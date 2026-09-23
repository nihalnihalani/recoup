/// <reference types="vite/client" />
/**
 * M25 (contract §11.2 row M25; mission §17): wave-2 scenario slices end to end through M20's seams, written by QA from
 * the contract (§2.4 claims, §2.8 case opening, §3.4 totals, §5 transitions, §6 packets and recording), DA-A-9/-10/-18,
 * DA-B-16 and D204/D206/D226 — not from M20's tests or kit.
 *
 * No wave-2 pack is active (D228), so the slices run on QA's own harness pack (`testing/qaCardPack.kit.ts`,
 * `QA.R13.card_fix` v1, postal_mail) swapped in for the rule registry and the packet-template index. Every user step
 * is a PUBLIC function: `transactions.createManual` (the transaction and its user_confirmed card facts), `facts.answer`,
 * `opportunities.forTransaction` / `reevaluate` / `openCase`, `packets.prepare` / `get` / `update` / `approve`,
 * `submissions.record` / `recordDelivery`, `claims.confirmCredit` / `recordDenial` / `recordNonCashResolution`,
 * `claims.get`, `recovery.summary`. The only direct reads are `t.run` checks of stored rows.
 *
 * Money in `recovery.summary` is checked at every step: exactly one tile holds the open loss (§3.4 I3), Recovered and
 * the tiles never double count, a denied loss is out of every tile and out of Potential on the same basis (D226), and
 * a claim resolved with a non-cash remedy leaves the cash tiles and is counted as non-cash (DA-B-16, DA-A-18).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./testing/qaCardPack.kit"));
vi.mock("./lib/packets/index", async () => await import("./testing/qaCardPack.kit"));

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { QA_RULE_ID, QA_TEXT_BLOCK, setQaPackActive } from "./testing/qaCardPack.kit";

const NOW = Date.UTC(2026, 8, 24, 15);
const TILES = ["potential", "ready", "sendingOrUnknown", "asked", "refused", "promised"] as const;
type Tile = (typeof TILES)[number];

type T = ReturnType<typeof setup>;
type User = Awaited<ReturnType<typeof signedIn>>;

beforeEach(() => {
  // All timers faked (KX3): nothing a mutation schedules runs by itself; the tests flush runAfter(0) work explicitly.
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setQaPackActive(true);
});
afterEach(() => {
  vi.useRealTimers();
  setQaPackActive(true);
});

/** The USD row of `recovery.summary`: each tile's amount (only non-empty tiles listed), Recovered, and non-cash. */
async function money(u: User) {
  const s = await u.as.query(api.recovery.summary, { now: Date.now() });
  const usd = s.currencies.find((c: { currency: string }) => c.currency === "USD");
  const tiles: Partial<Record<Tile, number>> = {};
  let components = 0;
  if (usd) {
    for (const name of TILES) {
      const tile = (usd.tiles as Record<Tile, { amountMinor: number; components: number }>)[name];
      if (tile.components > 0) tiles[name] = tile.amountMinor;
      components += tile.components;
    }
  }
  return { tiles, components, recovered: usd?.recoveredMinor ?? 0, nonCash: s.nonCash };
}

/** A card charge entered by the user on /add, plus the answers a slice needs. */
async function cardCharge(u: User, o: { totalMinor?: number; address?: string | null } = {}) {
  const transactionId = await u.as.mutation(api.transactions.createManual, {
    category: "card_charge", counterpartyName: "NORTHWIND STORE", currency: "USD", totalMinor: o.totalMinor ?? 12_345, transactedOn: "2026-09-10",
  });
  if (o.address !== null) {
    await u.as.mutation(api.facts.answer, {
      transactionId, subjectKey: "txn", key: "card.billing_error_address", value: { kind: "text", text: o.address ?? "Billing Errors, PO Box 100, Wilmington DE 19801" },
    });
  }
  const view = await u.as.query(api.opportunities.forTransaction, { transactionId });
  const qa = view.opportunities.filter((x: { opportunity: Doc<"opportunities"> }) => x.opportunity.ruleId === QA_RULE_ID);
  expect(qa, "one harness opportunity on the transaction").toHaveLength(1);
  return { transactionId, opportunityId: qa[0].opportunity._id as Id<"opportunities">, evaluation: qa[0].evaluation as Doc<"evaluations"> };
}

