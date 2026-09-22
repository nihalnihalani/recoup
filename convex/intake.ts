import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { processedRoute, processedStatus } from "./schema";
import { requireUserId } from "./lib/access";
import { extract } from "./lib/ai";
import { InboundEmail, type InboundEmailT } from "./lib/schemas";

/** The refund half of the extraction schema: a held `pendingRefund` is re-validated with it before use. */
const RefundCandidate = InboundEmail.shape.refund.unwrap();
import { normalizeDomain } from "./lib/policyText";
import { assertPositiveCents, toCents } from "./lib/money";
import { sanitizeError } from "./lib/errors";
import { applyEvent, openClaim } from "./claims";
import { internalKey } from "./lib/idempotency";
import { parseProductUrl } from "./lib/watchUrl";
import { cleanLine } from "./lib/text";
import { charge, tryConsumeBudget, tryConsumeGlobalBudget } from "./lib/budget";
import { isTombstoned } from "./lib/accountState";
import { maskPans } from "./lib/pan";
import { putFact, type PutFactInput } from "./lib/facts/write";
import { subjectKey } from "./lib/facts/subject";
import { ensurePurchaseTransaction } from "./transactions";
import { recordTextEvidence, TEXT_EXTRACTOR_VERSION, type EvidenceProvenance } from "./evidence";
import { DAILY_BUDGETS, GLOBAL_DAILY_BUDGETS, MAX_ITEMS_PER_PURCHASE, MAX_PURCHASES_PER_USER } from "./limits";

/**
 * What the model is told. The email itself is untrusted content and goes in
 * the user turn (`lib/ai.extract` adds the prompt-injection guard).
 */
const SYSTEM = `You read a single email a shopper received or forwarded.
Decide whether it is an order confirmation ("order"), a refund or return-credit notice ("refund"), or neither ("other").
Extract only what the email states; never infer a price, a date or a merchant that is not written down.
Prices are per unit, before tax, in the currency the email shows.
Derive merchantDomain from the sender address or the links in the email; never invent it.
A refund credit is "posted" only if the email says the money was issued to the payment method.`;

const MAX_ERROR_CHARS = 1_000;
const MAX_ATTEMPTS = 5;
/** Nothing a model proposes may exceed $1,000,000; above that it is a parse artefact. */
const MAX_CENTS = 100_000_000;
const MAX_QTY = 10_000;
/** Bounded read of the user's purchases when matching a refund to an order. */
const PURCHASE_SCAN_LIMIT = 200;
/** Rows shown in the board's "needs attention" list. */
const ATTENTION_LIMIT = 50;
const MIN_PASTE_CHARS = 40;
const MAX_PASTE_CHARS = 60_000;

/** One day: an ownerless failed row older than this will never find its inbox. */
const OWNERLESS_AFTER_MS = 86_400_000;

/**
 * D76/Invariant 10: a global-budget refusal is `needs_review` (retryable),
 * never `failed`/dropped, and never counts as one of `MAX_ATTEMPTS`. Written
 * only by `beginEvent`/`replies.pauseForBudget` below and read back by
 * `retryFailed`'s dedicated pass, so the two stay in lockstep without a
 * schema flag.
 */
export const BUDGET_PAUSED_SUMMARY = "Paused: daily extraction budget reached; will retry";

/**
 * D112 6a-2: distinct from `BUDGET_PAUSED_SUMMARY` on purpose -- a row
 * paused here hit its OWN user's daily cap, not the deployment-wide switch,
 * so it carries no global-pause marker and `retryFailed`'s bounded,
 * per-user round-robin pass (below) is what will pick it back up, not the
 * page that reads `BUDGET_PAUSED_SUMMARY`.
 */
export const PER_USER_BUDGET_PAUSED_SUMMARY = "Daily intake limit reached; will retry tomorrow";

/**
 * D76: the shared `inbound_extract` global switch -- one unit per model call
 * that reads an inbound email, whether from `processEvent` (a fresh order/
 * refund) or `replies.classify` (a merchant reply).
 *
 * D112 6a-2: one known inbox address used to be able to pause every user's
 * intake for the day by exhausting this global switch alone. A per-user
 * `inbound_extract` cap (`DAILY_BUDGETS.inbound_extract`) is now charged
 * FIRST, so one user's flood only ever exhausts their own share before it
 * can touch the shared switch below.
 */
export async function reserveInboundExtractBudget(ctx: MutationCtx, now: number = Date.now()): Promise<boolean> {
  return tryConsumeGlobalBudget(ctx, "inbound_extract", GLOBAL_DAILY_BUDGETS.inbound_extract.max, 1, now);
}

/** The per-user half of the D112 6a-2 gate, checked before the global one. */
async function reserveInboundExtractForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  now: number = Date.now(),
): Promise<boolean> {
  return tryConsumeBudget(ctx, userId, "inbound_extract", DAILY_BUDGETS.inbound_extract.max, now);
}

/** `replies.classify` runs in an action and has no `ctx.db` of its own; this is its way to call the helper above. */
export const reserveInboundExtract = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => reserveInboundExtractBudget(ctx),
});

/**
 * D112 6a-2: `replies.classify`'s way to charge BOTH the per-user and the
 * global `inbound_extract` switches (in that order) from an action, which
 * has no `ctx.db` of its own. The claim, not the caller, is the source of
 * truth for whose per-user budget to charge -- `classify`'s own args carry
 * no `userId` (D21: it is unauthenticated on purpose, ownership is derived
 * from the claim).
 */
export const reserveInboundExtractForReply = internalMutation({
  args: { claimId: v.id("claims") },
  returns: v.union(v.literal("ok"), v.literal("user_capped"), v.literal("global_capped"), v.literal("no_claim")),
  handler: async (ctx, { claimId }) => {
    const claim = await ctx.db.get(claimId);
    if (!claim) return "no_claim";
    if (!(await reserveInboundExtractForUser(ctx, claim.userId))) return "user_capped";
    if (!(await reserveInboundExtractBudget(ctx))) return "global_capped";
    return "ok";
  },
});

/** Moves a `processing` reply-classification row back to `needs_review` after a GLOBAL budget refusal, for `replies.classify`. */
export const pauseForBudget = internalMutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.null(),
  handler: async (ctx, { processedEventId }) => {
    const row = await ctx.db.get(processedEventId);
    if (!row) return null;
    await ctx.db.patch(processedEventId, { status: "needs_review", summary: BUDGET_PAUSED_SUMMARY, lastError: undefined });
    return null;
  },
});

