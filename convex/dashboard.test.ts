/// <reference types="vite/client" />
/**
 * T15 — cross-module regression for the dashboard's read models
 * (`insights.sources`/`activity`, `tracking.overview`, `budget.status`)
 * against ONE heavy, mixed-currency account, reusing the T07/readBudget
 * fixture shape (`convex/readBudget.test.ts`'s `heavyAccount`) rather than
 * each module's own minimal unit fixture. The point is cross-module
 * agreement: do `insights.sources`, `insights.activity` and
 * `tracking.overview` all report the SAME truncation/currency facts about
 * the SAME account, and does `budget.status`'s reported "paused" match what
 * a budgeted mutation actually does when the same switch is spent?
 *
 * `tracking.overview`'s own C1 fixture (6x1 purchases, the 50/51-item
 * per-purchase boundary) already lives in `tracking.test.ts` (T12.2), and
 * `insights.sources`/`activity`'s C2 fixture (10x1 purchases -> bought sums
 * to 10) already lives in `insights.test.ts` (T16) -- both owned by other
 * lanes. This file does not re-derive those in isolation; it re-uses the
 * same shapes only where doing so inside ONE larger, multi-module account
 * adds something those single-query unit tests do not: that every read
 * model an account holder's dashboard actually renders agrees.
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
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { GLOBAL_DAILY_BUDGETS } from "./limits";

// ---------------------------------------------------------------------------
// Harness (see freshness.test.ts / marketFlow.test.ts / readBudget.test.ts
// for the identical pattern).
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
  delete process.env.SHOPSAVVY_API_KEY;
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
type Ctx = Parameters<Parameters<T["run"]>[0]>[0];

async function signedIn(t: T, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

/**
 * Real convex-test transaction metrics for one call, via
 * `ctx.meta.getTransactionMetrics()` (readBudget.test.ts's own pattern).
 * Takes `Pick<T, "run">` rather than `T` so an identity-bound `as` (from
 * `t.withIdentity(...)`) can be passed for an authenticated query -- passing
 * the bare, unauthenticated `t` here for a signed-in-only query would make
 * `getAuthUserId` inside it resolve to `null`, silently measuring an EMPTY
 * result (0 documents read) instead of the real one.
 */
async function measure<Out>(accessor: Pick<T, "run">, call: (ctx: Ctx) => Promise<Out>): Promise<{ result: Out; documentsRead: number; bytesRead: number; databaseQueries: number; ms: number }> {
  const started = performance.now();
  const { result, metrics } = await accessor.run(async (ctx) => {
    const result = await call(ctx);
    const metrics = await ctx.meta.getTransactionMetrics();
    return { result, metrics };
  });
  return {
    result,
    documentsRead: metrics.documentsRead.used,
    bytesRead: metrics.bytesRead.used,
    databaseQueries: metrics.databaseQueries.used,
    ms: performance.now() - started,
  };
}

function report(name: string, fixture: string, m: { documentsRead: number; bytesRead: number; databaseQueries: number; ms: number }) {
  // eslint-disable-next-line no-console
  console.log("[read-budget]", JSON.stringify({ name, fixture, documentsRead: m.documentsRead, bytesRead: m.bytesRead, databaseQueries: m.databaseQueries, ms: Math.round(m.ms * 100) / 100 }));
}

const T0 = Date.UTC(2026, 8, 21, 12);
const DAY = 86_400_000;
function HOUR(n: number): number {
  return n * 3_600_000;
}

// The clock and the timers, not `performance` (`CLOCK_AND_TIMERS`, KX3/D233): with only `Date` faked, `markBought`'s
// runAfter(0) job fired on a real timer in the background. This file's `measure()` drives a nested `ctx.runQuery`
// inside `t.run`; on convex-test 0.0.59 its measurements are non-zero with timers faked (checked in M25; an older
// convex-test starved it, which is why this used to fake only `Date`).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"] }); // = test.setup CLOCK_AND_TIMERS
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Heavy, mixed-currency account fixture: >= 20 purchases x several items
// (T07/readBudget fixture shape), half USD half EUR, two of them carrying an
// open price_adjustment claim (one per currency) so `byCurrency` has real
// money to report on both sides.
// ---------------------------------------------------------------------------

const USD_PURCHASES = 12;
const EUR_PURCHASES = 12;
const ITEMS_PER_PURCHASE = 2;
const USD_CLAIM_CENTS = 3_000;
const EUR_CLAIM_CENTS = 1_200;

