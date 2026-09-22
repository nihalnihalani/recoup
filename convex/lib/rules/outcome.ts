/**
 * Outcome derivation (contract rev 5.5 §4). Pure: no ctx, no clock, no randomness, no `lib/ai`.
 *
 * `deriveOutcome` is the ONLY way an evaluator produces an outcome. Precedence (first match wins):
 *
 *   1  f.unsupportedReason                                   → unsupported
 *   2  f.sourceStale || f.sourceMissing || f.effectiveDateMismatch → source_unverified
 *   3  d.applies = fail                                      → not_eligible   (from known facts only)
 *   4  d.windowOpen = fail                                   → deadline_passed (USER deadlines only, DA-A-5)
 *   4b f.notYetDue                                           → not_yet_due    (never not_eligible; D147(6))
 *   5a f.manualReviewReason, or any conflict of kind confirmed_vs_observed / confirmed_vs_confirmed → manual_review
 *   5b any candidates conflict whose values give different answers (outcome or amount) → needs_facts
 *   5c every conflict is a same-answer candidates conflict   → the rules below decide, then CAPPED at likely_eligible
 *   6  d.applies = unknown || d.factsKnown ≠ pass              → needs_facts    (required-class facts only; a
 *                                                              `factsKnown: fail`, which no pack should produce, fails
 *                                                              closed here rather than falling through to eligible)
 *   7  f.contractCoverageInexact                             → possible_contract_benefit
 *   8  d.evidenceSupports ≠ pass || any assumption            → likely_eligible (DA-A-2: assumption-only row; also when
 *      || d.windowOpen = unknown                                  a user window cannot be computed, e.g. beyond_calendar:
 *                                                                 never eligible, never needs_facts by itself)
 *   9  otherwise                                             → eligible
 *
 * For 5c the caller passes the dimensions of a candidate evaluation (every candidate gave the same answer), so rules
 * 6–9 see known facts; `evaluateWithCandidates` does exactly that.
 */
import { canonicalHash } from "../canonical";
import {
  isApprovable,
  type AmountCalc,
  type Assumption,
  type ConflictFlag,
  type Dimensions,
  type EvaluationResult,
  type Flags,
  type NextAction,
  type Outcome,
  type RuleSourceMeta,
} from "./types";

export { APPROVABLE_OUTCOMES, isApprovable } from "./types";

/** Rule 5c: an eligible outcome is capped at likely_eligible; every other outcome stands. */
export function capAtLikelyEligible(outcome: Outcome): Outcome {
  return outcome === "eligible" ? "likely_eligible" : outcome;
}

function rulesSixToNine(d: Dimensions, f: Flags, assumptions: readonly Assumption[]): Outcome {
  if (d.applies === "unknown" || d.factsKnown !== "pass") return "needs_facts";
  if (f.contractCoverageInexact) return "possible_contract_benefit";
  if (d.evidenceSupports !== "pass" || assumptions.length > 0 || d.windowOpen !== "pass") return "likely_eligible";
  return "eligible";
}

export function deriveOutcome(d: Dimensions, f: Flags, assumptions: readonly Assumption[]): Outcome {
  if (f.unsupportedReason) return "unsupported";
  if (f.sourceStale || f.sourceMissing || f.effectiveDateMismatch) return "source_unverified";
  if (d.applies === "fail") return "not_eligible";
  if (d.windowOpen === "fail") return "deadline_passed";
  if (f.notYetDue) return "not_yet_due";
  if (f.manualReviewReason || f.conflicts.some((c) => c.kind !== "candidates")) return "manual_review";
  if (f.conflicts.some((c) => !c.sameAnswer)) return "needs_facts";
  const outcome = rulesSixToNine(d, f, assumptions);
  return f.conflicts.length > 0 ? capAtLikelyEligible(outcome) : outcome;
}

/** Which precedence rule decided (for explanations and tests). */
export function decidingRule(d: Dimensions, f: Flags, assumptions: readonly Assumption[]): string {
  if (f.unsupportedReason) return "1";
  if (f.sourceStale || f.sourceMissing || f.effectiveDateMismatch) return "2";
  if (d.applies === "fail") return "3";
  if (d.windowOpen === "fail") return "4";
  if (f.notYetDue) return "4b";
  if (f.manualReviewReason || f.conflicts.some((c) => c.kind !== "candidates")) return "5a";
  if (f.conflicts.some((c) => !c.sameAnswer)) return "5b";
  if (d.applies === "unknown" || d.factsKnown !== "pass") return f.conflicts.length > 0 ? "5c/6" : "6";
  if (f.contractCoverageInexact) return f.conflicts.length > 0 ? "5c/7" : "7";
  if (d.evidenceSupports !== "pass" || assumptions.length > 0 || d.windowOpen !== "pass") return f.conflicts.length > 0 ? "5c/8" : "8";
  return f.conflicts.length > 0 ? "5c" : "9";
}

// ---------------------------------------------------------------------------
// Candidate testing (rule 5, D152/D154/D158)
// ---------------------------------------------------------------------------

