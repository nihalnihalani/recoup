import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { vOutboundId, vOutboundStatus } from "@agentmail/convex";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { ownedClaim, requireUserId } from "./lib/access";
import { balanceValidator, claimBalance } from "./lib/balance";
import { extract } from "./lib/ai";
import { DraftOut } from "./lib/schemas";
import { agentmail } from "./mail";
import { scheduleClaimReminder } from "./followUps";
import { charge } from "./lib/budget";
import { stripControl } from "./lib/text";
import { MAX_SENDS_PER_CLAIM } from "./limits";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SUBJECT_CHARS = 80;
const MAX_BODY_CHARS = 1_200;
const MAX_ERROR_CHARS = 1_000;
const MAX_NOTE_CHARS = 500;
/** How many policy snapshots per kind we scan for a user-confirmed contact. */
const POLICY_SCAN = 20;

/**
 * D13 reconcile backoff. `approveAndSend` schedules attempt 1 at BACKOFF[0];
 * attempt N (1-based) reschedules itself at BACKOFF[N]. Running out of
 * entries means five checks happened and delivery is still unknown.
 */
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;

/** Component statuses that mean the message will never be delivered (D13). */
const TERMINAL_FAILURES = ["failed", "bounced", "rejected"] as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Draft versions one claim may hold; `insert` refuses past it, so a read of this many is always the whole set. */
const MAX_DRAFTS_PER_CLAIM = 200;
/** B1: example claims carry invented stores and contacts; nothing about them may ever leave as mail. */
const EXAMPLE_ERROR = "Example claims cannot be sent";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function day(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * D58: strips any existing `[RC-...]` token(s) from a subject -- e.g. a
 * stale one left over from editing a copy-pasted subject -- before
 * appending this claim's own token, so `tokenFromSubject` (lib/ledger) can
 * never pick up the wrong claim from a leftover tag earlier in the string.
 */
export function subjectWithToken(subject: string, token: string): string {
  const stripped = subject
    .replace(/\s*\[RC-[A-Z0-9]{6}\]/g, "")
    .trim()
    .slice(0, 200);
  return `${stripped} [RC-${token}]`.trim();
}

/** The domain half of an email address, lowercased. */
export function emailDomain(address: string): string | null {
  // Real From headers look like `Acme Support <help@acme.com>` (review H4).
  const bare = /<([^<>]+)>/.exec(address)?.[1] ?? address;
  const at = bare.lastIndexOf("@");
  if (at < 0) return null;
  const domain = bare.slice(at + 1).trim().toLowerCase().replace(/[^a-z0-9.-]+$/, "");
  return domain.length > 0 ? domain : null;
}

/**
 * The email address D18 allows us to send to without an explicit tick from
 * the user: a contact published by a policy snapshot the user has confirmed.
 * Unconfirmed research is never good enough to auto-address an email.
 */
export async function confirmedContactFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  merchantDomain: string,
): Promise<string | null> {
  for (const kind of ["returns", "price_adjustment"] as const) {
    const rows = await ctx.db
      .query("policies")
      .withIndex("by_user_domain_kind", (q) =>
        q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind),
      )
      .order("desc")
      .take(POLICY_SCAN);
    for (const row of rows) {
      const contact = row.contactEmail?.trim();
      if (row.confirmedByUser && contact && EMAIL_RE.test(contact)) return contact.toLowerCase();
    }
  }
  return null;
}

/**
 * The AgentMail component's ctx types predate convex 1.46's
 * `runMutation(fn, args, options)` overload, so a real `MutationCtx` fails
 * the structural check even though the runtime call is identical. Same
 * accepted deviation as `convex/http.ts` (D12a); narrowed to one helper so
 * there is exactly one cast in this file.
 */
function sendCtx(ctx: MutationCtx): Parameters<typeof agentmail.sendMessage>[0] {
  return ctx as unknown as Parameters<typeof agentmail.sendMessage>[0];
}

