import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { FIND_MARKER } from "./lib/offerMatch";
import { OUT_OF_STOCK_NOTE } from "./market";
import { OUT_OF_STOCK_NOTE as OUT_OF_STOCK_NOTE_UI } from "../src/lib/offerNotes";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
  MARKET_MAX_ATTEMPTS,
  MARKET_REFRESH_MIN_AGE_MS,
  MARKET_RETRY_BACKOFF_MS,
  MAX_OFFERS_PER_WATCH,
} from "./limits";

/**
 * Market history (W1b, D71). No test reaches the real ShopSavvy API: `fetch`
 * is stubbed per test (or left unset, for the missing-key path), and fake
 * timers both control `MARKET_REFRESH_MIN_AGE_MS`/backoff comparisons and let
 * `finishAllScheduledFunctions` drive the automatic retry chain end to end.
 */
const T0 = Date.UTC(2026, 8, 20, 12);
const DAY = 86_400_000;
const URL = "https://www.acme.example/p/down-jacket";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  delete process.env.SHOPSAVVY_API_KEY;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SHOPSAVVY_API_KEY;
});

type T = ReturnType<typeof setup>;

async function seedWatch(
  t: T,
  userId: Id<"users">,
  over: { status?: "active" | "paused" | "archived" | "bought"; slug?: string; currency?: string } = {},
): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "Acme Down Jacket",
      productUrl: over.slug ? `https://www.acme.example/p/${over.slug}` : URL,
      merchantDomain: "acme.example",
      status: over.status ?? "active",
      nextCheckAt: T0 + 3_600_000,
      currency: over.currency ?? "USD",
    }),
  );
}

async function watchRow(t: T, watchId: Id<"watches">) {
  const row = await t.run((ctx) => ctx.db.get(watchId));
  if (!row) throw new Error("watch missing");
  return row;
}

async function marketRows(t: T, watchId: Id<"watches">) {
  return await t.run((ctx) =>
    ctx.db
      .query("marketPrices")
      .withIndex("by_watch", (q) => q.eq("watchId", watchId))
      .collect(),
  );
}

/** Jobs still waiting to run — excludes ones `finishAllScheduledFunctions` already drained. */
async function scheduled(t: T) {
  const rows = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return rows.filter((r) => r.state.kind === "pending" || r.state.kind === "inProgress");
}

async function usageCount(t: T, userId: Id<"users"> | undefined, kind: string) {
  const day = new Date(vi.getMockedSystemTime() ?? Date.now()).toISOString().slice(0, 10);
  const row = await t.run((ctx) =>
    ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", kind))
      .first(),
  );
  return row?.count ?? 0;
}

