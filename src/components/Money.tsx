/** Formats integer minor units into a localized currency string. Never throws. */
export function fmt(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(cents / 100);
  } catch {
    return `${cents / 100} ${currency}`;
  }
}

/** A money amount set in tabular numerals so columns of figures line up like a ledger. */
export function Money({
  cents,
  currency,
  className = "",
}: {
  cents: number;
  currency: string;
  className?: string;
}) {
  return <span className={`font-mono tabular-nums ${className}`}>{fmt(cents, currency)}</span>;
}
