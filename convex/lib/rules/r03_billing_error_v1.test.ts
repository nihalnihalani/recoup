/**
 * R03 v1 code pack against EVERY runnable case of docs/rules/fixtures/R03.json, loaded (hash-checked, unmodified)
 * through M08's loader. Expected values are the researcher's hand-written ones (M02/M2D/M2E); nothing here is computed
 * by the evaluator under test.
 *
 * Fixture → evaluator input (README cross-pack rule 2). Each fixture fact becomes resolution rows for M11's
 * `resolveCell` on subject `txn` — one card statement line is one `card_charge` transaction (DA-A-30) — with the
 * fixture states mapped as in the R01/R05 harnesses (conflicting → one row per candidate in its `conflict_kind`). The
 * spec's objects map onto the scalar keys of `lib/facts/keys_card.ts` (FIXTURE_KEYS below). Merchant promises and
 * credits already received are ledger state (§3.2), not R03 facts, so they are not read. Dates are calendar dates
 * (file `conventions.calendar_zone`); no case states the billing-error address's zone.
 * Source state: no `source` → verified on the clock's date; `last_verified_on` → that date; `record: "missing"` → no
 * verification record (README rule 8).
 *
 * Assertion mapping (contract rev 5.5 §10, D158/D161), compared as SETS of fixture fact names:
 *   fixture `missing_facts`              ↔ missingFacts with reason missing | user_unknown | conflicting
 *   fixture `unconfirmed_decisive_facts` ↔ missingFacts with reason candidate_unconfirmed | conflict_capped
 * Other keys: `amount.disputed_amount`; `deadline` (the user's notice deadline: `date` ↔ dueLocalDate, `met` ↔ status
 * `met` (D212) / passed, a null date ↔ no dueAt with `status` and `advisory_act_by`, `deadline: null` ↔ no
 * notice deadline); `conservative_act_by`; `packet_readiness` and `user_message` (r03PacketReadiness); `overlap`;
 * `dedupe`; `explanation`; `route_to`; `pointer`; `note`; `forbidden_outputs`; `creditor_response_clocks` (params).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { loadRuleFixtureFile, REPO_ROOT, type FixtureFact, type RuleFixtureCase } from "../../testing/ruleFixtures.loader";
import { computeSummary } from "../../recovery";
import type { FactValue } from "../facts/catalog";
import type { CellSource, ResolveRow } from "../facts/resolve";
import { buildCardSnapshot, R03_BOUND_KEYS, type CardSnapshot } from "../facts/snapshot_card";
import type { CellRow } from "../facts/snapshot_retail";
import { resultHash } from "./outcome";
import {
  evaluateR03V1,
  r03AdapterRuns,
  r03BillingErrorV1,
  r03LossKeys,
  r03PacketReadiness,
  r03RequiredChannel,
  R03_R05_REMEDY_KEY,
  R03_REMEDY_KEY,
  R03_V1_ACK_DEADLINE_ID,
  R03_V1_NOTICE_DEADLINE_ID,
  R03_V1_PARAMS,
  R03_V1_PARAM_SOURCES,
  R03_V1_RESOLVE_DEADLINE_ID,
  R03_V1_SOURCES,
} from "./r03_billing_error_v1";
import { r05LateOrderV1, r05LossKeys, R05_R03_REMEDY_KEY } from "./r05_late_order_v1";
import * as prod from "./registry";
import { activePack, resetTestRegistry, setTestActivations } from "./testRegistry";
import { ENGINE_VERSION, type CaseContext, type EvaluationResult, type MissingFact } from "./types";

const FILE = loadRuleFixtureFile("R03");
const TXN_ID = "fixturetxn3" as Id<"transactions">;
const SPEC_TEXT = readFileSync(path.join(REPO_ROOT, "docs/rules/R03-credit-card-billing-error.md"), "utf8");
const REFRESHED = ["ecfr-12cfr1026.13", "ecfr-12cfr1026-suppI-13", "usc-15-1666"];

// ---------------------------------------------------------------------------
// Fixture fact → catalogue rows
// ---------------------------------------------------------------------------

type KV = [key: string, value: FactValue];
const code = (c: unknown): FactValue => ({ kind: "code", code: String(c) });
const text = (t: unknown): FactValue => ({ kind: "text", text: String(t) });
const bool = (b: unknown): FactValue => ({ kind: "bool", value: Boolean(b) });
const localDate = (s: unknown): FactValue => ({ kind: "local_date", date: String(s) });
const instant = (s: unknown): FactValue => ({ kind: "instant", epochMs: Date.parse(String(s)) });
const money = (m: unknown): FactValue => {
  const x = m as { amount_minor: number; currency: string };
  return { kind: "money", amountMinor: x.amount_minor, currency: x.currency };
};
const DELIVERY_STATUS: Record<string, string> = { "not delivered": "not_delivered", delivered: "delivered" };

const FIXTURE_KEYS: Record<string, (value: unknown) => KV[]> = {
  payment_instrument_class: (v) => [["card.payment_instrument_class", code(v)]],
  error_type: (v) => [["card.error_type", code(v)]],
  disputed_transaction: (v) => {
    const d = v as { date?: string; merchant_descriptor?: string; amount?: unknown; correct_amount?: unknown };
    return [
      ...(d.date ? ([["card.charge_date", localDate(d.date)]] as KV[]) : []),
      ...(d.merchant_descriptor ? ([["card.merchant_descriptor", text(d.merchant_descriptor)]] as KV[]) : []),
      ...(d.amount ? ([["card.charge_amount", money(d.amount)]] as KV[]) : []),
      ...(d.correct_amount ? ([["card.correct_amount", money(d.correct_amount)]] as KV[]) : []),
    ];
  },
  first_statement_transmitted_on: (v) => [["card.first_statement_transmitted_on", localDate(v)]],
  statement_closing_date: (v) => [["card.statement_closing_date", localDate(v)]],
  transaction_posting_date: (v) => [["card.posting_date", localDate(v)]],
  credit_issue_date: (v) => [["card.credit_issue_date", localDate(v)]],
  billing_error_address: (v) => [["card.billing_error_address", text(v)]],
  electronic_notice_stipulated: (v) => [["card.electronic_notice_stipulated", bool(v)]],
  notice_channel_planned: (v) => [["card.notice_channel_planned", code(v)]],
  notice_received_on: (v) => [["card.notice_received_on", localDate(v)]],
  merchant_contacted: (v) => [["card.merchant_contacted", bool(v)]],
  existing_dispute_open: (v) => [["card.existing_dispute_open", bool(v)]],
  delivery_evidence: (v) => {
    const d = v as { promised_delivery_by?: string; tracking?: string; status?: string; status_on_clock?: string; at?: string };
    const status = d.status ?? d.status_on_clock;
    return [
      ...(d.promised_delivery_by ? ([["card.delivery_promised_by", localDate(d.promised_delivery_by)]] as KV[]) : []),
      ...(d.tracking ? ([["card.delivery_tracking_summary", text(d.tracking)]] as KV[]) : []),
      ...(status ? ([["card.delivery_status", code(DELIVERY_STATUS[status])]] as KV[]) : []),
      ...(d.at ? ([["card.delivered_at", instant(d.at)]] as KV[]) : []),
    ];
  },
};
/** Ledger state, not R03 facts (§3.2: a promise and posted credits are ledger events). */
const NOT_READ = new Set(["credits_already_received", "merchant_promise"]);

