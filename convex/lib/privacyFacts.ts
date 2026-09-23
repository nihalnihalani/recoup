/**
 * M14 (DA-A-7, D146 R4-1, D142, SEC-DEL-5; contract rev 5 §2.6): the
 * backend's own statement of what Recoup keeps and for how long.
 *
 * Single source for BOTH sides:
 *  - behaviour: `convex/retention.ts` imports its evidence, evaluation and
 *    orphan-blob windows from here (never its own copies);
 *  - copy: the Privacy page (M15, `src/pages/Privacy.tsx`) renders
 *    `PRIVACY_STATEMENTS`, and its copy test asserts the rendered text
 *    contains every statement.
 * `lib/privacyFacts.test.ts` ties the two together through behaviour: it runs
 * the real sweeps at each window's boundary and seeds every listed keep
 * reason, so a statement cannot promise a rule the code does not enforce.
 *
 * Frontend-importable on purpose: this module's only import is
 * `../limits` (itself import-free), and it uses no TS-only runtime syntax, so
 * `src/` can import it under `tsconfig.app.json` (`erasableSyntaxOnly`,
 * `verbatimModuleSyntax`). The test pins that import list.
 */
import {
  MARKET_MAX_POINTS,
  MAX_LOCATOR_QUOTE_CHARS,
  RETENTION_EVIDENCE_DAYS,
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "../limits";

// --- Evidence (DA-A-7, D146) --------------------------------------------------

/**
 * Days after `evidence.receivedAt` at which email/paste text, and an upload
 * that nothing keeps, is cleared (`text` removed, blob deleted, row marked
 * `content_deleted`). Measured from receipt, so the text is gone no later
 * than D146's "30 days after Recoup finishes handling it". The number
 * itself is M10's `limits.RETENTION_EVIDENCE_DAYS`, re-exported under the
 * name the copy and `retention.ts` use.
 */
export const EVIDENCE_RETENTION_DAYS = RETENTION_EVIDENCE_DAYS;

/** Evidence kinds whose text follows the window (contract §2.6 "email and paste text"). `manual_note` and `system_capture` rows are not touched. */
export const EVIDENCE_TEXT_KINDS = ["email", "paste"] as const;

/**
 * The only reasons email/paste text outlives the window:
 *  - `claim_started`: its transaction has a case, i.e. any claim through
 *    `claims.by_transaction_and_status`, or for retail any claim on its
 *    purchase through `claims.by_purchase_type`. Every status counts,
 *    dismissed included ("unless you start a claim").
 *  - `user_kept`: the user pinned the row (`evidence.pinnedAt`).
 */
export const EVIDENCE_KEEP_REASONS = ["claim_started", "user_kept"] as const;

/** Uploads are also kept while attached to a transaction that is not archived (contract §2.6 "Uploads"). */
export const UPLOAD_KEEP_REASONS = ["attached_to_open_transaction", "claim_started", "user_kept"] as const;

/**
 * What a cleared row still holds. The contentHash stays so a later
 * re-upload of the same bytes revives the row (DA-A-20). Fact quotes live on
 * `facts` rows, which retention never prunes.
 */
export const EVIDENCE_KEPT_AFTER_CLEARING = ["headers", "content_fingerprint", "fact_quotes"] as const;

/** Upper bound on one fact's locator quote (contract §2.4 `evidenceLocator`): M10's `limits.MAX_LOCATOR_QUOTE_CHARS`, asserted by the fact writer. */
export const FACT_QUOTE_MAX_CHARS = MAX_LOCATOR_QUOTE_CHARS;

// --- Rule evaluations (DA-A-32) -------------------------------------------------

/** Evaluation rows older than this are pruned unless a keep reason applies. */
export const EVALUATION_RETENTION_DAYS = 90;

/**
 * `current`: the opportunity's `currentEvaluationId`.
 * `claim_or_approval`: the opportunity has any claim (`claims.by_opportunity`)
 * or an `activeClaimId`. That covers every approval binding, because a binding
 * is written only on a draft of a claim linked to the evaluation's opportunity.
 */
export const EVALUATION_KEEP_REASONS = ["current", "claim_or_approval"] as const;

// --- Blobs (SEC-UP-7, DA-A-28(d)) ---------------------------------------------

/** A `_storage` blob no registered field references is deleted once it is this old (an upload whose finalize never ran). */
export const ORPHAN_BLOB_MIN_AGE_HOURS = 24;

// --- Mail component copy (D142, D119) -----------------------------------------

/**
 * D142 accepted residual: the AgentMail component keeps its own copy of every
 * inbound message for the user's Recoup inbox. Recoup masks card numbers in
 * everything IT stores, but it cannot mask that copy, and no sweep clears it
 * before account deletion. `account.purge` drains it through
 * `mailPurge.purgeInboxData` (D119).
 */
export const MAIL_COMPONENT_RAW_COPY = {
  maskedByRecoup: false,
  keptUntil: "account_deletion",
  purgedOnAccountDeletion: true,
} as const;

// --- Copy ---------------------------------------------------------------------

/**
 * One sentence per rule, built from the constants above (plus the Mission-1
 * windows in `limits.ts`), for the Privacy page to render verbatim.
 */
export const PRIVACY_STATEMENTS = {
  evidenceText:
    `Raw email content is cleared ${EVIDENCE_RETENTION_DAYS} days after Recoup finishes handling it, ` +
    `unless you start a claim with it or choose to keep it. Text you paste in follows the same rule.`,
  evidenceAfterClearing:
    `After that, Recoup keeps only the email's headers (sender, subject, date), a fingerprint of the content ` +
    `so a re-upload of the same file or text is recognised, and the short quotes (at most ${FACT_QUOTE_MAX_CHARS} ` +
    `characters each) behind the facts recorded for the transaction.`,
  uploads:
    `An uploaded file is kept while it is attached to a transaction you have not archived, while you have a ` +
    `claim on its transaction, or while you choose to keep it; otherwise it is deleted ${EVIDENCE_RETENTION_DAYS} ` +
    `days after you upload it.`,
  unfinishedUploads: `A file whose upload never finished is deleted after ${ORPHAN_BLOB_MIN_AGE_HOURS} hours.`,
  evaluations:
    `Rule-check history older than ${EVALUATION_RETENTION_DAYS} days is pruned, except the latest check for each ` +
    `recovery opportunity and every check behind a claim or a message you approved.`,
  // P09-F2 (X2/X5): the purge can be left unfinished, so the copy promises the purge and the record, not the result.
  mailComponentCopy:
    `Recoup masks card numbers in the email text it stores, but the mail system inside Recoup's backend also keeps ` +
    `its own copy of every email sent to your Recoup inbox, and Recoup cannot mask that copy. It is kept until you ` +
    `delete your account. Deleting your account starts a purge of it; if the purge does not finish, that is ` +
    `recorded on the account's deletion record for Recoup's operator.`,
  inboundPayload:
    `The raw content of a processed inbound email is cleared ${RETENTION_PAYLOAD_DAYS} days after Recoup receives ` +
    `it, including an email still waiting for your review. Only its message ID is kept, and, while a refund it ` +
    `announced is waiting for your confirmation, that refund's details and the sender's address.`,
  observations:
    `Individual price-check and offer-check observations older than ${RETENTION_OBSERVATION_DAYS} days are pruned, ` +
    `always keeping at least the newest ${RETENTION_KEEP_NEWEST} per item. Market price history from ShopSavvy keeps ` +
    `only the newest ${MARKET_MAX_POINTS} points per watched item.`,
  mailLog: `Finished mail-log rows (sent, failed or suppressed) are pruned after ${RETENTION_MAILLOG_DAYS} days.`,
  stash: `Small internal bookkeeping rows are pruned after ${RETENTION_STASH_DAYS} days.`,
  unverifiedAccounts: `An account that never verifies its email is pruned after ${RETENTION_UNVERIFIED_DAYS} days.`,
  moneyHistory:
    `Purchases, transactions, claims, the ledger, drafts, replies and recorded facts are never pruned ` +
    `automatically; only deleting your account removes them.`,
} as const;

// --- Providers (P09-F2, D244e, SEC-DEL-5) -------------------------------------

/**
 * P09-SK-1 / M28: `lib/ai.extract` sends every OpenAI Responses request with `store: false` (the API stores requests
 * and responses by default). `privacyFacts.test.ts` checks `lib/ai.ts` really passes it; kept here as data so this
 * module stays importable by the browser (its only import is `limits.ts`).
 */
export const OPENAI_STORE_REQUESTS = false;

/**
 * What OpenAI is sent, one entry per `extract()` purpose. `calls` are the `extract("<name>", …)` names (a trailing
 * `_` covers a templated family such as `document_${docType}`); `privacyFacts.test.ts` fails when a call site's name
 * is not listed here.
 */
export const OPENAI_PURPOSES = [
  {
    calls: ["inbound_email"],
    text:
      "The sender, subject and text of an email you forward to your Recoup inbox, or text you paste in, to find the " +
      "order or refund details in it.",
  },
  {
    calls: ["reply"],
    text:
      "A reply to one of your claims (its sender, subject and text), with what the claim asks for, the company's name " +
      "and the amount you asked for, to tell whether it is a promise, a refusal or a question.",
  },
  {
    calls: ["draft"],
    text:
      "When Recoup writes a claim message for you to review: your name (or the part of your email address before the " +
      "@ when no name is set); for an item-linked claim, the store, order reference, purchase date, item, prices, " +
      "product link, and the store's policy passage together with the page it came from; for any claim, summaries of " +
      "earlier replies and the confirmed, observed and derived facts your rule check bound — not only facts you typed " +
      "in yourself.",
  },
  {
    calls: ["price"],
    text: "The text of a product page Recoup read, with the product's name, to find its current price.",
  },
  {
    calls: ["policy"],
    text:
      "The text of a store's policy page — its price-adjustment page or its returns page, whichever Recoup is " +
      "researching — to find its terms (the window, how to ask, a published contact address).",
  },
  {
    calls: ["document_classification", "document_"],
    text:
      "Only when document reading is switched on (it is off by default): the text of a document you upload (a PDF's " +
      "text layer), or of an email or pasted text you link to a transaction as a document, to tell what kind of " +
      "document it is and pull out its details.",
  },
] as const;

/**
 * One entry per outside provider, rendered verbatim by the Privacy page: what it is for, what it receives, and what
 * Recoup can say about what it keeps. Each sentence must stay literally true of the code (security reviews changes).
 */
export const PROVIDER_DISCLOSURES = [
  {
    name: "Convex",
    role: "Hosts Recoup's database and runs its server-side code, including sign-in.",
    receives:
      "Your account (email address and a salted password hash) and every row the app creates for you: purchases, " +
      "items, claims, the ledger, drafts, replies, watches, price history, the mail log, and for recovery checks your " +
      "transactions, the facts recorded about them, the evidence you forward, paste or upload, recovery opportunities " +
      "and the rule-check history behind them.",
    retention: "Kept as described under Retention below.",
  },
  {
    name: "OpenAI",
    role:
      "Reads text and returns structured details. Everything it is sent is treated as untrusted data, never as " +
      "instructions to follow.",
    receives: "Recoup sends it:",
    retention:
      `Recoup sends every request with OpenAI's storage option turned off (store: ${String(OPENAI_STORE_REQUESTS)}), so ` +
      "OpenAI does not keep the request or its answer for later retrieval. Anything else OpenAI keeps is governed by " +
      "OpenAI's own API data policies, which Recoup does not control.",
  },
  {
    name: "Firecrawl",
    role: "Fetches public web pages for Recoup, so price and policy information stays current.",
    receives:
      "The address of each product or store-policy page Recoup reads, and web searches built from a watched product's " +
      "name (to find other stores selling it) or a store's web address (to find its policy page). Nothing about your " +
      "account.",
    retention: "Recoup does not control what Firecrawl keeps from these requests.",
  },
  {
    name: "AgentMail",
    role: "Runs your Recoup inbox address and sends Recoup's email.",
    receives:
      "Every email sent to your Recoup inbox; the claim messages you approve, sent from that inbox; and, from one " +
      "shared Recoup mailbox, your sign-in and password-reset codes and (normally) your price alerts.",
    retention:
      "Recoup's Retention section below covers only the AgentMail component's copy inside Recoup's own backend, " +
      "masked and purged (attempted) on account deletion. Your AgentMail inbox itself is a separate resource, held " +
      "by AgentMail, not Recoup: deleting your account asks AgentMail to delete it, and it stays with AgentMail " +
      "until that delete succeeds — indefinitely, if it never does. AgentMail also keeps copies of what the shared " +
      "sign-in/alerts mailbox sends, such as codes and alerts; deleting your account does not remove those.",
  },
  {
    name: "ShopSavvy",
    role:
      "A market-data service Recoup asks for a product's price history and the other stores selling it. Its prices " +
      "are always labelled as ShopSavvy's and never open a claim or send an alert.",
    receives: "The address of the product page you watch. Nothing about your account.",
    retention: "Recoup does not control what ShopSavvy keeps from these requests.",
  },
] as const;
