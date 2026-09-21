/// <reference types="vite/client" />
/**
 * T15 — cross-module freshness regression (D73/P06 applied beyond
 * `watches.list`/`get`, which is where it was originally verified).
 *
 * The shared scenario: 3 clean, ACCEPTED observations establish a real price,
 * then 60 consecutive REJECTED observations (a page that stopped parsing, a
 * variant mismatch, whatever) keep the parent row's "last attempted" moving
 * while its "last known good price" stands still. D73's own watches.test.ts
 * already proves this for `watches.get`/`list` with a 4-day/one-rejection
 * fixture; this file pushes it further (60 rejections, +5 days) and, more
 * importantly, follows the same freshness question into three OTHER read
 * models that consume the same underlying rows: `insights.trackedTable`
 * (watches), `tracking.overview` (purchased items), and `notify.claimDrop`
 * (must never fire off a rejected read). Every test builds its own harness
 * with `transactionLimits: true` (task instruction) — see readBudget.test.ts's
 * file header for why `setup()`'s positional form cannot be used here.
 *
 * No test in this file edits production code (T15's own scope was "tester
 * files only"). T15 found `insights.trackedTable`'s `lowest*` fields did NOT
 * hold the freshness invariant and recorded it as `it.fails` (F-T15-1,
 * D111); T24b fixed `insights.ts` (see its own doc comments) and flipped
 * that case below to a normal passing `it`.
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
import { WATCH_CHECK_INTERVAL_MS } from "./limits";

// ---------------------------------------------------------------------------
// Harness: options-object `convexTest`, `transactionLimits: true` (task
// instruction: "Every test runs under transactionLimits: true"). Copied from
// readBudget.test.ts's own header comment: the positional form `setup()` in
// `./test.setup` uses silently ignores `transactionLimits`.
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
  delete process.env.SHOPSAVVY_API_KEY; // not under test here; recordWatchCheck's auto market-lookup trigger must no-op quietly
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

/** A signed-in user with a verified email, so `claimDrop`'s gate does not itself mask the freshness question. */
async function verifiedUser(t: T, name = "Verified") {
  const { userId, as } = await signedIn(t, name);
  await t.run((ctx) => ctx.db.patch(userId, { email: `${name.toLowerCase()}@example.com`, emailVerificationTime: Date.now() }));
  return { userId, as };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 20, 12);
const WATCH_URL = "https://www.acme.example/p/down-jacket";
const ITEM_URL = "https://www.acme.example/p/jacket";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

async function seedWatch(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "acme.example: down jacket",
      productUrl: WATCH_URL,
      merchantDomain: "acme.example",
      status: "active",
      nextCheckAt: T0,
    }),
  );
}

async function watchRow(t: T, watchId: Id<"watches">) {
  const row = await t.run((ctx) => ctx.db.get(watchId));
  if (!row) throw new Error("watch missing");
  return row;
}

/** A clean, D16-passing observation of `cents` (mirrors watches.test.ts's own `good()`). */
function good(watchId: Id<"watches">, cents: number) {
  return {
    watchId,
    sourceUrl: WATCH_URL,
    observedCents: cents,
    currency: "USD",
    confidence: 0.92,
    isRange: false,
    variantMatch: "exact" as const,
  };
}

/**
 * Builds the shared fixture: 3 accepted checks (a baseline, then one
 * qualifying drop, then a hold — exactly one alertable event), then 60
 * consecutive REJECTED checks (a page that stopped parsing), continuing the
 * normal WATCH_CHECK_INTERVAL_MS cadence throughout. Ends with the fake
 * clock sitting right after the 60th rejection (~T0 + 5.2 days), matching
 * the task's "now=+5d" framing.
 */
async function seedStaleWatch(t: T, userId: Id<"users">) {
  const watchId = await seedWatch(t, userId);

  await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000)); // T0: first accepted price, nothing to drop from yet
  vi.setSystemTime(T0 + WATCH_CHECK_INTERVAL_MS);
  await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_000)); // a genuine, alertable 30% drop
  const lastAcceptedAt = T0 + 2 * WATCH_CHECK_INTERVAL_MS;
  vi.setSystemTime(lastAcceptedAt);
  await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_000)); // unchanged: no second alert

  for (let i = 1; i <= 60; i++) {
    vi.setSystemTime(lastAcceptedAt + i * WATCH_CHECK_INTERVAL_MS);
    // A price range is never an observation (D16): rejected, but still a check.
    await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 1), isRange: true });
  }
  const now = lastAcceptedAt + 60 * WATCH_CHECK_INTERVAL_MS;
  vi.setSystemTime(now);

  return { watchId, lastAcceptedAt, now };
}

