import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { claimStatus, claimType } from "./schema";
import { claimBalance } from "./lib/balance";
import { windowEndsAt } from "./lib/ledger";
import { latest } from "./policies";

/** Most recent purchases the dashboard reads; older ones stay reachable from their own page. */
const MAX_PURCHASES = 60;
/** Observations kept per item for the chart, newest first in the read, oldest first in the payload. */
const MAX_POINTS = 90;

const point = v.object({ at: v.number(), cents: v.number() });

const trackedItem = v.object({
  itemId: v.id("items"),
  purchaseId: v.id("purchases"),
  name: v.string(),
  merchant: v.string(),
  merchantDomain: v.string(),
  currency: v.string(),
  qty: v.number(),
  paidCents: v.number(),
  productUrl: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  purchasedAt: v.optional(v.number()),
  isExample: v.boolean(),
  /** Price-adjustment window from the latest policy snapshot, when one states it. */
  windowDays: v.optional(v.number()),
  windowEndsAt: v.optional(v.number()),
  /** Priced observations only, oldest first. Unpriced checks are counted, not plotted. */
  points: v.array(point),
  checks: v.number(),
  lastCheckedAt: v.optional(v.number()),
  latestCents: v.optional(v.number()),
  lowestCents: v.optional(v.number()),
  /** paid minus latest, per unit. Negative when the price went up. */
  dropCents: v.optional(v.number()),
  claim: v.optional(
    v.object({
      claimId: v.id("claims"),
      type: claimType,
      status: claimStatus,
      expectedCents: v.number(),
      unresolvedCents: v.number(),
      confirmedCents: v.number(),
    }),
  ),
});

/**
 * Everything the price dashboard draws, in one reactive read: each owned item
 * with its paid price, its observed price history and the claim a drop opened.
 * Signed-out callers get an empty dashboard rather than an error.
 */
export const overview = query({
  args: {},
  returns: v.object({
    items: v.array(trackedItem),
    totals: v.object({
      tracked: v.number(),
      watching: v.number(),
      foundCents: v.number(),
      recoveredCents: v.number(),
      checks: v.number(),
    }),
    capped: v.boolean(),
  }),
  handler: async (ctx) => {
    const empty = {
      items: [],
      totals: { tracked: 0, watching: 0, foundCents: 0, recoveredCents: 0, checks: 0 },
      capped: false,
    };
    const userId = await getAuthUserId(ctx);
    if (!userId) return empty;

    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_PURCHASES + 1);
    const capped = purchases.length > MAX_PURCHASES;
    const now = Date.now();

    const items = [];
    let watching = 0;
    let foundCents = 0;
    let recoveredCents = 0;
    let checks = 0;

    for (const purchase of purchases.slice(0, MAX_PURCHASES)) {
      if (purchase.status !== "active") continue;
      const policy = await latest(ctx, userId, purchase.merchantDomain, "price_adjustment");
      const windowDays = policy?.windowDays;
      const ends =
        windowDays !== undefined && purchase.purchasedAt !== undefined
          ? windowEndsAt(purchase.purchasedAt, windowDays)
          : undefined;

      const rows = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
        .collect();

      for (const item of rows) {
        const recent = await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", item._id))
          .order("desc")
          .take(MAX_POINTS);
        const points = recent
          .filter((c) => c.observedCents !== undefined)
          .map((c) => ({ at: c.observedAt, cents: c.observedCents as number }))
          .reverse();
        const latestPoint = points[points.length - 1];

        const claims = await ctx.db
          .query("claims")
          .withIndex("by_item", (q) => q.eq("itemId", item._id))
          .collect();
        const priceClaim = claims
          .filter((c) => c.type === "price_adjustment" && c.status !== "dismissed")
          .sort((a, b) => b._creationTime - a._creationTime)[0];
        const balance = priceClaim ? await claimBalance(ctx, priceClaim) : undefined;

        const isExample = purchase.isExample === true;
        if (item.productUrl && !item.returned && ends !== undefined && ends > now) watching += 1;
        checks += recent.length;
        if (priceClaim && balance && !isExample) {
          foundCents += Math.max(balance.unresolved, 0);
          recoveredCents += Math.max(balance.confirmed - balance.debited, 0);
        }

        items.push({
          itemId: item._id,
          purchaseId: purchase._id,
          name: item.name,
          merchant: purchase.merchant,
          merchantDomain: purchase.merchantDomain,
          currency: purchase.currency,
          qty: item.qty,
          paidCents: item.unitCents,
          productUrl: item.productUrl,
          imageUrl: item.imageUrl,
          purchasedAt: purchase.purchasedAt,
          isExample,
          windowDays,
          windowEndsAt: ends,
          points,
          checks: recent.length,
          lastCheckedAt: recent[0]?.observedAt,
          latestCents: latestPoint?.cents,
          lowestCents: points.length > 0 ? Math.min(...points.map((p) => p.cents)) : undefined,
          dropCents: latestPoint ? item.unitCents - latestPoint.cents : undefined,
          claim:
            priceClaim && balance
              ? {
                  claimId: priceClaim._id,
                  type: priceClaim.type,
                  status: priceClaim.status,
                  expectedCents: priceClaim.expectedCents,
                  unresolvedCents: balance.unresolved,
                  confirmedCents: balance.confirmed,
                }
              : undefined,
        });
      }
    }

    return {
      items,
      totals: { tracked: items.length, watching, foundCents, recoveredCents, checks },
      capped,
    };
  },
});
