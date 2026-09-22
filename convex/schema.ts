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
/**
 * Ledger event kinds; `lib/ledger.EVENT_KINDS` is the same set and every reader switches on it exhaustively
 * (HC-3). M10 adds the provisional kinds (contract rev 5 §3.2): never part of `unresolved`, never a status change.
 */
export const eventKind = v.union(
  v.literal("promised_credit"), v.literal("confirmed_credit"), v.literal("later_debit"),
  v.literal("provisional_credit"), v.literal("provisional_released"),
);
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

// ===================== M10 (wave 1) — shared validators =====================
// Contract M01 rev 5 §2.4. Additive only: nothing below renames or narrows an
// existing field. Every NEW index is named `by_<f1>_and_<f2>…` with each
// field's trailing `Id` dropped (HC-19; schema.test.ts derives and checks it).

/** The 25 mission scenarios (mission §11). A scenario id never implies an active rule pack. */
export const scenarioId = v.union(
  v.literal("R01"), v.literal("R02"), v.literal("R03"), v.literal("R04"), v.literal("R05"),
  v.literal("R06"), v.literal("R07"), v.literal("R08"), v.literal("R09"), v.literal("R10"),
  v.literal("R11"), v.literal("R12"), v.literal("R13"), v.literal("R14"), v.literal("R15"),
  v.literal("R16"), v.literal("R17"), v.literal("R18"), v.literal("R19"), v.literal("R20"),
  v.literal("R21"), v.literal("R22"), v.literal("R23"), v.literal("R24"), v.literal("R25"),
);
export const transactionCategory = v.union(v.literal("retail_order"), v.literal("air_travel"), v.literal("card_charge"));
export const transactionStatus = v.union(v.literal("needs_review"), v.literal("active"), v.literal("archived"));
/** Integer minor units + ISO 4217. Never signed; direction lives in the field or event kind (`lib/money.assertMoney`). */
export const money = v.object({ amountMinor: v.number(), currency: v.string() });

/** Where in a piece of evidence a value was read. `quote` ≤ 300 chars (asserted by the writer). */
export const evidenceLocator = v.union(
  v.object({ kind: v.literal("text_span"), start: v.number(), end: v.number(), quote: v.string() }),
  v.object({ kind: v.literal("pdf_page"), page: v.number(), quote: v.optional(v.string()) }),
  v.object({
    kind: v.literal("email_header"),
    header: v.union(v.literal("from"), v.literal("date"), v.literal("subject"), v.literal("message_id")),
  }),
  v.object({ kind: v.literal("whole_document") }),
);
/** DA-A-6: three-valued from day one (no boolean→union migration later). Semantics implemented in M23 (§2.6). */
export const quoteStatus = v.union(v.literal("verified"), v.literal("unverified"), v.literal("unverifiable"));

/**
 * A fact's typed value. `text` ≤ 500 chars and passes through `lib/pan.maskPans` (D142);
 * `identifier` is validated by its scheme's own format and NEVER goes through the free-text masker;
 * `user_unknown` is "I don't know" (≠ missing, ≠ false; never a known cell — §2.5).
 */
export const factValue = v.union(
  v.object({ kind: v.literal("money"), amountMinor: v.number(), currency: v.string() }),
  v.object({ kind: v.literal("instant"), epochMs: v.number() }),
  v.object({ kind: v.literal("local_date"), date: v.string(), timeZone: v.optional(v.string()) }),
  v.object({ kind: v.literal("local_datetime"), dateTime: v.string(), timeZone: v.optional(v.string()) }),
  v.object({ kind: v.literal("code"), code: v.string() }),
  v.object({ kind: v.literal("text"), text: v.string() }),
  v.object({ kind: v.literal("identifier"), scheme: v.string(), value: v.string() }),
  v.object({ kind: v.literal("bool"), value: v.boolean() }),
  v.object({ kind: v.literal("count"), n: v.number() }),
  v.object({ kind: v.literal("minutes"), minutes: v.number() }),
  v.object({ kind: v.literal("user_unknown") }),
);
export const factRowState = v.union(
  v.literal("observed"), v.literal("extracted_candidate"), v.literal("user_confirmed"),
  v.literal("derived"), v.literal("superseded"), v.literal("rejected"),
);
/** Provenance of a fact row. `derived.fromFactIds` ≤ 8 (asserted by the single writer `lib/facts/write.ts`). */
export const factSource = v.union(
  v.object({
    kind: v.literal("evidence"), evidenceId: v.id("evidence"), locator: evidenceLocator,
    quoteStatus, extractorVersion: v.string(),
  }),
  v.object({ kind: v.literal("user") }),
  v.object({ kind: v.literal("price_check"), priceCheckId: v.id("priceChecks") }),
  v.object({ kind: v.literal("derived"), ruleId: v.string(), fromFactIds: v.array(v.id("facts")) }),
);