const FIXTURE_NAME: Record<string, string> = {
  "card.payment_instrument_class": "payment_instrument_class", "card.error_type": "error_type",
  "card.charge_date": "disputed_transaction", "card.merchant_descriptor": "disputed_transaction",
  "card.charge_amount": "disputed_transaction", "card.correct_amount": "disputed_transaction",
  "card.first_statement_transmitted_on": "first_statement_transmitted_on", "card.statement_closing_date": "statement_closing_date",
  "card.posting_date": "transaction_posting_date", "card.credit_issue_date": "credit_issue_date",
  "card.billing_error_address": "billing_error_address", "card.electronic_notice_stipulated": "electronic_notice_stipulated",
  "card.notice_channel_planned": "notice_channel_planned", "card.notice_received_on": "notice_received_on",
  "card.merchant_contacted": "merchant_contacted", "card.existing_dispute_open": "existing_dispute_open",
  "card.delivery_promised_by": "delivery_evidence", "card.delivery_tracking_summary": "delivery_evidence",
  "card.delivery_status": "delivery_evidence", "card.delivered_at": "delivery_evidence",
};

const ROW_STATE: Record<string, ResolveRow["state"]> = {
  user_confirmed: "user_confirmed", observed: "observed", derived: "derived", extracted_candidate: "extracted_candidate",
};
function sourceOf(state: string, evidence: unknown): CellSource {
  if (state === "user_confirmed") return { kind: "user" };
  if (state === "derived") return { kind: "derived", ref: "fixture" };
  return { kind: "evidence", ref: typeof evidence === "string" ? evidence : "fixture document" };
}
function rowsOf(name: string, fact: FixtureFact): CellRow[] {
  const convert = FIXTURE_KEYS[name];
  if (!convert) throw new Error(`R03 harness: no mapping for fixture fact "${name}"`);
  const rows = (kvs: KV[], state: ResolveRow["state"], at: number, source: CellSource): CellRow[] =>
    kvs.map(([key, value]) => ({ subjectKey: "txn", key, row: { state, value, at, source } }));
  if (fact.state === "missing") return [];
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    return (fact.candidates ?? []).flatMap((c, i) => {
      const state = kind === "candidates" ? "extracted_candidate" : ROW_STATE[String(c.state)];
      return rows(convert(c.value), state, i + 1, sourceOf(state, c.evidence ?? `candidate ${i + 1}`));
    });
  }
  return rows(convert(fact.value), ROW_STATE[fact.state], 1, sourceOf(fact.state, fact.evidence));
}

