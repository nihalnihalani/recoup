/**
 * R02 v1 — airline fare refund for a cancelled or significantly delayed/changed flight (docs/rules/R02-airline-refund.md,
 * spec gate M09/M09b/M09c `approve_for_activation`, D158; fixtures docs/rules/fixtures/R02.json). Pure: no ctx, no clock
 * (`now` is injected), no randomness, no `lib/ai`.
 *
 * What it evaluates. One ticket (subject `txn` of an `air_travel` transaction) against 14 CFR 260.6 (carrier as merchant
 * of record: automatic refund, path R02.a) or 14 CFR 399.80(l) (ticket agent as merchant of record: refund on request,
 * path R02.b). The spec's ordered outline (§16) is implemented as stages; each stage is a tri-state condition and the
 * outcome comes ONLY from `deriveOutcome`:
 *   1  source freshness (30-day refresh; README rule 3; the renumbered-flight pause end, L1) and the compliance-date
 *      gate (FR-2024-07177-COMPLIANCE; an unknown date or zone → capped with an assumption, README rule 5, D234 (8))
 *   2  scope: a covered flight (P-260.2-COVERED; `non_us` → unsupported) and a nonrefundable ticket (refundable →
 *      unsupported in v1)
 *   3  event (always decisive, M27 R02-02): cancellation (incl. a renumbered-only flight, P-260.2-CANCEL, which is
 *      manual_review under the enforcement pause, L1) or a significant delay/change (P-260.2-SIG criteria 1–5; an
 *      operational delay is judged on the carrier's revised scheduled arrival, and a revised schedule and actual arrival
 *      on opposite sides of the threshold → manual_review)
 *   4  the passenger did not fly the changed/alternative flight (P-260.6-A1(i); L4 downgrade fare difference and L5
 *      accepted-but-not-flown → manual_review)
 *   5  a deemed refund request (P-260.6-A2 (i)/(ii)/(iii)) and no affirmatively accepted compensation (P-260.7: only the
 *      user's own confirmation counts); a no-response request whose trigger (a departure) is still in the future →
 *      not_yet_due at that date
 *   6  the path (merchant of record, P-260.2-MOR); for R02.a the deemed-request instant (the carrier timer's anchor,
 *      spec §11 "anchor unknown → needs_facts")
 *   7  the amount inputs (§8): fare + taxes + ancillary fees − already refunded (before the case started), one
 *      currency; a partly flown itinerary or a full prior refund keeps the outcome but has no estimate (A4; D235 (B))
 *
 * Unconfirmed values (D234 (1); M27 R02-01/09/11): a negative, not-yet-due or review verdict never rests on an
 * extracted candidate. A fail, `unsupported`, `not_yet_due` or `manual_review` that a candidate would decide becomes a
 * question instead (reason `candidate_unconfirmed`); a candidate that keeps the refund alive only caps it at
 * likely_eligible (D147(2)). Two conflicting candidates that give the same NEGATIVE answer are asked, not capped.
 *
 * Questions (DA-A-24; D234 (2)). Only decisive unknowns are listed — the §16.8 list, each fact only when flipping it
 * could change the outcome given the known facts — and only those of the FIRST unresolved stage in the order above
 * (a stage whose only unknowns are "I don't know" answers does not hold the later stages back, M27 R02-23). Within
 * significance the criterion the event type names is asked first. The disability criteria (6)/(7) are raised by the
 * passenger (260.6(b) "upon notification") and never asked; only the user's own confirmed `true` gives manual_review
 * (L11; D234 (7)). The carrier and `offer_type` on a rejection decide nothing in v1 and are not asked.
 *
 * Carrier timer (DA-A-5, DA-A-25; D234 (3), (6), (8); D235 (A)). A COUNTERPARTY deadline: 7 business days (credit
 * card) or 20 calendar days (cash, check, debit card, miles, other) after the deemed-request date (P-260.2-PROMPT),
 * counted from the day after, US federal holidays skipped, in the consumer's home time zone (A1). The payment class
 * decides only which timer applies and never the outcome; while it is unconfirmed the timer has no date
 * (`unknown_anchor`). With the home zone unknown the date shows as "on or about <earliest> – <latest>" across the US
 * zones, and status, overdue and `escalate` wait for the LATEST-ending zone. A `manual_review` result shows no firm
 * carrier date. The DOT page's "20 business days" (DOT-REF-3) is disclosed on the 20-day timer (L2). Next action:
 * carrier → `track`, overdue → `escalate`; ticket agent → `request_refund` (D143.2).
 *
 * Status. This file declares `lifecycle: "researched"`; only the lead's activation entry and the manifest decide the
 * real status. "Active" would mean independently reviewed against the captured text — never legal certification.
 */
import { currencyExponent, formatMinor } from "../money";
import { alternatives, knownCell, withOverride, type Cell, type CellLookup as FactLookup } from "../facts/resolve";
import { AIR_TXN_SUBJECT, buildAirSnapshot, r02BoundFacts, r02View, type AirSnapshotInput, type R02View } from "../facts/snapshot_air";
import { AIR_VOUCHER_ACCEPTANCE } from "../facts/keys_air";
import { computeDeadlineDetailed, overdueCounterpartyDeadlines } from "../deadlines/engine";
import { localParts, US_ZONES, zoneRule, type ZoneRule } from "../deadlines/usZones";
import { addMissing, evaluateConditions } from "./conditions";
import { candidateCombinations, deriveOutcome, notYetDueAction, sameAnswer, sourceStale, withSameAnswer } from "./outcome";
import {
  emptyFlags,
  isApprovable,
  lookupFrom,
  unresolvedReason,
  type AmountCalc,
  type Assumption,
  type BoundFactValue,
  type CaseContext,
  type CellLookup as EngineLookup,
  type ComputedCondition,
  type ConditionKind,
  type ConditionNode,
  type ConditionResult,
  type ConflictFlag,
  type DeadlineResult,
  type DeadlineSpec,
  type Dimensions,
  type EngineCell,
  type EngineConflictValue,
  type EvaluationInput,
  type EvaluationResult,
  type FactRef,
  type FactValue,
  type Flags,
  type MissingFact,
  type MissingReason,
  type NextAction,
  type OverlapDecl,
  type Outcome,
  type RulePack,
  type RuleSourceMeta,
  type SourceRef,
  type Tri,
} from "./types";

export const R02_V1_RULE_ID = "R02.airline_fare_refund.us_dot";
export const R02_V1_VERSION = 1;
export const R02_REMEDY_KEY = "fare_refund";
/**
 * R03's remedy key, for the declared alternative (spec §16 steps 4 and 10: a credit-card payment dispute is a fallback
 * channel for the same money, never additive; the same key R05 declares). M27 R02-18.
 */
export const R02_R03_REMEDY_KEY = "billing_error_credit";
const R03_ALTERNATIVE: OverlapDecl = Object.freeze({ withScenario: "R03", withRemedyKey: R02_R03_REMEDY_KEY, relation: "alternative" });
export const R02_CARRIER_TIMER_CREDIT_ID = "r02.v1.carrier_refund.credit_card";
export const R02_CARRIER_TIMER_OTHER_ID = "r02.v1.carrier_refund.other";
export const R02_AGENT_TIMER_ID = "r02.v1.agent_refund";
/** The compliance-gate assumption (README rule 5; D234 (8)). */
export const R02_GATE_ASSUMPTION_ID = "r02.v1.after_compliance_date";
/** A8 (lead ruling D253(3); spec §16 step 8, L13): an unknown service type caps the result, never rules it out. */
export const R02_SCHEDULED_ASSUMPTION_ID = "r02.v1.scheduled_flight";
const SCHEDULED_ASSUMPTION: Assumption = Object.freeze({
  id: R02_SCHEDULED_ASSUMPTION_ID,
  text: "Recoup assumes a regularly scheduled flight: the refund rule covers scheduled flights, and the service type is not confirmed yet (A8).",
  changesOutcomeIf: "the flight was a charter or other non-scheduled flight (then R02 does not apply)",
});
const NON_SCHEDULED = ["public_charter", "other_non_scheduled"] as const;

// ---------------------------------------------------------------------------
// Parameters — every number/date below cites the passage it comes from (README "From spec to evaluator")
// ---------------------------------------------------------------------------

export interface R02Params {
  /** "three hours or more for domestic itineraries" (P-260.2-SIG (1)/(2)); the statute's arrival floor (P-42305-D (1)). */
  domesticThresholdMinutes: number;
  /** "six hours or more for international itineraries" (P-260.2-SIG (1)/(2)); statute floor P-42305-D (2). */
  internationalThresholdMinutes: number;
  /** "within 7 business days … for credit card purchases" (P-260.2-PROMPT; P-42305-B (1)). */
  creditCardBusinessDays: number;
  /** "within 20 calendar days … for cash, check, debit card, or other forms of purchases" (P-260.2-PROMPT). */
  otherPaymentCalendarDays: number;
  /**
   * Refund provisions' compliance date "October 28, 2024" (FR-2024-07177-COMPLIANCE; the quoted words are in
   * `sources/federal-web-pages-excerpts.md`); spec §16 step 1b.
   */
  refundComplianceDate: string;
  /**
   * Renumbered-flight enforcement pause "expiring on July 7, 2027" (FR-2026-13675-DATES; the quoted words are in
   * `sources/federal-web-pages-excerpts.md`); spec L1. After it, a renumbered-only flight is `source_unverified` until
   * the pack is re-reviewed (spec header "mandatory re-review on or before 2027-07-07").
   */
  renumberedPauseEnds: string;
}

export const R02_V1_PARAMS: R02Params = Object.freeze({
  domesticThresholdMinutes: 180,
  internationalThresholdMinutes: 360,
  creditCardBusinessDays: 7,
  otherPaymentCalendarDays: 20,
  refundComplianceDate: "2024-10-28",
  renumberedPauseEnds: "2027-07-07",
});

/** Machine-readable citations of every parameter (asserted against the spec in the pack's test). */
export const R02_PARAM_PASSAGES: Readonly<Record<keyof R02Params, readonly string[]>> = Object.freeze({
  domesticThresholdMinutes: ["P-260.2-SIG", "P-42305-D"],
  internationalThresholdMinutes: ["P-260.2-SIG", "P-42305-D"],
  creditCardBusinessDays: ["P-260.2-PROMPT", "P-42305-B"],
  otherPaymentCalendarDays: ["P-260.2-PROMPT"],
  refundComplianceDate: ["FR-2024-07177-COMPLIANCE"],
  renumberedPauseEnds: ["FR-2026-13675-DATES"],
});

