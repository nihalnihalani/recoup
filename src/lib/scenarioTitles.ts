import type { Doc } from "../../convex/_generated/dataModel";

export type ScenarioId = Doc<"opportunities">["scenarioId"];

/**
 * Scenario titles, as `convex/lib/rules/coverage.ts` `SCENARIO_TITLES` names them. Copied because that module pulls
 * the rule engine into the browser bundle; `model.test.ts` compares the two maps so they cannot drift.
 */
export const SCENARIO_TITLES: Readonly<Record<ScenarioId, string>> = {
  R01: "Retail price adjustment",
  R02: "Airline cancellation or significant-change refund",
  R03: "Credit-card billing error",
  R04: "Delayed, lost or damaged baggage",
  R05: "Late or missing online order",
  R06: "Card purchase protection",
  R07: "Card return protection",
  R08: "Card extended warranty",
  R09: "Involuntary denied boarding",
  R10: "Warranty defect",
  R11: "Product recall or service program",
  R12: "Card trip-delay or trip-cancellation benefit",
  R13: "Debit, ATM or bank transfer error",
  R14: "Airline extra service not provided",
  R15: "Airline commitment after a controllable disruption",
  R16: "Subscription renewal or cancellation",
  R17: "Surprise medical bill",
  R18: "Vehicle recall",
  R19: "Cancelled event or undelivered service",
  R20: "Hotel best-rate guarantee",
  R21: "Outage or missed-appointment credit",
  R22: "Regulator refund program",
  R23: "Class-action settlement",
  R24: "Unclaimed property",
  R25: "Small-business shipping or service guarantee",
};

