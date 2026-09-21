import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { OutboundId } from "@agentmail/convex";
import type { Id } from "./_generated/dataModel";
import { extract } from "./lib/ai";
import { DraftOut } from "./lib/schemas";
import { balance } from "./lib/ledger";
import { ownedClaim, ownedDraft, requireUserId } from "./lib/access";
import { agentmail } from "./mail";
import { scheduleReminder } from "./followUps";
import { latest } from "./policies";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

export const context = internalQuery({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }) => {
    const claim = await ctx.db.get(claimId);
    if (!claim) return null;
    const item = await ctx.db.get(claim.itemId);
    const purchase = await ctx.db.get(claim.purchaseId);
    const policy = claim.policyId ? await ctx.db.get(claim.policyId) : null;
    const events = await ctx.db
      .query("ledgerEvents")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const replies = await ctx.db
      .query("replies")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const notes = await ctx.db
      .query("claimNotes")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const user = await ctx.db.get(claim.userId);
    const latestCheck = claim.openedFromPriceCheckId ? await ctx.db.get(claim.openedFromPriceCheckId) : null;
    return {
      claim,
      item,
      purchase,
      policy,
      balance: balance(claim.expectedCents, events),
      replies,
      notes,
      user,
      latestCheck,
    };
  },
});

/**
 * Recipient prefill (D18): only from a policy snapshot the user has
 * explicitly confirmed. An unconfirmed or missing policy leaves `to`
 * blank so the user must supply or confirm the address themselves.
 */
export const generate = action({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }): Promise<Id<"drafts">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const c = await ctx.runQuery(internal.drafts.context, { claimId });
    if (!c || c.claim.userId !== userId || !c.item || !c.purchase) throw new ConvexError("Claim not found");

    const facts = [
      `Merchant: ${c.purchase.merchant}`,
      `Order reference: ${c.purchase.orderRef ?? "not available"}`,
      c.purchase.purchasedAt
        ? `Purchase date: ${new Date(c.purchase.purchasedAt).toISOString().slice(0, 10)}`
        : "Purchase date: not available",
      `Item: ${c.item.name}, quantity ${c.item.qty}, paid ${money(c.item.unitCents, c.purchase.currency)} each`,
      c.claim.type === "price_adjustment"
        ? `Current price observed on ${c.latestCheck ? new Date(c.latestCheck.observedAt).toISOString().slice(0, 10) : "recently"}: ${c.latestCheck?.observedCents !== undefined ? money(c.latestCheck.observedCents, c.purchase.currency) : "lower"} at ${c.item.productUrl ?? "the product page"}`
        : `Item returned on ${c.item.returnedAt ? new Date(c.item.returnedAt).toISOString().slice(0, 10) : "the return date"}; credit confirmed so far ${money(c.balance.confirmed, c.purchase.currency)}`,
      `Amount requested: ${money(c.balance.unresolved, c.purchase.currency)}`,
      c.policy ? `Policy passage (${c.policy.sourceUrl}): "${c.policy.passage}"` : "No policy passage available",
      c.replies.length
        ? `Previous replies: ${c.replies.map((r) => `${r.classification}: ${r.summary}`).join(" | ")}`
        : "No replies yet",
      `Customer name: ${c.user?.name ?? "the customer"}`,
    ].join("\n");
    const system = `Write a short, polite customer email to a retailer's support team. Ask about exactly one item and one amount. Cite the retailer's own policy passage if given. Do not threaten, do not mention laws, do not claim anything the facts do not state. Under 150 words. Sign with the customer name. Subject under 80 characters and must not include brackets.`;
    const out = await extract("draft", DraftOut, system, facts);
    const subject = `${out.subject.replace(/[[\]]/g, "").trim()} [RC-${c.claim.token}]`;
    const to = c.policy?.confirmedByUser ? (c.policy.contactEmail ?? "") : "";
    return ctx.runMutation(internal.drafts.insert, { claimId, userId, to, subject, body: out.body });
  },
});

export const insert = internalMutation({
  args: { claimId: v.id("claims"), userId: v.id("users"), to: v.string(), subject: v.string(), body: v.string() },
  handler: async (ctx, args): Promise<Id<"drafts">> => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    const prev = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", args.claimId))
      .collect();
    const id = await ctx.db.insert("drafts", { ...args, version: prev.length + 1, claimVersion: claim.version });
    if (claim.status === "detected") await ctx.db.patch(claim._id, { status: "drafted" });
    return id;
  },
});

// A claim in any of these states cannot receive a new outbound message.
const SEND_BLOCKED_STATUSES = new Set(["confirmed", "dismissed", "queued", "sent"]);