/** Same, for a PER-USER budget refusal (D112 6a-2): distinct summary, no global-pause marker. */
export const pauseForUserBudget = internalMutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.null(),
  handler: async (ctx, { processedEventId }) => {
    const row = await ctx.db.get(processedEventId);
    if (!row) return null;
    await ctx.db.patch(processedEventId, { status: "needs_review", summary: PER_USER_BUDGET_PAUSED_SUMMARY, lastError: undefined });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Normalisation. Model output is proposed data, never authority
// (ARCHITECTURE_PATTERNS §Actions): every number is re-derived here and a
// violation downgrades the event to needs_review instead of writing money.
// ---------------------------------------------------------------------------

function safeCents(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const cents = Math.round(Math.abs(amount) * 100);
  if (!Number.isSafeInteger(cents) || cents > MAX_CENTS) return null;
  return cents;
}

function safeQty(qty: number): number | null {
  if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_QTY) return null;
  return qty;
}

function safeCurrency(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(upper)) return null;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: upper });
  } catch {
    return null;
  }
  return upper;
}

/** An ISO date the email actually stated, or undefined; `purchasedAt` is optional until confirm (D25). */
function safeDate(iso: string | null): number | undefined {
  if (!iso) return undefined;
  // A bare "2025-11-29" parses as midnight UTC, which is the evening of the 28th anywhere in the
  // Americas, so the purchase rendered a day early (seen live on 2026-09-21). Anchor a date-only
  // value at noon UTC instead: that is the same calendar day from UTC-11 to UTC+12. A timestamp
  // that already carries a time or a zone is trusted as given. `fromDateInput` in src/lib/ui.ts
  // does the same thing for dates the user picks.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(iso.trim());
  const ms = Date.parse(dateOnly ? `${iso.trim()}T12:00:00Z` : iso);
  if (!Number.isFinite(ms)) return undefined;
  // Reject a hallucinated year: anything before 2000 or more than a day ahead.
  if (ms < 946_684_800_000 || ms > Date.now() + 86_400_000) return undefined;
  return ms;
}

function money(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// processedEvents lifecycle (D14)
// ---------------------------------------------------------------------------

const eventPayload = v.object({
  userId: v.id("users"),
  subject: v.string(),
  text: v.string(),
  from: v.string(),
});

/**
 * Moves a queued event into `processing` and hands the action the minimal
 * payload it needs. Returns `null` when the row is not runnable (already
 * done, owned by nobody, out of attempts), so the action simply stops.
 */
export const beginEvent = internalMutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.union(eventPayload, v.null()),
  handler: async (ctx, { processedEventId }) => {
    const row = await ctx.db.get(processedEventId);
    if (!row || row.status !== "received" || !row.userId) return null;
    // D115 6b-3: a tombstoned (deleting/deleted) owner's row is closed the
    // same way `retryFailed`'s D87 guard closes one -- `succeeded` with
    // "Ignored: account deleted" -- before it ever reaches attempts/budget
    // accounting or the model. Checked first: a day either budget switch is
    // out is not this row's fault, but neither is this row's fault the
    // account is gone, and unlike a budget pause this is never retryable.
    if (await isTombstoned(ctx, row.userId)) {
      await ctx.db.patch(processedEventId, { status: "succeeded", summary: "Ignored: account deleted" });
      return null;
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      const lastError = `Gave up after ${MAX_ATTEMPTS} attempts`;
      await ctx.db.patch(processedEventId, {
        status: "failed",
        lastError,
        errorSummary: sanitizeError(lastError), // D58
      });
      return null;
    }
    // D76/Invariant 10, extended by D112 6a-2: checked BEFORE
    // `processing`/attempts, so a day either switch is out never counts
    // against this row's own MAX_ATTEMPTS -- it is not this email's fault.
    // `needs_review`, not `failed`: `retryFailed`'s dedicated pass below
    // picks it back up. The per-user cap is charged FIRST (6a-2: one known
    // inbox address must not be able to pause every OTHER user's intake by
    // exhausting the shared switch alone) and gets its own distinct
    // summary and no global-pause marker.
    if (!(await reserveInboundExtractForUser(ctx, row.userId))) {
      await ctx.db.patch(processedEventId, { status: "needs_review", summary: PER_USER_BUDGET_PAUSED_SUMMARY });
      return null;
    }
    if (!(await reserveInboundExtractBudget(ctx))) {
      await ctx.db.patch(processedEventId, { status: "needs_review", summary: BUDGET_PAUSED_SUMMARY });
      return null;
    }
    await ctx.db.patch(processedEventId, {
      status: "processing",
      processingStartedAt: Date.now(),
      attempts: row.attempts + 1,
      lastError: undefined,
    });
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    // D142: nothing reaches the model unmasked. New payloads are masked at insert (`inbound`, `paste`); this also
    // covers a row stored before masking existed.
    const read = (key: string) => (typeof payload[key] === "string" ? maskPans(payload[key] as string) : "");
    return {
      userId: row.userId,
      subject: read("subject"),
      text: read("text"),
      from: read("from"),
    };
  },
});

/** Records a processing failure so the row stays retryable instead of vanishing (D10). */
export const failEvent = internalMutation({
  args: { processedEventId: v.id("processedEvents"), lastError: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.processedEventId);
    if (!row) return null;
    const lastError = args.lastError.slice(0, MAX_ERROR_CHARS);
    await ctx.db.patch(args.processedEventId, {
      status: "failed",
      lastError,
      // D58: `errorSummary` is the only thing the board's "needs attention"
      // list ever shows; the raw `lastError` stays server-side for operators.
      errorSummary: sanitizeError(lastError),
    });
    return null;
  },
});

