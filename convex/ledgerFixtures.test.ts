/// <reference types="vite/client" />
/**
 * M16 — mission §17 "Core financial fixtures", end to end (contract §10, §3.2–§3.4).
 *
 * Written by QA independently of the M10/M12/M13 implementers, from the mission text, contract rev 5.5 §3 and
 * DECISIONS. Every expected number below is written by hand from those rules, never produced by the code under test.
 *
 * Entry points: every user action goes through the public API (`purchases.create`, `purchases.setReturned`,
 * `claims.open`, `claims.confirmCredit`, `claims.recordLaterDebit`, the provisional-credit mutations,
 * `claims.recordNonCashRemedy`, `opportunities.reevaluate`, `recovery.summary`, `claims.get`). Three boundaries are
 * crossed below the public API, each the point where an external party's data enters, never a shortcut past a
 * user decision:
 *   - a merchant's email enters at `intake.applyExtraction` (the model-output boundary: the same mutation the
 *     OpenAI action calls; the model call itself is not exercised);
 *   - a price observation enters at `priceWatch.recordCheck` (the scraper-output boundary the cron calls);
 *   - a merchant policy is a `policies` row (what the LLM policy fetch writes), and a stored observation a
 *     `priceChecks` row.
 * The only SEEDED state is the pair of alternative opportunities / claims on one loss (fixtures C1/C2): wave 1 has one
 * pack (R01) and one remedy per item, so no public path can yet produce two remedies on the same loss key.
 *
 * `recovery.summary` is asserted at every step with the contract §3.4 invariants, per currency:
 *   (I1) Σ tiles = Σ outstanding (the hand-computed outstanding of every component),
 *   (I2) Recovered + Over-credit = Σ net over the claims,
 *   (I3) every component with an open member is in exactly one tile (the tile component counts add up to the number
 *        of open components, and each tile holds exactly the components expected there).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 22, 15);
const TILE_NAMES = ["potential", "ready", "sendingOrUnknown", "asked", "promised"] as const;
type TileName = (typeof TILE_NAMES)[number];

type T = ReturnType<typeof setup>;
type As = Awaited<ReturnType<typeof signedIn>>["as"];

beforeEach(() => {
  // Full fake timers: nothing a mutation schedules (policy fetch, scrapes, the model) runs by itself (D31).
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setTestActivations([]); // production state: no active pack → every R01 path is the legacy fallback
});
afterEach(() => {
  vi.useRealTimers();
  resetTestRegistry();
});

// ---------------------------------------------------------------------------
// Helpers (public API only, except the three data boundaries named in the header)
// ---------------------------------------------------------------------------

async function buy(
  as: As,
  o: { merchant?: string; domain?: string; orderRef?: string; currency?: string; items: Array<{ name: string; unitCents: number; qty?: number; productUrl?: string }> },
) {
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: o.merchant ?? "Northwind Outfitters",
    merchantDomain: o.domain ?? "northwind.example",
    ...(o.orderRef ? { orderRef: o.orderRef } : {}),
    purchasedAt: NOW - 3 * DAY,
    currency: o.currency ?? "USD",
    status: "active",
    items: o.items.map((i) => ({ name: i.name, unitCents: i.unitCents, qty: i.qty ?? 1, ...(i.productUrl ? { productUrl: i.productUrl } : {}) })),
  });
  const detail = await as.query(api.purchases.get, { purchaseId });
  const itemIds = detail.items.map((i: Doc<"items">) => i._id);
  return { purchaseId, itemIds };
}

/** Marks the item returned and opens the (public, D20) return claim for its full price. */
async function returnClaim(as: As, itemId: Id<"items">) {
  await as.mutation(api.purchases.setReturned, { itemId, returned: true });
  return await as.mutation(api.claims.open, { itemId });
}

/**
 * The account holder forwards the merchant's refund email from their own address, verified by the user's tap (DA-B-3):
 * a From header is not authentication (D190/D194, D198), so the email alone writes nothing and the promise is recorded
 * by the holder's one-tap `confirmRefundEmail`, which this helper performs.
 */
