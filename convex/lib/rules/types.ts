/**
 * Rule-engine types (contract rev 5.5 §4). Pure declarations: no ctx, no clock, no randomness, no `lib/ai`.
 *
 * Every stored shape is the `Infer<>` of the validator M10 exports from `convex/schema.ts`, so an
 * `EvaluationResult` can be written to `evaluations` without a translation layer. The engine-only shapes
 * (cells, condition trees, deadline specs, flags, packs) are declared here.
 */
import type { Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { CellLookup as FactsLookup } from "../facts/resolve";
import type { CellRow } from "../facts/snapshot_retail";
import type {
  amountCalc,
  assumption,
  authorityClass,
  boundFactValue,
  cashClass,
  cellStatus,
  conditionResult,
  deadlineResult,
  dimensions,
  evaluationOutcome,
  factRef,
  factValue,
  missingFact,
  nextAction,
  overlapRelation,
  reevaluate,
  remedyType,
  requiredChannel,
  scenarioId,
  sourceRef,
  transactionCategory,
  tri,
} from "../../schema";

export type Outcome = Infer<typeof evaluationOutcome>;
export type Tri = Infer<typeof tri>;
export type Dimensions = Infer<typeof dimensions>;
export type ConditionResult = Infer<typeof conditionResult>;
export type ConditionKind = ConditionResult["kind"];
export type MissingFact = Infer<typeof missingFact>;
export type MissingReason = MissingFact["reason"];
export type Assumption = Infer<typeof assumption>;
export type AmountCalc = Infer<typeof amountCalc>;
export type DeadlineResult = Infer<typeof deadlineResult>;
export type DeadlineStatus = DeadlineResult["status"];
export type SourceRef = Infer<typeof sourceRef>;
export type NextAction = Infer<typeof nextAction>;
export type Reevaluate = Infer<typeof reevaluate>;
export type FactRef = Infer<typeof factRef>;
export type FactValue = Infer<typeof factValue>;
export type BoundFactValue = Infer<typeof boundFactValue>;
export type CellStatus = Infer<typeof cellStatus>;
export type ScenarioId = Infer<typeof scenarioId>;
export type AuthorityClass = Infer<typeof authorityClass>;
export type RemedyType = Infer<typeof remedyType>;
export type CashClass = Infer<typeof cashClass>;
export type OverlapRelation = Infer<typeof overlapRelation>;
export type TransactionCategory = Infer<typeof transactionCategory>;
export type Money = { amountMinor: number; currency: string };
export type RequiredChannel = Infer<typeof requiredChannel>;
export type CaseMode = "request" | "track_automatic";

/**
 * `APPROVABLE_OUTCOMES` (contract §2.8, DA-A-14): the ONE allow-list shared by case opening, `drafts.prepareSend`
 * and `packets.approve`. `not_yet_due` is deliberately absent (rev 5.2).
 */
export const APPROVABLE_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit"]);

export function isApprovable(outcome: Outcome): boolean {
  return APPROVABLE_OUTCOMES.has(outcome);
}

// ---------------------------------------------------------------------------
// Cells (contract §2.5). The engine's structural view of a resolved fact cell. `lib/facts/resolve.ts` (M11)
// produces richer cells; any of them is assignable to `EngineCell`.
// ---------------------------------------------------------------------------

export type ConflictKind = "candidates" | "confirmed_vs_observed" | "confirmed_vs_confirmed";
export type KnownStatus = "confirmed" | "observed" | "derived";

/** Where a competing value came from, for display only (never hashed). */
export interface EngineCellSource {
  kind: string;
  ref?: string;
}

export interface EngineConflictValue<V = FactValue> {
  value: V;
  source: EngineCellSource;
  /** The row state behind this value (a confirmed_vs_observed conflict lists one of each). */
  state?: string;
}

export interface EngineCell<V = FactValue> {
  subjectKey: string;
  key: string;
  status: CellStatus;
  /** Present iff the status is known (confirmed/observed/derived) or `candidate`. */
  value?: V;
  /** Present iff the status is `conflicting`. */
  conflict?: { kind: ConflictKind; values: readonly EngineConflictValue<V>[] };
  /** R01 v1 fixtures only: an assumption-class candidate (README cross-pack rule 2). */
  assumption?: boolean;
}

/** Resolves any cell; a cell nobody wrote is `missing`, never an exception. */
export type CellLookup = (subjectKey: string, key: string) => EngineCell;

export const KNOWN_STATUSES: ReadonlySet<CellStatus> = new Set<CellStatus>(["confirmed", "observed", "derived"]);

export function isKnown(cell: Pick<EngineCell, "status">): boolean {
  return KNOWN_STATUSES.has(cell.status);
}

/** Known or candidate: a value the evaluator may compute with (a candidate caps the outcome, D147(2)). */
export function isUsable(cell: Pick<EngineCell, "status" | "value">): boolean {
  return (isKnown(cell) || cell.status === "candidate") && cell.value !== undefined;
}

export function missingCell(subjectKey: string, key: string): EngineCell {
  return { subjectKey, key, status: "missing" };
}

/** A lookup over an explicit cell list; anything not listed is `missing`. */
export function lookupFrom(cells: readonly EngineCell[]): CellLookup {
  const byId = new Map<string, EngineCell>();
  for (const c of cells) byId.set(`${c.subjectKey}\u0000${c.key}`, c);
  return (subjectKey, key) => byId.get(`${subjectKey}\u0000${key}`) ?? missingCell(subjectKey, key);
}

/** The missing-fact reason a non-usable cell carries (DA-A-1: `user_unknown` stays its own reason). */
export function unresolvedReason(cell: Pick<EngineCell, "status">): MissingReason {
  switch (cell.status) {
    case "user_unknown":
      return "user_unknown";
    case "conflicting":
      return "conflicting";
    case "candidate":
      return "candidate_unconfirmed";
    default:
      return "missing";
  }
}

// ---------------------------------------------------------------------------
// Condition trees (lib/rules/conditions.ts, DA-A-24)
// ---------------------------------------------------------------------------

/** A condition read directly off one fact cell. */
export interface FactCondition {
  op: "fact";
  id: string;
  label: string;
  kind: ConditionKind;
  fact: FactRef;
  /** Decides the condition from a usable value (known or candidate). */
  test: (value: FactValue) => boolean;
  /** DA-A-2: an assumption-class unknown is assumed to hold and never sets factsKnown. */
  class?: "required" | "assumption";
  /** DA-A-24: listed only when decisive (every listing is decisive-only; the flag documents intent). */
  sensitive?: boolean;
  neededFor?: readonly string[];
  sourcePassageId?: string;
  note?: string;
}

/** A condition the pack computed from several facts (e.g. "drop ≥ threshold"). */
export interface ComputedCondition {
  op: "computed";
  id: string;
  label: string;
  kind: ConditionKind;
  result: Tri;
  /** Every fact the result was computed from (shown with the condition). */
  facts: readonly FactRef[];
  /** When `result` is "unknown": the facts whose unresolved cells caused it, with their reasons. */
  unknownFacts?: readonly { fact: FactRef; reason: MissingReason }[];
  /** Facts that were used only as unconfirmed candidates (D147(2)): listed as `candidate_unconfirmed` when decisive. */
  candidateFacts?: readonly FactRef[];
  neededFor?: readonly string[];
  sourcePassageId?: string;
  note?: string;
}

export type ConditionNode =
  | { op: "all"; children: readonly ConditionNode[] }
  | { op: "any"; children: readonly ConditionNode[] }
  | { op: "not"; child: ConditionNode }
  | FactCondition
  | ComputedCondition;

export type ConditionLeaf = FactCondition | ComputedCondition;

// ---------------------------------------------------------------------------
// Requirements and deadlines (contract §4)
// ---------------------------------------------------------------------------

export interface FactRequirement {
  subjectPattern: string;
  key: string;
  /** DA-A-2: assumption-class unknowns add an Assumption, never set factsKnown. */
  class: "required" | "assumption";
  /** Required when class = "assumption". */
  assumptionText?: string;
  /** DA-A-24: must pass the decisiveness test to be asked. */
  sensitive?: boolean;
}

export type AnchorKind =
  | "event_occurred" | "notice_sent" | "notice_received" | "statement_transmitted" | "purchase" | "delivery"
  | "report_filed" | "refund_duty_start";

export type OffsetUnit = "calendar_days" | "business_days" | "hours" | "elapsed_24h_days";

export interface DeadlineSpec {
  id: string;
  label: string;
  /** DA-A-5: only "user" feeds windowOpen, nextDeadlineAt and "expired". */
  obligor: "user" | "counterparty";
  /** The LEGAL trigger; never a fallback date. `subjectPattern` is an exact subject key or `<head>:*`. */
  anchor: { subjectPattern: string; factKey: string };
  anchorKind: AnchorKind;
  offset: { amount: number; unit: OffsetUnit };
  boundary: { anchorDayCounts: boolean; endInclusive: boolean };
  endOfDay: "local_end_of_day" | "exact_instant";
  /** `{ fixed: "UTC" }` is allowed for exact-instant specs whose arithmetic needs no zone. */
  timeZone: { from: "fact"; factKey: string } | { fixed: string };
  holidays: "none" | "us_federal";
  mustBe: "received" | "sent" | "filed" | "paid" | "n_a";
  /** D143.3: e.g. R03 posting date + 60 when the first-statement anchor is unknown. */
  advisoryWhenAnchorUnknown?: { fromFactKey: string; offsetDays: number; label: string };
  /** e.g. payment class selects the 7-business vs 20-calendar timer (D143.2). */
  appliesWhen?: ConditionNode;
  /**
   * rev 5 (C1): set ONLY on R01 v1's legacy window (merchant_promise, elapsed_24h_days). Passing it gives
   * `deadline_passed` but is acknowledgeable at send time and not material.
   */
  lateAskAcknowledgeable?: true;
  sourcePassageId: string;
}

// ---------------------------------------------------------------------------
// Evaluation (contract §4)
// ---------------------------------------------------------------------------

export interface ConflictFlag {
  /** The conflicting fact's key (and subject). */
  key: string;
  subjectKey: string;
  kind: ConflictKind;
  values: { value: string; source: string }[];
  /** D154/D158: every conflicting value yields the same outcome AND the same amount (candidate testing). */
  sameAnswer: boolean;
}

export interface Flags {
  unsupportedReason?: string;
  sourceStale?: boolean;
  /** README cross-pack rule 8 (D160): no current source record (for R01 v1: no policy snapshot or no window). */
  sourceMissing?: boolean;
  effectiveDateMismatch?: boolean;
  /** Every decisive key whose cell is `conflicting`. */
  conflictingKeys: string[];
  conflicts: ConflictFlag[];
  contractCoverageInexact?: boolean;
  manualReviewReason?: string;
  /** rev 5.2/5.4: set by the pack only from KNOWN facts; `userAction` when the awaited event is the user's own action. */
  notYetDue?: { at?: string; when?: string; userAction?: NextAction };
}

export function emptyFlags(): Flags {
  return { conflictingKeys: [], conflicts: [] };
}

export interface OverlapDecl {
  withScenario: ScenarioId;
  withRemedyKey: string;
  relation: OverlapRelation;
  /** `coordinated` is honoured only with a source passage (D145). */
  sourcePassageId?: string;
}

export interface RuleSourceMeta {
  sourceId: string;
  passageId: string;
  url: string;
  /** Effective date "YYYY-MM-DD" or "unknown". */
  effective: string;
  /** README rule 3: evaluating past this window after the last verification → `source_unverified`. */
  refreshWindowDays?: number;
  /**
   * M20b (D234 E5): the manifest's `mandatoryReviewBy` ("YYYY-MM-DD", e.g. R02's DOT enforcement pause). From that
   * date on the source is stale (`source_unverified`) until a verification record dated on or after it exists.
   */
  mandatoryReviewBy?: string;
}

/** What the evaluator knows about existing cases on this opportunity (contract §4 `caseContext`). */
export interface CaseContext {
  activeClaimId?: Id<"claims">;
  /** Confirmed (settled) amounts per loss key on this subject. */
  settledMinorByLossKey: Record<string, number>;
  /** DA-A-22 (wave 2): the opening observation of a denied claim on this subject. */
  deniedObservedMinor?: number;
}

export interface EvaluationInput<S, P, C extends CaseContext = CaseContext> {
  snapshot: S;
  snapshotHash: string;
  pack: { ruleId: string; scenarioId: ScenarioId; version: number; params: P; sources: readonly RuleSourceMeta[] };
  /** From `lib/rules/verification.ts` (lead-owned data). */
  verification: Readonly<Record<string, { lastVerifiedAt: string }>>;
  engineVersion: string;
  remedyKey: string;
  subjectKey: string;
  incidentId?: string;
  caseContext: C;
  /** Injected clock (D138): evaluators never read the wall clock. */
  now: number;
}

export interface EvaluationResult {
  scenarioId: ScenarioId;
  ruleId: string;
  ruleVersion: number;
  engineVersion: string;
  remedyKey: string;
  subjectKey: string;
  snapshotHash: string;
  /** ONLY via `deriveOutcome`. */
  outcome: Outcome;
  dimensions: Dimensions;
  conditions: ConditionResult[];
  missingFacts: MissingFact[];
  assumptions: Assumption[];
  disqualifierIds: string[];
  amount: AmountCalc | null;
  deadlines: DeadlineResult[];
  sourceRefs: SourceRef[];
  lossKeys: string[];
  overlap: OverlapDecl[];
  nextAction: NextAction;
  explanation: string[];
  flags: Flags;
  /** rev 5 (N6): the pack's bound facts (values, ≤ 32). */
  boundFacts: BoundFactValue[];
  /** rev 5.2: set iff outcome === "not_yet_due". */
  reevaluate?: Reevaluate;
}

export type Evaluator<S, P, C extends CaseContext = CaseContext> = (input: EvaluationInput<S, P, C>) => EvaluationResult;

/**
 * One evaluation run of a pack on a transaction (M20, D208): the subject, the pack's snapshot for it, and the resolved
 * cells it was built from (`lookup`, hashed values-only into `factSnapshotHash`, DA-A-15).
 */
export interface PackRun<S> {
  subjectKey: string;
  snapshot: S;
  lookup: FactsLookup;
}

/**
 * How a wave-2 pack is fed from the `facts` table (M20, D208). PURE: type-only imports from `_generated`, no ctx, no
 * clock, no randomness (the `lib/rules` purity grep covers pack files). The engine reads the transaction's live fact
 * rows (bounded by the per-transaction fact cap), calls `runs`, keeps the requested subjects, and evaluates each run.
 * Every implemented pack other than R01 v1 (whose legacy adapter is `opportunities.r01Runs`) must have one.
 */
export interface PackAdapter<S> {
  runs(input: {
    transactionId: Id<"transactions">;
    /** Server-set only (DA-A-29): e.g. the order a card line belongs to, for R03's shared `txn:<orderTxnId>:paid` key. */
    relatedTransactionId?: Id<"transactions">;
    isExample: boolean;
    rows: readonly CellRow[];
  }): readonly PackRun<S>[];
}

/** The README field map (docs/rules/README.md "From spec to evaluator"): one field per spec section. */
export interface RulePack<S, P, C extends CaseContext = CaseContext> {
  ruleId: string;
  scenarioId: ScenarioId;
  /** Integer (`v1` → 1). */
  version: number;
  /** Informative only: activation is decided by `activation.ts` (lead-owned), never by this field. */
  lifecycle: "researched" | "reviewed";
  authority: { class: AuthorityClass; subtype: string };
  jurisdiction: string;
  categories: readonly TransactionCategory[];
  remedyKey: string;
  remedyType: RemedyType;
  cashClass: CashClass;
  params: P;
  sources: readonly RuleSourceMeta[];
  requirements: readonly FactRequirement[];
  fixturesPath: string;
  knownLimitations: readonly string[];
  /** rev 5 (C1): deadline ids whose passing is acknowledgeable at send time and never material (R01 v1's window only). */
  lateAskDeadlineIds: readonly string[];
  /** Overlap relations this pack declares (§3.3); undeclared intersections are `alternative` at case opening (D145). */
  overlap: readonly OverlapDecl[];
  evaluate: Evaluator<S, P, C>;
  /** M20 (D208): the facts-table adapter; required for every implemented pack except R01 v1. */
  adapter?: PackAdapter<S>;
  /** M20 (DA-A-9): the channel a scenario claim counts as submitted on (e.g. R03: postal unless designated). Default email. */
  requiredChannel?: (result: EvaluationResult) => RequiredChannel;
  /** M20 (DA-A-25): `track_automatic` when the refund is automatic by regulation. Default `request`. */
  caseMode?: (result: EvaluationResult) => CaseMode;
  /**
   * M20 (DA-A-18, D204): the fact `claims.recordNonCashResolution` writes (user_confirmed, on the claim's transaction)
   * when the user accepts a non-cash remedy on this pack's case — e.g. R02's `AIR_VOUCHER_ACCEPTANCE`.
   */
  nonCashAcceptance?: { subjectKey: string; key: string; value: FactValue };
}

/** A registered pack of any shape (the registries hold heterogeneous packs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyRulePack = RulePack<any, any, any>;

/** The engine version recorded on evaluations and bindings. Wave 2 (M20, DA-A-23) replaces it with a content hash. */
export const ENGINE_VERSION = "engine-w1";
