# M01 — Transaction-recovery architecture contract (proposed, pre-DA)

Author: `opus-product-architect`, self-reported model Opus 5.5 / `claude-opus-5-5`. Written 2026-09-23 against `main` at `5cc326d` (code identical to `18f3b46`). Governing mission: `docs/prompts/2026-09-23-recoup-us-transaction-recovery.md` ("mission §N"). Convex rules: `convex/_generated/ai/guidelines.md` ("guidelines"). Document B: `docs/research/usa-receipt-compensation-opportunities.md`.

Status: **proposal for devil's-advocate checkpoint A (M05)**. Not binding until the lead records the decisions in §12 in `docs/team/DECISIONS.md`. Nothing here claims that a proposed table, function, or rule already exists. Legal thresholds are never set here. Every legal number is a rule-pack parameter supplied by M02 (`docs/rules/**`) from a first-party passage. Where this document quotes document B's figures, it labels them "candidate, verify in M02".

Reading order for implementers: §2 (schema) → §3 (money) → §4 (evaluator/deadline signatures) → your slice's rows in §10 and §11.

---

## 1. Current-state map

### 1.1 Mission §7 concepts mapped to existing code

| Mission §7 concept | What exists today (file) | Reuse as-is | Needs an adapter | Missing |
|---|---|---|---|---|
| **Transaction** | `purchases` (schema.ts:87) is a retail order: `merchant`, `merchantDomain` (required, normalized host), `orderRef?`, `purchasedAt?` (required by `purchases.confirm`, D25), `currency` (string), `sourceMessageId?`, `status` needs_review/active/archived, `isExample?`. `watches` is pre-purchase intent. `watches.markBought` (watches.ts:559) converts a watch into a purchase. | `purchases` stays the retail order record, together with the price-watch, board, and tracking code that consume it. | A category-neutral parent row that points 1:1 at a purchase (`transactions.purchaseId`) so retail joins the new model without rewriting purchases. | Non-retail categories (flight booking, card charge), payment-method classification, jurisdiction, shipment/delivery/notice dates, and promise-vs-outcome. **The UI has no manual transaction entry**: `purchases.create` is public but no page calls it (verified by grepping `src/`). |
| **Asset / service details** | `items` (name, unitCents, qty, productUrl, returned, imageUrl). Variant is implicit in the name plus the price check's `variantMatch`. | `items` for retail line items. | — | SKU/model/serial, flight segments/PNR/bag tag, tracking number, exact card product. |
| **Evidence** | `processedEvents.payload` holds forwarded or pasted email text. **Retention strips it after 30 days** (`RETENTION_PAYLOAD_DAYS`, limits.ts:280). `policies` holds passage + sourceUrl + retrievedAt + verbatim offset. `priceChecks` holds sourceUrl + observedAt. `replies` holds summaries (the body lives in the AgentMail component). | `policies` and `priceChecks` stay as R01 observation sources. `lib/passage.verifyPassage` becomes the quote verifier for every extracted fact. | Intake must copy the email text into an evidence row before the 30-day payload strip removes it. | File storage (no `_storage` use anywhere today), content hash, per-field provenance, owner-scoped dedupe, links from evidence to transactions, retention and deletion state. |
| **Fact** | Implicit only. A `needs_review` purchase holds extracted candidates; `purchases.confirm` stands in for user confirmation; `priceChecks.observedCents` is an observation; `policies.confirmedByUser` is per snapshot. | The confirmed purchase and item fields, read as user-confirmed through an adapter (§2.5). | `lib/facts/legacyRetail.ts` synthesizes cells from purchase/item/priceCheck rows without writing any facts. | Fact rows, fact states (observed / candidate / confirmed / derived / missing / conflicting / superseded), and "I don't know" answers. |
| **Incident** | None. `items.returned`/`returnedAt` is a user-set event. A price drop is an observation, not an incident. | — | — | The whole concept. |
| **Rule pack** | `policies` is a per-user, LLM-extracted merchant snapshot (windowDays, channel, contactEmail, verbatim passage). It is immutable per D17. The rule logic is hard-coded in `priceWatch.watchWindow`/`recordCheck` and `lib/ledger.priceDropCents` (a threshold of max($1, 2%)). | Merchant policy snapshots become a *parameter source* for R01 (§2.7). | R01 v1 pack wraps the existing logic byte-for-byte (§10 R01 parity). | Versioned, reviewed rule packs with provenance. Today the **latest** snapshot is applied to every purchase, whatever its date (mission §8 temporal accuracy; RULES-COVERAGE R01 "known limit"). |
| **Opportunity** | None. A `detected` claim opened by `priceWatch.recordCheck` is the de facto opportunity, deduped by `hasOpenPriceClaim` + `settledPriceClaimCents` (priceWatch.ts:141–157). | The dedupe semantics (no second claim for the same drop; a further drop after payout is a new, smaller ask). | — | Opportunity rows, evaluation history, missing facts, assumptions, overlap. |
| **Claim / case** | `claims` (schema.ts:247): **`purchaseId` and `itemId` are required**, `type` is price_adjustment/return_credit, `expectedCents`, a 9-value `status`, `version` (the "money version" drafts bind to), `token`, `threadId`, `policyId?`, `openedFromPriceCheckId?`, `isExample?`. D44 allows one active claim per (item, type) (`openClaim`, claims.ts:68–82). | All of it, including tokens, threads, versions, reminders, and dismiss. | Optional links: `transactionId`, `opportunityId`, `scenarioId`, `remedyKey`, `currency`, `lossKeys`. | Cases not anchored on a retail item; a denied outcome; claim currency (derived from `purchases.currency` today). |
| **Correspondence / submission** | `drafts` are versioned, and approval binds to {to, subject, body, claimVersion, draftVersion}, the newest draft (D58), and the recipient gate (D18). `approveAndSend` enqueues via AgentMail → `queued`; `reconcileSend` → `sent`/`failed`/`sendUnknown`. `replies` are classified (D21). `followUps` are reminder-only (D03/D28). `markPacketSent` sets the claim to `packet` with only a free-text note. | The email path unchanged: approval re-check, outbound id in the enqueue transaction, reconcile, reply routing (D23). | Approval binding extended to amount, facts, rule version, and attachments (§6). | Manual-channel packets, **user-recorded submission evidence** (today `packet` is asserted with a note alone), postal/portal recipients, delivered state, and attachments. |
| **Recovery events** | `ledgerEvents` (promised_credit, confirmed_credit, later_debit), integer cents, **no currency**, idempotency per claim (D38), `lib/ledger.balance`. | All kinds and the balance formula (`unresolved = expected − confirmed + debited`; over-credit preserved per D24; later debit ≤ net confirmed per D40). | Provisional-credit kinds (§3). | Provisional credits, non-cash remedies, currency on events, submitted amount. |
| **Jobs** | `processedEvents` (a received → processing → succeeded/failed/needs_review state machine with attempts, lease `processingStartedAt`, and an hourly retry cron), `mailLog`, the `watches.market*` state machine, `accountState`, `opsState` cursors, `usage` budgets, and the rate limiter. | The row-first status pattern, `opsState` cursors for resumable sweeps, and budgets. | Evidence extraction reuses the same pattern on evidence rows (§7). | Upload-extraction jobs, rule-version re-evaluation sweeps, and the deadline sweep. |

### 1.2 Hard constraints found in the code (each is a design input, not a suggestion)

- **HC-1 `claims.purchaseId` and `claims.itemId` are required** (schema.ts:248). Code that dereferences them unconditionally: `claims.get` (claims.ts:441–442), `drafts.context` (drafts.ts:169–170), `drafts.approveAndSend` (drafts.ts:459–461; it throws "Purchase not found" and reads `purchase.isExample` and `purchase.merchantDomain`), `followUps.reminderFireAt` (followUps.ts:22), `replies.expectedDomain` (replies.ts:62), `insights.activity` (insights.ts:313–314, 333), and `src/pages/Claim.tsx:86,97` (`currency = purchase?.currency ?? "USD"`). Code that reads claims through purchase- or item-keyed indexes, and so can never see an item-less claim: `purchases.board`, `tracking.overview` (`by_purchase_type`), `priceWatch` (`by_item_type_status`, `by_item`), and `intake.applyRefund` (`by_item`).
- **HC-2 The ledger is keyed by `claimId` only and has no currency.** A claim's currency is `purchases.currency`. Balance math lives in `convex/lib/ledger.ts:38 balance()`, `lib/balance.ts claimBalance()`, and `netRecovered()` (ledger.ts:120). Totals are computed in three places **with two different recovered formulas**: `purchases.board` (purchases.ts:519, `netRecovered`, clamped to `[0, expected]`, per D39, and **summed across currencies**; the board totals are not rendered today, but they are asserted in tests) and `tracking.overview` (tracking.ts:254–255, `max(confirmed − debited, 0)` **unclamped**, per currency, which is what StatCards renders).
- **HC-3 `balance()` treats every kind that is not promised or confirmed as a debit** (`else debited += e.cents`, ledger.ts:46). Widening `eventKind` without an exhaustive rewrite of `balance()` and `statusAfterEvent()` silently turns new kinds into debits. TypeScript catches it only because `LedgerEvent.kind` is hand-typed; the rewrite must be in the same commit.
- **HC-4 The recipient gate is bound to retail policy snapshots.** `drafts.confirmedContactFor(userId, purchase.merchantDomain)` (drafts.ts:105) prefills or waives `recipientConfirmed` only from a user-confirmed `policies.contactEmail`. There is no equivalent source for airlines or issuers.
- **HC-5 Approval binding covers {to, subject, body, claimVersion, draftVersion, newest draft} only.** It does not cover amount (covered indirectly, because `claim.version` bumps on every ledger event and on `adjustExpected`), facts, rule version, or attachments.
- **HC-6 `markPacketSent` records a manual channel as done on the user's word** (drafts.ts:756). The claim becomes `packet`, which `purchases.board` counts as `asked` (purchases.ts:522). "Prepared" and "submitted" are not distinguished.
- **HC-7 A single overloaded `claims.status`** mixes workflow (detected/drafted), delivery (queued/sent plus `sendUnknown`), recovery (promised/confirmed/reopened), and terminal (dismissed). The UI (`StatusPill`, `StatusSteps`, `ItemTracker`, `Claim.tsx headline()`) switches on it.
- **HC-8 Money helpers assume two decimal places.** `toCents` multiplies by 100; `drafts.money()` and `src/lib/money.fmt` divide by 100. `assertCurrency` accepts any ISO code, so JPY or KWD would be mis-scaled.
- **HC-9 Intake silently defaults currency to USD** (intake.ts:444 `currency ?? "USD"`, summary "assumed USD"), and `purchases.confirm` takes no `currency` argument, so an assumed currency can never be corrected.
- **HC-10 `intake.applyRefund` can record a promise in a foreign currency** on a claim denominated in the purchase's currency. `currency = safeCurrency(credit.currency) ?? purchase.currency` (intake.ts:585) is used only for display; the cents are written to the ledger whatever the currency. **This violates the mission §6 money invariant today → fix in M13.**
- **HC-11 Temporal accuracy.** `latestPolicy()` (lib/latestPolicy.ts) applies the newest confirmed snapshot to purchases of any date. Legacy R01 windows use exact 24-hour multiples from the purchase instant (`windowEndsAt`, ledger.ts), not calendar days.
- **HC-12 Account export and purge list tables explicitly** (account.ts:138 `EXPORT_TABLES`, :165 `PURGE_STEPS`, `TABLE_SPECS`). Every new user-owned table must be added, needs a `userId`-prefixed index for a "direct" spec, and `_storage` blobs need their own delete step.
- **HC-13 Reactive queries must not read the clock.** D73 uses `watches.assertCoarseNow`, 5-minute steps. Deadline displays take a coarse `now` argument; authoritative checks run in mutations.
- **HC-14 Read budgets.** A transaction may read at most 4,096 index ranges (D103/D107/D126). Every new dashboard read is bounded by rows actually read and reports `truncated` on a real cut.
- **HC-15 Tombstone gates.** `requireUserId` refuses deleted accounts. Every scheduled or internal writer must call `isTombstoned` at write time (D87/D124).
- **HC-16 Examples** carry `isExample` on purchases, claims, and policies; totals exclude them; example claims can never be sent (drafts.ts:461). New tables inherit all of this.
- **HC-17 The follow-up delay is retail-specific**: `max(7 days, returns window)` (followUps.ts:17). The drafting prompt is retail-specific ("do not mention laws or chargebacks", drafts.ts:198).
- **HC-18 AgentMail `sendMessage` attachments are inline strings** (`@agentmail/convex` 0.1.0 `SendArgs.attachments[].content: string`) and are stored in the component's `outboundMessages` document, which is subject to Convex's 1 MiB document limit.
- **HC-19 Index naming.** The repo uses `by_user_domain_order`, `by_item_type_status`, and `by_purchase_type` (the last one covers 3 fields, including `status`, so its name omits a field). The guidelines require every field in the name, joined by `_and_`. **Decision: every NEW index uses `by_<f1>_and_<f2>…`, with each field's trailing `Id` dropped (so `userId` becomes `user`, matching the repo's `by_user`/`by_claim`), and lists every field. Existing indexes are not renamed**, because a rename means an index rebuild plus code churn with no behaviour gain.
- **HC-20 File ownership.** One writer per file; schema.ts, http.ts, convex.config.ts, App.tsx, and package.json each have exactly one owner per wave (mission §5, D137).

---

## 2. Smallest compatible architecture

### 2.1 Shape in one paragraph

A new category-neutral **`transactions`** parent points 1:1 at an existing `purchases` row for retail and stands alone for flights and card charges. **Facts** are the evaluation truth. They are typed values with a closed, per-domain key catalogue and a row state, and they hang off a transaction and a validated `subjectKey` (the transaction itself, an item, a segment, a bag, an expense line, a shipment, a charge, or an incident). Legacy retail values are read into the same typed snapshot by an adapter; nothing is rewritten. **Evidence** rows own uploaded or ingested content (Convex `_storage` plus a hex SHA-256 hash plus provenance). **Incidents** record what went wrong, separately from the original transaction facts. **Rule packs** are immutable, versioned TypeScript modules with committed provenance metadata; their evaluators are pure functions. **Evaluations** are append-only DB rows that record the rule id/version, the fact-snapshot hash, and the six-dimension result. **Opportunities** are the stable, deduped identity of "this remedy for this loss on this transaction", and each one projects its current evaluation. A user action (or, for R01 only, the legacy auto-open) turns an opportunity into a **claim**, with at most one active claim per opportunity and no active alternative for the same loss. Money flows through the **existing ledger**, extended with provisional kinds. Non-cash remedies get their own append-only table. Email keeps AgentMail. Manual channels get **packets** (approved content) and **submissions** (user-recorded proof).