async function merchantEmail(
  t: T,
  userId: Id<"users">,
  messageId: string,
  refund: { merchant: string; orderRef: string | null; credits: Array<{ itemName: string | null; amount: number; currency: string; state: "posted" | "promised" }> },
) {
  await t.run(async (ctx) => await ctx.db.patch(userId, { email: "holder@example.com" }));
  const processedEventId = await t.run(
    async (ctx) =>
      await ctx.db.insert("processedEvents", {
        externalId: `agentmail:${messageId}`,
        kind: "agentmail.message.received",
        status: "received",
        attempts: 0,
        userId,
        route: "intake",
        payload: { messageId, subject: "Your refund", text: "About your return.", from: "Holder <holder@example.com>" },
      }),
  );
  await t.mutation(internal.intake.applyExtraction, {
    processedEventId,
    parsed: { kind: "refund", order: null, refund, confidence: 0.95 },
  });
  const held = (await t.run(async (ctx) => await ctx.db.get(processedEventId)))!;
  if ((held.payload as { pendingRefund?: unknown } | undefined)?.pendingRefund !== undefined) {
    await t.withIdentity({ subject: `${userId}|session` }).mutation(api.intake.confirmRefundEmail, { processedEventId });
  }
  return (await t.run(async (ctx) => await ctx.db.get(processedEventId)))!;
}

async function claimView(as: As, claimId: Id<"claims">) {
  return await as.query(api.claims.get, { claimId });
}

async function ledgerCount(t: T, claimId: Id<"claims">) {
  return (await t.run(async (ctx) => await ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect())).length;
}

type Expected = {
  recovered: number;
  overCredit?: number;
  /** Hand-computed outstanding per tile: [amount, provisional, components]. Omitted tiles are 0/0/0. */
  tiles?: Partial<Record<TileName, [number, number, number]>>;
  /** Σ net over this currency's claims (I2). */
  sumNet: number;
};

/** `recovery.summary` for one currency equals the hand-computed figures, with I1–I3. */
async function expectSummary(as: As, currency: string, e: Expected) {
  const s = await as.query(api.recovery.summary, { now: NOW });
  const row = s.currencies.find((c: { currency: string }) => c.currency === currency);
  expect(row, `summary has a ${currency} row`).toBeDefined();
  const tiles = row!.tiles as Record<TileName, { amountMinor: number; provisionalMinor: number; components: number }>;
  for (const name of TILE_NAMES) {
    const [amount, provisional, components] = e.tiles?.[name] ?? [0, 0, 0];
    expect({ tile: name, ...tiles[name] }).toEqual({ tile: name, amountMinor: amount, provisionalMinor: provisional, components });
  }
  expect(row!.recoveredMinor).toBe(e.recovered);
  expect(row!.overCreditMinor).toBe(e.overCredit ?? 0);
  // (I1) Σ tiles = Σ outstanding (the expected tile amounts ARE the hand-computed outstanding per component).
  const handOutstanding = TILE_NAMES.reduce((a, n) => a + (e.tiles?.[n]?.[0] ?? 0), 0);
  expect(TILE_NAMES.reduce((a, n) => a + tiles[n].amountMinor, 0)).toBe(handOutstanding);
  // (I2) Recovered + Over-credit = Σ net.
  expect(row!.recoveredMinor + row!.overCreditMinor).toBe(e.sumNet);
  // (I3) each open component in exactly one tile.
  const handComponents = TILE_NAMES.reduce((a, n) => a + (e.tiles?.[n]?.[2] ?? 0), 0);
  expect(TILE_NAMES.reduce((a, n) => a + tiles[n].components, 0)).toBe(handComponents);
  return s;
}

// ---------------------------------------------------------------------------
// A. The mission's ledger walk: 4,000 → promise → 1,500 → 2,500 → later debit
// ---------------------------------------------------------------------------

