/**
 * DA-B-2 (D190, M13b; shared with M12d's opportunity projection): does a claim ask for more than the rule's own
 * exact calculation now supports?
 *
 * The ONE predicate behind both `drafts.prepareSend`'s acknowledgeable `amount_exceeds_estimate` refusal and the
 * opportunity projection's `review_amount` next action, so the two can never disagree. Pure: no ctx, clock or ids.
 *
 * True only when ALL hold:
 *   - the evaluation has an amount whose basis is `exact_formula` (a documented total or a user's own figure is not
 *     a calculation the claim can be held to);
 *   - the claim's currency is known and equals the estimate's currency (amounts in different currencies are never
 *     compared, mission §6);
 *   - that currency has a two-decimal minor unit on the R01 path (`currencyExponent(code, "legacy_r01") === 2`), so
 *     the claim's legacy `expectedCents` IS minor units of it — otherwise the two numbers are in different units and
 *     are never compared;
 *   - both amounts are non-negative safe integers and the estimate is strictly below the claimed amount.
 *
 * Callers resolve the claim's currency with `lib/money.claimCurrency(claim, purchase)` (a legacy claim has none of
 * its own), never a `?? "USD"` default.
 */
import { currencyExponent, type Money } from "./money";

export type AmountReview = { exceeds: false } | { exceeds: true; estimate: Money; claimed: Money };

export function amountExceedsEstimate(
  claim: { expectedCents: number; currency: string | null },
  amount: { estimate: { amountMinor: number; currency: string }; basis: string } | null,
): AmountReview {
  if (amount === null || amount.basis !== "exact_formula") return { exceeds: false };
  const currency = claim.currency;
  if (currency === null || amount.estimate.currency !== currency) return { exceeds: false };
  if (currencyExponent(currency, "legacy_r01") !== 2) return { exceeds: false };
  const estimateMinor = amount.estimate.amountMinor;
  const claimedMinor = claim.expectedCents;
  if (!Number.isSafeInteger(estimateMinor) || !Number.isSafeInteger(claimedMinor) || estimateMinor < 0 || claimedMinor < 0) {
    return { exceeds: false };
  }
  if (estimateMinor >= claimedMinor) return { exceeds: false };
  return { exceeds: true, estimate: { amountMinor: estimateMinor, currency }, claimed: { amountMinor: claimedMinor, currency } };
}