### 2.2 Decision: a new `transactions` parent vs extending `purchases`

**New parent.** `purchases` has seven retail consumers: the price-watch sweep via `items`, `tracking.overview`, `insights.*`, `purchases.board`, the policy fetch scheduled on create/confirm, examples, and retention's priceCheck pruning. Putting flights or statement lines into `purchases` would force a category filter at every one of them, and **a missed filter fails silently**: flights would be scraped for prices and card charges would trigger policy research. TypeScript cannot catch that. A separate table cannot leak into those readers. The cost is two rows per retail order (purchase + transaction). The transaction row for a purchase is created **lazily** by the idempotent helper `ensurePurchaseTransaction(ctx, purchaseId)` (unique through `transactions.by_purchase`). It is called from `purchases.create` and `purchases.confirm` when a purchase becomes active, from `watches.markBought` indirectly (it creates an active purchase), and from any evaluation path. No mandatory backfill; see §8.

### 2.3 How a flight, a card-statement line, and an online order become claimable without breaking `purchaseId/itemId` consumers

- **Online order (R05):** already a retail purchase with items. Its transaction is category `retail_order` linked by `purchaseId`. Shipment facts hang off subject `shp:<n>`. Its claims keep `purchaseId`/`itemId` when they concern one item. An order-level remedy (cancel and refund the whole unshipped order) uses a scenario claim (below), with `purchaseId` set and `itemId` absent.
- **Flight booking (R02/R04):** a transaction with category `air_travel` and no purchase.
- **Card-statement line (R03):** a transaction with category `card_charge` (one charge; never a whole statement, per mission §13), optionally `relatedTransactionId` pointing to the retail or air transaction it paid for.
- **Claims:** wave 2 (M20) widens `claims.purchaseId` and `claims.itemId` to `v.optional(...)` and adds `claimType` literal `"scenario"`. A scenario claim must carry `transactionId`, `opportunityId`, `scenarioId`, `remedyKey`, `currency`, and `lossKeys`, enforced by the single writer `cases.openCaseForOpportunity`. **Why this is safe:** (a) widening a required field to optional is a schema widening, so every stored document still validates; (b) TypeScript turns every unconditional dereference listed in HC-1 into a compile error, which gives an exhaustive worklist; (c) every price/return reader queries through `by_item`/`by_purchase_type` equality on a concrete id, so a scenario claim with no item can never appear in those ranges; (d) R01/return claims keep both fields, so wave-1 behaviour is unchanged. **Rejected alternative:** synthetic purchase+item rows for non-retail cases would pollute the price-watch sweep, policy fetch, board, and tracking silently (see 2.2). A separate `cases` table would duplicate the ledger, drafts, reminders, and reply routing, all of which are keyed by `claimId`.
- **Wave 1 does not widen `purchaseId`/`itemId`.** R01 cases keep them. That keeps the wave-1 blast radius to additive fields.

### 2.4 Proposed schema additions (validator code)

Every validator is exported from `convex/schema.ts` (ARCHITECTURE_PATTERNS §Schema). **M10 writes the wave-1 block; M20 writes the wave-2 block.** Nothing renames or narrows an existing field.

