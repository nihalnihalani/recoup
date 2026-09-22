/**
 * R01 v1 — retail price adjustment, LEGACY SNAPSHOT TIER (docs/rules/R01-retail-price-adjustment.md L1; contract rev 5.5
 * §2.7; fixtures docs/rules/fixtures/R01.json). Pure: no ctx, no clock (`now` is injected), no randomness, no `lib/ai`.
 *
 * What it evaluates. One purchased item against the merchant's price-adjustment policy snapshot that `latestPolicy()`
 * selects today (N7: the newest user-confirmed snapshot, else the newest). The framework logic cites no external legal
 * source (D145 d); every number below is a LEGACY PARITY value, reproduced exactly from the code at `5cc326d`:
 *   - an observation counts only if it is a VETTED PRICE CHECK — an `observed` cell sourced from a price check
 *     (`legacy_price_check` / `price_check`) that carries its acceptance metadata — and it is a single price > 0,
 *     variantMatch "exact", in the purchase currency, with confidence ≥ 0.7, and not below round(10 % of the unit
 *     price paid) (priceWatch.rejectionReason/implausiblyCheap; contract §2.7's definition of the fact). Any other
 *     observed-price value — an extracted candidate, an evidence- or user-sourced value, a value without metadata —
 *     is "not accepted" and counts as missing (M18 item 1);
 *   - a drop qualifies when (unit − observed) ≥ max(100, round(unit × 2 %)); the ask is drop × quantity
 *     (lib/ledger.priceDropCents);
 *   - after confirmed (paid) claims totalling S, the ask is drop × qty − S and opens only when it is
 *     ≥ max(100, round(unit × qty × 2 %)) (priceWatch.recordCheck);
 *   - the window ends at purchasedAt + windowDays × 86,400,000 ms (24-hour multiples, O15/HC-11), open while
 *     now ≤ end (lib/ledger.windowEndsAt).
 * Two-decimal currencies only (DA-A-13 carve-out via `isTwoDecimalCurrency`); a 0- or 3-decimal currency, which the
 * legacy flow mis-scales by 100 (HC-8), is `unsupported` — the one intentional divergence from legacy (D160).
 * After a denial (DA-A-22, wave 2) the ask is (deniedObserved − observed) × qty; when a paid claim also exists on the
 * item the ask is the SMALLER of that and the paid-claim remainder — the spec is silent on the combination, so v1 takes
 * the conservative reading and never re-asks money already paid (M18 N2).
 *
 * Status. This file declares `lifecycle: "researched"`; the lead's activation entry and the manifest decide the real
 * status (M18 N6), never this field.
 *
 * Outcome. Best is `likely_eligible` (never `eligible`): the temporal assumption A-T1/A-T2 is always present (§2.7,
 * README rule 3's R01 v1 exception). `retail.policy_confirmed`, `retail.policy_temporal` and `retail.currency` are
 * assumption-class (DA-A-2, DA-A-33): they never set factsKnown and never block a claim. No policy or no window →
 * `source_unverified` (README rule 8, D160).
 *
 * Window (C1). The legacy window is a user deadline marked `lateAskAcknowledgeable`: once it passes the outcome is
 * `deadline_passed` (auto-open stays closed, R01-05c) but an existing claim's send is only warned
 * (`window_may_have_passed`, R01-05d) and the flip is not material.
 *
 * Open case (C2, KM3). While a claim is active the evaluation reads the claim's OPENING observation, never the live
 * price, and the bound facts are unit price, quantity, item identity (subject + name), purchase date, the claim amount
 * and the opening observation — so price checks on an open case never change the result or invalidate an approval.
 */
import type { Id } from "../../_generated/dataModel";
import { formatMinor, isTwoDecimalCurrency } from "../money";
import { alternatives, cellLookup, knownCell, type Cell } from "../facts/resolve";
import { boundFactValues } from "../facts/snapshot_retail";
import { computeDeadline, isLateAskAcknowledgeable, userWindowOpen } from "../deadlines/engine";
import { addMissing, evaluateConditions } from "./conditions";
import {
  candidateCombinations,
  deriveOutcome,
  sameAnswer,
  withSameAnswer,
} from "./outcome";
import {
  emptyFlags,
  isApprovable,
  isKnown,
  lookupFrom,
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
  type Tri,
  unresolvedReason,
} from "./types";

export const R01_V1_RULE_ID = "R01.retail_price_adjustment";
export const R01_V1_VERSION = 1;
export const R01_REMEDY_KEY = "price_difference";
export const R01_V1_WINDOW_ID = "r01.v1.window";
/** rev 5 (C1): the only acknowledgeable deadline. */
export const R01_V1_ACKNOWLEDGEABLE: ReadonlySet<string> = new Set([R01_V1_WINDOW_ID]);

/**
 * R01 v1 parameters. Each cites its spec/fixture basis first and the legacy line it reproduces second (M18 item 2).
 * The window itself is not a parameter here: its length is the policy snapshot's `windowDays` (the parameter source,
 * N7), counted in whole 24-hour periods — spec §5 last bullet; R01.json `conventions.window`; O15/HC-11; lateAsk C1.
 * The currency gate is D160 / DA-A-13 (`isTwoDecimalCurrency`), not a number.
 */
