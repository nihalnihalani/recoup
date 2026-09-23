/**
 * R03 v1 — credit-card billing-error notice (Fair Credit Billing Act, 15 U.S.C. 1666; Regulation Z 12 CFR 1026.13
 * and its official interpretation; spec docs/rules/R03-credit-card-billing-error.md, M09/M09b/M09c-approved; fixtures
 * docs/rules/fixtures/R03.json). Pure: no ctx, no clock (`now` is injected), no randomness, no `lib/ai`.
 *
 * What it evaluates. One card statement line (a `card_charge` transaction, subject `txn`, facts
 * `lib/facts/keys_card.ts`) against the FORMAL billing-error path only (§1: merchant outreach, informal issuer support,
 * network chargebacks and claims-and-defenses are other channels and are never evaluated or conflated here):
 *   1. scope (§2, §16.2): consumer credit card or other consumer open-end credit. Debit, prepaid, ACH, P2P (Regulation E
 *      or other regimes → route to R13), business cards and BNPL → `unsupported`, never `not_eligible`.
 *   2. a billing error (§4, §16.3): a quality dispute about accepted goods is not one → `not_eligible`; a statement that
 *      was never sent has its own anchor (comment 13(b)(1)-1) → `manual_review`.
 *   3. the user deadline (§11, D143.3): the notice must be RECEIVED at the billing-error address no later than 60 calendar
 *      days after the creditor TRANSMITTED the first statement reflecting the error (day 60 inclusive, no roll-forward,
 *      A1). The anchor is `card.first_statement_transmitted_on` — never the closing date or the transaction date. Unknown
 *      anchor → `needs_facts` plus a labelled advisory act-by (posting date + 60, or the credit's issue date + 60 for a
 *      credit not reflected) that never becomes `dueAt`; an unconfirmed anchor → no firm date, advisory from the
 *      candidate, outcome capped; a conflicting anchor → `disputed_anchor` and D152 5a/5b/5c.
 *   4. a notice already received: on or before the due date → the deadline is `met` (D212, `markMet`);
 *      after it → `deadline_passed` for the formal path only. Once received, the creditor's clocks run (counterparty,
 *      §7/P-1026.13(c)): acknowledge within 30 days, resolve within two billing cycles and no later than 90 days.
 *   5. no merchant-first gate (comment 13(a)(3)-3): `card.merchant_contacted` only shapes the letter.
 *   6. the amount is the disputed amount (§8): the line's amount, or charged − correct for a wrong amount or a
 *      computational error; never capped.
 * Packet readiness (§16.8) and the required channel (postal unless the issuer's billing-rights statement designates an
 * electronic means, comment 13(b)-2) are separate from eligibility: `r03PacketReadiness`, `r03RequiredChannel`.
 *
 * Outcomes come only from `deriveOutcome`. `eligible` needs every decisive fact confirmed (D147(2)); a negative verdict
 * never rests on a candidate (contract §4 rule 3). Conflicts follow D152/D154 (5a/5b/5c) by candidate testing.
 *
 * Time zone. The window is day arithmetic on the calendar dates the creditor states and records (§11). Only "has day 60
 * ended today?" needs a zone: `card.billing_address_time_zone`, else the deadline engine's earliest-ending US zone
 * (conservative for the user's own deadline).
 *
 * Status. `lifecycle: "researched"` is informative only; the manifest and the lead's activation entry decide.
 */
import type { Id } from "../../_generated/dataModel";
import { formatMinor } from "../money";
import type { KnownValue } from "../facts/catalog";
import { alternatives, knownCell, withOverride, type Cell, type CellLookup } from "../facts/resolve";
import type { CellRow } from "../facts/snapshot_retail";
import { buildCardSnapshot, cardBoundFacts, type CardSnapshot } from "../facts/snapshot_card";
import { txnCell } from "../facts/snapshot_order";
import { formatFactValue } from "../facts/values";
import { computeDeadline, markMet, userWindowOpen } from "../deadlines/engine";
import { localParts, zoneRule } from "../deadlines/usZones";
import { addMissing, evaluateConditions } from "./conditions";
import { candidateCombinations, deriveOutcome, sameAnswer, sourceStale, withSameAnswer } from "./outcome";
import {
  emptyFlags,
  isApprovable,
  lookupFrom,
  unresolvedReason,
  type AmountCalc,
  type Assumption,
  type BoundFactValue,
  type CaseContext,
  type ComputedCondition,
  type ConditionNode,
  type ConditionResult,
  type ConflictFlag,
  type DeadlineResult,
  type DeadlineSpec,
  type Dimensions,
  type EvaluationInput,
  type EvaluationResult,
  type FactRef,
  type Flags,
  type MissingFact,
  type MissingReason,
  type NextAction,
  type Outcome,
  type RulePack,
  type RuleSourceMeta,
  type SourceRef,
  type Tri,
} from "./types";

export const R03_V1_RULE_ID = "R03.credit_billing_error.us_fcba";
export const R03_V1_VERSION = 1;
export const R03_REMEDY_KEY = "billing_error_credit";
/** R05's remedy key, for the declared alternative (`r03_billing_error_v1.test.ts` checks it against the R05 pack). */
export const R03_R05_REMEDY_KEY = "order_refund";
export const R03_V1_NOTICE_DEADLINE_ID = "r03.v1.notice";
export const R03_V1_ACK_DEADLINE_ID = "r03.v1.creditor_acknowledgment";
export const R03_V1_RESOLVE_DEADLINE_ID = "r03.v1.creditor_resolution";
export const R03_V1_ANCHOR_ID = "r03.v1.anchor";