async function openCase(u: User, opportunityId: Id<"opportunities">) {
  const r = await u.as.mutation(api.opportunities.openCase, { opportunityId });
  if (!r.ok) throw new Error(`openCase refused: ${r.code}`);
  return r.claimId as Id<"claims">;
}

/** prepare → get (the text the user reviews) → approve exactly that. */
async function preparedAndApproved(u: User, claimId: Id<"claims">) {
  const prepared = await u.as.mutation(api.packets.prepare, { claimId });
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  const view = await u.as.query(api.packets.get, { packetId: prepared.packetId });
  const approved = await u.as.mutation(api.packets.approve, { packetId: prepared.packetId, approvedHash: view.renderedHash });
  expect(approved).toEqual({ ok: true });
  return { packetId: prepared.packetId as Id<"packets">, view };
}

async function submitted(u: User, claimId: Id<"claims">) {
  const { packetId } = await preparedAndApproved(u, claimId);
  const r = await u.as.mutation(api.submissions.record, { packetId, submittedAt: Date.now() - 60_000, confirmationRef: "USPS 9400 1000 0000 0000 0000 00" });
  if (!r.ok) throw new Error(`record refused: ${r.code}`);
  return { packetId, submissionId: r.submissionId as Id<"submissions"> };
}

const claimRow = (t: T, claimId: Id<"claims">) => t.run(async (ctx) => (await ctx.db.get(claimId))!);
const oppRow = (t: T, id: Id<"opportunities">) => t.run(async (ctx) => (await ctx.db.get(id))!);

