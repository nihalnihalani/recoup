import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ownedItem, ownedPurchase, requireUserId } from "./lib/access";
import { netRecovered } from "./lib/ledger";
import { claimsWithBalance, claimBalance, balanceValidator } from "./lib/balance";
import { assertCents, assertCurrency, assertNonEmpty, assertQty, assertTimestamp } from "./lib/money";
import { cancelPending } from "./followUps";
import { normalizeDomain } from "./lib/policyText";
import { latestPolicy } from "./lib/latestPolicy";
import { verdict } from "./lib/verdict";
import { parseProductUrl } from "./lib/watchUrl";
import { boundedLine } from "./lib/text";
import { clearItemSchedule } from "./lib/schedule";
import { schedulePolicyFetch } from "./policies";
import { assertCoarseNow } from "./watches";
import schema, { processedStatus, verdictValidator } from "./schema";
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

/** A claim doc extended with its derived (never stored) balance -- shared by `get` and `board`'s returns validators. */
const claimWithBalance = schema.doc("claims").extend({ balance: balanceValidator });

/** `get`'s per-item row: the item document plus its price history and derived read-only fields. */
const itemWithHistory = schema.doc("items").extend({
  claims: v.array(claimWithBalance),
  priceChecks: v.array(schema.doc("priceChecks")),
  verdict: verdictValidator,
});

/** `board`'s per-purchase row. */
const boardRow = v.object({
  purchase: schema.doc("purchases"),
  items: v.array(schema.doc("items")),
  claims: v.array(claimWithBalance.extend({ item: v.optional(schema.doc("items")) })),
});