describe("A. expected 4,000 → promise 4,000 → confirm 1,500 → confirm 2,500 → later debit 1,000 (mission §17)", () => {
  it("walks the ledger through public mutations with the right balance, status and dashboard tile at every step", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Holder");
    const { itemIds } = await buy(as, { orderRef: "ORD-4000", items: [{ name: "Wool coat", unitCents: 4_000 }, { name: "Scarf", unitCents: 3_000 }] });
    const [coat, scarf] = itemIds;

    // Expected 4,000 (claims.open derives it server-side: 4,000 × 1, no fee).
    const a = await returnClaim(as, coat);
    let v = await claimView(as, a);
    expect(v.claim.status).toBe("detected");
    expect(v.balance).toEqual({ expected: 4_000, promised: 0, confirmed: 0, debited: 0, unresolved: 4_000 });
    // No drafts, no promise: the catch-all Ready tile (C4).
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });

    // Promise 4,000 → unresolved stays 4,000 (a promise is never recovered money, mission §6).
    const promised = await merchantEmail(t, userId, "<refund-1@northwind.example>", {
      merchant: "Northwind Outfitters", orderRef: "ORD-4000",
      credits: [{ itemName: "Wool coat", amount: 40.0, currency: "USD", state: "promised" }],
    });
    expect(promised.status).toBe("succeeded");
    v = await claimView(as, a);
    expect(v.claim.status).toBe("promised");
    expect(v.balance).toEqual({ expected: 4_000, promised: 4_000, confirmed: 0, debited: 0, unresolved: 4_000 });
    // promised 4,000 > net 0 and status promised → the Promised tile.
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { promised: [4_000, 0, 1] } });

    // Confirm 1,500 → unresolved 2,500.
    await as.mutation(api.claims.confirmCredit, { claimId: a, cents: 1_500, evidence: "Card statement line 1", idempotencyKey: "a-confirm-1" });
    v = await claimView(as, a);
    expect(v.balance).toEqual({ expected: 4_000, promised: 4_000, confirmed: 1_500, debited: 0, unresolved: 2_500 });
    expect(v.claim.status).toBe("promised");
    // net 1,500 → recovered 1,500; outstanding 4,000 − 1,500 = 2,500; still promised 4,000 > net 1,500.
    await expectSummary(as, "USD", { recovered: 1_500, sumNet: 1_500, tiles: { promised: [2_500, 0, 1] } });

    // Confirm 2,500 → 0, settled.
    await as.mutation(api.claims.confirmCredit, { claimId: a, cents: 2_500, evidence: "Card statement line 2", idempotencyKey: "a-confirm-2" });
    v = await claimView(as, a);
    expect(v.balance).toEqual({ expected: 4_000, promised: 4_000, confirmed: 4_000, debited: 0, unresolved: 0 });
    expect(v.claim.status).toBe("confirmed");
    // Closed for ask → no open member → no tile at all.
    await expectSummary(as, "USD", { recovered: 4_000, sumNet: 4_000 });

    // A second, unrelated claim on the same order, fully confirmed (the control for "only that claim reopens").
    const b = await returnClaim(as, scarf);
    await as.mutation(api.claims.confirmCredit, { claimId: b, cents: 3_000, evidence: "Card statement line 3", idempotencyKey: "b-confirm" });
    expect((await claimView(as, b)).claim.status).toBe("confirmed");
    await expectSummary(as, "USD", { recovered: 7_000, sumNet: 7_000 });

    // A later debit larger than the net confirmed credit is refused (D40) and writes nothing.
    const before = await ledgerCount(t, a);
    await expect(
      as.mutation(api.claims.recordLaterDebit, { claimId: a, cents: 4_001, evidence: "Chargeback", idempotencyKey: "a-debit-too-big" }),
    ).rejects.toThrow(/cannot exceed the confirmed credit/);
    expect(await ledgerCount(t, a)).toBe(before);

    // Later debit 1,000 → only claim A reopens, for exactly 1,000.
    await as.mutation(api.claims.recordLaterDebit, { claimId: a, cents: 1_000, evidence: "Refund reversed on statement", idempotencyKey: "a-debit" });
    v = await claimView(as, a);
    expect(v.claim.status).toBe("reopened");
    expect(v.balance).toEqual({ expected: 4_000, promised: 4_000, confirmed: 4_000, debited: 1_000, unresolved: 1_000 });
    const vb = await claimView(as, b);
    expect(vb.claim.status).toBe("confirmed");
    expect(vb.balance.unresolved).toBe(0);
    // net(A) 3,000 + net(B) 3,000 = 6,000 recovered; A open again: lossOpen 4,000 − recovered 3,000 = 1,000.
    // Status is `reopened` (not `promised`), no delivery → the Ready catch-all.
    await expectSummary(as, "USD", { recovered: 6_000, sumNet: 6_000, tiles: { ready: [1_000, 0, 1] } });

    // Replaying the same keys changes nothing (idempotent retries, D38).
    await as.mutation(api.claims.recordLaterDebit, { claimId: a, cents: 1_000, evidence: "Refund reversed on statement", idempotencyKey: "a-debit" });
    await as.mutation(api.claims.confirmCredit, { claimId: a, cents: 1_500, evidence: "Card statement line 1", idempotencyKey: "a-confirm-1" });
    expect((await claimView(as, a)).balance.unresolved).toBe(1_000);
    await expectSummary(as, "USD", { recovered: 6_000, sumNet: 6_000, tiles: { ready: [1_000, 0, 1] } });
  });

  it("a promise that is 'posted' in the email is still only a promise until the user confirms (mission §6)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Holder");
    const { itemIds } = await buy(as, { orderRef: "ORD-POSTED", items: [{ name: "Boots", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await merchantEmail(t, userId, "<refund-posted@northwind.example>", {
      merchant: "Northwind Outfitters", orderRef: "ORD-POSTED",
      credits: [{ itemName: "Boots", amount: 40.0, currency: "USD", state: "posted" }],
    });
    const v = await claimView(as, claimId);
    expect(v.balance.confirmed).toBe(0);
    expect(v.balance.unresolved).toBe(4_000);
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { promised: [4_000, 0, 1] } });
  });
});

