import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { recheckConfirmedOffers, searchOffers, type OfferDeps } from "./offers";
import type { PageObservation } from "./priceWatch";
import { MAX_OFFER_FINDS_PER_DAY, OFFER_FIND_COOLDOWN_MS, OFFER_FIND_WINDOW_MS } from "./limits";

/**
 * Offers (W3). No test reaches Firecrawl or OpenAI: `searchOffers` and
 * `recheckConfirmedOffers` take their search and price-extraction seams as
 * `deps`, and fake timers keep the search that `find` schedules from firing.
 */
const T0 = Date.UTC(2026, 8, 20, 12);
const NAME = "Acme Down Jacket, Blue, M";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof setup>;

function runner(t: T) {
  return {
    runQuery: (ref: any, args: any) => t.query(ref, args),
    runMutation: (ref: any, args: any) => t.mutation(ref, args),
  } as any;
}

async function makeWatch(
  t: T,
  userId: Id<"users">,
  over: { name?: string; lastCents?: number; currency?: string; status?: "active" | "paused" | "archived" | "bought"; slug?: string } = {},
): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: over.name ?? NAME,
      productUrl: `https://www.acme.example/p/${over.slug ?? "down-jacket"}`,
      merchantDomain: "acme.example",
      status: over.status ?? "active",
      nextCheckAt: T0 + 3_600_000,
      lastCents: "lastCents" in over ? over.lastCents : 20_000,
      currency: "currency" in over ? over.currency : "USD",
    }),
  );
}

const exact = (cents: number, extra: Partial<PageObservation> = {}): PageObservation => ({
  observedCents: cents,
  currency: "USD",
  confidence: 0.9,
  isRange: false,
  variantMatch: "exact",
  ...extra,
});

