import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { NEEDS_RECONFIRM_NOTE, OFFER_CHECK_DEDUPE_MS, recheckConfirmedOffers, searchOffers, type OfferDeps } from "./offers";
import type { PageObservation } from "./priceWatch";
import {
  GLOBAL_DAILY_BUDGETS,
  MAX_OFFER_FINDS_PER_DAY,
  OFFER_FIND_COOLDOWN_MS,
  OFFER_FIND_WINDOW_MS,
} from "./limits";

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

  it("T24c (D109): a page/search failure logs structured price_check_failed JSON lines via logEvent, never a raw console.error with the provider body", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { d } = deps(["https://dead.example/p", "https://rei.example/p"], {
      "dead.example": new Error("upstream failed with key sk-abcdefghij1234567890 for sam@home.example"),
      "rei.example": exact(18_000),
    });
    expect(await searchOffers(runner(t), watchId, d)).toBe(1);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    spy.mockRestore();
    expect(line.kind).toBe("price_check_failed");
    expect(line.watchId).toBe(String(watchId));
    expect(line.storeDomain).toBe("dead.example");
    expect(typeof line.error).toBe("string");
    const raw = JSON.stringify(line);
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/fc-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/sam@home\.example/);
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

    const empty = { offers: [], best: null, searchingUntil: undefined, nextFindAt: undefined };
    expect(await asOther.query(api.offers.listForWatch, { watchId })).toEqual(empty);
    expect(await t.query(api.offers.listForWatch, { watchId })).toEqual(empty);

    await expect(asOther.mutation(api.offers.reject, { offerId: row._id })).rejects.toThrow(/Offer not found/);
    await expect(asOther.mutation(api.offers.confirm, { offerId: row._id })).rejects.toThrow(/Offer not found/);
    await expect(t.mutation(api.offers.confirm, { offerId: row._id })).rejects.toThrow(/Not signed in/);
    await expect(asOther.mutation(api.offers.find, { watchId })).rejects.toThrow(/Watch not found/);
    expect((await rows(t, watchId))[0].status).toBe("confirmed");
  });

  it("D115 6b-3 / T18.3: returns the empty shape for a tombstoned caller's own (otherwise visible) watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 15_000 });
    await searchOffers(runner(t), watchId, deps(["https://b.example/p"], { "b.example": exact(12_000) }).d);
    const [row] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: row._id });
    // Prove real data is visible first, so the post-tombstone assertion below is not vacuous.
    expect((await as.query(api.offers.listForWatch, { watchId })).offers.length).toBeGreaterThan(0);

    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    const empty = { offers: [], best: null, searchingUntil: undefined, nextFindAt: undefined };
    expect(await as.query(api.offers.listForWatch, { watchId })).toEqual(empty);
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
    expect(listed).toEqual({
      offers: [],
      best: null,
      searchingUntil: T0 + 5 * 60_000,
      nextFindAt: T0 + OFFER_FIND_COOLDOWN_MS,
    });

    await expect(as.mutation(api.offers.find, { watchId })).rejects.toThrow(/recently/);
    vi.setSystemTime(T0 + OFFER_FIND_COOLDOWN_MS - 1);
    await expect(as.mutation(api.offers.find, { watchId })).rejects.toThrow(/recently/);
    expect(await scheduled(t)).toHaveLength(1);

    // The search records (even an empty one): no longer searching (searchingUntil undefined), still
    // cooling down; nextFindAt is raw and stays populated (never nulled) at every later `now` too.
    await searchOffers(runner(t), watchId, deps([], {}).d);
    listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.searchingUntil).toBeUndefined();
    expect(listed.nextFindAt).toBe(T0 + OFFER_FIND_COOLDOWN_MS);

    // Raw, so it reads the same past the cooldown too -- the client decides staleness, not this query
    // (T13/P06: no query result here is derived from server time).
    const past = await as.query(api.offers.listForWatch, { watchId, now: T0 + OFFER_FIND_COOLDOWN_MS + 3_600_000 });
    expect(past.nextFindAt).toBe(T0 + OFFER_FIND_COOLDOWN_MS);

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

