/**
 * Source verification record — LEAD-OWNED DATA (D146 R4-4, D160, D163). Created once, empty, by M12; after that only
 * the lead edits this file, after running `scripts/verify-rule-sources.mjs` (or a recorded manual browser check for
 * sites that refuse non-browser clients). `scripts/check-rule-packs.mjs` (M19) parses the initializer as a pure literal.
 *
 * Keys are manifest `sourceId`s or merchant-pack ruleIds. `lastVerifiedAt` is "YYYY-MM-DD". A pack evaluated past a
 * source's refresh window after this date is `source_unverified` (README rule 3, `lib/rules/outcome.sourceStale`).
 *
 * Data only: no imports, spreads, identifiers or calls in the initializer.
 */
export type SourceVerification = { lastVerifiedAt: string; sha256: string; method?: "fetch" | "browser" };

export const VERIFICATION: Readonly<Record<string, SourceVerification>> = {};

/**
 * Live verification of an ACTIVE pack on a real deployment (DA-B-14, D196) — LEAD-OWNED DATA after M12e. The only
 * thing that promotes a coverage row from `implemented_live_unverified` to `implemented_verified`
 * (`coverage.coverageRows`). One entry per (ruleId, version) verified: `deployment` names where, `verifiedOn` is
 * "YYYY-MM-DD", `decision` the lead's D-id, `evidence` the VERIFICATION.md anchor. Stays empty this mission.
 */
export type LiveVerification = { ruleId: string; version: number; deployment: string; verifiedOn: string /*YYYY-MM-DD*/; decision: string; evidence: string /*VERIFICATION.md anchor*/ };
export const LIVE_VERIFICATIONS: readonly LiveVerification[] = [];
