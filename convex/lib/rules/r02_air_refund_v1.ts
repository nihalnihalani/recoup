/**
 * R02 v1 — airline fare refund for a cancelled or significantly delayed/changed flight (docs/rules/R02-airline-refund.md,
 * spec gate M09/M09b/M09c `approve_for_activation`, D158; fixtures docs/rules/fixtures/R02.json). Pure: no ctx, no clock
 * (`now` is injected), no randomness, no `lib/ai`.
 *
 * What it evaluates. One ticket (subject `txn` of an `air_travel` transaction) against 14 CFR 260.6 (carrier as merchant
 * of record: automatic refund, path R02.a) or 14 CFR 399.80(l) (ticket agent as merchant of record: refund on request,
 * path R02.b). The spec's ordered outline (§16) is implemented as stages; each stage is a tri-state condition and the
 * outcome comes ONLY from `deriveOutcome`:
 *   1  source freshness (30-day refresh; README rule 3) and the compliance-date gate (FR-2024-07177-COMPLIANCE)
 *   2  scope: a covered flight (P-260.2-COVERED; `non_us` → unsupported) and a nonrefundable ticket (refundable →
 *      unsupported in v1)
 *   3  event: cancellation (incl. a renumbered-only flight, P-260.2-CANCEL, which is manual_review under the
 *      enforcement pause, L1) or a significant delay/change (P-260.2-SIG criteria 1–5; an operational delay is judged
 *      on the carrier's revised scheduled arrival, and a revised schedule and actual arrival on opposite sides of the
 *      threshold → manual_review)
 *   4  the passenger did not fly the changed/alternative flight (P-260.6-A1(i); L4 downgrade fare difference and L5
 *      accepted-but-not-flown → manual_review)
 *   5  a deemed refund request (P-260.6-A2 (i)/(ii)/(iii)) and no affirmatively accepted compensation (P-260.7); a
 *      no-response request whose trigger (a departure) is still in the future → not_yet_due at that date
 *   6  the path (merchant of record, P-260.2-MOR) and the carrier; for R02.a the deemed-request instant (the carrier
 *      timer's anchor and the compliance-date input, spec §11 "anchor unknown → needs_facts")
 *   7  the amount inputs (§8): fare + taxes + ancillary fees − already refunded, one currency; a partly flown itinerary
 *      keeps the outcome but has no estimate (A4)
 *
 * Questions (DA-A-24). Only decisive unknowns are listed, and only those of the FIRST unresolved stage in the order
 * above, so the user answers one step at a time (R02-04 asks only for the decision, R02-07 only for the disputed
 * arrival). Within the significance stage the criterion the event type names is asked first (arrival for a schedule
 * change or delay, cabin for a downgrade, …); the other criteria only when it fails. The disability criteria (6)/(7)
 * are raised by the passenger (260.6(b) "upon notification") and are never asked: a confirmed `true` gives
 * manual_review (L11). The carrier timer's time zone is never asked either.
 *
 * Carrier timer (DA-A-5, DA-A-25). A COUNTERPARTY deadline: 7 business days (credit card) or 20 calendar days (cash,
 * check, debit card, miles, other) after the deemed-request date (P-260.2-PROMPT), counted from the day after, US
 * federal holidays skipped, in the consumer's home time zone (A1; when unknown, the deadline engine's earliest-ending
 * US zone, noted in the explanation, never an assumption on the outcome). An unknown payment class selects no timer
 * and never changes the outcome. The DOT page's "20 business days" (DOT-REF-3) is disclosed on the 20-day timer (L2).
 * Next action: carrier → `track`, overdue → `escalate`; ticket agent → `request_refund` (D143.2).
 *
 * Status. This file declares `lifecycle: "researched"`; only the lead's activation entry and the manifest decide the
 * real status. "Active" would mean independently reviewed against the captured text — never legal certification.
 */
import { currencyExponent, formatMinor } from "../money";
import { alternatives, knownCell, withOverride, type Cell, type CellLookup as FactLookup } from "../facts/resolve";
import { AIR_TXN_SUBJECT, buildAirSnapshot, r02BoundFacts, r02View, type AirSnapshotInput, type R02View } from "../facts/snapshot_air";
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
  type NextAction,
  type Outcome,
  type RulePack,
  type RuleSourceMeta,
  type SourceRef,
  type Tri,
} from "./types";