async function finish(
  ctx: MutationCtx,
  processedEventId: Id<"processedEvents">,
  status: "succeeded" | "needs_review",
  summary: string,
) {
  await ctx.db.patch(processedEventId, { status, summary });
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * The intake worker (D14). Reads the queued event, asks the model what the
 * email is, and hands the proposed data to `applyExtraction`, which is the
 * only place that writes. Any failure lands on the row as `failed` with the
 * message, never as a silently dropped email.
 */
export const processEvent = internalAction({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.null(),
  handler: async (ctx, { processedEventId }) => {
    const payload = await ctx.runMutation(internal.intake.beginEvent, { processedEventId });
    if (!payload) return null;
    try {
      const parsed = await extract(
        "inbound_email",
        InboundEmail,
        SYSTEM,
        `From: ${payload.from}\nSubject: ${payload.subject}\n\n${payload.text}`,
      );
      await ctx.runMutation(internal.intake.applyExtraction, { processedEventId, parsed });
    } catch (error) {
      await ctx.runMutation(internal.intake.failEvent, {
        processedEventId,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Writing the extraction
// ---------------------------------------------------------------------------

/** Where an intake event's content came from, and the evidence row that holds it (null at the evidence cap). */
type IntakeSource = { evidenceId: Id<"evidence"> | null; provenance: EvidenceProvenance };

/** SEC-AI-6 copy: said wherever an unverified sender's email is held back, so a person forwarding from a second address knows why. */
export const UNVERIFIED_SENDER_NOTE = "It was sent from an address that isn't your account email";

/**
 * Writes the facts an email proposes as `extracted_candidate` rows through the single fact writer (`putFact`,
 * contract §2.5), each citing the evidence row it came from. Candidates never satisfy a rule condition and never
 * write money (SEC-AI-2/3); the user confirms them by confirming the purchase. A value the catalogue refuses (an order
 * reference that is not a valid reference, say) is skipped: `putFact` checks everything before its first write, so a
 * refusal leaves nothing behind, and the purchase row still carries what the user will review.
 */
async function proposeCandidates(
  ctx: MutationCtx,
  userId: Id<"users">,
  transactionId: Id<"transactions">,
  evidenceId: Id<"evidence">,
  candidates: Array<{ subjectKey: string; key: string; value: PutFactInput["value"] }>,
): Promise<number> {
  let written = 0;
  for (const c of candidates) {
    try {
      await putFact(ctx, userId, {
        transactionId,
        subjectKey: c.subjectKey,
        key: c.key,
        state: "extracted_candidate",
        value: c.value,
        source: {
          kind: "evidence",
          evidenceId,
          locator: { kind: "whole_document" },
          // The wave-1 extractor quotes nothing; quote verification arrives with M23 (DA-A-6).
          quoteStatus: "unverified",
          extractorVersion: TEXT_EXTRACTOR_VERSION,
        },
      });
      written++;
    } catch (err) {
      if (!(err instanceof ConvexError)) throw err;
    }
  }
  return written;
}

/**
 * An extracted order becomes a `needs_review` purchase (D25): the user
 * confirms merchant, date and every line item before anything is scraped or
 * claimed. A repeat of an order we already hold is refused outright (D22).
 *
 * M13 (contract §7): the purchase gets its transaction (`ensurePurchaseTransaction`, DA-A-35) and the email's values
 * become candidate facts citing the evidence row. HC-9: a currency the email does not state clearly is never assumed:
 * no currency candidate (or price candidate) is written, and the summary asks the user to confirm it.
 */
async function applyOrder(
  ctx: MutationCtx,
  processedEventId: Id<"processedEvents">,
  userId: Id<"users">,
  sourceMessageId: string | undefined,
  order: NonNullable<InboundEmailT["order"]>,
  source: IntakeSource,
) {
  const merchantDomain = normalizeDomain(order.merchantDomain);
  if (!merchantDomain) {
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      "Could not work out which store this order email is from.",
    );
    return;
  }

  // B5/H5: this very email already produced a purchase (a manual re-run, or two racing extractions). An order
  // with no `orderRef` has no D22 key, so the source message is the only thing that can say so.
  const held = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PURCHASES_PER_USER);
  if (sourceMessageId !== undefined && held.some((p) => p.sourceMessageId === sourceMessageId)) {
    await finish(ctx, processedEventId, "needs_review", "This email is already on your board as a purchase.");
    return;
  }
  if (held.length >= MAX_PURCHASES_PER_USER) {
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      `You already keep ${MAX_PURCHASES_PER_USER} purchases, so this order was not added.`,
    );
    return;
  }

  const orderRef = cleanLine(order.orderRef ?? "").slice(0, 100) || undefined;
  if (orderRef) {
    // D22: (userId, merchantDomain, orderRef) is the order's natural key.
    const duplicate = await ctx.db
      .query("purchases")
      .withIndex("by_user_domain_order", (q) =>
        q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("orderRef", orderRef),
      )
      .first();
    if (duplicate) {
      await finish(
        ctx,
        processedEventId,
        "needs_review",
        `Duplicate of purchase ${duplicate.merchant} ${orderRef}, already on your board.`,
      );
      return;
    }
  }

  type CleanItem = { name: string; unitCents: number; qty: number; productUrl: string | undefined };
  const items: CleanItem[] = [];
  // D58: unitPrice and qty are validated at the boundary (safeCents/safeQty
  // above); a violation drops just that item -- never the whole event to
  // `failed` -- with the reason surfaced in the event's summary below.
  const skipped: string[] = [];
  for (const it of order.items) {
    if (items.length >= MAX_ITEMS_PER_PURCHASE) break;
    const unitCents = safeCents(it.unitPrice);
    const qty = safeQty(it.qty);
    const name = cleanLine(it.name).slice(0, 200);
    if (unitCents === null || qty === null || name.length === 0) {
      skipped.push(name.length > 0 ? name : "an unnamed item");
      continue;
    }
    items.push({
      name,
      unitCents,
      qty,
      // M1: the link came out of an email via a model; one we would refuse to scrape is dropped, not stored.
      productUrl: it.productUrl ? parseProductUrl(it.productUrl)?.productUrl : undefined,
    });
  }

  if (items.length === 0) {
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      "No usable line items could be read out of this order email.",
    );
    return;
  }

  const currency = safeCurrency(order.currency);
  const merchant = cleanLine(order.merchant).slice(0, 120) || merchantDomain;
  const purchasedAt = safeDate(order.purchasedAt);
  const purchaseId = await ctx.db.insert("purchases", {
    userId,
    merchant,
    merchantDomain,
    orderRef,
    purchasedAt,
    // The purchase row needs a currency; when the email gave none clearly this is a placeholder the user must
    // confirm (HC-9). It is never a confirmed fact: the legacy adapter reads a purchase currency as a candidate unless
    // `purchases.confirm` records the user's answer (DA-A-33).
    currency: currency ?? "USD",
    sourceMessageId,
    // D25: extraction never produces an active purchase.
    status: "needs_review",
  });
  const itemIds: Id<"items">[] = [];
  for (const it of items) {
    itemIds.push(
      await ctx.db.insert("items", {
        purchaseId,
        userId,
        name: it.name,
        unitCents: it.unitCents,
        qty: it.qty,
        productUrl: it.productUrl,
        // D15: only the user ever marks an item returned.
        returned: false,
      }),
    );
  }
  // DA-A-35: every purchase insert gets its category-neutral transaction.
  const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);

  if (source.evidenceId !== null) {
    const txn = subjectKey.txn();
    const candidates: Array<{ subjectKey: string; key: string; value: PutFactInput["value"] }> = [
      { subjectKey: txn, key: "retail.merchant", value: { kind: "text", text: merchant } },
    ];
    if (orderRef) candidates.push({ subjectKey: txn, key: "retail.order_ref", value: { kind: "identifier", scheme: "order_ref", value: orderRef } });
    if (purchasedAt !== undefined) candidates.push({ subjectKey: txn, key: "retail.purchase_date", value: { kind: "instant", epochMs: purchasedAt } });
    if (currency) candidates.push({ subjectKey: txn, key: "retail.currency", value: { kind: "code", code: currency } });
    items.forEach((it, i) => {
      const s = subjectKey.item(itemIds[i]);
      candidates.push({ subjectKey: s, key: "retail.item_name", value: { kind: "text", text: it.name } });
      candidates.push({ subjectKey: s, key: "retail.quantity", value: { kind: "count", n: it.qty } });
      // A price without a stated currency is not a value the email gave: no candidate (HC-9).
      if (currency) {
        candidates.push({ subjectKey: s, key: "retail.unit_price", value: { kind: "money", amountMinor: it.unitCents, currency } });
      }
    });
    await proposeCandidates(ctx, userId, transactionId, source.evidenceId, candidates);
  }

  const note = currency ? "" : " The email did not state a clear currency, so confirm it before anything is compared.";
  const senderNote = source.provenance === "unverified_sender" ? ` ${UNVERIFIED_SENDER_NOTE}, so check every detail.` : "";
  const skippedNote =
    skipped.length > 0 ? ` Could not read ${skipped.join(", ")} — add ${skipped.length === 1 ? "it" : "them"} manually if needed.` : "";
  await finish(
    ctx,
    processedEventId,
    "needs_review",
    `Order from ${merchant} with ${items.length} item${items.length === 1 ? "" : "s"} — confirm the details to start tracking it.${note}${senderNote}${skippedNote}`,
  );
}

/**
 * Finds the purchase a refund email is about (D55). Only `active` purchases
 * are eligible, and an `isExample` purchase is skipped unless the refund's
 * own merchant name explicitly marks it as an example -- so the examples
 * flow can still exercise this path end to end without a real refund ever
 * landing on a demo purchase. Preference order: exact `orderRef`, then exact
 * merchant name, then merchant-name inclusion; each tier must identify
 * exactly one purchase, because guessing would attach a credit to the wrong
 * order's ledger.
 */
async function matchPurchase(
  ctx: MutationCtx,
  userId: Id<"users">,
  refund: NonNullable<InboundEmailT["refund"]>,
): Promise<Doc<"purchases"> | null> {
  const all = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(PURCHASE_SCAN_LIMIT);

  const refundIsExample = Boolean(refund.merchant?.toLowerCase().includes("(example)"));
  const purchases = all.filter((p) => {
    if (p.status !== "active") return false;
    if (p.isExample) return refundIsExample;
    return true;
  });

  const ref = refund.orderRef?.trim();
  if (ref) {
    const byRef = purchases.filter((p) => p.orderRef && norm(p.orderRef) === norm(ref));
    if (byRef.length === 1) return byRef[0];
  }
  const merchant = refund.merchant?.trim();
  if (merchant) {
    const byExactName = purchases.filter((p) => norm(p.merchant) === norm(merchant));
    if (byExactName.length === 1) return byExactName[0];
    const byName = purchases.filter(
      (p) => norm(p.merchant).includes(norm(merchant)) || norm(merchant).includes(norm(p.merchant)),
    );
    if (byName.length === 1) return byName[0];
  }
  return null;
}

/**
 * D15's attribution rule, and nothing looser: a credit is attributed only
 * when the evidence names exactly one item, either by name or by being the
 * only returned item whose total equals the credit.
 */
function matchItem(
  items: Doc<"items">[],
  itemName: string | null,
  cents: number,
): Doc<"items"> | null {
  const name = itemName?.trim();
  if (name) {
    const hits = items.filter(
      (i) => norm(i.name).includes(norm(name)) || norm(name).includes(norm(i.name)),
    );
    return hits.length === 1 ? hits[0] : null;
  }
  const hits = items.filter((i) => i.returned && i.unitCents * i.qty === cents);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A refund email is evidence that the merchant *says* money is coming, so it
 * writes at most a `promised_credit` (Inv 3, design §Reply: only the user's
 * own confirmation ever creates `confirmed_credit`, even when the email says
 * the refund was posted). It never marks an item returned and never opens a
 * claim on an item the user has not marked returned (D15).
 *
 * M13:
 * - SEC-AI-6 (D174): a refund email from an unverified sender — anyone but the account holder forwarding their own
 *   mail — writes no ledger event and opens no claim. It becomes a needs_review candidate the USER can confirm
 *   (`confirmRefundEmail`); the user's confirmation, never the sender, is what lets it write the promise.
 * - HC-10: a credit whose currency is unclear or differs from the purchase's is refused (needs_review, no ledger
 *   write). Recoup never converts currencies and never assumes one.
 */
async function applyRefund(
  ctx: MutationCtx,
  processedEventId: Id<"processedEvents">,
  userId: Id<"users">,
  sourceMessageId: string | undefined,
  messageIdOrPasteHash: string,
  refund: NonNullable<InboundEmailT["refund"]>,
  trust: { verified: boolean; confirmedByUser?: boolean },
) {
  const purchase = await matchPurchase(ctx, userId, refund);
  if (!purchase) {
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      "A refund email arrived but it could not be matched to one of your purchases.",
    );
    return;
  }

  if (!trust.verified) {
    // Held as a candidate: the validated refund waits on the event for the user's confirmation. Nothing is written to
    // the ledger or the claims until then. Retention clears the payload after 30 days; a later forward from the
    // account email (or a paste) is then the way to record it.
    const row = await ctx.db.get(processedEventId);
    const payload = (row?.payload ?? {}) as Record<string, unknown>;
    await ctx.db.patch(processedEventId, { payload: { ...payload, pendingRefund: refund } });
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      `A refund email about your ${purchase.merchant} order was held for review. ${UNVERIFIED_SENDER_NOTE}, so nothing was recorded. If it is genuine, confirm it here, or forward it again from your account email.`,
    );
    return;
  }

  const items = await ctx.db
    .query("items")
    .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
    .collect();
  const returnsPolicy = await ctx.db
    .query("policies")
    .withIndex("by_user_domain_kind", (q) =>
      q
        .eq("userId", userId)
        .eq("merchantDomain", purchase.merchantDomain)
        .eq("kind", "returns"),
    )
    .order("desc")
    .first();

  const unmatched: string[] = [];
  let applied = 0;

  for (let i = 0; i < refund.credits.length; i++) {
    const credit = refund.credits[i];
    // D58: a non-positive or otherwise invalid credit amount is a per-credit
    // needs_review entry (via `unmatched` below), never a thrown error --
    // the same boundary assert the ledger itself uses (lib/money), not a
    // bespoke check.
    let cents: number;
    try {
      cents = assertPositiveCents(toCents(credit.amount), "credit amount");
    } catch {
      unmatched.push(`A credit with an unreadable amount (${credit.amount})`);
      continue;
    }
    // HC-10: only a credit stated in the purchase's own currency can be recorded against it.
    const currency = safeCurrency(credit.currency);
    if (currency === null) {
      unmatched.push(`A credit of ${(cents / 100).toFixed(2)} in an unclear currency was not recorded`);
      continue;
    }
    if (currency !== purchase.currency) {
      unmatched.push(
        `Credit of ${money(cents, currency)} is in ${currency} but the purchase is in ${purchase.currency}; Recoup never converts currencies, so it was not recorded`,
      );
      continue;
    }
    const item = matchItem(items, credit.itemName, cents);
    if (!item) {
      unmatched.push(`Credit of ${money(cents, currency)} could not be matched`);
      continue;
    }
    if (!item.returned) {
      unmatched.push(
        `Credit of ${money(cents, currency)} names "${item.name}", which is not marked returned`,
      );
      continue;
    }

    const open = (
      await ctx.db
        .query("claims")
        .withIndex("by_item", (q) => q.eq("itemId", item._id))
        .collect()
    ).find((c) => c.type === "return_credit" && c.status !== "dismissed");

    let claim = open ?? null;
    if (!claim) {
      const claimId = await openClaim(ctx, {
        userId,
        purchaseId: item.purchaseId,
        itemId: item._id,
        type: "return_credit",
        expectedCents: item.unitCents * item.qty,
        policyId: returnsPolicy?._id,
        isExample: purchase.isExample, // D55
      });
      claim = await ctx.db.get(claimId);
    }
    if (!claim) continue;

    // D54: the idempotency key is external and per credit -- scoped to this
    // message (or paste), the matched item, and the credit's position in the
    // email, so two different credits (or a retried extraction) never
    // collide with each other. A key collision with a conflicting kind or
    // amount marks only this credit needs_review; the event as a whole still
    // succeeds rather than rolling back credits already applied above.
    //
    // D112 6a-1: the key used to be the raw `${messageIdOrPasteHash}:
    // ${itemId}:${i}` string, unbounded by the message id (an RFC
    // Message-ID has no length ceiling) -- `claims.applyEvent`'s old
    // 128-char bound made a long enough one unrecordable forever. Derived
    // through `internalKey` now (a fixed-length hash), with the old raw
    // string passed through as the legacy key so a credit recorded before
    // this change is still found and deduped rather than double-applied.
    const legacyKey = `${messageIdOrPasteHash}:${item._id}:${i}`;
    const key = await internalKey(messageIdOrPasteHash, item._id, String(i));
    try {
      await applyEvent(
        ctx,
        claim,
        "promised_credit",
        cents,
        `Merchant email says the refund is ${credit.state} (${sourceMessageId ?? "pasted email"})${trust.confirmedByUser ? "; confirmed by you" : ""}`,
        key,
        legacyKey,
      );
      applied++;
    } catch (err) {
      if (err instanceof ConvexError && err.data === "idempotency conflict") {
        unmatched.push(
          `Credit of ${money(cents, currency)} for "${item.name}" needs review: conflicts with a previously recorded credit`,
        );
        continue;
      }
      throw err;
    }
  }

  if (unmatched.length > 0) {
    await finish(
      ctx,
      processedEventId,
      "needs_review",
      `${unmatched.join("; ")}. Purchase: ${purchase.merchant}.`,
    );
    return;
  }
  await finish(
    ctx,
    processedEventId,
    "succeeded",
    `Recorded ${applied} promised credit${applied === 1 ? "" : "s"} from ${purchase.merchant}.`,
  );
}