/** A ShopSavvy envelope with one dated offer from a store other than `acme.example`, priced in `currency`. */
function bodyWithOnePoint(currency = "USD") {
  return {
    success: true,
    data: [
      {
        title_short: "Down Jacket",
        offers: [
          {
            URL: "https://www.other-store.example/p/down-jacket",
            retailer: "Other Store",
            price: 79.99,
            currency,
            timestamp: new Date(T0).toISOString(),
            availability: "in",
            condition: null,
            seller: null,
            history: [],
          },
        ],
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("missing key", () => {
  it("goes to not_configured with no budget spend and no marketFetchedAt, then works once a key is set", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(result).toEqual({ scheduled: false, state: "not_configured", reason: "not_configured" });
    expect(fetchSpy).not.toHaveBeenCalled();

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("not_configured");
    expect(row.marketFetchedAt).toBeUndefined();
    expect(await usageCount(t, userId, "market_lookup")).toBe(0);
    expect(await usageCount(t, undefined, "market_lookup")).toBe(0);

    process.env.SHOPSAVVY_API_KEY = "test-key";
    fetchSpy.mockResolvedValue(jsonResponse(bodyWithOnePoint()));
    const claim = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(claim).toEqual({ scheduled: true, state: "queued" });
    await t.action(internal.market.lookup, { watchId });

    const after = await watchRow(t, watchId);
    expect(after.marketState).toBe("success");
    expect(after.marketFetchedAt).toBe(T0);
    expect(after.marketNote).toBeUndefined();
    expect(await usageCount(t, userId, "market_lookup")).toBe(1);
  });
});

describe("retryable failures and backoff", () => {
  it("schedules an automatic retry after each 429, incrementing attempts, and gives up after 3", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const fetchSpy = vi.fn(async () => jsonResponse({}, 429));
    vi.stubGlobal("fetch", fetchSpy);

    const claim = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(claim.scheduled).toBe(true);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchSpy).toHaveBeenCalledTimes(MARKET_MAX_ATTEMPTS);
    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("terminal_failure");
    expect(row.marketAttempts).toBe(MARKET_MAX_ATTEMPTS);
    expect(row.marketNote).toBe("Market history is unavailable for this product");
    expect(row.marketNextRetryAt).toBeUndefined();
    expect(await marketRows(t, watchId)).toHaveLength(0);
    // The initial manual charge, and each of the two auto-scheduled retries (after the 1st and 2nd
    // failures — the 3rd goes straight to terminal), all go through `tryCharge`: every one of the 3
    // draws from BOTH the user's daily cap and the shared global cap (F7/D103 — the auto path used to
    // draw only from the global one, see "one user cannot exhaust the global switch" below).
    expect(await usageCount(t, userId, "market_lookup")).toBe(3);
    expect(await usageCount(t, undefined, "market_lookup")).toBe(3);
  });

  it("computes the first retry's nextRetryAt from MARKET_RETRY_BACKOFF_MS[0]", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("retryable_failure");
    expect(row.marketAttempts).toBe(1);
    expect(row.marketNextRetryAt).toBe(T0 + MARKET_RETRY_BACKOFF_MS[0]);

    // A manual click before the backoff elapses is refused too (D71: the gate is unconditional).
    const early = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(early).toEqual({ scheduled: false, state: "retryable_failure", reason: "retryable_backoff" });
  });

  it("resets marketAttempts to 0 on success, so a LATER failure cycle restarts from backoff[0] (F9/D103, DA-4)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // First cycle: one retryable failure (marketAttempts -> 1).
    fetchSpy.mockResolvedValueOnce(jsonResponse({}, 503));
    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });
    expect((await watchRow(t, watchId)).marketAttempts).toBe(1);

    // Once the backoff passes, a manual retry succeeds.
    const successAt = T0 + MARKET_RETRY_BACKOFF_MS[0] + 1;
    vi.setSystemTime(successAt);
    fetchSpy.mockResolvedValueOnce(jsonResponse(bodyWithOnePoint()));
    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    const afterSuccess = await watchRow(t, watchId);
    expect(afterSuccess.marketState).toBe("success");
    // Without the fix this stays 1 (whatever the failed cycle left it at) instead of resetting.
    expect(afterSuccess.marketAttempts).toBe(0);

    // Well past MARKET_REFRESH_MIN_AGE_MS from THIS success, a single new failure must restart
    // counting from 1 (backoff[0]) -- not continue from the stale pre-reset count.
    const secondCycleStart = successAt + MARKET_REFRESH_MIN_AGE_MS + 1;
    vi.setSystemTime(secondCycleStart);
    fetchSpy.mockResolvedValue(jsonResponse({}, 503));
    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    const afterSecondFailure = await watchRow(t, watchId);
    expect(afterSecondFailure.marketState).toBe("retryable_failure");
    expect(afterSecondFailure.marketAttempts).toBe(1);
    expect(afterSecondFailure.marketNextRetryAt).toBe(secondCycleStart + MARKET_RETRY_BACKOFF_MS[0]);
  });
});

describe("empty result", () => {
  it("classifies a real but empty response as empty_result, with no hot auto retry", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true, data: [{ title_short: "x", offers: [] }] })));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.finishAllScheduledFunctions(vi.runAllTimers); // drains the initial lookup job

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("empty_result");
    expect(row.marketNote).toBe("ShopSavvy has no price history for this product");

    const auto = await t.mutation(internal.market.requestLookup, { watchId, trigger: "auto" });
    expect(auto).toEqual({ scheduled: false, state: "empty_result", reason: "empty_result" });
    expect(await scheduled(t)).toHaveLength(0);
  });
});

