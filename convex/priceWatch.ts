import { ConvexError, v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import { action, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { extract } from "./lib/ai";
import { Price } from "./lib/schemas";
import { toCents } from "./lib/money";
import { priceDropCents, windowEndsAt } from "./lib/ledger";
import { latest } from "./policies";
import { openClaim } from "./claims";
import { variantMatch as variantMatchValidator } from "./schema";

const firecrawl = new FirecrawlClient(components.firecrawl);

type VariantMatch = "exact" | "unsure" | "none";

type ScrapedPrice = {
  price?: number | null;
  currency?: string | null;
  isRange?: boolean;
  variantMatch?: VariantMatch;
  confidence?: number;
};

const JSON_PROMPT = (name: string) =>
  `Return the current price information for the exact product "${name}" on this page as ` +
  `{"price": number|null, "currency": string|null, "isRange": boolean, "variantMatch": "exact"|"unsure"|"none", "confidence": number}. ` +
  `"price" is the single current selling price in major units (use the sale price if one is shown); null if the page does not show a single unambiguous number for this exact item. ` +
  `"currency" is the ISO 4217 code shown on the page, else null. "isRange" is true if the page shows a price range or a "from" price. ` +
  `"variantMatch" says whether the shown price is for this exact product/variant ("exact"), for a related but different variant ("unsure"), or not found at all ("none"). "confidence" is 0 to 1.`;

const MARKDOWN_SYSTEM = (name: string) =>
  `Extract the current price of the product named "${name}" from this page text. Use the sale price if one is shown. ` +
  `Set price to null and variantMatch to "none" if this exact product is not on the page.`;

/**
 * Items the 6-hourly cron should check (D16, D27): not an example, an
 * active purchase with a confirmed purchase date, not returned, has a
 * product URL, and has a `price_adjustment` policy snapshot with a window
 * that has not yet closed.
 */
export const eligibleItems = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const items = await ctx.db.query("items").collect();
    const out: { itemId: Id<"items"> }[] = [];
    for (const it of items) {
      if (!it.productUrl || it.returned) continue;
      const purchase = await ctx.db.get(it.purchaseId);
      if (!purchase) continue;
      if (purchase.isExample) continue;
      if (purchase.status !== "active") continue;
      if (purchase.purchasedAt === undefined) continue;
      const policy = await latest(ctx, it.userId, purchase.merchantDomain, "price_adjustment");
      if (!policy || !policy.windowDays || !(policy.confidence > 0)) continue;
      if (windowEndsAt(purchase.purchasedAt, policy.windowDays) < now) continue;
      out.push({ itemId: it._id });
    }
    return out;
  },
});

/** Scheduler-driven sweep. Never throws: each item's failure is caught and logged so one bad item can't stall the rest. */
export const runAll = internalAction({
  args: {},
  handler: async (ctx) => {
    const items = await ctx.runQuery(internal.priceWatch.eligibleItems, {});
    for (const { itemId } of items) {
      try {
        await ctx.runAction(internal.priceWatch.checkItem, { itemId });
      } catch (err) {
        console.error("priceWatch.runAll: check failed", itemId, err);
      }
    }
  },
});

export const getItem = internalQuery({
  args: { itemId: v.id("items") },
  handler: (ctx, { itemId }) => ctx.db.get(itemId),
});

/**
 * Scrapes the item's product page and hands the observation to
 * `recordCheck`. Prefers the structured JSON extraction from the scrape
 * itself; falls back to a separate OpenAI extraction over the markdown when
 * the JSON format didn't produce a usable numeric price. Any Firecrawl or
 * OpenAI failure is recorded as a check with no observed price rather than
 * thrown (D16), so a single flaky merchant page never breaks the sweep.
 */
