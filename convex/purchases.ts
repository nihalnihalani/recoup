import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { ownedItem, ownedPurchase, requireUserId } from "./lib/access";
import { assertCents, assertCurrency, assertQty } from "./lib/money";
import { balanceValidator, claimEvents, claimsWithBalance } from "./lib/balance";

/** Newest purchases shown on the board. Bounded read (ARCHITECTURE_PATTERNS §Schema). */
const BOARD_LIMIT = 200;
/** Price observations shown on a purchase page, newest first. */
const PRICE_CHECK_LIMIT = 30;

const itemInput = v.object({
  name: v.string(),
  unitCents: v.number(),
  qty: v.number(),
  productUrl: v.optional(v.string()),
});

const claimWithBalance = v.object({
  ...schema.doc("claims").fields,
  balance: balanceValidator,
});

const itemWithDetail = v.object({
  ...schema.doc("items").fields,
  claims: v.array(claimWithBalance),
  priceChecks: v.array(schema.doc("priceChecks")),
});

const boardRow = v.object({
  purchase: schema.doc("purchases"),
  items: v.array(schema.doc("items")),
  claims: v.array(v.object({ ...claimWithBalance.fields, itemName: v.string() })),
});

/** Statuses that mean "we have asked the merchant and are waiting" (D13). */
const ASKED_STATUSES: ReadonlyArray<Doc<"claims">["status"]> = ["sent", "packet", "promised"];

/** Rejects non-integer, negative or absurd money before anything is written (D20). */
function assertItemInput(it: { unitCents: number; qty: number }) {
  assertCents(it.unitCents, "unitCents");
  assertQty(it.qty);
}

export const create = mutation({
  args: {
    merchant: v.string(),
    merchantDomain: v.string(),
    orderRef: v.optional(v.string()),
    // Optional until the user confirms an extraction (D25).
    purchasedAt: v.optional(v.number()),
    currency: v.string(),
    items: v.array(itemInput),
    sourceMessageId: v.optional(v.string()),
    status: v.optional(v.union(v.literal("needs_review"), v.literal("active"))),
    isExample: v.optional(v.boolean()),
  },
  returns: v.id("purchases"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    assertCurrency(args.currency);
    for (const it of args.items) assertItemInput(it);

    const status = args.status ?? "active";
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: args.merchant,
      merchantDomain: args.merchantDomain,
      orderRef: args.orderRef,
      purchasedAt: args.purchasedAt,
      currency: args.currency,
      sourceMessageId: args.sourceMessageId,
      status,
      isExample: args.isExample,
    });
    for (const it of args.items) {
      await ctx.db.insert("items", {
        purchaseId,
        userId,
        name: it.name,
        unitCents: it.unitCents,
        qty: it.qty,
        productUrl: it.productUrl,
        returned: false,
      });
    }
    // Examples ship with their own policy snapshots (D27); never scrape for them.
    if (status === "active" && !args.isExample) {
      await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, {
        userId,
        merchantDomain: args.merchantDomain,
      });
    }
    return purchaseId;
  },
});

/**
 * The mandatory human review step (D25): an extracted purchase sits in
 * `needs_review` until the user confirms the merchant, the date and every
 * line item. Confirming moves it to `active` and kicks off the policy fetch.
 */
export const confirm = mutation({
  args: {
    purchaseId: v.id("purchases"),
    merchant: v.string(),
    merchantDomain: v.string(),
    orderRef: v.optional(v.string()),
    purchasedAt: v.number(),
    currency: v.optional(v.string()),
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const purchase = await ownedPurchase(ctx, args.purchaseId, userId);
    if (args.currency !== undefined) assertCurrency(args.currency);
    for (const it of args.items) assertItemInput(it);

    // D19: an item id from another purchase must never be patched through here.
    const items = await Promise.all(
      args.items.map(async (it) => {
        const item = await ownedItem(ctx, it.itemId, userId);
        if (item.purchaseId !== args.purchaseId) throw new ConvexError("Item not found");
        return it;
      }),
    );

    await ctx.db.patch(args.purchaseId, {
      merchant: args.merchant,
      merchantDomain: args.merchantDomain,
      orderRef: args.orderRef,
      purchasedAt: args.purchasedAt,
      currency: args.currency ?? purchase.currency,
      status: "active",
    });
    for (const it of items) {
      await ctx.db.patch(it.itemId, {
        name: it.name,
        unitCents: it.unitCents,
        qty: it.qty,
        productUrl: it.productUrl,
      });
    }
    if (!purchase.isExample) {
      await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, {
        userId,
        merchantDomain: args.merchantDomain,
      });
    }
    return null;
  },
});