/** Longest `From` header examined; an address is at most 254 characters, a display name adds a little. */
const MAX_FROM_CHARS = 512;

/** The bare, lowercased address in a `From` header (`Name <a@b.c>` or `a@b.c`), or null. No regex over unbounded input. */
export function senderAddress(from: string): string | null {
  const bounded = from.slice(0, MAX_FROM_CHARS);
  const open = bounded.lastIndexOf("<");
  const close = bounded.lastIndexOf(">");
  const bare = (open >= 0 && close > open ? bounded.slice(open + 1, close) : bounded).trim().toLowerCase();
  const at = bare.indexOf("@");
  if (at <= 0 || at !== bare.lastIndexOf("@") || at === bare.length - 1 || /\s/.test(bare) || bare.length > 254) return null;
  return bare;
}

/**
 * SEC-AI-6: true only when the email's sender is the account's own address. An account with no email on file has
 * nothing to compare against and is NOT treated as verified (D174).
 */
async function isAccountSender(ctx: MutationCtx, userId: Id<"users">, from: string): Promise<boolean> {
  const address = senderAddress(from);
  if (address === null) return false;
  const user = await ctx.db.get(userId);
  const own = user?.email?.trim().toLowerCase();
  return own !== undefined && own.length > 0 && own === address;
}

