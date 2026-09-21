import { fmt } from "./money";

/** One entry of `tracking.overview`'s `totals.byCurrency` (convex/tracking.ts). */
export type CurrencyTotals = { foundCents: number; recoveredCents: number; exampleFoundCents: number };

export type ByCurrency = Record<string, CurrencyTotals>;

/**
 * `byCurrency`'s keys, ordered for display: `primaryCurrency` first (only
 * when it is actually a key of `byCurrency` -- a `primaryCurrency` that
 * names a currency with no row is never invented as one), the rest
 * alphabetically after it so the order is stable across renders. Pure;
 * never mutates its input.
 */
export function orderedCurrencies(byCurrency: ByCurrency, primaryCurrency: string | null): string[] {
  const rest = Object.keys(byCurrency)
    .filter((code) => code !== primaryCurrency)
    .sort((a, b) => a.localeCompare(b));
  return primaryCurrency !== null && primaryCurrency in byCurrency ? [primaryCurrency, ...rest] : rest;
}

export type RecoveredLine = { currency: string; cents: number; label: string };

/**
 * `totals.recoveredCents` formatted per currency (D103/D107 C4). The old
 * single-number field is scoped to `primaryCurrency` only (see
 * `convex/tracking.ts`'s doc comment on `overview`'s `totals`), so
 * formatting it with a currency guessed from item currencies can print the
 * wrong symbol entirely -- e.g. 3 EUR items plus $50 USD recovered
 * rendering "€50.00". This reads the honest `byCurrency` breakdown instead,
 * one row per currency that actually has money, `primaryCurrency` first.
 * Never invents a currency: a currency with nothing recovered is simply not
 * a key in `byCurrency` and so never appears here; an empty `byCurrency`
 * (nothing to report yet) returns `[]`. Formatting itself is delegated to
 * `./money`'s `fmt`, which never throws even for an unrecognised code.
 */
export function recoveredByCurrency(byCurrency: ByCurrency, primaryCurrency: string | null): RecoveredLine[] {
  return orderedCurrencies(byCurrency, primaryCurrency).map((currency) => ({
    currency,
    cents: byCurrency[currency].recoveredCents,
    label: fmt(byCurrency[currency].recoveredCents, currency),
  }));
}
