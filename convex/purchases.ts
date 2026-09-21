import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ownedItem, ownedPurchase, requireUserId } from "./lib/access";
import { netRecovered } from "./lib/ledger";
import { claimsWithBalance } from "./lib/balance";
import { assertCents, assertCurrency, assertNonEmpty, assertQty, assertTimestamp } from "./lib/money";
import { cancelPending } from "./followUps";
import { normalizeDomain } from "./lib/policyText";
import { latestPolicy } from "./lib/latestPolicy";
import { verdict } from "./lib/verdict";
import { parseProductUrl } from "./lib/watchUrl";
import { boundedLine } from "./lib/text";
import { schedulePolicyFetch } from "./policies";
import { assertCoarseNow } from "./watches";
import {
  MAX_ITEMS_PER_PURCHASE,
  MAX_ITEM_NAME_CHARS,
  MAX_MERCHANT_CHARS,
  MAX_ORDER_REF_CHARS,
  MAX_PURCHASES_PER_USER,
} from "./limits";

const MAX_SOURCE_ID_CHARS = 500;

/**
 * An item's product link as it may be stored (review M1): every stored link is later scraped, so it goes through
 * the same validator as a watch. Empty means "no link"; a link we would refuse to scrape is refused here.
 */
function cleanProductUrl(input: string | undefined): string | undefined {
  if (input === undefined || input.trim().length === 0) return undefined;
  const parsed = parseProductUrl(input);
  if (!parsed) throw new ConvexError("Product link must be a full store link starting with http:// or https://");
  return parsed.productUrl;
}

function cleanItemName(name: string): string {
  const clean = boundedLine(name, "Item name", MAX_ITEM_NAME_CHARS);
  if (clean.length === 0) throw new ConvexError("Item name must not be empty");
  return clean;
}

function cleanOrderRef(orderRef: string | undefined): string | undefined {
  if (orderRef === undefined) return undefined;
  return boundedLine(orderRef, "orderRef", MAX_ORDER_REF_CHARS) || undefined;
}

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
  returns: v.id("purchases"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const { items, status, purchasedAt } = args;
    const resolvedStatus = status ?? "active";
    if (resolvedStatus === "active" && purchasedAt === undefined) {
      throw new ConvexError("purchasedAt is required for an active purchase");
    }
    assertCurrency(args.currency);
    assertNonEmpty(args.merchantDomain, "merchantDomain");
    // Policies are keyed by the bare registrable host; store the same form here (review H7).
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!merchantDomain) throw new ConvexError("merchantDomain must be a domain like example.com");
    if (items.length === 0) throw new ConvexError("A purchase needs at least one item");
    if (items.length > MAX_ITEMS_PER_PURCHASE) {
      throw new ConvexError(`A purchase can have at most ${MAX_ITEMS_PER_PURCHASE} items`);
    }
    if (purchasedAt !== undefined) assertTimestamp(purchasedAt, "purchasedAt");
    const merchant = boundedLine(args.merchant, "merchant", MAX_MERCHANT_CHARS);
    const orderRef = cleanOrderRef(args.orderRef);
    const sourceMessageId =
      args.sourceMessageId === undefined
        ? undefined
        : boundedLine(args.sourceMessageId, "sourceMessageId", MAX_SOURCE_ID_CHARS) || undefined;
    const cleanItems = items.map((it) => ({
      name: cleanItemName(it.name),
      unitCents: assertCents(it.unitCents, "unitCents"),
      qty: assertQty(it.qty),
      productUrl: cleanProductUrl(it.productUrl),
    }));

    // B4: archived rows count, so archive-and-recreate cannot get around the cap.
    const held = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PURCHASES_PER_USER);
    if (held.length >= MAX_PURCHASES_PER_USER) {
      throw new ConvexError(`You can keep up to ${MAX_PURCHASES_PER_USER} purchases`);
    }

    const purchaseId = await ctx.db.insert("purchases", {
      merchant,
      merchantDomain,
      orderRef,
      purchasedAt,
      currency: args.currency,
      sourceMessageId,
      isExample: args.isExample,
      userId,
      status: resolvedStatus,
    });
    for (const it of cleanItems) {
      await ctx.db.insert("items", { ...it, purchaseId, userId, returned: false });
    }
    // D27: an example store is not a real site; researching it would only burn credit.
    if (resolvedStatus === "active" && !args.isExample) {
      await schedulePolicyFetch(ctx, userId, merchantDomain);
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const purchase = await ownedPurchase(ctx, args.purchaseId, userId);
    if (purchase.status === "archived") throw new ConvexError("Purchase not found");
    assertNonEmpty(args.merchantDomain, "merchantDomain");
    // Policies are keyed by the bare registrable host; store the same form here (review H7).
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!merchantDomain) throw new ConvexError("merchantDomain must be a domain like example.com");
    if (args.items.length === 0) throw new ConvexError("A purchase needs at least one item");
    if (args.items.length > MAX_ITEMS_PER_PURCHASE) {
      throw new ConvexError(`A purchase can have at most ${MAX_ITEMS_PER_PURCHASE} items`);
    }
    assertTimestamp(args.purchasedAt, "purchasedAt");
    const merchant = boundedLine(args.merchant, "merchant", MAX_MERCHANT_CHARS);
    const orderRef = cleanOrderRef(args.orderRef);
    const cleanItems = [];
    for (const it of args.items) {
      const item = await ownedItem(ctx, it.itemId, userId);
      if (item.purchaseId !== args.purchaseId) {
        throw new ConvexError("Item does not belong to this purchase");
      }
      cleanItems.push({
        itemId: it.itemId,
        name: cleanItemName(it.name),
        unitCents: assertCents(it.unitCents, "unitCents"),
        qty: assertQty(it.qty),
        productUrl: cleanProductUrl(it.productUrl),
      });
    }
    await ctx.db.patch(args.purchaseId, {
      merchant,
      merchantDomain,
      orderRef,
      purchasedAt: args.purchasedAt,
      status: "active",
    });
    for (const { itemId, ...fields } of cleanItems) {
      await ctx.db.patch(itemId, fields);
    }
    // B4: re-confirming the same purchase must not buy another policy research. Only a purchase that just became
    // active, or one whose store changed, has anything new to look up.
    const becameActive = purchase.status !== "active";
    const domainChanged = purchase.merchantDomain !== merchantDomain;
    if ((becameActive || domainChanged) && !purchase.isExample) {
      await schedulePolicyFetch(ctx, userId, merchantDomain);
    }
    return null;
  },
});

