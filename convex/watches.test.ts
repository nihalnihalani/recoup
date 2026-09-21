import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { observePrice } from "./priceWatch";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
  MAX_WATCHES_PER_USER,
  MAX_WATCH_CREATES_PER_HOUR,
  WATCH_CHECK_COOLDOWN_MS,
  WATCH_CHECK_INTERVAL_MS,
  WATCH_SWEEP_BUMP_MS,
} from "./limits";

/**
 * Watches (W1). No test here reaches Firecrawl or OpenAI: the only network
 * seam is `priceWatch.observePrice`, which is replaced below, and fake timers
 * keep the checks that `create`/`checkNow`/`sweep` schedule from ever firing
 * on their own. `checkWatch` is driven directly where it is under test.
 */
vi.mock("./priceWatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./priceWatch")>()),
  observePrice: vi.fn(),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 20, 12);
const URL = "https://www.acme.example/p/down-jacket";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.mocked(observePrice).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof setup>;

async function scheduled(t: T) {
  return await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

async function watchRow(t: T, watchId: Id<"watches">) {
  const row = await t.run((ctx) => ctx.db.get(watchId));
  if (!row) throw new Error("watch missing");
  return row;
}

async function checksFor(t: T, watchId: Id<"watches">) {
  return await t.run((ctx) =>
    ctx.db
      .query("watchChecks")
      .withIndex("by_watch", (q) => q.eq("watchId", watchId))
      .collect(),
  );
}

/** A watch row inserted directly: the fixture for everything that is not `create`. */
async function seedWatch(
  t: T,
  userId: Id<"users">,
  o: {
    status?: "active" | "paused" | "archived" | "bought";
    nextCheckAt?: number;
    name?: string;
    currency?: string;
  } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: o.name ?? "acme.example: down jacket",
      productUrl: URL,
      merchantDomain: "acme.example",
      currency: o.currency,
      status: o.status ?? "active",
      nextCheckAt: o.nextCheckAt ?? T0,
    }),
  );
}

/** A clean, D16-passing observation of `cents`. */
function good(watchId: Id<"watches">, cents: number) {
  return {
    watchId,
    sourceUrl: URL,
    observedCents: cents,
    currency: "USD",
    confidence: 0.92,
    isRange: false,
    variantMatch: "exact" as const,
  };
}

describe("watches.create", () => {
  it("requires a signed-in caller", async () => {
    const t = setup();
    await expect(t.mutation(api.watches.create, { productUrl: URL })).rejects.toThrow(ConvexError);
    expect(await t.run((ctx) => ctx.db.query("watches").collect())).toHaveLength(0);
    expect(await scheduled(t)).toHaveLength(0);
  });

  it.each(["jacket", "ftp://acme.example/p", "http://localhost/p", "http://10.0.0.1/p", "javascript:alert(1)"])(
    "rejects the bad link %s and schedules nothing",
    async (productUrl) => {
      const t = setup();
      const { as } = await signedIn(t);
      await expect(as.mutation(api.watches.create, { productUrl })).rejects.toThrow(ConvexError);
      expect(await scheduled(t)).toHaveLength(0);
    },
  );

  it("rejects a non-positive or fractional target", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    for (const targetCents of [0, -5, 10.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(as.mutation(api.watches.create, { productUrl: URL, targetCents })).rejects.toThrow();
    }
  });

  it("inserts an active watch with a default name and schedules the first check", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);

    const watchId = await as.mutation(api.watches.create, { productUrl: `${URL}#reviews`, targetCents: 9_000 });

    const row = await watchRow(t, watchId);
    expect(row.userId).toBe(userId);
    expect(row.status).toBe("active");
    expect(row.name).toBe("acme.example: down jacket");
    expect(row.productUrl).toBe(URL);
    expect(row.merchantDomain).toBe("acme.example");
    expect(row.targetCents).toBe(9_000);
    expect(row.currency).toBeUndefined();
    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("watches");
    expect(jobs[0].name).toContain("checkWatch");

    const listed = await as.query(api.watches.list, {});
    expect(listed).toHaveLength(1);
    // P06/D73: raw `checkRequestedAt` instead of a server-computed `checking` boolean; the client derives it.
    expect(listed[0].checkRequestedAt).toBe(T0);
    expect(listed[0].lastObservedAt).toBeNull();
    expect(listed[0].priceStale).toBe(true);
    expect(listed[0].verdict.label).toBe("unknown");
    expect(listed[0].spark).toEqual([]);
  });

  it("keeps a name the user gave", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const watchId = await as.mutation(api.watches.create, { productUrl: URL, name: "  Blue jacket, M " });
    expect((await watchRow(t, watchId)).name).toBe("Blue jacket, M");
  });

  it("F1: strips a control character (subject/header injection) from a given name", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const watchId = await as.mutation(api.watches.create, {
      productUrl: URL,
      name: "Jacket\r\nBcc: evil@example.com",
    });
    expect((await watchRow(t, watchId)).name).not.toMatch(/[\r\n]/);
  });

  it("F1: rejects a name over the 200-char cap", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.watches.create, { productUrl: URL, name: "x".repeat(201) }),
    ).rejects.toThrow(/200 characters/);
    await expect(
      as.mutation(api.watches.create, { productUrl: URL, name: "x".repeat(200) }),
    ).resolves.toBeTruthy();
  });

  it("is not double-scheduled by a sweep that lands right after it", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.watches.create, { productUrl: URL });
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
    expect(await scheduled(t)).toHaveLength(1);
  });

  it(`allows ${MAX_WATCH_CREATES_PER_HOUR} creates an hour, counting archived ones, then recovers`, async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const other = await signedIn(t, "Other");
    let first: Id<"watches"> | null = null;
    for (let i = 0; i < MAX_WATCH_CREATES_PER_HOUR; i++) {
      const id = await as.mutation(api.watches.create, { productUrl: `${URL}-${i}` });
      first ??= id;
    }
    if (first) await as.mutation(api.watches.archive, { watchId: first });
    await expect(as.mutation(api.watches.create, { productUrl: URL })).rejects.toThrow(/last hour/);
    // The bucket is per user.
    await expect(other.as.mutation(api.watches.create, { productUrl: URL })).resolves.toBeTruthy();

    vi.setSystemTime(T0 + HOUR + 1);
    await expect(as.mutation(api.watches.create, { productUrl: URL })).resolves.toBeTruthy();
  });

  it(`caps a user at ${MAX_WATCHES_PER_USER} non-archived watches`, async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const ids: Id<"watches">[] = [];
    for (let i = 0; i < MAX_WATCHES_PER_USER; i++) {
      ids.push(await seedWatch(t, userId, { status: i % 2 === 0 ? "active" : "paused" }));
    }
    vi.setSystemTime(T0 + 2 * HOUR); // outside the hourly create window

    await expect(as.mutation(api.watches.create, { productUrl: URL })).rejects.toThrow(/up to 50/);
    expect(await scheduled(t)).toHaveLength(0);

    await as.mutation(api.watches.archive, { watchId: ids[0] });
    await expect(as.mutation(api.watches.create, { productUrl: URL })).resolves.toBeTruthy();
    await expect(as.mutation(api.watches.create, { productUrl: URL })).rejects.toThrow(/up to 50/);
  });
});

