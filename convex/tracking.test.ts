import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";

type CurrencyTotals = { foundCents: number; recoveredCents: number; exampleFoundCents: number };
/** `totals.byCurrency.USD` (the handler's inferred type includes the empty `{}` of the signed-out shape). */
const usdOf = (out: { totals: { byCurrency: Record<string, CurrencyTotals> | object } }) =>
  (out.totals.byCurrency as Record<string, CurrencyTotals>).USD;
import schema from "./schema";

describe("tracking.overview", () => {
  it("returns an empty dashboard to a signed-out caller", async () => {
    const t = setup();
    const out = await t.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(0);
    expect(out.totals.tracked).toBe(0);
  });

  it("plots the example history oldest first with the drop against the paid price", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const out = await as.query(api.tracking.overview, {});
    const jacket = out.items.find((i) => i.name === "Waxed field jacket");
    expect(jacket).toBeDefined();
    expect(jacket!.points.length).toBeGreaterThan(5);
    const times = jacket!.points.map((p) => p.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(jacket!.latestCents).toBe(9500);
    expect(jacket!.dropCents).toBe(2500);
    expect(jacket!.claim?.expectedCents).toBe(2500);
    // Example money never reaches the account totals (D27).
    expect(out.totals.foundCents).toBe(0);
  });

  it("never shows one user's items to another", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    await alice.mutation(api.examples.load, {});
    const out = await bob.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(0);
  });

  it("F6 (D103): archive churn beyond MAX_PURCHASES cannot hide an active purchase (P05-shaped)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    // The active purchase is created FIRST (older); 61 archived purchases
    // (one more than MAX_PURCHASES) are created after it. A `by_user` page
    // ordered newest-first, filtered to "active" only after reading, would
    // never even reach this row -- it is the 62nd newest.
    const activeId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId, merchant: "Old Active Store", merchantDomain: "old-active.example", currency: "USD", status: "active",
      }),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 61; i++) {
        await ctx.db.insert("purchases", {
          userId, merchant: `Archived ${i}`, merchantDomain: `archived${i}.example`, currency: "USD", status: "archived",
        });
      }
    });
    await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId: activeId, userId, name: "Still here", unitCents: 1_000, qty: 1, returned: false,
      }),
    );

    const out = await as.query(api.tracking.overview, {});
    expect(out.items.some((i) => i.name === "Still here")).toBe(true);
  });

  it("F5b (D103): totals never sum money across currencies; byCurrency has the full breakdown", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);

    async function seedClaimedItem(currency: string, unresolvedCents: number) {
      return await t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId, merchant: `${currency} Store`, merchantDomain: `${currency.toLowerCase()}.example`,
          purchasedAt: Date.now() - 2 * 86_400_000, currency, status: "active",
        });
        const itemId = await ctx.db.insert("items", {
          purchaseId, userId, name: `${currency} item`, unitCents: 10_000, qty: 1, returned: false,
        });
        await ctx.db.insert("claims", {
          purchaseId, itemId, userId, type: "price_adjustment", expectedCents: unresolvedCents,
          status: "detected", token: `tok-${currency}`, version: 1,
        });
        return { purchaseId, itemId };
      });
    }

    // USD is the larger claim: it should be picked as primaryCurrency.
    await seedClaimedItem("USD", 5_000);
    await seedClaimedItem("EUR", 1_000);

    const out = await as.query(api.tracking.overview, {});
    expect(out.totals.mixedCurrencies).toBe(true);
    expect(out.totals.primaryCurrency).toBe("USD");
    // The legacy single-number field is USD-only, never USD+EUR summed as if they were the same money.
    expect(out.totals.foundCents).toBe(5_000);
    expect(out.totals.byCurrency).toEqual({
      USD: { foundCents: 5_000, recoveredCents: 0, exampleFoundCents: 0 },
      EUR: { foundCents: 1_000, recoveredCents: 0, exampleFoundCents: 0 },
    });
  });

  it("F5b (D103): a single-currency account reports mixedCurrencies: false", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const out = await as.query(api.tracking.overview, {});
    expect(out.totals.mixedCurrencies).toBe(false);
    expect(out.totals.primaryCurrency).toBe("USD");
  });

  it("F4 regression (fe2 review, P02-OW-4): a queued claim's sendUnknown reaches the overview item", async () => {
    // Without the value spread at the claim's projection, this stays undefined even though the dashboard's
    // StatusPill/StatusSteps read it to avoid a forever-pulsing "Sending…" for a claim whose delivery is unknown
    // (P02-OW-4/P02-SK-2). Every OTHER test in this file builds its Item objects by hand, so dropping the field on
    // the server silently keeps typecheck and the rest of the suite green.
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId, merchant: "S", merchantDomain: "s.example", purchasedAt: Date.now() - 2 * 86_400_000, currency: "USD", status: "active",
      }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", { purchaseId, userId, name: "K", unitCents: 10_000, qty: 1, returned: false }),
    );
    await t.run((ctx) =>
      ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_000, status: "queued", sendUnknown: true, token: "tok", version: 1,
      }),
    );

    const out = await as.query(api.tracking.overview, {});
    const item = out.items.find((i) => i.name === "K");
    expect(item?.claim?.status).toBe("queued");
    expect(item?.claim?.sendUnknown).toBe(true);
  });
});