async function seedMixedAccount(t: T, userId: Id<"users">) {
  const purchaseIds: Id<"purchases">[] = [];
  async function seedPurchase(index: number, currency: "USD" | "EUR") {
    const merchantDomain = `${currency.toLowerCase()}${index}.example`;
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId,
        merchant: `${currency} Store ${index}`,
        merchantDomain,
        purchasedAt: T0 - 5 * DAY,
        currency,
        status: "active",
      }),
    );
    const itemIds: Id<"items">[] = [];
    for (let i = 0; i < ITEMS_PER_PURCHASE; i++) {
      const productUrl = `https://${merchantDomain}/p/${i}`;
      const itemId = await t.run((ctx) =>
        ctx.db.insert("items", {
          purchaseId,
          userId,
          name: `Item ${index}-${i}`,
          unitCents: 5_000,
          qty: 1,
          productUrl,
          returned: false,
        }),
      );
      await t.run(async (ctx) => {
        await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 5_000, currency, observedAt: T0 - 4 * DAY, sourceUrl: productUrl });
        await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 4_500, currency, observedAt: T0 - DAY, sourceUrl: productUrl });
      });
      itemIds.push(itemId);
    }
    purchaseIds.push(purchaseId);
    return { purchaseId, itemIds };
  }

  const usd: Array<{ purchaseId: Id<"purchases">; itemIds: Id<"items">[] }> = [];
  for (let i = 0; i < USD_PURCHASES; i++) usd.push(await seedPurchase(i, "USD"));
  const eur: Array<{ purchaseId: Id<"purchases">; itemIds: Id<"items">[] }> = [];
  for (let i = 0; i < EUR_PURCHASES; i++) eur.push(await seedPurchase(i, "EUR"));

  // One open price_adjustment claim per currency, so `byCurrency` carries real money.
  await t.run((ctx) =>
    ctx.db.insert("claims", {
      purchaseId: usd[0].purchaseId,
      itemId: usd[0].itemIds[0],
      userId,
      type: "price_adjustment",
      expectedCents: USD_CLAIM_CENTS,
      status: "detected",
      token: "tok-usd-claim",
      version: 1,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("claims", {
      purchaseId: eur[0].purchaseId,
      itemId: eur[0].itemIds[0],
      userId,
      type: "price_adjustment",
      expectedCents: EUR_CLAIM_CENTS,
      status: "detected",
      token: "tok-eur-claim",
      version: 1,
    }),
  );

  return { purchaseIds, usd, eur };
}

/** One purchase with `count` items and nothing else -- over MAX_ITEMS_PER_PURCHASE (50) trips a REAL per-purchase cut. */
async function seedOverflowPurchase(t: T, userId: Id<"users">, count: number): Promise<Id<"purchases">> {
  const merchantDomain = "overflow.example";
  const purchaseId = await t.run((ctx) =>
    ctx.db.insert("purchases", { userId, merchant: "Overflow Co", merchantDomain, purchasedAt: T0 - 5 * DAY, currency: "USD", status: "active" }),
  );
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("items", { purchaseId, userId, name: `Overflow item ${i}`, unitCents: 1_000, qty: 1, productUrl: `https://${merchantDomain}/p/${i}`, returned: false });
    }
  });
  return purchaseId;
}