describe("watches ownership", () => {
  it("hides a watch from another user and refuses every write", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const watchId = await seedWatch(t, owner.userId, { nextCheckAt: T0 + DAY });
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    vi.setSystemTime(T0 + DAY);

    expect(await other.as.query(api.watches.list, {})).toEqual([]);
    expect(await other.as.query(api.watches.get, { watchId })).toBeNull();
    expect(await owner.as.query(api.watches.list, {})).toHaveLength(1);

    const o = other.as;
    await expect(o.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(ConvexError);
    await expect(o.mutation(api.watches.archive, { watchId })).rejects.toThrow(ConvexError);
    await expect(o.mutation(api.watches.setTarget, { watchId, targetCents: 1 })).rejects.toThrow(ConvexError);
    await expect(o.mutation(api.watches.setStatus, { watchId, status: "paused" })).rejects.toThrow(ConvexError);
    await expect(o.mutation(api.watches.rename, { watchId, name: "mine now" })).rejects.toThrow(ConvexError);

    // The one scheduled job is the owner's own market-history lookup (W1b), from the accepted check above.
    const jobs = await scheduled(t);
    expect(jobs.every((j) => String(j.name).includes("market"))).toBe(true);
    const row = await watchRow(t, watchId);
    expect(row.status).toBe("active");
    expect(row.targetCents).toBeUndefined();
    expect(row.name).toBe("acme.example: down jacket");
  });

  it("returns nothing to a signed-out caller and refuses their writes", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    expect(await t.query(api.watches.list, {})).toEqual([]);
    expect(await t.query(api.watches.get, { watchId })).toBeNull();
    await expect(t.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(ConvexError);
    await expect(t.mutation(api.watches.archive, { watchId })).rejects.toThrow(ConvexError);
  });
});

describe("watches.rename (F1)", () => {
  it("trims and keeps a safe name", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await as.mutation(api.watches.rename, { watchId, name: "  Blue jacket, M  " });
    expect((await watchRow(t, watchId)).name).toBe("Blue jacket, M");
  });

  it("F1: strips a control character (subject/header injection) from a renamed watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await as.mutation(api.watches.rename, { watchId, name: "Jacket\r\nBcc: evil@example.com" });
    expect((await watchRow(t, watchId)).name).not.toMatch(/[\r\n]/);
  });

  it("rejects a name over the 200-char cap", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await expect(as.mutation(api.watches.rename, { watchId, name: "x".repeat(201) })).rejects.toThrow(
      /200 characters/,
    );
    await expect(as.mutation(api.watches.rename, { watchId, name: "x".repeat(200) })).resolves.toBeNull();
  });
});

describe("watches.checkNow cooldown", () => {
  it("refuses a second click, and a click right after a recorded check, then allows one", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);

    await expect(as.mutation(api.watches.checkNow, { watchId })).resolves.toBeNull();
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(/just checked/);
    expect(await scheduled(t)).toHaveLength(1);

    vi.setSystemTime(T0 + WATCH_CHECK_COOLDOWN_MS - 1);
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(/just checked/);

    vi.setSystemTime(T0 + WATCH_CHECK_COOLDOWN_MS);
    await expect(as.mutation(api.watches.checkNow, { watchId })).resolves.toBeNull();
    expect(await scheduled(t)).toHaveLength(2);

    // A check the sweep recorded counts too.
    vi.setSystemTime(T0 + HOUR);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(/just checked/);
  });

  it("applies to a freshly created watch", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const watchId = await as.mutation(api.watches.create, { productUrl: URL });
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(/just checked/);
  });

  it("refuses an archived watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { status: "archived" });
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(ConvexError);
    expect(await scheduled(t)).toHaveLength(0);
  });
});

