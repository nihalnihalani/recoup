/**
 * P06/D73's price-staleness rule (F-T15-1, T24b/D111): `insights.trackedTable`
 * used to read `watch.lastCents` straight through with no staleness check at
 * all, unlike `watches.ts`'s `summarise()`, which already applied this exact
 * test inline. Extracted here so `insights.ts` can apply the identical rule
 * without re-deriving its own copy.
 *
 * D115 note: this was briefly wired into `watches.ts` too (replacing its
 * inline copy so there would be exactly one implementation), but that edit
 * was reverted at the lead's instruction -- another lane is about to change
 * `watches.ts` and this task does not own that file. `watches.ts`'s own
 * inline `priceStale` computation therefore still exists separately and is
 * NOT calling this function; the two must be kept expressing the same rule
 * by hand until a future task unifies them. `insights.ts`'s `trackedTable`
 * is the one real caller today.
 *
 * A price is stale when it was never actually observed (`lastObservedAt`
 * undefined -- a check attempt exists but nothing was ever accepted) or the
 * last accepted observation is older than `STALE_PRICE_MS` as of `now`.
 * `now` is caller-supplied on purpose (P06/D73: a query never reads the real
 * wall clock for a display computation) -- see each call site for how it
 * falls back when the caller did not supply one of its own.
 */
import { STALE_PRICE_MS } from "../limits";

export function isPriceStale(lastObservedAt: number | undefined, now: number): boolean {
  return lastObservedAt === undefined || now - lastObservedAt > STALE_PRICE_MS;
}
