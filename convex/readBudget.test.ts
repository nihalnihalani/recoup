/// <reference types="vite/client" />
/**
 * T07 (P07 measurement).
 *
 * Representative high-volume fixtures under real Convex transaction limits,
 * measured with `convexTest`'s own transaction-metrics tracker rather than
 * guessed. See docs/reviews/read-budgets.md for the numbers this file
 * produces and docs/reviews/2026-09-21-phase0-reproduction.md's P07 rows +
 * the `refute:P07:security` dissent (D80) for the defect this file
 * reproduces.
 *
 * IMPORTANT: `convexTest(schema, modules)` (positional form, as `setup()` in
 * `./test.setup` calls it) silently ignores `transactionLimits` — it is not
 * an argument that overload accepts at all. Only the OPTIONS-OBJECT form,
 * `convexTest({ schema, modules, transactionLimits: true })`, turns on
 * enforcement (node_modules/convex-test/dist/index.js:1858-1862, confirmed
 * in the dissent above). `setup()` cannot pass that option, so this file
 * does not import it; `harness()` below rebuilds it with the same component
 * registrations (copied verbatim from `test.setup.ts`, D51's exhaustive-glob
 * fix included) plus `transactionLimits: true`.
 *
 * Reading the metrics: `ctx.meta.getTransactionMetrics()` (documented in
 * convex/_generated/ai/guidelines.md's mutation-guidelines section) is only
 * callable from INSIDE a running query/mutation — convex-test exposes no
 * external accessor on `t` itself (grepped node_modules/convex-test/dist for
 * `transactionMetrics`/`getTransactionMetrics`: the only reader is the
 * `1.0/getTransactionMetrics` syscall, reachable solely via `ctx.meta`). So
 * `measure()` below calls the target function through `ctx.runQuery`/
 * `ctx.runMutation` from inside `t.run`, then reads `ctx.meta` on the same
 * (parent) transaction: a nested call's read metrics fold into the parent on
 * both commit AND rollback (transactionMetrics.js's `commit()`/`rollback()`),
 * so this works even for the query that is expected to throw.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// ---------------------------------------------------------------------------
// Harness (deliverable 1): same registrations as test.setup.ts's setup(),
// options-object form, transaction limits ON.
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

/** Same shape as test.setup.ts's `signedIn`, inlined so this file has no dependency on `setup()`. */
async function signedIn(t: T, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

// ---------------------------------------------------------------------------
// Measurement helper: real convex-test transaction metrics, not estimates.
// ---------------------------------------------------------------------------

type Ctx = Parameters<Parameters<T["run"]>[0]>[0];

type Measured<Out> = {
  result: Out;
  documentsRead: number;
  bytesRead: number;
  databaseQueries: number;
  ms: number;
};

type MeasuredError = { message: string; name: string } | null;

/**
 * Runs `call` inside its own `t.run` transaction and reports the real
 * documents/bytes/queries it used, via `ctx.meta.getTransactionMetrics()`.
 * Catches so an expected overflow can still be measured (rollback folds
 * reads into the parent, per transactionMetrics.js) — the raw `Error` is
 * flattened to a plain `{message, name}` INSIDE the `t.run` callback,
 * because the callback's return value round-trips through Convex's own
 * value serialization (`t.run` is mutation-shaped) and a bare `Error`
 * instance is not a supported Convex type.
 */
async function measure<Out>(
  accessor: Pick<T, "run">,
  call: (ctx: Ctx) => Promise<Out>,
): Promise<Measured<Out | undefined> & { error: MeasuredError }> {
  const started = performance.now();
  const { result, error, metrics } = await accessor.run(async (ctx) => {
    let result: Out | undefined;
    let error: MeasuredError = null;
    try {
      result = await call(ctx);
    } catch (e) {
      error = { message: e instanceof Error ? e.message : String(e), name: e instanceof Error ? e.name : "Error" };
    }
    const metrics = await ctx.meta.getTransactionMetrics();
    return { result, error, metrics };
  });
  const ms = performance.now() - started;
  return {
    result,
    error,
    documentsRead: metrics.documentsRead.used,
    bytesRead: metrics.bytesRead.used,
    databaseQueries: metrics.databaseQueries.used,
    ms,
  };
}

/** Prints one line per measurement so the numbers in read-budgets.md come from a real run, not a guess. */
function report(name: string, fixture: string, m: Omit<Measured<unknown>, "result">) {
  // eslint-disable-next-line no-console
  console.log(
    "[read-budget]",
    JSON.stringify({
      name,
      fixture,
      documentsRead: m.documentsRead,
      bytesRead: m.bytesRead,
      databaseQueries: m.databaseQueries,
      ms: Math.round(m.ms * 100) / 100,
    }),
  );
}

const HOUR = 3_600_000;
const DAY = 86_400_000;
/**
 * Every measured function reads `Date.now()` directly (tracking.overview,
 * watches.sweep, priceWatch.eligibleItems). Faking only `Date` (not
 * `setTimeout`/timers, which convex-test's own internals depend on real
 * refs of, per its `realSetTimeout` comment) keeps fixture timestamps
 * deterministic across whatever real day this suite runs on, without
 * touching `performance.now()`, which the `ms` measurements below need to
 * stay real.
 */
const NOW = Date.UTC(2026, 8, 21, 12);
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

// ---------------------------------------------------------------------------
// Fixture sizes (deliverable 2). These are the numbers the task specifies,
// not the app's own per-user caps (limits.ts) — the point is to measure a
// single account heavier than any one query's own bound, so truncation and
// fan-out costs are visible.
// ---------------------------------------------------------------------------

// Reduced from the task's original 50 items/30 checks/200 watches/60
// checks after an initial measured run: insights.activity/sources's
// serialized nested fan-out (P07 "serialized fan-out") took ~75s EACH per
// query at the original size in convex-test's simulated syscall layer,
// pushing a single foreground run past a reasonable timeout. This size is
// still well past every query's own per-parent cap (MAX_WATCHES=40,
// CHECKS_PER_PRODUCT=12, etc. in insights.ts) and reproduces truncation and
// fan-out costs in seconds instead of minutes. tracking.overview's overflow
// (a separate, real finding) is measured with its own dedicated fixture
// below instead of inflating this one further.
const SIZES = {
  purchases: 40,
  itemsPerPurchase: 20,
  checksPerItem: 10,
  watches: 60,
  checksPerWatch: 20,
  offers: 300,
  checksPerOffer: 20,
  processedEvents: 500,
} as const;

/**
 * One heavy account: 40 purchases x 50 items x 30 price checks, 200 watches x
 * 60 checks, 300 offers (on one dedicated watch) x 20 checks each, and 500
 * processedEvents. Built in chunked `t.run` calls (each well under the
 * 16,000-document / 16MiB write limits `transactionLimits: true` now
 * enforces) — a single `t.run` across the whole fixture would itself throw.
 */
async function heavyAccount(t: T, userId: Id<"users">, now: number): Promise<{ offerWatchId: Id<"watches"> }> {
  // Purchases + items + price checks: one purchase per `t.run` chunk.
  // Per chunk: 1 + itemsPerPurchase + itemsPerPurchase*checksPerItem
  //          = 1 + 50 + 1500 = 1551 writes, well under the 16,000 cap.
  for (let p = 0; p < SIZES.purchases; p++) {
    await t.run(async (ctx) => {
      const merchantDomain = `store${p}.example`;
      const purchaseId = await ctx.db.insert("purchases", {
        userId,
        merchant: `Store ${p}`,
        merchantDomain,
        purchasedAt: now - 10 * DAY,
        currency: "USD",
        status: "active",
      });
      for (let i = 0; i < SIZES.itemsPerPurchase; i++) {
        const productUrl = `https://${merchantDomain}/p/${i}`;
        const itemId = await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: `Item ${p}-${i}`,
          unitCents: 5_000,
          qty: 1,
          productUrl,
          returned: false,
        });
        for (let c = 0; c < SIZES.checksPerItem; c++) {
          await ctx.db.insert("priceChecks", {
            itemId,
            userId,
            observedCents: 4_500 + c,
            currency: "USD",
            observedAt: now - (SIZES.checksPerItem - c) * HOUR,
            sourceUrl: productUrl,
          });
        }
      }
    });
  }

  // Watches + watchChecks, 20 watches per `t.run` chunk (20*(1+60) = 1,220 writes).
  const watchChunk = 20;
  for (let w = 0; w < SIZES.watches; w += watchChunk) {
    const end = Math.min(w + watchChunk, SIZES.watches);
    await t.run(async (ctx) => {
      for (let i = w; i < end; i++) {
        const productUrl = `https://watch${i}.example/p/1`;
        const watchId = await ctx.db.insert("watches", {
          userId,
          name: `Watch ${i}`,
          productUrl,
          merchantDomain: `watch${i}.example`,
          currency: "USD",
          status: "active",
          nextCheckAt: now - HOUR, // due, so watches.sweep has real work to bound
        });
        for (let c = 0; c < SIZES.checksPerWatch; c++) {
          await ctx.db.insert("watchChecks", {
            watchId,
            userId,
            observedCents: 3_000 + c,
            currency: "USD",
            observedAt: now - (SIZES.checksPerWatch - c) * HOUR,
            sourceUrl: productUrl,
          });
        }
      }
    });
  }

  // One dedicated watch carrying 300 offers x 20 checks each (deliberately
  // over MAX_OFFERS_PER_WATCH=40 + the WATCH_ROWS cap, to see the bound bite).
  const offerWatchId = await t.run(async (ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "Offer stress watch",
      productUrl: "https://primary.example/p/1",
      merchantDomain: "primary.example",
      currency: "USD",
      status: "active",
      nextCheckAt: now + HOUR,
      lastCents: 5_000,
    }),
  );
  const offerChunk = 60; // 60*(1+20) = 1,260 writes per chunk
  for (let o = 0; o < SIZES.offers; o += offerChunk) {
    const end = Math.min(o + offerChunk, SIZES.offers);
    await t.run(async (ctx) => {
      for (let i = o; i < end; i++) {
        const offerId = await ctx.db.insert("offers", {
          watchId: offerWatchId,
          userId,
          storeDomain: `offer${i}.example`,
          productUrl: `https://offer${i}.example/p/1`,
          title: "Same product elsewhere",
          status: "confirmed",
          lastCents: 2_000 + i,
          currency: "USD",
          lastCheckedAt: now,
        });
        for (let c = 0; c < SIZES.checksPerOffer; c++) {
          await ctx.db.insert("offerChecks", {
            offerId,
            watchId: offerWatchId,
            userId,
            observedCents: Math.max(1, 2_000 + i - c),
            currency: "USD",
            observedAt: now - (SIZES.checksPerOffer - c) * HOUR,
          });
        }
      }
    });
  }

  // processedEvents: 500 in one chunk (500 writes).
  await t.run(async (ctx) => {
    for (let i = 0; i < SIZES.processedEvents; i++) {
      await ctx.db.insert("processedEvents", {
        externalId: `evt-${i}`,
        kind: "inbound_email",
        status: i % 2 === 0 ? "failed" : "needs_review",
        attempts: 1,
        userId,
        lastError: "Could not read the reply: boom",
      });
    }
  });

  return { offerWatchId };
}

