/// <reference types="vite/client" />
/**
 * M20 (wave 2): scenario cases on a manual channel, end to end through the public mutations — the facts adapter
 * (D208), `openCase` → `claims.insertScenarioClaim` (item-less, pack-gated, D206), packets (§6 "Manual approval",
 * DA-A-15, SEC-AI-4, N6), recorded submissions (DA-A-10), N3 withdrawal → `rule_withdrawn` once then legacy handling,
 * denial (§5) and the refused tile (D206), non-cash resolution (DA-A-18), the D206(3) engine epoch, reevaluateAt
 * (rev 5.2), and two-user isolation for every new public function. A fake pack stands in through the registry and
 * template seams (`testing/scenarioPack.kit`), so no real wave-2 pack needs to be active.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEpoch } from "./lib/rules/engineEpochs";

vi.mock("./lib/rules/registry", async () => await import("./testing/scenarioPack.kit"));
vi.mock("./lib/packets/index", async () => await import("./testing/scenarioPack.kit"));
const EPOCHS: EngineEpoch[] = vi.hoisted(() => []);
vi.mock("./lib/rules/engineEpochs", () => ({ ENGINE_EPOCHS: EPOCHS }));

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn, twoUsers } from "./test.setup";
import { evaluateTransaction } from "./opportunities";
import { insertScenarioClaim } from "./claims";
import { FAKE_RULE_ID, FAKE_TEXT_BLOCK, setFakeActive, TXN } from "./testing/scenarioPack.kit";
import type { FactValue } from "./lib/rules/types";
import { hasLegacyIds, legacyIds } from "./lib/legacyClaim";

type T = ReturnType<typeof setup>;
type As = Awaited<ReturnType<typeof signedIn>>["as"];
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);
const RECIPIENT = "First Bank Billing Disputes\nPO Box 100\nWilmington, DE 19801";

afterEach(() => {
  setFakeActive(true);
  EPOCHS.length = 0;
});

const money = (amountMinor: number): FactValue => ({ kind: "money", amountMinor, currency: "USD" });
const text = (t: string): FactValue => ({ kind: "text", text: t });

function baseFacts(over: Record<string, FactValue | null> = {}): Record<string, FactValue> {
  const all: Record<string, FactValue | null> = { "test.amount": money(40_000), "test.recipient": text(RECIPIENT), "test.ref": text("STMT-2026-0915"), ...over };
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, FactValue] => e[1] !== null));
}

/** A card_charge transaction with transaction-level facts, evaluated once (the fake pack's opportunity exists). */
async function seed(t: T, userId: Id<"users">, facts = baseFacts()) {
  return await t.run(async (ctx) => {
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "card_charge", status: "active", counterpartyName: "First Bank", currency: "USD", liveFactCount: Object.keys(facts).length,
    });
    for (const [key, value] of Object.entries(facts)) {
      await ctx.db.insert("facts", { userId, transactionId, subjectKey: TXN, key, state: "user_confirmed", value, source: { kind: "user" }, recordedAt: NOW - DAY });
    }
    await evaluateTransaction(ctx, transactionId, "user_request", NOW);
    return transactionId;
  });
}

async function setFact(t: T, userId: Id<"users">, transactionId: Id<"transactions">, key: string, value: FactValue) {
  await t.run(async (ctx) => {
    const old = await ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId).eq("subjectKey", TXN).eq("key", key)).collect();
    for (const r of old) await ctx.db.patch(r._id, { state: "superseded" });
    await ctx.db.insert("facts", { userId, transactionId, subjectKey: TXN, key, state: "user_confirmed", value, source: { kind: "user" }, recordedAt: Date.now() });
  });
}

const oppOf = (t: T, transactionId: Id<"transactions">) =>
  t.run(async (ctx) => (await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect())[0]);