describe("D115 6b-3 / T18.3: a tombstoned caller sees the same empty dashboard a signed-out caller does", () => {
  it("overview returns the all-zero empty shape, not the caller's real data, once tombstoned", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    // Prove there is real data first, so the post-tombstone assertion below is not vacuous.
    const before = await as.query(api.tracking.overview, {});
    expect(before.items.length).toBeGreaterThan(0);

    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));

    const after = await as.query(api.tracking.overview, {});
    expect(after.items).toHaveLength(0);
    expect(after.totals.tracked).toBe(0);
    expect(after).toEqual({
      items: [],
      totals: {
        tracked: 0, watching: 0, foundCents: 0, recoveredCents: 0, checks: 0, exampleFoundCents: 0,
        mixedCurrencies: false, primaryCurrency: null, byCurrency: {},
      },
      truncated: false,
    });
  });

  it("a normal (non-tombstoned) account is unaffected by the gate", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const out = await as.query(api.tracking.overview, {});
    expect(out.items.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M2C (wave 2): overview money. DA-A-34 repro A.7 inverted (every price claim on an item counts, not only the
// newest); closed-for-ask (`isClosedForAsk`: denied, non-cash) is never "found"; each claim's own currency
// (`claimCurrency`); item-less `scenario` claims are never price rows (DA-A-12). Hand-written expected values.
// ---------------------------------------------------------------------------

describe("M2C: tracking.overview money (DA-A-34 A.7 inverted, isClosedForAsk, claimCurrency, item-less claims)", () => {
  const NOW = Date.UTC(2026, 8, 23, 12);
  pinClockEach(NOW);
  type T = ReturnType<typeof setup>;

  async function purchaseWithItem(t: T, userId: Id<"users">, currency = "USD") {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 3 * 86_400_000, currency, status: "active",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
      return { purchaseId, itemId };
    });
  }
  let tokenSeq = 0;
  async function priceClaim(
    t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> },
    over: { status?: "detected" | "sent" | "confirmed" | "denied" | "dismissed"; expectedCents: number; currency?: string; nonCashResolvedAt?: number },
  ) {
    return await t.run((ctx) => ctx.db.insert("claims", {
      purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: over.expectedCents,
      status: over.status ?? "detected", token: `TRK${String(++tokenSeq).padStart(3, "0")}`, version: 1,
      ...(over.currency ? { currency: over.currency } : {}),
      ...(over.nonCashResolvedAt !== undefined ? { nonCashResolvedAt: over.nonCashResolvedAt } : {}),
    }));
  }
  async function credit(t: T, userId: Id<"users">, claimId: Id<"claims">, cents: number, kind: "confirmed_credit" | "later_debit" = "confirmed_credit") {
    await t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind, cents, evidence: "statement", idempotencyKey: `${claimId}:${kind}:${cents}`, currency: "USD" }));
  }

  it("A.7 inverted: confirmed 2,000 (credited) + a NEWER detected 1,000 on the same item → recovered 2,000, found 1,000", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    const c1 = await priceClaim(t, userId, w, { status: "confirmed", expectedCents: 2_000 });
    await credit(t, userId, c1, 2_000);
    const c2 = await priceClaim(t, userId, w, { expectedCents: 1_000 });
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(out.totals.byCurrency).toEqual({ USD: { foundCents: 1_000, recoveredCents: 2_000, exampleFoundCents: 0 } });
    expect([out.totals.foundCents, out.totals.recoveredCents]).toEqual([1_000, 2_000]);
    // The row still shows the newest claim (unchanged pick).
    expect(out.items[0].claim).toMatchObject({ claimId: c2, status: "detected", expectedCents: 1_000, unresolvedCents: 1_000 });
  });

  it("a later debit on the earlier claim reduces what it recovered (net, never below 0)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    const c1 = await priceClaim(t, userId, w, { status: "confirmed", expectedCents: 2_000 });
    await credit(t, userId, c1, 2_000);
    await credit(t, userId, c1, 500, "later_debit");
    await priceClaim(t, userId, w, { expectedCents: 1_000 });
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(usdOf(out)).toEqual({ foundCents: 1_000, recoveredCents: 1_500, exampleFoundCents: 0 });
  });

  it("isClosedForAsk: a DENIED claim's 3,000 is not found money; the row shows it as denied", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    const denied = await priceClaim(t, userId, w, { status: "denied", expectedCents: 3_000 });
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(out.totals.byCurrency).toEqual({ USD: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 } });
    expect(out.items[0].claim).toMatchObject({ claimId: denied, status: "denied", unresolvedCents: 3_000 });
  });

  it("isClosedForAsk: a claim resolved non-cash (voucher) is not found money either", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    await priceClaim(t, userId, w, { status: "sent", expectedCents: 4_000, nonCashResolvedAt: NOW - 1_000 });
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(usdOf(out).foundCents).toBe(0);
  });

  it("a dismissed claim contributes nothing and is not the row's claim (unchanged)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    const d = await priceClaim(t, userId, w, { status: "dismissed", expectedCents: 2_500 });
    await credit(t, userId, d, 1_000);
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(out.items[0].claim).toBeUndefined();
    expect(out.totals.byCurrency).toEqual({});
  });

  it("claimCurrency: a claim's own currency keys its money, not its purchase's", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId, "USD");
    await priceClaim(t, userId, w, { expectedCents: 700, currency: "EUR" });
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(out.totals.byCurrency).toEqual({ EUR: { foundCents: 700, recoveredCents: 0, exampleFoundCents: 0 } });
  });

  it("repro A.1 shape: an item-less scenario claim carrying the purchaseId is never a price row and never in the totals", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    await t.run((ctx) => ctx.db.insert("claims", {
      purchaseId: w.purchaseId, userId, type: "scenario", expectedCents: 60_000, status: "sent", token: "SCEN01", version: 1,
      currency: "USD", scenarioId: "R05", remedyKey: "refund", lossKeys: ["txn:x:paid"],
    }));
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].claim).toBeUndefined();
    expect(out.totals.byCurrency).toEqual({});
    expect(out.totals.foundCents).toBe(0);
  });

  it("an example claim on a real purchase is example money only (D27/D48)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchaseWithItem(t, userId);
    const c = await priceClaim(t, userId, w, { expectedCents: 900 });
    await t.run((ctx) => ctx.db.patch(c, { isExample: true }));
    const out = await as.query(api.tracking.overview, { now: NOW });
    expect(usdOf(out)).toEqual({ foundCents: 0, recoveredCents: 0, exampleFoundCents: 900 });
  });
});

