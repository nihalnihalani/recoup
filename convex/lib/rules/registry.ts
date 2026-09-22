/**
 * The PRODUCTION rule-pack registry (contract §2.7, D145 DA-A-11 (c)). It returns a pack only when the lead-owned
 * `activation.ts` marks that exact (ruleId, version) `active` — the last entry for a (ruleId, version) wins, so a
 * withdrawal is an appended entry. "Active" means independently reviewed against the captured first-party text,
 * never legal certification. No opportunity card exists without an active pack.
 *
 * Tests reach unactivated packs only through `testRegistry.ts`, injected with
 * `vi.mock("./lib/rules/registry", () => import("./lib/rules/testRegistry"))` (C3); `registry.test.ts` fails if any
 * non-test file imports the test registry.
 */
import { ACTIVATIONS } from "./activation";
import { effectiveActivations, IMPLEMENTED_PACKS, packKey, resolveActivePacks } from "./applicable";
import type { AnyRulePack, ScenarioId, TransactionCategory } from "./types";

export { effectiveActivations, IMPLEMENTED_PACKS, resolveActivePacks } from "./applicable";
export const REGISTRY_KIND: "production" | "test" = "production";

export function activePacks(): AnyRulePack[] {
  return resolveActivePacks(ACTIVATIONS, IMPLEMENTED_PACKS);
}

export function isPackActive(ruleId: string, version: number): boolean {
  return activePacks().some((p) => p.ruleId === ruleId && p.version === version);
}

/** The active pack of a scenario (the highest active version), or null. */
export function activePack(scenarioId: ScenarioId): AnyRulePack | null {
  const found = activePacks().filter((p) => p.scenarioId === scenarioId).sort((a, b) => b.version - a.version);
  return found[0] ?? null;
}

export function activePacksForCategory(category: TransactionCategory): AnyRulePack[] {
  return activePacks().filter((p) => p.categories.includes(category));
}

/** The DECISIONS id that activated a pack (null when not active). */
export function activationDecision(ruleId: string, version: number): string | null {
  const a = effectiveActivations(ACTIVATIONS).get(packKey(ruleId, version));
  return a?.status === "active" ? a.decision : null;
}