describe("offerChecks (per-store price history)", () => {
  async function history(t: T, offerId: Id<"offers">) {
    return await t.run((ctx) =>
      ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offerId)).collect(),
    );
  }
  const cand = (store: string, obs: PageObservation, path = "p/1") => ({
    storeDomain: store,
    productUrl: `https://${store}/${path}`,
    title: NAME,
    observedCents: obs.observedCents,
    currency: obs.currency,
    confidence: obs.confidence,
    isRange: obs.isRange,
    variantMatch: obs.variantMatch,
    note: obs.note,
  });

  it("writes one row per accepted price from a search, and none for a rejected or unpriced page", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await t.mutation(internal.offers.recordCandidates, {
      watchId,
      candidates: [
        cand("rei.example", exact(18_000)),
        cand("eur.example", exact(17_000, { currency: "EUR" })), // D16: wrong currency, no cents stored
        cand("vague.example", exact(16_000, { variantMatch: "unsure" })),
        cand("blank.example", { variantMatch: "exact", note: "No price shown" }),
      ],
    });
    const stored = await rows(t, watchId);
    expect(stored).toHaveLength(4);
    for (const offer of stored) {
      const checks = await history(t, offer._id);
      if (offer.storeDomain === "rei.example") {
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({ offerId: offer._id, watchId, userId, observedCents: 18_000, currency: "USD", observedAt: T0 });
      } else {
        expect(offer.lastCents).toBeUndefined();
        expect(checks).toHaveLength(0);
      }
    }
  });

  it("skips a retry with the same price inside 30 minutes, and records a new price or a later repeat", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await t.mutation(internal.offers.recordCandidates, { watchId, candidates: [cand("rei.example", exact(18_000))] });
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });
    // Confirming an offer that already has its series adds nothing.
    expect(await history(t, offer._id)).toHaveLength(1);

    const recheck = (cents: number) =>
      t.mutation(internal.offers.recordRechecks, { watchId, results: [{ offerId: offer._id, ...exact(cents) }] });

    vi.setSystemTime(T0 + 60_000);
    await recheck(18_000); // retry, same price: no row
    expect(await history(t, offer._id)).toHaveLength(1);
    // The search finding the confirmed URL again is the same writer path.
    await t.mutation(internal.offers.recordCandidates, { watchId, candidates: [cand("rei.example", exact(18_000))] });
    expect(await history(t, offer._id)).toHaveLength(1);

    vi.setSystemTime(T0 + 120_000);
    await recheck(17_500); // a different price inside the window is news
    expect((await history(t, offer._id)).map((c) => c.observedCents)).toEqual([18_000, 17_500]);

    vi.setSystemTime(T0 + 120_000 + OFFER_CHECK_DEDUPE_MS);
    await recheck(17_500); // same price, window over: a new reading
    const checks = await history(t, offer._id);
    expect(checks.map((c) => [c.observedCents, c.observedAt])).toEqual([
      [18_000, T0],
      [17_500, T0 + 120_000],
      [17_500, T0 + 120_000 + OFFER_CHECK_DEDUPE_MS],
    ]);

    // A rejected re-read clears the offer's price and writes no row.
    vi.setSystemTime(T0 + 3 * OFFER_CHECK_DEDUPE_MS);
    await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [{ offerId: offer._id, ...exact(9_000, { confidence: 0.2 }) }],
    });
    expect(await history(t, offer._id)).toHaveLength(3);
  });

  it("confirming an offer priced before the history existed seeds its one known point, once", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    const offerId = await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId, userId, storeDomain: "old.example", productUrl: "https://old.example/p/1", title: NAME,
        status: "candidate", lastCents: 15_000, currency: "USD", lastCheckedAt: T0 - 86_400_000,
      }),
    );
    await as.mutation(api.offers.confirm, { offerId });
    await as.mutation(api.offers.confirm, { offerId }); // a retry is a no-op
    const checks = await history(t, offerId);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ observedCents: 15_000, observedAt: T0 - 86_400_000, userId, watchId });
  });

  it("a candidate replaced by another page of the store starts a fresh series", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await t.mutation(internal.offers.recordCandidates, { watchId, candidates: [cand("rei.example", exact(18_000), "p/1")] });
    vi.setSystemTime(T0 + 7 * 3_600_000);
    await t.mutation(internal.offers.recordCandidates, { watchId, candidates: [cand("rei.example", exact(12_000), "p/2")] });
    const [offer] = await rows(t, watchId);
    expect(offer.productUrl).toBe("https://rei.example/p/2");
    expect((await history(t, offer._id)).map((c) => c.observedCents)).toEqual([12_000]);
  });
});

