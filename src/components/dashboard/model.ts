import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import { boughtVerdict, type BoughtVerdict } from "../../lib/priceStats";
import { storeInfo } from "../../lib/stores";
import { shortDay } from "../../lib/ui";

export type Overview = FunctionReturnType<typeof api.tracking.overview>;
export type Item = Overview["items"][number];
export type Watch = FunctionReturnType<typeof api.watches.list>[number];
export type ActivityEvent = FunctionReturnType<typeof api.insights.activity>[number];
export type SourceRow = FunctionReturnType<typeof api.insights.sources>[number];
export type BoardData = FunctionReturnType<typeof api.purchases.board>;

export type SeriesPoint = { at: number; value: number };

/** One row of the dashboard: something watched before buying, or something bought and tracked. */
export type Product = {
  key: string;
  kind: "watch" | "bought";
  name: string;
  domain: string;
  storeName: string;
  currency: string;
  qty: number;
  /** Where the card and the row link to. */
  to: string;
  nowCents?: number;
  /** What "now" is compared with: the paid price, or the first price seen. */
  basisCents?: number;
  basisLabel: "paid" | "first seen";
  /** The dashed level on the chart: the paid price, or the target when one is set. */
  reference?: { value: number; label: string };
  series: SeriesPoint[];
  lowCents?: number;
  highCents?: number;
  isExample: boolean;
  watch?: Watch;
  item?: Item;
};

export function watchProduct(watch: Watch): Product {
  const series = watch.spark.map((p) => ({ at: p.observedAt, value: p.observedCents }));
  const seen = series.map((p) => p.value);
  return {
    key: watch._id,
    kind: "watch",
    name: watch.name,
    domain: watch.merchantDomain,
    storeName: storeInfo(watch.merchantDomain).name,
    currency: watch.currency ?? "USD",
    qty: 1,
    to: "/watching",
    nowCents: watch.lastCents ?? undefined,
    basisCents: series[0]?.value,
    basisLabel: "first seen",
    reference: watch.targetCents === null ? undefined : { value: watch.targetCents, label: "Target" },
    series,
    lowCents: seen.length > 0 ? Math.min(...seen) : undefined,
    highCents: seen.length > 0 ? Math.max(...seen) : undefined,
    isExample: false,
    watch,
  };
}

export function boughtProduct(item: Item): Product {
  const series = item.points.map((p) => ({ at: p.at, value: p.cents }));
  const seen = series.map((p) => p.value);
  return {
    key: item.itemId,
    kind: "bought",
    name: item.name,
    domain: item.merchantDomain,
    storeName: item.merchant || storeInfo(item.merchantDomain).name,
    currency: item.currency,
    qty: item.qty,
    to: `/purchases/${item.purchaseId}`,
    nowCents: item.latestCents,
    basisCents: item.paidCents,
    basisLabel: "paid",
    reference: { value: item.paidCents, label: "Paid" },
    series,
    lowCents: seen.length > 0 ? Math.min(...seen) : undefined,
    highCents: seen.length > 0 ? Math.max(...seen) : undefined,
    isExample: item.isExample,
    item,
  };
}

/** What a bought product's price means right now; undefined for a product that is only watched. */
export function productVerdict(product: Product, now: number): BoughtVerdict | undefined {
  const { item } = product;
  if (!item) return undefined;
  return boughtVerdict({
    paidCents: item.paidCents,
    latestCents: item.latestCents,
    windowEndsAt: item.windowEndsAt,
    claimStatus: item.claim?.status,
    now,
    currency: item.currency,
  });
}

/** Products with money to claim right now lead; everything else keeps the order it came in. */
export function claimNowFirst(products: Product[], now: number): Product[] {
  const claimable = (product: Product) => productVerdict(product, now)?.kind === "claim_now";
  return [...products.filter(claimable), ...products.filter((product) => !claimable(product))];
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

/**
 * The sum of every product's price at each observation time. A product's last known
 * price is carried forward, and its first price is carried back, so the line moves
 * only when a price moved, never because a product joined the list.
 */
export function aggregateSeries(products: Product[]): SeriesPoint[] {
  const priced = products.filter((p) => p.series.length > 0);
  const times = [...new Set(priced.flatMap((p) => p.series.map((s) => s.at)))].sort((a, b) => a - b);
  return times.map((at) => ({
    at,
    value: priced.reduce((sum, product) => {
      let known = product.series[0].value;
      for (const s of product.series) {
        if (s.at > at) break;
        known = s.value;
      }
      return sum + known * product.qty;
    }, 0),
  }));
}

/** The flat comparison level under an aggregate: what the same products cost at first sight, or what was paid. */
export function baselineCents(products: Product[]): number {
  return products
    .filter((p) => p.series.length > 0)
    .reduce((sum, p) => sum + (p.basisCents ?? p.series[0].value) * p.qty, 0);
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

/** The currency most products use; mixed-currency sums are labelled with it. */
export function mainCurrency(products: Product[]): string {
  const counts = new Map<string, number>();
  for (const p of products) counts.set(p.currency, (counts.get(p.currency) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
}