describe("watches.recordWatchCheck acceptance (D16)", () => {
  it("accepts a clean observation and moves the watch on", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);

    const res = await t.mutation(internal.watches.recordWatchCheck, {
      ...good(watchId, 7_500),
      listCents: 10_000,
      productName: "Acme Down Jacket",
    });

    expect(res.accepted).toBe(true);
    expect(res.note).toBeNull();
    const row = await watchRow(t, watchId);
    expect(row.lastCents).toBe(7_500);
    expect(row.currency).toBe("USD");
    expect(row.name).toBe("Acme Down Jacket");
    expect(row.lastCheckedAt).toBe(T0);
    expect(row.lastObservedAt).toBe(T0);
    expect(row.nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
    const checks = await checksFor(t, watchId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBe(7_500);
    expect(checks[0].listCents).toBe(10_000);
    expect(checks[0].userId).toBe(userId);

    const got = await as.query(api.watches.get, { watchId });
    expect(got?.watch.lastCents).toBe(7_500);
    expect(got?.watch.listCents).toBe(10_000);
    // P06/D73: raw `checkRequestedAt` (null here: never requested) replaces the old `checking` boolean.
    expect(got?.watch.checkRequestedAt).toBeNull();
    expect(got?.watch.lastObservedAt).toBe(T0);
    expect(got?.watch.priceStale).toBe(false);
    expect(got?.watch.verdict.label).toBe("not_enough_history");
    expect(got?.watch.verdict.reason).toContain("25% off");
    expect(got?.checks).toHaveLength(1);
  });

  it("does not overwrite a name the user chose", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { name: "Gift for Sam" });
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 7_500), productName: "Acme Down Jacket" });
    expect((await watchRow(t, watchId)).name).toBe("Gift for Sam");
  });

  it("drops a 'was' price that is not above the price", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 7_500), listCents: 7_500 });
    expect((await checksFor(t, watchId))[0].listCents).toBeUndefined();
  });

  const rejections: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a price range", { isRange: true }, /range/],
    ["low confidence", { confidence: 0.69 }, /confidence/i],
    ["missing confidence", { confidence: undefined }, /confidence/i],
    ["no currency", { currency: undefined }, /currency/],
    ["a currency that is not a code", { currency: "dollars" }, /currency/],
    ["an unsure variant", { variantMatch: "unsure" }, /variant/],
    ["a page that is not the product", { variantMatch: "none" }, /does not price/],
    ["a negative amount", { observedCents: -1 }, /does not show a price/],
    ["a fractional amount", { observedCents: 10.5 }, /does not show a price/],
    ["a zero amount (a model's way of saying no price)", { observedCents: 0 }, /does not show a price/],
  ];
  it.each(rejections)("stores %s as a note with no cents", async (_label, override, pattern) => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);

    const res = await t.mutation(internal.watches.recordWatchCheck, {
      ...good(watchId, 7_500),
      listCents: 10_000,
      ...override,
    });

    expect(res.accepted).toBe(false);
    expect(res.note).toMatch(pattern);
    const checks = await checksFor(t, watchId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].listCents).toBeUndefined();
    expect(checks[0].note).toMatch(pattern);
    const row = await watchRow(t, watchId);
    expect(row.lastCents).toBeUndefined();
    expect(row.currency).toBeUndefined();
    // A rejection still counts as a check: the watch moves to its next slot.
    expect(row.lastCheckedAt).toBe(T0);
    expect(row.nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
  });

  it("at exactly the confidence bar, accepts", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const res = await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 7_500), confidence: 0.7 });
    expect(res.accepted).toBe(true);
  });

  it("fixes the currency on the first accepted check and rejects a different one later", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_500));
    vi.setSystemTime(T0 + HOUR);

    const res = await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 6_900), currency: "CAD" });

    expect(res.accepted).toBe(false);
    expect(res.note).toMatch(/CAD.*USD/);
    const row = await watchRow(t, watchId);
    expect(row.lastCents).toBe(7_500);
    expect(row.currency).toBe("USD");
    const listed = await as.query(api.watches.list, {});
    expect(listed[0].lastCents).toBe(7_500);
    expect(listed[0].lastNote).toMatch(/CAD/);
    expect(listed[0].spark).toEqual([{ observedAt: T0, observedCents: 7_500 }]);
  });

  it("feeds the verdict from accepted checks only, oldest first in the sparkline", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const prices = [10_000, 10_000, 10_000, 8_000];
    for (let i = 0; i < prices.length; i++) {
      vi.setSystemTime(T0 + i * 3 * DAY);
      await t.mutation(internal.watches.recordWatchCheck, good(watchId, prices[i]));
      await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 1), isRange: true });
    }

    const [w] = await as.query(api.watches.list, {});
    expect(w.verdict.label).toBe("good_price");
    expect(w.verdict.reason).toContain("$80.00");
    expect(w.spark.map((p) => p.observedCents)).toEqual(prices);
    expect(w.lastNote).toMatch(/range/);

    await as.mutation(api.watches.setTarget, { watchId, targetCents: 8_000 });
    expect((await as.query(api.watches.list, {}))[0].targetHit).toBe(true);
    await as.mutation(api.watches.setTarget, { watchId, targetCents: 7_999 });
    expect((await as.query(api.watches.list, {}))[0].targetHit).toBe(false);
    await as.mutation(api.watches.setTarget, { watchId, targetCents: null });
    expect((await as.query(api.watches.list, {}))[0].targetCents).toBeNull();
  });
});

