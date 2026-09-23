/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn, fakeSchedulerTimersEach } from "./test.setup";
import { openClaim } from "./claims";

// D247 (KX3): a job this file's code schedules never runs on a real timer in the background; tests flush it.
fakeSchedulerTimersEach();

// purchases.confirm gains `currency` (contract §7, DA-A-33): validated; a CHANGE is refused once any claim exists on
// the purchase; an explicit currency is recorded as a `retail.currency` user_confirmed fact. purchases.test.ts is
// untouched (contract §8) — these cases live here.

type T = ReturnType<typeof setup>;

async function needsReview(t: T, currency = "USD") {
  const { as, userId } = await signedIn(t);
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Halden Audio", merchantDomain: "haldenaudio.example", currency, status: "needs_review",
    items: [{ name: "Headphones", unitCents: 19900, qty: 1 }],
  });
  const itemId = await t.run(async (ctx) => (await ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).first())!._id);
  const confirmArgs = (extra: { currency?: string } = {}) => ({
    purchaseId, merchant: "Halden Audio", merchantDomain: "haldenaudio.example", purchasedAt: Date.now() - 86_400_000,
    items: [{ itemId, name: "Headphones", unitCents: 19900, qty: 1 }], ...extra,
  });
  return { as, userId, purchaseId, itemId, confirmArgs };
}

async function state(t: T, purchaseId: Id<"purchases">) {
  return t.run(async (ctx) => {
    const purchase = (await ctx.db.get(purchaseId))!;
    const txn = (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).unique())!;
    const facts = await ctx.db
      .query("facts")
      .withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", txn._id).eq("subjectKey", "txn").eq("key", "retail.currency"))
      .collect();
    return { purchase, txn, facts };
  });
}

async function currencyCell(as: Awaited<ReturnType<typeof needsReview>>["as"], txnId: Id<"transactions">) {
  const cells = await as.query(api.facts.list, { transactionId: txnId });
  return cells.find((c) => c.subjectKey === "txn" && c.key === "retail.currency");
}

describe("purchases.confirm currency (DA-A-33)", () => {
  it("without a currency: nothing is recorded and the currency stays an assumption (candidate)", async () => {
    const t = setup();
    const p = await needsReview(t);
    await p.as.mutation(api.purchases.confirm, p.confirmArgs());
    const s = await state(t, p.purchaseId);
    expect(s.purchase.currency).toBe("USD");
    expect(s.facts).toHaveLength(0);
    expect(await currencyCell(p.as, s.txn._id)).toMatchObject({ status: "candidate", value: { kind: "code", code: "USD" }, capsOutcomeAt: "likely_eligible" });
  });

  it("with a currency: the purchase and its transaction take it and a retail.currency confirmation is recorded", async () => {
    const t = setup();
    const p = await needsReview(t);
    await p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency: "EUR" }));
    const s = await state(t, p.purchaseId);
    expect(s.purchase.currency).toBe("EUR");
    expect(s.txn.currency).toBe("EUR");
    expect(s.facts).toHaveLength(1);
    expect(s.facts[0]).toMatchObject({ state: "user_confirmed", value: { kind: "code", code: "EUR" }, source: { kind: "user" }, userId: p.userId });
    expect(await currencyCell(p.as, s.txn._id)).toMatchObject({ status: "confirmed", value: { kind: "code", code: "EUR" } });
  });

  it("confirming the same currency again writes nothing new", async () => {
    const t = setup();
    const p = await needsReview(t);
    await p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency: "USD" }));
    await p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency: "USD" }));
    expect((await state(t, p.purchaseId)).facts).toHaveLength(1);
  });

  it("refuses a malformed or unknown currency, and writes nothing", async () => {
    const t = setup();
    const p = await needsReview(t);
    for (const currency of ["usd", "US", "ZZZ", ""]) {
      await expect(p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency }))).rejects.toThrow(/currency/);
    }
    const s = await state(t, p.purchaseId);
    expect(s.purchase.status).toBe("needs_review");
    expect(s.facts).toHaveLength(0);
  });

  for (const status of ["detected", "confirmed", "dismissed"] as const) {
    it(`refuses a currency CHANGE once a ${status} claim exists on the purchase; nothing changes`, async () => {
      const t = setup();
      const p = await needsReview(t);
      await p.as.mutation(api.purchases.confirm, p.confirmArgs());
      await t.run(async (ctx) => {
        const claimId = await openClaim(ctx, {
          userId: p.userId, purchaseId: p.purchaseId, itemId: p.itemId, type: "price_adjustment", expectedCents: 2000,
          windowEndsAt: Date.now() + 86_400_000,
        });
        if (status !== "detected") await ctx.db.patch(claimId, { status });
      });
      await expect(p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency: "EUR" }))).rejects.toThrow(/claim/);
      const s = await state(t, p.purchaseId);
      expect(s.purchase.currency).toBe("USD");
      expect(s.txn.currency).toBe("USD");
      expect(s.facts).toHaveLength(0);
    });
  }

  it("confirming the SAME currency is allowed while a claim exists, and records the confirmation", async () => {
    const t = setup();
    const p = await needsReview(t);
    await p.as.mutation(api.purchases.confirm, p.confirmArgs());
    await t.run((ctx) =>
      openClaim(ctx, { userId: p.userId, purchaseId: p.purchaseId, itemId: p.itemId, type: "price_adjustment", expectedCents: 2000, windowEndsAt: Date.now() + 86_400_000 }),
    );
    await p.as.mutation(api.purchases.confirm, p.confirmArgs({ currency: "USD" }));
    const s = await state(t, p.purchaseId);
    expect(s.facts).toHaveLength(1);
    expect(await currencyCell(p.as, s.txn._id)).toMatchObject({ status: "confirmed" });
  });
});
