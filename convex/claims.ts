import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema, { claimStatus, eventKind } from "./schema";
import { ownedClaim, ownedItem, requireUserId } from "./lib/access";
import { assertCents, assertPositiveCents } from "./lib/money";
import { newToken, statusAfterEvent, type EventKind } from "./lib/ledger";
import { balanceValidator, claimBalance, claimEvents } from "./lib/balance";
import { cancelPending, reminderFireAt, scheduleReminder } from "./followUps";

const claimWithBalance = v.object({
  ...schema.doc("claims").fields,
  balance: balanceValidator,
});

const applyResult = v.object({ deduped: v.boolean(), status: claimStatus });

/** Statuses that still count as "open" when refusing a duplicate claim. */
const CLOSED_STATUSES: ReadonlyArray<Doc<"claims">["status"]> = ["confirmed", "dismissed"];

/** How many times `openClaim` retries a token collision before giving up (D23). */
const TOKEN_ATTEMPTS = 20;

/**
 * A globally unique claim token (D23). Reply routing falls back to the token
 * in the subject line, so a collision would hand one user's reply to another
 * user's claim; loop until the token is unused rather than trusting entropy.
 */
async function uniqueToken(ctx: MutationCtx): Promise<string> {
  for (let i = 0; i < TOKEN_ATTEMPTS; i++) {
    const token = newToken();
    const clash = await ctx.db
      .query("claims")
      .withIndex("by_token", (q) => q.eq("token", token))
      .first();
    if (!clash) return token;
  }
  throw new ConvexError("Could not allocate a unique claim token");
}

/**
 * Opens a claim. Not a registered function: it takes a `userId` and is
 * unauthenticated on purpose. Callers are the public `open` mutation below
 * (which resolves identity from `ctx.auth`) and `priceWatch.recordCheck`,
 * which opens price claims on the owner's behalf.
 *
 * Every related id is re-checked against the owner and against the purchase
 * (D19): a policy must belong to the same user and merchant domain, and a
 * price check must be an observation of this very item.
 */
export async function openClaim(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    itemId: Id<"items">;
    type: "price_adjustment" | "return_credit";
    expectedCents: number;
    windowEndsAt?: number;
    policyId?: Id<"policies">;
    openedFromPriceCheckId?: Id<"priceChecks">;
  },
): Promise<Id<"claims">> {
  assertPositiveCents(args.expectedCents, "expectedCents");

  const item = await ctx.db.get(args.itemId);
  if (!item || item.userId !== args.userId) throw new ConvexError("Item not found");
  const purchase = await ctx.db.get(item.purchaseId);
  if (!purchase || purchase.userId !== args.userId) throw new ConvexError("Purchase not found");

  if (args.policyId) {
    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.userId !== args.userId) throw new ConvexError("Policy not found");
    if (policy.merchantDomain !== purchase.merchantDomain) {
      throw new ConvexError("Policy is for a different merchant");
    }
  }
  if (args.openedFromPriceCheckId) {
    const check = await ctx.db.get(args.openedFromPriceCheckId);
    if (!check || check.userId !== args.userId) throw new ConvexError("Price check not found");
    if (check.itemId !== args.itemId) throw new ConvexError("Price check is for a different item");
  }

  const existing = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
    .collect();
  if (existing.some((c) => c.type === args.type && !CLOSED_STATUSES.includes(c.status))) {
    throw new ConvexError("An open claim of this type already exists for this item");
  }

  return await ctx.db.insert("claims", {
    purchaseId: item.purchaseId,
    itemId: args.itemId,
    userId: args.userId,
    type: args.type,
    expectedCents: args.expectedCents,
    status: "detected",
    windowEndsAt: args.windowEndsAt,
    policyId: args.policyId,
    openedFromPriceCheckId: args.openedFromPriceCheckId,
    token: await uniqueToken(ctx),
    version: 1,
    isExample: purchase.isExample,
  });
}

/**
 * Opens a return-credit claim on one item (D20). The client never states the
 * amount: the expected credit is derived server-side from the stored unit
 * price and quantity, less an optional restocking or return-label fee, so a
 * caller cannot inflate what the merchant supposedly owes. Price-adjustment
 * claims are opened only by `priceWatch.recordCheck`, never from the client.
 */
export const open = mutation({
  args: { itemId: v.id("items"), feeCents: v.optional(v.number()) },
  returns: v.id("claims"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ownedItem(ctx, args.itemId, userId);
    const fee = args.feeCents === undefined ? 0 : assertCents(args.feeCents, "feeCents");
    const expectedCents = item.unitCents * item.qty - fee;
    if (expectedCents <= 0) throw new ConvexError("Fee is not smaller than the item total");
    return await openClaim(ctx, {
      userId,
      itemId: args.itemId,
      type: "return_credit",
      expectedCents,
    });
  },
});

/**
 * Appends one fact to the append-only ledger and moves the claim's status to
 * whatever that fact implies (`lib/ledger.statusAfterEvent`). Duplicate
 * delivery is a no-op: `idempotencyKey` is namespaced by claim so one
 * client-supplied key can never dedupe an event on somebody else's claim.
 */