/** R03 v1 parameters; every number cites the passage it comes from (`R03_V1_PARAM_SOURCES`). */
export interface R03Params {
  /** The notice must be received no later than this many days after the first statement's transmittal. */
  noticeWindowDays: number;
  /** Conservative act-by offset from the posting date (or the credit's issue date) when the anchor is unknown. */
  advisoryOffsetDays: number;
  /** The creditor acknowledges within this many days of receiving the notice. */
  acknowledgeWithinDays: number;
  /** The creditor resolves within two complete billing cycles and in no event later than this many days. */
  resolveWithinDays: number;
  /** README rule 3: past this many days after the last verification the pack is `source_unverified`. */
  refreshWindowDays: number;
  /** README rule 5: the rule version in force from this date (FR 2011-31715). */
  effectiveFrom: string;
}

export const R03_V1_PARAMS: R03Params = Object.freeze({
  noticeWindowDays: 60,
  advisoryOffsetDays: 60,
  acknowledgeWithinDays: 30,
  resolveWithinDays: 90,
  refreshWindowDays: 90,
  effectiveFrom: "2011-12-30",
});

export const R03_V1_PARAM_SOURCES: Readonly<Record<keyof R03Params, readonly string[]>> = Object.freeze({
  noticeWindowDays: ["P-1026.13(b)", "P-1666(a)"],
  advisoryOffsetDays: ["P-1026.13(b)", "Unknown anchor"],
  acknowledgeWithinDays: ["P-1026.13(c)"],
  resolveWithinDays: ["P-1026.13(c)"],
  refreshWindowDays: ["Refresh policy"],
  effectiveFrom: ["Effective"],
});

const ECFR_13 = "https://www.ecfr.gov/current/title-12/chapter-X/part-1026/subpart-B/section-1026.13";
const ECFR_SUPP = "https://www.ecfr.gov/current/title-12/chapter-X/part-1026/appendix-Supplement%20I%20to%20Part%201026";
const USC_1666 = "https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/USCODE-2024-title15-chap41-subchapI-partD-sec1666.htm";
const ECFR_1005 = "https://www.ecfr.gov/current/title-12/chapter-X/part-1005/subpart-A/section-1005.11";

const src = (sourceId: string, url: string, passageId: string, refresh: boolean): RuleSourceMeta => ({
  sourceId, passageId, url, effective: R03_V1_PARAMS.effectiveFrom, ...(refresh ? { refreshWindowDays: R03_V1_PARAMS.refreshWindowDays } : {}),
});

/** The passages R03 v1 relies on (spec §13). The regulation, its commentary and the statute carry the refresh window. */
export const R03_V1_SOURCES: readonly RuleSourceMeta[] = Object.freeze([
  src("ecfr-12cfr1026.13", ECFR_13, "P-1026.13(a)(3)", true),
  src("ecfr-12cfr1026.13", ECFR_13, "P-1026.13(b)", true),
  src("ecfr-12cfr1026.13", ECFR_13, "P-1026.13(c)", true),
  src("ecfr-12cfr1026-suppI-13", ECFR_SUPP, "P-C13(a)(3)-1", true),
  src("ecfr-12cfr1026-suppI-13", ECFR_SUPP, "P-C13(a)(3)-3", true),
  src("ecfr-12cfr1026-suppI-13", ECFR_SUPP, "P-C13(b)-2", true),
  src("ecfr-12cfr1026-suppI-13", ECFR_SUPP, "P-C13(b)(1)", true),
  src("ecfr-12cfr1026-suppI-13", ECFR_SUPP, "P-C13(f)-3.ii", true),
  src("usc-15-1666", USC_1666, "P-1666(a)", true),
  { sourceId: "ecfr-12cfr1005.11", passageId: "P-1005.11(b)(1)", url: ECFR_1005, effective: "unknown" },
]);

const TXN = "txn";

const CONSUMER_CREDIT: ReadonlySet<string> = new Set(["consumer_credit_card", "consumer_open_end_other"]);
const REG_E: ReadonlySet<string> = new Set(["debit_card", "prepaid", "ach", "p2p"]);
/** (a)(3) errors about goods or services: the delivery record is their evidence, and R05 is an alternative. */
const GOODS_ERRORS: ReadonlySet<string> = new Set(["not_delivered_as_agreed", "not_accepted", "promised_credit_not_issued"]);
const DIFFERENCE_ERRORS: ReadonlySet<string> = new Set(["wrong_amount", "computational_error"]);
const DELIVERY_KEYS = ["card.delivery_promised_by", "card.delivery_status", "card.delivered_at", "card.delivery_tracking_summary"] as const;