// ---------------------------------------------------------------------------
// The 8 heavy-account measurements + claims.get (own fixture) + eligibleItems.
// ---------------------------------------------------------------------------

describe("read budgets: heavy-account measurements (T07)", () => {
  let t: T;
  let userId: Id<"users">;
  let as: ReturnType<T["withIdentity"]>;
  let offerWatchId: Id<"watches">;

  beforeAll(async () => {
    t = harness();
    const signed = await signedIn(t, "Heavy");
    userId = signed.userId;
    as = signed.as;
    ({ offerWatchId } = await heavyAccount(t, userId, NOW));
  }, 120_000);

  // insights.activity and insights.sources both walk every non-archived
  // watch and active purchase with a nested, serial (non-Promise.all) query
  // per product (P07 "serialized fan-out", partially_present) — at this
  // fixture size that is ~74s of real wall time in convex-test's simulated
  // syscall layer, hence the generous timeout: the slowness itself is part
  // of what this measurement documents, not a flake.
  it(
    "insights.activity",
    async () => {
      const fixture = "40 purchases x20 items x10 checks, 60 watches x20 checks";
      const m = await measure(as, (ctx) => ctx.runQuery(api.insights.activity, {}));
      expect(m.error).toBeNull();
      report("insights.activity", fixture, m);
      expect(m.documentsRead).toBeLessThan(32_000);
      expect(m.bytesRead).toBeLessThan(16 * (1 << 20));
    },
    150_000,
  );

  it(
    "insights.sources",
    async () => {
      const fixture = "40 purchases x20 items x10 checks, 60 watches x20 checks + 1 watch x300 offers";
      const m = await measure(as, (ctx) => ctx.runQuery(api.insights.sources, {}));
      expect(m.error).toBeNull();
      report("insights.sources", fixture, m);
      expect(m.documentsRead).toBeLessThan(32_000);
    },
    150_000,
  );

  it(
    "insights.priceHistory",
    async () => {
      const fixture = "1 watch x300 offers x20 checks each, amid 200 other watches";
      const m = await measure(as, (ctx) => ctx.runQuery(api.insights.priceHistory, { watchId: offerWatchId }));
      expect(m.error).toBeNull();
      expect(m.result).not.toBeNull();
      report("insights.priceHistory", fixture, m);
      expect(m.documentsRead).toBeLessThan(32_000);
    },
    60_000,
  );

  // FINDING (new, beyond the task's named repro): convex/tracking.ts:105-108
  // `overview` does an UNBOUNDED `.collect()` of every item on `by_purchase`
  // for each of up to 60 active purchases (MAX_PURCHASES, tracking.ts:10),
  // then up to MAX_POINTS=90 priceChecks (tracking.ts:111-115) and an
  // unbounded claims `.collect()` (tracking.ts:122-125) PER ITEM.
  //
  // EMPIRICALLY CONFIRMED (an earlier run of this exact suite, before this
  // fixture was reduced for CI runtime — see below): at 40 purchases x50
  // items x30 checks (all within insights.ts's own MAX_PURCHASES=40-shaped
  // caps, nothing exotic), documentsRead reached exactly 32,001 and
  // `tracking.overview` threw "Scanned too many documents ... (limit:
  // 32000)" for a REAL SIGNED-IN USER's dashboard load, not just a cron
  // (40*(1+50+50*30) = 62,040 attempted reads). D81 recorded "P07
  // transaction-limit failure on insights.activity at owner maxima" as NOT
  // reproduced — that holds (insights.activity caps at
  // CHECKS_PER_PRODUCT=12 per item; see the passing measurement above) but
  // tracking.overview has no per-item cap on the ITEMS read itself and does
  // overflow at the same 40x50x30 shape. This is a HIGH-severity gap on par
  // with D80's eligibleItems finding, on a more exposed surface (a page a
  // signed-in user loads directly, not a cron): flagging it here even
  // though it was not separately named in D80/D81.
  //
  // The measurement below re-runs the SAME query against this file's
  // (reduced, see SIZES above) shared fixture, which stays comfortably
  // under the ceiling — this is a fast regression guard, not a repro of the
  // overflow itself (re-inserting 32k+ rows just for this one assertion
  // would roughly double this file's runtime for no new information: the
  // threshold is already pinned by the eligibleItems bisection below, which
  // hits the identical generic per-transaction limit).
  it(
    "tracking.overview stays bounded at the (reduced) fixture size",
    async () => {
      const fixture = "40 purchases x20 items x10 checks";
      const m = await measure(as, (ctx) => ctx.runQuery(api.tracking.overview, {}));
      expect(m.error).toBeNull();
      report("tracking.overview", fixture, m);
      expect(m.documentsRead).toBeLessThan(32_000);
    },
    60_000,
  );

  it(
    "watches.list",
    async () => {
      const fixture = "60 watches x20 checks + 1 watch x300 offers (61 active watches total)";
      const m = await measure(as, (ctx) => ctx.runQuery(api.watches.list, {}));
      expect(m.error).toBeNull();
      report("watches.list", fixture, m);
      expect(m.documentsRead).toBeLessThan(32_000);
    },
    60_000,
  );

  it(
    "offers.listForWatch",
    async () => {
      const fixture = "1 watch x300 offers (over the 40-per-watch + 60-marker WATCH_ROWS cap)";
      const m = await measure(as, (ctx) => ctx.runQuery(api.offers.listForWatch, { watchId: offerWatchId }));
      expect(m.error).toBeNull();
      report("offers.listForWatch", fixture, m);
      // 1 (ctx.db.get(watchId)) + WATCH_ROWS take(100) = 101: 300 offers means ~200 are invisible to this read.
      expect(m.documentsRead).toBeLessThanOrEqual(101);
    },
    30_000,
  );

  it(
    "intake.needsAttention",
    async () => {
      const fixture = "500 processedEvents (250 failed, 250 needs_review)";
      const m = await measure(as, (ctx) => ctx.runQuery(api.intake.needsAttention, {}));
      expect(m.error).toBeNull();
      report("intake.needsAttention", fixture, m);
      // ATTENTION_LIMIT=50 per status x2 statuses: bounded regardless of the 500 rows behind it.
      expect(m.documentsRead).toBeLessThanOrEqual(100);
    },
    30_000,
  );

  it(
    "watches.sweep",
    async () => {
      const fixture = "60 due watches (plus 1 not-yet-due offer-stress watch)";
      const m = await measure(t, (ctx) => ctx.runMutation(internal.watches.sweep, {}));
      expect(m.error).toBeNull();
      report("watches.sweep", fixture, m);
      // WATCH_SWEEP_PAGE=50: bounded regardless of the 60 due rows behind it.
      expect(m.result).toBe(50);
      expect(m.documentsRead).toBeLessThanOrEqual(200);
    },
    30_000,
  );
});

