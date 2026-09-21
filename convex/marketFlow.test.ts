/// <reference types="vite/client" />
/**
 * T15 — cross-module regression for the ShopSavvy market-history flow
 * (D71), reached the way a real user reaches it: through
 * `watches.recordWatchCheck`'s automatic `market.requestLookup` trigger
 * (watches.ts:801-803), not by calling `market.ts`'s own mutations directly
 * the way market.test.ts (a different lane's file) does.
 *
 * Covers, in order: no key -> an accepted check still auto-fires the trigger,
 * which lands on `not_configured` with no charge and no fetch; key set -> the
 * next accepted check auto-requests, and the transactional claim in
 * `requestLookup` (D71) means a SECOND accepted check racing the first
 * lookup's completion cannot duplicate the charge or the scheduled fetch;
 * mocked ShopSavvy success -> the row's `marketObservedAt <= marketFetchedAt`
 * and `watches.get`'s own `market` field agrees with it. Also verifies, this
 * time reached through the auto-trigger rather than a direct mutation call,
 * the two accounting fixes D107 named: C5 (a watch's own auto-retry chain
 * charges the per-user counter only once, on the attempt that started it) and
 * C6 (a manual refresh out of `terminal_failure` regains a full retry chain).
 *
 * Every test builds its own `transactionLimits: true` harness (task
 * instruction) -- see readBudget.test.ts's file header for why `setup()`'s
 * positional form cannot be used here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MARKET_MAX_ATTEMPTS } from "./limits";

// ---------------------------------------------------------------------------
// Harness (see freshness.test.ts / readBudget.test.ts for the same pattern).
// ---------------------------------------------------------------------------

const modules = import.meta.glob("./**/*.*s");
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

function harness() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest({ schema, modules, transactionLimits: true });
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}

type T = ReturnType<typeof harness>;

async function signedIn(t: T, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

const T0 = Date.UTC(2026, 8, 20, 12);
const HOUR = 3_600_000;
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

async function seedWatch(t: T, userId: Id<"users">): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "Acme Down Jacket",
      productUrl: URL,
      merchantDomain: "acme.example",
      currency: "USD",
      status: "active",
      nextCheckAt: T0 + HOUR,
    }),
  );
}

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

async function watchRow(t: T, watchId: Id<"watches">) {
  const row = await t.run((ctx) => ctx.db.get(watchId));
  if (!row) throw new Error("watch missing");
  return row;
}

