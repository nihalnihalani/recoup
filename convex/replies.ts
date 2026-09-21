import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { extract } from "./lib/ai";
import { ReplyClass } from "./lib/schemas";
import { replyClass } from "./schema";
import { toCents } from "./lib/money";
import { applyEvent } from "./claims";
import { scheduleReminder } from "./followUps";

const SYSTEM = `Classify a retailer's reply to a customer's refund or price-adjustment request. "promise" = they say a refund or credit will be issued but has not been yet. "credit_issued" = they say it has already been issued. "refusal" = they decline the request. "question" = they need more information before deciding. Otherwise "other". promisedAmount is the amount they state will be or was refunded, in major units; null if no amount is stated.`;

/**
 * Plain helper (no action-in-action) run by `inbound.process` for the
 * "reply" route.
 */
export async function classifyReply(
  ctx: ActionCtx,
  args: { claimId: Id<"claims">; messageId: string; from: string; subject: string; text: string },
): Promise<void> {
  const c = await ctx.runQuery(internal.drafts.context, { claimId: args.claimId });
  if (!c) return;
  const parsed = await extract(
    "reply",
    ReplyClass,
    SYSTEM,
    `Requested amount: ${c.balance.unresolved / 100} ${c.purchase?.currency ?? ""}\n\nFrom: ${args.from}\nSubject: ${args.subject}\n\n${args.text}`,
  );
  await ctx.runMutation(internal.replies.apply, {
    claimId: args.claimId,
    messageId: args.messageId,
    from: args.from,
    classification: parsed.classification,
    summary: parsed.summary,
    promisedAmount: parsed.promisedAmount ?? undefined,
  });
}

// D58: REOPEN_ELIGIBLE removed as a status-transition gate for the
// amount-bearing path (that now goes through `applyEvent`/`statusAfterEvent`
// unconditionally, per D53). It still governs the *no-amount* case below,
// with `detected` added: a bare "we'll process this" reply arriving before
// any draft was even sent should still surface as `promised`.
const PROMISABLE_WITHOUT_AMOUNT = new Set(["sent", "packet", "reopened", "drafted", "detected"]);

export const apply = internalMutation({
  args: {
    claimId: v.id("claims"),
    messageId: v.string(),
    from: v.string(),
    classification: replyClass,
    summary: v.string(),
    promisedAmount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const dup = await ctx.db
      .query("replies")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .first();
    if (dup) return;
    const claim = await ctx.db.get(args.claimId);
    if (!claim) return;

    // senderMismatch (D21): sender domain differs from the latest *sent*
    // draft's recipient domain.
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .collect();
    const lastSent = drafts.filter((d) => d.outboundId).sort((a, b) => b.version - a.version)[0];
    const senderDomain = args.from.split("@")[1]?.toLowerCase();
    const recipientDomain = lastSent?.to.split("@")[1]?.toLowerCase();
    const senderMismatch = Boolean(senderDomain && recipientDomain && senderDomain !== recipientDomain);

    // D48: applyEvent rejects 0-cent events, so a stated amount only counts
    // as "stated" when it is strictly positive; null/undefined/<=0 all
    // behave like no amount was given.
    const rawCents = args.promisedAmount !== undefined ? toCents(args.promisedAmount) : undefined;
    const promisedCents = rawCents !== undefined && rawCents > 0 ? rawCents : undefined;

    await ctx.db.insert("replies", {
      claimId: claim._id,
      userId: claim.userId,
      messageId: args.messageId,
      from: args.from,
      classification: args.classification,
      summary: args.summary,
      promisedCents,
      senderMismatch,
      receivedAt: Date.now(),
    });

    if (args.classification === "promise" || args.classification === "credit_issued") {
      // D53: the reply row above is always recorded; a ledger event is
      // written only when the reply states an amount AND the claim is not
      // dismissed (dismissed is terminal -- `applyEvent` would throw, which
      // would roll back the whole mutation including the reply insert, so
      // this is checked here instead of relying on `applyEvent` to refuse).
      // A *confirmed* claim still gets the ledger event (a merchant can
      // restate a promise after the claim settled); `statusAfterEvent`
      // itself keeps a confirmed claim's status unchanged.
      if (promisedCents !== undefined && claim.status !== "dismissed") {
        await applyEvent(
          ctx,
          claim,
          "promised_credit",
          promisedCents,
          `Merchant reply (${args.classification}): ${args.summary}`,
          `msg:${args.messageId}`,
        );
      } else if (promisedCents === undefined && PROMISABLE_WITHOUT_AMOUNT.has(claim.status)) {
        // D58: a no-amount reply still nudges the claim to `promised`, but
        // only from these statuses -- notably not `queued` (send not even
        // confirmed delivered yet) and not `confirmed`/`dismissed`.
        await ctx.db.patch(claim._id, { status: "promised", version: claim.version + 1 });
      }
      const after = (await ctx.db.get(claim._id))!;
      if (after.status !== "confirmed" && after.status !== "dismissed") {
        await scheduleReminder(ctx, after, Date.now() + 7 * 86_400_000);
      }
    } else {
      await ctx.db.patch(claim._id, { attentionAt: Date.now() });
    }
  },
});