describe("dueForRecheck (F5)", () => {
  it("is false with no confirmed offers, true once one is overdue, and false again right after a recheck", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    expect(await t.query(internal.offers.dueForRecheck, { watchId })).toBe(false);

    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const [a] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: a._id });
    // Just confirmed (and priced by the find itself): not yet overdue.
    expect(await t.query(internal.offers.dueForRecheck, { watchId })).toBe(false);

    vi.setSystemTime(T0 + OFFER_FIND_COOLDOWN_MS);
    expect(await t.query(internal.offers.dueForRecheck, { watchId })).toBe(true);

    await recheckConfirmedOffers(runner(t), watchId, deps([], { "a.example": exact(16_000) }).d);
    expect(await t.query(internal.offers.dueForRecheck, { watchId })).toBe(false);
  });

  it("ignores rejected offers and the find marker", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(
      runner(t),
      watchId,
      deps(["https://a.example/p"], { "a.example": exact(18_000) }).d,
    );
    const [a] = await rows(t, watchId);
    await as.mutation(api.offers.reject, { offerId: a._id });
    vi.setSystemTime(T0 + OFFER_FIND_COOLDOWN_MS);

    expect(await t.query(internal.offers.dueForRecheck, { watchId })).toBe(false);
  });
});

describe("listForWatch: now argument (T13/P06)", () => {
  it("returns the identical result for two different `now` values -- nothing here is derived from server time", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await as.mutation(api.offers.find, { watchId }); // leaves a pending marker, the one time-shaped bit of state

    const a = await as.query(api.offers.listForWatch, { watchId, now: T0 });
    const b = await as.query(api.offers.listForWatch, { watchId, now: T0 + 6 * 3_600_000 });
    expect(a).toEqual(b);
    const withoutNow = await as.query(api.offers.listForWatch, { watchId });
    expect(withoutNow).toEqual(a);
  });

  it("still validates `now`: rejects a non-finite or far-future value", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await expect(as.query(api.offers.listForWatch, { watchId, now: Number.NaN })).rejects.toThrow();
    await expect(as.query(api.offers.listForWatch, { watchId, now: -1 })).rejects.toThrow();
    await expect(as.query(api.offers.listForWatch, { watchId, now: T0 + 2 * 86_400_000 })).rejects.toThrow();
  });
});

describe("provenance (T13/P04)", () => {
  it("a Firecrawl-found candidate is labelled source 'recoup'", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers[0].source).toBe("recoup");
  });

  it("a ShopSavvy candidate is labelled source 'shopsavvy', never drives best unconfirmed, and confirm seeds its history at the provider's own observed time", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 20_000 });
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));
    const providerObservedAt = T0 - 86_400_000; // the provider's own timestamp, distinct from "now" (retrieval time)
    await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Cheap Store",
          storeDomain: "cheap.example",
          productUrl: "https://cheap.example/p",
          cents: 15_000,
          currency: "USD",
          observedAt: providerObservedAt,
        },
      ],
    });

    let listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers[0].source).toBe("shopsavvy");
    expect(listed.best).toBeNull(); // unconfirmed: source alone never authorizes "best"

    const offerId = listed.offers[0]._id;
    await as.mutation(api.offers.confirm, { offerId });

    listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.best).toEqual({
      storeDomain: "cheap.example",
      cents: 15_000,
      currency: "USD",
      productUrl: "https://cheap.example/p",
    });

    const checks = await t.run((ctx) =>
      ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offerId)).collect(),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ source: "shopsavvy", observedAt: providerObservedAt, observedCents: 15_000 });
  });
});

