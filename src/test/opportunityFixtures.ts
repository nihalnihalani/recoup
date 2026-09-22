/**
 * Hand-written opportunity/evaluation rows for component tests (M15). Shapes are the real `Doc<>` types, so a
 * schema change breaks these fixtures at compile time instead of letting a test render a shape the server can no
 * longer produce. Values are written by hand, never produced by the code under test.
 */
import type { Doc, Id } from "../../convex/_generated/dataModel";
import type { OpportunityView } from "../components/opportunity/model";

export const NOW = Date.UTC(2026, 8, 23, 15);
const DAY = 86_400_000;

export function evaluationRow(overrides: Partial<Doc<"evaluations">> = {}): Doc<"evaluations"> {
  return {
    _id: "e1" as Id<"evaluations">,
    _creationTime: NOW - DAY,
    userId: "u1" as Id<"users">,
    opportunityId: "o1" as Id<"opportunities">,
    scenarioId: "R01",
    ruleId: "R01-price-adjustment",
    ruleVersion: 1,
    engineVersion: "1",
    factSnapshotHash: "f",
    resultHash: "r",
    evaluatedAt: NOW - DAY,
    trigger: "observation",
    outcome: "eligible",
    dimensions: {
      applies: "pass",
      factsKnown: "pass",
      evidenceSupports: "pass",
      windowOpen: "pass",
      amountCalculable: "pass",
      readyForApproval: "pass",
    },
    conditions: [],
    missingFacts: [],
    assumptions: [],
    disqualifierIds: [],
    amount: {
      estimate: { amountMinor: 2_500, currency: "USD" },
      basis: "exact_formula",
      formula: "(12,500 - 10,000) x 1",
      inputs: [],
    },
    deadlines: [],
    sourceRefs: [
      { sourceId: "policy:p1", passageId: "policy_snapshot.windowDays", url: "https://www.northwind.example/price-match", effective: "unknown" },
    ],
    overlap: [],
    nextAction: { kind: "open_case" },
    explanation: ["Estimated adjustment USD 25.00: (12,500 - 10,000) x 1 (minor units).", "The price fell within the store's window."],
    ...overrides,
  };
}

export function opportunityRow(overrides: Partial<Doc<"opportunities">> = {}): Doc<"opportunities"> {
  return {
    _id: "o1" as Id<"opportunities">,
    _creationTime: NOW - 2 * DAY,
    userId: "u1" as Id<"users">,
    transactionId: "t1" as Id<"transactions">,
    scenarioId: "R01",
    remedyKey: "price_difference",
    subjectKey: "item:i1",
    dedupeKey: "t1|R01|price_difference|item:i1|-",
    status: "open",
    currentEvaluationId: "e1" as Id<"evaluations">,
    ruleId: "R01-price-adjustment",
    ruleVersion: 1,
    outcome: "eligible",
    authorityClass: "merchant_promise",
    remedyType: "price_difference",
    cashClass: "cash",
    estimate: { amountMinor: 2_500, currency: "USD" },
    lossKeys: ["item:i1:price_diff:1"],
    lastEvaluatedAt: NOW - DAY,
    ...overrides,
  };
}

export function view(
  evaluation: Partial<Doc<"evaluations">> | null = {},
  opportunity: Partial<Doc<"opportunities">> = {},
): OpportunityView {
  const e = evaluation === null ? null : evaluationRow(evaluation);
  return { opportunity: opportunityRow({ ...(e ? { outcome: e.outcome } : {}), ...opportunity }), evaluation: e };
}