export const R02_V1_RULE_ID = "R02.airline_fare_refund.us_dot";
export const R02_V1_VERSION = 1;
export const R02_REMEDY_KEY = "fare_refund";
export const R02_CARRIER_TIMER_CREDIT_ID = "r02.v1.carrier_refund.credit_card";
export const R02_CARRIER_TIMER_OTHER_ID = "r02.v1.carrier_refund.other";
export const R02_AGENT_TIMER_ID = "r02.v1.agent_refund";

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
  /** Refund provisions' compliance date "October 28, 2024" (FR-2024-07177-COMPLIANCE); spec §16 step 1b. */
  refundComplianceDate: string;
  /** Renumbered-flight enforcement pause "expiring on July 7, 2027" (FR-2026-13675-DATES); spec L1. Display only. */
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
const USC_42305 = "https://www.govinfo.gov/content/pkg/USCODE-2024-title49/html/USCODE-2024-title49-subtitleVII-partA-subpartii-chap423-sec42305.htm";
const ECFR_399 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-F/part-399/subpart-G/section-399.80";
const DOT_REFUNDS = "https://www.transportation.gov/individuals/aviation-consumer-protection/refunds";
const FR_2024_07177 = "https://www.federalregister.gov/documents/2024/04/26/2024-07177";
const FR_2026_13675 = "https://www.federalregister.gov/documents/2026/07/07/2026-13675/airline-refunds-and-other-consumer-protections";
const REFRESH_DAYS = 30;

const src = (sourceId: string, passageId: string, url: string, effective: string): RuleSourceMeta =>
  Object.freeze({ sourceId, passageId, url, effective, refreshWindowDays: REFRESH_DAYS });