/** The keys whose conflicts are candidate-tested (D152). */
const DECISIVE_KEYS = [
  "card.payment_instrument_class", "card.error_type", "card.charge_amount", "card.correct_amount",
  "card.first_statement_transmitted_on", "card.credit_issue_date", "card.notice_received_on", "card.delivery_status",
  "card.delivered_at", "card.existing_dispute_open",
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usable(cell: Cell): KnownValue | null {
  return cell.status === "candidate" || cell.known ? cell.value : null;
}
const refOf = (cell: Pick<Cell, "subjectKey" | "key">): FactRef => ({ subjectKey: cell.subjectKey, key: cell.key });
const codeOf = (v: KnownValue | null): string | null => (v && v.kind === "code" ? v.code : null);
const boolOf = (v: KnownValue | null): boolean | null => (v && v.kind === "bool" ? v.value : null);
const dateOf = (v: KnownValue | null): string | null => (v && v.kind === "local_date" ? v.date : null);
const moneyOf = (v: KnownValue | null): { amountMinor: number; currency: string } | null =>
  v && v.kind === "money" ? { amountMinor: v.amountMinor, currency: v.currency } : null;

function computed(
  id: string, label: string, kind: ComputedCondition["kind"], result: Tri, facts: readonly Cell[],
  o: { unknown?: readonly { cell: Cell; reason: MissingReason }[]; candidates?: readonly Cell[]; note?: string; passage?: string; neededFor?: string[] } = {},
): ComputedCondition {
  return {
    op: "computed", id, label, kind, result, facts: facts.map(refOf),
    ...(result === "unknown" && o.unknown ? { unknownFacts: o.unknown.map((u) => ({ fact: refOf(u.cell), reason: u.reason })) } : {}),
    ...(o.candidates && o.candidates.length > 0 ? { candidateFacts: o.candidates.map(refOf) } : {}),
    ...(o.note !== undefined ? { note: o.note } : {}),
    ...(o.passage !== undefined ? { sourcePassageId: o.passage } : {}),
    ...(o.neededFor !== undefined ? { neededFor: o.neededFor } : {}),
  };
}

/** A required single-fact leaf: a KNOWN bad value fails, a candidate bad value is asked (rule 3), unreadable is unknown. */
function leaf(id: string, label: string, kind: ComputedCondition["kind"], cell: Cell, bad: (v: KnownValue) => boolean, passage: string): ComputedCondition {
  const v = usable(cell);
  if (v === null) return computed(id, label, kind, "unknown", [cell], { unknown: [{ cell, reason: unresolvedReason(cell) }], passage });
  if (bad(v)) {
    return cell.known
      ? computed(id, label, kind, "fail", [cell], { passage })
      : computed(id, label, kind, "unknown", [cell], { unknown: [{ cell, reason: "candidate_unconfirmed" }], passage });
  }
  return computed(id, label, kind, "pass", [cell], { candidates: cell.status === "candidate" ? [cell] : [], passage });
}

function unsupportedText(instrument: string): string {
  if (REG_E.has(instrument)) {
    return "Debit-card and other electronic transfers are governed by Regulation E, not the Fair Credit Billing Act. Regulation E accepts oral or written notice received within 60 days after the statement is sent (1005.11(b)(1)); separate liability limits depend on reporting a lost or stolen access device within two business days (1005.6(b)(1)). Recoup checks that path as R13, which is not available yet.";
  }
  if (instrument === "business_credit_card") return "Recoup's R03 covers consumer credit only. Your card agreement may still provide a dispute process.";
  return "Whether this buy-now-pay-later product is a credit card under Regulation Z is unresolved, so Recoup does not check it under R03 v1.";
}

// ---------------------------------------------------------------------------
// The deadlines (spec §11, §7)
// ---------------------------------------------------------------------------

function noticeSpec(p: R03Params, errorType: string | null): DeadlineSpec {
  const fallback = errorType === "statement_not_sent" ? null : errorType === "credit_issued_not_reflected" ? "card.credit_issue_date" : "card.posting_date";
  return {
    id: R03_V1_NOTICE_DEADLINE_ID,
    label: "Your billing-error notice must be RECEIVED at the billing-error address within 60 days of the first statement showing the error",
    obligor: "user",
    anchor: { subjectPattern: TXN, factKey: "card.first_statement_transmitted_on" },
    anchorKind: "statement_transmitted",
    offset: { amount: p.noticeWindowDays, unit: "calendar_days" },
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "local_end_of_day",
    timeZone: { from: "fact", factKey: "card.billing_address_time_zone" },
    holidays: "none",
    mustBe: "received",
    ...(fallback
      ? { advisoryWhenAnchorUnknown: { fromFactKey: fallback, offsetDays: p.advisoryOffsetDays, label: "Earliest possible deadline — not the legal deadline" } }
      : {}),
    sourcePassageId: "P-1026.13(b)",
  };
}

function creditorSpec(id: string, label: string, days: number): DeadlineSpec {
  return {
    id, label, obligor: "counterparty",
    anchor: { subjectPattern: TXN, factKey: "card.notice_received_on" },
    anchorKind: "notice_received",
    offset: { amount: days, unit: "calendar_days" },
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "local_end_of_day",
    timeZone: { from: "fact", factKey: "card.billing_address_time_zone" },
    holidays: "none",
    mustBe: "sent",
    sourcePassageId: "P-1026.13(c)",
  };
}

// ---------------------------------------------------------------------------
// The core evaluation of one fact assignment
// ---------------------------------------------------------------------------

interface Core {
  dims: Omit<Dimensions, "readyForApproval">;
  flags: Flags;
  conditions: ConditionResult[];
  missing: MissingFact[];
  unconfirmed: MissingFact[];
  assumptions: Assumption[];
  amount: AmountCalc | null;
  deadlines: DeadlineResult[];
  explanation: string[];
  errorType: string | null;
}

type BaseFlags = Pick<Flags, "sourceStale" | "effectiveDateMismatch">;

function core(s: CardSnapshot, p: R03Params, now: number, base: BaseFlags): Core {
  const flags: Flags = { ...emptyFlags(), ...base };
  const explanation: string[] = [];
  const cell = (key: Parameters<typeof txnCell>[1]) => txnCell(s, key) as Cell;

  // Scope (§2) and the error (§4).
  const instrumentCell = cell("card.payment_instrument_class");
  const instrument = leaf("r03.v1.consumer_credit", "Paid with a consumer credit card or other consumer open-end credit", "applicability", instrumentCell, (v) => v.kind === "code" && !CONSUMER_CREDIT.has(v.code), "P-1026.13(b)");
  const instrumentCode = instrumentCell.known ? codeOf(instrumentCell.value) : null;
  if (instrumentCode !== null && !CONSUMER_CREDIT.has(instrumentCode)) flags.unsupportedReason = unsupportedText(instrumentCode);

  const errorCell = cell("card.error_type");
  const error = leaf("r03.v1.billing_error", "A billing error the rule covers (not a quality dispute about goods you accepted)", "exclusion", errorCell, (v) => v.kind === "code" && v.code === "quality_dispute_accepted_goods", "P-C13(a)(3)-1");
  const errorType = codeOf(usable(errorCell));
  const errorKnown = errorCell.known ? errorType : null;
  if (errorKnown === "quality_dispute_accepted_goods") {
    explanation.push("A dispute about the quality of goods or services you accepted is not a billing error (comment 13(a)(3)-1.ii). Possible separate paths, not evaluated by R03 v1: the merchant's return or warranty (R10), and claims and defenses under 12 CFR 1026.12(c) — which needs a good-faith attempt with the merchant, more than $50 and a same-state / 100-mile condition (the FTC page's '$5' is recorded, the regulation's $50 governs).");
  }
  if (errorKnown === "statement_not_sent") {
    flags.manualReviewReason = "For a statement that was never sent, the 60 days run from when it should have been sent, and a new 60 days start once it is sent (comment 13(b)(1)-1); a person needs to work out those dates.";
  }

  // The disputed amount (§8).
  const chargeCell = cell("card.charge_amount");
  const correctCell = cell("card.correct_amount");
  const charge = moneyOf(usable(chargeCell));
  let amountLeaf: ComputedCondition;
  let amount: AmountCalc | null = null;
  const amountCells: Cell[] = [chargeCell];
  if (errorType !== null && DIFFERENCE_ERRORS.has(errorType)) amountCells.push(correctCell);
  const unreadable = amountCells.filter((c) => usable(c) === null);
  const amountCandidates = amountCells.filter((c) => c.status === "candidate");
  if (unreadable.length > 0) {
    amountLeaf = computed("r03.v1.amount", "The disputed amount is known", "requirement", "unknown", amountCells, { unknown: unreadable.map((c) => ({ cell: c, reason: unresolvedReason(c) })), neededFor: ["amount"] });
  } else {
    const correct = amountCells.length > 1 ? moneyOf(usable(correctCell)) : null;
    const disputed = correct && charge ? (correct.currency === charge.currency ? charge.amountMinor - correct.amountMinor : null) : charge?.amountMinor ?? null;
    if (charge === null || disputed === null || disputed <= 0) {
      const result: Tri = amountCandidates.length > 0 ? "unknown" : "fail";
      amountLeaf = computed("r03.v1.amount", "The disputed amount is known", "requirement", result, amountCells, {
        ...(result === "unknown" ? { unknown: amountCandidates.map((c) => ({ cell: c, reason: "candidate_unconfirmed" as const })) } : {}),
        note: "The charge is not above the correct amount in the same currency.", neededFor: ["amount"],
      });
    } else {
      amountLeaf = computed("r03.v1.amount", "The disputed amount is known", "requirement", "pass", amountCells, { candidates: amountCandidates, neededFor: ["amount"] });
      amount = {
        estimate: { amountMinor: disputed, currency: charge.currency },
        basis: correct ? "exact_formula" : "documented_total",
        formula: correct
          ? `${formatMinor(charge.amountMinor, charge.currency)} charged - ${formatMinor(correct.amountMinor, correct.currency)} correct`
          : "the amount of the disputed statement line",
        inputs: [
          { label: "amount on the statement line", value: String(charge.amountMinor), fact: refOf(chargeCell) },
          ...(correct ? [{ label: "correct amount", value: String(correct.amountMinor), fact: refOf(correctCell) }] : []),
        ],
      };
    }
  }

  // A credit not reflected is dated by the credit (comment 13(b)(1)-2; §16.7).
  const creditCell = cell("card.credit_issue_date");
  const typeLeaves: ComputedCondition[] = errorType === "credit_issued_not_reflected"
    ? [leaf("r03.v1.credit_issue_date", "The date the merchant issued the credit is known", "requirement", creditCell, () => false, "P-C13(b)(1)")]
    : [];

  // The notice deadline (§11) and a notice already received.
  const anchorCell = cell("card.first_statement_transmitted_on");
  const noticeCell = cell("card.notice_received_on");
  const zoneCell = cell("card.billing_address_time_zone");
  const zone = zoneCell.known && zoneCell.value.kind === "code" ? zoneRule(zoneCell.value.code) : null;
  const deadlines: DeadlineResult[] = [];
  // The engine reads cells through a function lookup.
  const cells = (subjectKey: string, key: string) => s.lookup.get(subjectKey, key);
  let notice = computeDeadline(noticeSpec(p, errorType), cells, now);
  const received = dateOf(usable(noticeCell));
  let anchorLeaf: ComputedCondition;
  const anchorLabel = "The date the first statement showing the error was sent to you is known";
  if (errorKnown === "statement_not_sent") {
    anchorLeaf = computed(R03_V1_ANCHOR_ID, anchorLabel, "timing", "pass", [anchorCell], { note: "Not applicable: the statement was not sent." });
  } else if (usable(anchorCell) === null) {
    anchorLeaf = computed(R03_V1_ANCHOR_ID, anchorLabel, "timing", "unknown", [anchorCell], { unknown: [{ cell: anchorCell, reason: unresolvedReason(anchorCell) }], passage: "P-1026.13(b)", neededFor: ["deadline"] });
  } else if (anchorCell.status === "candidate") {
    // An unconfirmed anchor gives no firm date (D154); if even its date has passed, the user confirms before anything else.
    const today = localParts(zone ?? zoneRule("Pacific/Pago_Pago")!, now).date;
    const passed = notice.advisoryActBy !== undefined && notice.advisoryActBy < today && received === null;
    anchorLeaf = passed
      ? computed(R03_V1_ANCHOR_ID, anchorLabel, "timing", "unknown", [anchorCell], { unknown: [{ cell: anchorCell, reason: "candidate_unconfirmed" }], passage: "P-1026.13(b)" })
      : computed(R03_V1_ANCHOR_ID, anchorLabel, "timing", "pass", [anchorCell], { candidates: [anchorCell], passage: "P-1026.13(b)" });
  } else {
    anchorLeaf = computed(R03_V1_ANCHOR_ID, anchorLabel, "timing", "pass", [anchorCell], { passage: "P-1026.13(b)" });
  }
  const unconfirmedNotice: Cell[] = [];
  if (received !== null && notice.dueLocalDate !== undefined && (notice.status === "open" || notice.status === "passed")) {
    if (received <= notice.dueLocalDate) {
      // D212: the user's act happened in time — `met` (windowOpen passes; no reminder; never material).
      notice = markMet(notice, `Met: the notice was received on ${received}, on or before ${notice.dueLocalDate}.`);
      if (noticeCell.status === "candidate") unconfirmedNotice.push(noticeCell);
      if (noticeCell.known) {
        deadlines.push(
          computeDeadline(creditorSpec(R03_V1_ACK_DEADLINE_ID, "The card issuer must acknowledge your notice in writing within 30 days of receiving it", p.acknowledgeWithinDays), cells, now),
          computeDeadline(creditorSpec(R03_V1_RESOLVE_DEADLINE_ID, "The card issuer must resolve the error within two complete billing cycles, and no later than 90 days after receiving your notice", p.resolveWithinDays), cells, now),
        );
      }
    } else {
      notice = { ...notice, status: "passed", basis: `The notice was received on ${received}, after ${notice.dueLocalDate}. (${notice.basis})` };
    }
  }
  if (errorKnown !== "statement_not_sent") deadlines.unshift(notice);

  // The evidence for an (a)(3) goods dispute (§9, §16.7): missing evidence caps the outcome, it is not a question.
  const goods = errorType !== null && GOODS_ERRORS.has(errorType);
  const deliveryCells = DELIVERY_KEYS.map((k) => cell(k));
  const deliveryEvidence = goods ? deliveryCells.some((c) => usable(c) !== null) : true;
  if (goods && !deliveryEvidence) explanation.push("Add the order confirmation and the tracking record: for a delivery dispute they are the evidence behind your notice.");

  // An existing dispute for the same charge is never duplicated (§16.4).
  const existing = cell("card.existing_dispute_open");
  if (existing.known && boolOf(existing.value) === true) {
    flags.manualReviewReason = flags.manualReviewReason ?? "You already have a dispute open with the card issuer for this charge; Recoup will not prepare a second notice.";
  }

  const tree: ConditionNode = { op: "all", children: [instrument, error, amountLeaf, ...typeLeaves, anchorLeaf] };
  const evaluated = evaluateConditions(tree, lookupFrom([]));
  const missing = [...evaluated.decisiveMissing];
  const unconfirmed = [...evaluated.decisiveUnconfirmed];
  for (const c of unconfirmedNotice) addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "candidate_unconfirmed", class: "required", neededFor: ["deadline"] });

  const dims: Omit<Dimensions, "readyForApproval"> = {
    applies: evaluated.result,
    factsKnown: missing.length === 0 ? "pass" : "unknown",
    evidenceSupports: unconfirmed.length === 0 && deliveryEvidence ? "pass" : "unknown",
    windowOpen: userWindowOpen(deadlines),
    amountCalculable: amount !== null ? "pass" : evaluated.result === "fail" ? "fail" : "unknown",
  };
  return { dims, flags, conditions: evaluated.conditions, missing, unconfirmed, assumptions: [], amount, deadlines, explanation, errorType };
}