describe("watches.checkWatch", () => {
  it("records what the page showed, asking the extractor to name an unnamed product", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    vi.mocked(observePrice).mockResolvedValueOnce({
      observedCents: 7_500,
      listCents: 10_000,
      productName: "Acme Down Jacket",
      currency: "USD",
      confidence: 0.9,
      isRange: false,
      variantMatch: "exact",
      note: undefined,
    });

    await t.action(internal.watches.checkWatch, { watchId });

    expect(vi.mocked(observePrice)).toHaveBeenCalledTimes(1);
    const [, name, url] = vi.mocked(observePrice).mock.calls[0];
    expect(name).toBeNull();
    expect(url).toBe(URL);
    const row = await watchRow(t, watchId);
    expect(row.lastCents).toBe(7_500);
    expect(row.name).toBe("Acme Down Jacket");
  });

  it("stores a failed scrape as a note and still advances the watch", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { name: "Gift for Sam" });
    vi.mocked(observePrice).mockRejectedValueOnce(new Error(`Firecrawl 502 ${"x".repeat(2_000)}`));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(t.action(internal.watches.checkWatch, { watchId })).resolves.toBeNull();
    quiet.mockRestore();

    expect(vi.mocked(observePrice).mock.calls[0][1]).toBe("Gift for Sam");
    const checks = await checksFor(t, watchId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].note).toMatch(/^Price check failed: Firecrawl 502/);
    expect(checks[0].note?.length).toBeLessThanOrEqual(500);
    const row = await watchRow(t, watchId);
    expect(row.lastCents).toBeUndefined();
    expect(row.nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
  });

  it("T24c (D109): a scrape failure logs one price_check_failed JSON line via logEvent, never a raw console.error", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { name: "Gift for Sam" });
    vi.mocked(observePrice).mockRejectedValueOnce(
      new Error("upstream call failed using key sk-abcdefghij1234567890 for sam@home.example"),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await t.action(internal.watches.checkWatch, { watchId });

    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    spy.mockRestore();
    expect(line.kind).toBe("price_check_failed");
    expect(line.watchId).toBe(String(watchId));
    expect(typeof line.error).toBe("string");
    // correlationId/at are excluded before the leak check below: correlationId is a random UUID
    // (crypto.randomUUID()) whose hex/hyphen characters can incidentally match the sk-/fc- shape
    // (~1% per run) -- not a leak, just a coincidental substring of a random id.
    delete line.correlationId;
    delete line.at;
    const raw = JSON.stringify(line);
    // sanitizeError collapses the raw error down to one of a small set of fixed, user-safe
    // categories (convex/lib/errors.ts) -- the injected secret/email never survives into the line.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/fc-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/sam@home\.example/);
  });

  it("does nothing for an archived watch", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { status: "archived" });
    await t.action(internal.watches.checkWatch, { watchId });
    expect(vi.mocked(observePrice)).not.toHaveBeenCalled();
    expect(await checksFor(t, watchId)).toHaveLength(0);
  });

  it("F5: schedules an offers recheck when a confirmed offer is overdue", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId,
        userId,
        storeDomain: "other.example",
        productUrl: "https://other.example/p",
        title: "Down Jacket",
        status: "confirmed",
        lastCents: 9_000,
        currency: "USD",
        lastCheckedAt: T0 - 7 * HOUR, // older than OFFER_FIND_COOLDOWN_MS (6h)
      }),
    );
    vi.mocked(observePrice).mockResolvedValueOnce({
      observedCents: 7_500,
      currency: "USD",
      confidence: 0.9,
      isRange: false,
      variantMatch: "exact",
    });

    await t.action(internal.watches.checkWatch, { watchId });

    const jobs = await scheduled(t);
    expect(jobs.some((j) => j.name.includes("offers"))).toBe(true);
  });

  it("F5: does not schedule an offers recheck when nothing is confirmed or overdue", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    // A confirmed offer that was just checked -- not overdue -- must not
    // trigger a recheck on every 2h watch tick.
    await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId,
        userId,
        storeDomain: "other.example",
        productUrl: "https://other.example/p",
        title: "Down Jacket",
        status: "confirmed",
        lastCents: 9_000,
        currency: "USD",
        lastCheckedAt: T0,
      }),
    );
    vi.mocked(observePrice).mockResolvedValueOnce({
      observedCents: 7_500,
      currency: "USD",
      confidence: 0.9,
      isRange: false,
      variantMatch: "exact",
    });

    await t.action(internal.watches.checkWatch, { watchId });

    const jobs = await scheduled(t);
    expect(jobs.some((j) => j.name.includes("offers"))).toBe(false);
  });

  it("F5: does not schedule an offers recheck when the check itself was rejected", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId,
        userId,
        storeDomain: "other.example",
        productUrl: "https://other.example/p",
        title: "Down Jacket",
        status: "confirmed",
        lastCents: 9_000,
        currency: "USD",
        lastCheckedAt: T0 - 7 * HOUR,
      }),
    );
    vi.mocked(observePrice).mockResolvedValueOnce({ note: "The product page could not be read" });

    await t.action(internal.watches.checkWatch, { watchId });

    const jobs = await scheduled(t);
    expect(jobs.some((j) => j.name.includes("offers"))).toBe(false);
  });
});

describe("watches.sweep", () => {
  it("schedules only due active watches and pushes them out of the due range", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const dueA = await seedWatch(t, userId, { nextCheckAt: T0 - HOUR });
    const dueB = await seedWatch(t, userId, { nextCheckAt: T0 });
    const notYet = await seedWatch(t, userId, { nextCheckAt: T0 + 1 });
    const paused = await seedWatch(t, userId, { status: "paused", nextCheckAt: T0 - HOUR });
    const archived = await seedWatch(t, userId, { status: "archived", nextCheckAt: T0 - HOUR });
    const bought = await seedWatch(t, userId, { status: "bought", nextCheckAt: T0 - HOUR });

    expect(await t.mutation(internal.watches.sweep, {})).toBe(2);

    const jobs = await scheduled(t);
    expect(jobs).toHaveLength(2);
    const targets = jobs.map((j) => (j.args[0] as { watchId: string }).watchId).sort();
    expect(targets).toEqual([dueA, dueB].map(String).sort());
    expect(jobs.map((j) => j.scheduledTime).sort()).toEqual([T0, T0 + 2_000]);
    for (const id of [dueA, dueB]) {
      expect((await watchRow(t, id)).nextCheckAt).toBe(T0 + WATCH_SWEEP_BUMP_MS);
    }
    expect((await watchRow(t, notYet)).nextCheckAt).toBe(T0 + 1);
    for (const id of [paused, archived, bought]) {
      expect((await watchRow(t, id)).nextCheckAt).toBe(T0 - HOUR);
    }

    // A second tick inside the bump finds nothing due.
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
    expect(await scheduled(t)).toHaveLength(2);
  });

  it("reads a bounded page (WATCH_SWEEP_PAGE) but a single user is capped at WATCH_SWEEP_PER_USER per tick (D74)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < 53; i++) await seedWatch(t, userId, { nextCheckAt: T0 - i });
    // Tick 1: the full 50-row page is read (all this one user's), but only
    // WATCH_SWEEP_PER_USER=10 are actually scheduled; the other 40 in that
    // page are rotated (bumped, not scheduled) so the page advances instead
    // of repeating. The 3 rows never read this tick are untouched.
    expect(await t.mutation(internal.watches.sweep, {})).toBe(10);
    expect((await scheduled(t)).length).toBe(10);
    // Tick 2: only the 3 never-read rows are still due (the 40 rotated ones
    // were bumped WATCH_SWEEP_BUMP_MS into the future); a fresh per-tick cap
    // easily covers all 3.
    expect(await t.mutation(internal.watches.sweep, {})).toBe(3);
    expect((await scheduled(t)).length).toBe(13);
    // Nothing left due at this fixed clock.
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
  });
});

