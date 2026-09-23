/// <reference types="vite/client" />
/**
 * E3 (D234(1), D243): no R01 v1 negative verdict rests on an unconfirmed candidate — through the PRODUCTION registry
 * (activation.ts, R01 v1 active) and the real path: `priceWatch.checkNow` used to accept an item of a needs_review
 * (unconfirmed) purchase (refused since M2C, D243); a check that still lands in `recordCheck` stores an accepted price
 * check and evaluates R01 with the purchase's extracted-candidate unit price, quantity and date.
 *   P1 — candidate unit/qty, drop below the threshold: was not_eligible, now needs_facts.
 *   P5 — two differing unit-price candidates, both below the threshold (5c "same answer"): was not_eligible, now
 *        needs_facts (5b — the user says which value is right).
 * Pin: an accepted check on a needs_review purchase never yields a negative R01 verdict, whatever the drop.
 */
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { activePack, REGISTRY_KIND } from "./lib/rules/registry";
import { CONFIRM_BEFORE_CHECK } from "./priceWatch";

const NOW = Date.UTC(2026, 8, 20, 14);
const DAY = 86_400_000;
const NEGATIVE: ReadonlySet<string> = new Set(["not_eligible", "deadline_passed", "not_yet_due", "manual_review"]);
type T = ReturnType<typeof setup>;

async function unconfirmedPurchase(t: T, o: { unit: number; secondUnitCandidate?: number }) {
  const { userId, as } = await signedIn(t);
  const w = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency: "USD", status: "needs_review",
    });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: o.unit, qty: 1, productUrl: "https://acme.example/p/jacket", returned: false });
    await ctx.db.insert("policies", {
      userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p",
      sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * DAY, confidence: 0.9, confirmedByUser: true,
    });
    return { purchaseId, itemId };
  });
  if (o.secondUnitCandidate !== undefined) {
    // Intake (or M23 extraction) stored a second, differing reading of the unit price.
    await t.run(async (ctx) => {
      const { ensurePurchaseTransaction } = await import("./transactions");
      const transactionId = await ensurePurchaseTransaction(ctx, w.purchaseId);
      await ctx.db.insert("facts", {
        userId, transactionId, subjectKey: `item:${w.itemId}`, key: "retail.unit_price", state: "extracted_candidate",
        value: { kind: "money", amountMinor: o.secondUnitCandidate!, currency: "USD" }, source: { kind: "user" }, recordedAt: NOW - DAY,
      });
    });
  }
  return { userId, as, ...w };
}

/**
 * The user presses "check price now" — refused on an unconfirmed purchase since M2C (D243 defence in depth,
 * CONFIRM_BEFORE_CHECK) — and a check that still lands in `recordCheck` (e.g. one queued before the status changed; the
 * mutation itself stays ungated) is the E3 pin's input: its verdict must never be negative.
 */
async function checkNowThenRecord(t: T, as: Awaited<ReturnType<typeof signedIn>>["as"], itemId: Id<"items">, observedCents: number) {
  await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(CONFIRM_BEFORE_CHECK);
  const res = await t.mutation(internal.priceWatch.recordCheck, {
    itemId, sourceUrl: "https://acme.example/p/jacket", observedCents, currency: "USD", confidence: 0.95, variantMatch: "exact",
  });
  expect(res.accepted).toBe(true); // a vetted, accepted observation on an unconfirmed purchase
  return await t.run(async (ctx) => {
    const opp = (await ctx.db.query("opportunities").collect()).find((o) => o.scenarioId === "R01") as Doc<"opportunities">;
    const ev = (await ctx.db.get(opp.currentEvaluationId!))!;
    return { outcome: opp.outcome, missing: ev.missingFacts.map((m) => `${m.key}:${m.reason}`), claims: (await ctx.db.query("claims").collect()).length };
  });
}

describe("E3 (D243): R01 v1 never gives a negative verdict on unconfirmed purchase facts", () => {
  pinClockEach(NOW);

  it("runs through the production registry with R01 v1 active", () => {
    expect(REGISTRY_KIND).toBe("production");
    expect(activePack("R01")?.version).toBe(1);
  });

  it("P1: candidate unit/qty with a drop below the threshold → needs_facts (was not_eligible)", async () => {
    const t = setup();
    const w = await unconfirmedPurchase(t, { unit: 12_000 });
    const r = await checkNowThenRecord(t, w.as, w.itemId, 11_950);
    expect(r.outcome).toBe("needs_facts");
    expect(r.missing).toEqual(expect.arrayContaining(["retail.unit_price:candidate_unconfirmed", "retail.quantity:candidate_unconfirmed"]));
    expect(r.claims).toBe(0);
  });

  it("P5: two differing unit-price candidates, both below the threshold → needs_facts via 5b (was not_eligible via 5c)", async () => {
    const t = setup();
    const w = await unconfirmedPurchase(t, { unit: 12_000, secondUnitCandidate: 12_020 });
    const r = await checkNowThenRecord(t, w.as, w.itemId, 11_950);
    expect(r.outcome).toBe("needs_facts");
    expect(r.claims).toBe(0);
  });

  it("pin: an accepted check on a needs_review purchase never yields a negative R01 verdict, whatever the price", async () => {
    for (const observed of [11_999, 11_950, 11_800, 9_500, 1_300]) {
      const t = setup();
      const w = await unconfirmedPurchase(t, { unit: 12_000 });
      const r = await checkNowThenRecord(t, w.as, w.itemId, observed);
      expect(NEGATIVE.has(r.outcome), `observed ${observed} → ${r.outcome}`).toBe(false);
      expect(r.claims, "an unconfirmed purchase never auto-opens").toBe(0);
    }
  });
});
