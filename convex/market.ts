/**
 * Third-party price history (W1b, day one).
 *
 * Our own history starts when a watch starts, so a brand-new watch can only say
 * "not enough history yet". ShopSavvy has indexed retail prices for years, so
 * one call per watched product gives a range a shopper has actually seen, plus
 * the other stores selling it.
 *
 * Boundaries, enforced here and relied on elsewhere:
 *  - Prices from this source are written to `marketPrices` and to `offers` rows
 *    marked `source: "shopsavvy"`. They are never written to `watchChecks`,
 *    which is the record of what Recoup read itself.
 *  - They never open a claim and never send an alert. Both of those are
 *    statements about money and stay with our own read of the store's page.
 *  - One lookup per watch, ever (`watches.marketFetchedAt`), because the trial
 *    plan bills 3 credits plus one per day of history requested.
 */
import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedWatch, requireUserId } from "./lib/access";
import { charge } from "./lib/budget";
import { cleanStoreUrl } from "./lib/offerMatch";
import { marketStats, parseSnapshot, flattenHistory, hostOf, type MarketSnapshot } from "./lib/shopsavvy";
import { MARKET_HISTORY_DAYS, MARKET_MAX_POINTS, MARKET_MAX_STORES } from "./limits";
import { cleanLine } from "./lib/text";

const BASE_URL = "https://api.shopsavvy.com/v1";
const TIMEOUT_MS = 30_000;
const MAX_NOTE_CHARS = 300;

/**
 * A day of history costs a credit, so the window is a constant and never a caller's argument.
 * The parameter names are `start`/`end`: `start_date`/`end_date` are accepted and silently
 * ignored, which returns every offer with an empty history array (found live).
 */
function historyRange(now: number): { start: string; end: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(now - MARKET_HISTORY_DAYS * 86_400_000), end: day(now) };
}

/**
 * One live call. Returns null when the key is unset (the feature is simply off)
 * and throws with a readable message on anything else, so the caller can store
 * the reason against the watch.
 */
