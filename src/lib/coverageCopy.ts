/**
 * What Recoup may say it checks (M2A; mission §20; contract §11.2 row M2A). Every coverage claim in product copy is
 * derived HERE from the same data the server's coverage report reads, never typed by hand on a page:
 *
 *   - `convex/lib/rules/activation.ts` (lead-owned; the production registry resolves active packs from it), and
 *   - `convex/lib/rules/verification.ts` `LIVE_VERIFICATIONS` (D196: an active pack is "checked, live verification
 *     pending" until a live-verification record promotes it).
 *
 * Both are data-only modules, so the browser bundle never pulls in the rule engine. `coverageCopy.test.ts` proves this
 * derivation equals `coverage.ts` `coverageRows()` for all 25 scenarios, and scans the product copy (landing page,
 * dashboard, /add, /opportunities, Privacy, index.html, README.md, hackathon.md) so no page claims a path the
 * registry does not evaluate, or guaranteed recovery, legal representation, automatic resolution or billing.
 *
 * The house phrase is "checks supported recovery paths", never "checks every right".
 */
import { ACTIVATIONS } from "../../convex/lib/rules/activation";
import { LIVE_VERIFICATIONS } from "../../convex/lib/rules/verification";
import { SCENARIO_TITLES, type ScenarioId } from "./scenarioTitles";

/** The one sentence every coverage claim starts from (§20). */
export const COVERAGE_PROMISE = "Recoup checks supported recovery paths";

/**
 * Plain words for what a checked scenario looks at, for landing and intake copy. Only scenarios that can be active
 * need one; the test fails if an active scenario has none.
 */
export const CHECK_WORDS: Readonly<Partial<Record<ScenarioId, string>>> = {
  R01: "a lower price inside a store's own price-adjustment window",
  R02: "an airline refund after a cancellation or a significant schedule change",
  R03: "a card billing error you can dispute with your card issuer",
  R04: "a refund of a bag fee, or expenses, for a delayed, lost or damaged bag",
  R05: "a refund for an online order that did not ship on time",
};

export type CheckedScenario = {
  scenarioId: ScenarioId;
  title: string;
  ruleId: string;
  version: number;
  /** D196: false until the lead records a live verification of this pack version. */
  liveVerified: boolean;
};

/** The ruleId's scenario prefix ("R01.retail_price_adjustment" → "R01"), or null for anything else. */
function scenarioOf(ruleId: string): ScenarioId | null {
  const prefix = ruleId.split(".")[0];
  return Object.prototype.hasOwnProperty.call(SCENARIO_TITLES, prefix) ? (prefix as ScenarioId) : null;
}

/**
 * The scenarios the production registry evaluates today, one row each (the newest active version), in scenario
 * order. An activation's LAST entry per (ruleId, version) wins, so a withdrawal removes it.
 */
export function checkedScenarios(
  activations: typeof ACTIVATIONS = ACTIVATIONS,
  liveVerifications: typeof LIVE_VERIFICATIONS = LIVE_VERIFICATIONS,
): CheckedScenario[] {
  const last = new Map<string, (typeof activations)[number]>();
  for (const entry of activations) last.set(`${entry.ruleId}\u0000${entry.version}`, entry);
  const best = new Map<ScenarioId, CheckedScenario>();
  for (const entry of last.values()) {
    if (entry.status !== "active") continue;
    const scenarioId = scenarioOf(entry.ruleId);
    if (scenarioId === null) continue;
    const current = best.get(scenarioId);
    if (current && current.version >= entry.version) continue;
    best.set(scenarioId, {
      scenarioId,
      title: SCENARIO_TITLES[scenarioId],
      ruleId: entry.ruleId,
      version: entry.version,
      liveVerified: liveVerifications.some(
        (r) =>
          r.ruleId === entry.ruleId && r.version === entry.version && /^\d{4}-\d{2}-\d{2}$/.test(r.verifiedOn) &&
          /^D\d+$/.test(r.decision) && r.deployment.trim() !== "" && r.evidence.trim() !== "",
      ),
    });
  }
  return [...best.values()].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

/**
 * One or two sentences for the landing page and the intake hub: the promise, then exactly what is checked today,
 * and, while any check awaits live verification, that it does. Never a scenario the registry does not evaluate.
 */
export function coverageSummary(checked: readonly CheckedScenario[] = checkedScenarios()): string {
  if (checked.length === 0) return `${COVERAGE_PROMISE}. None is switched on yet.`;
  const words = checked.map((c) => CHECK_WORDS[c.scenarioId] ?? c.title.toLowerCase());
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join("; ")}; and ${words[words.length - 1]}`;
  const pending = checked.some((c) => !c.liveVerified)
    ? ` ${checked.length === 1 ? "This check is" : "These checks are"} tested; live verification is still pending.`
    : "";
  return `${COVERAGE_PROMISE}. Today that means ${list}.${pending}`;
}