const ECFR_260 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260";
const ECFR_254 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-254";
const USC_42305 = "https://www.govinfo.gov/content/pkg/USCODE-2024-title49/html/USCODE-2024-title49-subtitleVII-partA-subpartii-chap423-sec42305.htm";
const ECFR_399 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-F/part-399/subpart-G/section-399.80";
const DOT_REFUNDS = "https://www.transportation.gov/individuals/aviation-consumer-protection/refunds";
const FR_2024_07177 = "https://www.federalregister.gov/documents/2024/04/26/2024-07177";
const FR_2026_13675 = "https://www.federalregister.gov/documents/2026/07/07/2026-13675/airline-refunds-and-other-consumer-protections";
/** Refresh window in days: spec header "Refresh policy — every 30 days"; README rule 3 (R02 30). */
const REFRESH_DAYS = 30;

/**
 * Mandatory re-review date: manifest `mandatoryReviewBy` (spec header "mandatory re-review on or before 2027-07-07", the
 * end of DOT's renumbered-flight enforcement pause, FR-2026-13675-DATES). From that date every source is stale until a
 * verification dated on or after it exists (M20b E5).
 */
const MANDATORY_REVIEW_BY = "2027-07-07";

const src = (sourceId: string, passageId: string, url: string, effective: string): RuleSourceMeta =>
  Object.freeze({ sourceId, passageId, url, effective, refreshWindowDays: REFRESH_DAYS, mandatoryReviewBy: MANDATORY_REVIEW_BY });