describe("watches.setStatus / archive", () => {
  it("pauses, resumes as due, and is a no-op on a retry", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { nextCheckAt: T0 - DAY });

    await as.mutation(api.watches.setStatus, { watchId, status: "paused" });
    await as.mutation(api.watches.setStatus, { watchId, status: "paused" });
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);

    vi.setSystemTime(T0 + HOUR);
    await as.mutation(api.watches.setStatus, { watchId, status: "active" });
    expect((await watchRow(t, watchId)).nextCheckAt).toBe(T0 + HOUR);
    // Resuming spends nothing by itself.
    expect(await scheduled(t)).toHaveLength(0);
    expect(await t.mutation(internal.watches.sweep, {})).toBe(1);
  });

  it("does not make a recently checked watch due on resume", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_500));
    await as.mutation(api.watches.setStatus, { watchId, status: "paused" });
    vi.setSystemTime(T0 + HOUR);
    await as.mutation(api.watches.setStatus, { watchId, status: "active" });
    expect((await watchRow(t, watchId)).nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
  });

  it("archives idempotently, hides the watch, and cannot be resumed", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const kept = await seedWatch(t, userId, { name: "Keep me" });

    await as.mutation(api.watches.archive, { watchId });
    await as.mutation(api.watches.archive, { watchId });

    const listed = await as.query(api.watches.list, {});
    expect(listed.map((w) => w._id)).toEqual([kept]);
    expect(await as.query(api.watches.get, { watchId })).toBeNull();
    await expect(as.mutation(api.watches.setStatus, { watchId, status: "active" })).rejects.toThrow(ConvexError);
  });
});

describe("watches.markBought (W4)", () => {
  const bought = (watchId: Id<"watches">) => ({ watchId, paidCents: 8_000, purchasedAt: T0 - DAY });

  it("turns the watch into an owned active purchase with its price history carried over", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { name: "Down Jacket" });
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    vi.setSystemTime(T0 + HOUR);
    await t.mutation(internal.watches.recordWatchCheck, { watchId, sourceUrl: URL, note: "Page did not load" });
    vi.setSystemTime(T0 + 2 * HOUR);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 9_000));

    const purchaseId = await as.mutation(api.watches.markBought, {
      ...bought(watchId),
      qty: 2,
      orderRef: "  AC-77 ",
    });

    const detail = await as.query(api.purchases.get, { purchaseId });
    expect(detail.purchase).toMatchObject({
      userId,
      status: "active",
      merchant: "Acme",
      merchantDomain: "acme.example",
      currency: "USD",
      orderRef: "AC-77",
      purchasedAt: T0 - DAY,
    });
    expect(detail.items).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({
      name: "Down Jacket",
      unitCents: 8_000,
      qty: 2,
      productUrl: URL,
      returned: false,
    });
    // Accepted checks only, newest first, original observation times kept.
    expect(detail.items[0].priceChecks.map((c) => [c.observedCents, c.observedAt])).toEqual([
      [9_000, T0 + 2 * HOUR],
      [10_000, T0],
    ]);

    const row = await watchRow(t, watchId);
    expect(row.status).toBe("bought");
    expect(row.purchaseId).toBe(purchaseId);
    // The policy research is scheduled exactly as purchases.create does.
    const jobs = await scheduled(t);
    expect(jobs.filter((j) => j.name.includes("fetchBoth"))).toHaveLength(1);
  });

  it("defaults qty to 1 and currency to USD, and works for a paused watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { status: "paused" });
    const purchaseId = await as.mutation(api.watches.markBought, bought(watchId));
    const detail = await as.query(api.purchases.get, { purchaseId });
    expect(detail.purchase.currency).toBe("USD");
    expect(detail.items[0].qty).toBe(1);
    expect(detail.items[0].priceChecks).toEqual([]);
  });

  it("carries over at most the newest 90 accepted checks", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 95; i++) {
        await ctx.db.insert("watchChecks", {
          watchId,
          userId,
          observedCents: 10_000 + i,
          currency: "USD",
          observedAt: T0 - (95 - i) * HOUR,
          sourceUrl: URL,
        });
      }
    });
    const purchaseId = await as.mutation(api.watches.markBought, bought(watchId));
    const copied = await t.run(async (ctx) => {
      const item = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
        .unique();
      return ctx.db
        .query("priceChecks")
        .withIndex("by_item", (q) => q.eq("itemId", item!._id))
        .collect();
    });
    expect(copied).toHaveLength(90);
    expect(copied[0].observedCents).toBe(10_005);
    expect(copied[89].observedCents).toBe(10_094);
  });

  it("refuses another user's watch and a signed-out caller, writing nothing", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const watchId = await seedWatch(t, owner.userId);

    await expect(other.as.mutation(api.watches.markBought, bought(watchId))).rejects.toThrow(/Watch not found/);
    await expect(t.mutation(api.watches.markBought, bought(watchId))).rejects.toThrow(ConvexError);

    expect(await t.run((ctx) => ctx.db.query("purchases").collect())).toHaveLength(0);
    expect((await watchRow(t, watchId)).status).toBe("active");
  });

  it("refuses a second call, so a retry cannot create a second purchase", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await as.mutation(api.watches.markBought, bought(watchId));
    await expect(as.mutation(api.watches.markBought, bought(watchId))).rejects.toThrow(/already marked as bought/);
    expect(await t.run((ctx) => ctx.db.query("purchases").collect())).toHaveLength(1);
  });

  it("refuses an archived watch and bad input", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const archived = await seedWatch(t, userId, { status: "archived" });
    await expect(as.mutation(api.watches.markBought, bought(archived))).rejects.toThrow(/no longer being watched/);

    const watchId = await seedWatch(t, userId);
    const bad = [
      { paidCents: 0 },
      { paidCents: 19.99 },
      { paidCents: Number.NaN },
      { purchasedAt: T0 + 3 * DAY },
      { purchasedAt: -1 },
      { qty: 0 },
      { qty: 1.5 },
      { orderRef: "x".repeat(101) },
    ];
    for (const over of bad) {
      await expect(as.mutation(api.watches.markBought, { ...bought(watchId), ...over })).rejects.toThrow(ConvexError);
    }
    expect(await t.run((ctx) => ctx.db.query("purchases").collect())).toHaveLength(0);
  });

  it("a bought watch is never swept, checked or alerted again", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) => ctx.db.patch(watchId, { targetCents: 20_000 }));
    await as.mutation(api.watches.markBought, bought(watchId));
    const before = (await scheduled(t)).length;

    vi.setSystemTime(T0 + 2 * DAY);
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(/no longer being watched/);
    expect(await t.query(internal.watches.watchForCheck, { watchId })).toBeNull();
    // A check that was already in flight still records, but claims no alert.
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 5_000));
    expect(await t.run((ctx) => ctx.db.query("mailLog").collect())).toHaveLength(0);
    expect((await scheduled(t)).length).toBe(before);
  });
});