describe("A2. tiles by the furthest state (DA-A-17, C4)", () => {
  it("C4's example: return claim 4,000 + promise 1,500 + confirmed 1,500 → 2,500 in Ready (promised ≤ net)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-C4", items: [{ name: "Hiking poles", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await merchantEmail(t, userId, "<partial@northwind.example>", {
      merchant: "Northwind Outfitters", orderRef: "ORD-C4",
      credits: [{ itemName: "Hiking poles", amount: 15.0, currency: "USD", state: "promised" }],
    });
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { promised: [4_000, 0, 1] } });
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1_500, evidence: "Statement", idempotencyKey: "c4" });
    expect((await claimView(as, claimId)).claim.status).toBe("promised");
    await expectSummary(as, "USD", { recovered: 1_500, sumNet: 1_500, tiles: { ready: [2_500, 0, 1] } });
  });

  it("a claim the user sent through the merchant's own channel (packet) → Asked, reported as user-reported", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-PKT", items: [{ name: "Bike light", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await as.mutation(api.drafts.markPacketSent, { claimId, note: "Submitted the store's web form" });
    const s = await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { asked: [4_000, 0, 1] } });
    expect(s.currencies[0].askedUserReportedMinor).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// B. Provisional credits (§3.2, DA-A-16, N5)
// ---------------------------------------------------------------------------