describe("slice 1: adapter → opportunity → openCase → packet → submission → credit (cash)", () => {
  it("each step moves the loss to exactly one tile, and the credit ends in Recovered with nothing left in a tile", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice One");

    // Adapter → opportunity: the user's own entry (user_confirmed facts) is evaluated by the harness pack.
    const { transactionId, opportunityId, evaluation } = await cardCharge(u);
    expect(evaluation).toMatchObject({ ruleId: QA_RULE_ID, outcome: "eligible", amount: { estimate: { amountMinor: 12_345, currency: "USD" } } });
    expect(await money(u)).toMatchObject({ tiles: { potential: 12_345 }, components: 1, recovered: 0 });

    // openCase → insertScenarioClaim: an item-less claim on the transaction, on the pack's manual channel.
    const claimId = await openCase(u, opportunityId);
    const claim = await claimRow(t, claimId);
    expect(claim).toMatchObject({
      transactionId, opportunityId, scenarioId: "R13", status: "detected", expectedCents: 12_345, currency: "USD",
      requiredChannel: "postal_mail", caseMode: "request", lossKeys: [`txn:${transactionId}:paid`],
    });
    expect(claim.purchaseId).toBeUndefined();
    expect(claim.itemId).toBeUndefined();
    expect((await oppRow(t, opportunityId)).activeClaimId).toBe(claimId);
    expect(await money(u)).toMatchObject({ tiles: { ready: 12_345 }, components: 1 }); // the case holds the loss once
    // A second openCase returns the same case (no second claim).
    expect(await u.as.mutation(api.opportunities.openCase, { opportunityId })).toMatchObject({ ok: true, claimId, created: false });

    // Packet: the template states only bound facts and the claim's own ask; the recipient comes from the pack.
    const { packetId, view } = await preparedAndApproved(u, claimId);
    expect(view.packet).toMatchObject({ channel: "postal_mail", version: 1, recipient: { source: "rule_pack", text: "Billing Errors, PO Box 100, Wilmington DE 19801" } });
    expect(view.packet.body).toContain(claim.token);
    expect(view.packet.body).toContain("USD 123.45"); // server text is locale-independent (D205)
    expect(view.packet.body).toContain(QA_TEXT_BLOCK);
    expect(view.boundFacts?.map((f: { key: string }) => f.key)).toEqual(expect.arrayContaining(["card.charge_amount", "card.billing_error_address"]));
    const approved = await t.run(async (ctx) => (await ctx.db.get(packetId))!);
    expect(approved).toMatchObject({ status: "approved", approvedHash: view.renderedHash });
    // An approved packet is prepared, not sent: still Ready (§3.4: packet_prepared is not asked).
    expect(await money(u)).toMatchObject({ tiles: { ready: 12_345 }, components: 1 });

    // Recording: the only way a scenario claim reaches `packet` (§5); a second record of the same packet is the first.
    const rec = await u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 60_000 });
    expect(rec).toMatchObject({ ok: true, staleAtRecord: false, deduped: false });
    if (!rec.ok) return;
    expect((await claimRow(t, claimId)).status).toBe("packet");
    expect(await u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 30_000 })).toMatchObject({ ok: true, submissionId: rec.submissionId, deduped: true });
    expect(await money(u)).toMatchObject({ tiles: { asked: 12_345 }, components: 1 });
    await u.as.mutation(api.submissions.recordDelivery, { submissionId: rec.submissionId, deliveredAt: NOW - 1_000 });
    expect(await money(u)).toMatchObject({ tiles: { asked: 12_345 }, components: 1 });

    // Ledger → Recovered: the whole ask credited, the claim settles, the opportunity closes, no tile holds it.
    await u.as.mutation(api.claims.confirmCredit, { claimId, cents: 12_345, evidence: "Statement credit", idempotencyKey: "slice1" });
    expect((await claimRow(t, claimId)).status).toBe("confirmed");
    expect((await oppRow(t, opportunityId)).status).toBe("closed");
    expect(await money(u)).toEqual({ tiles: {}, components: 0, recovered: 12_345, nonCash: [] });
    // A closed case takes no new packet.
    expect(await u.as.mutation(api.packets.prepare, { claimId })).toMatchObject({ ok: false, code: "closed" });
  });

  it("no address on file: the packet has no recipient until the user enters one; approval is refused, then the new version approves", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice One B");
    const { opportunityId } = await cardCharge(u, { address: null });
    const claimId = await openCase(u, opportunityId);
    const prepared = await u.as.mutation(api.packets.prepare, { claimId });
    if (!prepared.ok) throw new Error(prepared.code);
    const v1 = await u.as.query(api.packets.get, { packetId: prepared.packetId });
    expect(v1.packet.recipient).toEqual({ text: "", source: "user_entered" });
    expect(await u.as.mutation(api.packets.approve, { packetId: prepared.packetId, approvedHash: v1.renderedHash })).toMatchObject({ ok: false, code: "no_recipient" });
    const v2Id = await u.as.mutation(api.packets.update, { packetId: prepared.packetId, recipient: { text: "Card Services, PO Box 7, Dover DE 19901", source: "user_entered" } });
    const v2 = await u.as.query(api.packets.get, { packetId: v2Id });
    expect(v2.packet.version).toBe(2);
    // Approving the superseded version is refused; the reviewed hash of the new one approves it.
    expect(await u.as.mutation(api.packets.approve, { packetId: prepared.packetId, approvedHash: v1.renderedHash })).toMatchObject({ ok: false, code: "not_newest" });
    expect(await u.as.mutation(api.packets.approve, { packetId: v2Id, approvedHash: v1.renderedHash })).toMatchObject({ ok: false, code: "hash_mismatch" });
    expect(await u.as.mutation(api.packets.approve, { packetId: v2Id, approvedHash: v2.renderedHash })).toEqual({ ok: true });
  });

  it("the pack is withdrawn between approval and recording (N3): rule_withdrawn once, then the record lands, flagged stale", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice One C");
    const { opportunityId } = await cardCharge(u);
    const claimId = await openCase(u, opportunityId);
    const { packetId } = await preparedAndApproved(u, claimId);
    setQaPackActive(false);
    expect(await u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 60_000 })).toMatchObject({ ok: false, code: "rule_withdrawn" });
    expect((await oppRow(t, opportunityId)).status).toBe("superseded");
    const second = await u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 60_000 });
    expect(second).toMatchObject({ ok: true, staleAtRecord: true, deduped: false });
    expect((await claimRow(t, claimId)).status).toBe("packet");
    // The recorded ask is still money the user asked for, on the legacy path: Asked, once.
    expect(await money(u)).toMatchObject({ tiles: { asked: 12_345 }, components: 1 });
  });
});