describe("OUT_OF_STOCK_NOTE (D102)", () => {
  it("is exported, and stays literally equal to src/lib/offerNotes.ts's UI copy", () => {
    // D102: exported so this string can be VERIFIED against the frontend's copy by a test, instead of
    // the two silently drifting (src/ cannot import convex/*.ts directly -- server-only packages don't
    // bundle for the browser -- so offerNotes.ts keeps its own copy; this is that verification).
    expect(OUT_OF_STOCK_NOTE).toBe(OUT_OF_STOCK_NOTE_UI);
  });
});

describe("byte cap", () => {
  it("treats an oversized response as terminal_failure without throwing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const huge = "x".repeat(2_000_001);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(huge, { status: 200 })));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await expect(t.action(internal.market.lookup, { watchId })).resolves.toBeNull();

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("terminal_failure");
    expect(row.marketNote).toBe("Market history is unavailable for this product");
  });

  it("rejects a response whose declared Content-Length is already over the cap, before reading its body (F8/D103)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    let textRead = false;
    const res = new Response("small body, lying header", {
      status: 200,
      headers: { "content-length": String(2_000_001) },
    });
    const originalText = res.text.bind(res);
    res.text = async () => {
      textRead = true;
      return originalText();
    };
    vi.stubGlobal("fetch", vi.fn(async () => res));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await expect(t.action(internal.market.lookup, { watchId })).resolves.toBeNull();

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("terminal_failure");
    expect(textRead).toBe(false); // the body was never buffered once the declared length was over the cap
  });
});

describe("concurrent claims", () => {
  it("lets exactly one of two concurrent requestLookup calls claim and charge", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));

    const [a, b] = await Promise.all([
      t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" }),
      t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" }),
    ]);
    const scheduledCount = [a, b].filter((r) => r.scheduled).length;
    expect(scheduledCount).toBe(1);

    expect(await usageCount(t, userId, "market_lookup")).toBe(1);
    const jobs = await scheduled(t);
    expect(jobs.filter((j) => String(j.name).includes("market"))).toHaveLength(1);
  });
});

describe("per-user auto budget (F7/D103)", () => {
  it("caps one user's AUTO lookups at their own per-user budget, so they cannot alone exhaust the global switch (DA-7)", async () => {
    const t = setup();
    const { userId: userA } = await signedIn(t, "A");
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));

    const perUserMax = DAILY_BUDGETS.market_lookup.max;
    expect(GLOBAL_DAILY_BUDGETS.market_lookup.max).toBeGreaterThan(perUserMax); // otherwise this test proves nothing

    const results: Array<{ scheduled: boolean; reason?: string }> = [];
    for (let i = 0; i < perUserMax + 1; i++) {
      const watchId = await seedWatch(t, userA, { slug: `auto-${i}` });
      results.push(await t.mutation(internal.market.requestLookup, { watchId, trigger: "auto" }));
    }

    // Without F7, every one of these would schedule (the auto path only drew from the global cap):
    // userA alone could have spent all GLOBAL_DAILY_BUDGETS.market_lookup.max on their own watches.
    expect(results.filter((r) => r.scheduled)).toHaveLength(perUserMax);
    expect(results[perUserMax]).toMatchObject({ scheduled: false, reason: "budget" });
    expect(await usageCount(t, userA, "market_lookup")).toBe(perUserMax);
    expect(await usageCount(t, undefined, "market_lookup")).toBe(perUserMax);
    // Headroom left in the global switch for every other user on the deployment.
    expect(GLOBAL_DAILY_BUDGETS.market_lookup.max - perUserMax).toBeGreaterThan(0);

    // A second user's own first auto lookup is entirely unaffected by userA having maxed out.
    const { userId: userB } = await signedIn(t, "B");
    const watchB = await seedWatch(t, userB, { slug: "userB-first" });
    const resultB = await t.mutation(internal.market.requestLookup, { watchId: watchB, trigger: "auto" });
    expect(resultB.scheduled).toBe(true);
  });
});

