import { ConvexError } from "convex/values";
import { MAX_USER_AMOUNT_MINOR } from "../limits";

export function assertCents(n: number, label = "cents"): number {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new ConvexError(`${label} must be a non-negative safe integer`);
  return n;
}

export function assertPositiveCents(n: number, label = "cents"): number {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new ConvexError(`${label} must be a positive safe integer`);
  return n;
}

export function assertQty(n: number): number {
  if (!Number.isSafeInteger(n) || n < 1)
    throw new ConvexError("qty must be a safe integer of at least 1");
  return n;
}

/** A user-supplied timestamp: finite, not negative, at most a day in the future (D43). */
export function assertTimestamp(n: number, label = "timestamp", now: number = Date.now()): number {
  if (!Number.isFinite(n) || n < 0 || n > now + 86_400_000)
    throw new ConvexError(`${label} must be a valid time, not in the future`);
  return n;
}

/** A policy window in whole days, 0..3650 (D43). */
export function assertWindowDays(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > 3650)
    throw new ConvexError("windowDays must be a whole number between 0 and 3650");
  return n;
}

export function assertNonEmpty(s: string, label: string): string {
  if (s.trim().length === 0) throw new ConvexError(`${label} must not be empty`);
  return s;
}

export function assertCurrency(s: string): string {
  if (!/^[A-Z]{3}$/.test(s))
    throw new ConvexError("currency must be a 3-letter ISO 4217 code");
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: s });
  } catch {
    throw new ConvexError(`unsupported currency ${s}`);
  }
  return s;
}

/** Converts a decimal major-unit amount to integer minor units, rounding half away from zero. */
export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new ConvexError("amount must be finite");
  const c = Math.round(Math.abs(amount) * 100) * Math.sign(amount);
  if (!Number.isSafeInteger(c)) throw new ConvexError("amount out of range");
  return c === 0 ? 0 : c;
}

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §3.1): Money = integer minor units + ISO 4217 code.
// No floating-point arithmetic anywhere below: amounts are parsed and
// formatted by string operations, and range checks use BigInt.
// ---------------------------------------------------------------------------

/** `{ amountMinor, currency }`, the shape of the `money` validator exported from `convex/schema.ts`. */
export type Money = { amountMinor: number; currency: string };

/**
 * Which currencies a money path admits.
 * - `new_scenario` (default): only `CURRENCY_EXPONENT` (USD) — new scenarios are USD-only (O6).
 * - `legacy_r01`: the R01 carve-out (DA-A-13) — additionally every two-decimal ISO 4217 code, exactly the set
 *   the legacy price-adjustment flow already opens claims in (a GBP purchase + a GBP observation still claims).
 */
export type CurrencyMode = "new_scenario" | "legacy_r01";

/** Minor-unit exponent per currency admitted for NEW scenarios (O6). Extend only with provenance. */
export const CURRENCY_EXPONENT: Readonly<Record<string, number>> = Object.freeze({ USD: 2 });

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
 * True when `code` is a real ISO 4217 currency whose minor unit has exactly two decimal places
 * (Intl `maximumFractionDigits === 2`). Never throws. Intl reports 2 digits for ANY well-formed
 * unknown code ("ZZZ", "XXX"), so membership in the runtime's ISO list is also required.
 */
export function isTwoDecimalCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const known = knownIsoCurrencies();
  if (known && !known.has(code)) return false;
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits === 2;
  } catch {
    return false;
  }
}

/** The minor-unit exponent `code` has on a path of the given mode, or null when that path does not admit it. */
export function currencyExponent(code: string, mode: CurrencyMode = "new_scenario"): number | null {
  if (Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENT, code)) return CURRENCY_EXPONENT[code];
  if (mode === "legacy_r01" && isTwoDecimalCurrency(code)) return 2;
  return null;
}

/** Validates a Money value: a non-negative safe-integer amount in a currency the mode admits. Returns it. */
export function assertMoney(m: Money, mode: CurrencyMode = "new_scenario", label = "amount"): Money {
  if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor < 0) {
    throw new ConvexError(`${label} must be a non-negative whole number of minor units`);
  }
  if (currencyExponent(m.currency, mode) === null) throw new ConvexError(`unsupported currency ${m.currency}`);
  return m;
}

/** Refuses to combine amounts in different currencies (mission §6: never sum different currencies). Returns the shared code. */
export function assertSameCurrency(a: Money, b: Money): string {
  if (a.currency !== b.currency) throw new ConvexError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  return a.currency;
}

