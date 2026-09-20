import { ConvexError } from "convex/values";

/**
 * The text to show a user for a failed mutation/action. Server code throws
 * `new ConvexError("…")`, so `.data` is a plain string (ARCHITECTURE_PATTERNS
 * §Errors); anything else falls back to the message.
 */
export function errorText(error: unknown): string {
  if (error instanceof ConvexError) {
    return typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Dollars typed by a human into integer minor units. Returns null if unusable. */
export function dollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Integer minor units back into an editable dollars string. */
export function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** `YYYY-MM-DD` for an `<input type="date">`, from epoch ms. */
export function toDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Epoch ms from a `YYYY-MM-DD` value, or null when empty/invalid. */
export function fromDateInput(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T12:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Short absolute timestamp, e.g. "Sep 20, 2026, 3:04 PM". */
export function when(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Short date only. */
export function day(ms: number | undefined): string {
  return ms === undefined ? "—" : new Date(ms).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export const inputClass =
  "w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20";

export const labelClass = "mb-1 block text-xs font-medium text-ink/70";

export const primaryButtonClass =
  "rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper transition hover:bg-harbor/90 disabled:opacity-60";

export const secondaryButtonClass =
  "rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink/70 transition hover:border-ink/30 hover:text-ink disabled:opacity-60";

export const sectionClass = "rounded-lg border border-line bg-white/70 p-4 shadow-sm";
