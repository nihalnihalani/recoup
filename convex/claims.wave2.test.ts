/// <reference types="vite/client" />
/**
 * M20 (wave 2) with the REAL packs through the C3 seam:
 *  - DA-A-18 / D204: `claims.recordNonCashResolution` on an R02 case writes R02's declared acceptance fact
 *    (`AIR_VOUCHER_ACCEPTANCE`) as the user's own confirmation — superseding their earlier "rejected" answer — and
 *    schedules the transaction's re-evaluation.
 *  - D206(3): R01's engine epoch. A behavioural re-pin (epoch bump) makes the next evaluation material once, so
 *    `drafts.prepareSend` refuses the draft approved before it; a hash-only re-pin (D204-style) bumps nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEpoch } from "./lib/rules/engineEpochs";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
const EPOCHS: EngineEpoch[] = vi.hoisted(() => []);
vi.mock("./lib/rules/engineEpochs", () => ({ ENGINE_EPOCHS: EPOCHS }));

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluatePurchase } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";
import { AIR_VOUCHER_ACCEPTANCE } from "./lib/facts/keys_air";
import { R02_V1_RULE_ID } from "./lib/rules/r02_air_refund_v1";
import { R01_V1_RULE_ID } from "./lib/rules/r01_price_adjustment_v1";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";

type T = ReturnType<typeof setup>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);

afterEach(() => {
  EPOCHS.length = 0;
  resetTestRegistry();
});

describe("DA-A-18 (D204): a non-cash resolution on an R02 case writes the acceptance fact", () => {
  pinClockEach(NOW);

  it("voucher accepted → air.consumer_response = accepted_compensation (user_confirmed, the earlier answer superseded); re-evaluation scheduled", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { transactionId, claimId } = await t.run(async (ctx) => {
      const transactionId = await ctx.db.insert("transactions", {
        userId, category: "air_travel", status: "active", counterpartyName: "Example Air", currency: "USD", liveFactCount: 1,
      });
      await ctx.db.insert("facts", {
        userId, transactionId, subjectKey: "txn", key: "air.consumer_response", state: "user_confirmed",
        value: { kind: "code", code: "rejected" }, source: { kind: "user" }, recordedAt: NOW - DAY,
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        userId, transactionId, scenarioId: "R02", remedyKey: "fare_refund", subjectKey: "txn", dedupeKey: `${transactionId}|R02|fare_refund|txn|-`,
        status: "case_open", ruleId: R02_V1_RULE_ID, ruleVersion: 1, outcome: "eligible", authorityClass: "legal_entitlement",
        remedyType: "cash_refund", cashClass: "cash", estimate: { amountMinor: 41_220, currency: "USD" }, lossKeys: [`txn:${transactionId}:paid`],
        lastEvaluatedAt: NOW - DAY,
      });
      const claimId = await ctx.db.insert("claims", {
        userId, type: "scenario", expectedCents: 41_220, status: "sent", token: "AIR123", version: 1, transactionId, opportunityId,
        scenarioId: "R02", remedyKey: "fare_refund", currency: "USD", lossKeys: [`txn:${transactionId}:paid`], requiredChannel: "email", caseMode: "request",
      });
      await ctx.db.patch(opportunityId, { activeClaimId: claimId });
      return { transactionId, claimId };
    });
    await as.mutation(api.claims.recordNonCashResolution, { claimId, kind: "voucher", description: "Travel credit, 12 months", idempotencyKey: "v" });
    const rows = await t.run((ctx) =>
      ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId).eq("subjectKey", "txn").eq("key", AIR_VOUCHER_ACCEPTANCE.key)).collect());
    const live = rows.filter((r) => r.state === "user_confirmed");
    expect(live.map((r) => r.value)).toEqual([AIR_VOUCHER_ACCEPTANCE.value]);
    expect(rows.find((r) => r.value.kind === "code" && r.value.code === "rejected")?.state).toBe("superseded");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((s) => s.name)).toContain("opportunities:evaluateInternal");
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.nonCashResolvedAt).toBe(NOW);
  });
});

describe("D206(3): R01 engine epoch — only a behavioural re-pin invalidates an approval", () => {
  pinClockEach(NOW);
  const DOMAIN = "acme.example";
  const CONTACT = "help@acme.example";
  const BODY = "Hello, the Jacket I bought is now listed lower. Could you refund the $25.00 difference? Thank you.";

  async function world(t: T, userId: Id<"users">) {
    return await t.run(async (ctx) => {
      await ctx.db.insert("profiles", { userId, inboxId: "inbox_1", inboxEmail: "me@agentmail.to" });
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: DOMAIN, purchasedAt: NOW - 2 * DAY, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: `https://${DOMAIN}/p`, returned: false });
      const priceCheckId = await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.92, variantMatch: "exact", observedAt: NOW - 60_000, sourceUrl: `https://${DOMAIN}/p` });
      const policyId = await ctx.db.insert("policies", {
        userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: 14, channel: "email", contactEmail: CONTACT,
        passage: "We adjust the price within 14 days.", sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: NOW - 2 * DAY, confidence: 0.9, confirmedByUser: true,
      });
      await ensurePurchaseTransaction(ctx, purchaseId);
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "detected", token: "AB12CD", version: 1,
        windowEndsAt: NOW + 12 * DAY, policyId, openedFromPriceCheckId: priceCheckId,
      });
      await evaluatePurchase(ctx, purchaseId, "user_request", NOW);
      return { purchaseId, claimId };
    });
  }
  const reevaluate = (t: T, purchaseId: Id<"purchases">) => t.run(async (ctx) => { await evaluatePurchase(ctx, purchaseId, "rule_version", NOW); });

  it("epoch bump → one material bump, prepareSend refuses; a hash-only re-pin → no bump, prepareSend still ok", async () => {
    const t = setup();
    setTestActivations([{ ruleId: R01_V1_RULE_ID, version: 1, status: "active", decision: "TEST" }]);
    EPOCHS.push({ ruleId: R01_V1_RULE_ID, version: 1, engineEpoch: 1, engineClosureSha256: "a".repeat(64) });
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    const draftId = (await t.mutation(internal.drafts.insert, { claimId: w.claimId, userId, to: CONTACT, subject: "Price adjustment", body: BODY }))!;
    const prepare = () => as.mutation(api.drafts.prepareSend, { draftId, to: CONTACT, subject: "Price adjustment", body: BODY });
    expect((await prepare()).ok).toBe(true);
    const evals = await t.run((ctx) => ctx.db.query("evaluations").collect());
    expect(evals.every((e) => e.engineVersion === `${R01_V1_RULE_ID}@v1/e1`)).toBe(true);

    EPOCHS[0] = { ...EPOCHS[0], engineClosureSha256: "b".repeat(64) }; // hash-only (D204-style)
    await reevaluate(t, w.purchaseId);
    expect((await prepare()).ok).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(w.claimId)))!.version).toBe(1);

    EPOCHS[0] = { ...EPOCHS[0], engineEpoch: 2 }; // behavioural re-pin
    await reevaluate(t, w.purchaseId);
    await reevaluate(t, w.purchaseId);
    const claim = (await t.run((ctx) => ctx.db.get(w.claimId)))!;
    expect(claim.version).toBe(2);
    const notes = await t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", w.claimId)).collect());
    expect(notes.filter((n) => /evaluation engine changed/.test(n.text))).toHaveLength(1);
    expect(await prepare()).toMatchObject({ ok: false });
  });
});

describe("DA-B-16 / DA-B-17 (D223): a gift card that came back instead of cash", () => {
  pinClockEach(NOW);

  async function legacyClaim(t: T, userId: Id<"users">, currency: string) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency, status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Mug", unitCents: 2_500, qty: 1, returned: true });
      return await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "return_credit", expectedCents: 2_500, status: "detected", token: `GC${currency}`, version: 1 });
    });
  }

  it("DA-B-16: recordNonCashResolution closes the claim for ask — Ready 2,500 → 0, the remedy recorded, reminders cancelled", async () => {
    const t = setup();
    setTestActivations([]);
    const { userId, as } = await signedIn(t);
    const claimId = await legacyClaim(t, userId, "USD");
    await t.run(async (ctx) => {
      const claim = (await ctx.db.get(claimId))!;
      const { scheduleClaimReminder } = await import("./followUps");
      await scheduleClaimReminder(ctx, claim);
    });
    const before = await as.query(api.recovery.summary, { now: NOW });
    expect(before.currencies[0].tiles.ready.amountMinor).toBe(2_500);
    await as.mutation(api.claims.recordNonCashResolution, {
      claimId, kind: "other", description: "Gift card", faceValue: { amountMinor: 2_500, currency: "USD" }, idempotencyKey: "gc",
    });
    const after = await as.query(api.recovery.summary, { now: NOW });
    const usd = after.currencies.find((c) => c.currency === "USD");
    expect(usd?.tiles.ready.amountMinor ?? 0).toBe(0);
    expect(after.nonCash).toEqual([{ kind: "other", count: 1 }]);
    const followUps = await t.run((ctx) => ctx.db.query("followUps").collect());
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps.every((f) => f.status === "cancelled")).toBe(true);
    const remedy = (await t.run((ctx) => ctx.db.query("nonCashRemedies").collect()))[0];
    expect(remedy).toMatchObject({ kind: "other", state: "received", faceValue: { amountMinor: 2_500, currency: "USD" } });
  });

  it("DA-B-17: a face value in a non-two-decimal currency is refused (never stored in a unit that displays wrong); words still work", async () => {
    const t = setup();
    setTestActivations([]);
    const { userId, as } = await signedIn(t);
    const claimId = await legacyClaim(t, userId, "JPY");
    await expect(as.mutation(api.claims.recordNonCashResolution, {
      claimId, kind: "other", description: "Gift card ¥1,200", faceValue: { amountMinor: 120_000, currency: "JPY" }, idempotencyKey: "gc",
    })).rejects.toThrow(/cannot record an amount in JPY/);
    await expect(as.mutation(api.claims.recordNonCashRemedy, {
      claimId, kind: "other", description: "Gift card ¥1,200", faceValue: { amountMinor: 1_200, currency: "JPY" }, state: "received", idempotencyKey: "gc2",
    })).rejects.toThrow(/cannot record an amount in JPY/);
    expect(await t.run((ctx) => ctx.db.query("nonCashRemedies").collect())).toEqual([]);
    await as.mutation(api.claims.recordNonCashResolution, { claimId, kind: "other", description: "Gift card ¥1,200", idempotencyKey: "gc3" });
    const remedy = (await t.run((ctx) => ctx.db.query("nonCashRemedies").collect()))[0];
    expect(remedy.faceValue).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.nonCashResolvedAt).toBe(NOW);
  });
});