export const evidenceKind = v.union(
  v.literal("email"), v.literal("paste"), v.literal("upload"), v.literal("manual_note"), v.literal("system_capture"),
);
export const evidenceDocType = v.union(
  v.literal("order_confirmation"), v.literal("receipt"), v.literal("refund_notice"), v.literal("shipping_notice"),
  v.literal("delivery_notice"), v.literal("delay_notice"), v.literal("e_ticket"), v.literal("itinerary_change_notice"),
  v.literal("cancellation_notice"), v.literal("baggage_report"), v.literal("expense_receipt"), v.literal("card_statement"),
  v.literal("merchant_correspondence"), v.literal("submission_proof"), v.literal("damage_photo"), v.literal("policy_page"),
  v.literal("other"), v.literal("unknown"),
);
export const evidenceChannel = v.union(
  v.literal("agentmail_forward"), v.literal("paste"), v.literal("upload"), v.literal("manual"), v.literal("system_capture"),
);
/** SEC-AI-6: who stands behind the content. `unverified_sender` never creates confirmed facts or case state. */
export const evidenceProvenance = v.union(
  v.literal("user_forwarded"), v.literal("user_pasted"), v.literal("user_uploaded"),
  v.literal("unverified_sender"), v.literal("system_capture"),
);
export const extractionStatus = v.union(
  /** DA-A-8: no user-declared docType yet → never extracted. */
  v.literal("awaiting_doc_type"),
  v.literal("not_requested"), v.literal("queued"), v.literal("running"), v.literal("succeeded"),
  v.literal("needs_review"), v.literal("failed"),
  /** card_statement, a text layer holding a card number (DA-A-8), or live extraction not approved (D145). */
  v.literal("store_only"),
  v.literal("needs_unlocked_copy"), v.literal("unreadable"), v.literal("over_page_cap"),
);
export const evidenceRetention = v.union(v.literal("active"), v.literal("content_deleted"));

export const incidentKind = v.union(
  v.literal("flight_cancelled"), v.literal("flight_schedule_changed"), v.literal("flight_renumbered_only"),
  v.literal("flight_delayed"), v.literal("denied_boarding"), v.literal("bag_delayed"), v.literal("bag_lost"),
  v.literal("bag_damaged"), v.literal("ancillary_not_provided"),
  v.literal("order_not_shipped_on_time"), v.literal("order_in_transit_delay"), v.literal("order_not_delivered"),
  v.literal("order_delivery_disputed"), v.literal("package_stolen_after_delivery"),
  v.literal("charge_duplicate"), v.literal("charge_wrong_amount"), v.literal("credit_not_posted"),
  v.literal("goods_not_delivered_as_agreed"), v.literal("charge_unauthorized"),
  v.literal("item_damaged"), v.literal("item_stolen"), v.literal("item_defective"), v.literal("return_refused"),
  v.literal("other"),
);
export const incidentStatus = v.union(v.literal("candidate"), v.literal("confirmed"), v.literal("withdrawn"));

