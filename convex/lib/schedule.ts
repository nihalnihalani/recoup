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
 * from `policies.confirm` and `policies.refresh` when the confirmed/refreshed
 * snapshot is `price_adjustment`: a reopened or newly-opened window means the
 * merchant's items may have been sitting on a permanent (or merely stale)
 * ineligibility stamp that no longer holds.
 *
 * There is no index straight from `(userId, merchantDomain)` to `items` --
 * items key off `purchaseId` and `userId` only -- so this goes through the
 * merchant's purchases first (`purchases.by_user_domain_order`, using only
 * its `userId`+`merchantDomain` prefix) and each purchase's own
 * `items.by_purchase` range, exactly the shape `tracking.overview` already
 * uses for a per-purchase item page.
 *
 * Bounded and, honestly, incomplete for an outsized account:
 * `MAX_MERCHANT_PURCHASES` (50) purchases scanned and `MAX_MERCHANT_ITEMS`
 * (200) items un-stamped in total. A merchant with more purchases than that,
 * or whose scanned purchases together hold more than 200 items, will have
 * some items miss this immediate reset -- they simply pick the fix up on
 * their own next scheduled tick instead (at most `WATCH_CHECK_INTERVAL_MS`,
 * or in the worst case `INELIGIBLE_REST_MS`, later). Nothing is lost or
 * double-charged, only delayed; this is a documented gap, not a correctness
 * bug.
 */
export async function clearMerchantItemSchedule(
  ctx: MutationCtx,
  userId: Id<"users">,
  merchantDomain: string,
): Promise<void> {
  const purchases = await ctx.db
    .query("purchases")
    .withIndex("by_user_domain_order", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain))
    .take(MAX_MERCHANT_PURCHASES);

  let remaining = MAX_MERCHANT_ITEMS;
  for (const purchase of purchases) {
    if (remaining <= 0) break;
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
