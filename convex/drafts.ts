import { ConvexError, v, type Infer } from "convex/values";
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
import schema, { approvalBinding, money as moneyValidator } from "./schema";
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
import { claimCurrency, formatMinor, type Money } from "./lib/money";
import { amountExceedsEstimate } from "./lib/amountReview";
import { isPackActive } from "./lib/rules/registry";
import { boundFactsHash, canonicalHash } from "./lib/canonical";
import { rateLimiter } from "./lib/rateLimits";
import { isApprovable } from "./lib/rules/types";
import { r01LateAskAcknowledgeable } from "./lib/rules/r01_price_adjustment_v1";
import { evaluatePurchase, evaluateTransaction } from "./opportunities";

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
    // §6 / C2: a draft of a claim linked to an opportunity is bound at insert to the claim's current evaluation — its
    // bound facts (R01 v1: never the live price), amount, rule and engine versions. `prepareSend` compares against it.
    // The claim is re-evaluated first (committed, like a review), so the draft is written against the claim as it is
    // NOW: a change the user just made (a corrected quantity, an adjusted amount — DA-B-2) is absorbed here, with its
    // version bump, instead of invalidating this very draft at its first review.
    // Example claims never send (B1), so they are never re-evaluated for approval.
    const claimPurchase = await ctx.db.get(claim.purchaseId);
    if (claim.isExample !== true && claimPurchase?.isExample !== true) await reevaluateForApproval(ctx, claim, Date.now());
    const current = (await ctx.db.get(claim._id))!;
    const purchase = await ctx.db.get(current.purchaseId);
    const link = await liveLink(ctx, current);
    const binding = purchase && link?.evaluation ? await bindingFor(current, purchase, link.opportunity._id, link.evaluation) : undefined;
    const draftId = await ctx.db.insert("drafts", {
      claimId: args.claimId,
      userId: args.userId,
      version: prev.length + 1,
      claimVersion: current.version,
      to: args.to.trim(),
      subject: args.subject.slice(0, 200),
      body: args.body.slice(0, MAX_BODY_CHARS),
      ...(binding !== undefined ? { binding } : {}),
    });
    if (current.status === "detected") await ctx.db.patch(claim._id, { status: "drafted" });
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

// ---------------------------------------------------------------------------
// Approval binding and prepareSend (contract rev 5 §6; DA-A-14, DA-A-21, C1, C2, N2, N3, N6; SEC-AI-4)
// ---------------------------------------------------------------------------

export type ApprovalBinding = Infer<typeof approvalBinding>;

/**
 * The approval binding of a claim linked to an opportunity (§2.4 `approvalBinding`, §6). `contextHash` is the
 * canonical hash of the VALUES the user approves — claim version, amount, rule id/version, engine version, the
 * bound-fact hash and attachments — never row ids (DA-A-15), so re-evaluating to the same result keeps it, and any
 * material change (which bumps `claims.version`) breaks it. C2: the bound facts are the pack's list (for R01 v1: unit
 * price, quantity, item identity, purchase date, claim amount, the opening observation), never the live price.
 * `evaluationId` names the evaluation the approval was made on; that row stores its bound values (N6).
 */
export async function bindingFor(
  claim: Doc<"claims">,
  purchase: Doc<"purchases">,
  opportunityId: Id<"opportunities">,
  evaluation: Doc<"evaluations">,
): Promise<ApprovalBinding> {
  const amount = { amountMinor: claim.expectedCents, currency: claimCurrency(claim, purchase) ?? purchase.currency };
  const bfh = await boundFactsHash(evaluation.boundFacts ?? []);
  const contextHash = await canonicalHash({
    claimVersion: claim.version,
    amount,
    ruleId: evaluation.ruleId,
    ruleVersion: evaluation.ruleVersion,
    engineVersion: evaluation.engineVersion ?? null,
    boundFactsHash: bfh,
    attachments: [],
  });
  return {
    contextHash,
    claimVersion: claim.version,
    amount,
    opportunityId,
    evaluationId: evaluation._id,
    ruleId: evaluation.ruleId,
    ruleVersion: evaluation.ruleVersion,
    ...(evaluation.engineVersion !== undefined ? { engineVersion: evaluation.engineVersion } : {}),
    boundFactsHash: bfh,
    attachments: [],
  };
}

