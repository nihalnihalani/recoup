/// <reference types="vite/client" />
/**
 * Mission §12 — the cross-category iPhone acceptance case, through the PRODUCTION registry (`activation.ts`).
 *
 * A synthetic, card-paid iPhone purchase (the facts the mission lists: exact model and configuration, seller, purchase
 * date, payment card, a separately bought protection plan, trade-in and carrier-promotion terms, a bundled digital
 * trial line) must DISCOVER or EXPLICITLY RULE OUT each of the twelve paths. The test is data-driven: `PATHS` maps each
 * mission path to the scenario that would evaluate it (or to none), and the expectation follows activation —
 *   - an ACTIVE pack's scenario is evaluated: it appears as an opportunity card on its transaction;
 *   - an implemented-or-researched scenario WITHOUT an active pack appears under "Paths not checked" for its category,
 *     with its reason and NO amount;
 *   - a path with no scenario is ruled out explicitly: it never appears as a card, a coverage row or an amount.
 * So each path flips from "not checked" to "evaluated" the moment its pack is activated, with no test change.
 *
 * And, whatever is active: a physical-device receipt never implies a digital purchase; non-cash remedies stay
 * non-cash; nothing theoretical enters a "money found" figure — `recovery.summary` Potential counts only active-pack
 * estimates, and overlapping alternatives count once.
 */
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluatePurchase, evaluateTransaction } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";
import { activePack, REGISTRY_KIND } from "./lib/rules/registry";
import { SCENARIOS_BY_CATEGORY } from "./lib/rules/applicable";
import type { ScenarioId, TransactionCategory } from "./lib/rules/types";

const NOW = Date.UTC(2026, 8, 20, 14);
const DAY = 86_400_000;
type T = ReturnType<typeof setup>;
type As = Awaited<ReturnType<typeof signedIn>>["as"];

type Path =
  | { path: string; scenario: ScenarioId; category: TransactionCategory }
  | { path: string; scenario: null; ruledOut: string; mustNotAppear: RegExp };

/** Mission §12's twelve paths. `scenario: null` = no scenario models it: ruled out, never a card or an amount. */
const PATHS: readonly Path[] = [
  { path: "merchant price adjustment", scenario: "R01", category: "retail_order" },
  {
    path: "merchant return window", scenario: null, mustNotAppear: /return window/i,
    ruledOut: "the legacy return claim is user-initiated after the item is marked returned; not a checked path",
  },
  { path: "card purchase protection", scenario: "R06", category: "retail_order" },
  { path: "card return protection", scenario: "R07", category: "retail_order" },
  { path: "card extended warranty", scenario: "R08", category: "retail_order" },
  { path: "manufacturer warranty or separately purchased protection", scenario: "R10", category: "retail_order" },
  { path: "recall or service program", scenario: "R11", category: "retail_order" },
  { path: "trade-in discrepancy", scenario: null, ruledOut: "no scenario models trade-in terms", mustNotAppear: /trade-?in/i },
  { path: "delivery error (late or missing order)", scenario: "R05", category: "retail_order" },
  { path: "billing error on the card charge", scenario: "R03", category: "card_charge" },
  {
    path: "digital-content refund", scenario: null, mustNotAppear: /digital/i,
    ruledOut: "only for a separately relevant digital transaction; none exists",
  },
  {
    path: "carrier promotion or bill-credit failure", scenario: null, mustNotAppear: /carrier promotion|bill[- ]credit/i,
    ruledOut: "no scenario models carrier promotions",
  },
  { path: "settlement match", scenario: "R23", category: "retail_order" },
];

const ITEM_NAME = "iPhone 17 Pro 256GB Natural Titanium (A3104)";