export const authorityClass = v.union(
  v.literal("legal_entitlement"), v.literal("contract_benefit"), v.literal("merchant_promise"),
  v.literal("settlement_or_program"), v.literal("goodwill"),
);
/**
 * Mission §9 outcomes. docs/rules/README.md alias table, applied by M08's fixture loader:
 * `likely_eligible_missing_evidence` → `likely_eligible`; `not_yet_due` (D147(6), README rule 4) maps 1:1
 * (rev 5.2). `not_yet_due` = the path is not ripe yet; it carries a `reevaluate` date or event and is NEVER
 * `not_eligible`, never approvable and never in a money tile.
 */
export const evaluationOutcome = v.union(
  v.literal("eligible"), v.literal("likely_eligible"), v.literal("possible_contract_benefit"), v.literal("needs_facts"),
  v.literal("manual_review"), v.literal("not_eligible"), v.literal("deadline_passed"), v.literal("source_unverified"),
  v.literal("unsupported"),
  v.literal("not_yet_due"),
);
/**
 * rev 5.2 (D147(6)): when a `not_yet_due` path should be re-evaluated. At least one of the two is set (asserted by
 * the writer). `at` is an ISO local date "YYYY-MM-DD" (fixture `reevaluate_at`); `when` names an event (fixture
 * `reevaluate_when`, e.g. "MBR filed") that arrives as a fact change.
 */
export const reevaluate = v.object({ at: v.optional(v.string()), when: v.optional(v.string()) });
export const tri = v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown"));
export const remedyType = v.union(
  v.literal("price_difference"), v.literal("cash_refund"), v.literal("statement_credit"), v.literal("reimbursement"),
  v.literal("fee_refund"), v.literal("billing_correction"), v.literal("voucher"), v.literal("points"), v.literal("repair"),
  v.literal("replacement"), v.literal("service_credit"),
);
export const cashClass = v.union(v.literal("cash"), v.literal("non_cash"), v.literal("provisional"));
export const overlapRelation = v.union(
  v.literal("alternative"), v.literal("coordinated"), v.literal("primary_secondary"),
  v.literal("complementary"), v.literal("distinct_lines"),
);
export const opportunityStatus = v.union(
  v.literal("open"), v.literal("case_open"), v.literal("dismissed"), v.literal("closed"), v.literal("superseded"),
);
/** DA-A-5: `overdue` exists only for counterparty obligations. */
export const deadlineStatus = v.union(
  v.literal("open"), v.literal("passed"), v.literal("overdue"), v.literal("unknown_anchor"),
  v.literal("disputed_anchor"), v.literal("beyond_calendar"), v.literal("not_applicable"),
);
export const obligor = v.union(v.literal("user"), v.literal("counterparty"));
export const manualChannel = v.union(
  v.literal("postal_mail"), v.literal("web_form"), v.literal("portal"), v.literal("phone"),
  v.literal("chat"), v.literal("in_person"),
);
/**
 * DA-A-9: the channel on which a claim counts as submitted (`lib/claimState` projects delivery from it).
 * Declared as one FLAT union of `email` + every `manualChannel` member so the validator has a single level.
 */
export const requiredChannel = v.union(v.literal("email"), ...manualChannel.members);