export interface R01Params {
  /** Drop floor, minor units. Basis: R01.json `conventions.threshold` + contract §2.7 parity (KM1). Legacy: `ledger.priceDropCents` `Math.max(100, …)`. */
  thresholdFloorMinor: number;
  /** Drop threshold, % of the unit price paid. Basis: R01.json `conventions.threshold` (and `conventions.after_settled_claim` for the remainder) + contract §2.7 (KM1). Legacy: `Math.round(unitCents * 0.02)`. */
  thresholdPercent: number;
  /** Minimum extraction confidence of an accepted observation. Basis: R01.json `conventions.observation` + D16 + contract §2.7 ("confidence ≥ 0.7"). Legacy: `priceWatch.MIN_CONFIDENCE`. */
  minConfidence: number;
  /** An observation below this % of the unit price paid is implausible. Basis: R01.json `conventions.observation` + D16. Legacy: `priceWatch.MIN_PLAUSIBLE_FRACTION`. */
  minPlausiblePercent: number;
  /** A-T1 when the snapshot was retrieved within ± this many days of the purchase (inclusive), else A-T2. Basis: contract §2.7 "Reconciliation for R01 v1" + README rule 3 (R01 v1 exception); R01.json `conventions.temporal_assumptions`. New in v1 (no legacy line). */
  temporalToleranceDays: number;
}

export const R01_V1_PARAMS: R01Params = Object.freeze({
  thresholdFloorMinor: 100,
  thresholdPercent: 2,
  minConfidence: 0.7,
  minPlausiblePercent: 10,
  temporalToleranceDays: 7,
});

/** The parameter source: the policy snapshot `latestPolicy()` selects (N7). */
export interface R01Policy {
  policyId?: string;
  windowDays?: number;
  retrievedAt: number;
  confirmedByUser: boolean;
  sourceUrl?: string;
}

/** Acceptance metadata of the observation behind the observed-price cell (display and D16 bars; never hashed). */
export interface R01ObservationMeta {
  variantMatch?: "exact" | "unsure" | "none";
  confidence?: number;
  isRange?: boolean;
  observedAt?: number;
  priceCheckId?: string;
}

/** The typed view R01 v1 evaluates: M11 cells for one item subject plus the transaction-level cells it reads. */
export interface R01Snapshot {
  /** `item:<itemId>` */
  subjectKey: string;
  itemReturned: boolean;
  purchaseDate: Cell;
  currency: Cell;
  unitPrice: Cell;
  quantity: Cell;
  itemName: Cell;
  observedPrice: Cell;
  observation: R01ObservationMeta | null;
  policy: R01Policy | null;
}

export interface R01CaseContext extends CaseContext {
  /** The open price-adjustment claim on this item, when there is one (linked or not). */
  activeClaim?: {
    claimId: Id<"claims">;
    expectedMinor: number;
    currency: string;
    lossKeys?: readonly string[];
    /** The observation the claim was opened on (`openedFromPriceCheckId`), frozen (C2). */
    opening?: { amountMinor: number; currency: string; observedAt: number };
  };
}

const DAY_MS = 86_400_000;
const TXN = "txn";
/** The sources of a vetted price check: the legacy adapter's accepted `priceChecks` row, or a stored price-check fact. */
const VETTED_OBSERVATION_SOURCES: ReadonlySet<string> = new Set(["legacy_price_check", "price_check"]);
const NOT_VETTED = "That price was not read from a vetted price check of this item";

function group(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function money(cell: Cell): { amountMinor: number; currency: string } | null {
  const v = (cell.status === "candidate" || cell.known) ? cell.value : null;
  return v && v.kind === "money" ? { amountMinor: v.amountMinor, currency: v.currency } : null;
}
function count(cell: Cell): number | null {
  const v = (cell.status === "candidate" || cell.known) ? cell.value : null;
  return v && v.kind === "count" ? v.n : null;
}
function instant(cell: Cell): number | null {
  const v = (cell.status === "candidate" || cell.known) ? cell.value : null;
  return v && v.kind === "instant" ? v.epochMs : null;
}
function code(cell: Cell): string | null {
  const v = (cell.status === "candidate" || cell.known) ? cell.value : null;
  return v && v.kind === "code" ? v.code : null;
}
const ref = (cell: Cell): FactRef => ({ subjectKey: cell.subjectKey, key: cell.key });
const reasonOf = (cell: Cell): MissingReason => unresolvedReason(cell);

/** The legacy D16 bars. Returns the legacy note when the observation is rejected, else null. */
export function r01ObservationRejection(
  obs: { amountMinor: number; currency?: string },
  meta: R01ObservationMeta | null,
  purchaseCurrency: string | null,
  unitMinor: number | null,
  p: R01Params,
): string | null {
  if (meta?.isRange) return "Page shows a price range, not a single price";
  if (!Number.isSafeInteger(obs.amountMinor) || obs.amountMinor <= 0) return "The page does not show a price";
  if (meta && meta.variantMatch !== "exact") {
    return meta.variantMatch === "none" ? "The page does not price this product" : "Could not tell which variant the price is for";
  }
  if (!obs.currency) return "The page does not state a currency";
  if (purchaseCurrency !== null && obs.currency !== purchaseCurrency) {
    return `Page price is in ${obs.currency}, the purchase was in ${purchaseCurrency}`;
  }
  if (meta && (meta.confidence === undefined || meta.confidence < p.minConfidence)) return "Low confidence in the extracted price";
  if (unitMinor !== null && unitMinor > 0 && obs.amountMinor < Math.round(unitMinor * (p.minPlausiblePercent / 100))) {
    return "That price is too far below what you paid to be this product; it looks like an accessory, a deposit or a monthly payment";
  }
  return null;
}

function windowSpec(windowDays: number): DeadlineSpec {
  return {
    id: R01_V1_WINDOW_ID,
    label: "The store's price-adjustment window (legacy reading: whole 24-hour periods from the purchase time)",
    obligor: "user",
    anchor: { subjectPattern: TXN, factKey: "retail.purchase_date" },
    anchorKind: "purchase",
    offset: { amount: windowDays, unit: "elapsed_24h_days" },
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "exact_instant",
    timeZone: { fixed: "UTC" },
    holidays: "none",
    mustBe: "n_a",
    lateAskAcknowledgeable: true,
    sourcePassageId: "policy_snapshot.windowDays",
  };
}

// ---------------------------------------------------------------------------
// The core evaluation of one fact assignment (candidate testing calls it once per candidate)
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
  observationRejected: string | null;
  refreshPolicy: boolean;
}