describe("refresh", () => {
  it("throws for a non-owner", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const watchId = await seedWatch(t, owner.userId);
    await expect(other.as.mutation(api.market.refresh, { watchId })).rejects.toThrow();
  });

  it("is refused (not thrown) on an archived or bought watch", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const archived = await seedWatch(t, userId, { status: "archived", slug: "a" });
    const bought = await seedWatch(t, userId, { status: "bought", slug: "b" });
    process.env.SHOPSAVVY_API_KEY = "test-key";

    await expect(as.mutation(api.market.refresh, { watchId: archived })).resolves.toMatchObject({
      scheduled: false,
      reason: "archived",
    });
    await expect(as.mutation(api.market.refresh, { watchId: bought })).resolves.toMatchObject({
      scheduled: false,
      reason: "bought",
    });
  });

  it("refuses a success refresh before MARKET_REFRESH_MIN_AGE_MS and allows (and charges) one after", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await watchRow(t, watchId)).marketState).toBe("success");
    expect(await usageCount(t, userId, "market_lookup")).toBe(1);

    const tooSoon = await as.mutation(api.market.refresh, { watchId });
    expect(tooSoon).toMatchObject({ scheduled: false, reason: "too_recent" });
    expect(await usageCount(t, userId, "market_lookup")).toBe(1);

    // MARKET_REFRESH_MIN_AGE_MS is 7 days, so this charge lands in a new UTC-day usage bucket —
    // `usageCount` reads whatever day is current, so 1 here demonstrates the second charge landed,
    // not a cumulative total across the two different days.
    vi.setSystemTime(T0 + MARKET_REFRESH_MIN_AGE_MS + 1);
    const later = await as.mutation(api.market.refresh, { watchId });
    expect(later).toMatchObject({ scheduled: true, state: "queued" });
    expect(await usageCount(t, userId, "market_lookup")).toBe(1);
  });

  it(`refuses once the user's daily ${DAILY_BUDGETS.market_lookup.max} manual lookups are spent`, async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true, data: [{ title_short: "x", offers: [] }] })));

    for (let i = 0; i < DAILY_BUDGETS.market_lookup.max; i++) {
      const watchId = await seedWatch(t, userId, { slug: `p${i}` });
      const result = await as.mutation(api.market.refresh, { watchId });
      expect(result).toMatchObject({ scheduled: true });
    }
    const oneMore = await seedWatch(t, userId, { slug: "over" });
    expect(await as.mutation(api.market.refresh, { watchId: oneMore })).toMatchObject({
      scheduled: false,
      reason: "budget",
    });
  });
});

describe("archive mid-flight (D87)", () => {
  it("writes nothing once the watch is archived between markRunning and recordSnapshot", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(await t.mutation(internal.market.markRunning, { watchId })).toBe(true);
    await t.run((ctx) => ctx.db.patch(watchId, { status: "archived" }));

    const result = await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [
        {
          retailer: "Other Store",
          storeDomain: "other-store.example",
          cents: 7_999,
          currency: "USD",
          observedAt: T0,
          marketKey: "other-store.example:2026-09-20",
        },
      ],
      stores: [],
    });

    expect(result).toEqual({ skipped: true, points: 0, stores: 0 });
    expect(await marketRows(t, watchId)).toHaveLength(0);
    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("running"); // never advanced past running; archived watches never reclaim
  });

  it("also skips for a tombstoned owner", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    const result = await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [],
    });
    expect(result).toEqual({ skipped: true, points: 0, stores: 0 });
  });
});

describe("bought watch and stale claims (F8/D103)", () => {
  it("performs no fetch once the watch is marked bought after the claim but before the scheduled lookup runs (DA-5b)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const fetchSpy = vi.fn(async () => jsonResponse(bodyWithOnePoint()));
    vi.stubGlobal("fetch", fetchSpy);

    const claim = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(claim.scheduled).toBe(true); // now "queued"; the scheduled `lookup` has not run yet

    // The user marks the item bought before that scheduled lookup gets to run.
    await t.run((ctx) => ctx.db.patch(watchId, { status: "bought" }));
    await t.action(internal.market.lookup, { watchId });

    expect(fetchSpy).not.toHaveBeenCalled(); // watchForMarket refuses a bought watch (F8), same as archived
  });

  it("reclaims a queued/running claim once older than 15 minutes, allowing a new attempt", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";

    const claim = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(claim.scheduled).toBe(true);
    expect((await watchRow(t, watchId)).marketState).toBe("queued");
    // The scheduled `lookup` is deliberately never run here, simulating a job that crashed or was
    // killed before it ever reached `recordSnapshot` -- the watch is stuck "in flight".

    vi.setSystemTime(T0 + 14 * 60_000);
    const tooSoon = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(tooSoon).toEqual({ scheduled: false, state: "queued", reason: "in_flight" });

    const reclaimAt = T0 + 15 * 60_000 + 1;
    vi.setSystemTime(reclaimAt);
    const reclaimed = await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    expect(reclaimed).toEqual({ scheduled: true, state: "queued" });
    expect((await watchRow(t, watchId)).marketClaimedAt).toBe(reclaimAt); // re-stamped by the reclaim

    // The reclaim resolves normally end to end (the original stale job, now also pending, does not
    // double-write or throw once this reclaim has moved the state on: `markRunning` refuses whichever
    // of the two runs second, since by then the state is no longer "queued").
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await watchRow(t, watchId)).marketState).toBe("success");
  });
});

