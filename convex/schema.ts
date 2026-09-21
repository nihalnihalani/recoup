import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";
import { vOutboundId } from "@agentmail/convex";

// Exported validators: single source of truth for enums (ARCHITECTURE_PATTERNS §Schema).
export const claimType = v.union(v.literal("price_adjustment"), v.literal("return_credit"));
export const claimStatus = v.union(
  v.literal("detected"), v.literal("drafted"), v.literal("queued"), v.literal("sent"), v.literal("packet"),
  v.literal("promised"), v.literal("confirmed"), v.literal("reopened"), v.literal("dismissed"),
);
export const eventKind = v.union(v.literal("promised_credit"), v.literal("confirmed_credit"), v.literal("later_debit"));
export const policyKind = v.union(v.literal("price_adjustment"), v.literal("returns"));
export const channel = v.union(v.literal("email"), v.literal("form"), v.literal("chat"), v.literal("phone"), v.literal("unknown"));
export const replyClass = v.union(v.literal("promise"), v.literal("credit_issued"), v.literal("refusal"), v.literal("question"), v.literal("other"));
export const purchaseStatus = v.union(v.literal("needs_review"), v.literal("active"), v.literal("archived"));
export const processedStatus = v.union(v.literal("received"), v.literal("processing"), v.literal("succeeded"), v.literal("failed"), v.literal("needs_review"));
export const processedRoute = v.union(v.literal("reply"), v.literal("intake"), v.literal("ignored"));
export const noteKind = v.union(v.literal("note"), v.literal("status"), v.literal("expected_change"));
export const followUpStatus = v.union(v.literal("pending"), v.literal("fired"), v.literal("cancelled"));
export const variantMatch = v.union(v.literal("exact"), v.literal("unsure"), v.literal("none"));
/** W1b. Produced only by lib/verdict.ts, never by the model. */
export const verdictLabel = v.union(
  v.literal("good_price"), v.literal("fair"), v.literal("wait"), v.literal("inflated_discount"), v.literal("not_enough_history"), v.literal("unknown"),
);
/**
 * `qualified`/`qualifiedReason` are only produced by `lib/verdict.ts`'s
 * `verdictWithQualifier()` (T04); optional so `verdict()`'s older
 * `{label, reason}` shape keeps validating unchanged.
 */
export const verdictValidator = v.object({
  label: verdictLabel,
  reason: v.string(),
  qualified: v.optional(v.boolean()),
  qualifiedReason: v.optional(v.union(v.string(), v.null())),
});
export const priceSource = v.union(v.literal("recoup"), v.literal("shopsavvy"));
export const watchStatus = v.union(v.literal("active"), v.literal("paused"), v.literal("archived"), v.literal("bought"));
export const mailKind = v.union(v.literal("price_drop"));
/**
 * `queued` sits between `claimed` and `sent`: the component has an outboundId but no confirmed message id yet (F3).
 * `unknown` = reconciliation exhausted its attempts with no message id; `suppressed` = the send-time gate refused (T01/T06).
 */
export const mailStatus = v.union(
  v.literal("claimed"), v.literal("queued"), v.literal("sent"), v.literal("failed"),
  v.literal("unknown"), v.literal("suppressed"),
);
/** Why a mailLog row is `suppressed`/`failed`, or why `alertGate` refused a send (T01). */
export const mailReason = v.union(
  v.literal("unverified"), v.literal("opted_out"), v.literal("deleted"), v.literal("address_suppressed"),
  v.literal("daily_cap"), v.literal("global_cap"), v.literal("no_email"), v.literal("not_configured"),
  v.literal("watch_inactive"), v.literal("send_failed"),
);
/** Why an address landed in `alertSettings.suppressedReason` (T01). */
export const suppressedReason = v.union(v.literal("bounced"), v.literal("complained"), v.literal("user_unsubscribed"));
export const offerStatus = v.union(v.literal("candidate"), v.literal("confirmed"), v.literal("rejected"));
/** Per-watch ShopSavvy market-history fetch lifecycle (T01/T09, D71). */
export const marketState = v.union(
  v.literal("not_configured"), v.literal("queued"), v.literal("running"), v.literal("success"),
  v.literal("empty_result"), v.literal("retryable_failure"), v.literal("terminal_failure"),
);
/** Account-deletion tombstone lifecycle (T01/T18, D77). */
export const accountStateStatus = v.union(v.literal("deleting"), v.literal("deleted"));