describe("P06-OW-2 (QA-4): owned items carry a data-age signal", () => {
  const NOW = Date.UTC(2026, 8, 23, 12);
  const DAY = 86_400_000;
  pinClockEach(NOW);

  async function itemWithChecks(t: ReturnType<typeof setup>, userId: Id<"users">, checks: { at: number; cents?: number; note?: string }[]) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 30 * DAY, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p/j", returned: false });
      for (const c of checks) {
        await ctx.db.insert("priceChecks", {
          itemId, userId, observedAt: c.at, sourceUrl: "https://acme.example/p/j",
          ...(c.cents !== undefined ? { observedCents: c.cents, currency: "USD", confidence: 0.9, variantMatch: "exact" as const } : { note: c.note ?? "blocked" }),
        });
      }
      return { purchaseId, itemId };
    });
  }

  it("a 9,000 price read 20 days ago + a failed read an hour ago → priceStale, lastObservedAt 20 days ago, lastCheckedAt an hour ago", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId } = await itemWithChecks(t, userId, [{ at: NOW - 20 * DAY, cents: 9_000 }, { at: NOW - 3_600_000, note: "The product page could not be read" }]);
    const [item] = (await as.query(api.tracking.overview, { now: NOW })).items;
    expect(item).toMatchObject({ priceStale: true, lastObservedAt: NOW - 20 * DAY, lastCheckedAt: NOW - 3_600_000, dropCents: 3_000 });
    // purchases.get: the stale drop is not judged as today's (verdict unknown, age named).
    const got = await as.query(api.purchases.get, { purchaseId, now: NOW });
    expect(got.items[0]).toMatchObject({ priceStale: true, lastObservedAt: NOW - 20 * DAY });
    expect(got.items[0].verdict.label).toBe("unknown");
    expect(got.items[0].verdict.reason).toMatch(/20 days ago/);
  });

  it("a price read an hour ago → not stale; no price at all → stale", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await itemWithChecks(t, userId, [{ at: NOW - 3_600_000, cents: 9_000 }]);
    await itemWithChecks(t, userId, [{ at: NOW - 3_600_000, note: "blocked" }]);
    const items = (await as.query(api.tracking.overview, { now: NOW })).items;
    expect(items.map((i) => [i.priceStale, i.lastObservedAt ?? null])).toEqual(
      expect.arrayContaining([[false, NOW - 3_600_000], [true, null]]),
    );
  });
});

