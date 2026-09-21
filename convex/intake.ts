import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
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
import { normalizeDomain } from "./lib/policyText";
import { assertPositiveCents, toCents } from "./lib/money";
import { sanitizeError } from "./lib/errors";
import { applyEvent, openClaim } from "./claims";
import { parseProductUrl } from "./lib/watchUrl";
import { cleanLine } from "./lib/text";
import { charge, tryConsumeGlobalBudget } from "./lib/budget";
import { isTombstoned } from "./lib/accountState";
import { GLOBAL_DAILY_BUDGETS, MAX_ITEMS_PER_PURCHASE, MAX_PURCHASES_PER_USER } from "./limits";

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
 * D76: the shared `inbound_extract` global switch -- one unit per model call
 * that reads an inbound email, whether from `processEvent` (a fresh order/
 * refund) or `replies.classify` (a merchant reply). Global-only (no per-user
 * counterpart in `DAILY_BUDGETS`): `GLOBAL_DAILY_BUDGETS.inbound_extract`.
 */
export async function reserveInboundExtractBudget(ctx: MutationCtx, now: number = Date.now()): Promise<boolean> {
  return tryConsumeGlobalBudget(ctx, "inbound_extract", GLOBAL_DAILY_BUDGETS.inbound_extract.max, 1, now);
}

/** `replies.classify` runs in an action and has no `ctx.db` of its own; this is its way to call the helper above. */
export const reserveInboundExtract = internalMutation({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => reserveInboundExtractBudget(ctx),
});

/** Moves a `processing` reply-classification row back to `needs_review` after a budget refusal, for `replies.classify`. */
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
  const ms = Date.parse(iso);
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
    if (row.attempts >= MAX_ATTEMPTS) {
      const lastError = `Gave up after ${MAX_ATTEMPTS} attempts`;
      await ctx.db.patch(processedEventId, {
        status: "failed",
        lastError,
        errorSummary: sanitizeError(lastError), // D58
      });
      return null;
    }
    // D76/Invariant 10: checked BEFORE `processing`/attempts, so a day the
    // deployment-wide switch is out never counts against this row's own
    // MAX_ATTEMPTS -- it is not this email's fault. `needs_review`, not
    // `failed`: `retryFailed`'s dedicated pass below picks it back up hourly.
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
    const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
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

/**
 * An extracted order becomes a `needs_review` purchase (D25): the user
 * confirms merchant, date and every line item before anything is scraped or
 * claimed. A repeat of an order we already hold is refused outright (D22).
 */
async function applyOrder(
  ctx: MutationCtx,
  processedEventId: Id<"processedEvents">,
  userId: Id<"users">,
  sourceMessageId: string | undefined,
  order: NonNullable<InboundEmailT["order"]>,
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
  const purchaseId = await ctx.db.insert("purchases", {
    userId,
    merchant: cleanLine(order.merchant).slice(0, 120) || merchantDomain,
    merchantDomain,
    orderRef,
    purchasedAt: safeDate(order.purchasedAt),
    currency: currency ?? "USD",
    sourceMessageId,
    // D25: extraction never produces an active purchase.
    status: "needs_review",
  });
  for (const it of items) {
    await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: it.name,
      unitCents: it.unitCents,
      qty: it.qty,
      productUrl: it.productUrl,
      // D15: only the user ever marks an item returned.
      returned: false,
    });
  }

  const note = currency ? "" : ` Currency was unclear, assumed USD.`;
  const skippedNote =
    skipped.length > 0 ? ` Could not read ${skipped.join(", ")} — add ${skipped.length === 1 ? "it" : "them"} manually if needed.` : "";
  await finish(
    ctx,
    processedEventId,
    "needs_review",
    `Order from ${cleanLine(order.merchant).slice(0, 120) || merchantDomain} with ${items.length} item${items.length === 1 ? "" : "s"} — confirm the details to start tracking it.${note}${skippedNote}`,
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
 */
async function applyRefund(
  ctx: MutationCtx,
  processedEventId: Id<"processedEvents">,
  userId: Id<"users">,
  sourceMessageId: string | undefined,
  messageIdOrPasteHash: string,
  refund: NonNullable<InboundEmailT["refund"]>,
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
    const currency = safeCurrency(credit.currency) ?? purchase.currency;
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
    try {
      await applyEvent(
        ctx,
        claim,
        "promised_credit",
        cents,
        `Merchant email says the refund is ${credit.state} (${sourceMessageId ?? "pasted email"})`,
        `${messageIdOrPasteHash}:${item._id}:${i}`,
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
    const parsed: InboundEmailT = InboundEmail.parse(args.parsed);
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const sourceMessageId =
      typeof payload.messageId === "string" ? payload.messageId : undefined;
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
      await applyOrder(ctx, args.processedEventId, row.userId, orderSourceId, parsed.order);
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
 * Queues a pasted email for the same pipeline a forwarded one goes through.
 * The external id is the hash of the text (D14), so pasting the same email
 * twice returns the first row instead of re-extracting and re-crediting.
 */
export const paste = action({
  args: { text: v.string() },
  returns: v.id("processedEvents"),
  handler: async (ctx, { text }): Promise<Id<"processedEvents">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const body = text.trim();
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
    const seen = await ctx.db
      .query("processedEvents")
      .withIndex("by_external", (q) => q.eq("externalId", args.externalId))
      .first();
    // The hash is content-addressed, so a second paste of the same email by a
    // different user must not be handed somebody else's row.
    if (seen && seen.userId === args.userId) return seen._id;
    if (seen) throw new ConvexError("That email has already been processed");
    if (args.text.length > MAX_PASTE_CHARS) throw new ConvexError("That email is too long to process");

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
      payload: { subject: "", text: args.text, from: "", messageId: null },
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

/** How many failed or stuck rows one tick looks at; the rest wait for the next tick. */
const RETRY_PAGE = 50;
/** A row still `processing` after this long lost its action (timeout or redeploy); review M2. */
const STUCK_AFTER_MS = 15 * 60_000;

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
 *  4. D76/Invariant 10: `needs_review` rows `beginEvent`/`replies.classify` paused for the day (marked with
 *     `BUDGET_PAUSED_SUMMARY`, never `failed`) are re-run the same way, but WITHOUT touching `attempts` -- a
 *     global-budget refusal is never counted as this row's own failed attempt to read the email.
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

    // D76/Invariant 10, point 4 above: budget-paused rows, picked up hourly
    // and NOT charged against `attempts`. Newest first: a refusal is a
    // same-day event, so the rows worth unblocking first are the freshest.
    const budgetPaused = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "needs_review"))
      .order("desc")
      .take(RETRY_PAGE);
    for (const row of budgetPaused) {
      if (row.summary !== BUDGET_PAUSED_SUMMARY || !row.userId) continue;
      if (await isTombstoned(ctx, row.userId)) {
        await ctx.db.patch(row._id, { status: "succeeded", summary: "Ignored: account deleted" });
        continue;
      }
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      const read = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : "");
      if (row.route === "intake") {
        await ctx.db.patch(row._id, { status: "received", summary: undefined });
        await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId: row._id });
        retried++;
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
      }
      // Else: nothing to re-run. Neither writer of BUDGET_PAUSED_SUMMARY marks a
      // row this way without a runnable route/payload, so this is unreached in
      // practice; left as a no-op rather than an assertion.
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
