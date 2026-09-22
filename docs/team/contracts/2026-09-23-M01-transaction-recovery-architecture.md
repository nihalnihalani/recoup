# M01 — Transaction-recovery architecture contract (rev 4, post-checkpoint A)

Author: `opus-product-architect`, self-reported model Opus 5.5 / `claude-opus-5-5`. Governing mission: `docs/prompts/2026-09-23-recoup-us-transaction-recovery.md` ("mission §N"). Convex rules: `convex/_generated/ai/guidelines.md` ("guidelines"). Document B: `docs/research/usa-receipt-compensation-opportunities.md`.

**Revision history.**
- **rev 1** `ca01232`: the initial design.
- **rev 2** `ff48010`: aligned with the M03 security baseline. httpAction-only upload, no bearer URLs, gated extraction, S-M03-1.
- **rev 3** `4b950ca`: `owned*` helpers, card masking moved into wave 1, typed-amount cap, reflective export/purge test, download header hygiene.
- **rev 4 (this revision, task M06).** Folds in, in order of precedence:
  - **D145**, the lead's rulings. Where D145 differs from a review's suggested fix, D145 wins.
  - DA checkpoint A, `docs/reviews/2026-09-23-da-checkpoint-A.md` (`c47b023`): all 36 findings accepted.
  - D142, card masking.
  - D143, the M02 source corrections.
  - D144's routed QA items.
  - The M08/M09 tasks already running (`4723945`).
  - M02's `docs/rules/README.md` field map and outcome aliases.

  §13 maps every finding and decision id to the section that addresses it.
- **rev 5 (task M06b).** Applies the M07 recheck (`docs/reviews/2026-09-23-da-checkpoint-A.md` § "Recheck of rev 4 (M07)", `16b6a5a`) as ruled by **D148**: conditions C1–C5, N2, N3, N5, N6, N7, and the two wave-2 notes. Nothing else changed. §13.2 lists the rows.

**Status.** Rev 5 is binding for wave 1 per D148. M10 is implementing from rev 4 + D148; the rev-5 deltas to M10's files were sent to the lead for forwarding. Nothing here claims that a proposed table, function, or rule already exists. **No legal threshold is set in this document.** Every legal number is a rule-pack parameter taken from M02's captured first-party passages under `docs/rules/**`, and each parameter cites its passage id.

**Binding inputs this contract does not restate:**
- the M03 security baseline `docs/reviews/2026-09-23-security-baseline.md` §3 (SEC-UP/SD/AI/CH/MF/DEL/RR controls) and its findings register;
- the M02 specs `docs/rules/R01…R05*.md`, the fixtures `docs/rules/fixtures/*.json`, and `docs/rules/manifest.json`;
- the QA baseline `docs/reviews/2026-09-23-qa-baseline.md`.

Reading order for implementers: §2.4 (schema) → §2.5–2.8 → §3 (money) → §4 (evaluator/deadlines) → §5–§7 → your task's row in §11 and its tests in §10.

---

## 1. Current-state map

### 1.1 Mission §7 concepts mapped to existing code

| Mission §7 concept | What exists today (file) | Reuse as-is | Needs an adapter | Missing |
|---|---|---|---|---|
| **Transaction** | `purchases` (schema.ts:87) is a retail order with `merchant`, `merchantDomain`, `orderRef?`, `purchasedAt?` (required by `purchases.confirm`, D25), `currency`, `sourceMessageId?`, `status` needs_review/active/archived, and `isExample?`. `watches` holds pre-purchase intent. `watches.markBought` (watches.ts:559) **inserts a purchase directly** (watches.ts:594), and so does `examples.load` (examples.ts:58/144). | `purchases` stays the retail order record, along with the price-watch, board and tracking code that reads it. | A 1:1 category-neutral parent (`transactions.purchaseId`). Every purchase insert path must call `ensurePurchaseTransaction` (§2.2). | Non-retail categories, payment-method classification, jurisdiction, shipment/delivery/notice dates, promise vs outcome, and **manual transaction entry in the UI** (`purchases.create` is public, but no page calls it). |
| **Asset / service details** | `items` (name, unitCents, qty, productUrl, returned, imageUrl). | `items` for retail line items. | — | SKU/model/serial, segments/PNR/bag tag, tracking number, exact card product. |
| **Evidence** | `processedEvents.payload` holds forwarded or pasted email text; retention strips it after 30 days (`RETENTION_PAYLOAD_DAYS`, limits.ts:280). `policies` holds passage, sourceUrl, retrievedAt and a verbatim offset. `priceChecks` holds sourceUrl and observedAt. | `policies` and `priceChecks` as R01 observation sources. | Intake writes evidence rows. The Privacy page's 30-day promise is kept (D145, §2.6). | Storage, content hash, per-field provenance, owner-scoped dedupe, links, retention state. |
| **Fact** | Implicit only (needs_review purchase = candidates, `purchases.confirm` = confirmation, priceChecks = observations). | Confirmed purchase and item fields through an adapter (§2.5). | `lib/facts/legacyRetail.ts`. | Fact rows and fact states. |
| **Incident** | None. `items.returned` is a user-set event. | — | — | The whole concept. |
| **Rule pack** | `policies` is a per-user, LLM-extracted merchant snapshot, immutable per D17. The logic is hard-coded in `priceWatch.watchWindow`/`recordCheck` and `lib/ledger.priceDropCents`. | Snapshots become the **parameter source** of R01 v1 (D145 DA-A-11 d). | The R01 v1 pack wraps the existing logic (§10 R01 parity). | Versioned, reviewed packs; the latest snapshot is applied to purchases of any date (HC-11). |
| **Opportunity** | None. A `detected` claim is the de facto opportunity (priceWatch.ts:141–157). | The dedupe semantics. | — | Opportunity rows, evaluation history. |
| **Claim / case** | `claims` (schema.ts:247). `purchaseId` and `itemId` are required. `type` is price_adjustment/return_credit. There are 9 statuses. `version` is the money version. D44 allows one active claim per (item, type). | All of it. | Optional links (§2.4). | Cases not anchored on an item, `denied`, claim currency, a required channel. |
| **Correspondence / submission** | `drafts` bind to {to, subject, body, claimVersion, draftVersion} plus the newest-draft rule (D58) and the recipient gate (D18). The AgentMail enqueue sets `queued`, and reconcile sets `sent`/`failed`/`sendUnknown`. `replies` (D21). Reminder-only `followUps` (D03/D28). `markPacketSent` records a submission from a note alone. | The email path, reconcile, reply routing (D23). | Binding extended (§6). | Packets, user-recorded submissions, formal-channel semantics. |
| **Recovery events** | `ledgerEvents` (promised/confirmed/later_debit), integer cents, no currency, per-claim idempotency (D38). | Kinds and the formula `unresolved = expected − confirmed + debited` (D24/D40). | Provisional kinds (§3.2). | Provisional credits, non-cash remedies, currency. |
| **Jobs** | `processedEvents`, `mailLog`, the market state machine, `accountState`, `opsState` cursors, `usage`, the rate limiter. | The row-first status pattern, cursors, budgets. | Evidence extraction on evidence rows. | Extraction, re-evaluation and deadline sweeps; diagnostics (§11 M1B). |

### 1.2 Hard constraints found in the code

- **HC-1 `claims.purchaseId`/`itemId` are required.** The unconditional dereferences (measured by DA E1, checkpoint A Appendix B) are at:
  - `claims.ts:438,441,442`
  - `drafts.ts:166,169,170,188,268,459,461,466`
  - `followUps.ts:22,30`
  - `insights.ts:313,314,329–331`
  - `replies.ts:62,63`
  - `tracking.ts:230,231`

  **Silent sites** (not flagged by the compiler):
  - `purchases.board` reads `by_purchase_type` on `purchaseId` alone, so an item-less claim **with** a `purchaseId` is counted (repro A.1).
  - `Claim.tsx:87` and `replies.ts:166` use `purchase?.currency ?? "USD"`.
  - `insights.ts` has `currency: purchase?.currency`.

  rev 3's claim that "item-keyed readers can never see an item-less claim" was **false** for the board; corrected in §2.3.
- **HC-2 The ledger is keyed by `claimId` and carries no currency.** Balance: `lib/ledger.ts:38 balance()` and `lib/balance.ts claimBalance()`. Totals use two formulas: `purchases.board` (clamped per D39 and summed across currencies, unrendered; asserted in `purchases.test.ts:387–407` and `lib/ledger.test.ts:198–202`) and `tracking.overview` (unclamped, per currency, but newest claim per item only; repro A.7).
- **HC-3 `balance()` counts every unknown event kind as a debit** (ledger.ts:46).
- **HC-4 The recipient gate is bound to retail policy snapshots** (drafts.ts:105).
- **HC-5 The approval binding** covers text + versions only.
- **HC-6 `markPacketSent`** records a submission from a note.
- **HC-7 One overloaded `claims.status`.**
- **HC-8 The money helpers assume 2 decimal places.**
- **HC-9 Intake assumes USD** (intake.ts:444), and `confirm` cannot correct it.
- **HC-10 `applyRefund` writes a foreign-currency promise** (intake.ts:585).
- **HC-11 Temporal accuracy.** The latest snapshot is applied to any purchase date, and the legacy window is a multiple of 24 hours from the purchase instant.
- **HC-12 Export and purge lists are explicit** (account.ts:138/165).
- **HC-13 No clock reads in queries** (D73).
- **HC-14 Read budget:** 4,096 index ranges.
- **HC-15 Tombstone gates at write.**
- **HC-16 `isExample`** on purchases, claims and policies.
- **HC-17 Retail-specific follow-up and drafting prompt.**
- **HC-18 AgentMail attachments are inline strings in a component document** (1 MiB limit).
- **HC-19 Index naming.** Every NEW index is named `by_<f1>_and_<f2>…`, with each field's trailing `Id` dropped and every field listed. Existing indexes are not renamed.
- **HC-20 One writer per file per wave.**
- **HC-21 AgentMail blind retries** (S-M03-1).
- **HC-22 Convex file URLs are bearer URLs;** `_storage` ids carry no owner.
- **HC-23 `verifyPassage` rejects any quote shorter than 40 normalized characters** (`lib/passage.ts:36,46`; repro A.5). A bare substring check does not bind the emitted value.
- **HC-24 `_storage.sha256` is base64 in convex-test** (repro A.4). The hex comment in the Convex types sits on the deprecated `FileMetadata`.
- **HC-25 `replies` reads `promisedAmount` as a currency-less float** (replies.ts:33, 246–249) and defaults to USD (replies.ts:166).
- **HC-26 One idempotency key cannot cover two ledger events in one mutation** (claims.ts:243–246; repro A.2). **A mutation that throws rolls back its own invalidation writes** (repro A.3).
- **HC-27 The frontend test gap (QA-13).** `vitest.config.mts` includes only `*.test.ts` and has no DOM environment, so component tests would not run. **M08** fixes this before M15's tests count.
- **HC-28 The dashboard charts sum cents across currencies** (`src/components/dashboard/model.ts:85–111`; QA-2).

---

## 2. Smallest compatible architecture

### 2.1 Shape

- A category-neutral **`transactions`** parent: 1:1 with `purchases` for retail; standalone for flights and card charges.
- **Facts** are typed values with a closed per-domain key catalogue, a row state and a single writer. They are the evaluation truth. Legacy retail values enter through a read adapter; nothing is rewritten.
- **Evidence** rows own ingested content: `_storage` + a hex SHA-256 + provenance, under a published retention rule.
- **Incidents** hold what went wrong.
- **Rule packs** are immutable, versioned TypeScript modules with pure evaluators and a shared, versioned engine. Only **independently reviewed, lead-activated** packs evaluate in production.
- **Evaluations** are append-only rows, deduplicated by outcome-bearing fields.
- **Opportunities** are the stable identity of "remedy × loss × transaction". An opportunity links **mandatorily and lazily** to any pre-existing case.
- **Claims** are widened in wave 2, never duplicated. There is one active case per loss component unless a source-backed coordination is declared.
- **The existing ledger** gains provisional kinds. **Non-cash remedies** get an append-only table.
- **Email** keeps AgentMail, with at-most-once sends. **Manual channels** get packets and user-recorded submissions. **Formal notices** count only on their pack's required channel.

### 2.2 Decision: a new `transactions` parent, not extended `purchases`

`purchases` has seven retail consumers: the item sweep, tracking, insights, board, policy fetch, examples, and retention. Putting flights or statement lines into `purchases` would require a category filter at each of them, and a missed filter fails silently. The new table cannot leak into those paths. The cost is two rows per retail order.

`ensurePurchaseTransaction(ctx, purchaseId)` is idempotent: unique through `transactions.by_purchase`, with OCC serializing concurrent callers. It copies `purchase.isExample` (DA-A-35) and **must be called from every purchase insert or confirm path**:
- `purchases.create` and `purchases.confirm`;
- `watches.markBought` (a direct insert);
- `examples.load` (direct inserts);
- `intake.applyOrder` (needs_review);
- every evaluation entry point.

A test enumerates all `insert("purchases"` sites and requires the helper at each one.

### 2.3 How non-retail transactions become claimable

- **Online order (R05):** a `retail_order` transaction. An order-level scenario claim carries `purchaseId` and no `itemId`.
- **Flight (R02/R04):** an `air_travel` transaction with no purchase.
- **Card charge (R03):** a `card_charge` transaction for exactly one statement line. It links to a related transaction via `relatedTransactionId`, which is **set only server-side after `ownedTransaction`** (DA-A-29).
- **Claims, wave 2 (M20):** `purchaseId`/`itemId` become optional; `claimType += "scenario"`.
  - A scenario claim must carry `transactionId`, `opportunityId`, `scenarioId`, `remedyKey`, `currency` and `lossKeys`. Its single writer is `claims.insertScenarioClaim` (M20).
  - **Corrected safety argument:**
    - (a) The change only widens the schema, so every stored document still validates.
    - (b) The compiler lists the unconditional dereferences in HC-1.
    - (c) **The silent sites in HC-1 are fixed explicitly in M2C**: the board skips `type === "scenario"` and reports per currency; `claimCurrency()` replaces every `?? "USD"` in M28 and M24. Tests: repro A.1 inverted; an air_travel claim page shows `claim.currency`.
    - (d) R01 and return claims keep both ids.
  - Wave 1 does not widen anything.

### 2.4 Schema (validator code)

Every validator is exported from `convex/schema.ts`. **M10 writes the wave-1 block and M20 writes the wave-2 block.** No existing field is renamed or narrowed.