describe("availability: out-of-stock never best (T13/P04)", () => {
  it("a confirmed out-of-stock ShopSavvy candidate stays unpriced and cannot become best, and is shown qualified", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 30_000 });
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));
    await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "OOS Store",
          storeDomain: "oos.example",
          productUrl: "https://oos.example/p",
          cents: 5_000,
          currency: "USD",
          observedAt: T0,
          inStock: false,
        },
      ],
    });

    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.offers[0].lastCents).toBeNull();
    expect(listed.offers[0].note).toMatch(/out of stock/i);

    await as.mutation(api.offers.confirm, { offerId: listed.offers[0]._id });
    const after = await as.query(api.offers.listForWatch, { watchId });
    expect(after.best).toBeNull();
  });
});

describe("confirmed-offer variant drift -> needs_reconfirm (T13/P04)", () => {
  const candWithTitle = (store: string, obs: PageObservation, title: string, path = "p/1") => ({
    storeDomain: store,
    productUrl: `https://${store}/${path}`,
    title,
    observedCents: obs.observedCents,
    currency: obs.currency,
    confidence: obs.confidence,
    isRange: obs.isRange,
    variantMatch: obs.variantMatch,
    note: obs.note,
  });

  it("recordCandidates flags drift instead of updating price when the same URL's title no longer resembles the confirmed one", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 25_000 });
    await t.mutation(internal.offers.recordCandidates, {
      watchId,
      candidates: [candWithTitle("drift.example", exact(18_000), "Acme Down Jacket, Blue, M")],
    });
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });

    // Same URL, a completely different product the second time -- the store swapped the listing.
    await t.mutation(internal.offers.recordCandidates, {
      watchId,
      candidates: [candWithTitle("drift.example", exact(9_000), "Sony WH-1000XM5 Wireless Headphones")],
    });

    const after = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(after.lastCents).toBe(18_000); // unchanged, not silently overwritten
    expect(after.note).toBe("This store's listing may have changed since you confirmed it; check it before trusting this price.");

    const listed = await as.query(api.offers.listForWatch, { watchId });
    expect(listed.best).toBeNull(); // the only confirmed offer is flagged, so it cannot drive best
  });

  it("recordRechecks flags drift from a 'none' variant match or a drifted product name, without appending an offerChecks row", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });
    const before = await t.run((ctx) =>
      ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offer._id)).collect(),
    );

    await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [{ offerId: offer._id, observedCents: 5_000, currency: "USD", confidence: 0.9, isRange: false, variantMatch: "none" }],
    });

    const afterNone = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(afterNone.lastCents).toBe(18_000);
    expect(afterNone.note).toMatch(/changed/);

    await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [
        {
          offerId: offer._id,
          observedCents: 4_000,
          currency: "USD",
          confidence: 0.9,
          isRange: false,
          variantMatch: "exact",
          productName: "Totally Different Espresso Machine",
        },
      ],
    });
    const afterDrift = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(afterDrift.lastCents).toBe(18_000);

    const checksAfter = await t.run((ctx) =>
      ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offer._id)).collect(),
    );
    expect(checksAfter).toHaveLength(before.length); // no new (untrusted) price point recorded

    // A later read that DOES still look like the confirmed product resumes trusting the price.
    await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [
        {
          offerId: offer._id,
          observedCents: 16_000,
          currency: "USD",
          confidence: 0.9,
          isRange: false,
          variantMatch: "exact",
          // F4 (D103): resembles the offer's stored `productName` (bootstrapped at confirm time from
          // the WATCH's own name, `NAME`), not `offer.title` -- the drift check no longer compares
          // against title at all (see the ShopSavvy-sourced case below, where title is the retailer's
          // own name and would never resemble a product name in the first place).
          productName: NAME,
        },
      ],
    });
    const resumed = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(resumed.lastCents).toBe(16_000);
    expect(resumed.note).toBeUndefined();
  });

  it("a ShopSavvy-sourced confirmed offer survives its first recheck with the price updated (F4/D103, DA-10)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 25_000 });
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));
    // A ShopSavvy candidate: its `title` is the RETAILER's name (market.ts), never the product's.
    await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Best Buy",
          storeDomain: "bestbuy.example",
          productUrl: "https://bestbuy.example/p",
          cents: 19_999,
          currency: "USD",
          observedAt: T0,
        },
      ],
    });
    const [offer] = await rows(t, watchId);
    expect(offer.title).toBe("Best Buy"); // sanity: confirms the setup this bug depended on

    await as.mutation(api.offers.confirm, { offerId: offer._id });
    const confirmed = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(confirmed.productName).toBe(NAME); // bootstrapped from the watch's own name at confirm time

    // A realistic recheck: a real-looking product-name read off the store page, similar to (but not a
    // verbatim copy of) the watch's own name -- the kind of thing a real page's extractor returns.
    // Before F4 this would have been compared against `offer.title` ("Best Buy") instead, and would
    // have been flagged as drift on this very first recheck.
    await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [
        {
          offerId: offer._id,
          observedCents: 18_500,
          currency: "USD",
          confidence: 0.9,
          isRange: false,
          variantMatch: "exact",
          productName: "Acme Down Jacket - Blue, Size M",
        },
      ],
    });

    const after = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(after.lastCents).toBe(18_500); // price updated, not frozen behind a false drift flag
    expect(after.note).toBeUndefined();
  });

  it("confirm clears NEEDS_RECONFIRM_NOTE, whether it is a plain re-confirm or a reject -> confirm (F4/D103)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId, { lastCents: 25_000 });
    await t.mutation(internal.offers.recordCandidates, {
      watchId,
      candidates: [candWithTitle("drift.example", exact(18_000), "Acme Down Jacket, Blue, M")],
    });
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });

    const flagDrift = () =>
      t.mutation(internal.offers.recordCandidates, {
        watchId,
        candidates: [candWithTitle("drift.example", exact(9_000), "Sony WH-1000XM5 Wireless Headphones")],
      });

    await flagDrift();
    const flagged = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(flagged.note).toBe(NEEDS_RECONFIRM_NOTE); // sanity: it really is flagged

    // A plain re-confirm (status is already "confirmed" -- previously treated as a full no-op) still
    // clears the flag: the user looking again and confirming IS the reconfirmation.
    await as.mutation(api.offers.confirm, { offerId: offer._id });
    const reconfirmed = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(reconfirmed.note).toBeUndefined();
    expect(reconfirmed.status).toBe("confirmed");

    // reject -> confirm clears it too.
    await flagDrift();
    await as.mutation(api.offers.reject, { offerId: offer._id });
    await as.mutation(api.offers.confirm, { offerId: offer._id });
    const afterRejectConfirm = (await rows(t, watchId)).find((r) => r._id === offer._id)!;
    expect(afterRejectConfirm.note).toBeUndefined();
    expect(afterRejectConfirm.status).toBe("confirmed");
  });
});