function computed(
  id: string, label: string, kind: ComputedCondition["kind"], result: Tri, facts: Cell[],
  opts: { unknown?: Cell[]; note?: string; neededFor?: string[]; sourcePassageId?: string } = {},
): ComputedCondition {
  const unknownFacts = (opts.unknown ?? []).map((c) => ({ fact: ref(c), reason: reasonOf(c) }));
  const candidateFacts = facts.filter((c) => c.status === "candidate").map(ref);
  return {
    op: "computed", id, label, kind, result, facts: facts.map(ref),
    ...(result === "unknown" ? { unknownFacts } : {}),
    ...(candidateFacts.length > 0 ? { candidateFacts } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
    ...(opts.neededFor !== undefined ? { neededFor: opts.neededFor } : {}),
    ...(opts.sourcePassageId !== undefined ? { sourcePassageId: opts.sourcePassageId } : {}),
  };
}

function core(s: R01Snapshot, cc: R01CaseContext, p: R01Params, now: number): Core {
  const flags: Flags = emptyFlags();
  const explanation: string[] = [];
  const assumptions: Assumption[] = [];

  const unit = money(s.unitPrice);
  const qty = count(s.quantity);
  const purchasedAt = instant(s.purchaseDate);
  const purchaseCurrency = unit?.currency ?? code(s.currency);

  if (purchaseCurrency !== null && !isTwoDecimalCurrency(purchaseCurrency)) {
    flags.unsupportedReason = `Recoup's price-adjustment check handles two-decimal currencies only; ${purchaseCurrency} is not one (D160).`;
  }

  // The observation: the claim's frozen opening observation while a case is open (C2), else the live cell.
  let observedCell: Cell = s.observedPrice;
  let meta: R01ObservationMeta | null = s.observation;
  const opening = cc.activeClaim?.opening;
  if (opening) {
    observedCell = {
      subjectKey: s.subjectKey, key: "retail.observed_price", status: "observed", known: true,
      value: { kind: "money", amountMinor: opening.amountMinor, currency: opening.currency },
      source: { kind: "legacy_price_check" }, capsOutcomeAt: null,
    };
    meta = { variantMatch: "exact", confidence: 1, isRange: false, observedAt: opening.observedAt };
  }
  const obsMoney = money(observedCell);
  // M18 item 1: only a VETTED price check counts as the accepted observation (contract §2.7). Every other usable value
  // (a candidate, an evidence- or user-sourced value, a value without the check's metadata) is "not accepted".
  const vetted = observedCell.status === "observed" && VETTED_OBSERVATION_SOURCES.has(observedCell.source.kind) && meta !== null;
  const rejection = obsMoney === null
    ? null
    : !vetted
      ? NOT_VETTED
      : r01ObservationRejection(obsMoney, meta, purchaseCurrency, unit?.amountMinor ?? null, p);
  const observed = obsMoney && rejection === null ? obsMoney : null;
  // A rejected or unvetted reading — and a conflict among unvetted values — is not an observation (D16, §2.7): for the
  // condition and missing-fact lists the cell counts as missing, never as an unconfirmed candidate it was not.
  const obsFact: Cell = observed === null && (rejection !== null || observedCell.status === "conflicting")
    ? { subjectKey: observedCell.subjectKey, key: observedCell.key, status: "missing", known: false, capsOutcomeAt: null }
    : observedCell;
  const obsForUnknown = obsFact;

  // Policy (the parameter source) and the legacy window.
  const policy = s.policy;
  const windowDays = policy?.windowDays;
  const hasWindow = policy !== null && windowDays !== undefined && Number.isSafeInteger(windowDays) && windowDays >= 0;
  if (!hasWindow) {
    flags.sourceMissing = true;
    explanation.push("No price-adjustment policy with a window has been found for this store yet.");
  }
  const cells = lookupFrom([s.purchaseDate]);
  const deadline = hasWindow ? computeDeadline(windowSpec(windowDays!), cells, now) : null;
  const deadlines = deadline ? [deadline] : [];

  // Conditions.
  const returnedCond = computed("r01.v1.item_not_returned", "The item has not been returned", "applicability", s.itemReturned ? "fail" : "pass", []);
  const obsCond = computed(
    "r01.v1.observation_accepted", "An accepted price check of this exact item, in the purchase currency", "evidence",
    observed !== null ? "pass" : "unknown", [obsFact],
    { unknown: [obsForUnknown], note: rejection ?? undefined, neededFor: ["drop"] },
  );

  let dropResult: Tri = "unknown";
  let settledResult: Tri = "unknown";
  let estimate: number | null = null;
  let formula = "";
  const threshold = unit ? Math.max(p.thresholdFloorMinor, Math.round(unit.amountMinor * (p.thresholdPercent / 100))) : null;
  const settled = Object.values(cc.settledMinorByLossKey).reduce((a, b) => a + b, 0);
  let remainderThreshold: number | null = null;
  if (unit && observed && qty !== null && Number.isSafeInteger(qty) && qty >= 1) {
    const perUnit = unit.amountMinor - observed.amountMinor;
    const drop = perUnit >= threshold! ? perUnit * qty : null;
    dropResult = drop === null ? "fail" : "pass";
    if (drop === null) {
      settledResult = "pass";
      explanation.push(`The price drop (${group(Math.max(perUnit, 0))}) is below the threshold of ${group(threshold!)}.`);
    } else {
      const remaining = drop - settled;
      remainderThreshold = Math.max(p.thresholdFloorMinor, Math.round(unit.amountMinor * qty * (p.thresholdPercent / 100)));
      if (settled > 0 && remaining < remainderThreshold) {
        settledResult = "fail";
        explanation.push(`This drop was already claimed and paid (${group(settled)}); the remaining ${group(Math.max(remaining, 0))} is below ${group(remainderThreshold)}.`);
      } else {
        settledResult = "pass";
        estimate = remaining;
        formula = `(${group(unit.amountMinor)} - ${group(observed.amountMinor)}) x ${qty}${settled > 0 ? ` - ${group(settled)} settled` : ""}`;
      }
    }
    // DA-A-22 (wave 2): after a denial only the new difference below the denied observation is asked.
    // With a paid claim on the item too, the ask is the smaller of the two readings (spec silent; conservative, M18 N2).
    if (dropResult === "pass" && settledResult === "pass" && cc.deniedObservedMinor !== undefined) {
      const diff = Math.max(0, cc.deniedObservedMinor - observed.amountMinor) * qty;
      const remaining = perUnit * qty - settled;
      const ask = settled > 0 ? Math.min(diff, remaining) : diff;
      estimate = ask > 0 ? ask : null;
      formula = ask <= 0
        ? ""
        : settled > 0 && remaining < diff
          ? `(${group(unit.amountMinor)} - ${group(observed.amountMinor)}) x ${qty} - ${group(settled)} settled (less than the denied-claim difference)`
          : `(${group(cc.deniedObservedMinor)} denied observation - ${group(observed.amountMinor)}) x ${qty}`;
    }
  }
  const dropUnknown: Cell[] = [
    ...(unit === null ? [s.unitPrice] : []),
    ...(observed === null ? [obsForUnknown] : []),
    ...(qty === null ? [s.quantity] : []),
  ];
  const dropCond = computed(
    "r01.v1.drop_meets_threshold", "The lower price is at least max($1, 2%) below the unit price paid", "requirement",
    dropResult, [s.unitPrice, obsFact, s.quantity], { unknown: dropUnknown, neededFor: ["drop", "amount"] },
  );
  const settledCond = computed(
    "r01.v1.not_already_claimed", "The drop has not already been claimed and paid", "requirement",
    settledResult, [s.unitPrice, obsFact, s.quantity], { unknown: dropUnknown, neededFor: ["amount"] },
  );
  const windowResult: Tri = deadline === null ? "unknown" : deadline.status === "open" ? "pass" : deadline.status === "passed" ? "fail" : "unknown";
  const windowCond = computed(
    R01_V1_WINDOW_ID, "Inside the store's price-adjustment window", "timing", windowResult, [s.purchaseDate],
    { unknown: deadline === null ? [] : [s.purchaseDate], neededFor: ["window"], sourcePassageId: "policy_snapshot.windowDays" },
  );

  const tree: ConditionNode = { op: "all", children: [returnedCond, obsCond, dropCond, settledCond, windowCond] };
  const evaluated = evaluateConditions(tree, lookupFrom([]));
  const applies = evaluateConditions({ op: "all", children: [returnedCond, dropCond, settledCond] }, lookupFrom([])).result;

  const required: Cell[] = [s.purchaseDate, s.unitPrice, s.quantity];
  const requiredUsable = required.every((c) => c.status === "candidate" || c.known) && observed !== null;
  const usedCandidates = [...required, obsFact].some((c) => c.status === "candidate");
  if (s.itemReturned) explanation.push("The item was returned, so a price adjustment does not apply.");
  if (rejection) explanation.push(`The latest price check was not used: ${rejection}.`);

  // Assumptions (assumption-class; DA-A-2, DA-A-33, §2.7).
  if (policy && !policy.confirmedByUser) {
    assumptions.push({
      id: "retail.policy_confirmed",
      text: "You have not confirmed the store's price-adjustment policy text Recoup found.",
      changesOutcomeIf: "the store's actual policy differs from the text Recoup found",
    });
  }
  if (!isKnown(s.currency) && purchaseCurrency !== null) {
    assumptions.push({
      id: "retail.currency",
      text: `The purchase currency (${purchaseCurrency}) was read from the order, not confirmed by you.`,
      changesOutcomeIf: "you paid in a different currency",
    });
  }
  let refreshPolicy = false;
  if (policy && purchasedAt !== null) {
    const diffDays = Math.round(Math.abs(policy.retrievedAt - purchasedAt) / DAY_MS);
    if (Math.abs(policy.retrievedAt - purchasedAt) <= p.temporalToleranceDays * DAY_MS) {
      assumptions.push({
        id: "A-T1",
        text: "The policy text was retrieved within a week of your purchase; Recoup assumes it was the policy then.",
        changesOutcomeIf: "the store changed its policy between your purchase and the retrieval",
      });
    } else {
      refreshPolicy = true;
      const when = policy.retrievedAt >= purchasedAt ? `${diffDays} days after` : `${diffDays} days before`;
      assumptions.push({
        id: "A-T2",
        text: `The policy text was retrieved ${when} your purchase; the policy may have changed.`,
        changesOutcomeIf: "the policy in force on your purchase date was different — refresh the store's policy to check",
      });
    }
  }

  const amount: AmountCalc | null = estimate !== null && unit !== null && observed !== null && qty !== null
    ? {
        estimate: { amountMinor: estimate, currency: unit.currency },
        basis: "exact_formula",
        formula,
        inputs: [
          { label: "unit price paid", value: String(unit.amountMinor), fact: ref(s.unitPrice) },
          { label: cc.activeClaim?.opening ? "price the claim was opened on" : "observed price", value: String(observed.amountMinor), fact: ref(observedCell) },
          { label: "quantity", value: String(qty), fact: ref(s.quantity) },
          { label: "threshold per unit", value: String(threshold) },
          ...(settled > 0 ? [{ label: "already paid on this item", value: String(settled) }] : []),
          ...(remainderThreshold !== null && settled > 0 ? [{ label: "threshold after a paid claim", value: String(remainderThreshold) }] : []),
          ...(cc.deniedObservedMinor !== undefined ? [{ label: "observation of the denied claim", value: String(cc.deniedObservedMinor) }] : []),
        ],
      }
    : null;

  const dims: Omit<Dimensions, "readyForApproval"> = {
    applies,
    factsKnown: requiredUsable ? "pass" : "unknown",
    evidenceSupports: usedCandidates ? "unknown" : "pass",
    windowOpen: userWindowOpen(deadlines),
    amountCalculable: amount !== null ? "pass" : applies === "fail" ? "fail" : "unknown",
  };
  return {
    dims, flags, conditions: evaluated.conditions,
    missing: evaluated.decisiveMissing, unconfirmed: evaluated.decisiveUnconfirmed,
    assumptions, amount, deadlines, explanation, observationRejected: rejection, refreshPolicy,
  };
}

/** An amount is shown only for outcomes where it is meaningful (never for unsupported/unverified/not eligible/needs facts). */
const AMOUNT_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit", "deadline_passed", "not_yet_due"]);

function outcomeOf(c: Core): { outcome: Outcome; amount: AmountCalc | null } {
  const outcome = deriveOutcome({ ...c.dims, readyForApproval: "unknown" }, c.flags, c.assumptions);
  return { outcome, amount: AMOUNT_OUTCOMES.has(outcome) ? c.amount : null };
}

function describeCellValue(v: unknown): string {
  if (typeof v !== "object" || v === null) return String(v);
  const x = v as { kind?: string; amountMinor?: number; currency?: string; epochMs?: number; n?: number; code?: string };
  switch (x.kind) {
    case "money": return isTwoDecimalCurrency(x.currency!) ? formatMinor(x.amountMinor!, x.currency!) : `${x.currency} ${x.amountMinor} (minor units)`;
    case "instant": return new Date(x.epochMs!).toISOString();
    case "count": return String(x.n);
    case "code": return x.code!;
    default: return x.kind ?? "value";
  }
}

function conflictFlag(cell: Cell): Omit<ConflictFlag, "sameAnswer"> {
  const c = cell as Extract<Cell, { status: "conflicting" }>;
  return {
    key: cell.key,
    subjectKey: cell.subjectKey,
    kind: c.conflict.kind,
    values: c.conflict.values.map((v) => ({ value: describeCellValue(v.value), source: v.source.ref ? `${v.source.kind}: ${v.source.ref}` : v.source.kind })),
  };
}

function nextActionFor(outcome: Outcome, c: Core, cc: R01CaseContext, missing: MissingFact[], manualReason?: string): NextAction {
  const claimId = cc.activeClaimId ?? cc.activeClaim?.claimId;
  if (outcome === "manual_review") return { kind: "manual_review", reason: manualReason ?? "The facts disagree; review them before a claim is prepared." };
  if (outcome === "needs_facts") {
    const keys = missing.filter((m) => m.key !== "retail.observed_price");
    if (keys.length === 0) return { kind: "none", reason: "Waiting for an accepted price check of this exact item." };
    // Legacy-backed retail keys are answered on the purchase page, not as free-answer questions (D164/M11b).
    return { kind: "none", reason: `Confirm the purchase details on the purchase page: ${keys.map((k) => k.key).join(", ")}.` };
  }
  if (claimId !== undefined && (isApprovable(outcome) || outcome === "deadline_passed")) {
    return { kind: "continue_case", claimId };
  }
  if (isApprovable(outcome)) {
    if (c.refreshPolicy) return { kind: "add_evidence", docTypes: ["policy_page"] };
    return { kind: "open_case" };
  }
  switch (outcome) {
    case "source_unverified":
      return { kind: "none", reason: "No price-adjustment policy with a window is on file for this store yet." };
    case "unsupported":
      return { kind: "none", reason: c.flags.unsupportedReason ?? "Not supported." };
    case "deadline_passed":
      return { kind: "none", reason: "The store's price-adjustment window has passed for this purchase." };
    default:
      return { kind: "none", reason: c.explanation[0] ?? "No price adjustment is available on these facts." };
  }
}

/** C2: the bound facts of an R01 v1 evaluation (values, never the live observed price). */
export function r01BoundFacts(s: R01Snapshot, cc: R01CaseContext): BoundFactValue[] {
  const facts = boundFactValues({ lookup: cellLookup([s.unitPrice, s.quantity, s.itemName, s.purchaseDate]) }, [
    ref(s.unitPrice), ref(s.quantity), ref(s.itemName), ref(s.purchaseDate),
  ]);
  const claim = cc.activeClaim;
  if (claim) {
    facts.push({ subjectKey: s.subjectKey, key: "retail.claim_amount", status: "derived", value: { kind: "money", amountMinor: claim.expectedMinor, currency: claim.currency } });
    if (claim.opening) {
      facts.push({ subjectKey: s.subjectKey, key: "retail.opening_price", status: "observed", value: { kind: "money", amountMinor: claim.opening.amountMinor, currency: claim.opening.currency } });
      facts.push({ subjectKey: s.subjectKey, key: "retail.opening_observed_at", status: "observed", value: { kind: "instant", epochMs: claim.opening.observedAt } });
    }
  }
  return facts.sort((a, b) => (`${a.subjectKey}\u0000${a.key}` < `${b.subjectKey}\u0000${b.key}` ? -1 : 1));
}

/** Loss key (§3.3): `item:<id>:price_diff:<n>`, n = 1 + the paid price claims on the item; an open claim keeps its own. */
export function r01LossKeys(subjectKey: string, cc: R01CaseContext): string[] {
  if (cc.activeClaim?.lossKeys && cc.activeClaim.lossKeys.length > 0) return [...cc.activeClaim.lossKeys];
  return [`${subjectKey}:price_diff:${Object.keys(cc.settledMinorByLossKey).length + 1}`];
}

function substitute(s: R01Snapshot, cell: Cell): R01Snapshot {
  const k = cell.key;
  if (k === "retail.purchase_date") return { ...s, purchaseDate: cell };
  if (k === "retail.unit_price") return { ...s, unitPrice: cell };
  if (k === "retail.quantity") return { ...s, quantity: cell };
  if (k === "retail.observed_price") return { ...s, observedPrice: cell };
  return s;
}

export function evaluateR01V1(input: EvaluationInput<R01Snapshot, R01Params, R01CaseContext>): EvaluationResult {
  const { snapshot: s, pack, caseContext: cc, now } = input;
  const p = pack.params;
  // Candidate testing covers the purchase facts. The observed price takes part only in 5a (a confirmed value against
  // the price check); a candidates-only conflict on it is not a vetted price check at all → "not accepted" (M18 item 1).
  const decisive: Cell[] = [s.purchaseDate, s.unitPrice, s.quantity];
  const obs = s.observedPrice;
  const obsConfirmedConflict = !cc.activeClaim?.opening && obs.status === "conflicting" && obs.conflict.kind !== "candidates";
  const conflicting = [...decisive.filter((c) => c.status === "conflicting"), ...(obsConfirmedConflict ? [obs] : [])];

  let final: Core;
  let flags: Flags;
  let missing: MissingFact[];
  let unconfirmed: MissingFact[];
  let manualReason: string | undefined;
  const extraExplanation: string[] = [];

  if (conflicting.length === 0) {
    final = core(s, cc, p, now);
    flags = final.flags;
    missing = final.missing;
    unconfirmed = final.unconfirmed;
  } else {
    const confirmedKinds = conflicting.filter((c) => (c as Extract<Cell, { status: "conflicting" }>).conflict.kind !== "candidates");
    const base = core(s, cc, p, now);
    if (confirmedKinds.length > 0) {
      // 5a: the user cannot settle it by answering — manual review, and the key is not asked.
      final = base;
      flags = { ...base.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: withSameAnswer(conflicting.map(conflictFlag), false) };
      const confirmedKeys = new Set(confirmedKinds.map((c) => `${c.subjectKey}\u0000${c.key}`));
      missing = base.missing.filter((m) => !confirmedKeys.has(`${m.subjectKey}\u0000${m.key}`));
      unconfirmed = base.unconfirmed;
      const parts = confirmedKinds.map((c) => {
        const f = conflictFlag(c);
        return `${c.key}: ${f.values.map((v) => `${v.value} (${v.source})`).join(" vs ")}`;
      });
      manualReason = `A value you confirmed contradicts another source — ${parts.join("; ")}. Upload proof (e.g. a dated screenshot) or correct your confirmation.`;
      extraExplanation.push(manualReason);
    } else {
      // Candidate testing: evaluate once per value AS IF it were confirmed (a candidate anchor would never give a
      // firm window, D154, and every combination would look alike). The final result keeps the disputed deadline.
      const choices = conflicting.map((c) =>
        alternatives(c).map((alt) =>
          alt.status === "candidate" || alt.known ? knownCell(alt.subjectKey, alt.key, "confirmed", alt.value, { kind: "user" }) : alt,
        ),
      );
      const combos = candidateCombinations(choices);
      const tested = (combos ?? []).map((combo) => {
        const sub = combo.reduce((acc, cell) => substitute(acc, cell), s);
        const c = core(sub, cc, p, now);
        return { core: c, answer: outcomeOf(c) };
      });
      const same = combos !== null && sameAnswer(tested.map((t) => t.answer));
      const flagsList = withSameAnswer(conflicting.map(conflictFlag), same);
      if (same) {
        // 5c: the answer stands, capped; the conservative (earliest-window) candidate is the representative.
        const byWindow = [...tested].sort((a, b) => (a.core.deadlines[0]?.dueAt ?? Infinity) - (b.core.deadlines[0]?.dueAt ?? Infinity));
        final = { ...byWindow[0].core, deadlines: base.deadlines };
        flags = { ...byWindow[0].core.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: flagsList };
        const conflictKeys = new Set(conflicting.map((c) => `${c.subjectKey}\u0000${c.key}`));
        missing = final.missing.filter((m) => !conflictKeys.has(`${m.subjectKey}\u0000${m.key}`));
        unconfirmed = final.unconfirmed.filter((m) => !conflictKeys.has(`${m.subjectKey}\u0000${m.key}`));
        for (const c of conflicting) {
          addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "conflict_capped", class: "required", neededFor: ["confirmation"] });
        }
        extraExplanation.push(`Your documents disagree on ${conflicting.map((c) => c.key).join(", ")}, but every value gives the same answer; confirm the right one to remove the cap.`);
      } else {
        // 5b: the user answers which value is right.
        final = base;
        flags = { ...base.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: flagsList };
        missing = base.missing;
        unconfirmed = base.unconfirmed;
        for (const c of conflicting) {
          addMissing(missing, { subjectKey: c.subjectKey, key: c.key, reason: "conflicting", class: "required", neededFor: ["outcome"] });
        }
        extraExplanation.push(`Your documents disagree on ${conflicting.map((c) => c.key).join(", ")} and the answer depends on which is right: ${flagsList.map((f) => f.values.map((v) => `${v.value} (${v.source})`).join(" vs ")).join("; ")}.`);
      }
    }
  }

  const outcome = deriveOutcome({ ...final.dims, readyForApproval: "unknown" }, flags, final.assumptions);
  const amount = AMOUNT_OUTCOMES.has(outcome) ? final.amount : null;
  const missingFacts = [...missing, ...unconfirmed];
  const dimensions: Dimensions = { ...final.dims, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  const nextAction = nextActionFor(outcome, final, cc, missing, manualReason);
  const explanation = [
    ...extraExplanation,
    ...(amount ? [`Estimated adjustment ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)}: ${amount.formula} (minor units).`] : []),
    ...final.explanation,
    ...final.assumptions.map((a) => a.text),
    ...(nextAction.kind === "add_evidence" ? ["Refresh the store's policy to check the terms that applied on your purchase date."] : []),
  ].slice(0, 12);

  return {
    scenarioId: "R01",
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
    disqualifierIds: final.conditions.filter((c) => c.result === "fail" && c.kind !== "timing").map((c) => c.id),
    amount,
    deadlines: final.deadlines,
    sourceRefs: s.policy?.sourceUrl
      ? [{ sourceId: `policy:${s.policy.policyId ?? "snapshot"}`, passageId: "policy_snapshot.windowDays", url: s.policy.sourceUrl, effective: "unknown" }]
      : [],
    lossKeys: r01LossKeys(s.subjectKey, cc),
    overlap: [],
    nextAction,
    explanation,
    flags,
    boundFacts: r01BoundFacts(s, cc),
  };
}