export async function applyEvent(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  kind: EventKind,
  cents: number,
  evidence: string,
  idempotencyKey?: string,
): Promise<{ deduped: boolean; status: Doc<"claims">["status"] }> {
  assertCents(cents, `${kind} cents`);
  const scopedKey = idempotencyKey ? `${claim._id}:${idempotencyKey}` : undefined;
  if (scopedKey) {
    const dup = await ctx.db
      .query("ledgerEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", scopedKey))
      .first();
    if (dup) return { deduped: true, status: claim.status };
  }

  await ctx.db.insert("ledgerEvents", {
    claimId: claim._id,
    userId: claim.userId,
    kind,
    cents,
    evidence,
    idempotencyKey: scopedKey,
  });
  const b = await claimBalance(ctx, claim);
  const status = statusAfterEvent(claim.status, kind, b);
  const patch: Partial<Doc<"claims">> = { status, version: claim.version + 1 };
  if (status === "confirmed") {
    await cancelPending(ctx, claim._id);
    patch.attentionAt = undefined;
  }
  await ctx.db.patch(claim._id, patch);
  return { deduped: false, status };
}

/**
 * Unauthenticated on purpose: callers are `replies.classify` (a merchant
 * promise extracted from inbound mail) and the intake pipeline, which have
 * already resolved the owning user from the inbox. `userId` is re-checked
 * against the claim here so a wrong pairing writes nothing.
 */
export const applyEventInternal = internalMutation({
  args: {
    claimId: v.id("claims"),
    userId: v.id("users"),
    kind: eventKind,
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: applyResult,
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    return await applyEvent(ctx, claim, args.kind, args.cents, args.evidence, args.idempotencyKey);
  },
});

/**
 * The only way money becomes `confirmed` (Inv 3): the user saw the credit on
 * a statement. `idempotencyKey` is required (D24) because a double-submitted
 * form would otherwise confirm the same credit twice and settle a claim that
 * is still half owed.
 */
export const confirmCredit = mutation({
  args: {
    claimId: v.id("claims"),
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.string(),
  },
  returns: applyResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertPositiveCents(args.cents, "cents");
    return await applyEvent(
      ctx,
      claim,
      "confirmed_credit",
      args.cents,
      args.evidence,
      args.idempotencyKey,
    );
  },
});

/** A merchant clawback after the credit landed. Same idempotency rule (D24). */
export const recordLaterDebit = mutation({
  args: {
    claimId: v.id("claims"),
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.string(),
  },
  returns: applyResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertPositiveCents(args.cents, "cents");
    return await applyEvent(
      ctx,
      claim,
      "later_debit",
      args.cents,
      args.evidence,
      args.idempotencyKey,
    );
  },
});

/**
 * Corrects what we think the merchant owes. This is bookkeeping, not money
 * moving, so it writes a `claimNotes` row and never a ledger event (D24).
 * Bumping the version invalidates any draft the user already approved but
 * that has not left the outbox, and cancels reminders tied to the old amount.
 */
export const adjustExpected = mutation({
  args: { claimId: v.id("claims"), expectedCents: v.number(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertPositiveCents(args.expectedCents, "expectedCents");

    await ctx.db.patch(claim._id, {
      expectedCents: args.expectedCents,
      version: claim.version + 1,
    });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "expected_change",
      text: args.reason,
      oldCents: claim.expectedCents,
      newCents: args.expectedCents,
    });
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .collect();
    for (const d of drafts) {
      if (d.approvedAt && !d.outboundId) await ctx.db.patch(d._id, { approvedAt: undefined });
    }
    await cancelPending(ctx, claim._id);
    return null;
  },
});

export const dismiss = mutation({
  args: { claimId: v.id("claims"), reason: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    await cancelPending(ctx, claim._id);
    await ctx.db.patch(claim._id, {
      status: "dismissed",
      version: claim.version + 1,
      attentionAt: undefined,
    });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "status",
      text: args.reason ?? "Dismissed",
    });
    return null;
  },
});

/** Clears the "needs attention" flag a fired follow-up set (D03, D28). */
export const clearAttention = mutation({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    await ownedClaim(ctx, claimId, userId);
    await ctx.db.patch(claimId, { attentionAt: undefined });
    return null;
  },
});

/**
 * Schedules the reminder for a claim the user has chased (D26, D28). Not a
 * registered function: `drafts.reconcileSend` calls it once a send is
 * confirmed, which is the only moment a reminder makes sense.
 */
export async function scheduleClaimReminder(ctx: MutationCtx, claim: Doc<"claims">) {
  await scheduleReminder(ctx, claim, await reminderFireAt(ctx, claim));
}

export const get = query({
  args: { claimId: v.id("claims") },
  returns: v.object({
    claim: schema.doc("claims"),
    item: v.union(schema.doc("items"), v.null()),
    purchase: v.union(schema.doc("purchases"), v.null()),
    events: v.array(schema.doc("ledgerEvents")),
    notes: v.array(schema.doc("claimNotes")),
    drafts: v.array(schema.doc("drafts")),
    replies: v.array(schema.doc("replies")),
    followUps: v.array(schema.doc("followUps")),
    policy: v.union(schema.doc("policies"), v.null()),
    balance: balanceValidator,
  }),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    const events = await claimEvents(ctx, claimId);
    return {
      claim,
      item: await ctx.db.get(claim.itemId),
      purchase: await ctx.db.get(claim.purchaseId),
      events,
      notes: await ctx.db
        .query("claimNotes")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
      drafts: await ctx.db
        .query("drafts")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .order("desc")
        .collect(),
      replies: await ctx.db
        .query("replies")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
      followUps: await ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
      policy: claim.policyId ? await ctx.db.get(claim.policyId) : null,
      balance: await claimBalance(ctx, claim),
    };
  },
});

/** Lists the claims that a fired follow-up pushed onto the user's plate. */
export const needsAttention = query({
  args: {},
  returns: v.array(claimWithBalance),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(200);
    const flagged = claims.filter((c) => c.attentionAt !== undefined && c.status !== "dismissed");
    return await Promise.all(
      flagged.map(async (claim) => ({ ...claim, balance: await claimBalance(ctx, claim) })),
    );
  },
});
