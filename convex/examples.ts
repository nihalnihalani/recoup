import { mutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/access";
import { openClaim, applyEvent } from "./claims";
import { windowEndsAt } from "./lib/ledger";
import { removePurchase } from "./purchases";

const DAY = 86_400_000;
const DOMAIN = "northwind.example";

/**
 * Seeds two labelled example purchases into the signed-in user's own
 * account (D04, D27): a returns case (one item already credited, one still
 * a $40 gap) and a price-adjustment case (a jacket that dropped $95 -> ... ,
 * i.e. $120 -> $95). Every row carries `isExample: true` and every
 * recipient/contact/product URL points at the non-resolving `*.example`
 * domain so no real mail can ever go out by accident.
 *
 * Idempotent per user: if the caller already has any example purchase,
 * this is a no-op (`{ loaded: false }`) rather than seeding a duplicate set.
 */
export const load = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);

    const existing = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // D47: an archived (removed) example purchase no longer counts, so a
    // user who removed their examples can load a fresh set.
    if (existing.some((p) => p.isExample && p.status !== "archived")) {
      return { loaded: false as const };
    }

    const now = Date.now();

    const returnsPolicy = await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "returns",
      windowDays: 14,
      channel: "email",
      contactEmail: "returns@northwind.example",
      passage:
        "Example policy: refunds are processed within 14 days of receipt at our warehouse. If you have not heard from us after 14 days, email returns@northwind.example with your order number and the items returned.",
      sourceUrl: "https://northwind.example/returns",
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
      isExample: true,
    });
    const paPolicy = await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      contactEmail: "help@northwind.example",
      passage:
        "Example policy: if we lower the price of an item within 14 days of your purchase, email help@northwind.example with your order number and we will refund the difference to your original payment method.",
      sourceUrl: "https://northwind.example/price-adjustments",
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
      isExample: true,
    });

    // Act one: two items returned, one already credited by the merchant,
    // one still an open $40 gap.
    const p1 = await ctx.db.insert("purchases", {
      userId,
      merchant: "Northwind Outfitters (example)",
      merchantDomain: DOMAIN,
      orderRef: "NW-48211",
      purchasedAt: now - 26 * DAY,
      currency: "USD",
      status: "active",
      isExample: true,
    });
    const sweater = await ctx.db.insert("items", {
      purchaseId: p1,
      userId,
      name: "Merino crew sweater",
      unitCents: 8000,
      qty: 1,
      returned: true,
      returnedAt: now - 23 * DAY,
    });
    const scarf = await ctx.db.insert("items", {
      purchaseId: p1,
      userId,
      name: "Wool scarf, oat",
      unitCents: 4000,
      qty: 1,
      returned: true,
      returnedAt: now - 23 * DAY,
    });

    const sweaterClaim = await openClaim(ctx, {
      userId,
      purchaseId: p1,
      itemId: sweater,
      type: "return_credit",
      expectedCents: 8000,
      policyId: returnsPolicy,
      isExample: true,
    });
    await applyEvent(
      ctx,
      (await ctx.db.get(sweaterClaim))!,
      "promised_credit",
      8000,
      "Example merchant email: refund issued for Merino crew sweater",
      `example:sweater:${userId}`,
    );

    // The scarf claim is left open with no events: the $40 gap the demo walks through.
    await openClaim(ctx, {
      userId,
      purchaseId: p1,
      itemId: scarf,
      type: "return_credit",
      expectedCents: 4000,
      policyId: returnsPolicy,
      isExample: true,
    });

    // Act two: a price drop inside the window.
    const p2 = await ctx.db.insert("purchases", {
      userId,
      merchant: "Northwind Outfitters (example)",
      merchantDomain: DOMAIN,
      orderRef: "NW-48377",
      purchasedAt: now - 5 * DAY,
      currency: "USD",
      status: "active",
      isExample: true,
    });
    const jacket = await ctx.db.insert("items", {
      purchaseId: p2,
      userId,
      name: "Waxed field jacket",
      unitCents: 12000,
      qty: 1,
      productUrl: "https://northwind.example/p/waxed-field-jacket",
      returned: false,
    });
    await ctx.db.insert("priceChecks", {
      itemId: jacket,
      userId,
      observedCents: 12000,
      observedAt: now - 4 * DAY,
      sourceUrl: "https://northwind.example/p/waxed-field-jacket",
    });
    const check = await ctx.db.insert("priceChecks", {
      itemId: jacket,
      userId,
      observedCents: 9500,
      observedAt: now - 2 * 3_600_000,
      sourceUrl: "https://northwind.example/p/waxed-field-jacket",
    });
    await openClaim(ctx, {
      userId,
      purchaseId: p2,
      itemId: jacket,
      type: "price_adjustment",
      expectedCents: 2500,
      windowEndsAt: windowEndsAt(now - 5 * DAY, 14),
      policyId: paPolicy,
      openedFromPriceCheckId: check,
      isExample: true,
    });

    return { loaded: true as const, purchaseIds: [p1, p2] as Id<"purchases">[] };
  },
});

/** Archives every example purchase owned by the caller (D47): they drop off the board, but their history is kept. */
export const remove = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const purchases = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const exampleIds = purchases.filter((p) => p.isExample).map((p) => p._id);
    for (const purchaseId of exampleIds) {
      await removePurchase(ctx, purchaseId);
    }
    return { removed: exampleIds.length };
  },
});
