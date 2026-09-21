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