export default defineSchema({
  ...authTables,

  /**
   * One AgentMail inbox per user; inbound mail is routed to a user through by_inbox.
   *
   * `inboxId`/`inboxEmail` are optional (T18.5 addendum, F-AUD-2/D126): a row
   * can exist as a PLACEHOLDER before either is known -- `profiles.ensureInbox`
   * claims this row first (stamping `provisioningAt`) to make concurrent
   * inbox provisioning single-flight (only one caller ever POSTs to the
   * provider), then fills both fields in via `profiles.save` once the
   * provider responds. A row with `provisioningAt` set and `inboxId` unset is
   * "claimed, provider POST in flight"; reclaimable by a later caller once
   * `provisioningAt` is more than `PROVISIONING_STALE_MS` old (`profiles.ts`).
   */
  profiles: defineTable({
    userId: v.id("users"), inboxId: v.optional(v.string()), inboxEmail: v.optional(v.string()),
    provisioningAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"]).index("by_inbox", ["inboxId"]),

  /** The case. purchasedAt is optional until the user confirms the extraction (D25). */
  purchases: defineTable({
    userId: v.id("users"), merchant: v.string(), merchantDomain: v.string(), orderRef: v.optional(v.string()),
    purchasedAt: v.optional(v.number()), currency: v.string(), sourceMessageId: v.optional(v.string()),
    status: purchaseStatus, isExample: v.optional(v.boolean()),
  }).index("by_user", ["userId"]).index("by_user_domain_order", ["userId", "merchantDomain", "orderRef"])
    .index("by_user_status", ["userId", "status"]),

  /**
   * Line items. `returned` is set only by the user, never by extraction (D15).
   * `checkRequestedAt` is stamped when `priceWatch.checkNow` schedules a manual
   * check, so it carries that check's cooldown the same way a watch's own
   * `checkRequestedAt` does (F2).
   */
  items: defineTable({
    purchaseId: v.id("purchases"), userId: v.id("users"), name: v.string(), unitCents: v.number(), qty: v.number(),
    productUrl: v.optional(v.string()), returned: v.boolean(), returnedAt: v.optional(v.number()),
    /** The product page's Open Graph image (absolute https), captured by a price check or carried from a watch. */
    imageUrl: v.optional(v.string()),
    /** Stamped when a manual price check is scheduled; carries the `priceWatch.checkNow` cooldown (review H1), as on watches. */
    checkRequestedAt: v.optional(v.number()),
    /** Denormalised so the sweep reads a bounded page off `by_nextCheck` (D74 cron fairness). */
    nextCheckAt: v.optional(v.number()),
  }).index("by_purchase", ["purchaseId"]).index("by_user", ["userId"]).index("by_nextCheck", ["nextCheckAt"]),

  /** Immutable policy snapshots; refresh inserts a new row (D17). */
  policies: defineTable({
    userId: v.id("users"), merchantDomain: v.string(), kind: policyKind, windowDays: v.optional(v.number()), channel,
    contactEmail: v.optional(v.string()), passage: v.string(), passageStart: v.optional(v.number()), sourceUrl: v.string(),
    retrievedAt: v.number(), confidence: v.number(), confirmedByUser: v.boolean(), note: v.optional(v.string()),
    isExample: v.optional(v.boolean()), userEdited: v.optional(v.boolean()),
  }).index("by_user_domain_kind", ["userId", "merchantDomain", "kind"]),

  /** One observation of a product page. observedCents undefined = no usable price (D16). */
  priceChecks: defineTable({
    itemId: v.id("items"), userId: v.id("users"), observedCents: v.optional(v.number()), currency: v.optional(v.string()),
    confidence: v.optional(v.number()), variantMatch: v.optional(variantMatch), observedAt: v.number(), sourceUrl: v.string(),
    note: v.optional(v.string()),
  }).index("by_item", ["itemId"]),

  /**
   * A product the user has NOT bought yet (W1). `nextCheckAt` is denormalised so the sweep reads a bounded page off
   * by_status_nextCheck; `checkRequestedAt` is stamped when a check is scheduled and carries the manual-check cooldown; `lastCents` is the latest accepted price for list views. `purchaseId` is set when a watch is bought (W4).
   */
  watches: defineTable({
    /** Set when ShopSavvy has been asked about this product, so we never spend a second lookup on it. */
    userId: v.id("users"), name: v.string(), productUrl: v.string(), merchantDomain: v.string(), currency: v.optional(v.string()),
    targetCents: v.optional(v.number()), status: watchStatus, lastCheckedAt: v.optional(v.number()), nextCheckAt: v.number(),
    lastCents: v.optional(v.number()), purchaseId: v.optional(v.id("purchases")), checkRequestedAt: v.optional(v.number()),
    marketFetchedAt: v.optional(v.number()), marketNote: v.optional(v.string()),
    /** The product page's Open Graph image (absolute https), captured by a watch check. */
    imageUrl: v.optional(v.string()),
    /** ShopSavvy market-history fetch lifecycle for this watch (T09, D71). */
    marketState: v.optional(marketState),
    marketAttempts: v.optional(v.number()),
    /** Set while a market lookup is in flight, so a crashed attempt can be reclaimed. */
    marketClaimedAt: v.optional(v.number()),
    marketNextRetryAt: v.optional(v.number()),
    /** Newest provider point time; `marketFetchedAt` stays the retrieval time. */
    marketObservedAt: v.optional(v.number()),
    /** Time of the last ACCEPTED own-store price (T04/T12 staleness gate). */
    lastObservedAt: v.optional(v.number()),
  }).index("by_user", ["userId"]).index("by_user_status", ["userId", "status"]).index("by_status_nextCheck", ["status", "nextCheckAt"]),

  /** One observation of a watched page; sibling of priceChecks. observedCents undefined = no usable price (D16). listCents is the page's claimed "was" price. */
  watchChecks: defineTable({
    watchId: v.id("watches"), userId: v.id("users"), observedCents: v.optional(v.number()), listCents: v.optional(v.number()),
    currency: v.optional(v.string()), confidence: v.optional(v.number()), variantMatch: v.optional(variantMatch), observedAt: v.number(),
    sourceUrl: v.string(), note: v.optional(v.string()),
  }).index("by_watch", ["watchId", "observedAt"]),

  /**
   * Per-user, per-day spend counters (pre-launch review B3-B5, H1-H2). One row per (user, UTC day, kind); the
   * scheduling mutation increments it in the same transaction that schedules the paid work, so the cap fails closed.
   * `userId` is optional only for the deployment-wide kill-switch rows.
   */
  usage: defineTable({
    userId: v.optional(v.id("users")), day: v.string(), kind: v.string(), count: v.number(),
  }).index("by_user_day_kind", ["userId", "day", "kind"]),

  /**
   * Outbound notification mail to the account holder (W2). Claim-before-send: the row is inserted with a unique
   * dedupeKey (`watch:<watchId>:<cents>`) before the send is attempted, so a re-run never mails the same event twice.
   * `outboundId` is set once the component has queued the send (status moves `claimed` -> `queued`); only
   * `notify.reconcileDrop` confirming a real AgentMail message id moves it on to `sent` (F3, same shape as `drafts`).
   */
  mailLog: defineTable({
    userId: v.id("users"), dedupeKey: v.string(), kind: mailKind, watchId: v.optional(v.id("watches")), to: v.string(),
    subject: v.string(), status: mailStatus, error: v.optional(v.string()), cents: v.optional(v.number()),
    previousCents: v.optional(v.number()), sentAt: v.optional(v.number()), outboundId: v.optional(vOutboundId),
    /** Why the row is `suppressed`/`failed`/`unknown` (T01/T06). */
    reason: v.optional(mailReason),
    /** Reconciliation attempt count (mirrors D56's backoff schedule). */
    attempt: v.optional(v.number()),
    /** Next time `notify.sweepStalled` should look at this row. */
    nextCheckAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    /** Stamped by `claimDrop`; re-claim (D70) keys on this, not `_creationTime`. */
    claimedAt: v.optional(v.number()),
    /** Raw AgentMail delivery status string (e.g. "delivered", "bounced"). */
    providerStatus: v.optional(v.string()),
    /** AgentMail's own message id; `onEvent` carries no outboundId, so this is the join key (`by_message`) instead. */
    agentmailMessageId: v.optional(v.string()),
  }).index("by_dedupe", ["dedupeKey"]).index("by_user", ["userId"]).index("by_watch", ["watchId"])
    .index("by_status_nextCheck", ["status", "nextCheckAt"]).index("by_message", ["agentmailMessageId"])
    /** D89 (T16): a status-scoped page per user, e.g. `insights.activity`'s "sent" alerts feed, without reading every other status in between. */
    .index("by_user_status", ["userId", "status"]),

  /** One row per user; alert opt-in/out and unsubscribe-token state, owns suppression via `alerts.suppressAddress` (T01). */
  alertSettings: defineTable({
    userId: v.id("users"), alertsEnabled: v.boolean(), unsubscribeToken: v.string(),
    suppressedAt: v.optional(v.number()), suppressedReason: v.optional(suppressedReason), updatedAt: v.number(),
  }).index("by_user", ["userId"]).index("by_unsubscribeToken", ["unsubscribeToken"]),

  /**
   * The same product at another store (W3). A `candidate` came from search and is never trusted: only a
   * user-`confirmed` offer is re-checked, ranked, or allowed to drive a verdict or an alert.
   */
  offers: defineTable({
    watchId: v.id("watches"), userId: v.id("users"), storeDomain: v.string(), productUrl: v.string(), title: v.string(),
    status: offerStatus, variantMatch: v.optional(variantMatch), matchConfidence: v.optional(v.number()),
    lastCents: v.optional(v.number()), currency: v.optional(v.string()), lastCheckedAt: v.optional(v.number()),
    note: v.optional(v.string()), source: v.optional(priceSource),
    /**
     * The product's own name, distinct from `title` (which for a ShopSavvy-sourced offer is the
     * RETAILER's name, e.g. "Walmart" -- never a product name). Set once, at confirm time and (as a
     * fallback when unset) on the first recheck that returns one; frozen after that. The only thing
     * a recheck's drift check (`titleSimilarity`) compares against -- checkpoint-5 addendum, F4/D103,
     * pre-declared by sonnet-integrations (T13.1), added here per the T01 schema-ownership convention.
     */
    productName: v.optional(v.string()),
  })
    .index("by_watch", ["watchId"])
    .index("by_user", ["userId"])
    // The daily re-check reads the stalest confirmed offers first, as a bounded page.
    .index("by_status_checked", ["status", "lastCheckedAt"]),

  /**
   * Per-store price history: one row each time a price is accepted into `offers.lastCents`. Sibling of
   * watchChecks, but only accepted, priced observations are kept (a failed read stays a `note` on the offer).
   */
  offerChecks: defineTable({
    offerId: v.id("offers"), watchId: v.id("watches"), userId: v.id("users"), observedCents: v.number(),
    currency: v.optional(v.string()), observedAt: v.number(), source: v.optional(priceSource),
  }).index("by_offer", ["offerId", "observedAt"]).index("by_watch", ["watchId", "observedAt"]),

  /**
   * Dated prices for a watched product from the ShopSavvy Data API, so a watch has a price range on day one
   * instead of "not enough history yet". Third-party evidence: always labelled, never opens a claim or sends
   * an alert (only our own read of the store page does that). `marketKey` dedupes a store's day.
   */
  marketPrices: defineTable({
    watchId: v.id("watches"), userId: v.id("users"), retailer: v.string(), storeDomain: v.optional(v.string()),
    cents: v.number(), currency: v.string(), observedAt: v.number(), marketKey: v.string(),
    /** Always "shopsavvy" today; kept alongside `priceSource`'s other literal for when a second market source exists (T10). */
    source: v.optional(priceSource),
    /** When Recoup retrieved this point, distinct from `observedAt` (when the provider says the price was seen) (T10). */
    retrievedAt: v.optional(v.number()),
  }).index("by_watch", ["watchId", "observedAt"]).index("by_key", ["watchId", "marketKey"]),

  /** Money the store owes on one item for one reason. Balance is derived from ledgerEvents, never stored. */
  claims: defineTable({
    purchaseId: v.id("purchases"), itemId: v.id("items"), userId: v.id("users"), type: claimType, expectedCents: v.number(),
    status: claimStatus, windowEndsAt: v.optional(v.number()), policyId: v.optional(v.id("policies")), threadId: v.optional(v.string()),
    token: v.string(), version: v.number(), attentionAt: v.optional(v.number()), openedFromPriceCheckId: v.optional(v.id("priceChecks")),
    sendUnknown: v.optional(v.boolean()), isExample: v.optional(v.boolean()),
  }).index("by_user", ["userId"]).index("by_item", ["itemId"]).index("by_token", ["token"]).index("by_thread", ["threadId"])
    .index("by_item_type_status", ["itemId", "type", "status"])
    /** F3 (D103): lets `tracking.overview` fetch every price_adjustment claim
     * for a whole purchase's items in one range read, instead of one query
     * per item -- see tracking.ts's docstring for the "too many index
     * ranges read" failure this replaces. */
    .index("by_purchase_type", ["purchaseId", "type", "status"]),

  /** Append-only facts about money. Idempotency keys are scoped per claim (D38). Only user confirmation creates confirmed_credit (Inv 3). */
  ledgerEvents: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), kind: eventKind, cents: v.number(), evidence: v.string(),
    idempotencyKey: v.optional(v.string()),
  }).index("by_claim", ["claimId"]).index("by_claim_key", ["claimId", "idempotencyKey"]),

  /** Non-monetary audit trail for a claim (D24). */
  claimNotes: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), kind: noteKind, text: v.string(), oldCents: v.optional(v.number()), newCents: v.optional(v.number()),
  }).index("by_claim", ["claimId"]),

  /** Versioned outbound messages; approval binds to claimVersion (D11, D13). */
  drafts: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), version: v.number(), claimVersion: v.number(), to: v.string(), subject: v.string(),
    body: v.string(), approvedAt: v.optional(v.number()), recipientConfirmed: v.optional(v.boolean()), outboundId: v.optional(vOutboundId),
    agentmailMessageId: v.optional(v.string()), sendError: v.optional(v.string()),
  }).index("by_claim", ["claimId"]).index("by_outbound", ["outboundId"]).index("by_message", ["agentmailMessageId"]),

  /** Classified merchant replies. promisedCents only when the reply states an amount (D21). */
  replies: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), messageId: v.string(), from: v.string(), classification: replyClass,
    summary: v.string(), promisedCents: v.optional(v.number()), senderMismatch: v.boolean(), receivedAt: v.number(),
  }).index("by_claim", ["claimId"]).index("by_message", ["messageId"]),

  /** Reminder-only follow-ups (D03, D28). Schedule first, then insert with the returned id. */
  followUps: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), scheduledFnId: v.id("_scheduled_functions"), fireAt: v.number(),
    claimVersion: v.number(), status: followUpStatus,
  }).index("by_claim", ["claimId"]),

  /** Idempotency + retry state for inbound webhooks and pastes (D14, D33). */
  processedEvents: defineTable({
    externalId: v.string(), kind: v.string(), status: processedStatus, attempts: v.number(), lastError: v.optional(v.string()),
    errorSummary: v.optional(v.string()),
    userId: v.optional(v.id("users")), claimId: v.optional(v.id("claims")), route: v.optional(processedRoute),
    summary: v.optional(v.string()), payload: v.optional(v.any()),
    /** When the row last entered `processing`; stuck detection compares against this, not `_creationTime` (review H5). */
    processingStartedAt: v.optional(v.number()),
  }).index("by_external", ["externalId"]).index("by_status", ["status"]).index("by_user_status", ["userId", "status"]),

  /** Account-deletion tombstone (D77); absence of a row means the account is active. */
  accountState: defineTable({
    userId: v.id("users"), status: accountStateStatus, requestedAt: v.number(), completedAt: v.optional(v.number()),
    attempts: v.number(), lastError: v.optional(v.string()), inboxDeleted: v.optional(v.boolean()),
    progress: v.optional(v.object({ table: v.string(), cursor: v.optional(v.string()) })),
    /**
     * 6b-4c (D115, T18.1): the AgentMail inbox id captured once by
     * `requestDeletion` (mirrors `account.ts`'s `purge` docstring: `profiles`
     * is the LAST table `purgeStep` drains, so re-reading it back after the
     * app-data purge completes would find nothing). Persisting it here
     * instead of only threading it as a `purge` action argument means a
     * daily re-drive (`account.reDriveStuckDeletions`) can recover it for a
     * row whose in-flight scheduled call was lost, without depending on
     * `profiles` still existing.
     */
    inboxId: v.optional(v.string()),
    /**
     * 6b-4c (D115, T18.1): the `_scheduled_functions` id of the currently
     * in-flight `account.purge` invocation for this row (the return value of
     * whichever `ctx.scheduler.runAfter` call most recently (re)armed it),
     * so the daily re-drive cron can tell "still running" from "chain died"
     * with a single indexed `ctx.db.system.get` instead of an unbounded scan
     * of the whole `_scheduled_functions` table (the pattern this codebase's
     * own N2/N3 finding, D99, already flagged as wrong for a materially
     * identical problem in `drafts.ts`'s `reconcileSend`).
     */
    activePurgeJobId: v.optional(v.id("_scheduled_functions")),
    /**
     * T18.4 (D115 6b-5), wired by T18.1: whether the AgentMail component's
     * own rows for the user's OWN inbox (`inboundMessages`/`outboundMessages`/
     * `events`, scoped by `inboxId` via `mailPurge.purgeInboxData`) were
     * fully drained. `true` vacuously when the user never provisioned an
     * inbox; `false` (not hidden/coerced) if that action's own bounded loop
     * reported `complete: false`.
     *
     * T18.5 (D124 B1) note: this flag does NOT cover price-drop alert
     * component rows -- those are sent from the separate, shared
     * `ALERTS_INBOX_ID` inbox (`convex/notify.ts`'s `sendDrop`), which is
     * never purged wholesale (doing so would delete every OTHER user's
     * alerts too). Those rows are purged individually, unconditionally, by
     * `outboundId`, inside `purgeStep`'s `mailLog` step
     * (`mailPurge.purgeOutbound`) -- not reflected in this field at all, and
     * not expected to be: by the time `purgeStep`'s `mailLog` step reports
     * done, every such row for this user is already gone, flag or no flag.
     */
    mailDataPurged: v.optional(v.boolean()),
  }).index("by_user", ["userId"]).index("by_status", ["status"]),

  /** Named cursors for resumable background jobs (e.g. retention sweeps, D75), one row per `key`. */
  opsState: defineTable({
    key: v.string(), cursor: v.optional(v.string()), updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