/** The synthetic iPhone purchase: Apple Store, card-paid, with the protection plan, trade-in and promotion terms. */
async function iphoneWorld(t: T) {
  const { userId, as } = await signedIn(t);
  const w = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Apple Store", merchantDomain: "apple.example", orderRef: "W1234567890", purchasedAt: NOW - 3 * DAY,
      currency: "USD", status: "active",
    });
    const iphoneId = await ctx.db.insert("items", {
      purchaseId, userId, name: ITEM_NAME, unitCents: 109_900, qty: 1, productUrl: "https://apple.example/shop/iphone-17-pro", returned: false,
    });
    // A separately purchased protection plan and a bundled digital trial line — on a PHYSICAL receipt.
    await ctx.db.insert("items", { purchaseId, userId, name: "AppleCare+ for iPhone 17 Pro (2 years)", unitCents: 19_900, qty: 1, returned: false });
    await ctx.db.insert("items", { purchaseId, userId, name: "Apple Music — 3 months included", unitCents: 0, qty: 1, returned: false });
    await ctx.db.insert("policies", {
      userId, merchantDomain: "apple.example", kind: "price_adjustment", windowDays: 14, channel: "email", contactEmail: "orders@apple.example",
      passage: "If we reduce our price within 14 days of your purchase, we will refund the difference.", sourceUrl: "https://apple.example/policy",
      retrievedAt: NOW - 3 * DAY, confidence: 0.9, confirmedByUser: true,
    });
    // A vetted price check: the phone now sells for 1,049.00.
    await ctx.db.insert("priceChecks", {
      itemId: iphoneId, userId, observedCents: 104_900, currency: "USD", confidence: 0.95, variantMatch: "exact", observedAt: NOW - 60_000,
      sourceUrl: "https://apple.example/shop/iphone-17-pro",
    });
    const orderTxnId = await ensurePurchaseTransaction(ctx, purchaseId);
    // The card charge for the purchase, a separate transaction related to the order (DA-A-29, server-set).
    const cardTxnId = await ctx.db.insert("transactions", {
      userId, category: "card_charge", status: "active", counterpartyName: "APPLE STORE #R123", currency: "USD", totalMinor: 139_795,
      transactedAt: NOW - 3 * DAY, relatedTransactionId: orderTxnId, liveFactCount: 0,
    });
    await evaluatePurchase(ctx, purchaseId, "user_request", NOW);
    await evaluateTransaction(ctx, cardTxnId, "user_request", NOW);
    return { purchaseId, iphoneId, orderTxnId, cardTxnId };
  });
  return { userId, as, ...w };
}

async function viewOf(as: As, w: { purchaseId: Id<"purchases">; cardTxnId: Id<"transactions"> }, category: TransactionCategory) {
  return category === "retail_order"
    ? await as.query(api.opportunities.forPurchase, { purchaseId: w.purchaseId })
    : await as.query(api.opportunities.forTransaction, { transactionId: w.cardTxnId });
}