/**
 * The only writer in the intake lane. `parsed` is `v.any()` because it comes
 * from the model; it is narrowed by the zod schema on the first line and a
 * bad shape throws, which the caller turns into a retryable `failed` row.
 */
export const applyExtraction = internalMutation({
  args: { processedEventId: v.id("processedEvents"), parsed: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.processedEventId);
    if (!row || !row.userId) return null;
    // D115 6b-3: defense in depth alongside `beginEvent`'s own gate above --
    // this is the only place that actually writes purchases/items/claims, so
    // it refuses independently rather than trusting every caller to have
    // gone through `beginEvent` first (checkpoint 6b F3a: a direct call
    // reached this function for an account already `deleted`).
    if (await isTombstoned(ctx, row.userId)) {
      await ctx.db.patch(args.processedEventId, { status: "succeeded", summary: "Ignored: account deleted" });
      return null;
    }
    const parsed: InboundEmailT = InboundEmail.parse(args.parsed);
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const sourceMessageId =
      typeof payload.messageId === "string" ? payload.messageId : undefined;
    const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");

    // SEC-AI-6: who stands behind this content. A paste is the user's own act; an email is the user's only when it
    // comes from the account's own address (a forward from their mailbox). Anything else is an unverified sender.
    const provenance: EvidenceProvenance =
      row.kind === "paste" ? "user_pasted" : (await isAccountSender(ctx, row.userId, read("from"))) ? "user_forwarded" : "unverified_sender";
    // §7: the (masked) email becomes evidence before anything is proposed from it.
    const evidenceId = await recordTextEvidence(ctx, {
      userId: row.userId,
      kind: row.kind === "paste" ? "paste" : "email",
      provenance,
      text: read("text"),
      headers: row.kind === "paste" ? undefined : { from: read("from"), subject: read("subject"), messageId: sourceMessageId },
      processedEventId: args.processedEventId,
      docType: parsed.kind === "order" ? "order_confirmation" : parsed.kind === "refund" ? "refund_notice" : "unknown",
    });
    const source: IntakeSource = { evidenceId, provenance };
    // A paste has no message id; its content hash is just as stable, so a re-run of the same paste is
    // recognised as "already applied" too (B5).
    const orderSourceId = sourceMessageId ?? (row.kind === "paste" ? row.externalId : undefined);
    // D54: the external, per-message identity used to scope refund credit
    // idempotency keys -- the AgentMail message id for a forwarded email, or
    // the event's own externalId (a per-user hash for a pasted one). Stable
    // across a retry of the same event, so a retried extraction still
    // dedupes against ledger events it already wrote.
    const messageIdOrPasteHash = sourceMessageId ?? row.externalId;

    if (parsed.kind === "order" && parsed.order) {
      await applyOrder(ctx, args.processedEventId, row.userId, orderSourceId, parsed.order, source);
      return null;
    }
    if (parsed.kind === "refund" && parsed.refund) {
      await applyRefund(
        ctx,
        args.processedEventId,
        row.userId,
        sourceMessageId,
        messageIdOrPasteHash,
        parsed.refund,
        { verified: provenance !== "unverified_sender" },
      );
      return null;
    }
    await finish(
      ctx,
      args.processedEventId,
      "needs_review",
      "This email did not read as an order confirmation or a refund notice.",
    );
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Tombstone-aware resolution of the caller for `paste`, which has no
 * `ctx.db` of its own (D115 6b-3). `ctx.runQuery` from an action propagates
 * the same request's `ctx.auth`, so `requireUserId` here resolves the same
 * user `getAuthUserId` used to, but also refuses a deleting/deleted account
 * with `requireUserId`'s own non-leaking message -- the bare `getAuthUserId`
 * this action used to call let a tombstoned caller keep pasting mail
 * (checkpoint 6b F3a).
 */
export const requireActiveUserId = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => requireUserId(ctx),
});