function statusCtx(ctx: QueryCtx | MutationCtx): Parameters<typeof agentmail.status>[0] {
  return ctx as unknown as Parameters<typeof agentmail.status>[0];
}

// ---------------------------------------------------------------------------
// Context for the writer
// ---------------------------------------------------------------------------

const draftContext = v.object({
  claim: schema.doc("claims"),
  item: v.union(schema.doc("items"), v.null()),
  purchase: v.union(schema.doc("purchases"), v.null()),
  policy: v.union(schema.doc("policies"), v.null()),
  latestCheck: v.union(schema.doc("priceChecks"), v.null()),
  replies: v.array(schema.doc("replies")),
  balance: balanceValidator,
  userName: v.union(v.string(), v.null()),
  confirmedContact: v.union(v.string(), v.null()),
});

/**
 * Everything the drafting action needs in one transaction. Unauthenticated
 * on purpose: the only caller is `generate`, which resolves the identity
 * from `ctx.auth` and re-checks `claim.userId` against it before using any
 * of this. `replies.classify` reads it too, for the same reason.
 */
export const context = internalQuery({
  args: { claimId: v.id("claims") },
  returns: v.union(draftContext, v.null()),
  handler: async (ctx, { claimId }) => {
    const claim = await ctx.db.get(claimId);
    if (!claim) return null;
    const item = await ctx.db.get(claim.itemId);
    const purchase = await ctx.db.get(claim.purchaseId);
    const user = await ctx.db.get(claim.userId);
    return {
      claim,
      item,
      purchase,
      policy: claim.policyId ? await ctx.db.get(claim.policyId) : null,
      latestCheck: claim.openedFromPriceCheckId
        ? await ctx.db.get(claim.openedFromPriceCheckId)
        : null,
      replies: await ctx.db
        .query("replies")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .take(20),
      balance: await claimBalance(ctx, claim),
      // Password sign-up stores no name; the mailbox name is a truthful sign-off (review H5).
      userName: user?.name ?? user?.email?.split("@")[0] ?? null,
      confirmedContact: purchase
        ? await confirmedContactFor(ctx, claim.userId, purchase.merchantDomain)
        : null,
    };
  },
});

// ---------------------------------------------------------------------------
// Writing drafts
// ---------------------------------------------------------------------------

const SYSTEM = [
  "Write a short, polite customer email to a retailer's support team.",
  "Ask about exactly one item and exactly one amount.",
  "Quote the retailer's own policy passage if one is given.",
  "Do not threaten, do not mention laws or chargebacks, and never state anything the facts below do not state.",
  "Under 150 words. Sign off with the customer name.",
  `Subject under ${MAX_SUBJECT_CHARS} characters and must not contain square brackets.`,
].join(" ");

/**
 * Drafts one message with the model and stores it as a new version (D18).
 * `to` is prefilled only from a policy contact the user has confirmed;
 * otherwise the recipient stays empty and the user must supply and tick it
 * before `approveAndSend` will send anything.
 */