describe("rows written on success", () => {
  it("stamps source, observedAt (provider) and retrievedAt (now) on every marketPrices row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    const rows = await marketRows(t, watchId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "shopsavvy", observedAt: T0, retrievedAt: T0 });
  });
});

async function offerRows(t: T, watchId: Id<"watches">) {
  return await t.run((ctx) => ctx.db.query("offers").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect());
}

describe("own-store exclusion (T13/P04)", () => {
  /** A watch whose product page is on a DIFFERENT subdomain than "www" -- `seedWatch` always uses "www.acme.example". */
  async function subdomainWatch(t: T, userId: Id<"users">) {
    return await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId,
        name: "Acme Down Jacket",
        productUrl: "https://shop.acme.example/p/down-jacket",
        merchantDomain: "acme.example",
        status: "active",
        nextCheckAt: T0 + 3_600_000,
        currency: "USD",
      }),
    );
  }

  it("recordSnapshot -- the authoritative write path -- excludes a store on the same registrable host as the product page, across subdomains", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await subdomainWatch(t, userId);
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));

    const result = await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Acme (own store, another subdomain)",
          storeDomain: "acme.example",
          productUrl: "https://acme.example/p/down-jacket",
          cents: 19_999,
          currency: "USD",
          observedAt: T0,
        },
        {
          retailer: "Other Store",
          storeDomain: "other-store.example",
          productUrl: "https://other-store.example/p/down-jacket",
          cents: 17_999,
          currency: "USD",
          observedAt: T0,
        },
      ],
    });

    expect(result.stores).toBe(1);
    expect((await offerRows(t, watchId)).map((o) => o.storeDomain)).toEqual(["other-store.example"]);
  });

  it("lookup() end to end also excludes an own-store offer found on a subdomain of the watched product's host", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await subdomainWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const offer = (url: string, retailer: string, price: number) => ({
      URL: url,
      retailer,
      price,
      currency: "USD",
      timestamp: new Date(T0).toISOString(),
      availability: "in",
      condition: null,
      seller: null,
      history: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          data: [
            {
              title_short: "Down Jacket",
              offers: [
                offer("https://outlet.acme.example/p/down-jacket", "Acme Outlet", 89.99),
                offer("https://other-store.example/p/down-jacket", "Other Store", 79.99),
              ],
            },
          ],
        }),
      ),
    );

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    expect((await offerRows(t, watchId)).map((o) => o.storeDomain)).toEqual(["other-store.example"]);
  });
});

describe("availability (T13/P04)", () => {
  it("inserts an out-of-stock ShopSavvy store unpriced with a qualifying note; an in-stock one keeps its price", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));

    const result = await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Out Of Stock Store",
          storeDomain: "oos.example",
          productUrl: "https://oos.example/p",
          cents: 5_000,
          currency: "USD",
          observedAt: T0,
          inStock: false,
        },
        {
          retailer: "In Stock Store",
          storeDomain: "instock.example",
          productUrl: "https://instock.example/p",
          cents: 6_000,
          currency: "USD",
          observedAt: T0,
          inStock: true,
        },
      ],
    });

    expect(result.stores).toBe(2);
    const rows = await offerRows(t, watchId);
    const oos = rows.find((o) => o.storeDomain === "oos.example")!;
    expect(oos.lastCents).toBeUndefined();
    expect(oos.currency).toBeUndefined();
    expect(oos.note).toMatch(/out of stock/i);
    const inStock = rows.find((o) => o.storeDomain === "instock.example")!;
    expect(inStock.lastCents).toBe(6_000);
  });
});