describe("slice 2: denial (§5; D226: a denied loss does not come back as Potential on the same basis)", () => {
  it("a recorded denial takes the loss out of every tile; the same facts keep it out; a material change counts it again", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice Two");
    const { transactionId, opportunityId } = await cardCharge(u);
    const claimId = await openCase(u, opportunityId);

    // Nothing was asked yet: a denial cannot be recorded.
    await expect(u.as.mutation(api.claims.recordDenial, { claimId, reason: "No" })).rejects.toThrow(/sent, submitted or promised/);
    await submitted(u, claimId);
    expect(await money(u)).toMatchObject({ tiles: { asked: 12_345 } });

    await u.as.mutation(api.claims.recordDenial, { claimId, reason: "The issuer says the charge is correct" });
    const denied = await claimRow(t, claimId);
    expect(denied.status).toBe("denied");
    const opp = await oppRow(t, opportunityId);
    expect(opp.status).toBe("open");
    expect(opp.activeClaimId).toBeUndefined();
    expect(opp.deniedAt).toBeDefined();
    expect(await money(u)).toMatchObject({ tiles: {}, components: 0, recovered: 0 });

    // "Check again" on the same facts: still the same basis → still not Potential (and no tile).
    await u.as.mutation(api.opportunities.reevaluate, { transactionId });
    expect(await money(u)).toMatchObject({ tiles: {}, components: 0 });
    // A second identical check changes nothing either.
    await u.as.mutation(api.opportunities.reevaluate, { transactionId });
    expect(await money(u)).toMatchObject({ tiles: {}, components: 0 });

    // A material change (the user learns the correct amount: the ask is now 10,000) → a different basis → Potential.
    await u.as.mutation(api.facts.answer, { transactionId, subjectKey: "txn", key: "card.correct_amount", value: { kind: "money", amountMinor: 2_345, currency: "USD" } });
    expect(await money(u)).toMatchObject({ tiles: { potential: 10_000 }, components: 1, recovered: 0 });
  });

  it("money after a denial reopens the claim and is Recovered (lib/ledger: denied → confirmed when the credit covers it)", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice Two B");
    const { opportunityId } = await cardCharge(u);
    const claimId = await openCase(u, opportunityId);
    await submitted(u, claimId);
    await u.as.mutation(api.claims.recordDenial, { claimId, reason: "Refused by phone" });
    await u.as.mutation(api.claims.confirmCredit, { claimId, cents: 12_345, evidence: "Credit appeared anyway", idempotencyKey: "after-denial" });
    expect((await claimRow(t, claimId)).status).toBe("confirmed");
    expect(await money(u)).toMatchObject({ tiles: {}, recovered: 12_345 });
  });
});