describe("watch images", () => {
  const IMG = "https://cdn.acme.example/i/jacket.jpg";

  it("stores the page image only when it is an absolute https URL, and exposes it in list and get", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    for (const imageUrl of ["http://cdn.acme.example/i.jpg", "//cdn.acme.example/i.jpg", "/i/jacket.jpg", "data:image/png;base64,AA", `https://cdn.acme.example/${"x".repeat(2_000)}`]) {
      await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 10_000), imageUrl });
      expect((await watchRow(t, watchId)).imageUrl).toBeUndefined();
    }
    expect((await as.query(api.watches.list, {}))[0].imageUrl).toBeNull();

    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 10_000), imageUrl: IMG });
    expect((await watchRow(t, watchId)).imageUrl).toBe(IMG);
    expect((await as.query(api.watches.list, {}))[0].imageUrl).toBe(IMG);
    expect((await as.query(api.watches.get, { watchId }))!.watch.imageUrl).toBe(IMG);

    // A later check without an image, or with a bad one, keeps what we have; a changed one replaces it.
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 10_000), imageUrl: "http://x.example/i.jpg" });
    expect((await watchRow(t, watchId)).imageUrl).toBe(IMG);
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 10_000), imageUrl: `${IMG}?v=2` });
    expect((await watchRow(t, watchId)).imageUrl).toBe(`${IMG}?v=2`);
  });

  it("ignores the image of a page that is not the product, but keeps one from an unpriced read", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 10_000), variantMatch: "none", imageUrl: IMG });
    expect((await watchRow(t, watchId)).imageUrl).toBeUndefined();
    await t.mutation(internal.watches.recordWatchCheck, { watchId, sourceUrl: URL, note: "The page does not show a single price", imageUrl: IMG });
    expect((await watchRow(t, watchId)).imageUrl).toBe(IMG);
  });

  it("checkWatch threads the scraped image through, and markBought carries it to the item", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    vi.mocked(observePrice).mockResolvedValueOnce({
      observedCents: 7_500, currency: "USD", confidence: 0.9, isRange: false, variantMatch: "exact", imageUrl: IMG,
    });
    await t.action(internal.watches.checkWatch, { watchId });
    expect(vi.mocked(observePrice)).toHaveBeenCalledTimes(1); // one scrape, not two
    expect((await watchRow(t, watchId)).imageUrl).toBe(IMG);

    const purchaseId = await as.mutation(api.watches.markBought, { watchId, paidCents: 7_500, purchasedAt: T0 - 86_400_000 });
    const items = await t.run((ctx) => ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).collect());
    expect(items).toHaveLength(1);
    expect(items[0].imageUrl).toBe(IMG);
    const overview = await as.query(api.tracking.overview, {});
    expect(overview.items.find((i) => i.itemId === items[0]._id)?.imageUrl).toBe(IMG);
  });
});

describe("watch spend caps (pre-launch review H2, H3, B4)", () => {
  const usage = async (t: T) => await t.run((ctx) => ctx.db.query("usage").collect());
  const pendingNamed = async (t: T, name: string) => (await scheduled(t)).filter((j) => j.name.includes(name)).length;
  const spendGlobal = async (t: T, kind: "price_check" | "policy_fetch", left: number) =>
    await t.run((ctx) => ctx.db.insert("usage", { day: "2026-09-20", kind, count: GLOBAL_DAILY_BUDGETS[kind].max - left }));

  it(`checkNow stops at ${DAILY_BUDGETS.watch_check.max} a day per user, on top of the per-watch cooldown`, async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const max = DAILY_BUDGETS.watch_check.max;
    const ids: Id<"watches">[] = [];
    for (let i = 0; i <= max; i++) ids.push(await seedWatch(t, userId));

    for (let i = 0; i < max; i++) await as.mutation(api.watches.checkNow, { watchId: ids[i] });
    // The cooldown still applies to a watch that was just checked...
    await expect(as.mutation(api.watches.checkNow, { watchId: ids[0] })).rejects.toThrow(/just checked/);
    // ...and a fresh watch is refused by the daily budget, with nothing stamped or scheduled.
    await expect(as.mutation(api.watches.checkNow, { watchId: ids[max] })).rejects.toThrow(
      /today's limit for checking prices on watched items/,
    );
    expect((await watchRow(t, ids[max])).checkRequestedAt).toBeUndefined();
    expect(await pendingNamed(t, "checkWatch")).toBe(max);
    expect((await usage(t)).find((r) => r.userId === undefined)).toMatchObject({ kind: "price_check", count: max });

    const other = await signedIn(t, "Other");
    await other.as.mutation(api.watches.checkNow, { watchId: await seedWatch(t, other.userId) });

    vi.setSystemTime(T0 + DAY);
    await as.mutation(api.watches.checkNow, { watchId: ids[max] });
  });

  it("the sweep schedules only what the global switch still allows and leaves the rest due", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const ids: Id<"watches">[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seedWatch(t, userId, { nextCheckAt: T0 - (5 - i) * HOUR }));
    await spendGlobal(t, "price_check", 2);

    expect(await t.mutation(internal.watches.sweep, {})).toBe(2);
    expect(await pendingNamed(t, "checkWatch")).toBe(2);
    // The two longest overdue went; the others were not bumped, so they are first in line tomorrow.
    expect((await watchRow(t, ids[0])).nextCheckAt).toBe(T0 + WATCH_SWEEP_BUMP_MS);
    expect((await watchRow(t, ids[4])).nextCheckAt).toBe(T0 - HOUR);
    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);

    vi.setSystemTime(T0 + DAY);
    expect(await t.mutation(internal.watches.sweep, {})).toBe(5);
  });

  it("create is refused, with no row written, once the global switch is spent", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await spendGlobal(t, "price_check", 0);
    await expect(as.mutation(api.watches.create, { productUrl: URL })).rejects.toThrow(/Recoup has reached today's limit/);
    expect(await t.run((ctx) => ctx.db.query("watches").collect())).toHaveLength(0);
  });

  it("create refuses an internal host and an unusual port (M2)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    for (const productUrl of ["http://metadata.google.internal/x", "https://printer.local/x", "https://acme.example:8080/p"]) {
      await expect(as.mutation(api.watches.create, { productUrl })).rejects.toThrow(ConvexError);
    }
  });

  it(`markBought shares the ${DAILY_BUDGETS.policy_fetch.max}-a-day policy research budget; past it the purchase is still made`, async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const max = DAILY_BUDGETS.policy_fetch.max;
    for (let i = 0; i < max + 2; i++) {
      const watchId = await seedWatch(t, userId, { currency: "USD" });
      await as.mutation(api.watches.markBought, { watchId, paidCents: 8_000, purchasedAt: T0 - DAY });
    }
    expect(await pendingNamed(t, "fetchBoth")).toBe(max);
    expect(await t.run((ctx) => ctx.db.query("purchases").collect())).toHaveLength(max + 2);
    const rows = await usage(t);
    expect(rows.find((r) => r.userId === userId && r.kind === "policy_fetch")?.count).toBe(max);
    expect(rows.find((r) => r.userId === undefined && r.kind === "policy_fetch")?.count).toBe(max * 2);
  });

  it("a spent global policy switch skips the research for everyone and charges nobody", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await spendGlobal(t, "policy_fetch", 1); // one unit left, a fetchBoth needs two
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    await as.mutation(api.watches.markBought, { watchId, paidCents: 8_000, purchasedAt: T0 - DAY });
    expect(await pendingNamed(t, "fetchBoth")).toBe(0);
    expect((await usage(t)).filter((r) => r.userId === userId)).toHaveLength(0);
  });
});

