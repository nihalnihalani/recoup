import { ConvexError, v } from "convex/values";
import { vOutboundId, vOutboundStatus, type OutboundId } from "@agentmail/convex";
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
import { isClosedForAsk } from "./lib/claimState";
import { balanceValidator, claimBalance } from "./lib/balance";
import { extract } from "./lib/ai";
import { DraftOut } from "./lib/schemas";
import { agentmail } from "./mail";
import { scheduleClaimReminder } from "./followUps";
import { charge } from "./lib/budget";
import { stripControl } from "./lib/text";
import { isTombstoned } from "./lib/accountState";
import { parseSingleEmail } from "./lib/email";
import { sanitizeError } from "./lib/errors";
import { redact } from "./lib/log";
import { clearPendingMailEvent, getPendingMailEvent } from "./mailEvents";
import { MAIL_RECONCILE_STALL_MS, MAX_SENDS_PER_CLAIM } from "./limits";

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
 * Exported so `notify.reconcileDrop` (F3) can reconcile a queued drop email
 * on the same backoff, rather than inventing a second schedule.
 */
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000] as const;

/**
 * Component statuses that can mean the message will never be delivered (D13). Exported for `notify.ts` (F3), same
 * reason as `BACKOFF_MS`. `bounced` and `rejected` are always terminal; `failed` is terminal ONLY when the provider
 * answered with a 4xx (`isPermanentSendFailure`) — S-M03-1: every other component failure (a lost response, a
 * timeout, a 5xx, a 2xx without a body) may have been accepted by the provider, so it is `unknown`, never `failed`.
 * Use `isTerminalSendFailure` rather than testing membership here.
 */
export const TERMINAL_FAILURES = ["failed", "bounced", "rejected"] as const;

/**
 * S-M03-1: a component `failed` is a definite "not sent" only when the provider itself answered with an HTTP 4xx
 * (the component records `AgentMail API error <status>` for both its permanent-error path and a thrown transient
 * error). A 4xx is a refusal of the request, so nothing was accepted. Everything else is ambiguous.
 */
export function isPermanentSendFailure(errorMessage: string | null | undefined): boolean {
  return /^AgentMail API error 4\d\d\b/.test(errorMessage ?? "");
}

/** True when this component observation means the message was definitely not delivered (bounce, rejection, 4xx). */
export function isTerminalSendFailure(status: { status: string; errorMessage: string | null }): boolean {
  if (status.status === "bounced" || status.status === "rejected") return true;
  return status.status === "failed" && isPermanentSendFailure(status.errorMessage);
}

/** A component `failed` that is NOT a provider refusal: the send's outcome is unknown, and the component row is final. */
export function isAmbiguousSendFailure(status: { status: string; errorMessage: string | null }): boolean {
  return status.status === "failed" && !isPermanentSendFailure(status.errorMessage);
}

/**
 * S-M03-4: the only failure text an owner ever sees. The component stores `AgentMail API error <n>: <body>` for a
 * permanent failure, and a provider body may echo request data (headers, keys). Never pass it through: a provider
 * 4xx becomes a fixed sentence naming only the status code; any other component failure text becomes a
 * `sanitizeError` category. A bounce/rejection reason is shown redacted (keys, bearer tokens and mailbox local parts
 * removed by `lib/log.redact`).
 */
export function ownerSafeSendError(status: string, errorMessage: string | null): string {
  const code = /^AgentMail API error (\d{3})\b/.exec(errorMessage ?? "")?.[1];
  if (code !== undefined) {
    return code.startsWith("4")
      ? `The mail provider refused this message (${code}). Check the recipient address, then approve it again.`
      : `The mail provider had an error (${code}).`;
  }
  if (status === "failed") return errorMessage ? sanitizeError(errorMessage) : "Delivery failed";
  return (errorMessage ? redact(errorMessage) : `Delivery ${status}`).slice(0, MAX_ERROR_CHARS);
}

/** D116: `drafts.update`'s `to` bound -- generous past any real address, but a fixed cap on an otherwise-unbounded string field. */
const MAX_TO_CHARS = 320;
/** Only ever run on a string already capped at `MAX_TO_CHARS` (S-M03-5: its backtracking is quadratic in length). */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * S-M03-5: one recipient, length-capped BEFORE any regex runs (`parseSingleEmail` checks the length first), control
 * characters stripped first so nothing can break out of a header. Lowercased, as the send path always has been.
 */
