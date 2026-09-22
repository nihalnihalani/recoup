import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUserId } from "./lib/access";
import { openClaim } from "./claims";
import { windowEndsAt } from "./lib/ledger";
import { ensurePurchaseTransaction } from "./transactions";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DOMAIN = "northwind.example";
const MERCHANT = "Northwind Outfitters";
const WINDOW_DAYS = 14;
const AUDIO_DOMAIN = "haldenaudio.example";
const AUDIO_MERCHANT = "Halden Audio";
const AUDIO_WINDOW_DAYS = 30;

/**
 * Seeds two labelled example purchases into the caller's account (D04, D27),
 * both price drops after purchase, at two made-up stores.
 * Idempotent per user: if the caller already owns an example purchase, nothing
 * is inserted. Every contact address is on the reserved `.example` TLD, so no
 * real mail can be sent by accident, and nothing here touches the network.
 * Accounts that loaded an earlier version of the example keep the rows they
 * already have; there is no migration.
 */
export const load = mutation({
  args: {},
  returns: v.object({ loaded: v.boolean(), purchaseIds: v.array(v.id("purchases")) }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    const mine = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const existing = mine.filter((p) => p.isExample);
    if (existing.length > 0) {
      // DA-A-35: examples loaded before wave 1 have no transaction yet; give them one (idempotent, ≤ 2 rows).
      for (const p of existing) await ensurePurchaseTransaction(ctx, p._id);
      return { loaded: false, purchaseIds: existing.map((p) => p._id) };
    }

    const now = Date.now();

    const priceAdjustmentPolicy = await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "price_adjustment",
      windowDays: WINDOW_DAYS,
      channel: "email",
      contactEmail: `help@${DOMAIN}`,
      passage: `Example policy: if we lower the price of an item within 14 days of your purchase, email help@${DOMAIN} with your order number and we will refund the difference to your original payment method.`,
      sourceUrl: `https://${DOMAIN}/price-adjustments`,
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
      isExample: true,
    });

    // Story one: bought at $120, now observed at $95 inside the 14-day window.
    const purchasedAt = now - 5 * DAY;
    const productUrl = `https://${DOMAIN}/p/waxed-field-jacket`;
    const dropPurchase = await ctx.db.insert("purchases", {
      userId,
      merchant: MERCHANT,
      merchantDomain: DOMAIN,
      orderRef: "NW-48377",
      purchasedAt,
      currency: "USD",
      status: "active",
      isExample: true,
    });
    // DA-A-35: a direct purchase insert creates its own transaction, which copies `isExample`.
    await ensurePurchaseTransaction(ctx, dropPurchase);
    const jacket = await ctx.db.insert("items", {
      purchaseId: dropPurchase,
      userId,
      name: "Waxed field jacket",
      unitCents: 12000,
      qty: 1,
      productUrl,
      returned: false,
    });
    // A short, plainly labelled history so the example chart has a shape to read:
    // steady at the paid price, a brief sale that ended, then the drop the claim is about.
    const history: Array<[number, number]> = [
      [5 * DAY, 12000],
      [4 * DAY + 12 * HOUR, 12000],
      [4 * DAY, 12000],
      [3 * DAY + 12 * HOUR, 11400],
      [3 * DAY, 11400],
      [2 * DAY + 12 * HOUR, 12000],
      [2 * DAY, 12000],
      [1 * DAY + 12 * HOUR, 11800],
      [1 * DAY, 10900],
      [12 * HOUR, 10200],
    ];
    for (const [ago, cents] of history) {
      await ctx.db.insert("priceChecks", {
        itemId: jacket,
        userId,
        observedCents: cents,
        currency: "USD",
        confidence: 1,
        variantMatch: "exact",
        observedAt: now - ago,
        sourceUrl: productUrl,
        note: "Example observation",
      });
    }
    const drop = await ctx.db.insert("priceChecks", {
      itemId: jacket,
      userId,
      observedCents: 9500,
      currency: "USD",
      confidence: 1,
      variantMatch: "exact",
      observedAt: now - 2 * HOUR,
      sourceUrl: productUrl,
      note: "Example observation",
    });
    await openClaim(ctx, {
      userId,
      purchaseId: dropPurchase,
      itemId: jacket,
      type: "price_adjustment",
      expectedCents: 2500,
      windowEndsAt: windowEndsAt(purchasedAt, WINDOW_DAYS),
      policyId: priceAdjustmentPolicy,
      openedFromPriceCheckId: drop,
      isExample: true,
    });

    // Story two, a different store: headphones bought at $199, now $169 inside a 30-day window.
    const audioPolicy = await ctx.db.insert("policies", {
      userId,
      merchantDomain: AUDIO_DOMAIN,
      kind: "price_adjustment",
      windowDays: AUDIO_WINDOW_DAYS,
      channel: "email",
      contactEmail: `support@${AUDIO_DOMAIN}`,
      passage: `Example policy: if our price for an item you bought drops within 30 days of your order, email support@${AUDIO_DOMAIN} with your order number and we will credit the difference.`,
      sourceUrl: `https://${AUDIO_DOMAIN}/price-match`,
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
      isExample: true,
    });
    const audioPurchasedAt = now - 9 * DAY;
    const audioUrl = `https://${AUDIO_DOMAIN}/p/over-ear-headphones`;
    const audioPurchase = await ctx.db.insert("purchases", {
      userId,
      merchant: AUDIO_MERCHANT,
      merchantDomain: AUDIO_DOMAIN,
      orderRef: "HA-20931",
      purchasedAt: audioPurchasedAt,
      currency: "USD",
      status: "active",
      isExample: true,
    });
    await ensurePurchaseTransaction(ctx, audioPurchase);
    const headphones = await ctx.db.insert("items", {
      purchaseId: audioPurchase,
      userId,
      name: "Over-ear wireless headphones",
      unitCents: 19900,
      qty: 1,
      productUrl: audioUrl,
      returned: false,
    });
    const audioHistory: Array<[number, number]> = [
      [9 * DAY, 19900],
      [8 * DAY, 19900],
      [7 * DAY, 19900],
      [6 * DAY, 19900],
      [5 * DAY, 18900],
      [4 * DAY, 18900],
      [3 * DAY, 19900],
      [2 * DAY, 17900],
      [1 * DAY, 17900],
    ];
    for (const [ago, cents] of audioHistory) {
      await ctx.db.insert("priceChecks", {
        itemId: headphones,
        userId,
        observedCents: cents,
        currency: "USD",
        confidence: 1,
        variantMatch: "exact",
        observedAt: now - ago,
        sourceUrl: audioUrl,
        note: "Example observation",
      });
    }
    const audioDrop = await ctx.db.insert("priceChecks", {
      itemId: headphones,
      userId,
      observedCents: 16900,
      currency: "USD",
      confidence: 1,
      variantMatch: "exact",
      observedAt: now - 3 * HOUR,
      sourceUrl: audioUrl,
      note: "Example observation",
    });
    await openClaim(ctx, {
      userId,
      purchaseId: audioPurchase,
      itemId: headphones,
      type: "price_adjustment",
      expectedCents: 3000,
      windowEndsAt: windowEndsAt(audioPurchasedAt, AUDIO_WINDOW_DAYS),
      policyId: audioPolicy,
      openedFromPriceCheckId: audioDrop,
      isExample: true,
    });

    return { loaded: true, purchaseIds: [dropPurchase, audioPurchase] };
  },
});
