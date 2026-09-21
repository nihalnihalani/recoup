import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import { boughtVerdict, type BoughtVerdict } from "../../lib/priceStats";
import { shortDay } from "../../lib/ui";

export type Overview = FunctionReturnType<typeof api.tracking.overview>;
export type Item = Overview["items"][number];
export type Watch = FunctionReturnType<typeof api.watches.list>[number];
export type ActivityEvent = FunctionReturnType<typeof api.insights.activity>[number];
export type SourceRow = FunctionReturnType<typeof api.insights.sources>[number];
export type BoardData = FunctionReturnType<typeof api.purchases.board>;
export type PriceHistory = NonNullable<FunctionReturnType<typeof api.insights.priceHistory>>;
export type HistoryStore = PriceHistory["stores"][number];
export type TrackedRow = FunctionReturnType<typeof api.insights.trackedTable>[number];

export type SeriesPoint = { at: number; value: number };

const DAY = 86_400_000;

/**
 * Line colours for stores, in fixed order: a store keeps its slot whatever else is
 * filtered. Steps picked with the dataviz palette validator; `dot` is the matching
 * utility, which also makes Tailwind emit the variable `color` reads.
 */
export const SERIES_COLORS = [
  { color: "var(--color-blue-600)", dot: "bg-blue-600" },
  { color: "var(--color-purple-400)", dot: "bg-purple-400" },
  { color: "var(--color-green-600)", dot: "bg-green-600" },
  { color: "var(--color-amber-600)", dot: "bg-amber-600" },
  { color: "var(--color-rose-600)", dot: "bg-rose-600" },
  { color: "var(--color-cyan-600)", dot: "bg-cyan-600" },
] as const;

/** What a bought item's price means right now. */
export function itemVerdict(item: Item, now: number): BoughtVerdict {
  return boughtVerdict({
    paidCents: item.paidCents,
    latestCents: item.latestCents,
    windowEndsAt: item.windowEndsAt,
    claimStatus: item.claim?.status,
    now,
    currency: item.currency,
  });
}

/** A drop that can still be claimed: price is below paid, the window has not shut, the money is not back yet. */
export function openDropCents(item: Item, now: number): number {
  if (item.dropCents === undefined || item.dropCents <= 0) return 0;
  if (item.windowEndsAt !== undefined && item.windowEndsAt <= now) return 0;
  if (item.claim?.status === "confirmed") return 0;
  return item.dropCents * item.qty;
}

/** Open drops first, largest first; then whichever window shuts soonest; closed and unknown windows last. */
export function byUrgency(now: number) {
  const windowRank = (item: Item) =>
    item.windowEndsAt !== undefined && item.windowEndsAt > now ? item.windowEndsAt : Number.POSITIVE_INFINITY;
  return (a: Item, b: Item) => {
    const drop = openDropCents(b, now) - openDropCents(a, now);
    if (drop !== 0) return drop;
    return windowRank(a) - windowRank(b);
  };
}

function knownAt(points: SeriesPoint[], at: number): number | undefined {
  let known: number | undefined;
  for (const p of points) {
    if (p.at > at) break;
    known = p.value;
  }
  return known;
}

/**
 * The sum of every watched price at each observation time. A last known price is
 * carried forward and a first price carried back, so the line moves only when a
 * price moved, never because a product joined the list.
 */
export function watchedTotalSeries(watches: Watch[]): SeriesPoint[] {
  const priced = watches
    .map((watch) => watch.spark.map((p) => ({ at: p.observedAt, value: p.observedCents })))
    .filter((series) => series.length > 0);
  const times = [...new Set(priced.flatMap((series) => series.map((p) => p.at)))].sort((a, b) => a - b);
  return times.map((at) => ({
    at,
    value: priced.reduce((sum, series) => sum + (knownAt(series, at) ?? series[0].value), 0),
  }));
}

/**
 * How much sat below the paid price over time, across items whose drop could still
 * be claimed today. An item counts from its first reading on, never before it.
 */
export function claimableGapSeries(items: Item[], now: number): SeriesPoint[] {
  const live = items.filter(
    (item) => item.points.length > 0 && item.claim?.status !== "confirmed" && (item.windowEndsAt === undefined || item.windowEndsAt > now),
  );
  const times = [...new Set(live.flatMap((item) => item.points.map((p) => p.at)))].sort((a, b) => a - b);
  return times.map((at) => ({
    at,
    value: live.reduce((sum, item) => {
      const known = knownAt(item.points.map((p) => ({ at: p.at, value: p.cents })), at);
      return known === undefined ? sum : sum + Math.max(item.paidCents - known, 0) * item.qty;
    }, 0),
  }));
}

/** Local midnight at the start of the day `at` falls in. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Events per local day for the last `days` days, today last. `since` trims days the
 * source cannot vouch for (a capped feed knows nothing older than its oldest event).
 */
export function perDay(times: number[], now: number, days: number, since?: number): SeriesPoint[] {
  const today = startOfDay(now);
  const out: SeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = startOfDay(today - i * DAY + DAY / 2);
    if (since !== undefined && from < startOfDay(since)) continue;
    const to = startOfDay(from + DAY + DAY / 2);
    out.push({ at: from, value: times.filter((t) => t >= from && t < to).length });
  }
  return out;
}

/** "now", "12m", "3h", "2d", then a short date. */
export function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return shortDay(at);
}

/** "just now", "12m ago", "2d ago", then "on Sep 3". */
export function agoLong(at: number, now: number): string {
  const short = ago(at, now);
  if (short === "now") return "just now";
  return /^\d+[mhd]$/.test(short) ? `${short} ago` : `on ${short}`;
}

/** The currency most rows use; mixed-currency sums are labelled with it. */
export function mainCurrency(currencies: string[]): string {
  const counts = new Map<string, number>();
  for (const c of currencies) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}