function snapshotOf(c: RuleFixtureCase, opts: { transactionId?: Id<"transactions">; relatedTransactionId?: Id<"transactions"> } = {}): CardSnapshot {
  const rows = Object.entries(c.facts).filter(([n]) => !NOT_READ.has(n)).flatMap(([n, f]) => rowsOf(n, f));
  return buildCardSnapshot({ transactionId: opts.transactionId ?? TXN_ID, ...(opts.relatedTransactionId ? { relatedTransactionId: opts.relatedTransactionId } : {}), rows });
}
function verificationOf(c: RuleFixtureCase): Record<string, { lastVerifiedAt: string }> {
  const src = c.source;
  const at = (date: string) => Object.fromEntries(REFRESHED.map((id) => [id, { lastVerifiedAt: date }]));
  if (src === null) return at(c.clock.slice(0, 10));
  if ("record" in src) return {};
  expect(src.refresh_window_days).toBe(R03_V1_PARAMS.refreshWindowDays);
  return at(src.last_verified_on);
}
function run(snapshot: CardSnapshot, now: number, opts: { verification?: Record<string, { lastVerifiedAt: string }>; cc?: CaseContext } = {}): EvaluationResult {
  return evaluateR03V1({
    snapshot, snapshotHash: "fixture", engineVersion: ENGINE_VERSION, remedyKey: R03_REMEDY_KEY, subjectKey: "txn",
    pack: { ruleId: r03BillingErrorV1.ruleId, scenarioId: "R03", version: r03BillingErrorV1.version, params: R03_V1_PARAMS, sources: R03_V1_SOURCES },
    verification: opts.verification ?? Object.fromEntries(REFRESHED.map((id) => [id, { lastVerifiedAt: new Date(now).toISOString().slice(0, 10) }])),
    caseContext: opts.cc ?? { settledMinorByLossKey: {} },
    now,
  });
}
const runCase = (c: RuleFixtureCase, opts: Parameters<typeof snapshotOf>[1] = {}) => run(snapshotOf(c, opts), c.now, { verification: verificationOf(c) });

const UNRESOLVED = new Set(["missing", "user_unknown", "conflicting"]);
const CAPPED = new Set(["candidate_unconfirmed", "conflict_capped"]);
const namesOf = (list: MissingFact[], cls: Set<string>) =>
  [...new Set(list.filter((m) => cls.has(m.reason)).map((m) => FIXTURE_NAME[m.key] ?? m.key))].sort();