const claimOf = (t: T, id: Id<"claims">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const notesOf = (t: T, id: Id<"claims">) => t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", id)).collect());

async function openScenario(t: T, as: As, transactionId: Id<"transactions">) {
  const opp = await oppOf(t, transactionId);
  const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
  if (!opened.ok) throw new Error(opened.message);
  return opened.claimId;
}

async function prepared(as: As, claimId: Id<"claims">) {
  const r = await as.mutation(api.packets.prepare, { claimId });
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.packetId;
}

async function approveShown(as: As, packetId: Id<"packets">, over: Record<string, unknown> = {}) {
  const view = await as.query(api.packets.get, { packetId });
  return await as.mutation(api.packets.approve, { packetId, approvedHash: view.renderedHash, ...over });
}

/** Owner, a scenario case with an approved packet. */
async function approvedCase(t: T, facts = baseFacts()) {
  const { userId, as } = await signedIn(t);
  const transactionId = await seed(t, userId, facts);
  const claimId = await openScenario(t, as, transactionId);
  const packetId = await prepared(as, claimId);
  expect(await approveShown(as, packetId)).toEqual({ ok: true });
  return { userId, as, transactionId, claimId, packetId };
}

const summaryUsd = async (as: As) => (await as.query(api.recovery.summary, { now: Date.now() })).currencies.find((c) => c.currency === "USD");

describe("D208 adapter + openCase → insertScenarioClaim (D206: item-less, pack-gated)", () => {
  pinClockEach(NOW);

  it("the facts adapter evaluates the transaction; openCase writes an item-less scenario claim on a manual channel", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const opp = await oppOf(t, transactionId);
    expect(opp).toMatchObject({ ruleId: FAKE_RULE_ID, outcome: "eligible", estimate: { amountMinor: 40_000, currency: "USD" }, status: "open" });
    const claimId = await openScenario(t, as, transactionId);
    const claim = await claimOf(t, claimId);
    expect(claim).toMatchObject({
      type: "scenario", status: "detected", expectedCents: 40_000, currency: "USD", transactionId, opportunityId: opp._id,
      scenarioId: "R13", remedyKey: "billing_correction", lossKeys: [`txn:${transactionId}:paid`], requiredChannel: "postal_mail", caseMode: "request",
    });
    expect([claim.purchaseId, claim.itemId]).toEqual([undefined, undefined]);
    expect(hasLegacyIds(claim)).toBe(false);
    expect(() => legacyIds(claim)).toThrow("This claim has no purchase or item");
    expect(await oppOf(t, transactionId)).toMatchObject({ status: "case_open", activeClaimId: claimId });
    // claims.get works for an item-less claim: no item or purchase, the transaction instead.
    const view = await as.query(api.claims.get, { claimId });
    expect([view.item, view.purchase, view.transaction?._id]).toEqual([null, null, transactionId]);
  });

  it("no public path creates an item-less claim unless its pack is active: inactive → no opportunity, no claim; the writer refuses", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    setFakeActive(false);
    const transactionId = await seed(t, userId);
    expect(await oppOf(t, transactionId)).toBeFalsy();
    // Active long enough to create the opportunity, then withdrawn: openCase supersedes it and opens nothing.
    setFakeActive(true);
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "user_request", NOW); });
    const opp = await oppOf(t, transactionId);
    setFakeActive(false);
    expect(await as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).toMatchObject({ ok: false });
    await expect(
      t.run((ctx) => insertScenarioClaim(ctx, {
        userId, transactionId, opportunityId: opp._id, ruleId: FAKE_RULE_ID, ruleVersion: 1, scenarioId: "R13", remedyKey: "billing_correction",
        expectedMinor: 40_000, currency: "USD", lossKeys: ["k"], requiredChannel: "postal_mail", caseMode: "request",
      })),
    ).rejects.toThrow("This path is not checked by an active rule");
    expect(await t.run((ctx) => ctx.db.query("claims").collect())).toEqual([]);
  });

  it("the only production writer of a `scenario` claim is claims.insertScenarioClaim (grep)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.resolve(__dirname);
    const writers = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.includes(".test.") && !f.includes(".kit."))
      .filter((f) => /type:\s*"scenario"/.test(readFileSync(path.join(dir, f), "utf8")));
    expect(writers).toEqual(["claims.ts"]);
  });
});

