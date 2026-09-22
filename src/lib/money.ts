/**
 * Money display for the browser (M15; mission §6, contract §3.1).
 *
 * Two kinds of stored amount reach the UI, and they are NOT the same unit for every currency:
 *
 *  - **`Money.amountMinor`** (`{ amountMinor, currency }`: `recovery.summary`, opportunity estimates, caps, fact
 *    values): integer ISO 4217 minor units. The exponent comes from the currency: USD 2, JPY 0, KWD 3.
 *    Format these with `formatMinor`.
 *  - **Legacy `…Cents` fields** (`items.unitCents`, `priceChecks.observedCents`, `claims.expectedCents`, ledger
 *    `cents`, …): hundredths of the major unit for EVERY currency, because intake (`Math.round(amount * 100)`),
 *    price reads and the purchase forms all scale by 100 regardless of currency. A yen price of ¥1,200 is stored
 *    as 120000. Format these with `fmt`, which converts hundredths to the currency's real minor unit before
 *    formatting, so the displayed digits follow the currency (¥1,200, KWD 12.340) and never a guessed 2.
 *
 * For every currency a claim or a new scenario admits (two-decimal currencies only: `lib/money.currencyExponent`
 * on the server, O6 / DA-A-13) the two units coincide. Nothing here does arithmetic on floats: amounts become
 * decimal strings by integer/string operations and Intl formats the string.
 */

/** Minor-unit exponent pinned for new scenarios (mirrors the server's `CURRENCY_EXPONENT`, O6). */
const PINNED_EXPONENT: Readonly<Record<string, number>> = Object.freeze({ USD: 2 });

type IntlWithSupported = typeof Intl & { supportedValuesOf?: (key: "currency") => string[] };
let isoCurrencies: ReadonlySet<string> | null | undefined;
/** The runtime's ISO 4217 list, or null when the engine cannot enumerate it (then Intl alone decides). */
function knownIsoCurrencies(): ReadonlySet<string> | null {
  if (isoCurrencies === undefined) {
    const list = (Intl as IntlWithSupported).supportedValuesOf?.("currency");
    isoCurrencies = list ? new Set(list) : null;
  }
  return isoCurrencies;
}

/**
 * The ISO 4217 minor-unit exponent of `code` (USD 2, JPY 0, KWD 3), or null when `code` is not a currency this
 * runtime knows. Intl reports 2 for ANY well-formed unknown code ("ZZZ"), so, as on the server
 * (`isTwoDecimalCurrency`), membership in the runtime's ISO list is also required. Never throws.
 */
export function currencyExponent(code: string): number | null {
  if (Object.prototype.hasOwnProperty.call(PINNED_EXPONENT, code)) return PINNED_EXPONENT[code];
  if (!/^[A-Z]{3}$/.test(code)) return null;
  const known = knownIsoCurrencies();
  if (known && !known.has(code)) return null;
  try {
    const digits = new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" ? digits : null;
  } catch {
    return null;
  }
}

/** `amount / 10^scale` as an exact decimal string ("-12.05", "1200", "0.007"). `amount` must be a safe integer. */
function decimalString(amount: number, scale: number): string {
  const negative = amount < 0;
  const digits = String(Math.abs(amount)).padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, digits.length - scale);
  const fraction = scale === 0 ? "" : digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Intl currency formatting of an exact decimal string, or null when Intl refuses the code. */
function intlCurrency(decimal: string, currency: string): string | null {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(
      decimal as Intl.StringNumericLiteral,
    );
  } catch {
    return null;
  }
}

/**
 * Formats integer ISO minor units (`Money.amountMinor`) in the currency's own exponent: 1234 USD → "$12.34",
 * 1200 JPY → "¥1,200", 12345 KWD → "KWD 12.345". An amount whose currency has no known exponent is shown as
 * minor units with its code, never divided by a guessed 100. Never throws.
 */
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) return `— ${currency}`;
  const exponent = currencyExponent(currency);
  if (exponent === null) return `${amountMinor} ${currency} (minor units)`;
  return intlCurrency(decimalString(amountMinor, exponent), currency) ?? `${decimalString(amountMinor, exponent)} ${currency}`;
}

/**
 * Formats a legacy `…Cents` amount (hundredths of the major unit, see the header) in the currency's own exponent:
 * 1234 USD → "$12.34", 120000 JPY → "¥1,200", 1234 KWD → "KWD 12.340". A hundredths value finer than the
 * currency's unit (a JPY amount not divisible by 100) is rounded by Intl to the currency's digits for display only.
 * Never throws.
 */
export function fmt(cents: number, currency: string): string {
  if (!Number.isSafeInteger(cents)) return `— ${currency}`;
  const decimal = decimalString(cents, 2);
  return intlCurrency(decimal, currency) ?? `${decimal} ${currency}`;
}

/**
 * A price typed into a form, as legacy hundredths (the unit `items.unitCents` stores for every currency), by
 * string arithmetic only: "12", "12.5", "12.50", "1,234.50", with an optional leading "$". At most two decimals;
 * no sign, exponent, decimal comma or other grouping. Returns null for anything else or beyond the safe range.
 */
export function parseHundredths(input: string): number | null {
  const trimmed = input.trim().replace(/^\$\s*/, "");
  const match = /^(\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const whole = match[1].replace(/,/g, "");
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const value = BigInt(whole + fraction);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

/** Legacy hundredths back into an editable decimal string ("12.50"), by string arithmetic. */
export function hundredthsToInput(cents: number): string {
  return decimalString(cents, 2);
}
