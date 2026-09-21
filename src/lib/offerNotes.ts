/**
 * Fixed, matchable `note` strings T13 writes in place of a typed flag (D100:
 * "behavioural, not schema" out-of-stock/needs-reconfirm representation --
 * T16 was pre-declared to add `offers.inStock?`/an `offerStatus` literal
 * later; until then the UI keys off these exact strings, same as the
 * backend's own `needsReconfirm()` helper in `convex/offers.ts` does).
 *
 * Duplicated here rather than imported: `src/` never imports a raw
 * `convex/*.ts` module (only `convex/_generated/api`, which is type-only for
 * a plain string) because those files pull in server-only packages that do
 * not bundle for the browser.
 */

/** Mirrors the EXPORTED `NEEDS_RECONFIRM_NOTE` in `convex/offers.ts`. Keep the two literally equal. */
export const NEEDS_RECONFIRM_NOTE =
  "This store's listing may have changed since you confirmed it; check it before trusting this price.";

/**
 * Mirrors a PRIVATE `OUT_OF_STOCK_NOTE` in `convex/market.ts` (never exported
 * by T13). Known gap (see this task's final report): if that string ever
 * changes, this copy drifts silently until T16's typed `offers.inStock?`
 * flag lands and this file's matching can be deleted.
 */
export const OUT_OF_STOCK_NOTE = "Out of stock according to ShopSavvy; confirm it is the same item";