describe("§6 packets and DA-A-10 submissions", () => {
  pinClockEach(NOW);

  it("prepare renders the pack template from bound facts only; approve → packet_prepared; record → packet, Asked", async () => {
    const t = setup();
    const { as, transactionId, claimId, packetId } = await approvedCase(t);
    const view = await as.query(api.packets.get, { packetId });
    expect(view.packet).toMatchObject({ version: 1, channel: "postal_mail", status: "approved", templateId: "fake.letter" });
    expect(view.packet.recipient).toEqual({ text: RECIPIENT, source: "rule_pack" });
    expect(view.packet.body).toContain("I dispute USD 400.00.");
    expect(view.packet.body).toContain(FAKE_TEXT_BLOCK);
    expect(view.packet.binding).toMatchObject({ claimVersion: 1, amount: { amountMinor: 40_000, currency: "USD" }, ruleId: FAKE_RULE_ID });
    const rec = await as.mutation(api.submissions.record, { packetId, submittedAt: NOW, confirmationRef: "USPS 9400 1000" });
    expect(rec).toMatchObject({ ok: true, staleAtRecord: false, deduped: false });
    expect((await claimOf(t, claimId)).status).toBe("packet");
    expect((await summaryUsd(as))?.tiles.asked).toEqual({ amountMinor: 40_000, provisionalMinor: 0, components: 1 });
    // Idempotent: recording the same packet again returns the first record.
    const again = await as.mutation(api.submissions.record, { packetId, submittedAt: NOW });
    expect(again).toMatchObject({ ok: true, deduped: true, submissionId: rec.ok ? rec.submissionId : undefined });
    expect(await t.run((ctx) => ctx.db.query("submissions").collect())).toHaveLength(1);
    expect(transactionId).toBeDefined();
  });

  it("approve → a ledger event → record still succeeds, flagged staleAtRecord, with a note and a review prompt", async () => {
    const t = setup();
    const { userId, as, claimId, packetId } = await approvedCase(t);
    await t.mutation(internal.claims.applyEventInternal, { claimId, userId, kind: "promised_credit", cents: 40_000, evidence: "bank letter", idempotencyKey: "p1" });
    const rec = await as.mutation(api.submissions.record, { packetId, submittedAt: NOW });
    expect(rec).toMatchObject({ ok: true, staleAtRecord: true });
    const claim = await claimOf(t, claimId);
    expect(claim.attentionAt).toBe(NOW);
    expect(claim.status).toBe("promised"); // a later status is kept; `packet` only from detected/drafted/queued
    expect((await notesOf(t, claimId)).some((n) => /changed after you approved/.test(n.text))).toBe(true);
    const sub = (await t.run((ctx) => ctx.db.query("submissions").collect()))[0];
    expect(sub.staleAtRecord).toBe(true);
  });

  it("approve → the user deadline passes → record succeeds, flagged, and submittedAt shows against the deadline", async () => {
    const t = setup();
    const due = NOW + DAY;
    const { as, packetId } = await approvedCase(t, baseFacts({ "test.due": { kind: "instant", epochMs: due } }));
    vi.setSystemTime(NOW + 2 * DAY);
    const rec = await as.mutation(api.submissions.record, { packetId, submittedAt: NOW + 2 * DAY - 3_600_000 });
    expect(rec).toMatchObject({ ok: true, staleAtRecord: true, deadline: { id: "fake.notice", dueAt: due, late: true } });
  });

  it("approve refuses: a changed hash, no recipient, changed evidence, not the newest version, an example claim", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId, baseFacts({ "test.recipient": null }));
    const claimId = await openScenario(t, as, transactionId);
    const p1 = await prepared(as, claimId);
    expect(await as.mutation(api.packets.approve, { packetId: p1, approvedHash: "0".repeat(64) })).toMatchObject({ ok: false, code: "hash_mismatch" });
    expect(await approveShown(as, p1)).toMatchObject({ ok: false, code: "no_recipient" });
    const evidenceId = await t.run((ctx) => ctx.db.insert("evidence", {
      userId, transactionId, kind: "upload", docType: "card_statement", sourceChannel: "upload", provenance: "user_uploaded",
      contentHash: "a".repeat(64), receivedAt: NOW, extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
    }));
    const p2 = await as.mutation(api.packets.update, {
      packetId: p1, recipient: { text: "Billing Disputes, PO Box 9", source: "user_entered" }, evidence: [{ evidenceId, label: "September statement" }],
    });
    expect(await approveShown(as, p1)).toMatchObject({ ok: false, code: "not_newest" });
    await t.run((ctx) => ctx.db.patch(evidenceId, { contentHash: "b".repeat(64) }));
    expect(await approveShown(as, p2)).toMatchObject({ ok: false, code: "evidence_changed" });
    await t.run((ctx) => ctx.db.patch(evidenceId, { contentHash: "a".repeat(64) }));
    expect(await approveShown(as, p2)).toEqual({ ok: true });
    await t.run((ctx) => ctx.db.patch(claimId, { isExample: true }));
    expect(await as.mutation(api.packets.prepare, { claimId })).toMatchObject({ ok: false, code: "example_claim" });
  });

  it("SEC-AI-4: an edited body stating an unknown amount or address needs the acknowledgment of exactly those findings", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const claimId = await openScenario(t, as, transactionId);
    const p1 = await prepared(as, claimId);
    const view = await as.query(api.packets.get, { packetId: p1 });
    const p2 = await as.mutation(api.packets.update, { packetId: p1, body: `${view.packet.body}\nAlso refund $999.00 to pay@evil.example.` });
    const refused = await approveShown(as, p2);
    expect(refused).toMatchObject({ ok: false, code: "unverified_content" });
    if (refused.ok || refused.code !== "unverified_content") throw new Error("expected unverified_content");
    expect(refused.findings).toEqual(expect.arrayContaining(["email pay@evil.example", "amount $999.00"]));
    // The pack's verbatim text block and the bound amount are never findings.
    expect(refused.findings!.some((f) => f.includes("30 days") || f.includes("400.00"))).toBe(false);
    expect(await approveShown(as, p2, { acknowledgeUnverifiedContent: true, acknowledgedFindingsHash: "x" })).toMatchObject({ code: "unverified_content" });
    expect(await approveShown(as, p2, { acknowledgeUnverifiedContent: true, acknowledgedFindingsHash: refused.findingsHash })).toEqual({ ok: true });
  });

  it("a claim change after prepare → binding_changed; record before approval is refused", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const claimId = await openScenario(t, as, transactionId);
    const p1 = await prepared(as, claimId);
    await expect(as.mutation(api.submissions.record, { packetId: p1, submittedAt: NOW })).rejects.toThrow("Approve this packet");
    await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 30_000, reason: "part was refunded" });
    expect(await approveShown(as, p1)).toMatchObject({ ok: false, code: "binding_changed" });
  });

  it("N6: packets.get shows the binding evaluation's boundFacts — the approved values, even after the facts change", async () => {
    const t = setup();
    const { userId, as, transactionId, packetId } = await approvedCase(t);
    const view = await as.query(api.packets.get, { packetId });
    const evaluation = await t.run(async (ctx) => (await ctx.db.get(view.packet.binding.evaluationId!))!);
    expect(view.boundFacts).toEqual(evaluation.boundFacts);
    expect(view.boundFacts).toContainEqual({ subjectKey: TXN, key: "test.amount", status: "confirmed", value: money(40_000) });
    await setFact(t, userId, transactionId, "test.ref", text("STMT-CORRECTED"));
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "fact_change", NOW); });
    const after = await as.query(api.packets.get, { packetId });
    expect(after.boundFacts).toContainEqual({ subjectKey: TXN, key: "test.ref", status: "confirmed", value: text("STMT-2026-0915") });
  });
});