describe("per-watch offer cap (T13)", () => {
  it("holds under a burst of new candidates once the watch already has MAX_OFFERS_PER_WATCH stores", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(watchId, { marketState: "running" });
      for (let i = 0; i < MAX_OFFERS_PER_WATCH; i++) {
        await ctx.db.insert("offers", {
          watchId,
          userId,
          storeDomain: `store${i}.example`,
          productUrl: `https://store${i}.example/p`,
          title: `Store ${i}`,
          status: "candidate",
        });
      }
    });

    const burst = Array.from({ length: 10 }, (_, i) => ({
      retailer: `New Store ${i}`,
      storeDomain: `newstore${i}.example`,
      productUrl: `https://newstore${i}.example/p`,
      cents: 1_000 + i,
      currency: "USD",
      observedAt: T0,
    }));
    const result = await t.mutation(internal.market.recordSnapshot, { watchId, outcome: "success", points: [], stores: burst });

    expect(result.stores).toBe(0);
    expect(await offerRows(t, watchId)).toHaveLength(MAX_OFFERS_PER_WATCH);
  });

  it("never exceeds MAX_OFFERS_PER_WATCH even when FIND_MARKER rows crowd the existing-offers count (F11/D103, DA-8)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(watchId, { marketState: "running" });
      // Inserted FIRST (oldest): with the OLD, narrower take-limit (MAX_OFFERS_PER_WATCH +
      // MARKET_MAX_STORES = 48), 20 of these plus the 40 real rows below (60 total) would have
      // crowded a `.take(48)` ascending read down to 20 markers + only 28 real rows, undercounting
      // the true existing total and letting more than MAX_OFFERS_PER_WATCH stores in overall.
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("offers", {
          watchId,
          userId,
          storeDomain: FIND_MARKER,
          productUrl: "https://www.acme.example/p/down-jacket",
          title: "",
          status: "rejected",
        });
      }
      for (let i = 0; i < MAX_OFFERS_PER_WATCH; i++) {
        await ctx.db.insert("offers", {
          watchId,
          userId,
          storeDomain: `store${i}.example`,
          productUrl: `https://store${i}.example/p`,
          title: `Store ${i}`,
          status: "candidate",
        });
      }
    });

    const burst = Array.from({ length: 10 }, (_, i) => ({
      retailer: `New Store ${i}`,
      storeDomain: `newstore${i}.example`,
      productUrl: `https://newstore${i}.example/p`,
      cents: 1_000 + i,
      currency: "USD",
      observedAt: T0,
    }));
    const result = await t.mutation(internal.market.recordSnapshot, { watchId, outcome: "success", points: [], stores: burst });

    expect(result.stores).toBe(0);
    const realOffers = (await offerRows(t, watchId)).filter((r) => r.storeDomain !== FIND_MARKER);
    expect(realOffers).toHaveLength(MAX_OFFERS_PER_WATCH);
  });

  it("does not re-add a store the user rejected as a second candidate row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const rejectedId = await t.run(async (ctx) => {
      await ctx.db.patch(watchId, { marketState: "running" });
      return await ctx.db.insert("offers", {
        watchId,
        userId,
        storeDomain: "rejected.example",
        productUrl: "https://rejected.example/p",
        title: "Rejected Store",
        status: "rejected",
      });
    });

    await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Rejected Store",
          storeDomain: "rejected.example",
          productUrl: "https://rejected.example/p",
          cents: 4_000,
          currency: "USD",
          observedAt: T0,
        },
      ],
    });

    const rows = await offerRows(t, watchId);
    const matches = rows.filter((o) => o.storeDomain === "rejected.example");
    expect(matches).toHaveLength(1);
    expect(matches[0]._id).toBe(rejectedId);
    expect(matches[0].status).toBe("rejected");
  });
});