// ---------------------------------------------------------------------------
// Candidate testing (D152/D154) and the evaluator
// ---------------------------------------------------------------------------

/** Outcomes that show the disputed amount and the notice deadline (never unsupported / not eligible / unverified). */
const QUIET_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["unsupported", "not_eligible", "source_unverified"]);

function outcomeOf(c: Core): { outcome: Outcome; amount: AmountCalc | null } {
  const outcome = deriveOutcome({ ...c.dims, readyForApproval: "unknown" }, c.flags, c.assumptions);
  return { outcome, amount: QUIET_OUTCOMES.has(outcome) ? null : c.amount };
}

function conflictFlag(cell: Extract<Cell, { status: "conflicting" }>): Omit<ConflictFlag, "sameAnswer"> {
  return {
    key: cell.key,
    subjectKey: cell.subjectKey,
    kind: cell.conflict.kind,
    values: cell.conflict.values.map((v) => ({ value: formatFactValue(v.value), source: v.source.ref ? `${v.source.kind}: ${v.source.ref}` : v.source.kind })),
  };
}

function nextActionFor(outcome: Outcome, flags: Flags, missing: readonly MissingFact[], deadlines: readonly DeadlineResult[], cc: CaseContext): NextAction {
  switch (outcome) {
    case "eligible":
    case "likely_eligible":
    case "possible_contract_benefit": {
      if (cc.activeClaimId === undefined) return { kind: "open_case" };
      const overdue = deadlines.find((d) => d.obligor === "counterparty" && d.status === "overdue");
      if (overdue) return { kind: "escalate", reason: `${overdue.label}; that date (${overdue.dueLocalDate ?? "computed"}) has passed. You can file a complaint with the CFPB.` };
      return { kind: "continue_case", claimId: cc.activeClaimId };
    }
    case "needs_facts": {
      const keys: FactRef[] = [];
      for (const m of missing) if (!keys.some((k) => k.key === m.key && k.subjectKey === m.subjectKey)) keys.push({ subjectKey: m.subjectKey, key: m.key });
      return keys.length > 0 ? { kind: "answer_questions", keys } : { kind: "none", reason: "Recoup needs more facts about this charge." };
    }
    case "manual_review":
      return { kind: "manual_review", reason: flags.manualReviewReason ?? "The facts disagree; review them before a notice is prepared." };
    case "deadline_passed": {
      const d = deadlines.find((x) => x.id === R03_V1_NOTICE_DEADLINE_ID);
      return {
        kind: "none",
        reason: `The formal billing-error window closed${d?.dueLocalDate ? ` on ${d.dueLocalDate}` : ""}. That closes the formal FCBA path only: a merchant refund and the issuer's own dispute or chargeback process are not evaluated here and may still be open.`,
      };
    }
    case "unsupported":
      return { kind: "none", reason: flags.unsupportedReason ?? "Not supported." };
    case "source_unverified":
      return { kind: "none", reason: "The Regulation Z text on file is not verified as current; Recoup will not conclude until it is re-checked." };
    default:
      return { kind: "none", reason: "The formal billing-error rule does not apply to this charge." };
  }
}

