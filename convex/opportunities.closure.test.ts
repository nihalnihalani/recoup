/// <reference types="vite/client" />
/**
 * DA-B-7 (checkpoint B): when a claim is dismissed or confirmed, its opportunity reflects the closure AT ONCE, in the
 * same mutation — not at the next evaluation, which may never come once the item's window has closed.
 * `claims.dismiss` → the opportunity is `open` with no `activeClaimId`; a confirmed credit that settles the claim →
 * `closed`. R01 v1 is forced active through the test-registry seam (C3), as elsewhere.
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

async function openCaseWorld(t: T) {
  const { userId, as } = await signedIn(t);
  const w = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * 86_400_000, currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - 1_000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * 86_400_000, confidence: 0.9, confirmedByUser: true });
    await ensurePurchaseTransaction(ctx, purchaseId);
    await evaluatePurchase(ctx, purchaseId, "user_request", NOW);
    return { purchaseId, itemId };
  });
  const [opp] = await t.run((ctx) => ctx.db.query("opportunities").collect());
  const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
  if (!opened.ok) throw new Error(opened.message);
  return { as, w, opportunityId: opp._id as Id<"opportunities">, claimId: opened.claimId };
}

const oppOf = (t: T, id: Id<"opportunities">) => t.run((ctx) => ctx.db.get(id));

describe("DA-B-7: claim closure reaches the opportunity in the same mutation", () => {
  pinClockEach(NOW);

  it("dismiss → the opportunity is open with no activeClaimId at once (no evaluation in between)", async () => {
    const t = setup();
    const { as, opportunityId, claimId } = await openCaseWorld(t);
    expect(await oppOf(t, opportunityId)).toMatchObject({ status: "case_open", activeClaimId: claimId });
    await as.mutation(api.claims.dismiss, { claimId });
    const opp = (await oppOf(t, opportunityId))!;
    expect(opp.status).toBe("open");
    expect(opp.activeClaimId).toBeUndefined();
  });

  it("a confirmed credit that settles the claim → the opportunity is closed at once", async () => {
    const t = setup();
    const { as, opportunityId, claimId } = await openCaseWorld(t);
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 2_500, evidence: "Adjustment posted", idempotencyKey: "full" });
    const opp = (await oppOf(t, opportunityId))!;
    expect(opp.status).toBe("closed");
    expect(opp.activeClaimId).toBeUndefined();
  });

  it("a partial credit (claim still open) leaves the case open", async () => {
    const t = setup();
    const { as, opportunityId, claimId } = await openCaseWorld(t);
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1_000, evidence: "Partial", idempotencyKey: "part" });
    expect(await oppOf(t, opportunityId)).toMatchObject({ status: "case_open", activeClaimId: claimId });
  });

  it("an unlinked (legacy) claim's dismissal touches no opportunity", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Mug", unitCents: 1_000, qty: 1, returned: true });
      return await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "return_credit", expectedCents: 1_000, status: "detected", token: "UNLNK1", version: 1 });
    });
    await as.mutation(api.claims.dismiss, { claimId });
    expect(await t.run((ctx) => ctx.db.query("opportunities").collect())).toEqual([]);
  });
});
