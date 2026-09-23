import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import schema, { transactionStatus } from "./schema";
import { MAX_MERCHANT_CHARS, MAX_TRANSACTIONS_PER_USER } from "./limits";
import { ownedPurchase, ownedTransaction, requireUserId } from "./lib/access";
import { isTombstoned } from "./lib/accountState";
import type { FactValue } from "./lib/facts/catalog";
import { putFact } from "./lib/facts/write";
import { assertTimestamp, assertUserMoney, currencyExponent } from "./lib/money";
import { maskPans } from "./lib/pan";
import { boundedLine, meaningfulName } from "./lib/text";
import { evaluateTransaction } from "./opportunities";

/**
 * The fields a retail transaction mirrors from its purchase (contract §2.2). Everything else on the row
 * (`liveFactCount`, `relatedTransactionId`, `sourceEvidenceId`, `naturalKey`) is owned by other writers and never
 * touched here.
 */
function mirror(purchase: Doc<"purchases">) {
  return {
    status: purchase.status,
    counterpartyName: purchase.merchant,
    counterpartyDomain: purchase.merchantDomain,
    currency: purchase.currency,
    transactedAt: purchase.purchasedAt,
    // DA-A-35: an example purchase's transaction is an example too, so every summary that reads transactions (or
    // anything keyed on them) can exclude it without joining back to `purchases`. Only `true` is copied, so a real
    // purchase's row never carries the field at all.
    isExample: purchase.isExample === true ? (true as const) : undefined,
  };
}

/**
 * The category-neutral parent of a retail purchase (contract §2.2): idempotent, 1:1 through
 * `transactions.by_purchase`. Concurrent callers serialize under OCC because each one reads the same index range
 * before inserting, so at most one row is ever created (CT-3). An existing row is re-synced to the purchase's current
 * status, merchant, currency and date, so calling this from every insert AND confirm path keeps the mirror current.
 *
 * Must be called from every `insert("purchases"` site (DA-A-35; `transactions.test.ts` enumerates them) and from
 * `purchases.confirm`/`remove`. Takes no userId: the purchase row is the authority on ownership, and every caller has
 * already authorised the purchase (or just inserted it).
 */
export async function ensurePurchaseTransaction(
  ctx: MutationCtx,
  purchaseId: Id<"purchases">,
): Promise<Id<"transactions">> {
  const purchase = await ctx.db.get(purchaseId);
  if (!purchase) throw new ConvexError("Purchase not found");
  const fields = mirror(purchase);
  const existing = await ctx.db
    .query("transactions")
    .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
    .first();
  if (existing) {
    const changed =
      existing.status !== fields.status ||
      existing.counterpartyName !== fields.counterpartyName ||
      existing.counterpartyDomain !== fields.counterpartyDomain ||
      existing.currency !== fields.currency ||
      existing.transactedAt !== fields.transactedAt ||
      existing.isExample !== fields.isExample;
    if (changed) await ctx.db.patch(existing._id, fields);
    return existing._id;
  }
  return await ctx.db.insert("transactions", {
    userId: purchase.userId,
    category: "retail_order",
    purchaseId,
    liveFactCount: 0,
    ...fields,
  });
}

/** Transactions one `list` call returns, newest first; `truncated` says more exist. */
export const LIST_LIMIT = 100;

/**
 * The caller's transactions in one status (default `active`), newest first, at most `LIST_LIMIT`
 * (`transactions.by_user_and_status`, one bounded range). Example transactions are included and carry `isExample`.
 */
export const list = query({
  args: { status: v.optional(transactionStatus) },
  returns: v.object({ transactions: v.array(schema.doc("transactions")), truncated: v.boolean() }),
  handler: async (ctx, { status }) => {
    const userId = await requireUserId(ctx);
    const page = await ctx.db
      .query("transactions")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", status ?? "active"))
      .order("desc")
      .take(LIST_LIMIT + 1);
    return { transactions: page.slice(0, LIST_LIMIT), truncated: page.length > LIST_LIMIT };
  },
});

/** One of the caller's transactions. A foreign or missing id → the same "Transaction not found" (one read). */
export const get = query({
  args: { transactionId: v.id("transactions") },
  returns: schema.doc("transactions"),
  handler: async (ctx, { transactionId }) => {
    const userId = await requireUserId(ctx);
    return await ownedTransaction(ctx, transactionId, userId);
  },
});

/**
 * The transaction mirroring one of the caller's purchases, or null when none exists yet (a purchase created before
 * wave 1 gets one on its next confirm or evaluation — queries never write). A foreign or missing purchase → the same
 * "Purchase not found".
 */
export const forPurchase = query({
  args: { purchaseId: v.id("purchases") },
  returns: v.union(schema.doc("transactions"), v.null()),
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, purchaseId, userId);
    const txn = await ctx.db
      .query("transactions")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .first();
    // Defence in depth: the mirror always carries the purchase's owner, but never return a row the caller does not own.
    return txn !== null && txn.userId === userId ? txn : null;
  },
});

// ---------------------------------------------------------------------------
// Manual entry (contract §7 wave 2; D220/D221)
// ---------------------------------------------------------------------------

/** The furthest-ahead civil time on Earth is UTC+14: a calendar date after that "today" is in the future everywhere. */
const LATEST_OFFSET_MS = 14 * 3_600_000;