export const generate = action({
  args: { claimId: v.id("claims") },
  returns: v.id("drafts"),
  handler: async (ctx, { claimId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const c = await ctx.runQuery(internal.drafts.context, { claimId });
    if (!c || c.claim.userId !== userId) throw new ConvexError("Claim not found");
    const { claim, item, purchase } = c;
    if (!item || !purchase) throw new ConvexError("Claim not found");
    // B1/B5: refusals first, then the budget, then the model, so a refused call spends nothing.
    // Writing a draft for an example claim is allowed (it is how a new account sees what Recoup writes, and it
    // is budgeted like any other draft); SENDING one is what `approveAndSend` refuses.
    if (claim.status === "confirmed" || claim.status === "dismissed") {
      throw new ConvexError("This claim is closed");
    }
    await ctx.runMutation(internal.budget.consume, { userId, kind: "draft_generate" });

    const currency = purchase.currency;
    const purchasedOn = day(purchase.purchasedAt);
    const observed =
      c.latestCheck?.observedCents !== undefined && c.latestCheck?.observedCents !== null
        ? money(c.latestCheck.observedCents, currency)
        : null;

    const facts = [
      `Merchant: ${purchase.merchant}`,
      `Order reference: ${purchase.orderRef ?? "not available"}`,
      `Purchase date: ${purchasedOn ?? "not available"}`,
      `Item: ${item.name}, quantity ${item.qty}, paid ${money(item.unitCents, currency)} each`,
      claim.type === "price_adjustment"
        ? `The same item is now listed at ${observed ?? "a lower price"}${
            c.latestCheck ? ` (seen ${day(c.latestCheck.observedAt) ?? "recently"})` : ""
          }${item.productUrl ? ` at ${item.productUrl}` : ""}`
        : `The item was returned${
            item.returnedAt ? ` on ${day(item.returnedAt)}` : ""
          }; credit received so far ${money(c.balance.confirmed, currency)}`,
      `Amount being asked for: ${money(Math.max(c.balance.unresolved, 0), currency)}`,
      c.policy && c.policy.passage.length > 0
        ? `Policy passage from ${c.policy.sourceUrl}: "${c.policy.passage}"`
        : "No policy passage is available; do not quote one.",
      c.replies.length > 0
        ? `Earlier replies from the merchant: ${c.replies
            .map((r) => `${r.classification}: ${r.summary}`)
            .join(" | ")}`
        : "The merchant has not replied yet.",
      `Customer name: ${c.userName ?? "the customer"}`,
    ].join("\n");

    const out = await extract("draft", DraftOut, SYSTEM, facts);
    const subject = `${out.subject.replace(/[[\]]/g, "").trim().slice(0, MAX_SUBJECT_CHARS)} [RC-${claim.token}]`;
    const body = out.body.trim().slice(0, MAX_BODY_CHARS);

    const draftId: Id<"drafts"> = await ctx.runMutation(internal.drafts.insert, {
      claimId,
      userId,
      to: c.confirmedContact ?? "",
      subject,
      body,
    });
    return draftId;
  },
});

/**
 * Stores one draft version bound to the claim's current version (D11).
 * Unauthenticated on purpose: called by `generate`, which has already
 * resolved the caller, and by the example loader. `userId` is re-checked
 * against the claim so a wrong pairing writes nothing.
 */
export const insert = internalMutation({
  args: {
    claimId: v.id("claims"),
    userId: v.id("users"),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
  },
  returns: v.id("drafts"),
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    const prev = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", args.claimId))
      .take(MAX_DRAFTS_PER_CLAIM);
    if (prev.length >= MAX_DRAFTS_PER_CLAIM) {
      throw new ConvexError("This claim has too many drafts; edit an existing one instead");
    }
    const draftId = await ctx.db.insert("drafts", {
      claimId: args.claimId,
      userId: args.userId,
      version: prev.length + 1,
      claimVersion: claim.version,
      to: args.to.trim(),
      subject: args.subject.slice(0, 200),
      body: args.body.slice(0, MAX_BODY_CHARS),
    });
    if (claim.status === "detected") await ctx.db.patch(claim._id, { status: "drafted" });
    return draftId;
  },
});

/**
 * The user's own edits to an unsent draft. Refuses once the draft has left
 * the outbox, and refuses when the claim moved on underneath it: an edit
 * would otherwise silently re-bind stale text to a new expected amount.
 * Editing clears any prior approval, so the send guard is re-run.
 */