function parseRecipient(raw: string): string {
  const cleaned = stripControl(raw).trim();
  if (cleaned.length === 0) throw new ConvexError("Enter a recipient email address");
  try {
    return parseSingleEmail(cleaned, MAX_TO_CHARS).toLowerCase();
  } catch {
    throw new ConvexError("Enter a valid recipient email address");
  }
}
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
      if (row.confirmedByUser && contact && contact.length <= MAX_TO_CHARS && EMAIL_RE.test(contact)) return contact.toLowerCase();
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
 * Tombstone-aware resolution of the caller for `generate`, which has no
 * `ctx.db` of its own (D115 6b-3). `ctx.runQuery` from an action propagates
 * the same request's `ctx.auth`, so this resolves the same user the bare
 * `getAuthUserId` this action used to call would, but also refuses a
 * deleting/deleted account before the model is ever asked to write anything.
 */
export const requireActiveUserId = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => requireUserId(ctx),
});

/**
 * Drafts one message with the model and stores it as a new version (D18).
 * `to` is prefilled only from a policy contact the user has confirmed;
 * otherwise the recipient stays empty and the user must supply and tick it
 * before `approveAndSend` will send anything.
 */
export const generate = action({
  args: { claimId: v.id("claims") },
  returns: v.id("drafts"),
  handler: async (ctx, { claimId }): Promise<Id<"drafts">> => {
    const userId = await ctx.runQuery(internal.drafts.requireActiveUserId, {});
    const c = await ctx.runQuery(internal.drafts.context, { claimId });
    if (!c || c.claim.userId !== userId) throw new ConvexError("Claim not found");
    const { claim, item, purchase } = c;
    if (!item || !purchase) throw new ConvexError("Claim not found");
    // B1/B5: refusals first, then the budget, then the model, so a refused call spends nothing.
    // Writing a draft for an example claim is allowed (it is how a new account sees what Recoup writes, and it
    // is budgeted like any other draft); SENDING one is what `approveAndSend` refuses.
    if (isClosedForAsk(claim)) {
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

    const draftId: Id<"drafts"> | null = await ctx.runMutation(internal.drafts.insert, {
      claimId,
      userId,
      to: c.confirmedContact ?? "",
      subject,
      body,
    });
    // T18.5 (D124 B5): the account was deleted while `extract` above was in
    // flight -- `insert` refused rather than writing a draft the finished
    // purge would never see again. Nothing useful can be returned to a
    // caller whose account no longer exists; `generate`'s declared return
    // stays a plain `Id<"drafts">` (never widened to nullable) so every
    // OTHER caller keeps its existing non-null contract.
    if (draftId === null) throw new ConvexError("This account is being deleted.");
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
  returns: v.union(v.id("drafts"), v.null()),
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    // T18.5 (D124 B5): `generate`'s own model call (`extract`) can take real
    // time; a `requestDeletion` landing while it is in flight (after
    // `requireActiveUserId` already passed) must not let the LATE draft
    // still land after the purge finished. Same write-time gate as
    // `priceWatch.recordCheck`/`policies.fetchBoth`.
    if (await isTombstoned(ctx, args.userId)) return null;
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
    // D116 (checkpoint-6b inventory bound gap): `to` must parse as exactly
    // one address within a fixed length, the same shape `approveAndSend`
    // already re-checks before it will send -- `update` is the one place
    // that used to let an unbounded, unvalidated string reach the stored
    // draft at all.
    const to = parseSingleEmail(args.to, MAX_TO_CHARS);
    await ctx.db.patch(draft._id, {
      to,
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

/** What the user saw and approved: the text, the recipient tick, and the claim/draft versions it was shown at (D11). */
const sendApprovalArgs = {
  draftId: v.id("drafts"),
  to: v.string(),
  subject: v.string(),
  body: v.string(),
  claimVersion: v.number(),
  draftVersion: v.number(),
  recipientConfirmed: v.optional(v.boolean()),
};
type SendApproval = {
  to: string;
  subject: string;
  body: string;
  claimVersion: number;
  draftVersion: number;
  recipientConfirmed?: boolean;
};

type CheckedSend = { to: string; subject: string; body: string; inboxId: string };

/**
 * Every check a claim email runs before its side effect, in this order (D11, D13, D18, D58, B1, review H6,
 * S-M03-5), shared by `approveAndSend` and `resendAfterUnknown` so a resend can never skip one (DA-A-31):
 * draft version → newest draft → claim version → one ask in flight → closed → recipient (capped before any regex)
 * → example → D18 recipient tick → inbox → body → per-claim send cap → `claim_email` charge, LAST, so every refusal
 * costs nothing. `mode: "first"` refuses a draft that already has an attempt; a resend is gated by its caller.
 */
async function checkSend(
  ctx: MutationCtx,
  userId: Id<"users">,
  draft: Doc<"drafts">,
  claim: Doc<"claims">,
  args: SendApproval,
  mode: "first" | "resend",
): Promise<CheckedSend> {
  // Duplicate click: the enqueue already happened in an earlier transaction.
  if (mode === "first" && draft.outboundId) throw new ConvexError("This draft was already sent");

  if (draft.version !== args.draftVersion) {
    throw new ConvexError("This draft changed since you reviewed it. Reload and try again.");
  }
  // D58: the draft being approved must be the newest one on the claim -- an older draft can still pass every other
  // check (its own claimVersion matches, it was never sent) yet be stale because a newer draft was generated after it.
  const siblingDrafts = await ctx.db
    .query("drafts")
    .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
    .take(MAX_DRAFTS_PER_CLAIM);
  const newestVersion = Math.max(...siblingDrafts.map((d) => d.version));
  if (draft.version !== newestVersion) {
    throw new ConvexError("A newer draft exists for this claim. Use that one instead.");
  }
  if (claim.version !== args.claimVersion || claim.version !== draft.claimVersion) {
    throw new ConvexError("The claim changed since this draft was written. Generate a new draft.");
  }

  // One ask in flight per claim, and never on a closed claim (review H6). A resend is by definition on a `queued`
  // claim whose outcome is unknown; its caller has already checked exactly that.
  if (mode === "first" && claim.status === "queued") throw new ConvexError("A message for this claim is already being sent");
  if (isClosedForAsk(claim)) throw new ConvexError("This claim is closed");

  // B1 + S-M03-5: nothing that could break out of a header survives, and the length is capped before any regex.
  const to = parseRecipient(args.to);

  const purchase = await ctx.db.get(claim.purchaseId);
  if (!purchase) throw new ConvexError("Purchase not found");
  if (claim.isExample || purchase.isExample) throw new ConvexError(EXAMPLE_ERROR);

  // D18: an unticked recipient is only allowed when it is exactly the contact from a policy snapshot this user
  // confirmed themselves.
  if (args.recipientConfirmed !== true) {
    const contact = await confirmedContactFor(ctx, userId, purchase.merchantDomain);
    if (contact !== to) throw new ConvexError("Confirm this recipient before sending");
  }

  const profile = await ctx.db
    .query("profiles")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  // T18.5 addendum (F-AUD-2): a `profiles` row can exist as a provisioning-in-flight placeholder (no `inboxId` yet).
  if (!profile?.inboxId) throw new ConvexError("Set up your Recoup inbox first");

  // The same cap `update` applies; the client's copy of the text is never trusted to have gone through it.
  const body = args.body.trim().slice(0, MAX_BODY_CHARS);
  if (body.length === 0) throw new ConvexError("The message body is empty");
  const subject = subjectWithToken(stripControl(args.subject), claim.token);

  // B1: `queued` only blocks a second send for the ~30s until reconcile, so sends are counted. A draft whose delivery
  // definitely failed has its `outboundId` and `approvedAt` cleared by `applySendOutcome` and does not count; an
  // attempt whose outcome is unknown keeps them, so a resend after it uses one more send (S-M03-1).
  const sentDrafts = siblingDrafts.filter((d) => d.outboundId !== undefined || d.approvedAt !== undefined);
  if (sentDrafts.length >= MAX_SENDS_PER_CLAIM) {
    throw new ConvexError(`A claim can be emailed at most ${MAX_SENDS_PER_CLAIM} times. Reply from your own mailbox to follow up.`);
  }
  // Last, so every refusal above costs nothing; throws at 10 sends a day.
  await charge(ctx, userId, "claim_email");
  return { to, subject, body, inboxId: profile.inboxId };
}

/** Enqueues one claim email (at most one provider POST: `mail.ts` `retryAttempts: 1`) and schedules its reconcile. */
async function enqueueClaimEmail(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  draftId: Id<"drafts">,
  send: CheckedSend,
  recipientConfirmed: boolean,
): Promise<OutboundId> {
  const outboundId = await agentmail.sendMessage(sendCtx(ctx), send.inboxId, {
    to: send.to,
    subject: send.subject,
    text: send.body,
    labels: [`claim:${claim._id}`],
  });
  await ctx.db.patch(draftId, {
    to: send.to,
    subject: send.subject,
    body: send.body,
    approvedAt: Date.now(),
    recipientConfirmed,
    outboundId,
    sendError: undefined,
  });
  // Status only: the version is the money version, and bumping it here would strand this very draft (and every
  // reminder) behind a stale check.
  await ctx.db.patch(claim._id, { status: "queued", attentionAt: undefined, sendUnknown: undefined });
  await ctx.scheduler.runAfter(BACKOFF_MS[0], internal.drafts.reconcileSend, { draftId, attempt: 1 });
  return outboundId;
}

/**
 * Sends an approved draft (D11, D13, D18).
 *
 * The approval binds to `{to, subject, body, claimVersion, draftVersion}`: the client echoes back the claim and
 * draft versions it displayed, and a mismatch throws rather than sending text the user never saw in the state they
 * saw it. `outboundId` is written in the same transaction as the component enqueue, so a second click finds it set
 * and is refused instead of mailing the merchant twice.
 *
 * The claim goes to `queued`, never `sent` — only `reconcileSend`, once AgentMail has an actual message id, may say
 * a message was sent. If the outcome turns out to be unknown (S-M03-1), the only way to send again is
 * `resendAfterUnknown`.
 */
export const approveAndSend = mutation({
  args: sendApprovalArgs,
  returns: vOutboundId,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    const claim = await ownedClaim(ctx, draft.claimId, userId);
    const send = await checkSend(ctx, userId, draft, claim, args, "first");
    return await enqueueClaimEmail(ctx, claim, draft._id, send, args.recipientConfirmed === true);
  },
});

const resendResult = v.union(
  v.object({ ok: v.literal(true), outboundId: vOutboundId, draftId: v.id("drafts") }),
  v.object({ ok: v.literal(false), code: v.literal("outcome_known"), message: v.string() }),
);

/**
 * Sends a claim email again after its earlier attempt ended with an UNKNOWN outcome (S-M03-1, DA-A-31, SEC-CH-5).
 *
 * Nothing ever resends on its own: the provider may already have delivered the earlier attempt, so the user must
 * acknowledge it by echoing its `acknowledgedOutboundId` (the UI shows that attempt and its time). Then:
 *   1. the claim must still be `queued` with `sendUnknown`, and the acknowledged attempt must be this draft's;
 *   2. the earlier attempt's outcome is re-read immediately before the side effect. If it resolved in the meantime
 *      (delayed success, a bounce, a provider refusal) that outcome is recorded and `{ ok: false, code:
 *      "outcome_known" }` is RETURNED — never thrown, so the recorded outcome persists — and nothing is sent;
 *   3. every `approveAndSend` check runs again (`checkSend`), including the claim version: a material change since
 *      the first attempt refuses the resend (DA-A-31);
 *   4. the resend is a NEW draft version carrying the re-approved text, so the earlier attempt stays on record with
 *      its own outbound id, both count toward `MAX_SENDS_PER_CLAIM`, and `claim_email` is charged once more. A claim
 *      note names the earlier attempt.
 */
export const resendAfterUnknown = mutation({
  args: { ...sendApprovalArgs, acknowledgedOutboundId: v.string() },
  returns: resendResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    const claim = await ownedClaim(ctx, draft.claimId, userId);
    if (!draft.outboundId || args.acknowledgedOutboundId !== draft.outboundId) {
      throw new ConvexError("Review the earlier attempt before sending again");
    }
    if (claim.status !== "queued" || claim.sendUnknown !== true) {
      throw new ConvexError("This message's delivery is not unknown, so it cannot be sent again from here");
    }

    // 2. Re-read the earlier attempt right before the side effect.
    const earlier = await agentmail.status(statusCtx(ctx), draft.outboundId);
    if (earlier !== null && (earlier.agentmailMessageId !== null || isTerminalSendFailure(earlier))) {
      await applySendOutcome(ctx, draft._id, BACKOFF_MS.length, earlier, false);
      return {
        ok: false as const,
        code: "outcome_known" as const,
        message: earlier.agentmailMessageId !== null && !isTerminalSendFailure(earlier)
          ? "The earlier attempt was sent after all, so nothing was sent again."
          : "The earlier attempt failed. Review the draft and approve it again.",
      };
    }

    // 3. The full approval checks, against the draft the user is looking at.
    const send = await checkSend(ctx, userId, draft, claim, args, "resend");

    // 4. A new draft version for the new attempt; the earlier one keeps its outbound id.
    const resendDraftId = await ctx.db.insert("drafts", {
      claimId: claim._id,
      userId,
      version: draft.version + 1,
      claimVersion: claim.version,
      to: send.to,
      subject: send.subject,
      body: send.body,
    });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "status",
      text: `Sent again after an unknown delivery outcome. The earlier attempt (${new Date(draft.approvedAt ?? draft._creationTime).toISOString().slice(0, 16).replace("T", " ")} UTC) may also have reached the merchant.`,
    });
    const outboundId = await enqueueClaimEmail(ctx, claim, resendDraftId, send, args.recipientConfirmed === true);
    return { ok: true as const, outboundId, draftId: resendDraftId };
  },
});

export type SendOutcome = "sent" | "failed" | "retrying" | "unknown" | "gone";

/**
 * Applies one AgentMail delivery observation to the draft and its claim (D13). Exported as a plain function, not
 * registered: `reconcileSend`, `recheckSend` and `resendAfterUnknown` are the only production callers, and tests
 * drive the transitions directly without needing the component to have talked to the network.
 *
 * - a real `agentmailMessageId` → claim `sent`, thread captured, reminder set (unless N6's stash below says this id
 *   already bounced/complained)
 * - `bounced | rejected`, or `failed` from a provider 4xx → claim back to `drafted` with an owner-safe `sendError`
 *   (S-M03-4), binding cleared so the user can fix the address and approve again
 * - `failed` for any other reason (lost response, timeout, 5xx; S-M03-1) → `unknown`: the binding is KEPT, the claim
 *   stays `queued` with `sendUnknown`, and no further poll is scheduled because the component row is final. Only
 *   `resendAfterUnknown`, with the user's acknowledgment, can send again.
 * - still pending, attempts left → reschedule on the backoff
 * - still pending, attempts spent → claim stays `queued`, `sendUnknown: true`
 *
 * After a resend, an EARLIER attempt's observation never overwrites the current attempt's state: its failure or
 * unknown outcome is recorded on its own draft only. If it turns out delivered, the claim becomes `sent` — that is
 * the truth, whichever attempt got there.
 *
 * `reschedule` says whether THIS call may arm the next stall-interval check once backoff is exhausted
 * (checkpoint-4 N2/N3, superseding the F9 scan below): `reconcileSend`, the scheduled path, passes `true`;
 * `recheckSend`, a user click that must never independently grow the schedule, passes `false`. See the exhausted
 * branch for why the old scan was wrong, not just unbounded.
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
  reschedule: boolean,
): Promise<SendOutcome> {
  const draft = await ctx.db.get(draftId);
  if (!draft || !draft.outboundId) return "gone";
  const claim = await ctx.db.get(draft.claimId);
  if (!claim) return "gone";
  // An attempt is superseded once a newer draft of the claim carries its own outbound attempt (a resend).
  const superseded = (
    await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .take(MAX_DRAFTS_PER_CLAIM)
  ).some((d) => d.version > draft.version && d.outboundId !== undefined);

  // Failures first: a bounced message still carries its message id (review H3).
  if (status && isTerminalSendFailure(status)) {
    const sendError = ownerSafeSendError(status.status, status.errorMessage);
    if (superseded) {
      // The earlier attempt's own record only; its send still counted, and the current attempt is untouched.
      await ctx.db.patch(draft._id, { sendError });
      return "failed";
    }
    // Clear the outbound binding so the user can fix the address and retry; `sendError` keeps the reason visible.
    await ctx.db.patch(draft._id, { sendError, outboundId: undefined, approvedAt: undefined });
    if (claim.status === "queued") {
      await ctx.db.patch(claim._id, { status: "drafted", sendUnknown: undefined });
    }
    return "failed";
  }

  if (status && status.agentmailMessageId) {
    // N6 (checkpoint-4 recheck): `mailEvents.onEvent` can see a bounce or complaint webhook for this message id
    // before this poll ever learns it (the id is only recorded here) -- that event was stashed
    // (`mailEvents.storePendingMailEvent`, F8) rather than lost. Consume it now, before a fast bounce gets silently
    // recorded as "sent" the way `notify.applyDropOutcome` already does for price-drop alerts.
    const pending = await getPendingMailEvent(ctx, status.agentmailMessageId, Date.now());
    if (pending?.reason === "bounced") {
      const sendError = `Merchant email ${pending.providerStatus} after it was marked sent.`.slice(0, MAX_ERROR_CHARS);
      if (superseded) {
        await ctx.db.patch(draft._id, { sendError });
      } else {
        await ctx.db.patch(draft._id, { sendError, outboundId: undefined, approvedAt: undefined });
        if (claim.status === "queued") {
          await ctx.db.patch(claim._id, { status: "drafted", sendUnknown: undefined });
        }
      }
      await clearPendingMailEvent(ctx, status.agentmailMessageId);
      return "failed";
    }

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
    if (pending?.reason === "complained") {
      // Delivered, so the claim stays `sent` (mirrors mailEvents.onEvent's own late-complaint treatment for a
      // merchant draft) -- flagged for a human, not auto-resent.
      const note = "The merchant's mail provider marked this email as spam after it was sent.";
      await ctx.db.patch(draft._id, { sendError: note.slice(0, MAX_ERROR_CHARS) });
      await ctx.db.insert("claimNotes", { claimId: claim._id, userId: claim.userId, kind: "status", text: note });
      await clearPendingMailEvent(ctx, status.agentmailMessageId);
    }
    return "sent";
  }

  // S-M03-1: the component gave up without a provider answer that settles it. The provider may have accepted the
  // message, so this is unknown -- never failed -- and the approval stays bound. The component row is final, so
  // polling it again can never resolve it: no reschedule (the owner can still `recheckSend`).
  if (status && isAmbiguousSendFailure(status)) {
    if (!superseded && claim.status === "queued") await ctx.db.patch(claim._id, { sendUnknown: true });
    return "unknown";
  }

  if (attempt < BACKOFF_MS.length) {
    await ctx.scheduler.runAfter(BACKOFF_MS[attempt], internal.drafts.reconcileSend, {
      draftId: draft._id,
      attempt: attempt + 1,
    });
    return "retrying";
  }

  if (!superseded && claim.status === "queued") await ctx.db.patch(claim._id, { sendUnknown: true });
  // T06 durable-delivery review: backoff exhausted must not mean "never checked again" -- without this, a draft
  // whose delivery never resolves (worker outage, a status the component never settles) is stuck `sendUnknown`
  // forever unless the user happens to click "check again" (`recheckSend`). `drafts` has no
  // `nextCheckAt`/`by_status_nextCheck` column to drive a `notify.sweepStalled`-style cron sweep, so the sibling
  // mechanism is this mutation rescheduling itself on the same stall interval `notify.ts` uses for `mailLog`, at the
  // same "attempts exhausted" attempt number, until a definite outcome (the `sent`/`failed` branches above) stops it.
  //
  // N2/N3 (checkpoint-4 recheck): this exhausted branch used to gate the reschedule on a scan of
  // `ctx.db.system.query("_scheduled_functions")` (F9) looking for an already-pending `reconcileSend` for this draft.
  // That scan was wrong, not just unbounded (N3): when `reconcileSend` itself reaches this branch, ITS OWN
  // scheduled-function row is still "inProgress", so the scan always found a "pending" job -- itself -- and a
  // SCHEDULED exhaustion never re-armed the next stall-interval check at all (N2, HIGH). The fix is structural: the
  // caller says explicitly whether it may arm the next hop. `status !== null` still stops it in either case --
  // `null` means the component no longer recognizes this outbound id, so polling again can never resolve it (the
  // owner can still force one more check via `recheckSend`).
  if (reschedule && status !== null) {
    await ctx.scheduler.runAfter(MAIL_RECONCILE_STALL_MS, internal.drafts.reconcileSend, {
      draftId: draft._id,
      attempt: BACKOFF_MS.length,
    });
  }
  return "unknown";
}

/**
 * The scheduled delivery check (D13, D29). Reads the component's view of the outbound message and hands it to
 * `applySendOutcome`. Skips a tombstoned account (D87): a scheduled mutation reaching a `deleting`/`deleted` user's
 * own claim/draft rows must not keep touching them.
 */
export const reconcileSend = internalMutation({
  args: { draftId: v.id("drafts"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const draft = await ctx.db.get(args.draftId);
    if (!draft || !draft.outboundId) return null;
    if (await isTombstoned(ctx, draft.userId)) return null;
    const status = await agentmail.status(statusCtx(ctx), draft.outboundId);
    // Scheduled path: may arm the next stall-interval hop if delivery is still unresolved (N2).
    await applySendOutcome(ctx, args.draftId, args.attempt, status, true);
    return null;
  },
});

/**
 * D56: lets the owner ask for one more delivery check on demand, e.g. after a draft has sat `sendUnknown` for a
 * while. Reuses `applySendOutcome` with the backoff exhausted so a still-pending result doesn't reschedule another
 * automatic check; it only updates `sendUnknown` (cleared on a definite outcome, otherwise left as-is).
 */
export const recheckSend = mutation({
  args: { draftId: v.id("drafts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    if (!draft.outboundId) throw new ConvexError("This draft has not been sent");
    const status = await agentmail.status(statusCtx(ctx), draft.outboundId);
    // A user click never independently grows the schedule (N2/N3 supersede the old F9 scan).
    await applySendOutcome(ctx, draft._id, BACKOFF_MS.length, status, false);
    return null;
  },
});

/**
 * Live delivery state for one draft the caller owns (D29). Resolves the outbound id from the draft rather than
 * taking it as an argument, so no caller can poll somebody else's outbound message.
 *
 * Projected for the owner (S-M03-1, S-M03-4): `errorMessage` is never the provider's text (`ownerSafeSendError`),
 * and a component `failed` whose outcome is actually unknown is reported as `pending` with `outcome: "unknown"`,
 * never as a failure. `outcome` is the one field a UI needs: sent | failed | unknown | pending.
 */
export const sendStatus = query({
  args: { draftId: v.id("drafts") },
  returns: v.union(
    v.object({
      status: vOutboundStatus,
      agentmailMessageId: v.union(v.string(), v.null()),
      threadId: v.union(v.string(), v.null()),
      errorMessage: v.union(v.string(), v.null()),
      outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("unknown"), v.literal("pending")),
    }),
    v.null(),
  ),
  handler: async (ctx, { draftId }) => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, draftId, userId);
    if (!draft.outboundId) return null;
    const raw = await agentmail.status(statusCtx(ctx), draft.outboundId);
    if (raw === null) return null;
    if (isAmbiguousSendFailure(raw)) {
      return { status: "pending" as const, agentmailMessageId: null, threadId: raw.threadId, errorMessage: null, outcome: "unknown" as const };
    }
    const failed = isTerminalSendFailure(raw);
    return {
      status: raw.status,
      agentmailMessageId: raw.agentmailMessageId,
      threadId: raw.threadId,
      errorMessage: failed ? ownerSafeSendError(raw.status, raw.errorMessage) : null,
      outcome: failed ? ("failed" as const) : raw.agentmailMessageId !== null ? ("sent" as const) : ("pending" as const),
    };
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