describe("B. provisional credit is labelled separately (mission §17; contract §3.2, N5)", () => {
  it("provisional 2,000 → 'of which provisional', Recovered unchanged; ProvisionalOutstanding; separate posting; finalize → +2,000", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-PROV", items: [{ name: "Tent", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);

    await as.mutation(api.claims.recordProvisionalCredit, {
      claimId, amount: { amountMinor: 2_000, currency: "USD" }, evidence: "Issuer provisional credit", idempotencyKey: "prov-1",
    });
    let v = await claimView(as, claimId);
    expect(v.provisionalMinor).toBe(2_000);
    expect(v.balance).toEqual({ expected: 4_000, promised: 0, confirmed: 0, debited: 0, unresolved: 4_000 });
    expect(v.claim.status).toBe("detected"); // provisional kinds never change status
    // outstanding 4,000 in Ready; of which provisional = min(4,000, 2,000).
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 2_000, 1] } });

    // confirmCredit without saying which → ProvisionalOutstanding, nothing written (N5).
    const before = await ledgerCount(t, claimId);
    const err = await as
      .mutation(api.claims.confirmCredit, { claimId, cents: 1_000, evidence: "Statement", idempotencyKey: "conf-ambiguous" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ kind: string; provisionalMinor: number }>).data).toEqual({ kind: "ProvisionalOutstanding", provisionalMinor: 2_000 });
    expect(await ledgerCount(t, claimId)).toBe(before);

    // A genuinely separate posting is never refused: recorded, provisional unchanged.
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1_000, evidence: "Separate goodwill credit", idempotencyKey: "conf-separate", separateFromProvisional: true });
    v = await claimView(as, claimId);
    expect(v.provisionalMinor).toBe(2_000);
    expect(v.balance.confirmed).toBe(1_000);
    // recovered 1,000; outstanding 3,000; of which provisional min(3,000, 2,000) = 2,000.
    await expectSummary(as, "USD", { recovered: 1_000, sumNet: 1_000, tiles: { ready: [3_000, 2_000, 1] } });

    // The provisional credit becomes final → Recovered +2,000, provisional 0; a retry dedupes both events.
    await as.mutation(api.claims.finalizeProvisionalCredit, { claimId, cents: 2_000, evidence: "Investigation closed in my favour", idempotencyKey: "fin-1" });
    const afterFinalize = await ledgerCount(t, claimId);
    await as.mutation(api.claims.finalizeProvisionalCredit, { claimId, cents: 2_000, evidence: "Investigation closed in my favour", idempotencyKey: "fin-1" });
    expect(await ledgerCount(t, claimId)).toBe(afterFinalize);
    v = await claimView(as, claimId);
    expect(v.provisionalMinor).toBe(0);
    expect(v.balance.confirmed).toBe(3_000);
    expect(v.balance.unresolved).toBe(1_000);
    await expectSummary(as, "USD", { recovered: 3_000, sumNet: 3_000, tiles: { ready: [1_000, 0, 1] } });
  });

  it("a reversed provisional credit → provisional 0, Recovered 0; a release can never exceed what is outstanding", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-REV", items: [{ name: "Stove", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await as.mutation(api.claims.recordProvisionalCredit, {
      claimId, amount: { amountMinor: 2_000, currency: "USD" }, evidence: "Issuer provisional credit", idempotencyKey: "prov-r",
    });
    await expect(
      as.mutation(api.claims.reverseProvisionalCredit, { claimId, cents: 2_001, evidence: "Reversed", idempotencyKey: "rev-too-big" }),
    ).rejects.toThrow(/cannot exceed the outstanding provisional credit/);
    await as.mutation(api.claims.reverseProvisionalCredit, { claimId, cents: 2_000, evidence: "Issuer reversed it", idempotencyKey: "rev-1" });
    const v = await claimView(as, claimId);
    expect(v.provisionalMinor).toBe(0);
    expect(v.balance).toEqual({ expected: 4_000, promised: 0, confirmed: 0, debited: 0, unresolved: 4_000 });
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });
  });

  it("a provisional credit in another currency than the claim's is refused", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-PC", items: [{ name: "Lamp", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await expect(
      as.mutation(api.claims.recordProvisionalCredit, { claimId, amount: { amountMinor: 2_000, currency: "EUR" }, evidence: "x", idempotencyKey: "p-eur" }),
    ).rejects.toThrow(/currency mismatch/);
    expect((await claimView(as, claimId)).provisionalMinor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C. Alternatives never inflate (D145 DA-A-4; contract §3.4)
// ---------------------------------------------------------------------------

describe("C. alternatives never inflate Potential or Recovered", () => {
  /** A real R01 opportunity with no case (public `opportunities.reevaluate` never opens one), R01 v1 active. */
  async function potentialOpportunity(t: T, userId: Id<"users">, as: As) {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const { purchaseId, itemIds } = await buy(as, {
      domain: "fjord.example", merchant: "Fjord Supply", orderRef: "ORD-ALT",
      items: [{ name: "Rain shell", unitCents: 12_000, productUrl: "https://fjord.example/p/rain-shell" }],
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("policies", {
        userId, merchantDomain: "fjord.example", kind: "price_adjustment", windowDays: 14, channel: "email",
        contactEmail: "help@fjord.example", passage: "We refund the difference if our price drops within 14 days.",
        sourceUrl: "https://fjord.example/price-policy", retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      });
      await ctx.db.insert("priceChecks", {
        itemId: itemIds[0], userId, observedCents: 9_000, currency: "USD", confidence: 0.95, variantMatch: "exact",
        observedAt: NOW - DAY, sourceUrl: "https://fjord.example/p/rain-shell",
      });
    });
    await as.mutation(api.opportunities.reevaluate, { purchaseId });
    const view = await as.query(api.opportunities.forPurchase, { purchaseId });
    expect(view.opportunities).toHaveLength(1);
    return view.opportunities[0].opportunity as Doc<"opportunities">;
  }

  it("C1. alternatives of 3,000 and 2,500 on one loss → Potential 3,000 (one component)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const opp = await potentialOpportunity(t, userId, as);
    expect(opp.activeClaimId).toBeUndefined();
    expect(opp.estimate).toEqual({ amountMinor: 3_000, currency: "USD" }); // (12,000 − 9,000) × 1
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { potential: [3_000, 0, 1] } });

    // SEEDED (see header): a second remedy for the SAME loss with a smaller estimate.
    await t.run(async (ctx) => {
      const { _id: _omitId, _creationTime: _omitTime, currentEvaluationId: _omitEval, ...rest } = opp;
      await ctx.db.insert("opportunities", { ...rest, remedyKey: "alternative_remedy", dedupeKey: `${opp.dedupeKey}:alt`, estimate: { amountMinor: 2_500, currency: "USD" } });
    });
    // max(3,000, 2,500) — never 5,500.
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { potential: [3_000, 0, 1] } });
  });

  it("C2. two credits for one loss → Recovered = the loss, the excess on the over-credit line (never erased)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-DOUBLE", items: [{ name: "Kayak paddle", unitCents: 4_000 }, { name: "Dry bag", unitCents: 2_000 }] });
    const a = await returnClaim(as, itemIds[0]);
    const b = await returnClaim(as, itemIds[1]);
    // SEEDED (see header): claim B is declared a remedy for claim A's loss.
    await t.run(async (ctx) => await ctx.db.patch(b, { lossKeys: [`item:${itemIds[0]}:return_credit`] }));
    // One component {A, B}: lossAll = max(4,000, 2,000) = 4,000; nothing confirmed yet → Ready 4,000.
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });

    await as.mutation(api.claims.confirmCredit, { claimId: a, cents: 4_000, evidence: "Refund posted", idempotencyKey: "a-full" });
    await as.mutation(api.claims.confirmCredit, { claimId: b, cents: 1_500, evidence: "Second refund posted", idempotencyKey: "b-part" });
    // Σ net 5,500; recovered = min(5,500, 4,000) = 4,000; excess 1,500. B is still open (1,500 of 2,000), so the
    // component keeps an open member and sits in exactly one tile (I3: Ready, the catch-all), but lossOpen = 2,000
    // < recovered 4,000 → outstanding max(0, 2,000 − 4,000) = 0: nothing more to pursue on this loss.
    await expectSummary(as, "USD", { recovered: 4_000, overCredit: 1_500, sumNet: 5_500, tiles: { ready: [0, 0, 1] } });
  });
});

