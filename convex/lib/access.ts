import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isTombstoned } from "./accountState";

type Ctx = QueryCtx | MutationCtx;

/**
 * Resolves the signed-in user, refusing one being deleted or already deleted
 * (D77): the single choke point every query/mutation goes through, so a
 * tombstoned account cannot mint new sessions, claims, or mail through any
 * caller of this helper. One indexed read (`accountState.by_user`).
 */
export async function requireUserId(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  if (await isTombstoned(ctx, userId)) throw new ConvexError("This account has been deleted");
  return userId;
}

export async function ownedPurchase(ctx: Ctx, purchaseId: Id<"purchases">, userId: Id<"users">) {
  const p = await ctx.db.get(purchaseId);
  if (!p || p.userId !== userId) throw new ConvexError("Purchase not found");
  return p;
}

export async function ownedItem(ctx: Ctx, itemId: Id<"items">, userId: Id<"users">) {
  const i = await ctx.db.get(itemId);
  if (!i || i.userId !== userId) throw new ConvexError("Item not found");
  return i;
}

export async function ownedClaim(ctx: Ctx, claimId: Id<"claims">, userId: Id<"users">) {
  const c = await ctx.db.get(claimId);
  if (!c || c.userId !== userId) throw new ConvexError("Claim not found");
  return c;
}

export async function ownedPolicy(ctx: Ctx, policyId: Id<"policies">, userId: Id<"users">) {
  const p = await ctx.db.get(policyId);
  if (!p || p.userId !== userId) throw new ConvexError("Policy not found");
  return p;
}

export async function ownedDraft(ctx: Ctx, draftId: Id<"drafts">, userId: Id<"users">) {
  const d = await ctx.db.get(draftId);
  if (!d || d.userId !== userId) throw new ConvexError("Draft not found");
  return d;
}

export async function ownedWatch(ctx: Ctx, watchId: Id<"watches">, userId: Id<"users">) {
  const w = await ctx.db.get(watchId);
  if (!w || w.userId !== userId) throw new ConvexError("Watch not found");
  return w;
}
