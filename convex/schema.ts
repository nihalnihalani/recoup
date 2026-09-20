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

export default defineSchema({
  ...authTables,

  /** One AgentMail inbox per user; inbound mail is routed to a user through by_inbox. */
  profiles: defineTable({ userId: v.id("users"), inboxId: v.string(), inboxEmail: v.string() })
    .index("by_user", ["userId"]).index("by_inbox", ["inboxId"]),

  /** The case. purchasedAt is optional until the user confirms the extraction (D25). */
  purchases: defineTable({
    userId: v.id("users"), merchant: v.string(), merchantDomain: v.string(), orderRef: v.optional(v.string()),
    purchasedAt: v.optional(v.number()), currency: v.string(), sourceMessageId: v.optional(v.string()),
    status: purchaseStatus, isExample: v.optional(v.boolean()),
  }).index("by_user", ["userId"]).index("by_user_domain_order", ["userId", "merchantDomain", "orderRef"]),

  /** Line items. `returned` is set only by the user, never by extraction (D15). */
  items: defineTable({
    purchaseId: v.id("purchases"), userId: v.id("users"), name: v.string(), unitCents: v.number(), qty: v.number(),
    productUrl: v.optional(v.string()), returned: v.boolean(), returnedAt: v.optional(v.number()),
  }).index("by_purchase", ["purchaseId"]).index("by_user", ["userId"]),

  /** Immutable policy snapshots; refresh inserts a new row (D17). */
  policies: defineTable({
    userId: v.id("users"), merchantDomain: v.string(), kind: policyKind, windowDays: v.optional(v.number()), channel,
    contactEmail: v.optional(v.string()), passage: v.string(), passageStart: v.optional(v.number()), sourceUrl: v.string(),
    retrievedAt: v.number(), confidence: v.number(), confirmedByUser: v.boolean(), note: v.optional(v.string()),
    isExample: v.optional(v.boolean()),
  }).index("by_user_domain_kind", ["userId", "merchantDomain", "kind"]),

  /** One observation of a product page. observedCents undefined = no usable price (D16). */
  priceChecks: defineTable({
    itemId: v.id("items"), userId: v.id("users"), observedCents: v.optional(v.number()), currency: v.optional(v.string()),
    confidence: v.optional(v.number()), variantMatch: v.optional(variantMatch), observedAt: v.number(), sourceUrl: v.string(),
    note: v.optional(v.string()),
  }).index("by_item", ["itemId"]),

  /** Money the store owes on one item for one reason. Balance is derived from ledgerEvents, never stored. */
  claims: defineTable({
    purchaseId: v.id("purchases"), itemId: v.id("items"), userId: v.id("users"), type: claimType, expectedCents: v.number(),
    status: claimStatus, windowEndsAt: v.optional(v.number()), policyId: v.optional(v.id("policies")), threadId: v.optional(v.string()),
    token: v.string(), version: v.number(), attentionAt: v.optional(v.number()), openedFromPriceCheckId: v.optional(v.id("priceChecks")),
    sendUnknown: v.optional(v.boolean()), isExample: v.optional(v.boolean()),
  }).index("by_user", ["userId"]).index("by_item", ["itemId"]).index("by_token", ["token"]).index("by_thread", ["threadId"]),

  /** Append-only facts about money. Only user confirmation creates confirmed_credit (Inv 3). */
  ledgerEvents: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), kind: eventKind, cents: v.number(), evidence: v.string(),
    idempotencyKey: v.optional(v.string()),
  }).index("by_claim", ["claimId"]).index("by_key", ["idempotencyKey"]),

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
    userId: v.optional(v.id("users")), claimId: v.optional(v.id("claims")), route: v.optional(processedRoute),
    summary: v.optional(v.string()), payload: v.optional(v.any()),
  }).index("by_external", ["externalId"]).index("by_status", ["status"]).index("by_user_status", ["userId", "status"]),
});