// ---------------------------------------------------------------------------
// C1 (D107, Opus checkpoint-5 recheck): MAX_ITEMS_TOTAL is now budgeted off
// rows actually read, purchase by purchase, instead of allotted up front per
// purchase before any of it is spent -- see tracking.ts's MAX_ITEMS_TOTAL doc
// comment for the bug this replaces (only the newest 5 of any account's
// purchases ever got items rendered at all, however small each one was).
// ---------------------------------------------------------------------------

async function seedPurchaseWithItems(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  itemCount: number,
  merchantDomain: string,
): Promise<Id<"purchases">> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: merchantDomain,
      merchantDomain,
      purchasedAt: Date.now() - 2 * 86_400_000,
      currency: "USD",
      status: "active",
    });
    for (let i = 0; i < itemCount; i++) {
      await ctx.db.insert("items", {
        purchaseId,
        userId,
        name: `Item ${i}`,
        unitCents: 1_000,
        qty: 1,
        productUrl: `https://${merchantDomain}/p/${i}`,
        returned: false,
      });
    }
    return purchaseId;
  });
}

describe("tracking.overview: C1/D107 budgeting by rows actually read", () => {
  it("6 purchases x 1 item each: every purchase gets its item, not just the newest 5", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseIds: Id<"purchases">[] = [];
    for (let p = 0; p < 6; p++) {
      purchaseIds.push(await seedPurchaseWithItems(t, userId, 1, `store${p}.example`));
    }

    const out = await as.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(6);
    expect(new Set(out.items.map((i) => i.purchaseId))).toEqual(new Set(purchaseIds));
    expect(out.truncated).toBe(false);
  });

  it("a purchase with exactly MAX_ITEMS_PER_PURCHASE (50) items is not truncated", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await seedPurchaseWithItems(t, userId, 50, "exactly50.example");

    const out = await as.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(50);
    expect(out.truncated).toBe(false);
  });

  it("a purchase with 51 items (one over the per-purchase cap) is truncated", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await seedPurchaseWithItems(t, userId, 51, "fiftyone.example");

    const out = await as.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D93/P07: 40 purchases x 50 items x 30 checks stays under the 32,000-document
// transaction limit and reports `truncated`. This is the exact shape
// docs/reviews/read-budgets.md measured overflowing at 62,040 documents read
// before this task's fix (an unbounded items-per-purchase `.collect()` plus
// an unbounded per-item claims `.collect()`); `setup()`/convex-test's
// positional form does not enforce `transactionLimits` at all (see
// readBudget.test.ts's file header), so this rebuilds the options-object
// harness locally rather than silently measuring nothing.
// ---------------------------------------------------------------------------

const modules = import.meta.glob("./**/*.*s");
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

function limitedHarness() {
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

describe("tracking.overview: read budget at 40 purchases x 50 items x 30 checks (D93)", () => {
  // D138/M04: both tests pass `now: NOW` to `api.tracking.overview`, which
  // validates it against the server clock (`watches.assertCoarseNow`, +/-24 h).
  // With the real clock this fixed NOW was a calendar time-bomb: green on
  // 2026-09-21, red from 2026-09-22. Pin the clock to NOW. Date only (not
  // timers), as readBudget.test.ts/dashboard.test.ts do: fully-faked timers
  // starve the nested `ctx.runQuery` these tests measure inside `t.run`.
  const NOW = Date.UTC(2026, 8, 21, 12);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it(
    "does not overflow the 32,000-document transaction limit and reports truncated",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy" }));
      const as = t.withIdentity({ subject: `${userId}|session` });
      const DAY = 86_400_000;
      const HOUR = 3_600_000;
      const PURCHASES = 40;
      // One over MAX_ITEMS_PER_PURCHASE (50) so the per-purchase item cap
      // actually bites and `truncated` is observably true, while still being
      // the "40x50x30" shape read-budgets.md measured overflowing at.
      const ITEMS_PER_PURCHASE = 51;
      const CHECKS_PER_ITEM = 30;

      for (let p = 0; p < PURCHASES; p++) {
        await t.run(async (ctx) => {
          const merchantDomain = `store${p}.example`;
          const purchaseId = await ctx.db.insert("purchases", {
            userId,
            merchant: `Store ${p}`,
            merchantDomain,
            purchasedAt: NOW - 10 * DAY,
            currency: "USD",
            status: "active",
          });
          for (let i = 0; i < ITEMS_PER_PURCHASE; i++) {
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
            for (let c = 0; c < CHECKS_PER_ITEM; c++) {
              await ctx.db.insert("priceChecks", {
                itemId,
                userId,
                observedCents: 4_500 + c,
                currency: "USD",
                observedAt: NOW - (CHECKS_PER_ITEM - c) * HOUR,
                sourceUrl: productUrl,
              });
            }
          }
        });
      }

      const { result, errorMessage, metrics } = await as.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof api.tracking.overview>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(api.tracking.overview, { now: NOW });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const metrics = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics };
      });

      // eslint-disable-next-line no-console
      console.log(
        "[read-budget] tracking.overview (40x50x30)",
        JSON.stringify({ documentsRead: metrics.documentsRead.used, errorMessage }),
      );
      expect(errorMessage).toBeNull();
      expect(result).toBeDefined();
      // F3 (D103): MAX_ITEMS_TOTAL (250) now bounds the grand total across
      // every purchase, not just each purchase's own 50 -- 40 purchases x 51
      // items would otherwise be 2,000+ items; `truncated` (below) says so.
      expect(result!.items).toHaveLength(250);
      expect(result!.truncated).toBe(true);
      expect(metrics.documentsRead.used).toBeLessThan(32_000);
      // F3 (D103): the actual failure this shape reproduced was Convex's
      // SEPARATE "Too many index ranges read (4096)" limit (`databaseQueries`),
      // not the document-count one above -- see tracking.ts's MAX_POINTS doc
      // comment for why documentsRead alone was never the real constraint.
      expect(metrics.databaseQueries.used).toBeLessThan(4_096);
    },
    150_000,
  );

  // The literal shape D103's F3 finding reproduced the crash at.
  it(
    "60 purchases x 50 items x 12 checks does not throw 'Too many index ranges read (4096)' (F3, D103)",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy" }));
      const as = t.withIdentity({ subject: `${userId}|session` });
      const DAY = 86_400_000;
      const HOUR = 3_600_000;
      const PURCHASES = 60;
      const ITEMS_PER_PURCHASE = 50;
      const CHECKS_PER_ITEM = 12;

      for (let p = 0; p < PURCHASES; p++) {
        await t.run(async (ctx) => {
          const merchantDomain = `f3store${p}.example`;
          const purchaseId = await ctx.db.insert("purchases", {
            userId,
            merchant: `Store ${p}`,
            merchantDomain,
            purchasedAt: NOW - 10 * DAY,
            currency: "USD",
            status: "active",
          });
          for (let i = 0; i < ITEMS_PER_PURCHASE; i++) {
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
            for (let c = 0; c < CHECKS_PER_ITEM; c++) {
              await ctx.db.insert("priceChecks", {
                itemId,
                userId,
                observedCents: 4_500 + c,
                currency: "USD",
                observedAt: NOW - (CHECKS_PER_ITEM - c) * HOUR,
                sourceUrl: productUrl,
              });
            }
          }
        });
      }

      const { result, errorMessage, metrics } = await as.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof api.tracking.overview>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(api.tracking.overview, { now: NOW });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const metrics = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics };
      });

      // eslint-disable-next-line no-console
      console.log(
        "[read-budget] tracking.overview (60x50x12, F3)",
        JSON.stringify({
          documentsRead: metrics.documentsRead.used,
          databaseQueries: metrics.databaseQueries.used,
          errorMessage,
        }),
      );
      expect(errorMessage).toBeNull();
      expect(result).toBeDefined();
      expect(result!.truncated).toBe(true); // 3,000 items total, capped at MAX_ITEMS_TOTAL (250)
      expect(metrics.documentsRead.used).toBeLessThan(32_000);
      expect(metrics.databaseQueries.used).toBeLessThan(4_096);
    },
    150_000,
  );
});