export const checkItem = internalAction({
  args: { itemId: v.id("items") },
  handler: async (ctx, { itemId }) => {
    const item = await ctx.runQuery(internal.priceWatch.getItem, { itemId });
    if (!item?.productUrl) return;
    const sourceUrl = item.productUrl;

    try {
      const doc = await firecrawl.scrape(ctx, sourceUrl, {
        formats: ["markdown", { type: "json", prompt: JSON_PROMPT(item.name) }],
        onlyMainContent: true,
        maxAge: 3_600_000,
      });

      let observedCents: number | undefined;
      let currency: string | undefined;
      let confidence: number | undefined;
      let variantMatch: VariantMatch | undefined;
      let isRange = false;
      let note: string | undefined;

      const j = doc.json as ScrapedPrice | undefined;
      if (j && typeof j.price === "number") {
        observedCents = toCents(j.price);
        currency = j.currency ?? undefined;
        confidence = j.confidence;
        variantMatch = j.variantMatch;
        isRange = j.isRange ?? false;
      } else if (doc.markdown) {
        const p = await extract("price", Price, MARKDOWN_SYSTEM(item.name), doc.markdown);
        if (typeof p.price === "number") observedCents = toCents(p.price);
        currency = p.currency ?? undefined;
        confidence = p.confidence;
        variantMatch = p.variantMatch;
        isRange = p.isRange;
        note = p.note ?? undefined;
      }

      await ctx.runMutation(internal.priceWatch.recordCheck, {
        itemId,
        observedCents,
        currency,
        confidence,
        variantMatch,
        isRange,
        sourceUrl,
        note,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.priceWatch.recordCheck, {
        itemId,
        sourceUrl,
        note: `check failed: ${msg.slice(0, 200)}`,
      });
    }
  },
});

/**
 * Records one price observation, and opens a `price_adjustment` claim only
 * when every acceptance condition holds (D16): a numeric observed price in
 * the purchase's own currency, high-confidence exact variant match, not a
 * range, the purchase active with a purchase date, an eligible policy
 * snapshot, an open window, a qualifying drop (`priceDropCents`), and no
 * other open price_adjustment claim on the item. `openClaim`'s own
 * same-item guard is a second line of defense against a concurrent check
 * racing this one to the same conclusion.
 */
export const recordCheck = internalMutation({
  args: {
    itemId: v.id("items"),
    observedCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    confidence: v.optional(v.number()),
    variantMatch: v.optional(variantMatchValidator),
    isRange: v.optional(v.boolean()),
    sourceUrl: v.string(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return { opened: false as const };

    const checkId = await ctx.db.insert("priceChecks", {
      itemId: item._id,
      userId: item.userId,
      observedCents: args.observedCents,
      currency: args.currency,
      confidence: args.confidence,
      variantMatch: args.variantMatch,
      observedAt: Date.now(),
      sourceUrl: args.sourceUrl,
      note: args.note,
    });

    if (args.observedCents === undefined) return { opened: false as const };

    const purchase = await ctx.db.get(item.purchaseId);
    if (!purchase || purchase.status !== "active" || purchase.purchasedAt === undefined) {
      return { opened: false as const };
    }
    if (args.currency === undefined || args.currency !== purchase.currency) return { opened: false as const };
    if (args.confidence === undefined || args.confidence < 0.7) return { opened: false as const };
    if (args.variantMatch !== "exact") return { opened: false as const };
    if (args.isRange) return { opened: false as const };

    const policy = await latest(ctx, item.userId, purchase.merchantDomain, "price_adjustment");
    if (!policy || !policy.windowDays || !(policy.confidence > 0)) return { opened: false as const };
    const ends = windowEndsAt(purchase.purchasedAt, policy.windowDays);
    if (ends < Date.now()) return { opened: false as const };

    const drop = priceDropCents(item.unitCents, args.observedCents, item.qty);
    if (drop === null) return { opened: false as const };

    const alreadyOpen = (
      await ctx.db
        .query("claims")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .collect()
    ).some((c) => c.type === "price_adjustment" && !["confirmed", "dismissed"].includes(c.status));
    if (alreadyOpen) return { opened: false as const };

    try {
      const claimId = await openClaim(ctx, {
        userId: item.userId,
        purchaseId: purchase._id,
        itemId: item._id,
        type: "price_adjustment",
        expectedCents: drop,
        windowEndsAt: ends,
        policyId: policy._id,
        openedFromPriceCheckId: checkId,
        isExample: purchase.isExample,
      });
      return { opened: true as const, claimId };
    } catch {
      // openClaim's own same-item guard is the last line of defense against
      // a concurrent check (manual + cron) reaching this point together.
      return { opened: false as const };
    }
  },
});

/** User-triggered check of one item they own. */
export const checkNow = action({
  args: { itemId: v.id("items") },
  handler: async (ctx, { itemId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const item = await ctx.runQuery(internal.priceWatch.getItem, { itemId });
    if (!item || item.userId !== userId) throw new ConvexError("Item not found");
    await ctx.runAction(internal.priceWatch.checkItem, { itemId });
  },
});