/** Deps whose search returns `urls` and whose extractor answers per host substring. */
function deps(urls: string[], byHost: Record<string, PageObservation | Error>) {
  const observed: string[] = [];
  const searches: Array<{ query: string; options: unknown }> = [];
  const d: OfferDeps = {
    search: async (_ctx, query, options) => {
      searches.push({ query, options });
      return { web: urls.map((url) => ({ url, title: `Title of ${url}`, markdown: "x" })) };
    },
    observe: async (_ctx, _name, productUrl) => {
      observed.push(productUrl);
      const key = Object.keys(byHost).find((k) => productUrl.includes(k));
      if (!key) throw new Error(`no observation for ${productUrl}`);
      const answer = byHost[key];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { d, observed, searches };
}

async function rows(t: T, watchId: Id<"watches">) {
  const all = await t.run((ctx) =>
    ctx.db.query("offers").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect(),
  );
  return all.filter((r) => r.storeDomain !== "~find");
}

describe("searchOffers", () => {
  it("filters the own store and excluded hosts, keeps one row per store, and never adds to a URL", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const { d, observed, searches } = deps(
      [
        "https://www.acme.example/p/down-jacket",
        "https://www.facebook.com/marketplace/item/1",
        "https://www.reddit.com/r/deals/1",
        "https://www.rei.example/p/1?utm_source=g&color=blue&gclid=zz",
        "https://outlet.rei.example/p/2",
        "https://www.youtube.com/watch?v=1",
        "https://backcountry.example/p/3",
      ],
      { "rei.example": exact(18_000), "backcountry.example": exact(19_000) },
    );

    expect(await searchOffers(runner(t), watchId, d)).toBe(2);

    expect(searches).toHaveLength(1);
    expect(searches[0].query).toContain(NAME);
    expect(searches[0].options).toMatchObject({
      limit: 8,
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true },
    });
    expect((searches[0].options as { excludeDomains: string[] }).excludeDomains).toContain("acme.example");
    expect(observed).toEqual(["https://www.rei.example/p/1?color=blue", "https://backcountry.example/p/3"]);

    const stored = await rows(t, watchId);
    expect(stored.map((r) => r.storeDomain).sort()).toEqual(["backcountry.example", "rei.example"]);
    for (const r of stored) {
      expect(r.status).toBe("candidate");
      expect(r.userId).toBe(userId);
      expect(r.matchConfidence).toBe(0.9);
      expect(r.lastCheckedAt).toBe(T0);
    }
    expect(stored.find((r) => r.storeDomain === "rei.example")?.productUrl).toBe("https://www.rei.example/p/1?color=blue");

    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers).toHaveLength(2);
    expect(listed.best).toBeNull(); // nothing is confirmed yet
  });

  it("prices at most five pages", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const urls = Array.from({ length: 8 }, (_, i) => `https://store${i}.example/p`);
    const { d, observed } = deps(urls, { ".example": exact(18_000) });
    await searchOffers(runner(t), watchId, d);
    expect(observed).toHaveLength(5);
    expect(await rows(t, watchId)).toHaveLength(5);
  });

  it("drops 'none' matches, halves 'unsure', and stores D16 rejections with a note and no cents", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const { d } = deps(
      ["https://none.example/p", "https://unsure.example/p", "https://eur.example/p", "https://range.example/p", "https://low.example/p", "https://noprice.example/p"],
      {
        "none.example": exact(1_000, { variantMatch: "none" }),
        "unsure.example": exact(17_000, { variantMatch: "unsure", confidence: 0.8 }),
        "eur.example": exact(15_000, { currency: "EUR" }),
        "range.example": exact(15_000, { isRange: true }),
        "low.example": exact(15_000, { confidence: 0.4 }),
        "noprice.example": { variantMatch: "exact", confidence: 0.9, note: "The page does not show a single price" },
      },
    );
    await searchOffers(runner(t), watchId, d);

    const stored = await rows(t, watchId);
    const by = (host: string) => stored.find((r) => r.storeDomain === host);
    expect(by("none.example")).toBeUndefined();

    expect(by("unsure.example")?.matchConfidence).toBe(0.4);
    expect(by("unsure.example")?.lastCents).toBeUndefined();
    expect(by("unsure.example")?.note).toMatch(/variant/);

    expect(by("eur.example")?.lastCents).toBeUndefined();
    expect(by("eur.example")?.currency).toBe("EUR");
    expect(by("eur.example")?.note).toMatch(/EUR.*USD/);

    expect(by("range.example")?.lastCents).toBeUndefined();
    expect(by("range.example")?.note).toMatch(/range/);

    expect(by("low.example")?.lastCents).toBeUndefined();
    expect(by("low.example")?.note).toMatch(/confidence/i);
    expect(by("low.example")?.matchConfidence).toBe(0.4);
  });

  it("stores nothing and does not throw when the search or a page fails", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const failing: OfferDeps = {
      search: async () => {
        throw new Error("402 insufficient credits");
      },
      observe: async () => {
        throw new Error("should not be called");
      },
    };
    expect(await searchOffers(runner(t), watchId, failing)).toBe(0);

    const { d } = deps(["https://dead.example/p", "https://rei.example/p"], {
      "dead.example": new Error("timeout"),
      "rei.example": exact(18_000),
    });
    expect(await searchOffers(runner(t), watchId, d)).toBe(1);

    expect((await rows(t, watchId)).map((r) => r.storeDomain)).toEqual(["rei.example"]);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  it("user decisions survive a second search; a confirmed price is refreshed only", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const urls = ["https://rei.example/p/1", "https://backcountry.example/p/3", "https://moose.example/p/9"];
    await searchOffers(runner(t), watchId, deps(urls, { ".example": exact(18_000) }).d);

    const first = await rows(t, watchId);
    const rei = first.find((r) => r.storeDomain === "rei.example")!;
    const bc = first.find((r) => r.storeDomain === "backcountry.example")!;
    await as.mutation(api.offers.confirm, { offerId: rei._id });
    await as.mutation(api.offers.confirm, { offerId: rei._id }); // idempotent
    await as.mutation(api.offers.reject, { offerId: bc._id });
    await as.mutation(api.offers.reject, { offerId: bc._id }); // idempotent

    vi.setSystemTime(T0 + 7 * 3_600_000);
    await searchOffers(
      runner(t),
      watchId,
      deps(urls, {
        "rei.example": exact(16_500, { variantMatch: "unsure", confidence: 0.2 }),
        "backcountry.example": exact(10_000),
        "moose.example": exact(17_500),
      }).d,
    );

    const second = await rows(t, watchId);
    expect(second).toHaveLength(3); // still one row per store

    const rei2 = second.find((r) => r._id === rei._id)!;
    expect(rei2.status).toBe("confirmed");
    expect(rei2.variantMatch).toBe("exact"); // the match the user vouched for is not re-judged
    expect(rei2.matchConfidence).toBe(0.9);
    expect(rei2.lastCheckedAt).toBe(T0 + 7 * 3_600_000);
    expect(rei2.lastCents).toBeUndefined(); // D16: an unsure re-read is not a price
    expect(rei2.note).toMatch(/variant/);

    const bc2 = second.find((r) => r._id === bc._id)!;
    expect(bc2).toEqual({ ...bc, status: "rejected" }); // untouched apart from the user's own decision

    const moose = second.find((r) => r.storeDomain === "moose.example")!;
    expect(moose.status).toBe("candidate");
    expect(moose.lastCents).toBe(17_500);

    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers.map((o) => o.storeDomain)).toEqual(["rei.example", "moose.example"]); // rejected omitted
  });
});