/** `board`'s "needs attention" list: D58's explicit field allowlist (never the raw `lastError`). */
const boardAttentionRow = v.object({
  _id: v.id("processedEvents"),
  status: processedStatus,
  kind: v.string(),
  summary: v.optional(v.string()),
  attempts: v.number(),
  errorSummary: v.optional(v.string()),
});

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
      userId,
      status: resolvedStatus,
    });
    for (const it of cleanItems) {
      await ctx.db.insert("items", { ...it, purchaseId, userId, returned: false });
    }
    // F-AUD-9/D27: `isExample` is not a public argument here (examples are
    // seeded only by `examples.ts`'s direct `db.insert`, D04) -- a client
    // can no longer mark its own purchase as an example to dodge its own
    // money totals/spend or block the example loader (regression test:
    // "purchases.create refuses a client-supplied isExample").
    if (resolvedStatus === "active") {
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
    // C3(d)/D107: confirming is exactly the moment a needs_review item's
    // permanent-vs-transient classification can flip (it gains a
    // purchasedAt/productUrl, or its purchase becomes "active") -- un-stamp
    // every item on this purchase so `priceWatch`'s next tick reconsiders
    // them instead of resting behind whatever it was last stamped with.
    // 6a-4/D112: every item ON THE PURCHASE, not only `args.items` -- a
    // re-confirm can submit a partial item list (the caller only resubmits
    // the rows its own form has open), and an item the caller omitted still
    // just had its purchase flip to "active"/gain a `purchasedAt`, so its
    // schedule needs the same reset. `items.by_purchase` is the same index
    // `clearMerchantItemSchedule` already reads per-purchase; the page size
    // matches `clearItemSchedule`'s own `MAX_ITEM_IDS` bound (50), which is
    // also `MAX_ITEMS_PER_PURCHASE`, so a purchase's full item list is never
    // truncated here.
    const purchaseItemIds = (
      await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", args.purchaseId))
        .take(MAX_ITEMS_PER_PURCHASE)
    ).map((it) => it._id);
    await clearItemSchedule(ctx, purchaseItemIds);
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    await ownedItem(ctx, args.itemId, userId);
    if (args.returnedAt !== undefined) assertTimestamp(args.returnedAt, "returnedAt");
    await ctx.db.patch(args.itemId, {
      returned: args.returned,
      returnedAt: args.returned ? (args.returnedAt ?? Date.now()) : undefined,
    });
    // C3(d)/D107: un-returning an item is a resurrection -- it was stamped
    // permanently ineligible (INELIGIBLE_REST_MS) the moment it was marked
    // returned, so un-stamp it here or it would sit out the price watch for
    // up to a year despite being watchable again.
    if (!args.returned) await clearItemSchedule(ctx, [args.itemId]);
    return null;
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
  returns: v.object({
    purchase: schema.doc("purchases"),
    items: v.array(itemWithHistory),
    policies: v.array(schema.doc("policies")),
  }),
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

/**
 * F-AUD-1 (opus-auditor's 36-connection audit; D107 C1 pattern): most
 * purchases the board reads PER STATUS, newest first. The OLD query read
 * every non-archived purchase via a single `by_user` `.collect()`, then, for
 * EVERY item on EVERY purchase, issued a separate `by_item` claims range
 * read (`claimsWithBalance`) -- `1 + purchases + items` index ranges before
 * a single claim or ledger event was even found. At 100 purchases x 50
 * items (inside `MAX_PURCHASES_PER_USER`=200 x `MAX_ITEMS_PER_PURCHASE`=50)
 * that is already 5,100 ranges, over Convex's 4,096-per-transaction limit --
 * `scratchpad/audit/repros/zz_audit_board.test.ts` reproduces the crash at
 * exactly this shape (60x50 = 3,060 ranges still passes). The fix below
 * replaces the per-item claims query with one per-PURCHASE query
 * (`by_purchase_type`, mirroring `tracking.ts`'s C1 fix) and bounds both the
 * purchase list and a shared per-call item budget, so a heavy account
 * degrades to `truncated: true` instead of a platform error.
 *
 * Both statuses the board renders are read and capped independently: `active`
 * for the money view, and `needs_review` for the "needs a look" banner
 * (`src/pages/Board.tsx`'s `NeedsReview`, `intake.test.ts`'s board
 * assertions) -- archived purchases stay hidden everywhere (D47) by simply
 * never being queried.
 */
const MAX_BOARD_PURCHASES = 60;

/**
 * F-AUD-1: shared item-read budget across every purchase this call actually
 * processes (both statuses combined, spent as items are actually read, not
 * allotted per purchase up front) -- see `tracking.ts`'s `MAX_ITEMS_TOTAL`
 * doc comment for the full rationale (an early purchase with few items must
 * not starve a later one of budget it never used). Sized at
 * `MAX_BOARD_PURCHASES * MAX_ITEMS_PER_PURCHASE` so a realistic account
 * within the purchase cap is never truncated on items alone.
 */
const MAX_BOARD_ITEMS_TOTAL = MAX_BOARD_PURCHASES * MAX_ITEMS_PER_PURCHASE;

/** F-AUD-1: `processedEvents` rows read per status (`failed`/`needs_review`) for the "needs attention" list; the merge below still renders at most 20 (D14). */
const ATTENTION_SCAN_PER_STATUS = 20;

export const board = query({
  args: {},
  returns: v.object({
    purchases: v.array(boardRow),
    totals: v.object({ owed: v.number(), asked: v.number(), confirmed: v.number() }),
    attention: v.array(boardAttentionRow),
    /** F-AUD-1: true only on a REAL cut (more purchases or items exist than were read), never merely because a bound exists. */
    truncated: v.boolean(),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    // F-AUD-1: bounded per status via `by_user_status`, newest first -- one
    // range read each, instead of the old single unbounded `by_user`
    // `.collect()` filtered to non-archived in memory.
    const [activePage, reviewPage] = await Promise.all([
      ctx.db
        .query("purchases")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
        .order("desc")
        .take(MAX_BOARD_PURCHASES + 1),
      ctx.db
        .query("purchases")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "needs_review"))
        .order("desc")
        .take(MAX_BOARD_PURCHASES + 1),
    ]);
    let truncated = activePage.length > MAX_BOARD_PURCHASES || reviewPage.length > MAX_BOARD_PURCHASES;
    const purchases = [...activePage.slice(0, MAX_BOARD_PURCHASES), ...reviewPage.slice(0, MAX_BOARD_PURCHASES)].sort(
      (a, b) => b._creationTime - a._creationTime,
    );

    let owed = 0,
      asked = 0,
      confirmed = 0;
    // F-AUD-1: shared budget, spent as rows are actually read -- see
    // MAX_BOARD_ITEMS_TOTAL's doc comment.
    let itemsRoom = MAX_BOARD_ITEMS_TOTAL;
    const rows: Array<{
      purchase: Doc<"purchases">;
      items: Doc<"items">[];
      claims: Array<Doc<"claims"> & { balance: Awaited<ReturnType<typeof claimBalance>>; item: Doc<"items"> | undefined }>;
    }> = [];
    for (const p of purchases) {
      if (itemsRoom <= 0) {
        // F-AUD-1: the shared budget is spent; every purchase from here on
        // is cut ENTIRELY (a real truncation) rather than read-and-discarded.
        truncated = true;
        break;
      }
      const cap = Math.min(MAX_ITEMS_PER_PURCHASE, itemsRoom);
      // Read one row past the cap so `truncated` reflects a REAL cut, not
      // merely a tight shared budget (mirrors tracking.ts's C1 fix).
      const probe = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", p._id))
        .take(cap + 1);
      const overflow = probe.length > cap;
      if (overflow) truncated = true;
      const items = overflow ? probe.slice(0, cap) : probe;
      itemsRoom -= items.length;

      // F-AUD-1: ONE range read for every claim on this whole purchase
      // (`by_purchase_type`, every type/status -- unlike `tracking.overview`,
      // the board needs both `price_adjustment` and `return_credit`, so the
      // query stops at the `purchaseId` equality and does not narrow by
      // `type`), instead of a `by_item` range read PER ITEM. This is what
      // turns the range count from O(items) into O(purchases) -- the
      // dominant fix for the "too many index ranges read" crash.
      const purchaseClaims = await ctx.db
        .query("claims")
        .withIndex("by_purchase_type", (q) => q.eq("purchaseId", p._id))
        .collect();
      const claims = await Promise.all(
        purchaseClaims.map(async (c) => ({ ...c, balance: await claimBalance(ctx, c) })),
      );

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

      rows.push({
        purchase: p,
        items,
        claims: claims.map((c) => ({ ...c, item: items.find((i) => i._id === c.itemId) })),
      });
    }

    // Needs-attention list: failed or needs_review processedEvents for this
    // user, newest first, capped at 20 (D14). F-AUD-1: bounded READ via
    // `take` (instead of an unbounded `.collect()` per status) -- a flooded
    // inbox of failed/needs_review rows, never pruned by retention (only
    // payloads are), must not blow the range/document budget just to surface
    // the newest 20. Two equality queries (one per status) merged in memory,
    // since the by_user_status index only sorts by _creationTime within a
    // fixed status value.
    const [failed, needsReview] = await Promise.all([
      ctx.db
        .query("processedEvents")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "failed"))
        .order("desc")
        .take(ATTENTION_SCAN_PER_STATUS),
      ctx.db
        .query("processedEvents")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "needs_review"))
        .order("desc")
        .take(ATTENTION_SCAN_PER_STATUS),
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

    return { purchases: rows, totals: { owed, asked, confirmed }, attention, truncated };
  },
});
