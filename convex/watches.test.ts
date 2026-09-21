import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { observePrice } from "./priceWatch";
import {
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
    expect(listed[0].checking).toBe(true);
    expect(listed[0].verdict.label).toBe("unknown");
    expect(listed[0].spark).toEqual([]);
  });

  it("keeps a name the user gave", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const watchId = await as.mutation(api.watches.create, { productUrl: URL, name: "  Blue jacket, M " });
    expect((await watchRow(t, watchId)).name).toBe("Blue jacket, M");
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

    expect(await scheduled(t)).toHaveLength(0);
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
    expect(row.nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
    const checks = await checksFor(t, watchId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBe(7_500);
    expect(checks[0].listCents).toBe(10_000);
    expect(checks[0].userId).toBe(userId);

    const got = await as.query(api.watches.get, { watchId });
    expect(got?.watch.lastCents).toBe(7_500);
    expect(got?.watch.listCents).toBe(10_000);
    expect(got?.watch.checking).toBe(false);
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
    ["a negative amount", { observedCents: -1 }, /usable amount/],
    ["a fractional amount", { observedCents: 10.5 }, /usable amount/],
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

  it("does nothing for an archived watch", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { status: "archived" });
    await t.action(internal.watches.checkWatch, { watchId });
    expect(vi.mocked(observePrice)).not.toHaveBeenCalled();
    expect(await checksFor(t, watchId)).toHaveLength(0);
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

  it("reads a bounded page and leaves the rest for the next tick", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < 53; i++) await seedWatch(t, userId, { nextCheckAt: T0 - i });
    expect(await t.mutation(internal.watches.sweep, {})).toBe(50);
    expect(await t.mutation(internal.watches.sweep, {})).toBe(3);
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