```ts
// ===================== M10 (wave 1) — shared validators =====================
export const scenarioId = v.union(
  v.literal("R01"), v.literal("R02"), v.literal("R03"), v.literal("R04"), v.literal("R05"),
  v.literal("R06"), v.literal("R07"), v.literal("R08"), v.literal("R09"), v.literal("R10"),
  v.literal("R11"), v.literal("R12"), v.literal("R13"), v.literal("R14"), v.literal("R15"),
  v.literal("R16"), v.literal("R17"), v.literal("R18"), v.literal("R19"), v.literal("R20"),
  v.literal("R21"), v.literal("R22"), v.literal("R23"), v.literal("R24"), v.literal("R25"),
);
export const transactionCategory = v.union(v.literal("retail_order"), v.literal("air_travel"), v.literal("card_charge"));
export const transactionStatus = v.union(v.literal("needs_review"), v.literal("active"), v.literal("archived"));
/** Integer minor units + ISO 4217. Never signed; direction lives in the field or event kind. */
export const money = v.object({ amountMinor: v.number(), currency: v.string() });

export const evidenceLocator = v.union(
  v.object({ kind: v.literal("text_span"), start: v.number(), end: v.number(), quote: v.string() }), // quote ≤ 300 chars
  v.object({ kind: v.literal("pdf_page"), page: v.number(), quote: v.optional(v.string()) }),
  v.object({ kind: v.literal("email_header"), header: v.union(v.literal("from"), v.literal("date"), v.literal("subject"), v.literal("message_id")) }),
  v.object({ kind: v.literal("whole_document") }),
);
/** DA-A-6: three-valued from day one (no boolean→union migration later). Semantics implemented in M23 (§2.6). */
export const quoteStatus = v.union(v.literal("verified"), v.literal("unverified"), v.literal("unverifiable"));

export const factValue = v.union(
  v.object({ kind: v.literal("money"), amountMinor: v.number(), currency: v.string() }),
  v.object({ kind: v.literal("instant"), epochMs: v.number() }),
  v.object({ kind: v.literal("local_date"), date: v.string(), timeZone: v.optional(v.string()) }),
  v.object({ kind: v.literal("local_datetime"), dateTime: v.string(), timeZone: v.optional(v.string()) }),
  v.object({ kind: v.literal("code"), code: v.string() }),
  v.object({ kind: v.literal("text"), text: v.string() }),          // ≤ 500 chars, passed through maskPans (D142)
  v.object({ kind: v.literal("identifier"), scheme: v.string(), value: v.string() }), // D142: IMEI/ticket/order ref/tracking; own format validator, NEVER the free-text masker
  v.object({ kind: v.literal("bool"), value: v.boolean() }),
  v.object({ kind: v.literal("count"), n: v.number() }),
  v.object({ kind: v.literal("minutes"), minutes: v.number() }),
  v.object({ kind: v.literal("user_unknown") }),                    // "I don't know" (≠ missing, ≠ false; never a known cell — §2.5)
);
export const factRowState = v.union(
  v.literal("observed"), v.literal("extracted_candidate"), v.literal("user_confirmed"),
  v.literal("derived"), v.literal("superseded"), v.literal("rejected"),
);
export const factSource = v.union(
  v.object({ kind: v.literal("evidence"), evidenceId: v.id("evidence"), locator: evidenceLocator,
             quoteStatus, extractorVersion: v.string() }),
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
/** SEC-AI-6: who stands behind the content. `unverified_sender` never creates confirmed facts or case state. */
export const evidenceProvenance = v.union(v.literal("user_forwarded"), v.literal("user_pasted"), v.literal("user_uploaded"),
  v.literal("unverified_sender"), v.literal("system_capture"));
export const extractionStatus = v.union(
  v.literal("awaiting_doc_type"),   // DA-A-8: no user-declared docType yet → never extracted
  v.literal("not_requested"), v.literal("queued"), v.literal("running"), v.literal("succeeded"),
  v.literal("needs_review"), v.literal("failed"),
  v.literal("store_only"),          // card_statement, or a text layer holding a card number (DA-A-8), or live extraction not approved
  v.literal("needs_unlocked_copy"), v.literal("unreadable"), v.literal("over_page_cap"),
);
export const evidenceRetention = v.union(v.literal("active"), v.literal("content_deleted"));

export const incidentKind = v.union(
  v.literal("flight_cancelled"), v.literal("flight_schedule_changed"), v.literal("flight_renumbered_only"), v.literal("flight_delayed"),
  v.literal("denied_boarding"), v.literal("bag_delayed"), v.literal("bag_lost"), v.literal("bag_damaged"), v.literal("ancillary_not_provided"),
  v.literal("order_not_shipped_on_time"), v.literal("order_in_transit_delay"), v.literal("order_not_delivered"),
  v.literal("order_delivery_disputed"), v.literal("package_stolen_after_delivery"),
  v.literal("charge_duplicate"), v.literal("charge_wrong_amount"), v.literal("credit_not_posted"),
  v.literal("goods_not_delivered_as_agreed"), v.literal("charge_unauthorized"),
  v.literal("item_damaged"), v.literal("item_stolen"), v.literal("item_defective"), v.literal("return_refused"), v.literal("other"),
);
export const incidentStatus = v.union(v.literal("candidate"), v.literal("confirmed"), v.literal("withdrawn"));

export const authorityClass = v.union(v.literal("legal_entitlement"), v.literal("contract_benefit"), v.literal("merchant_promise"),
  v.literal("settlement_or_program"), v.literal("goodwill"));
/** Mission §9 outcomes. M02 fixtures' `likely_eligible_missing_evidence` ≡ `likely_eligible` (docs/rules/README.md alias table; M08's fixture loader maps it). */
export const evaluationOutcome = v.union(
  v.literal("eligible"), v.literal("likely_eligible"), v.literal("possible_contract_benefit"), v.literal("needs_facts"),
  v.literal("manual_review"), v.literal("not_eligible"), v.literal("deadline_passed"), v.literal("source_unverified"), v.literal("unsupported"),
);
export const tri = v.union(v.literal("pass"), v.literal("fail"), v.literal("unknown"));
export const remedyType = v.union(v.literal("price_difference"), v.literal("cash_refund"), v.literal("statement_credit"), v.literal("reimbursement"),
  v.literal("fee_refund"), v.literal("billing_correction"), v.literal("voucher"), v.literal("points"), v.literal("repair"),
  v.literal("replacement"), v.literal("service_credit"));
export const cashClass = v.union(v.literal("cash"), v.literal("non_cash"), v.literal("provisional"));
export const overlapRelation = v.union(v.literal("alternative"), v.literal("coordinated"), v.literal("primary_secondary"),
  v.literal("complementary"), v.literal("distinct_lines"));
export const opportunityStatus = v.union(v.literal("open"), v.literal("case_open"), v.literal("dismissed"), v.literal("closed"), v.literal("superseded"));
/** DA-A-5: `overdue` exists only for counterparty obligations. */
export const deadlineStatus = v.union(v.literal("open"), v.literal("passed"), v.literal("overdue"), v.literal("unknown_anchor"),
  v.literal("disputed_anchor"), v.literal("beyond_calendar"), v.literal("not_applicable"));
export const obligor = v.union(v.literal("user"), v.literal("counterparty"));
export const manualChannel = v.union(v.literal("postal_mail"), v.literal("web_form"), v.literal("portal"), v.literal("phone"),
  v.literal("chat"), v.literal("in_person"));
export const requiredChannel = v.union(v.literal("email"), manualChannel); // DA-A-9 (M10 — lib/claimState uses it in wave 1)

export const factRef = v.object({ subjectKey: v.string(), key: v.string() });           // DA-A-15: values are hashed, not row ids
/** rev 5 (N6): resolved cell status (§2.5) and a bound fact's value, stored so an approved basis stays displayable. */
export const cellStatus = v.union(v.literal("confirmed"), v.literal("observed"), v.literal("derived"), v.literal("candidate"),
  v.literal("conflicting"), v.literal("user_unknown"), v.literal("missing"));
export const boundFactValue = v.object({ subjectKey: v.string(), key: v.string(), status: cellStatus, value: v.optional(factValue) });
export const sourceRef = v.object({ sourceId: v.string(), passageId: v.string(), url: v.string(), effective: v.string() });
export const conditionResult = v.object({
  id: v.string(), label: v.string(), result: tri,
  kind: v.union(v.literal("applicability"), v.literal("requirement"), v.literal("exclusion"), v.literal("timing"), v.literal("evidence")),
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
export const amountCalc = v.object({
  estimate: money,
  basis: v.union(v.literal("exact_formula"), v.literal("documented_total"), v.literal("user_claimed")),
  formula: v.string(),
  inputs: v.array(v.object({ label: v.string(), value: v.string(), fact: v.optional(factRef) })), // ≤ 12
  cap: v.optional(v.object({ amount: money, sourcePassageId: v.string(), note: v.string() })),   // a LIMIT, never the estimate
});
export const deadlineResult = v.object({
  id: v.string(), label: v.string(), obligor, status: deadlineStatus,
  dueAt: v.optional(v.number()), dueLocalDate: v.optional(v.string()), timeZone: v.optional(v.string()),
  mustBe: v.union(v.literal("received"), v.literal("sent"), v.literal("filed"), v.literal("paid"), v.literal("n_a")),
  overdueSince: v.optional(v.number()),                 // counterparty only (DA-A-5)
  advisoryActBy: v.optional(v.string()),                // D143.3: labelled "conservative act-by", NEVER dueAt
  basis: v.string(), anchor: v.optional(factRef), sourcePassageId: v.optional(v.string()),
});
export const dimensions = v.object({ applies: tri, factsKnown: tri, evidenceSupports: tri, windowOpen: tri, amountCalculable: tri, readyForApproval: tri });
export const nextAction = v.union(
  v.object({ kind: v.literal("answer_questions"), keys: v.array(factRef) }),
  v.object({ kind: v.literal("add_evidence"), docTypes: v.array(evidenceDocType) }),
  v.object({ kind: v.literal("open_case") }),
  v.object({ kind: v.literal("continue_case"), claimId: v.id("claims") }),
  v.object({ kind: v.literal("track") }),                 // DA-A-25: automatic refund; watch the counterparty deadline
  v.object({ kind: v.literal("escalate"), reason: v.string() }),   // DA-A-5: counterparty deadline overdue
  v.object({ kind: v.literal("request_refund") }),        // D143.2: e.g. ticket agent is merchant of record
  v.object({ kind: v.literal("ask_anyway"), reason: v.string() }), // D143.1: user-initiated ask when source is unverified
  v.object({ kind: v.literal("manual_review"), reason: v.string() }),
  v.object({ kind: v.literal("none"), reason: v.string() }),
);
export const nonCashKind = v.union(v.literal("voucher"), v.literal("points"), v.literal("repair"), v.literal("replacement"),
  v.literal("service_credit"), v.literal("fee_waiver"), v.literal("other"));
export const approvalBinding = v.object({
  contextHash: v.string(),                 // canonical hash of every field below (values, not row ids — DA-A-15)
  claimVersion: v.number(),
  amount: money,
  opportunityId: v.optional(v.id("opportunities")),
  evaluationId: v.optional(v.id("evaluations")),
  ruleId: v.optional(v.string()), ruleVersion: v.optional(v.number()),
  engineVersion: v.optional(v.string()),   // DA-A-23 (populated from wave 2; optional so wave 1 needs no later migration)
  boundFactsHash: v.optional(v.string()),  // hash over (subjectKey, key, status, value) of every bound fact (§2.5)
  attachments: v.array(v.object({ evidenceId: v.id("evidence"), contentHash: v.string() })), // ≤ 10; [] in Phase-1 email
});

// ===================== M10 (wave 1) — new tables =====================
  transactions: defineTable({
    userId: v.id("users"), category: transactionCategory, status: transactionStatus,
    counterpartyName: v.string(), counterpartyDomain: v.optional(v.string()),
    currency: v.string(), totalMinor: v.optional(v.number()), transactedAt: v.optional(v.number()),
    naturalKey: v.optional(v.string()),          // owner-scoped dedupe; card lines include a per-line identity (DA-A-30)
    purchaseId: v.optional(v.id("purchases")),
    relatedTransactionId: v.optional(v.id("transactions")), // server-set only (DA-A-29)
    sourceEvidenceId: v.optional(v.id("evidence")),
    liveFactCount: v.number(),                   // DA-A-36: non-superseded fact rows; maintained by putFact
    isExample: v.optional(v.boolean()),
  }).index("by_user_and_status", ["userId", "status"])
    .index("by_user_and_natural_key", ["userId", "naturalKey"])
    .index("by_purchase", ["purchaseId"]),

  facts: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    subjectKey: v.string(), key: v.string(),
    state: factRowState, value: factValue, source: factSource,
    supersededBy: v.optional(v.id("facts")),
    overridesObserved: v.optional(v.boolean()),
    recordedAt: v.number(),
    lastObservedAt: v.optional(v.number()),      // DA-A-36: an unchanged observation patches this instead of inserting
    isExample: v.optional(v.boolean()),
  }).index("by_transaction_and_subject_key_and_key", ["transactionId", "subjectKey", "key"])
    .index("by_user", ["userId"]),

  incidents: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    kind: incidentKind, status: incidentStatus,
    reportedBy: v.union(v.literal("user"), v.literal("extraction")),
    sourceEvidenceId: v.optional(v.id("evidence")), isExample: v.optional(v.boolean()),
  }).index("by_transaction", ["transactionId"]).index("by_user", ["userId"]),

  evidence: defineTable({
    userId: v.id("users"), transactionId: v.optional(v.id("transactions")),
    kind: evidenceKind, docType: evidenceDocType,
    docTypeDeclaredBy: v.optional(v.union(v.literal("user"), v.literal("classifier"))), // DA-A-8: only "user" unlocks upload extraction
    sourceChannel: evidenceChannel, provenance: evidenceProvenance,
    processedEventId: v.optional(v.id("processedEvents")),
    storageId: v.optional(v.id("_storage")),     // written only by the upload httpAction's finalize mutation (SEC-UP-1)
    contentHash: v.string(),                     // lowercase hex SHA-256, normalized at finalize (DA-A-27)
    mimeType: v.optional(v.string()), sizeBytes: v.optional(v.number()), pageCount: v.optional(v.number()),
    fileName: v.optional(v.string()),            // ≤ 200 chars; quotes/control/`\`/`/`/`;` stripped (rev 3)
    text: v.optional(v.string()),                // masked (D142) text ≤ 60,000 chars
    headers: v.optional(v.object({ from: v.optional(v.string()), subject: v.optional(v.string()), date: v.optional(v.string()), messageId: v.optional(v.string()) })),
    receivedAt: v.number(),
    pinnedAt: v.optional(v.number()),            // DA-A-7: user chose to keep it
    extractionStatus, extractionAttempts: v.number(),
    extractionStartedAt: v.optional(v.number()), extractorVersion: v.optional(v.string()), extractionSummary: v.optional(v.string()),
    hasTextLayer: v.optional(v.boolean()),       // DA-A-6: deterministic text layer present (PDF text / email / paste)
    retention: evidenceRetention, isExample: v.optional(v.boolean()),
  }).index("by_user_and_content_hash", ["userId", "contentHash"])
    .index("by_transaction", ["transactionId"])
    .index("by_storage", ["storageId"])
    .index("by_extraction_status_and_extraction_started_at", ["extractionStatus", "extractionStartedAt"])
    .index("by_retention_and_received_at", ["retention", "receivedAt"]),  // DA-A-7 retention sweep

  opportunities: defineTable({
    userId: v.id("users"), transactionId: v.id("transactions"),
    scenarioId, remedyKey: v.string(), subjectKey: v.string(), incidentId: v.optional(v.id("incidents")),
    dedupeKey: v.string(),                       // `${transactionId}|${scenarioId}|${remedyKey}|${subjectKey}|${incidentId ?? "-"}` — never includes ruleVersion
    status: opportunityStatus,
    currentEvaluationId: v.optional(v.id("evaluations")),
    ruleId: v.string(), ruleVersion: v.number(), outcome: evaluationOutcome,
    authorityClass, remedyType, cashClass,
    estimate: v.optional(money),
    nextDeadlineAt: v.optional(v.number()),      // USER-obligor deadlines only (DA-A-5)
    nextCounterpartyDueAt: v.optional(v.number()),
    lossKeys: v.array(v.string()),               // ≤ 20
    activeClaimId: v.optional(v.id("claims")),
    lastEvaluatedAt: v.number(), isExample: v.optional(v.boolean()),
  }).index("by_user_and_dedupe_key", ["userId", "dedupeKey"])
    .index("by_transaction", ["transactionId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_status_and_next_deadline_at", ["status", "nextDeadlineAt"])
    .index("by_scenario_and_rule_version", ["scenarioId", "ruleVersion"]),

  evaluations: defineTable({
    userId: v.id("users"), opportunityId: v.id("opportunities"), scenarioId,
    ruleId: v.string(), ruleVersion: v.number(), engineVersion: v.optional(v.string()),
    factSnapshotHash: v.string(),                // stored alongside, NOT part of resultHash (DA-A-32)
    resultHash: v.string(),                      // outcome-bearing fields only (§4)
    evaluatedAt: v.number(),
    trigger: v.union(v.literal("fact_change"), v.literal("observation"), v.literal("rule_version"), v.literal("user_request"),
      v.literal("case_open"), v.literal("approval_check"), v.literal("migration"), v.literal("link")),
    outcome: evaluationOutcome, dimensions,
    conditions: v.array(conditionResult), missingFacts: v.array(missingFact), assumptions: v.array(assumption),
    disqualifierIds: v.array(v.string()), amount: v.union(amountCalc, v.null()),
    deadlines: v.array(deadlineResult), sourceRefs: v.array(sourceRef),
    overlap: v.array(v.object({ withScenario: scenarioId, withRemedyKey: v.string(), relation: overlapRelation })),
    nextAction, explanation: v.array(v.string()),
    boundFacts: v.optional(v.array(boundFactValue)), // rev 5 (N6): the pack's bound-fact values (≤ 32); written on every row
  }).index("by_opportunity", ["opportunityId"]).index("by_user", ["userId"]),
  // Array bounds asserted by the single writer: conditions ≤ 64, missingFacts ≤ 32, assumptions ≤ 16, disqualifiers ≤ 16,
  // deadlines ≤ 8, sourceRefs ≤ 8, overlap ≤ 8, explanation ≤ 12.

  nonCashRemedies: defineTable({
    userId: v.id("users"), claimId: v.id("claims"), kind: nonCashKind, description: v.string(),
    faceValue: v.optional(money), state: v.union(v.literal("promised"), v.literal("received")),
    idempotencyKey: v.string(), recordedAt: v.number(),
  }).index("by_claim_and_idempotency_key", ["claimId", "idempotencyKey"]).index("by_user", ["userId"]),

// ===================== M10 (wave 1) — additive changes to existing tables =====================
// eventKind += "provisional_credit" | "provisional_released"   (lib/ledger rewritten exhaustively in the same commit — HC-3)
// ledgerEvents += currency: v.optional(v.string())            (required by every NEW writer; must equal claimCurrency(claim))
// claims += transactionId?, opportunityId?, scenarioId?, remedyKey?, currency?, lossKeys? (≤ 20),
//           requiredChannel?: requiredChannel                  (DA-A-9)
//         + .index("by_opportunity", ["opportunityId"]) + .index("by_transaction_and_status", ["transactionId", "status"])
// drafts += binding?: approvalBinding, approvedHash?: string

// ===================== M20 (wave 2) — addendum =====================
// claimType += "scenario"; claimStatus += "denied"; claims.purchaseId/itemId -> optional
// claims += caseMode?: v.union(v.literal("request"), v.literal("track_automatic"))   (DA-A-25)
//         + nonCashResolvedAt?: number                                                 (DA-A-18)
// drafts += purpose?: v.union(v.literal("formal"), v.literal("informal"))             (DA-A-9: informal outreach never changes delivery)
export const recipientSource = v.union(v.literal("confirmed_policy_snapshot"), v.literal("rule_pack"),
  v.literal("user_entered_from_document"), v.literal("user_entered"));
  packets: defineTable({
    userId: v.id("users"), claimId: v.id("claims"), version: v.number(), channel: manualChannel,
    recipient: v.object({ text: v.string(), source: recipientSource, evidenceId: v.optional(v.id("evidence")) }),
    body: v.string(), requestedRemedy: v.string(),
    evidenceIndex: v.array(v.object({ evidenceId: v.id("evidence"), contentHash: v.string(), label: v.string() })), // ≤ 25
    binding: approvalBinding,
    status: v.union(v.literal("draft"), v.literal("approved"), v.literal("superseded"), v.literal("submission_recorded")),
    approvedAt: v.optional(v.number()), approvedHash: v.optional(v.string()),
    supersededAt: v.optional(v.number()),
  }).index("by_claim", ["claimId"]).index("by_user", ["userId"]),
  submissions: defineTable({
    userId: v.id("users"), claimId: v.id("claims"), packetId: v.id("packets"), approvedHash: v.string(),
    channel: manualChannel, submittedAt: v.number(),
    confirmationRef: v.optional(v.string()), proofEvidenceId: v.optional(v.id("evidence")),
    deliveryRecordedAt: v.optional(v.number()), deliveryEvidenceId: v.optional(v.id("evidence")),
    staleAtRecord: v.optional(v.boolean()),      // DA-A-10: binding drifted after approval; recorded anyway + review prompt
    note: v.optional(v.string()),
  }).index("by_claim", ["claimId"]).index("by_user", ["userId"]),
```