/**
 * Queues a pasted email for the same pipeline a forwarded one goes through.
 * The external id is the hash of the text (D14), so pasting the same email
 * twice returns the first row instead of re-extracting and re-crediting.
 */
export const paste = action({
  args: { text: v.string() },
  returns: v.id("processedEvents"),
  handler: async (ctx, { text }): Promise<Id<"processedEvents">> => {
    const userId = await ctx.runQuery(internal.intake.requireActiveUserId, {});
    // D142 / contract §7: masked BEFORE hashing, storing or the model call, so a card number never reaches any of them.
    const body = maskPans(text.trim());
    if (body.length < MIN_PASTE_CHARS) {
      throw new ConvexError("Paste the whole order or refund email, not just a line of it");
    }
    if (body.length > MAX_PASTE_CHARS) {
      throw new ConvexError("That email is too long to process");
    }

    // D54 / review LOW: the user is part of the hashed input, so the same
    // email pasted by two people is two events -- nobody learns what
    // somebody else pasted and nobody can pre-block an email for another
    // account.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${userId}\n${body}`));
    const externalId = `paste:${Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}`;

    return await ctx.runMutation(internal.intake.createPasteEvent, { userId, externalId, text: body });
  },
});

/**
 * Unauthenticated on purpose: only `paste` calls it, and it has already
 * resolved the caller from `ctx.auth`.
 */
export const createPasteEvent = internalMutation({
  args: { userId: v.id("users"), externalId: v.string(), text: v.string() },
  returns: v.id("processedEvents"),
  handler: async (ctx, args) => {
    // D115 6b-3: defense in depth alongside `paste`'s own gate above --
    // nothing has been inserted yet at this point, so refusing here throws
    // and writes no processedEvents row at all (checkpoint 6b F3a), rather
    // than the "mark succeeded" shape the other intake writers use once a
    // row already exists.
    if (await isTombstoned(ctx, args.userId)) {
      throw new ConvexError("This account has been deleted");
    }
    const seen = await ctx.db
      .query("processedEvents")
      .withIndex("by_external", (q) => q.eq("externalId", args.externalId))
      .first();
    // The hash is content-addressed, so a second paste of the same email by a
    // different user must not be handed somebody else's row.
    if (seen && seen.userId === args.userId) return seen._id;
    if (seen) throw new ConvexError("That email has already been processed");
    // Defense in depth: `paste` already masked; an internal caller must not be able to store an unmasked card number.
    const text = maskPans(args.text);
    if (text.length > MAX_PASTE_CHARS) throw new ConvexError("That email is too long to process");

    // B5: one new paste is one model call. Charged here, in the transaction that schedules it, and only for a
    // paste that is really new; throws at the daily cap with nothing written.
    await charge(ctx, args.userId, "paste");

    const processedEventId = await ctx.db.insert("processedEvents", {
      externalId: args.externalId,
      kind: "paste",
      status: "received",
      attempts: 0,
      userId: args.userId,
      route: "intake",
      payload: { subject: "", text, from: "", messageId: null },
    });
    await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId });
    return processedEventId;
  },
});

/** True when this intake event's email is already a purchase on the caller's board. */
async function alreadyProducedPurchase(
  ctx: MutationCtx,
  userId: Id<"users">,
  row: Doc<"processedEvents">,
): Promise<boolean> {
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  const sourceId =
    typeof payload.messageId === "string" ? payload.messageId : row.kind === "paste" ? row.externalId : undefined;
  if (sourceId === undefined) return false;
  const held = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PURCHASES_PER_USER);
  return held.some((p) => p.sourceMessageId === sourceId);
}

/**
 * Re-runs an event the caller owns that ended `failed` or `needs_review` (D14).
 *
 * Every re-run is another model call, so it is charged to the caller's daily `intake_retry` budget (B5).
 * `attempts` is never reset: a row that is out of attempts is granted exactly one more per (budgeted) click.
 */
