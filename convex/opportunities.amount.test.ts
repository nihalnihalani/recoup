/// <reference types="vite/client" />
/**
 * DA-B-2 (checkpoint B, B4), projection half: when a LINKED claim asks more than the re-evaluated exact_formula
 * estimate, the opportunity's evaluation says `review_amount` (claim amount, estimate, currency) instead of
 * `continue_case`, so the card prompts "adjust or acknowledge" before anything is sent. The comparison is M13b's one
 * shared predicate (`lib/amountReview.amountExceedsEstimate`), the same one `drafts.prepareSend` uses.
 * R01 v1 is forced active through the test-registry seam (C3).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluatePurchase } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";

const NOW = Date.UTC(2026, 8, 20, 14);
type T = ReturnType<typeof setup>;

async function world(t: T) {
  const { userId, as } = await signedIn(t);
  const w = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * 86_400_000, currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 2, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - 1_000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * 86_400_000, confidence: 0.9, confirmedByUser: true });
    await ensurePurchaseTransaction(ctx, purchaseId);
    await evaluatePurchase(ctx, purchaseId, "user_request", NOW);
    return { purchaseId, itemId };
  });
  const [opp] = await t.run((ctx) => ctx.db.query("opportunities").collect());
  const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
  if (!opened.ok) throw new Error(opened.message);
  return { as, ...w, opportunityId: opp._id as Id<"opportunities">, claimId: opened.claimId };
}

async function currentNextAction(t: T, opportunityId: Id<"opportunities">) {
  const opp = (await t.run((ctx) => ctx.db.get(opportunityId)))!;
  return (await t.run((ctx) => ctx.db.get(opp.currentEvaluationId!)))!.nextAction;
}

describe("DA-B-2: review_amount when the claim asks more than the re-evaluated estimate", () => {
  pinClockEach(NOW);

  it("qty 2 → 1 on an open 5,000 claim → review_amount {5,000 asked, 2,500 estimate, USD}; adjusting to 2,500 → continue_case", async () => {
    const t = setup();
    const { as, purchaseId, itemId, opportunityId, claimId } = await world(t);
    expect(await currentNextAction(t, opportunityId)).toEqual({ kind: "continue_case", claimId });
    await t.run(async (ctx) => {
      await ctx.db.patch(itemId, { qty: 1 });
      await evaluatePurchase(ctx, purchaseId, "fact_change", NOW);
    });
    expect(await currentNextAction(t, opportunityId)).toEqual({ kind: "review_amount", claimId, claimedMinor: 5_000, estimateMinor: 2_500, currency: "USD" });
    await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 2_500, reason: "Quantity corrected to 1" });
    await t.run(async (ctx) => {
      await evaluatePurchase(ctx, purchaseId, "fact_change", NOW);
    });
    expect(await currentNextAction(t, opportunityId)).toEqual({ kind: "continue_case", claimId });
  });

  it("a claim asking exactly the estimate (or less) keeps continue_case", async () => {
    const t = setup();
    const { as, purchaseId, opportunityId, claimId } = await world(t);
    await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 4_000, reason: "asked a little less" });
    await t.run(async (ctx) => {
      await evaluatePurchase(ctx, purchaseId, "fact_change", NOW);
    });
    expect(await currentNextAction(t, opportunityId)).toEqual({ kind: "continue_case", claimId });
  });

  it("never across currencies: a EUR claim over a USD estimate keeps continue_case", async () => {
    const t = setup();
    const { purchaseId, itemId, opportunityId, claimId } = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(claimId, { currency: "EUR" });
      await ctx.db.patch(itemId, { qty: 1 });
      await evaluatePurchase(ctx, purchaseId, "fact_change", NOW);
    });
    expect(await currentNextAction(t, opportunityId)).toEqual({ kind: "continue_case", claimId });
  });
});