// D52: a claim in any of these states cannot be marked packet-sent either --
// `packet` itself included, since a merchant channel outside email is a
// one-shot record, not something to re-send.
const PACKET_BLOCKED_STATUSES = new Set([...SEND_BLOCKED_STATUSES, "packet"]);

/**
 * Approval is bound to `{to, subject, body, claimVersion, draft.version}`
 * (D11): a claim that changed since the draft was written, or a draft
 * that already has an `outboundId`, both refuse. The `outboundId` check
 * runs before the version check so a duplicate click (which itself just
 * bumped the claim's version to `queued`) reliably reports "already sent"
 * rather than "changed" (D13). D58 additionally requires the draft being
 * approved to be the newest one on the claim -- an older draft approved
 * after a newer one was generated is stale even if its own claimVersion
 * still matches.
 */
export const approveAndSend = mutation({
  args: {
    draftId: v.id("drafts"),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    recipientConfirmed: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<OutboundId> => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    const claim = await ownedClaim(ctx, draft.claimId, userId);

    if (draft.outboundId) throw new ConvexError("This draft was already sent");

    const siblingDrafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .collect();
    const newestVersion = Math.max(...siblingDrafts.map((d) => d.version));
    if (draft.version !== newestVersion) {
      throw new ConvexError("A newer draft exists for this claim. Use that one instead.");
    }

    if (claim.version !== draft.claimVersion) {
      throw new ConvexError("The claim changed since this draft was written. Generate a new draft.");
    }
    if (SEND_BLOCKED_STATUSES.has(claim.status)) {
      throw new ConvexError(`This claim is ${claim.status} and cannot be sent`);
    }

    const to = args.to.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new ConvexError("Enter a valid recipient email");

    const purchase = await ctx.db.get(claim.purchaseId);
    if (!purchase) throw new ConvexError("Purchase not found");
    const policyKind = claim.type === "price_adjustment" ? ("price_adjustment" as const) : ("returns" as const);
    const confirmedPolicy = await latest(ctx, userId, purchase.merchantDomain, policyKind);
    const recipientOk =
      args.recipientConfirmed === true ||
      (confirmedPolicy?.confirmedByUser === true && confirmedPolicy.contactEmail === to);
    if (!recipientOk) throw new ConvexError("Confirm the recipient");

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!profile) throw new ConvexError("Set up your Recoup inbox first");

    // D58: strip any existing `[RC-...]` token(s) -- e.g. a stale one left
    // over from editing a copy-pasted subject -- before appending this
    // claim's own token, so `tokenFromSubject` can never pick up the wrong
    // claim from a leftover tag earlier in the string.
    const strippedSubject = args.subject.replace(/\s*\[RC-[A-Z0-9]{6}\]/g, "").trim();
    const subject = `${strippedSubject} [RC-${claim.token}]`;
    const outboundId = await agentmail.sendMessage(ctx, profile.inboxId, {
      to,
      subject,
      text: args.body,
      labels: [`claim:${claim._id}`],
    });

    await ctx.db.patch(draft._id, {
      to,
      subject,
      body: args.body,
      approvedAt: Date.now(),
      outboundId,
      recipientConfirmed: args.recipientConfirmed,
    });
    // D56: a fresh approval always starts clean, even if a previous send on
    // this claim left `sendUnknown` set from a stalled reconcile.
    await ctx.db.patch(claim._id, { status: "queued", version: claim.version + 1, sendUnknown: undefined });
    await ctx.db.insert("claimNotes", { claimId: claim._id, userId, kind: "status", text: "Message queued to send" });
    await ctx.scheduler.runAfter(30_000, internal.drafts.reconcileSend, { draftId: draft._id, attempt: 1 });
    return outboundId;
  },
});

type StatusResult = Awaited<ReturnType<typeof agentmail.status>>;
type StatusFn = (ctx: MutationCtx, outboundId: OutboundId) => Promise<StatusResult>;

const RECONCILE_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const FAILURE_STATUSES = new Set(["failed", "bounced", "rejected"]);

/**
 * Reconciles a queued send against the AgentMail component's outbound
 * status (D13). Backoff schedule 30s/60s/120s/300s/600s; after 5 attempts
 * with no terminal status, the claim is flagged `sendUnknown` and stays
 * `queued`.
 *
 * D49: a status transition only ever moves the claim FROM `queued`. If the
 * user has meanwhile confirmed or dismissed the claim (or anything else
 * changed it away from `queued`) before the message id arrives, we still
 * record `agentmailMessageId` on the draft and `threadId` on the claim,
 * but leave the claim's status and version untouched.
 *
 * `statusFn` is injectable so tests can simulate AgentMail's outbound
 * status without a real send/component round trip.
 */
