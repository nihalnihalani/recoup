import { ConvexError } from "convex/values";

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