/** "Same answer" = same outcome AND same amount (identical estimate amountMinor + currency, or both null). */
export function sameAnswer(
  answers: readonly { outcome: Outcome; amount: Pick<AmountCalc, "estimate"> | null }[],
): boolean {
  if (answers.length === 0) return true;
  const key = (a: (typeof answers)[number]) =>
    `${a.outcome}|${a.amount === null ? "null" : `${a.amount.estimate.amountMinor} ${a.amount.estimate.currency}`}`;
  const first = key(answers[0]);
  return answers.every((a) => key(a) === first);
}

/** The cartesian product of per-key candidate choices, bounded (a larger product is not testable → not same answer). */
export const MAX_CANDIDATE_COMBINATIONS = 16;

export function candidateCombinations<T>(choices: readonly (readonly T[])[]): T[][] | null {
  let total = 1;
  for (const c of choices) {
    total *= Math.max(c.length, 1);
    if (total > MAX_CANDIDATE_COMBINATIONS) return null;
  }
  let combos: T[][] = [[]];
  for (const c of choices) {
    const next: T[][] = [];
    for (const prefix of combos) for (const v of c) next.push([...prefix, v]);
    combos = next;
  }
  return combos;
}

/** Marks every flag with the combined same-answer verdict. */
export function withSameAnswer(conflicts: readonly Omit<ConflictFlag, "sameAnswer">[], same: boolean): ConflictFlag[] {
  return conflicts.map((c) => ({ ...c, sameAnswer: c.kind === "candidates" ? same : false }));
}

// ---------------------------------------------------------------------------
// Next action and freshness helpers
// ---------------------------------------------------------------------------

/** rev 5.4 (D154): a `not_yet_due` path's next action — the user's own action when they control it, else wait. */
export function notYetDueAction(n: NonNullable<Flags["notYetDue"]>): NextAction {
  if (n.userAction) return n.userAction;
  return { kind: "wait", reevaluate: { ...(n.at !== undefined ? { at: n.at } : {}), ...(n.when !== undefined ? { when: n.when } : {}) } };
}

const DAY_MS = 86_400_000;

/**
 * README rule 3: a pack evaluated after one of its sources' refresh window (from the lead-owned
 * `verification.ts` date) is stale → `source_unverified`. A source with a refresh window and no verification record
 * is stale too (never verified). Sources without a refresh window (e.g. R01 v1, D145 d) never go stale here.
 */
export function sourceStale(
  sources: readonly RuleSourceMeta[],
  verification: Readonly<Record<string, { lastVerifiedAt: string }>>,
  now: number,
): { stale: boolean; staleSourceIds: string[] } {
  const staleSourceIds: string[] = [];
  for (const s of sources) {
    if (s.refreshWindowDays === undefined) continue;
    const v = verification[s.sourceId];
    const at = v ? Date.parse(`${v.lastVerifiedAt}T00:00:00Z`) : Number.NaN;
    if (!Number.isFinite(at) || now > at + s.refreshWindowDays * DAY_MS) staleSourceIds.push(s.sourceId);
  }
  return { stale: staleSourceIds.length > 0, staleSourceIds: [...new Set(staleSourceIds)] };
}

// ---------------------------------------------------------------------------
// resultHash (§4, DA-A-32; N6)
// ---------------------------------------------------------------------------

/**
 * The outcome-bearing projection of a result. `snapshotHash`, explanations, labels and notes are excluded, so an
 * unchanged answer never writes a new evaluation row; `boundFactsHash` is included (N6) so stored `boundFacts` are
 * never stale.
 */
export function resultHashInput(r: EvaluationResult, boundFactsHashValue: string) {
  return {
    outcome: r.outcome,
    dimensions: r.dimensions,
    conditions: r.conditions.map((c) => ({ id: c.id, result: c.result })),
    missingFacts: r.missingFacts.map((m) => ({ subjectKey: m.subjectKey, key: m.key, reason: m.reason, class: m.class })),
    assumptions: r.assumptions.map((a) => a.id),
    amount: r.amount === null ? null : { estimate: r.amount.estimate, basis: r.amount.basis },
    deadlines: r.deadlines.map((d) => ({
      id: d.id, status: d.status, dueAt: d.dueAt ?? null, overdueSince: d.overdueSince ?? null, advisoryActBy: d.advisoryActBy ?? null,
    })),
    nextAction: r.nextAction.kind,
    ruleVersion: r.ruleVersion,
    engineVersion: r.engineVersion,
    boundFactsHash: boundFactsHashValue,
  };
}

export async function resultHash(r: EvaluationResult, boundFactsHashValue: string): Promise<string> {
  return await canonicalHash(resultHashInput(r, boundFactsHashValue));
}

/** Approvable-set membership for materiality (§2.8): leaving the set is material unless the late ask is acknowledgeable. */
export function leavesApprovableSet(previous: Outcome, next: Outcome): boolean {
  return isApprovable(previous) && !isApprovable(next);
}