/** The claim's live opportunity and its current evaluation, or null (unlinked, or its pack was withdrawn — N3). */
async function liveLink(
  ctx: QueryCtx | MutationCtx,
  claim: Doc<"claims">,
): Promise<{ opportunity: Doc<"opportunities">; evaluation: Doc<"evaluations"> | null } | null> {
  if (!claim.opportunityId) return null;
  const opportunity = await ctx.db.get(claim.opportunityId);
  if (!opportunity || opportunity.userId !== claim.userId || opportunity.status === "superseded") return null;
  const evaluation = opportunity.currentEvaluationId ? await ctx.db.get(opportunity.currentEvaluationId) : null;
  return { opportunity, evaluation };
}

// --- SEC-AI-4: what the generated body may state -----------------------------------------------------------------

/** Values the server gave the writer (or bound): the only emails, links and amounts a claim email may state. */
type Allowances = { emails: Set<string>; urls: Set<string>; hosts: Set<string>; amountsMinor: Set<number> };

const MAX_FINDINGS = 10;
const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[A-Za-z]{2,}/g;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const PHONE_IN_TEXT = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const CURRENCY_CODES = "USD|EUR|GBP|CAD|AUD";
const CURRENCY_WORDS = "dollars?|euros?|pounds?|bucks";
/**
 * Money in every form DA-B-5 names: a leading symbol ("$450"), a two-decimal number with or without a code ("95.00
 * USD"), a number then a code or word ("40 dollars"), a code first ("USD 450"), and a trailing symbol ("450$").
 */
const AMOUNT_IN_TEXT = new RegExp(
  [
    "[$€£]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?",
    `\\b(?:${CURRENCY_CODES})\\s?\\d[\\d,]*(?:\\.\\d{1,2})?`,
    `\\b\\d[\\d,]*(?:\\.\\d{1,2})?\\s?[$€£]`,
    `\\b\\d[\\d,]*\\.\\d{2}\\b(?:\\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS}))?`,
    `\\b\\d[\\d,]*\\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS})\\b`,
  ].join("|"),
  "gi",
);
const NUMBER_WORDS =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million";
/** A spelled amount: number words (with "and"/hyphens between them) next to a currency word or code (DA-B-5). */
const SPELLED_AMOUNT = new RegExp(
  `\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMBER_WORDS}))*\\s+(?:${CURRENCY_WORDS}|${CURRENCY_CODES})\\b`,
  "gi",
);
/** "claims [at] evil.example", "claims (at) evil.example" → an address (DA-B-5). */
const BRACKET_AT = /\s*[[(]\s*at\s*[\])]\s*/gi;
/** "claims at evil.example" when no path follows (a path makes it a bare link, checked below). */
const WORD_AT = /\b([A-Za-z0-9._%+-]+)\s+at\s+((?:[a-z0-9-]+\.)+[a-z]{2,})\b(?![/.\w-])/gi;
/** A bare `host.tld/path` token (no scheme) — DA-B-5. A host without a path is not a link and is left alone. */
const BARE_LINK = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s<>()"']*)/gi;

function normalizeUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]]+$/, "").replace(/^www\./i, "https://www.").replace(/\/+$/, "").toLowerCase();
}