export async function reconcileSendImpl(
  ctx: MutationCtx,
  args: { draftId: Id<"drafts">; attempt: number },
  statusFn: StatusFn = (c, outboundId) => agentmail.status(c, outboundId),
): Promise<void> {
  const draft = await ctx.db.get(args.draftId);
  if (!draft || !draft.outboundId) return;
  const claim = await ctx.db.get(draft.claimId);
  if (!claim) return;

  const result = await statusFn(ctx, draft.outboundId);

  if (result?.agentmailMessageId) {
    await ctx.db.patch(draft._id, { agentmailMessageId: result.agentmailMessageId });
    if (claim.status !== "queued") {
      if (result.threadId && !claim.threadId) await ctx.db.patch(claim._id, { threadId: result.threadId });
      return;
    }
    await ctx.db.patch(claim._id, {
      status: "sent",
      threadId: result.threadId ?? claim.threadId,
      version: claim.version + 1,
      sendUnknown: undefined,
    });
    const fresh = (await ctx.db.get(claim._id))!;
    const purchase = await ctx.db.get(fresh.purchaseId);
    const returnsPolicy = purchase ? await latest(ctx, fresh.userId, purchase.merchantDomain, "returns") : null;
    const delayDays = Math.max(7, returnsPolicy?.windowDays ?? 0);
    await scheduleReminder(ctx, fresh, Date.now() + delayDays * 86_400_000);
    return;
  }

  if (result && FAILURE_STATUSES.has(result.status)) {
    await ctx.db.patch(draft._id, { sendError: result.errorMessage ?? result.status });
    if (claim.status !== "queued") return;
    // D56: the failure path clears `sendUnknown` too -- a claim that was
    // flagged unknown after 5 attempts and is now rechecked (`recheckSend`)
    // into a definite failure should not keep showing "delivery unknown".
    await ctx.db.patch(claim._id, { status: "drafted", version: claim.version + 1, sendUnknown: undefined });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId: claim.userId,
      kind: "status",
      text: `Send failed: ${result.errorMessage ?? result.status}`,
    });
    return;
  }

  if (args.attempt < 5) {
    await ctx.scheduler.runAfter(RECONCILE_DELAYS_MS[args.attempt], internal.drafts.reconcileSend, {
      draftId: draft._id,
      attempt: args.attempt + 1,
    });
  } else if (claim.status === "queued") {
    await ctx.db.patch(claim._id, { sendUnknown: true });
  }
}

export const reconcileSend = internalMutation({
  args: { draftId: v.id("drafts"), attempt: v.number() },
  handler: (ctx, args) => reconcileSendImpl(ctx, args),
});

/**
 * D56: an owner-gated, on-demand recheck for a claim stuck `queued` with
 * `sendUnknown` (or simply impatient to see the current status sooner than
 * the backoff schedule). Runs exactly one reconcile pass; passing the final
 * attempt number means a still-pending result leaves `sendUnknown` set
 * rather than re-arming a new scheduled retry.
 */
export const recheckSend = mutation({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, draftId, userId);
    if (!draft.outboundId) throw new ConvexError("This draft has not been sent");
    await reconcileSendImpl(ctx, { draftId: draft._id, attempt: RECONCILE_DELAYS_MS.length });
  },
});

/** D29: resolves the owned draft, then asks the component for its outbound status. */
export const sendStatus = query({
  args: { draftId: v.id("drafts") },
  handler: async (ctx, { draftId }) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, draftId, userId);
    if (!draft.outboundId) return null;
    return agentmail.status(ctx, draft.outboundId);
  },
});

/**
 * For merchant channels outside email (chat, form, phone): no ledger event,
 * just a note + reminder. D52: refuses a claim already past this point --
 * `confirmed`, `dismissed`, `queued`, `sent`, or already `packet` -- so a
 * packet-sent record can't clobber a real send in flight or reopen a
 * settled/terminal claim.
 */
export const markPacketSent = mutation({
  args: { claimId: v.id("claims"), note: v.string() },
  handler: async (ctx, { claimId, note }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    if (PACKET_BLOCKED_STATUSES.has(claim.status)) {
      throw new ConvexError(`This claim is ${claim.status} and cannot be marked packet-sent`);
    }
    await ctx.db.insert("claimNotes", { claimId: claim._id, userId, kind: "status", text: note });
    await ctx.db.patch(claim._id, { status: "packet", version: claim.version + 1 });
    const fresh = (await ctx.db.get(claim._id))!;
    const purchase = await ctx.db.get(fresh.purchaseId);
    const returnsPolicy = purchase ? await latest(ctx, userId, purchase.merchantDomain, "returns") : null;
    const delayDays = Math.max(7, returnsPolicy?.windowDays ?? 0);
    await scheduleReminder(ctx, fresh, Date.now() + delayDays * 86_400_000);
  },
});