```ts
// ===================== M10 (wave 1) — new shared validators =====================

/** R01..R25 exactly as docs/team/RULES-COVERAGE.md. Closed list, never renumbered. */
export const scenarioId = v.union(
  v.literal("R01"), v.literal("R02"), v.literal("R03"), v.literal("R04"), v.literal("R05"),
  v.literal("R06"), v.literal("R07"), v.literal("R08"), v.literal("R09"), v.literal("R10"),
  v.literal("R11"), v.literal("R12"), v.literal("R13"), v.literal("R14"), v.literal("R15"),
  v.literal("R16"), v.literal("R17"), v.literal("R18"), v.literal("R19"), v.literal("R20"),
  v.literal("R21"), v.literal("R22"), v.literal("R23"), v.literal("R24"), v.literal("R25"),
);

/** A category is added only when a slice needs it (no speculative categories). */
export const transactionCategory = v.union(
  v.literal("retail_order"), // 1:1 with a `purchases` row (purchaseId set)
  v.literal("air_travel"),   // R02, R04 now; R09/R12/R14/R15 later
  v.literal("card_charge"),  // R03: ONE charge / statement line, never a whole statement
);
export const transactionStatus = v.union(v.literal("needs_review"), v.literal("active"), v.literal("archived"));

/** Integer minor units of `currency` (ISO 4217). Never signed: direction is carried by the field or event kind (§3). */
export const money = v.object({ amountMinor: v.number(), currency: v.string() });

/** Where a fact's quote sits inside its evidence. `quote` ≤ 300 chars, verified verbatim (lib/passage.normalizeForMatch). */
export const evidenceLocator = v.union(
  v.object({ kind: v.literal("text_span"), start: v.number(), end: v.number(), quote: v.string() }),
  v.object({ kind: v.literal("pdf_page"), page: v.number(), quote: v.optional(v.string()) }),
  v.object({ kind: v.literal("email_header"), header: v.union(v.literal("from"), v.literal("date"), v.literal("subject"), v.literal("message_id")) }),
  v.object({ kind: v.literal("whole_document") }),
);

/** Typed fact values. The per-key spec in lib/facts/catalog.ts fixes WHICH variant a key accepts and its domain. */
export const factValue = v.union(
  v.object({ kind: v.literal("money"), amountMinor: v.number(), currency: v.string() }),
  v.object({ kind: v.literal("instant"), epochMs: v.number() }),
  v.object({ kind: v.literal("local_date"), date: v.string(), timeZone: v.optional(v.string()) }),          // "YYYY-MM-DD", IANA tz
  v.object({ kind: v.literal("local_datetime"), dateTime: v.string(), timeZone: v.optional(v.string()) }), // "YYYY-MM-DDTHH:mm"
  v.object({ kind: v.literal("code"), code: v.string() }),       // member of the key's closed code list
  v.object({ kind: v.literal("text"), text: v.string() }),       // ≤ 500 chars
  v.object({ kind: v.literal("bool"), value: v.boolean() }),
  v.object({ kind: v.literal("count"), n: v.number() }),         // safe integer ≥ 0
  v.object({ kind: v.literal("minutes"), minutes: v.number() }), // safe integer
  v.object({ kind: v.literal("user_unknown") }),                 // the user was asked and answered "I don't know" (≠ missing, ≠ false)
);

/** Stored row state. "missing" and "conflicting" are COMPUTED cell states (lib/facts/resolve.ts), never stored. */
export const factRowState = v.union(
  v.literal("observed"),            // system observation (e.g. price check, provider status)
  v.literal("extracted_candidate"), // AI/parser proposal; never counts as known
  v.literal("user_confirmed"),      // user asserted or confirmed
  v.literal("derived"),             // computed deterministically from other facts
  v.literal("superseded"),          // replaced by a newer row for the same cell (kept for audit)
  v.literal("rejected"),            // user rejected a candidate
);

export const factSource = v.union(
  v.object({ kind: v.literal("evidence"), evidenceId: v.id("evidence"), locator: evidenceLocator,
             quoteVerified: v.boolean(), extractorVersion: v.string() }),
  v.object({ kind: v.literal("user") }),
  v.object({ kind: v.literal("price_check"), priceCheckId: v.id("priceChecks") }),
  v.object({ kind: v.literal("derived"), ruleId: v.string(), fromFactIds: v.array(v.id("facts")) }), // ≤ 8
);

export const evidenceKind = v.union(v.literal("email"), v.literal("paste"), v.literal("upload"), v.literal("manual_note"), v.literal("system_capture"));
export const evidenceDocType = v.union(
  v.literal("order_confirmation"), v.literal("receipt"), v.literal("refund_notice"), v.literal("shipping_notice"),
  v.literal("delivery_notice"), v.literal("delay_notice"), v.literal("e_ticket"), v.literal("itinerary_change_notice"),
  v.literal("cancellation_notice"), v.literal("baggage_report"), v.literal("expense_receipt"), v.literal("card_statement"),
  v.literal("merchant_correspondence"), v.literal("submission_proof"), v.literal("damage_photo"), v.literal("policy_page"),
  v.literal("other"), v.literal("unknown"),
);
export const evidenceChannel = v.union(v.literal("agentmail_forward"), v.literal("paste"), v.literal("upload"), v.literal("manual"), v.literal("system_capture"));
export const extractionStatus = v.union(
  v.literal("not_requested"), v.literal("queued"), v.literal("running"), v.literal("succeeded"),
  v.literal("needs_review"), v.literal("failed"), v.literal("unsupported"),
  v.literal("store_only"), // sensitive doc types (card statements) until M03 clears LLM extraction
);
export const evidenceRetention = v.union(v.literal("active"), v.literal("content_deleted"));

export const incidentKind = v.union(
  v.literal("flight_cancelled"), v.literal("flight_schedule_changed"), v.literal("flight_delayed"), v.literal("denied_boarding"),
  v.literal("bag_delayed"), v.literal("bag_lost"), v.literal("bag_damaged"), v.literal("ancillary_not_provided"),
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
export const evaluationOutcome = v.union(
  v.literal("eligible"),                  // eligible under the evaluated rule AND confirmed facts
  v.literal("likely_eligible"),           // rule applies, facts known, evidence or an assumption outstanding
  v.literal("possible_contract_benefit"),
  v.literal("needs_facts"),
  v.literal("manual_review"),             // conflicting facts / source disagreement / unsupported sub-case
  v.literal("not_eligible"),              // under THIS rule, with confirmed facts
  v.literal("deadline_passed"),           // for THIS path only
  v.literal("source_unverified"),         // pack not `active`, or its source unavailable
  v.literal("unsupported"),               // jurisdiction/product/payment type not supported (≠ not eligible)
);
export const tri = v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown"));
export const remedyType = v.union(
  v.literal("price_difference"), v.literal("cash_refund"), v.literal("statement_credit"), v.literal("reimbursement"),
  v.literal("fee_refund"), v.literal("billing_correction"), v.literal("voucher"), v.literal("points"),
  v.literal("repair"), v.literal("replacement"), v.literal("service_credit"),
);
export const cashClass = v.union(v.literal("cash"), v.literal("non_cash"), v.literal("provisional"));
export const overlapRelation = v.union(
  v.literal("alternative"),       // same loss; pursue one (a second active case is refused)
  v.literal("coordinated"),       // same loss; concurrent pursuit allowed; recovered at most once (default when undeclared)
  v.literal("primary_secondary"), // same loss; secondary covers the remainder after the primary's outcome
  v.literal("complementary"),     // different losses; additive
  v.literal("distinct_lines"),    // same incident, distinct expense lines; additive
);
export const opportunityStatus = v.union(v.literal("open"), v.literal("case_open"), v.literal("dismissed"), v.literal("closed"), v.literal("superseded"));
export const deadlineStatus = v.union(
  v.literal("open"), v.literal("passed"), v.literal("unknown_anchor"), v.literal("disputed_anchor"),
  v.literal("beyond_calendar"), // business-day math past the committed holiday table: refuse to guess
  v.literal("not_applicable"),
);

export const factRef = v.object({ subjectKey: v.string(), key: v.string(), factIds: v.array(v.id("facts")) });
export const sourceRef = v.object({ sourceId: v.string(), passageId: v.string(), url: v.string(), effective: v.string() /* ISO date | "unknown" */ });
export const conditionResult = v.object({
  id: v.string(), label: v.string(), result: tri,
  kind: v.union(v.literal("applicability"), v.literal("requirement"), v.literal("exclusion"), v.literal("timing"), v.literal("evidence")),
  facts: v.array(factRef), sourcePassageId: v.optional(v.string()), note: v.optional(v.string()),
});
export const missingFact = v.object({
  subjectKey: v.string(), key: v.string(),
  reason: v.union(v.literal("missing"), v.literal("candidate_unconfirmed"), v.literal("conflicting"), v.literal("user_unknown")),
  neededFor: v.array(v.string()), // condition ids
});
export const assumption = v.object({ id: v.string(), text: v.string(), changesOutcomeIf: v.string() });
export const amountCalc = v.object({
  estimate: money, // what the rule computes; NEVER a cap
  basis: v.union(v.literal("exact_formula"), v.literal("documented_total"), v.literal("user_claimed")),
  formula: v.string(), // deterministic template, e.g. "(12,000 − 9,500) × 2"
  inputs: v.array(v.object({ label: v.string(), value: v.string(), fact: v.optional(factRef) })), // ≤ 12
  cap: v.optional(v.object({ amount: money, sourcePassageId: v.string(), note: v.string() })),   // shown as a limit only
});
export const deadlineResult = v.object({
  id: v.string(), label: v.string(), status: deadlineStatus,
  dueAt: v.optional(v.number()),            // last valid instant, UTC ms
  dueLocalDate: v.optional(v.string()), timeZone: v.optional(v.string()),
  mustBe: v.union(v.literal("received"), v.literal("sent"), v.literal("filed"), v.literal("n_a")),
  basis: v.string(),                        // deterministic explanation of anchor + arithmetic
  anchor: v.optional(factRef), sourcePassageId: v.optional(v.string()),
});
export const dimensions = v.object({
  applies: tri, factsKnown: tri, evidenceSupports: tri, windowOpen: tri, amountCalculable: tri, readyForApproval: tri,
});
export const nextAction = v.union(
  v.object({ kind: v.literal("answer_questions"), keys: v.array(v.object({ subjectKey: v.string(), key: v.string() })) }),
  v.object({ kind: v.literal("add_evidence"), docTypes: v.array(evidenceDocType) }),
  v.object({ kind: v.literal("open_case") }),
  v.object({ kind: v.literal("continue_case"), claimId: v.id("claims") }),
  v.object({ kind: v.literal("manual_review"), reason: v.string() }),
  v.object({ kind: v.literal("none"), reason: v.string() }),
);
export const nonCashKind = v.union(v.literal("voucher"), v.literal("points"), v.literal("repair"), v.literal("replacement"),
  v.literal("service_credit"), v.literal("fee_waiver"), v.literal("other"));

/** Approval context captured at draft/packet generation and re-derived before any side effect (§6). */
export const approvalBinding = v.object({
  contextHash: v.string(),                  // sha-256 hex of canonical JSON of every field below
  claimVersion: v.number(),
  amount: money,
  opportunityId: v.optional(v.id("opportunities")),
  evaluationId: v.optional(v.id("evaluations")),
  ruleId: v.optional(v.string()),
  ruleVersion: v.optional(v.number()),
  boundFactsHash: v.optional(v.string()),   // hash of the facts the packet ASSERTS (pack-defined subset), not the whole snapshot
  attachments: v.array(v.object({ evidenceId: v.id("evidence"), contentHash: v.string() })), // ≤ 10; [] for Phase-1 email
});

// ===================== M10 (wave 1) — new tables =====================

  /** Category-neutral parent of everything recoverable. Identity + display projection only: evaluation reads FACTS (§2.5). */
  transactions: defineTable({
    userId: v.id("users"),
    category: transactionCategory,
    status: transactionStatus,
    counterpartyName: v.string(),                 // merchant / carrier / issuer, ≤ 120 chars
    counterpartyDomain: v.optional(v.string()),   // normalized host when known
    currency: v.string(),                         // ISO 4217 of the transaction total
    totalMinor: v.optional(v.number()),
    transactedAt: v.optional(v.number()),         // display/sort only; legal anchors are facts
    naturalKey: v.optional(v.string()),           // owner-scoped dedupe: "retail:<domain>:<orderRef>", "air:<carrier>:<PNR>", "card:<chargeHash>"
    purchaseId: v.optional(v.id("purchases")),    // retail_order only, 1:1
    relatedTransactionId: v.optional(v.id("transactions")), // card_charge -> what it paid for
    sourceEvidenceId: v.optional(v.id("evidence")),
    isExample: v.optional(v.boolean()),
  })
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user_and_natural_key", ["userId", "naturalKey"])
    .index("by_purchase", ["purchaseId"]),

  /** One assertion about one cell (transactionId, subjectKey, key). Append-only except `state`/`supersededBy`. */
  facts: defineTable({
    userId: v.id("users"),
    transactionId: v.id("transactions"),
    subjectKey: v.string(),  // grammar in lib/facts/subject.ts: "txn" | "item:<itemId>" | "seg:<orig|chg|flown>:<n>" | "bag:<n>" | "exp:<n>" | "shp:<n>" | "chg:<n>" | "inc:<incidentId>"
    key: v.string(),         // closed catalogue in lib/facts/catalog.ts; only lib/facts/write.ts inserts
    state: factRowState,
    value: factValue,
    source: factSource,
    supersededBy: v.optional(v.id("facts")),
    overridesObserved: v.optional(v.boolean()), // explicit user override of a conflicting observation
    recordedAt: v.number(),
    isExample: v.optional(v.boolean()),
  })
    .index("by_transaction_and_subject_key_and_key", ["transactionId", "subjectKey", "key"])
    .index("by_user", ["userId"]),

  /** What went wrong, separate from what was bought. Its dates/details are facts on subject "inc:<id>". */
  incidents: defineTable({
    userId: v.id("users"),
    transactionId: v.id("transactions"),
    kind: incidentKind,
    status: incidentStatus,
    reportedBy: v.union(v.literal("user"), v.literal("extraction")),
    sourceEvidenceId: v.optional(v.id("evidence")),
    isExample: v.optional(v.boolean()),
  })
    .index("by_transaction", ["transactionId"])
    .index("by_user", ["userId"]),

  /** Owned source material. Hash supports change detection and dedupe, never truth. */
  evidence: defineTable({
    userId: v.id("users"),
    transactionId: v.optional(v.id("transactions")),
    kind: evidenceKind,
    docType: evidenceDocType,
    sourceChannel: evidenceChannel,
    processedEventId: v.optional(v.id("processedEvents")),
    storageId: v.optional(v.id("_storage")),
    contentHash: v.string(),            // lowercase hex sha-256 of the bytes (uploads: `_storage.sha256`, hex per convex types) or of the normalized text
    mimeType: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    pageCount: v.optional(v.number()),
    fileName: v.optional(v.string()),   // ≤ 200 chars, control chars stripped
    text: v.optional(v.string()),       // pasted/extracted text ≤ 60,000 chars (the paste cap)
    receivedAt: v.number(),
    extractionStatus: extractionStatus,
    extractionAttempts: v.number(),
    extractionStartedAt: v.optional(v.number()), // lease; stale after 15 min
    extractorVersion: v.optional(v.string()),
    extractionSummary: v.optional(v.string()),   // sanitized, user-facing (D58 pattern)
    retention: evidenceRetention,
    isExample: v.optional(v.boolean()),
  })
    .index("by_user_and_content_hash", ["userId", "contentHash"])
    .index("by_transaction", ["transactionId"])
    .index("by_storage", ["storageId"])
    .index("by_extraction_status_and_extraction_started_at", ["extractionStatus", "extractionStartedAt"]),

  /** Binds an uploaded blob to the user who asked for the upload URL (storage ids carry no owner). */
  uploadTickets: defineTable({
    userId: v.id("users"),
    issuedAt: v.number(),
    consumedAt: v.optional(v.number()),
    storageId: v.optional(v.id("_storage")),
  }).index("by_user_and_issued_at", ["userId", "issuedAt"]),

  /** Stable identity of "remedy X for loss L on transaction T", projecting its current evaluation. */
  opportunities: defineTable({
    userId: v.id("users"),
    transactionId: v.id("transactions"),
    scenarioId,
    remedyKey: v.string(),
    subjectKey: v.string(),
    incidentId: v.optional(v.id("incidents")),
    dedupeKey: v.string(), // `${transactionId}|${scenarioId}|${remedyKey}|${subjectKey}|${incidentId ?? "-"}`
    status: opportunityStatus,
    currentEvaluationId: v.optional(v.id("evaluations")), // optional only between insert and first evaluation, same mutation
    ruleId: v.string(),
    ruleVersion: v.number(),
    outcome: evaluationOutcome,
    authorityClass,
    remedyType,
    cashClass,
    estimate: v.optional(money),
    nextDeadlineAt: v.optional(v.number()),
    lossKeys: v.array(v.string()), // ≤ 20, produced by the pack (§3.3)
    activeClaimId: v.optional(v.id("claims")),
    lastEvaluatedAt: v.number(),
    isExample: v.optional(v.boolean()),
  })
    .index("by_user_and_dedupe_key", ["userId", "dedupeKey"])
    .index("by_transaction", ["transactionId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_status_and_next_deadline_at", ["status", "nextDeadlineAt"])
    .index("by_scenario_and_rule_version", ["scenarioId", "ruleVersion"]),

  /** Append-only evaluation history; a row is added only when resultHash changes (bounded growth). */
  evaluations: defineTable({
    userId: v.id("users"),
    opportunityId: v.id("opportunities"),
    scenarioId,
    ruleId: v.string(),
    ruleVersion: v.number(),
    factSnapshotHash: v.string(),
    resultHash: v.string(), // canonical hash of the result WITHOUT evaluatedAt
    evaluatedAt: v.number(),
    trigger: v.union(v.literal("fact_change"), v.literal("observation"), v.literal("rule_version"), v.literal("user_request"),
      v.literal("case_open"), v.literal("approval_check"), v.literal("migration")),
    outcome: evaluationOutcome,
    dimensions,
    conditions: v.array(conditionResult),  // ≤ 64 (asserted by the writer)
    missingFacts: v.array(missingFact),    // ≤ 32
    assumptions: v.array(assumption),      // ≤ 16
    disqualifierIds: v.array(v.string()),  // ≤ 16
    amount: v.union(amountCalc, v.null()),
    deadlines: v.array(deadlineResult),    // ≤ 8
    sourceRefs: v.array(sourceRef),        // ≤ 8
    overlap: v.array(v.object({ withScenario: scenarioId, withRemedyKey: v.string(), relation: overlapRelation })), // ≤ 8
    nextAction,
    explanation: v.array(v.string()),      // ≤ 12 deterministic sentences
  })
    .index("by_opportunity", ["opportunityId"])
    .index("by_user", ["userId"]),

  /** Non-cash recovery events, append-only; never summed with cash. */
  nonCashRemedies: defineTable({
    userId: v.id("users"),
    claimId: v.id("claims"),
    kind: nonCashKind,
    description: v.string(),               // ≤ 300 chars
    faceValue: v.optional(money),          // display only; never enters a cash total
    state: v.union(v.literal("promised"), v.literal("received")),
    idempotencyKey: v.string(),
    recordedAt: v.number(),
  })
    .index("by_claim_and_idempotency_key", ["claimId", "idempotencyKey"])
    .index("by_user", ["userId"]),

// ===================== M10 (wave 1) — additive changes to existing tables =====================
// eventKind: + "provisional_credit" | "provisional_released"         (justified in §3.2; lib/ledger rewritten exhaustively in the same commit, HC-3)
// ledgerEvents: + currency: v.optional(v.string())                  (required by the writer for every NEW event; must equal claimCurrency(claim))
// claims: + transactionId: v.optional(v.id("transactions")), opportunityId: v.optional(v.id("opportunities")),
//         scenarioId: v.optional(scenarioId), remedyKey: v.optional(v.string()),
//         currency: v.optional(v.string()), lossKeys: v.optional(v.array(v.string())) // ≤ 20
//         + .index("by_opportunity", ["opportunityId"]) + .index("by_transaction_and_status", ["transactionId", "status"])
// drafts: + binding: v.optional(approvalBinding), approvedHash: v.optional(v.string())

// ===================== M20 (wave 2) — addendum =====================
// claimType: + v.literal("scenario")
// claimStatus: + v.literal("denied")                                (§5)
// claims.purchaseId / claims.itemId: v.id(...) -> v.optional(v.id(...))   (§2.3)
export const manualChannel = v.union(v.literal("postal_mail"), v.literal("web_form"), v.literal("portal"),
  v.literal("phone"), v.literal("chat"), v.literal("in_person"));
export const recipientSource = v.union(
  v.literal("confirmed_policy_snapshot"), // existing D18 source
  v.literal("rule_pack"),                 // an address/portal the reviewed pack cites (e.g. a DOT-required refund form URL)
  v.literal("user_entered_from_document"),// e.g. billing-error address copied from the user's statement, with evidenceId
  v.literal("user_entered"),
);
  packets: defineTable({
    userId: v.id("users"),
    claimId: v.id("claims"),
    version: v.number(),
    channel: manualChannel,
    recipient: v.object({ text: v.string(), source: recipientSource, evidenceId: v.optional(v.id("evidence")) }), // text ≤ 500
    body: v.string(),                    // ≤ 8,000 chars; deterministic template output, user-editable
    requestedRemedy: v.string(),         // ≤ 300
    evidenceIndex: v.array(v.object({ evidenceId: v.id("evidence"), contentHash: v.string(), label: v.string() })), // ≤ 25
    binding: approvalBinding,
    status: v.union(v.literal("draft"), v.literal("approved"), v.literal("superseded"), v.literal("submission_recorded")),
    approvedAt: v.optional(v.number()),
    approvedHash: v.optional(v.string()), // hash over binding.contextHash + recipient + body + evidenceIndex + requestedRemedy
  }).index("by_claim", ["claimId"]).index("by_user", ["userId"]),
  submissions: defineTable({
    userId: v.id("users"),
    claimId: v.id("claims"),
    packetId: v.id("packets"),
    approvedHash: v.string(),            // the packet hash the user said they submitted
    channel: manualChannel,
    submittedAt: v.number(),             // user-stated
    confirmationRef: v.optional(v.string()), // portal confirmation #, certified-mail #, ≤ 120
    proofEvidenceId: v.optional(v.id("evidence")),
    deliveryRecordedAt: v.optional(v.number()),   // e.g. certified-mail receipt, user-recorded
    deliveryEvidenceId: v.optional(v.id("evidence")),
    note: v.optional(v.string()),        // ≤ 500
  }).index("by_claim", ["claimId"]).index("by_user", ["userId"]),
```

**Why each existing-table change is needed:**
- **`claims.*` links:** the only way the dedupe guard ("one active case per opportunity"), overlap refusal (`lossKeys`), and per-currency totals can work without joining through purchases. `claims.currency` is written by every new writer; legacy rows fall back to `purchases.currency` through `claimCurrency(claim)` in `lib/claimState.ts`, so no backfill is needed.
- **`claims.purchaseId`/`itemId` optional (wave 2 only):** required for non-retail cases (§2.3).
- **`claimType += "scenario"`:** existing readers filter on `"price_adjustment"`/`"return_credit"`, so a scenario claim is invisible to them by construction.
- **`claimStatus += "denied"`:** the only new persisted workflow state (§5).
- **`ledgerEvents` provisional kinds and `currency`:** §3.2. New writers enforce `currency === claimCurrency(claim)`, which closes HC-10's class of bug.
- **`drafts.binding`/`approvedHash`:** mission §6 outbound binding (§6). Legacy drafts without `binding` keep today's checks unchanged.
- **Nothing changes on `purchases`, `items`, `policies`, `priceChecks`, or `watches`.**

**Caps** (M10 adds these to `convex/limits.ts`, each with a comment justifying the number): transactions per user 500 (archived rows included, as `MAX_PURCHASES_PER_USER` does); facts per transaction 1,000 rows; incidents per transaction 20; evidence per user 1,000 rows and 500 MB total `sizeBytes`; upload ≤ 10 MB, PDF ≤ 20 pages; open opportunities read per dashboard call 200 (`truncated` flag); upload tickets 20 per hour per user (rate limiter bucket `evidenceUpload`).

### 2.5 Fact model

- **Cell** = (transactionId, subjectKey, key). **Resolution** (`lib/facts/resolve.ts`, pure) reads the cell's non-superseded, non-rejected rows and returns:
  1. the rows include `user_confirmed` → `confirmed`. If a current `observed` row disagrees and the confirmed row lacks `overridesObserved`, the result is `conflicting`.
  2. otherwise `observed` rows → `observed` (newest wins; an older observation is superseded at write time).
  3. otherwise `derived` → `derived`.
  4. otherwise candidates → `candidate` when they agree, `conflicting` when they differ.
  5. otherwise, a confirmed `user_unknown` value → `user_unknown`.
  6. otherwise `missing`.

  **Only `confirmed | observed | derived` count as known.** Missing is not false. A candidate is not known. Conflicting blocks every condition that depends on the cell.