const noticeOf = (r: EvaluationResult) => r.deadlines.find((d) => d.id === R03_V1_NOTICE_DEADLINE_ID);
const byId = (id: string) => FILE.cases.find((c) => c.id === id)!;
const withFacts = (c: RuleFixtureCase, facts: Record<string, Partial<FixtureFact> | null>): RuleFixtureCase => {
  const next: Record<string, FixtureFact> = { ...c.facts };
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) delete next[name];
    else next[name] = { ...(c.facts[name] ?? { type: "string", state: "user_confirmed" }), ...f } as FixtureFact;
  }
  return { ...c, facts: next };
};

// ---------------------------------------------------------------------------
// Every fixture, unchanged
// ---------------------------------------------------------------------------

describe("R03 v1 code pack × docs/rules/fixtures/R03.json (unmodified, via M08's loader)", () => {
  it("loads the file (hash-checked) with every case runnable", () => {
    expect(FILE.ruleId).toBe(r03BillingErrorV1.ruleId);
    expect(FILE.ruleVersion).toBe(r03BillingErrorV1.version);
    expect(FILE.cases.length).toBe(19);
  });

  describe.each(FILE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = runCase(c);
    const e = c.expected as Record<string, unknown> & { outcome: string };

    it(`outcome ${e.outcome}`, () => {
      expect(r.outcome).toBe(e.outcome);
    });

    it("missing_facts ↔ unresolved class; unconfirmed_decisive_facts ↔ capped class (D158/D161)", () => {
      expect(namesOf(r.missingFacts, UNRESOLVED)).toEqual([...((e.missing_facts as string[] | undefined) ?? [])].sort());
      expect(namesOf(r.missingFacts, CAPPED)).toEqual([...((e.unconfirmed_decisive_facts as string[] | undefined) ?? [])].sort());
    });

    it("amount and the notice deadline (where the fixture states them)", () => {
      const amount = e.amount as { disputed_amount?: { amount_minor: number; currency: string } } | null | undefined;
      if (amount === null) expect(r.amount).toBeNull();
      if (amount?.disputed_amount) expect(r.amount?.estimate).toEqual({ amountMinor: amount.disputed_amount.amount_minor, currency: amount.disputed_amount.currency });

      const deadline = e.deadline as { date: string | null; status?: string; met?: boolean; advisory_act_by?: string } | null | undefined;
      const n = noticeOf(r);
      if (deadline === null) expect(n).toBeUndefined();
      if (deadline) {
        expect(n?.obligor).toBe("user");
        expect(n?.mustBe).toBe("received");
      }
      if (deadline && typeof deadline.date === "string") {
        expect(n?.dueLocalDate).toBe(deadline.date);
        if (deadline.met === true) {
          expect(n?.status).toBe("met");
          expect(n?.basis).toContain("Met: the notice was received on");
        } else if (deadline.met === false) expect(n?.status).toBe("passed");
        else expect(n?.status).toBe("open");
      }
      if (deadline && deadline.date === null) {
        expect(n?.dueAt).toBeUndefined();
        expect(n?.status).toBe(deadline.status);
      }
      if (deadline?.advisory_act_by) expect(n?.advisoryActBy).toBe(deadline.advisory_act_by);
      const conservative = e.conservative_act_by as { date: string } | undefined;
      if (conservative) {
        expect(n?.advisoryActBy).toBe(conservative.date);
        expect(n?.basis).toContain("not the legal deadline");
      }
    });

    it("readiness, overlap, explanation, next action, dedupe, forbidden outputs", async () => {
      const snapshot = snapshotOf(c);
      if (typeof e.packet_readiness === "string") expect(r03PacketReadiness(snapshot, r).status).toBe(e.packet_readiness);
      if (typeof e.user_message === "string") {
        const msg = r03PacketReadiness(snapshot, r).message ?? "";
        expect(msg).toContain("does not preserve your formal billing-error rights");
        expect(msg).toContain("billing-error address on your statement so that it arrives by 2026-11-09");
      }
      const overlap = e.overlap as { with: string } | undefined;
      if (overlap?.with === "R05") expect(r.overlap).toEqual([{ withScenario: "R05", withRemedyKey: R03_R05_REMEDY_KEY, relation: "alternative" }]);
      const text = r.explanation.join(" ");
      if (typeof e.explanation === "string") {
        if (r.outcome === "unsupported" && e.explanation.includes("Regulation E")) expect(text).toContain("Regulation E, not the Fair Credit Billing Act");
        else if (r.outcome === "unsupported") expect(text).toContain("consumer credit only");
        else {
          // R03-13 (5a): both sources named; the letter must be truthful; the deadline still runs.
          expect(text).toContain("delivered");
          expect(text).toContain("user");
          expect(text).toContain("truthful");
          expect(text.toLowerCase()).toContain("upload proof");
          expect(text).toContain("deadline still runs");
        }
      }
      if (typeof e.route_to === "string") {
        expect(r.nextAction.kind).toBe("none");
        expect(r.nextAction.kind === "none" && r.nextAction.reason).toContain("R13");
      }
      if (typeof e.pointer === "string") expect(text).toContain("1026.12(c)");
      if (typeof e.note === "string" && r.outcome === "deadline_passed") {
        expect(r.nextAction.kind === "none" && r.nextAction.reason).toContain("formal FCBA path only");
      }
      if (e.dedupe !== undefined) expect(await resultHash(runCase(c), "b")).toBe(await resultHash(r, "b"));
      if (e.creditor_response_clocks) {
        expect(R03_V1_PARAMS.acknowledgeWithinDays).toBe(30);
        expect(R03_V1_PARAMS.resolveWithinDays).toBe(90);
      }
      for (const f of (e.forbidden_outputs as string[] | undefined) ?? []) {
        if (f === "not_eligible") expect(r.outcome).not.toBe("not_eligible");
        if (f === "the R03 60-day deadline" || f.startsWith("a legal deadline derived") || f.startsWith("a firm deadline")) {
          expect(noticeOf(r)?.dueAt).toBeUndefined();
        }
        if (f.startsWith("needs_facts")) expect(r.outcome).not.toBe("needs_facts");
        if (f.startsWith("a 'contact the merchant first' gate")) {
          expect(r.nextAction).toEqual({ kind: "open_case" });
          expect(text).toContain("do not have to contact the merchant first");
        }
      }
      expect(r.boundFacts.length).toBeLessThanOrEqual(32);
    });
  });
});

