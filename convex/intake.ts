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
import schema from "./schema";
import { requireUserId } from "./lib/access";
import { extract } from "./lib/ai";
import { InboundEmail, type InboundEmailT } from "./lib/schemas";
import { normalizeDomain } from "./lib/policyText";
import { applyEvent, openClaim } from "./claims";

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

const processedDoc = schema.doc("processedEvents");

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
      await ctx.db.patch(processedEventId, {
        status: "failed",
        lastError: `Gave up after ${MAX_ATTEMPTS} attempts`,
      });
      return null;
    }
    await ctx.db.patch(processedEventId, {
      status: "processing",
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
    await ctx.db.patch(args.processedEventId, {
      status: "failed",
      lastError: args.lastError.slice(0, MAX_ERROR_CHARS),
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

  const orderRef = order.orderRef?.trim() || undefined;
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
  for (const it of order.items) {
    const unitCents = safeCents(it.unitPrice);
    const qty = safeQty(it.qty);
    const name = it.name.trim().slice(0, 200);
    if (unitCents === null || qty === null || name.length === 0) continue;
    items.push({
      name,
      unitCents,
      qty,
      productUrl: it.productUrl?.startsWith("http") ? it.productUrl.slice(0, 2_000) : undefined,
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
    merchant: order.merchant.trim().slice(0, 120) || merchantDomain,
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
  await finish(
    ctx,
    processedEventId,
    "needs_review",
    `Order from ${order.merchant.trim() || merchantDomain} with ${items.length} item${items.length === 1 ? "" : "s"} — confirm the details to start tracking it.${note}`,
  );
}

/**
 * Finds the purchase a refund email is about. Exact `orderRef` wins; failing
 * that the merchant name must identify exactly one purchase, because guessing
 * would attach a credit to the wrong order's ledger.
 */
async function matchPurchase(
  ctx: MutationCtx,
  userId: Id<"users">,
  refund: NonNullable<InboundEmailT["refund"]>,
): Promise<Doc<"purchases"> | null> {
  const purchases = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(PURCHASE_SCAN_LIMIT);

  const ref = refund.orderRef?.trim();
  if (ref) {
    const byRef = purchases.filter((p) => p.orderRef && norm(p.orderRef) === norm(ref));
    if (byRef.length === 1) return byRef[0];
  }
  const merchant = refund.merchant?.trim();
  if (merchant) {
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
    const cents = safeCents(credit.amount);
    if (cents === null || cents === 0) {
      unmatched.push("A credit with an unreadable amount");
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
      });
      claim = await ctx.db.get(claimId);
    }
    if (!claim) continue;

    await applyEvent(
      ctx,
      claim,
      "promised_credit",
      cents,
      `Merchant email says the refund is ${credit.state} (${sourceMessageId ?? "pasted email"})`,
      `intake:${processedEventId}:${i}`,
    );
    applied++;
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

    if (parsed.kind === "order" && parsed.order) {
      await applyOrder(ctx, args.processedEventId, row.userId, sourceMessageId, parsed.order);
      return null;
    }
    if (parsed.kind === "refund" && parsed.refund) {
      await applyRefund(ctx, args.processedEventId, row.userId, sourceMessageId, parsed.refund);
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

    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
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

/** Re-runs an event the caller owns that ended `failed` or `needs_review` (D14). */
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
      await ctx.db.patch(processedEventId, { status: "processing", lastError: undefined });
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

    await ctx.db.patch(processedEventId, {
      status: "received",
      lastError: undefined,
      summary: undefined,
      // A retry starts a fresh budget; the row is only here because a human asked.
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, internal.intake.processEvent, { processedEventId });
    return null;
  },
});

/**
 * The board's "needs attention" list (D14): every inbound message or paste of
 * the caller's that could not be finished on its own.
 */
export const needsAttention = query({
  args: {},
  returns: v.array(processedDoc),
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
    return pages.flat().sort((a, b) => b._creationTime - a._creationTime);
  },
});
