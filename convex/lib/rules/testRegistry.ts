/**
 * TEST-ONLY rule-pack registry (contract §2.7, D145 DA-A-11 (c), rev 5 C3). Same exports as `registry.ts`, but every
 * implemented pack is active unless a test narrows it with `setTestActivations`. Only `*.test.ts` files may import
 * this module (`registry.test.ts` greps the tree); production never sees a pack that `activation.ts` has not
 * activated, and `coverage.ts` never reads either registry.
 *
 * The seam, in a test file:
 *   vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
 *   import { setTestActivations, resetTestRegistry } from "./lib/rules/testRegistry";
 *
 * It does NOT import `registry.ts` (that module is the one being replaced).
 */
import type { Activation } from "./activation";
import { IMPLEMENTED_PACKS, resolveActivePacks } from "./applicable";
import type { AnyRulePack, ScenarioId, TransactionCategory } from "./types";

export { effectiveActivations, IMPLEMENTED_PACKS, resolveActivePacks } from "./applicable";
export const REGISTRY_KIND: "production" | "test" = "test";

let override: readonly Activation[] | null = null;

/** Narrow (or widen) what the test registry treats as active. The LAST entry per (ruleId, version) wins. */
export function setTestActivations(list: readonly Activation[]): void {
  override = [...list];
}

/** Back to "every implemented pack is active". */
export function resetTestRegistry(): void {
  override = null;
}

export function activePacks(): AnyRulePack[] {
  if (override === null) return [...IMPLEMENTED_PACKS];
  return resolveActivePacks(override, IMPLEMENTED_PACKS);
}

export function isPackActive(ruleId: string, version: number): boolean {
  return activePacks().some((p) => p.ruleId === ruleId && p.version === version);
}

export function activePack(scenarioId: ScenarioId): AnyRulePack | null {
  const found = activePacks().filter((p) => p.scenarioId === scenarioId).sort((a, b) => b.version - a.version);
  return found[0] ?? null;
}

export function activePacksForCategory(category: TransactionCategory): AnyRulePack[] {
  return activePacks().filter((p) => p.categories.includes(category));
}

export function activationDecision(ruleId: string, version: number): string | null {
  return isPackActive(ruleId, version) ? "TEST" : null;
}