// ---------------------------------------------------------------------------
// Contract §10 R03 rows (M21, D143.3) and pack invariants
// ---------------------------------------------------------------------------

describe("contract §10 R03 rows (M21; D143.3)", () => {
  it("credit card + error type + first statement transmittal confirmed → user deadline 'received by anchor + 60 days'", () => {
    const n = noticeOf(runCase(byId("R03-01")))!;
    expect(n).toMatchObject({ obligor: "user", mustBe: "received", status: "open", dueLocalDate: "2026-11-09" });
    expect(n.anchor).toEqual({ subjectKey: "txn", key: "card.first_statement_transmitted_on" });
    expect(n.basis).toContain("60 calendar days from card.first_statement_transmitted_on");
  });

  it("unknown anchor → needs_facts + advisoryActBy (posting date + 60, labelled), dueAt undefined", () => {
    const r = runCase(byId("R03-03"));
    expect(r.outcome).toBe("needs_facts");
    expect(noticeOf(r)).toMatchObject({ status: "unknown_anchor", advisoryActBy: "2026-11-02" });
    expect(noticeOf(r)?.dueAt).toBeUndefined();
    expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "card.first_statement_transmitted_on" }] });
    // A credit not reflected dates its advisory from the credit's issue date instead.
    const credit = runCase(withFacts(byId("R03-02a"), { first_statement_transmitted_on: null, notice_received_on: null }));
    expect(noticeOf(credit)?.advisoryActBy).toBe("2026-08-25");
  });

  it("requiredChannel is postal unless the electronic designation is confirmed", () => {
    expect(r03PacketReadiness(snapshotOf(byId("R03-01"))).requiredChannel).toBe("postal_mail");
    expect(r03PacketReadiness(snapshotOf(byId("R03-05b"))).requiredChannel).toBe("portal");
    const undesignated = withFacts(byId("R03-05b"), { electronic_notice_stipulated: { value: false } });
    expect(r03PacketReadiness(snapshotOf(undesignated))).toMatchObject({ status: "blocked_channel", requiredChannel: "postal_mail" });
    expect(r03RequiredChannel(runCase(byId("R03-01")))).toBe("postal_mail");
    expect(r03RequiredChannel(runCase(byId("R03-05b")))).toBe("portal");
    expect(r03RequiredChannel(runCase(undesignated))).toBe("postal_mail");
    // An extracted designation is not a confirmation.
    expect(r03RequiredChannel(runCase(withFacts(byId("R03-05b"), { electronic_notice_stipulated: { state: "extracted_candidate" } })))).toBe("postal_mail");
  });

  it("an informal email leaves the deadline strip in place; day 61 without a received notice → deadline_passed", () => {
    const c = byId("R03-05"); // email to customer service planned; received-by 2026-11-09
    expect(noticeOf(runCase(c))?.status).toBe("open");
    const day61 = run(snapshotOf(c), Date.parse("2026-11-10T12:00:00-05:00"));
    expect(day61.outcome).toBe("deadline_passed");
    expect(noticeOf(day61)?.status).toBe("passed");
  });

  it("debit card → unsupported (R13 not yet), never not_eligible, and no FCBA deadline", () => {
    const r = runCase(byId("R03-04"));
    expect(r.outcome).toBe("unsupported");
    expect(r.deadlines).toEqual([]);
    expect(r.amount).toBeNull();
  });

  it("no merchant-first gate: merchant not contacted → eligible and open_case", () => {
    const r = runCase(byId("R03-08"));
    expect(r.outcome).toBe("eligible");
    expect(r.nextAction).toEqual({ kind: "open_case" });
    expect(r.conditions.some((x) => x.facts.some((f) => f.key === "card.merchant_contacted"))).toBe(false);
  });

  it("DA-A-30: two identical duplicate-charge lines are two transactions → two loss keys", () => {
    const c = byId("R03-01");
    const a = runCase(c, { transactionId: "cardlinea" as Id<"transactions"> });
    const b = runCase(c, { transactionId: "cardlineb" as Id<"transactions"> });
    expect(a.outcome).toBe(b.outcome);
    expect(a.lossKeys).toEqual(["txn:cardlinea:paid"]);
    expect(b.lossKeys).toEqual(["txn:cardlineb:paid"]);
    // A duplicate charge stays the line's own money even when the line is related to an order.
    expect(runCase(c, { transactionId: "cardlinea" as Id<"transactions">, relatedTransactionId: "order1" as Id<"transactions"> }).lossKeys).toEqual(["txn:cardlinea:paid"]);
  });

  it("R05 and R03 on a related charge share the order's loss key and count once (§3.3; R05-12 / R03-08 'never 2×')", () => {
    const order = "order1" as Id<"transactions">;
    const r03 = runCase(byId("R03-08"), { transactionId: "cardline1" as Id<"transactions">, relatedTransactionId: order });
    const r05Keys = r05LossKeys({ transactionId: order });
    expect(r03.lossKeys).toEqual(r05Keys);
    expect(r03LossKeys({ transactionId: "cardline1" as Id<"transactions">, relatedTransactionId: null }, "not_delivered_as_agreed")).toEqual(["txn:cardline1:paid"]);
    const s = computeSummary([], [
      { id: "r05", currency: "USD", estimateMinor: 54000, lossKeys: r05Keys, anchor: `txn:${order}` },
      { id: "r03", currency: "USD", estimateMinor: r03.amount!.estimate.amountMinor, lossKeys: r03.lossKeys, anchor: `txn:${order}` },
    ], new Map()).find((x) => x.currency === "USD")!;
    expect(s.tiles.potential.amountMinor).toBe(54000);
    expect(r05LateOrderV1.overlap).toEqual([{ withScenario: "R03", withRemedyKey: R03_REMEDY_KEY, relation: "alternative" }]);
    expect(R05_R03_REMEDY_KEY).toBe(r03BillingErrorV1.remedyKey);
    expect(R03_R05_REMEDY_KEY).toBe(r05LateOrderV1.remedyKey);
  });

  it("D154 anchors: an extracted anchor → unknown_anchor with the candidate's advisory; a conflict → the earliest", () => {
    expect(noticeOf(runCase(byId("R03-01b")))).toMatchObject({ status: "unknown_anchor", advisoryActBy: "2026-11-09" });
    expect(noticeOf(runCase(byId("R03-07")))).toMatchObject({ status: "disputed_anchor", advisoryActBy: "2026-09-30" });
    expect(noticeOf(runCase(byId("R03-07b")))).toMatchObject({ status: "disputed_anchor", advisoryActBy: "2026-09-18" });
    // An extracted anchor whose own date has passed is asked, never left capped at likely_eligible.
    const late = run(snapshotOf(byId("R03-01b")), Date.parse("2026-11-12T12:00:00-05:00"));
    expect(late.outcome).toBe("needs_facts");
    expect(late.missingFacts.find((m) => m.key === "card.first_statement_transmitted_on")?.reason).toBe("candidate_unconfirmed");
  });

  it("a notice received in time starts the creditor's counterparty clocks: acknowledge in 30 days, resolve within 90", () => {
    const r = runCase(byId("R03-02a")); // received 2026-08-30
    expect(r.deadlines.find((d) => d.id === R03_V1_ACK_DEADLINE_ID)).toMatchObject({ obligor: "counterparty", dueLocalDate: "2026-09-29", status: "open" });
    expect(r.deadlines.find((d) => d.id === R03_V1_RESOLVE_DEADLINE_ID)).toMatchObject({ obligor: "counterparty", dueLocalDate: "2026-11-28", status: "open" });
    const later = run(snapshotOf(byId("R03-02a")), Date.parse("2026-10-01T12:00:00-04:00"), { cc: { settledMinorByLossKey: {}, activeClaimId: "claim3" as Id<"claims"> } });
    expect(later.deadlines.find((d) => d.id === R03_V1_ACK_DEADLINE_ID)?.status).toBe("overdue");
    expect(later.nextAction.kind).toBe("escalate");
    expect(later.dimensions.windowOpen).toBe("pass"); // counterparty clocks never feed windowOpen (DA-A-5)
  });

  it("the production registry never returns R03; the test registry does only through setTestActivations", () => {
    expect(prod.IMPLEMENTED_PACKS).toContain(r03BillingErrorV1);
    expect(prod.activePack("R03")).toBeNull();
    try {
      setTestActivations([]);
      expect(activePack("R03")).toBeNull();
      setTestActivations([{ ruleId: r03BillingErrorV1.ruleId, version: 1, status: "active", decision: "TEST" }]);
      expect(activePack("R03")).toBe(r03BillingErrorV1);
    } finally {
      resetTestRegistry();
    }
  });
});

