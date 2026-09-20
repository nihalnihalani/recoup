import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUserId } from "./lib/access";
import { applyEvent, openClaim } from "./claims";
import { windowEndsAt } from "./lib/ledger";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DOMAIN = "northwind.example";
const MERCHANT = "Northwind Outfitters";
const WINDOW_DAYS = 14;

/**
 * Seeds two labelled example purchases into the caller's account (D04, D27).
 * Idempotent per user: if the caller already owns an example purchase, nothing
 * is inserted. Every contact address is on the reserved `.example` TLD, so no
 * real mail can be sent by accident, and nothing here touches the network.
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
    if (existing.length > 0) return { loaded: false, purchaseIds: existing.map((p) => p._id) };

    const now = Date.now();

    const returnsPolicy = await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "returns",
      windowDays: WINDOW_DAYS,
      channel: "email",
      contactEmail: `returns@${DOMAIN}`,
      passage: `Example policy: refunds are processed within 14 days of receipt at our warehouse. If you have not heard from us after 14 days, email returns@${DOMAIN} with your order number and the items returned.`,
      sourceUrl: `https://${DOMAIN}/returns`,
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
      isExample: true,
    });
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

    // Story one: two items returned, the sweater was credited, the scarf was not.
    const returnsPurchase = await ctx.db.insert("purchases", {
      userId,
      merchant: MERCHANT,
      merchantDomain: DOMAIN,
      orderRef: "NW-48211",
      purchasedAt: now - 26 * DAY,
      currency: "USD",
      status: "active",
      isExample: true,
    });
    const sweater = await ctx.db.insert("items", {
      purchaseId: returnsPurchase,
      userId,
      name: "Merino crew sweater",
      unitCents: 8000,
      qty: 1,
      returned: true,
      returnedAt: now - 23 * DAY,
    });
    const scarf = await ctx.db.insert("items", {
      purchaseId: returnsPurchase,
      userId,
      name: "Wool scarf, oat",
      unitCents: 4000,
      qty: 1,
      returned: true,
      returnedAt: now - 23 * DAY,
    });
    const sweaterClaimId = await openClaim(ctx, {
      userId,
      purchaseId: returnsPurchase,
      itemId: sweater,
      type: "return_credit",
      expectedCents: 8000,
      policyId: returnsPolicy,
      isExample: true,
    });
    const sweaterClaim = await ctx.db.get(sweaterClaimId);
    if (!sweaterClaim) throw new ConvexError("Example claim missing");
    await applyEvent(
      ctx,
      sweaterClaim,
      "confirmed_credit",
      8000,
      "Example: $80.00 refund for the Merino crew sweater seen on the card statement",
      `example:${returnsPurchase}:sweater`,
    );
    await openClaim(ctx, {
      userId,
      purchaseId: returnsPurchase,
      itemId: scarf,
      type: "return_credit",
      expectedCents: 4000,
      policyId: returnsPolicy,
      isExample: true,
    });

    // Story two: bought at $120, now observed at $95 inside the 14-day window.
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

    return { loaded: true, purchaseIds: [returnsPurchase, dropPurchase] };
  },
});