export const setReturned = mutation({
  args: { itemId: v.id("items"), returned: v.boolean(), returnedAt: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await ownedItem(ctx, args.itemId, userId);
    if (args.returnedAt !== undefined) assertTimestamp(args.returnedAt, "returnedAt");
    await ctx.db.patch(args.itemId, {
      returned: args.returned,
      returnedAt: args.returned ? (args.returnedAt ?? Date.now()) : undefined,
    });
  },
});

/**
 * Archives a purchase (D47). Nothing is deleted: the ledger is append-only
 * history, so claims, events, drafts and replies stay. Pending reminders
 * are cancelled; `board` and `get` skip archived purchases.
 */
export const remove = mutation({
  args: { purchaseId: v.id("purchases") },
  returns: v.null(),
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, purchaseId, userId);
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const c of claims) {
      if (c.purchaseId === purchaseId) await cancelPending(ctx, c._id);
    }
    await ctx.db.patch(purchaseId, { status: "archived" });
    return null;
  },
});

const POLICY_KINDS = ["price_adjustment", "returns"] as const;

export const get = query({
  args: { purchaseId: v.id("purchases"), now: v.optional(v.number()) },
  handler: async (ctx, { purchaseId, now: argsNow }) => {
    const userId = await requireUserId(ctx);
    const purchase = await ownedPurchase(ctx, purchaseId, userId);
    if (purchase.status === "archived") throw new ConvexError("Purchase not found");
    const rawItems = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect();
    // purchases.get: this is a QUERY (reactive) -- reading the wall clock
    // directly inside one does not get tracked as a dependency, so the
    // cached result never invalidates as time passes on its own (P06/D73).
    // `now` (D103) is the same optional, validated, coarse contract
    // `watches.list`/`get` and `tracking.overview` already use; when
    // omitted, each item falls back to its own newest observation (or the
    // purchase's own date), which can only ever make the verdict's
    // staleness math look MORE current than the real clock, never falsely
    // stale.
    const validatedNow = assertCoarseNow(argsNow);
    const items = await Promise.all(
      rawItems.map(async (it) => {
        const priceChecks = await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", it._id))
          .order("desc")
          .take(30);
        // W1b: the same verdict line a watch gets, from the accepted checks
        // already loaded. `priceChecks` has no list-price column, so the
        // inflated-discount call cannot fire here.
        const history = priceChecks.flatMap((c) =>
          c.observedCents === undefined ? [] : [{ observedAt: c.observedAt, cents: c.observedCents }],
        );
        const now = validatedNow ?? history[0]?.observedAt ?? purchase.purchasedAt ?? purchase._creationTime;
        return {
          ...it,
          claims: await claimsWithBalance(ctx, it._id),
          priceChecks,
          verdict: verdict({
            currentCents: history[0]?.cents ?? null,
            listCents: null,
            history,
            now,
            currency: purchase.currency,
          }),
        };
      }),
    );
    // Latest snapshot per kind for this user+domain (D17).
    const policyRows = await Promise.all(
      POLICY_KINDS.map((kind) => latestPolicy(ctx, userId, purchase.merchantDomain, kind)),
    );
    const policies = policyRows.filter((p): p is Doc<"policies"> => p !== null);
    return { purchase, items, policies };
  },
});

export const board = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    // Archived purchases are hidden everywhere (D47).
    const purchases = (
      await ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .order("desc")
        .collect()
    ).filter((p) => p.status !== "archived");
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
        // Example purchases and example claims never contribute to real
        // money totals (D27, D48). `confirmed` is net recovered (D39).
        if (!p.isExample) {
          for (const c of claims) {
            if (c.status === "dismissed" || c.isExample) continue;
            confirmed += netRecovered(c.balance);
            const unresolvedPositive = Math.max(0, c.balance.unresolved);
            owed += unresolvedPositive;
            if (["sent", "packet", "promised"].includes(c.status)) asked += unresolvedPositive;
          }
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
        // D58: never expose the raw `lastError`; fall back to a generic
        // sanitized summary when only the raw error was recorded.
        errorSummary: e.errorSummary ?? (e.lastError !== undefined ? "Processing failed" : undefined),
      }));

    return { purchases: rows, totals: { owed, asked, confirmed }, attention };
  },
});