- **Writes go only through `lib/facts/write.ts putFact(ctx, userId, {...})`.** It checks that the transaction is owned, parses `subjectKey` and checks ownership of any referenced `itemId` (whose `item.purchaseId` must equal `transaction.purchaseId`) or `incidentId` (whose `incident.transactionId` must match), checks that the key is in the catalogue for the transaction's category, validates the value variant and domain (`code ∈ spec.codes`; money through `assertMoney`; dates by grammar), and checks that any referenced evidence belongs to the user. It applies the supersede rules: a new `user_confirmed` supersedes the cell's prior confirmed and candidate rows (and observed rows only when `overridesObserved`); a new `observed` supersedes older observed rows; a new `derived` supersedes older derived rows; a new candidate supersedes nothing. It enforces the per-transaction cap and fails closed.
- **Catalogue:** `convex/lib/facts/catalog.ts` merges the per-domain files `keys_retail.ts`, `keys_order.ts`, `keys_air.ts`, and `keys_card.ts`. M11 creates all four; the three non-retail files are empty stubs so that wave-2 domain engineers only fill their own file. Each `FactSpec` = `{ key, categories, subject: "txn"|"item"|"seg"|"bag"|"exp"|"shp"|"chg"|"inc", value: ValueKind, codes?, question: { prompt, why, sensitive? }, evidenceHint?: EvidenceDocType[], userAssertable: boolean }`. A test asserts that every stored `facts.key` is in the catalogue and that the catalogue has no duplicates. Keys are never renamed once shipped (a rename requires a migration). **Runtime catalogue rather than schema literals:** the catalogue grows per domain each wave, and a schema literal would make schema.ts a multi-writer file. Validation is identical because there is exactly one writer. (Open decision O2.)
- **Typed per-category snapshot** (the "typed detail record"): `lib/facts/snapshot_<category>.ts` exports a compile-time-typed shape, for example `AirTravelSnapshot = { itinerary: { original: Segment[]; changed: Segment[] }; scope: Cell<"domestic"|"international">; payment: {...}; incidents: ...; bags: ...; expenses: ... }`, where `Cell<T> = { status: "confirmed"|"observed"|"derived"; value: T; factIds; evidenceIds } | { status: "candidate"; value: T; ... } | { status: "conflicting"; values: T[]; factIds } | { status: "user_unknown" } | { status: "missing" }`. `buildSnapshot()` is pure. `snapshotHash = sha256(canonicalJson(snapshot))` (`lib/canonical.ts`: sorted keys, no undefined, arrays in deterministic order).
- **Legacy retail adapter** (`lib/facts/legacyRetail.ts`): for an **active** purchase, it reads `purchases.{merchantDomain, purchasedAt, currency}` and `items.{name, unitCents, qty, productUrl, returned}` as `confirmed` cells with source `legacy_purchase` (purchase `status === "active"` means the user confirmed them, per D25, or entered them manually). It reads the newest accepted `priceChecks` row (with `observedCents` defined) as an `observed` cell. It overlays any stored `facts` rows for the same cells, and a stored confirmed fact wins. For a `needs_review` purchase every legacy cell is a `candidate`. **Nothing is backfilled into `facts`.**

### 2.6 Evidence storage

- **Upload:** `evidence.generateUploadUrl()` (public mutation) runs `requireUserId`, then the rate limiter, then inserts an `uploadTickets` row, then returns `ctx.storage.generateUploadUrl()`. `evidence.registerUpload({ storageId, fileName })` runs `requireUserId`, then:
  1. requires an unconsumed ticket for this user issued ≤ 60 min ago, whose `issuedAt` ≤ `_storage._creationTime`;
  2. requires that `by_storage` has no evidence row for this `storageId` (so no blob is registered twice, by anyone);
  3. reads `ctx.db.system.get("_storage", storageId)` and enforces `size` ≤ cap and content type ∈ {application/pdf, image/jpeg, image/png, image/heic, image/webp}, magic-byte checked in the extraction action;
  4. owner-scoped dedupe on `(userId, sha256)`: an existing row means the new blob is deleted and the existing evidence id is returned;
  5. inserts evidence with `extractionStatus: "queued"` (or `store_only` for `card_statement`) and consumes the ticket.

  A failed validation deletes the blob. **Dedupe is never global**, so no user can learn that another user holds a file.
- **Text evidence** (forward or paste): intake (M13) inserts an evidence row with `text`, `contentHash = sha256(normalizeWhitespace(text))`, and `processedEventId`, in the same mutation that creates the needs_review purchase or transaction. `transactions.sourceEvidenceId` points at it. Because the evidence row keeps the text, the 30-day `processedEvents.payload` strip no longer destroys case evidence.
- **Provenance:** every extracted fact carries `source.evidence.locator.quote`, checked verbatim with `lib/passage.normalizeForMatch`. A failed check is stored with `quoteVerified: false`, and the UI shows "not found in the document". Such a fact can be confirmed by the user but never counts as evidence support (dimension 3).
- **Access:** `evidence.getUrl({ evidenceId })` checks ownership, then returns `ctx.storage.getUrl`. A storage id never reaches the client for another user's row.
- **Retention (M14):** evidence referenced by a transaction that has a claim, a packet, or a submission is kept until the user deletes it or deletes the account (it is case history). Evidence never linked to an active transaction is set to `content_deleted` after 30 days (blob deleted, `text` cleared, hash kept for dedupe/audit). `evidence.remove` refuses rows cited by an approved packet or a recorded submission.

### 2.7 Rule packs: where they live

**Immutable, versioned TypeScript modules plus DB rows that record evaluations.** Justification: evaluators must be deterministic, type-checked, fixture-tested, and reviewable in git (mission §8 "reviewable", "never generate executable production rule code from untrusted content"). A DB-stored rule would need an interpreter, which is a DSL (mission §7 says no DSL). Scraped updates can never rewrite active logic because logic only changes through a reviewed commit.

- **Layout:** `convex/lib/rules/types.ts`, `outcome.ts` (a single `deriveOutcome`), `registry.ts`, `coverage.ts`, one file per pack version named `r01_price_adjustment_v1.ts` (underscores only; a Convex entry point with more than one dot is skipped by the bundler), and `convex/lib/deadlines/{engine,calendar,usFederalHolidays}.ts`. Fixtures live in `convex/lib/rules/fixtures/r01_v1.fixtures.ts`, with expected outcomes written by hand from M02's spec, **never produced by running the evaluator** (mission §17). Captured sources live in `docs/rules/sources/<sourceId>.md` with a sha-256 in `docs/rules/manifest.json` (M02 owns docs/rules/**).
- **`RulePack<S, P>` fields**, each mapped to its mission §8 item: `ruleId` (stable id), `scenarioId`, `version` (immutable), `lifecycle` (draft→researched→reviewed→active→superseded/withdrawn), `authority: { class, subtype }` (subtypes: federal_statute, federal_regulation, state_law, card_benefit_guide, insurance_policy, written_warranty, service_contract, merchant_policy, carrier_commitment, contract_of_carriage, class_settlement, regulator_refund_program, manufacturer_program, recall, unclaimed_property, goodwill), `jurisdiction`, `categories` (which transaction categories it applies to), `applicability` + `trigger` + `requiredFacts` + `exclusions` (as condition specs), `remedies: RemedySpec[]` (remedyKey, remedyType, cashClass, lossKeys builder, declared `overlap` relations), `calculation` + `cap`, `evidenceChecklist`, `notice` (filing/response requirements), `deadlines: DeadlineSpec[]`, `channels` (+ escalation route), `sources: RuleSource[]` (`{ sourceId, url, passage, passageId, capturedPath, capturedSha256, effectiveDate | "unknown", retrievedAt, lastVerifiedAt }`), `review: { status, reviewer, reviewedAt, refreshPolicy }`, `knownLimitations`, `fixturesPath`, `boundFacts(snapshot)` (the facts a packet asserts, used for approval binding), and `evaluate`.
- **Activation gate:** `registry.activePack(scenarioId)` returns only a pack with `lifecycle === "active"`. A test asserts that every active pack has ≥ 1 source with passage, capturedSha256, reviewer, and reviewedAt, and a non-empty fixtures file whose positive, negative, missing, contradictory, boundary, unsupported, stale-source, exclusion, duplicate, and overlap cases (mission §17) all pass. A scenario whose pack is not active evaluates to `source_unverified`, or is not evaluated at all when no pack is registered (listed as "not checked yet" from `coverage.ts`, §9).
- **Immutability check:** `scripts/check-rule-packs.mjs` (owned by the verifier or CI owner) fails CI when a pack file listed in `docs/rules/manifest.json` with status ≥ reviewed has a different hash. New behaviour means a new `_v<N+1>` file. The old file stays so historical evaluations can be explained (C54).
- **Temporal accuracy:** `lib/rules/applicable.ts` picks the pack for an evaluation. The **active** pack evaluates. If `sources[].effectiveDate` is after the transaction's anchor date, or unknown, that surfaces as an assumption ("these terms may not be the ones in effect on <date>"), and the outcome is capped at `likely_eligible`. It never becomes a silent `eligible`.
- **R01's merchant-policy snapshots** stay per-user `policies` rows (unreviewed scrape plus user confirmation). The R01 pack treats them as **parameter sources with a trust tier**:
  - a reviewed merchant entry that M02 may add to `lib/rules/merchants/*.ts` can reach `eligible`;
  - a user-confirmed verbatim snapshot caps at `likely_eligible`, with the assumption "current page text assumed to govern your purchase";
  - an unconfirmed snapshot also caps at `likely_eligible`, with missing fact `retail.policy_confirmed`;
  - no window gives `source_unverified`.

### 2.8 Opportunities and cases

- **Evaluate:** `opportunities.evaluateTransaction(ctx, transactionId, trigger, now)` is a plain async helper called inside mutations. It:
  1. builds the snapshot;
  2. picks the applicable scenarios from `coverage.ts` by category, payment class, and incidents;
  3. for each registered pack, runs `evaluate` once per remedy and subject;
  4. **upserts** by `by_user_and_dedupe_key` (Convex OCC serializes concurrent upserts on the same index range, so there are no duplicates);
  5. inserts an `evaluations` row only when `resultHash` changed, otherwise patches `lastEvaluatedAt`;
  6. projects outcome, estimate, deadline, lossKeys, and rule version onto the opportunity;
  7. if `activeClaimId` is set and the change is **material** (outcome leaves {eligible, likely_eligible}, `ruleVersion` changed, a deadline flipped to `passed`, or `boundFacts` hash changed), bumps `claims.version` (which invalidates any draft or packet approval through the existing `claimVersion` check) and writes a `claimNotes` row that says what changed.

  An estimate drift while a case is active is **not** material. The case amount is `claims.expectedCents`, which changes only through `adjustExpected`, so each 2-hour price check does not invalidate drafts.
- **Open a case:** `opportunities.openCase({ opportunityId, claimedAmount? })` (public; for R01 it is also called internally by `recordCheck`). Steps:
  1. owner check, tombstone gate;
  2. **re-evaluate now** (trigger `case_open`); refuse if the outcome is ∉ {eligible, likely_eligible, possible_contract_benefit}, with `nextAction` explaining why;
  3. **idempotency:** if `activeClaimId` points to a claim that is not dismissed, denied, or confirmed, return that claim id (a second click or a concurrent open gets the same case);
  4. **overlap guard:** read active claims on the same transaction and on `relatedTransactionId` (`by_transaction_and_status`, bounded). An `alternative` relation with a non-empty `lossKeys` intersection refuses with "You already have an active claim for this loss via <X>". `coordinated` allows with a notice. `primary_secondary` refuses the secondary until the primary is closed (wave 3). Undeclared intersections are treated as `coordinated`;
  5. amount: the pack's estimate or, for remedies with basis `user_claimed`, `claimedAmount`, validated as money in the transaction currency and ≤ the documented total when the pack defines one;
  6. insert the claim (legacy `openClaim` for R01, so D44 still holds; the new `insertScenarioClaim` for wave 2) and set `activeClaimId` + `status: "case_open"` in the same mutation.

  **Re-evaluation never creates a case, with one exception: the R01 legacy auto-open**, which goes through this same guard (§10 R01).
- **Closing:** when the active claim reaches `dismissed` or `denied`, `status` returns to `open` and `activeClaimId` is cleared, so the user may retry and history is kept. `confirmed` sets `closed`. A dismissed opportunity is never re-opened by re-evaluation; its `status` stays `dismissed` while evaluations continue to be recorded.

---

## 3. Money and recovery types

### 3.1 Money validator and helpers

`money = v.object({ amountMinor: v.number(), currency: v.string() })` (§2.4). `v.number()` rather than `v.int64()` keeps compatibility with every existing cents field and with JSON clients. `lib/money.ts` (M10) adds:

```ts
/** Exponent per supported currency. Anything not listed is unsupported for NEW money (legacy purchases keep assertCurrency). */
export const CURRENCY_EXPONENT = { USD: 2 } as const satisfies Record<string, 0 | 2 | 3>;
export type SupportedCurrency = keyof typeof CURRENCY_EXPONENT;
export function assertMoney(m: { amountMinor: number; currency: string }, label?: string): { amountMinor: number; currency: SupportedCurrency };
//   Number.isSafeInteger(amountMinor) && amountMinor >= 0 && currency ∈ CURRENCY_EXPONENT; otherwise ConvexError
export function parseDecimalToMinor(decimal: string, currency: SupportedCurrency): number;
//   "1,234.50" → 123450; rejects NaN/Infinity/exponents/more fraction digits than the exponent/negative; no float math
export function formatMinor(m: { amountMinor: number; currency: string }): string; // exponent-aware Intl formatting
export function claimCurrency(claim: Doc<"claims">, purchase: Doc<"purchases"> | null): string; // claim.currency ?? purchase.currency
```

LLM extraction schemas for new document types emit amounts as **decimal strings**, parsed by `parseDecimalToMinor`. They never emit numbers passed through `toCents`. A new evaluator supports USD only (open decision O6). Other currencies evaluate to `unsupported` ("Recoup checks US-dollar transactions only"). There is never any conversion.

### 3.2 Recovery-event taxonomy mapped onto storage