/**
 * A user-typed amount in minor units (SEC-MF-4): a non-negative safe integer no larger than
 * `MAX_USER_AMOUNT_MINOR` (USD 1,000,000, D145). Callers that need a positive amount check that too.
 */
export function assertUserAmount(amountMinor: number, label = "amount"): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ConvexError(`${label} must be a non-negative whole number of minor units`);
  }
  if (amountMinor > MAX_USER_AMOUNT_MINOR) throw new ConvexError(`${label} is larger than Recoup accepts`);
  return amountMinor;
}

/** A user-typed Money value: `assertMoney` (currency admitted by `mode`) plus the typed-amount cap. Returns it. */
export function assertUserMoney(m: Money, mode: CurrencyMode = "new_scenario", label = "amount"): Money {
  assertMoney(m, mode, label);
  assertUserAmount(m.amountMinor, label);
  return m;
}

/**
 * The currency a claim is denominated in: its own `currency` (set on every claim linked or opened from wave 1),
 * else its purchase's (legacy retail claims). Null when neither is known — callers show "currency unknown",
 * never a `?? "USD"` default (HC-1 silent sites, HC-25).
 */
export function claimCurrency(
  claim: { currency?: string },
  purchase: { currency: string } | null | undefined,
): string | null {
  return claim.currency ?? purchase?.currency ?? null;
}

/**
 * Formats minor units for letters and notes as `"<ISO> <grouped major>.<minor>"`, e.g. `USD 1,234.50`,
 * by string arithmetic only. Unknown exponents fall back to 2 (display only; never used for arithmetic).
 */
export function formatMinor(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ConvexError("amount must be a non-negative whole number of minor units");
  }
  const e = currencyExponent(currency, "legacy_r01") ?? 2;
  const digits = String(amountMinor).padStart(e + 1, "0");
  const major = digits.slice(0, digits.length - e).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return e === 0 ? `${currency} ${major}` : `${currency} ${major}.${digits.slice(digits.length - e)}`;
}

/**
 * The result of reading a decimal amount string. `signMarked` results (a leading `-`/`−`, parentheses,
 * a trailing `-`, or a `CR`/`DR` suffix) are routed by callers to `needs_review` and are NEVER read as a
 * positive amount (DA-A-26).
 */
export type DecimalParse =
  | { ok: true; amountMinor: number }
  | { ok: false; signMarked: true }
  | { ok: false; signMarked: false; reason: "malformed" | "too_many_decimals" | "out_of_range" | "unsupported_currency" };

const SIGN_MARKED = /^(?:[-−].*|\(.*\)|.*-|.*\s?(?:CR|DR))$/i;
const PLAIN_OR_GROUPED = /^(?:\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d+))?$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses a major-unit decimal string into integer minor units (DA-A-26). After trimming ASCII spaces
 * (U+0020 only) it accepts exactly `^\d+(\.\d{1,E})?$` or `^[1-9]\d{0,2}(,\d{3})+(\.\d{1,E})?$`
 * (ASCII digits, comma thousands grouping, no leading-zero group), where E is the currency exponent
 * for `mode`. Everything else — decimal commas, other groupings, a bare or trailing dot, full-width
 * digits, NBSP, exponents, symbols, extra fraction digits, values beyond the safe-integer range — is
 * rejected. Sign markers return `{ ok: false, signMarked: true }`.
 */
export function parseDecimalToMinor(s: string, currency: string, mode: CurrencyMode = "new_scenario"): DecimalParse {
  const e = currencyExponent(currency, mode);
  if (e === null) return { ok: false, signMarked: false, reason: "unsupported_currency" };
  const t = s.replace(/^ +| +$/g, "");
  if (t.length === 0) return { ok: false, signMarked: false, reason: "malformed" };
  if (SIGN_MARKED.test(t)) return { ok: false, signMarked: true };
  const m = PLAIN_OR_GROUPED.exec(t);
  if (!m) return { ok: false, signMarked: false, reason: "malformed" };
  const frac = m[1] ?? "";
  if (frac.length > e) return { ok: false, signMarked: false, reason: "too_many_decimals" };
  const intDigits = t.slice(0, t.length - (m[1] === undefined ? 0 : frac.length + 1)).replace(/,/g, "");
  const minor = BigInt(intDigits + frac.padEnd(e, "0"));
  if (minor > MAX_SAFE) return { ok: false, signMarked: false, reason: "out_of_range" };
  return { ok: true, amountMinor: Number(minor) };
}
