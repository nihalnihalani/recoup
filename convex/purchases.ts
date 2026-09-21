import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedItem, ownedPurchase, requireUserId } from "./lib/access";
import { balance, netConfirmed } from "./lib/ledger";
import { assertCents, assertCurrency, assertQty, assertTimestamp } from "./lib/money";

const itemInput = v.object({
  name: v.string(),
  unitCents: v.number(),
  qty: v.number(),
  productUrl: v.optional(v.string()),
});

export const create = mutation({
  args: {
    merchant: v.string(),
    merchantDomain: v.string(),
    orderRef: v.optional(v.string()),
    purchasedAt: v.optional(v.number()),
    currency: v.string(),
    items: v.array(itemInput),
    sourceMessageId: v.optional(v.string()),
    status: v.optional(v.union(v.literal("needs_review"), v.literal("active"))),
    isExample: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { items, status, purchasedAt, ...rest } = args;
    const resolvedStatus = status ?? "active";
    if (resolvedStatus === "active" && purchasedAt === undefined) {
      throw new ConvexError("purchasedAt is required for an active purchase");
    }
    assertCurrency(args.currency);
    if (!args.merchantDomain.trim()) throw new ConvexError("merchantDomain must not be empty"); // D43
    if (items.length === 0) throw new ConvexError("items must not be empty"); // D43
    if (purchasedAt !== undefined) assertTimestamp(purchasedAt, "purchasedAt"); // D43
    for (const it of items) {
      assertCents(it.unitCents, "unitCents");
      assertQty(it.qty);
    }

    const purchaseId = await ctx.db.insert("purchases", {
      ...rest,
      purchasedAt,
      userId,
      status: resolvedStatus,
    });
    for (const it of items) {
      await ctx.db.insert("items", { ...it, purchaseId, userId, returned: false });
    }
    if (resolvedStatus === "active") {
      await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, {
        userId,
        merchantDomain: args.merchantDomain,
      });
    }
    return purchaseId;
  },
});

export const confirm = mutation({
  args: {
    purchaseId: v.id("purchases"),
    merchant: v.string(),
    merchantDomain: v.string(),
    orderRef: v.optional(v.string()),
    purchasedAt: v.number(),
    items: v.array(
      v.object({
        itemId: v.id("items"),
        name: v.string(),
        unitCents: v.number(),
        qty: v.number(),
        productUrl: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, args.purchaseId, userId);
    if (!args.merchantDomain.trim()) throw new ConvexError("merchantDomain must not be empty"); // D43
    if (args.items.length === 0) throw new ConvexError("items must not be empty"); // D43
    assertTimestamp(args.purchasedAt, "purchasedAt"); // D43
    for (const it of args.items) {
      const item = await ownedItem(ctx, it.itemId, userId);
      if (item.purchaseId !== args.purchaseId) {
        throw new ConvexError("Item does not belong to this purchase");
      }
      assertCents(it.unitCents, "unitCents");
      assertQty(it.qty);
    }
    await ctx.db.patch(args.purchaseId, {
      merchant: args.merchant,
      merchantDomain: args.merchantDomain,
      orderRef: args.orderRef,
      purchasedAt: args.purchasedAt,
      status: "active",
    });
    for (const it of args.items) {
      await ctx.db.patch(it.itemId, {
        name: it.name,
        unitCents: it.unitCents,
        qty: it.qty,
        productUrl: it.productUrl,
      });
    }
    await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, {
      userId,
      merchantDomain: args.merchantDomain,
    });
  },
});

export const setReturned = mutation({
  args: { itemId: v.id("items"), returned: v.boolean(), returnedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await ownedItem(ctx, args.itemId, userId);
    await ctx.db.patch(args.itemId, {
      returned: args.returned,
      returnedAt: args.returned ? (args.returnedAt ?? Date.now()) : undefined,
    });
  },
});

/**
 * "Removes" a purchase by archiving it (D47/R10): `status` becomes
 * `"archived"` rather than the row (and everything hanging off it) being
 * deleted. `board` and `get` both skip archived purchases, but every item,
 * claim, ledger event, draft, reply, note, and follow-up is left untouched
 * so the money history is preserved. Does not check ownership itself —
 * callers (`remove` here, `examples.remove` in T12) must verify the caller
 * owns the purchase before calling this.
 */
export async function removePurchase(ctx: MutationCtx, purchaseId: Id<"purchases">) {
  await ctx.db.patch(purchaseId, { status: "archived" });
}

export const remove = mutation({
  args: { purchaseId: v.id("purchases") },
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, purchaseId, userId);
    await removePurchase(ctx, purchaseId);
  },
});