describe("P06 (D73): no reactive query result depends on the server's wall clock", () => {
  it("grep: list/get's query bodies and summarise() never call Date.now() directly", () => {
    // `URL` is shadowed by this file's own `const URL = "https://..."` fixture above; use the global explicitly.
    const src = readFileSync(new globalThis.URL("./watches.ts", import.meta.url), "utf8");

    const listStart = src.indexOf("export const list = query({");
    const getStart = src.indexOf("export const get = query({");
    const getSectionEnd = src.indexOf(
      "// ---------------------------------------------------------------------------",
      getStart,
    );
    expect(listStart).toBeGreaterThan(-1);
    expect(getStart).toBeGreaterThan(listStart);
    expect(getSectionEnd).toBeGreaterThan(getStart);
    expect(src.slice(listStart, getStart)).not.toContain("Date.now()");
    expect(src.slice(getStart, getSectionEnd)).not.toContain("Date.now()");

    // `summarise` is the shared computation both queries call into; the same rule applies.
    const summariseStart = src.indexOf("function summarise(");
    const summariseEnd = src.indexOf("\n/**\n * The caller's non-archived watches", summariseStart);
    expect(summariseStart).toBeGreaterThan(-1);
    expect(summariseEnd).toBeGreaterThan(summariseStart);
    expect(src.slice(summariseStart, summariseEnd)).not.toContain("Date.now()");
  });

  it("list called twice with different `now` args returns different derived fields but identical stored ones", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_500));

    const fresh = (await as.query(api.watches.list, { now: T0 }))[0];
    // assertCoarseNow bounds `now` to within a day of the server's own clock,
    // so the second call also advances the (faked) real clock -- it is still
    // the QUERY's own `now` argument, not a `Date.now()` read inside it, that
    // drives the different result below.
    vi.setSystemTime(T0 + 4 * DAY);
    const stale = (await as.query(api.watches.list, { now: T0 + 4 * DAY }))[0];

    // Stored fields: unaffected by `now`.
    expect(fresh._creationTime).toBe(stale._creationTime);
    expect(fresh.lastCents).toBe(stale.lastCents);
    expect(fresh.lastObservedAt).toBe(stale.lastObservedAt);
    expect(fresh.lastCheckedAt).toBe(stale.lastCheckedAt);
    // Derived fields: differ because `now` differs (STALE_PRICE_MS = 3 days).
    expect(fresh.priceStale).toBe(false);
    expect(stale.priceStale).toBe(true);
    expect(fresh.verdict.label).not.toBe(stale.verdict.label);
  });

  it("an out-of-bounds `now` is refused rather than silently skewing the result", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.query(api.watches.list, { now: T0 + 5 * DAY })).rejects.toThrow(ConvexError);
    await expect(as.query(api.watches.list, { now: Number.NaN })).rejects.toThrow(ConvexError);
  });
});

describe("P06 (D73): failed reads cannot make an old price look current", () => {
  it("verdict is unknown with the staleness reason after only failed reads for 3+ days", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_500)); // day 0: accepted

    for (let day = 1; day <= 4; day++) {
      vi.setSystemTime(T0 + day * DAY);
      // A rejected observation every day: lastCheckedAt keeps moving, lastObservedAt/lastCents must not.
      await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 7_000 + day), isRange: true });
    }

    const row = await watchRow(t, watchId);
    expect(row.lastObservedAt).toBe(T0);
    expect(row.lastCents).toBe(7_500);
    expect(row.lastCheckedAt).toBe(T0 + 4 * DAY);

    const now = T0 + 4 * DAY;
    const got = await as.query(api.watches.get, { watchId, now });
    expect(got?.watch.priceStale).toBe(true);
    expect(got?.watch.targetHit).toBe(false);
    expect(got?.watch.verdict.label).toBe("unknown");
    expect(got?.watch.verdict.reason).toMatch(/days ago/);
    expect(got?.watch.verdict.qualified).toBe(true);
    // Still shows the last real price and exactly when it was seen and last attempted -- not silence.
    expect(got?.watch.lastCents).toBe(7_500);
    expect(got?.watch.lastObservedAt).toBe(T0);
    expect(got?.watch.lastCheckedAt).toBe(T0 + 4 * DAY);
  });
});

