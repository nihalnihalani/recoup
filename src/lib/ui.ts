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
  "w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 placeholder-gray-400 outline-none transition hover:border-gray-300 focus:border-gray-300 focus:ring-2 focus:ring-violet-500/20";

export const labelClass = "mb-1 block text-sm font-medium text-gray-800";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-gray-100 transition hover:bg-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-800 transition hover:border-gray-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

/** The dashboard card: white, soft shadow, generous radius. */
export const sectionClass = "rounded-xl bg-white p-5 shadow-xs";

/** A card with its own header and body padding (use with cardHeaderClass / cardTitleClass). */
export const cardClass = "rounded-xl bg-white shadow-xs";
export const cardHeaderClass = "border-b border-gray-100 px-5 py-4";
export const cardTitleClass = "text-lg font-semibold text-gray-800";

export const pageTitleClass = "text-2xl font-bold text-gray-800 md:text-3xl";
export const mutedLabelClass = "text-xs font-semibold uppercase text-gray-400";
export const bigNumberClass = "text-3xl font-bold text-gray-800";
export const tableHeadClass = "bg-gray-50 text-xs font-semibold uppercase text-gray-400";

/** Up/down/warning pills. Pair with an arrow or label: tone is never the only signal. */
const pillBase = "inline-flex items-center gap-1 rounded-full px-1.5 text-sm font-medium";
export const pillGoodClass = `${pillBase} bg-green-500/20 text-green-700`;
export const pillBadClass = `${pillBase} bg-red-500/20 text-red-700`;
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
