import { v } from "convex/values";
import { query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { claimStatus, claimType } from "./schema";
import { claimBalance } from "./lib/balance";
import { windowEndsAt } from "./lib/ledger";
import { latest } from "./policies";
import { assertCoarseNow } from "./watches";
import { MAX_ITEMS_PER_PURCHASE } from "./limits";
import { isTombstoned } from "./lib/accountState";

/** Most recent purchases the dashboard reads; older ones stay reachable from their own page. */
const MAX_PURCHASES = 60;
/**
 * Observations read per item for the chart, newest first in the read, oldest
 * first in the payload. D93: lowered from 90 to 12, matching `insights.ts`'s
 * `CHECKS_PER_PRODUCT`, for the same reason that constant is 12: even
 * bounded per item, a large document COUNT is not this query's actual
 * failure mode (see F3/D103 below).
 *
 * F3 (D103) correction to this comment's earlier claim: the crash this
 * query hit at owner maxima (60 purchases x 50 items x 12 checks) was never
 * "too many documents read" (that ceiling is 32,000, and this shape stays
 * under it) -- it was Convex's SEPARATE "Too many index ranges read (4096)"
 * limit, which counts every `.withIndex(...)` query issued in the
 * transaction, not the documents they return. The old code issued two such
 * queries per item (priceChecks, and a claims lookup) on top of one per
 * purchase (policy, items page): 60 x (2 + 50 x 2) = 6,120 ranges, over the
 * limit regardless of MAX_POINTS. The fix has two parts: the per-item claims
 * query became one per-purchase query (`by_purchase_type`, grouped by item
 * in memory, below), and `MAX_ITEMS_TOTAL` caps the grand total of items
 * whose checks/claim get read across every purchase combined -- per-purchase
 * bounds alone cannot stop the purchases x items product from growing
 * without limit as an account gets bigger.
 */
const MAX_POINTS = 12;
/**
 * C1 (D107, Opus checkpoint-5 recheck): ceiling on the total number of items
 * `overview` reads price history and a claim for, across every purchase
 * combined -- see MAX_POINTS' doc comment. Budgeted by ROWS ACTUALLY READ,
 * purchase by purchase, as the loop below goes (`take(min(cap, remaining) +
 * 1)`), not allotted up front per purchase before any of it is spent: the
 * earlier version divided this budget into MAX_ITEMS_PER_PURCHASE-sized
 * shares for every one of the (up to 60) purchases before reading a single
 * item, which at MAX_ITEMS_PER_PURCHASE=50 meant only the newest 5 purchases
 * (250/50) were ever allotted anything at all -- a purchase with, say, one
 * item still got a full 50-item share subtracted from the shared pool, and
 * every purchase after the 5th got a zero share and no items rendered,
 * however small. Budgeting off what each purchase actually returns fixes
 * this: 6 purchases with 1 item each now all render (6 <= 250), and the
 * budget is only ever spent on rows that exist.
 */
const MAX_ITEMS_TOTAL = 250;

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
 * Signed-out callers get an empty dashboard rather than an error -- and, per
 * D115 6b-3/T18.3, so does a tombstoned (`accountState` status
 * `deleting`/`deleted`) caller, so a just-revoked but still momentarily valid
 * JWT cannot keep reading this account's dashboard mid-purge.
 *
 * `now` (P06/D73, optional, same contract as `watches.list`/`get`) drives
 * only the display-derived `watching` count. When omitted, each purchase
 * falls back to its own `purchasedAt` (never `Date.now()`), which can only
 * ever make a window look open, never falsely closed.
 */
export const overview = query({
  args: { now: v.optional(v.number()) },
  returns: v.object({
    items: v.array(trackedItem),
    totals: v.object({
      tracked: v.number(),
      watching: v.number(),
      /**
       * F5b (D103): money in `purchases.currency` for `primaryCurrency` only
       * (D72: never summed across currencies) -- the currency with the most
       * combined found+recovered money, ties broken by whichever purchase
       * was read first (newest first). `null`/all-zero when nothing has a
       * price-adjustment claim yet, or the caller has no active purchases.
       * `byCurrency` below always has the complete, per-currency breakdown;
       * these three fields exist for callers that only want one headline
       * number and are willing to see it scoped to one currency rather than
       * a meaningless cross-currency sum.
       */
      foundCents: v.number(),
      recoveredCents: v.number(),
      checks: v.number(),
      /** Unresolved money on labelled example purchases, in `primaryCurrency`; excluded from foundCents (D27). */
      exampleFoundCents: v.number(),
      /** True when the account's claims span more than one currency (F5b/D103): `byCurrency` is the honest total, the three fields above are only a partial view. */
      mixedCurrencies: v.boolean(),
      /** ISO 4217 code the three totals above are scoped to, or `null` when there is no money to report yet. */
      primaryCurrency: v.union(v.string(), v.null()),
      /** The complete per-currency breakdown (F5b/D103), one entry per currency any active purchase's claims touched. */
      byCurrency: v.record(v.string(), v.object({ foundCents: v.number(), recoveredCents: v.number(), exampleFoundCents: v.number() })),
    }),
    /** True when the purchase list and/or some purchase's item list was cut off (P07/D93): the UI should say so rather than silently showing a partial account. */
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const empty = {
      items: [],
      totals: {
        tracked: 0, watching: 0, foundCents: 0, recoveredCents: 0, checks: 0, exampleFoundCents: 0,
        mixedCurrencies: false, primaryCurrency: null, byCurrency: {},
      },
      truncated: false,
    };
    const userId = await getAuthUserId(ctx);
    if (!userId || (await isTombstoned(ctx, userId))) return empty;

    // F6 (D103): scoped to "active" by the index itself, like insights.ts's
    // userPurchases -- not a `by_user` page filtered by status afterward,
    // which could push an active purchase out of the page entirely behind
    // enough newer archived/needs_review ones (the same P05-shaped bug D72
    // already fixed in insights.ts).
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
      .order("desc")
      .take(MAX_PURCHASES + 1);
    let truncated = purchases.length > MAX_PURCHASES;
    const validatedNow = assertCoarseNow(args.now);

    // C1 (D107): the shared item budget is spent as the loop below actually
    // reads rows, not allotted per purchase up front -- see MAX_ITEMS_TOTAL's
    // doc comment.
    let itemsRoom = MAX_ITEMS_TOTAL;

    const items = [];
    let watching = 0;
    let checks = 0;
    // F5b (D103): accumulated per currency, never mixed (D72). See the
    // `byCurrency`/`primaryCurrency` doc comments above for how the single-
    // number legacy fields below are derived from this.
    type CurrencyTotals = { foundCents: number; recoveredCents: number; exampleFoundCents: number };
    const byCurrency = new Map<string, CurrencyTotals>();
    function currencyTotals(currency: string): CurrencyTotals {
      let row = byCurrency.get(currency);
      if (!row) {
        row = { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 };
        byCurrency.set(currency, row);
      }
      return row;
    }

    for (const purchase of purchases.slice(0, MAX_PURCHASES)) {
      if (itemsRoom <= 0) {
        // C1 (D107): the shared budget is spent; every purchase from here on
        // is cut entirely rather than read-and-discarded (an index range read
        // per purchase we already know will contribute nothing).
        truncated = true;
        break;
      }
      const cap = Math.min(MAX_ITEMS_PER_PURCHASE, itemsRoom);

      const policy = await latest(ctx, userId, purchase.merchantDomain, "price_adjustment");
      const windowDays = policy?.windowDays;
      const ends =
        windowDays !== undefined && purchase.purchasedAt !== undefined
          ? windowEndsAt(purchase.purchasedAt, windowDays)
          : undefined;
      const now = validatedNow ?? purchase.purchasedAt ?? purchase._creationTime;

      // C1 (D107): read one row past the cap so `truncated` reflects a REAL
      // cut (this purchase actually has more items than its share) rather
      // than firing whenever the shared budget happened to be tight.
      const probe = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
        .take(cap + 1);
      const overflow = probe.length > cap;
      if (overflow) truncated = true;
      const rows = overflow ? probe.slice(0, cap) : probe;
      itemsRoom -= rows.length;

      // F3 (D103): one range read for every non-dismissed price_adjustment
      // claim on this whole purchase (`by_purchase_type`), instead of one
      // per item -- grouped below to the newest claim per item, the same
      // pick `claims.filter(...).sort(...)[0]` made per item before. This is
      // what turns the per-purchase query count from O(items) into O(1),
      // the dominant fix for the "too many index ranges read" crash (see
      // MAX_POINTS' doc comment).
      const purchaseClaims = await ctx.db
        .query("claims")
        .withIndex("by_purchase_type", (q) => q.eq("purchaseId", purchase._id).eq("type", "price_adjustment"))
        .collect();
      const priceClaimByItem = new Map<string, (typeof purchaseClaims)[number]>();
      for (const c of purchaseClaims) {
        if (c.status === "dismissed") continue;
        const existing = priceClaimByItem.get(c.itemId);
        if (!existing || c._creationTime > existing._creationTime) priceClaimByItem.set(c.itemId, c);
      }

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

        const priceClaim = priceClaimByItem.get(item._id);
        const balance = priceClaim ? await claimBalance(ctx, priceClaim) : undefined;

        const isExample = purchase.isExample === true;
        if (item.productUrl && !item.returned && ends !== undefined && ends > now) watching += 1;
        checks += recent.length;
        if (priceClaim && balance && !isExample) {
          const t = currencyTotals(purchase.currency);
          t.foundCents += Math.max(balance.unresolved, 0);
          t.recoveredCents += Math.max(balance.confirmed - balance.debited, 0);
        } else if (priceClaim && balance && isExample) {
          // Never mixed into real totals (D27); reported apart so the UI can explain a $0 headline over example rows.
          currencyTotals(purchase.currency).exampleFoundCents += Math.max(balance.unresolved, 0);
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

    // F5b (D103): pick the currency with the most combined found+recovered
    // money as `primaryCurrency` for the legacy single-number fields (ties,
    // including all-zero, broken by iteration order -- purchases were read
    // newest first, so that is "the most recently touched currency").
    let primaryCurrency: string | null = null;
    let primaryScore = -1;
    for (const [currency, t] of byCurrency) {
      const score = t.foundCents + t.recoveredCents;
      if (score > primaryScore) {
        primaryScore = score;
        primaryCurrency = currency;
      }
    }
    const primary = primaryCurrency ? byCurrency.get(primaryCurrency)! : { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 };

    return {
      items,
      totals: {
        tracked: items.length,
        watching,
        foundCents: primary.foundCents,
        recoveredCents: primary.recoveredCents,
        checks,
        exampleFoundCents: primary.exampleFoundCents,
        mixedCurrencies: byCurrency.size > 1,
        primaryCurrency,
        byCurrency: Object.fromEntries(byCurrency),
      },
      truncated,
    };
  },
});