describe("R03 v1 pack invariants beyond the fixtures", () => {
  it("every param cites a passage in the spec; params are frozen; every source passage exists", () => {
    for (const [param, ids] of Object.entries(R03_V1_PARAM_SOURCES)) {
      expect(ids.length, param).toBeGreaterThan(0);
      for (const id of ids) expect(SPEC_TEXT, `${param} cites ${id}`).toContain(id);
    }
    expect(Object.keys(R03_V1_PARAM_SOURCES).sort()).toEqual(Object.keys(R03_V1_PARAMS).sort());
    expect(Object.isFrozen(R03_V1_PARAMS)).toBe(true);
    for (const s of R03_V1_SOURCES) expect(SPEC_TEXT, s.passageId).toContain(s.passageId);
    expect(r03BillingErrorV1.lifecycle).toBe("researched");
    expect(r03BillingErrorV1.fixturesPath).toBe(FILE.relPath);
  });

  it("the closing date is never the anchor (R03-01: closing 2026-09-07 → deadline from the 2026-09-10 transmittal)", () => {
    const r = runCase(withFacts(byId("R03-01"), { first_statement_transmitted_on: null }));
    expect(noticeOf(r)?.status).toBe("unknown_anchor");
    expect(r.outcome).toBe("needs_facts");
  });

  it("a wrong amount disputes the difference; a charge not above the correct amount is not a billing error in your favour", () => {
    const c = byId("R03-03");
    expect(runCase(c).amount).toMatchObject({ estimate: { amountMinor: 45000, currency: "USD" }, basis: "exact_formula" });
    const none = runCase(withFacts(c, { disputed_transaction: { value: { date: "2026-09-01", merchant_descriptor: "CITY FURNITURE", amount: { amount_minor: 49000, currency: "USD" }, correct_amount: { amount_minor: 49000, currency: "USD" } } } }));
    expect(none.outcome).toBe("not_eligible");
  });

  it("a goods dispute without any delivery record caps the outcome at likely_eligible (evidence, not a question)", () => {
    const r = runCase(withFacts(byId("R03-08"), { delivery_evidence: null }));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.missingFacts).toEqual([]);
    expect(r.dimensions.evidenceSupports).toBe("unknown");
  });

  it("an existing open dispute is never duplicated; a never-sent statement goes to review", () => {
    expect(runCase(withFacts(byId("R03-01"), { existing_dispute_open: { value: true } })).outcome).toBe("manual_review");
    const r = runCase(withFacts(byId("R03-01"), { error_type: { value: "statement_not_sent" }, first_statement_transmitted_on: null }));
    expect(r.outcome).toBe("manual_review");
    expect(noticeOf(r)).toBeUndefined();
  });

  it("a candidate business-card reading is asked, never unsupported on its own (rule 3: known facts only)", () => {
    const r = runCase(withFacts(byId("R03-01"), { payment_instrument_class: { value: "business_credit_card", state: "extracted_candidate" } }));
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["card.payment_instrument_class", "candidate_unconfirmed"]]);
  });

  it("a statement before the rule's effective date (2011-12-30) is source_unverified (README rule 5)", () => {
    expect(runCase(withFacts(byId("R03-01"), { first_statement_transmitted_on: { value: "2011-06-01" } })).outcome).toBe("source_unverified");
  });

  it("bound facts are canonical rows, sorted, ≤ 32; the adapter gives one run per line on subject txn", () => {
    const r = runCase(byId("R03-01"));
    expect(R03_BOUND_KEYS.length).toBeLessThanOrEqual(32);
    expect(r.boundFacts.map((b) => b.key)).toEqual([...R03_BOUND_KEYS].sort());
    const rows = Object.entries(byId("R03-01").facts).filter(([n]) => !NOT_READ.has(n)).flatMap(([n, f]) => rowsOf(n, f));
    const runs = r03AdapterRuns({ transactionId: TXN_ID, relatedTransactionId: "order9" as Id<"transactions">, isExample: false, rows });
    expect(runs).toHaveLength(1);
    expect(runs[0].subjectKey).toBe("txn");
    expect(runs[0].snapshot.relatedTransactionId).toBe("order9");
    expect(runs[0].lookup.cells().length).toBeGreaterThan(0);
  });

  it("deterministic, and no explicit undefined anywhere in a result (results are stored)", async () => {
    const hasUndefined = (v: unknown): boolean =>
      v === undefined || (typeof v === "object" && v !== null && Object.values(v as Record<string, unknown>).some(hasUndefined));
    for (const c of FILE.cases) {
      expect(hasUndefined(runCase(c)), c.id).toBe(false);
      expect(await resultHash(runCase(c), "b"), c.id).toBe(await resultHash(runCase(c), "b"));
    }
  });
});