describe("tracking.overview: M2C claim budget measured at the caps", () => {
  const NOW = Date.UTC(2026, 8, 23, 12);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it(
    "6 purchases x 50 items x 12 checks x 4 price claims (3 credited) → no error, truncated, bounded ranges and documents",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy claims" }));
      const as = t.withIdentity({ subject: `${userId}|session` });
      const DAY = 86_400_000;
      const HOUR = 3_600_000;
      // MAX_ITEMS_TOTAL (250) cuts at the 6th purchase; MAX_CLAIMS_PER_PURCHASE (200) is exactly 50 x 4, and the
      // shared MAX_CLAIM_BALANCES_TOTAL (1,000) is spent by the first five purchases.
      for (let p = 0; p < 6; p++) {
        await t.run(async (ctx) => {
          const merchantDomain = `claims${p}.example`;
          const purchaseId = await ctx.db.insert("purchases", {
            userId, merchant: `Store ${p}`, merchantDomain, purchasedAt: NOW - 10 * DAY, currency: "USD", status: "active",
          });
          for (let i = 0; i < 50; i++) {
            const productUrl = `https://${merchantDomain}/p/${i}`;
            const itemId = await ctx.db.insert("items", { purchaseId, userId, name: `Item ${p}-${i}`, unitCents: 5_000, qty: 1, productUrl, returned: false });
            for (let c = 0; c < 12; c++) {
              await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 4_500 + c, currency: "USD", observedAt: NOW - (12 - c) * HOUR, sourceUrl: productUrl });
            }
            for (let k = 0; k < 4; k++) {
              const claimId = await ctx.db.insert("claims", {
                purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 100, status: k < 3 ? "confirmed" : "detected",
                token: `H${p}-${i}-${k}`, version: 1,
              });
              if (k < 3) await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "confirmed_credit", cents: 100, evidence: "stmt", currency: "USD" });
            }
          }
        });
      }

      const { result, errorMessage, metrics } = await as.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof api.tracking.overview>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(api.tracking.overview, { now: NOW });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const metrics = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics };
      });
      // eslint-disable-next-line no-console
      console.log(
        "[read-budget] tracking.overview M2C claims (6x50x12x4)",
        JSON.stringify({ documentsRead: metrics.documentsRead.used, databaseQueries: metrics.databaseQueries.used, bytesRead: metrics.bytesRead.used, errorMessage }),
      );
      expect(errorMessage).toBeNull();
      expect(result!.truncated).toBe(true);
      expect(result!.items).toHaveLength(250);
      // 250 items x 3 credited claims x 100, hand-computed: every earlier confirmed claim counts (A.7), found 250 x 100.
      expect(usdOf(result!)).toEqual({ foundCents: 25_000, recoveredCents: 75_000, exampleFoundCents: 0 });
      expect(metrics.documentsRead.used).toBeLessThan(32_000);
      expect(metrics.databaseQueries.used).toBeLessThan(4_096);
    },
    150_000,
  );
});