describe("N3: a withdrawn pack → rule_withdrawn once, then the legacy path", () => {
  pinClockEach(NOW);

  it("submissions.record: first call rule_withdrawn (superseded, version bumped once), then records under the legacy path", async () => {
    const t = setup();
    const { as, transactionId, claimId, packetId } = await approvedCase(t);
    setFakeActive(false);
    expect(await as.mutation(api.submissions.record, { packetId, submittedAt: NOW })).toMatchObject({ ok: false, code: "rule_withdrawn" });
    expect((await oppOf(t, transactionId)).status).toBe("superseded");
    expect((await claimOf(t, claimId)).version).toBe(2);
    const second = await as.mutation(api.submissions.record, { packetId, submittedAt: NOW });
    expect(second).toMatchObject({ ok: true, staleAtRecord: true, deadline: null });
    expect((await claimOf(t, claimId)).version).toBe(2); // bumped exactly once
  });

  it("packets.approve: first call rule_withdrawn; the legacy re-prepare binds no evaluation and approves", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const claimId = await openScenario(t, as, transactionId);
    const p1 = await prepared(as, claimId);
    setFakeActive(false);
    expect(await approveShown(as, p1)).toMatchObject({ ok: false, code: "rule_withdrawn" });
    expect(await approveShown(as, p1)).toMatchObject({ ok: false, code: "binding_changed" });
    const p2 = await prepared(as, claimId);
    const view = await as.query(api.packets.get, { packetId: p2 });
    expect(view.packet.binding.evaluationId).toBeUndefined();
    expect(view.boundFacts).toBeNull();
    expect(view.packet.body).toContain("I dispute USD 400.00."); // rendered from the last recorded evaluation
    expect(await approveShown(as, p2)).toEqual({ ok: true });
  });
});

