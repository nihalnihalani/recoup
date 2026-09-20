import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema, { replyClass } from "./schema";
import { ownedClaim, requireUserId } from "./lib/access";
import { extract } from "./lib/ai";
import { ReplyClass } from "./lib/schemas";
import { toCents } from "./lib/money";
import { applyEvent } from "./claims";
import { scheduleClaimReminder } from "./followUps";
import { emailDomain } from "./drafts";

const MAX_SUMMARY_CHARS = 240;
const MAX_TEXT_CHARS = 20_000;

const SYSTEM = [
  "Classify a retailer's reply to a customer's refund or price-adjustment request.",
  '"promise" = the retailer says a refund or credit will be issued but has not been yet.',
  '"credit_issued" = the retailer says the refund or credit has already been issued.',
  '"refusal" = the retailer declines the request.',
  '"question" = the retailer needs more information before deciding.',
  'Otherwise "other" (auto-replies, receipts, marketing, anything unrelated).',
  "promisedAmount is the refund amount the retailer states, in major units, or null when the reply states no amount.",
  "Never infer an amount the reply does not state.",
].join(" ");

/**
 * Two addresses count as the same party when the domains match or one is a
 * subdomain of the other (`mail.acme.com` answering for `acme.com`).
 */
function sameParty(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * Who we believe we were talking to: the recipient of the most recent draft
 * that actually left the outbox, falling back to the merchant's own domain.
 */
async function expectedDomain(
  ctx: MutationCtx,
  claim: Doc<"claims">,
): Promise<string | null> {
  const drafts = await ctx.db
    .query("drafts")
    .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
    .order("desc")
    .take(20);
  const sent = drafts.find((d) => d.approvedAt !== undefined && d.to.length > 0);
  if (sent) return emailDomain(sent.to);
  const purchase = await ctx.db.get(claim.purchaseId);
  return purchase ? purchase.merchantDomain.toLowerCase() : null;
}

/**
 * Classifies one inbound merchant reply (D21).
 *
 * The exported name and argument shape are a contract with
 * `inbound.onMessageReceived`, which schedules this by reference (D34); do
 * not rename or re-shape them. Unauthenticated on purpose: the inbound
 * router has already resolved the owning user from the inbox that received
 * the message, and `apply` re-derives ownership from the claim.
 */
export const classify = internalAction({
  args: {
    processedEventId: v.optional(v.id("processedEvents")),
    claimId: v.id("claims"),
    messageId: v.string(),
    from: v.string(),
    subject: v.string(),
    text: v.string(),
    attempt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Scheduled actions are not retried by Convex, so a model hiccup would lose the
    // merchant's reply for good (review H2): retry with backoff, then park the
    // event as `failed` where the user can see it and re-run it.
    const attempt = args.attempt ?? 0;
    try {
      await classifyOnce(ctx, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < CLASSIFY_BACKOFF_MS.length) {
        await ctx.scheduler.runAfter(CLASSIFY_BACKOFF_MS[attempt], internal.replies.classify, {
          ...args,
          attempt: attempt + 1,
        });
      } else if (args.processedEventId) {
        await ctx.runMutation(internal.intake.failEvent, {
          processedEventId: args.processedEventId,
          lastError: `Could not read the reply: ${message}`,
        });
      }
      return null;
    }
    if (args.processedEventId) {
      await ctx.runMutation(internal.replies.finishEvent, { processedEventId: args.processedEventId });
    }
    return null;
  },
});

const CLASSIFY_BACKOFF_MS = [20_000, 120_000];

export const finishEvent = internalMutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.null(),
  handler: async (ctx, { processedEventId }) => {
    const row = await ctx.db.get(processedEventId);
    if (row) await ctx.db.patch(processedEventId, { status: "succeeded", lastError: undefined, summary: "Reply read and recorded on the claim." });
    return null;
  },
});

async function classifyOnce(
  ctx: ActionCtx,
  args: { claimId: Id<"claims">; messageId: string; from: string; subject: string; text: string },
): Promise<null> {
  {
    const c = await ctx.runQuery(internal.drafts.context, { claimId: args.claimId });
    if (!c) return null;

    const currency = c.purchase?.currency ?? "USD";
    const parsed = await extract(
      "reply",
      ReplyClass,
      SYSTEM,
      [
        `Amount the customer asked for: ${(Math.max(c.balance.unresolved, 0) / 100).toFixed(2)} ${currency}`,
        `From: ${args.from}`,
        `Subject: ${args.subject}`,
        "",
        args.text.slice(0, MAX_TEXT_CHARS),
      ].join("\n"),
    );

    await ctx.runMutation(internal.replies.apply, {
      claimId: args.claimId,
      messageId: args.messageId,
      from: args.from,
      classification: parsed.classification,
      summary: parsed.summary,
      promisedAmount: parsed.promisedAmount ?? undefined,
    });
    return null;
  }
}

