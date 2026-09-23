/**
 * M2C (wave 2) — `purchases.board` (DA-A-12, D145, D241). The board is the retail item board:
 *   - repro A.1 inverted: an item-less `scenario` claim that carries the purchase's id is neither a row nor money;
 *   - `totalsByCurrency`: the board's money per currency (the claim's own, else its purchase's), never summed across
 *     currencies; `owed`/`asked` count only claims still open for ask (`isClosedForAsk`);
 *   - the legacy `totals` keep their formula (D39; `purchases.test.ts:387–407` stays unmodified).
 * Expected values are hand-written.
 */
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

type T = ReturnType<typeof setup>;

async function purchase(t: T, userId: Id<"users">, currency = "USD") {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: `${currency} Store`, merchantDomain: `${currency.toLowerCase()}.example`, currency, status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
    return { purchaseId, itemId };
  });
}
let seq = 0;
async function claim(
  t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> },
  o: { status: "detected" | "sent" | "promised" | "confirmed" | "denied"; expectedCents: number; currency?: string; nonCashResolvedAt?: number },
) {
  return await t.run((ctx) => ctx.db.insert("claims", {
    purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: o.expectedCents, status: o.status,
    token: `BRD${String(++seq).padStart(3, "0")}`, version: 1,
    ...(o.currency ? { currency: o.currency } : {}), ...(o.nonCashResolvedAt !== undefined ? { nonCashResolvedAt: o.nonCashResolvedAt } : {}),
  }));
}

describe("M2C: purchases.board", () => {
  it("repro A.1 inverted: an item-less scenario claim with the purchase's id (60,000 sent) is not owed, not asked, not a row", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchase(t, userId);
    await t.run((ctx) => ctx.db.insert("claims", {
      purchaseId: w.purchaseId, userId, type: "scenario", expectedCents: 60_000, status: "sent", token: "A1SCEN", version: 1,
      currency: "USD", scenarioId: "R05", remedyKey: "refund", lossKeys: ["txn:x:paid"],
    }));
    const board = await as.query(api.purchases.board, {});
    expect(board.totals).toEqual({ owed: 0, asked: 0, confirmed: 0 });
    expect(board.totalsByCurrency).toEqual({});
    expect(board.purchases).toHaveLength(1);
    expect(board.purchases[0].claims).toEqual([]);
  });

  it("per currency: USD and EUR are separate entries; the legacy totals keep summing (unrendered, D39)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const usd = await purchase(t, userId, "USD");
    const eur = await purchase(t, userId, "EUR");
    await claim(t, userId, usd, { status: "sent", expectedCents: 5_000 });
    await claim(t, userId, eur, { status: "detected", expectedCents: 1_000 });
    const board = await as.query(api.purchases.board, {});
    expect(board.totalsByCurrency).toEqual({
      USD: { owed: 5_000, asked: 5_000, confirmed: 0 },
      EUR: { owed: 1_000, asked: 0, confirmed: 0 },
    });
    expect(board.totals).toEqual({ owed: 6_000, asked: 5_000, confirmed: 0 });
  });

  it("a claim's own currency keys its entry (claimCurrency), not its purchase's", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchase(t, userId, "USD");
    await claim(t, userId, w, { status: "sent", expectedCents: 700, currency: "GBP" });
    expect((await as.query(api.purchases.board, {})).totalsByCurrency).toEqual({ GBP: { owed: 700, asked: 700, confirmed: 0 } });
  });

  it("closed for ask: a denied 3,000 and a voucher-resolved 2,000 are not owed per currency; the legacy totals are untouched", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchase(t, userId);
    await claim(t, userId, w, { status: "denied", expectedCents: 3_000 });
    await claim(t, userId, w, { status: "sent", expectedCents: 2_000, nonCashResolvedAt: Date.UTC(2026, 8, 20) });
    const board = await as.query(api.purchases.board, {});
    expect(board.totalsByCurrency).toEqual({ USD: { owed: 0, asked: 0, confirmed: 0 } });
    expect(board.totals).toEqual({ owed: 5_000, asked: 2_000, confirmed: 0 }); // legacy formula (D145: untouched)
  });

  it("wave-1 statuses in one currency: the per-currency entry equals the legacy totals (net recovered, clamped, D39)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await purchase(t, userId);
    const paid = await claim(t, userId, w, { status: "confirmed", expectedCents: 4_000 });
    await t.run(async (ctx) => {
      await ctx.db.insert("ledgerEvents", { claimId: paid, userId, kind: "confirmed_credit", cents: 5_000, evidence: "stmt", idempotencyKey: "c1" });
      await ctx.db.insert("ledgerEvents", { claimId: paid, userId, kind: "later_debit", cents: 500, evidence: "clawback", idempotencyKey: "d1" });
    });
    await claim(t, userId, w, { status: "promised", expectedCents: 1_500 });
    const board = await as.query(api.purchases.board, {});
    // confirmed 5,000 − debited 500 = 4,500, clamped to expected 4,000; the promised 1,500 is owed and asked.
    expect(board.totals).toEqual({ owed: 1_500, asked: 1_500, confirmed: 4_000 });
    expect(board.totalsByCurrency).toEqual({ USD: board.totals });
  });
});
