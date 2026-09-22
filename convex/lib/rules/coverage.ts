/**
 * Scenario coverage (contract §2.7, §9; D145 DA-A-11 (c)/(d)). Reads the lead-owned `activation.ts` DIRECTLY — never
 * `registry.ts` or `testRegistry.ts` — so a coverage row can reach `implemented_verified` only from a pack the lead
 * activated, even when a test mocks the registry. No row carries an amount: the "Paths not checked / source not
 * verified" list is honest coverage, not an estimate.
 */
import { ACTIVATIONS } from "./activation";
import { IMPLEMENTED_PACKS, resolveActivePacks, SCENARIOS_BY_CATEGORY } from "./applicable";
import type { ScenarioId, TransactionCategory } from "./types";

export type CoverageStatus = "implemented_verified" | "not_checked";

export interface CoverageRow {
  scenarioId: ScenarioId;
  title: string;
  status: CoverageStatus;
  /** Why the path is not checked (or which pack checks it). Plain language, no amounts. */
  reason: string;
  ruleId?: string;
  version?: number;
}

export const SCENARIO_TITLES: Readonly<Record<ScenarioId, string>> = Object.freeze({
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
});

/** Why each scenario is not checked while no active pack evaluates it (docs/team/RULES-COVERAGE.md, TRIAGE). */
const NOT_CHECKED: Readonly<Record<ScenarioId, string>> = Object.freeze({
  R01: "Rule researched and reviewed; waiting for activation.",
  R02: "Rule researched from DOT regulations; not activated yet.",
  R03: "Rule researched from Regulation Z; not activated yet.",
  R04: "Rule researched from DOT regulations; not activated yet.",
  R05: "Rule researched from the FTC mail-order rule; not activated yet.",
  R06: "Needs the exact benefit guide for your card; never inferred from the card network.",
  R07: "Needs the exact benefit guide for your card; never inferred from the card network.",
  R08: "Needs the exact benefit guide for your card; never inferred from the card network.",
  R09: "Not checked yet.",
  R10: "Needs the product's written warranty; not checked yet.",
  R11: "Recall matching is not checked yet; Recoup will not ask for a serial number just to list it.",
  R12: "Needs the exact benefit guide for your card; never inferred from the card network.",
  R13: "Not checked yet.",
  R14: "Not checked yet.",
  R15: "Carrier commitments are not checked yet.",
  R16: "Not checked yet.",
  R17: "Not available.",
  R18: "Not checked yet.",
  R19: "Not checked.",
  R20: "Not checked.",
  R21: "Not checked.",
  R22: "Not checked.",
  R23: "Settlement matching is not checked; a name match is not class membership.",
  R24: "Not checked.",
  R25: "Not checked.",
});

const ALL_SCENARIOS = Object.keys(SCENARIO_TITLES) as ScenarioId[];

/** One row per scenario R01–R25, from `activation.ts` only. */
export function coverageRows(): CoverageRow[] {
  const active = resolveActivePacks(ACTIVATIONS, IMPLEMENTED_PACKS);
  return ALL_SCENARIOS.map((scenarioId) => {
    const pack = active.filter((p) => p.scenarioId === scenarioId).sort((a, b) => b.version - a.version)[0];
    return pack
      ? {
          scenarioId, title: SCENARIO_TITLES[scenarioId], status: "implemented_verified" as const,
          reason: `Checked by ${pack.ruleId} v${pack.version}.`, ruleId: pack.ruleId, version: pack.version,
        }
      : { scenarioId, title: SCENARIO_TITLES[scenarioId], status: "not_checked" as const, reason: NOT_CHECKED[scenarioId] };
  });
}

/** The "Paths not checked / source not verified" list for a transaction category: relevant scenarios with no active pack. */
export function pathsNotChecked(category: TransactionCategory): CoverageRow[] {
  const relevant = new Set(SCENARIOS_BY_CATEGORY[category]);
  return coverageRows().filter((r) => relevant.has(r.scenarioId) && r.status === "not_checked");
}
