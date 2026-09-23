/// <reference types="vite/client" />
/**
 * D247 (DA E3 re-check): no claim on facts the user never confirmed — the legacy D25 invariant ("no claim on a
 * needs_review purchase") held by `opportunities.openCase` itself, through the PRODUCTION registry (R01 v1 active).
 * The DA's route to P7: an unconfirmed purchase with an accepted price check → likely_eligible → the public openCase.
 * Now: openCase refuses (`unconfirmed_facts`, "confirm first"), nothing is written, and the estimate is not Potential;
 * an active (confirmed) purchase is unaffected. Also: the stored missing facts are unique (the DA's low note).
 */
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluatePurchase, hasUnconfirmedDecisive } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";
import { REGISTRY_KIND } from "./lib/rules/registry";

const NOW = Date.UTC(2026, 8, 20, 14);
const DAY = 86_400_000;
type T = ReturnType<typeof setup>;

async function world(t: T, status: "needs_review" | "active") {
  const { userId, as } = await signedIn(t);
  const w = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency: "USD", status });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.95, variantMatch: "exact", observedAt: NOW - 1_000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", {
      userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p",
      sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * DAY, confidence: 0.9, confirmedByUser: true,
    });
    await ensurePurchaseTransaction(ctx, purchaseId);
    await evaluatePurchase(ctx, purchaseId, "user_request", NOW);
    const opp = (await ctx.db.query("opportunities").collect())[0];
    const ev = (await ctx.db.get(opp.currentEvaluationId!))!;
    return { purchaseId, opportunityId: opp._id as Id<"opportunities">, opp, missing: ev.missingFacts };
  });
  return { userId, as, ...w };
}
const potential = async (as: Awaited<ReturnType<typeof signedIn>>["as"]) =>
  (await as.query(api.recovery.summary, { now: NOW })).currencies.find((c) => c.currency === "USD")?.tiles.potential.amountMinor ?? 0;

describe("D247: openCase never opens on unconfirmed facts; unconfirmed estimates are not Potential", () => {
  pinClockEach(NOW);

  it("production registry", () => expect(REGISTRY_KIND).toBe("production"));

  it("the DA's P7 steps 1–2: needs_review → likely_eligible → openCase refused, nothing written, not Potential", async () => {
    const t = setup();
    const w = await world(t, "needs_review");
    expect(w.opp).toMatchObject({ outcome: "likely_eligible", estimate: { amountMinor: 2_500, currency: "USD" }, decisiveUnconfirmed: true });
    const res = await w.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId });
    expect(res).toMatchObject({ ok: false, code: "unconfirmed_facts" });
    if (res.ok) throw new Error("opened");
    expect(res.message).toMatch(/Confirm/);
    expect(await t.run((ctx) => ctx.db.query("claims").collect())).toEqual([]);
    expect(await potential(w.as)).toBe(0);
  });

  it("the R01 purchase gate holds on its own: an unconfirmed purchase is refused even with no candidate listed", async () => {
    const t = setup();
    const w = await world(t, "needs_review");
    // Simulate a result with no candidate listed (as if every cell were confirmed) — the purchase status still refuses.
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = (await ctx.db.get(w.opp.currentEvaluationId!))!;
      void _id;
      void _creationTime;
      await ctx.db.patch(w.opp.currentEvaluationId!, { ...rest, missingFacts: [] });
    });
    const res = await w.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId });
    expect(res).toMatchObject({ ok: false, code: "unconfirmed_facts" });
  });

  it("an active (confirmed) purchase is unaffected: Potential 2,500, then openCase opens the claim", async () => {
    const t = setup();
    const w = await world(t, "active");
    expect(w.opp.decisiveUnconfirmed).toBeUndefined();
    expect(await potential(w.as)).toBe(2_500);
    const res = await w.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId });
    expect(res).toMatchObject({ ok: true, created: true });
  });

  it("the stored missing facts are unique per (subject, key, reason) — the candidate purchase date is listed once", async () => {
    const t = setup();
    const w = await world(t, "needs_review");
    const ids = w.missing.map((m) => `${m.subjectKey}|${m.key}|${m.reason}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((i) => i.endsWith("retail.purchase_date|candidate_unconfirmed"))).toHaveLength(1);
    expect(hasUnconfirmedDecisive({ missingFacts: w.missing })).toBe(true);
    expect(hasUnconfirmedDecisive({ missingFacts: [] })).toBe(false);
  });
});