async function claimsWithBalance(ctx: QueryCtx, itemId: Id<"items">) {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .collect();
  return Promise.all(
    claims.map(async (c) => {
      const events = await ctx.db
        .query("ledgerEvents")
        .withIndex("by_claim", (q) => q.eq("claimId", c._id))
        .collect();
      return { ...c, balance: balance(c.expectedCents, events) };
    }),
  );
}

const POLICY_KINDS = ["price_adjustment", "returns"] as const;

export const get = query({
  args: { purchaseId: v.id("purchases") },
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    const purchase = await ownedPurchase(ctx, purchaseId, userId);
    if (purchase.status === "archived") throw new ConvexError("Purchase not found"); // D47
    const rawItems = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect();
    const items = await Promise.all(
      rawItems.map(async (it) => ({
        ...it,
        claims: await claimsWithBalance(ctx, it._id),
        priceChecks: await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", it._id))
          .order("desc")
          .take(30),
      })),
    );
    // Latest snapshot per kind for this user+domain (D17).
    const policyRows = await Promise.all(
      POLICY_KINDS.map((kind) =>
        ctx.db
          .query("policies")
          .withIndex("by_user_domain_kind", (q) =>
            q.eq("userId", userId).eq("merchantDomain", purchase.merchantDomain).eq("kind", kind),
          )
          .order("desc")
          .first(),
      ),
    );
    const policies = policyRows.filter((p): p is Doc<"policies"> => p !== null);
    return { purchase, items, policies };
  },
});

export const board = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const allPurchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    const purchases = allPurchases.filter((p) => p.status !== "archived"); // D47
    let owed = 0,
      asked = 0,
      confirmed = 0;
    const rows = await Promise.all(
      purchases.map(async (p) => {
        const items = await ctx.db
          .query("items")
          .withIndex("by_purchase", (q) => q.eq("purchaseId", p._id))
          .collect();
        const claims = (await Promise.all(items.map((it) => claimsWithBalance(ctx, it._id)))).flat();
        for (const c of claims) {
          // Dismissed and example claims never contribute to real money
          // totals -- checked per-claim (D48), not just per-purchase (D27),
          // since a claim can carry its own isExample independent of its
          // purchase's flag.
          if (c.status === "dismissed" || c.isExample) continue;
          confirmed += netConfirmed(c.balance); // D39: net recovered, clamped to [0, expected].
          const unresolvedPositive = Math.max(0, c.balance.unresolved);
          owed += unresolvedPositive;
          if (["sent", "packet", "promised"].includes(c.status)) asked += unresolvedPositive;
        }
        return {
          purchase: p,
          items,
          claims: claims.map((c) => ({ ...c, item: items.find((i) => i._id === c.itemId) })),
        };
      }),
    );

    // Needs-attention list: failed or needs_review processedEvents for this
    // user, newest first, capped at 20 (D14). Two equality queries (one per
    // status) merged in memory, since the by_user_status index only sorts
    // by _creationTime within a fixed status value.
    const [failed, needsReview] = await Promise.all([
      ctx.db
        .query("processedEvents")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "failed"))
        .order("desc")
        .collect(),
      ctx.db
        .query("processedEvents")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "needs_review"))
        .order("desc")
        .collect(),
    ]);
    const attention = [...failed, ...needsReview]
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, 20)
      .map((e) => ({
        _id: e._id,
        status: e.status,
        kind: e.kind,
        summary: e.summary,
        attempts: e.attempts,
        lastError: e.lastError,
      }));

    return { purchases: rows, totals: { owed, asked, confirmed }, attention };
  },
});