// ---------------------------------------------------------------------------
// Auto-open decision (the `openCase` guard for R01 auto-open; §2.8 recordCheck order)
// ---------------------------------------------------------------------------

export interface R01AutoOpen {
  opens: boolean;
  amountMinor?: number;
  currency?: string;
  windowEndsAt?: number;
  /** The legacy `recordCheck` note when nothing opens. */
  note?: string;
}

/**
 * Whether an evaluation auto-opens a claim. Auto-open is limited to eligible/likely_eligible with an amount, so it
 * stays closed past the window (R01-05c), for not_yet_due and for every non-approvable outcome. An open claim on the
 * item blocks a second one (duplicate evaluation, R01-12). After a denial (DA-A-22, wave 2) only a strictly lower
 * observation whose difference clears the per-unit threshold opens, for the difference only.
 */
export function r01AutoOpen(
  result: EvaluationResult,
  guard: { openClaimExists: boolean; deniedObservedMinor?: number; observedMinor?: number; unitMinor?: number },
  p: R01Params = R01_V1_PARAMS,
): R01AutoOpen {
  if (result.outcome === "deadline_passed" || result.outcome === "source_unverified") return { opens: false, note: "No open price window" };
  if (result.outcome === "not_eligible") {
    const failed = (id: string) => result.conditions.some((c) => c.id === id && c.result === "fail");
    // A returned item has no open price window (legacy `watchWindow` wording), whatever the drop (M18 N4).
    if (failed("r01.v1.item_not_returned")) return { opens: false, note: "No open price window" };
    return { opens: false, note: failed("r01.v1.not_already_claimed") ? "Drop already claimed" : "Drop below threshold" };
  }
  if (result.outcome === "unsupported") return { opens: false, note: "Currency not supported for price adjustments" };
  if (result.outcome !== "eligible" && result.outcome !== "likely_eligible") return { opens: false };
  if (guard.openClaimExists) return { opens: false, note: "Claim already open" };
  if (result.amount === null) return { opens: false };
  if (guard.deniedObservedMinor !== undefined) {
    const { observedMinor, unitMinor } = guard;
    if (observedMinor === undefined || unitMinor === undefined || observedMinor >= guard.deniedObservedMinor) return { opens: false, note: "Denied for this drop" };
    const perUnitThreshold = Math.max(p.thresholdFloorMinor, Math.round(unitMinor * (p.thresholdPercent / 100)));
    if (guard.deniedObservedMinor - observedMinor < perUnitThreshold) return { opens: false, note: "Denied for this drop" };
  }
  const window = result.deadlines.find((d) => d.id === R01_V1_WINDOW_ID);
  const windowEndsAt = window?.dueAt ?? (window?.advisoryActBy ? Date.parse(window.advisoryActBy) : undefined);
  return {
    opens: true,
    amountMinor: result.amount.estimate.amountMinor,
    currency: result.amount.estimate.currency,
    ...(windowEndsAt !== undefined && Number.isFinite(windowEndsAt) ? { windowEndsAt } : {}),
  };
}