export const retryEvent = mutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.null(),
  handler: async (ctx, { processedEventId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(processedEventId);
    if (!row || row.userId !== userId) throw new ConvexError("Event not found");
    if (row.status !== "failed" && row.status !== "needs_review") {
      throw new ConvexError("This event is not waiting on anything");
    }
    if (row.route === "reply") {
      // Re-read a merchant reply whose classification failed (review H2).
      const payload = row.payload as
        | { messageId?: unknown; from?: unknown; subject?: unknown; text?: unknown }
        | undefined;
      if (!row.claimId || typeof payload?.messageId !== "string") {
        throw new ConvexError("This event cannot be re-run");
      }
      await charge(ctx, userId, "intake_retry");
      await ctx.db.patch(processedEventId, {
        status: "processing",
        processingStartedAt: Date.now(),
        lastError: undefined,
      });
      await ctx.scheduler.runAfter(0, internal.replies.classify, {
        processedEventId,
        claimId: row.claimId,
        messageId: payload.messageId,
        from: typeof payload.from === "string" ? payload.from : "",
        subject: typeof payload.subject === "string" ? payload.subject : "",
        text: typeof payload.text === "string" ? payload.text : "",
      });
      return null;
    }
    if (row.route !== "intake") throw new ConvexError("This event cannot be re-run");
    // B5: `needs_review` is the NORMAL end of an order email. Re-reading one that already became a purchase
    // would pay for the model again and, with no orderRef, used to insert the purchase a second time.
    if (row.status === "needs_review" && (await alreadyProducedPurchase(ctx, userId, row))) {
      throw new ConvexError("This email is already on your board as a purchase; confirm it there");
    }

    await charge(ctx, userId, "intake_retry");
    await ctx.db.patch(processedEventId, {
      status: "received",
      lastError: undefined,
      summary: undefined,
      // Never back to 0 (B5). A human asked, so an exhausted row gets one more attempt, not five.
      attempts: Math.min(row.attempts, MAX_ATTEMPTS - 1),
    });
    await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId });
    return null;
  },
});

/**
 * SEC-AI-6 (D174): the user confirms a refund email that came from an unverified sender. Only the owner can, only
 * for an event holding such a candidate, and only once: the candidate is taken off the event in the same
 * transaction, then applied exactly as a verified refund would be (same idempotency keys, same D15 attribution rules,
 * same HC-10 currency refusal), with the ledger evidence noting the user confirmed it. A foreign or missing event →
 * the identical "Event not found".
 */
export const confirmRefundEmail = mutation({
  args: { processedEventId: v.id("processedEvents") },
  returns: v.object({ status: processedStatus, summary: v.union(v.string(), v.null()) }),
  handler: async (ctx, { processedEventId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(processedEventId);
    if (!row || row.userId !== userId) throw new ConvexError("Event not found");
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (row.route !== "intake" || row.status !== "needs_review" || payload.pendingRefund === undefined) {
      throw new ConvexError("This email has no refund waiting for your confirmation");
    }
    const refund = RefundCandidate.parse(payload.pendingRefund);
    const { pendingRefund: _taken, ...rest } = payload;
    await ctx.db.patch(processedEventId, { payload: rest });
    const sourceMessageId = typeof payload.messageId === "string" ? payload.messageId : undefined;
    await applyRefund(ctx, processedEventId, userId, sourceMessageId, sourceMessageId ?? row.externalId, refund, {
      verified: true,
      confirmedByUser: true,
    });
    const after = await ctx.db.get(processedEventId);
    return { status: after!.status, summary: after!.summary ?? null };
  },
});

/** How many failed or stuck rows one tick looks at; the rest wait for the next tick. */
const RETRY_PAGE = 50;
/** A row still `processing` after this long lost its action (timeout or redeploy); review M2. */
const STUCK_AFTER_MS = 15 * 60_000;
/**
 * D112 6a-2: scan window for the budget-paused round-robin below. Bounded
 * (never an unbounded scan), but wide enough that a single flooder's
 * backlog (the checkpoint's own DA repro: 60 rows from one user) does not
 * stop the scan from reaching an older row belonging to somebody else in
 * the same hourly pass.
 */
const BUDGET_PAUSE_SCAN_LIMIT = 300;
/**
 * D112 6a-2: rows the budget-paused round-robin below will retry (or close
 * as tombstoned) for any ONE user in a single pass. Combined with the
 * `RETRY_PAGE`-wide (50) total cap on the same loop, this is what makes the
 * pass round-robin instead of first-come: once a user's rows fill their
 * share, the scan moves on to the next user's rows in the same window
 * rather than spending the rest of the pass on that one user.
 */
const BUDGET_RETRY_PER_USER = 5;

/**
 * Hourly safety net for inbound mail (idea from origin's a2ceb98, rewritten for this pipeline).
 * Unauthenticated on purpose: the only caller is the cron. Bounded and idempotent:
 *  1. rows stuck in `processing` become `failed`, so they are visible and retryable. "Stuck" is measured from
 *     `processingStartedAt`, the moment the row last entered `processing` (review H5); `_creationTime` is only
 *     the fallback for rows written before that field existed. An old row a user re-ran a second ago is
 *     therefore left alone instead of being failed and scheduled a second time.
 *  2. `failed` rows with attempts left are re-run once. `beginEvent` counts intake attempts; reply re-runs are
 *     counted here.
 *  3. `failed` rows this job can never re-run LEAVE the `failed` page (review H4), because the page is the
 *     oldest 50 and rows that stay in it forever end up hiding every newer failure: a row out of attempts, or
 *     one with nothing to re-run, moves to `needs_review` (still on the owner's needs-attention list, where
 *     `retryEvent` can re-run it by hand); an ownerless row older than a day is closed as ignored.
 *  4. D76/Invariant 10, extended by D112 6a-2: `needs_review` rows `beginEvent`/`replies.classify` paused for
 *     the day (marked with `BUDGET_PAUSED_SUMMARY` or, for a per-user cap, `PER_USER_BUDGET_PAUSED_SUMMARY`;
 *     never `failed`) are re-run the same way, but WITHOUT touching `attempts` -- a budget refusal, per-user or
 *     global, is never counted as this row's own failed attempt to read the email. This pass is per-user
 *     round-robin (`BUDGET_RETRY_PER_USER`, `BUDGET_PAUSE_SCAN_LIMIT`): one user flooding the paused page with
 *     their own rows cannot crowd out another user's single paused row from the same hourly pass (checkpoint
 *     6a-2's DA repro: a 60-row flood must not starve a 1-row victim).
 */
export const retryFailed = internalMutation({
  args: {},
  returns: v.object({ unstuck: v.number(), retried: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let unstuck = 0;
    let retried = 0;

    const processing = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "processing"))
      .take(RETRY_PAGE);
    for (const row of processing) {
      if (now - (row.processingStartedAt ?? row._creationTime) < STUCK_AFTER_MS) continue;
      await ctx.db.patch(row._id, { status: "failed", lastError: "Timed out while being read" });
      unstuck++;
    }

    const failed = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(RETRY_PAGE);
    for (const row of failed) {
      if (!row.userId) {
        if (now - row._creationTime >= OWNERLESS_AFTER_MS) {
          await ctx.db.patch(row._id, { status: "succeeded", summary: "Ignored: no matching inbox" });
        }
        continue;
      }
      // D87 (D103): never spend a retry (a model call) on a user whose
      // account is being deleted, and leave the `failed` page the same way
      // the "out of attempts"/"nothing to re-run" branches below do --
      // otherwise a backlog of a tombstoned user's rows would occupy this
      // same bounded page on every tick, the same starvation shape F1/F2
      // fixed for the price/watch sweeps.
      if (await isTombstoned(ctx, row.userId)) {
        await ctx.db.patch(row._id, { status: "succeeded", summary: "Ignored: account deleted" });
        continue;
      }
      if (row.attempts >= MAX_ATTEMPTS) {
        await ctx.db.patch(row._id, {
          status: "needs_review",
          summary: `This email could not be read after ${MAX_ATTEMPTS} attempts. You can try it again by hand.`,
        });
        continue;
      }
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
      if (row.route === "intake") {
        await ctx.db.patch(row._id, { status: "received", lastError: undefined });
        await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId: row._id });
        retried++;
      } else if (row.route === "reply" && row.claimId && read("messageId")) {
        await ctx.db.patch(row._id, {
          status: "processing",
          processingStartedAt: now,
          lastError: undefined,
          attempts: row.attempts + 1,
        });
        await ctx.scheduler.runAfter(0, internal.replies.classify, {
          processedEventId: row._id,
          claimId: row.claimId,
          messageId: read("messageId"),
          from: read("from"),
          subject: read("subject"),
          text: read("text"),
        });
        retried++;
      } else {
        // Nothing here can be re-run (never routed, or a reply with no message id).
        await ctx.db.patch(row._id, {
          status: "needs_review",
          summary: row.summary ?? "This message could not be routed and cannot be re-read automatically.",
        });
      }
    }

    // D76/Invariant 10, point 4 above, extended by D112 6a-2: budget-paused
    // rows, picked up hourly and NOT charged against `attempts`. Newest
    // first within the scan window: a refusal is a same-day event, so the
    // rows worth unblocking first are the freshest -- but the per-user cap
    // below (`BUDGET_RETRY_PER_USER`) is what actually makes this pass
    // round-robin: once one user's rows fill their share of the pass, the
    // loop keeps scanning PAST their remaining rows to reach the next
    // user's, instead of a plain "take the newest 50" that a single
    // flooder's rows could fill entirely.
    const budgetPausedCandidates = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "needs_review"))
      .order("desc")
      .take(BUDGET_PAUSE_SCAN_LIMIT);
    const budgetRetriesByUser = new Map<Id<"users">, number>();
    let budgetRetried = 0;
    for (const row of budgetPausedCandidates) {
      if (budgetRetried >= RETRY_PAGE) break; // D112 6a-2: ≤ 50 total for this pass.
      const isBudgetPause = row.summary === BUDGET_PAUSED_SUMMARY || row.summary === PER_USER_BUDGET_PAUSED_SUMMARY;
      if (!isBudgetPause || !row.userId) continue;
      const usedByUser = budgetRetriesByUser.get(row.userId) ?? 0;
      if (usedByUser >= BUDGET_RETRY_PER_USER) continue; // this user's share is full; keep scanning for others.

      if (await isTombstoned(ctx, row.userId)) {
        await ctx.db.patch(row._id, { status: "succeeded", summary: "Ignored: account deleted" });
        budgetRetriesByUser.set(row.userId, usedByUser + 1);
        continue;
      }
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
      if (row.route === "intake") {
        await ctx.db.patch(row._id, { status: "received", summary: undefined });
        await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId: row._id });
        retried++;
        budgetRetried++;
        budgetRetriesByUser.set(row.userId, usedByUser + 1);
      } else if (row.route === "reply" && row.claimId && read("messageId")) {
        await ctx.db.patch(row._id, { status: "processing", processingStartedAt: now, summary: undefined });
        await ctx.scheduler.runAfter(0, internal.replies.classify, {
          processedEventId: row._id,
          claimId: row.claimId,
          messageId: read("messageId"),
          from: read("from"),
          subject: read("subject"),
          text: read("text"),
        });
        retried++;
        budgetRetried++;
        budgetRetriesByUser.set(row.userId, usedByUser + 1);
      }
      // Else: nothing to re-run. Neither writer of a budget-paused summary
      // marks a row this way without a runnable route/payload, so this is
      // unreached in practice; left as a no-op rather than an assertion.
    }

    return { unstuck, retried };
  },
});

