/**
 * Price watch (T09).
 *
 * Every six hours `crons.ts` runs `runAll`, which reads a bounded page of
 * eligible items and fans out one scheduled `checkItem` per item. `checkItem`
 * scrapes the product page through the Firecrawl component, extracts a price
 * with OpenAI, and hands the raw extraction to `recordCheck`.
 *
 * `recordCheck` is where the money rules live (D16): an observation becomes
 * `priceChecks.observedCents` only when the page showed a single numeric price,
 * in the purchase's own currency, for the exact variant, at confidence >= 0.7.
 * Anything else is still stored — as a `priceChecks` row with a human-readable
 * `note` and no `observedCents` — so the UI can show "we looked and could not
 * tell" instead of silence. A price-adjustment claim is opened ONLY from here
 * (D20), through `claims.openClaim`, never from the client.
 */
import { latestPolicy } from "./lib/latestPolicy";
import { ConvexError, v } from "convex/values";
import { FirecrawlClient, type ScrapeOptions } from "@firecrawl/firecrawl-convex";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { variantMatch } from "./schema";
import { ownedItem, requireUserId } from "./lib/access";
import { toCents } from "./lib/money";
import { priceDropCents, windowEndsAt } from "./lib/ledger";
import { openClaim } from "./claims";
import { Price } from "./lib/schemas";
import { extract } from "./lib/ai";

const firecrawl = new FirecrawlClient(components.firecrawl);

/** D16: below this the extraction is a guess, not an observation. */
export const MIN_CONFIDENCE = 0.7;

/**
 * How many of the newest items one cron tick considers. The sweep has no
 * index to narrow on (`items` is keyed by purchase and by user only), so it
 * reads a bounded page in reverse creation order: an item whose price window
 * is still open is by definition a recent one, so newest-first is the right
 * page to read (ARCHITECTURE_PATTERNS §Schema, "a sweep never reads a whole
 * table").
 */
const SCAN_LIMIT = 500;
/** Upper bound on scrapes one tick may start, so a bad day cannot burn the quota. */
const FANOUT_LIMIT = 50;
/** Spacing between scheduled scrapes; Firecrawl is rate limited per key. */
const STAGGER_MS = 3_000;
/** A manual check inside this window of the last recorded one is refused. */
export const CHECK_COOLDOWN_MS = 60_000;

const MAX_NOTE_CHARS = 500;
const MAX_NAME_CHARS = 200;
/** Below this a "page" is an interstitial or an error page, not a product. */
const MIN_PAGE_CHARS = 200;

/** Statuses that still count as an open claim when refusing a duplicate. */
const CLOSED_STATUSES: ReadonlyArray<Doc<"claims">["status"]> = ["confirmed", "dismissed"];

/**
 * Product pages price client-side and geo-gate aggressively; the same settings
 * that made the policy scrapes work (see `policies.scrapeOptions`) apply here.
 * `maxAge` is one hour, not a day: a price is the thing we are watching.
 */
function scrapeOptions(): ScrapeOptions {
  return {
    formats: ["markdown"],
    onlyMainContent: false,
    waitFor: 3_000,
    maxAge: 3_600_000,
    location: { country: "us", languages: ["en-US"] },
    proxy: "auto",
  };
}

const SYSTEM =
  "You read a retail product page. Report the current selling price of the named product: " +
  "the price a shopper would pay today, including any sale price, excluding tax and shipping. " +
  "Set price to null unless the page shows ONE unambiguous number for that exact product. " +
  "Set isRange true if the page shows a range or a 'from' price. " +
  "Set variantMatch to 'exact' only when the price clearly belongs to the named product and variant, " +
  "'unsure' when several variants are priced differently, and 'none' when the page is not that product.";

const recordResult = v.object({
  priceCheckId: v.id("priceChecks"),
  claimId: v.union(v.id("claims"), v.null()),
  accepted: v.boolean(),
  note: v.optional(v.string()),
});

export function truncate(note: string): string {
  return note.slice(0, MAX_NOTE_CHARS);
}

