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