/**
 * One row of the needs-attention list: the `processedEvents` document WITHOUT `payload` (review M5). The payload
 * holds the whole email, up to 60 KB a row, and nothing on screen reads it.
 *
 * T16 (docs/reviews/2026-09-21-phase0-reproduction.md's phase-0 finding,
 * convex/intake.ts:847/877, convex/intake.test.ts:900-913): `lastError` was
 * ALSO still in this shape and the handler spread it straight through --
 * the payload-only redaction below never actually stripped it. `lastError`
 * is server-side only from here on; `errorSummary` (D58's `sanitizeError`)
 * is the only thing a caller ever sees.
 */
const attentionRow = v.object({
  _id: v.id("processedEvents"),
  _creationTime: v.number(),
  externalId: v.string(),
  kind: v.string(),
  status: processedStatus,
  attempts: v.number(),
  /**
   * T16: kept in the shape (frontend code reads `event.lastError` as a
   * fallback display string, out of this task's `src/**` scope to touch)
   * but the handler below never populates it any more -- always `undefined`
   * on the wire, never the raw error. `errorSummary` is the real field now.
   */
  lastError: v.optional(v.string()),
  errorSummary: v.optional(v.string()),
  userId: v.optional(v.id("users")),
  claimId: v.optional(v.id("claims")),
  route: v.optional(processedRoute),
  summary: v.optional(v.string()),
});

/**
 * The board's "needs attention" list (D14): every inbound message or paste of
 * the caller's that could not be finished on its own.
 */
export const needsAttention = query({
  args: {},
  returns: v.array(attentionRow),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const statuses = ["failed", "needs_review"] as const;
    const pages = await Promise.all(
      statuses.map((status) =>
        ctx.db
          .query("processedEvents")
          .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
          .order("desc")
          .take(ATTENTION_LIMIT),
      ),
    );
    return pages
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .map(({ payload: _payload, processingStartedAt: _startedAt, lastError, errorSummary, ...row }) => ({
        ...row,
        // T16: never the raw `lastError` -- a row written before D58 (or by
        // a direct db.patch, e.g. in a test) may carry a `lastError` with no
        // `errorSummary` yet; sanitize it here rather than let it through.
        // `lastError` is spelled out (always `undefined`) only so the
        // `attentionRow` validator's field is reflected in this query's
        // inferred client type -- Convex drops `undefined`-valued keys on
        // the wire, so it never actually serializes.
        lastError: undefined,
        errorSummary: errorSummary ?? (lastError !== undefined ? sanitizeError(lastError) : undefined),
      }));
  },
});