describe("tombstoned owner: scheduled offers work writes nothing (D87)", () => {
  it("recordCandidates and recordRechecks are no-ops once the owner is tombstoned", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });

    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    const cand = (store: string, obs: PageObservation, path = "p/1") => ({
      storeDomain: store,
      productUrl: `https://${store}/${path}`,
      title: NAME,
      observedCents: obs.observedCents,
      currency: obs.currency,
      confidence: obs.confidence,
      isRange: obs.isRange,
      variantMatch: obs.variantMatch,
      note: obs.note,
    });
    const writtenCandidates = await t.mutation(internal.offers.recordCandidates, {
      watchId,
      candidates: [cand("new-store.example", exact(9_999))],
    });
    expect(writtenCandidates).toBe(0);
    expect((await rows(t, watchId)).some((r) => r.storeDomain === "new-store.example")).toBe(false);

    const writtenRechecks = await t.mutation(internal.offers.recordRechecks, {
      watchId,
      results: [{ offerId: offer._id, observedCents: 1_234, currency: "USD", confidence: 0.9, isRange: false, variantMatch: "exact" }],
    });
    expect(writtenRechecks).toBe(0);
    expect((await rows(t, watchId)).find((r) => r._id === offer._id)?.lastCents).toBe(18_000);
  });

  it("searchOffers and recheckConfirmedOffers spend nothing -- no Firecrawl search, no price-extractor observe -- once the owner is tombstoned (F12/D103, DA-14)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    // A confirmed offer for recheckConfirmedOffers to (not) act on below.
    await searchOffers(runner(t), watchId, deps(["https://a.example/p"], { "a.example": exact(18_000) }).d);
    const [offer] = await rows(t, watchId);
    await as.mutation(api.offers.confirm, { offerId: offer._id });

    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    const { d: spendDeps, observed, searches } = deps(["https://b.example/p"], { "b.example": exact(5_000) });

    const searchWritten = await searchOffers(runner(t), watchId, spendDeps);
    expect(searchWritten).toBe(0);
    // Before F12, `watchForSearch` did not check the tombstone: searchOffers would still have run the
    // (paid) Firecrawl search and the (paid) price-extractor observe for every candidate page, only to
    // have `recordCandidates` throw the write away. Gating in `watchForSearch` -- read BEFORE either --
    // stops both from ever running.
    expect(searches).toHaveLength(0);
    expect(observed).toHaveLength(0);

    const rechecked = await recheckConfirmedOffers(runner(t), watchId, spendDeps);
    expect(rechecked).toBe(0);
    expect(observed).toHaveLength(0); // still 0: confirmedForWatch is never even reached
  });
});

