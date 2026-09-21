import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
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
  it(
    "does not overflow the 32,000-document transaction limit and reports truncated",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy" }));
      const as = t.withIdentity({ subject: `${userId}|session` });
      const NOW = Date.UTC(2026, 8, 21, 12);
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
      const NOW = Date.UTC(2026, 8, 21, 12);
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