describe("mission §12: the cross-category iPhone case (production registry, data-driven)", () => {
  pinClockEach(NOW);

  it("runs against the production registry", () => {
    expect(REGISTRY_KIND).toBe("production");
    expect(PATHS).toHaveLength(13); // twelve mission paths; delivery and billing error are split by the transaction they live on
  });

  it.each(PATHS.map((p) => [p.path, p] as const))("%s: discovered (active pack) or explicitly ruled out", async (_name, p) => {
    const t = setup();
    const w = await iphoneWorld(t);
    if (p.scenario === null) {
      // Ruled out: no card, no coverage row, no amount — on either transaction.
      for (const category of ["retail_order", "card_charge"] as const) {
        expect(JSON.stringify(await viewOf(w.as, w, category)), category).not.toMatch(p.mustNotAppear);
      }
      const summary = await w.as.query(api.recovery.summary, { now: NOW });
      expect(JSON.stringify(summary)).not.toMatch(p.mustNotAppear);
      expect(p.ruledOut.length).toBeGreaterThan(0);
      return;
    }
    expect(SCENARIOS_BY_CATEGORY[p.category]).toContain(p.scenario);
    const view = await viewOf(w.as, w, p.category);
    const cards = view.opportunities.filter((o) => o.opportunity.scenarioId === p.scenario);
    const notChecked = view.pathsNotChecked.filter((r) => r.scenarioId === p.scenario);
    if (activePack(p.scenario) !== null) {
      // Evaluated: a card with its evaluation, and not listed as "not checked".
      expect(cards.length, `${p.scenario} card`).toBeGreaterThan(0);
      expect(cards.every((c) => c.evaluation !== null)).toBe(true);
      expect(notChecked).toEqual([]);
    } else {
      // Not checked: listed with its reason, no card, and no amount anywhere in the row.
      expect(cards).toEqual([]);
      expect(notChecked).toHaveLength(1);
      expect(notChecked[0].status).toBe("not_checked");
      expect(notChecked[0].reason.length).toBeGreaterThan(0);
      expect(JSON.stringify(notChecked[0])).not.toMatch(/amount|\$\d|\d{3,}/i);
    }
  });

  it("the active R01 path finds exactly its own estimate, asks nothing irrelevant, and never asks for a serial", async () => {
    const t = setup();
    const w = await iphoneWorld(t);
    if (activePack("R01") === null) return; // flips with activation like every other path
    const view = await w.as.query(api.opportunities.forPurchase, { purchaseId: w.purchaseId });
    const phone = view.opportunities.find((o) => o.opportunity.subjectKey === `item:${w.iphoneId}`)!;
    expect(["eligible", "likely_eligible"]).toContain(phone.opportunity.outcome);
    expect(phone.opportunity.estimate).toEqual({ amountMinor: 5_000, currency: "USD" }); // (1,099.00 − 1,049.00) × 1
    const asked = (phone.evaluation?.missingFacts ?? []).map((m) => m.key);
    expect(asked.some((k) => /serial|imei|card\.|trade|carrier/.test(k))).toBe(false);
    // The R11 reason promises never to ask for a serial just to list recall matching.
    expect(view.pathsNotChecked.find((r) => r.scenarioId === "R11")?.reason).toContain("serial");
  });

  it("a physical-device receipt never implies a digital purchase", async () => {
    const t = setup();
    const w = await iphoneWorld(t);
    const txns = await t.run((ctx) => ctx.db.query("transactions").withIndex("by_user_and_status", (q) => q.eq("userId", w.userId)).collect());
    // Exactly the order and its card charge; the bundled "Apple Music — 3 months included" line created nothing.
    expect(txns.map((x) => x._id).sort()).toEqual([w.orderTxnId, w.cardTxnId].sort());
    expect(txns.map((x) => x.category).sort()).toEqual(["card_charge", "retail_order"]);
    const opps = await t.run((ctx) => ctx.db.query("opportunities").collect());
    expect(opps.every((o) => SCENARIOS_BY_CATEGORY[txns.find((x) => x._id === o.transactionId)!.category].includes(o.scenarioId))).toBe(true);
    for (const category of ["retail_order", "card_charge"] as const) {
      expect(JSON.stringify(await viewOf(w.as, w, category)).toLowerCase()).not.toContain("digital");
    }
  });

  it("non-cash remedies stay non-cash: a replacement voucher is a count, never money", async () => {
    const t = setup();
    const w = await iphoneWorld(t);
    const claimId = await t.run(async (ctx) =>
      await ctx.db.insert("claims", {
        purchaseId: w.purchaseId, itemId: w.iphoneId, userId: w.userId, type: "return_credit", expectedCents: 109_900, status: "sent", token: "IPH001", version: 1,
      }));
    const before = await w.as.query(api.recovery.summary, { now: NOW });
    await w.as.mutation(api.claims.recordNonCashRemedy, {
      claimId, kind: "voucher", description: "Apple Store gift card", faceValue: { amountMinor: 109_900, currency: "USD" }, state: "received", idempotencyKey: "gc",
    });
    const after = await w.as.query(api.recovery.summary, { now: NOW });
    expect(after.nonCash).toEqual([{ kind: "voucher", count: 1 }]);
    const usd = (s: typeof after) => s.currencies.find((c) => c.currency === "USD");
    expect(usd(after)?.recoveredMinor ?? 0).toBe(usd(before)?.recoveredMinor ?? 0);
    expect(JSON.stringify(after.currencies)).toBe(JSON.stringify(before.currencies)); // the face value enters no money figure
  });

  it("nothing theoretical is summed: Potential counts only active-pack estimates, and overlapping alternatives count once", async () => {
    const t = setup();
    const w = await iphoneWorld(t);
    const activeEstimates = await t.run(async (ctx) => {
      const opps = await ctx.db.query("opportunities").collect();
      return opps
        .filter((o) => o.status === "open" && o.estimate && (o.outcome === "eligible" || o.outcome === "likely_eligible") && activePack(o.scenarioId)?.ruleId === o.ruleId)
        .reduce((a, o) => a + o.estimate!.amountMinor, 0);
    });
    const potential = async () => (await w.as.query(api.recovery.summary, { now: NOW })).currencies.find((c) => c.currency === "USD")?.tiles.potential.amountMinor ?? 0;
    expect(await potential()).toBe(activeEstimates);

    // A theoretical maximum from a path with NO active pack (card purchase protection on the whole phone) never counts.
    const phoneOpp = (await t.run((ctx) => ctx.db.query("opportunities").collect())).find((o) => o.subjectKey === `item:${w.iphoneId}`) as Doc<"opportunities"> | undefined;
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...base } = phoneOpp ?? ({} as Doc<"opportunities">);
      void _id;
      void _creationTime;
      if (!phoneOpp) return;
      await ctx.db.insert("opportunities", {
        ...base, scenarioId: "R06", ruleId: "R06.card_purchase_protection.theoretical", ruleVersion: 1, remedyKey: "purchase_protection",
        dedupeKey: `${base.dedupeKey}|R06`, estimate: { amountMinor: 109_900, currency: "USD" }, lossKeys: [`item:${w.iphoneId}:damage`],
        currentEvaluationId: undefined,
      });
      // An overlapping ALTERNATIVE under an active pack, on the same loss as the R01 card: counts once (the max).
      await ctx.db.insert("opportunities", {
        ...base, dedupeKey: `${base.dedupeKey}|alt`, subjectKey: `${base.subjectKey}:alt`, estimate: { amountMinor: 4_000, currency: "USD" },
        currentEvaluationId: undefined,
      });
    });
    expect(await potential()).toBe(activeEstimates);
  });
});