/** DA-A-15: a reference to a fact CELL by value coordinates — never a row id, so hashes survive re-confirmation. */
export const factRef = v.object({ subjectKey: v.string(), key: v.string() });
/** rev 5 (N6): resolved cell status (§2.5) and a bound fact's value, stored so an approved basis stays displayable. */
export const cellStatus = v.union(
  v.literal("confirmed"), v.literal("observed"), v.literal("derived"), v.literal("candidate"),
  v.literal("conflicting"), v.literal("user_unknown"), v.literal("missing"),
);
export const boundFactValue = v.object({
  subjectKey: v.string(), key: v.string(), status: cellStatus, value: v.optional(factValue),
});
export const sourceRef = v.object({ sourceId: v.string(), passageId: v.string(), url: v.string(), effective: v.string() });
export const conditionResult = v.object({
  id: v.string(), label: v.string(), result: tri,
  kind: v.union(
    v.literal("applicability"), v.literal("requirement"), v.literal("exclusion"), v.literal("timing"), v.literal("evidence"),
  ),
  facts: v.array(factRef), sourcePassageId: v.optional(v.string()), note: v.optional(v.string()),
});
/** DA-A-2 / DA-A-24: only DECISIVE unknowns are listed; `class: "assumption"` never sets factsKnown. */
export const missingFact = v.object({
  subjectKey: v.string(), key: v.string(),
  reason: v.union(v.literal("missing"), v.literal("candidate_unconfirmed"), v.literal("conflicting"), v.literal("user_unknown")),
  class: v.union(v.literal("required"), v.literal("assumption")),
  neededFor: v.array(v.string()),
});
export const assumption = v.object({ id: v.string(), text: v.string(), changesOutcomeIf: v.string() });
/** `inputs` ≤ 12. `cap` is a LIMIT, never the estimate (mission §14). */
export const amountCalc = v.object({
  estimate: money,
  basis: v.union(v.literal("exact_formula"), v.literal("documented_total"), v.literal("user_claimed")),
  formula: v.string(),
  inputs: v.array(v.object({ label: v.string(), value: v.string(), fact: v.optional(factRef) })),
  cap: v.optional(v.object({ amount: money, sourcePassageId: v.string(), note: v.string() })),
});
export const deadlineResult = v.object({
  id: v.string(), label: v.string(), obligor, status: deadlineStatus,
  dueAt: v.optional(v.number()), dueLocalDate: v.optional(v.string()), timeZone: v.optional(v.string()),
  mustBe: v.union(v.literal("received"), v.literal("sent"), v.literal("filed"), v.literal("paid"), v.literal("n_a")),
  /** Counterparty only (DA-A-5). */
  overdueSince: v.optional(v.number()),
  /** D143.3: labelled "conservative act-by", NEVER dueAt. */
  advisoryActBy: v.optional(v.string()),
  basis: v.string(), anchor: v.optional(factRef), sourcePassageId: v.optional(v.string()),
});
export const dimensions = v.object({
  applies: tri, factsKnown: tri, evidenceSupports: tri, windowOpen: tri, amountCalculable: tri, readyForApproval: tri,
});
export const nextAction = v.union(
  v.object({ kind: v.literal("answer_questions"), keys: v.array(factRef) }),
  v.object({ kind: v.literal("add_evidence"), docTypes: v.array(evidenceDocType) }),
  v.object({ kind: v.literal("open_case") }),
  v.object({ kind: v.literal("continue_case"), claimId: v.id("claims") }),
  /** DA-A-25: automatic refund; watch the counterparty deadline. */
  v.object({ kind: v.literal("track") }),
  /** DA-A-5: counterparty deadline overdue. */
  v.object({ kind: v.literal("escalate"), reason: v.string() }),
  /** D143.2: e.g. ticket agent is merchant of record. */
  v.object({ kind: v.literal("request_refund") }),
  /** D143.1: user-initiated ask when the source is unverified. */
  v.object({ kind: v.literal("ask_anyway"), reason: v.string() }),
  v.object({ kind: v.literal("manual_review"), reason: v.string() }),
  v.object({ kind: v.literal("none"), reason: v.string() }),
  /** rev 5.2: `not_yet_due` → "check again on <date>" / "after <event>". */
  v.object({ kind: v.literal("wait"), reevaluate }),
);
export const nonCashKind = v.union(
  v.literal("voucher"), v.literal("points"), v.literal("repair"), v.literal("replacement"),
  v.literal("service_credit"), v.literal("fee_waiver"), v.literal("other"),
);
/**
 * What an outbound approval is bound to (mission §6 outbound authorization). `contextHash` is the canonical
 * hash (`lib/canonical.ts`) of every field below — VALUES, not row ids (DA-A-15). `attachments` ≤ 10 ([] in
 * Phase-1 email). `engineVersion` is populated from wave 2 (DA-A-23) and optional so wave 1 needs no migration.
 */