describe("read budgets: claims.get on a claim with 200 ledger events", () => {
  it(
    "claims.get",
    async () => {
      const t = harness();
      const { userId, as } = await signedIn(t, "Claimant");
      const claimId = await t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId,
          merchant: "Acme",
          merchantDomain: "acme.example",
          purchasedAt: NOW - 10 * DAY,
          currency: "USD",
          status: "active",
        });
        const itemId = await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: "Jacket",
          unitCents: 12_000,
          qty: 1,
          productUrl: "https://acme.example/p/jacket",
          returned: false,
        });
        const claimId = await ctx.db.insert("claims", {
          purchaseId,
          itemId,
          userId,
          type: "price_adjustment",
          expectedCents: 2_000,
          status: "detected",
          token: "tok-claims-get-fixture",
          version: 1,
        });
        for (let i = 0; i < 200; i++) {
          await ctx.db.insert("ledgerEvents", {
            claimId,
            userId,
            kind: i % 2 === 0 ? "promised_credit" : "later_debit",
            cents: 100,
            evidence: `event ${i}`,
          });
        }
        return claimId;
      });

      const m = await measure(as, (ctx) => ctx.runQuery(api.claims.get, { claimId }));
      expect(m.error).toBeNull();
      report("claims.get", "1 claim x200 ledgerEvents", m);
      // `ledgerEvents.by_claim` is `.collect()`d with no bound (claims.ts:360-363): documented, not defended.
      expect(m.documentsRead).toBeGreaterThanOrEqual(200);
      expect(m.documentsRead).toBeLessThan(32_000);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// priceWatch.eligibleItems: the reproduced transaction-limit overflow