**Why each existing-table change is needed:**
- **claims links:** the dedupe guard, the overlap guard, and per-currency totals.
- **`requiredChannel` (DA-A-9):** formal-notice truth.
- **Optional ids, `scenario` type, `denied` status, `caseMode`, `nonCashResolvedAt`:** wave-2 scenario cases.
- **Ledger provisional kinds and `currency`:** §3.2.
- **drafts `binding`/`approvedHash`/`purpose`:** §6.
- **Nothing else:** `purchases`, `items`, `policies`, `priceChecks` and `watches` do not change.

**Caps** (M10, in `convex/limits.ts`, each with a justifying comment):
- **Per user:** transactions 500; evidence 1,000 rows and 500 MB.
- **Per transaction:** 1,000 **non-superseded** facts (DA-A-36); 20 incidents; 25 images.
- **Per upload:** 10 MB; PDFs ≤ 20 pages.
- **Upload rates:** 20 uploads per hour per user (`evidenceUpload`), plus per-user daily count/byte quotas and a global daily byte cap (`evidence_bytes`) under the `ops.pauseKind` kill switch (SEC-UP-8). The byte quota is charged from `_storage.size` (DA-A-28f).
- **Download rate:** `evidenceDownload` per user.
- **Dashboard read:** 200 open opportunities.
- **User-entered amounts:** `MAX_USER_AMOUNT_MINOR = 100_000_000` (D145, SEC-MF-4).
- **Retention:** `RETENTION_EVIDENCE_DAYS = 30` (DA-A-7).

### 2.5 Fact model (M11)

- **Cell** = (transactionId, subjectKey, key). **Resolution** (`lib/facts/resolve.ts`, pure) runs over the cell's current rows (state ∉ {superseded, rejected}). Let U be the newest current `user_confirmed` row. (DA-A-1)
  1. If U exists and `U.value.kind !== "user_unknown"`, the cell is `confirmed`. It is `conflicting` instead if a current `observed` row disagrees and `U.overridesObserved` is not set.
  2. Otherwise, a current `observed` row gives `observed`.
  3. Otherwise, a current `derived` row gives `derived`.
  4. Otherwise, if U exists (it can only be `user_unknown` at this point), the cell is **`user_unknown`**, carrying any later candidate as a `hint`.
  5. Otherwise, candidates give `candidate` (all agree) or `conflicting`.
  6. Otherwise the cell is `missing`.

  Only `confirmed | observed | derived` are **known**. Type rule: `KnownCell<T>` carries `value: T`. The builder converts a stored value through `typedValue(spec, value)`, which returns `null` for `user_unknown`, and **throws if a known status would carry null**. That throw is unreachable by construction, and a test asserts it.
- **Single writer** `lib/facts/write.ts putFact(ctx, userId, input)`. A grep test enforces that only this file inserts into `facts` (O2). It:
  - checks the transaction with M10's `ownedTransaction`;
  - parses `subjectKey`; an item subject must satisfy `item.purchaseId === txn.purchaseId`, and an incident subject must satisfy `incident.transactionId === txn._id`;
  - **checks that evidence cited in `source` is owned and either belongs to the same transaction or is unlinked, and links it on cite; evidence from another transaction is refused** (DA-A-29, `assertSameTransaction`);
  - validates the key against the catalogue for the transaction's category, the value variant and its domain;
  - checks user money with `assertUserAmount`;
  - **masks `text` values with `maskPans` and never refuses them (D142)**, and validates `identifier` values with their scheme's format validator, **never** passing them through the free-text masker;
  - applies the supersede rules:
    - a new `user_confirmed` supersedes the cell's current confirmed rows and candidates, and its observed rows only with `overridesObserved`;
    - a new `observed` with a **changed** value supersedes older observed rows; **an unchanged value patches `lastObservedAt`** (DA-A-36);
    - a new `derived` supersedes older derived rows;
    - a candidate supersedes nothing;
  - maintains `transactions.liveFactCount`; the cap counts non-superseded rows only (DA-A-36).
- **Catalogue:** `lib/facts/catalog.ts` merges `keys_retail.ts`, `keys_order.ts`, `keys_air.ts` and `keys_card.ts`. The last three are stubs in wave 1. Each `FactSpec` = `{ key, categories, subject, value, codes?, identifierScheme?, question: { prompt, why, sensitive? }, evidenceHint?, userAssertable }`. Keys are never renamed.
- **Typed snapshots** come from `lib/facts/snapshot_<category>.ts` (pure).
  - **`snapshotHash` and `boundFactsHash` hash `(subjectKey, key, status, value)` only, never fact or evidence ids** (DA-A-15). Re-confirming a value unchanged does not change the hash.
  - `lib/canonical.ts` provides canonical JSON: sorted keys, no undefined, deterministic arrays.
- **Legacy retail adapter** (`lib/facts/legacyRetail.ts`):
  - For an **active** purchase, it reads merchant, date, items and qty as `confirmed` with source `legacy_purchase`.
  - **Currency is `confirmed` only if a `retail.currency` user-confirmed fact exists (written by `purchases.confirm` from wave 1 on). Otherwise the cell is an assumption-class `candidate`** (DA-A-33).
  - The newest accepted `priceChecks` row is the `observed` price cell.
  - The policy snapshot is a parameter source (§2.7), not a fact.
  - A needs_review purchase yields `candidate` cells.
  - Stored facts overlay the adapter's cells.

### 2.6 Evidence (M13 + M14; binding controls SEC-UP-1…8, SEC-SD-*, SEC-AI-1/2/6, SEC-DEL-*)

- **Upload: one path, the authenticated `POST /evidence/upload` httpAction** (rev 2; SEC-UP-1/2/3/6/7/8). The steps:
  1. The caller is resolved with `ctx.auth` from `Authorization: Bearer <Convex Auth JWT>`. No caller or a tombstoned caller → 401 with an identical body.
  2. An internal mutation runs the rate limiter and the per-user and global quotas → 429, with nothing stored.
  3. A missing or oversized `Content-Length` → 413 before the body is read, as does a chunked request without a length. The body is read with a streamed cap of ≤ 10 MB and **magic-byte** sniffing. Only PDF, JPEG, PNG, HEIC/HEIF and WebP are allowed → otherwise 415, with nothing stored.
  4. `ctx.storage.store(blob)`.
  5. `internal.evidence.finalizeUpload({ userId, storageId, fileName, sniffedMime, declaredDocType })` re-checks the tombstone, reads `ctx.db.system.get("_storage", id)`, applies dedupe, inserts the row and binds `storageId` (unique through `by_storage`).

  **No public function accepts a `storageId`.** A refusal after step 4 deletes only the blob that request stored. Responses never differ based on whether another user holds the same bytes. Additions in rev 4:
  - **(DA-A-8)** An optional header `X-Doc-Type` from the closed `evidenceDocType` list. Any value other than `unknown` or `other` becomes `docTypeDeclaredBy: "user"`. Absent, `unknown` or `other` → `extractionStatus: "awaiting_doc_type"`. The owner-only `evidence.declareDocType({ evidenceId, docType })` supplies it later. `card_statement` → `store_only`.
  - **(DA-A-28a)** `X-File-Name` is **percent-encoded UTF-8** by the client and decoded, sanitized and bounded at finalize.
  - **(DA-A-28f)** Quotas are charged from `_storage.size` after storing. Over quota → the request deletes the blob it just stored (the SEC-UP-2 exception) and returns 429.
  - **(DA-A-28e)** HEIC/HEIF are accepted for storage and preview-by-download only. They are **not sent to the model provider** (`extractionStatus: "unreadable"`, summary "convert to JPEG/PNG to extract").
  - **(DA-A-27)** `contentHash` is normalized to lowercase hex at finalize: `_storage.sha256` is decoded from base64 when it is not already 64 hex characters. M13 confirms the production encoding once on `adorable-lion-138` and records it.
  - **Dedupe (DA-A-20)** runs on `(userId, sha256)` **against `retention === "active"` rows only**. A `content_deleted` match is **revived**: the new blob is bound, `retention` returns to `active`, and `text` is re-derived. An active match → the new blob is deleted and the existing id returned.
- **Text evidence** (forward or paste, M13):
  - `maskPans` (D142) runs before any persist, hash, log or model call.
  - `contentHash` = hex sha-256 of the masked, whitespace-normalized text.
  - `headers` is kept separately.
  - `provenance` is `user_forwarded` when the sender is the account address or the message is a forward the user sent to the inbox, `user_pasted` for a paste, and **`unverified_sender`** otherwise (SEC-AI-6). Facts from `unverified_sender` evidence are candidates only, never auto-confirmed, and never write ledger or case state.
- **Card masking (D142, `lib/pan.ts`, M10).** A digit run is masked to `•••• <last4>` only if:
  - (a) it is Luhn-valid, **and**
  - (b) it carries a card-network issuer prefix at that brand's length (Visa 4 at **16/19 only** (rev 5, C5: a 13-digit Visa-prefix string is kept, because Frontier/Spirit e-tickets and EAN-13 codes 400–440 collide with it); Mastercard 51–55 and 2221–2720 at 16; Amex 34/37 at 15; Discover 6011, 644–649 and 65 at 16–19; JCB 3528–3589 at 16–19; Diners 36, 300–305 and 38–39 at 14–19; UnionPay 62 at 16–19), **and**
  - (c) its separators are single spaces or single hyphens only.

  Typed identifiers never pass through the masker. Required tests: standard test PANs are masked in payload, evidence text, facts, export, logs and model input; **these Luhn-valid samples survive unchanged (rev 5, C5; lead-verified in D148): IMEI `352099001761481`, 13-digit e-ticket `4221234567897`, order ref `112-3456789-1234562` and EAN-13 `4006381333932`.** A keep-test sample that is not Luhn-valid proves nothing and is not accepted. **Accepted residual (D142):** the AgentMail component's own raw inbound copy cannot be masked by Recoup. It is purged on account deletion (D119) and **disclosed on the Privacy page** (M15).
- **Retention (DA-A-7, D145; M14 implements, M15 publishes the copy):**
  - **Email and paste text** is cleared (`text` removed, blob deleted if any, `retention: "content_deleted"`) at `receivedAt + RETENTION_EVIDENCE_DAYS`, **unless its transaction has a case or the row is pinned**. "Has a case" means any claim referencing the transaction through `claims.by_transaction_and_status`, or, for retail, any claim on its purchase through `by_purchase_type`.
    - After clearing, only `headers`, `contentHash` and the facts' locator quotes (≤ 300 chars each) persist.
    - Evidence of a transaction that gets a case **later** but was already cleared stays cleared. The user may re-upload, which revives the row (DA-A-20).
  - **Uploads:** kept while linked to a non-archived transaction or pinned. Unlinked uploads are cleared after 30 days. Account deletion purges everything.
  - The Privacy copy states exactly these rules. It is rendered from `convex/lib/privacyFacts.ts` (M14, backend constants), and a copy test asserts the rendered text contains every constant.
  - The lead records the D83(5) amendment ("30 days unless you start a claim or keep it"). The promise is **kept, not weakened**: without a case or pin, the text is still gone at 30 days.
- **Quote verification (DA-A-6, D145; implemented in M23, wave 2).** `quoteStatus: "verified"` requires **both**:
  - (i) `normalizeForMatch(text.slice(start, end)) === normalizeForMatch(quote)` at the locator, **with no 40-character minimum**, against a **deterministic text layer**: email/paste text, or a PDF text layer from the pinned library (D145); **and**
  - (ii) `parseValue(key, quote)` equals the emitted value for the value kind (money via `parseDecimalToMinor`, dates via the date grammar, identifiers exactly).

  Content the model transcribed from an image or an image-only PDF → **`unverifiable`**, which never counts toward `evidenceSupports`. A failed match → `unverified`. `lib/passage.verifyPassage` keeps its 40-character floor for policy passages only (D17/D45 unchanged).
- **Access:** no `ctx.storage.getUrl` for evidence anywhere: queries, exports, logs or mail (SEC-UP-5/SEC-DEL-3). `GET /evidence/file?id=<evidenceId>` (httpAction):
  - checks bearer auth, the tombstone and ownership; a missing, foreign or content-deleted id → 404 with an identical body;
  - is rate-limited per user (`evidenceDownload`);
  - streams `ctx.storage.get` with `Content-Disposition: attachment; filename="<ascii fallback>"; filename*=UTF-8''<RFC 5987>`, `X-Content-Type-Options: nosniff`, the **sniffed** type and `Cache-Control: private, no-store`.

  Evidence queries return no URL-shaped field; a test greps results for `/api/storage`. **Previews (DA-A-28b)** are built only from the **server-sniffed** image type in the response header (`image/jpeg|png|webp`). They are rendered in `<img src={blobUrl}>` and never through `window.open`, an iframe, or a Blob type taken from a stored field. PDFs are download-only.
- **CORS (DA-A-28c):** `http://localhost:5173` is allowed **only when `CONVEX_SITE_URL` matches the dev deployment**, never on production.
- **Orphan sweep (SEC-UP-7, DA-A-28d; M14):** deletes `_storage` blobs older than 24 h that no **registered referencing table** references. The registry is `BLOB_REFERENCES` in `convex/lib/blobRefs.ts` (M14), today `evidence.by_storage`. Any future blob-storing feature must add itself, and a test fails if a table with a `v.id("_storage")` field is not registered.
- **Live extraction (D145).** Extraction of **real users' uploaded documents** is disabled by the server flag `live_document_extraction` on **every** deployment. Enabling it requires **the user's explicit data-flow approval**. `ops.setFlag` refuses to enable it without an `approvalRef` that the lead records in DECISIONS. Synthetic fixtures on the dev deployment are allowed.
- **Statement gate:** `card_statement` extraction additionally requires SEC-SD-1, SD-2, SD-4 and AI-5.
- **Text-layer pre-scan (DA-A-8; M23):** a card number detected by `lib/pan.detect` in a text layer forces `store_only` whatever the declared type.

### 2.7 Rule packs, review, activation and refresh

- **Layout:**
  - Engine: `convex/lib/rules/{types,outcome,conditions,registry,coverage,applicable}.ts` and `convex/lib/deadlines/{engine,calendar,usFederalHolidays,usZones}.ts`.
  - One immutable file per pack version (`r01_price_adjustment_v1.ts`, underscores only).
  - Fixtures: `docs/rules/fixtures/*.json` (M02), loaded by **M08's fixture loader**, which checks the manifest hash and maps outcome aliases.
  - Captured sources: `docs/rules/sources/*.txt` and `federal-web-pages-excerpts.md` (D143.5).
  - `RulePack<S, P>` fields follow the README field map exactly (each spec section → one field).
- **Lifecycle** is `draft → researched → reviewed → active → superseded/withdrawn` (README). **Who moves what (D145 DA-A-11):**
  - **researched:** M02, the rules researcher.
  - **spec-level review:** **M09**, `opus-rules-reviewer`, independent of the researcher and running now. It covers R01–R05, each passage against its captured text, plus a blind fixture check.
  - **code-pack review:** **M18** (wave 1, R01 v1) and **M27** (wave 2, R02–R05), also `opus-rules-reviewer`. The code pack must match the M09-approved spec, cite every param's passage id, and **pass every fixture unchanged through M08's loader**.
  - **active:** the lead records a DECISIONS entry **and** the one-line activation in `convex/lib/rules/activation.ts`. That data-only file is **lead-owned** and is checked by `scripts/check-rule-packs.mjs` against `docs/rules/manifest.json` and the DECISIONS id. "Active" means *independently reviewed against the captured first-party text*, never legal certification.