| Mission concept | Where it lives | Counted in |
|---|---|---|
| Potential recovery | `opportunities` (no ledger) | "Potential" (dedup rule in §3.4) |
| Rule-calculated estimate | `evaluations.amount.estimate` (+ `cap` shown only as a limit) | the Potential estimate only |
| Claimed amount | `claims.expectedCents` (+ `claims.currency`) — existing | "Ready to ask" / "Asked" |
| Submitted amount | `drafts.binding.amount` (email) / `packets.binding.amount` + `submissions` (manual) | "Asked" (only once delivery state is sent or submission_recorded) |
| Merchant/issuer promise | `ledgerEvents.promised_credit` — existing (latest, not summed, D21) | "Promised" |
| Provisional credit | **new** `ledgerEvents.provisional_credit` (user-recorded; e.g. an issuer's provisional credit during an investigation) | "Provisional" (never "Recovered") |
| Provisional finalized or reversed | **new** `ledgerEvents.provisional_released` (always paired: finalization = `provisional_released` + `confirmed_credit` of the same amount in one mutation; reversal = `provisional_released` alone) | — |
| User-confirmed posted credit | `ledgerEvents.confirmed_credit` — existing; **only** user mutations write it | "Recovered" |
| Reversal / later debit | `ledgerEvents.later_debit` — existing (≤ net confirmed, D40; reopens only that claim) | subtracts from "Recovered" |
| Non-cash remedy | **new** `nonCashRemedies` table | "Non-cash" (count and items; never summed with cash) |

The ledger rewrite (M10, one commit, HC-3):

```ts
export type EventKind = "promised_credit" | "confirmed_credit" | "later_debit" | "provisional_credit" | "provisional_released";
export type Balance = { expected: number; promised: number; confirmed: number; debited: number; provisional: number; unresolved: number };
// balance(): exhaustive switch with `const _never: never = e.kind` default; provisional = Σprovisional_credit − Σprovisional_released (assert ≥ 0);
// unresolved = expected − confirmed + debited  (UNCHANGED: provisional never reduces unresolved, per mission §6 formula)
// statusAfterEvent(): provisional_* never change status (a provisional credit is not a settlement).
```

The new public mutations in `claims.ts` (M10) are `recordProvisionalCredit`, `finalizeProvisionalCredit`, `recordProvisionalReversal`, and `recordNonCashRemedy`. Each follows the `confirmCredit` pattern: `requireUserId`, `ownedClaim`, a client idempotency key ≤ 128 chars, `assertPositiveCents`, and currency equal to `claimCurrency`. `provisional_released` ≤ current provisional.

### 3.3 Overlap groups (no double counting)

- Each pack's `RemedySpec.lossKeys(snapshot)` returns stable **loss keys** anchored on the transaction where the money was paid. Examples: `item:<itemId>:price_diff` (R01), `txn:<id>:fare_unused` (R02), `txn:<id>:bag_fee:<n>` (R04), `txn:<id>:exp:<n>` (R04, one per documented expense line), `txn:<paidTxnId>:paid` (R05 order total, and R03 on a `card_charge` whose `relatedTransactionId` = paidTxnId, so a merchant refund and a billing-error correction share a loss).
- Declared relations live in the pack (`overlap: [{ withScenario, withRemedyKey, relation, sourcePassageId? }]`). When two opportunities' lossKeys intersect, the relation is the one declared (either side); **if none is declared, it is `coordinated`** (concurrent pursuit allowed, recovered at most once). This default makes totals conservative without blocking a legitimate parallel path. Mission §6 says to assume neither mutual exclusion nor accumulation. `complementary` and `distinct_lines` must not share lossKeys. A pack test asserts that.
- **Cases:** the §2.8 guard applies. Confirmed credits on two coordinated claims for the same lossKey are both real money received, so both count, but the dashboard flags "possible double recovery for <loss> — you may be asked to return one".

### 3.4 Exact rule for dashboard totals (`recovery.summary({ now })`, M12)

Everything is computed **per currency, never converted, never summed across currencies**. `isExample` rows are excluded, reported separately as `exampleCounts`. Reads are bounded (claims `by_user` desc ≤ 200, open opportunities `by_user_and_status` ≤ 200, balances per claim), and `complete: false` whenever a bound cut real rows. The UI then labels figures "at least"/"recent" (a sampled window is not a total).

For currency c:
1. **Recovered** = Σ over claims (not dismissed, currency c) of `max(0, confirmed − debited)`. This is actual net money posted. Over-credit is **included** and shown as "over-credited by X" on the claim. This supersedes D39's clamp (open decision O9) and unifies the two formulas from HC-2.
2. **Provisional** = Σ `provisional` (as above). Labelled "posted provisionally, can be reversed". Never added to Recovered.
3. **Promised, not yet posted** = Σ over non-dismissed claims of `max(0, min(promised, expected) − max(0, confirmed − debited))`.
4. **Asked** = Σ `max(0, unresolved)` over claims whose **delivery** state is `sent`, `delivered`, `submission_recorded`, or `user_reported` (§5), and whose status is not confirmed, dismissed, or denied. The response carries an `askedUserReportedMinor` sub-figure so the UI can show "of which you reported contacting them yourself". HC-6 is fixed for new scenario claims, which cannot reach `packet` without a recorded submission, and legacy note-only packets stay counted but labelled.
5. **Ready to ask** = Σ `max(0, unresolved)` over claims in `detected` or `drafted` (cases that exist but were not sent).
6. **Potential (estimated, not claimed)** = consider open opportunities with outcome ∈ {eligible, likely_eligible}, an `estimate` in c, cashClass `cash`, **and no active claim**. Build connected components over shared lossKeys (union-find, ≤ 200 nodes). Potential = Σ over components of **max** estimate in the component. It is never a sum within a component and never uses `cap`. Opportunities without an estimate, with outcome `possible_contract_benefit`/`needs_facts`/`manual_review`, or non-cash are **counted, not summed**.
7. **Non-cash** = counts by `nonCashKind` (promised or received). Face values are shown per item only.

The headline "money found" is **Recovered**. Potential is labelled "estimated, not guaranteed", and no theoretical maximum ever enters a number (mission §12). Watch and purchase dedup (D72) is untouched.

---

## 4. Evaluator and deadline contracts

```ts
// convex/lib/rules/types.ts  (pure; no Convex ctx, no Date.now, no Math.random, no lib/ai import — a test greps for this)
export type Tri = "pass" | "fail" | "unknown";
export type Outcome = Infer<typeof evaluationOutcome>;

export interface EvaluationInput<S, P> {
  snapshot: S;                         // typed per-category snapshot (§2.5)
  snapshotHash: string;
  pack: { ruleId: string; scenarioId: ScenarioId; version: number; lifecycle: Lifecycle; params: P };
  remedyKey: string;
  subjectKey: string;                  // which item / segment / charge
  incidentId?: Id<"incidents">;
  caseContext: {                       // read by the caller, passed in (keeps evaluate pure)
    activeClaimId?: Id<"claims">;
    settledMinorByLossKey: Record<string, number>; // e.g. R01 settled price-diff claims (existing settledPriceClaimCents)
  };
  now: number;                         // INJECTED clock (UTC ms)
}

export interface EvaluationResult {
  scenarioId: ScenarioId; ruleId: string; ruleVersion: number; remedyKey: string; subjectKey: string;
  snapshotHash: string;
  outcome: Outcome;                    // ONLY via deriveOutcome(dimensions, flags) below
  dimensions: {                        // mission §9's six separable questions
    applies: Tri;                      // 1 does the rule apply (category/payment/jurisdiction/trigger)
    factsKnown: Tri;                   // 2 required facts known (confirmed|observed|derived)
    evidenceSupports: Tri;             // 3 evidence supports them (verified quotes / observations)
    windowOpen: Tri;                   // 4 time window open
    amountCalculable: Tri;             // 5 remedy can be calculated
    readyForApproval: Tri;             // 6 packet can be approved (recipient/channel known, no blocking assumption)
  };
  conditions: ConditionResult[];       // every condition: pass/fail/unknown + fact refs + source passage id
  missingFacts: MissingFact[];
  assumptions: Assumption[];
  disqualifierIds: string[];           // failed applicability/exclusion condition ids (confirmed facts only)
  amount: AmountCalc | null;           // null when not calculable; cap never used as estimate
  deadlines: DeadlineResult[];
  sourceRefs: SourceRef[];
  lossKeys: string[];
  overlap: { withScenario: ScenarioId; withRemedyKey: string; relation: OverlapRelation }[];
  nextAction: NextAction;
  explanation: string[];               // deterministic template sentences, no model output
  flags: { unsupportedReason?: string; sourceNotActive?: boolean; conflictingKeys: string[]; contractCoverageInexact?: boolean };
}

export type Evaluator<S, P> = (input: EvaluationInput<S, P>) => EvaluationResult;

/** The ONLY place an outcome is chosen; precedence is fixed and unit-tested exhaustively (3^6 × flag combinations). */
export function deriveOutcome(d: EvaluationResult["dimensions"], f: EvaluationResult["flags"]): Outcome;
//  1 f.unsupportedReason                          -> "unsupported"
//  2 f.sourceNotActive                            -> "source_unverified"
//  3 d.applies === "fail"                         -> "not_eligible"      (only from CONFIRMED facts)
//  4 d.windowOpen === "fail"                      -> "deadline_passed"   (this path only)
//  5 f.conflictingKeys.length > 0                 -> "manual_review"
//  6 d.applies === "unknown" || d.factsKnown === "unknown" -> "needs_facts"
//  7 f.contractCoverageInexact                    -> "possible_contract_benefit"
//  8 d.evidenceSupports !== "pass" || assumptions.length > 0 -> "likely_eligible"
//  9 otherwise                                    -> "eligible"
//  (windowOpen "unknown" because the anchor is unknown makes factsKnown "unknown" -> rule 6; amountCalculable and
//   readyForApproval never change eligibility, they gate case opening/approval.)
```

```ts
// convex/lib/deadlines/engine.ts  (pure)
export interface DeadlineSpec {
  id: string; label: string;
  anchor: { subjectPattern: "txn" | "seg" | "inc" | "chg" | "shp"; factKey: string };  // the LEGAL trigger; never a fallback date
  anchorKind: "event_occurred" | "notice_sent" | "notice_received" | "statement_transmitted" | "purchase" | "delivery" | "report_filed";
  offset: { amount: number; unit: "calendar_days" | "business_days" | "hours" | "elapsed_24h_days" /* R01 v1 legacy parity */ };
  boundary: { anchorDayCounts: boolean; endInclusive: boolean };  // e.g. "within 60 days after X": anchorDayCounts=false, endInclusive=true
  endOfDay: "local_end_of_day" | "exact_instant";
  timeZone: { from: "fact"; factKey: string } | { fixed: string };  // e.g. fact "txn.time_zone" (user-confirmed IANA zone; the UI pre-fills the browser's zone as a candidate)
  holidays: "none" | "us_federal";
  mustBe: "received" | "sent" | "filed" | "n_a";                 // receipt vs dispatch semantics
  extensions?: { factKey: string; addDays: number; sourcePassageId: string }[]; // only source-backed
  sourcePassageId: string;
}
export function computeDeadline(spec: DeadlineSpec, snapshot: DeadlineFacts, now: number): DeadlineResult;
//  anchor cell missing | candidate | user_unknown -> status "unknown_anchor" (dueAt undefined)
//  anchor cell conflicting                        -> "disputed_anchor", basis lists each candidate due date
//  business_days beyond the committed holiday table (lib/deadlines/usFederalHolidays.ts, explicit observed dates 2024–2030) -> "beyond_calendar"
//  timezone unknown and endOfDay=local_end_of_day -> dueLocalDate is still computed; dueAt = the end of that local date in the
//     EARLIEST-ENDING zone of the committed US zone list (lib/deadlines/usZones.ts; the conservative cutoff), and the
//     result carries an assumption "time zone not confirmed; showing the earliest possible cutoff for <date>"
//  otherwise "open" | "passed" relative to `now`; dueLocalDate via YYYY-MM-DD calendar arithmetic, dueAt via Intl offset lookup
export function sendByAdvice(r: DeadlineResult, mailDays: number): number | undefined;
//  for mustBe "received": an ADVISORY send-by date (UI copy "mail by"), never presented as the legal deadline
```

The rules for the deadline engine are these:
- The engine never infers an anchor from "the easiest date". A spec names exactly one anchor fact key per anchor kind, and there is no fallback.
- It never treats an expired path as "no recovery": the outcome is `deadline_passed` for that opportunity only.
- Local-date arithmetic runs on `YYYY-MM-DD` strings (no DST drift). The UTC instant comes from `Intl.DateTimeFormat` offset resolution, with fixtures across both 2026 US DST transitions.
- Tests inject `now`. Queries never compute outcome transitions; they return `dueAt` and the UI counts down with the client clock (HC-13). Mutations recompute authoritatively.

---

## 5. State separation

| State | Holder | Values | Written by |
|---|---|---|---|
| **Eligibility** | `opportunities.outcome` (+ history in `evaluations`) | §2.4 `evaluationOutcome` | `recordEvaluation` only (deterministic). No user or model write path. |
| **Opportunity lifecycle** | `opportunities.status` | open → case_open → (open on dismissed/denied) \| closed (confirmed); open → dismissed (user); any → superseded (scenario withdrawn) | `openCase`, claim-closure hooks, `opportunities.dismiss` |
| **Case workflow** | `claims.status` (persisted, existing semantics kept) | detected, drafted, queued, sent, packet, promised, confirmed, reopened, dismissed, **+ denied (wave 2)** | existing writers + `claims.recordDenial` |
| **Delivery** | email: `drafts` (`outboundId`, `agentmailMessageId`, `sendError`) + `claims.sendUnknown` + component status; manual: `packets.status` + `submissions` | derived by `lib/claimState.delivery()`: `none`, `draft`, `approved`, `queued`, `accepted` (outbound id, no message id), `sent` (message id), `delivered` (component status `delivered`), `failed`, `bounced`, `unknown` (`sendUnknown`), `stalled` (queued > `MAIL_RECONCILE_STALL_MS`, from a coarse `now`), `packet_prepared` (packet approved), `submission_recorded` (a `submissions` row exists), `user_reported` (legacy `packet` status set by note-only `markPacketSent`, no submissions row: shown as "You said you contacted them", never as "Sent") | existing reconcile + `packets.approve` + `submissions.record` |
| **Recovery** | derived from `ledgerEvents` + `nonCashRemedies` | `none`, `promised`, `provisional`, `partially_recovered`, `recovered`, `over_credited`, `reversed` (later debit reopened it), `non_cash_received` | never stored |
| **Expired** | derived | a claim not yet submitted whose opportunity's deadline is `passed` shows "expired" | display only; never a stored status (no clock-driven writes) |

**Legal claim-status transitions.** "Existing" means they are already enforced in code today; they are unchanged and pinned by regression tests. "New" transitions are marked with `+`.
- create → `detected` (`openClaim`)
- `detected` → `drafted` (`drafts.insert`)
- {detected, drafted, sent, packet, promised, reopened} → `queued` (`approveAndSend`; refused from queued/confirmed/dismissed, **+ refused from denied**)
- `queued` → `sent` (reconcile message id); `queued` → `drafted` (terminal failure/bounce)
- {detected, drafted, promised, reopened} → `packet` (**+ now only through `submissions.record` with an approved, non-stale packet**; `markPacketSent` is kept as a thin wrapper that requires a `packetId` for scenario claims and keeps its legacy note-only behaviour for R01/return claims so the existing UI and tests pass; the delivery projection then shows `submission_recorded` only when a `submissions` row exists)
- any non-dismissed → `promised` (promise event or promise reply)
- any → `confirmed` (settled)
- `confirmed` → `reopened` (debit or expected change)
- `reopened` → `confirmed`
- any except confirmed → `dismissed`
- **+ {sent, packet, promised, reopened} → `denied`** (`claims.recordDenial`, a user action after a refusal reply or other evidence)
- **+ `denied` → `promised`/`confirmed`** (money can still arrive)
- **+ `denied` → `dismissed`**

Every "is this claim closed?" check moves to one exported `CLOSED_FOR_ASK = ["confirmed", "dismissed", "denied"]` / `CLOSED_FOR_MONEY = ["dismissed"]` in `lib/claimState.ts` (M10 wave 1, before `denied` exists), so wave 2's literal is a one-line change. The current call sites are priceWatch.ts:71, claims.ts:75, drafts.ts:238/450/748, followUps.ts:113, purchases.ts:518, and tracking.ts:229.

**Mapping to the mission §14 display model** (`lib/claimState.display()`, used by the new UI; existing `StatusPill`/`StatusSteps` keep working on the raw status):

| Display | Source |
|---|---|
| detected | opportunity open with outcome eligible or likely_eligible |
| needs facts | outcome needs_facts |
| likely eligible | outcome likely_eligible |
| user verified | all bound facts confirmed and the case opened |
| ready to send | claim drafted with a current binding, or a packet approved |
| submitted | delivery ∈ {sent, delivered, submission_recorded} |
| paid | recovery `recovered` |
| denied | `denied` |
| escalated | wave 3 (a follow-on case links `escalatedFromClaimId`) |
| expired | derived, as in the table above |

---

## 6. Channels

| Channel | Artifact | "Prepared" | "Submitted" | "Sent" | "Delivered" |
|---|---|---|---|---|---|
| Email (AgentMail, existing) | `drafts` row (+ `binding`) | draft generated with a binding | — | `agentmailMessageId` present (reconcile) | component status `delivered` (provider-reported; shown only when reported) |
| Postal / web form / portal / phone / chat / in person | `packets` row (letter + evidence index + submission instructions) | `packets.status = approved` (the user can print or copy it) | a `submissions` row the user recorded (date, optional confirmation #, optional proof evidence) | — (never claimed) | only `deliveryRecordedAt` + `deliveryEvidenceId` (for example, a certified-mail return receipt) |

- **Approval binding (both channels).** At generation, the writer stores `binding = { claimVersion, amount, opportunityId, evaluationId, ruleId, ruleVersion, boundFactsHash, attachments, contextHash }`.
  - **Email:** `approveAndSend` keeps every existing check (D11/D18/D58/B1) and adds, immediately before the enqueue: (a) re-evaluate the opportunity (trigger `approval_check`, same transaction); (b) rebuild the binding from current state; (c) refuse if `contextHash` differs ("The facts or rules behind this claim changed; review the updated draft") or if the fresh outcome is `deadline_passed`, `not_eligible`, `unsupported`, or `source_unverified`; (d) store `approvedHash = sha256(contextHash + to + subject + body)`. When the claim has no `opportunityId` (return claims, and R01 claims opened before wave 1 and not linked by the optional migration), steps (a)–(d) are skipped and behaviour is byte-identical to today. When the claim has an opportunity but the draft predates wave 1 (no `binding`), steps (a) and (c)'s outcome refusal still run, but the `contextHash` comparison is skipped because there is nothing to compare.
  - **Manual:** `packets.approve({ packetId, approvedHash })`. The client echoes the hash it rendered. The server recomputes it and refuses on mismatch. The server also refuses: when there is a newer packet version; when `binding.contextHash` ≠ current; when the recipient is empty; when an evidence item is no longer owned, is `content_deleted`, or has a changed `contentHash`; when the outcome is ∉ {eligible, likely_eligible, possible_contract_benefit}; and for example claims ("Example claims cannot be submitted").
  - `submissions.record({ packetId, submittedAt, confirmationRef?, proofEvidenceId?, note? })` requires an `approved` packet whose `approvedHash` still recomputes. It stores `approvedHash` on the submission, sets the claim `packet` and the packet `submission_recorded`, and schedules the reminder.
  - Any edit of a packet or draft clears its approval (existing D-pattern). Any material re-evaluation bumps `claims.version`, which invalidates both artifacts through their `claimVersion`.
- **Recipient provenance.** Email keeps D18: only a user-confirmed policy contact auto-fills or waives the tick; any other address needs `recipientConfirmed`, and the UI warns when the domain differs. A packet recipient must carry a `recipientSource`. For R03, it is `user_entered_from_document` with the statement's evidence id: **Recoup never supplies or guesses a billing-error address.**
- **Attachments.** Phase-1 email carries **no attachments** (HC-18: inline base64 in a component document risks the 1 MiB limit). The body carries an evidence index, and the packet page offers the files for the user to attach through manual channels. Revisit with a size cap ≤ 700 KB total, or when the component supports references (open decision O10).
- **Letters are deterministic templates.** Packets for R02–R05 are rendered by `lib/packets/<scenario>_v<N>.ts` from bound facts and pack text, with no model call. Mission §6 and §14 forbid fabricated official language, and the template is testable. A model may later offer an optional tone rewrite of the free-text summary paragraph, but the user sees the diff. R01 keeps its existing LLM draft path unchanged.
- **Formal notices** (R03, and later R13) are `postal_mail` packets, unless the reviewed pack's source designates an electronic channel. Email to an issuer is labelled "informal contact — does not replace the written billing-error notice" (K04).
- **Reminders:** reminder-only (D03). The delay is `pack.responseExpectation` when a reviewed source states one, otherwise the existing 7-day floor. `followUps.fire` keeps re-reading claim status (D28/D42).

---

## 7. Intake

Pipeline (C37, C38): **channel → processedEvents (existing dedupe) → evidence row → candidate facts / needs_review transaction → user confirmation → active transaction → evaluation.**

- **Forward and paste (reusing `intake.ts`).** `onMessageReceived`, `paste`, `beginEvent`, and the budgets are unchanged. In `applyExtraction`:
  1. **(wave 1, M13)** insert an evidence row (text, contentHash, processedEventId, docType from the classification) and link it: `applyOrder` creates the needs_review purchase as today **plus** `ensurePurchaseTransaction` (status needs_review, `sourceEvidenceId`); `applyRefund` links the evidence to the matched transaction.
  2. **(wave 1)** currency: `order.currency` unclear → the purchase is still created with `currency: "USD"` (the schema requires a string). A `txn`-level fact `retail.currency` is created as a candidate, `summary` says "currency not stated — confirm it", and `purchases.confirm` gains `currency: v.optional(v.string())` (validated with `assertCurrency`; changing it is refused once any claim exists). This fixes HC-9.
  3. **(wave 1)** `applyRefund` refuses (per-credit `needs_review`) a credit whose currency ≠ `purchase.currency`. This fixes HC-10.
  4. **(wave 2, M23)** for `kind === "other"`: a second-stage classifier (`DocumentClass` zod: e_ticket, itinerary_change_notice, cancellation_notice, baggage_report, shipping_notice, delivery_notice, delay_notice, card_statement, other) followed by the doc-type schema (`lib/schemas_docs.ts`: every field `{ value: string | null, quote: string | null }`, amounts as decimal strings) → candidate facts + a needs_review transaction. Each stage charges `inbound_extract` (at most 2 units per event). A statement that yields several charges produces **several candidate lines on one evidence row**. The user picks which become `card_charge` transactions, and they are never merged.
- **Manual entry (wave 2).** `transactions.createManual({ category, facts: [{ subjectKey, key, value }] })` creates the transaction `active`, with every fact `user_confirmed` (source `user`), after catalogue validation. Retail manual entry uses the existing `purchases.create`. The UI gains a form (the backend already exists).
- **Upload (wave 1 store-only, wave 2 extraction).** §2.6. Extraction runs in `evidence.extract` (an internalAction; the lease is `extractionStartedAt`; attempts ≤ 3; a sweep re-drives stale leases through the `crons.ts` owner). PDFs and images go to the **existing** OpenAI provider as file or image input with the page cap. No new provider. `card_statement` is `store_only` until M03 signs off (the user transcribes the one line through manual entry). Encrypted or malformed files → `unsupported` with a user-facing summary. Magic bytes must match the declared type. Active content is never rendered or executed; the UI shows images through `getUrl` in `<img>`, and PDFs only as download links.
- **Confirmation.** `transactions.confirm({ transactionId, confirmations: [{ factId, action: "confirm" | "reject" | "correct", value? }] })` applies each entry through `putFact`, sets the transaction active, projects display fields, and calls `evaluateTransaction(trigger "fact_change")`. For retail, `purchases.confirm` stays the entry point and calls `ensurePurchaseTransaction` + evaluation.
- **Owner-scoped dedupe.** Evidence dedupes on `(userId, contentHash)`. Forwarded mail dedupes on the AgentMail event id (global and unguessable, existing) plus `sourceMessageId`. Pastes dedupe on `paste:<userId>:<sha>` (D54). Transactions dedupe on `(userId, naturalKey)` through `by_user_and_natural_key`; a duplicate goes to `needs_review` "Duplicate of …" (the D22 pattern). Retail keeps `by_user_domain_order`. Retries and duplicate provider events hit the same keys, and a financial event is never duplicated because the ledger keeps its per-claim idempotency.
- **Untrusted content.** Extraction output only proposes candidate facts with quotes. It never selects tools, recipients, or rules, and never creates a confirmed fact, a claim, or money. The `lib/ai` prompt-injection guard is reused. A quote that is not found verbatim marks the fact `quoteVerified: false`.

---

## 8. Migration and compatibility

- **Schema deploys are additive per wave.** Wave 1 adds new tables, optional fields, and the widened `eventKind` (2 literals). Wave 2 adds `claimType += scenario`, `claimStatus += denied`, optional `purchaseId`/`itemId`, and `packets`/`submissions`. Every existing document validates under the new schema, so no deploy-time backfill is needed. New indexes on `claims` are unstaged, which is fine because the table is small (a few hundred rows per deployment). Mark them `staged: true` if an operator's production table is found to be large (guidelines).
- **Backfill: none required.** Transactions are created lazily. `claimCurrency()` falls back to `purchases.currency`. Legacy claims have no `opportunityId` and keep their legacy behaviour. **Optional** `migrations.linkLegacyPurchases({ cursor })` (M12): an internal, paged mutation (200 rows), self-rescheduling with an `opsState` cursor, idempotent. For each active non-example purchase with an item inside an open R01 window, it creates the transaction, evaluates R01, and links any existing open price claim as `activeClaimId` (it sets `claims.opportunityId`/`transactionId`/`currency`). Recommended as a RUNBOOK step right after the wave-1 deploy so "Potential" is complete immediately instead of after ≤ 2 h plus rotation. The lead records the choice (O4).
- **Deploy order per wave.** (1) Backend: schema + functions deploy atomically. The old frontend keeps working because return validators built on `schema.doc(...)` only gain optional fields. (2) Run the optional migration. (3) Frontend static upload. Codegen: the lead regenerates and commits `convex/_generated/api.d.ts` at wave close (D92).
- **What code rollback cannot undo.**
  - (a) Once any row uses a widened literal (`provisional_credit`, `scenario`, `denied`), redeploying an older commit fails schema validation. Rollback means a *hybrid* commit (old functions + new schema) or a forward fix.
  - (b) Once a scenario claim with no `itemId` exists, pre-wave-2 functions would throw on it (`ctx.db.get(undefined)` paths in HC-1). Rolling back functions after the first scenario claim is unsafe.
  - (c) Uploaded blobs and evidence rows persist. The account purge deletes them, and a code rollback does not.
  - (d) Evaluation history written under pack v1 stays. It is explainable only while `r0x_v1.ts` remains in the tree (the immutability rule keeps it).
  - (e) A `claims.version` bump from a material re-evaluation invalidated drafts. That is intended, and a rollback does not "un-invalidate".
- **Account lifecycle (M14).** Add every new table to `EXPORT_TABLES`/`TABLE_SPECS` (direct specs through `by_user` or `by_user_and_status`) and to `PURGE_STEPS` in child-first order: `submissions, packets, nonCashRemedies, evaluations, opportunities, facts, incidents` before `claims`; `evidence` (blob delete first, then the row, byte-aware page) and `uploadTickets` before `profiles`. Add storage-deletion idempotency: a missing blob is treated as deleted. Retention: evidence rule §2.6; uploadTickets older than 24 h deleted; evaluations never pruned (they are case history; growth is bounded by resultHash dedupe).
- **Regression suites that must stay green, unmodified except for fixture-clock fixes (M04):**
  - Convex: `claims`, `drafts`, `replies`, `followUps`, `priceWatch`, `purchases`, `intake`, `inbound`, `policies`, `examples`, `watches`, `offers`, `market`, `tracking`, `insights`, `dashboard`, `freshness`, `readBudget`, `fairness`, `lifecycle`, `account`, `retention`, `boundary`, `http`, `mailEvents`, `notify`, and `lib/*`.
  - Browser: the `e2e/` specs (auth, watches, purchases, claims, resilience, isolation, lifecycle).
  - A wave is closed only with the full suite green on the integrated tree (D89), plus the new suites in §10.

---

## 9. Information architecture

- **Routes stay:** `/` (dashboard), `/watching`, `/purchases/:id`, `/claims/:id`, `/settings`, `/privacy`. **Returns-first navigation is not resurrected.** There is no "Returns" nav item, and the return_credit backend stays unexposed (the 2026-09-20 direction, D136).
- **Routes added (wave 2, App.tsx owner = frontend):**
  - `/add`: the intake hub with tabs "Forward or paste" (moves the existing paste panel; Settings keeps inbox and account), "Upload", and "Enter manually" (Retail order | Flight | Card charge). The nav item "Add purchase" becomes "Add" → `/add`, and `/settings` loses the add panel.
  - `/transactions/:id`: facts grouped as confirmed or needs-your-confirmation; incidents ("Something went wrong?" → incident picker); opportunity cards; the "Not checked yet" list from `coverage.ts`; the evidence list. For a `retail_order` it **redirects to `/purchases/:purchaseId`**, which gains the same Opportunities section. Unknown or foreign ids render the existing not-found state (P10).
  - `/opportunities`: every open opportunity across transactions, filterable by outcome and deadline.
- **Opportunity card** (`src/components/opportunity/OpportunityCard.tsx`, wave 1 for R01):
  - Header: category plus an **authority badge** (Law / Card contract / Store or airline promise / Program or settlement / Goodwill) with a subtype tooltip.
  - Amount: shown only when `estimate` exists, formatted with `formatMinor`; the cap is shown as "limit", never as the amount. Cash / non-cash / provisional label.
  - Outcome and explanation: an outcome label plus the deterministic explanation sentences.
  - Missing facts: "Answer 2 questions" (inline).
  - Assumptions and exclusions: collapsible, each one saying "changes the answer if …".
  - Deadline: the deadline with its `basis`, the mustBe (received/sent) wording, and a client-clock countdown; `unknown_anchor` renders as "Deadline unknown — we need <fact>".
  - Source: title, link, passage excerpt (≤ 1 quote), effective date or "unknown", and pack version.
  - Formula when meaningful.
  - Related paths ("Alternative to …" / "Also possible …").
  - A single primary action from `nextAction`: Answer questions / Add evidence / Start claim / Continue claim / Why not? No fabricated confidence percentages.
- **Questions UI** (`src/components/opportunity/Questions.tsx`): one field per missing fact, with the catalogue prompt and a "why we ask" line. Sensitive keys explain the need and never ask for full card number, CVV, or credentials. Every question has an "I don't know" option. Submitting writes `user_confirmed` facts and re-evaluates. Corrections go through the same form.
- **Packet review** (a section of `/claims/:id` for scenario claims): factual summary, requested remedy, calculation, timeline, evidence index (with add and remove), source, recipient with its provenance, the editable letter, assumptions and missing items, submission instructions per channel, and an "I have reviewed this packet" approve button showing the binding summary. After approval come "Download / print" and "Record that I submitted it" (date, confirmation #, optional proof upload). Labels are always "Prepared", "You recorded submitting it on …", and "Sent by Recoup (email)".
- **Dashboard:** replace the money stat cards' data source with `recovery.summary` and show, per currency, separate tiles for Recovered, Provisional, Promised, Asked, Ready to ask, Potential (estimated, not guaranteed), and Non-cash (count). Price-tracking widgets stay on `tracking.overview`. Add a "Needs your answers" strip (opportunities with outcome needs_facts, bounded) and a "Deadlines this week" strip (client clock over `nextDeadlineAt`).

---

## 10. Acceptance criteria (each a test; "fixture" = hand-written expected values)

**Common to every slice (per active evaluator, mission §17):**
- Each fixture category (positive, negative, missing fact, contradictory fact, boundary time ±1 unit around each deadline, unsupported jurisdiction/product/payment, missing or non-active source, exclusion, duplicate evaluation, overlapping remedy) produces the hand-written `outcome`, `missingFacts`, `disqualifierIds`, and `amount`.
- Evaluating twice with the same snapshot and `now` yields an identical `resultHash` and **one** `evaluations` row.
- A foreign `transactionId`, `opportunityId`, `evidenceId`, `packetId`, or `claimId` on any public function throws the same "not found" as a missing id (two-user tests).
- No evaluator module imports `lib/ai` (grep test).

**R01 Retail price adjustment (wave 1 retrofit):**
1. **Parity:** the unmodified `priceWatch.test.ts`, `claims.test.ts`, `examples.test.ts`, `tracking.test.ts`, and `dashboard.test.ts` pass. For every `recordCheck` fixture the set of claims opened (count, `expectedCents`, `windowEndsAt`, `policyId`, `openedFromPriceCheckId`) is identical to `5cc326d`.
2. 2 units paid 12,000 minor; an accepted observation of 9,500 (USD, `variantMatch: exact`, confidence ≥ 0.7) inside the window → an opportunity with `amount.estimate = {5000, USD}`, formula `(12,000 − 9,500) × 2`, and exactly one `price_adjustment` claim with `expectedCents 5000`. A second identical check → no new claim and no new evaluation row (same resultHash).
3. Wrong variant (`unsure`/`none`), a different currency, a range, or confidence < 0.7 → no observed cell, the opportunity is not eligible or needs facts, and **no claim** is opened.
4. Policy snapshot unconfirmed → outcome `likely_eligible`, with missing fact `retail.policy_confirmed` and the assumption "current page text assumed to govern your purchase". Confirmed snapshot → `likely_eligible` with the temporal assumption. No policy or no `windowDays` → `source_unverified` and no claim.
5. Window closed (at `now = windowEndsAt + 1`) → `deadline_passed`, and `approveAndSend` on an existing R01 draft refuses with the window message (new authoritative check). At `windowEndsAt − 1` it is allowed.
6. A settled R01 claim for 5,000 followed by a further drop → only `remaining = drop − 5,000` is estimated and asked, never the full drop again (lossKey `item:<id>:price_diff`).
7. ShopSavvy `marketPrices` and unconfirmed offers never change an R01 outcome or open a claim. The test inserts a lower market price and asserts no change.
8. Dashboard: `recovery.summary` Potential for an R01 opportunity with an open claim is 0 (it is in Ready to ask instead). The sum Ready to ask + Asked + Recovered is never greater than the claims' `expectedCents` plus over-credit.

**Core financial fixtures (mission §17, wave 1, `convex/ledgerFixtures.test.ts`):**
- expected 4,000 / promise 4,000 → unresolved 4,000; confirm 1,500 → 2,500; confirm 2,500 → 0 (confirmed).
- later debit 1,000 → only that claim is `reopened` with unresolved 1,000; a sibling claim's status and balance are unchanged.
- provisional 2,000 → Recovered unchanged and Provisional 2,000; finalize → Recovered +2,000 and Provisional 0; reversal → Provisional 0 and Recovered unchanged.
- two coordinated opportunities estimating 3,000 and 2,500 for the same lossKey → Potential 3,000, not 5,500.
- a USD claim and an EUR claim → two currency rows, and no field anywhere sums them.
- a non-cash voucher with face 5,000 → Recovered unchanged and Non-cash count 1.
- a promised_credit from a refund email in a currency ≠ the purchase's → refused (HC-10).

**R02 Airline cancellation or significant change (wave 2):**
1. An original and a changed itinerary where the changed arrival is later by ≥ `params.significantChangeMinutes[scope]` (the value comes from M02's DOT passage; document B's 3 h domestic / 6 h international is a *candidate to verify*), `air.alternative.accepted = false` (confirmed), and the ticket seller = carrier → outcome `eligible` or `likely_eligible`, remedy `airfare_refund`, authority `legal_entitlement`, and an estimate equal to confirmed paid fare + taxes/fees for the unused segments only. With partial use and no per-segment amounts → `amountCalculable: unknown` and no estimate.
2. The same, with `alternative.accepted = true` or the changed flight flown (`air.segment.flown` confirmed) → `not_eligible` for `airfare_refund`, with the explanation citing the acceptance condition.
3. Acceptance not answered → `needs_facts` whose `missingFacts` includes exactly `air.alternative.accepted` (plus any other truly missing keys). The question renders once, and "I don't know" leaves the outcome at `needs_facts`.
4. **A one-hour delay with no other qualifying event** → no opportunity of any scenario with `cashClass: "cash"` and outcome ∈ {eligible, likely_eligible}. The transaction page shows R02 as not eligible, with the reason.
5. Refund-timing deadlines use separate specs per payment class (credit card vs other) from M02's passages. An unknown payment class → `unknown_anchor`/`needs_facts`, never one merged timer.
6. Denied boarding, delay inconvenience, carrier commitments, card insurance, and ancillary refunds never appear as R02 remedies. They are separate scenarios, listed as "Not checked yet" unless their packs are active.
7. Foreign currency, or a non-US itinerary outside the pack's jurisdiction → `unsupported` (not `not_eligible`).
8. Browser: intake an e-ticket email + change notice → confirm facts → answer the acceptance question → review the card (authority, source, deadline) → start a claim → review the packet → approve → record a submission (or approve and send an email to an `.example` recipient in an example account) → record a promise → confirm posted funds → dashboard Recovered equals the confirmed amount.

**R04 Delayed, lost, or damaged baggage (wave 2):**
1. Delayed bag with documented expense lines 3,000 + 2,000 (confirmed amounts, verified receipt quotes), report filed (`bag.report.filed_at` confirmed) → `incidental_expenses` estimate {5000, USD} with basis `documented_total`. `amount.cap` (the liability ceiling from M02) is shown as a cap and never used as the estimate.
2. A user-claimed expense line without a receipt → excluded from the estimate and listed in `missingFacts`/add_evidence. Claiming more than the documented total is refused at case open.
3. `bag_fee_refund` is a separate opportunity (lossKey `txn:<id>:bag_fee:<n>`, relation `complementary` to expenses). The total potential = expenses + fee, and one expense line cannot sit in two active cases (lossKey guard).
4. Lost/damaged property → `property_loss_or_damage` requires the user-claimed value with evidence (basis `user_claimed`). Its estimate never exceeds the claimed documented value, and the ceiling is shown as a limit.
5. No report filed and the report deadline unknown → `needs_facts`, never an inferred date.

**R05 Late or missing online order (wave 2):**
1. Promised ship-by date confirmed, no shipment evidence by then, and no delay notice or consent → `cancel_and_refund_unshipped`, outcome eligible or likely_eligible (authority `legal_entitlement`, subtype `federal_regulation`, params from M02's MITOR passage). The estimate = confirmed order total paid.
2. No ship-by promise stated → the default shipping period from `params.defaultShipDays` (M02; candidate 30 days) with the assumption "no shipping time was stated". An unknown order date → `needs_facts`.
3. Shipped on time but delivered late (in-transit delay) → R05 `not_eligible` for the MITOR remedy, with explanation. **The shipment date and delivery date are separate keys, and swapping them changes the outcome** (fixture).
4. Merchant-consented delay confirmed (`order.delay_consent = true`) → not eligible for the unshipped-cancel remedy until the consented date passes. Consent unknown → `needs_facts`.
5. Non-delivery after shipment, disputed delivery, and theft after delivery are distinct incidents. None of them produces the MITOR remedy. A linked card charge can surface R03 (§R03), coordinated on `txn:<paid>:paid`.

**R03 Credit-card billing-error evidence packet (wave 2):**
1. `payment.method_class = credit_card` (confirmed), error type ∈ {duplicate, wrong_amount, credit_not_posted, not_delivered_as_agreed, unauthorized}, first statement transmission date confirmed → deadline `mustBe: "received"`, computed from that anchor per M02's Reg Z passage (candidate 60 days). The packet is `postal_mail` to a recipient with `recipientSource: user_entered_from_document`.
2. First statement date unknown → deadline `unknown_anchor` and missing fact `card.first_statement_date`. The transaction date is **never** used as the anchor (fixture asserts `dueAt` undefined).
3. `payment.method_class = debit_card` → `unsupported` ("Debit card errors follow different rules (R13), not checked yet"), not `not_eligible`, and no packet.
4. Packet approval refuses an empty recipient, a stale binding, or an evidence item with a changed hash. Submission recording requires an approved, non-stale packet. The dashboard counts it under Asked only after the submission is recorded.
5. Merchant outreach is optional and never blocks the notice: the packet page offers "contact the merchant" as a parallel action, and the deadline countdown is always shown.
6. The letter template contains a signature line and no representation claims. A test snapshots the template for a fixture and asserts no text outside the template + facts (the only interpolations are fact values).

**iPhone cross-category case (mission §12), a synthetic fixture:** "iPhone 17 Pro 256 GB", retail order at a merchant with an R01 policy snapshot, paid by credit card (product unknown), purchased 10 days ago.
1. The transaction page shows each of these, each either **evaluated** or **explicitly listed as not checked with a reason**: price adjustment (R01, evaluated); merchant return window (informational line from the returns policy snapshot, no amount); card purchase, return, and extended-warranty protection (R06, R07, R08: "not checked — needs your exact card product and its benefit guide (coming in Phase 2)"); manufacturer warranty or AppleCare (R10: not checked); recall or service program (R11: not checked, and **no serial number is requested** while no pack needs it); trade-in discrepancy (not supported); delivery or billing error (R05 evaluated only if the order is online; R03 only if a card charge or incident exists); carrier promotion or bill credit (not supported); settlement match (R23: not checked).
2. **No digital-content-refund path appears** for this physical-device receipt (assert absence).
3. Questions asked are only those an active pack needs (for R01: variant confirmation if the observation was not exact, policy confirmation). No card number, CVV, or serial number is asked.
4. The dashboard Potential equals the R01 estimate exactly (or 0). Unsupported, non-cash, and cap values contribute 0.

---

## 11. Implementation task breakdown (waves 1–3)

Rules for all tasks:
- Owner files are **exclusive** for the wave.
- Each task carries its tests.
- Commits use a pathspec.
- The lead regenerates `convex/_generated/**` at wave close.
- **Single owners in wave 1:** schema.ts → M10; convex.config.ts → M10 (no change expected); http.ts → M13 (no change expected); package.json/lockfile → M16 (no change expected); App.tsx → M15 (no change in wave 1); crons.ts → M12 (optional migration only).

### Wave 1 — safety foundation + R01 retrofit (one complete vertical slice, mission §19)

| ID | Owner | Only-writer files | Depends on | Required tests |
|---|---|---|---|---|
| M10 | backend | `convex/schema.ts`, `convex/lib/money.ts`, `convex/lib/ledger.ts`, `convex/lib/balance.ts`, `convex/lib/claimState.ts` (new), `convex/lib/canonical.ts` (new), `convex/lib/access.ts`, `convex/limits.ts`, `convex/claims.ts` (+ their tests) | M01 approved | ledger exhaustive-kind test; §10 core financial fixtures (lib-level); `assertMoney`/`parseDecimalToMinor` property tests (no float, rejects `1e3`, `-1`, `12.345` for USD); `CLOSED_*` call-site refactor keeps every existing claims/drafts/priceWatch test green; the provisional/non-cash mutations' idempotency, conflict, foreign-claim, and currency-mismatch tests |
| M11 | backend-2 | `convex/transactions.ts`, `convex/facts.ts`, `convex/lib/facts/{catalog,subject,values,resolve,write,snapshot_retail,legacyRetail,keys_retail,keys_order,keys_air,keys_card}.ts` (the last three are empty stubs), `convex/purchases.ts` (`ensurePurchaseTransaction` on create/confirm; `confirm.currency`) (+ tests) | M10 | resolution-matrix tests (each state combination → cell status, incl. confirmed-vs-observed conflict and `user_unknown`); `putFact` refuses a foreign item/incident/evidence, an off-catalogue key, a wrong value kind, or a code not in the list; supersede rules; `ensurePurchaseTransaction` is idempotent under two concurrent calls; `purchases.confirm` currency change refused once a claim exists; unchanged `purchases.test.ts` passes |
| M12 | backend-3 | `convex/lib/rules/{types,outcome,registry,coverage,applicable,r01_price_adjustment_v1}.ts`, `convex/lib/rules/fixtures/r01_v1.fixtures.ts`, `convex/lib/deadlines/{engine,calendar,usFederalHolidays}.ts`, `convex/opportunities.ts`, `convex/recovery.ts` (`summary`), `convex/migrations.ts` (optional `linkLegacyPurchases`), `convex/priceWatch.ts` (retrofit `recordCheck`; exports `evaluateR01ForClaim(ctx, claim, now)` which M13 calls from `drafts.ts`; M12 never edits `drafts.ts`), `convex/crons.ts` (no change expected) (+ tests) | M10, M11, M02 R01 spec | `deriveOutcome` exhaustive precedence table; deadline engine fixtures (calendar/business days, inclusive/exclusive, DST 2026-03-08 and 2026-11-01, unknown/disputed anchor, beyond_calendar); R01 §10 items 1–8; `evaluateTransaction` twice → one evaluation row; concurrent `openCase` → one claim; material-change version bump invalidates a draft; `recovery.summary` per-currency and overlap rules, bounded under `transactionLimits: true` at 200 opportunities + 200 claims |
| M13 | ingestion-integrations | `convex/evidence.ts` (new: tickets, register, getUrl, remove, store-only), `convex/intake.ts` (evidence rows, currency candidate, applyRefund currency refusal), `convex/lib/schemas.ts` (currency nullable), `convex/drafts.ts` (binding at `insert`, approval-time re-evaluation + `approvedHash` for claims with `opportunityId`), `convex/http.ts` (no change expected) (+ tests) | M10, M11 (write helpers), M12 (evaluation helper, for drafts) | upload ticket required, expired, or reused → refused; register twice → one row; same bytes from user A and user B → two rows (no global dedupe); size/type refusal deletes the blob; forwarded order → purchase + transaction + evidence linked; unclear currency → candidate + summary; foreign-currency refund credit → needs_review, no ledger write; approval refused after a material re-evaluation, allowed on a legacy draft; prompt-injection text in an email creates no confirmed fact and no claim |
| M14 | backend | `convex/account.ts`, `convex/retention.ts` (+ tests) | M10 | export includes every new table for the owner only (forged cursor → nothing foreign); purge deletes the new tables child-first plus storage blobs, resumable after a crash between blob delete and row delete; retention sets unlinked evidence to `content_deleted` after 30 days and never touches linked evidence, evaluations, or ledger |
| M15 | frontend | `src/components/opportunity/{OpportunityCard,Questions,AuthorityBadge,DeadlineLine}.tsx` (new), `src/components/purchase/ItemTracker.tsx`, `src/lib/money.ts` (exponent-aware), `src/components/dashboard/StatCards.tsx`, `src/App.tsx` (no change) | M12 queries | component tests for the card states (each outcome, unknown deadline, cap shown as limit, no estimate → no amount); axe on Purchase and Board; the existing e2e purchases/claims specs pass |
| M16 | qa | `convex/ledgerFixtures.test.ts`, `convex/r01Parity.test.ts`, `convex/isolationM1.test.ts`, `e2e/r01-opportunity.spec.ts`, `docs/reviews/2026-09-2x-wave1-qa.md`, `package.json` (only if a test dependency is unavoidable) | M10–M15 | independent (not written by M10–M15): §17 core financial fixtures end to end through public mutations; R01 parity against `5cc326d` fixtures; two-user isolation for every new public function; a browser run of watch → buy → price drop → opportunity card → claim → draft → approve (example `.example` recipient refused) → confirm credit → dashboard |
| M17 (DA) | devils-advocate | `docs/reviews/…-da-checkpoint-B.md` | M10–M16 | checkpoint after the integrated slice (mission §16) |

### Wave 2 — Phase 1 slices R05 → R02 → R04 → R03 on the proven structure

| ID | Owner | Only-writer files | Depends on | Required tests |
|---|---|---|---|---|
| M20 | backend | `convex/schema.ts` (wave-2 addendum), `convex/claims.ts` (`insertScenarioClaim`, `recordDenial`, `get` for item-less claims), `convex/followUps.ts`, `convex/replies.ts` (scenario-aware prompt + `expectedDomain`), `convex/insights.ts` (optional ids), `convex/packets.ts` (new), `convex/submissions.ts` (new), `convex/lib/packets/common.ts` (new), `convex/lib/facts/catalog.ts` (merge only) | wave 1 closed | every HC-1 site handles item-less claims (compile + tests); packet approve/record binding tests from §6; denied transitions; reminder uses pack `responseExpectation` |
| M21 | commerce-payments | `convex/lib/facts/{keys_order,keys_card,snapshot_order,snapshot_card}.ts`, `convex/lib/rules/{r05_late_order_v1,r03_billing_error_v1}.ts` + fixtures, `convex/lib/packets/{r05_v1,r03_v1}.ts` | M20, M02 R03/R05 specs | §10 R05 and R03 items; payment-class routing; the debit card → R13 unsupported fixture; template snapshot tests |
| M22 | travel | `convex/lib/facts/{keys_air,snapshot_air}.ts`, `convex/lib/rules/{r02_air_refund_v1,r04_baggage_v1}.ts` + fixtures, `convex/lib/packets/{r02_v1,r04_v1}.ts` | M20, M02 R02/R04 specs | §10 R02 and R04 items, incl. the short-delay fixture and the expense-duplication guard |
| M23 | ingestion-integrations | `convex/evidence.ts` (extraction action + sweep), `convex/intake.ts` (second-stage classifier), `convex/lib/schemas_docs.ts` (new), `convex/crons.ts` (evidence retry sweep), `package.json` (only if a PDF library is approved, O5), `convex/http.ts` (no change) | M20, M03 sign-off for uploads | doc-type extraction with quote verification; multi-line statement → separate candidates; malformed or encrypted PDF → unsupported; lease reclaim; budgets charged before the model call; tombstone gate at write |
| M24 | frontend | `src/App.tsx` (routes `/add`, `/transactions/:id`, `/opportunities`), `src/pages/{Add,Transaction,Opportunities}.tsx` (new), `src/pages/Claim.tsx`, `src/pages/Settings.tsx` (moves the paste panel out), `src/components/shell/nav.tsx`, `src/components/packet/*` (new) | M20–M23 queries | keyboard-only completion of the questions and packet flows; direct-route refresh + foreign ids; axe on the new pages; mobile + desktop projects |
| M25 | qa | `e2e/{r02,r03,r04,r05}.spec.ts`, `convex/slicesM2.test.ts`, `docs/reviews/…-wave2-qa.md` | M20–M24 | mission §17 browser proof per Phase-1 path; the domain fixtures list from §17 |
| M26 (DA) | devils-advocate | checkpoint C | M25 | per-slice adversarial review |

### Wave 3 — expansion in dependency order (only unblocked work; coverage explicit)

| ID | Owner | Scope | Only-writer files | Blocker / dependency |
|---|---|---|---|---|
| M30 | benefits-discovery | R06/R07/R08/R12 for an explicit small set of exact card products (`lib/benefits/cards/<issuer>_<product>_<guideVersion>.ts`), card-product picker facts (`payment.card_product_ref`, never PAN), `primary_secondary` coordination | `convex/lib/benefits/**`, `convex/lib/rules/r06_*…r12_*` | M02 must capture the exact benefit guides (else `blocked_source`) |
| M31 | travel | R09 denied boarding, R14 ancillary not provided, R15 carrier commitments (non-cash + reimbursement; carrier promise ≠ law) | travel pack files | M02 sources |
| M32 | benefits-discovery | R11 recall candidates (candidate ≠ confirmed match; serial/model asked only now) | recall pack files | provider/source availability (`blocked_provider` if there is no official API) |
| M33 | commerce-payments | R16 subscription evidence assistant (manual_review until state packs exist) | r16 files | M02 state-by-state status |
| M34 | backend | deadline reminder sweep (`by_status_and_next_deadline_at`, in-app attention only), rule-version re-evaluation sweep (`by_scenario_and_rule_version`, opsState cursor, C54), cross-claim credit split with `postingRef` (O11) | `convex/crons.ts`, `convex/opportunities.ts`, `convex/claims.ts` | wave 2 closed |
| M35 | frontend | coverage registry page (C57), card product picker, escalation links | `src/**` pages named in the task | M30–M34 |
| M36 | qa + DA | per-slice tests, checkpoint D | tests | — |

R10, R13, R17 (gated; synthetic fixtures only until M03 clears), R18, and R19–R25 remain `not_implemented` or `blocked_*` in RULES-COVERAGE.md with their exact blockers unless the lead schedules a later wave. **Nothing is shown as a card unless an active pack evaluates it.**

---

## 12. Open decisions for the lead (each with a recommendation) and risks

1. **O1: R01 auto-opens a case** (today's behaviour) or waits for the user. **Recommend: keep auto-open for R01 only**, routed through `openCase`'s guard, so the price-first product and its tests are preserved. Every new scenario is user-initiated.
2. **O2: Fact storage.** **Recommend: one `facts` table with a closed runtime catalogue and typed values**, one writer, and typed per-category snapshots. The alternative is typed detail tables per entity. The facts table gives one questions UI, one provenance and state model, and a schema.ts that stays single-owner.
3. **O3: Generalize `claims`.** **Recommend: widen `purchaseId`/`itemId` to optional in wave 2**, with `claimType: "scenario"`. Reject synthetic purchase adapters and a second case table (§2.3).
4. **O4: Legacy linking.** **Recommend: lazy, plus a one-off optional `linkLegacyPurchases` run after the wave-1 deploy** (RUNBOOK). No mandatory backfill.
5. **O5: Upload extraction provider.** **Recommend: the existing OpenAI provider** (file/image input, page and size caps). No new PDF dependency in wave 2. Card statements are store-only until M03 approves. A native text-extraction library can come later as a "use node" action if the lead approves the dependency.
6. **O6: Currencies for new scenarios.** **Recommend: USD only** (`CURRENCY_EXPONENT = { USD: 2 }`). Other currencies are `unsupported`. Legacy R01 keeps any 2-decimal ISO currency.
7. **O7: New persisted claim status.** **Recommend: add only `denied` (wave 2).** Derive `expired` and `escalated`.
8. **O8: Non-cash remedies.** **Recommend: a separate append-only `nonCashRemedies` table**, not ledger kinds, so `balance()` stays cash-only. Provisional credits **are** ledger kinds.
9. **O9: "Recovered" formula.** **Recommend: unclamped `max(0, confirmed − debited)` per currency, with an over-credit flag.** This supersedes D39's clamp in `purchases.board` and unifies it with `tracking.overview`.
10. **O10: Email attachments.** **Recommend: none in Phase 1** (HC-18). The evidence index goes in the body; attachments are handled on manual channels.
11. **O11: One posted credit covering several claims.** **Recommend: keep D24 (one credit → one claim) through wave 2.** Wave 3 adds `confirmCreditSplit` with a shared `postingRef`, enforcing Σ allocations = posting.
12. **O12: Index naming.** **Recommend: guidelines' `by_a_and_b` (field names without `Id`, every field listed) for new indexes only.** Existing names stay (HC-19).
13. **O13: Where the add flow lives.** **Recommend: a new `/add` hub in wave 2.** The nav changes "Add purchase" to "Add"; Settings keeps the inbox and account.
14. **O14: `approveAndSend` refusing a closed R01 window.** This is a behaviour change. **Recommend: adopt it** (mission §19 says authoritative actions reject expired work) and pin it in a test.
15. **O15: The R01 v1 window keeps legacy elapsed-24 h semantics** for parity. **Recommend: yes.** A calendar-day v2 comes only after M02 review.

**Mission items I recommend deferring or treating as infeasible, with reasons:**
- **Purchase-time merchant policy text:** historical pages are not reliably retrievable, and archive scraping is not authorized. Handled as an explicit assumption plus an outcome cap.
- **Airport → country/time-zone data for R02/R04:** there is no committed dataset. The user confirms scope (domestic/international) and time zone, with extraction hints.
- **Business-day deadlines beyond 2030:** `beyond_calendar` instead of guessing.
- **Formal FCBA/Reg E notices by email:** only where a reviewed source designates that channel.
- **Email attachments:** HC-18.
- **Currency conversion:** not implemented; currencies stay separate.
- **Bank/card feeds and direct email-account connection:** deferred per D136.
- **Card-benefit packs:** `blocked_source` until exact guides are captured.
- **R17 live intake:** gated; synthetic fixtures only.
- **Push/SMS deadline reminders:** in-app only.

**Risks (for RISKS.md):**
- **KM1 (high):** the R01 retrofit changes auto-open behaviour. Mitigation: the parity test against `5cc326d` fixtures is a hard gate.
- **KM2 (high):** `balance()` widening silently becomes a debit. Mitigation: the exhaustive switch lands in the same commit, plus a test with every kind.
- **KM3 (medium):** material-change version bumps invalidate drafts too often (price churn). Mitigation: materiality excludes estimate drift while a case is active; a test counts bumps over 12 price checks.
- **KM4 (medium):** facts table growth or supersede bugs. Mitigation: per-transaction cap, one writer, resolution-matrix tests.
- **KM5 (medium):** dashboard totals exceed read budgets as opportunities grow. Mitigation: bounded reads + `complete` flag + `transactionLimits: true` tests at the caps.
- **KM6 (high):** upload abuse or cost. Mitigation: tickets + rate limit + size/page caps + per-user storage cap + budgets, and extraction is off for statements.
- **KM7 (medium):** rollback after the first scenario claim is unsafe. Mitigation: documented forward-fix policy; wave 2 deploys only after the checkpoint C sign-off.
- **KM8 (medium):** rule-pack immutability depends on a CI script, and CI secrets are missing (FINAL-REPORT §5). Mitigation: the lead runs `scripts/check-rule-packs.mjs` in the wave-close gates locally.
- **KM9 (medium):** the concurrent-lane collision on `catalog.ts`/`registry.ts`. Mitigation: stub files created in wave 1 so domain engineers only touch their own files.
- **KM10 (high):** M02 cannot verify a Phase-1 source (e.g. inaccessible DOT/CFPB pages). Mitigation: the pack stays `researched`, the evaluator returns `source_unverified`, and the slice ships the flow with that honest state. It is never marked implemented_verified.