// ---------------------------------------------------------------------------
// D/E/F. Currencies, non-cash, foreign-currency refund email
// ---------------------------------------------------------------------------

describe("D. mixed currencies are separate rows, never summed or converted", () => {
  it("USD and EUR claims → two currency rows with their own figures", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const usd = await buy(as, { merchant: "Harbor Books", domain: "harbor.example", orderRef: "ORD-USD", currency: "USD", items: [{ name: "Atlas", unitCents: 4_000 }] });
    const eur = await buy(as, { merchant: "Kanal Books", domain: "kanal.example", orderRef: "ORD-EUR", currency: "EUR", items: [{ name: "Globus", unitCents: 2_500 }] });
    const cu = await returnClaim(as, usd.itemIds[0]);
    const ce = await returnClaim(as, eur.itemIds[0]);
    await as.mutation(api.claims.confirmCredit, { claimId: ce, cents: 1_000, evidence: "EUR refund part", idempotencyKey: "eur-1" });

    const s = await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });
    await expectSummary(as, "EUR", { recovered: 1_000, sumNet: 1_000, tiles: { ready: [1_500, 0, 1] } });
    expect(s.currencies.map((c: { currency: string }) => c.currency).sort()).toEqual(["EUR", "USD"]);
    expect((await claimView(as, cu)).balance.unresolved).toBe(4_000);
  });
});

describe("E. a non-cash voucher is a count only", () => {
  it("recordNonCashRemedy with a face value → nonCash count 1; no money figure changes (I5)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-NC", items: [{ name: "Blender", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    await as.mutation(api.claims.recordNonCashRemedy, {
      claimId, kind: "voucher", description: "Store voucher, expires 2027-01-31", faceValue: { amountMinor: 5_000, currency: "USD" },
      state: "received", idempotencyKey: "voucher-1",
    });
    const s = await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });
    expect(s.nonCash).toEqual([{ kind: "voucher", count: 1 }]);
    const v = await claimView(as, claimId);
    expect(v.claim.status).toBe("detected");
    expect(v.balance.unresolved).toBe(4_000);
    expect(v.nonCashRemedies).toHaveLength(1);
  });
});

describe("F. a refund email in a foreign currency is refused (HC-10)", () => {
  it("EUR credit on a USD purchase → needs_review, no ledger event, the dashboard unchanged", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemIds } = await buy(as, { orderRef: "ORD-FX", items: [{ name: "Camera strap", unitCents: 4_000 }] });
    const claimId = await returnClaim(as, itemIds[0]);
    const row = await merchantEmail(t, userId, "<refund-fx@northwind.example>", {
      merchant: "Northwind Outfitters", orderRef: "ORD-FX",
      credits: [{ itemName: "Camera strap", amount: 37.0, currency: "EUR", state: "posted" }],
    });
    expect(row.status).toBe("needs_review");
    expect(row.summary).toMatch(/never converts currencies/);
    expect(await ledgerCount(t, claimId)).toBe(0);
    expect((await claimView(as, claimId)).claim.status).toBe("detected");
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [4_000, 0, 1] } });
  });
});