describe("migrateStamps", () => {
  it("classifies both legacy shapes and is idempotent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const withHistory = await seedWatch(t, userId, { slug: "with-history" });
    const withoutHistory = await seedWatch(t, userId, { slug: "no-history" });
    await t.run(async (ctx) => {
      await ctx.db.patch(withHistory, { marketFetchedAt: T0 - DAY, marketState: undefined });
      await ctx.db.patch(withoutHistory, { marketFetchedAt: T0 - DAY, marketState: undefined });
      await ctx.db.insert("marketPrices", {
        watchId: withHistory,
        userId,
        retailer: "Other Store",
        storeDomain: "other-store.example",
        cents: 7_999,
        currency: "USD",
        observedAt: T0 - DAY,
        marketKey: "other-store.example:2026-09-19",
      });
    });

    const first = await t.mutation(internal.market.migrateStamps, {});
    expect(first.migrated).toBe(2);
    expect(first.done).toBe(true);

    expect((await watchRow(t, withHistory)).marketState).toBe("success");
    const cleared = await watchRow(t, withoutHistory);
    expect(cleared.marketState).toBe("not_configured");
    expect(cleared.marketFetchedAt).toBeUndefined();

    const second = await t.mutation(internal.market.migrateStamps, {});
    expect(second.migrated).toBe(0);
    expect(await usageCount(t, undefined, "market_lookup")).toBe(0);
    expect(await usageCount(t, userId, "market_lookup")).toBe(0);
  });

  it("never touches a watch that already has a marketState", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run((ctx) => ctx.db.patch(watchId, { marketFetchedAt: T0 - DAY, marketState: "retryable_failure" }));

    const result = await t.mutation(internal.market.migrateStamps, {});
    expect(result.migrated).toBe(0);
    expect((await watchRow(t, watchId)).marketState).toBe("retryable_failure");
  });
});

describe("currency mismatch", () => {
  it("drops a point whose currency does not match the watch's, still landing on empty_result", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint("EUR"))));

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    expect((await watchRow(t, watchId)).marketState).toBe("empty_result");
    expect(await marketRows(t, watchId)).toHaveLength(0);
  });

  it("recordSnapshot writes a foreign-currency store unpriced with a qualifying note -- never a priced candidate (F5a/D103, DA-11)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));

    const result = await t.mutation(internal.market.recordSnapshot, {
      watchId,
      outcome: "success",
      points: [],
      stores: [
        {
          retailer: "Amazon.de",
          storeDomain: "amazon.de",
          productUrl: "https://amazon.de/p",
          cents: 7_999,
          currency: "EUR",
          observedAt: T0,
        },
        {
          retailer: "Same Currency Store",
          storeDomain: "same-currency.example",
          productUrl: "https://same-currency.example/p",
          cents: 6_999,
          currency: "USD",
          observedAt: T0,
        },
      ],
    });

    expect(result.stores).toBe(2); // both still recorded as candidates...
    const rows = await offerRows(t, watchId);
    const eur = rows.find((o) => o.storeDomain === "amazon.de")!;
    expect(eur.lastCents).toBeUndefined(); // ...but the EUR one is never priced
    expect(eur.currency).toBeUndefined();
    expect(eur.note).toMatch(/currency/i);
    const usd = rows.find((o) => o.storeDomain === "same-currency.example")!;
    expect(usd.lastCents).toBe(6_999);
  });

  it("lookup() end to end also never prices a foreign-currency store found on the watched product's own page", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { currency: "USD" });
    process.env.SHOPSAVVY_API_KEY = "test-key";
    const offer = (url: string, retailer: string, price: number, currency: string) => ({
      URL: url,
      retailer,
      price,
      currency,
      timestamp: new Date(T0).toISOString(),
      availability: "in",
      condition: null,
      seller: null,
      history: [],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          success: true,
          data: [
            {
              title_short: "Down Jacket",
              offers: [
                offer("https://amazon.de/p/down-jacket", "Amazon.de", 79.99, "EUR"),
                offer("https://other-store.example/p/down-jacket", "Other Store", 69.99, "USD"),
              ],
            },
          ],
        }),
      ),
    );

    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });

    const rows = await offerRows(t, watchId);
    const eur = rows.find((o) => o.storeDomain === "amazon.de")!;
    expect(eur.lastCents).toBeUndefined();
    const usd = rows.find((o) => o.storeDomain === "other-store.example")!;
    expect(usd.lastCents).toBe(6_999);
  });
});

describe("transition window (watches.ts calling lookup directly, per T10's Risks note)", () => {
  it("treats an undefined marketState as queued so a direct internal.market.lookup call still runs", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(bodyWithOnePoint())));

    expect((await watchRow(t, watchId)).marketState).toBeUndefined();
    await t.action(internal.market.lookup, { watchId }); // no prior requestLookup claim at all

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("success");
  });
});
