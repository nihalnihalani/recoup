import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/access";
import { tokenFromSubject } from "./lib/ledger";
import { classifyReply } from "./replies";
import { extractInbound } from "./intake";

type InboundPayload = {
  inboxId: string;
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
};

/**
 * Reply routing order (D23): a matching outbound draft (via the
 * AgentMail message id in In-Reply-To/References), else the AgentMail
 * thread id, else the claim token embedded in the subject. Every
 * candidate is re-checked against the resolved inbox's owner so one
 * user's mail can never route to another user's claim.
 */
async function resolveReplyClaim(
  ctx: MutationCtx,
  userId: Id<"users">,
  msg: { inReplyTo?: string; references?: string[]; threadId?: string; subject: string },
): Promise<Doc<"claims"> | null> {
  const candidateMessageIds = [msg.inReplyTo, ...(msg.references ?? [])].filter(
    (x): x is string => Boolean(x),
  );
  for (const agentmailMessageId of candidateMessageIds) {
    const draft = await ctx.db
      .query("drafts")
      .withIndex("by_message", (q) => q.eq("agentmailMessageId", agentmailMessageId))
      .first();
    if (draft && draft.userId === userId) {
      const claim = await ctx.db.get(draft.claimId);
      if (claim && claim.userId === userId) return claim;
    }
  }

  if (msg.threadId) {
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_thread", (q) => q.eq("threadId", msg.threadId))
      .first();
    if (claim && claim.userId === userId) return claim;
  }

  const token = tokenFromSubject(msg.subject);
  if (token) {
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (claim && claim.userId === userId) return claim;
  }

  return null;
}

/**
 * AgentMail's inbound-mail webhook callback (D14, D23, D33). Never throws:
 * an exception here would surface as a webhook failure and AgentMail would
 * retry a handler that fails the same way every time. Real work (LLM calls)
 * happens in `process`, scheduled after this returns.
 */
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  handler: async (ctx, { message, eventId }) => {
    try {
      const dup = await ctx.db
        .query("processedEvents")
        .withIndex("by_external", (q) => q.eq("externalId", eventId))
        .first();
      if (dup) return;

      const inboxId: string = message.inbox_id;
      const messageId: string = message.message_id;
      const threadId: string | undefined = message.thread_id ?? undefined;
      const from: string = message.from ?? "";
      const subject: string = message.subject ?? "";
      const text: string = String(message.extracted_text ?? message.text ?? "").slice(0, 60_000);
      const inReplyTo: string | undefined = message.in_reply_to ?? undefined;
      const references: string[] | undefined = message.references ?? undefined;
      const payload: InboundPayload = { inboxId, messageId, threadId, from, subject, text, inReplyTo, references };

      const rowId = await ctx.db.insert("processedEvents", {
        externalId: eventId,
        kind: "agentmail.message.received",
        status: "received",
        attempts: 0,
        payload,
      });

      const profile = await ctx.db
        .query("profiles")
        .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
        .unique();
      if (!profile) {
        await ctx.db.patch(rowId, { status: "succeeded", route: "ignored", summary: "Unknown inbox" });
        return;
      }

      const matched = await resolveReplyClaim(ctx, profile.userId, { inReplyTo, references, threadId, subject });
      const route: "reply" | "intake" = matched ? "reply" : "intake";
      if (matched && !matched.threadId && threadId) {
        await ctx.db.patch(matched._id, { threadId });
      }

      await ctx.db.patch(rowId, {
        userId: profile.userId,
        status: "processing",
        attempts: 1,
        route,
        claimId: matched?._id,
      });
      await ctx.scheduler.runAfter(0, internal.inbound.process, { eventId: rowId });
    } catch (err) {
      console.error("inbound.onMessageReceived failed", { eventId, err });
    }
  },
});

export const getRow = internalQuery({
  args: { eventId: v.id("processedEvents") },
  handler: (ctx, { eventId }) => ctx.db.get(eventId),
});

/**
 * Finalizes a `processedEvents` row. A "succeeded" patch is a no-op once
 * the row already carries a terminal outcome set by the extraction step
 * itself (`needs_review`, D14) so `process` can never clobber it.
 */
export const markProcessed = internalMutation({
  args: {
    eventId: v.id("processedEvents"),
    status: v.union(v.literal("succeeded"), v.literal("failed")),
    summary: v.optional(v.string()),
    lastError: v.optional(v.string()),
  },
  handler: async (ctx, { eventId, status, summary, lastError }) => {
    const row = await ctx.db.get(eventId);
    if (!row) return;
    if (status === "succeeded" && row.status !== "processing") return;
    const patch: Partial<Doc<"processedEvents">> = { status };
    if (summary !== undefined) patch.summary = summary;
    if (lastError !== undefined) patch.lastError = lastError;
    await ctx.db.patch(eventId, patch);
  },
});

/**
 * The single worker for both inbound-mail rows and pasted-text rows.
 * Delegates to the plain helper functions in replies.ts / intake.ts
 * rather than nesting actions inside actions.
 */
export const process = internalAction({
  args: { eventId: v.id("processedEvents") },
  handler: async (ctx, { eventId }): Promise<void> => {
    const row = await ctx.runQuery(internal.inbound.getRow, { eventId });
    if (!row || row.status !== "processing") return;
    const payload = row.payload as InboundPayload;
    try {
      if (row.route === "reply" && row.claimId) {
        await classifyReply(ctx, {
          claimId: row.claimId,
          messageId: payload.messageId,
          from: payload.from,
          subject: payload.subject,
          text: payload.text,
        });
      } else if (row.userId) {
        await extractInbound(ctx, {
          userId: row.userId,
          eventId,
          subject: payload.subject,
          text: payload.text,
          from: payload.from,
        });
      }
      await ctx.runMutation(internal.inbound.markProcessed, { eventId, status: "succeeded" });
    } catch (e) {
      await ctx.runMutation(internal.inbound.markProcessed, {
        eventId,
        status: "failed",
        lastError: String(e).slice(0, 1000),
      });
      throw e;
    }
  },
});

/** Owner-gated manual retry of one failed row (D14). */
export const retryEvent = mutation({
  args: { eventId: v.id("processedEvents") },
  handler: async (ctx, { eventId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(eventId);
    if (!row || row.userId !== userId) throw new ConvexError("Event not found");
    if (row.status !== "failed") throw new ConvexError("Only a failed event can be retried");
    await ctx.db.patch(eventId, { status: "processing", attempts: row.attempts + 1 });
    await ctx.scheduler.runAfter(0, internal.inbound.process, { eventId });
  },
});

/**
 * Cron-able bulk retry, NOT wired into crons.ts (backend lane owns
 * crons.ts; flagged to the lead in the report). Retries rows with
 * attempts < 3 only, so a row that has failed three times waits for a
 * human via `retryEvent` instead of retrying forever.
 */
export const retryFailed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .collect();
    for (const row of rows) {
      if (row.attempts >= 3) continue;
      await ctx.db.patch(row._id, { status: "processing", attempts: row.attempts + 1 });
      await ctx.scheduler.runAfter(0, internal.inbound.process, { eventId: row._id });
    }
  },
});
