/**
 * R04 v1 — delayed, lost or damaged checked baggage (docs/rules/R04-baggage.md, spec gate M09/M09b/M09c
 * `approve_for_activation`, D158; fixtures docs/rules/fixtures/R04.json). Pure: no ctx, no clock (`now` is injected), no
 * randomness, no `lib/ai`.
 *
 * Three SEPARATE packs (mission §10: separate opportunities, never merged), one rule id and version, one file:
 *   R04.a `bag_fee_refund`           — refund of the fee for that bag, 14 CFR 260.5 (legal entitlement)
 *   R04.b `delayed_bag_expenses`     — documented incidental expenses while delayed, 14 CFR 254.4 + DOT-BAG-1/2
 *   R04.c `lost_or_damaged_property` — lost/damaged property, 14 CFR 254.4 + DOT-BAG-6/7
 *
 * Bags (D234 (11); M27 R04-04/05/06/15). A trip has one bag per `incident:<id>` holding a per-bag fact, plus `txn` when
 * the transaction itself holds one; with no bag fact there are no bags and R04 asks nothing. Per-bag facts are read
 * only on their bag; only trip-level facts (the deplane opportunity, the incident date) are inherited from `txn`. A
 * bag's loss key is `txn:<id>:bag_fee:<tag>` (its known bag tag, else its incident id), never a position. Paths a and
 * c run once per bag; path b runs once per trip (its expense lines are trip-level) and passes if ANY bag was delayed.
 *
 * Path a (spec §15.2, D147(1)). Ordered stages: compliance gate (the incident's date; unknown → capped with an
 * assumption, README rule 5, D234 (8)) → scope (covered flight; `non_us` → unsupported) → Mishandled Baggage Report
 * (P-260.5-B: unknown → needs_facts; confirmed "not filed" → `not_yet_due` with `reevaluate.when` "MBR filed" and the
 * user's own next action `add_evidence baggage_report`, D154) → exemptions (P-260.5-F: carrier defences; a true one →
 * not_eligible, (f)(2) only when the carrier documented it, (f)(3) not for a lost bag, 260.5(g); unknown ones are an
 * assumption, conflicting ones follow D152) → significant delay (P-260.2-SDB/P-260.5-A: from the deplane opportunity
 * to delivery or pickup, > 12 h domestic, > 15 h / > 30 h international by the longest US↔foreign nonstop segment;
 * exactly the threshold is "within", A1; a declared-lost bag needs no delay; a bag not yet delivered is asked, never
 * extrapolated to the clock, D234 (10)) → the fee (P-260.5-E; unknown → likely_eligible, a 0 fee → nothing to refund).
 * **Path a may reach `eligible`** when every decisive fact is confirmed (D147(1)); an extracted candidate caps it at
 * likely_eligible (D147(2)). No carrier timer: 260.5 requires a prompt refund but defines no day count for bag fees
 * (L6), so the next action is `track` and never escalates by date.
 *
 * Paths b and c (spec §15.3/§15.4). Domestic only (international → unsupported, treaty regime, L8); a ticket with no
 * aircraft over 60 seats → manual_review (L3), unknown → an assumption; **always capped at likely_eligible** in v1
 * by the assumption "carrier contract of carriage not captured" (D143(4) as amended by D147(1)).
 *   b — delayed (D234 (9)): a bag still missing or declared lost, a confirmed delivery later than path a's significant-
 *       delay threshold, or a confirmed Mishandled Baggage Report (not for a damaged or pilfered bag, which is path c).
 *       A carousel pickup alone is not a delay; a confirmed "no report" with a short span → not_eligible. The estimate
 *       is the sum of documented, unallocated expense lines dated from the deplane day through the delivery day
 *       (`documented_total`, spec A2): a receipt is an evidence reference, an allocation names a remedy, a line equal to
 *       a bag fee is set aside for confirmation, and a reimbursement not tied to lines adds an assumption (D234 (13)).
 *   c — no estimate (depreciation, exclusions and the carrier's limit unknown); documented values are evidence only.
 * The 14 CFR 254.4 figure is shown only in the explanation as the minimum limit a carrier may impose ("Carrier
 * liability limit: at least $4,700 per passenger …"), versioned by the incident date ($3,800 before 2025-01-22). It is
 * never an estimate and never `amount.cap`; only a captured carrier limit is a cap (M27 R04-08).
 *
 * Unconfirmed values (D234 (1)): a negative, not-yet-due or review verdict never rests on an extracted candidate — it
 * is asked (`candidate_unconfirmed`); two conflicting candidates that give the same negative answer are asked too.
 * Questions (DA-A-24): only decisive unknowns, and only those of the first unresolved stage. Facts that cannot change
 * the outcome but the user can still add (receipts, dates, proof, the airline's contract terms, the fee) are listed as
 * assumption-class missing facts on likely results.
 *
 * Status. `lifecycle: "researched"`; the lead's activation entry and the manifest decide the real status.
 */
import { currencyExponent, formatMinor, parseDecimalToMinor } from "../money";
import { alternatives, knownCell, withOverride, type Cell, type CellLookup as FactLookup } from "../facts/resolve";
import {
  AIR_TXN_SUBJECT,
  bagFactSubject,
  buildAirSnapshot,
  lineSubject,
  r04Bags,
  r04BoundFacts,
  r04View,
  R04_MAX_EXPENSE_LINES,
  R04_MAX_PROPERTY_ITEMS,
  type AirSnapshotInput,
  type R04Path,
  type R04View,
} from "../facts/snapshot_air";
import { localParts, US_ZONES } from "../deadlines/usZones";
import { addMissing, evaluateConditions } from "./conditions";
import { candidateCombinations, deriveOutcome, sameAnswer, sourceStale, withSameAnswer } from "./outcome";
import {
  emptyFlags,
  isApprovable,
  lookupFrom,
  unresolvedReason,
  type AmountCalc,
  type Assumption,
  type CaseContext,
  type ComputedCondition,
  type ConditionKind,
  type ConditionNode,
  type ConditionResult,
  type ConflictFlag,
  type Dimensions,
  type EvaluationInput,
  type EvaluationResult,
  type FactRef,
  type FactValue,
  type Flags,
  type MissingFact,
  type MissingReason,
  type NextAction,
  type Outcome,
  type OverlapDecl,
  type RulePack,
  type RuleSourceMeta,
  type SourceRef,
  type Tri,
} from "./types";

export const R04_V1_RULE_ID = "R04.baggage.us_dot";
export const R04_V1_VERSION = 1;
export const R04_REMEDY_KEYS: Readonly<Record<R04Path, string>> = Object.freeze({
  a: "bag_fee_refund",
  b: "delayed_bag_expenses",
  c: "lost_or_damaged_property",
});

// ---------------------------------------------------------------------------
// Parameters — every number/date cites its passage
// ---------------------------------------------------------------------------

export interface R04LiabilityFloor {
  /** First incident date ("YYYY-MM-DD") the figure applies to; null = the figure before every dated entry. */
  effectiveFrom: string | null;
  amountMinor: number;
  currency: string;
}

export interface R04Params {
  /** "within 12 hours … for domestic itineraries" (P-260.2-SDB). */
  domesticDelayHours: number;
  /** "within 15 hours … international … non-stop flight segment … 12 hours or less in duration" (P-260.2-SDB). */
  internationalShortDelayHours: number;
  /** "within 30 hours … international … non-stop flight segment … more than 12 hours in duration" (P-260.2-SDB). */
  internationalLongDelayHours: number;
  /** The segment-length cut-off, "12 hours or less", in minutes (P-260.2-SDB). */
  longSegmentMinutes: number;
  /** Part 260 bag-fee refund compliance date "October 28, 2024" (FR-2024-07177-COMPLIANCE); spec §15 step 1b. */
  bagFeeComplianceDate: string;
  /** 14 CFR 254.4's minimum carrier limit by incident date: $4,700 from 2025-01-22, $3,800 before (P-254.4, FR-2024-23588). */
  liabilityFloors: readonly R04LiabilityFloor[];
  /** DOT delayed enforcement of the $4,700 figure "until March 20, 2025" (FR-2025-02814). Display only. */
  liabilityEnforcementFrom: string;
}

/** Parses a whole-dollar USD figure from its passage text into minor units (lib/money, never a float). */
function usd(major: string): number {
  const parsed = parseDecimalToMinor(major, "USD");
  if (!parsed.ok) throw new Error(`R04 parameter ${major} is not a USD amount`);
  return parsed.amountMinor;
}

export const R04_V1_PARAMS: R04Params = Object.freeze({
  domesticDelayHours: 12,
  internationalShortDelayHours: 15,
  internationalLongDelayHours: 30,
  longSegmentMinutes: 720,
  bagFeeComplianceDate: "2024-10-28",
  liabilityFloors: Object.freeze([
    Object.freeze({ effectiveFrom: "2025-01-22", amountMinor: usd("4,700"), currency: "USD" }),
    Object.freeze({ effectiveFrom: null, amountMinor: usd("3,800"), currency: "USD" }),
  ]),
  liabilityEnforcementFrom: "2025-03-20",
});

/** Machine-readable citations of every parameter (asserted against the spec in the pack's test). */
export const R04_PARAM_PASSAGES: Readonly<Record<keyof R04Params, readonly string[]>> = Object.freeze({
  domesticDelayHours: ["P-260.2-SDB"],
  internationalShortDelayHours: ["P-260.2-SDB"],
  internationalLongDelayHours: ["P-260.2-SDB"],
  longSegmentMinutes: ["P-260.2-SDB"],
  bagFeeComplianceDate: ["FR-2024-07177-COMPLIANCE"],
  liabilityFloors: ["P-254.4", "FR-2024-23588"],
  liabilityEnforcementFrom: ["FR-2025-02814"],
});

