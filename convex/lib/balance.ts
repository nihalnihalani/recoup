import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { balance } from "./ledger";

/** The derived money shape of a claim; `returns:` validators import this. */
export const balanceValidator = v.object({
  expected: v.number(),
  promised: v.number(),
  confirmed: v.number(),
  debited: v.number(),
  unresolved: v.number(),
});

/** Every ledger event on a claim, oldest first. */
export async function claimEvents(ctx: QueryCtx | MutationCtx, claimId: Id<"claims">) {
  return await ctx.db
    .query("ledgerEvents")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .collect();
}

/** Derives a claim's balance from its append-only ledger (never stored). */
export async function claimBalance(
  ctx: QueryCtx | MutationCtx,
  claim: { _id: Id<"claims">; expectedCents: number },
) {
  return balance(claim.expectedCents, await claimEvents(ctx, claim._id));
}

/** Every claim on an item, each with its derived balance. */
export async function claimsWithBalance(ctx: QueryCtx, itemId: Id<"items">) {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .collect();
  return await Promise.all(
    claims.map(async (claim) => ({ ...claim, balance: await claimBalance(ctx, claim) })),
  );
}