/** Captured sources (manifest `sources`, spec §14). Every one has the 30-day refresh window (spec header). */
export const R02_SOURCES: readonly RuleSourceMeta[] = Object.freeze([
  src("ecfr-14cfr260", "P-260.2-COVERED", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-CARRIER", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-CANCEL", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-SIG", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-MOR", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-PROMPT", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.2-BD", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.6-A1", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.6-A2", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.7", ECFR_260, "2024-06-25"),
  src("ecfr-14cfr260", "P-260.10", ECFR_260, "2024-06-25"),
  src("usc-49-42305", "P-42305-B", USC_42305, "2024-05-16"),
  src("usc-49-42305", "P-42305-D", USC_42305, "2024-05-16"),
  src("ecfr-14cfr399.80l", "P-399.80(l)", ECFR_399, "unknown"),
  src("federal-web-excerpts", "DOT-REF-3", DOT_REFUNDS, "unknown"),
  src("federal-web-excerpts", "FR-2024-07177-COMPLIANCE", FR_2024_07177, "2024-06-25"),
  src("fr-notices", "FR-2026-13675-DATES", FR_2026_13675, "2026-07-07"),
  // Erratum E-R02-1 (S7): 254.2 names "charter or scheduled passenger service" separately.
  src("ecfr-14cfr254", "P-254.2", ECFR_254, "2025-01-22"),
]);

// ---------------------------------------------------------------------------
// Keys and small readers
// ---------------------------------------------------------------------------

const TXN = "txn";
const MINUTE_MS = 60_000;
const K = {
  scope: "air.itinerary_scope",
  operating: "air.operating_carrier",
  marketing: "air.marketing_carrier",
  service: "air.service_type",
  mor: "air.merchant_of_record",
  refundability: "air.ticket_refundability",
  event: "air.event_type",
  oDep: "air.original_sched_departure_at",
  oArr: "air.original_sched_arrival_at",
  cDep: "air.changed_sched_departure_at",
  cArr: "air.changed_sched_arrival_at",
  actualArr: "air.actual_arrival_at",
  oOrigin: "air.original_origin_airport",
  oDest: "air.original_destination_airport",
  cOrigin: "air.changed_origin_airport",
  cDest: "air.changed_destination_airport",
  oConn: "air.original_connections",
  cConn: "air.changed_connections",
  oCabin: "air.original_cabin",
  cCabin: "air.changed_cabin",
  disability: "air.passenger_disability_relevant",
  offer: "air.offer_type",
  response: "air.consumer_response",
  responseAt: "air.consumer_response_at",
  flew: "air.flew_changed_or_alternative",
  altDeparts: "air.changed_or_alternative_departs_at",
  cancelNotice: "air.cancellation_notice_at",
  payment: "air.payment_method_class",
  fare: "air.fare_paid",
  taxes: "air.taxes_paid",
  ancillary: "air.ancillary_fees_total",
  refunded: "air.already_refunded",
  partlyFlown: "air.partly_flown",
  homeZone: "air.home_time_zone",
} as const;

/** Cabin order, highest first: a changed cabin later in the list is a downgrade (P-260.2-SIG (5)). */
const CABIN_RANK: Readonly<Record<string, number>> = Object.freeze({ first: 0, business: 1, premium_economy: 2, economy: 3 });
const OTHER_PAYMENTS = ["debit_card", "cash", "check", "miles", "other"] as const;
/** Spec §5: airports are IATA codes; criterion (3) compares only codes (M27 R02-13). */
const IATA = /^[A-Z]{3}$/;

type Money = { amountMinor: number; currency: string };
const valueOf = (c: Cell): FactValue | null => (c.status === "candidate" || c.known ? c.value : null);
const usable = (c: Cell): boolean => valueOf(c) !== null;
function code(c: Cell): string | null {
  const v = valueOf(c);
  return v?.kind === "code" ? v.code : null;
}
function bool(c: Cell): boolean | null {
  const v = valueOf(c);
  return v?.kind === "bool" ? v.value : null;
}
function instant(c: Cell): number | null {
  const v = valueOf(c);
  return v?.kind === "instant" && Number.isFinite(v.epochMs) ? v.epochMs : null;
}
/** An instant from a KNOWN cell only (ripeness, the gate and departures never rest on candidates, D234 (1)). */
function knownInstant(c: Cell): number | null {
  return c.known ? instant(c) : null;
}
function count(c: Cell): number | null {
  const v = valueOf(c);
  return v?.kind === "count" ? v.n : null;
}
function money(c: Cell): Money | null {
  const v = valueOf(c);
  return v?.kind === "money" ? { amountMinor: v.amountMinor, currency: v.currency } : null;
}
function label(c: Cell): string | null {
  const v = valueOf(c);
  if (v?.kind === "text") return v.text.trim().toUpperCase();
  if (v?.kind === "identifier") return v.value.trim().toUpperCase();
  return null;
}
const ref = (c: Cell): FactRef => ({ subjectKey: c.subjectKey, key: c.key });
function show(v: FactValue): string {
  switch (v.kind) {
    case "money": return formatMinor(v.amountMinor, v.currency);
    case "instant": return `${new Date(v.epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    case "code": return v.code;
    case "bool": return v.value ? "yes" : "no";
    case "count": return String(v.n);
    case "text": return v.text;
    case "identifier": return v.value;
    case "local_date": return v.date;
    case "local_datetime": return v.dateTime;
    case "minutes": return `${v.minutes} min`;
    case "user_unknown": return "I don't know";
  }
}
/** "3h10m" from a millisecond span (display only; truncated, so a note never contradicts its result, M27 R02-22). */
function hm(ms: number): string {
  const total = Math.floor(Math.abs(ms) / MINUTE_MS);
  return `${ms < 0 ? "-" : ""}${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// Stages and condition leaves
// ---------------------------------------------------------------------------

/** Spec §16 order; questions come from the first stage with a decisive unknown. */
const STAGES = ["gate", "scope", "event", "significance", "significance_other", "not_flown", "response", "path", "anchor", "amount"] as const;
type Stage = (typeof STAGES)[number];

/**
 * A computed condition. D234 (1): a `fail` that rests on an unconfirmed cell (a candidate, or an observed value where
 * only the user's own confirmation counts) is never a fail — it is `unknown` and asks that cell (`candidate_unconfirmed`).
 */
function leaf(
  stage: Stage, id: string, text: string, kind: ConditionKind, result: Tri, used: readonly Cell[],
  opts: { unknown?: readonly Cell[]; note?: string; passage?: string; unconfirmed?: readonly Cell[] } = {},
): ComputedCondition {
  let res = result;
  let unknownFacts: { fact: FactRef; reason: MissingReason }[] = (opts.unknown ?? []).map((c) => ({ fact: ref(c), reason: unresolvedReason(c) }));
  const guarded = res === "fail" ? [...used.filter((c) => c.status === "candidate"), ...(opts.unconfirmed ?? [])] : [];
  if (guarded.length > 0) {
    res = "unknown";
    unknownFacts = guarded.map((c) => ({ fact: ref(c), reason: "candidate_unconfirmed" as const }));
  }
  const guardedIds = new Set(guarded.map((c) => `${c.subjectKey}\u0000${c.key}`));
  const seen = new Set<string>();
  const facts: FactRef[] = [];
  for (const c of [...used, ...(opts.unknown ?? []), ...guarded]) {
    const id2 = `${c.subjectKey}\u0000${c.key}`;
    if (!seen.has(id2)) {
      seen.add(id2);
      facts.push(ref(c));
    }
  }
  const candidateFacts = used.filter((c) => c.status === "candidate" && !guardedIds.has(`${c.subjectKey}\u0000${c.key}`)).map(ref);
  return {
    op: "computed", id, label: text, kind, result: res, facts,
    ...(res === "unknown" ? { unknownFacts } : {}),
    ...(candidateFacts.length > 0 ? { candidateFacts } : {}),
    neededFor: [stage],
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.passage !== undefined ? { sourcePassageId: opts.passage } : {}),
  };
}

/** A span measured against the scope's threshold; the scope is "used" only when it decides (both thresholds disagree). */
function againstThreshold(spanMs: number, scope: Cell, p: R02Params): { result: Tri; used: Cell[]; unknown: Cell[] } {
  const domestic = spanMs >= p.domesticThresholdMinutes * MINUTE_MS;
  const international = spanMs >= p.internationalThresholdMinutes * MINUTE_MS;
  if (domestic === international) return { result: domestic ? "pass" : "fail", used: [], unknown: [] };
  const s = code(scope);
  if (s === "domestic") return { result: domestic ? "pass" : "fail", used: [scope], unknown: [] };
  if (s === "international" || s === "non_us") return { result: international ? "pass" : "fail", used: [scope], unknown: [] };
  return { result: "unknown", used: [], unknown: [scope] };
}

function thresholdLabel(scope: Cell, p: R02Params): string {
  const s = code(scope);
  if (s === "domestic") return `${p.domesticThresholdMinutes / 60} hours (domestic)`;
  if (s === "international" || s === "non_us") return `${p.internationalThresholdMinutes / 60} hours (international)`;
  return `${p.domesticThresholdMinutes / 60} hours domestic / ${p.internationalThresholdMinutes / 60} hours international`;
}

/** How the refund request is deemed made (P-260.6-A2) and which fact holds its instant (the carrier timer's anchor). */
interface Basis {
  kind: "rejected" | "no_response_flight" | "no_response_voucher" | "no_response_both" | "cancelled_nothing_offered";
  /** The anchor facts; the earliest instant wins ("the earliest date the refund was requested", P-260.2-PROMPT). */
  anchorKeys: string[];
  passage: string;
}

function basisFor(response: string | null, offer: string | null, event: string | null, altKey: string, voucherKey: string): Basis | null {
  if (response === "rejected") return { kind: "rejected", anchorKeys: [K.responseAt], passage: "P-260.6-A2" };
  const cancelled = event === "cancellation" || event === "renumbered_only";
  if (response === "no_response" || (response === null && offer === "none" && cancelled)) {
    if (offer === "none") {
      return cancelled
        ? { kind: "cancelled_nothing_offered", anchorKeys: [K.cancelNotice], passage: "P-260.6-A2" }
        : { kind: "no_response_flight", anchorKeys: [altKey], passage: "P-260.6-A2" };
    }
    if (offer === "rebooking") return { kind: "no_response_flight", anchorKeys: [altKey], passage: "P-260.6-A2" };
    if (offer === "voucher_or_credit") return { kind: "no_response_voucher", anchorKeys: [voucherKey], passage: "P-260.6-A2" };
    if (offer === "both") return { kind: "no_response_both", anchorKeys: [altKey, voucherKey], passage: "P-260.6-A2" };
  }
  return null;
}

const BASIS_TEXT: Record<Basis["kind"], string> = {
  rejected: "you rejected the airline's offer (260.6(a)(2)(ii))",
  no_response_flight: "you did not respond and the changed or replacement flight departed without you (260.6(a)(2)(iii)(A))",
  no_response_voucher: "you did not respond to the voucher or credit offer by the flight's departure date (260.6(a)(2)(iii)(B))",
  no_response_both: "you did not respond to the airline's offers (260.6(a)(2)(iii))",
  cancelled_nothing_offered: "the flight was cancelled and nothing was offered (260.6(a)(2)(i); anchor = the cancellation notice, assumption A7)",
};

// ---------------------------------------------------------------------------
// Core: one fact assignment → dimensions, flags, conditions, amount, deadlines
// ---------------------------------------------------------------------------

interface Core {
  dims: Omit<Dimensions, "readyForApproval">;
  flags: Flags;
  conditions: ConditionResult[];
  /** Decisive unresolved facts of the first unresolved stage(s) (the questions). */
  missing: MissingFact[];
  /** Every decisive unresolved fact (all stages) — conflicts are candidate-tested only when decisive. */
  decisiveUnresolved: MissingFact[];
  /** Decisive facts used only as unconfirmed candidates (D147(2)): they cap the outcome. */
  unconfirmed: MissingFact[];
  assumptions: Assumption[];
  amount: AmountCalc | null;
  deadlines: DeadlineResult[];
  path: "a" | "b" | null;
  /** Failing conditions that decide not_eligible (a failed criterion inside a passing "any" is not one). */
  disqualifierIds: string[];
  explanation: string[];
  /** Notes about the carrier timer (disclosed source conflict, time-zone range): shown only with the timer. */
  deadlineNotes: string[];
  passages: string[];
  /** The earliest known departure that a no-response request waits for (5c takes the minimum across alternatives). */
  notYetDueAt?: number;
}

interface Env {
  p: R02Params;
  now: number;
  stale: boolean;
}

/** The instant's local dates: in the home zone when known, else in every US zone (the committed zone table). */
function localDates(epochMs: number, home: ZoneRule | null): string[] {
  try {
    return home ? [localParts(home, epochMs).date] : US_ZONES.map((z) => localParts(z, epochMs).date);
  } catch {
    // Before the committed DST table (2007): the UTC date is close enough for a pre-rule event.
    return [new Date(epochMs).toISOString().slice(0, 10)];
  }
}

/** A re-evaluation date: the earliest local date the instant falls on (re-checking early is harmless). */
function earliestLocalDate(epochMs: number, home: ZoneRule | null): string {
  return [...localDates(epochMs, home)].sort()[0];
}

function carrierTimers(anchorKey: string, p: R02Params, zone: string | null): DeadlineSpec[] {
  const payIs = (codes: readonly string[], id: string): ConditionNode => ({
    op: "fact", id, label: "Payment method selects this timer", kind: "applicability",
    fact: { subjectKey: TXN, key: K.payment },
    test: (v) => v.kind === "code" && codes.includes(v.code),
  });
  const common = {
    obligor: "counterparty" as const,
    anchor: { subjectPattern: TXN, factKey: anchorKey },
    anchorKind: "refund_duty_start" as const,
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "local_end_of_day" as const,
    timeZone: zone === null ? { from: "fact" as const, factKey: K.homeZone } : { fixed: zone },
    mustBe: "paid" as const,
    sourcePassageId: "P-260.2-PROMPT",
  };
  return [
    {
      ...common,
      id: R02_CARRIER_TIMER_CREDIT_ID,
      label: `The airline's refund deadline: ${p.creditCardBusinessDays} business days (credit card)`,
      offset: { amount: p.creditCardBusinessDays, unit: "business_days" },
      holidays: "us_federal",
      appliesWhen: payIs(["credit_card"], "r02.v1.timer.credit_card"),
    },
    {
      ...common,
      id: R02_CARRIER_TIMER_OTHER_ID,
      label: `The airline's refund deadline: ${p.otherPaymentCalendarDays} calendar days (cash, check, debit card or other)`,
      offset: { amount: p.otherPaymentCalendarDays, unit: "calendar_days" },
      holidays: "none",
      appliesWhen: payIs(OTHER_PAYMENTS, "r02.v1.timer.other"),
    },
  ];
}

const L2_DISCLOSURE =
  "Source conflict (disclosed, L2): DOT's consumer page says '20 business days (for cash purchases)' in one place (DOT-REF-3); the regulation says 20 calendar days (P-260.2-PROMPT), which Recoup uses.";

/**
 * The airline's timer for one anchor (D234 (3)/(8); D235 (A)), computed by the deadline engine. With the home zone
 * known (a KNOWN cell; a candidate zone decides nothing) it is fixed there. With it unknown, the engine's counterparty
 * fallback (M20b E1) computes every US zone: status / overdue / escalate wait for the latest-ending zone, the shown date
 * is the earliest local due date, and `dueLocalDateRange` carries "on or about <earliest> – <latest>". A candidate
 * payment class selects no timer (E4 → `unknown_anchor`).
 */
function carrierTimer(anchorKey: string, p: R02Params, lookup: EngineLookup, home: ZoneRule | null, now: number): { result: DeadlineResult; notes: string[] } | null {
  const guarded: EngineLookup = (s, k) => (s === TXN && k === K.homeZone && home === null ? { subjectKey: TXN, key: K.homeZone, status: "missing" } : lookup(s, k));
  const selected = carrierTimers(anchorKey, p, home?.id ?? null)
    .map((spec) => computeDeadlineDetailed(spec, guarded, now).result)
    .find((d) => d.status !== "not_applicable");
  if (!selected) return null;
  const range = selected.dueLocalDateRange;
  return {
    result: selected,
    notes: range ? [`On or about ${range.earliest} – ${range.latest}, depending on your time zone (not known yet); Recoup treats the airline as late only after the latest of these (A1).`] : [],
  };
}

function core(v: R02View, env: Env): Core {
  const { p, now } = env;
  const cell = (key: string): Cell => v.lookup.get(TXN, key);
  const flags: Flags = emptyFlags();
  const explanation: string[] = [];
  const passages: string[] = ["P-260.6-A1"];
  const assumptions: Assumption[] = [];
  if (env.stale) flags.sourceStale = true;

  const scope = cell(K.scope);
  const refundability = cell(K.refundability);
  const event = cell(K.event);
  const eventCode = code(event);
  const eventKnown = event.known;
  const mor = cell(K.mor);
  const morCode = code(mor);
  const offer = cell(K.offer);
  const offerCode = code(offer);
  const response = cell(K.response);
  const responseCode = code(response);
  const flew = cell(K.flew);
  const flewValue = bool(flew);
  const alt = cell(K.altDeparts);
  const cDep = cell(K.cDep);
  const oDep = cell(K.oDep);
  const homeCell = cell(K.homeZone);
  const home = homeCell.known ? zoneRule(code(homeCell) ?? "") : null;
  const leaves: ConditionNode[] = [];

  // --- Stage: scope (P-260.2-COVERED; v1 nonrefundable tickets only). `unsupported` only from KNOWN cells. ---
  const scopeCode = code(scope);
  if (scopeCode === "non_us" && scope.known) {
    flags.unsupportedReason = "Not a covered flight: no point in the United States (14 CFR 260.2). Other regimes may apply; Recoup does not evaluate them.";
  }
  leaves.push(leaf("scope", "r02.v1.covered_flight", "A covered flight: to, from or within the United States", "applicability",
    scopeCode === null ? "unknown" : scopeCode === "non_us" ? "fail" : "pass", scopeCode === null ? [] : [scope],
    { unknown: [scope], passage: "P-260.2-COVERED" }));
  // Scheduled service (errata E-R02-1/E-R02-3; D253(3)). A KNOWN charter or other non-scheduled flight → unsupported
  // here, before the decision questions (R02-16); a candidate one is asked (D234 (1), R02-14d); an unknown service type
  // passes this leaf and caps the result with A8 at the end (R02-15, never resolved toward eligible).
  const service = cell(K.service);
  const serviceCode = code(service);
  const nonScheduled = serviceCode !== null && (NON_SCHEDULED as readonly string[]).includes(serviceCode);
  if (nonScheduled && service.known) {
    flags.unsupportedReason ??= "Not a covered flight: a charter or other non-scheduled flight is not \"a scheduled flight\" under 14 CFR 260.2 (P-260.2-COVERED, P-254.2). Other rules may apply; R02 v1 does not evaluate them.";
  }
  leaves.push(service.status === "conflicting"
    ? leaf("scope", "r02.v1.scheduled_service", "A regularly scheduled flight (not a charter)", "applicability", "unknown", [], { unknown: [service], passage: "P-260.2-CARRIER" })
    : serviceCode === "scheduled"
      ? leaf("scope", "r02.v1.scheduled_service", "A regularly scheduled flight (not a charter)", "applicability", "pass", [service], { passage: "P-260.2-CARRIER" })
      : nonScheduled
        ? leaf("scope", "r02.v1.scheduled_service", "A regularly scheduled flight (not a charter)", "applicability", "fail", [service], { passage: "P-260.2-CARRIER" })
        : leaf("scope", "r02.v1.scheduled_service", "A regularly scheduled flight (not a charter)", "applicability", "pass", [], { note: "not confirmed: assumed (A8)", passage: "P-260.2-CARRIER" }));
  const refundCode = code(refundability);
  if (refundCode === "refundable" && refundability.known) {
    flags.unsupportedReason ??= "A fully refundable ticket has its own refund terms; R02 v1 covers nonrefundable tickets only.";
  }
  leaves.push(leaf("scope", "r02.v1.nonrefundable", "A nonrefundable ticket", "applicability",
    refundCode === null ? "unknown" : refundCode === "refundable" ? "fail" : "pass", refundCode === null ? [] : [refundability],
    { unknown: [refundability], passage: "P-260.6-A1" }));

  // --- Stage: event (always decisive: it selects the criteria and the L1 review, M27 R02-02) ---
  const renumbered = eventCode === "renumbered_only";
  leaves.push(leaf("event", "r02.v1.event_known", "What happened to the flight is known", "requirement",
    eventCode === null || (renumbered && !eventKnown) ? "unknown" : "pass", eventCode === null || (renumbered && !eventKnown) ? [] : [event],
    { unknown: eventCode === null ? [event] : [], unconfirmed: renumbered && !eventKnown ? [event] : [], passage: "P-260.2-SIG" }));
  if (renumbered && !eventKnown) {
    // Only a known "renumbered only" gives the L1 review (D234 (1)): an unconfirmed one is asked.
    (leaves[leaves.length - 1] as ComputedCondition).unknownFacts = [{ fact: ref(event), reason: "candidate_unconfirmed" }];
  }
  if (renumbered && eventKnown) {
    flags.manualReviewReason = `The flight was only renumbered. The regulation's text treats that as a cancellation (P-260.2-CANCEL), but DOT is not enforcing the refund rules for renumbered flights with no significant change until ${p.renumberedPauseEnds} while it reconsiders the definition (Refund III, FR-2026-13675). A person reviews it.`;
    passages.push("FR-2026-13675-DATES");
    if (new Date(now).toISOString().slice(0, 10) > p.renumberedPauseEnds) {
      // M27 R02-20: after the pause the pack must be re-reviewed (spec header) before it says anything about it.
      flags.sourceStale = true;
      explanation.push(`DOT's enforcement pause for renumbered flights ended on ${p.renumberedPauseEnds}; Recoup re-checks the rule before evaluating renumbered flights again.`);
    }
  }

  // --- Stage: significance ---
  const cancelled = eventCode === "cancellation" || renumbered;
  const cancelLeaf = leaf("significance", "r02.v1.cancelled", "The flight was cancelled", "requirement",
    eventCode === null ? "unknown" : cancelled ? "pass" : "fail", eventCode === null ? [] : [event],
    { unknown: [event], passage: "P-260.2-CANCEL" });

  const oArr = cell(K.oArr);
  const cArr = cell(K.cArr);
  const actualCell = cell(K.actualArr);
  const criteria: ComputedCondition[] = [];
  let downgradeKnown = false;
  let downgradeHolds = false;
  // F5: whether the CABINS show a downgrade, independent of eventCode (the criteria block below only computes
  // downgradeHolds when eventCode !== null — operational_delay and cancellation also never reach c5). Confirmed
  // cabins showing a downgrade must still ask event_type when it is unresolved, never default flew=true straight to
  // not_eligible.
  const oCabRaw = code(cell(K.oCabin));
  const cCabRaw = code(cell(K.cCabin));
  const cabinsShowDowngrade = oCabRaw !== null && cCabRaw !== null && oCabRaw in CABIN_RANK && cCabRaw in CABIN_RANK && CABIN_RANK[cCabRaw] > CABIN_RANK[oCabRaw];
  // N-R02-1 (D234 (1)): event_type SELECTS which criteria run and which threshold applies; a candidate value must
  // never decide a negative through them, so it is added to every criterion leaf's `used` when unconfirmed — the
  // leaf() guard then turns a candidate-driven fail into unknown/candidate_unconfirmed (a positive is already capped
  // via candidateFacts).
  const eventUsed: Cell[] = eventKnown ? [] : [event];
  if (!cancelled && eventCode !== null) {
    const primaryOf: Record<string, string> = {
      schedule_change: "c2", operational_delay: "c2", downgrade: "c5", airport_change: "c3", added_connection: "c4",
    };
    const primary = primaryOf[eventCode] ?? null;
    const stageOf = (id: string): Stage => (primary === id ? "significance" : "significance_other");
    const span = (from: Cell, to: Cell, id: string, text: string, passage: string, forceUsed: readonly Cell[] = []) => {
      const a = instant(from);
      const b = instant(to);
      if (a === null || b === null) {
        return leaf(stageOf(id), `r02.v1.sig.${id}`, text, "requirement", "unknown", [], { unknown: [from, to].filter((c) => !usable(c)), passage });
      }
      const ms = b - a;
      const t = againstThreshold(ms, scope, p);
      return leaf(stageOf(id), `r02.v1.sig.${id}`, text, "requirement", t.result, [from, to, ...t.used, ...eventUsed, ...forceUsed],
        { unknown: t.unknown, note: `${hm(ms)} against ${thresholdLabel(scope, p)}`, passage });
    };
    // (2) later arrival — for an operational delay, the carrier's revised scheduled arrival (spec §4, step 3). A revised
    // schedule and an actual arrival on opposite sides of the threshold (P-42305-D "arrives" vs P-260.2-SIG "scheduled
    // to arrive") → manual_review, only from KNOWN values (D234 (1)); with a candidate among them it is asked.
    const actual = instant(actualCell);
    const oA = instant(oArr);
    const cA = instant(cArr);
    let straddle: ComputedCondition | null = null;
    // N-R02-1(d): scope pivotal for EITHER threshold check under a candidate value, even when that value happens not
    // to trigger the straddle review below — force it into c2's used so a resulting fail is still guarded.
    let forceScope: Cell[] = [];
    // F4 (missing-value twin of N-R02-1(d)): the revised-schedule check decides "fail" without needing scope, but the
    // actual-arrival check is unresolved because scope (missing, not merely a candidate) is needed for IT — a genuine
    // straddle could be hiding behind the unresolved check. Ask the scope instead of falling back to the revised
    // schedule alone.
    let scopeUnresolvedLeaf: ComputedCondition | null = null;
    if (eventCode === "operational_delay" && actual !== null && oA !== null && cA !== null) {
      const revised = againstThreshold(cA - oA, scope, p);
      const arrived = againstThreshold(actual - oA, scope, p);
      if (revised.result !== "unknown" && arrived.result !== "unknown" && revised.result !== arrived.result) {
        const inputs = [oArr, cArr, actualCell, event, ...revised.used, ...arrived.used];
        const unconfirmed = inputs.filter((c) => !c.known);
        straddle = leaf(stageOf("c2"), "r02.v1.sig.c2", "Scheduled to arrive 3 h (domestic) / 6 h (international) or more later", "requirement", "unknown", [],
          { unconfirmed, note: "revised schedule and actual arrival disagree", passage: "P-260.2-SIG" });
        if (unconfirmed.length > 0) {
          straddle.unknownFacts = unconfirmed.map((c) => ({ fact: ref(c), reason: "candidate_unconfirmed" as const }));
        } else {
          straddle.unknownFacts = [];
          flags.manualReviewReason ??= `The revised schedule is ${hm(cA - oA)} late but the flight actually arrived ${hm(actual - oA)} late: the statute counts when you arrive (P-42305-D), the regulation the schedule (P-260.2-SIG). A person reviews it.`;
          passages.push("P-42305-D");
        }
      } else if (!scope.known && (revised.used.includes(scope) || arrived.used.includes(scope))) {
        forceScope = [scope];
      } else if (!scope.known && revised.result === "fail" && arrived.result === "unknown" && arrived.unknown.includes(scope)) {
        scopeUnresolvedLeaf = leaf(stageOf("c2"), "r02.v1.sig.c2", "Scheduled to arrive 3 h (domestic) / 6 h (international) or more later", "requirement", "unknown", [],
          { unknown: [scope], note: "the itinerary scope decides whether the actual arrival also crosses the threshold", passage: "P-260.2-SIG" });
      }
    }
    criteria.push(straddle ?? scopeUnresolvedLeaf ?? span(oArr, cArr, "c2", "Scheduled to arrive 3 h (domestic) / 6 h (international) or more later", "P-260.2-SIG", forceScope));
    if (eventCode !== "operational_delay") {
      // (1) earlier departure: the changed departure is 3 h / 6 h or more before the original one.
      criteria.push(span(cDep, oDep, "c1", "Scheduled to depart 3 h (domestic) / 6 h (international) or more earlier", "P-260.2-SIG"));
      // (3) a different origin or destination airport — compared only as IATA codes (spec §5; M27 R02-13).
      const pairs: [Cell, Cell][] = [[cell(K.oOrigin), cell(K.cOrigin)], [cell(K.oDest), cell(K.cDest)]];
      const codeOf = (c: Cell) => {
        const l = label(c);
        return l !== null && IATA.test(l) ? l : null;
      };
      const differs = pairs.find(([a, b]) => codeOf(a) !== null && codeOf(b) !== null && codeOf(a) !== codeOf(b));
      const allCodes = pairs.every(([a, b]) => codeOf(a) !== null && codeOf(b) !== null);
      const notCodes = pairs.flat().filter((c) => codeOf(c) === null);
      criteria.push(leaf(stageOf("c3"), "r02.v1.sig.c3", "Departs from or arrives at a different airport", "requirement",
        differs ? "pass" : allCodes ? "fail" : "unknown", [...(differs ?? pairs.flat().filter(usable)), ...eventUsed],
        { unknown: notCodes, note: notCodes.some(usable) ? "airports are compared as 3-letter IATA codes" : undefined, passage: "P-260.2-SIG" }));
      // (4) more connection points.
      const oc = count(cell(K.oConn));
      const cc = count(cell(K.cConn));
      criteria.push(leaf(stageOf("c4"), "r02.v1.sig.c4", "More connections than the original itinerary", "requirement",
        oc === null || cc === null ? "unknown" : cc > oc ? "pass" : "fail", [...[cell(K.oConn), cell(K.cConn)].filter(usable), ...eventUsed],
        { unknown: [cell(K.oConn), cell(K.cConn)].filter((c) => !usable(c)), passage: "P-260.2-SIG" }));
      // (5) a downgrade to a lower class of service.
      const oCab = code(cell(K.oCabin));
      const cCab = code(cell(K.cCabin));
      const known = oCab !== null && cCab !== null && oCab in CABIN_RANK && cCab in CABIN_RANK;
      downgradeHolds = known && CABIN_RANK[cCab] > CABIN_RANK[oCab];
      downgradeKnown = known && cell(K.oCabin).known && cell(K.cCabin).known;
      criteria.push(leaf(stageOf("c5"), "r02.v1.sig.c5", "Downgraded to a lower class of service", "requirement",
        known ? (downgradeHolds ? "pass" : "fail") : "unknown", [...[cell(K.oCabin), cell(K.cCabin)].filter(usable), ...eventUsed],
        { unknown: [cell(K.oCabin), cell(K.cCabin)].filter((c) => !usable(c)), passage: "P-260.2-SIG" }));
    }
  }
  // Disability criteria (6)/(7): raised by the passenger (260.6(b) "upon notification"), never asked (DA-A-24; D234
  // (7)); only the user's own confirmed `true` counts (spec §5 "user-confirmed only", M27 R02-09) and keeps the
  // significance question open for a person (L11).
  const disability = cell(K.disability);
  if (disability.status === "confirmed" && bool(disability) === true) {
    flags.manualReviewReason ??= "You told Recoup a disability is involved. The two disability-specific refund grounds (a different connecting airport, or a substitute aircraft without a feature you need) are reviewed by a person (L11).";
    if (!cancelled) {
      const d = leaf("significance_other", "r02.v1.sig.disability", "A disability-specific change (different connecting airport or substitute aircraft)", "requirement", "unknown", [disability], { note: "reviewed by a person (L11)", passage: "P-260.2-SIG" });
      d.unknownFacts = [];
      criteria.push(d);
    }
  }
  const sigChildren: ConditionNode[] = eventCode === null ? [cancelLeaf] : cancelled ? [cancelLeaf] : criteria;
  const significance: ConditionNode = { op: "any", children: sigChildren };
  leaves.push(significance);
  const significanceResult = evaluateConditions(significance, lookupFrom([])).result;
  passages.push(cancelled ? "P-260.2-CANCEL" : "P-260.2-SIG");
  if (significanceResult === "fail") {
    // M27 R02-24: tell the user what else exists.
    explanation.push(
      eventCode === "operational_delay"
        ? "The delay is below the refund threshold. No federal rule pays cash for a delay; the airline's own customer-service commitments (R15) may cover meals or a hotel."
        : "The change is below the refund thresholds. The airline's own customer-service commitments (R15) may still help.",
      "If a disability makes a new connecting airport or a substitute aircraft a problem for you, tell Recoup: a person reviews those grounds (260.6(b)).",
    );
  }

  // --- Stage: not flown (P-260.6-A1(i)) ---
  const altKey = usable(alt) ? K.altDeparts : usable(cDep) ? K.cDep : K.altDeparts;
  const departureCell = usable(alt) ? alt : cDep;
  const departsKnownAt = knownInstant(departureCell);
  const departsInFuture = departsKnownAt !== null && departsKnownAt > now;
  const flownText = "You did not fly the changed or replacement flight";
  const l4 = "You flew the downgraded flight. DOT's page says the airline must refund the fare difference (DOT-REF-6), but the regulation located for this rule does not state it (L4). A person reviews it.";
  if (flewValue !== null) {
    if (flewValue && downgradeHolds) {
      // L4 only from known facts; with an unconfirmed flight, cabin or event it is asked (D234 (1); N-R02-1(e);
      // P-R02-1: the cabins decide a "downgrade" event, so they are asked, never treated as "not flown" on an
      // otherwise-confirmed flew=true).
      if (flew.known && downgradeKnown && eventKnown) {
        flags.manualReviewReason ??= l4;
        leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "pass", [flew, event], { note: "flew the downgraded flight (L4)" }));
      } else {
        const unconfirmed = [flew, cell(K.oCabin), cell(K.cCabin), event].filter((c) => !c.known);
        leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "fail", [flew], { unconfirmed, passage: "P-260.6-A1" }));
      }
    } else if (flewValue && eventCode === "downgrade" && !downgradeKnown) {
      // P-R02-1/F3 (D247): whether this is a downgrade rests on the cabins; wholly unresolved cabins, OR a candidate
      // reading that happens to show no downgrade (downgradeHolds false but not confirmed), are both asked, never
      // treated as "flew, not a downgrade" → not_eligible (missing ≠ false, spec §5, D147 (2); a decisive candidate
      // never settles a negative, D234 (1)).
      const unconfirmed = [cell(K.oCabin), cell(K.cCabin), event].filter((c) => !c.known);
      leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "fail", [flew], { unconfirmed, passage: "P-260.6-A1" }));
    } else if (flewValue && eventCode === null && cabinsShowDowngrade) {
      // F5: the cabins alone show a downgrade even though event_type itself is wholly unresolved — ask event_type
      // instead of defaulting flew=true to "not flown the changed flight" → not_eligible.
      leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "fail", [flew], { unconfirmed: [event], passage: "P-260.6-A1" }));
    } else {
      leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", flewValue ? "fail" : "pass", [flew], { passage: "P-260.6-A1" }));
    }
  } else if (eventCode === "cancellation" && eventKnown && offer.known && (offerCode === "none" || offerCode === "voucher_or_credit")) {
    leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "pass", [event, offer], { note: "no replacement flight was offered" }));
  } else if (departsInFuture && (responseCode === null || responseCode === "no_response" || responseCode === "accepted_rebooking")) {
    // M27 R02-08: only while the decision is still open (or for a no-response or accepted rebooking) does a future
    // departure answer "not flown yet"; a rejection needs the flight question answered like any decisive fact.
    leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "pass", [departureCell], { note: "the changed flight has not departed yet" }));
  } else {
    leaves.push(leaf("not_flown", "r02.v1.not_flown", flownText, "exclusion", "unknown", [], { unknown: [flew], passage: "P-260.6-A1" }));
  }

  // --- Stage: deemed request (P-260.6-A2) and no affirmatively accepted compensation (P-260.7) ---
  const voucherKey = eventCode === "cancellation" || renumbered ? K.oDep : K.cDep;
  let basis: Basis | null = null;
  let notYetDueAt: number | undefined;
  const responseLeaf = (result: Tri, used: Cell[], opts: { unknown?: Cell[]; note?: string; unconfirmed?: Cell[] } = {}) =>
    leaf("response", "r02.v1.deemed_request", "A refund request is deemed made and no compensation was affirmatively accepted", "requirement", result, used, { ...opts, passage: "P-260.6-A2" });
  if (responseCode === "accepted_compensation") {
    // P-260.7 "affirmatively agrees": only the user's own confirmed answer counts (D204; M27 R02-01).
    leaves.push(responseLeaf("fail", [response], { unconfirmed: response.status === "confirmed" ? [] : [response], note: "a voucher, credit or other compensation was affirmatively accepted (P-260.7)" }));
    passages.push("P-260.7");
  } else if (responseCode === "accepted_rebooking") {
    if (flewValue === true && downgradeHolds) {
      // M27 R02-03: accepting and flying the downgraded seat is the typical L4 case. N-R02-1(e): event is added too —
      // a candidate "downgrade" must not decide this either (D234 (1)).
      const unconfirmed = [response, flew, cell(K.oCabin), cell(K.cCabin), event].filter((c) => !c.known);
      if (unconfirmed.length === 0) {
        flags.manualReviewReason ??= l4;
        leaves.push(responseLeaf("pass", [response, flew], { note: "accepted and flew the downgraded seat (L4)" }));
      } else {
        leaves.push(responseLeaf("fail", [response, flew], { unconfirmed }));
      }
    } else if (flewValue === true && eventCode === "downgrade" && !downgradeKnown) {
      // F1 (P-R02-1 residual): the accepted_rebooking branch needs the same cabins-unresolved guard as not_flown
      // (:735-741) — a flown, confirmed downgrade with the cabins unresolved is asked, not settled as not_eligible.
      // Checked ahead of departsInFuture: the user's own confirmed flew=true outranks that date-based heuristic
      // (which exists for when flew itself is unknown, M27 R02-08).
      const unconfirmed = [cell(K.oCabin), cell(K.cCabin), event].filter((c) => !c.known);
      leaves.push(responseLeaf("fail", [response, flew], { unconfirmed }));
    } else if (departsInFuture && response.known) {
      leaves.push(responseLeaf("fail", [response, departureCell], { note: "rebooking accepted (260.6(a)(1)(i))" }));
    } else if (flewValue === false) {
      if (response.known && flew.known) {
        flags.manualReviewReason ??= "You accepted the rebooking but did not fly it. The regulation does not address a later change of mind (L5); a person reviews it.";
        leaves.push(responseLeaf("pass", [response, flew], { note: "accepted rebooking, not flown (L5)" }));
      } else {
        leaves.push(responseLeaf("unknown", [], { unknown: [response, flew].filter((c) => !c.known) }));
        (leaves[leaves.length - 1] as ComputedCondition).unknownFacts = [response, flew].filter((c) => !c.known).map((c) => ({ fact: ref(c), reason: "candidate_unconfirmed" as const }));
      }
    } else if (flewValue === true) {
      leaves.push(responseLeaf("fail", [response, flew]));
    } else {
      leaves.push(responseLeaf("unknown", [], { unknown: [flew] }));
    }
  } else {
    basis = basisFor(responseCode, offerCode, eventCode, altKey, voucherKey);
    // F2 (N-R02-1 residual, D234 (1)): voucherKey (oDep vs cDep) is picked from eventCode, so a "no_response_voucher"/
    // "no_response_both" basis must not let an unresolved event decide ripeness on its own.
    const voucherAnchored = basis !== null && (basis.kind === "no_response_voucher" || basis.kind === "no_response_both");
    if (basis === null) {
      // Decision unknown (or the offer, for a no-response): ask. "I don't know" stays unknown (DA-A-1).
      const unknown = responseCode === "no_response" ? [offer] : [response];
      leaves.push(responseLeaf("unknown", [], { unknown }));
    } else if (basis.kind === "rejected" || basis.kind === "cancelled_nothing_offered") {
      leaves.push(responseLeaf("pass", basis.kind === "rejected" ? [response] : [offer, event], { note: BASIS_TEXT[basis.kind] }));
    } else if (voucherAnchored && eventCode === null) {
      // event_type is wholly unresolved (no candidate either): the anchor choice would silently default to
      // changed_sched_departure_at. Ask event_type instead of guessing which anchor applies.
      leaves.push(responseLeaf("unknown", [response, offer], { unknown: [event] }));
    } else {
      // A no-response request exists only once its trigger instant has passed (260.6(a)(2)(iii)); ripeness is decided
      // only from KNOWN cells (contract §4 "notYetDue … from KNOWN facts"; M27 R02-11).
      const triggers = basis.anchorKeys.map(cell);
      const missingTriggers = triggers.filter((c) => instant(c) === null);
      const eventUnconfirmed = voucherAnchored && !eventKnown ? [event] : [];
      if (missingTriggers.length > 0) {
        leaves.push(responseLeaf("unknown", [response, offer], { unknown: missingTriggers }));
      } else {
        const at = Math.min(...triggers.map((c) => instant(c)!));
        if (at > now) {
          const unconfirmed = [response, offer, ...triggers, ...eventUnconfirmed].filter((c) => !c.known);
          if (unconfirmed.length > 0) {
            const l = responseLeaf("unknown", [], {});
            l.unknownFacts = unconfirmed.map((c) => ({ fact: ref(c), reason: "candidate_unconfirmed" as const }));
            leaves.push(l);
          } else {
            const date = earliestLocalDate(at, home);
            notYetDueAt = at;
            flags.notYetDue = { at: date, when: "the changed or replacement flight departs without you (or the voucher offer's deadline passes)" };
            explanation.push(`Not yet due: with no response, the refund request counts from ${date} (260.6(a)(2)(iii)).`);
            leaves.push(responseLeaf("pass", [response, offer, ...triggers], { note: BASIS_TEXT[basis.kind] }));
          }
        } else {
          leaves.push(responseLeaf("pass", [response, offer, ...triggers, ...eventUnconfirmed], { note: BASIS_TEXT[basis.kind] }));
        }
      }
    }
    if (basis !== null) passages.push("P-260.6-A2");
  }

  // --- Stage: path (merchant of record). The carrier's identity decides nothing in v1 (D234 (2)); it is bound. ---
  const path: "a" | "b" | null = morCode === "carrier" ? "a" : morCode === "ticket_agent" ? "b" : null;
  leaves.push(leaf("path", "r02.v1.merchant_of_record", "Who took the payment (merchant of record) is known", "requirement",
    path === null ? "unknown" : "pass", path === null ? [] : [mor], { unknown: [mor], passage: "P-260.2-MOR" }));
  if (path === "b") passages.push("P-399.80(l)");

  // --- Stage: anchor (R02.a: the deemed-request instant; spec §11 "anchor unknown → needs_facts") ---
  const anchorCells = basis ? basis.anchorKeys.map(cell) : [];
  const anchorAt = anchorCells.length > 0 && anchorCells.every((c) => instant(c) !== null) ? Math.min(...anchorCells.map((c) => instant(c)!)) : null;
  if (path === "a" && basis !== null) {
    leaves.push(leaf("anchor", "r02.v1.request_date", "The date the refund request was deemed made is known", "timing",
      anchorAt !== null ? "pass" : "unknown", anchorCells.filter((c) => instant(c) !== null),
      { unknown: anchorCells.filter((c) => instant(c) === null), passage: "P-260.2-PROMPT" }));
  }

  // --- Compliance-date gate (spec §16 step 1b; README rule 5; D234 (8); M27 R02-12) ---
  // The deemed-request date when known; else the earliest known date of the trip. Known cells only.
  const knownAnchorAt = anchorCells.length > 0 && anchorCells.every((c) => knownInstant(c) !== null) ? Math.min(...anchorCells.map((c) => knownInstant(c)!)) : null;
  const tripInstants = [oDep, cDep, oArr, cArr, actualCell, alt, cell(K.cancelNotice), cell(K.responseAt)].map(knownInstant).filter((x): x is number => x !== null);
  const gateAt = knownAnchorAt ?? (tripInstants.length > 0 ? Math.min(...tripInstants) : null);
  const gateDates = gateAt !== null ? localDates(gateAt, home) : localDates(now, home);
  const allBefore = gateDates.every((d) => d < p.refundComplianceDate);
  const noneBefore = gateDates.every((d) => d >= p.refundComplianceDate);
  if (allBefore) {
    flags.effectiveDateMismatch = true;
    passages.push("FR-2024-07177-COMPLIANCE");
    explanation.push(`The refund request date is before the refund rule's compliance date (${p.refundComplianceDate}); R02 v1 does not evaluate earlier events.`);
  } else if (gateAt === null || !noneBefore) {
    assumptions.push({
      id: R02_GATE_ASSUMPTION_ID,
      text: gateAt === null
        ? `No date of the trip or of your refund request is confirmed yet, so Recoup assumes it was on or after ${p.refundComplianceDate}, when the DOT refund rule took effect.`
        : `Depending on your time zone, the refund request fell just before or on ${p.refundComplianceDate}, when the DOT refund rule took effect; Recoup assumes it was on or after that date.`,
      changesOutcomeIf: `the refund request was before ${p.refundComplianceDate} where you are (the rule does not apply to earlier events)`,
    });
    passages.push("FR-2024-07177-COMPLIANCE");
  }

  // --- Stage: amount (§8; D234 (4), D235 (B)) ---
  const amountCells = [cell(K.fare), cell(K.taxes), cell(K.ancillary), cell(K.refunded)];
  const amounts = amountCells.map(money);
  let amount: AmountCalc | null = null;
  const missingAmounts = amountCells.filter((_c, i) => amounts[i] === null);
  if (missingAmounts.length === 0) {
    const [fare, taxes, ancillary, refunded] = amounts as Money[];
    const currencies = new Set(amounts.map((m) => m!.currency));
    for (const c of currencies) {
      const cellsInC = amountCells.filter((_x, i) => amounts[i]!.currency === c);
      if (currencyExponent(c, "new_scenario") === null && cellsInC.every((x) => x.known)) {
        flags.unsupportedReason ??= `Recoup's air checks handle USD amounts only; ${c} is not supported yet (O6).`;
      }
    }
    if (currencies.size > 1) {
      explanation.push("The fare, taxes and fees are in different currencies; Recoup never adds different currencies, so a person works out the amount.");
    } else {
      const paid = fare.amountMinor + taxes.amountMinor + ancillary.amountMinor;
      const due = paid - refunded.amountMinor;
      const partly = bool(cell(K.partlyFlown));
      if (!Number.isSafeInteger(paid) || !Number.isSafeInteger(due)) {
        // M27 R02-21: never throw on an absurd amount; a person looks at it.
        explanation.push("These amounts are too large to add safely; a person works out the amount.");
      } else if (due <= 0) {
        // D234 (4) / D235 (B): refunds never change the outcome; nothing is left to ask for.
        explanation.push(due < 0
          ? "Nothing is outstanding: the airline refunded more than you paid for the ticket (please check the amounts)."
          : "Nothing is outstanding: the airline already refunded the fare, taxes and fees in full before this case.");
      } else if (partly === true) {
        explanation.push("Part of this ticket was already flown. 260.6(a)(1) does not say how to split a partly used ticket (assumption A4), so a person works out the amount; the refund itself is owed.");
      } else {
        amount = {
          estimate: { amountMinor: due, currency: fare.currency },
          basis: "exact_formula",
          formula: "fare + taxes + ancillary fees - already refunded",
          inputs: [
            { label: "fare", value: String(fare.amountMinor), fact: ref(amountCells[0]) },
            { label: "taxes", value: String(taxes.amountMinor), fact: ref(amountCells[1]) },
            { label: "ancillary fees", value: String(ancillary.amountMinor), fact: ref(amountCells[2]) },
            { label: "already refunded before the case", value: String(refunded.amountMinor), fact: ref(amountCells[3]) },
          ],
        };
        passages.push("P-260.10");
      }
    }
  }
  leaves.push(leaf("amount", "r02.v1.amount_known", "The fare, taxes, fees and any earlier refund are known", "requirement",
    missingAmounts.length === 0 ? "pass" : "unknown", missingAmounts.length === 0 ? amountCells : [], { unknown: missingAmounts, passage: "P-260.6-A1" }));

  // --- Evaluate the tree ---
  const tree: ConditionNode = { op: "all", children: leaves };
  const ev = evaluateConditions(tree, lookupFrom([]));
  // Staged questions (§16 order). A stage whose only unknowns are "I don't know" answers does not hold back the next
  // stage (M27 R02-23): its facts stay listed and the next stage's are added.
  const missing: MissingFact[] = [];
  for (const s of STAGES) {
    const inStage = ev.decisiveMissing.filter((m) => m.neededFor.includes(s));
    if (inStage.length === 0) continue;
    for (const m of inStage) addMissing(missing, m);
    if (!inStage.every((m) => m.reason === "user_unknown")) break;
  }

  // --- Deadlines ---
  const deadlines: DeadlineResult[] = [];
  const deadlineNotes: string[] = [];
  if (path === "b") {
    deadlines.push({
      id: R02_AGENT_TIMER_ID,
      label: "The travel agency's refund deadline",
      obligor: "counterparty",
      status: "unknown_anchor",
      mustBe: "paid",
      basis: "Not computable: 399.80(l) counts 7 business days (credit card) or 20 calendar days (other payments) from when the agency receives the airline's eligibility information (260.6(d)), which you cannot see (L7).",
      sourcePassageId: "P-399.80(l)",
    });
  } else if (path === "a" && (basis !== null || response.status === "conflicting")) {
    // No basis (e.g. an accepted rebooking, L5) → no timer at all (M27 R02-04): its anchor would not be a request.
    let engineLookup: EngineLookup = (s, k) => v.lookup.get(s, k);
    let anchorKey = basis?.anchorKeys[0] ?? K.responseAt;
    if (basis !== null && basis.anchorKeys.length > 1 && anchorAt !== null) {
      anchorKey = basis.anchorKeys.find((k) => instant(cell(k)) === anchorAt) ?? anchorKey;
    }
    if (response.status === "conflicting") {
      // D154: which request event applies is disputed, so the carrier's timer has no firm date (no overdue either).
      const values: EngineConflictValue[] = [];
      for (const alt2 of alternatives(response)) {
        const b = basisFor(code(alt2), offerCode, eventCode, altKey, voucherKey);
        const at = b ? b.anchorKeys.map((k) => instant(cell(k))).filter((x): x is number => x !== null) : [];
        if (b && at.length === b.anchorKeys.length) {
          anchorKey = b.anchorKeys[0];
          values.push({ value: { kind: "instant", epochMs: Math.min(...at) }, source: { kind: "derived", ref: `if the decision was ${show(valueOf(alt2) ?? { kind: "user_unknown" })}` } });
        }
      }
      const disputed: EngineCell = { subjectKey: TXN, key: anchorKey, status: "conflicting", conflict: { kind: response.conflict.kind, values } };
      const base = engineLookup;
      engineLookup = (s, k) => (s === TXN && k === anchorKey ? disputed : base(s, k));
    }
    const timer = carrierTimer(anchorKey, p, engineLookup, home, now);
    if (timer) {
      const notes = [...timer.notes];
      if (timer.result.id === R02_CARRIER_TIMER_OTHER_ID) {
        notes.push(L2_DISCLOSURE);
        passages.push("DOT-REF-3");
      }
      deadlines.push(timer.result.id === R02_CARRIER_TIMER_OTHER_ID ? { ...timer.result, basis: `${timer.result.basis} ${L2_DISCLOSURE}` } : timer.result);
      deadlineNotes.push(...notes);
    }
    passages.push("P-260.2-PROMPT");
  }

  // --- Loss keys: the fare only (D270(1)/D234 (17) revised) — a checked-bag fee belongs to R04 path a alone ---
  const dims: Omit<Dimensions, "readyForApproval"> = {
    applies: ev.result,
    factsKnown: ev.result === "pass" ? "pass" : "unknown",
    evidenceSupports: ev.decisiveUnconfirmed.length > 0 ? "unknown" : "pass",
    windowOpen: "pass",
    amountCalculable: amount !== null ? "pass" : ev.result === "fail" ? "fail" : "unknown",
  };
  const failing = (nodes: readonly ConditionNode[]) =>
    nodes.filter((l): l is ComputedCondition => l.op === "computed" && l.result === "fail" && l.kind !== "timing").map((l) => l.id);
  const disqualifierIds = [...failing(leaves), ...(significanceResult === "fail" ? failing(sigChildren) : [])];
  return {
    dims, flags, conditions: ev.conditions, missing, decisiveUnresolved: ev.decisiveMissing, unconfirmed: ev.decisiveUnconfirmed,
    assumptions, amount, deadlines, path, disqualifierIds, explanation, deadlineNotes, passages,
    ...(notYetDueAt !== undefined ? { notYetDueAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Evaluation: conflicts (D152/D154/D158), outcome, projection
// ---------------------------------------------------------------------------

/** An amount is shown only where it can be owed (never for not_yet_due, needs_facts, not_eligible, …). */
const AMOUNT_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit"]);
/** The carrier timer is shown where a refund is (or may be, after review) owed; review rows never carry a date. */
const DEADLINE_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "manual_review"]);

function outcomeOf(c: Core): { outcome: Outcome; amount: AmountCalc | null } {
  const outcome = deriveOutcome({ ...c.dims, readyForApproval: "unknown" }, c.flags, c.assumptions);
  return { outcome, amount: AMOUNT_OUTCOMES.has(outcome) ? c.amount : null };
}

function conflictFlag(cell: Cell): Omit<ConflictFlag, "sameAnswer"> {
  const c = cell as Extract<Cell, { status: "conflicting" }>;
  return {
    key: cell.key,
    subjectKey: cell.subjectKey,
    kind: c.conflict.kind,
    values: c.conflict.values.map((x) => ({ value: show(x.value), source: x.source.ref ? `${x.source.kind}: ${x.source.ref}` : x.source.kind })),
  };
}

function sourceRefsFor(passages: readonly string[]): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  for (const id of passages) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = R02_SOURCES.find((x) => x.passageId === id);
    if (s) out.push({ sourceId: s.sourceId, passageId: s.passageId, url: s.url, effective: s.effective });
  }
  return out.slice(0, 8);
}