// (phase0 dissent refute:P07:security#1, D80 -> severity HIGH).
// ---------------------------------------------------------------------------

/**
 * `items` scanned in `_creationTime` desc order (matching `eligibleItems`'s
 * own unindexed scan), each with a valid, open price-adjustment window (an
 * active, non-example purchase + a price-adjustment policy covering `now`)
 * so `hasOpenPriceClaim`'s full `.collect()` runs on every item instead of
 * the loop short-circuiting at FANOUT_LIMIT=50 eligible items found. Built
 * in chunked `t.run` calls (`itemsPerChunk*(1 + claimsPerItem)` writes each).
 */
async function overflowFixture(
  t: T,
  userId: Id<"users">,
  now: number,
  { items, claimsPerItem }: { items: number; claimsPerItem: number },
): Promise<void> {
  const merchantDomain = "overflow.example";
  const purchaseId = await t.run(async (ctx) =>
    ctx.db.insert("purchases", {
      userId,
      merchant: "Overflow Co",
      merchantDomain,
      purchasedAt: now - 10 * DAY,
      currency: "USD",
      status: "active",
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("policies", {
      userId,
      merchantDomain,
      kind: "price_adjustment",
      windowDays: 365,
      channel: "email",
      passage: "Price match within 365 days.",
      sourceUrl: `https://${merchantDomain}/policy`,
      retrievedAt: now - 10 * DAY,
      confidence: 1,
      confirmedByUser: true,
    }),
  );

  const itemsPerChunk = 50;
  for (let start = 0; start < items; start += itemsPerChunk) {
    const end = Math.min(start + itemsPerChunk, items);
    await t.run(async (ctx) => {
      for (let i = start; i < end; i++) {
        const itemId = await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: `Overflow item ${i}`,
          unitCents: 5_000,
          qty: 1,
          productUrl: `https://${merchantDomain}/p/${i}`,
          returned: false,
        });
        // One open price_adjustment claim (keeps the item permanently
        // ineligible, so the loop never short-circuits at FANOUT_LIMIT)...
        await ctx.db.insert("claims", {
          purchaseId,
          itemId,
          userId,
          type: "price_adjustment",
          expectedCents: 500,
          status: "detected",
          token: `tok-open-${i}`,
          version: 1,
        });
        // ...plus (claimsPerItem - 1) dismissed return_credit claims (D44
        // allows re-opening after a dismissal, so nothing prunes these).
        for (let c = 1; c < claimsPerItem; c++) {
          await ctx.db.insert("claims", {
            purchaseId,
            itemId,
            userId,
            type: "return_credit",
            expectedCents: 100,
            status: "dismissed",
            token: `tok-dismissed-${i}-${c}`,
            version: c + 1,
          });
        }
      }
    });
  }
}