/** Captured sources (manifest `sources`, spec §14). Every one has the 30-day refresh window (spec header). */
export const R02_SOURCES: readonly RuleSourceMeta[] = Object.freeze([
  src("ecfr-14cfr260", "P-260.2-COVERED", ECFR_260, "2024-06-25"),
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
    case "instant": return new Date(v.epochMs).toISOString();
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
/** "3h10m" from a millisecond span (display only). */
function hm(ms: number): string {
  const total = Math.round(Math.abs(ms) / MINUTE_MS);
  return `${ms < 0 ? "-" : ""}${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m`;
}

// ---------------------------------------------------------------------------
// Stages and condition leaves
// ---------------------------------------------------------------------------

/** Spec §16 order; questions come from the first stage with a decisive unknown. */
const STAGES = ["scope", "event", "significance", "significance_other", "not_flown", "response", "path", "anchor", "amount"] as const;
type Stage = (typeof STAGES)[number];

function leaf(
  stage: Stage, id: string, text: string, kind: ConditionKind, result: Tri, used: readonly Cell[],
  opts: { unknown?: readonly Cell[]; note?: string; passage?: string } = {},
): ComputedCondition {
  const unknown = result === "unknown" ? (opts.unknown ?? []) : [];
  const seen = new Set<string>();
  const facts: FactRef[] = [];
  for (const c of [...used, ...unknown]) {
    const id2 = `${c.subjectKey}\u0000${c.key}`;
    if (!seen.has(id2)) {
      seen.add(id2);
      facts.push(ref(c));
    }
  }
  const candidateFacts = used.filter((c) => c.status === "candidate").map(ref);
  return {
    op: "computed", id, label: text, kind, result, facts,
    ...(result === "unknown" ? { unknownFacts: unknown.map((c) => ({ fact: ref(c), reason: unresolvedReason(c) })) } : {}),
    ...(candidateFacts.length > 0 ? { candidateFacts } : {}),
    neededFor: [stage],
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.passage !== undefined ? { sourcePassageId: opts.passage } : {}),
  };
}

/** A span measured against the scope's threshold; an unknown scope decides only when both thresholds agree. */
function againstThreshold(spanMs: number, scope: Cell, p: R02Params): { result: Tri; used: Cell[]; unknown: Cell[] } {
  const domestic = spanMs >= p.domesticThresholdMinutes * MINUTE_MS;
  const international = spanMs >= p.internationalThresholdMinutes * MINUTE_MS;
  const s = code(scope);
  if (s === "domestic") return { result: domestic ? "pass" : "fail", used: [scope], unknown: [] };
  if (s === "international" || s === "non_us") return { result: international ? "pass" : "fail", used: [scope], unknown: [] };
  if (domestic === international) return { result: domestic ? "pass" : "fail", used: [], unknown: [] };
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
  /** The anchor facts; the earliest usable instant wins ("the earliest date the refund was requested", P-260.2-PROMPT). */
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
  /** Decisive unresolved facts of the FIRST unresolved stage (the questions). */
  missing: MissingFact[];
  /** Every decisive unresolved fact (all stages) — conflicts are candidate-tested only when decisive. */
  decisiveUnresolved: MissingFact[];
  /** Decisive facts used only as unconfirmed candidates (D147(2)): they cap the outcome. */
  unconfirmed: MissingFact[];
  amount: AmountCalc | null;
  deadlines: DeadlineResult[];
  path: "a" | "b" | null;
  /** Failing conditions that decide not_eligible (a failed criterion inside a passing "any" is not one). */
  disqualifierIds: string[];
  explanation: string[];
  /** Notes about the carrier timer (disclosed source conflict, time-zone fallback): shown only with the timer. */
  deadlineNotes: string[];
  passages: string[];
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

/** Compliance gate: the event's local date is before `date` wherever the consumer may be. */
function beforeDate(epochMs: number, home: ZoneRule | null, date: string): boolean {
  return localDates(epochMs, home).every((d) => d < date);
}

/** A re-evaluation date: the earliest local date the instant falls on (re-checking early is harmless). */
function earliestLocalDate(epochMs: number, home: ZoneRule | null): string {
  return [...localDates(epochMs, home)].sort()[0];
}

function carrierTimers(anchorKey: string, p: R02Params): DeadlineSpec[] {
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
    timeZone: { from: "fact" as const, factKey: K.homeZone },
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

function core(v: R02View, env: Env): Core {
  const { p, now } = env;
  const cell = (key: string): Cell => v.lookup.get(TXN, key);
  const flags: Flags = emptyFlags();
  const explanation: string[] = [];
  const passages: string[] = ["P-260.6-A1"];
  if (env.stale) flags.sourceStale = true;

  const scope = cell(K.scope);
  const refundability = cell(K.refundability);
  const event = cell(K.event);
  const eventCode = code(event);
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
  const home = zoneRule(code(cell(K.homeZone)) ?? "");
  const leaves: ConditionNode[] = [];

  // --- Stage: scope (P-260.2-COVERED; v1 nonrefundable tickets only) ---
  const scopeCode = code(scope);
  if (scopeCode === "non_us") {
    flags.unsupportedReason = "Not a covered flight: no point in the United States (14 CFR 260.2). Other regimes may apply; Recoup does not evaluate them.";
  }
  leaves.push(leaf("scope", "r02.v1.covered_flight", "A covered flight: to, from or within the United States", "applicability",
    scopeCode === null ? "unknown" : scopeCode === "non_us" ? "fail" : "pass", scopeCode === null ? [] : [scope],
    { unknown: [scope], passage: "P-260.2-COVERED" }));
  const refundCode = code(refundability);
  if (refundCode === "refundable") {
    flags.unsupportedReason ??= "A fully refundable ticket has its own refund terms; R02 v1 covers nonrefundable tickets only.";
  }
  leaves.push(leaf("scope", "r02.v1.nonrefundable", "A nonrefundable ticket", "applicability",
    refundCode === null ? "unknown" : refundCode === "refundable" ? "fail" : "pass", refundCode === null ? [] : [refundability],
    { unknown: [refundability], passage: "P-260.6-A1" }));

  // --- Stage: event and significance ---
  const cancelled = eventCode === "cancellation" || eventCode === "renumbered_only";
  if (eventCode === "renumbered_only") {
    flags.manualReviewReason = `The flight was only renumbered. The regulation's text treats that as a cancellation (P-260.2-CANCEL), but DOT is not enforcing the refund rules for renumbered flights with no significant change until ${p.renumberedPauseEnds} while it reconsiders the definition (Refund III, FR-2026-13675). A person reviews it.`;
    passages.push("FR-2026-13675-DATES");
  }
  const cancelLeaf = leaf(eventCode === null ? "event" : "significance", "r02.v1.cancelled", "The flight was cancelled", "requirement",
    eventCode === null ? "unknown" : cancelled ? "pass" : "fail", eventCode === null ? [] : [event],
    { unknown: [event], passage: "P-260.2-CANCEL" });

  const oArr = cell(K.oArr);
  const cArr = cell(K.cArr);
  const criteria: { leaf: ComputedCondition; code: string }[] = [];
  let downgradeHolds = false;
  if (!cancelled) {
    const primaryOf: Record<string, string> = {
      schedule_change: "c2", operational_delay: "c2", downgrade: "c5", airport_change: "c3", added_connection: "c4",
    };
    const primary = eventCode === null ? null : primaryOf[eventCode] ?? null;
    const stageOf = (id: string): Stage => (primary === id ? "significance" : "significance_other");
    const span = (from: Cell, to: Cell, id: string, text: string, passage: string) => {
      const a = instant(from);
      const b = instant(to);
      if (a === null || b === null) {
        return leaf(stageOf(id), `r02.v1.sig.${id}`, text, "requirement", "unknown", [], { unknown: [from, to].filter((c) => !usable(c)), passage });
      }
      const ms = b - a;
      const t = againstThreshold(ms, scope, p);
      return leaf(stageOf(id), `r02.v1.sig.${id}`, text, "requirement", t.result, [from, to, ...t.used],
        { unknown: t.unknown, note: `${hm(ms)} against ${thresholdLabel(scope, p)}`, passage });
    };
    // (2) later arrival — for an operational delay, the carrier's revised scheduled arrival (spec §4, step 3). A revised
    // schedule and an actual arrival on opposite sides of the threshold (P-42305-D "arrives" vs P-260.2-SIG "scheduled
    // to arrive") make the criterion undecidable here → manual_review (never not_eligible).
    const actual = instant(cell(K.actualArr));
    const oA = instant(oArr);
    const cA = instant(cArr);
    let straddle = false;
    if (eventCode === "operational_delay" && actual !== null && oA !== null && cA !== null) {
      const revised = againstThreshold(cA - oA, scope, p).result;
      const arrived = againstThreshold(actual - oA, scope, p).result;
      if (revised !== "unknown" && arrived !== "unknown" && revised !== arrived) {
        straddle = true;
        flags.manualReviewReason ??= `The revised schedule is ${hm(cA - oA)} late but the flight actually arrived ${hm(actual - oA)} late: the statute counts when you arrive (P-42305-D), the regulation the schedule (P-260.2-SIG). A person reviews it.`;
        passages.push("P-42305-D");
      }
    }
    const arrivalText = "Scheduled to arrive 3 h (domestic) / 6 h (international) or more later";
    criteria.push({
      code: "c2",
      leaf: straddle
        ? leaf(stageOf("c2"), "r02.v1.sig.c2", arrivalText, "requirement", "unknown", [oArr, cArr, cell(K.actualArr)], { note: "revised schedule and actual arrival disagree (manual review)", passage: "P-260.2-SIG" })
        : span(oArr, cArr, "c2", arrivalText, "P-260.2-SIG"),
    });
    if (eventCode !== "operational_delay") {
      // (1) earlier departure: the changed departure is 3 h / 6 h or more before the original one.
      criteria.push({ code: "c1", leaf: span(cDep, oDep, "c1", "Scheduled to depart 3 h (domestic) / 6 h (international) or more earlier", "P-260.2-SIG") });
      // (3) a different origin or destination airport.
      const pairs: [Cell, Cell][] = [[cell(K.oOrigin), cell(K.cOrigin)], [cell(K.oDest), cell(K.cDest)]];
      const differs = pairs.find(([a, b]) => label(a) !== null && label(b) !== null && label(a) !== label(b));
      const allKnown = pairs.every(([a, b]) => label(a) !== null && label(b) !== null);
      criteria.push({ code: "c3", leaf: leaf(stageOf("c3"), "r02.v1.sig.c3", "Departs from or arrives at a different airport", "requirement",
        differs ? "pass" : allKnown ? "fail" : "unknown", differs ?? pairs.flat().filter(usable),
        { unknown: pairs.flat().filter((c) => !usable(c)), passage: "P-260.2-SIG" }) });
      // (4) more connection points.
      const oc = count(cell(K.oConn));
      const cc = count(cell(K.cConn));
      criteria.push({ code: "c4", leaf: leaf(stageOf("c4"), "r02.v1.sig.c4", "More connections than the original itinerary", "requirement",
        oc === null || cc === null ? "unknown" : cc > oc ? "pass" : "fail", [cell(K.oConn), cell(K.cConn)].filter(usable),
        { unknown: [cell(K.oConn), cell(K.cConn)].filter((c) => !usable(c)), passage: "P-260.2-SIG" }) });
      // (5) a downgrade to a lower class of service.
      const oCab = code(cell(K.oCabin));
      const cCab = code(cell(K.cCabin));
      const known = oCab !== null && cCab !== null && oCab in CABIN_RANK && cCab in CABIN_RANK;
      downgradeHolds = known && CABIN_RANK[cCab] > CABIN_RANK[oCab];
      criteria.push({ code: "c5", leaf: leaf(stageOf("c5"), "r02.v1.sig.c5", "Downgraded to a lower class of service", "requirement",
        known ? (downgradeHolds ? "pass" : "fail") : "unknown", [cell(K.oCabin), cell(K.cCabin)].filter(usable),
        { unknown: [cell(K.oCabin), cell(K.cCabin)].filter((c) => !usable(c)), passage: "P-260.2-SIG" }) });
    }
  }
  // Disability criteria (6)/(7): raised by the passenger (260.6(b) "upon notification"), never asked (DA-A-24); a
  // confirmed `true` is reviewed by a person (L11) and keeps the significance question open, so it never becomes
  // not_eligible on the other criteria alone.
  const disability = cell(K.disability);
  if (bool(disability) === true) {
    flags.manualReviewReason ??= "You told Recoup a disability is involved. The two disability-specific refund grounds (a different connecting airport, or a substitute aircraft without a feature you need) are reviewed by a person (L11).";
    if (!cancelled) {
      criteria.push({ code: "c6", leaf: leaf("significance_other", "r02.v1.sig.disability", "A disability-specific change (different connecting airport or substitute aircraft)", "requirement", "unknown", [disability], { note: "reviewed by a person (L11)", passage: "P-260.2-SIG" }) });
    }
  }
  const sigChildren: ConditionNode[] = eventCode === null ? [cancelLeaf, ...criteria.map((c) => c.leaf)] : cancelled ? [cancelLeaf] : criteria.map((c) => c.leaf);
  const significance: ConditionNode = { op: "any", children: sigChildren };
  leaves.push(significance);
  const significanceResult = evaluateConditions(significance, lookupFrom([])).result;
  passages.push(cancelled ? "P-260.2-CANCEL" : "P-260.2-SIG");
  if (eventCode === "operational_delay" && significanceResult === "fail") {
    explanation.push("The delay is below the refund threshold. No federal rule pays cash for a delay; the airline's own customer-service commitments (R15) may cover meals or a hotel.");
  }

  // --- Stage: not flown (P-260.6-A1(i)) ---
  const altKey = usable(alt) ? K.altDeparts : usable(cDep) ? K.cDep : K.altDeparts;
  const altAt = instant(alt) ?? instant(cDep);
  const departedLater = altAt !== null && altAt > now;
  if (flewValue !== null) {
    if (flewValue && downgradeHolds) {
      flags.manualReviewReason ??= "You flew the downgraded flight. DOT's page says the airline must refund the fare difference (DOT-REF-6), but the regulation located for this rule does not state it (L4). A person reviews it.";
      leaves.push(leaf("not_flown", "r02.v1.not_flown", "You did not fly the changed or replacement flight", "exclusion", "pass", [flew], { note: "flew the downgraded flight (L4)" }));
    } else {
      leaves.push(leaf("not_flown", "r02.v1.not_flown", "You did not fly the changed or replacement flight", "exclusion", flewValue ? "fail" : "pass", [flew], { passage: "P-260.6-A1" }));
    }
  } else if (eventCode === "cancellation" && (offerCode === "none" || offerCode === "voucher_or_credit")) {
    leaves.push(leaf("not_flown", "r02.v1.not_flown", "You did not fly the changed or replacement flight", "exclusion", "pass", [event, offer], { note: "no replacement flight was offered" }));
  } else if (departedLater) {
    leaves.push(leaf("not_flown", "r02.v1.not_flown", "You did not fly the changed or replacement flight", "exclusion", "pass", [usable(alt) ? alt : cDep], { note: "the changed flight has not departed yet" }));
  } else {
    leaves.push(leaf("not_flown", "r02.v1.not_flown", "You did not fly the changed or replacement flight", "exclusion", "unknown", [], { unknown: [flew], passage: "P-260.6-A1" }));
  }

  // --- Stage: deemed request (P-260.6-A2) and no affirmatively accepted compensation (P-260.7) ---
  const voucherKey = eventCode === "cancellation" || eventCode === "renumbered_only" ? K.oDep : K.cDep;
  let basis: Basis | null = null;
  const responseLeaf = (result: Tri, used: Cell[], opts: { unknown?: Cell[]; note?: string } = {}) =>
    leaf("response", "r02.v1.deemed_request", "A refund request is deemed made and no compensation was affirmatively accepted", "requirement", result, used, { ...opts, passage: "P-260.6-A2" });
  if (responseCode === "accepted_compensation") {
    leaves.push(responseLeaf("fail", [response], { note: "a voucher, credit or other compensation was affirmatively accepted (P-260.7)" }));
    passages.push("P-260.7");
  } else if (responseCode === "accepted_rebooking") {
    if (departedLater) {
      leaves.push(responseLeaf("fail", [response, usable(alt) ? alt : cDep], { note: "rebooking accepted (260.6(a)(1)(i))" }));
    } else if (flewValue === false) {
      flags.manualReviewReason ??= "You accepted the rebooking but did not fly it. The regulation does not address a later change of mind (L5); a person reviews it.";
      leaves.push(responseLeaf("pass", [response, flew], { note: "accepted rebooking, not flown (L5)" }));
    } else if (flewValue === true) {
      leaves.push(responseLeaf("fail", [response, flew]));
    } else {
      leaves.push(responseLeaf("unknown", [response], { unknown: [flew] }));
    }
  } else {
    basis = basisFor(responseCode, offerCode, eventCode, altKey, voucherKey);
    if (basis === null) {
      // Decision unknown (or the offer, for a no-response): ask. "I don't know" stays unknown (DA-A-1).
      const unknown = responseCode === "no_response" ? [offer] : [response];
      leaves.push(responseLeaf("unknown", [], { unknown }));
    } else if (basis.kind === "rejected" || basis.kind === "cancelled_nothing_offered") {
      leaves.push(responseLeaf("pass", basis.kind === "rejected" ? [response] : [offer, event], { note: BASIS_TEXT[basis.kind] }));
    } else {
      // A no-response request exists only once its trigger instant has passed (260.6(a)(2)(iii)).
      const triggers = basis.anchorKeys.map(cell);
      const missingTriggers = triggers.filter((c) => instant(c) === null);
      if (missingTriggers.length > 0) {
        leaves.push(responseLeaf("unknown", [response, offer], { unknown: missingTriggers }));
      } else {
        const at = Math.min(...triggers.map((c) => instant(c)!));
        if (at > now) {
          const date = earliestLocalDate(at, home);
          flags.notYetDue = { at: date, when: "the changed or replacement flight departs without you (or the voucher offer's deadline passes)" };
          explanation.push(`Not yet due: with no response, the refund request counts from ${date} (260.6(a)(2)(iii)).`);
        }
        leaves.push(responseLeaf("pass", [response, offer, ...triggers], { note: BASIS_TEXT[basis.kind] }));
      }
    }
    if (basis !== null) passages.push("P-260.6-A2");
  }

  // --- Stage: path (merchant of record) and carrier ---
  const path: "a" | "b" | null = morCode === "carrier" ? "a" : morCode === "ticket_agent" ? "b" : null;
  leaves.push(leaf("path", "r02.v1.merchant_of_record", "Who took the payment (merchant of record) is known", "requirement",
    path === null ? "unknown" : "pass", path === null ? [] : [mor], { unknown: [mor], passage: "P-260.2-MOR" }));
  const operating = cell(K.operating);
  const marketing = cell(K.marketing);
  const carrierCell = [operating, marketing].find((c) => c.known) ?? [operating, marketing].find(usable);
  leaves.push(leaf("path", "r02.v1.carrier", "The airline is known", "requirement",
    carrierCell ? "pass" : "unknown", carrierCell ? [carrierCell] : [], { unknown: [operating], passage: "P-260.2-COVERED" }));
  if (path === "b") passages.push("P-399.80(l)");

  // --- Stage: anchor (R02.a: the deemed-request instant; spec §11 "anchor unknown → needs_facts") ---
  const anchorCells = basis ? basis.anchorKeys.map(cell) : [];
  const anchorAt = anchorCells.length > 0 && anchorCells.every((c) => instant(c) !== null) ? Math.min(...anchorCells.map((c) => instant(c)!)) : null;
  if (path === "a" && basis !== null) {
    leaves.push(leaf("anchor", "r02.v1.request_date", "The date the refund request was deemed made is known", "timing",
      anchorAt !== null ? "pass" : "unknown", anchorCells.filter((c) => instant(c) !== null),
      { unknown: anchorCells.filter((c) => instant(c) === null), passage: "P-260.2-PROMPT" }));
  }
  // Compliance-date gate (spec §16 step 1b): the deemed-request (or incident) date before 2024-10-28.
  const gateAt = anchorAt ?? instant(oDep) ?? instant(cDep) ?? instant(cell(K.cancelNotice)) ?? instant(cell(K.responseAt));
  if (gateAt !== null && beforeDate(gateAt, home, p.refundComplianceDate)) {
    flags.effectiveDateMismatch = true;
    passages.push("FR-2024-07177-COMPLIANCE");
    explanation.push(`The refund request date is before the refund rule's compliance date (${p.refundComplianceDate}); R02 v1 does not evaluate earlier events.`);
  }

  // --- Stage: amount (§8) ---
  const amountCells = [cell(K.fare), cell(K.taxes), cell(K.ancillary), cell(K.refunded)];
  const amounts = amountCells.map(money);
  let amount: AmountCalc | null = null;
  let amountResult: Tri = "unknown";
  const missingAmounts = amountCells.filter((_c, i) => amounts[i] === null);
  if (missingAmounts.length === 0) {
    const [fare, taxes, ancillary, refunded] = amounts as Money[];
    const currencies = new Set(amounts.map((m) => m!.currency));
    for (const c of currencies) {
      if (currencyExponent(c, "new_scenario") === null) flags.unsupportedReason ??= `Recoup's air checks handle USD amounts only; ${c} is not supported yet (O6).`;
    }
    if (currencies.size > 1) {
      amountResult = "pass";
      explanation.push("The fare, taxes and fees are in different currencies; Recoup never adds different currencies, so a person works out the amount.");
    } else {
      const due = fare.amountMinor + taxes.amountMinor + ancillary.amountMinor - refunded.amountMinor;
      amountResult = due > 0 ? "pass" : "fail";
      if (due <= 0) explanation.push("The airline has already refunded the fare, taxes and fees in full.");
      const partly = bool(cell(K.partlyFlown));
      if (due > 0 && partly === true) {
        explanation.push("Part of this ticket was already flown. 260.6(a)(1) does not say how to split a partly used ticket (assumption A4), so a person works out the amount; the refund itself is owed.");
      } else if (due > 0) {
        const currency = fare.currency;
        amount = {
          estimate: { amountMinor: due, currency },
          basis: "exact_formula",
          formula: "fare + taxes + ancillary fees - already refunded",
          inputs: [
            { label: "fare", value: String(fare.amountMinor), fact: ref(amountCells[0]) },
            { label: "taxes", value: String(taxes.amountMinor), fact: ref(amountCells[1]) },
            { label: "ancillary fees", value: String(ancillary.amountMinor), fact: ref(amountCells[2]) },
            { label: "already refunded", value: String(refunded.amountMinor), fact: ref(amountCells[3]) },
          ],
        };
        passages.push("P-260.10");
      }
    }
  }
  leaves.push(leaf("amount", "r02.v1.amount_owed", "Fare, taxes and fees paid, less anything already refunded, leave an amount owed", "requirement",
    amountResult, missingAmounts.length === 0 ? amountCells : [], { unknown: missingAmounts, passage: "P-260.6-A1" }));

  // --- Evaluate the tree ---
  const tree: ConditionNode = { op: "all", children: leaves };
  const ev = evaluateConditions(tree, lookupFrom([]));
  const firstStage = STAGES.find((s) => ev.decisiveMissing.some((m) => m.neededFor.includes(s)));
  const missing = firstStage === undefined ? [] : ev.decisiveMissing.filter((m) => m.neededFor.includes(firstStage));

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
  } else if (path === "a") {
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
    const computed = carrierTimers(anchorKey, p).map((spec) => computeDeadlineDetailed(spec, engineLookup, now));
    const selected = computed.filter((d) => d.result.status !== "not_applicable");
    const shown = selected.length > 1 ? [selected[0]] : selected;
    for (const d of shown) {
      const notes: string[] = [];
      if (d.result.id === R02_CARRIER_TIMER_OTHER_ID) {
        notes.push(L2_DISCLOSURE);
        passages.push("DOT-REF-3");
      }
      for (const a of d.assumptions) notes.push(a.text);
      deadlines.push(notes.length > 0 ? { ...d.result, basis: `${d.result.basis} ${notes.join(" ")}` } : d.result);
      if (d.result.id === R02_CARRIER_TIMER_OTHER_ID) deadlineNotes.push(L2_DISCLOSURE);
      for (const a of d.assumptions) deadlineNotes.push(`${a.text} (The deadline is the airline's, so this never changes your result.)`);
    }
    passages.push("P-260.2-PROMPT");
  }

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
    amount, deadlines, path, disqualifierIds, explanation, deadlineNotes, passages,
  };
}

// ---------------------------------------------------------------------------
// Evaluation: conflicts (D152/D154/D158), outcome, projection
// ---------------------------------------------------------------------------

/** An amount is shown only where it can be owed (never for not_yet_due, needs_facts, not_eligible, …). */
const AMOUNT_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit"]);
/** The carrier timer is shown where a refund is (or may be, after review) owed. */
const DEADLINE_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "manual_review"]);