describe("§5 denied, and the refused tile (D206)", () => {
  pinClockEach(NOW);

  async function submitted(t: T) {
    const c = await approvedCase(t);
    await c.as.mutation(api.submissions.record, { packetId: c.packetId, submittedAt: NOW });
    return c;
  }

  it("refused (a refusal reply, no denial recorded) → recordDenial → closed for ask, in no tile; the opportunity reopens", async () => {
    const t = setup();
    const { userId, as, transactionId, claimId } = await submitted(t);
    await t.run((ctx) => ctx.db.insert("replies", { claimId, userId, messageId: "m1", from: "billing@bank.example", classification: "refusal", summary: "no", senderMismatch: false, receivedAt: NOW }));
    expect((await summaryUsd(as))?.tiles.refused.amountMinor).toBe(40_000);
    await as.mutation(api.claims.recordDenial, { claimId, reason: "The bank says the charge was valid" });
    const claim = await claimOf(t, claimId);
    expect(claim.status).toBe("denied");
    expect(claim.version).toBe(2);
    // The denied CLAIM is in no tile (closed for ask). Its opportunity reopens (§2.8 Closing) but is NOT Potential money
    // on the same basis (D226): nothing of the 40,000 shows anywhere.
    const usd = await summaryUsd(as);
    for (const tile of ["potential", "ready", "sendingOrUnknown", "asked", "refused", "promised"] as const) {
      expect(usd?.tiles[tile].components ?? 0, tile).toBe(0);
    }
    const opp = await oppOf(t, transactionId);
    expect([opp.status, opp.activeClaimId, opp.deniedAt]).toEqual(["open", undefined, NOW]);
    expect(await t.run((ctx) => ctx.db.query("followUps").collect())).toSatisfy((rows: Doc<"followUps">[]) => rows.every((r) => r.status !== "pending"));
  });

  it("D226: a denied loss stays out of Potential on the same basis; a material re-evaluation makes it count again", async () => {
    const t = setup();
    const { userId, as, transactionId, claimId } = await submitted(t);
    await as.mutation(api.claims.recordDenial, { claimId, reason: "The bank says the charge was valid" });
    const potential = async () => (await summaryUsd(as))?.tiles.potential.amountMinor ?? 0;
    expect(await potential()).toBe(0); // at once, before any re-evaluation
    // The first evaluation without the case (scheduled by recordDenial; run here) records the denied basis.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((f) => f.name)).toContain("opportunities:evaluateInternal");
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "fact_change", NOW, { subjects: [TXN] }); });
    const opp = await oppOf(t, transactionId);
    const current = await t.run(async (ctx) => (await ctx.db.get(opp.currentEvaluationId!))!);
    expect(opp.deniedResultHash).toBe(current.resultHash);
    expect(await potential()).toBe(0);
    // The same facts again: same resultHash, still not Potential.
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "user_request", NOW); });
    expect(await potential()).toBe(0);
    // A material change (a different amount on new facts): it counts again.
    await setFact(t, userId, transactionId, "test.amount", money(45_000));
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "fact_change", NOW); });
    expect(await potential()).toBe(45_000);
  });

  it("money after a denial: a promise → promised (case relinked); a settling credit → confirmed (opportunity closed)", async () => {
    const t = setup();
    const { userId, as, transactionId, claimId } = await submitted(t);
    await as.mutation(api.claims.recordDenial, { claimId, reason: "refused" });
    await t.mutation(internal.claims.applyEventInternal, { claimId, userId, kind: "promised_credit", cents: 40_000, evidence: "reversed", idempotencyKey: "p" });
    expect((await claimOf(t, claimId)).status).toBe("promised");
    const relinked = await oppOf(t, transactionId);
    expect([relinked.status, relinked.activeClaimId, relinked.deniedAt]).toEqual(["case_open", claimId, undefined]); // D226 markers cleared
    expect((await summaryUsd(as))?.tiles.promised.amountMinor).toBe(40_000);
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 40_000, evidence: "posted", idempotencyKey: "c" });
    expect((await claimOf(t, claimId)).status).toBe("confirmed");
    const closed = await oppOf(t, transactionId);
    expect([closed.status, closed.activeClaimId]).toEqual(["closed", undefined]);
  });

  it("denied only from sent/packet/promised/reopened; a denied claim can be dismissed; dismissed stays terminal", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const claimId = await openScenario(t, as, transactionId);
    await expect(as.mutation(api.claims.recordDenial, { claimId, reason: "x" })).rejects.toThrow(/sent, submitted or promised/);
    await t.run((ctx) => ctx.db.patch(claimId, { status: "sent" }));
    await expect(as.mutation(api.claims.recordDenial, { claimId, reason: "  " })).rejects.toThrow(/what the answer was/);
    await as.mutation(api.claims.recordDenial, { claimId, reason: "no" });
    await as.mutation(api.claims.dismiss, { claimId });
    expect((await claimOf(t, claimId)).status).toBe("dismissed");
    await expect(as.mutation(api.claims.recordDenial, { claimId, reason: "no" })).rejects.toThrow();
  });
});