export function errorNote(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return truncate(`${prefix}: ${message}`);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** The latest price-adjustment snapshot for a merchant (D17: newest row wins). */
async function latestPricePolicy(
  ctx: QueryCtx,
  userId: Id<"users">,
  merchantDomain: string,
): Promise<Doc<"policies"> | null> {
  return latestPolicy(ctx, userId, merchantDomain, "price_adjustment");
}

/** True when an unsettled price-adjustment claim already exists for this item. */
async function hasOpenPriceClaim(ctx: QueryCtx, itemId: Id<"items">): Promise<boolean> {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .collect();
  return claims.some((c) => c.type === "price_adjustment" && !CLOSED_STATUSES.includes(c.status));
}

/** Cents already asked for and settled on this item's price drops; dismissed claims do not count. */
async function settledPriceClaimCents(ctx: QueryCtx, itemId: Id<"items">): Promise<number> {
  const claims = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", itemId))
    .collect();
  return claims
    .filter((c) => c.type === "price_adjustment" && c.status === "confirmed")
    .reduce((sum, c) => sum + c.expectedCents, 0);
}

/**
 * The window a claim would be opened against, or null when this item is not
 * watchable right now. Shared by `eligibleItems` (which decides what to
 * scrape) and `recordCheck` (which re-decides at write time, because the cron
 * fan-out and the scrape happen minutes apart and a window can close in
 * between).
 */
async function watchWindow(
  ctx: QueryCtx,
  item: Doc<"items">,
  now: number,
): Promise<{ policy: Doc<"policies">; endsAt: number } | null> {
  if (item.returned) return null;
  const purchase = await ctx.db.get(item.purchaseId);
  if (!purchase || purchase.userId !== item.userId) return null;
  // D25: an unconfirmed purchase has no trustworthy date; D27: examples never scrape.
  if (purchase.status !== "active") return null;
  if (purchase.isExample) return null;
  if (purchase.purchasedAt === undefined) return null;

  const policy = await latestPricePolicy(ctx, item.userId, purchase.merchantDomain);
  if (!policy || policy.windowDays === undefined) return null;
  const endsAt = windowEndsAt(purchase.purchasedAt, policy.windowDays);
  if (endsAt < now) return null;
  return { policy, endsAt };
}

/**
 * Items the cron should scrape this tick. Unauthenticated on purpose: the only
 * caller is `runAll`, which runs from the cron with no identity at all.
 */
export const eligibleItems = internalQuery({
  args: {},
  returns: v.array(v.id("items")),
  handler: async (ctx) => {
    const now = Date.now();
    const items = await ctx.db.query("items").order("desc").take(SCAN_LIMIT);
    const out: Id<"items">[] = [];
    for (const item of items) {
      if (out.length >= FANOUT_LIMIT) break;
      if (!item.productUrl) continue;
      if (!(await watchWindow(ctx, item, now))) continue;
      if (await hasOpenPriceClaim(ctx, item._id)) continue;
      out.push(item._id);
    }
    return out;
  },
});

/** What `checkItem` needs to build a prompt. Unauthenticated on purpose. */
export const itemForCheck = internalQuery({
  args: { itemId: v.id("items") },
  returns: v.union(
    v.object({ name: v.string(), productUrl: v.string(), currency: v.string() }),
    v.null(),
  ),
  handler: async (ctx, { itemId }) => {
    const item = await ctx.db.get(itemId);
    if (!item || !item.productUrl) return null;
    const purchase = await ctx.db.get(item.purchaseId);
    if (!purchase) return null;
    return { name: item.name, productUrl: item.productUrl, currency: purchase.currency };
  },
});

// ---------------------------------------------------------------------------
// Recording an observation (D16) and opening the claim (D20)
// ---------------------------------------------------------------------------

/**
 * Stores one observation of a product page and, when the observation clears
 * every D16 bar and the drop clears the D20 threshold, opens the claim.
 *
 * Unauthenticated on purpose: the caller is `checkItem`, which has already
 * resolved the item, and tests. Nothing here takes a `userId` from outside —
 * ownership is read off the item itself.
 *
 * A rejected observation is still a row: `observedCents` is left undefined and
 * `note` says why, so the item page can show the attempt.
 */
export const recordCheck = internalMutation({
  args: {
    itemId: v.id("items"),
    sourceUrl: v.string(),
    /** Integer minor units, already converted by the caller. */
    observedCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    confidence: v.optional(v.number()),
    isRange: v.optional(v.boolean()),
    variantMatch: v.optional(variantMatch),
    note: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new ConvexError("Item not found");
    const purchase = await ctx.db.get(item.purchaseId);
    if (!purchase || purchase.userId !== item.userId) throw new ConvexError("Purchase not found");

    const now = Date.now();
    const rejection = rejectionReason(args, purchase.currency, "the purchase was");

    const priceCheckId = await ctx.db.insert("priceChecks", {
      itemId: item._id,
      userId: item.userId,
      // D16: a price that failed any bar is NOT an observation of a price.
      observedCents: rejection === null ? args.observedCents : undefined,
      currency: args.currency,
      confidence: args.confidence,
      variantMatch: args.variantMatch,
      observedAt: now,
      sourceUrl: args.sourceUrl,
      note: rejection === null ? args.note : truncate(rejection),
    });

    if (rejection !== null || args.observedCents === undefined) {
      return { priceCheckId, claimId: null, accepted: false, note: rejection ?? args.note };
    }

    // Re-decide the window at write time: the cron scheduled this scrape
    // minutes ago and a window can close, or a purchase be archived, between.
    const window = await watchWindow(ctx, item, now);
    if (!window) {
      return { priceCheckId, claimId: null, accepted: true, note: "No open price window" };
    }
    const drop = priceDropCents(item.unitCents, args.observedCents, item.qty);
    if (drop === null) {
      return { priceCheckId, claimId: null, accepted: true, note: "Drop below threshold" };
    }
    // Idempotency: two checks a minute apart must not open two claims for the
    // same drop. `openClaim` throws on a duplicate, so ask first and no-op.
    if (await hasOpenPriceClaim(ctx, item._id)) {
      return { priceCheckId, claimId: null, accepted: true, note: "Claim already open" };
    }
    // A settled claim already covered part (usually all) of this drop. Ask only
    // for what is new: the same $50 must never be claimed twice, but a price
    // that falls further after a payout is a fresh, smaller ask (found live).
    const settled = await settledPriceClaimCents(ctx, item._id);
    const remaining = drop - settled;
    if (settled > 0 && remaining < Math.max(100, Math.round(item.unitCents * item.qty * 0.02))) {
      return { priceCheckId, claimId: null, accepted: true, note: "Drop already claimed" };
    }

    const claimId = await openClaim(ctx, {
      userId: item.userId,
      purchaseId: item.purchaseId,
      itemId: item._id,
      type: "price_adjustment",
      expectedCents: remaining,
      windowEndsAt: window.endsAt,
      policyId: window.policy._id,
      openedFromPriceCheckId: priceCheckId,
    });
    return { priceCheckId, claimId, accepted: true, note: undefined };
  },
});

/**
 * D16 in one place. Returns null when the observation is usable.
 * `expectedCurrency` is null when nothing is known yet (a watch before its
 * first accepted check): any stated currency passes. `expectedWas` finishes
 * the mismatch sentence ("the purchase was" / "this watch is tracked").
 */
export function rejectionReason(
  args: {
    observedCents?: number;
    currency?: string;
    confidence?: number;
    isRange?: boolean;
    variantMatch?: "exact" | "unsure" | "none";
  },
  expectedCurrency: string | null,
  expectedWas: string,
): string | null {
  if (args.isRange) return "Page shows a price range, not a single price";
  if (args.observedCents === undefined) return null; // nothing to accept; caller's note stands
  // Zero is what a model returns for "no price on the page"; nothing is sold for $0.00 (found live, W3).
  if (!Number.isSafeInteger(args.observedCents) || args.observedCents <= 0) {
    return "The page does not show a price";
  }
  if (args.variantMatch !== "exact") {
    return args.variantMatch === "none"
      ? "The page does not price this product"
      : "Could not tell which variant the price is for";
  }
  if (!args.currency) return "The page does not state a currency";
  if (expectedCurrency !== null && args.currency !== expectedCurrency) {
    return `Page price is in ${args.currency}, ${expectedWas} in ${expectedCurrency}`;
  }
  if (args.confidence === undefined || args.confidence < MIN_CONFIDENCE) {
    return "Low confidence in the extracted price";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scrape + extract
// ---------------------------------------------------------------------------

/**
 * Scrapes one product page and records what it saw. Never throws past the
 * scheduler: a dead page, a missing key or a refusing model all end as a
 * `priceChecks` row with a note (ARCHITECTURE_PATTERNS §Actions calling
 * external APIs).
 */
export const checkItem = internalAction({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const item = await ctx.runQuery(internal.priceWatch.itemForCheck, { itemId });
    if (!item) return null;

    let observed: Observation;
    try {
      // `listCents` and `productName` are for watches (W1); an owned item
      // already has a name and `priceChecks` has no list-price column.
      const { listCents: _listCents, productName: _productName, ...rest } = await observePrice(
        ctx,
        item.name,
        item.productUrl,
      );
      observed = rest;
    } catch (err) {
      console.error(`priceWatch.checkItem failed for ${itemId}`, err);
      observed = { note: errorNote("Price check failed", err) };
    }
    await ctx.runMutation(internal.priceWatch.recordCheck, {
      itemId,
      sourceUrl: item.productUrl,
      ...observed,
    });
    return null;
  },
});

export type Observation = {
  observedCents?: number;
  currency?: string;
  confidence?: number;
  isRange?: boolean;
  variantMatch?: "exact" | "unsure" | "none";
  note?: string;
};

/** What the page also said, used only by watches (W1, W1b). */
export type PageObservation = Observation & {
  /** The page's claimed "was"/list price in minor units, unverified. */
  listCents?: number;
  productName?: string;
};

/**
 * The external half of a price check: scrape the page, extract the price.
 * Exported so it can be exercised directly against a real retailer without
 * seeding a purchase, and shared with `watches.checkWatch`. `name` is null
 * when the user pasted a bare link and nobody knows the product's name yet.
 */
export async function observePrice(
  // The ActionCtx shape Firecrawl needs; inferred from the caller.
  ctx: Parameters<FirecrawlClient["scrape"]>[0],
  name: string | null,
  productUrl: string,
): Promise<PageObservation> {
  const page = await firecrawl.scrape(ctx, productUrl, scrapeOptions());
  const markdown = typeof page.markdown === "string" ? page.markdown : "";
  if (markdown.length < MIN_PAGE_CHARS) {
    return { note: "The product page could not be read" };
  }

  const parsed = await extract(
    "price",
    Price,
    name === null
      ? `${SYSTEM}\n\nThe product is the main product this page sells.`
      : `${SYSTEM}\n\nThe product is: ${name.slice(0, 200)}`,
    markdown,
  );

  let observedCents: number | undefined;
  if (parsed.price !== null) {
    try {
      observedCents = toCents(parsed.price);
    } catch {
      return { note: `Extracted price is out of range: ${parsed.price}` };
    }
  }
  let listCents: number | undefined;
  if (parsed.listPrice !== null) {
    try {
      listCents = toCents(parsed.listPrice);
    } catch {
      listCents = undefined; // a claimed "was" price we cannot represent is simply not shown
    }
  }
  const productName = parsed.productName?.trim();
  return {
    observedCents,
    listCents,
    productName: productName ? productName.slice(0, MAX_NAME_CHARS) : undefined,
    currency: parsed.currency ? parsed.currency.trim().toUpperCase() : undefined,
    confidence: parsed.confidence,
    isRange: parsed.isRange,
    variantMatch: parsed.variantMatch,
    note: parsed.note ? truncate(parsed.note) : observedCents === undefined
      ? "The page does not show a single price"
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Fan-out
// ---------------------------------------------------------------------------

/**
 * The cron target (every 6h). Idempotent: a tick with nothing eligible does
 * nothing, and an item whose claim is already open is not eligible. Fans out
 * through the scheduler rather than looping `ctx.runAction`, so one slow
 * retailer cannot eat the action time limit for every other item.
 */
export const runAll = internalAction({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const itemIds: Id<"items">[] = await ctx.runQuery(internal.priceWatch.eligibleItems, {});
    for (let i = 0; i < itemIds.length; i++) {
      await ctx.scheduler.runAfter(i * STAGGER_MS, internal.priceWatch.checkItem, {
        itemId: itemIds[i],
      });
    }
    return itemIds.length;
  },
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * "Check the price now" on an item the caller owns. A mutation, not an action,
 * so the cooldown read and the schedule happen in one transaction: two rapid
 * clicks cannot both get past the guard.
 *
 * The guard is deliberately cheap — it refuses when a check was *recorded* in
 * the last minute. A check scheduled seconds ago has not recorded yet, so the
 * real protection against a hammering client is the per-user rate limiter the
 * app applies to paid paths; this only stops the obvious double-click.
 */
export const checkNow = mutation({
  args: { itemId: v.id("items") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const userId = await requireUserId(ctx);
    const item = await ownedItem(ctx, itemId, userId);
    if (!item.productUrl) throw new ConvexError("This item has no product page to check");

    const last = await ctx.db
      .query("priceChecks")
      .withIndex("by_item", (q) => q.eq("itemId", itemId))
      .order("desc")
      .first();
    if (last && Date.now() - last.observedAt < CHECK_COOLDOWN_MS) {
      throw new ConvexError("This item was just checked; try again in a minute");
    }

    await ctx.scheduler.runAfter(0, internal.priceWatch.checkItem, { itemId });
    return null;
  },
});
