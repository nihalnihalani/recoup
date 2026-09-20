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
