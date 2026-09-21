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
      // MAX_ITEMS_PER_PURCHASE (50) caps each purchase's items, so 1 of each
      // purchase's 51 is left out -- exactly what `truncated` reports below.
      expect(result!.items).toHaveLength(PURCHASES * 50);
      expect(result!.truncated).toBe(true);
      expect(metrics.documentsRead.used).toBeLessThan(32_000);
    },
    150_000,
  );
});