describe("M27 cross-pack rules applied to R03 before its review (D234(1), R05-01/R05-03 lessons)", () => {
  it("an unsupported or unverified result names its reason only (no deadline, evidence or merchant text)", () => {
    const debit = runCase(withFacts(byId("R03-08"), { payment_instrument_class: { value: "debit_card" } }));
    expect(debit.outcome).toBe("unsupported");
    expect(debit.explanation).toHaveLength(1);
    expect(debit.explanation[0]).toContain("Regulation E, not the Fair Credit Billing Act");
    expect(debit.overlap).toEqual([]);
    const stale = runCase(byId("R03-10"));
    expect(stale.explanation).toEqual([expect.stringContaining("draws no conclusion")]);
  });

  it("two extracted first-statement dates that BOTH close the window → needs_facts, never deadline_passed (5c keeps only a positive answer)", () => {
    const c = withFacts(byId("R03-07"), {
      first_statement_transmitted_on: { type: "date", value: null, state: "conflicting", conflict_kind: "candidates", candidates: [{ value: "2026-07-01", evidence: "July PDF" }, { value: "2026-07-10", evidence: "issuer email" }] } as unknown as Partial<FixtureFact>,
    });
    const r = runCase(c);
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.find((m) => m.key === "card.first_statement_transmitted_on")?.reason).toBe("conflicting");
    expect(noticeOf(r)?.status).toBe("disputed_anchor");
  });
});