/** Jobs still waiting to run -- excludes ones `finishAllScheduledFunctions` already drained. */
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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A ShopSavvy envelope with one dated offer, priced in USD, timestamped at T0. */
function bodyWithOnePoint() {
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
            currency: "USD",
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

describe("marketFlow: watches.recordWatchCheck's automatic market.requestLookup trigger (D71/T10)", () => {
  it("no key: an accepted check still auto-fires the trigger, which lands on not_configured with no charge and no fetch", async () => {
    const t = harness();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchSpy).not.toHaveBeenCalled();
    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("not_configured");
    expect(row.marketFetchedAt).toBeUndefined();
    expect(row.marketObservedAt).toBeUndefined();
    expect(await usageCount(t, userId, "market_lookup")).toBe(0);
  });

  it(
    "key set: the next accepted check auto-requests exactly once (transactional claim -- a second accepted check " +
      "racing the first lookup's completion does not duplicate the charge or the job), and the mocked lookup's " +
      "success leaves marketObservedAt <= marketFetchedAt, consistent with what watches.get shows",
    async () => {
      const t = harness();
      const { userId, as } = await signedIn(t);
      const watchId = await seedWatch(t, userId);
      process.env.SHOPSAVVY_API_KEY = "test-key";
      const fetchSpy = vi.fn(async () => jsonResponse(bodyWithOnePoint()));
      vi.stubGlobal("fetch", fetchSpy);

      // Two accepted checks, back to back, before either's auto-scheduled
      // `market.requestLookup(trigger:"auto")` job has run -- this is the
      // real race the transactional claim in `requestLookup` (D71) exists to
      // close: `recordWatchCheck` schedules that job unconditionally on every
      // accepted observation (watches.ts:801-803), not just the first.
      await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
      vi.setSystemTime(T0 + HOUR);
      await t.mutation(internal.watches.recordWatchCheck, good(watchId, 9_500));

      const pendingBefore = await scheduled(t);
      expect(pendingBefore.filter((j) => String(j.name).includes("market"))).toHaveLength(2);

      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const afterLookup = Date.now();

      // Only ONE of the two requestLookup calls could claim (queued) and
      // charge; `requestLookup`'s own state gate (D71) no-ops the other
      // (already queued/running/success) rather than scheduling a second fetch.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await usageCount(t, userId, "market_lookup")).toBe(1);
      expect((await scheduled(t)).filter((j) => String(j.name).includes("market"))).toHaveLength(0);

      const row = await watchRow(t, watchId);
      expect(row.marketState).toBe("success");
      expect(row.marketFetchedAt).toBeDefined();
      expect(row.marketObservedAt).toBeDefined();
      expect(row.marketObservedAt!).toBeLessThanOrEqual(row.marketFetchedAt!);

      const got = await as.query(api.watches.get, { watchId, now: afterLookup });
      expect(got?.watch.market).not.toBeNull();
      expect(got?.watch.market!.points).toHaveLength(1);
      // The provider's own point timestamp (T0, from the mocked body) is at
      // or before the fetch time, and `since` (the earliest/only point) is
      // exactly the row's own `marketObservedAt`.
      expect(got?.watch.market!.points[0].observedAt).toBeLessThanOrEqual(row.marketFetchedAt!);
      expect(got?.watch.market!.since).toBe(row.marketObservedAt);
    },
  );
});

describe("D107 C5/C6 accounting, reached through the auto-trigger from an accepted watch check", () => {
  it(`C5: a watch's own auto-retry chain (from ONE accepted check triggering up to ${MARKET_MAX_ATTEMPTS} auto attempts) consumes only 1 per-user market_lookup unit`, async () => {
    const t = harness();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429)));

    // ONE accepted price check is the only user action here -- the rest
    // (queued -> lookup -> retryable_failure -> the next auto-scheduled
    // retry, up to MARKET_MAX_ATTEMPTS) is the automatic chain C5 describes.
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const row = await watchRow(t, watchId);
    expect(row.marketState).toBe("terminal_failure");
    expect(row.marketAttempts).toBe(MARKET_MAX_ATTEMPTS);
    // Without C5, the (MARKET_MAX_ATTEMPTS - 1) auto-scheduled retries this
    // cycle triggered on its own would also have drawn from the per-user
    // counter; with it, only the very first (attempt 1, the one this single
    // accepted check actually caused) does.
    expect(await usageCount(t, userId, "market_lookup")).toBe(1);
  });

  it("C6: a manual refresh out of that terminal_failure regains a full retry chain", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    process.env.SHOPSAVVY_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 429)));

    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const terminal = await watchRow(t, watchId);
    expect(terminal.marketState).toBe("terminal_failure");
    expect(terminal.marketAttempts).toBe(MARKET_MAX_ATTEMPTS);

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));
    const refreshResult = await as.mutation(api.market.refresh, { watchId });
    expect(refreshResult).toMatchObject({ scheduled: true, state: "queued" });
    // C6: the reset happens in the SAME transaction as the claim, before the scheduled `lookup` even runs.
    expect((await watchRow(t, watchId)).marketAttempts).toBe(0);

    await t.action(internal.market.lookup, { watchId });

    const afterOneFailure = await watchRow(t, watchId);
    // Without C6 this would go straight back to terminal_failure:
    // marketAttempts was already at MARKET_MAX_ATTEMPTS from the exhausted
    // cycle, so even a single new failure would have nowhere left to retry to.
    expect(afterOneFailure.marketState).toBe("retryable_failure");
    expect(afterOneFailure.marketAttempts).toBe(1);
  });
});