function nextActionFor(
  outcome: Outcome, c: Core, flags: Flags, missing: readonly MissingFact[], manualReason: string | undefined,
  serviceCapped: boolean,
): NextAction {
  switch (outcome) {
    case "eligible":
    case "likely_eligible":
    case "possible_contract_benefit": {
      if (c.path === "b") return { kind: "request_refund" };
      const overdue = overdueCounterpartyDeadlines(c.deadlines);
      if (overdue.length > 0) {
        // D270(4)/R-4: while A8 caps the result (the service type is not confirmed), the card never escalates — the
        // timer still shows, but the next action is to confirm the service type (only the letter was gated, O-1).
        if (serviceCapped) return { kind: "answer_questions", keys: [{ subjectKey: TXN, key: K.service }] };
        const due = overdue[0].dueLocalDate ?? new Date(overdue[0].dueAt!).toISOString().slice(0, 10);
        return { kind: "escalate", reason: `The airline's refund deadline (${due}) has passed without the refund. Ask the airline through its refund channel, or file a complaint with DOT's Office of Aviation Consumer Protection.` };
      }
      return { kind: "track" };
    }
    case "needs_facts": {
      // Unconfirmed values are questions too (confirm them), as R05 does (M27 R04-18 / cross-pack observation 6).
      const keys = missing.filter((m) => m.reason !== "conflict_capped").map((m) => ({ subjectKey: m.subjectKey, key: m.key }));
      return keys.length > 0 ? { kind: "answer_questions", keys } : { kind: "none", reason: "Waiting for the facts above." };
    }
    case "manual_review":
      return { kind: "manual_review", reason: manualReason ?? flags.manualReviewReason ?? "A person reviews this case." };
    case "not_yet_due":
      return notYetDueAction(flags.notYetDue!);
    case "unsupported":
      return { kind: "none", reason: flags.unsupportedReason ?? "Not covered by R02 v1." };
    case "source_unverified":
      return {
        kind: "none",
        reason: flags.effectiveDateMismatch
          ? "This happened before the DOT refund rule's compliance date; Recoup v1 does not evaluate it."
          : "The DOT refund rule text has not been re-verified recently; Recoup checks it again before giving a result.",
      };
    default:
      return { kind: "none", reason: c.explanation[0] ?? "No refund is owed under the DOT refund rule on these facts." };
  }
}