- **Registries (D145 c/d).** `lib/rules/registry.ts` (production) returns a pack only when `activation.ts` marks it active. Test packs live in `lib/rules/testRegistry.ts`, which only `*.test.ts` files may import (grep test). `coverage.ts` reads only the production registry, so a coverage row cannot reach `implemented_verified` from a test pack. **No opportunity card exists without an active pack.** The transaction page shows a separate "Paths not checked / source not verified" list from `coverage.ts`, with no amounts (§9).
- **Refresh and staleness (README rule 3).**
  - `convex/lib/rules/verification.ts` is lead-owned data: `{ [sourceId]: { lastVerifiedAt, sha256 } }`. It is updated only after `scripts/verify-rule-sources.mjs` runs. That script is on-demand. **The lead runs it at every wave close, before release, and weekly while any slice's pack is active** (rev 5, D148 wave-2 note), so no pack reaches its refresh window unnoticed. A hash drift writes `docs/rules/review-items/<date>-<sourceId>.md`, and the script **never edits logic**. Federal sites that refuse non-browser clients are re-verified manually and recorded with `method: "browser"`.
  - An active pack evaluated past a source's refresh window → `source_unverified`, via the flag `sourceStale`.
  - **Reconciliation for R01 v1 (D145 d).** R01 v1's framework logic cites no external legal source. Its parameter source is **exactly the snapshot `latestPolicy()` selects today**: the newest user-confirmed snapshot for (user, merchant, `price_adjustment`), otherwise the newest (rev 5, N7, D148). It is never "the snapshot nearest the purchase", which would change `windowDays` and break parity. A-T1/A-T2 are computed from **that** snapshot's `retrievedAt`. The question that matters is *purchase-time applicability*, not whether the page is current. So README rule 3's 7-day merchant window applies to **reviewed merchant packs** (the R01 v2 tier). For the v1 snapshot tier, freshness is measured **relative to the purchase**:
    - a snapshot retrieved within ±7 days of `purchasedAt` gets assumption A-T1 ("policy text retrieved within a week of your purchase; assumed to be the policy then");
    - otherwise it gets assumption A-T2 ("retrieved N days after purchase; the policy may have changed") and the next action "refresh policy".

    Both are assumption-class. Neither yields `eligible` or blocks the case, so parity holds (KM1). **M02 is asked (via the lead) to add this sentence to README rule 3.**
  - **R01 v1 `FactRequirement`s:**
    - **required:** `retail.purchase_date` and `retail.unit_price` (active purchase), `retail.observed_price` (an accepted observation in the purchase currency with `variantMatch: exact` and confidence ≥ 0.7), and `retail.window_days` (from the snapshot; missing → `source_unverified`);
    - **assumption-class:** `retail.policy_confirmed` (the snapshot has not been confirmed by the user), `retail.policy_temporal` (A-T1/A-T2, always present in v1), and `retail.currency` (legacy currency not confirmed, DA-A-33).

    **So R01 v1's best outcome is `likely_eligible`, never `eligible`**, matching M02 R01 §1.4 and L1. That outcome is in `APPROVABLE_OUTCOMES`, so auto-open parity holds (DA-A-2).
  - **R01 v1 bound facts (rev 5, C2, D148).** The approval binding (`boundFactsHash`, and `boundFacts` on the evaluation) covers exactly: unit price, quantity, item identity (item id + name), purchase date, claim amount (`claims.expectedCents` + currency), and **the observation the claim was opened on** (`openedFromPriceCheckId`: its `observedCents`, currency and `observedAt`, frozen). **It never covers the live observed-price cell**, so price checks on an open case never invalidate an approval (KM3).
  - **Testing R01 before activation (rev 5, C3, D148).** Until the lead's activation commit, the production registry has no R01 v1, so `recordCheck` runs the legacy fallback. Every R01 behaviour test therefore runs in **both modes**:
    - (a) the legacy fallback;
    - (b) R01 v1 forced active through the test seam `vi.mock("./lib/rules/registry", …)`, which returns `testRegistry`'s R01 v1.

    The seam lives only in `*.test.ts`, per the testRegistry import rule. **Wave 1 closes only after the lead re-runs the full suite at the activation commit**, with v1 active through the production registry.
- **Temporal rule (D143.1)** applies to the **reviewed merchant tier** (R01 v2, wave 3): a displayed `effective_from` after the purchase date → `source_unverified`, no auto-open, and next action `ask_anyway`. Unknown → assumption-capped `likely_eligible`. The R01 parity gate covers the legacy/unknown tier only.
- **Engine versioning (DA-A-23; M20, wave 2).**
  - `lib/rules/engineVersion.ts` exports `ENGINE_VERSION`, the SHA-256 of the evaluator import closure: types, outcome, conditions, deadlines + holiday/zone tables, facts resolve/snapshot/catalog, canonical.
  - `scripts/check-rule-packs.mjs` recomputes it and fails CI on a mismatch.
  - `ENGINE_VERSION` enters `resultHash`, `approvalBinding.engineVersion` and the materiality rule (§2.8).
  - The script also **refuses a change to the hash of any existing manifest entry with status ≥ reviewed**, comparing against `origin/main`'s manifest.

### 2.8 Opportunities and cases (M12)

- **`evaluateTransaction(ctx, transactionId, trigger, now, subjects?)`**, a plain helper called in mutations:
  1. build the snapshot for the requested subjects only; on `observation` triggers, only the changed subject is evaluated (DA-A-32);
  2. select the scenarios that have an **active** pack;
  3. run `evaluate`;
  4. **link mandatorily (DA-A-3)**, before any upsert decision: for R01, find a non-closed `price_adjustment` claim on the item through `by_item_type_status`. If its `opportunityId` is unset, patch the claim (`opportunityId`, `transactionId`, `currency`, `scenarioId: "R01"`, `remedyKey: "price_difference"`, `lossKeys`) and set the opportunity's `activeClaimId` and `status: "case_open"` (trigger `link`). The optional migration is an optimisation only.
  5. upsert through `by_user_and_dedupe_key`;
  6. append an evaluation only when `resultHash` changed;
  7. project the evaluation onto the opportunity;
  8. **materiality:** if `activeClaimId` is set and the change is material, bump `claims.version` and write a `claimNotes` row. Material means any of:
     - the outcome leaves the approvable set, **except** a `deadline_passed` whose only failing condition is a deadline spec marked `lateAskAcknowledgeable` (the R01 legacy window; rev 5, C1);
     - `ruleVersion` or `engineVersion` changes;
     - a **user** deadline flips to passed, **except** a `lateAskAcknowledgeable` one: the legacy R01 window closing is **not** material and bumps no version (C1, D148);
     - `boundFactsHash` changes;
     - **the scenario's pack is no longer active** (activation withdrawn; rev 5, N3). The first `evaluateTransaction` or `prepareSend` that finds it supersedes the opportunity (`status: "superseded"`), bumps `claims.version`, writes a claimNote ("R01 checks were withdrawn; review and approve again"), and the claim continues under the legacy send path.

     Estimate drift while a case is active is **not** material.
