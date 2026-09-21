/**
 * The AgentMail component's `onEvent` webhook callback (T06, D69, D85).
 *
 * Unlike `inbound.onMessageReceived`, an event never carries the outboundId
 * Recoup minted -- only AgentMail's own message id, nested under whichever
 * sub-object the event type uses (`message`, `send`, `delivery`, `bounce`,
 * `complaint`, `reject`). `messageIdOf` below mirrors the component's own
 * `eventLogic.extractIndexFields` fallback order (that helper lives under
 * the component's internal `dist/component/` tree, which ships no plain
 * `.ts` source and is not re-exported by the client package, so the fallback
 * is reimplemented here rather than imported). Every mailLog/drafts row that
 * has ever reached a terminal state (`sent`/`failed`) stores that id
 * (`agentmailMessageId`), so this is the join key back to our own rows
 * (`by_message` on both tables) -- see the contract's note that the polling
 * path (`notify.applyDropOutcome`, `drafts.applySendOutcome`) is the FIRST
 * place most bounces are seen, since the component marks its own row
 * terminal before an event can be mapped here; this handler exists for a
 * LATE bounce/complaint that arrives after a row is already `sent`.
 *
 * `message.received` and `domain.verified` carry no such id and are not
 * this function's job (the former is `inbound.onMessageReceived`'s).
 *
 * At-least-once: the component's callbackPool may redeliver this mutation
 * for the same event (T06(d)), so every transition below is guarded by the
 * row's CURRENT status -- applying the same event twice is a no-op the
 * second time. Never throws, mirroring `inbound.onMessageReceived`'s
 * contract: a webhook redelivery must never be lost to an unhandled
 * exception here.
 */
import { v } from "convex/values";
import { vEvent, type AgentMailEvent } from "@agentmail/convex";
import { internalMutation } from "./_generated/server";
import { suppressAddress } from "./alerts";

const MAX_ERROR_CHARS = 1000;

/** Same fallback order as the component's own `eventLogic.extractIndexFields`. */
function messageIdOf(event: AgentMailEvent): string | undefined {
  const payload = (event.message ?? event.send ?? event.delivery ?? event.bounce ?? event.complaint ?? event.reject) as
    | Record<string, unknown>
    | undefined;
  const id = payload?.message_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export const onEvent = internalMutation({
  args: { event: vEvent },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    try {
      // Nothing to map: no id to join on, and neither event type touches a mailLog/drafts row.
      if (event.event_type === "message.received" || event.event_type === "domain.verified") return null;

      const isBounceLike = event.event_type === "message.bounced" || event.event_type === "message.rejected";
      const isComplaint = event.event_type === "message.complained";
      // "sent"/"delivered" events carry nothing this handler needs to record
      // (the polling path already owns those transitions on `queued` rows).
      if (!isBounceLike && !isComplaint) return null;

      const messageId = messageIdOf(event);
      if (!messageId) return null; // unknown id: no-op (contract T06(f)(1)).

      const providerStatus = event.event_type.replace(/^message\./, "");
      const now = Date.now();

      // --- Price-drop alerts (mailLog) ---------------------------------
      const mailRow = await ctx.db
        .query("mailLog")
        .withIndex("by_message", (q) => q.eq("agentmailMessageId", messageId))
        .first();
      // Only a row already `sent` is a LATE event; anything else (still
      // `queued`, or already `failed`/`suppressed` from an earlier delivery
      // of this same event) is left alone -- idempotent by construction.
      if (mailRow && mailRow.status === "sent") {
        if (isBounceLike) {
          await ctx.db.patch(mailRow._id, {
            status: "failed",
            reason: "send_failed",
            providerStatus,
            error: `The email ${providerStatus} after delivery`.slice(0, MAX_ERROR_CHARS),
            lastCheckedAt: now,
          });
          await suppressAddress(ctx, mailRow.userId, "bounced");
        } else {
          // Complaint after a completed send stays `sent` (it was delivered), but flags the address.
          await ctx.db.patch(mailRow._id, { providerStatus: "complained", lastCheckedAt: now });
          await suppressAddress(ctx, mailRow.userId, "complained");
        }
      }

      // --- Merchant mail (drafts) --------------------------------------
      const draftRow = await ctx.db
        .query("drafts")
        .withIndex("by_message", (q) => q.eq("agentmailMessageId", messageId))
        .first();
      if (draftRow) {
        const claim = await ctx.db.get(draftRow.claimId);
        // A late bounce/complaint on a claim already moved on (drafted again,
        // confirmed, dismissed) would be recording stale news; only a claim
        // still resting on this exact send is touched. `!draftRow.sendError`
        // makes this idempotent the same way the mailLog branch's status
        // guard does: unlike a mailLog row (which flips out of `sent` on the
        // first application), this handler never changes `claim.status`, so
        // without this guard a redelivered event would append a duplicate
        // claimNote every time. One flag per draft is enough for a human to
        // notice; a second distinct event on an already-flagged draft is not
        // separately recorded.
        if (claim && claim.status === "sent" && !draftRow.sendError) {
          const note = isBounceLike
            ? `Merchant email ${providerStatus} after it was marked sent.`
            : "The merchant's mail provider marked this email as spam after it was marked sent.";
          // Scoped narrowly per this task's instruction: record the fact on
          // the draft and as a claim note. No auto-resend, and the claim's
          // own status/follow-ups are left as they are -- a human decides
          // whether to reopen and re-draft (see report: "known gaps" for the
          // alternative, wider behaviour PLAN.md's superseded text described).
          await ctx.db.patch(draftRow._id, { sendError: note.slice(0, MAX_ERROR_CHARS) });
          await ctx.db.insert("claimNotes", { claimId: claim._id, userId: claim.userId, kind: "status", text: note });
        }
      }
    } catch (err) {
      console.error(`mailEvents.onEvent failed for ${event.event_id}`, err);
    }
    return null;
  },
});
