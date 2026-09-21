import { ConvexError, v } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { extract } from "./lib/ai";
import { InboundEmail } from "./lib/schemas";
import { assertCents, assertCurrency, assertPositiveCents, assertQty, assertTimestamp, toCents } from "./lib/money";
import { openClaim, applyEvent } from "./claims";
import { latest } from "./policies";

const SYSTEM = `You read a single email a shopper forwarded, or pasted directly. Decide whether it is an order confirmation ("order"), a refund or return-credit notice ("refund"), or neither ("other"). Extract only what the email states. Prices are per unit before tax. If the email lists a product link, include it. Never invent a merchant domain: derive it from the sender's address or a link in the email.`;

async function markEventNeedsReview(ctx: MutationCtx, eventId: Id<"processedEvents">, summary: string) {
  await ctx.db.patch(eventId, { status: "needs_review", summary });
}

/**
 * Plain helper (no action-in-action, D17-style): run by `inbound.process`
 * for the "intake" route, and inline by `paste`. LLM output is proposed
 * data only; `applyExtraction` re-validates it with zod.
 *
 * `key` (D54) is the external, per-message identity used to scope refund
 * credit idempotency keys: the AgentMail message id for a forwarded email,
 * or the paste's content hash for a pasted one. It is stable across a
 * retry of the same event so a retried extraction still dedupes against
 * ledger events it already wrote.
 */
export async function extractInbound(
  ctx: ActionCtx,
  args: { userId: Id<"users">; eventId: Id<"processedEvents">; subject: string; text: string; from: string; key: string },
): Promise<void> {
  const parsed = await extract(
    "inbound_email",
    InboundEmail,
    SYSTEM,
    `From: ${args.from}\nSubject: ${args.subject}\n\n${args.text}`,
  );
  await ctx.runMutation(internal.intake.applyExtraction, {
    userId: args.userId,
    eventId: args.eventId,
    parsed,
    key: args.key,
  });
}