export function evaluateR03V1(input: EvaluationInput<CardSnapshot, R03Params, CaseContext>): EvaluationResult {
  const { snapshot: s, pack, now, caseContext: cc } = input;
  const p = pack.params;
  const base: BaseFlags = {};
  if (sourceStale(pack.sources, input.verification, now).stale) base.sourceStale = true;
  // README rule 5: a statement (or, without one, a charge) before the rule version's effective date is a known mismatch.
  const knownDate = (key: "card.first_statement_transmitted_on" | "card.charge_date") => {
    const c = txnCell(s, key) as Cell;
    return c.known ? dateOf(c.value) : null;
  };
  const dated = knownDate("card.first_statement_transmitted_on") ?? knownDate("card.charge_date");
  if (dated !== null && dated < p.effectiveFrom) base.effectiveDateMismatch = true;

  const conflicting = DECISIVE_KEYS.map((k) => txnCell(s, k) as Cell).filter((c): c is Extract<Cell, { status: "conflicting" }> => c.status === "conflicting");
  const baseCore = core(s, p, now, base);
  let final = baseCore;
  let flags = baseCore.flags;
  let missing = baseCore.missing;
  let unconfirmed = baseCore.unconfirmed;
  const extra: string[] = [];
  if (conflicting.length > 0) {
    const choices = conflicting.map((c) =>
      alternatives(c).map((alt) => (alt.status === "candidate" ? knownCell(alt.subjectKey, alt.key, "confirmed", alt.value, { kind: "user" }) : alt)),
    );
    const combos = candidateCombinations(choices);
    const tested = (combos ?? []).map((combo) => {
      const sub: CardSnapshot = { ...s, lookup: combo.reduce((l, alt) => withOverride(l, alt), s.lookup) };
      const c = core(sub, p, now, base);
      return { core: c, answer: outcomeOf(c) };
    });
    const confirmedKinds = conflicting.filter((c) => c.conflict.kind !== "candidates");
    const conflictKeys = new Set(conflicting.map((c) => `${c.subjectKey}\u0000${c.key}`));
    const notConflict = (m: MissingFact) => !conflictKeys.has(`${m.subjectKey}\u0000${m.key}`);
    // 5c keeps only a positive answer: readings that agree on a negative or review verdict are asked (D212(b), D234(1)).
    const same = combos !== null && sameAnswer(tested.map((t) => t.answer)) && isApprovable(tested[0].answer.outcome);
    const list = withSameAnswer(conflicting.map(conflictFlag), confirmedKinds.length === 0 && same);
    const describe = (f: Omit<ConflictFlag, "sameAnswer">) => `${f.key}: ${f.values.map((x) => `${x.value} (${x.source})`).join(" vs ")}`;
    if (confirmedKinds.length > 0) {
      // 5a: the user cannot settle it by answering. A billing-error letter must be truthful.
      const delivery = confirmedKinds.some((c) => c.key === "card.delivery_status" || c.key === "card.delivered_at");
      const reason = `A value you confirmed contradicts another source — ${confirmedKinds.map((c) => describe(conflictFlag(c))).join("; ")}.${delivery ? " You told us the order never arrived, but the carrier's record shows a delivery. A billing-error letter must be truthful: check with neighbours or the carrier, or describe the discrepancy in the letter." : ""} Upload proof or correct your confirmation. The notice deadline still runs.`;
      flags = { ...baseCore.flags, manualReviewReason: reason, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = baseCore.missing.filter(notConflict);
      extra.push(reason);
    } else if (same) {
      // 5c: the answer stands, capped; the earliest-deadline reading represents it; the disputed deadline is kept.
      const rep = [...tested].sort((a, b) => (a.core.deadlines[0]?.dueAt ?? Infinity) - (b.core.deadlines[0]?.dueAt ?? Infinity))[0];
      final = { ...rep.core, deadlines: baseCore.deadlines };
      flags = { ...rep.core.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = rep.core.missing.filter(notConflict);
      unconfirmed = rep.core.unconfirmed.filter(notConflict);
      for (const c of conflicting) addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "conflict_capped", class: "required", neededFor: ["confirmation"] });
      extra.push(`Your documents disagree on ${conflicting.map((c) => c.key).join(", ")}, but every value gives the same answer; confirm the right one. Act by the earliest date shown.`);
    } else {
      // 5b: the user answers which value is right.
      const { manualReviewReason: _drop, ...rest } = baseCore.flags;
      void _drop;
      flags = { ...rest, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = [...baseCore.missing];
      for (const c of conflicting) addMissing(missing, { subjectKey: c.subjectKey, key: c.key, reason: "conflicting", class: "required", neededFor: ["outcome"] });
      extra.push(`Your documents disagree on ${list.map(describe).join("; ")}, and the answer depends on which is right.`);
    }
  }

  const d = { ...final.dims, factsKnown: missing.length === 0 ? final.dims.factsKnown : ("unknown" as Tri) };
  const outcome = deriveOutcome({ ...d, readyForApproval: "unknown" }, flags, final.assumptions);
  const quiet = QUIET_OUTCOMES.has(outcome);
  const amount = quiet ? null : final.amount;
  const deadlines = quiet ? [] : final.deadlines;
  const dimensions: Dimensions = { ...d, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  const nextAction = nextActionFor(outcome, flags, [...missing, ...unconfirmed], deadlines, cc);
  const notice = deadlines.find((x) => x.id === R03_V1_NOTICE_DEADLINE_ID);
  const goods = final.errorType !== null && GOODS_ERRORS.has(final.errorType);
  // An unsupported or unverified result names its reason only and draws no conclusion (D234, M27 R05-01 applied to R03).
  const explanation = outcome === "unsupported"
    ? [flags.unsupportedReason ?? "Recoup does not check this charge under the billing-error rule."]
    : outcome === "source_unverified"
      ? ["The Regulation Z text on file has not been verified as current, so Recoup draws no conclusion about this charge under it until the source is re-checked."]
      : [
    ...extra,
    ...(notice?.dueLocalDate && notice.status === "open" ? [`Your notice must be received at the billing-error address by ${notice.dueLocalDate} (60 days after the first statement showing the error was sent; mailing it on the last day is not enough).`] : []),
    ...(notice?.status === "unknown_anchor" && notice.advisoryActBy ? [`Act by ${notice.advisoryActBy}: the earliest the deadline could be, not the legal deadline. Check the first statement that shows this charge and when it was sent or made available to you.`] : []),
    ...(notice?.status === "disputed_anchor" && notice.advisoryActBy ? [`Act by ${notice.advisoryActBy}, the deadline under the earliest statement date on file (not a firm date until you confirm which statement first showed the charge).`] : []),
    ...(amount ? [`Disputed amount: ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)} (${amount.formula}).`] : []),
    ...final.explanation,
    ...(isApprovable(outcome) ? ["You do not have to contact the merchant first (comment 13(a)(3)-3). A phone call or an ordinary email to customer service does not preserve these rights; a written notice to the billing-error address does."] : []),
    ...(goods && isApprovable(outcome) ? ["If the seller never shipped, the FTC shipping rule (R05) may also require a prompt refund; the two paths are alternatives for the same money."] : []),
  ];

  const passages = [...new Set(["P-1026.13(b)", ...final.conditions.map((c) => c.sourcePassageId).filter((x): x is string => x !== undefined), ...(goods ? ["P-1026.13(a)(3)", "P-C13(a)(3)-3"] : [])])];
  const sourceRefs: SourceRef[] = passages
    .map((id) => pack.sources.find((x) => x.passageId === id))
    .filter((x): x is RuleSourceMeta => x !== undefined)
    .slice(0, 8)
    .map((x) => ({ sourceId: x.sourceId, passageId: x.passageId, url: x.url, effective: x.effective }));

  return {
    scenarioId: "R03",
    ruleId: pack.ruleId,
    ruleVersion: pack.version,
    engineVersion: input.engineVersion,
    remedyKey: input.remedyKey,
    subjectKey: input.subjectKey,
    snapshotHash: input.snapshotHash,
    outcome,
    dimensions,
    conditions: final.conditions,
    missingFacts: [...missing, ...unconfirmed],
    assumptions: final.assumptions,
    disqualifierIds: final.conditions.filter((c) => c.result === "fail" && c.kind !== "timing").map((c) => c.id),
    amount,
    deadlines,
    sourceRefs,
    lossKeys: r03LossKeys(s, final.errorType),
    overlap: goods && isApprovable(outcome) ? [{ withScenario: "R05", withRemedyKey: R03_R05_REMEDY_KEY, relation: "alternative" }] : [],
    nextAction,
    explanation: explanation.slice(0, 12),
    flags,
    boundFacts: cardBoundFacts(s),
  };
}

/**
 * Loss key (§3.3). A goods dispute on a card line that paid for a known order is the ORDER's paid money
 * (`txn:<orderTxnId>:paid`, the key R05 uses: alternatives, counted once); every other error is the line's own
 * money (`txn:<cardTxnId>:paid`), so two identical duplicate-charge lines are two losses (DA-A-30).
 */
export function r03LossKeys(s: Pick<CardSnapshot, "transactionId" | "relatedTransactionId">, errorType: string | null): string[] {
  const goods = errorType !== null && GOODS_ERRORS.has(errorType);
  return [`txn:${goods && s.relatedTransactionId ? s.relatedTransactionId : s.transactionId}:paid`];
}

/** Packet readiness (§16.8), separate from eligibility. */
export type R03Readiness = {
  status: "ready_for_user_review" | "blocked_channel" | "blocked_address";
  requiredChannel: "postal_mail" | "portal";
  message?: string;
};

/**
 * Whether the notice can be prepared: an ordinary email, a phone call or an app button does not preserve the formal
 * right (§10; comment 13(b)-2 — only the electronic means the billing-rights statement designates counts); a postal
 * notice needs the billing-error address from the statement, never a guessed one (§12).
 */
export function r03PacketReadiness(s: Pick<CardSnapshot, "lookup">, result?: Pick<EvaluationResult, "deadlines">): R03Readiness {
  const known = (key: Parameters<typeof txnCell>[1]) => {
    const c = txnCell(s, key) as Cell;
    return c.known ? c.value : null;
  };
  const channel = codeOf(known("card.notice_channel_planned"));
  const stipulated = boolOf(known("card.electronic_notice_stipulated")) === true;
  const requiredChannel: R03Readiness["requiredChannel"] = channel === "stipulated_electronic" && stipulated ? "portal" : "postal_mail";
  const due = result?.deadlines.find((d) => d.id === R03_V1_NOTICE_DEADLINE_ID)?.dueLocalDate;
  const by = due ? ` so that it arrives by ${due}` : "";
  if (channel === "email_customer_service" || channel === "phone" || channel === "app_dispute_button" || (channel === "stipulated_electronic" && !stipulated)) {
    return {
      status: "blocked_channel",
      requiredChannel,
      message: channel === "stipulated_electronic"
        ? `Your statement's billing-rights section must name the electronic means for this to count. Otherwise send the letter to the billing-error address on your statement${by}.`
        : `${channel === "phone" ? "A phone call" : channel === "app_dispute_button" ? "An app dispute button" : "An ordinary email to customer service"} does not preserve your formal billing-error rights with this issuer. Send the letter to the billing-error address on your statement${by}.`,
    };
  }
  if (requiredChannel === "postal_mail" && known("card.billing_error_address") === null) {
    return { status: "blocked_address", requiredChannel, message: "Add the billing-error address printed on your statement (not the payment address)." };
  }
  return { status: "ready_for_user_review", requiredChannel };
}

/** The claim's required channel from a result's bound facts (M20 `requiredChannel` hook): postal unless designated. */
export function r03RequiredChannel(result: Pick<EvaluationResult, "boundFacts">): "postal_mail" | "portal" {
  const value = (key: string): BoundFactValue["value"] | undefined => {
    const b = result.boundFacts.find((x) => x.key === key && x.subjectKey === TXN);
    return b && (b.status === "confirmed" || b.status === "observed" || b.status === "derived") ? b.value : undefined;
  };
  const channel = value("card.notice_channel_planned");
  const stipulated = value("card.electronic_notice_stipulated");
  return channel?.kind === "code" && channel.code === "stipulated_electronic" && stipulated?.kind === "bool" && stipulated.value ? "portal" : "postal_mail";
}

/** The pack's run adapter (D208, M20's `PackAdapter.runs`): one run per card line (DA-A-30), on subject `txn`. Pure. */
export function r03AdapterRuns(input: { transactionId: Id<"transactions">; relatedTransactionId?: Id<"transactions">; isExample: boolean; rows: readonly CellRow[] }): { subjectKey: string; snapshot: CardSnapshot; lookup: CellLookup }[] {
  const snapshot = buildCardSnapshot({ transactionId: input.transactionId, ...(input.relatedTransactionId ? { relatedTransactionId: input.relatedTransactionId } : {}), rows: input.rows });
  return [{ subjectKey: TXN, snapshot, lookup: snapshot.lookup }];
}

export const r03BillingErrorV1: RulePack<CardSnapshot, R03Params, CaseContext> = {
  ruleId: R03_V1_RULE_ID,
  scenarioId: "R03",
  version: R03_V1_VERSION,
  // Informative only: the manifest + the lead's activation entry decide status.
  lifecycle: "researched",
  authority: { class: "legal_entitlement", subtype: "Federal statute + regulation + official interpretation (15 U.S.C. 1666; 12 CFR 1026.13; Supplement I comments 13(a)–13(i))" },
  jurisdiction: "US — consumer open-end credit (credit cards and other open-end consumer plans)",
  categories: ["card_charge"],
  remedyKey: R03_REMEDY_KEY,
  remedyType: "billing_correction",
  cashClass: "cash",
  params: R03_V1_PARAMS,
  sources: R03_V1_SOURCES,
  requirements: [
    { subjectPattern: TXN, key: "card.payment_instrument_class", class: "required" },
    { subjectPattern: TXN, key: "card.error_type", class: "required" },
    { subjectPattern: TXN, key: "card.charge_amount", class: "required" },
    { subjectPattern: TXN, key: "card.correct_amount", class: "required" },
    { subjectPattern: TXN, key: "card.first_statement_transmitted_on", class: "required" },
    { subjectPattern: TXN, key: "card.credit_issue_date", class: "required" },
  ],
  fixturesPath: "docs/rules/fixtures/R03.json",
  lateAskDeadlineIds: [],
  overlap: [{ withScenario: "R05", withRemedyKey: R03_R05_REMEDY_KEY, relation: "alternative" }],
  knownLimitations: [
    "L1: the legal anchor is the statement's TRANSMITTAL date, often unobservable; the closing date is never used. Unknown → needs_facts with a labelled conservative act-by.",
    "L2: no weekend or holiday roll-forward of day 60 (A1); the UI's 'mail by' buffer is product policy.",
    "L3: issuers' electronic channels vary; only the means the billing-rights statement designates counts, and Recoup cannot verify an app button is that means.",
    "L4: claims and defenses (12 CFR 1026.12(c)) is a different right with different conditions; not implemented in R03 v1.",
    "L5: BNPL products → unsupported. L6: business cards → unsupported. L9: person-to-person intermediaries → unsupported.",
    "L10: for a promised credit never issued the window runs from the statement with the original charge; a late return may leave the formal path closed.",
    "A statement that was never sent (a)(7) has its own anchor and goes to manual review.",
    "Reassertion of an error the creditor already resolved (1026.13(h)) is not modelled.",
    "Without the billing-error address's time zone, day 60 ends at the earliest-ending US time zone (conservative for your own deadline).",
  ],
  evaluate: evaluateR03V1,
  adapter: { runs: r03AdapterRuns }, // M20 (D208): one run per card line, subject txn
  requiredChannel: r03RequiredChannel, // M20 (DA-A-9): postal unless the electronic designation is confirmed (D143.3)
};