/**
 * Records a classified reply against its claim (D21).
 *
 * Invariants this function exists to hold:
 * - one reply row per inbound `messageId` (`replies.by_message`);
 * - a `promised_credit` ledger event only when the merchant stated an amount
 *   — a bare "we'll refund you" moves the status but touches no money;
 * - never a `confirmed_credit`: only the user, seeing the statement, can
 *   confirm that money actually arrived (Inv 3);
 * - `senderMismatch` when the reply came from a different party than the one
 *   we wrote to, so the UI can warn rather than silently trust it.
 *
 * Unauthenticated on purpose: called by `classify` above. The owning user is
 * read off the claim, never taken as an argument.
 */
export const apply = internalMutation({
  args: {
    claimId: v.id("claims"),
    messageId: v.string(),
    from: v.string(),
    classification: replyClass,
    summary: v.string(),
    promisedAmount: v.optional(v.number()),
  },
  returns: v.object({
    deduped: v.boolean(),
    replyId: v.union(v.id("replies"), v.null()),
    ledgerWritten: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dup = await ctx.db
      .query("replies")
      .withIndex("by_message", (q) => q.eq("messageId", args.messageId))
      .first();
    if (dup) return { deduped: true, replyId: dup._id, ledgerWritten: false };

    const claim = await ctx.db.get(args.claimId);
    if (!claim) return { deduped: false, replyId: null, ledgerWritten: false };

    // A stated amount is the merchant's own number; anything non-positive or
    // out of range is treated as "no amount stated" rather than a write.
    let promisedCents: number | undefined;
    if (args.promisedAmount !== undefined && Number.isFinite(args.promisedAmount)) {
      let cents: number;
      try {
        cents = toCents(args.promisedAmount);
      } catch {
        cents = 0;
      }
      if (cents > 0) promisedCents = cents;
    }

    const senderMismatch = !sameParty(
      emailDomain(args.from),
      await expectedDomain(ctx, claim),
    );

    const replyId: Id<"replies"> = await ctx.db.insert("replies", {
      claimId: claim._id,
      userId: claim.userId,
      messageId: args.messageId,
      from: args.from,
      classification: args.classification,
      summary: args.summary.trim().slice(0, MAX_SUMMARY_CHARS),
      promisedCents,
      senderMismatch,
      receivedAt: Date.now(),
    });

    const isPromise =
      args.classification === "promise" || args.classification === "credit_issued";

    if (isPromise) {
      const evidence = `Merchant reply (${args.classification}): ${args.summary
        .trim()
        .slice(0, MAX_SUMMARY_CHARS)}`;
      if (promisedCents !== undefined) {
        // `promised_credit` never reduces `unresolved` (lib/ledger): it records
        // what was said, and moves the claim to `promised`.
        await applyEvent(
          ctx,
          claim,
          "promised_credit",
          promisedCents,
          evidence,
          `${claim._id}:msg:${args.messageId}`,
        );
      } else if (claim.status !== "confirmed" && claim.status !== "dismissed") {
        await ctx.db.patch(claim._id, { status: "promised" });
      }
      const fresh = await ctx.db.get(claim._id);
      if (fresh && fresh.status !== "confirmed" && fresh.status !== "dismissed") {
        await scheduleClaimReminder(ctx, fresh);
      }
      return {
        deduped: false,
        replyId,
        ledgerWritten: promisedCents !== undefined,
      };
    }

    if (args.classification === "refusal" || args.classification === "question") {
      await ctx.db.patch(claim._id, { attentionAt: Date.now() });
    }
    return { deduped: false, replyId, ledgerWritten: false };
  },
});

/** Every classified reply on a claim the caller owns, oldest first. */
export const listForClaim = query({
  args: { claimId: v.id("claims") },
  returns: v.array(schema.doc("replies")),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    await ownedClaim(ctx, claimId, userId);
    return await ctx.db
      .query("replies")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .take(100);
  },
});
