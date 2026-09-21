/**
 * Un-stamping `items.nextCheckAt` so a resurrected item is reconsidered by
 * `priceWatch`'s very next tick instead of resting behind whatever stamp
 * `eligibleItems` last gave it -- up to `INELIGIBLE_REST_MS` (a year) for a
 * permanently-ineligible stamp, or up to `WATCH_CHECK_INTERVAL_MS` for a
 * transient one (C3/D107, Opus checkpoint-5 recheck).
 *
 * Both helpers only patch rows the caller already loaded and owns in its own
 * mutation transaction -- neither one authorizes or resolves ownership
 * itself.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Bound on one call: the caller passes ids it already loaded in this same transaction (a purchase's own items, at most `MAX_ITEMS_PER_PURCHASE`), never an unbounded list. */
const MAX_ITEM_IDS = 50;

/** Purchases scanned per merchant by `clearMerchantItemSchedule` -- see its doc comment. */
const MAX_MERCHANT_PURCHASES = 50;
/** Items un-stamped per merchant, total, across every purchase scanned. */
const MAX_MERCHANT_ITEMS = 200;

/**
 * Clears `nextCheckAt` on up to `MAX_ITEM_IDS` items so `items.by_nextCheck`
 * sorts them back to the scan's head (`undefined` sorts before every stamped
 * row, ascending -- see priceWatch.test.ts's own assertion of this). A
 * missing id is silently skipped; callers are trusted to have already
 * resolved ownership (they pass ids read inside their own transaction).
 * Idempotent: an item already due (`nextCheckAt` already `undefined`) costs
 * no write.
 */
export async function clearItemSchedule(ctx: MutationCtx, itemIds: Array<Id<"items">>): Promise<void> {
  for (const itemId of itemIds.slice(0, MAX_ITEM_IDS)) {
    const item = await ctx.db.get(itemId);
    if (!item || item.nextCheckAt === undefined) continue;
    await ctx.db.patch(itemId, { nextCheckAt: undefined });
  }
}

/**
 * Clears `nextCheckAt` on every item this user owns at one merchant -- called
 * from `policies.confirm` and `policies.refresh` (via `clearMerchantSchedule`)
 * when the confirmed/refreshed snapshot is `price_adjustment`: a reopened or
 * newly-opened window means the merchant's items may have been sitting on a
 * permanent (or merely stale) ineligibility stamp that no longer holds.
 *
 * There is no index straight from `(userId, merchantDomain)` to `items` --
 * items key off `purchaseId` and `userId` only -- so this goes through the
 * merchant's purchases first and each purchase's own `items.by_purchase`
 * range, exactly the shape `tracking.overview` already uses for a
 * per-purchase item page.
 *
 * Purchase order/skip rule (6a-6/D112, Opus checkpoint 6a): the ideal source
 * would be `purchases.by_user_status` (`userId`+`status`) read `desc` and
 * filtered to this merchant -- true newest-first among ACTIVE purchases only,
 * for free from the index. That index carries no `merchantDomain` field,
 * though, so it cannot be equality-scoped to one merchant; walking every one
 * of a user's `active` purchases across every merchant just to find this
 * one's would cost far more reads than the purchase list this function is
 * trying to stay cheap for. So this falls back to the one index that IS
 * merchant-scoped, `by_user_domain_order` (`userId`, `merchantDomain`,
 * `orderRef`), read `.order("desc")`. Because `orderRef` is optional and most
 * purchases never set it, rows tied on it (the common case) fall back to the
 * index's implicit trailing `_creationTime`, descending -- a true newest-first
 * scan. A merchant whose purchases carry distinct, non-chronological order
 * numbers instead sorts primarily by that string; this is a known,
 * accepted imprecision of the fallback, not something a domain-scoped index
 * over `_creationTime` could fix without one existing.
 *
 * The skip rule, exactly: every row this scan reads counts against
 * `MAX_MERCHANT_PURCHASES` the moment it is read -- archived, needs_review,
 * and example rows included, since the index has no way to leave them out
 * before reading them. Only a row that is BOTH `status === "active"` AND not
 * `isExample` ever has its items looked at (query + patch); every other row
 * costs one read and nothing else. So a merchant with many non-active or
 * example purchases interleaved among its active ones can still starve some
 * active purchases out of this pass -- unchanged from before this fix, and
 * still bounded by the same fallback the file already documents: a missed
 * item picks the fix up on its own next scheduled tick instead (at most
 * `WATCH_CHECK_INTERVAL_MS`, or in the worst case `INELIGIBLE_REST_MS`,
 * later).
 *
 * `MAX_MERCHANT_PURCHASES` (50) and `MAX_MERCHANT_ITEMS` (200) were measured,
 * not just kept: `lib/schedule.test.ts`'s "read cost" test reads real
 * `ctx.meta.getTransactionMetrics()` numbers for this function at 50
 * purchases, and both are far under Convex's own per-transaction ceilings
 * (32,000 documents read, 4,096 index-range queries -- see that test for the
 * exact counts). Raising `MAX_MERCHANT_PURCHASES` toward
 * `MAX_PURCHASES_PER_USER` (200) would stay under those hard ceilings too,
 * but is deliberately NOT done here: a single user with more than 50 active
 * purchases at ONE merchant is already an extreme outlier next to
 * `MAX_PURCHASES_PER_USER`'s 200-purchases-total-across-every-merchant cap,
 * and this is a rarely-invoked correctness nicety (an immediate resurrection)
 * riding on a call this same file already documents as "bounded and,
 * honestly, incomplete" -- the existing next-tick fallback already bounds the
 * worst case to `WATCH_CHECK_INTERVAL_MS`/`INELIGIBLE_REST_MS` later, so
 * quadrupling this function's worst-case read cost buys a rare edge case
 * very little. Revisit if a real account is ever seen to need it.
 */
export async function clearMerchantItemSchedule(
  ctx: MutationCtx,
  userId: Id<"users">,
  merchantDomain: string,
): Promise<void> {
  const purchases = await ctx.db
    .query("purchases")
    .withIndex("by_user_domain_order", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain))
    .order("desc")
    .take(MAX_MERCHANT_PURCHASES);

  let remaining = MAX_MERCHANT_ITEMS;
  for (const purchase of purchases) {
    if (remaining <= 0) break;
    // Skip rule: a non-active or example purchase counts against the raw
    // scan above (it was already read) but never against the items budget --
    // its items are never queried or patched.
    if (purchase.status !== "active" || purchase.isExample) continue;
    const items = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
      .take(remaining);
    remaining -= items.length;
    for (const item of items) {
      if (item.nextCheckAt === undefined) continue;
      await ctx.db.patch(item._id, { nextCheckAt: undefined });
    }
  }
}