/** A real calendar date "YYYY-MM-DD", not in the future anywhere. A local date is never derived from an instant. */
function localDateNotAfterToday(date: string, now: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : Number.NaN;
  if (!m || !Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== date || Number(m[1]) < 1900) {
    throw new ConvexError("transactedOn must be a calendar date (YYYY-MM-DD)");
  }
  const latestToday = new Date(now + LATEST_OFFSET_MS).toISOString().slice(0, 10);
  if (date > latestToday) throw new ConvexError("transactedOn must not be in the future");
  return date;
}

/**
 * The facts a manual entry states, all `user_confirmed` from the user (shown as "your entry"; SEC-MF-4 caps the typed
 * amount in `putFact`). Only keys whose meaning the form's fields match exactly (D220/D221):
 *   air_travel  → `air.total_paid` (the ticket's total). The counterparty stays on the row only: it may be the
 *                 airline or a travel agency, and which one is a separate question (`air.merchant_of_record`).
 *   card_charge → `card.merchant_descriptor`, `card.charge_amount`, and `card.charge_date` from `transactedOn` alone.
 */
function manualFacts(
  category: "air_travel" | "card_charge",
  entry: { counterpartyName: string; total: { amountMinor: number; currency: string } | null; transactedOn: string | null },
): { key: string; value: FactValue }[] {
  const money = entry.total ? ({ kind: "money", amountMinor: entry.total.amountMinor, currency: entry.total.currency } as const) : null;
  if (category === "air_travel") return money ? [{ key: "air.total_paid", value: money }] : [];
  return [
    { key: "card.merchant_descriptor", value: { kind: "text", text: entry.counterpartyName } },
    ...(money ? [{ key: "card.charge_amount", value: money }] : []),
    ...(entry.transactedOn ? [{ key: "card.charge_date", value: { kind: "local_date" as const, date: entry.transactedOn } }] : []),
  ];
}

/**
 * `transactions.createManual` (contract §7 "Manual entry", wave 2; D220): the user records a flight or a card charge
 * by hand. Creates one owned, active transaction of that category and writes the entered values as `user_confirmed`
 * facts (source `user`, "your entry") through the single fact writer (`lib/facts/write.ts putFact`, O2). Retail
 * orders stay on `purchases.create`.
 *
 * Validation, all before the first write: signed in and not deleted; `counterpartyName` one clean line of at most
 * `MAX_MERCHANT_CHARS` with a letter or digit, card numbers masked (D142, never refused); `currency` one this path
 * admits (USD for new scenarios, O6); `totalMinor` integer minor units, not negative, not unsafe, at most the typed-
 * amount cap (`assertUserMoney`, SEC-MF-4); `transactedAt` a valid time clamped to now (QA-M16-4, as
 * `watches.purchasedAtNotAfterNow`); `transactedOn` a real calendar date not in the future — the ONLY source of
 * `card.charge_date` (D221). At most `MAX_TRANSACTIONS_PER_USER` transactions per user, archived included.
 * Then the transaction is evaluated (no pack is active for these categories yet, so today that writes nothing).
 */
export const createManual = mutation({
  args: {
    category: v.union(v.literal("air_travel"), v.literal("card_charge")),
    counterpartyName: v.string(),
    currency: v.string(),
    totalMinor: v.optional(v.number()),
    transactedAt: v.optional(v.number()),
    transactedOn: v.optional(v.string()),
  },
  returns: v.id("transactions"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if (await isTombstoned(ctx, userId)) throw new ConvexError("This account has been deleted");
    const now = Date.now();

    const name = meaningfulName(boundedLine(args.counterpartyName, "counterpartyName", MAX_MERCHANT_CHARS));
    if (name === null) throw new ConvexError("counterpartyName must name the airline, agency or merchant");
    const counterpartyName = maskPans(name);
    if (currencyExponent(args.currency, "new_scenario") === null) {
      throw new ConvexError(`Recoup records flights and card charges in USD only for now; ${args.currency.slice(0, 8)} is not supported`);
    }
    const total = args.totalMinor === undefined ? null : assertUserMoney({ amountMinor: args.totalMinor, currency: args.currency }, "new_scenario", "totalMinor");
    // QA-M16-4 / M15d `watches.purchasedAtNotAfterNow`, inlined (watches.ts imports this module): a valid user
    // timestamp (at most a day ahead, else refused), clamped to now.
    const transactedAt = args.transactedAt === undefined ? undefined : Math.min(assertTimestamp(args.transactedAt, "transactedAt", now), now);
    const transactedOn = args.transactedOn === undefined ? null : localDateNotAfterToday(args.transactedOn, now);

    const held = await ctx.db
      .query("transactions")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
      .take(MAX_TRANSACTIONS_PER_USER);
    if (held.length >= MAX_TRANSACTIONS_PER_USER) {
      throw new ConvexError(`You can keep up to ${MAX_TRANSACTIONS_PER_USER} flights, orders and charges`);
    }

    const transactionId = await ctx.db.insert("transactions", {
      userId,
      category: args.category,
      status: "active",
      counterpartyName,
      currency: args.currency,
      ...(total !== null ? { totalMinor: total.amountMinor } : {}),
      ...(transactedAt !== undefined ? { transactedAt } : {}),
      liveFactCount: 0,
    });
    for (const f of manualFacts(args.category, { counterpartyName, total, transactedOn })) {
      await putFact(ctx, userId, { transactionId, subjectKey: "txn", key: f.key, state: "user_confirmed", value: f.value, source: { kind: "user" } });
    }
    await evaluateTransaction(ctx, transactionId, "fact_change", now);
    return transactionId;
  },
});
