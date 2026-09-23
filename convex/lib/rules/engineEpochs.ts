/**
 * Engine epochs — LEAD-CONTROLLED DATA (D206(3), refining D197). One entry per manifest pack entry that records an
 * `engineEpoch`; `scripts/check-rule-packs.mjs` parses this initializer as a pure literal and requires it to equal the
 * manifest EXACTLY ({ruleId, version, engineEpoch, engineClosureSha256}), so the runtime can never drift from the
 * pinned closure and nothing outside convex/ is bundled.
 *
 * The runtime engine version of a pack is `${ruleId}@v${version}/e${engineEpoch}` (`engineVersion.ts`). It is recorded
 * on every evaluation and approval binding; a change is MATERIAL (§2.8) and invalidates approvals. Only a BEHAVIOURAL
 * re-pin (its decision says so) increments the epoch; a hash-only re-pin (e.g. D204: a new file in the closure that
 * changes no result) updates `engineClosureSha256` here and in the manifest and keeps the epoch, so no approval breaks.
 *
 * Data only: no imports, spreads, identifiers or calls in the initializer.
 */
export type EngineEpoch = { ruleId: string; version: number; engineEpoch: number; engineClosureSha256: string };

export const ENGINE_EPOCHS: readonly EngineEpoch[] = [
  { ruleId: "R01.retail_price_adjustment", version: 1, engineEpoch: 2, engineClosureSha256: "a5c2cda0b9a0448eee0a0171deae12ae045e548a25f32c71ff8f7a2d6c37f72b" },
];