describe("DA-A-18 recordNonCashResolution", () => {
  pinClockEach(NOW);

  it("a voucher on 40,000 → Asked 0, Non-cash 1, reminders cancelled, the case and opportunity closed; idempotent", async () => {
    const t = setup();
    const { as, transactionId, claimId, packetId } = await approvedCase(t);
    await as.mutation(api.submissions.record, { packetId, submittedAt: NOW });
    expect((await summaryUsd(as))?.tiles.asked.amountMinor).toBe(40_000);
    expect((await t.run((ctx) => ctx.db.query("followUps").collect())).some((f) => f.status === "pending")).toBe(true);
    const args = { claimId, kind: "voucher" as const, description: "Store voucher, expires 2027-01-31", faceValue: { amountMinor: 40_000, currency: "USD" }, idempotencyKey: "v1" };
    const first = await as.mutation(api.claims.recordNonCashResolution, args);
    expect(first.deduped).toBe(false);
    const s = await as.query(api.recovery.summary, { now: NOW });
    const usd = s.currencies.find((c) => c.currency === "USD");
    expect(usd?.tiles.asked.amountMinor ?? 0).toBe(0);
    expect(usd?.recoveredMinor ?? 0).toBe(0); // non-cash never enters a cash total
    expect(s.nonCash).toEqual([{ kind: "voucher", count: 1 }]);
    expect((await t.run((ctx) => ctx.db.query("followUps").collect())).every((f) => f.status !== "pending")).toBe(true);
    expect((await claimOf(t, claimId)).nonCashResolvedAt).toBe(NOW);
    expect(await oppOf(t, transactionId)).toMatchObject({ status: "closed" });
    expect(await as.mutation(api.claims.recordNonCashResolution, args)).toEqual({ deduped: true, remedyId: first.remedyId });
    await expect(as.mutation(api.claims.recordNonCashResolution, { ...args, idempotencyKey: "v2" })).rejects.toThrow(/already resolved/);
    expect(await t.run((ctx) => ctx.db.query("nonCashRemedies").collect())).toHaveLength(1);
  });
});