const ECFR_260 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-260";
const ECFR_254 = "https://www.ecfr.gov/current/title-14/chapter-II/subchapter-A/part-254";
const DOT_BAGS = "https://www.transportation.gov/lost-delayed-or-damaged-baggage";
const DOT_REFUNDS = "https://www.transportation.gov/individuals/aviation-consumer-protection/refunds";
const FR_2024_07177 = "https://www.federalregister.gov/documents/2024/04/26/2024-07177";
const FR_2024_23588 = "https://www.federalregister.gov/documents/2024/10/24/2024-23588";
const FR_2025_02814 = "https://www.federalregister.gov/documents/2025/02/20/2025-02814";
const REFRESH_DAYS = 30;
const src = (sourceId: string, passageId: string, url: string, effective: string): RuleSourceMeta =>
  Object.freeze({ sourceId, passageId, url, effective, refreshWindowDays: REFRESH_DAYS });

/** Captured sources per path (manifest `sources`, spec §13); 30-day refresh for every path (spec header). */
export const R04_SOURCES: Readonly<Record<R04Path, readonly RuleSourceMeta[]>> = Object.freeze({
  a: Object.freeze([
    src("ecfr-14cfr260", "P-260.2-SDB", ECFR_260, "2024-06-25"),
    src("ecfr-14cfr260", "P-260.5-A", ECFR_260, "2024-06-25"),
    src("ecfr-14cfr260", "P-260.5-B", ECFR_260, "2024-06-25"),
    src("ecfr-14cfr260", "P-260.5-D", ECFR_260, "2024-06-25"),
    src("ecfr-14cfr260", "P-260.5-E", ECFR_260, "2024-06-25"),
    src("ecfr-14cfr260", "P-260.5-F", ECFR_260, "2024-06-25"),
    src("federal-web-excerpts", "DOT-REF-8", DOT_REFUNDS, "unknown"),
    src("federal-web-excerpts", "FR-2024-07177-COMPLIANCE", FR_2024_07177, "2024-06-25"),
  ]),
  b: Object.freeze([
    src("ecfr-14cfr254", "P-254.2", ECFR_254, "2025-01-22"),
    src("ecfr-14cfr254", "P-254.3", ECFR_254, "2025-01-22"),
    src("ecfr-14cfr254", "P-254.4", ECFR_254, "2025-01-22"),
    src("federal-web-excerpts", "DOT-BAG-1", DOT_BAGS, "unknown"),
    src("federal-web-excerpts", "DOT-BAG-2", DOT_BAGS, "unknown"),
    src("fr-notices", "FR-2024-23588", FR_2024_23588, "2025-01-22"),
    src("fr-notices", "FR-2025-02814", FR_2025_02814, "2025-02-20"),
  ]),
  c: Object.freeze([
    src("ecfr-14cfr254", "P-254.2", ECFR_254, "2025-01-22"),
    src("ecfr-14cfr254", "P-254.3", ECFR_254, "2025-01-22"),
    src("ecfr-14cfr254", "P-254.4", ECFR_254, "2025-01-22"),
    src("federal-web-excerpts", "DOT-BAG-6", DOT_BAGS, "unknown"),
    src("federal-web-excerpts", "DOT-BAG-7", DOT_BAGS, "unknown"),
    src("fr-notices", "FR-2024-23588", FR_2024_23588, "2025-01-22"),
    src("fr-notices", "FR-2025-02814", FR_2025_02814, "2025-02-20"),
  ]),
});

// ---------------------------------------------------------------------------
// Keys and readers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Keys and readers
// ---------------------------------------------------------------------------

const TXN = AIR_TXN_SUBJECT;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const K = {
  scope: "air.itinerary_scope",
  segment: "air.longest_us_foreign_nonstop_segment_minutes",
  operatingLast: "air.operating_carrier_last_segment",
  largeAircraft: "air.large_aircraft_segment_on_ticket",
  carrierLimit: "air.carrier_liability_limit",
  carrierDeadline: "air.carrier_claim_deadline",
  carrierExclusions: "air.carrier_exclusions",
  reimbursement: "air.reimbursement_received",
  fee: "air.bag_fee_paid",
  deplane: "air.deplane_opportunity_at",
  delivered: "air.bag_delivered_or_picked_up_at",
  status: "air.bag_status",
  mbrFiled: "air.mbr_filed",
  mbrRef: "air.mbr_reference",
  mbrAt: "air.mbr_filed_at",
  exRecheck: "air.exemption_failed_recheck",
  exPickup: "air.exemption_failed_pickup",
  exVoluntary: "air.exemption_voluntary_separation",
  exDocumented: "air.exemption_documented_by_carrier",
  incidentDate: "air.incident_date",
  expAmount: "air.expense_amount",
  expDate: "air.expense_date",
  expReceipt: "air.expense_receipt",
  expAllocated: "air.expense_allocated_to",
  propItem: "air.property_item",
  propValue: "air.property_claimed_value",
  propProof: "air.property_proof",
} as const;

/**
 * A receipt is a reference to stored evidence, `evidence:<id>` (M27 R04-11; D235 (D)): typed text such as "none" or
 * "lost it" is not a receipt. (The key stays `text`; intake writes the reference when a receipt is attached.)
 */
export const R04_RECEIPT_REF = /^evidence:[a-z0-9]{1,64}$/;
/**
 * An allocation excludes a line only when it names a remedy, `<kind>:<detail>` — e.g. `card_benefit:baggage_delay`,
 * `insurer:…`, `R04.a:bag_fee` (M27 R04-12; D235 (D)). "no" or "none" is an answer, not an allocation.
 */