/** C1: `drafts.prepareSend` answers such a claim with the acknowledgeable `window_may_have_passed`. */
export function r01LateAskAcknowledgeable(evaluation: Pick<EvaluationResult, "outcome" | "deadlines" | "conditions">): boolean {
  return isLateAskAcknowledgeable(evaluation, R01_V1_ACKNOWLEDGEABLE);
}

export const r01PriceAdjustmentV1: RulePack<R01Snapshot, R01Params, R01CaseContext> = {
  ruleId: R01_V1_RULE_ID,
  scenarioId: "R01",
  version: R01_V1_VERSION,
  // Informative only: the lead's activation entry + the manifest decide status (M18 N6).
  lifecycle: "researched",
  authority: { class: "merchant_promise", subtype: "merchant published price-adjustment policy (legacy snapshot tier)" },
  jurisdiction: "US (per merchant)",
  categories: ["retail_order"],
  remedyKey: R01_REMEDY_KEY,
  remedyType: "price_difference",
  cashClass: "cash",
  params: R01_V1_PARAMS,
  // D145 d: R01 v1's framework logic cites no external legal source; its parameter source is the policy snapshot.
  sources: [],
  requirements: [
    { subjectPattern: "txn", key: "retail.purchase_date", class: "required" },
    { subjectPattern: "item:*", key: "retail.unit_price", class: "required" },
    { subjectPattern: "item:*", key: "retail.quantity", class: "required" },
    { subjectPattern: "item:*", key: "retail.observed_price", class: "required" },
    { subjectPattern: "txn", key: "retail.window_days", class: "required" },
    { subjectPattern: "txn", key: "retail.policy_confirmed", class: "assumption", assumptionText: "the store's policy text is the one Recoup found" },
    { subjectPattern: "txn", key: "retail.policy_temporal", class: "assumption", assumptionText: "the policy text found is the policy in force on the purchase date (A-T1/A-T2)" },
    { subjectPattern: "txn", key: "retail.currency", class: "assumption", assumptionText: "the purchase currency read from the order is right (DA-A-33)" },
  ],
  fixturesPath: "docs/rules/fixtures/R01.json",
  lateAskDeadlineIds: [R01_V1_WINDOW_ID],
  overlap: [],
  knownLimitations: [
    "L1: legacy per-purchase policy snapshots are not versioned packs; the best outcome is likely_eligible.",
    "Windows are whole 24-hour periods from the purchase instant, not calendar days (O15); R01 v2 (M37) reads calendar days.",
    "Which event must fall inside the window (drop, request or both) is not modelled in v1 (M09 R01.6-2, implemented in R01 v2); the late send is warned, never refused.",
    "Two-decimal currencies only (D160).",
    "Merchants may pay an adjustment by credit rather than cash (e.g. Apple AP-1 'refund or credit'); v1 counts it as cash (cashClass, legacy parity) — R01 v2's remedy_form resolves it.",
    "Only a vetted price check is an accepted observation; an extracted or user-entered price never drives an amount (contract §2.7).",
  ],
  evaluate: evaluateR01V1,
};
