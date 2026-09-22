import { ConvexError } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * The fields a retail transaction mirrors from its purchase (contract §2.2). Everything else on the row
 * (`liveFactCount`, `relatedTransactionId`, `sourceEvidenceId`, `naturalKey`) is owned by other writers and never
 * touched here.
 */
function mirror(purchase: Doc<"purchases">) {
  return {
    status: purchase.status,
    counterpartyName: purchase.merchant,
    counterpartyDomain: purchase.merchantDomain,
    currency: purchase.currency,
    transactedAt: purchase.purchasedAt,
    // DA-A-35: an example purchase's transaction is an example too, so every summary that reads transactions (or
    // anything keyed on them) can exclude it without joining back to `purchases`. Only `true` is copied, so a real
    // purchase's row never carries the field at all.
    isExample: purchase.isExample === true ? (true as const) : undefined,
  };
}

/**
 * The category-neutral parent of a retail purchase (contract §2.2): idempotent, 1:1 through
 * `transactions.by_purchase`. Concurrent callers serialize under OCC because each one reads the same index range
 * before inserting, so at most one row is ever created (CT-3). An existing row is re-synced to the purchase's current
 * status, merchant, currency and date, so calling this from every insert AND confirm path keeps the mirror current.
 *
 * Must be called from every `insert("purchases"` site (DA-A-35; `transactions.test.ts` enumerates them) and from
 * `purchases.confirm`/`remove`. Takes no userId: the purchase row is the authority on ownership, and every caller has
 * already authorised the purchase (or just inserted it).
 */
export async function ensurePurchaseTransaction(
  ctx: MutationCtx,
  purchaseId: Id<"purchases">,
): Promise<Id<"transactions">> {
  const purchase = await ctx.db.get(purchaseId);
  if (!purchase) throw new ConvexError("Purchase not found");
  const fields = mirror(purchase);
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
    .first();
  if (existing) {
    const changed =
      existing.status !== fields.status ||
      existing.counterpartyName !== fields.counterpartyName ||
      existing.counterpartyDomain !== fields.counterpartyDomain ||
      existing.currency !== fields.currency ||
      existing.transactedAt !== fields.transactedAt ||
      existing.isExample !== fields.isExample;
    if (changed) await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return await ctx.db.insert("transactions", {
    userId: purchase.userId,
    category: "retail_order",
    purchaseId,
    liveFactCount: 0,
    ...fields,
  });
}
