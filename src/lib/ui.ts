import { useEffect, useRef, useState } from "react";
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

/**
 * `YYYY-MM-DD` for an `<input type="date">`: the calendar day `ms` falls on in the viewer's own time zone, which is
 * the day a date picker shows. A stored noon-UTC date (the convention below) is the same calendar day in every zone
 * from UTC−11 to UTC+12, so older rows read back unchanged.
 */
export function toDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Today's `YYYY-MM-DD` in the viewer's own time zone (a date picker's `max` for a purchase). */
export function todayInput(now: number = Date.now()): string {
  return toDateInput(now);
}

/**
 * The instant a picked calendar day stands for, or null when the value is empty, malformed or not allowed.
 *
 * QA-M16-4 (D217): the old convention stored noon UTC of the picked day for every day, so "today" picked east of
 * UTC before 12:00 UTC was a FUTURE instant, and a price-adjustment window counted from it ran up to ~12 h past the
 * store's rule. Now:
 *  - today (in the viewer's zone) → `now`, the moment it was entered;
 *  - an earlier day → noon UTC of that day (the same calendar day from UTC−11 to UTC+12), never later than `now`;
 *  - a later day → null, unless `allowFuture` (a promised date can be ahead; an event that happened cannot).
 */
export function fromDateInput(value: string, options: { now?: number; allowFuture?: boolean } = {}): number | null {
  const now = options.now ?? Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const noon = Date.parse(`${value}T12:00:00Z`);
  if (Number.isNaN(noon)) return null;
  const today = todayInput(now);
  if (value === today) return now;
  if (value > today) return options.allowFuture ? noon : null;
  return Math.min(noon, now);
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
  "w-full rounded-xl border border-gray-200 bg-white px-3.5 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none transition hover:border-gray-300 focus:border-gray-300 focus:ring-2 focus:ring-violet-500/25";

export const labelClass = "mb-1.5 block text-sm font-medium text-gray-900";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-semibold text-gray-100 transition hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-semibold text-gray-900 transition hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

/** The dashboard card: white on white, held by a hairline border and a generous radius. */
export const sectionClass = "rounded-2xl border border-gray-200 bg-white p-5";

/** A card with its own header and body padding (use with cardHeaderClass / cardTitleClass). */
export const cardClass = "rounded-2xl border border-gray-200 bg-white";
export const cardHeaderClass = "border-b border-gray-200 px-5 py-4";
export const cardTitleClass = "text-base font-semibold text-gray-900";

export const pageTitleClass = "text-2xl font-semibold tracking-tight text-gray-900 md:text-[1.75rem]";
export const mutedLabelClass = "text-xs font-medium uppercase tracking-wide text-gray-400";
export const bigNumberClass = "text-3xl font-semibold tracking-tight text-gray-900 tabular-nums";
export const tableHeadClass = "bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-400";

/** Up/down/warning pills. Pair with an arrow or label: tone is never the only signal. */
const pillBase = "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold";
export const pillGoodClass = `${pillBase} bg-green-500/15 text-green-700`;
export const pillBadClass = `${pillBase} bg-red-500/15 text-red-700`;
export const pillWarnClass = `${pillBase} bg-yellow-500/20 text-yellow-700`;
export const pillMutedClass = `${pillBase} bg-gray-100 text-gray-500`;

/** Compact day for chart axes and tooltips, e.g. "Sep 20". */
export function shortDay(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "9d 12h", "5h 20m", "42m" — the two largest units of a positive duration. */
export function remainingLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Percentage with one decimal, e.g. "9.1%". `ratio` is 0..1. */
export function percent(ratio: number): string {
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}

/** The current time as state, refreshed every `everyMs`, so renders stay pure. */
export function useNow(everyMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Tracks an element's rendered width so an SVG can draw at true pixel size. */
export function useMeasuredWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      if (w > 0) setWidth(Math.round(w));
    };
    apply(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) apply(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}