export async function fetchSnapshot(productUrl: string, now: number): Promise<MarketSnapshot | null> {
  const key = process.env.SHOPSAVVY_API_KEY;
  if (!key) return null;

  const { start, end } = historyRange(now);
  const url =
    `${BASE_URL}/products/offers/history?ids=${encodeURIComponent(productUrl)}` +
    `&start=${start}&end=${end}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // The body can carry the key back in an echoed request; only the status is safe to keep.
    throw new Error(`ShopSavvy returned ${res.status}`);
  }
  return parseSnapshot(await res.json());
}

export const watchForMarket = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.union(
    v.object({ productUrl: v.string(), currency: v.string(), merchantDomain: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.status === "archived") return null;
    if (watch.marketFetchedAt !== undefined) return null;
    return {
      productUrl: watch.productUrl,
      currency: watch.currency ?? "USD",
      merchantDomain: watch.merchantDomain,
    };
  },
});

const pointArg = v.object({
  retailer: v.string(),
  storeDomain: v.optional(v.string()),
  cents: v.number(),
  currency: v.string(),
  observedAt: v.number(),
  marketKey: v.string(),
});

const storeArg = v.object({
  retailer: v.string(),
  storeDomain: v.string(),
  productUrl: v.string(),
  cents: v.optional(v.number()),
  currency: v.optional(v.string()),
  observedAt: v.optional(v.number()),
});

/**
 * Writes one lookup's result. Stamps `marketFetchedAt` whatever happened, so a
 * product ShopSavvy does not know is never asked about twice.
 */
export const recordSnapshot = internalMutation({
  args: {
    watchId: v.id("watches"),
    points: v.array(pointArg),
    stores: v.array(storeArg),
    note: v.optional(v.string()),
  },
  returns: v.object({ points: v.number(), stores: v.number() }),
  handler: async (ctx, { watchId, points, stores, note }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return { points: 0, stores: 0 };
    const now = Date.now();
    await ctx.db.patch(watchId, { marketFetchedAt: now, marketNote: note });

    let written = 0;
    for (const point of points.slice(0, MARKET_MAX_POINTS)) {
      const existing = await ctx.db
        .query("marketPrices")
        .withIndex("by_key", (q) => q.eq("watchId", watchId).eq("marketKey", point.marketKey))
        .unique();
      if (existing) continue;
      await ctx.db.insert("marketPrices", { ...point, watchId, userId: watch.userId });
      written++;
    }

    // Stores ShopSavvy lists become offer candidates: the user still confirms each match (W3),
    // and an unconfirmed offer never drives a verdict or an alert.
    const rows = await ctx.db
      .query("offers")
      .withIndex("by_watch", (q) => q.eq("watchId", watchId))
      .take(MARKET_MAX_STORES * 3);
    const known = new Set(rows.map((r) => r.storeDomain));
    let added = 0;
    for (const store of stores.slice(0, MARKET_MAX_STORES)) {
      if (known.has(store.storeDomain)) continue;
      known.add(store.storeDomain);
      await ctx.db.insert("offers", {
        watchId,
        userId: watch.userId,
        storeDomain: store.storeDomain,
        productUrl: store.productUrl,
        title: store.retailer,
        status: "candidate",
        source: "shopsavvy",
        lastCents: store.cents,
        currency: store.currency,
        lastCheckedAt: store.observedAt,
        note: "Listed by ShopSavvy; confirm it is the same item",
      });
      added++;
    }
    return { points: written, stores: added };
  },
});

/**
 * Asks ShopSavvy about one watched product. Never throws past the scheduler: a
 * refusal or an unknown product ends as a note on the watch, and watching
 * carries on with our own reads.
 */
export const lookup = internalAction({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.runQuery(internal.market.watchForMarket, { watchId });
    if (!watch) return null;

    const now = Date.now();
    let snapshot: MarketSnapshot | null = null;
    let note: string | undefined;
    try {
      snapshot = await fetchSnapshot(watch.productUrl, now);
      if (snapshot === null) note = "Market history is not configured on this deployment";
    } catch (err) {
      note = cleanLine(
        `Could not read market history: ${err instanceof Error ? err.message : String(err)}`,
      ).slice(0, MAX_NOTE_CHARS);
    }

    if (!snapshot) {
      await ctx.runMutation(internal.market.recordSnapshot, { watchId, points: [], stores: [], note });
      return null;
    }

    const ownDomain = hostOf(watch.productUrl) ?? watch.merchantDomain;
    const points = flattenHistory(snapshot, watch.currency)
      .slice(-MARKET_MAX_POINTS)
      .map((p) => {
        const day = new Date(p.observedAt).toISOString().slice(0, 10);
        const store = p.storeDomain ?? p.retailer ?? "unknown";
        return {
          retailer: p.retailer ?? store,
          storeDomain: p.storeDomain ?? undefined,
          cents: p.cents,
          currency: watch.currency,
          observedAt: p.observedAt,
          // Store AND day: two stores priced on one day are two facts, not a collision.
          marketKey: `${store}:${day}`,
        };
      });

    const stores: Array<{
      retailer: string;
      storeDomain: string;
      productUrl: string;
      cents?: number;
      currency?: string;
      observedAt?: number;
    }> = [];
    for (const offer of snapshot.offers) {
      // A marketplace seller's listing is not the store's own price.
      if (offer.seller !== null || offer.productUrl === null) continue;
      const cleaned = cleanStoreUrl(offer.productUrl);
      if (!cleaned || cleaned.storeDomain === ownDomain) continue;
      stores.push({
        retailer: offer.retailer,
        storeDomain: cleaned.storeDomain,
        productUrl: cleaned.productUrl,
        cents: offer.cents ?? undefined,
        currency: offer.currency ?? undefined,
        observedAt: offer.observedAt ?? undefined,
      });
    }

    await ctx.runMutation(internal.market.recordSnapshot, {
      watchId,
      points,
      stores,
      note: points.length === 0 ? "ShopSavvy has no price history for this product" : undefined,
    });
    return null;
  },
});

/** Every market point for a watch, oldest first. Used by the verdict and the chart. */
export async function marketPointsFor(
  ctx: QueryCtx,
  watchId: Id<"watches">,
): Promise<Array<Doc<"marketPrices">>> {
  return await ctx.db
    .query("marketPrices")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .take(MARKET_MAX_POINTS);
}

/**
 * A user asking for market history on a watch that has none yet (the automatic
 * lookup runs once, after the first accepted price). Budgeted like any paid call.
 */
export const refresh = mutation({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, watchId, userId);
    if (watch.status === "archived") throw new ConvexError("This item is no longer being watched");
    if (watch.marketFetchedAt !== undefined) {
      throw new ConvexError("Market history has already been looked up for this item");
    }
    await charge(ctx, userId, "market_lookup");
    await ctx.scheduler.runAfter(0, internal.market.lookup, { watchId });
    return null;
  },
});

export { marketStats };
