import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

/**
 * The only way a Convex function in this app learns who is calling
 * (ARCHITECTURE_PATTERNS §Auth). No public function ever takes a `userId`
 * argument; identity always comes from `ctx.auth` via this helper.
 */
export async function requireUserId(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
}

/** Loads a purchase, throwing the same "not found" for missing and not-owned. */
export async function ownedPurchase(ctx: Ctx, purchaseId: Id<"purchases">, userId: Id<"users">) {
  const purchase = await ctx.db.get(purchaseId);
  if (!purchase || purchase.userId !== userId) throw new ConvexError("Purchase not found");
  return purchase;
}

/** Loads an item, throwing the same "not found" for missing and not-owned. */
export async function ownedItem(ctx: Ctx, itemId: Id<"items">, userId: Id<"users">) {
  const item = await ctx.db.get(itemId);
  if (!item || item.userId !== userId) throw new ConvexError("Item not found");
  return item;
}

/** Loads a claim, throwing the same "not found" for missing and not-owned. */
export async function ownedClaim(ctx: Ctx, claimId: Id<"claims">, userId: Id<"users">) {
  const claim = await ctx.db.get(claimId);
  if (!claim || claim.userId !== userId) throw new ConvexError("Claim not found");
  return claim;
}