describe("dashboard: a heavy, mixed-currency account agrees across insights.sources/activity and tracking.overview", () => {
  it("under every ITEM/PURCHASE cap: sources/overview report truncated:false, while activity's own (unrelated) 40-event feed window truthfully still cuts -- and tracking.overview's byCurrency matches the two seeded claims exactly", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    await seedMixedAccount(t, userId);

    const sources = await as.query(api.insights.sources, {});
    const activity = await as.query(api.insights.activity, {});
    const overview = await as.query(api.tracking.overview, { now: T0 });

    // 24 purchases x 2 items = 48, well under insights.ts's MAX_ITEMS_TOTAL
    // (150) and tracking.ts's (250); 24 purchases is under both MAX_PURCHASES
    // (40 for insights.ts, 60 for tracking.ts) -- neither sources nor
    // overview has anything to cut at this size.
    expect(sources.truncated).toBe(false);
    expect(overview.truncated).toBe(false);
    // insights.activity is a DIFFERENT, tighter bound: FEED_LIMIT=40 total
    // events, not an item/purchase count. 24 purchases x 2 priced items each
    // (a price_seen + a price_drop event per item, D93/priceEvents) is 24 +
    // 96 = 120 events -- genuinely over 40, so `truncated:true` here is the
    // TRUTHFUL answer for THIS account, not a false positive; it just proves
    // a different real cut than sources/overview's item-count cap. This is
    // the cross-module finding worth pinning: the three dashboard read
    // models do not all trip on the same trigger, and each must be honest
    // about its own.
    expect(activity.truncated).toBe(true);
    expect(overview.items).toHaveLength(USD_PURCHASES * ITEMS_PER_PURCHASE + EUR_PURCHASES * ITEMS_PER_PURCHASE);

    // F5b (D103): the complete per-currency breakdown, exactly the two seeded claims.
    expect(overview.totals.mixedCurrencies).toBe(true);
    expect(overview.totals.byCurrency).toEqual({
      USD: { foundCents: USD_CLAIM_CENTS, recoveredCents: 0, exampleFoundCents: 0 },
      EUR: { foundCents: EUR_CLAIM_CENTS, recoveredCents: 0, exampleFoundCents: 0 },
    });
    // USD has the larger claim, so it is picked as primaryCurrency; the legacy single-number field never sums across currencies (D72).
    expect(overview.totals.primaryCurrency).toBe("USD");
    expect(overview.totals.foundCents).toBe(USD_CLAIM_CENTS);
  });

  it(
    "adding one purchase with 51 items (one over the per-purchase cap) trips `truncated` truthfully and IDENTICALLY " +
      "in insights.sources, insights.activity and tracking.overview, while every other purchase still renders in full",
    async () => {
      const t = harness();
      const { userId, as } = await signedIn(t);
      const { usd, eur } = await seedMixedAccount(t, userId);
      await seedOverflowPurchase(t, userId, 51);

      const sourcesM = await measure(as, (ctx) => ctx.runQuery(api.insights.sources, {}));
      const activityM = await measure(as, (ctx) => ctx.runQuery(api.insights.activity, {}));
      const overviewM = await measure(as, (ctx) => ctx.runQuery(api.tracking.overview, { now: T0 }));
      report("insights.sources", "24 mixed-currency purchases x2 items + 1 purchase x51 items", sourcesM);
      report("insights.activity", "24 mixed-currency purchases x2 items + 1 purchase x51 items", activityM);
      report("tracking.overview", "24 mixed-currency purchases x2 items + 1 purchase x51 items", overviewM);

      expect(sourcesM.result.truncated).toBe(true);
      expect(activityM.result.truncated).toBe(true);
      expect(overviewM.result.truncated).toBe(true);
      // The per-purchase cap (50) bites on the overflow purchase alone; every
      // one of the other 24 purchases' 2 items still renders in full --
      // `truncated` reflects a real, localized cut, not a starved account.
      expect(overviewM.result.items).toHaveLength(usd.length * ITEMS_PER_PURCHASE + eur.length * ITEMS_PER_PURCHASE + 50);
      // as.query (not measure/ctx.runQuery) below to sanity-check the same
      // invariant through the ordinary query path too, not just the metrics probe.
      const activityAgain = await as.query(api.insights.activity, {});
      expect(activityAgain.truncated).toBe(true);

      expect(sourcesM.documentsRead).toBeLessThan(32_000);
      expect(activityM.documentsRead).toBeLessThan(32_000);
      expect(overviewM.documentsRead).toBeLessThan(32_000);
      expect(overviewM.databaseQueries).toBeLessThan(4_096);
    },
  );
});

describe("dashboard: tracking.overview renders every purchase when under cap, mixed currency included (6x1)", () => {
  it("6 purchases (3 USD, 3 EUR), 1 item each: all 6 render, none truncated, and insights.sources/activity agree the same 6 purchases exist", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const purchaseIds: Id<"purchases">[] = [];
    for (const currency of ["USD", "USD", "USD", "EUR", "EUR", "EUR"] as const) {
      const idx = purchaseIds.length;
      const merchantDomain = `six${idx}.example`;
      const purchaseId = await t.run((ctx) =>
        ctx.db.insert("purchases", { userId, merchant: `Six ${idx}`, merchantDomain, purchasedAt: T0 - 2 * DAY, currency, status: "active" }),
      );
      await t.run((ctx) =>
        ctx.db.insert("items", { purchaseId, userId, name: `Item ${idx}`, unitCents: 2_000, qty: 1, productUrl: `https://${merchantDomain}/p/0`, returned: false }),
      );
      purchaseIds.push(purchaseId);
    }

    const overview = await as.query(api.tracking.overview, {});
    expect(overview.items).toHaveLength(6);
    expect(overview.truncated).toBe(false);
    expect(new Set(overview.items.map((i) => i.purchaseId))).toEqual(new Set(purchaseIds));

    const sources = await as.query(api.insights.sources, {});
    expect(sources.rows).toHaveLength(6);
    expect(sources.truncated).toBe(false);
    const activity = await as.query(api.insights.activity, {});
    expect(activity.events.filter((e) => e.kind === "purchase_added")).toHaveLength(6);
  });
});