describe("listForWatch", () => {
  it("orders confirmed by price then candidates by confidence, and best ignores candidates", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 20_000 });
    await searchOffers(
      runner(t),
      watchId,
      deps(["https://a.example/p", "https://b.example/p", "https://c.example/p", "https://d.example/p", "https://e.example/p"], {
        "a.example": exact(12_000), // cheapest of all, never confirmed
        "b.example": exact(19_000),
        "c.example": exact(18_000),
        "d.example": { variantMatch: "exact", confidence: 0.95, note: "No single price" },
        "e.example": exact(15_000, { variantMatch: "unsure", confidence: 0.6 }),
      }).d,
    );

    let listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.best).toBeNull();
    expect(listed.offers).toHaveLength(5);
    expect(listed.offers[0].storeDomain).toBe("d.example");
    expect(listed.offers[4].storeDomain).toBe("e.example");

    const id = (host: string) => listed.offers.find((o) => o.storeDomain === host)!._id;
    await as.mutation(api.offers.confirm, { offerId: id("b.example") });
    await as.mutation(api.offers.confirm, { offerId: id("c.example") });
    await as.mutation(api.offers.confirm, { offerId: id("d.example") });

    listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers.map((o) => o.storeDomain)).toEqual(["c.example", "b.example", "d.example", "a.example", "e.example"]);
    expect(listed.best).toEqual({ storeDomain: "c.example", cents: 18_000, currency: "USD", productUrl: "https://c.example/p" });
    const d = listed.offers.find((o) => o.storeDomain === "d.example")!;
    expect(d.lastCents).toBeNull();
    expect(d.currency).toBeNull();
    expect(d.note).toBe("No single price");
  });

  it("best is null when no confirmed offer beats the watch's own price, or the watch has none", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const dear = await makeWatch(t, userId, { lastCents: 15_000 });
    await searchOffers(runner(t), dear, deps(["https://b.example/p"], { "b.example": exact(15_000) }).d);
    const [row] = await rows(t, dear);
    await as.mutation(api.offers.confirm, { offerId: row._id });
    expect((await as.query(api.offers.listForWatch, { watchId: dear })).best).toBeNull();

    const unpriced = await makeWatch(t, userId, { lastCents: undefined, currency: undefined, slug: "other" });
    await searchOffers(runner(t), unpriced, deps(["https://b.example/p"], { "b.example": exact(1_000) }).d);
    const [row2] = await rows(t, unpriced);
    await as.mutation(api.offers.confirm, { offerId: row2._id });
    expect((await as.query(api.offers.listForWatch, { watchId: unpriced })).best).toBeNull();
  });

  it("other users and signed-out callers see nothing and cannot decide", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Owner");
    const { as: asOther } = await signedIn(t, "Other");
    const watchId = await makeWatch(t, userId);
    await searchOffers(runner(t), watchId, deps(["https://b.example/p"], { "b.example": exact(15_000) }).d);
    const [row] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: row._id });

    const empty = { offers: [], best: null, searching: false, nextFindAt: null };
    expect(await asOther.query(api.offers.listForWatch, { watchId })).toEqual(empty);
    expect(await t.query(api.offers.listForWatch, { watchId })).toEqual(empty);

    await expect(asOther.mutation(api.offers.reject, { offerId: row._id })).rejects.toThrow(/Offer not found/);
    await expect(asOther.mutation(api.offers.confirm, { offerId: row._id })).rejects.toThrow(/Offer not found/);
    await expect(t.mutation(api.offers.confirm, { offerId: row._id })).rejects.toThrow(/Not signed in/);
    await expect(asOther.mutation(api.offers.find, { watchId })).rejects.toThrow(/Watch not found/);
    expect((await rows(t, watchId))[0].status).toBe("confirmed");
  });
});