describe("offers.sweepRechecks (daily cron)", () => {
  async function jobs(t: T) {
    return await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  }

  async function confirmedOffer(
    t: T,
    watchId: Id<"watches">,
    userId: Id<"users">,
    store: string,
    lastCheckedAt?: number,
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId,
        userId,
        storeDomain: store,
        productUrl: `https://${store}/p/1`,
        title: store,
        status: "confirmed",
        lastCents: 19_000,
        currency: "USD",
        lastCheckedAt,
      }),
    );
  }

  it("schedules one re-check per watch, stalest first, and stamps the rows it took", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const stale = await makeWatch(t, userId, { slug: "stale" });
    const fresh = await makeWatch(t, userId, { slug: "fresh" });
    // Two confirmed offers on the stale watch: one watch, one scheduled action.
    await confirmedOffer(t, stale, userId, "a.example", T0 - 5 * 86_400_000);
    await confirmedOffer(t, stale, userId, "b.example", T0 - 4 * 86_400_000);
    await confirmedOffer(t, fresh, userId, "c.example", T0 - 60_000);

    const before = (await jobs(t)).length;
    const res = await t.mutation(internal.offers.sweepRechecks, {});
    expect(res.watches).toBe(2);
    expect((await jobs(t)).length).toBe(before + 2);

    // Every row it read is stamped, so the next tick does not pick the same page up again.
    const rows = await t.run((ctx) => ctx.db.query("offers").collect());
    expect(rows.every((r) => (r.lastCheckedAt ?? 0) >= T0)).toBe(true);
  });

  it("never re-reads a candidate or a rejected offer", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await t.run(async (ctx) => {
      for (const status of ["candidate", "rejected"] as const) {
        await ctx.db.insert("offers", {
          watchId,
          userId,
          storeDomain: `${status}.example`,
          productUrl: `https://${status}.example/p/1`,
          title: status,
          status,
          lastCheckedAt: T0 - 86_400_000,
        });
      }
    });

    const before = (await jobs(t)).length;
    expect(await t.mutation(internal.offers.sweepRechecks, {})).toEqual({ watches: 0 });
    expect((await jobs(t)).length).toBe(before);
  });

  it("schedules nothing once the deployment's daily price-check switch is spent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await makeWatch(t, userId);
    await confirmedOffer(t, watchId, userId, "a.example", T0 - 86_400_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("usage", {
        day: new Date(T0).toISOString().slice(0, 10),
        kind: "price_check",
        count: GLOBAL_DAILY_BUDGETS.price_check.max,
      });
    });

    const before = (await jobs(t)).length;
    expect(await t.mutation(internal.offers.sweepRechecks, {})).toEqual({ watches: 0 });
    expect((await jobs(t)).length).toBe(before);
  });
});