// ---------------------------------------------------------------------------
// watches.get: the module this invariant was originally built for (D73).
// Pushed further here (60 rejections vs. the original 4-day/1-rejection
// fixture) to pin the same behaviour at the scale the task specifies.
// ---------------------------------------------------------------------------

describe("freshness: watches.get after 3 accepted + 60 rejected checks (D73/P06)", () => {
  it("priceStale flips true and the verdict goes unknown, but the last real price is preserved, not hidden", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const { watchId, lastAcceptedAt, now } = await seedStaleWatch(t, userId);

    const row = await watchRow(t, watchId);
    expect(row.lastObservedAt).toBe(lastAcceptedAt); // unmoved by any of the 60 rejections
    expect(row.lastCents).toBe(7_000);
    expect(row.lastCheckedAt).toBe(now); // moved by every attempt, accepted or not

    const got = await as.query(api.watches.get, { watchId, now });
    expect(got?.watch.priceStale).toBe(true);
    expect(got?.watch.verdict.label).toBe("unknown");
    expect(got?.watch.verdict.qualified).toBe(true);
    expect(got?.watch.verdict.reason).toMatch(/days ago/);
    // Still shows the last real price and exactly when it was seen/attempted -- not silence.
    expect(got?.watch.lastCents).toBe(7_000);
    expect(got?.watch.lastObservedAt).toBe(lastAcceptedAt);
    expect(got?.watch.lastCheckedAt).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// notify.claimDrop: must fire only on the 3 accepted checks (exactly one of
// which is a qualifying drop), never on any of the 60 rejected ones.
// ---------------------------------------------------------------------------

describe("freshness: notify.claimDrop only fires on accepted observations", () => {
  it("exactly one mailLog row exists after the 3 accepted checks, and none of the 60 rejections add another", async () => {
    const t = harness();
    const { userId } = await verifiedUser(t);
    const watchId = await seedWatch(t, userId);

    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 10_000));
    vi.setSystemTime(T0 + WATCH_CHECK_INTERVAL_MS);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_000)); // the one alertable drop
    const lastAcceptedAt = T0 + 2 * WATCH_CHECK_INTERVAL_MS;
    vi.setSystemTime(lastAcceptedAt);
    await t.mutation(internal.watches.recordWatchCheck, good(watchId, 7_000)); // unchanged: not alertable

    const afterAccepted = await t.run((ctx) => ctx.db.query("mailLog").collect());
    expect(afterAccepted).toHaveLength(1);
    expect(afterAccepted[0].status).toBe("claimed");
    expect(afterAccepted[0].dedupeKey).toBe(`watch:${watchId}:7000`);

    for (let i = 1; i <= 60; i++) {
      vi.setSystemTime(lastAcceptedAt + i * WATCH_CHECK_INTERVAL_MS);
      await t.mutation(internal.watches.recordWatchCheck, { ...good(watchId, 1), isRange: true });
    }

    // 60 rejected reads later: still exactly the one row from the one accepted, qualifying drop.
    const afterRejections = await t.run((ctx) => ctx.db.query("mailLog").collect());
    expect(afterRejections).toHaveLength(1);
    expect(afterRejections[0]._id).toBe(afterAccepted[0]._id);
  });
});

// ---------------------------------------------------------------------------
// insights.trackedTable: the SAME watch/data as above, read through a
// different query. FIXED (T24b/D111 F-T15-1): `lowestCents`/`lowestDomain`
// used to be drawn straight from `watch.lastCents` with no staleness check
// and no staleness field on the row at all -- unlike `watches.get`/`list`,
// which correctly force the verdict to "unknown" via `priceStale`.
// `insights.ts`'s `trackedTable` now applies the identical rule (via
// `lib/freshness.ts`'s `isPriceStale`, expressing the same test `watches.ts`'s
// `summarise()` computes inline) and exposes `priceStale` on the row; a stale
// PRIMARY price is excluded from `lowestCents`/`lowestDomain` (a fresher
// confirmed offer can still win -- see insights.test.ts's F-T15-1 cases for
// that half). `trackedTable` now takes the same optional coarse `now`
// argument (P06/D73) as `watches.get`/`list`, so this test passes the same
// `now` `seedStaleWatch` already returns.
// Repro (unchanged): seed 3 accepted checks then enough rejected checks to
// push the primary store's `points` window (TABLE_POINTS=20, so the newest
// 40 watchChecks) past every accepted row.
// ---------------------------------------------------------------------------