export const approvalBinding = v.object({
  contextHash: v.string(),
  claimVersion: v.number(),
  amount: money,
  opportunityId: v.optional(v.id("opportunities")),
  evaluationId: v.optional(v.id("evaluations")),
  ruleId: v.optional(v.string()),
  ruleVersion: v.optional(v.number()),
  engineVersion: v.optional(v.string()),
  /** Hash over (subjectKey, key, status, value) of every bound fact (§2.5). */
  boundFactsHash: v.optional(v.string()),
  attachments: v.array(v.object({ evidenceId: v.id("evidence"), contentHash: v.string() })),
});

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
    // M10 (wave 1) links, all optional so every stored claim still validates (contract §2.4).
    /** The category-neutral parent (M11 `ensurePurchaseTransaction`); set by linking or scenario-case opening. */
    transactionId: v.optional(v.id("transactions")),
    /** The opportunity this claim pursues; set by the mandatory lazy link (DA-A-3) or `openCase`. */
    opportunityId: v.optional(v.id("opportunities")),
    scenarioId: v.optional(scenarioId),
    remedyKey: v.optional(v.string()),
    /** The claim's own ISO 4217 currency (`lib/money.claimCurrency` falls back to the purchase's for legacy rows). */
    currency: v.optional(v.string()),
    /** Loss keys (§3.3) this claim pursues, ≤ 20; the overlap guard and loss-component totals key on them. */
    lossKeys: v.optional(v.array(v.string())),
    /** DA-A-9: submitted / Asked / expired are projected only from artifacts on this channel (`lib/claimState`). */
    requiredChannel: v.optional(requiredChannel),
  }).index("by_user", ["userId"]).index("by_item", ["itemId"]).index("by_token", ["token"]).index("by_thread", ["threadId"])
    .index("by_item_type_status", ["itemId", "type", "status"])
    /** F3 (D103): lets `tracking.overview` fetch every price_adjustment claim
     * for a whole purchase's items in one range read, instead of one query
     * per item -- see tracking.ts's docstring for the "too many index
     * ranges read" failure this replaces. */
    .index("by_purchase_type", ["purchaseId", "type", "status"])
    /** M10: the claim linked to an opportunity (evaluation retention, DA-A-32; link checks, DA-A-3). */
    .index("by_opportunity", ["opportunityId"])
    /** M10: active claims on one transaction (overlap guard, DA-A-4; evidence retention "has a case", DA-A-7). */
    .index("by_transaction_and_status", ["transactionId", "status"]),

  /**
   * Append-only facts about money. Idempotency keys are scoped per claim (D38). Only user confirmation creates
   * confirmed_credit (Inv 3; SEC-MF-5 as amended by D145: only `claims.ts` writes it). `currency` (M10) is required
   * of every NEW writer and must equal the claim's currency; legacy rows carry none.
   */
  ledgerEvents: defineTable({
    claimId: v.id("claims"), userId: v.id("users"), kind: eventKind, cents: v.number(), evidence: v.string(),
    idempotencyKey: v.optional(v.string()),
    currency: v.optional(v.string()),
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
    /** M10 (§6): the full approval context — amount, rule/evaluation, bound-fact hash — for opportunity-linked claims. */
    binding: v.optional(approvalBinding),
    /** M10 (§6): the hash the user approved; a send re-derives it and refuses on a mismatch. */
    approvedHash: v.optional(v.string()),
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

  // ===================== M10 (wave 1) — new tables (contract §2.4) =====================

  /**
   * The category-neutral transaction (§2.2): 1:1 with `purchases` for retail (unique through `by_purchase`,
   * written by M11's `ensurePurchaseTransaction`), standalone for flights and card charges. `naturalKey` is the
   * owner-scoped dedupe key (card lines include a per-line identity, DA-A-30). `relatedTransactionId` is set only
   * server-side after `ownedTransaction` (DA-A-29). `liveFactCount` counts non-superseded fact rows (DA-A-36).
   */
  transactions: defineTable({
    userId: v.id("users"), category: transactionCategory, status: transactionStatus,
    counterpartyName: v.string(), counterpartyDomain: v.optional(v.string()),
    currency: v.string(), totalMinor: v.optional(v.number()), transactedAt: v.optional(v.number()),
    naturalKey: v.optional(v.string()),
    purchaseId: v.optional(v.id("purchases")),
    relatedTransactionId: v.optional(v.id("transactions")),
    sourceEvidenceId: v.optional(v.id("evidence")),
    liveFactCount: v.number(),
    isExample: v.optional(v.boolean()),
  }).index("by_user_and_status", ["userId", "status"])
    .index("by_user_and_natural_key", ["userId", "naturalKey"])
    .index("by_purchase", ["purchaseId"]),

  /**
   * Typed facts about a transaction (§2.5). A cell is (transactionId, subjectKey, key); its rows carry a state
   * and a provenance. Single writer `lib/facts/write.ts putFact` (M11, grep-tested). An unchanged observation
   * patches `lastObservedAt` instead of inserting (DA-A-36).
   */
  facts: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    subjectKey: v.string(), key: v.string(),
    state: factRowState, value: factValue, source: factSource,
    supersededBy: v.optional(v.id("facts")),
    overridesObserved: v.optional(v.boolean()),
    recordedAt: v.number(),
    lastObservedAt: v.optional(v.number()),
    isExample: v.optional(v.boolean()),
  }).index("by_transaction_and_subject_key_and_key", ["transactionId", "subjectKey", "key"])
    /** M11 (lead-approved): bounded reads of one state's rows on a transaction, e.g. every current candidate. */
    .index("by_transaction_and_state_and_subject_key_and_key", ["transactionId", "state", "subjectKey", "key"])
    .index("by_user", ["userId"]),

  /** What went wrong, kept apart from the transaction's original facts (mission §7). */
  incidents: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    kind: incidentKind, status: incidentStatus,
    reportedBy: v.union(v.literal("user"), v.literal("extraction")),
    sourceEvidenceId: v.optional(v.id("evidence")), isExample: v.optional(v.boolean()),
  }).index("by_transaction", ["transactionId"]).index("by_user", ["userId"]),

  /**
   * Ingested content with provenance (§2.6). `storageId` is written only by the upload httpAction's finalize
   * mutation (SEC-UP-1); `contentHash` is lowercase hex SHA-256 (DA-A-27); `text` is masked (D142) and
   * ≤ 60,000 chars; `fileName` ≤ 200 chars, sanitized. Dedupe on (userId, contentHash) against `active` rows only
   * (DA-A-20). Only `docTypeDeclaredBy: "user"` unlocks upload extraction (DA-A-8).
   */
  evidence: defineTable({
    userId: v.id("users"), transactionId: v.optional(v.id("transactions")),
    kind: evidenceKind, docType: evidenceDocType,
    docTypeDeclaredBy: v.optional(v.union(v.literal("user"), v.literal("classifier"))),
    sourceChannel: evidenceChannel, provenance: evidenceProvenance,
    processedEventId: v.optional(v.id("processedEvents")),
    storageId: v.optional(v.id("_storage")),
    contentHash: v.string(),
    mimeType: v.optional(v.string()), sizeBytes: v.optional(v.number()), pageCount: v.optional(v.number()),
    fileName: v.optional(v.string()),
    text: v.optional(v.string()),
    headers: v.optional(v.object({
      from: v.optional(v.string()), subject: v.optional(v.string()), date: v.optional(v.string()),
      messageId: v.optional(v.string()),
    })),
    receivedAt: v.number(),
    /** DA-A-7: the user chose to keep it past the retention window. */
    pinnedAt: v.optional(v.number()),
    extractionStatus, extractionAttempts: v.number(),
    extractionStartedAt: v.optional(v.number()), extractorVersion: v.optional(v.string()),
    extractionSummary: v.optional(v.string()),
    /** DA-A-6: a deterministic text layer is present (PDF text / email / paste). */
    hasTextLayer: v.optional(v.boolean()),
    retention: evidenceRetention, isExample: v.optional(v.boolean()),
  }).index("by_user_and_content_hash", ["userId", "contentHash"])
    .index("by_transaction", ["transactionId"])
    .index("by_storage", ["storageId"])
    .index("by_extraction_status_and_extraction_started_at", ["extractionStatus", "extractionStartedAt"])
    /** DA-A-7 retention sweep. */
    .index("by_retention_and_received_at", ["retention", "receivedAt"]),

  /**
   * The stable identity of "remedy × loss × transaction" (§2.1, §2.8). `dedupeKey` is
   * `${transactionId}|${scenarioId}|${remedyKey}|${subjectKey}|${incidentId ?? "-"}` and never includes the rule
   * version. `nextDeadlineAt` holds USER-obligor deadlines only (DA-A-5). `lossKeys` ≤ 20.
   */
  opportunities: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    scenarioId, remedyKey: v.string(), subjectKey: v.string(), incidentId: v.optional(v.id("incidents")),
    dedupeKey: v.string(),
    status: opportunityStatus,
    currentEvaluationId: v.optional(v.id("evaluations")),
    ruleId: v.string(), ruleVersion: v.number(), outcome: evaluationOutcome,
    authorityClass, remedyType, cashClass,
    estimate: v.optional(money),
    nextDeadlineAt: v.optional(v.number()),
    nextCounterpartyDueAt: v.optional(v.number()),
    lossKeys: v.array(v.string()),
    activeClaimId: v.optional(v.id("claims")),
    lastEvaluatedAt: v.number(), isExample: v.optional(v.boolean()),
  }).index("by_user_and_dedupe_key", ["userId", "dedupeKey"])
    .index("by_transaction", ["transactionId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_status_and_next_deadline_at", ["status", "nextDeadlineAt"])
    .index("by_scenario_and_rule_version", ["scenarioId", "ruleVersion"]),

  /**
   * Append-only evaluation history, one row per changed `resultHash` (§4, DA-A-32). `factSnapshotHash` is stored
   * alongside but is NOT part of `resultHash`. Array bounds asserted by the single writer: conditions ≤ 64,
   * missingFacts ≤ 32, assumptions ≤ 16, disqualifiers ≤ 16, deadlines ≤ 8, sourceRefs ≤ 8, overlap ≤ 8,
   * explanation ≤ 12, boundFacts ≤ 32 (rev 5, N6: the pack's bound-fact values, written on every row).
   */
  evaluations: defineTable({
    userId: v.id("users"), opportunityId: v.id("opportunities"), scenarioId,
    ruleId: v.string(), ruleVersion: v.number(), engineVersion: v.optional(v.string()),
    factSnapshotHash: v.string(),
    resultHash: v.string(),
    evaluatedAt: v.number(),
    trigger: v.union(
      v.literal("fact_change"), v.literal("observation"), v.literal("rule_version"), v.literal("user_request"),
      v.literal("case_open"), v.literal("approval_check"), v.literal("migration"), v.literal("link"),
    ),
    outcome: evaluationOutcome, dimensions,
    conditions: v.array(conditionResult), missingFacts: v.array(missingFact), assumptions: v.array(assumption),
    disqualifierIds: v.array(v.string()), amount: v.union(amountCalc, v.null()),
    deadlines: v.array(deadlineResult), sourceRefs: v.array(sourceRef),
    overlap: v.array(v.object({ withScenario: scenarioId, withRemedyKey: v.string(), relation: overlapRelation })),
    nextAction, explanation: v.array(v.string()),
    boundFacts: v.optional(v.array(boundFactValue)),
    /** rev 5.2 (D147(6)): set iff `outcome === "not_yet_due"`. */
    reevaluate: v.optional(reevaluate),
  }).index("by_opportunity", ["opportunityId"]).index("by_user", ["userId"]),

  /**
   * Non-cash remedies (vouchers, points, repairs, replacements…): append-only, never summed with cash
   * (mission §6). `faceValue` is shown per item only, never in a total (SEC-MF-1, I5). Idempotency keys are
   * scoped per claim, like the ledger (D38).
   */
  nonCashRemedies: defineTable({
    userId: v.id("users"), claimId: v.id("claims"), kind: nonCashKind, description: v.string(),
    faceValue: v.optional(money), state: v.union(v.literal("promised"), v.literal("received")),
    idempotencyKey: v.string(), recordedAt: v.number(),
  }).index("by_claim_and_idempotency_key", ["claimId", "idempotencyKey"]).index("by_user", ["userId"]),
});