function outcomeOf(c: Core): { outcome: Outcome; amount: AmountCalc | null } {
  const outcome = deriveOutcome({ ...c.dims, readyForApproval: "unknown" }, c.flags, []);
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

function nextActionFor(outcome: Outcome, c: Core, flags: Flags, missing: readonly MissingFact[], manualReason: string | undefined): NextAction {
  switch (outcome) {
    case "eligible":
    case "likely_eligible":
    case "possible_contract_benefit": {
      if (c.path === "b") return { kind: "request_refund" };
      const overdue = overdueCounterpartyDeadlines(c.deadlines);
      if (overdue.length > 0) {
        const due = overdue[0].dueLocalDate ?? new Date(overdue[0].dueAt!).toISOString().slice(0, 10);
        return { kind: "escalate", reason: `The airline's refund deadline (${due}) has passed without the refund. Ask the airline through its refund channel, or file a complaint with DOT's Office of Aviation Consumer Protection.` };
      }
      return { kind: "track" };
    }
    case "needs_facts": {
      const keys = missing.filter((m) => m.reason !== "candidate_unconfirmed" && m.reason !== "conflict_capped").map((m) => ({ subjectKey: m.subjectKey, key: m.key }));
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
      if (same) {
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

  const outcome = deriveOutcome({ ...final.dims, readyForApproval: "unknown" }, flags, []);
  const amount = AMOUNT_OUTCOMES.has(outcome) ? final.amount : null;
  const deadlines = DEADLINE_OUTCOMES.has(outcome) ? final.deadlines : [];
  const missingFacts: MissingFact[] =
    outcome === "needs_facts" ? [...missing, ...unconfirmed]
      : outcome === "eligible" || outcome === "likely_eligible" || outcome === "possible_contract_benefit" || outcome === "not_yet_due" ? [...(outcome === "not_yet_due" ? missing : []), ...unconfirmed]
        : [];
  const dimensions: Dimensions = { ...final.dims, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  const shaped: Core = { ...final, deadlines };
  const nextAction = nextActionFor(outcome, shaped, flags, missingFacts, manualReason);
  const lines = [
    ...extra,
    ...(outcome === "manual_review" && flags.manualReviewReason && !manualReason ? [flags.manualReviewReason] : []),
    ...(amount ? [`Refund owed: ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)} (fare + taxes + ancillary fees − already refunded), in the original form of payment (P-260.10).`] : []),
    ...(isApprovable(outcome) && final.path === "a" ? ["The airline must refund automatically; Recoup tracks its deadline."] : []),
    ...(isApprovable(outcome) && final.path === "b" ? ["A travel agency took the payment: it owes the refund when you ask for it (399.80(l)), not automatically."] : []),
    ...final.explanation,
    ...(deadlines.length > 0 ? final.deadlineNotes : []),
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
    assumptions: [],
    disqualifierIds: final.disqualifierIds,
    amount,
    deadlines,
    sourceRefs: sourceRefsFor(final.passages),
    lossKeys: [`txn:${v.transactionId}:fare_unused`],
    overlap: [],
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
 * D208 PackAdapter (M20's `RulePack.adapter`; standalone until that type is on main, then wired as `adapter`): live
 * fact rows of one air transaction → the single R02 run (the ticket, subject `txn`). Pure.
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
    { subjectPattern: TXN, key: K.operating, class: "required" },
    { subjectPattern: TXN, key: K.fare, class: "required" },
    { subjectPattern: TXN, key: K.taxes, class: "required" },
    { subjectPattern: TXN, key: K.ancillary, class: "required" },
    { subjectPattern: TXN, key: K.refunded, class: "required" },
  ],
  fixturesPath: "docs/rules/fixtures/R02.json",
  lateAskDeadlineIds: [],
  overlap: [],
  knownLimitations: [
    "L1: a renumbered-only flight is manual_review while DOT's enforcement pause runs (to 2027-07-07); mandatory re-review by then.",
    "L2: the 20-calendar-day timer is the regulation's; DOT's page also says '20 business days' (DOT-REF-3) — disclosed, not used.",
    "L4/L5/L11: the downgrade fare difference, an accepted-but-not-flown rebooking and the disability grounds are manual_review.",
    "L7: a ticket agent's refund deadline is not computable (it runs from information the consumer cannot see).",
    "A1: the carrier timer counts calendar days in the consumer's home time zone; when unknown, the earliest-ending US zone (never asked, never outcome-changing).",
    "A4: the fare is taken to be for the affected itinerary; a partly flown ticket has no estimate (a person splits it).",
    "A7: for a cancellation with nothing offered, the timer runs from the carrier's cancellation notice.",
    "Refundable tickets, charters, non-US itineraries and the 24-hour rule (14 CFR 259.5(b)(4)) are out of scope for v1 (L8).",
    "The multi-change nuance (A3: successive changes compared with the original schedule) relies on the stored original schedule.",
    "USD amounts only (O6); amounts in different currencies are never added — a person works out the amount.",
  ],
  evaluate: evaluateR02V1,
};