function hostOf(raw: string): string | null {
  try {
    return new URL(normalizeUrl(raw)).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Minor units of an amount token ("$1,234.50", "79.99 USD", "40 dollars"), by string arithmetic; null if unreadable. */
function amountTokenMinor(token: string): number | null {
  const m = /(\d[\d,]*)(?:\.(\d{1,2}))?/.exec(token);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0"));
  const minor = whole * 100 + frac;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * SEC-AI-4 (M13): the post-generation check on a claim email. Any email address, link, phone number or money amount
 * in the body that the server did not supply — the recipient, the store's confirmed contact, the user's own
 * addresses, the item and policy links (or the store's own site), and the claim's own amounts — is listed. A
 * non-empty list blocks approval until the user edits the text or acknowledges it (`acknowledgeUnverifiedContent`).
 * Pure; the body is already capped at 1,200 characters, so the patterns never see unbounded input.
 */
export function unverifiedContent(body: string, allowed: Allowances): string[] {
  const findings: string[] = [];
  const add = (f: string) => {
    if (findings.length < MAX_FINDINGS && !findings.includes(f)) findings.push(f);
  };
  const hostAllowed = (host: string) => [...allowed.hosts].some((h) => host === h || host.endsWith(`.${h}`));
  // 1. Links with a scheme or "www.".
  for (const m of body.matchAll(URL_IN_TEXT)) {
    const url = normalizeUrl(m[0]);
    const host = hostOf(m[0]);
    if (!allowed.urls.has(url) && !(host !== null && hostAllowed(host))) add(`link ${m[0]}`);
  }
  // 2. Addresses, after undoing the obfuscations DA-B-5 names ("[at]", "(at)", " at " before a bare host).
  let rest = body.replace(URL_IN_TEXT, " ").replace(BRACKET_AT, "@");
  rest = rest.replace(WORD_AT, (whole, local: string, host: string) => (hostAllowed(host.toLowerCase()) ? whole : `${local}@${host}`));
  for (const m of rest.matchAll(EMAIL_IN_TEXT)) {
    if (!allowed.emails.has(m[0].toLowerCase())) add(`email ${m[0]}`);
  }
  rest = rest.replace(EMAIL_IN_TEXT, " ");
  // 3. Bare `host.tld/path` links with no scheme.
  for (const m of rest.matchAll(BARE_LINK)) {
    const token = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!allowed.urls.has(normalizeUrl(`https://${token}`)) && !hostAllowed(m[1].toLowerCase())) add(`link ${token}`);
  }
  rest = rest.replace(BARE_LINK, " ");
  // 4. Phone numbers, then amounts (numeric in every symbol/code position, and spelled out).
  for (const m of rest.matchAll(PHONE_IN_TEXT)) add(`phone ${m[0].trim()}`);
  for (const m of rest.matchAll(AMOUNT_IN_TEXT)) {
    const minor = amountTokenMinor(m[0]);
    if (minor === null || !allowed.amountsMinor.has(minor)) add(`amount ${m[0].trim()}`);
  }
  // A spelled amount is never something the server wrote; it is always listed.
  for (const m of rest.matchAll(SPELLED_AMOUNT)) add(`amount ${m[0].trim()}`);
  return findings;
}

/** Everything `generate` told the writer, plus the claim's bound amounts: what `unverifiedContent` accepts. */
async function draftAllowances(
  ctx: QueryCtx | MutationCtx,
  claim: Doc<"claims">,
  purchase: Doc<"purchases">,
  to: string,
  evaluation: Doc<"evaluations"> | null,
): Promise<Allowances> {
  const emails = new Set<string>([to.toLowerCase()]);
  const urls = new Set<string>();
  const hosts = new Set<string>([purchase.merchantDomain.toLowerCase().replace(/^www\./, "")]);
  const amountsMinor = new Set<number>([claim.expectedCents]);
  const item = await ctx.db.get(claim.itemId);
  if (item) {
    amountsMinor.add(item.unitCents);
    amountsMinor.add(item.unitCents * item.qty);
    if (item.productUrl) urls.add(normalizeUrl(item.productUrl));
  }
  const policy = claim.policyId ? await ctx.db.get(claim.policyId) : null;
  if (policy) {
    urls.add(normalizeUrl(policy.sourceUrl));
    if (policy.contactEmail) emails.add(policy.contactEmail.trim().toLowerCase());
  }
  if (claim.openedFromPriceCheckId) {
    const pc = await ctx.db.get(claim.openedFromPriceCheckId);
    if (pc?.observedCents !== undefined) amountsMinor.add(pc.observedCents);
  }
  const balance = await claimBalance(ctx, claim);
  amountsMinor.add(Math.max(balance.unresolved, 0));
  amountsMinor.add(balance.confirmed);
  for (const f of evaluation?.boundFacts ?? []) {
    if (f.value?.kind === "money") amountsMinor.add(f.value.amountMinor);
  }
  const profile = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", claim.userId)).unique();
  if (profile?.inboxEmail) emails.add(profile.inboxEmail.toLowerCase());
  const user = await ctx.db.get(claim.userId);
  if (user?.email) emails.add(user.email.toLowerCase());
  return { emails, urls, hosts, amountsMinor };
}

// --- The approval state both prepareSend and approveAndSend compute -------------------------------------------------

/** The text of an approval, normalized exactly as the send will normalize it. */
type ApprovalText = { to: string; subject: string; body: string };

function approvalText(claim: Doc<"claims">, input: { to: string; subject: string; body: string }): ApprovalText {
  return {
    to: parseRecipient(input.to),
    subject: subjectWithToken(stripControl(input.subject), claim.token),
    body: input.body.trim().slice(0, MAX_BODY_CHARS),
  };
}

export type PrepareCode =
  | "amount_exceeds_estimate"
  | "outcome_not_approvable"
  | "binding_changed"
  | "window_may_have_passed"
  | "rule_withdrawn"
  | "rate_limited"
  | "example_claim"
  | "unverified_content";

type ApprovalState =
  | { ok: false; code: PrepareCode; message: string; findings?: string[]; estimate?: Money }
  | {
      ok: true;
      /** The binding to approve under (linked claims), or null (the legacy binding: text + versions). */
      binding: ApprovalBinding | null;
      needsWindowAck: boolean;
      /** DA-B-2: the claim asks more than the rule's exact estimate and the user acknowledged it. */
      amountAboveEstimate: boolean;
      findings: string[];
    };

type Acks = { windowRisk: boolean; unverifiedContent: boolean; amountAboveEstimate: boolean };

const RULE_WITHDRAWN_MESSAGE =
  "Recoup's automatic checks for this kind of claim were withdrawn. Review the claim and approve it again.";

const WINDOW_MESSAGE =
  "The store's price-adjustment window may have passed. You can still send the request; confirm that you understand it may be refused.";

/**
 * Read-only: may this draft be approved as it stands, and under what binding? Shared by `prepareSend` (after it has
 * committed a fresh `approval_check` evaluation) and `approveAndSend` (which re-derives it without evaluating).
 *
 * - The claim moved on since the draft was written (a material change bumped its version) → `binding_changed`.
 * - Linked claim: the current evaluation must be in `APPROVABLE_OUTCOMES`; when the ONLY failing condition is the
 *   acknowledgeable R01 legacy window (C1), the answer is `window_may_have_passed` unless acknowledged — never a hard
 *   refusal. A draft already bound to a different context → `binding_changed`.
 * - Unlinked (legacy) claim: past `windowEndsAt` → the same acknowledgeable `window_may_have_passed` (DA-A-21:
 *   identical for linked and unlinked claims).
 * - SEC-AI-4: unknown emails/links/phones/amounts in the body → `unverified_content` unless acknowledged.
 */
async function approvalState(
  ctx: QueryCtx | MutationCtx,
  draft: Doc<"drafts">,
  claim: Doc<"claims">,
  purchase: Doc<"purchases">,
  text: ApprovalText,
  acks: Acks,
  now: number,
): Promise<ApprovalState> {
  if (claim.version !== draft.claimVersion) {
    return { ok: false, code: "binding_changed", message: "The claim changed since this draft was written. Generate a new draft and review it again." };
  }
  const link = await liveLink(ctx, claim);
  let binding: ApprovalBinding | null = null;
  let needsWindowAck = false;
  let amountReview: { estimate: Money; claimed: Money } | null = null;
  if (link !== null) {
    const evaluation = link.evaluation;
    if (evaluation === null) return { ok: false, code: "outcome_not_approvable", message: "Recoup has not checked this claim yet." };
    // DA-B-1 (b): the rule the evaluation ran under must still be active NOW — a withdrawal between the review and
    // the send is a hard refusal, read without evaluating (the next review supersedes the opportunity, N3).
    if (!isPackActive(evaluation.ruleId, evaluation.ruleVersion)) {
      return { ok: false, code: "rule_withdrawn", message: RULE_WITHDRAWN_MESSAGE };
    }
    if (!isApprovable(evaluation.outcome)) {
      if (!r01LateAskAcknowledgeable(evaluation)) {
        return { ok: false, code: "outcome_not_approvable", message: `Recoup's check no longer supports this claim (${evaluation.outcome.replace(/_/g, " ")}).` };
      }
      needsWindowAck = true;
    }
    binding = await bindingFor(claim, purchase, link.opportunity._id, evaluation);
    if (draft.binding !== undefined && draft.binding.contextHash !== binding.contextHash) {
      return { ok: false, code: "binding_changed", message: "What this draft asks for changed since it was written. Generate a new draft and review it again." };
    }
    // DA-B-2: the one shared predicate (`lib/amountReview`, also behind the opportunity's `review_amount`).
    const review = amountExceedsEstimate({ expectedCents: claim.expectedCents, currency: claimCurrency(claim, purchase) }, evaluation.amount);
    if (review.exceeds) amountReview = review;
  }
  // DA-B-1 (a) / DA-A-21: the legacy window is read from the clock for EVERY claim that has one — linked or not —
  // so a review done before the window closed never approves a send after it without the acknowledgment.
  if (claim.windowEndsAt !== undefined && now > claim.windowEndsAt) needsWindowAck = true;
  if (needsWindowAck && !acks.windowRisk) return { ok: false, code: "window_may_have_passed", message: WINDOW_MESSAGE };
  if (amountReview !== null && !acks.amountAboveEstimate) {
    const { estimate, claimed } = amountReview;
    return {
      ok: false,
      code: "amount_exceeds_estimate",
      message: `This claim asks ${formatMinor(claimed.amountMinor, claimed.currency)}; Recoup's current estimate is ${formatMinor(estimate.amountMinor, estimate.currency)}. Adjust the claim to ${formatMinor(estimate.amountMinor, estimate.currency)}, or confirm that you want to ask for the full amount.`,
      estimate,
    };
  }
  const findings = unverifiedContent(text.body, await draftAllowances(ctx, claim, purchase, text.to, link?.evaluation ?? null));
  if (findings.length > 0 && !acks.unverifiedContent) {
    return {
      ok: false,
      code: "unverified_content",
      message: "The message mentions details Recoup did not supply. Edit them out, or confirm that you checked them.",
      findings,
    };
  }
  return { ok: true, binding, needsWindowAck, amountAboveEstimate: amountReview !== null, findings };
}

function acksOf(input: { acknowledgeWindowRisk?: boolean; acknowledgeUnverifiedContent?: boolean; acknowledgeAmountAboveEstimate?: boolean }): Acks {
  return {
    windowRisk: input.acknowledgeWindowRisk === true,
    unverifiedContent: input.acknowledgeUnverifiedContent === true,
    amountAboveEstimate: input.acknowledgeAmountAboveEstimate === true,
  };
}

/** The hash the user approves (§6 `preparedHash`); `approveAndSend` recomputes it read-only and compares. */
async function preparedHashOf(
  draft: Doc<"drafts">,
  claim: Doc<"claims">,
  text: ApprovalText,
  state: Extract<ApprovalState, { ok: true }>,
): Promise<string> {
  return await canonicalHash({
    v: 1,
    // Linked: the binding (claim version, amount, rule, bound facts). Unlinked or withdrawn (N2): the legacy binding.
    ...(state.binding !== null ? { contextHash: state.binding.contextHash } : { claimVersion: claim.version }),
    draftVersion: draft.version,
    to: text.to,
    subject: text.subject,
    body: text.body,
    ...(state.needsWindowAck ? { acknowledgeWindowRisk: true } : {}),
    ...(state.amountAboveEstimate ? { acknowledgeAmountAboveEstimate: true } : {}),
    ...(state.findings.length > 0 ? { acknowledgeUnverifiedContent: true } : {}),
  });
}

/** Does this send need a `preparedHash`? Linked claims, and any claim past its legacy window (§6). */
async function requiresPrepared(ctx: QueryCtx | MutationCtx, claim: Doc<"claims">, now: number): Promise<boolean> {
  if ((await liveLink(ctx, claim)) !== null) return true;
  return claim.windowEndsAt !== undefined && now > claim.windowEndsAt;
}

const prepareArgs = {
  draftId: v.id("drafts"),
  to: v.string(),
  subject: v.string(),
  body: v.string(),
  acknowledgeWindowRisk: v.optional(v.boolean()),
  acknowledgeUnverifiedContent: v.optional(v.boolean()),
  /** DA-B-2: the user chose to ask for the claim's full amount although Recoup's exact estimate is lower. */
  acknowledgeAmountAboveEstimate: v.optional(v.boolean()),
};

const prepareCode = v.union(
  v.literal("amount_exceeds_estimate"),
  v.literal("outcome_not_approvable"),
  v.literal("binding_changed"),
  v.literal("window_may_have_passed"),
  v.literal("rule_withdrawn"),
  v.literal("rate_limited"),
  v.literal("example_claim"),
  v.literal("unverified_content"),
);
const prepareResult = v.union(
  v.object({ ok: v.literal(true), preparedHash: v.string(), findings: v.array(v.string()) }),
  v.object({
    ok: v.literal(false),
    code: prepareCode,
    message: v.string(),
    findings: v.optional(v.array(v.string())),
    /** `amount_exceeds_estimate` only: the estimate the UI offers to adjust the claim to. */
    estimate: v.optional(moneyValidator),
  }),
);
type PrepareResult =
  | { ok: true; preparedHash: string; findings: string[] }
  | { ok: false; code: PrepareCode; message: string; findings?: string[]; estimate?: Money };

/**
 * The evaluation half of a prepare: re-evaluates the claim's R01 subject (`approval_check`) and COMMITS it — the
 * result, any material version bump and its claimNote (§2.8), the mandatory link of a legacy claim (DA-A-3) and an
 * N3 supersession. Returns `rule_withdrawn` for the call that finds the claim's pack withdrawn (the version bump and
 * note are M12's); later calls see a superseded opportunity and take the legacy path.
 */
async function reevaluateForApproval(ctx: MutationCtx, claim: Doc<"claims">, now: number): Promise<PrepareResult | null> {
  if (claim.type !== "price_adjustment" && !claim.opportunityId) return null;
  const before = claim.opportunityId ? await ctx.db.get(claim.opportunityId) : null;
  const subjects = [`item:${claim.itemId}`];
  if (claim.transactionId) await evaluateTransaction(ctx, claim.transactionId, "approval_check", now, { subjects });
  else await evaluatePurchase(ctx, claim.purchaseId, "approval_check", now, { subjects });
  if (before && before.status !== "superseded") {
    const after = await ctx.db.get(before._id);
    if (after?.status === "superseded") {
      return {
        ok: false,
        code: "rule_withdrawn",
        message: RULE_WITHDRAWN_MESSAGE,
      };
    }
  }
  return null;
}

/**
 * The one prepare pass: N2's checks in order (the owner, tombstone and example checks are the caller's), the
 * committed re-evaluation, then the approval state and its hash. Never throws on a policy refusal: it RETURNS it,
 * so the committed re-evaluation, version bump and note survive (DA-A-14). Charges nothing.
 */
async function prepareCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  draft: Doc<"drafts">,
  claim: Doc<"claims">,
  purchase: Doc<"purchases">,
  input: {
    to: string;
    subject: string;
    body: string;
    acknowledgeWindowRisk?: boolean;
    acknowledgeUnverifiedContent?: boolean;
    acknowledgeAmountAboveEstimate?: boolean;
  },
): Promise<PrepareResult> {
  const text = approvalText(claim, input); // S-M03-5: capped before any regex; throws on a malformed address.
  const limit = await rateLimiter.limit(ctx, "prepareSend", { key: userId });
  if (!limit.ok) return { ok: false, code: "rate_limited", message: "Too many checks in a minute. Wait a moment and try again." };

  const now = Date.now();
  const withdrawn = await reevaluateForApproval(ctx, claim, now);
  if (withdrawn !== null) return withdrawn;
  const fresh = (await ctx.db.get(claim._id))!;
  const state = await approvalState(
    ctx,
    draft,
    fresh,
    purchase,
    text,
    acksOf(input),
    now,
  );
  if (!state.ok) return state;
  // A draft written before its claim was linked is bound now, at the user's review (the text they see is the text
  // being bound); a draft already bound keeps its original evaluation reference (N6).
  if (state.binding !== null && draft.binding === undefined) await ctx.db.patch(draft._id, { binding: state.binding });
  return { ok: true, preparedHash: await preparedHashOf(draft, fresh, text, state), findings: state.findings };
}

/**
 * `drafts.prepareSend` (contract rev 5 §6, N2; DA-A-14, DA-A-21 / C1, N3, SEC-AI-4): the review step the UI runs
 * before every send. Check order, all before any evaluation: sign-in and tombstone (`requireUserId`) → the draft
 * and its claim are the caller's (identical not-found, nothing written) → an example claim is refused
 * (`example_claim`) → the recipient parses as one capped address → the per-user `prepareSend` limiter
 * (`rate_limited`). Then it re-evaluates and commits, and returns `{ ok: true, preparedHash }` or
 * `{ ok: false, code, message }` — never a throw for a policy refusal, and never a charge.
 */
export const prepareSend = mutation({
  args: prepareArgs,
  returns: prepareResult,
  handler: async (ctx, args): Promise<PrepareResult> => {
    const userId = await requireUserId(ctx);
    const draft = await ownedDraft(ctx, args.draftId, userId);
    const claim = await ownedClaim(ctx, draft.claimId, userId);
    const purchase = await ctx.db.get(claim.purchaseId);
    if (!purchase) throw new ConvexError("Purchase not found");
    if (claim.isExample || purchase.isExample) return { ok: false, code: "example_claim", message: EXAMPLE_ERROR };
    if (draft.outboundId) throw new ConvexError("This draft was already sent");
    return await prepareCore(ctx, userId, draft, claim, purchase, args);
  },
});

/** What the user saw and approved: the text, the recipient tick, and the claim/draft versions it was shown at (D11). */
const sendApprovalArgs = {
  draftId: v.id("drafts"),
  to: v.string(),
  subject: v.string(),
  body: v.string(),
  claimVersion: v.number(),
  draftVersion: v.number(),
  recipientConfirmed: v.optional(v.boolean()),
  /**
   * §6: required for a claim linked to an opportunity and for any claim past its legacy window — the hash
   * `prepareSend` returned. Legacy claims inside their window send exactly as before without it.
   */
  preparedHash: v.optional(v.string()),
  /** C1 / DA-A-21: the user acknowledged that the store's window may have passed. */
  acknowledgeWindowRisk: v.optional(v.boolean()),
  /** SEC-AI-4: the user checked the details `prepareSend` flagged in the body. */
  acknowledgeUnverifiedContent: v.optional(v.boolean()),
  /** DA-B-2: the user asks for the claim's full amount although Recoup's exact estimate is lower. */
  acknowledgeAmountAboveEstimate: v.optional(v.boolean()),
};
type SendApproval = {
  to: string;
  subject: string;
  body: string;
  claimVersion: number;
  draftVersion: number;
  recipientConfirmed?: boolean;
  preparedHash?: string;
  acknowledgeWindowRisk?: boolean;
  acknowledgeUnverifiedContent?: boolean;
  acknowledgeAmountAboveEstimate?: boolean;
};

type CheckedSend = { to: string; subject: string; body: string; inboxId: string; approvedHash?: string };

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
  // §6: a linked claim, or one past its legacy window, sends only what `prepareSend` approved: the hash is
  // recomputed read-only from the current state, so a change since the review ("Review the claim again") refuses
  // before anything is charged or sent. A resend runs the full prepare pass itself in the same transaction.
  let approvedHash: string | undefined;
  if (mode === "first") approvedHash = await verifyPrepared(ctx, draft, claim, purchase, args);
  // Last, so every refusal above costs nothing; throws at 10 sends a day.
  await charge(ctx, userId, "claim_email");
  return { to, subject, body, inboxId: profile.inboxId, ...(approvedHash !== undefined ? { approvedHash } : {}) };
}

/** Read-only check of an approval against `prepareSend`'s hash; returns it, or undefined when none is required. */
async function verifyPrepared(
  ctx: MutationCtx,
  draft: Doc<"drafts">,
  claim: Doc<"claims">,
  purchase: Doc<"purchases">,
  args: SendApproval,
): Promise<string | undefined> {
  const now = Date.now();
  if (!(await requiresPrepared(ctx, claim, now))) return undefined;
  const text = approvalText(claim, args);
  const state = await approvalState(
    ctx,
    draft,
    claim,
    purchase,
    text,
    acksOf(args),
    now,
  );
  if (!state.ok && state.code === "window_may_have_passed") {
    throw new ConvexError("Acknowledge that the store's window may have passed, then send.");
  }
  if (!state.ok && state.code === "amount_exceeds_estimate") {
    throw new ConvexError("Adjust the claim amount, or confirm that you want to ask for the full amount, then send.");
  }
  if (!state.ok && state.code === "rule_withdrawn") throw new ConvexError(state.message);
  if (!state.ok || args.preparedHash === undefined || (await preparedHashOf(draft, claim, text, state)) !== args.preparedHash) {
    throw new ConvexError("Review the claim again before sending.");
  }
  return args.preparedHash;
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
    ...(send.approvedHash !== undefined ? { approvedHash: send.approvedHash } : {}),
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
  v.object({ ok: v.literal(false), code: v.union(v.literal("outcome_known"), prepareCode), message: v.string(), findings: v.optional(v.array(v.string())) }),
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
 *   3. the full `prepareSend` pass runs (DA-A-31): the claim is re-evaluated (`approval_check`) and the result,
 *      version bump and note are committed; any refusal — the claim changed, the outcome left the approvable set,
 *      the window may have passed without an acknowledgment, the rule was withdrawn, unverified content — is
 *      RETURNED, and nothing is sent. Then every `approveAndSend` check runs again (`checkSend`);
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
    const purchase = await ctx.db.get(claim.purchaseId);
    if (!purchase) throw new ConvexError("Purchase not found");
    if (claim.isExample || purchase.isExample) throw new ConvexError(EXAMPLE_ERROR);
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

    // 3. The full prepare pass (committed re-evaluation; refusals returned), then every approval check.
    const prepared = await prepareCore(ctx, userId, draft, claim, purchase, args);
    if (!prepared.ok) return prepared;
    const current = (await ctx.db.get(claim._id))!;
    const send = await checkSend(ctx, userId, draft, current, args, "resend");
    const bound = await liveLink(ctx, current);

    // 4. A new draft version for the new attempt; the earlier one keeps its outbound id.
    const resendDraftId = await ctx.db.insert("drafts", {
      claimId: claim._id,
      userId,
      version: draft.version + 1,
      claimVersion: current.version,
      to: send.to,
      subject: send.subject,
      body: send.body,
      ...(bound?.evaluation ? { binding: await bindingFor(current, purchase, bound.opportunity._id, bound.evaluation) } : {}),
      approvedHash: prepared.preparedHash,
    });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "status",
      text: `Sent again after an unknown delivery outcome. The earlier attempt (${new Date(draft.approvedAt ?? draft._creationTime).toISOString().slice(0, 16).replace("T", " ")} UTC) may also have reached the merchant.`,
    });
    const outboundId = await enqueueClaimEmail(ctx, current, resendDraftId, send, args.recipientConfirmed === true);
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