/** Only the user marks an item returned; extraction never does (D15). */
export const setReturned = mutation({
  args: { itemId: v.id("items"), returned: v.boolean(), returnedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await ownedItem(ctx, args.itemId, userId);
    await ctx.db.patch(args.itemId, {
      returned: args.returned,
      returnedAt: args.returned ? (args.returnedAt ?? Date.now()) : undefined,
    });
    return null;
  },
});

export const remove = mutation({
  args: { purchaseId: v.id("purchases") },
  returns: v.null(),
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, purchaseId, userId);
    const items = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect();
    for (const item of items) {
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .collect();
      for (const claim of claims) await deleteClaim(ctx, claim._id);
      const priceChecks = await ctx.db
        .query("priceChecks")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .collect();
      for (const pc of priceChecks) await ctx.db.delete(pc._id);
      await ctx.db.delete(item._id);
    }
    await ctx.db.delete(purchaseId);
    return null;
  },
});

/**
 * Deletes a claim and everything hanging off it, cancelling any scheduled
 * reminder first so the scheduler never wakes up to a missing row.
 */
async function deleteClaim(ctx: MutationCtx, claimId: Id<"claims">) {
  for (const e of await claimEvents(ctx, claimId)) await ctx.db.delete(e._id);
  for (const table of ["claimNotes", "drafts", "replies"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
  const followUps = await ctx.db
    .query("followUps")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .collect();
  for (const f of followUps) {
    if (f.status === "pending") await ctx.scheduler.cancel(f.scheduledFnId);
    await ctx.db.delete(f._id);
  }
  await ctx.db.delete(claimId);
}

/**
 * The latest snapshot of each policy kind for a merchant (D17). Snapshots are
 * immutable and a refresh inserts a new row, so "current policy" is always
 * the newest row per kind, never a mutated one.
 */
async function latestPolicies(ctx: QueryCtx, userId: Id<"users">, merchantDomain: string) {
  const kinds = ["returns", "price_adjustment"] as const;
  const found = await Promise.all(
    kinds.map((kind) =>
      ctx.db
        .query("policies")
        .withIndex("by_user_domain_kind", (q) =>
          q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind),
        )
        .order("desc")
        .first(),
    ),
  );
  return found.filter((p): p is Doc<"policies"> => p !== null);
}

export const get = query({
  args: { purchaseId: v.id("purchases") },
  returns: v.object({
    purchase: schema.doc("purchases"),
    items: v.array(itemWithDetail),
    policies: v.array(schema.doc("policies")),
  }),
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    const purchase = await ownedPurchase(ctx, purchaseId, userId);
    const rawItems = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect();
    const items = await Promise.all(
      rawItems.map(async (item) => ({
        ...item,
        claims: await claimsWithBalance(ctx, item._id),
        priceChecks: await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", item._id))
          .order("desc")
          .take(PRICE_CHECK_LIMIT),
      })),
    );
    return { purchase, items, policies: await latestPolicies(ctx, userId, purchase.merchantDomain) };
  },
});

export const board = query({
  args: {},
  returns: v.object({
    purchases: v.array(boardRow),
    totals: v.object({ owed: v.number(), asked: v.number(), confirmed: v.number() }),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(BOARD_LIMIT);

    let owed = 0;
    let asked = 0;
    let confirmed = 0;
    const rows = await Promise.all(
      purchases.map(async (purchase) => {
        const items = await ctx.db
          .query("items")
          .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
          .collect();
        const nameOf = new Map(items.map((i) => [i._id, i.name]));
        const claims = (
          await Promise.all(items.map((item) => claimsWithBalance(ctx, item._id)))
        ).flat();
        for (const claim of claims) {
          if (claim.status === "dismissed") continue;
          // D27: example money is demo data and never enters the headline totals.
          if (purchase.isExample || claim.isExample) continue;
          confirmed += claim.balance.confirmed;
          // D24: an over-credit is an unresolved negative; it never offsets owed.
          const unresolved = Math.max(0, claim.balance.unresolved);
          owed += unresolved;
          if (ASKED_STATUSES.includes(claim.status)) asked += unresolved;
        }
        return {
          purchase,
          items,
          claims: claims.map((c) => ({ ...c, itemName: nameOf.get(c.itemId) ?? "" })),
        };
      }),
    );
    return { purchases: rows, totals: { owed, asked, confirmed } };
  },
});
