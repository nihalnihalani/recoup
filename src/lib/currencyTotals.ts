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

/** One formatted per-currency figure, ready to render as its own line. */
export type CurrencyLine = { currency: string; cents: number; label: string };
/** @deprecated kept as an alias -- `recoveredByCurrency`'s original return type name. */
export type RecoveredLine = CurrencyLine;

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
export function recoveredByCurrency(byCurrency: ByCurrency, primaryCurrency: string | null): CurrencyLine[] {
  return orderedCurrencies(byCurrency, primaryCurrency).map((currency) => ({
    currency,
    cents: byCurrency[currency].recoveredCents,
    label: fmt(byCurrency[currency].recoveredCents, currency),
  }));
}

/**
 * Sums arbitrary `{ currency, cents }` entries into one row per currency
 * (F-T14-1): `StatCards`'s "Money on the table" figure summed
 * `openDropCents` across every scoped item and displayed the total under a
 * single guessed currency (`mainCurrency`), which -- like the recovered
 * figure above before D107 C4 -- can print the wrong symbol/amount outright
 * once items span more than one currency. This groups by currency instead,
 * ordered the same way as `recoveredByCurrency` (`primaryCurrency` first
 * when it is one of the entries' currencies, the rest alphabetically after
 * it), so the caller can render one line per currency and never sum across
 * currencies. Never invents a currency: a currency with no entries produces
 * no row. Entries for a currency that all sum to zero still produce a row
 * (so "nothing open right now" in a currency the account otherwise uses
 * still reads e.g. "$0.00" rather than silently vanishing); callers that
 * want to hide all-zero currencies should filter first. An empty `entries`
 * returns `[]`.
 */
export function sumCentsByCurrency(entries: { currency: string; cents: number }[], primaryCurrency: string | null): CurrencyLine[] {
  const totals = new Map<string, number>();
  for (const { currency, cents } of entries) {
    totals.set(currency, (totals.get(currency) ?? 0) + cents);
  }
  const rest = [...totals.keys()].filter((code) => code !== primaryCurrency).sort((a, b) => a.localeCompare(b));
  const ordered = primaryCurrency !== null && totals.has(primaryCurrency) ? [primaryCurrency, ...rest] : rest;
  return ordered.map((currency) => {
    const cents = totals.get(currency) ?? 0;
    return { currency, cents, label: fmt(cents, currency) };
  });
}