- **`recordCheck` order (R01):**
  1. insert the `priceChecks` row;
  2. **if R01 v1 is active:** run `evaluateTransaction(subject item)` (this links any legacy claim), then auto-open through the `openCase` guard. **Auto-open stays closed past the window** (`deadline_passed` is not approvable for auto-open; M1C R01-05c). Only a user send with acknowledgment can go late (§6, C1);
  3. **if R01 v1 is not active:** run the **legacy path unchanged** (today's code, with no opportunity rows). This keeps deploy and revert safe. **Wave 1 closes only with R01 v1 active** (M18 + lead), so the vertical slice is real (DA-A-2, DA-A-11).
- **`openCase({ opportunityId, claimedAmount? })`:**
  1. check ownership and the tombstone;
  2. re-evaluate (`case_open`); the outcome must be in **`APPROVABLE_OUTCOMES = {eligible, likely_eligible, possible_contract_benefit}`**. This one set is shared by case opening, `drafts.prepareSend` and `packets.approve` (DA-A-14);
  3. if `activeClaimId` points to a claim that is not closed, return that claim id (idempotent);
  4. **overlap guard (DA-A-4, D145).** Read the user's active claims on this transaction and on the server-set `relatedTransactionId`, through `by_transaction_and_status`, **filtered by `userId`** (DA-A-29).
     - A loss-key intersection with **no declared relation defaults to `alternative`**: the open is refused with "You already have an active claim for this loss via <X>".
     - `coordinated` applies only when a pack declares it **with a `sourcePassageId`**; the open is then allowed with a notice.
     - `primary_secondary` is refused until the primary is closed (wave 3).
     - `complementary`/`distinct_lines` never share keys (a pack test enforces it).
  5. check the amount (pack estimate, or `claimedAmount` for `user_claimed`; `assertUserAmount`, and ≤ the documented total);
  6. insert the claim and set `activeClaimId` in the same mutation.
- **After a denial (DA-A-22; wave 2 via M2C in priceWatch):** when an R01 claim is `denied`, auto-open happens again only for an observation **strictly below** the denied claim's opening observation (`openedFromPriceCheckId.observedCents`). The new claim asks only for `(deniedObserved − newObserved) × qty`, subject to the threshold. Anything else requires the user-initiated "ask again" (`openCase` with `userInitiated: true`).
- **Closing:** a claim that is dismissed or denied reopens its opportunity (`open`, `activeClaimId` cleared). A confirmed claim, or one with `nonCashResolvedAt` set, closes it. A dismissed opportunity stays dismissed.

---

## 3. Money and recovery types

### 3.1 Money helpers (M10, `lib/money.ts`)

- `money` validator; `CURRENCY_EXPONENT = { USD: 2 }` for **new scenarios** (O6). **R01 carve-out (DA-A-13):** the R01 v1 money path uses `assertCurrency` plus `isTwoDecimalCurrency(code)` (Intl `maximumFractionDigits === 2`), exactly as the legacy flow does. A GBP purchase with a GBP observation still opens a claim; a GBP purchase with a USD observation is still rejected (D16).
- `assertMoney`, `assertUserAmount` (≤ `MAX_USER_AMOUNT_MINOR`), `formatMinor`, `claimCurrency(claim, purchase)`.
- **`parseDecimalToMinor(s, currency)` (DA-A-26)** accepts only `^\d{1,3}(,\d{3})*(\.\d{1,E})?$` or `^\d+(\.\d{1,E})?$`, where E is the currency exponent, after trimming ASCII spaces. It **rejects**:
  - `"12,34"`, `"1.234,50"`, `"1,23,456"`
  - `"12."`, `".5"`
  - full-width digits, NBSP inside the number
  - exponents
  - more fraction digits than E

  Sign markers (`"-12.50"`, `"(12.50)"`, `"12.50 CR"`) return a typed `{ signMarked: true }` result that callers route to `needs_review`. They are **never** parsed as positive. There is one property test per case.

### 3.2 Recovery-event taxonomy

| Concept | Storage | Tile (§3.4) |
|---|---|---|
| Potential | `opportunities` | Potential |
| Estimate | `evaluations.amount.estimate` (cap = limit only) | — |
| Claimed amount | `claims.expectedCents` + `claims.currency` | by furthest state |
| Submitted amount | `drafts.binding.amount` / `packets.binding.amount` + `submissions` | — |
| Promise | `ledgerEvents.promised_credit` (latest, D21) | Promised |
| Provisional credit | **`provisional_credit`** (user-recorded) | "of which provisional" |
| Provisional finalized or reversed | **`provisional_released`** (+ `confirmed_credit` when finalized) | — |
| Confirmed posted credit | `confirmed_credit` — **only `claims.ts` writes it** (SEC-MF-5 amended, D145) | Recovered |
| Reversal / later debit | `later_debit` (D40) | reduces Recovered |
| Non-cash | `nonCashRemedies` | Non-cash count |

- **Ledger rewrite (M10, one commit):** an exhaustive switch with a `never` check. `provisional = Σ provisional_credit − Σ provisional_released`, asserted ≥ 0. `unresolved` is **unchanged**. Provisional kinds never change status.
- **Finalize (DA-A-16).** `claims.finalizeProvisionalCredit({ claimId, cents, evidence, idempotencyKey })` writes `provisional_released` with key `${key}:release` and `confirmed_credit` with key `${key}:confirm`. Both go through the **one** helper `writeConfirmedCredit` that `confirmCredit` also uses. A retry dedupes both events.
- **`confirmCredit` while `provisional > 0` (rev 5, N5, D148): the user chooses; a separate posting is never refused.** `confirmCredit` gains an optional `separateFromProvisional: true`.
  - Without it, while provisional > 0, the mutation writes nothing and throws `ConvexError({ kind: "ProvisionalOutstanding", provisionalMinor })`. The UI then asks "Is this the provisional credit becoming final?" (→ `finalizeProvisionalCredit`) or "Is this a separate credit?" (→ `confirmCredit` with `separateFromProvisional: true`).
  - With the flag, it records `confirmed_credit` normally and leaves `provisional` unchanged.
- **Grep test:** the only production file containing an insert of `kind: "confirmed_credit"` is `convex/claims.ts`.
- **Non-cash:** `claims.recordNonCashRemedy` (M10, wave 1) appends a promised or received row without changing status. **`claims.recordNonCashResolution`** (M20, wave 2; DA-A-18) appends a received row, sets `nonCashResolvedAt` (closed for ask and cash tiles; reminders cancelled), and for R02 also writes the acceptance fact (`air.alternative.accepted`, value "voucher accepted") and re-evaluates.

### 3.3 Overlap and loss keys

- Loss keys are anchored on the transaction where the money was paid:
  - **R01:** `item:<itemId>:price_diff:<n>`, where n = 1 + the number of confirmed price claims on the item, so successive drops are distinct losses while an open claim and its opportunity share a key.
  - **Legacy claims:** keys are synthesized at link time: `price_adjustment` → `item:<id>:price_diff:<ordinal>`; `return_credit` → `item:<id>:return_credit`.
  - **R02:** `txn:<id>:fare_unused`.
  - **R04:** `txn:<id>:bag_fee:<n>`, and `txn:<id>:exp:<n>` per expense line.
  - **R05 and R03 on a related charge:** `txn:<paidTxnId>:paid`.
- Relations are declared in packs. Undeclared intersections are `alternative` at case opening (D145). Totals use components (§3.4).

### 3.4 Dashboard totals: `recovery.summary({ now })` (M12)

This is **the one server function** behind every money number (SEC-MF-1). Rules:
- per currency; no conversion;
- examples excluded; the example join is on `claims.isExample` for ledger and non-cash rows, and on `opportunities.isExample` (DA-A-35);
- bounded reads: claims `by_user` ≤ 200, open opportunities ≤ 200; `complete: false` on a real cut;
- `purchases.board` totals are **untouched**, so D39 stays in force there and `purchases.test.ts:387–407` / `lib/ledger.test.ts:198–202` stay unmodified (D145).

```
nodes(c)  = claims(currency c, not dismissed) ∪ opportunities(c, status open, outcome ∈ {eligible, likely_eligible},
            estimate present, cashClass cash, no activeClaimId)
K         = connected components over shared lossKeys (union-find)
open(m)   = m is an opportunity, or a claim that is not closed-for-ask
net(claim)        = max(0, confirmed − debited)
lossAll(K)        = max( max_{claims in K} expectedCents, max_{opps in K} estimate )      // caps Recovered
lossOpen(K)       = max( max_{open claims in K} expectedCents, max_{opps in K} estimate ) // what is still being pursued
recovered(K)      = min( Σ_{claims in K} net, lossAll(K) )         // D145: alternatives never add
excess(K)         = Σ net − recovered(K)                            // shown on the "Over-credit / possible double credit" line, never erased
outstanding(K)    = K has an open member ? max(0, lossOpen(K) − recovered(K)) : 0
   // e.g. R05 case confirmed 60,000 + coordinated R03 case open → outstanding 0; a denied 5,000 claim + a new 2,000
   // "difference only" claim on the same key → outstanding 2,000 (the denied amount is not re-counted)
tile(K)           = furthest state over open members: promised > asked > sending_or_unknown > ready > potential   (DA-A-17)
   promised            : a claim with promised > net and status promised
   asked               : delivery ∈ {sent, delivered, submission_recorded, user_reported} on the claim's requiredChannel (DA-A-9)
   sending_or_unknown  : delivery ∈ {queued, accepted, unknown, stalled}
   ready               : CATCH-ALL (rev 5, C4): every open claim not in a higher tile — incl. detected/drafted/packet_prepared/failed,
                         reopened, a legacy `packet` without delivery evidence, and `promised` with promised ≤ net
   potential           : only opportunities
provisionalOf(K)  = min(outstanding(K), Σ provisional)             // rendered "of which provisional" inside tile(K)
per-transaction cap (D145): for each transaction T with a known confirmed paid total P(T)
   (retail (rev 5, D148 wave-2 note): the confirmed order total incl. tax + shipping (fact `retail.order_total`, user_confirmed or derived
    from confirmed facts) when known, else Σ item unitCents×qty with `paidTotalPartial: true` shown as "cap based on item prices only";
    air: confirmed air.total_paid; card: confirmed card.charge_amount),
   if Σ_{K anchored on T} (recovered + outstanding) > P(T): reduce outstanding in order potential → ready → sending → asked → promised,
   set cappedAtPaidTotal
closed-for-ask(claim) = status ∈ {confirmed, dismissed, denied} or nonCashResolvedAt set  (lib/claimState.isClosedForAsk)
```

**Reported per currency:**
- Recovered = Σ recovered(K).
- Over-credit / possible double credit = Σ excess(K).
- The tiles Potential, Ready to ask, Sending or unknown, Asked and Promised, each carrying "of which provisional".
- Non-cash counts by kind (face values per item only).
- `askedUserReportedMinor`, the legacy note-only sub-figure.
- `cappedAtPaidTotal`.

**Invariants (property-tested per currency):**
- (I1) Σ tiles = Σ_K outstanding(K).
- (I2) Recovered + Over-credit = Σ_claims net.
- (I3) The tiles are disjoint **and exhaustive**: every component with an open member is in exactly one tile. The property-test generator covers every claim status (detected, drafted, queued, sent, packet, promised, reopened, confirmed, dismissed) × delivery state × promised ≶ net × provisional 0/>0 × a linked opportunity or not (rev 5, C4).
- (I4) For each capped transaction, Σ ≤ P(T).
- (I5) No cap value and no non-cash face value appears in any sum.

The headline "money found" is Recovered. Potential is labelled "estimated, not guaranteed".

---

## 4. Evaluator and deadline contracts (M12; pure; no ctx, clock, randomness or `lib/ai` import — grep test)

```ts
export interface FactRequirement {
  subjectPattern: string; key: FactKey;
  class: "required" | "assumption";    // DA-A-2: assumption-class unknowns add an Assumption, never set factsKnown
  assumptionText?: string;             // required when class = "assumption"
  sensitive?: boolean;                 // DA-A-24: must pass the decisiveness test to be asked
}
export interface EvaluationInput<S, P> {
  snapshot: S; snapshotHash: string;
  pack: { ruleId: string; scenarioId: ScenarioId; version: number; params: P; sources: RuleSourceMeta[] };
  verification: Record<string, { lastVerifiedAt: string }>;   // from lib/rules/verification.ts
  engineVersion: string;
  remedyKey: string; subjectKey: string; incidentId?: Id<"incidents">;
  caseContext: { activeClaimId?: Id<"claims">; settledMinorByLossKey: Record<string, number>;
                 deniedObservedMinor?: number };               // DA-A-22
  now: number;                                                 // injected clock
}
export interface EvaluationResult {
  scenarioId; ruleId; ruleVersion; engineVersion; remedyKey; subjectKey; snapshotHash;
  outcome: Outcome;                                            // ONLY via deriveOutcome
  dimensions: { applies: Tri; factsKnown: Tri; evidenceSupports: Tri; windowOpen: Tri; amountCalculable: Tri; readyForApproval: Tri };
  conditions: ConditionResult[]; missingFacts: MissingFact[]; assumptions: Assumption[]; disqualifierIds: string[];
  amount: AmountCalc | null; deadlines: DeadlineResult[]; sourceRefs: SourceRef[];
  lossKeys: string[]; overlap: OverlapDecl[]; nextAction: NextAction; explanation: string[];
  flags: { unsupportedReason?: string; sourceStale?: boolean; effectiveDateMismatch?: boolean;
           conflictingKeys: string[]; contractCoverageInexact?: boolean; manualReviewReason?: string };
}
export type Evaluator<S, P> = (input: EvaluationInput<S, P>) => EvaluationResult;

/** lib/rules/conditions.ts (DA-A-24): all/any/not/fact combinators with tri-state short-circuit.
 *  missingFacts = facts in UNRESOLVED branches whose values could flip the combinator's result
 *  (an `any` already passed lists nothing; a `sensitive` key is listed only if decisive). */
export function evaluateConditions(tree: ConditionNode, cells: CellLookup): { result: Tri; conditions: ConditionResult[]; decisiveMissing: MissingFact[] };

export function deriveOutcome(d: Dimensions, f: Flags, assumptions: Assumption[]): Outcome;
//  1 f.unsupportedReason                                  -> "unsupported"
//  2 f.sourceStale || f.effectiveDateMismatch             -> "source_unverified"   (only reachable for ACTIVE packs)
//  3 d.applies === "fail"                                 -> "not_eligible"       (from known facts only)
//  4 d.windowOpen === "fail"                              -> "deadline_passed"    (USER-obligor deadlines only — DA-A-5)
//  5 f.conflictingKeys.length > 0 || f.manualReviewReason -> "manual_review"
//  6 d.applies === "unknown" || d.factsKnown === "unknown" -> "needs_facts"       (required-class facts only)
//  7 f.contractCoverageInexact                            -> "possible_contract_benefit"
//  8 d.evidenceSupports !== "pass" || assumptions.length > 0 -> "likely_eligible"  (DA-A-2 row: "only assumption-class unknowns → likely_eligible")
//  9 otherwise                                            -> "eligible"
//  resultHash = sha256(canonical({outcome, dimensions, conditions[].{id,result}, missingFacts, assumptions[].id, amount,
//                deadlines[].{id,status,dueAt,overdueSince,advisoryActBy}, nextAction.kind, ruleVersion, engineVersion,
//                boundFactsHash}))  (DA-A-32; boundFactsHash added in rev 5 (N6) so a stored `boundFacts` is never stale)
```

```ts
// lib/deadlines/engine.ts (pure)
export interface DeadlineSpec {
  id: string; label: string;
  obligor: "user" | "counterparty";    // DA-A-5: only "user" feeds windowOpen, nextDeadlineAt and "expired"
  anchor: { subjectPattern: string; factKey: string };   // the LEGAL trigger; never a fallback date
  anchorKind: "event_occurred" | "notice_sent" | "notice_received" | "statement_transmitted" | "purchase" | "delivery" | "report_filed" | "refund_duty_start";
  offset: { amount: number; unit: "calendar_days" | "business_days" | "hours" | "elapsed_24h_days" };
  boundary: { anchorDayCounts: boolean; endInclusive: boolean };
  endOfDay: "local_end_of_day" | "exact_instant";
  timeZone: { from: "fact"; factKey: string } | { fixed: string };
  holidays: "none" | "us_federal";
  mustBe: "received" | "sent" | "filed" | "paid" | "n_a";
  advisoryWhenAnchorUnknown?: { fromFactKey: string; offsetDays: number; label: string }; // D143.3 (R03: posting date + 60)
  appliesWhen?: ConditionNode;          // e.g. payment class selects the 7-business vs 20-calendar timer (D143.2)
  lateAskAcknowledgeable?: true;        // rev 5 (C1): set ONLY on R01 v1's legacy window (merchant_promise, elapsed_24h_days).
                                        // Passing it gives deadline_passed but is acknowledgeable at send time and not material.
  sourcePassageId: string;
}
export function computeDeadline(spec: DeadlineSpec, cells: CellLookup, now: number): DeadlineResult;
//  anchor missing | candidate | user_unknown  -> "unknown_anchor" (dueAt undefined); + advisoryActBy if spec.advisoryWhenAnchorUnknown and that fact is known
//  anchor conflicting                         -> "disputed_anchor" (basis lists each candidate)
//  business days beyond the committed holiday table -> "beyond_calendar"
//  tz unknown & local_end_of_day              -> dueLocalDate + dueAt at the earliest-ending zone in usZones.ts + assumption
//  user obligor:        "open" | "passed"
//  counterparty obligor: "open" | "overdue" (overdueSince = dueAt) — NEVER "passed"; nextAction "escalate" when overdue
```

---

## 5. State separation

| State | Holder | Written by |
|---|---|---|
| Eligibility | `opportunities.outcome` (+ `evaluations`) | `recordEvaluation` only |
| Opportunity lifecycle | `opportunities.status` | `openCase`, claim-closure hooks, `dismiss` |
| Case workflow | `claims.status` (existing + `denied` in wave 2) + `nonCashResolvedAt` (wave 2) + `caseMode` (wave 2) | existing writers, `recordDenial`, `recordNonCashResolution` |
| Delivery | `lib/claimState.delivery(claim, drafts, packets, submissions)` (derived) | — |
| Recovery | derived from the ledger and `nonCashRemedies` | never stored |

- **Delivery projection (DA-A-9).** When `claim.requiredChannel` is set, delivery, "submitted", Asked and "expired" are projected **only** from artifacts on that channel: drafts with `purpose !== "informal"` for email, submissions whose `channel === requiredChannel` for manual channels. Informal outreach, such as a merchant email on an R03 claim, is correspondence only. Values: `none`, `draft`, `approved`, `queued`, `accepted`, `sent`, `delivered` (provider-reported), `failed` (a permanent 4xx only, S-M03-1), `bounced`, `unknown`, `stalled`, `packet_prepared`, `submission_recorded`, and `user_reported` (a legacy note-only packet). A legacy claim without `requiredChannel` keeps today's projection.
- **Expired:** a claim not submitted on its required channel whose **user-obligor** deadline has passed. It is display-only and never stored.
- **Closed-for-ask** is `lib/claimState.isClosedForAsk(claim)`, one helper replacing the scattered status lists. Each file's owner switches its own call site: claims.ts and followUps.ts in M10; priceWatch.ts in M12; drafts.ts in M13; purchases.ts in M11; tracking.ts in M2C (wave 2).
- **Transitions:** the existing ones are unchanged and pinned by regression tests. Wave 2 adds:
  - {sent, packet, promised, reopened} → `denied` via `recordDenial`;
  - `denied` → promised/confirmed when money arrives;
  - `denied` → dismissed;
  - any open status → closed-for-ask via `nonCashResolvedAt`.

  `packet` is reached for scenario claims only through `submissions.record`.
- **Display** (mission §14): detected / needs facts / likely eligible / user verified / ready to send / **tracking** (the `track_automatic` case mode) / submitted (on the required channel) / paid / denied / escalated (wave 3) / expired (derived).

---

## 6. Channels

| Channel | Artifact | Prepared | Submitted | Sent | Delivered |
|---|---|---|---|---|---|
| Email (AgentMail) | `drafts` + `binding` | a draft with a binding | — | message id (reconcile) | component status `delivered` |
| Manual | `packets` + `submissions` | packet `approved` | a `submissions` row (user-recorded) | never claimed | `deliveryRecordedAt` + evidence only |
| Tracking (`track_automatic`) | none | — | — | — | counterparty deadline tracked; overdue → escalate |

- **Email approval (DA-A-14, DA-A-21).** A new public mutation **`drafts.prepareSend({ draftId, to, subject, body, acknowledgeWindowRisk? })`**.

  **Check order (rev 5, N2, D148)**, the same checks as `approveAndSend` and in this order, all before any evaluation:
  - `requireUserId`, which covers the tombstone;
  - `ownedDraft` → `ownedClaim`, with the identical not-found and nothing written;
  - the example refusal;
  - `parseSingleEmail` on `to`;
  - the per-user rate limiter `prepareSend` (bucket in `lib/rateLimits.ts`, M13; 60 per minute per user, from M03 §3.7's evaluate limit).

  It then:
  1. re-evaluates the claim's opportunity (`approval_check`) and **commits** the result, including any material version bump and claimNote;
  2. **returns** `{ ok: true, preparedHash } | { ok: false, code, message }` and **never throws on a policy refusal**, so the persisted invalidation survives;
  3. charges nothing.

  **Behaviour change (D145):** if any existing test sends after `windowEndsAt`, M13 lists it in its report and the lead approves the amendment. The D145 ruling overrides §8's "unmodified" for that case only.

  Refusal codes:
  - `outcome_not_approvable` (the one `APPROVABLE_OUTCOMES` allow-list);
  - `binding_changed`;
  - `window_may_have_passed` (rev 5, C1, D148). This refusal is acknowledgeable, **identical for linked and unlinked R01 claims**, and never a hard refusal:
    - For a **linked** claim, it is returned when the fresh evaluation is `deadline_passed` **and its only failing condition** is the `lateAskAcknowledgeable` R01 window. It is returned instead of `outcome_not_approvable`.
    - For an **unlinked** claim, it is returned when `windowEndsAt` < now.
    - With `acknowledgeWindowRisk: true`, the send proceeds as if approvable, with no version bump and no new draft required.
    - Any other failing condition still returns `outcome_not_approvable`.
  - `rule_withdrawn` (rev 5, N3): the linked claim's pack is no longer active. The first call supersedes the opportunity and bumps the version (§2.8). Later calls use the legacy path.
  - `rate_limited`;
  - `example_claim` (checked before any evaluation, per the check order above).

  **`preparedHash`:**
  - for a claim **with** an opportunity: `contextHash` (the binding) + to/subject/body + draftVersion;
  - for a claim **without** one, or a superseded one (N2, D148): the hash of the existing binding {to, subject, body, claimVersion, draftVersion}, plus `acknowledgeWindowRisk` when it applies.

  **`drafts.approveAndSend` keeps its signature** (existing tests stay unmodified). For claims with `opportunityId`, or any claim past `windowEndsAt`, it requires the optional arg `preparedHash` to equal a read-only recomputation, and requires `acknowledgeWindowRisk` when applicable. On a mismatch it throws "Review the claim again", which loses nothing because prepareSend already persisted. Legacy claims inside their window are byte-identical to today. The UI (M15 Composer) always calls prepareSend first.
- **S-M03-1:** `retryAttempts: 1`. Only a permanent AgentMail 4xx, a bounce or a rejection counts as terminal. Anything else is `unknown`, with the binding kept.
- **Resend (DA-A-31):** `resendAfterUnknown` = the prepareSend checks + the approveAndSend checks + `acknowledgedOutboundId`. It consumes one send.
- **S-M03-4:** `sanitizeError` in `applySendOutcome`'s failure branch; `sendStatus` returns a sanitized `errorMessage`.
- **S-M03-5:** `approveAndSend` parses `to` through `parseSingleEmail(stripControl(to), MAX_TO_CHARS)` **before** any regex. The same rule applies to every new address field.
- **SEC-AI-4:** post-generation validator on the R01 LLM draft (M13) and the packet templates (M21/M22). Any amount, email, URL or phone number in the body that is not in the bound facts or the pack text blocks approval until the user edits or acknowledges it. Recipient, channel, amount and currency are server fields.
- **Manual approval (M20).** `packets.approve({ packetId, approvedHash })` checks:
  - the rendered-hash echo;
  - that this is the newest version;
  - that `binding.contextHash` is current;
  - that there is a recipient;
  - that each evidence item is owned, active and has an unchanged hash;
  - `APPROVABLE_OUTCOMES`;
  - that the claim is not an example.
- **Recording (DA-A-10).** `submissions.record({ packetId, submittedAt, confirmationRef?, proofEvidenceId?, note? })` requires only that **this packet version was approved (`approvedHash` stored) and was not superseded before its `approvedAt`**. If the binding drifted after approval (ledger event, re-evaluation, deadline passed), recording **still succeeds** with `staleAtRecord: true`, a claimNote and a review prompt. The recorded `submittedAt` is shown against the user deadline.
- **Formal notices (D143.3; DA-A-9).** R03's `requiredChannel` is `postal_mail` unless the fact `card.billing_rights_electronic_designated` is confirmed with evidence from the issuer's billing-rights statement (Reg Z comment 13(b)-2). In that case it is the designated channel. **There is no merchant-contact-first gate** (comment 13(a)(3)-3). Merchant outreach is `purpose: "informal"`.
- **Case mode `track_automatic` (DA-A-25; M22/M24)** is set when the refund is automatic by regulation (R02.a with the carrier as merchant of record; R04.a). There is no packet. The next action follows the counterparty deadline: `track` → overdue → `escalate` (`request_refund` packet or a DOT complaint link). A ticket agent as merchant of record → `caseMode: "request"`, next action `request_refund` (D143.2).
- **Attachments:** none in Phase-1 email (HC-18). Deterministic letter templates for R02–R05. Reminders stay reminder-only; the delay comes from the pack's `responseExpectation` or the 7-day floor.

---

## 7. Intake

Pipeline: channel → `processedEvents` (existing dedupe) → **masked** evidence → candidate facts / needs_review transaction → confirmation → active transaction → evaluation.

- **Masking first (D142, M13):** `inbound.onMessageReceived` masks before the payload insert, and `intake.paste` masks before hashing.
- **Wave 1 (M13):**
  - `applyOrder` creates the needs_review purchase, calls `ensurePurchaseTransaction` and writes an evidence row.
  - **Currency:** an unclear currency becomes a `retail.currency` candidate plus a summary. `purchases.confirm` gains `currency?`, and changing it is refused once a claim exists. Confirming writes a `retail.currency` `user_confirmed` fact (M11).
  - `applyRefund` refuses a foreign-currency credit (HC-10).
  - `provenance` + SEC-AI-6.
- **Reply currency (DA-A-19; wave 2, M28).** The `ReplyClass` schema returns `promised: { value: decimal string, currency } | null`. The currency must equal `claimCurrency`, or the reply goes to `needs_review` with no ledger write. Parsing uses `parseDecimalToMinor` (with the 2-decimal carve-out for legacy claims). **S-M03-6 (M13, wave 1):** `sameParty(null, x)` returns `false`, and the UI labels the sender as unverified.
- **Second-stage classifier and doc schemas (wave 2, M23).** Amounts are decimal strings and every field carries `{ value, quote }` (SEC-SD-1: no PAN/CVV/expiry/routing/password fields). A statement yields one candidate per line (SEC-AI-5), and **the card-charge natural key includes a per-line identity** (reference number, or `evidenceId` + line ordinal) so two identical duplicate-charge lines stay two transactions (DA-A-30).
- **Manual entry (wave 2):** `transactions.createManual` writes `user_confirmed` facts, labelled "your entry" (SEC-MF-4).
- **Uploads:** §2.6. Wave 1 is store-only (`not_requested`/`store_only`/`awaiting_doc_type`). Wave 2 adds extraction, still behind the live-extraction flag (D145).
- **Dedupe (owner-scoped):**
  - evidence on `(userId, contentHash)`, active rows only;
  - AgentMail event id + `sourceMessageId`;
  - paste on `paste:<userId>:<sha>`;
  - transactions on `(userId, naturalKey)`;
  - retail keeps D22.

---

## 8. Migration and compatibility

- **Schema:** additive per wave. `quoteStatus`, `requiredChannel`, `obligor` and `engineVersion` land in wave 1, so no widening from boolean to union is ever needed.
- **Linking is lazy and mandatory** in `evaluateTransaction` (DA-A-3, O4 reversed). The optional `migrations.linkLegacyPurchases` (paged, `opsState` cursor, idempotent) only brings Potential completeness forward.
- **R01 fallback:** the legacy path runs until R01 v1 is active (§2.8), so deploying or reverting before activation is behaviour-neutral.
- **Deploy order:** backend (schema + functions) → optional migration → frontend. The lead regenerates `_generated` at wave close (D92).
- **Rollback limits:**
  - (a) Widened literals, once written, block redeploying the old schema.
  - (b) An item-less scenario claim makes rolling back to pre-wave-2 functions unsafe.
  - (c) Blobs and evidence persist until purged.
  - (d) Old pack and engine versions must stay in the tree to explain historical evaluations.
  - (e) Version bumps are not undone.
- **Account lifecycle (M14):**
  - every new table goes into `EXPORT_TABLES`/`TABLE_SPECS`/`PURGE_STEPS`, child-first: `submissions, packets, nonCashRemedies, evaluations, opportunities, facts, incidents` before `claims`; `evidence` (blob then row in one mutation) and `transactions` before `profiles`;
  - the SEC-DEL-1 reflective test;
  - the export carries no storage URL;
  - `BLOB_REFERENCES`.
- **Retention (M14):**
  - evidence per §2.6;
  - evaluations older than 90 days that are neither an opportunity's `currentEvaluationId`, nor referenced by any `drafts.binding`/`packets.binding`, nor belonging to an opportunity with any claim (`claims.by_opportunity`) are pruned, bounded and resumable (DA-A-32);
  - ledger, claims, drafts, replies, purchases and facts are never pruned.
- **Regression suites** stay green, **unmodified** except for M04 fixture-clock fixes:
  - convex: claims, drafts, replies, followUps, priceWatch, purchases (incl. :387–407), intake, inbound, policies, examples, watches, offers, market, tracking, insights, dashboard, freshness, readBudget, fairness, lifecycle, account, retention, boundary, http, mailEvents, notify, lib/* (incl. `lib/ledger.test.ts:198–202`);
  - the e2e suites.

---

## 9. Information architecture

- **Routes kept:** `/`, `/watching`, `/purchases/:id`, `/claims/:id`, `/settings` and `/privacy`. Returns-first navigation stays retired.
- **Routes added (wave 2, M24 owns `App.tsx`):** `/add` (intake hub: forward/paste, upload with **a required doc-type picker**, manual entry by category), `/transactions/:id` (a retail order redirects to `/purchases/:purchaseId`, which gains the same sections), and `/opportunities`.
- **Transaction page sections:**
  - confirmed facts / needs confirmation;
  - incidents;
  - **opportunity cards (active packs only)**;
  - **"Paths not checked / source not verified"** (from `coverage.ts`, no amounts);
  - evidence (previews per §2.6, a "Keep this email" pin, the retention date shown).
- **Opportunity card:**
  - authority badge;
  - an amount only when an estimate exists; the cap is shown as a "limit" (R04: "minimum liability limit a carrier may set — not a payout", D143.4);
  - cash / non-cash / provisional;
  - outcome + deterministic explanation;
  - assumptions ("changes the answer if…");
  - decisive missing facts only (DA-A-24);
  - user deadlines with basis and countdown on the client clock;
  - counterparty deadlines as "carrier owes by X / overdue since Y";
  - `advisoryActBy` labelled "conservative act-by (not the legal deadline)";
  - source + version + effective date or "unknown", with **disclosed source conflicts** (D143.2 "20 business days" note);
  - related paths;
  - one next action.
- **Questions UI:** decisive facts only, "why we ask", sensitive-key explanations, "I don't know", corrections. Identifiers are validated per scheme.
- **Packet review:**
  - summary, timeline, evidence index;
  - recipient with its provenance;
  - the editable letter plus the SEC-AI-4 flags;
  - instructions per channel;
  - the approve → print/copy → "Record that I submitted it" flow, with the stale-at-record note;
  - labels: Prepared / "You recorded submitting it on…" / Sent by Recoup.
- **Tracking mode:** a status card with no packet; escalation appears when the case is overdue.
- **Dashboard (M15, wave 1):** tiles from `recovery.summary` per currency: Recovered, Over-credit, Potential, Ready to ask, Sending or unknown, Asked, Promised, "of which provisional", Non-cash. Charts are **per currency** (QA-2). `tracking.overview` money fields are no longer shown (DA-A-34). Strips: "Needs your answers" and "Deadlines this week" (user-obligor only).
- **Resilience (§14; M24 implements, M25 tests):**
  - offline/reconnect on `/add` and `/transactions`;
  - session expiry mid-upload (401 → re-auth → retry once);
  - provider outage (extraction `failed` state with retry);
  - source-unverified and stale copy;
  - direct-route refresh;
  - unknown and foreign ids;
  - empty states and partial extraction;
  - live-extraction-disabled messaging.

---

## 10. Acceptance criteria ("fixture" = expected values written by hand, never produced by the code under test)

**Common (every active evaluator):**
- M02's fixture categories pass unchanged through M08's loader, with `likely_eligible_missing_evidence` mapped to `likely_eligible`.
- Evaluating twice gives one evaluation row.
- 30 alternating price observations give a bounded number of evaluation rows (DA-A-32).
- Foreign ids on every public function get an identical not-found.
- There is no `lib/ai` import under `lib/rules`.
- The production registry never returns a non-active pack.
- A coverage row cannot come from a test pack.
- Staleness fixtures `R0x-10/11` → `source_unverified`.

**Wave-1 regression tests named for the DA findings** (they must fail on the rev-3 design, per checkpoint B):

| Finding | Test (file · name) | Task |
|---|---|---|
| DA-A-1 | `lib/facts/resolve.test.ts` · "confirmed user_unknown → user_unknown", "candidate then user_unknown → user_unknown", "user_unknown then observed → observed", "confirmed value then user_unknown → user_unknown", "a known cell never carries user_unknown" | M11 |
| DA-A-2 | `r01Parity.test.ts` · "unconfirmed policy + qualifying drop → exactly one claim" **run in both modes (rev 5, C3)**; `lib/rules/outcome.test.ts` · "only assumption-class unknowns → likely_eligible" | M12, M16 |
| DA-A-3 | `opportunities.test.ts` · "legacy open claim + evaluation → Potential 0, claim linked, no second claim, recordCheck returns normally" (v1 forced active through the C3 seam) | M12, M16 |
| DA-A-4 | `recovery.test.ts` · "one 120 receipt under two remedies counts 120 once" (SEC-MF-2), "undeclared intersection → second openCase refused", "R01 + order-level loss on one order → Σ ≤ paid", "two credits for one loss → Recovered = loss, excess on the over-credit line" | M12, M16 |
| DA-A-5 | `lib/deadlines/engine.test.ts` · "counterparty deadline + 1 day → overdue, outcome unchanged, nextAction escalate", "unknown payment class selects no timer and does not produce needs_facts" | M12 |
| DA-A-7 | `retention.test.ts` · "forwarded order, no case → text cleared at 30 days, quotes and headers kept", "with a claim → kept", "pinned → kept"; `src/pages/Privacy.test.tsx` · "copy renders every privacyFacts constant" | M14, M15 |
| DA-A-8 | `evidence.test.ts` · "no doc type → awaiting_doc_type, never extracted", "declared card_statement → store_only" | M13 |
| DA-A-9 | `lib/claimState.test.ts` · "requiredChannel postal + informal email sent → not submitted; day 61 → expired" | M10 |
| DA-A-11 | `lib/rules/registry.test.ts` · "production registry returns only activation.ts actives", "testRegistry importable only from *.test.ts" | M12 |
| DA-A-13 | `r01Parity.test.ts` · "GBP purchase + GBP observation → claim", "GBP + USD observation → rejected" (both modes, C3) | M12, M16 |
| DA-A-14 | `drafts.test.ts` (new cases only) · "prepareSend after a rule-version change → ok:false, version bumped, note written, no outbound, no charge" | M13 |
| DA-A-15 | `lib/facts/snapshot.test.ts` · "same value re-confirmed → same hash", "anchor changed → bump"; **`opportunities.test.ts` · "12 checks at 12 different prices on an open R01 case → 0 version bumps, 0 invalidated drafts"; "a corrected unit price → bump"** (rev 5, C2) | M11, M12, M13 |
| DA-A-16 | `claims.test.ts` (new cases) · "finalize retried → one release + one confirm", "confirmCredit with provisional outstanding → refused", grep "only claims.ts writes confirmed_credit" | M10 |
| DA-A-17 | `recovery.test.ts` · property "Σ tiles = Σ outstanding" per currency; "unknown send appears in Sending or unknown"; **property "every component with an open member is in exactly one tile" over the C4 generator; "return claim 4,000 + promise 1,500 + confirmed 1,500 → 2,500 in Ready"** (rev 5, C4) | M12, M16 |
| DA-A-21 | `drafts.test.ts` (new cases) · **"linked claim, windowEndsAt + 1 min → window_may_have_passed; with acknowledgment → sends; no version bump; no new draft required"**, "unlinked claim → the same"; M1C **R01-05c** (auto-open closed past the window) and **R01-05d** through M08's loader (rev 5, C1) | M12, M13 |
| D142 | `lib/pan.test.ts` · test PANs masked (16-digit Visa, Mastercard, Amex 15, 19-digit Visa); **Luhn-valid keep-samples unchanged: `352099001761481`, `4221234567897`, `112-3456789-1234562`, `4006381333932`**; a test asserting each keep-sample is Luhn-valid (rev 5, C5); `facts.test.ts` · "putFact masks text, never refuses" | M10, M11, M13 |
| N2 (rev 5) | `drafts.test.ts` · "prepareSend on a foreign draft → identical not-found, nothing written"; "61st call in a minute → rate_limited"; "unlinked late send round-trips with acknowledgment"; "example claim → example_claim before any evaluation" | M13 |
| N3 (rev 5) | `opportunities.test.ts` · "activate → link → deactivate (test registry) → first prepareSend returns rule_withdrawn, supersedes the opportunity, bumps the version once; re-prepare under the legacy path → sendable" | M12, M13 |
| N5 (rev 5) | `claims.test.ts` · "provisional 4,000 outstanding + confirmCredit 1,000 without the flag → ProvisionalOutstanding, nothing written"; "with separateFromProvisional → recorded, provisional still 4,000"; "finalize path unchanged" | M10, M16 |
| N6 (rev 5) | `drafts.test.ts` · "edit a legacy item's unitCents after approval → the binding's evaluation still shows the approved values"; `lib/facts/snapshot.test.ts` · "boundFactValues are canonical and bounded ≤ 32" | M11, M12, M13 |
| N7 (rev 5) | `r01Parity.test.ts` · "a later confirmed snapshot with a different windowDays → v1 uses it (same as legacy) with assumption A-T2" (both modes) | M12, M16 |

**Core financial fixtures (mission §17, M16, through public mutations):**
- expected 4,000 / promise 4,000 → unresolved 4,000 → confirm 1,500 → 2,500 → confirm 2,500 → 0;
- a later debit of 1,000 reopens only that claim;
- provisional 2,000 → in "of which provisional", Recovered unchanged; finalize → Recovered +2,000; reversal → provisional 0;
- alternatives of 3,000 and 2,500 on one loss → Potential 3,000;
- USD and EUR → separate rows;
- a non-cash voucher → count only;
- foreign-currency refund email → refused;
- 2 units at 12,000 with an eligible 9,500 → 5,000.

**R01 (wave 1):**
- parity: the unmodified legacy suites pass; claim-opening is identical to `5cc326d` for the legacy tier;
- 2 × 12,000 → 9,500 → estimate 5,000, formula `(12,000 − 9,500) × 2`, one claim;
- wrong variant, currency, range or confidence → no claim;
- unconfirmed policy → `likely_eligible` with the assumption, **still opens** (DA-A-2);
- no policy or no window → `source_unverified`, no claim;
- window + 1 minute → `window_may_have_passed` (acknowledgeable), identical for linked and unlinked claims, no version bump; auto-open stays closed past the window (rev 5, C1);
- v1 uses exactly `latestPolicy()`'s snapshot (rev 5, N7);
- every R01 test runs in both modes; the full suite is re-run at the activation commit (rev 5, C3);
- a settled 5,000 followed by a deeper drop → only the remainder (new loss key n+1);
- ShopSavvy data and unconfirmed offers never change the outcome;
- R01 v1 inactive → the legacy path opens exactly the claims it opens today (fallback test).

**R02 (wave 2; D143.2):**
- Significance is any M02-cited §260.2 criterion: departure or arrival ±3h/±6h (domestic/international), a different airport, an added connection, a downgrade, or a disability-related criterion. **The disability criteria are asked only when decisive** (DA-A-24).
- A cancellation with a confirmed 4-hour change → no disability question and no time-zone question.
- Accepted alternative → `not_eligible`; "I don't know" → `needs_facts` (DA-A-1).
- A renumbered-only change → `manual_review`.
- Merchant of record: carrier → `track_automatic`, counterparty timer 7 business days (credit card) / 20 calendar days (cash, check, debit, other) with the DOT "20 business days" wording shown as a disclosed conflict. An unknown payment class → timer `unknown_anchor`, outcome unaffected. Ticket agent → `request_refund` (399.80(l)).
- Carrier deadline + 1 day → `overdue`, next action `escalate`.
- A one-hour delay with no other qualifying event → no cash opportunity.
- A voucher recorded through `recordNonCashResolution` → the acceptance fact is written and the case is closed-for-ask.
- Browser flow: intake → confirm → track → overdue → escalate packet → record → promise → confirm funds → dashboard.

**R04 (wave 2; D143.4, amended by D147(1)):**
- Documented expense lines of 3,000 + 2,000 → estimate 5,000 (`documented_total`). **$4,700 is shown only as the carrier's minimum liability limit**, never as an estimate.
- Unreceipted lines are excluded.
- The bag-fee path is separate; one expense line cannot sit in two active cases.
- The bag-fee refund has no stated day count (no counterparty timer).
- **Path a, the checked-bag fee refund (14 CFR 260.5), may reach `eligible`** once its decisive facts are confirmed (`user_confirmed`, or observed/derived from confirmed facts: fee paid, bag significantly delayed or lost, Mishandled Baggage Report filed). The refund is a regulatory duty conditioned on the report, independent of the uncaptured carrier contract deadlines (D147(1)). Extracted candidates still cap it at `likely_eligible` (D147(2)). Fixture: "all decisive fee-path facts confirmed → `eligible`".
- **The property-loss and incidental-expense paths only** are capped at `likely_eligible` (assumption-class "carrier contract deadlines not captured"). Fixture: "same confirmed facts on the expense path → `likely_eligible` with that assumption".
- The international expense path → `unsupported`.

**R05 (wave 2):**
- M02 fixtures R05-01…12 pass.
- Promised ship-by missed with no consent → eligible or likely eligible. Estimate = the order total paid.
- No stated time → the 30-day default (50-day when the seller applies for credit) as params citing §435.1.
- Shipment date and delivery date are separate keys, and swapping them changes the outcome.
- Consent → not eligible until the consented date.
- Post-shipment non-delivery ≠ the MITOR remedy.

**R03 (wave 2; D143.3):**
- credit card + error type + first statement transmittal confirmed → user deadline "received by anchor + 60 days";
- unknown anchor → `needs_facts` + `advisoryActBy` (posting date + 60, labelled), `dueAt` undefined;
- `requiredChannel` postal unless electronic designation is confirmed;
- an informal merchant email leaves the claim "not submitted" and the deadline strip stays; day 61 without a postal submission → expired;
- debit card → `unsupported` (R13 not yet);
- no merchant-first gate;
- record after drift → succeeds with `staleAtRecord`;
- two identical duplicate-charge lines → two transactions (DA-A-30);
- letter template snapshot + the SEC-AI-4 validator.

**iPhone case (mission §12):**
- Every path from rev 3 is either evaluated (R01; R05 and R03 only when they apply) or listed under "Paths not checked" with its reason (R06/R07/R08: exact guide needed; R10; R11 without asking for a serial; R23; trade-in; carrier promotion).
- No digital-content path appears.
- Only decisive questions are asked.
- Potential equals the R01 estimate exactly, or 0.

---

## 11. Implementation tasks

**Rules for all tasks:**
- A task's required tests **include every row of the §10 regression table that names it**, plus what its row lists here.
- Owner files are exclusive within a wave (§11.4).
- Every task lands its named tests.
- Commits use a pathspec.
- The lead regenerates `_generated` and owns `docs/team/**`, `convex/lib/rules/activation.ts` and `convex/lib/rules/verification.ts`.
- **Tasks already running:** **M08** (`opus-qa-engineer`) owns the test infrastructure and CI:
  - the QA-13 DOM environment and `*.test.tsx` include;
  - the rule-fixture loader (manifest hash + aliases);
  - `twoUsers`/clock-pin helpers;
  - CI tightening: lint 0, test floor, e2e typecheck, env-driven e2e fixtures (QA-9).

  M08 owns `vitest.config.mts`, `package.json`/lockfile, `convex/test.setup.ts`, `convex/testing/**`, `src/test/**`, `.github/workflows/ci.yml`, `scripts/check-test-count.mjs`, `e2e/fixtures.ts` and `playwright.config.ts` **until it lands**. No wave-1 feature task touches them. **M09** (`opus-rules-reviewer`) runs the spec-level review of R01–R05.

### 11.1 Wave 1 — safety foundation + R01 retrofit

| ID | Owner | Only-writer files | Depends on | Required tests (in addition to §10's table) |
|---|---|---|---|---|
| M10 | backend | `convex/schema.ts`, `convex/lib/{money,ledger,balance,claimState,canonical,pan,access}.ts`, `convex/limits.ts`, `convex/claims.ts`, `convex/followUps.ts` (the `isClosedForAsk` call site), `convex/convex.config.ts` (no change expected) (+ tests) | M06 accepted | ledger exhaustive-kind test; `owned*` helpers (`ownedTransaction/Evidence/Fact/Incident/Opportunity/Evaluation/NonCashRemedy`, identical not-found, one read, two-user test each) + `assertSameTransaction`; `parseDecimalToMinor` per-case property tests (DA-A-26); `assertUserAmount` 10^12 refused; `isTwoDecimalCurrency`; provisional/non-cash mutations (idempotency, conflict, foreign claim, currency mismatch); DA-A-9, DA-A-16, D142 rows; **rev 5: C5 (Visa 16/19 only; Luhn-valid keep-samples), N5 (`separateFromProvisional`; the `ProvisionalOutstanding` prompt), N6 schema (`cellStatus`, `boundFactValue`, `evaluations.boundFacts`)**; does **not** touch `lib/rateLimits.ts` (M13 owns the rate-limiter buckets) |
| M11 | backend-2 | `convex/transactions.ts`, `convex/facts.ts`, `convex/lib/facts/{catalog,subject,values,resolve,write,snapshot_retail,legacyRetail,keys_retail,keys_order,keys_air,keys_card}.ts`, `convex/purchases.ts` (ensure + `confirm.currency` + the `isClosedForAsk` call site), `convex/watches.ts` (`markBought` → ensure), `convex/examples.ts` (ensure + `isExample` copy) (+ tests) | M10 | DA-A-1, DA-A-15, DA-A-33 (legacy assumed-USD currency ≠ confirmed), DA-A-35 (every `insert("purchases"` site calls ensure; `markBought` → transaction exists), DA-A-36 (the 1,001st correction is accepted; an unchanged observation patches), DA-A-29 (a fact citing evidence from another transaction is refused), grep "only lib/facts/write.ts inserts facts", putFact masking (D142); unchanged `purchases.test.ts`; **rev 5 N6: `boundFactValues(snapshot, keys)` in `lib/facts/snapshot_retail.ts` returns canonical (subjectKey, key, status, value) rows, ≤ 32** |
| M12 | backend-3 | `convex/lib/rules/{types,outcome,conditions,registry,testRegistry,coverage,applicable,r01_price_adjustment_v1}.ts`, `convex/lib/deadlines/{engine,calendar,usFederalHolidays,usZones}.ts`, `convex/opportunities.ts`, `convex/recovery.ts`, `convex/migrations.ts`, `convex/priceWatch.ts` (retrofit + legacy fallback + **S-M03-3**: the target name moves into the user message as a delimited, JSON-escaped field, `SYSTEM` stays constant) (+ tests) | M10, M11, M09 (R01 spec approved), M1C (R01 fixtures) | DA-A-2, 3, 4, 5, 11, 13, 17 rows; `deriveOutcome` precedence table incl. the assumption-only row; deadline engine (calendar/business days, inclusive/exclusive, DST 2026-03-08 and 2026-11-01, unknown/disputed anchor, beyond_calendar, counterparty overdue, advisory act-by); decisive-missing (DA-A-24: an `any` group already passed lists nothing); DA-A-29 ("a foreign or client-supplied relatedTransactionId is refused; the overlap guard reads only the user's claims"); DA-A-32 (subject-scoped evaluation, bounded rows at 50 items under `transactionLimits`); DA-A-22 test stub prepared for wave 2; DA-A-34 ("recovery.summary sums every claim", A.7 inverted against the summary); SEC-AI-1 static test (every `extract()` call site passes a constant `system`); R01 v1 legacy-fallback test; **rev 5:**
- C1: R01 v1's window spec carries `lateAskAcknowledgeable`; the window closing is not material; auto-open is closed past the window (R01-05c);
- C2: the R01 v1 bound-fact list; 12 checks at 12 prices → 0 bumps; a corrected unit price → bump;
- C3: every R01 test in both modes through the `vi.mock` registry seam;
- C4: `ready` is the catch-all, with the exhaustiveness property;
- N3: activation withdrawal is material;
- N6: `evaluations.boundFacts` written; `resultHash` includes `boundFactsHash`;
- N7: `latestPolicy()` snapshot + A-T2;
- wave-2 note: the retail paid-total cap uses a confirmed `retail.order_total` when present, else item totals with `paidTotalPartial` |
| M13 | ingestion-integrations | `convex/evidence.ts`, `convex/http.ts` (upload/download/OPTIONS), `convex/lib/sniff.ts`, `convex/intake.ts`, `convex/inbound.ts`, `convex/lib/schemas.ts`, `convex/drafts.ts` (binding, `prepareSend`, `approveAndSend` hash/ack check, S-M03-1/4/5, `resendAfterUnknown` with full checks, SEC-AI-4 validator for the R01 draft), `convex/mail.ts`, `convex/notify.ts` (S-M03-1 for alerts), `convex/replies.ts` (S-M03-6 only), `convex/lib/rateLimits.ts` (rev 5: the `evidenceUpload`, `evidenceDownload` and `prepareSend` buckets, using M10's constants) (+ tests) | M10, M11, M12 (evaluation helper), M1B (flags) | the rev-3 security tests (SEC-UP-1/2/3/5/6, SEC-SD-2 fixture, A.1/A.2 inverted); DA-A-8, DA-A-14, DA-A-21 rows; DA-A-20 ("upload → content_deleted → re-upload → active row with content"); DA-A-27 ("finalize stores 64-hex"); DA-A-28a ("UTF-8 filename round-trips"), 28c (localhost refused on a non-dev `CONVEX_SITE_URL`), 28e (HEIC → never sent to the model), 28f (quota charged from `_storage.size`); DA-A-31 ("resend after a material change → refused"); SEC-AI-6 ("a spoofed 'refund issued $500' to the inbox → unverified_sender candidate, no ledger promise"); S-M03-4/5/6 repros inverted; SEC-AI-4 ("an unknown email/URL in the generated body blocks approval"); **rev 5:**
- C1: `window_may_have_passed` for linked claims; with acknowledgment → sends, no bump, no new draft;
- C2: the binding at `drafts.insert` uses the R01 v1 bound-fact list, never the live price;
- N2: check order, the `prepareSend` limiter, the unlinked-claim hash;
- N3: `rule_withdrawn`;
- N6: the binding's evaluation shows the approved values after a legacy item edit |
| M14 | backend | `convex/account.ts`, `convex/retention.ts`, `convex/crons.ts`, `convex/lib/blobRefs.ts`, `convex/lib/privacyFacts.ts` (+ tests) | M10 | DA-A-7 retention rows; SEC-DEL-1 reflective test (`EXPORT_EXEMPT`: `usage`); SEC-DEL-2/3 (blob then row in one mutation; no URL in the export); orphan sweep (a referenced blob is never deleted; an unregistered `_storage` field fails the test); DA-A-32 evaluation pruning (bounded; never prunes current, bound or case-linked rows); DA-A-20 retention side |
| M15 | frontend | `src/components/opportunity/{OpportunityCard,Questions,AuthorityBadge,DeadlineLine,CoverageList}.tsx`, `src/components/purchase/ItemTracker.tsx`, `src/lib/money.ts`, `src/components/dashboard/{StatCards,model}.tsx/.ts`, `src/components/claim/Composer.tsx` (prepareSend + window acknowledgment), `src/pages/Privacy.tsx` (DA-A-7 + D142 disclosure), `src/App.tsx` (no change) | M08 (DOM env), M12/M13/M14 queries | component tests (`*.test.tsx`, counted only once M08 lands): every card outcome, unknown deadline, cap shown as a limit, counterparty "overdue" copy, advisory act-by label, no amount without an estimate; `model.test.ts` "mixed currencies → separate series, never summed" (QA-2); DA-A-34 "StatCards renders money only from recovery.summary, never from tracking.overview totals"; Privacy copy test; axe on Purchase, Board and Privacy; the existing e2e purchases/claims specs |
| M16 | qa | `convex/ledgerFixtures.test.ts`, `convex/r01Parity.test.ts`, `convex/isolationM1.test.ts`, `convex/concurrencyM1.test.ts`, `convex/testing.ts` (seeders for transactions/evidence/opportunities, incl. a synthetic PAN), `e2e/r01-opportunity.spec.ts`, `docs/reviews/…-wave1-qa.md` | M10–M15, M08 | independent core financial fixtures; R01 parity against `5cc326d`; two-user isolation for every new public function; **§17 concurrency tests, each with its read-set argument written in the file header** (convex-test serializes, so each test proves the conflict set): CT-1 concurrent `openCase` → one claim; CT-2 manual re-evaluate vs cron `recordCheck` on one item → one claim, one row per resultHash; CT-3 concurrent `ensurePurchaseTransaction` → one row; CT-4 credit confirmation vs `followUps.fire` → the reminder is a no-op; CT-5 activation change (test registry) during approval → prepareSend refuses and persists; CT-6 approval invalidation vs `approveAndSend` → the send refuses; **rev 5: C3 (r01Parity, DA-A-2/3/13 and N7 tests parameterized over {legacy fallback, v1 forced active}); C4 (an independent tile-exhaustiveness property test over the full status × delivery × promised × provisional generator); N5 through public mutations**; a browser run of watch → buy → drop → card → claim → prepare → acknowledge → confirm credit → dashboard |
| M17 | devils-advocate | `docs/reviews/…-da-checkpoint-B.md` | M10–M1C | checkpoint B: each high finding's test fails on rev 3 and passes on the implementation |
| M18 | opus-rules-reviewer | `docs/reviews/…-pack-review-R01-v1.md` | M09, M12, M1C | the R01 v1 code pack matches the M09-approved spec, every param cites a passage id, all R01 fixtures pass unchanged through M08's loader → the lead records activation (DECISIONS + `activation.ts`) |
| M19 | qa-2 | `scripts/check-rule-packs.mjs` (new: manifest ↔ activation ↔ DECISIONS consistency; pack-file immutability for status ≥ reviewed; `ENGINE_VERSION` check stubbed until M20), `scripts/verify-rule-sources.mjs` (new: on-demand; fetches pinned `sources[].url`s where permitted, compares sha256 with `manifest.json`, writes `docs/rules/review-items/*.md` on drift or failure, never edits logic, prints the manual-verification list for 403 sites) | M08 landed. The `ci.yml` step (`check-rule-packs` on every run; `verify-rule-sources` never in CI) is added by M08 if it is still open, otherwise by the lead as shared-CI owner (D144) | script unit tests on fixture manifests: drift → a review item; unchanged → no output; an edited reviewed pack file → failure |
| M1A | ingestion-integrations-2 | `convex/market.ts`, `convex/lib/shopsavvy.ts` (+ tests) | – | **QA-1**: key set + `success:false`/`data:[]` → `empty_result` (not `not_configured`), no re-charge on the next accepted check |
| M1B | backend-4 | `convex/ops.ts`, `convex/lib/flags.ts` (new), `convex/lib/log.ts` (event names only) (+ tests) | M10 | **P12/C58 diagnostics**: `ops.backlog` reports rule-evaluation failures (per-day `opsState` counters written by `recordEvaluation`'s catch path), stale-source packs (verification vs refresh windows at a coarse `now`), the `live_document_extraction` flag state + `approvalRef`, `awaiting_doc_type`/pending-extraction counts, orphan-sweep and retention cursor age. `ops.setFlag` is internal-only and refuses to enable live extraction without `approvalRef`. Redacted structured logs |
| M1C | opus-rules-researcher | `docs/rules/fixtures/R01.json` (new), `docs/rules/README.md` (rule 3 sentence, §2.7) | M02 | R01 v1 snapshot-tier fixtures written by hand, independently of M12's code: the priceWatch parity cases, unconfirmed policy, GBP carve-out, wrong variant/currency/range/confidence, no window, window boundary, settled + deeper drop, temporal assumptions A-T1/A-T2 |

### 11.2 Wave 2 — Phase-1 slices R05 → R02 → R04 → R03

| ID | Owner | Only-writer files | Depends on | Required tests / specified content |
|---|---|---|---|---|
| M20 | backend | `convex/schema.ts` (wave-2 addendum), `convex/claims.ts` (`insertScenarioClaim`, `recordDenial`, `recordNonCashResolution` (DA-A-18), `get` for item-less claims), `convex/lib/access.ts` (`ownedPacket`, `ownedSubmission`), `convex/packets.ts`, `convex/submissions.ts` (DA-A-10), `convex/lib/packets/common.ts`, `convex/lib/facts/catalog.ts` (merge only), engine files `convex/lib/rules/{types,outcome,conditions,registry,engineVersion}.ts` (DA-A-23 `ENGINE_VERSION`), `scripts/check-rule-packs.mjs` (enable the ENGINE_VERSION check) | wave 1 closed | packet approve/record rules (§6), incl. "approve → ledger event → record succeeds flagged" and "approve → deadline passes → record succeeds, shown against the deadline"; denied transitions; non-cash resolution (a voucher on 40,000 → Asked 0, Non-cash 1, reminders cancelled); an engine change without an `ENGINE_VERSION` bump fails CI; with a bump, approvals are invalidated; **rev 5 N3: `packets.approve`/`submissions.record` on a claim whose pack was withdrawn → `rule_withdrawn` once, then legacy handling; N6: `packets.binding.evaluationId` → evaluation `boundFacts` displayed on the packet** |
| M21 | commerce-payments | `convex/lib/facts/{keys_order,keys_card,snapshot_order,snapshot_card}.ts`, `convex/lib/rules/{r05_late_order_v1,r03_billing_error_v1}.ts`, `convex/lib/packets/{r05_v1,r03_v1}.ts` | M20, M09 (R03/R05 approved), M27 per pack | §10 R05/R03; D143.3 (channel, anchor, advisory act-by, no merchant gate); DA-A-30 per-line key; SEC-AI-4 on templates; DA-A-15 "every interpolated key is bound"; **rev 5 wave-2 note: the `retail.order_total` fact (incl. tax + shipping) in `keys_order.ts`; an R05 order-total estimate is capped by it, not by item totals ("R05 estimate 64,950 on an order total 64,950 with items 60,000 → not capped")** |
| M22 | travel | `convex/lib/facts/{keys_air,snapshot_air}.ts`, `convex/lib/rules/{r02_air_refund_v1,r04_baggage_v1}.ts`, `convex/lib/packets/{r02_v1,r04_v1}.ts` | M20, M09 (R02/R04), M27 | §10 R02/R04; D143.2/D143.4 as amended by **D147(1)** (R04 path a, the bag-fee refund under 14 CFR 260.5, may reach `eligible` with confirmed decisive facts; the `likely_eligible` cap covers only the property-loss and incidental-expense paths — tests: "fee path, all decisive facts confirmed → eligible", "expense path, same facts → likely_eligible + assumption", "fee path with an extracted-candidate report date → likely_eligible"); DA-A-24 (no disability/time-zone question on a confirmed 4-hour cancellation change); DA-A-25 (`track_automatic`; overdue → escalate); DA-A-18 R02 voucher acceptance fact |
| M23 | ingestion-integrations | `convex/evidence.ts` (extraction action + flag gate + text-layer pre-scan), `convex/intake.ts` (second-stage classifier), `convex/lib/schemas_docs.ts`, `convex/lib/quote.ts` (DA-A-6 verification), `convex/lib/pdfText.ts` ("use node"; one exact-pinned PDF text-layer library, D145), `package.json`/lockfile (that one dependency; wave-2 owner once M08 releases) | M20, M1B | DA-A-6 ("a correct short quote → verified", "a digit-swapped value → unverified", "image-only → unverifiable, never counts toward evidenceSupports"); DA-A-8 ("PDF declared receipt with a test PAN in its text layer → store_only"); SEC-UP-4 (embedded JS/remote URL not executed; decompression bomb capped); SEC-AI-2/3/5; SEC-DEL-4 ("extraction finishing after requestDeletion writes no facts, leaves no blob"); the live-extraction flag blocks real-user documents |
| M24 | frontend | `src/App.tsx` (routes), `src/pages/{Add,Transaction,Opportunities}.tsx`, `src/pages/Claim.tsx` (`claimCurrency`, packet section, tracking mode), `src/pages/Settings.tsx` (move the paste panel out), `src/lib/evidenceFetch.ts` (DA-A-28b previews), `src/components/shell/nav.tsx`, `src/components/packet/*` | M20–M23 | keyboard-only questions and packet flows; the doc-type picker is required before extraction; previews reject non-image sniffed types; §14 resilience states implemented (§9); axe on the new pages; direct-route refresh; foreign ids |
| M25 | qa | `e2e/{r02,r03,r04,r05}.spec.ts`, `e2e/resilience-m2.spec.ts`, `convex/slicesM2.test.ts`, `convex/concurrencyM2.test.ts`, `docs/reviews/…-wave2-qa.md` | M20–M24, M2C, M28 | the mission §17 browser proof per Phase-1 path; §14 resilience specs (offline/reconnect, a 401 mid-upload → re-auth → retry, provider outage, source unverified, foreign ids, empty/partial extraction); concurrency CT-7 extraction vs account deletion, CT-8 duplicate webhook + intake, CT-9 concurrent `submissions.record`, CT-10 duplicate outbound send (each with its read-set argument) |
| M26 | devils-advocate | checkpoint C | M25 | per-slice adversarial review |
| M27 | opus-rules-reviewer | `docs/reviews/…-pack-review-R02-R05.md` | M09, M21, M22 | each code pack matches its M09-approved spec and passes the M02 fixtures unchanged → the lead records each activation **before that slice's wave-2 close** |
| M28 | ingestion-integrations | `convex/drafts.ts` (item-less context, `claimCurrency`, `purpose`), `convex/replies.ts` (DA-A-19 currency; scenario-aware prompt; `expectedDomain`), `convex/followUps.ts` (item-less claims; `responseExpectation`), `convex/lib/schemas.ts` (ReplyClass), `convex/inbound.ts` (unchanged unless needed) | M20 | DA-A-12 HC-1 sites compile and are tested; DA-A-19 ("a '€40' reply on a USD claim → no ledger event, needs review") |
| M2C | backend-2 | `convex/tracking.ts` (`isClosedForAsk`; item-less claims; DA-A-34 A.7 inverted on overview), `convex/purchases.ts` (board skips `scenario` claims, per-currency fields added alongside the untouched legacy totals), `convex/insights.ts` (optional ids, `claimCurrency`), `convex/priceWatch.ts` (DA-A-22 denied re-open rule) | M20 | repro A.1 inverted; DA-A-22 ("a denied claim at the same price → no claim; a lower price → a claim for (deniedObserved − new) × qty only"); `purchases.test.ts:387–407` unmodified |
| M29 | backend | `convex/crons.ts` (deadline attention sweep + the evidence-retry sweep entry M23 provides), `convex/deadlines.ts` (new), `convex/ops.ts` (backlog additions) | M20, M21 | **C50 user-obligor deadline attention for R03** (in-app only): a bounded sweep on `by_status_and_next_deadline_at`; re-reads state; skips closed, dismissed, superseded and tombstoned work (SEC-CH-6); "a reminder for a case closed after scheduling is a no-op" |
| M2A | frontend | `src/lib/coverageCopy.ts` (new), `src/pages/SignIn.tsx` (landing copy), `README.md`, `hackathon.md` | M24 | **§20 copy consistency**: every coverage claim in the product copy is derived from `coverage.ts` + RULES-COVERAGE; a copy test fails when any page claims a scenario the production registry does not evaluate ("checks supported recovery paths", never "every right"); no billing copy |

### 11.3 Waves 3–4 — expansion (each with its recorded blocker or scope; nothing becomes a card without an active pack)

| ID | Wave | Owner | Scenario / scope | Recorded blocker (TRIAGE, D145) |
|---|---|---|---|---|
| M30 | 3 | benefits-discovery | R06/R07/R08/R12 for an explicit set of exact card products (never from a network logo) | `needs_exact_guide` until M02 captures each guide version |
| M31 | 3 | travel | R09, R14, R15 (a carrier promise, not law) | M02 specs + M09 review |
| M32 | 3 | benefits-discovery | R11 recall **candidates** only (saferproducts.gov API); a serial is asked only then | a new egress host needs an M03 review |
| M33 | 3 | commerce-payments | R16 subscription evidence assistant (state packs CA/NY/MN; federal status = pre-2024 Negative Option Rule) | per-state specs; `manual_review` until reviewed |
| M34 | 3 | backend | rule-version re-evaluation sweep (C54); `primary_secondary` coordination; cross-claim credit split with `postingRef` (O11) | wave 2 closed |
| M35 | 3 | frontend | coverage page (C57), card-product picker, escalation links | M30–M34 |
| M36 | 3 | qa + DA | per-slice tests; checkpoint D | — |
| M37 | 3 | backend + rules | **R01 v2**: calendar-day / receipt anchors, channel, exclusions, identity match, quantity limit, discretion clause, and reviewed merchant packs (Best Buy/Target/Costco/Apple, M02 §7) with the D143.1 effective-date rule; its own fixtures; excluded from the parity gate | M09-style review + activation |
| M38 | 3 | benefits-discovery | **R10** warranty assistant: identifies the governing written warranty + the covered defect; state implied-warranty law not evaluated | Magnuson-Moss / 16 CFR 700–703 not yet captured (M02) |
| M39 | 3 | commerce-payments | **R13** Reg E: payment-type classifier first; notice within 60 days of statement transmittal; provisional credit uses the ledger's provisional kinds; wires/checks → `unsupported` | M02 spec (ready_for_spec) + review |
| M3A | 3 | benefits-discovery | **R18** vehicle recall **candidate** (NHTSA make/model/year; never a confirmed VIN match); **lemon law explicitly deferred** | VIN lookup blocked to non-browser clients; lemon law `defer` |
| M40 | 4 | commerce-payments | **R19** assisted routing: undelivered services paid by credit card → R03; ticketing-platform terms | `defer`: no general federal event-refund rule; platform terms not captured |
| M41 | 4 | travel | **R20** Hilton price-match pack only; **the guest must file** (third-party preparation restricted) → a user-filed packet | others `source_blocked` (Hyatt 403, Marriott 404, IHG unverified) |
| M42 | 4 | ingestion-integrations | **R21** outage/appointment credits | `blocked_source`: no first-party source; PUC/provider-specific |
| M43 | 4 | benefits-discovery | **R22** FTC refund-program registry (per-program verification; never submit an attestation; impersonation warning shown) | per-program pages must be verified |
| M44 | 4 | benefits-discovery | **R23** class settlements | `blocked_source`: no central registry |
| M45 | 4 | benefits-discovery | **R24** unclaimed property (links to state offices only; a name match ≠ ownership) | `explicitly_deferred_by_scope` pending lead scope |
| M46 | 4 | — | **R25** small-business guarantees | `explicitly_deferred_by_scope`: not a consumer rule |
| — | — | — | **R17** | `blocked_privacy_review`; synthetic fixtures only (mission §11) |

### 11.4 One-writer-per-file (wave 1) and ownership notes

- **Wave 1 single owners:**
  - M10: `convex/schema.ts`, `convex/convex.config.ts`, `convex/limits.ts`
  - M13: `convex/http.ts`
  - M08 until it lands, then nobody in wave 1: `package.json`/lockfile, `vitest.config.mts`, `ci.yml`
  - M15: `src/App.tsx`
  - M14: `convex/crons.ts`
  - lead: `activation.ts`, `verification.ts`
  - M11: `purchases.ts`, `watches.ts`, `examples.ts`
  - M12: `priceWatch.ts`
  - M13: `drafts.ts`, `replies.ts`, `inbound.ts`, `intake.ts`
  - M1A: `market.ts`
  - M1B: `ops.ts`
  - no file appears in two wave-1 rows.
- **Wave 2 single owners:**
  - M20: `schema.ts`, `claims.ts`, `access.ts`, the engine files
  - M24: `App.tsx`
  - M29: `crons.ts`
  - M28: `drafts.ts`, `replies.ts`, `followUps.ts`, `lib/schemas.ts`
  - M2C: `tracking.ts`, `purchases.ts`, `insights.ts`, `priceWatch.ts`
  - M23: `evidence.ts`, `intake.ts`, and `package.json` once M08 has landed
  - M29: `ops.ts`
  - M13 and M1B release their files at wave-1 close.
- **Connection map (mission §18, CONNECTIONS.md rows, lead-owned):**

  | Rows | Tasks |
  |---|---|
  | C37 | M13 / M23 |
  | C38 | M11 |
  | C39 | M11 / M22 |
  | C40 | M1C / M19 / M18 / M27 |
  | C41 | M12 |
  | C42 | M12 |
  | C43 | M11 / M15 / M24 |
  | C44 | M15 |
  | C45 | M12 |
  | C46 | M12 |
  | C47 | M20 / M21 / M22 |
  | C48 | M13 / M20 |
  | C49 | M13 / M20 |
  | C50 | M29 |
  | C51 | M30 |
  | C52 | M32 / M3A |
  | C53 | M19 + lead |
  | C54 | M34 |
  | C55 | M10 / M12 |
  | C56 | M14 |
  | C57 | M12 / M2A / M35 |
  | C58 | M1B / M29 |

---

## 12. Open decisions (status after D145) and risks

| # | Decision | Status |
|---|---|---|
| O1 | R01 auto-open | **Agreed** (D145), with DA-A-2/3/22 |
| O2 | One facts table + runtime catalogue | **Agreed** (+ a grep test for the single writer) |
| O3 | Widen `purchaseId`/`itemId` in wave 2 | **Agreed**, with the corrected §2.3 and the M28/M2C owners |
| O4 | Legacy linking | **Reversed**: lazy **and** mandatory |
| O5 | Extraction | **Agreed**. A PDF text layer is approved for wave 2. **Live extraction of real users' documents needs the user's explicit data-flow approval** (D145) |
| O6 | USD for new scenarios | **Agreed**, plus the R01 2-decimal carve-out |
| O7 | Only `denied` persisted | **Agreed** (+ `nonCashResolvedAt` as a field, not a status) |
| O8 | Non-cash table; provisional ledger kinds | **Agreed**, with DA-A-16/18 |
| O9 | Recovered | Unclamped per component with a visible over-credit line in `recovery.summary`; board untouched (D145) |
| O10–O13 | — | **Agreed** |
| O14 | Closed-window send | **Warn + acknowledge**, identical for linked and unlinked claims, until R01 v2 (D145) |
| O15 | 24 h multiples in R01 v1 | **Agreed** for parity; R01 v2 is M37 |
| O16 | httpAction upload | **Agreed**, with DA-A-8/20/27/28 |

**Remaining items for the lead:**
- **(R4-1)** Record the D83(5) wording amendment (§2.6).
- **(R4-2)** Ask M02 to add the §2.7 sentence to README rule 3, which reconciles the R01 v1 snapshot-tier freshness.
- **(R4-3)** Confirm M1C (R01 fixtures by the researcher) as a wave-1 task.
- **(R4-4)** Record when `activation.ts` and `verification.ts` become lead-owned code files.

**Risks:**

| Risk | Mitigation |
|---|---|
| KM1 (high): R01 parity | Fallback path + M16 parity + M1C independent fixtures |
| KM2 (high): ledger widening | Exhaustive switch |
| KM3: version-bump churn | Values-not-ids hashing, subject-scoped evaluation |
| KM4: facts growth | Live-count cap |
| KM5: read budgets | Bounded summary + `complete` |
| KM6 (high): uploads | Rev 2/3 controls + docType gate + flag |
| KM7: rollback after scenario claims | Forward-fix policy |
| KM8: rule immutability | CI scripts + lead-owned activation/verification data |
| KM9: catalogue/registry collisions | Stubs in wave 1 |
| KM10 (high): an unreviewed source or failed activation leaves a slice at "not checked" | Honest coverage copy (M2A); never marked `implemented_verified` |
| KM11 (new): wave-1 close depends on M09 → M1C → M12 → M18 → lead activation | The fallback path keeps the deploy safe meanwhile |

---

## 13. Changelogs

### 13.1 Rev 4

| Id | What changed | Section(s) |
|---|---|---|
| DA-A-1 | Resolution order puts `user_unknown` after known states; type guard | §2.5, §10 table, M11 |
| DA-A-2 | Assumption-class facts; `deriveOutcome` assumption-only row; R01 v1 activation in wave 1 (M18) + legacy fallback | §2.4 `missingFact.class`, §2.8, §4, §10, M12/M18 |
| DA-A-3 | Mandatory lazy link in `evaluateTransaction`; `recordCheck` order | §2.8, §8, §10, M12/M16 |
| DA-A-4 | Case-opening default `alternative`; loss-component tiles; per-transaction paid cap; Recovered ≤ loss + over-credit line (D145) | §2.8, §3.3, §3.4, §10, M12 |
| DA-A-5 | `obligor`, counterparty `overdue`, `escalate`; only user deadlines gate | §2.4, §4, §5, §9, §10, M12/M22 |
| DA-A-6 | `quoteStatus` three-valued from wave 1; exact locator + value parse; `unverifiable`; PDF text layer (wave 2) | §2.4, §2.6, M23 |
| DA-A-7 | 30-day evidence rule unless case/pin; Privacy copy from backend constants; D83 amendment | §2.6, §8, §12 R4-1, M14/M15 |
| DA-A-8 | Declared docType before extraction; `awaiting_doc_type`; text-layer pre-scan | §2.4, §2.6, §9, M13/M23/M24 |
| DA-A-9 | `claims.requiredChannel`; channel-scoped delivery projection; informal drafts | §2.4, §3.4, §5, §6, M10/M20/M21 |
| DA-A-10 | Record an approved packet version even after drift (`staleAtRecord`) | §2.4, §6, M20 |
| DA-A-11 | M09 spec review → M18/M27 code-pack review → lead activation (`activation.ts`); production vs test registry; verify script; staleness; no card without an active pack | §2.7, §9, §11 (M18, M19, M27), §12 |
| DA-A-12 | Corrected §2.3(c); silent sites; `drafts`/`tracking`/`purchases` wave-2 owners | §1.2 HC-1, §2.3, M28/M2C |
| DA-A-13 | R01 2-decimal carve-out | §3.1, §10, M10/M12 |
| DA-A-14 | `prepareSend` persists and returns; one `APPROVABLE_OUTCOMES`; no charge | §2.8, §6, M13 |
| DA-A-15 | Hash values, not ids; bound facts = interpolations + amount inputs + anchors | §2.4, §2.5, M11/M12/M21/M22 |
| DA-A-16 | Derived sub-keys; one confirmed-credit writer; `confirmCredit` refuses with provisional outstanding | §3.2, M10 |
| DA-A-17 | Disjoint, exhaustive tiles by furthest state; "of which provisional"; property test | §3.4, §9, M12/M15 |
| DA-A-18 | `recordNonCashResolution`; `nonCashResolvedAt`; R02 acceptance fact | §2.4, §3.2, §5, M20/M22 |
| DA-A-19 | Reply currency extracted and checked | §7, M28 |
| DA-A-20 | Dedupe only against active rows; revive content-deleted rows | §2.6, M13/M14 |
| DA-A-21 | Warn + acknowledge, identical for linked and unlinked claims (D145) | §6, §10, M13/M15 |
| DA-A-22 | No automatic re-ask after a denial unless the price is lower; difference only | §2.8, M2C |
| DA-A-23 | `ENGINE_VERSION`; append-only manifest check | §2.7, M20/M19 |
| DA-A-24 | Decisive-missing combinator; sensitive keys only when decisive | §4, §9, M12/M22 |
| DA-A-25 | `track_automatic`, `track`/`escalate`/`request_refund` | §2.4, §6, M22/M24 |
| DA-A-26 | `parseDecimalToMinor` grammar and sign markers | §3.1, M10 |
| DA-A-27 | Hex normalization at finalize | §2.6, M13 |
| DA-A-28 | Filename encoding, preview type, dev-only CORS, blob registry, HEIC, quota from size | §2.6, M13/M14/M24 |
| DA-A-29 | Same-transaction evidence; server-set related id; userId-filtered guard | §2.3, §2.5, §2.8, M11/M12 |
| DA-A-30 | Per-line card natural key | §7, M21/M23 |
| DA-A-31 | Resend = full checks + acknowledgment | §6, M13 |
| DA-A-32 | Outcome-bearing `resultHash`; subject-scoped evaluation; pruning | §2.4, §4, §8, M12/M14 |
| DA-A-33 | Legacy currency is an assumption unless confirmed | §2.5, M11 |
| DA-A-34 | Summary sums every claim; overview money not shown; overview fixed in wave 2 | §9, M12/M15/M2C |
| DA-A-35 | `isExample` joins and copy; `ensurePurchaseTransaction` at every purchase insert | §2.2, §3.4, M11 |
| DA-A-36 | Live-fact cap; unchanged observation patches | §2.4, §2.5, M11 |
| D142 | Luhn + issuer prefix + brand length + separators; typed identifiers bypass the masker; putFact masks, never refuses; keep/mask tests; component raw copy disclosed | §2.4, §2.5, §2.6, §10, M10/M11/M13/M15 |
| D143.1 | R01 temporal rule (effective date after purchase → `source_unverified`, `ask_anyway`) in the reviewed tier (R01 v2); parity limited to the legacy tier | §2.7, M37 |
| D143.2 | R02: §260.2 criteria, merchant of record, renumbered-only → manual review, timers + disclosed conflict, `request_refund` | §2.4, §4, §6, §10 R02, M22 |
| D143.3 | R03: electronic designation, transmittal anchor, received-by, no merchant gate, advisory act-by | §2.4, §4, §6, §10 R03, M21 |
| D143.4 | R04: $4,700 as a limit only; no bag-fee timer; likely-eligible caps; international unsupported | §9, §10 R04, M22 |
| D143.5 | `.txt` sources; README field map + outcome aliases | §2.4, §2.7 |
| D144 QA-1 / QA-2 / QA-3 / QA-9 / QA-13 | M1A / M15 / M13 (= O14) / M08 / M08 (before M15's tests count) | §11 |
| D145 rulings | O4 reversed; O5 with user approval; O9 per component; O14 warn + acknowledge; cap USD 1M; tasks for review, verify, R01 v2, R10/R13/R18, R19–R25, R03 attention, diagnostics, resilience, concurrency, copy | §2–§12 |
| M03 lows | S-M03-3 → M12; S-M03-4/5/6 → M13; SEC-AI-4 → M13/M21/M22; SEC-AI-6 → M13 | §6, §7, §11 |
| DA omissions 1–12 | Pack review/activation (M18/M27); refresh (M19); later scenarios (§11.3); R01 v2 (M37); C50 (M29); diagnostics (M1B/M29); resilience (M24/M25); concurrency (M16/M25); copy (M2A); native text (M23); M03 lows (§11); C37–C58 map (§11.4) | §11 |
| M08 / M09 | Referenced, not duplicated | §2.7, §11 |

### 13.2 Rev 5 (M06b; M07 recheck `16b6a5a`, D148)

| Id | What changed | Section(s) / task |
|---|---|---|
| C1 (N1, DA-A-21) | `lateAskAcknowledgeable` on R01 v1's legacy window; `prepareSend` returns the acknowledgeable `window_may_have_passed` when that window is the only failing condition, identical for linked and unlinked claims; the window closing is not material; auto-open closed past the window | §2.8, §4, §6, §10 R01 + DA-A-21 row · M12/M13 |
| C2 (DA-A-15) | R01 v1 bound facts = unit price, quantity, item identity, purchase date, claim amount, opening observation; never the live price; 12 prices → 0 invalidations | §2.7, §10 DA-A-15 row · M12/M13 |
| C3 (N4) | Every R01 test in both modes via the `vi.mock` registry seam; the lead re-runs the full suite at the activation commit | §2.7, §10 · M12/M16 |
| C4 (DA-A-17) | `ready` is the catch-all tile; I3 disjoint **and exhaustive**; generator over every status/delivery/promise/provisional combination | §3.4, §10 DA-A-17 row · M12/M16 |
| C5 (D142) | Visa 16/19 only; Luhn-valid keep-samples `352099001761481`, `4221234567897`, `112-3456789-1234562`, `4006381333932` | §2.6, §10 D142 row · M10 |
| N2 | `prepareSend` check order = `approveAndSend`'s (owner, tombstone, example, address, limiter) before any evaluation; the unlinked hash is the existing binding {to, subject, body, claimVersion, draftVersion} | §6, §10 · M13 |
| N3 | A withdrawn activation is material: supersede the opportunity, bump once, `rule_withdrawn`, then the legacy path | §2.8, §6, §10 · M12/M13/M20 |
| N5 | `confirmCredit` with provisional outstanding asks: finalize vs `separateFromProvisional`; never refuses a separate posting | §3.2, §10 · M10/M16 |
| N6 | `evaluations.boundFacts` (values, ≤ 32); `resultHash` includes `boundFactsHash`; the approved basis stays displayable for legacy purchases | §2.4, §4, §10 · M10/M11/M12/M13/M20 |
| N7 | R01 v1 uses exactly `latestPolicy()`'s snapshot; A-T1/A-T2 from its `retrievedAt` | §2.7, §10 · M12/M16 |
| Wave-2 note 1 | Retail paid-total cap = confirmed `retail.order_total` (tax + shipping) else item totals labelled `paidTotalPartial` | §3.4 · M12/M21 |
| Wave-2 note 2 | The lead runs `verify-rule-sources.mjs` at every wave close, before release, and weekly while a slice is active | §2.7 |

### 13.3 Rev 5.1 (M06c)

| Id | What changed | Section(s) / task |
|---|---|---|
| D147(1) | R04 path a (checked-bag fee refund, 14 CFR 260.5) may reach `eligible` when its decisive facts are confirmed; the `likely_eligible` cap now applies only to the property-loss and incidental-expense paths; extracted candidates still cap at `likely_eligible` (D147(2)) | §10 R04 · M22 |
