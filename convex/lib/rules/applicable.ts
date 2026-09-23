/**
 * Which rule packs exist and which scenarios concern which transaction category. Data only — no activation logic
 * (that is `registry.ts`, production, or `testRegistry.ts`, tests) — so the registries and `coverage.ts` can share
 * one pack list without importing each other.
 */
import type { Activation } from "./activation";
import { r01PriceAdjustmentV1 } from "./r01_price_adjustment_v1";
import { r02AirRefundV1 } from "./r02_air_refund_v1";
import { r04BagFeeRefundV1, r04DelayedBagExpensesV1, r04PropertyLossV1 } from "./r04_baggage_v1";
import { r05LateOrderV1 } from "./r05_late_order_v1";
import type { AnyRulePack, ScenarioId, TransactionCategory } from "./types";

/**
 * Every implemented pack version, whatever its lifecycle. Nothing in production evaluates from this list directly:
 * only packs that `activation.ts` marks active are returned by the production registry. Old versions stay here so
 * historical evaluations remain explainable (contract §8 (d)).
 */
export const IMPLEMENTED_PACKS: readonly AnyRulePack[] = Object.freeze([
  r01PriceAdjustmentV1,
  r02AirRefundV1,
  r04BagFeeRefundV1,
  r04DelayedBagExpensesV1,
  r04PropertyLossV1,
  r05LateOrderV1,
]);

/**
 * The scenarios a transaction of each category could involve — the rows of its "Paths not checked / source not
 * verified" list when no active pack evaluates them (§9, D145 d). The iPhone acceptance case (mission §12) is a
 * retail order: R01 price adjustment, R05 late shipment, the card benefits R06–R08 (exact guide needed), R10
 * warranty, R11 recall (never asks for a serial just to list it) and R23 class settlements.
 */
export const SCENARIOS_BY_CATEGORY: Readonly<Record<TransactionCategory, readonly ScenarioId[]>> = Object.freeze({
  retail_order: ["R01", "R05", "R06", "R07", "R08", "R10", "R11", "R23"],
  air_travel: ["R02", "R04", "R09", "R12", "R14", "R15"],
  card_charge: ["R03", "R13"],
});

/** `${ruleId}@${version}` — the activation key. */
export function packKey(ruleId: string, version: number): string {
  return `${ruleId}@${version}`;
}

/** The effective status per (ruleId, version): the LAST entry wins, so a withdrawal is an appended entry. */
export function effectiveActivations(list: readonly Activation[]): Map<string, Activation> {
  const out = new Map<string, Activation>();
  for (const a of list) out.set(packKey(a.ruleId, a.version), a);
  return out;
}

/** Pure: the implemented packs an activation list makes active. */
export function resolveActivePacks(activations: readonly Activation[], packs: readonly AnyRulePack[]): AnyRulePack[] {
  const eff = effectiveActivations(activations);
  return packs.filter((p) => eff.get(packKey(p.ruleId, p.version))?.status === "active");
}
