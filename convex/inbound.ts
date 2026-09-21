import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { tokenFromSubject } from "./lib/ledger";

/** How much of a message body we keep for the retry payload (D14). */
const MAX_TEXT_CHARS = 60_000;
const MAX_ERROR_CHARS = 1_000;

/**
 * Reads one string field out of an untrusted webhook payload, trying each
 * alias in turn. AgentMail sends snake_case (D32); the component hands the
 * raw object through untouched, so nothing here may assume a shape.
 */
function str(source: unknown, ...keys: string[]): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const rec = source as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** Same, for the `references` header, which is a list of message ids. */
function strList(source: unknown, ...keys: string[]): string[] {
  if (typeof source !== "object" || source === null) return [];
  const rec = source as Record<string, unknown>;
  for (const key of keys) {
    const value = rec[key];
    if (Array.isArray(value)) return value.filter((x): x is string => typeof x === "string");
    if (typeof value === "string" && value.length > 0) return value.split(/\s+/).filter(Boolean);
  }
  return [];
}

/**
 * Finds the claim an inbound message is replying to, in the order fixed by
 * D23: the `In-Reply-To`/`References` headers against a draft we actually
 * sent, then the AgentMail thread id, then the `[RC-XXXXXX]` subject token.
 * Every hop re-checks ownership, so a message that landed in one user's inbox
 * can never be attached to another user's claim.
 */
async function findReplyClaim(
  ctx: MutationCtx,
  userId: Id<"users">,
  headerIds: string[],
  threadId: string | undefined,
  subject: string,
): Promise<Doc<"claims"> | null> {
  for (const messageId of headerIds) {
    const draft = await ctx.db
      .query("drafts")
      .withIndex("by_message", (q) => q.eq("agentmailMessageId", messageId))
      .first();
    if (!draft || draft.userId !== userId) continue;
    const claim = await ctx.db.get(draft.claimId);
    if (claim && claim.userId === userId) return claim;
  }

  if (threadId) {
    const claim = await ctx.db
      .query("claims")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .first();
    if (claim && claim.userId === userId) return claim;
  }

  const token = tokenFromSubject(subject);
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
 * The AgentMail webhook callback (D14, D33). It is the one function in the
 * app that must never throw: a throw here is retried by the component and,
 * worse, loses the event entirely once retries run out. Every failure is
 * therefore recorded as a `processedEvents` row the user can retry from the
 * board.
 *
 * Responsibilities, in order: dedupe on `eventId`, resolve inbox → profile →
 * user, decide reply-vs-intake, and schedule the lane that owns the work.
 * Nothing expensive happens inline (ARCHITECTURE_PATTERNS §Webhooks).
 */
export const onMessageReceived = internalMutation({
  args: { message: v.any(), thread: v.any(), eventId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let eventId: Id<"processedEvents"> | null = null;
    try {
      const message: unknown = args.message;
      const inboxId = str(message, "inbox_id", "inboxId");
      const messageId = str(message, "message_id", "messageId") ?? args.eventId;
      const threadId = str(message, "thread_id", "threadId");
      const subject = str(message, "subject") ?? "";
      const from = str(message, "from", "from_") ?? "";
      const text = (
        str(message, "extracted_text", "extractedText", "text", "preview") ?? ""
      ).slice(0, MAX_TEXT_CHARS);

      // Dedupe first: a redelivered webhook must not re-run intake (D10).
      const seen = await ctx.db
        .query("processedEvents")
        .withIndex("by_external", (q) => q.eq("externalId", args.eventId))
        .first();
      if (seen) return null;

      eventId = await ctx.db.insert("processedEvents", {
        externalId: args.eventId,
        kind: "agentmail.message.received",
        status: "received",
        attempts: 0,
        payload: { inboxId, messageId, threadId, subject, text, from },
      });

      const profile = inboxId
        ? await ctx.db
            .query("profiles")
            .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
            .unique()
        : null;
      if (!profile) {
        // D33: mail for an inbox we do not own is not an error, it is noise.
        await ctx.db.patch(eventId, {
          status: "succeeded",
          route: "ignored",
          summary: "Message arrived for an inbox this app does not know.",
        });
        return null;
      }

      const headerIds = [
        ...(str(message, "in_reply_to", "inReplyTo") ? [str(message, "in_reply_to", "inReplyTo")!] : []),
        ...strList(message, "references"),
      ];
      const claim = await findReplyClaim(ctx, profile.userId, headerIds, threadId, subject);

      if (claim) {
        // Capture the thread on first contact so later replies route by thread.
        if (!claim.threadId && threadId) await ctx.db.patch(claim._id, { threadId });
        await ctx.db.patch(eventId, {
          userId: profile.userId,
          claimId: claim._id,
          route: "reply",
          // Stays `processing` until the reply is classified and applied (review H2).
          status: "processing",
          processingStartedAt: Date.now(),
          summary: `Reply on claim ${claim.token} is being read.`,
        });
        await ctx.scheduler.runAfter(0, internal.replies.classify, {
          processedEventId: eventId,
          claimId: claim._id,
          messageId,
          from,
          subject,
          text,
        });
        return null;
      }

      await ctx.db.patch(eventId, { userId: profile.userId, route: "intake" });
      await ctx.scheduler.runAfter(0, internal.intake.processEvent, {
        processedEventId: eventId,
      });
      return null;
    } catch (error) {
      // Never throw (D33). If the row exists, mark it failed so the user can
      // retry it; if it does not, there is nothing left to record.
      const lastError = (error instanceof Error ? error.message : String(error)).slice(
        0,
        MAX_ERROR_CHARS,
      );
      if (eventId) {
        await ctx.db.patch(eventId, {
          status: "failed",
          lastError,
          summary: "Inbound message could not be routed.",
        });
      } else {
        console.error(`inbound.onMessageReceived failed for ${args.eventId}: ${lastError}`);
      }
      return null;
    }
  },
});