export const applyExtraction = internalMutation({
  args: { userId: v.id("users"), eventId: v.id("processedEvents"), parsed: v.any(), key: v.string() },
  handler: async (ctx, { userId, eventId, parsed, key }) => {
    const p = InboundEmail.parse(parsed);

    if (p.kind === "order" && p.order) {
      const domain = p.order.merchantDomain.toLowerCase();
      const orderRef = p.order.orderRef ?? undefined;

      if (orderRef) {
        const dup = await ctx.db
          .query("purchases")
          .withIndex("by_user_domain_order", (q) =>
            q.eq("userId", userId).eq("merchantDomain", domain).eq("orderRef", orderRef),
          )
          .first();
        if (dup) {
          await markEventNeedsReview(ctx, eventId, `Duplicate of purchase ${p.order.merchant} ${orderRef}`);
          return;
        }
      }

      const currency = p.order.currency.toUpperCase();
      try {
        assertCurrency(currency);
      } catch {
        await markEventNeedsReview(ctx, eventId, `Unknown currency ${currency}`);
        return;
      }

      // D58: validate the boundary-crossing fields before writing anything.
      // A violation routes the whole order to `needs_review` (never
      // `failed` -- these are untrusted extracted values, not a bug) and no
      // purchase or item is inserted at all, rather than leaving a partial
      // row behind.
      let purchasedAt: number | undefined;
      if (p.order.purchasedAt) {
        const parsedDate = Date.parse(p.order.purchasedAt);
        if (Number.isFinite(parsedDate)) {
          try {
            purchasedAt = assertTimestamp(parsedDate, "purchasedAt");
          } catch {
            await markEventNeedsReview(ctx, eventId, `Invalid purchase date ${p.order.purchasedAt}`);
            return;
          }
        }
        // An unparseable date is treated as "not stated" (D25: purchasedAt
        // is optional), not a validation violation.
      }

      const items: { name: string; unitCents: number; qty: number; productUrl?: string }[] = [];
      for (const it of p.order.items) {
        try {
          assertQty(it.qty);
          const unitCents = assertCents(toCents(it.unitPrice), "unitPrice");
          items.push({ name: it.name, unitCents, qty: it.qty, productUrl: it.productUrl ?? undefined });
        } catch {
          await markEventNeedsReview(ctx, eventId, `Invalid price or quantity for item "${it.name}"`);
          return;
        }
      }

      const purchaseId = await ctx.db.insert("purchases", {
        userId,
        merchant: p.order.merchant,
        merchantDomain: domain,
        orderRef,
        purchasedAt,
        currency,
        status: "needs_review",
      });
      for (const item of items) {
        await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: item.name,
          unitCents: item.unitCents,
          qty: item.qty,
          productUrl: item.productUrl,
          returned: false,
        });
      }
      // Never scheduled here (D25): policy fetch happens on purchases.confirm.
      await markEventNeedsReview(ctx, eventId, `Purchase from ${p.order.merchant} needs your review`);
      return;
    }

    if (p.kind === "refund" && p.refund) {
      const refund = p.refund;
      const allPurchases = await ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();

      // D55: only active, non-example purchases are eligible, unless the
      // refund's own merchant name explicitly marks it as an example (so
      // the examples flow can still exercise this path end to end).
      const refundIsExample = Boolean(refund.merchant?.toLowerCase().includes("(example)"));
      const eligible = allPurchases.filter((x) => {
        if (x.status !== "active") return false;
        if (x.isExample) return refundIsExample;
        return true;
      });

      // Preference order: exact orderRef, then exact merchant name, then
      // merchant-name inclusion.
      const purchase =
        (refund.orderRef && eligible.find((x) => x.orderRef === refund.orderRef)) ||
        (refund.merchant && eligible.find((x) => x.merchant.toLowerCase() === refund.merchant!.toLowerCase())) ||
        (refund.merchant &&
          eligible.find((x) => x.merchant.toLowerCase().includes(refund.merchant!.toLowerCase()))) ||
        undefined;
      if (!purchase) {
        await markEventNeedsReview(ctx, eventId, "Refund email could not be matched to a purchase");
        return;
      }

      const items = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
        .collect();
      const returnsPolicy = await latest(ctx, userId, purchase.merchantDomain, "returns");

      for (const [index, credit] of refund.credits.entries()) {
        // D58: a non-positive or otherwise invalid credit amount is a
        // per-credit needs_review, not a thrown (and event-failing) error.
        let cents: number;
        try {
          cents = assertPositiveCents(toCents(credit.amount), "credit amount");
        } catch {
          await markEventNeedsReview(ctx, eventId, `Credit amount ${credit.amount} is not a valid positive amount`);
          continue;
        }

        let matched: Doc<"items"> | undefined;
        if (credit.itemName) {
          const byName = items.filter((i) => i.name.toLowerCase().includes(credit.itemName!.toLowerCase()));
          if (byName.length === 1) matched = byName[0];
        } else {
          const byAmount = items.filter((i) => i.returned && i.unitCents * i.qty === cents);
          if (byAmount.length === 1) matched = byAmount[0];
        }

        // A refund email never sets `returned` (D15): only the user does.
        if (!matched || !matched.returned) {
          await markEventNeedsReview(ctx, eventId, `Credit of ${credit.amount} could not be matched to an item`);
          continue;
        }

        let claim = (
          await ctx.db
            .query("claims")
            .withIndex("by_item", (q) => q.eq("itemId", matched!._id))
            .collect()
        ).find((c) => c.type === "return_credit" && c.status !== "dismissed");
        if (!claim) {
          const claimId = await openClaim(ctx, {
            userId,
            purchaseId: purchase._id,
            itemId: matched._id,
            type: "return_credit",
            expectedCents: matched.unitCents * matched.qty,
            policyId: returnsPolicy?._id,
            isExample: purchase.isExample, // D55
          });
          claim = (await ctx.db.get(claimId))!;
        }

        // D54: idempotency key is external and per credit -- scoped to this
        // message (or paste), the matched item, and the credit's position
        // in the email, so two different credits (or a retried extraction)
        // never collide with each other.
        const idempotencyKey = `${key}:${matched._id}:${index}`;
        try {
          await applyEvent(
            ctx,
            claim,
            "promised_credit",
            cents,
            `Merchant email says refund ${credit.state} for ${matched.name}`,
            idempotencyKey,
          );
        } catch (err) {
          // A key collision with a conflicting kind/amount marks only this
          // credit needs_review; the event as a whole still succeeds (D54).
          if (err instanceof ConvexError && err.data === "idempotency conflict") {
            await markEventNeedsReview(
              ctx,
              eventId,
              `Credit ${index} for ${matched.name} needs review: conflicts with a previously recorded credit`,
            );
            continue;
          }
          throw err;
        }
      }
      return;
    }

    await markEventNeedsReview(ctx, eventId, "Email was not an order or refund");
  },
});

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Dedupes pasted text by content hash so a re-pasted email is a no-op. */
export const createPasteEvent = internalMutation({
  args: { externalId: v.string(), userId: v.id("users"), payload: v.any() },
  handler: async (ctx, { externalId, userId, payload }): Promise<{ eventId: Id<"processedEvents">; isNew: boolean }> => {
    const existing = await ctx.db
      .query("processedEvents")
      .withIndex("by_external", (q) => q.eq("externalId", externalId))
      .first();
    if (existing) return { eventId: existing._id, isNew: false };
    const eventId = await ctx.db.insert("processedEvents", {
      externalId,
      kind: "paste",
      status: "processing",
      attempts: 1,
      userId,
      payload,
    });
    return { eventId, isNew: true };
  },
});

/** Paste path: same pipeline as a forwarded email, run inline instead of via the scheduler. */
export const paste = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<Id<"processedEvents">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    if (text.trim().length < 40) throw new ConvexError("Paste the full order or refund email");

    // D54: the paste externalId is per user (`paste:${userId}:${sha256}`),
    // not global -- two different users pasting the same forwarded email
    // (e.g. a shared promo) must not dedupe against each other.
    const hash = await sha256Hex(text);
    const externalId = `paste:${userId}:${hash}`;
    const { eventId, isNew } = await ctx.runMutation(internal.intake.createPasteEvent, {
      externalId,
      userId,
      payload: { text: text.slice(0, 60_000) },
    });
    if (!isNew) return eventId;

    try {
      await extractInbound(ctx, { userId, eventId, subject: "", text, from: "", key: hash });
      await ctx.runMutation(internal.inbound.markProcessed, { eventId, status: "succeeded" });
    } catch (e) {
      await ctx.runMutation(internal.inbound.markProcessed, {
        eventId,
        status: "failed",
        lastError: String(e).slice(0, 1000),
      });
      throw e;
    }
    return eventId;
  },
});