describe("dashboard: a bought watch is counted exactly once, consistently, in both insights.sources and tracking.overview", () => {
  it("markBought converts the watch; insights.sources.bought sums to 1 and tracking.overview shows exactly one matching item, not zero and not two", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const productUrl = "https://acme.example/p/lamp";
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", { userId, name: "Desk lamp", productUrl, merchantDomain: "acme.example", currency: "USD", status: "active", nextCheckAt: T0 + DAY, lastCents: 4_000, lastCheckedAt: T0 - HOUR(1), lastObservedAt: T0 - HOUR(1) }),
    );
    await t.run((ctx) => ctx.db.insert("watchChecks", { watchId, userId, observedCents: 5_000, currency: "USD", observedAt: T0 - HOUR(3), sourceUrl: productUrl }));
    await t.run((ctx) => ctx.db.insert("watchChecks", { watchId, userId, observedCents: 4_000, currency: "USD", observedAt: T0 - HOUR(1), sourceUrl: productUrl }));

    // Before markBought: the watch is "watching" territory for insights.sources/activity, and tracking.overview (purchases-only) has nothing.
    const beforeSources = await as.query(api.insights.sources, {});
    expect(beforeSources.rows.find((r) => r.domain === "acme.example")).toMatchObject({ watching: 1, bought: 0 });
    expect((await as.query(api.tracking.overview, {})).items).toHaveLength(0);

    const purchaseId = await as.mutation(api.watches.markBought, { watchId, paidCents: 4_000, purchasedAt: T0 - 2 * DAY, qty: 1 });

    // D72 canonical counting: a bought watch is skipped by insights.ts entirely (it no longer contributes as a "watch"); its history is carried by the purchase item markBought created.
    const afterSources = await as.query(api.insights.sources, {});
    const row = afterSources.rows.find((r) => r.domain === "acme.example");
    expect(row).toMatchObject({ watching: 0, bought: 1, checks: 2 });
    expect(afterSources.rows.filter((r) => r.domain === "acme.example")).toHaveLength(1); // never double-counted as a second row

    const overview = await as.query(api.tracking.overview, {});
    expect(overview.items).toHaveLength(1);
    expect(overview.items[0]).toMatchObject({ purchaseId, name: "Desk lamp", merchantDomain: "acme.example" });
    // The carried-over price history landed on the new item, exactly once (2 accepted watchChecks -> 2 priceChecks, not 4).
    expect(overview.items[0].checks).toBe(2);
  });
});

describe("dashboard: budget.status reports paused exactly when the global switch it draws from is actually spent", () => {
  it("price_check exhausted globally: watch_check/item_check report paused:true, and watches.checkNow is really refused (not just misreported)", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const productUrl = "https://acme.example/p/lamp";
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", { userId, name: "Desk lamp", productUrl, merchantDomain: "acme.example", currency: "USD", status: "active", nextCheckAt: T0 - 3_600_000 }),
    );

    // Spend the ENTIRE global price_check switch (shared by watch_check and item_check) before any per-user charge.
    await t.run((ctx) => ctx.db.insert("usage", { day: "2026-09-21", kind: "price_check", count: GLOBAL_DAILY_BUDGETS.price_check.max }));

    const status = await as.query(api.budget.status, { now: T0 });
    const watchCheck = status.kinds.find((k) => k.kind === "watch_check");
    const itemCheck = status.kinds.find((k) => k.kind === "item_check");
    expect(watchCheck).toMatchObject({ userUsed: 0, globalUsed: GLOBAL_DAILY_BUDGETS.price_check.max, globalMax: GLOBAL_DAILY_BUDGETS.price_check.max, paused: true });
    expect(itemCheck).toMatchObject({ userUsed: 0, globalUsed: GLOBAL_DAILY_BUDGETS.price_check.max, globalMax: GLOBAL_DAILY_BUDGETS.price_check.max, paused: true });
    // A kind that draws from a DIFFERENT global switch is unaffected -- "paused" is per-kind, not account-wide.
    const marketLookup = status.kinds.find((k) => k.kind === "market_lookup");
    expect(marketLookup).toMatchObject({ paused: false });

    // What `budget.status` reports must match what actually happens: `checkNow` charges the same global switch and must be refused, with no row mutated.
    await expect(as.mutation(api.watches.checkNow, { watchId })).rejects.toThrow(ConvexError);
    expect((await t.run((ctx) => ctx.db.get(watchId)))!.checkRequestedAt).toBeUndefined();
  });
});