describe("D206(3) engine epoch: only a behavioural re-pin invalidates approvals", () => {
  pinClockEach(NOW);

  it("an epoch bump → one material bump and packets.approve refuses; a hash-only re-pin → no bump", async () => {
    const t = setup();
    EPOCHS.push({ ruleId: FAKE_RULE_ID, version: 1, engineEpoch: 1, engineClosureSha256: "a".repeat(64) });
    const { userId, as } = await signedIn(t);
    const transactionId = await seed(t, userId);
    const claimId = await openScenario(t, as, transactionId);
    const packetId = await prepared(as, claimId);
    expect((await as.query(api.packets.get, { packetId })).packet.binding.engineVersion).toBe(`${FAKE_RULE_ID}@v1/e1`);
    // Hash-only re-pin (D204-style): the epoch stays; nothing is material.
    EPOCHS[0] = { ...EPOCHS[0], engineClosureSha256: "b".repeat(64) };
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "rule_version", NOW); });
    expect((await claimOf(t, claimId)).version).toBe(1);
    // Behavioural re-pin: epoch 2 → the next evaluation is material once; the approval is refused.
    EPOCHS[0] = { ...EPOCHS[0], engineEpoch: 2 };
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "rule_version", NOW); });
    await t.run(async (ctx) => { await evaluateTransaction(ctx, transactionId, "rule_version", NOW); });
    expect((await claimOf(t, claimId)).version).toBe(2);
    expect((await notesOf(t, claimId)).filter((n) => /evaluation engine changed/.test(n.text))).toHaveLength(1);
    expect(await approveShown(as, packetId)).toMatchObject({ ok: false, code: "binding_changed" });
  });
});

describe("rev 5.2 reevaluateAt and the sweep stub", () => {
  pinClockEach(NOW);

  it("not_yet_due with reevaluate.at → opportunities.reevaluateAt; the sweep evaluates due ones only", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const transactionId = await seed(t, userId, baseFacts({ "test.outcome": { kind: "code", code: "not_yet_due" } }));
    const opp = await oppOf(t, transactionId);
    expect(opp).toMatchObject({ outcome: "not_yet_due", reevaluateAt: Date.UTC(2026, 9, 11) });
    expect(await t.mutation(internal.opportunities.sweepReevaluateDue, { now: Date.UTC(2026, 9, 10) })).toEqual({ transactions: 0 });
    await setFact(t, userId, transactionId, "test.outcome", { kind: "code", code: "eligible" });
    expect(await t.mutation(internal.opportunities.sweepReevaluateDue, { now: Date.UTC(2026, 9, 11) })).toEqual({ transactions: 1 });
    const after = await oppOf(t, transactionId);
    expect(after.outcome).toBe("eligible");
    expect(after.reevaluateAt).toBeUndefined();
  });
});

describe("D206 batch readers skip item-less claims (never throw)", () => {
  pinClockEach(NOW);

  it("insights.activity, tracking.overview, purchases.board and recovery.summary all serve a user with a scenario claim", async () => {
    const t = setup();
    const { as, claimId } = await approvedCase(t);
    const activity = await as.query(api.insights.activity, {});
    // M2C (D241): insights.activity handles item-less claims (optional ids + claimCurrency) instead of skipping them.
    expect(activity.events.find((e) => e.claimId === claimId && e.kind === "claim_opened")).toMatchObject({ currency: "USD", cents: 40_000, subject: "First Bank" });
    await expect(as.query(api.tracking.overview, { now: NOW })).resolves.toBeDefined();
    await expect(as.query(api.purchases.board, {})).resolves.toBeDefined();
    expect((await summaryUsd(as))?.tiles.ready.amountMinor).toBe(40_000); // detected, packet approved (not sent yet)
  });
});