export const R04_ALLOCATION_REF = /^[a-z][a-z0-9_.]*:[a-z0-9_.-]+/i;

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
function minutes(c: Cell): number | null {
  const v = valueOf(c);
  return v?.kind === "minutes" ? v.minutes : v?.kind === "count" ? v.n : null;
}
function money(c: Cell): Money | null {
  const v = valueOf(c);
  return v?.kind === "money" ? { amountMinor: v.amountMinor, currency: v.currency } : null;
}
function text(c: Cell): string | null {
  const v = valueOf(c);
  if (v?.kind === "text") return v.text.trim() || null;
  if (v?.kind === "identifier") return v.value;
  return null;
}
function localDate(c: Cell): string | null {
  const v = valueOf(c);
  return v?.kind === "local_date" ? v.date : v?.kind === "local_datetime" ? v.dateTime.slice(0, 10) : null;
}
const ref = (c: Cell): FactRef => ({ subjectKey: c.subjectKey, key: c.key });
function show(v: FactValue): string {
  switch (v.kind) {
    case "money": return formatMinor(v.amountMinor, v.currency);
    // M27 R04-20: an instant is labelled UTC (the destination's zone is not known to the pack).
    case "instant": return `${new Date(v.epochMs).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    case "code": return v.code;
    case "bool": return v.value ? "yes" : "no";
    case "count": return String(v.n);
    case "minutes": return `${v.minutes} min`;
    case "text": return v.text;
    case "identifier": return v.value;
    case "local_date": return v.date;
    case "local_datetime": return v.dateTime;
    case "user_unknown": return "I don't know";
  }
}
function hm(ms: number): string {
  const total = Math.floor(Math.abs(ms) / MINUTE_MS);
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}m`;
}
/** "$4,700" for a whole-dollar USD amount (display of the federal figure only). */
function dollars(m: Money): string {
  if (m.currency === "USD" && m.amountMinor % 100 === 0) return `$${String(m.amountMinor / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
  return formatMinor(m.amountMinor, m.currency);
}
/** The instant's local dates in every US zone (the committed table); the UTC date for a pre-2007 instant. */
function usDates(epochMs: number): string[] {
  try {
    return US_ZONES.map((z) => localParts(z, epochMs).date);
  } catch {
    return [new Date(epochMs).toISOString().slice(0, 10)];
  }
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

const STAGES = ["gate", "scope", "mbr", "exemption", "delay", "status", "fee"] as const;
type Stage = (typeof STAGES)[number];

/**
 * A computed condition. D234 (1): a `fail` that rests on an extracted candidate is never a fail — it is `unknown` and
 * asks that candidate (`candidate_unconfirmed`).
 */
function leaf(
  stage: Stage, id: string, label: string, kind: ConditionKind, result: Tri, used: readonly Cell[],
  opts: { unknown?: readonly Cell[]; note?: string; passage?: string } = {},
): ComputedCondition {
  let res = result;
  let unknownFacts: { fact: FactRef; reason: MissingReason }[] = (opts.unknown ?? []).map((c) => ({ fact: ref(c), reason: unresolvedReason(c) }));
  const guarded = res === "fail" ? used.filter((c) => c.status === "candidate") : [];
  if (guarded.length > 0) {
    res = "unknown";
    unknownFacts = guarded.map((c) => ({ fact: ref(c), reason: "candidate_unconfirmed" as const }));
  }
  const guardedIds = new Set(guarded.map((c) => `${c.subjectKey}\u0000${c.key}`));
  const facts: FactRef[] = [];
  const seen = new Set<string>();
  for (const c of [...used, ...(opts.unknown ?? [])]) {
    const id2 = `${c.subjectKey}\u0000${c.key}`;
    if (!seen.has(id2)) {
      seen.add(id2);
      facts.push(ref(c));
    }
  }
  const candidateFacts = used.filter((c) => c.status === "candidate" && !guardedIds.has(`${c.subjectKey}\u0000${c.key}`)).map(ref);
  return {
    op: "computed", id, label, kind, result: res, facts,
    ...(res === "unknown" ? { unknownFacts } : {}),
    ...(candidateFacts.length > 0 ? { candidateFacts } : {}),
    neededFor: [stage],
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.passage !== undefined ? { sourcePassageId: opts.passage } : {}),
  };
}

/** A fact the user may still add that does not block the result (assumption class; listed with likely outcomes). */
function optional(cell: Cell, neededFor: string): MissingFact {
  return { subjectKey: cell.subjectKey, key: cell.key, reason: unresolvedReason(cell), class: "assumption", neededFor: [neededFor] };
}

const CONTRACT_ASSUMPTION: Assumption = {
  id: "r04.v1.carrier_contract_not_captured",
  text: "Recoup has not captured this airline's contract of carriage (its claim deadlines, exclusions and limit), so this path is shown as likely, not certain (D143(4), D147(1)). File with the airline promptly.",
  changesOutcomeIf: "the airline's contract sets a claim deadline you have missed, excludes these items or sets a different limit",
};
const LARGE_AIRCRAFT_ASSUMPTION: Assumption = {
  id: "r04.large_aircraft",
  text: "A flight on the ticket uses an aircraft with more than 60 seats, so the 14 CFR 254.4 floor on the airline's liability limit applies.",
  changesOutcomeIf: "every flight on the ticket used a plane with 60 seats or fewer (then a person reviews it)",
};
const NO_EXEMPTION_ASSUMPTION: Assumption = {
  id: "r04.a.no_exemption",
  text: "The airline has not recorded one of the three reasons it may refuse the bag-fee refund (customs recheck, bag left uncollected, travelling without the bag by agreement).",
  changesOutcomeIf: "the airline documents one of those reasons for this bag",
};
export const R04_GATE_ASSUMPTION_ID = "r04.a.after_compliance_date";
export const R04_REIMBURSEMENT_ASSUMPTION_ID = "r04.v1.unallocated_reimbursement";
/** Path a's re-evaluation trigger for a still-undelivered bag with an exemption (spec §15 step 2.3; D253(2)). */
export const R04_AWAIT_BAG = "bag delivered or declared lost";

interface Core {
  dims: Omit<Dimensions, "readyForApproval">;
  flags: Flags;
  conditions: ConditionResult[];
  /** Decisive unresolved facts of the FIRST unresolved stage (the questions). */
  missing: MissingFact[];
  /** Every decisive unresolved fact (conflicts are candidate-tested only when decisive). */
  decisiveUnresolved: MissingFact[];
  unconfirmed: MissingFact[];
  /** Assumption-class facts the user may still add (receipts, dates, proof, the carrier's contract terms, the fee). */
  optional: MissingFact[];
  /** Conflicting cells outside the condition tree that change the amount (expense lines). */
  amountConflicts: Cell[];
  assumptions: Assumption[];
  amount: AmountCalc | null;
  lossKeys: string[];
  disqualifierIds: string[];
  explanation: string[];
  passages: string[];
  nextActionHint?: NextAction;
}

interface Env {
  path: R04Path;
  p: R04Params;
  now: number;
  stale: boolean;
}

type Rest = Omit<Core, "dims" | "flags" | "conditions" | "missing" | "decisiveUnresolved" | "unconfirmed" | "disqualifierIds">;

function finishTree(leaves: ConditionNode[], flags: Flags, rest: Rest, extraUnconfirmed: MissingFact[] = []): Core {
  const ev = evaluateConditions({ op: "all", children: leaves }, lookupFrom([]));
  const first = STAGES.find((s) => ev.decisiveMissing.some((m) => m.neededFor.includes(s)));
  const missing = first === undefined ? [] : ev.decisiveMissing.filter((m) => m.neededFor.includes(first));
  const unconfirmed = [...ev.decisiveUnconfirmed];
  for (const u of extraUnconfirmed) addMissing(unconfirmed, u);
  const failing = (n: ConditionNode): ComputedCondition[] =>
    n.op === "computed" ? (n.result === "fail" && n.kind !== "timing" ? [n] : [])
      : n.op === "any" ? (evaluateConditions(n, lookupFrom([])).result === "fail" ? n.children.flatMap(failing) : [])
        : n.op === "all" ? n.children.flatMap(failing) : [];
  const disqualifierIds = leaves.flatMap(failing).map((l) => l.id);
  return {
    ...rest,
    dims: {
      applies: ev.result,
      factsKnown: ev.result === "pass" ? "pass" : "unknown",
      evidenceSupports: unconfirmed.length > 0 || rest.optional.some((o) => o.key === K.fee) ? "unknown" : "pass",
      windowOpen: "pass",
      amountCalculable: rest.amount !== null ? "pass" : ev.result === "fail" ? "fail" : "unknown",
    },
    flags,
    conditions: ev.conditions,
    missing,
    decisiveUnresolved: ev.decisiveMissing,
    unconfirmed,
    disqualifierIds,
  };
}

/** Reads a bag fact at the subject `bagFactSubject` names (per-bag facts on the bag only; trip-level facts inherited). */
function bagReader(v: R04View, bagSubjectKey: string): (key: string) => Cell {
  return (key) => v.lookup.get(bagFactSubject(v.lookup, bagSubjectKey, key), key);
}

/** The significant-delay threshold(s) for the trip (P-260.2-SDB), with the cells that decide it. */
function thresholds(v: R04View, p: R04Params): { hours: number[]; used: Cell[]; unknown: Cell[] } {
  const scope = v.lookup.get(TXN, K.scope);
  const segment = v.lookup.get(TXN, K.segment);
  const scopeCode = code(scope);
  if (scopeCode === "domestic") return { hours: [p.domesticDelayHours], used: [scope], unknown: [] };
  if (scopeCode === "international" || scopeCode === "non_us") {
    const seg = minutes(segment);
    if (seg !== null) return { hours: [seg <= p.longSegmentMinutes ? p.internationalShortDelayHours : p.internationalLongDelayHours], used: [scope, segment], unknown: [] };
    return { hours: [p.internationalShortDelayHours, p.internationalLongDelayHours], used: [scope], unknown: [segment] };
  }
  return { hours: [p.domesticDelayHours, p.internationalShortDelayHours, p.internationalLongDelayHours], used: [], unknown: [scope] };
}

/** "Not delivered … within N hours": exactly N:00 elapsed is within (A1), so late means strictly more. */
function lateVerdict(spanMs: number, hours: readonly number[]): Tri {
  const verdicts = hours.map((h) => spanMs > h * HOUR_MS);
  return verdicts.every((x) => x) ? "pass" : verdicts.every((x) => !x) ? "fail" : "unknown";
}

/** The 254.4 floor for the incident, and the display line (a limit, never an estimate). */
function liabilityDisplay(v: R04View, p: R04Params, bag: (key: string) => Cell): { floor: Money | null; carrierCap: Money | null; line: string; passages: string[] } {
  const dated = p.liabilityFloors.filter((f) => f.effectiveFrom !== null).sort((a, b) => (a.effectiveFrom! < b.effectiveFrom! ? 1 : -1));
  const before = p.liabilityFloors.find((f) => f.effectiveFrom === null)!;
  const floorOn = (date: string): R04LiabilityFloor => dated.find((f) => date >= f.effectiveFrom!) ?? before;
  const incidentCell = bag(K.incidentDate);
  const incident = incidentCell.known ? localDate(incidentCell) : null;
  const deplaneCell = bag(K.deplane);
  const deplane = deplaneCell.known ? instant(deplaneCell) : null;
  // A3: the incident date is the local date at the final-destination airport; unknown zone → every US zone.
  const dates = incident !== null ? [incident] : deplane !== null ? usDates(deplane) : [];
  const chosen = [...new Set(dates.map((d) => floorOn(d)))];
  const carrier = money(v.lookup.get(TXN, K.carrierLimit));
  const carrierKnown = v.lookup.get(TXN, K.carrierLimit).known;
  const passages = ["P-254.4", "FR-2024-23588"];
  if (chosen.length !== 1) {
    const current = dated[0];
    return {
      floor: null,
      carrierCap: null,
      line: `Carrier liability limit: at least ${dollars(before)} or ${dollars(current)} per passenger depending on the incident date (the federal floor changed on ${current.effectiveFrom}); add the date you arrived without the bag. It is a limit, never a payout.`,
      passages,
    };
  }
  const f = chosen[0];
  const floor: Money = { amountMinor: f.amountMinor, currency: f.currency };
  let line = f.effectiveFrom === null
    ? `Carrier liability limit: at least ${dollars(floor)} per passenger (federal floor in force before ${dated[dated.length - 1].effectiveFrom})`
    : `Carrier liability limit: at least ${dollars(floor)} per passenger (federal floor on the carrier's cap)`;
  let carrierCap: Money | null = null;
  if (carrier !== null && carrierKnown && carrier.currency === floor.currency && carrier.amountMinor >= floor.amountMinor) {
    carrierCap = carrier;
    line = `Carrier liability limit: ${dollars(carrier)} per passenger (the airline's stated limit; the federal floor is ${dollars(floor)})`;
  }
  // M27 R04-07: the enforcement note shows when ANY plausible local date falls in the delay window.
  if (f.effectiveFrom !== null && dates.some((d) => d >= f.effectiveFrom! && d < p.liabilityEnforcementFrom)) {
    line += `; DOT delayed enforcement of this figure to ${p.liabilityEnforcementFrom} (FR-2025-02814), its legal effective date is unchanged`;
    passages.push("FR-2025-02814");
  }
  return { floor, carrierCap, line: `${line}. Actual reimbursement depends on documented losses.`, passages };
}

// ---------------------------------------------------------------------------
// Path a — bag-fee refund (14 CFR 260.5)
// ---------------------------------------------------------------------------

function coreA(v: R04View, env: Env): Core {
  const { p, now } = env;
  const bag = bagReader(v, v.bagSubjectKey);
  const flags: Flags = emptyFlags();
  if (env.stale) flags.sourceStale = true;
  const explanation: string[] = [];
  const passages: string[] = ["P-260.5-D"];
  const assumptions: Assumption[] = [];
  const optionalFacts: MissingFact[] = [];
  const leaves: ConditionNode[] = [];

  // Compliance gate (spec §15 step 1b; README rule 5; D234 (8); M27 R04-07). The incident's date comes from a KNOWN
  // incident date, else a KNOWN deplane instant; report and delivery dates may only prove "before", never "after".
  const incidentCell = bag(K.incidentDate);
  const deplane = bag(K.deplane);
  const delivered = bag(K.delivered);
  const mbrAt = bag(K.mbrAt);
  const incidentDay = incidentCell.known ? localDate(incidentCell) : null;
  const deplaneAt = deplane.known ? instant(deplane) : null;
  const gateDates = incidentDay !== null ? [incidentDay] : deplaneAt !== null ? usDates(deplaneAt) : null;
  const laterProof = [mbrAt, delivered].filter((c) => c.known && instant(c) !== null).map((c) => usDates(instant(c)!));
  let gateBefore = false;
  let gateAssumed = false;
  if (gateDates !== null) {
    gateBefore = gateDates.every((d) => d < p.bagFeeComplianceDate);
    gateAssumed = !gateBefore && !gateDates.every((d) => d >= p.bagFeeComplianceDate);
  } else if (laterProof.some((ds) => ds.every((d) => d < p.bagFeeComplianceDate)) || usDates(now).every((d) => d < p.bagFeeComplianceDate)) {
    gateBefore = true;
  } else {
    gateAssumed = true;
    optionalFacts.push(optional(incidentCell, "compliance date"));
  }
  if (gateBefore) {
    flags.effectiveDateMismatch = true;
    passages.push("FR-2024-07177-COMPLIANCE");
    explanation.push(`The bag-fee refund conditions were met before the rule's compliance date (${p.bagFeeComplianceDate}); R04 v1 does not evaluate earlier events.`);
  } else if (gateAssumed) {
    assumptions.push({
      id: R04_GATE_ASSUMPTION_ID,
      text: `Recoup assumes the bag was mishandled on or after ${p.bagFeeComplianceDate}, when the bag-fee refund rule took effect (the date is ${gateDates === null ? "not confirmed yet" : "on that boundary depending on your time zone"}).`,
      changesOutcomeIf: `the bag was mishandled before ${p.bagFeeComplianceDate} (the rule does not apply to earlier events)`,
    });
    passages.push("FR-2024-07177-COMPLIANCE");
  }
  // The gate's own leaf lists a candidate date as unconfirmed (it is the date the gate would use once confirmed).
  const gateCandidate = [incidentCell, deplane].find((c) => c.status === "candidate");
  leaves.push(leaf("gate", "r04.a.compliance_date", "The bag was mishandled on or after the rule's compliance date", "timing", "pass",
    gateCandidate && gateDates === null ? [gateCandidate] : [], { passage: "FR-2024-07177-COMPLIANCE" }));

  // Scope: a covered flight (part 260). `unsupported` only from a KNOWN scope.
  const scope = v.lookup.get(TXN, K.scope);
  const scopeCode = code(scope);
  if (scopeCode === "non_us" && scope.known) flags.unsupportedReason = "Not a covered flight: no point in the United States (14 CFR 260.2).";
  leaves.push(leaf("scope", "r04.a.covered_flight", "A covered flight: to, from or within the United States", "applicability",
    scopeCode === null ? "unknown" : scopeCode === "non_us" ? "fail" : "pass", scopeCode === null ? [] : [scope], { unknown: [scope], passage: "P-260.2-SDB" }));

  // Mishandled Baggage Report (P-260.5-B): unknown → ask; confirmed "not filed" → not yet due (D147(6), D154).
  const mbr = bag(K.mbrFiled);
  const mbrValue = bool(mbr);
  const mbrRef = bag(K.mbrRef);
  const mbrText = "A Mishandled Baggage Report was filed with the airline";
  if (mbr.status === "conflicting") {
    // M27 R04-16: a conflict is settled by D152, never by a reference that happens to exist.
    leaves.push(leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "unknown", [], { unknown: [mbr], passage: "P-260.5-B" }));
  } else if (mbrValue === true) {
    leaves.push(leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "pass", [mbr], { passage: "P-260.5-B" }));
  } else if (mbrValue === false && mbr.known) {
    flags.notYetDue = { when: "MBR filed", userAction: { kind: "add_evidence", docTypes: ["baggage_report"] } };
    leaves.push(leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "pass", [mbr], { note: "not filed yet: the refund is owed once the report is filed", passage: "P-260.5-B" }));
    explanation.push("File a Mishandled Baggage Report with the airline, then add it here: the bag-fee refund is owed only after that report is filed (260.5(b)).");
  } else if (mbrValue === false) {
    // An unconfirmed "not filed" is asked (not_yet_due only from KNOWN facts).
    const l = leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "unknown", [], { passage: "P-260.5-B" });
    l.unknownFacts = [{ fact: ref(mbr), reason: "candidate_unconfirmed" }];
    leaves.push(l);
  } else if (usable(mbrAt) || usable(mbrRef)) {
    // A report date or reference is evidence that the report exists.
    const basis = [mbrAt, mbrRef].find((c) => c.known) ?? (usable(mbrAt) ? mbrAt : mbrRef);
    leaves.push(leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "pass", [basis], { note: "a report date or reference shows it was filed", passage: "P-260.5-B" }));
  } else {
    leaves.push(leaf("mbr", "r04.a.mbr_filed", mbrText, "requirement", "unknown", [], { unknown: [mbr], passage: "P-260.5-B" }));
  }

  // Exemptions (P-260.5-F): carrier defences; unknown ones are assumed absent (an assumption, never a question);
  // conflicting ones follow D152 (M27 R04-16); a candidate `true` is asked, never failed on (R04-02).
  const status = bag(K.status);
  const statusCode = code(status);
  const recheck = bag(K.exRecheck);
  const pickup = bag(K.exPickup);
  const voluntary = bag(K.exVoluntary);
  const documented = bag(K.exDocumented);
  const exText = "No refund exemption applies (260.5(f))";
  const conflictingEx = [recheck, pickup, voluntary, documented].filter((c) => c.status === "conflicting");
  const f1 = bool(recheck) === true;
  const f2 = bool(pickup) === true && bool(documented) === true;
  const f3 = bool(voluntary) === true && statusCode !== "declared_lost"; // (f)(3) never reaches a lost bag (260.5(g))
  if (conflictingEx.length > 0) {
    leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "unknown", [], { unknown: conflictingEx, passage: "P-260.5-F" }));
  } else if (f1 || f2 || f3) {
    // Spec §15 step 2.3 (errata E-R04-2, ERR-R1-01; D253(2)): the bag's state decides what an exemption does.
    const exCells = f1 ? [recheck] : f2 ? [pickup, documented] : [voluntary];
    const which = f1
      ? "the bag was not rechecked at the first US entry point (260.5(f)(1))"
      : f2 ? "the airline documented that the bag was left uncollected (260.5(f)(2))" : "you agreed to travel without the bag (260.5(f)(3))";
    const deliveredAt = instant(delivered);
    const unconfirmedOf = (cells: readonly Cell[]) => cells.filter((c) => !c.known);
    const asking = (cells: readonly Cell[], note: string) => {
      const l = leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "unknown", [], { note, passage: "P-260.5-F" });
      l.unknownFacts = cells.map((c) => ({ fact: ref(c), reason: c.status === "candidate" ? "candidate_unconfirmed" as const : unresolvedReason(c) }));
      return l;
    };
    if (deliveredAt !== null || statusCode === "delivered" || statusCode === "damaged" || statusCode === "pilfered") {
      // A delivered bag: the exemption applies (R04-07). A fail on a candidate is asked (leaf guard, D234 (1)).
      leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "fail",
        [...exCells, ...(deliveredAt !== null ? [delivered] : [status])], { note: which, passage: "P-260.5-F" }));
    } else if (statusCode === "declared_lost") {
      // (f)(1)/(f)(2) and a lost bag: the captured text does not settle it (L11) → a person reviews it (R04-15/15b).
      const open = unconfirmedOf([...exCells, status]);
      if (open.length > 0) {
        leaves.push(asking(open, "confirm these first: whether the exemption reaches a lost bag is a review"));
      } else {
        flags.manualReviewReason ??= `The airline declared the bag lost, and ${which}. 260.5(f) exempts "the fee for a significantly delayed bag" where "the delay resulted from" the passenger's action. Part 260 names lost and significantly delayed bags separately, but its definition of a significantly delayed bag ("not delivered ... within 12 hours") also fits a lost bag, so the captured text does not settle whether the exemption reaches a lost bag (L11). A person reviews it.`;
        leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "pass", [...exCells, status], { note: "a lost bag: whether the exemption reaches it is a review (L11)", passage: "P-260.5-F" }));
      }
    } else if (statusCode === "delayed_undelivered") {
      // Still undelivered: a delivery makes the exemption apply, a loss declaration keeps the refund (260.5(g)) or is a
      // review (L11) — not yet due (R04-15e/f). An extracted status is asked (R04-15g).
      const open = unconfirmedOf([...exCells, status]);
      if (open.length > 0) {
        leaves.push(asking(open, "confirm the bag's status: still undelivered, delivered or declared lost decide this"));
      } else {
        flags.notYetDue ??= { when: R04_AWAIT_BAG };
        leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "unknown", [...exCells, status], { note: `${which}; the bag is still undelivered, so this waits for its delivery or a loss declaration`, passage: "P-260.5-F" }));
      }
    } else {
      // Status unknown and no delivery time: the status decides (the delivery time is not asked; R04-15d, R04-09).
      leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "unknown", exCells, { unknown: [status], note: `${which}; whether it applies depends on whether the bag was delivered, is still missing or was declared lost`, passage: "P-260.5-F" }));
    }
  } else if (bool(pickup) === true && bool(documented) === null) {
    leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "unknown", [pickup], { unknown: [documented], passage: "P-260.5-F" }));
  } else {
    const facts = [recheck, pickup, voluntary].filter(usable);
    if (bool(pickup) === true) facts.push(documented);
    if (bool(voluntary) === true) facts.push(status);
    const unknownAny = [recheck, pickup, voluntary].some((c) => !usable(c));
    if (unknownAny) assumptions.push(NO_EXEMPTION_ASSUMPTION);
    leaves.push(leaf("exemption", "r04.a.no_exemption", exText, "exclusion", "pass", facts, { note: unknownAny ? "assumed: the airline has recorded no exemption" : "no exemption applies", passage: "P-260.5-F" }));
  }

  // Significant delay (P-260.2-SDB, P-260.5-A) or a lost bag. A bag not yet delivered is asked — never extrapolated to
  // the clock (D234 (10); M27 R04-01).
  const sigText = "The bag was lost, or significantly delayed";
  if (statusCode === "declared_lost") {
    leaves.push(leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", "pass", [status], { note: "declared lost: no delay calculation is needed", passage: "P-260.5-D" }));
  } else {
    const a = instant(deplane);
    const b = instant(delivered);
    const t = thresholds(v, p);
    if (a !== null && b !== null && b >= a) {
      const verdict = lateVerdict(b - a, t.hours);
      const within = verdict === "fail";
      const note = `delivered ${hm(b - a)} after the chance to deplane; ${within ? "within" : "over"} the ${t.hours.join(" / ")}-hour limit (exactly the limit is within it, A1)`;
      leaves.push(verdict === "unknown"
        ? leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", "unknown", [deplane, delivered, ...t.used], { unknown: t.unknown, note, passage: "P-260.2-SDB" })
        : leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", verdict, [deplane, delivered, ...t.used], { note, passage: "P-260.2-SDB" }));
      explanation.push(`The bag was delivered ${hm(b - a)} after you could leave the plane: ${within ? "within" : "more than"} ${t.hours.join(" or ")} hours.`);
    } else if (a !== null && b !== null) {
      // M27 R04-19: a delivery before the deplane opportunity is a data error → asked, never not_eligible.
      leaves.push(leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", "unknown", [], { unknown: [delivered], note: "the delivery time is before the deplane time; check both", passage: "P-260.5-A" }));
      (leaves[leaves.length - 1] as ComputedCondition).unknownFacts = [{ fact: ref(delivered), reason: "missing" }];
    } else if (flags.notYetDue?.when === R04_AWAIT_BAG) {
      // Waiting for the bag's delivery or a loss declaration (above): the delivery time is not asked meanwhile.
      leaves.push(leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", "unknown", [], { note: "the bag is still undelivered", passage: "P-260.5-A" }));
    } else {
      leaves.push(leaf("delay", "r04.a.lost_or_delayed", sigText, "requirement", "unknown", [], { unknown: [deplane, delivered].filter((c) => !usable(c)), passage: "P-260.5-A" }));
    }
  }

  // The fee (P-260.5-E); unknown → likely_eligible (spec §15.2.5), a 0 fee → nothing to refund.
  const fee = bag(K.fee);
  const feeMoney = money(fee);
  let amount: AmountCalc | null = null;
  if (feeMoney === null) {
    optionalFacts.push(optional(fee, "amount"));
    leaves.push(leaf("fee", "r04.a.fee_paid", "A fee was paid to check this bag", "requirement", fee.status === "conflicting" ? "unknown" : "pass", [], { unknown: [fee], note: "fee not known yet" }));
  } else {
    if (currencyExponent(feeMoney.currency, "new_scenario") === null && fee.known) flags.unsupportedReason ??= `Recoup's air checks handle USD amounts only; ${feeMoney.currency} is not supported yet (O6).`;
    leaves.push(leaf("fee", "r04.a.fee_paid", "A fee was paid to check this bag", "requirement", feeMoney.amountMinor > 0 ? "pass" : "fail", [fee], { note: feeMoney.amountMinor > 0 ? undefined : "no fee was paid for this bag", passage: "P-260.5-E" }));
    if (feeMoney.amountMinor > 0) {
      amount = {
        estimate: feeMoney,
        basis: "exact_formula",
        formula: "refund >= fee paid for that bag (260.5(e))",
        inputs: [{ label: "bag fee paid", value: String(feeMoney.amountMinor), fact: ref(fee) }],
      };
      passages.push("P-260.5-E");
    } else {
      explanation.push("No fee was paid for this bag, so there is no bag fee to refund.");
    }
  }

  const airline = text(v.lookup.get(TXN, K.operatingLast));
  explanation.push(`260.5 requires a prompt, automatic refund once the report is filed but defines no day count for bag fees, so Recoup computes no date (L6). If it does not arrive, ask the airline${airline ? ` (${airline})` : ""}, even when a travel agency charged the fee (DOT-REF-8).`);
  passages.push("DOT-REF-8");

  return finishTree(leaves, flags, {
    optional: optionalFacts, amountConflicts: [], assumptions, amount,
    lossKeys: [`txn:${v.transactionId}:bag_fee:${v.bagLossId}`], explanation, passages,
  });
}

// ---------------------------------------------------------------------------
// Paths b and c — carrier liability (14 CFR 254.4), capped in v1
// ---------------------------------------------------------------------------

function liabilityCommon(v: R04View, path: "b" | "c", flags: Flags, leaves: ConditionNode[], assumptions: Assumption[], optionalFacts: MissingFact[]): void {
  const scope = v.lookup.get(TXN, K.scope);
  const scopeCode = code(scope);
  if ((scopeCode === "international" || scopeCode === "non_us") && scope.known) {
    flags.unsupportedReason = "International baggage claims fall under the Montreal Convention (about 1,519 SDR per passenger, DOT-BAG-4), not 14 CFR 254; R04 v1 does not evaluate them (L8).";
  }
  leaves.push(leaf("scope", `r04.${path}.domestic`, "A domestic (US interstate or intrastate) itinerary (254.2)", "applicability",
    scopeCode === null ? "unknown" : scopeCode === "domestic" ? "pass" : "fail", scopeCode === null ? [] : [scope], { unknown: [scope], passage: "P-254.2" }));

  const large = v.lookup.get(TXN, K.largeAircraft);
  const largeValue = bool(large);
  if (large.status === "conflicting") {
    // M27 R04-16: a conflict is D152's, not an assumption.
    leaves.push(leaf("scope", `r04.${path}.large_aircraft`, "A flight on the ticket uses an aircraft with more than 60 seats (254.3/254.4)", "applicability", "unknown", [], { unknown: [large], passage: "P-254.3" }));
  } else if (largeValue === false && large.known) {
    flags.manualReviewReason ??= "No flight on the ticket used a plane with more than 60 seats, so the 14 CFR 254.4 floor on the airline's limit does not apply (254.3, L3). A person reviews it.";
  } else if (largeValue === false) {
    const l = leaf("scope", `r04.${path}.large_aircraft`, "A flight on the ticket uses an aircraft with more than 60 seats (254.3/254.4)", "applicability", "unknown", [], { passage: "P-254.3" });
    l.unknownFacts = [{ fact: ref(large), reason: "candidate_unconfirmed" }];
    leaves.push(l);
  } else if (largeValue === true) {
    leaves.push(leaf("scope", `r04.${path}.large_aircraft`, "A flight on the ticket uses an aircraft with more than 60 seats (254.3/254.4)", "applicability", "pass", [large], { passage: "P-254.3" }));
  } else {
    assumptions.push(LARGE_AIRCRAFT_ASSUMPTION);
  }
  assumptions.push(CONTRACT_ASSUMPTION);
  const deadline = v.lookup.get(TXN, K.carrierDeadline);
  if (!usable(deadline)) optionalFacts.push(optional(deadline, "timeliness"));
}

/**
 * One bag's path-b delay test (D234 (9); D253(1); spec §15 step 3): still missing / declared lost; a confirmed delivery
 * later than 12 h (A5; path a's threshold, D235 (D)); or a confirmed Mishandled Baggage Report on a bag whose status
 * says it is undamaged (a damaged or pilfered bag is path c; an unknown status is asked, R04-14f). A carousel pickup
 * alone is not a delay; a confirmed "no report" with a short span fails.
 */
function bagDelayedLeaf(v: R04View, p: R04Params, bagSubjectKey: string): ComputedCondition {
  const bag = bagReader(v, bagSubjectKey);
  const status = bag(K.status);
  const statusCode = code(status);
  const deplane = bag(K.deplane);
  const delivered = bag(K.delivered);
  const mbr = bag(K.mbrFiled);
  const mbrValue = bool(mbr);
  const id = `r04.b.delayed${bagSubjectKey === TXN ? "" : `.${bagSubjectKey}`}`;
  const text = "The bag did not arrive with you";
  const damaged = statusCode === "damaged" || statusCode === "pilfered";
  if (statusCode === "delayed_undelivered" || statusCode === "declared_lost") {
    return leaf("delay", id, text, "requirement", "pass", [status], { note: "the bag did not arrive" });
  }
  // D253(1): a confirmed report meets the condition on an UNDAMAGED bag — the status must say so (R04-14e/14f).
  const mbrPasses = mbrValue === true && statusCode !== null && !damaged;
  const mbrOnUnknownStatus = mbrValue === true && statusCode === null;
  const a = instant(deplane);
  const b = instant(delivered);
  if (a !== null && b !== null) {
    const span = b - a;
    if (span < 0) {
      const l = leaf("delay", id, text, "requirement", "unknown", [], { note: "the delivery time is before the deplane time; check both" });
      l.unknownFacts = [{ fact: ref(delivered), reason: "missing" }];
      return l;
    }
    if (span === 0) return leaf("delay", id, text, "requirement", "fail", [deplane, delivered], { note: "delivered at the deplane time: no delay" });
    const t = thresholds(v, p);
    const late = lateVerdict(span, t.hours);
    const note = `delivered ${hm(span)} after the chance to deplane`;
    if (late === "pass") return leaf("delay", id, text, "requirement", "pass", [deplane, delivered, ...t.used], { note: `${note}: a late delivery (over ${t.hours.join(" / ")} h)` });
    if (mbrPasses) return leaf("delay", id, text, "requirement", "pass", [mbr, status], { note: `${note}, with a Mishandled Baggage Report` });
    if (late === "fail") {
      if (damaged) return leaf("delay", id, text, "requirement", "fail", [status, deplane, delivered, ...t.used], { note: `${note}: a damaged or pilfered bag delivered on time is a property claim (path c)` });
      if (mbrValue === false) return leaf("delay", id, text, "requirement", "fail", [mbr, deplane, delivered, ...t.used], { note: `${note}, and no Mishandled Baggage Report: a normal pickup is not a delay` });
      if (mbrOnUnknownStatus) return leaf("delay", id, text, "requirement", "unknown", [mbr], { unknown: [status], note: `${note}, with a report: was the bag damaged (a property claim, path c) or just delayed?` });
      return leaf("delay", id, text, "requirement", "unknown", [], { unknown: [mbr], note: `${note}: did the bag arrive on your flight? A Mishandled Baggage Report records that it did not` });
    }
    return leaf("delay", id, text, "requirement", "unknown", [], { unknown: [...t.unknown, mbrOnUnknownStatus ? status : mbr].filter((c) => !usable(c)), note });
  }
  if (mbrPasses) return leaf("delay", id, text, "requirement", "pass", [mbr, status], { note: "a Mishandled Baggage Report was filed" });
  return leaf("delay", id, text, "requirement", "unknown", [], { unknown: [deplane, delivered, mbrOnUnknownStatus ? status : mbr].filter((c) => !usable(c)) });
}

/** The trip's A2 window for expense lines: from the deplane day through the latest delivery day (open while undelivered). */
function expenseWindow(v: R04View): { from: string | null; to: string | null } {
  const bags = v.bags.length > 0 ? v.bags.map((b) => b.subjectKey) : [v.bagSubjectKey];
  let from: string | null = null;
  let to: string | null = null;
  let open = false;
  for (const s of bags) {
    const bag = bagReader(v, s);
    const a = instant(bag(K.deplane));
    const statusCode = code(bag(K.status));
    const b = instant(bag(K.delivered));
    if (a !== null) {
      const d = usDates(a).sort()[0];
      if (from === null || d < from) from = d;
    }
    if (statusCode === "delayed_undelivered" || statusCode === "declared_lost" || b === null) open = true;
    else {
      const d = usDates(b).sort().reverse()[0];
      if (to === null || d > to) to = d;
    }
  }
  return { from, to: open ? null : to };
}

function coreB(v: R04View, env: Env): Core {
  const { p } = env;
  const bag = bagReader(v, v.bagSubjectKey);
  const flags: Flags = emptyFlags();
  if (env.stale) flags.sourceStale = true;
  const explanation: string[] = [];
  const passages: string[] = ["P-254.4", "DOT-BAG-1", "DOT-BAG-2"];
  const assumptions: Assumption[] = [];
  const optionalFacts: MissingFact[] = [];
  const leaves: ConditionNode[] = [];
  liabilityCommon(v, "b", flags, leaves, assumptions, optionalFacts);

  // Delayed: ANY bag of the trip qualifies (M27 R04-04; the expense lines are trip-level).
  const bags = v.bags.length > 0 ? v.bags.map((b) => b.subjectKey) : [v.bagSubjectKey];
  leaves.push({ op: "any", children: bags.map((s) => bagDelayedLeaf(v, p, s)) });

  // Expense lines: documented (an evidence receipt), in the A2 window, unallocated, not the bag fee.
  const extraUnconfirmed: MissingFact[] = [];
  const amountConflicts: Cell[] = [];
  const included: { n: number; money: Money; cells: Cell[] }[] = [];
  const excluded: string[] = [];
  if (v.expenseLines.length > R04_MAX_EXPENSE_LINES) {
    flags.manualReviewReason ??= `More than ${R04_MAX_EXPENSE_LINES} expense lines on one trip: a person prepares this claim.`;
  }
  const window = expenseWindow(v);
  const bagFees = bags.map((s) => money(bagReader(v, s)(K.fee))).filter((m): m is Money => m !== null && m.amountMinor > 0);
  for (const n of v.expenseLines.slice(0, R04_MAX_EXPENSE_LINES)) {
    const s = lineSubject(n);
    const amountCell = v.lookup.get(s, K.expAmount);
    const dateCell = v.lookup.get(s, K.expDate);
    const receipt = v.lookup.get(s, K.expReceipt);
    const allocated = v.lookup.get(s, K.expAllocated);
    const conflicts = [amountCell, dateCell, receipt, allocated].filter((c) => c.status === "conflicting");
    if (conflicts.length > 0) {
      amountConflicts.push(...conflicts);
      continue;
    }
    // M27 R04-12: only a KNOWN allocation that names a remedy excludes the line.
    const allocatedTo = text(allocated);
    const namesRemedy = allocatedTo !== null && R04_ALLOCATION_REF.test(allocatedTo);
    if (namesRemedy && allocated.known) {
      excluded.push(`line ${n} (already allocated to ${allocatedTo})`);
      continue;
    }
    const m = money(amountCell);
    if (m === null) {
      optionalFacts.push(optional(amountCell, "amount"));
      excluded.push(`line ${n} (no amount)`);
      continue;
    }
    if (currencyExponent(m.currency, "new_scenario") === null) {
      // M27 R04-22: one non-USD line is set aside, never the whole path.
      excluded.push(`line ${n} (${m.currency}: Recoup handles USD amounts only for now)`);
      continue;
    }
    const receiptRef = text(receipt);
    if (receiptRef === null || !R04_RECEIPT_REF.test(receiptRef)) {
      // M27 R04-11: only an attached receipt (an evidence reference) documents a line.
      optionalFacts.push({ ...optional(receipt, "amount"), reason: "missing" });
      excluded.push(`line ${n} (${formatMinor(m.amountMinor, m.currency)}, no receipt attached)`);
      continue;
    }
    // M27 R04-10 (spec A2): a line counts only if dated from the deplane day through the delivery day.
    const date = localDate(dateCell);
    if (date === null) {
      optionalFacts.push(optional(dateCell, "amount"));
      excluded.push(`line ${n} (${formatMinor(m.amountMinor, m.currency)}, no date)`);
      continue;
    }
    if ((window.from !== null && date < window.from) || (window.to !== null && date > window.to)) {
      excluded.push(`line ${n} (${formatMinor(m.amountMinor, m.currency)}, dated ${date}, outside the delay from ${window.from ?? "?"} to ${window.to ?? "delivery"})`);
      continue;
    }
    // M27 R04-13 / D234 (17): a line equal to a bag fee is set aside until the user says it is not the bag fee.
    if (bagFees.some((f) => f.currency === m.currency && f.amountMinor === m.amountMinor) && !(allocated.known && allocatedTo !== null && !namesRemedy)) {
      optionalFacts.push(optional(allocated, "bag fee"));
      excluded.push(`line ${n} (${formatMinor(m.amountMinor, m.currency)} equals the checked-bag fee, which is refunded separately; confirm it is a different expense)`);
      continue;
    }
    for (const c of [amountCell, dateCell, receipt, ...(namesRemedy ? [allocated] : [])]) {
      if (c.status === "candidate") extraUnconfirmed.push({ subjectKey: c.subjectKey, key: c.key, reason: "candidate_unconfirmed", class: "required", neededFor: ["amount"] });
    }
    included.push({ n, money: m, cells: [amountCell, dateCell, receipt] });
  }
  // D234 (13): a reimbursement not tied to lines caps the result with an assumption and asks which lines it covered.
  const reimbursement = money(v.lookup.get(TXN, K.reimbursement));
  if (reimbursement !== null && reimbursement.amountMinor > 0) {
    assumptions.push({
      id: R04_REIMBURSEMENT_ASSUMPTION_ID,
      text: `You received ${formatMinor(reimbursement.amountMinor, reimbursement.currency)} that is not tied to specific expenses; Recoup assumes it covered none of the lines below until you say which it covered.`,
      changesOutcomeIf: "that payment covered some of these expenses (they are not claimed twice)",
    });
    for (const l of included) optionalFacts.push(optional(v.lookup.get(lineSubject(l.n), K.expAllocated), "reimbursement"));
  }
  const display = flags.unsupportedReason ? null : liabilityDisplay(v, p, bag);
  passages.push(...(display?.passages ?? []));
  let amount: AmountCalc | null = null;
  const currencies = new Set(included.map((l) => l.money.currency));
  if (included.length > 0 && currencies.size === 1) {
    const currency = [...currencies][0];
    const total = included.reduce((a, l) => a + l.money.amountMinor, 0);
    amount = {
      estimate: { amountMinor: total, currency },
      basis: "documented_total",
      formula: `sum of documented, unallocated lines: ${included.map((l) => `line ${l.n}`).join(" + ")}`,
      inputs: [
        ...included.slice(0, 10).map((l) => ({ label: `line ${l.n}`, value: String(l.money.amountMinor), fact: ref(l.cells[0]) })),
        ...(included.length > 10 ? [{ label: `${included.length - 10} more lines`, value: String(included.slice(10).reduce((a, l) => a + l.money.amountMinor, 0)) }] : []),
        ...(excluded.length > 0 ? [{ label: "excluded", value: excluded.join("; ").slice(0, 300) }] : []),
      ].slice(0, 12),
      // M27 R04-08: only the airline's own captured limit is a cap; the federal floor is never one.
      ...(display?.carrierCap && display.carrierCap.currency === currency ? { cap: { amount: display.carrierCap, sourcePassageId: "P-254.4", note: display.line } } : {}),
    };
    if (display?.carrierCap && display.carrierCap.currency === currency && total > display.carrierCap.amountMinor) {
      explanation.push(`The documented total is above the airline's stated liability limit (${dollars(display.carrierCap)}); the airline may pay no more than its limit.`);
    }
  } else if (currencies.size > 1) {
    explanation.push("The receipts are in different currencies; Recoup never adds different currencies, so a person works out the total.");
  }
  if (excluded.length > 0) explanation.push(`Not in the estimate: ${excluded.join("; ")}.`);
  if (display) explanation.push(display.line);
  explanation.push("Reimbursement is for reasonable, verifiable and actual expenses (DOT-BAG-1); the airline may not impose an arbitrary daily cap (DOT-BAG-2). Recoup counts only documented amounts.");

  return finishTree(leaves, flags, {
    optional: optionalFacts, amountConflicts, assumptions, amount,
    lossKeys: included.map((l) => `txn:${v.transactionId}:exp:${l.n}`), explanation, passages,
    ...(included.length === 0 ? { nextActionHint: { kind: "add_evidence", docTypes: ["expense_receipt"] } as NextAction } : {}),
  }, extraUnconfirmed);
}

function coreC(v: R04View, env: Env): Core {
  const { p } = env;
  const bag = bagReader(v, v.bagSubjectKey);
  const flags: Flags = emptyFlags();
  if (env.stale) flags.sourceStale = true;
  const explanation: string[] = [];
  const passages: string[] = ["P-254.4", "DOT-BAG-6", "DOT-BAG-7"];
  const assumptions: Assumption[] = [];
  const optionalFacts: MissingFact[] = [];
  const leaves: ConditionNode[] = [];
  liabilityCommon(v, "c", flags, leaves, assumptions, optionalFacts);

  // The carrier declared the bag lost, or it arrived damaged or pilfered; no declaration yet → ask (spec §15.4).
  const status = bag(K.status);
  const statusCode = code(status);
  const statusText = "The airline declared the bag lost, or it arrived damaged or with items missing";
  if (statusCode === "declared_lost" || statusCode === "damaged" || statusCode === "pilfered") {
    leaves.push(leaf("status", "r04.c.lost_or_damaged", statusText, "requirement", "pass", [status], { passage: "P-254.4" }));
  } else if (statusCode === "delivered") {
    leaves.push(leaf("status", "r04.c.lost_or_damaged", statusText, "requirement", "fail", [status], { note: "delivered, with no loss or damage recorded" }));
  } else {
    leaves.push(leaf("status", "r04.c.lost_or_damaged", statusText, "requirement", "unknown", [], { unknown: [status], note: statusCode === "delayed_undelivered" ? "still missing: has the airline declared it lost yet?" : undefined }));
  }

  for (const key of [K.carrierLimit, K.carrierExclusions] as const) {
    const c = v.lookup.get(TXN, key);
    if (!usable(c)) optionalFacts.push(optional(c, "valuation"));
  }
  if (v.propertyItems.length > R04_MAX_PROPERTY_ITEMS) {
    flags.manualReviewReason ??= `More than ${R04_MAX_PROPERTY_ITEMS} items on one bag: a person prepares this claim.`;
  }
  const values: string[] = [];
  for (const n of v.propertyItems.slice(0, R04_MAX_PROPERTY_ITEMS)) {
    const s = lineSubject(n);
    const proof = v.lookup.get(s, K.propProof);
    if (text(proof) === null) optionalFacts.push(optional(proof, "evidence"));
    const item = text(v.lookup.get(s, K.propItem)) ?? `item ${n}`;
    const m = money(v.lookup.get(s, K.propValue));
    if (m) values.push(`${item} ${formatMinor(m.amountMinor, m.currency)}`);
  }
  const display = flags.unsupportedReason ? null : liabilityDisplay(v, p, bag);
  passages.push(...(display?.passages ?? []));
  explanation.push("No estimate: the airline applies depreciation, its contract's exclusions and its limit, none of which Recoup has captured yet.");
  if (values.length > 0) explanation.push(`Documented values (evidence for the claim, not the payout): ${values.join("; ")}.`);
  if (display) explanation.push(display.line);

  return finishTree(leaves, flags, {
    optional: optionalFacts, amountConflicts: [], assumptions, amount: null,
    lossKeys: [`txn:${v.transactionId}:property:${v.bagLossId}`], explanation, passages,
  });
}

function core(v: R04View, env: Env): Core {
  return env.path === "a" ? coreA(v, env) : env.path === "b" ? coreB(v, env) : coreC(v, env);
}

// ---------------------------------------------------------------------------
// Evaluation: conflicts (D152/D154/D158), outcome, projection
// ---------------------------------------------------------------------------

const AMOUNT_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit"]);

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

function sourceRefsFor(path: R04Path, passages: readonly string[]): SourceRef[] {
  const out: SourceRef[] = [];
  const seen = new Set<string>();
  for (const id of passages) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = R04_SOURCES[path].find((x) => x.passageId === id);
    if (s) out.push({ sourceId: s.sourceId, passageId: s.passageId, url: s.url, effective: s.effective });
  }
  return out.slice(0, 8);
}

function nextActionFor(path: R04Path, outcome: Outcome, c: Core, flags: Flags, missing: readonly MissingFact[], manualReason: string | undefined): NextAction {
  switch (outcome) {
    case "eligible":
    case "likely_eligible":
    case "possible_contract_benefit":
      // a: automatic after the MBR (track_automatic, DA-A-25); b/c: a claim with the airline under its contract.
      return path === "a" ? { kind: "track" } : c.nextActionHint ?? { kind: "open_case" };
    case "needs_facts": {
      // M27 R04-18: an unconfirmed value is a question too (confirm it).
      const keys = missing.filter((m) => m.reason !== "conflict_capped").map((m) => ({ subjectKey: m.subjectKey, key: m.key }));
      return keys.length > 0 ? { kind: "answer_questions", keys } : { kind: "none", reason: "Waiting for the facts above." };
    }
    case "manual_review":
      return { kind: "manual_review", reason: manualReason ?? flags.manualReviewReason ?? "A person reviews this case." };
    case "not_yet_due":
      // D154: the awaited event is the user's own action (file the MBR) → that action is the next action.
      return flags.notYetDue?.userAction ?? { kind: "wait", reevaluate: { ...(flags.notYetDue?.at ? { at: flags.notYetDue.at } : {}), ...(flags.notYetDue?.when ? { when: flags.notYetDue.when } : {}) } };
    case "unsupported":
      return { kind: "none", reason: flags.unsupportedReason ?? "Not covered by R04 v1." };
    case "source_unverified":
      return {
        kind: "none",
        reason: flags.effectiveDateMismatch
          ? "This happened before the bag-fee refund rule's compliance date; Recoup v1 does not evaluate it."
          : "The DOT baggage rule text has not been re-verified recently; Recoup checks it again before giving a result.",
      };
    default: {
      // M27 R04-19: the reason is the condition that decided it.
      const deciding = c.conditions.find((x) => x.result === "fail" && x.kind !== "timing");
      return { kind: "none", reason: deciding ? `${deciding.label}: no${deciding.note ? ` — ${deciding.note}` : ""}.` : "Nothing is owed under this path on these facts." };
    }
  }
}

const OVERLAP: Readonly<Record<R04Path, readonly OverlapDecl[]>> = Object.freeze({
  // The fee and the expenses/property are distinct loss lines (spec §1: complementary); the fee is never an expense line.
  a: [
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.b, relation: "complementary" },
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.c, relation: "complementary" },
  ],
  // b and c share the per-passenger limit but are different losses; one expense line is allocated to one remedy only.
  b: [
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.a, relation: "complementary" },
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.c, relation: "distinct_lines" },
  ],
  c: [
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.a, relation: "complementary" },
    { withScenario: "R04", withRemedyKey: R04_REMEDY_KEYS.b, relation: "distinct_lines" },
  ],
});