describe("find", () => {
  async function scheduled(t: T) {
    return await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  }

  it("schedules one search, reports searching, and enforces the per-watch cooldown", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);

    await as.mutation(api.offers.find, { watchId });
    expect(await scheduled(t)).toHaveLength(1);
    let listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed).toEqual({ offers: [], best: null, searching: true, nextFindAt: T0 + OFFER_FIND_COOLDOWN_MS });

    await expect(as.mutation(api.offers.find, { watchId })).rejects.toThrow(/recently/);
    vi.setSystemTime(T0 + OFFER_FIND_COOLDOWN_MS - 1);
    await expect(as.mutation(api.offers.find, { watchId })).rejects.toThrow(/recently/);
    expect(await scheduled(t)).toHaveLength(1);

    // The search records (even an empty one): no longer searching, still cooling down.
    await searchOffers(runner(t), watchId, deps([], {}).d);
    listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.searching).toBe(false);
    expect(listed.nextFindAt).toBe(T0 + OFFER_FIND_COOLDOWN_MS);

    vi.setSystemTime(T0 + OFFER_FIND_COOLDOWN_MS);
    await as.mutation(api.offers.find, { watchId });
    expect(await scheduled(t)).toHaveLength(2);
  });

  it("caps finds per user per day across watches, and the cap rolls off", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { userId: otherId, as: asOther } = await signedIn(t, "Other");
    for (let i = 0; i < MAX_OFFER_FINDS_PER_DAY; i++) {
      const watchId = await makeWatch(t, userId, { slug: `item-${i}` });
      await as.mutation(api.offers.find, { watchId });
    }
    const extra = await makeWatch(t, userId, { slug: "one-too-many" });
    await expect(as.mutation(api.offers.find, { watchId: extra })).rejects.toThrow(/today/);
    expect(await scheduled(t)).toHaveLength(MAX_OFFER_FINDS_PER_DAY);

    // Someone else's budget is their own.
    await asOther.mutation(api.offers.find, { watchId: await makeWatch(t, otherId) });

    vi.setSystemTime(T0 + OFFER_FIND_WINDOW_MS + 1);
    await as.mutation(api.offers.find, { watchId: extra });
  });

  it("refuses a watch that is not live or has nothing to search for", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    for (const status of ["archived", "bought"] as const) {
      const watchId = await makeWatch(t, userId, { status, slug: status });
      await expect(as.mutation(api.offers.find, { watchId })).rejects.toThrow(/no longer/);
    }
    const unread = await makeWatch(t, userId, {
      name: "acme.example: down jacket",
      lastCents: undefined,
      currency: undefined,
    });
    await expect(as.mutation(api.offers.find, { watchId: unread })).rejects.toThrow(/not been read/);
    expect(await scheduled(t)).toHaveLength(0);

    const paused = await makeWatch(t, userId, { status: "paused", slug: "paused" });
    await as.mutation(api.offers.find, { watchId: paused });
    expect(await scheduled(t)).toHaveLength(1);
  });
});

describe("recheck", () => {
  it("re-reads confirmed offers only", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(
      runner(t),
      watchId,
      deps(["https://a.example/p", "https://b.example/p", "https://c.example/p"], { ".example": exact(18_000) }).d,
    );
    const stored = await rows(t, watchId);
    const a = stored.find((r) => r.storeDomain === "a.example")!;
    const b = stored.find((r) => r.storeDomain === "b.example")!;
    await as.mutation(api.offers.confirm, { offerId: a._id });
    await as.mutation(api.offers.reject, { offerId: b._id });

    vi.setSystemTime(T0 + 3_600_000);
    const { d, observed, searches } = deps([], { "a.example": exact(16_000) });
    expect(await recheckConfirmedOffers(runner(t), watchId, d)).toBe(1);
    expect(observed).toEqual(["https://a.example/p"]);
    expect(searches).toHaveLength(0);

    const after = await rows(t, watchId);
    expect(after.find((r) => r._id === a._id)).toMatchObject({ status: "confirmed", lastCents: 16_000, lastCheckedAt: T0 + 3_600_000 });
    expect(after.find((r) => r._id === b._id)).toEqual({ ...b, status: "rejected" });
    expect(after.find((r) => r.storeDomain === "c.example")?.lastCheckedAt).toBe(T0);

    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.best?.cents).toBe(16_000);
  });

  it("a failed re-read leaves the row as it was", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const [a] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: a._id });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await recheckConfirmedOffers(runner(t), watchId, deps([], { "a.example": new Error("timeout") }).d)).toBe(0);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
    expect((await rows(t, watchId))[0]).toMatchObject({ lastCents: 18_000, lastCheckedAt: T0 });
    // The internal registration exists for the sweep to schedule.
    expect(internal.offers.recheck).toBeDefined();
  });
});
