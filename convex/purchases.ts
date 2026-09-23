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
import { assertCoarseNow, purchasedAtNotAfterNow } from "./watches";
import { ensurePurchaseTransaction } from "./transactions";
import { putFact } from "./lib/facts/write";
import { evaluateTransaction } from "./opportunities";
import { evaluationScope } from "./lib/facts/subject";
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
    const { items, status } = args;
    // QA-M16-4: never a future instant (clamped to now; see `purchasedAtNotAfterNow`).
    const purchasedAt = args.purchasedAt === undefined ? undefined : purchasedAtNotAfterNow(args.purchasedAt);
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
    // Contract §2.2 / DA-A-35: every purchase gets its category-neutral transaction in the same mutation.
    await ensurePurchaseTransaction(ctx, purchaseId);
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
    /**
     * The currency the user confirms (contract §7, DA-A-33). Optional so existing callers are unchanged; when given it
     * is validated, written to the purchase, and recorded as a `retail.currency` user_confirmed fact — the only thing
     * that makes a retail currency "confirmed" rather than an assumption. A CHANGE is refused once any claim exists on
     * the purchase (its ledger and drafts are in the old currency).
     */
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
    if (purchase.status === "archived") throw new ConvexError("Purchase not found");
    assertNonEmpty(args.merchantDomain, "merchantDomain");
    // Policies are keyed by the bare registrable host; store the same form here (review H7).
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!merchantDomain) throw new ConvexError("merchantDomain must be a domain like example.com");
    if (args.items.length === 0) throw new ConvexError("A purchase needs at least one item");
    if (args.items.length > MAX_ITEMS_PER_PURCHASE) {
      throw new ConvexError(`A purchase can have at most ${MAX_ITEMS_PER_PURCHASE} items`);
    }
    // QA-M16-4: never a future instant (clamped to now; see `purchasedAtNotAfterNow`).
    const purchasedAt = purchasedAtNotAfterNow(args.purchasedAt);
    const merchant = boundedLine(args.merchant, "merchant", MAX_MERCHANT_CHARS);
    const orderRef = cleanOrderRef(args.orderRef);
    const currency = args.currency === undefined ? undefined : assertCurrency(args.currency);
    if (currency !== undefined && currency !== purchase.currency) {
      // Any claim at all (open, confirmed or dismissed) was opened, drafted and possibly paid in the old currency.
      const claim = await ctx.db
        .query("claims")
        .withIndex("by_purchase_type", (q) => q.eq("purchaseId", args.purchaseId))
        .first();
      if (claim !== null) throw new ConvexError("The currency cannot change once a claim exists for this purchase");
    }
    const cleanItems = [];
    /** M11d: the item subjects whose values this confirm changes (for the scoped re-evaluation below). */
    const changedItemSubjects: string[] = [];
    for (const it of args.items) {
      const item = await ownedItem(ctx, it.itemId, userId);
      if (item.purchaseId !== args.purchaseId) {
        throw new ConvexError("Item does not belong to this purchase");
      }
      const clean = {
        itemId: it.itemId,
        name: cleanItemName(it.name),
        unitCents: assertCents(it.unitCents, "unitCents"),
        qty: assertQty(it.qty),
        productUrl: cleanProductUrl(it.productUrl),
      };
      if (clean.name !== item.name || clean.unitCents !== item.unitCents || clean.qty !== item.qty || clean.productUrl !== item.productUrl) {
        changedItemSubjects.push(`item:${it.itemId}`);
      }
      cleanItems.push(clean);
    }
    // M11d: purchase-level fields feed every item's evaluation (date, currency, status, merchant, order ref).
    let purchaseLevelChanged =
      purchase.status !== "active" ||
      purchase.merchant !== merchant ||
      purchase.merchantDomain !== merchantDomain ||
      purchase.orderRef !== orderRef ||
      purchase.purchasedAt !== purchasedAt ||
      (currency !== undefined && currency !== purchase.currency);
    await ctx.db.patch(args.purchaseId, {
      merchant,
      merchantDomain,
      orderRef,
      purchasedAt,
      ...(currency !== undefined ? { currency } : {}),
      status: "active",
    });
    for (const { itemId, ...fields } of cleanItems) {
      await ctx.db.patch(itemId, fields);
    }
    // Contract §2.2: confirming re-syncs (or, for a legacy purchase, lazily creates) the transaction mirror.
    const transactionId = await ensurePurchaseTransaction(ctx, args.purchaseId);
    if (currency !== undefined) {
      // DA-A-33: only an explicit confirmation makes the currency known; an identical re-confirmation writes nothing.
      const confirmation = await putFact(ctx, userId, {
        transactionId,
        subjectKey: "txn",
        key: "retail.currency",
        state: "user_confirmed",
        value: { kind: "code", code: currency },
        source: { kind: "user" },
      });
      // A first confirmation turns the currency assumption into a known fact: every item's result can change.
      if (confirmation.outcome !== "unchanged") purchaseLevelChanged = true;
    }
    // C43 (M11d): re-evaluate in this SAME mutation, so the opportunity card shows the new outcome reactively.
    // Scoped to the changed items (DA-A-32); a purchase-level change re-evaluates every item; nothing changed → no
    // evaluation work. Budget: a whole 50-item purchase (the item cap) evaluates inside this transaction —
    // facts.reevaluate.test.ts measures confirm + full re-evaluation on 50 items under real limits — so no scheduled
    // follow-up, and no window in which the card shows a stale outcome.
    if (purchaseLevelChanged || changedItemSubjects.length > 0) {
      await evaluateTransaction(
        ctx,
        transactionId,
        "fact_change",
        Date.now(),
        purchaseLevelChanged ? {} : evaluationScope(changedItemSubjects),
      );
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
    // The transaction mirrors the purchase's status, so an archived purchase never leaves an active transaction.
    await ensurePurchaseTransaction(ctx, purchaseId);
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

/**
 * B-6 (D129, checkpoint 6d): F-AUD-1 bounded the purchase list and the item
 * reads, but left this loop's claims read completely unbounded in the way
 * that actually matters for the range budget -- not the per-purchase
 * `by_purchase_type` claims list itself (one range per purchase, same O(1)
 * shape the item probe already has), but `claimBalance`'s own `ledgerEvents`
 * range read (`lib/balance.ts`), issued once per claim ACTUALLY RETURNED. At
 * 60 active purchases x 50 items x 2 claims each (6,000 claims, every number
 * still inside `MAX_BOARD_PURCHASES`/`MAX_ITEMS_PER_PURCHASE`/
 * `MAX_PURCHASES_PER_USER`), that alone is 6,000 index ranges, over Convex's
 * 4,096-per-transaction limit -- the Board page threw the platform error for
 * any real account with two open claim types (price adjustment + return
 * credit) on every returned item.
 *
 * Same shape as `MAX_BOARD_ITEMS_TOTAL`: a shared claims-read budget spent
 * as claims are actually read across every purchase this call processes,
 * not allotted per purchase up front (an early purchase with few claims must
 * not starve a later one of budget it never used). Sized the same way --
 * `MAX_BOARD_PURCHASES * MAX_ITEMS_PER_PURCHASE` -- so a realistic account
 * within every existing cap is never truncated on claims alone.
 */
const MAX_BOARD_CLAIMS_TOTAL = MAX_BOARD_PURCHASES * MAX_ITEMS_PER_PURCHASE;

/** B-6: per-purchase claims cap mirroring `MAX_ITEMS_PER_PURCHASE`'s role for items -- a realistic item carries at most one claim per type (price_adjustment, return_credit), so twice the item cap is generous headroom before the shared budget above ever needs to cut a single heavy purchase's claims list. */
const MAX_BOARD_CLAIMS_PER_PURCHASE = MAX_ITEMS_PER_PURCHASE * 2;

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
    // B-6: shared claims budget, same spend-as-read shape -- see
    // MAX_BOARD_CLAIMS_TOTAL's doc comment.
    let claimsRoom = MAX_BOARD_CLAIMS_TOTAL;
    const rows: Array<{
      purchase: Doc<"purchases">;
      items: Doc<"items">[];
      claims: Array<Doc<"claims"> & { balance: Awaited<ReturnType<typeof claimBalance>>; item: Doc<"items"> | undefined }>;
    }> = [];
    for (const p of purchases) {
      if (itemsRoom <= 0 || claimsRoom <= 0) {
        // F-AUD-1/B-6: either shared budget is spent; every purchase from
        // here on is cut ENTIRELY (a real truncation) rather than
        // read-and-discarded -- a purchase never renders with a partial
        // money picture (some claims read, others silently missing).
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
      //
      // B-6: bounded the same way the items probe above is -- `take(cap+1)`
      // against the shared `claimsRoom` budget, one range past the cap so
      // `truncated` reflects a REAL cut. This caps how many claims are
      // actually returned, which in turn caps how many `claimBalance` calls
      // (each its own `ledgerEvents` range read, the real cost driver) this
      // purchase spends.
      const claimsCap = Math.min(MAX_BOARD_CLAIMS_PER_PURCHASE, claimsRoom);
      const claimsProbe = await ctx.db
        .query("claims")
        .withIndex("by_purchase_type", (q) => q.eq("purchaseId", p._id))
        .take(claimsCap + 1);
      const claimsOverflow = claimsProbe.length > claimsCap;
      if (claimsOverflow) truncated = true;
      const purchaseClaims = claimsOverflow ? claimsProbe.slice(0, claimsCap) : claimsProbe;
      claimsRoom -= purchaseClaims.length;
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
