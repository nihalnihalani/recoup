/// <reference types="vite/client" />
/**
 * Read budget of the fact reads (lead request on the M11 index delta, `facts.by_transaction_and_state_and_subject_key_and_key`).
 *
 * Superseded history is unbounded by design (DA-A-36: a correction is always accepted), so no fact read may scan it.
 * Fixture: ONE cell with 5,000 superseded rows and 1 live row. Under `transactionLimits: true` (enforcing convex-test
 * harness — `setup()` in test.setup.ts cannot pass that option, see readBudget.test.ts) we measure
 * `ctx.meta.getTransactionMetrics().documentsRead` around each read and require a small CONSTANT, independent of the
 * 5,000 superseded rows: the cell read, putFact's current-rows read inside a correction, and the public live listing.
 */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import schema from "./schema";
import { putFact, readCellRows, readLiveFacts } from "./lib/facts/write";

const modules = import.meta.glob("./**/*.*s");
const SUPERSEDED = 5_000;
/** Each fixture seeds 5,000 rows (~0.3 s locally, slower under the full CI suite): explicit 30 s instead of vitest's 5 s. */
const HEAVY_TEST_TIMEOUT_MS = 30_000;

async function fixture() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Budget" }));
  const as = t.withIdentity({ subject: `${userId}|session` });
  const { transactionId, item } = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Northwind", merchantDomain: "northwind.example", currency: "USD", status: "active", purchasedAt: Date.now() - 86_400_000,
    });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Sweater", unitCents: 8000, qty: 1, returned: false });
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "retail_order", status: "active", counterpartyName: "Northwind", currency: "USD", purchaseId, liveFactCount: 1,
    });
    return { transactionId, item: `item:${itemId}` };
  });
  // 5,000 superseded corrections of one cell, then its one live row (seeded directly: the read is what is measured).
  for (let chunk = 0; chunk < SUPERSEDED / 1_000; chunk++) {
    await t.run(async (ctx) => {
      for (let i = 0; i < 1_000; i++) {
        await ctx.db.insert("facts", {
          userId, transactionId, subjectKey: item, key: "retail.unit_price", state: "superseded",
          value: { kind: "money", amountMinor: 10_000 + chunk * 1_000 + i, currency: "USD" }, source: { kind: "user" }, recordedAt: Date.now(),
        });
      }
    });
  }
  await t.run((ctx) =>
    ctx.db.insert("facts", {
      userId, transactionId, subjectKey: item, key: "retail.unit_price", state: "user_confirmed",
      value: { kind: "money", amountMinor: 7_900, currency: "USD" }, source: { kind: "user" }, recordedAt: Date.now(),
    }),
  );
  return { t, as, userId, transactionId, item };
}

async function documentsRead(ctx: MutationCtx, fn: () => Promise<unknown>): Promise<number> {
  const before = (await ctx.meta.getTransactionMetrics()).documentsRead.used;
  await fn();
  return (await ctx.meta.getTransactionMetrics()).documentsRead.used - before;
}

describe(`fact reads never scan superseded history (1 live row + ${SUPERSEDED} superseded in one cell)`, () => {
  it("readCellRows and readLiveFacts read only the live row", async () => {
    const { t, transactionId, item } = await fixture();
    const [cell, live, rows] = await t.run(async (ctx) => {
      let rows = 0;
      const cell = await documentsRead(ctx, async () => { rows += (await readCellRows(ctx, transactionId, item, "retail.unit_price")).length; });
      const live = await documentsRead(ctx, async () => { rows += (await readLiveFacts(ctx, transactionId)).length; });
      return [cell, live, rows];
    });
    expect(rows).toBe(2);
    expect(cell).toBeLessThanOrEqual(2);
    expect(live).toBeLessThanOrEqual(2);
  }, HEAVY_TEST_TIMEOUT_MS);

  it("a correction through putFact reads a small constant number of documents", async () => {
    const { t, userId, transactionId, item } = await fixture();
    const read = await t.run((ctx) =>
      documentsRead(ctx, () =>
        putFact(ctx, userId, {
          transactionId, subjectKey: item, key: "retail.unit_price", state: "user_confirmed",
          value: { kind: "money", amountMinor: 7_800, currency: "USD" }, source: { kind: "user" },
        }),
      ),
    );
    // accountState (tombstone) + transaction + item + the live row (+ its re-read on patch) — never the 5,000.
    expect(read).toBeLessThanOrEqual(10);
  }, HEAVY_TEST_TIMEOUT_MS);

  it("the public live listing (facts.list) stays within a small constant", async () => {
    const { as, transactionId } = await fixture();
    const read = await as.run((ctx) =>
      documentsRead(ctx, () => ctx.runQuery(api.facts.list, { transactionId })),
    );
    // accountState + transaction + purchase + 1 item + its price checks (none) + the live row.
    expect(read).toBeLessThanOrEqual(10);
  }, HEAVY_TEST_TIMEOUT_MS);
});