describe("F10 (D103): priceObservedAt stays consistent with priceStale even off the normal recordWatchCheck path", () => {
  it("a directly-seeded row with lastCents but no lastObservedAt still gets a stale/unknown verdict, not 'not enough history'", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    // Not reachable through recordWatchCheck (which always sets lastCents
    // and lastObservedAt together) -- simulates a legacy/migrated/seeded row
    // where only one of the two was written, the state F10 defends against.
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId,
        name: "Legacy row",
        productUrl: URL,
        merchantDomain: "acme.example",
        currency: "USD",
        status: "active",
        nextCheckAt: T0,
        lastCents: 9_000,
        lastCheckedAt: T0 - 4 * DAY, // an attempt was made, long ago
        // lastObservedAt intentionally omitted.
      }),
    );

    const got = await as.query(api.watches.get, { watchId, now: T0 });
    expect(got?.watch.priceStale).toBe(true);
    expect(got?.watch.lastCents).toBe(9_000);
    // Before this fix, `priceObservedAt: watch.lastObservedAt` was
    // `undefined`, so verdictCore's own staleness check never ran, and with
    // zero accepted checks in history it fell through to "not_enough_history"
    // instead -- inconsistent with `priceStale: true` on the very same row.
    expect(got?.watch.verdict.label).toBe("unknown");
    expect(got?.watch.verdict.reason).toMatch(/days ago/);
    expect(got?.watch.verdict.qualified).toBe(true);
  });
});

describe("D87: a tombstoned owner's rows are skipped by every scheduled reader", () => {
  async function tombstone(t: T, userId: Id<"users">) {
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));
  }

  it("sweep does not schedule a tombstoned user's due watch, but bumps it out of the due set (F2, D103)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { nextCheckAt: T0 - HOUR });
    await tombstone(t, userId);

    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
    expect((await scheduled(t)).length).toBe(0);
    // F2: bumped far out of the due set (not left at T0 - HOUR, which would
    // put it right back at the head of the very next tick's scan) -- the old
    // behavior let a backlog of tombstoned rows occupy the due page forever.
    expect((await watchRow(t, watchId)).nextCheckAt).toBeGreaterThan(T0 + 300 * DAY);
  });

  it("F2 (D103): due watches on a deleting user (under one page) do not block a live user's due watch on tick 1", async () => {
    const t = setup();
    const { userId: gone } = await signedIn(t, "Gone");
    const { userId: live } = await signedIn(t, "Live");
    // One fewer than WATCH_SWEEP_PAGE, so the live watch is guaranteed a slot
    // in the same due page regardless of tie-break order among equal
    // nextCheckAt values -- this isolates the tombstoned-bump fix itself
    // (below) from the separate, page-boundary starvation case.
    for (let i = 0; i < 49; i++) {
      await seedWatch(t, gone, { nextCheckAt: T0 - HOUR, name: `gone ${i}` });
    }
    await tombstone(t, gone);
    const liveWatchId = await seedWatch(t, live, { nextCheckAt: T0 - HOUR });

    expect(await t.mutation(internal.watches.sweep, {})).toBe(1);
    const jobs = await scheduled(t);
    expect(jobs.map((j) => (j.args[0] as { watchId: string }).watchId)).toEqual([String(liveWatchId)]);
  });

  it("F2 (D103): a full page (WATCH_SWEEP_PAGE) of due watches on a deleting user never permanently blocks a live user's watch", async () => {
    const t = setup();
    const { userId: gone } = await signedIn(t, "Gone");
    const { userId: live } = await signedIn(t, "Live");
    // Exactly one page of tombstoned, due watches, all older (created
    // first) than the live one: the very first sweep may not even reach the
    // live watch's row, but -- unlike before this fix, where these rows
    // were never touched and would occupy the exact same page forever --
    // every one of them is bumped out of the due set in that same call, so
    // the live watch is reachable by the very next tick.
    for (let i = 0; i < 50; i++) {
      await seedWatch(t, gone, { nextCheckAt: T0 - HOUR, name: `gone ${i}` });
    }
    await tombstone(t, gone);
    const liveWatchId = await seedWatch(t, live, { nextCheckAt: T0 - HOUR });

    expect(await t.mutation(internal.watches.sweep, {})).toBe(0);
    expect((await scheduled(t)).length).toBe(0);

    expect(await t.mutation(internal.watches.sweep, {})).toBe(1);
    const jobs = await scheduled(t);
    expect(jobs.map((j) => (j.args[0] as { watchId: string }).watchId)).toEqual([String(liveWatchId)]);
  });

  it("sweep still serves other users' due watches in the same tick", async () => {
    const t = setup();
    const { userId: gone } = await signedIn(t, "Gone");
    const { userId: active } = await signedIn(t, "Active");
    await seedWatch(t, gone, { nextCheckAt: T0 - HOUR });
    const activeWatchId = await seedWatch(t, active, { nextCheckAt: T0 - HOUR });
    await tombstone(t, gone);

    expect(await t.mutation(internal.watches.sweep, {})).toBe(1);
    const jobs = await scheduled(t);
    expect(jobs.map((j) => (j.args[0] as { watchId: string }).watchId)).toEqual([String(activeWatchId)]);
  });

  it("watchForCheck (checkWatch's own guard) returns null for a tombstoned owner", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await tombstone(t, userId);
    expect(await t.query(internal.watches.watchForCheck, { watchId })).toBeNull();
  });
});

describe("D115 6b-3 / T18.3: watches.list/get see the signed-out shape once tombstoned", () => {
  async function tombstone(t: T, userId: Id<"users">) {
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));
  }

  it("list returns [] and get returns null for a tombstoned caller with a real, otherwise-visible watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    // Prove both calls see real data first, so the post-tombstone assertions are not vacuous.
    expect(await as.query(api.watches.list, {})).toHaveLength(1);
    expect(await as.query(api.watches.get, { watchId })).not.toBeNull();

    await tombstone(t, userId);

    expect(await as.query(api.watches.list, {})).toEqual([]);
    expect(await as.query(api.watches.get, { watchId })).toBeNull();
  });

  it("a normal (non-tombstoned) caller is unaffected by the gate", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    expect(await as.query(api.watches.list, {})).toHaveLength(1);
    expect(await as.query(api.watches.get, { watchId })).not.toBeNull();
  });
});