describe("slice 3: non-cash resolution (DA-B-16, DA-A-18, D204)", () => {
  it("a voucher accepted as the resolution closes the case for ask: out of every cash tile, counted as non-cash, the pack's acceptance fact written", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice Three");
    const { transactionId, opportunityId } = await cardCharge(u);
    const claimId = await openCase(u, opportunityId);
    await submitted(u, claimId);
    expect(await money(u)).toMatchObject({ tiles: { asked: 12_345 } });

    const r = await u.as.mutation(api.claims.recordNonCashResolution, {
      claimId, kind: "voucher", description: "Store credit instead of the refund", faceValue: { amountMinor: 12_345, currency: "USD" }, idempotencyKey: "nc1",
    });
    expect(r.deduped).toBe(false);
    const claim = await claimRow(t, claimId);
    expect(claim.nonCashResolvedAt).toBeDefined();
    // Retry with the same key is the same record; a different resolution on a resolved claim is refused.
    expect(await u.as.mutation(api.claims.recordNonCashResolution, { claimId, kind: "voucher", description: "Store credit instead of the refund", faceValue: { amountMinor: 12_345, currency: "USD" }, idempotencyKey: "nc1" })).toEqual({ deduped: true, remedyId: r.remedyId });
    await expect(u.as.mutation(api.claims.recordNonCashResolution, { claimId, kind: "points", description: "Points too", idempotencyKey: "nc2" })).rejects.toThrow(/already resolved/);

    // DA-B-16: the loss is no longer outstanding cash; no face value enters a money figure (I5).
    expect(await money(u)).toEqual({ tiles: {}, components: 0, recovered: 0, nonCash: [{ kind: "voucher", count: 1 }] });

    // D204: the pack's declared acceptance fact, user_confirmed, on the claim's transaction; its re-evaluation runs.
    const fact = await t.run(async (ctx) =>
      (await ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId).eq("subjectKey", "txn").eq("key", "card.merchant_contacted")).collect())
        .filter((f) => f.state === "user_confirmed"),
    );
    expect(fact.map((f) => f.value)).toEqual([{ kind: "bool", value: true }]);
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    // Still closed for ask after the re-evaluation, and nothing re-enters a tile.
    expect(await money(u)).toMatchObject({ tiles: {}, components: 0, recovered: 0 });
    expect(await u.as.mutation(api.packets.prepare, { claimId })).toMatchObject({ ok: false, code: "closed" });
    await expect(u.as.mutation(api.claims.recordDenial, { claimId, reason: "late" })).rejects.toThrow();
  });

  it("a non-cash REMEDY that is not the resolution (recordNonCashRemedy) leaves the claim open in its tile (DA-B-16 contrast)", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice Three B");
    const { opportunityId } = await cardCharge(u);
    const claimId = await openCase(u, opportunityId);
    await submitted(u, claimId);
    await u.as.mutation(api.claims.recordNonCashRemedy, { claimId, kind: "voucher", description: "A goodwill voucher", state: "received", idempotencyKey: "rem1" });
    expect((await claimRow(t, claimId)).nonCashResolvedAt).toBeUndefined();
    expect(await money(u)).toEqual({ tiles: { asked: 12_345 }, components: 1, recovered: 0, nonCash: [{ kind: "voucher", count: 1 }] });
  });
});

describe("slices: day arithmetic and the user deadline on a recorded submission", () => {
  it("a submission recorded after the bound user deadline is flagged late against that deadline", async () => {
    const t = setup();
    const u = await signedIn(t, "Slice Four");
    const { transactionId, opportunityId } = await cardCharge(u);
    // The first statement was sent 2026-08-01 → notice due 60 days later, 2026-09-30T23:59:59Z (still open at NOW).
    await u.as.mutation(api.facts.answer, { transactionId, subjectKey: "txn", key: "card.first_statement_transmitted_on", value: { kind: "local_date", date: "2026-08-01" } });
    const claimId = await openCase(u, opportunityId);
    const { packetId } = await preparedAndApproved(u, claimId);
    vi.setSystemTime(Date.UTC(2026, 9, 2, 12));
    const r = await u.as.mutation(api.submissions.record, { packetId, submittedAt: Date.UTC(2026, 9, 1, 9) });
    expect(r).toMatchObject({ ok: true, deadline: { id: "qa.notice", late: true, dueAt: Date.UTC(2026, 8, 30, 23, 59, 59) } });
  });
});