describe("H. per-transaction paid-total cap (D145; contract §3.4 I4)", () => {
  it("a price claim and a return claim on one 12,000 item never show more than the 12,000 paid", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemIds } = await buy(as, {
      merchant: "Summit Gear", domain: "summit.example", orderRef: "ORD-CAP",
      items: [{ name: "Down jacket", unitCents: 12_000, productUrl: "https://summit.example/p/down-jacket" }],
    });
    await t.run(async (ctx) =>
      await ctx.db.insert("policies", {
        userId, merchantDomain: "summit.example", kind: "price_adjustment", windowDays: 14, channel: "email",
        contactEmail: "care@summit.example", passage: "If our price drops within 14 days of purchase, we refund the difference.",
        sourceUrl: "https://summit.example/price-promise", retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      }));
    // Price drop to 9,000 → a 3,000 price claim (legacy path).
    const r = await t.mutation(internal.priceWatch.recordCheck, {
      itemId: itemIds[0], sourceUrl: "https://summit.example/p/down-jacket", observedCents: 9_000, currency: "USD", confidence: 0.92, variantMatch: "exact",
    });
    expect(r.claimId).not.toBeNull();
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [3_000, 0, 1] } });
    // Then the user returns the jacket: a 12,000 return claim (a different loss key, so a second component).
    await returnClaim(as, itemIds[0]);
    // Uncapped the tiles would show 3,000 + 12,000 = 15,000 against 12,000 paid; the cap removes 3,000 from the
    // lowest tile first (both components are Ready), leaving exactly the paid total.
    const s = await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [12_000, 0, 2] } });
    const usd = s.currencies.find((c: { currency: string }) => c.currency === "USD")!;
    expect(usd.cappedAtPaidTotal).toBe(true);
    expect(usd.paidTotalPartial).toBe(true); // no confirmed order total: "cap based on item prices only"
  });
});

describe("H2. confirmed money on one item above what was paid (contract §3.4 I4; mission §6)", () => {
  /**
   * QA-M16-1 (MEDIUM, found by this file at 4f274f1, fixed by M12c in 9acc16b per D188): the paid-total cap used to
   * trim only OUTSTANDING, so two confirmed credits on distinct loss keys of one item (a price adjustment, then the
   * full return refund) showed Recovered above the price paid with nothing on the over-credit line. Through public
   * flows: a 2,000 price adjustment confirmed, then the 4,000 item returned and refunded in full. D188: per
   * transaction per currency, Recovered = min(Σ confirmed net, paid) and the excess is on the over-credit line.
   */
  it("a confirmed price adjustment + a confirmed full return refund never show more Recovered than the 4,000 paid", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemIds } = await buy(as, {
      merchant: "Summit Gear", domain: "summit.example", orderRef: "ORD-I4",
      items: [{ name: "Fleece", unitCents: 4_000, productUrl: "https://summit.example/p/fleece" }],
    });
    await t.run(async (ctx) =>
      await ctx.db.insert("policies", {
        userId, merchantDomain: "summit.example", kind: "price_adjustment", windowDays: 14, channel: "email",
        contactEmail: "care@summit.example", passage: "If our price drops within 14 days of purchase, we refund the difference.",
        sourceUrl: "https://summit.example/price-promise", retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      }));
    const r = await t.mutation(internal.priceWatch.recordCheck, {
      itemId: itemIds[0], sourceUrl: "https://summit.example/p/fleece", observedCents: 2_000, currency: "USD", confidence: 0.92, variantMatch: "exact",
    });
    await as.mutation(api.claims.confirmCredit, { claimId: r.claimId!, cents: 2_000, evidence: "Price adjustment posted", idempotencyKey: "pa" });
    const ret = await returnClaim(as, itemIds[0]);
    await as.mutation(api.claims.confirmCredit, { claimId: ret, cents: 4_000, evidence: "Full refund posted", idempotencyKey: "rf" });
    const usd = (await as.query(api.recovery.summary, { now: NOW })).currencies.find((c: { currency: string }) => c.currency === "USD")!;
    // I2: Recovered + over-credit = Σ net = 6,000; I4: Recovered ≤ paid 4,000; D188: the 2,000 excess is visible.
    expect(usd.recoveredMinor + usd.overCreditMinor).toBe(6_000);
    expect(usd.recoveredMinor).toBe(4_000);
    expect(usd.overCreditMinor).toBe(2_000);
  });
});