describe("D220 opportunities.listMine (M24's /opportunities page)", () => {
  pinClockEach(NOW);

  it("owner-scoped: open and case_open with evaluation, transaction and category; status filter; inactive packs hidden", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    const transactionId = await seed(t, owner.userId);
    const listed = await owner.as.query(api.opportunities.listMine, {});
    expect(listed.truncated).toBe(false);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ transactionId, category: "card_charge", counterpartyName: "First Bank", opportunity: { status: "open" } });
    expect(listed.items[0].evaluation?._id).toBe(listed.items[0].opportunity.currentEvaluationId);
    expect(await other.as.query(api.opportunities.listMine, {})).toEqual({ items: [], truncated: false });
    const claimId = await openScenario(t, owner.as, transactionId);
    expect((await owner.as.query(api.opportunities.listMine, { statuses: ["open"] })).items).toEqual([]);
    expect((await owner.as.query(api.opportunities.listMine, { statuses: ["case_open"] })).items[0].opportunity.activeClaimId).toBe(claimId);
    setFakeActive(false);
    expect((await owner.as.query(api.opportunities.listMine, {})).items).toEqual([]);
  });
});

describe("two-user isolation: every new public function refuses another user's ids identically, writing nothing", () => {
  pinClockEach(NOW);

  it("claims.recordDenial / recordNonCashResolution, packets.*, submissions.*", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    const transactionId = await seed(t, owner.userId);
    const claimId = await openScenario(t, owner.as, transactionId);
    const packetId = await prepared(owner.as, claimId);
    expect(await approveShown(owner.as, packetId)).toEqual({ ok: true });
    const rec = await owner.as.mutation(api.submissions.record, { packetId, submittedAt: NOW });
    if (!rec.ok) throw new Error("record failed");
    const snapshot = async () => t.run(async (ctx) => ({
      claims: await ctx.db.query("claims").collect(), packets: await ctx.db.query("packets").collect(),
      submissions: await ctx.db.query("submissions").collect(), remedies: await ctx.db.query("nonCashRemedies").collect(),
      notes: (await ctx.db.query("claimNotes").collect()).length,
    }));
    const before = await snapshot();
    const o = other.as;
    await expect(o.mutation(api.claims.recordDenial, { claimId, reason: "x" })).rejects.toThrow("Claim not found");
    await expect(o.mutation(api.claims.recordNonCashResolution, { claimId, kind: "voucher", description: "v", idempotencyKey: "k" })).rejects.toThrow("Claim not found");
    await expect(o.mutation(api.packets.prepare, { claimId })).rejects.toThrow("Claim not found");
    await expect(o.mutation(api.packets.update, { packetId, body: "x" })).rejects.toThrow("Packet not found");
    await expect(o.mutation(api.packets.approve, { packetId, approvedHash: "x" })).rejects.toThrow("Packet not found");
    await expect(o.query(api.packets.get, { packetId })).rejects.toThrow("Packet not found");
    await expect(o.query(api.packets.listForClaim, { claimId })).rejects.toThrow("Claim not found");
    await expect(o.mutation(api.submissions.record, { packetId, submittedAt: NOW })).rejects.toThrow("Packet not found");
    await expect(o.mutation(api.submissions.recordDelivery, { submissionId: rec.submissionId, deliveredAt: NOW })).rejects.toThrow("Submission not found");
    expect(await snapshot()).toEqual(before);
    // The owner's own reads work.
    expect((await owner.as.query(api.packets.listForClaim, { claimId })).packets).toHaveLength(1);
    await owner.as.mutation(api.submissions.recordDelivery, { submissionId: rec.submissionId, deliveredAt: NOW });
    expect((await t.run((ctx) => ctx.db.get(rec.submissionId)))?.deliveryRecordedAt).toBe(NOW);
  });
});
