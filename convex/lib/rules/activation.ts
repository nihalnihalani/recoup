/**
 * Rule-pack activation — LEAD-OWNED DATA (D146 R4-4, D160, D163). Created once, empty, by M12; after that only the
 * lead edits this file, together with a DECISIONS activation/withdrawal entry. `scripts/check-rule-packs.mjs` (M19)
 * parses the initializer as a pure literal and checks it against `docs/rules/manifest.json` and DECISIONS.
 *
 * - Append-only: one entry per activation or withdrawal. When the same (ruleId, version) appears more than once,
 *   the LAST entry wins, so a withdrawal is an append (`status: "withdrawn"`), never an edit.
 * - `ruleId` and `version` must match a manifest pack AND an implemented pack in `lib/rules/registry.ts`.
 * - `decision` is the DECISIONS id that recorded it, e.g. "D170".
 * - "active" means independently reviewed against the captured first-party text (D145 DA-A-11) — never legal
 *   certification. Only the production registry reads this file; tests use `lib/rules/testRegistry.ts`.
 *
 * Data only: no imports, spreads, identifiers or calls in the initializer.
 */
export type Activation = { ruleId: string; version: number; status: "active" | "withdrawn"; decision: string };

export const ACTIVATIONS: readonly Activation[] = [
  { ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "D186" },
];