describe("I. legacy claims in a non-two-decimal currency are never shown as money (HC-8, D160 family, D179)", () => {
  it("a JPY return claim (legacy hundredths) is listed under unsupportedCurrencies and in no money figure", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { itemIds } = await buy(as, { merchant: "Kyoto Tools", domain: "kyoto.example", orderRef: "ORD-JPY", currency: "JPY", items: [{ name: "Chisel", unitCents: 120_000 }] });
    await returnClaim(as, itemIds[0]);
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.currencies).toEqual([]);
    expect(s.unsupportedCurrencies).toEqual([{ currency: "JPY", claims: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// G. R01: 2 × 12,000 with an eligible 9,500 → 5,000; wrong variant/currency/policy → no claim
// ---------------------------------------------------------------------------

const MODES = ["legacy", "v1"] as const;
function selectMode(mode: (typeof MODES)[number]) {
  if (mode === "legacy") setTestActivations([]);
  else setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
}

describe.each(MODES)("G. R01 price drop, mode %s (C3: legacy fallback and v1 forced active)", (mode) => {
  async function watchedPair(t: T, userId: Id<"users">, as: As, o: { policy?: boolean } = {}) {
    selectMode(mode);
    const { purchaseId, itemIds } = await buy(as, {
      merchant: "Summit Gear", domain: "summit.example", orderRef: "ORD-PAIR",
      items: [{ name: "Trail runner, size 42", unitCents: 12_000, qty: 2, productUrl: "https://summit.example/p/trail-runner-42" }],
    });
    if (o.policy !== false) {
      await t.run(async (ctx) =>
        await ctx.db.insert("policies", {
          userId, merchantDomain: "summit.example", kind: "price_adjustment", windowDays: 14, channel: "email",
          contactEmail: "care@summit.example", passage: "If our price drops within 14 days of purchase, we refund the difference.",
          sourceUrl: "https://summit.example/price-promise", retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
        }));
    }
    return { purchaseId, itemId: itemIds[0] };
  }
  const observe = (t: T, itemId: Id<"items">, o: { cents: number; currency?: string; variantMatch?: "exact" | "unsure" | "none" }) =>
    t.mutation(internal.priceWatch.recordCheck, {
      itemId, sourceUrl: "https://summit.example/p/trail-runner-42", observedCents: o.cents, currency: o.currency ?? "USD",
      confidence: 0.92, variantMatch: o.variantMatch ?? "exact",
    });
  const priceClaims = (t: T, itemId: Id<"items">) =>
    t.run(async (ctx) => (await ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect()).filter((c) => c.type === "price_adjustment"));

  it("2 units at 12,000 with an eligible 9,500 → one claim of (12,000 − 9,500) × 2 = 5,000 in Ready", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { purchaseId, itemId } = await watchedPair(t, userId, as);
    const r = await observe(t, itemId, { cents: 9_500 });
    expect(r.accepted).toBe(true);
    expect(r.claimId).not.toBeNull();
    const claims = await priceClaims(t, itemId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expectedCents).toBe(5_000);
    if (mode === "v1") {
      // The v1 card carries the same number, the formula spelled out, and the case it opened (no second card).
      const view = await as.query(api.opportunities.forPurchase, { purchaseId });
      expect(view.opportunities).toHaveLength(1);
      const { opportunity, evaluation } = view.opportunities[0];
      expect(opportunity.activeClaimId).toBe(r.claimId);
      expect(evaluation?.amount?.estimate).toEqual({ amountMinor: 5_000, currency: "USD" });
      expect(evaluation?.amount?.formula.replace(/[\s,]/g, "")).toMatch(/\(12000[−-]9500\)[×x*]2/);
    }
    await expectSummary(as, "USD", { recovered: 0, sumNet: 0, tiles: { ready: [5_000, 0, 1] } });
    // The same observation a minute later opens nothing new (idempotent drop).
    vi.setSystemTime(NOW + 60_000);
    await observe(t, itemId, { cents: 9_500 });
    expect(await priceClaims(t, itemId)).toHaveLength(1);
  });

  it.each([
    ["a different variant", { cents: 9_500, variantMatch: "unsure" as const }],
    ["another product", { cents: 9_500, variantMatch: "none" as const }],
    ["another currency", { cents: 9_500, currency: "EUR" }],
  ])("wrong observation (%s) → no claim and nothing on the dashboard", async (_label, o) => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await watchedPair(t, userId, as);
    const r = await observe(t, itemId, o);
    expect(r.claimId).toBeNull();
    expect(r.accepted).toBe(false);
    expect(await priceClaims(t, itemId)).toHaveLength(0);
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.currencies).toEqual([]);
  });

  it("no price-adjustment policy (unsupported policy) → no claim", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await watchedPair(t, userId, as, { policy: false });
    const r = await observe(t, itemId, { cents: 9_500 });
    expect(r.claimId).toBeNull();
    expect(await priceClaims(t, itemId)).toHaveLength(0);
    expect((await as.query(api.recovery.summary, { now: NOW })).currencies).toEqual([]);
  });
});