describe("freshness: insights.trackedTable and a stale 'lowest' (F-T15-1, MEDIUM)", () => {
  it("does not surface a >5-day-stale accepted price as 'lowest', and flags the row priceStale", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const { now } = await seedStaleWatch(t, userId);

    const rows = await as.query(api.insights.trackedTable, { now });
    const row = rows[0];
    expect(row.priceStale).toBe(true);
    // The only store on this watch is the (now stale) primary, so with it excluded nothing is left.
    expect(row.lowestCents).toBeNull();
    expect(row.lowestDomain).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tracking.overview: the item-level twin of the watch fixture above, built
// through `priceWatch.recordCheck` (the items' equivalent of
// `recordWatchCheck`) so the same 3-accepted+60-rejected shape exercises the
// PURCHASES path tracking.overview actually reads (priceChecks/items), not
// watches/watchChecks.
// ---------------------------------------------------------------------------

describe("freshness: tracking.overview distinguishes 'last attempted' from 'last priced' (D73 applied to owned items)", () => {
  function goodItem(itemId: Id<"items">, cents: number) {
    return {
      itemId,
      sourceUrl: ITEM_URL,
      observedCents: cents,
      currency: "USD",
      confidence: 0.92,
      isRange: false,
      variantMatch: "exact" as const,
    };
  }

  it("lastCheckedAt tracks the latest attempt even once no accepted price survives the points window", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId,
        merchant: "Acme",
        merchantDomain: "acme.example",
        purchasedAt: T0 - 10 * DAY,
        currency: "USD",
        status: "active",
      }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId,
        userId,
        name: "Jacket",
        unitCents: 12_000,
        qty: 1,
        productUrl: ITEM_URL,
        returned: false,
      }),
    );

    await t.mutation(internal.priceWatch.recordCheck, goodItem(itemId, 12_000));
    vi.setSystemTime(T0 + HOUR);
    await t.mutation(internal.priceWatch.recordCheck, goodItem(itemId, 9_000));
    const lastPricedAt = T0 + 2 * HOUR;
    vi.setSystemTime(lastPricedAt);
    await t.mutation(internal.priceWatch.recordCheck, goodItem(itemId, 9_000));

    for (let i = 1; i <= 60; i++) {
      vi.setSystemTime(lastPricedAt + i * HOUR);
      await t.mutation(internal.priceWatch.recordCheck, { ...goodItem(itemId, 1), isRange: true });
    }
    const now = lastPricedAt + 60 * HOUR;
    vi.setSystemTime(now);

    const out = await as.query(api.tracking.overview, { now });
    const item = out.items.find((i) => i.itemId === itemId);
    expect(item).toBeDefined();
    // MAX_POINTS=12 reads only the newest 12 priceChecks: all 12 are the tail
    // of the 60-rejection run, so no accepted price survives the window at all.
    expect(item!.points).toEqual([]);
    expect(item!.latestCents).toBeUndefined();
    expect(item!.checks).toBe(12);
    // The freshness invariant: "we tried recently" (lastCheckedAt) is never
    // conflated with "we last knew a real price" (lastPricedAt, 60 hours
    // earlier and, per the assertion above, no longer even represented).
    expect(item!.lastCheckedAt).toBe(now);
    expect(item!.lastCheckedAt).not.toBe(lastPricedAt);
  });

  it("with a shorter rejection run (under the points window), lastCheckedAt and the latest priced point are simultaneously visible and distinct", async () => {
    const t = harness();
    const { userId, as } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId,
        merchant: "Acme",
        merchantDomain: "acme.example",
        purchasedAt: T0 - 10 * DAY,
        currency: "USD",
        status: "active",
      }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId,
        userId,
        name: "Jacket",
        unitCents: 12_000,
        qty: 1,
        productUrl: ITEM_URL,
        returned: false,
      }),
    );

    await t.mutation(internal.priceWatch.recordCheck, goodItem(itemId, 9_000));
    const lastPricedAt = T0;
    // 3 rejections: well under MAX_POINTS=12, so the one accepted price stays in the window.
    for (let i = 1; i <= 3; i++) {
      vi.setSystemTime(T0 + i * HOUR);
      await t.mutation(internal.priceWatch.recordCheck, { ...goodItem(itemId, 1), isRange: true });
    }
    const now = T0 + 3 * HOUR;

    const out = await as.query(api.tracking.overview, { now });
    const item = out.items.find((i) => i.itemId === itemId)!;
    expect(item.points).toEqual([{ at: lastPricedAt, cents: 9_000 }]);
    expect(item.latestCents).toBe(9_000);
    expect(item.lastCheckedAt).toBe(now);
    expect(item.lastCheckedAt).not.toBe(lastPricedAt);
    expect(item.lastCheckedAt).toBeGreaterThan(item.points[0].at);
  });
});