export function evaluateR04V1(path: R04Path, input: EvaluationInput<R04View, R04Params>): EvaluationResult {
  const { snapshot: v, pack, now } = input;
  const env: Env = { path, p: pack.params, now, stale: sourceStale(pack.sources, input.verification, now).stale };
  const base = core(v, env);

  // Conflicts are tested only on decisive cells (plus conflicting expense cells, which change the amount).
  const seen = new Set<string>();
  const conflicting: Extract<Cell, { status: "conflicting" }>[] = [];
  const addConflict = (c: Cell) => {
    const id = `${c.subjectKey}\u0000${c.key}`;
    if (c.status === "conflicting" && !seen.has(id)) {
      seen.add(id);
      conflicting.push(c);
    }
  };
  for (const m of base.decisiveUnresolved) if (m.reason === "conflicting") addConflict(v.lookup.get(m.subjectKey, m.key));
  for (const c of base.amountConflicts) addConflict(c);

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
      manualReason = `A value you confirmed contradicts another source — ${parts.join("; ")}. Upload proof (for example the courier notification or a dated photo) or correct your confirmation.`;
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
        final = tested[0].core;
        flags = { ...final.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
        missing = final.missing.filter((m) => !ids.has(`${m.subjectKey}\u0000${m.key}`));
        unconfirmed = final.unconfirmed.filter((m) => !ids.has(`${m.subjectKey}\u0000${m.key}`));
        for (const c of conflicting) addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "conflict_capped", class: "required", neededFor: ["confirmation"] });
        extra.push(`Your documents disagree on ${conflicting.map((c) => c.key).join(", ")}, but every value gives the same answer and amount; confirm the right one to remove the cap.`);
      } else {
        flags = { ...base.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
        for (const c of conflicting) addMissing(missing, { subjectKey: c.subjectKey, key: c.key, reason: "conflicting", class: "required", neededFor: ["outcome"] });
        extra.push(`Your documents disagree and the answer depends on which is right: ${list.map((f) => `${f.key}: ${f.values.map((x) => `${x.value} (${x.source})`).join(" vs ")}`).join("; ")}. Do you have the delivery notice or a dated photo?`);
      }
    }
  }

  const outcome = deriveOutcome({ ...final.dims, readyForApproval: "unknown" }, flags, final.assumptions);
  const amount = AMOUNT_OUTCOMES.has(outcome) ? final.amount : null;
  const optionalRows = final.optional.filter((o) => !missing.some((m) => m.subjectKey === o.subjectKey && m.key === o.key));
  const missingFacts: MissingFact[] =
    outcome === "needs_facts" ? [...missing, ...unconfirmed]
      : outcome === "not_yet_due" ? [...missing, ...unconfirmed, ...optionalRows]
        : AMOUNT_OUTCOMES.has(outcome) ? [...unconfirmed, ...optionalRows]
          : [];
  const dimensions: Dimensions = { ...final.dims, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  const nextAction = nextActionFor(path, outcome, final, flags, missingFacts, manualReason);
  const lines = [
    ...extra,
    ...(outcome === "manual_review" && flags.manualReviewReason && !manualReason ? [flags.manualReviewReason] : []),
    ...(amount && path === "a" ? [`Bag-fee refund: at least ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)}, in the original form of payment (260.5(e), 260.10).`] : []),
    ...(amount && path === "b" ? [`Estimated reimbursement: ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)} (documented receipts only; the airline decides what is reasonable).`] : []),
    ...final.explanation,
    ...(AMOUNT_OUTCOMES.has(outcome) ? final.assumptions.map((a) => a.text) : []),
  ];

  return {
    scenarioId: "R04",
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
    assumptions: final.assumptions,
    disqualifierIds: final.disqualifierIds,
    amount,
    deadlines: [],
    sourceRefs: sourceRefsFor(path, final.passages),
    lossKeys: final.lossKeys,
    overlap: [...OVERLAP[path]],
    nextAction,
    explanation: [...new Set(lines)].slice(0, 12),
    flags,
    boundFacts: r04BoundFacts(v, path),
    ...(outcome === "not_yet_due" && flags.notYetDue
      ? { reevaluate: { ...(flags.notYetDue.at !== undefined ? { at: flags.notYetDue.at } : {}), ...(flags.notYetDue.when !== undefined ? { when: flags.notYetDue.when } : {}) } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The three packs
// ---------------------------------------------------------------------------

const REQUIREMENTS_A = [
  { subjectPattern: TXN, key: K.scope, class: "required" as const },
  { subjectPattern: "*", key: K.mbrFiled, class: "required" as const },
  { subjectPattern: "*", key: K.deplane, class: "required" as const },
  { subjectPattern: "*", key: K.delivered, class: "required" as const },
  { subjectPattern: "*", key: K.status, class: "required" as const },
  { subjectPattern: TXN, key: K.segment, class: "required" as const },
  { subjectPattern: "*", key: K.exDocumented, class: "required" as const },
  { subjectPattern: "*", key: K.fee, class: "assumption" as const, assumptionText: "the bag fee paid (unknown → likely eligible, spec §15.2.5)" },
  { subjectPattern: "*", key: K.incidentDate, class: "assumption" as const, assumptionText: "the bag was mishandled on or after the rule's compliance date" },
  { subjectPattern: "*", key: K.exRecheck, class: "assumption" as const, assumptionText: "no exemption applies unless the airline recorded one" },
  { subjectPattern: "*", key: K.exPickup, class: "assumption" as const, assumptionText: "no exemption applies unless the airline recorded one" },
  { subjectPattern: "*", key: K.exVoluntary, class: "assumption" as const, assumptionText: "no exemption applies unless the airline recorded one" },
];
const REQUIREMENTS_BC = [
  { subjectPattern: TXN, key: K.scope, class: "required" as const },
  { subjectPattern: "*", key: K.status, class: "required" as const },
  { subjectPattern: "*", key: K.deplane, class: "required" as const },
  { subjectPattern: "*", key: K.delivered, class: "required" as const },
  { subjectPattern: "*", key: K.mbrFiled, class: "required" as const },
  { subjectPattern: TXN, key: K.largeAircraft, class: "assumption" as const, assumptionText: "a flight on the ticket uses an aircraft with more than 60 seats" },
  { subjectPattern: TXN, key: K.carrierDeadline, class: "assumption" as const, assumptionText: "the airline's claim deadline (not captured in v1)" },
];

const LIMITS_COMMON = [
  "Paths a, b and c are separate opportunities; the bag fee is never an expense line (spec §1, §15.5); R02 shares each bag fee's loss key so a fee inside R02's ancillary total is never counted twice (D234 (17)).",
  "Bags (D234 (11)): one per incident holding a per-bag fact, plus txn; loss keys use the bag tag, else the incident id; only the deplane time and incident date are inherited from txn.",
  "USD amounts only (O6); amounts in different currencies are never added.",
];

function makePack(path: R04Path): RulePack<R04View, R04Params, CaseContext> {
  const a = path === "a";
  return {
    ruleId: R04_V1_RULE_ID,
    scenarioId: "R04",
    version: R04_V1_VERSION,
    // Informative only: the lead's activation entry + the manifest decide status.
    lifecycle: "researched",
    authority: a
      ? { class: "legal_entitlement", subtype: "federal regulation (14 CFR 260.2, 260.5, 260.10): bag-fee refund duty" }
      : { class: "merchant_promise", subtype: "carrier liability under its contract of carriage; 14 CFR 254.4 sets the minimum limit a carrier may impose; DOT guidance (DOT-BAG-1/2/6/7), not a regulation granting reimbursement" },
    jurisdiction: a ? "US: covered flights to, from or within the United States (14 CFR 260.2)" : "US domestic (interstate or intrastate) air transportation (14 CFR 254.2)",
    categories: ["air_travel"],
    remedyKey: R04_REMEDY_KEYS[path],
    remedyType: a ? "fee_refund" : "reimbursement",
    cashClass: "cash",
    params: R04_V1_PARAMS,
    sources: R04_SOURCES[path],
    requirements: a ? REQUIREMENTS_A : REQUIREMENTS_BC,
    fixturesPath: "docs/rules/fixtures/R04.json",
    lateAskDeadlineIds: [],
    overlap: OVERLAP[path],
    adapter: R04_ADAPTERS[path],
    // DA-A-25 (contract §6): the bag-fee refund is automatic after the report → tracked; b/c are claims.
    caseMode: () => (a ? "track_automatic" : "request"),
    knownLimitations: a
      ? [
          ...LIMITS_COMMON,
          "L6: 260.5 requires a prompt refund but no day count for bag fees; no carrier timer is computed.",
          "A1: delivery at exactly the threshold is 'within' it (not significant).",
          "D234 (10): a bag not yet delivered is asked for its delivery time or the airline's lost declaration; the delay is never extrapolated to the clock (a v2 spec item).",
          "260.5(c)/(d) multi-carrier notification is not modelled; the MBR with the last operating carrier is taken as sufficient.",
          "L9: DOT-REF-8 (request from the airline) and 260.5(d) (automatic) are both preserved: the refund is tracked, the airline is named.",
          "L11 (erratum E-R04-2, D253(2)): with an (f)(1) or documented (f)(2) exemption, a declared-lost bag is a manual review (the captured text does not settle whether the exemption reaches a lost bag); a bag confirmed still undelivered is not yet due (re-evaluated when it is delivered or declared lost); a delivered bag is not eligible. (f)(3) never reaches a lost bag (260.5(g)).",
          "L13 (errata ERR-R1-07): path a has no service-type input yet, so a bag on a charter or other non-scheduled flight is evaluated as if the flight were scheduled (a follow-up spec item).",
        ]
      : [
          ...LIMITS_COMMON,
          "D143(4)/D147(1): capped at likely_eligible while no carrier contract of carriage is captured; carrier claim deadlines are an assumption, not an outcome (D234 (19)).",
          "L1: the 254.4 figure is the minimum carrier limit, never a payout or a cap; versioned by incident date (A3), with the 2026 biennial review pending (L5). Only a captured carrier limit is shown as a cap.",
          "L3: a ticket with no aircraft over 60 seats is manual_review.",
          "L8: international itineraries are unsupported (Montreal/Warsaw).",
          path === "b"
            ? "Path b (D234 (9), D253(1), A5/L12): delayed = still missing or lost, a confirmed delivery later than 12 hours, or a confirmed MBR on a bag whose status says it is undamaged (damaged or pilfered → path c); only receipted (evidence), dated (spec A2) and unallocated lines count; reasonableness is the airline's call (L2). Lines are trip-level, so path b runs once per trip. A reimbursement not tied to lines is an assumption until allocated (D234 (13))."
            : "No estimate: depreciation, exclusions and the carrier's limit decide the payout; documented values are evidence only. The remedy may be a repair (non-cash) rather than money (M27 R04-21).",
        ],
    evaluate: (input) => evaluateR04V1(path, input),
  };
}

/**
 * D208 PackAdapters (M20's `RulePack.adapter`): live fact rows of one air transaction → runs. No bag fact → no run
 * (M27 R04-15). Paths a and c: one run per bag (subject = the bag's incident, or `txn`). Path b: one run per trip, on
 * the first bag, testing every bag's delay (its expense lines are trip-level). Pure.
 */
function r04Adapter(path: R04Path) {
  return Object.freeze({
    runs(input: AirSnapshotInput): { subjectKey: string; snapshot: R04View; lookup: FactLookup }[] {
      const s = buildAirSnapshot(input);
      const bags = r04Bags(s);
      return (path === "b" ? bags.slice(0, 1) : bags).map((bag) => ({ subjectKey: bag.subjectKey, snapshot: r04View(s, bag.subjectKey), lookup: s.lookup }));
    },
  });
}
export const R04_ADAPTERS: Readonly<Record<R04Path, ReturnType<typeof r04Adapter>>> = Object.freeze({ a: r04Adapter("a"), b: r04Adapter("b"), c: r04Adapter("c") });

export const r04BagFeeRefundV1 = makePack("a");
export const r04DelayedBagExpensesV1 = makePack("b");
export const r04PropertyLossV1 = makePack("c");
export const R04_V1_PACKS = Object.freeze([r04BagFeeRefundV1, r04DelayedBagExpensesV1, r04PropertyLossV1]);