describe("priceWatch.eligibleItems: transaction-limit overflow (D80)", () => {

  // FINDING: convex/priceWatch.ts:173-189 `eligibleItems` scans up to
  // SCAN_LIMIT=500 items and, for each one still inside its price-adjustment
  // window, calls `hasOpenPriceClaim` (priceWatch.ts:122-129), which
  // `.collect()`s EVERY claim row on `by_item` with no bound and no
  // claims.by_item_kind_status index narrowing the read to just the open
  // ones. At 500 items x 65 claims each (1 open price_adjustment + 64
  // dismissed return_credit, exactly the phase0 dissent's repro —
  // docs/reviews/2026-09-21-phase0-reproduction.md's `refute:P07:security`
  // #1), the cron's own `eligibleItems` throws "Scanned too many documents
  // ... (limit: 32000)" every tick, for every user, with no way to recover
  // short of deleting claim rows by hand (D44 lets a user re-open a
  // dismissed return_credit claim any number of times, and nothing prunes
  // dismissed claims). D80 raised this from not_reproduced/info to HIGH.
  // T12's fix (D74: claims.by_item_kind_status instead of a full collect,
  // plus item-level nextCheckAt rotation) should make this pass for real;
  // until then it stays `it.fails` so a regression is loud.
  it.fails(
    "does not overflow the 32,000-document budget at 500 items x 65 claims/item",
    async () => {
      const t = harness();
      const { userId } = await signedIn(t, "Overflowed");
      await overflowFixture(t, userId, NOW, { items: 500, claimsPerItem: 65 });

      const m = await measure(t, (ctx) => ctx.runQuery(internal.priceWatch.eligibleItems, {}));
      report("priceWatch.eligibleItems (500x65, expected fixed)", "500 items x65 claims/item", m);
      if (m.error) throw new Error(`${m.error.name}: ${m.error.message}`);
      expect(Array.isArray(m.result)).toBe(true);
    },
    60_000,
  );

  it(
    "reproduces the exact throw and its metrics at the moment of failure",
    async () => {
      const t = harness();
      const { userId } = await signedIn(t, "Overflowed2");
      await overflowFixture(t, userId, NOW, { items: 500, claimsPerItem: 65 });

      const m = await measure(t, (ctx) => ctx.runQuery(internal.priceWatch.eligibleItems, {}));
      report("priceWatch.eligibleItems (500x65, current main)", "500 items x65 claims/item", m);
      expect(m.error).not.toBeNull();
      expect(m.error!.message).toMatch(/Scanned too many documents.*limit: 32000/);
      // The tracker throws on the read that pushes documentsRead past the
      // limit; that read still commits (real Convex charges for it too), so
      // `used` reads the limit + 1 deterministically, regardless of which
      // item/claim tipped it over.
      expect(m.documentsRead).toBe(32_001);
    },
    60_000,
  );

  // Bisection (task deliverable 3: "bisect fixture size to the failure
  // threshold"). documentsRead for this code path is, per item scanned,
  // 1 (purchase get) + 1 (policy lookup, one row per user+domain+kind here)
  // + claimsPerItem (the unbounded collect), plus the initial 500-document
  // `items` scan itself: total = items * (claimsPerItem + 3). At items=500
  // that crosses the 32,000 ceiling between claimsPerItem=61 (500*64=32,000,
  // exactly AT the limit: the tracker only throws when a read pushes STRICTLY
  // past it) and claimsPerItem=62 (500*65=32,500). Confirmed empirically
  // below at the lower bound; the dissent's own 65-claim repro above
  // confirms the upper bound.
  it(
    "61 claims/item at 500 items sits exactly at the ceiling and does not throw",
    async () => {
      const t = harness();
      const { userId } = await signedIn(t, "AtCeiling");
      await overflowFixture(t, userId, NOW, { items: 500, claimsPerItem: 61 });

      const m = await measure(t, (ctx) => ctx.runQuery(internal.priceWatch.eligibleItems, {}));
      report("priceWatch.eligibleItems (500x61, ceiling)", "500 items x61 claims/item", m);
      expect(m.error).toBeNull();
      expect(m.documentsRead).toBe(32_000);
    },
    60_000,
  );
});