export function evaluateR02V1(input: EvaluationInput<R02View, R02Params>): EvaluationResult {
  const { snapshot: v, pack, now } = input;
  const env: Env = { p: pack.params, now, stale: sourceStale(pack.sources, input.verification, now).stale };
  const base = core(v, env);

  // Conflicts are tested only on decisive cells (a conflict nothing depends on neither asks nor caps).
  const conflictKeys = new Set(base.decisiveUnresolved.filter((m) => m.reason === "conflicting").map((m) => `${m.subjectKey}\u0000${m.key}`));
  const conflicting = [...conflictKeys].map((id) => {
    const [s, k] = id.split("\u0000");
    return v.lookup.get(s, k);
  }).filter((c): c is Extract<Cell, { status: "conflicting" }> => c.status === "conflicting");

  let final: Core = base;
  let flags: Flags = base.flags;
  let missing: MissingFact[] = base.missing;
  let unconfirmed: MissingFact[] = base.unconfirmed;
  let manualReason: string | undefined;
  const extra: string[] = [];

  if (conflicting.length > 0) {
    const confirmedKinds = conflicting.filter((c) => c.conflict.kind !== "candidates");
    if (confirmedKinds.length > 0) {
      // 5a: the user cannot settle it by answering.
      flags = { ...base.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: withSameAnswer(conflicting.map(conflictFlag), false) };
      const parts = confirmedKinds.map((c) => `${c.key}: ${conflictFlag(c).values.map((x) => `${x.value} (${x.source})`).join(" vs ")}`);
      manualReason = `A value you confirmed contradicts another source — ${parts.join("; ")}. Upload proof (for example the airline's message or a dated screenshot) or correct your confirmation before a refund request is prepared.`;
      extra.push(manualReason);
    } else {
      // Candidate testing: each value as if confirmed; same outcome AND amount → 5c, else 5b.
      const choices = conflicting.map((c) => alternatives(c).map((a) => (a.status === "candidate" || a.known ? knownCell(a.subjectKey, a.key, "confirmed", a.value, { kind: "user" }) : a)));
      const combos = candidateCombinations(choices);
      const tested = (combos ?? []).map((combo) => {
        const lookup = combo.reduce<FactLookup>((acc, c) => withOverride(acc, c), v.lookup);
        const c = core({ ...v, lookup }, env);
        return { core: c, answer: outcomeOf(c) };
      });
      const same = combos !== null && sameAnswer(tested.map((t) => t.answer));
      const list = withSameAnswer(conflicting.map(conflictFlag), same);
      const ids = new Set(conflicting.map((c) => `${c.subjectKey}\u0000${c.key}`));
      // D234 (1): a same answer that is negative, not yet due or a review never rests on candidates → ask instead.
      const negative = same && !AMOUNT_OUTCOMES.has(tested[0].answer.outcome);
      if (same && !negative) {
        final = { ...tested[0].core, deadlines: base.deadlines };
        flags = { ...tested[0].core.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
        missing = final.missing.filter((m) => !ids.has(`${m.subjectKey}\u0000${m.key}`));
        unconfirmed = final.unconfirmed.filter((m) => !ids.has(`${m.subjectKey}\u0000${m.key}`));
        for (const c of conflicting) addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "conflict_capped", class: "required", neededFor: ["confirmation"] });
        extra.push(`Your documents disagree on ${conflicting.map((c) => c.key).join(", ")}, but every value gives the same answer and amount; confirm the right one to remove the cap.`);
      } else {
        flags = { ...base.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
        for (const c of conflicting) addMissing(missing, { subjectKey: c.subjectKey, key: c.key, reason: "conflicting", class: "required", neededFor: ["outcome"] });
        extra.push(`Your documents disagree and the answer depends on which is right: ${list.map((f) => `${f.key}: ${f.values.map((x) => `${x.value} (${x.source})`).join(" vs ")}`).join("; ")}. Which is the airline's latest?`);
      }
    }
  }

  // D253(3) / A8: an unknown service type is a ceiling — it caps a result that would otherwise be approvable, and is
  // asked only when it is the ONLY thing between likely and eligible (R02-15/15b; not yet in R02-15c). A candidate
  // `scheduled` is an unconfirmed decisive fact instead (R02-15d); a known non-scheduled value was unsupported above.
  // N-R02-2: any readable-but-not-"scheduled" value counts as unknown — including an extracted candidate "unknown"
  // (previously only missing/user_unknown/confirmed-or-observed "unknown" were caught, so a candidate "unknown" gave
  // an uncapped `eligible`). A conflict is resolved separately above and never falls into this cap.
  const serviceCell = v.lookup.get(TXN, K.service);
  const serviceCode = code(serviceCell);
  const serviceNonScheduled = serviceCode !== null && (NON_SCHEDULED as readonly string[]).includes(serviceCode);
  const serviceUnknown = serviceCell.status !== "conflicting" && serviceCode !== "scheduled" && !serviceNonScheduled;
  const uncapped = deriveOutcome({ ...final.dims, readyForApproval: "unknown" }, flags, final.assumptions);
  const assumptions = serviceUnknown && AMOUNT_OUTCOMES.has(uncapped) ? [...final.assumptions, SCHEDULED_ASSUMPTION] : final.assumptions;
  const serviceCapped = serviceUnknown && AMOUNT_OUTCOMES.has(uncapped);
  if (serviceUnknown && uncapped === "eligible") {
    addMissing(unconfirmed, {
      subjectKey: TXN, key: K.service,
      reason: serviceCell.status === "missing" ? "missing" : serviceCell.status === "candidate" ? "candidate_unconfirmed" : "user_unknown",
      class: "assumption", neededFor: ["scope"],
    });
  }
  const outcome = deriveOutcome({ ...final.dims, readyForApproval: "unknown" }, flags, assumptions);
  const amount = AMOUNT_OUTCOMES.has(outcome) ? final.amount : null;
  // D234 (6): a manual_review result carries no firm carrier date (only unknown/disputed rows).
  const deadlines = !DEADLINE_OUTCOMES.has(outcome) ? [] : outcome === "manual_review" ? final.deadlines.filter((d) => d.dueAt === undefined) : final.deadlines;
  const missingFacts: MissingFact[] =
    outcome === "needs_facts" ? [...missing, ...unconfirmed]
      : outcome === "eligible" || outcome === "likely_eligible" || outcome === "possible_contract_benefit" || outcome === "not_yet_due" ? [...(outcome === "not_yet_due" ? missing : []), ...unconfirmed]
        : [];
  const dimensions: Dimensions = { ...final.dims, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  const shaped: Core = { ...final, deadlines };
  const nextAction = nextActionFor(outcome, shaped, flags, missingFacts, manualReason, serviceCapped);
  const lines = [
    ...extra,
    ...(outcome === "manual_review" && flags.manualReviewReason && !manualReason ? [flags.manualReviewReason] : []),
    ...(amount ? [`Refund owed: ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)} (fare + taxes + ancillary fees − anything refunded before this case), in the original form of payment (P-260.10).`] : []),
    ...(isApprovable(outcome) && final.path === "a" ? ["The airline must refund automatically; Recoup tracks its deadline."] : []),
    ...(isApprovable(outcome) && final.path === "b" ? ["A travel agency took the payment: it owes the refund when you ask for it (399.80(l)), not automatically."] : []),
    ...final.explanation,
    ...(AMOUNT_OUTCOMES.has(outcome) ? assumptions.map((a) => a.text) : []),
    ...(deadlines.some((d) => d.dueAt !== undefined) ? final.deadlineNotes : []),
  ];
  const explanation = [...new Set(lines)].slice(0, 12);

  return {
    scenarioId: "R02",
    ruleId: pack.ruleId,
    ruleVersion: pack.version,
    engineVersion: input.engineVersion,
    remedyKey: input.remedyKey,
    subjectKey: input.subjectKey,
    snapshotHash: input.snapshotHash,
    outcome,
    dimensions,
    conditions: final.conditions,
    missingFacts,
    assumptions,
    disqualifierIds: final.disqualifierIds,
    amount,
    deadlines,
    sourceRefs: sourceRefsFor(final.passages),
    // D270(1) (revises D234 (17)): R02 excludes checked-bag fees entirely and never shares a loss key with R04 path a
    // (fixes N-X-1 — the two refunds are additive; the ancillary-fee prompt and the per-transaction air-paid cap keep
    // a bag fee from being double-counted inside R02's own total).
    lossKeys: [`txn:${v.transactionId}:fare_unused`],
    // M27 R02-18: R03 is the alternative channel when the ticket was paid by (known) credit card.
    overlap: code(v.lookup.get(TXN, K.payment)) === "credit_card" && v.lookup.get(TXN, K.payment).known ? [R03_ALTERNATIVE] : [],
    nextAction,
    explanation,
    flags,
    boundFacts: r02BoundFacts(v),
    ...(outcome === "not_yet_due" && flags.notYetDue
      ? { reevaluate: { ...(flags.notYetDue.at !== undefined ? { at: flags.notYetDue.at } : {}), ...(flags.notYetDue.when !== undefined ? { when: flags.notYetDue.when } : {}) } }
      : {}),
  };
}

/** R02 v1's bound facts (re-exported for callers that bind an approval without evaluating). */
export function r02V1BoundFacts(v: R02View): BoundFactValue[] {
  return r02BoundFacts(v);
}

/**
 * D208 PackAdapter (M20's `RulePack.adapter`): live fact rows of one air transaction → the single R02 run (the ticket,
 * subject `txn`). Pure.
 */
export const r02Adapter = Object.freeze({
  runs(input: AirSnapshotInput): { subjectKey: string; snapshot: R02View; lookup: FactLookup }[] {
    const s = buildAirSnapshot(input);
    return [{ subjectKey: AIR_TXN_SUBJECT, snapshot: r02View(s), lookup: s.lookup }];
  },
});

export const r02AirRefundV1: RulePack<R02View, R02Params, CaseContext> = {
  ruleId: R02_V1_RULE_ID,
  scenarioId: "R02",
  version: R02_V1_VERSION,
  // Informative only: the lead's activation entry + the manifest decide status.
  lifecycle: "researched",
  authority: { class: "legal_entitlement", subtype: "federal statute + regulation (49 U.S.C. 42305; 14 CFR part 260; 14 CFR 399.80(l) for ticket agents)" },
  jurisdiction: "US — covered flights to, from or within the United States (14 CFR 260.2)",
  categories: ["air_travel"],
  remedyKey: R02_REMEDY_KEY,
  remedyType: "cash_refund",
  cashClass: "cash",
  params: R02_V1_PARAMS,
  sources: R02_SOURCES,
  requirements: [
    { subjectPattern: TXN, key: K.scope, class: "required" },
    { subjectPattern: TXN, key: K.refundability, class: "required" },
    { subjectPattern: TXN, key: K.event, class: "required" },
    { subjectPattern: TXN, key: K.oArr, class: "required" },
    { subjectPattern: TXN, key: K.cArr, class: "required" },
    { subjectPattern: TXN, key: K.oDep, class: "required" },
    { subjectPattern: TXN, key: K.cDep, class: "required" },
    { subjectPattern: TXN, key: K.oOrigin, class: "required" },
    { subjectPattern: TXN, key: K.oDest, class: "required" },
    { subjectPattern: TXN, key: K.cOrigin, class: "required" },
    { subjectPattern: TXN, key: K.cDest, class: "required" },
    { subjectPattern: TXN, key: K.oConn, class: "required" },
    { subjectPattern: TXN, key: K.cConn, class: "required" },
    { subjectPattern: TXN, key: K.oCabin, class: "required" },
    { subjectPattern: TXN, key: K.cCabin, class: "required" },
    { subjectPattern: TXN, key: K.disability, class: "required", sensitive: true },
    { subjectPattern: TXN, key: K.flew, class: "required" },
    { subjectPattern: TXN, key: K.offer, class: "required" },
    { subjectPattern: TXN, key: K.response, class: "required" },
    { subjectPattern: TXN, key: K.responseAt, class: "required" },
    { subjectPattern: TXN, key: K.altDeparts, class: "required" },
    { subjectPattern: TXN, key: K.cancelNotice, class: "required" },
    { subjectPattern: TXN, key: K.mor, class: "required" },
    { subjectPattern: TXN, key: K.fare, class: "required" },
    { subjectPattern: TXN, key: K.taxes, class: "required" },
    { subjectPattern: TXN, key: K.ancillary, class: "required" },
    { subjectPattern: TXN, key: K.refunded, class: "required" },
  ],
  fixturesPath: "docs/rules/fixtures/R02.json",
  lateAskDeadlineIds: [],
  overlap: [R03_ALTERNATIVE],
  knownLimitations: [
    "L1: a renumbered-only flight is manual_review while DOT's enforcement pause runs (to 2027-07-07); after it the path is source_unverified until re-reviewed.",
    "L2: the 20-calendar-day timer is the regulation's; DOT's page also says '20 business days' (DOT-REF-3) — disclosed, not used.",
    "L4/L5/L11: the downgrade fare difference, an accepted-but-not-flown rebooking and the disability grounds are manual_review, only from confirmed facts.",
    "D234 (7): the disability criteria (6)/(7) are never asked — the passenger raises them (260.6(b) 'upon notification'); v1 models no connecting-airport identities or aircraft features, so they can never be decided here.",
    "L7: a ticket agent's refund deadline is not computable (it runs from information the consumer cannot see).",
    "A1 (D234 (8), D235): the carrier timer counts calendar days in the consumer's home time zone; when unknown it shows 'on or about <earliest> – <latest>' across the US zones and treats the airline as late only after the latest.",
    "A4: the fare is taken to be for the affected itinerary; a partly flown ticket has no estimate (a person splits it).",
    "A7: for a cancellation with nothing offered, the timer runs from the carrier's cancellation notice.",
    "L13 (errata E-R02-1/E-R02-3, D253(3)): a known charter or other non-scheduled flight is unsupported; an unknown service type caps the result with A8 ('assumes a regularly scheduled flight') and is asked only when it is the one thing between likely and eligible; an extracted one is confirmed first. The covered-carrier half is inferred from scope + service type (ERR-R1-08).",
    "D234 (2)/(3): the carrier's identity, offer_type on a rejection and the payment class decide nothing about the outcome in v1; the payment class only selects the carrier timer.",
    "D234 (4)/D235 (B): already_refunded is money refunded before the case started; it reduces the estimate (spec §8) but never the outcome. Money received on a case is a ledger credit only.",
    "D270(1) (revises D234 (17)): a checked-bag fee belongs to R04 path a alone, never the ancillary total; R02 excludes it entirely and shares no loss key with R04 path a, so the two refunds are additive.",
    "M27 R02-18: R12 (card trip-cancellation cover) is primary/secondary to this refund and never additive (spec §16 step 10, fixture R02-12); it is declared once R12's pack defines its remedy key — until then DA-A-4's non-additive default applies. R15 stays undeclared (per carrier plan).",
    "Precedence (contract §4 rules 1–3): a known disqualifier (flew, accepted compensation) outranks the L1/L11/straddle reviews, and unsupported outranks staleness.",
    "Refundable tickets, charters, non-US itineraries and the 24-hour rule (14 CFR 259.5(b)(4)) are out of scope for v1 (L8).",
    "USD amounts only (O6); amounts in different currencies are never added — a person works out the amount.",
  ],
  evaluate: evaluateR02V1,
  adapter: r02Adapter,
  nonCashAcceptance: AIR_VOUCHER_ACCEPTANCE,
  // DA-A-25 (contract §6): the carrier as merchant of record refunds automatically → tracked, not requested.
  caseMode: (r) => (r.nextAction.kind === "track" || r.nextAction.kind === "escalate" ? "track_automatic" : "request"),
};