export const update = mutation({
  args: {
    draftId: v.id("drafts"),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    if (draft.outboundId) throw new ConvexError("This draft was already sent");
    const claim = await ownedClaim(ctx, draft.claimId, userId);
    if (claim.version !== draft.claimVersion) {
      throw new ConvexError("The claim changed since this draft was written. Generate a new draft.");
    }
    await ctx.db.patch(draft._id, {
      to: args.to.trim(),
      subject: args.subject.slice(0, 200),
      body: args.body.slice(0, MAX_BODY_CHARS),
      approvedAt: undefined,
      recipientConfirmed: undefined,
      sendError: undefined,
    });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** Loads a draft, throwing the same "not found" for missing and not-owned. */
async function ownedDraft(
  ctx: QueryCtx | MutationCtx,
  draftId: Id<"drafts">,
  userId: Id<"users">,
): Promise<Doc<"drafts">> {
  const draft = await ctx.db.get(draftId);
  if (!draft || draft.userId !== userId) throw new ConvexError("Draft not found");
  return draft;
}

/**
 * Sends an approved draft (D11, D13, D18).
 *
 * The approval binds to `{to, subject, body, claimVersion, draftVersion}`:
 * the client echoes back the claim and draft versions it displayed, and a
 * mismatch throws rather than sending text the user never saw in the state
 * they saw it. `outboundId` is written in the same transaction as the
 * component enqueue, so a second click finds it set and is refused instead
 * of mailing the merchant twice.
 *
 * The claim goes to `queued`, never `sent` — only `reconcileSend`, once
 * AgentMail has an actual message id, may say a message was sent.
 */
export const approveAndSend = mutation({
  args: {
    draftId: v.id("drafts"),
    to: v.string(),
    subject: v.string(),
    body: v.string(),
    claimVersion: v.number(),
    draftVersion: v.number(),
    recipientConfirmed: v.optional(v.boolean()),
  },
  returns: vOutboundId,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    const claim = await ownedClaim(ctx, draft.claimId, userId);

    // Duplicate click: the enqueue already happened in an earlier transaction.
    if (draft.outboundId) throw new ConvexError("This draft was already sent");

    if (draft.version !== args.draftVersion) {
      throw new ConvexError("This draft changed since you reviewed it. Reload and try again.");
    }

    // D58: the draft being approved must be the newest one on the claim --
    // an older draft can still pass every other check (its own claimVersion
    // matches, it was never sent) yet be stale because a newer draft was
    // generated after it.
    const siblingDrafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .collect();
    const newestVersion = Math.max(...siblingDrafts.map((d) => d.version));
    if (draft.version !== newestVersion) {
      throw new ConvexError("A newer draft exists for this claim. Use that one instead.");
    }
    if (claim.version !== args.claimVersion || claim.version !== draft.claimVersion) {
      throw new ConvexError("The claim changed since this draft was written. Generate a new draft.");
    }

    // One ask in flight per claim, and never on a closed claim (review H6).
    if (claim.status === "queued") throw new ConvexError("A message for this claim is already being sent");
    if (claim.status === "confirmed" || claim.status === "dismissed") {
      throw new ConvexError("This claim is closed");
    }

    // B1: nothing that could break out of a header survives, whatever the transport does with it.
    const to = stripControl(args.to).trim().toLowerCase();
    if (to.length === 0) throw new ConvexError("Enter a recipient email address");
    if (!EMAIL_RE.test(to)) throw new ConvexError("Enter a valid recipient email address");

    const purchase = await ctx.db.get(claim.purchaseId);
    if (!purchase) throw new ConvexError("Purchase not found");
    if (claim.isExample || purchase.isExample) throw new ConvexError(EXAMPLE_ERROR);

    // D18: an unticked recipient is only allowed when it is exactly the
    // contact from a policy snapshot this user confirmed themselves.
    if (args.recipientConfirmed !== true) {
      const contact = await confirmedContactFor(ctx, userId, purchase.merchantDomain);
      if (contact !== to) {
        throw new ConvexError("Confirm this recipient before sending");
      }
    }

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (!profile) throw new ConvexError("Set up your Recoup inbox first");

    // The same cap `update` applies; the client's copy of the text is never trusted to have gone through it.
    const body = args.body.trim().slice(0, MAX_BODY_CHARS);
    if (body.length === 0) throw new ConvexError("The message body is empty");
    const subject = subjectWithToken(stripControl(args.subject), claim.token);

    // B1: `queued` only blocks a second send for the ~30s until reconcile, so sends are counted. A draft whose
    // delivery failed has its `outboundId` and `approvedAt` cleared by `applySendOutcome` and does not count.
    const sentDrafts = (
      await ctx.db
        .query("drafts")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .take(MAX_DRAFTS_PER_CLAIM)
    ).filter((d) => d.outboundId !== undefined || d.approvedAt !== undefined);
    if (sentDrafts.length >= MAX_SENDS_PER_CLAIM) {
      throw new ConvexError(`A claim can be emailed at most ${MAX_SENDS_PER_CLAIM} times. Reply from your own mailbox to follow up.`);
    }
    // Last, so every refusal above costs nothing; throws at 10 sends a day.
    await charge(ctx, userId, "claim_email");

    const outboundId = await agentmail.sendMessage(sendCtx(ctx), profile.inboxId, {
      to,
      subject,
      text: body,
      labels: [`claim:${claim._id}`],
    });

    await ctx.db.patch(draft._id, {
      to,
      subject,
      body,
      approvedAt: Date.now(),
      recipientConfirmed: args.recipientConfirmed === true,
      outboundId,
      sendError: undefined,
    });
    // Status only: the version is the money version, and bumping it here
    // would strand this very draft (and every reminder) behind a stale check.
    await ctx.db.patch(claim._id, {
      status: "queued",
      attentionAt: undefined,
      sendUnknown: undefined,
    });
    await ctx.scheduler.runAfter(BACKOFF_MS[0], internal.drafts.reconcileSend, {
      draftId: draft._id,
      attempt: 1,
    });
    return outboundId;
  },
});

export type SendOutcome = "sent" | "failed" | "retrying" | "unknown" | "gone";

/**
 * Applies one AgentMail delivery observation to the draft and its claim
 * (D13). Exported as a plain function, not registered: `reconcileSend` is
 * the only production caller, and tests drive the transitions directly
 * without needing the component to have talked to the network.
 *
 * - a real `agentmailMessageId` → claim `sent`, thread captured, reminder set
 * - `failed | bounced | rejected` → claim back to `drafted` with `sendError`
 * - still pending, attempts left → reschedule on the backoff
 * - still pending, attempts spent → claim stays `queued`, `sendUnknown: true`
 */
export async function applySendOutcome(
  ctx: MutationCtx,
  draftId: Id<"drafts">,
  attempt: number,
  status: {
    status: string;
    agentmailMessageId: string | null;
    threadId: string | null;
    errorMessage: string | null;
  } | null,
): Promise<SendOutcome> {
  const draft = await ctx.db.get(draftId);
  if (!draft || !draft.outboundId) return "gone";
  const claim = await ctx.db.get(draft.claimId);
  if (!claim) return "gone";

  // Failures first: a bounced message still carries its message id (review H3).
  if (status && (TERMINAL_FAILURES as readonly string[]).includes(status.status)) {
    // Clear the outbound binding so the user can fix the address and retry;
    // `sendError` keeps the reason visible next to the draft.
    await ctx.db.patch(draft._id, {
      sendError: (status.errorMessage ?? `Delivery ${status.status}`).slice(0, MAX_ERROR_CHARS),
      outboundId: undefined,
      approvedAt: undefined,
    });
    if (claim.status === "queued") {
      await ctx.db.patch(claim._id, { status: "drafted", sendUnknown: undefined });
    }
    return "failed";
  }

  if (status && status.agentmailMessageId) {
    await ctx.db.patch(draft._id, {
      agentmailMessageId: status.agentmailMessageId,
      sendError: undefined,
    });
    if (claim.status === "queued") {
      await ctx.db.patch(claim._id, {
        status: "sent",
        threadId: claim.threadId ?? status.threadId ?? undefined,
        sendUnknown: undefined,
      });
      const fresh = await ctx.db.get(claim._id);
      if (fresh) await scheduleClaimReminder(ctx, fresh);
    } else if (!claim.threadId && status.threadId) {
      await ctx.db.patch(claim._id, { threadId: status.threadId });
    }
    return "sent";
  }

  if (attempt < BACKOFF_MS.length) {
    await ctx.scheduler.runAfter(BACKOFF_MS[attempt], internal.drafts.reconcileSend, {
      draftId: draft._id,
      attempt: attempt + 1,
    });
    return "retrying";
  }

  if (claim.status === "queued") await ctx.db.patch(claim._id, { sendUnknown: true });
  return "unknown";
}

/**
 * The scheduled delivery check (D13, D29). Reads the component's view of the
 * outbound message and hands it to `applySendOutcome`.
 */
export const reconcileSend = internalMutation({
  args: { draftId: v.id("drafts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || !draft.outboundId) return null;
    const status = await agentmail.status(statusCtx(ctx), draft.outboundId);
    await applySendOutcome(ctx, args.draftId, args.attempt, status);
    return null;
  },
});

/**
 * D56: lets the owner ask for one more delivery check on demand, e.g. after
 * a draft has sat `sendUnknown` for a while. Reuses `applySendOutcome` with
 * the backoff exhausted so a still-pending result doesn't reschedule another
 * automatic check; it only updates `sendUnknown` (cleared on a definite
 * outcome, otherwise left as-is).
 */
export const recheckSend = mutation({
  args: { draftId: v.id("drafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    if (!draft.outboundId) throw new ConvexError("This draft has not been sent");
    const status = await agentmail.status(statusCtx(ctx), draft.outboundId);
    await applySendOutcome(ctx, draft._id, BACKOFF_MS.length, status);
    return null;
  },
});

/**
 * Live delivery state for one draft the caller owns (D29). Resolves the
 * outbound id from the draft rather than taking it as an argument, so no
 * caller can poll somebody else's outbound message.
 */
export const sendStatus = query({
  args: { draftId: v.id("drafts") },
  returns: v.union(
    v.object({
      status: vOutboundStatus,
      agentmailMessageId: v.union(v.string(), v.null()),
      threadId: v.union(v.string(), v.null()),
      errorMessage: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, { draftId }) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, draftId, userId);
    if (!draft.outboundId) return null;
    return await agentmail.status(statusCtx(ctx), draft.outboundId);
  },
});

/**
 * D52: a claim already past this point -- `confirmed`, `dismissed`,
 * `queued`, `sent`, or already `packet` -- refuses a new packet-sent record,
 * so it can't clobber a real send in flight or reopen a closed claim.
 */
const PACKET_BLOCKED_STATUSES = new Set(["confirmed", "dismissed", "queued", "sent", "packet"]);

/**
 * The user chased the merchant somewhere we cannot send mail — a web form,
 * a chat widget, a phone call (D24, D18). The claim moves to `packet`, the
 * fact is recorded as a note rather than a ledger event (no money has moved),
 * and the same reminder that a real send would have scheduled is set.
 */
export const markPacketSent = mutation({
  args: { claimId: v.id("claims"), note: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    if (PACKET_BLOCKED_STATUSES.has(claim.status)) {
      throw new ConvexError(`This claim is ${claim.status} and cannot be marked packet-sent`);
    }
    const note = args.note.trim().slice(0, MAX_NOTE_CHARS);
    await ctx.db.patch(claim._id, {
      status: "packet",
      attentionAt: undefined,
      sendUnknown: undefined,
    });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "status",
      text: note.length > 0 ? `Sent via merchant channel: ${note}` : "Sent via merchant channel",
    });
    const fresh = await ctx.db.get(claim._id);
    if (fresh) await scheduleClaimReminder(ctx, fresh);
    return null;
  },
});

/** Every draft version on a claim the caller owns, newest first. */
export const listForClaim = query({
  args: { claimId: v.id("claims") },
  returns: v.array(schema.doc("drafts")),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    await ownedClaim(ctx, claimId, userId);
    return await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .order("desc")
      .take(50);
  },
});
