import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedClaim, ownedItem, requireUserId } from "./lib/access";
import { balance, newToken, statusAfterEvent, type EventKind } from "./lib/ledger";
import { assertCents, assertPositiveCents } from "./lib/money";
import { eventKind } from "./schema";
import { cancelPending } from "./followUps";

const MAX_TOKEN_ATTEMPTS = 10;

/**
 * Shared claim-creation path used by the public `open` mutation (always
 * return_credit, D20) and by price-watch / examples callers (T09, T12).
 * Validates related-id ownership (D19) and generates a globally unique
 * token (D23) before inserting.
 */
export async function openClaim(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    purchaseId: Id<"purchases">;
    itemId: Id<"items">;
    type: "price_adjustment" | "return_credit";
    expectedCents: number;
    windowEndsAt?: number;
    policyId?: Id<"policies">;
    openedFromPriceCheckId?: Id<"priceChecks">;
    isExample?: boolean;
  },
): Promise<Id<"claims">> {
  assertPositiveCents(args.expectedCents, "expectedCents");

  const existing = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
    .collect();
  if (existing.some((c) => c.type === args.type && !["confirmed", "dismissed"].includes(c.status))) {
    throw new ConvexError("An open claim of this type already exists for this item");
  }

  if (args.policyId) {
    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.userId !== args.userId) throw new ConvexError("Policy not found");
    const purchase = await ctx.db.get(args.purchaseId);
    if (!purchase || policy.merchantDomain !== purchase.merchantDomain) {
      throw new ConvexError("Policy does not match this purchase's merchant");
    }
  }

  if (args.openedFromPriceCheckId) {
    const priceCheck = await ctx.db.get(args.openedFromPriceCheckId);
    if (!priceCheck || priceCheck.itemId !== args.itemId) {
      throw new ConvexError("Price check does not match this item");
    }
  }

  let token: string | undefined;
  for (let i = 0; i < MAX_TOKEN_ATTEMPTS; i++) {
    const candidate = newToken();
    const hit = await ctx.db
      .query("claims")
      .withIndex("by_token", (q) => q.eq("token", candidate))
      .first();
    if (!hit) {
      token = candidate;
      break;
    }
  }
  if (!token) throw new ConvexError("Could not generate a unique claim token");

  return ctx.db.insert("claims", {
    purchaseId: args.purchaseId,
    itemId: args.itemId,
    userId: args.userId,
    type: args.type,
    expectedCents: args.expectedCents,
    status: "detected",
    windowEndsAt: args.windowEndsAt,
    policyId: args.policyId,
    openedFromPriceCheckId: args.openedFromPriceCheckId,
    token,
    version: 1,
    isExample: args.isExample,
  });
}

/**
 * The only public way to open a claim (D20): always `return_credit`,
 * always on an item the user has already marked returned. Expected cents
 * are derived server-side from the item's price and an optional fee,
 * never taken from the client. Price-adjustment claims are opened only by
 * `priceWatch.recordCheck` (T09) via the exported `openClaim` helper.
 */
export const open = mutation({
  args: { itemId: v.id("items"), feeCents: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const item = await ownedItem(ctx, args.itemId, userId);
    if (!item.returned) throw new ConvexError("Mark the item returned first");

    const fee = args.feeCents ?? 0;
    assertCents(fee, "feeCents");
    const fullCents = item.unitCents * item.qty;
    const expectedCents = fullCents - fee;
    assertPositiveCents(expectedCents, "expectedCents");

    const purchase = await ctx.db.get(item.purchaseId);
    if (!purchase) throw new ConvexError("Purchase not found");
    const policy = await ctx.db
      .query("policies")
      .withIndex("by_user_domain_kind", (q) =>
        q.eq("userId", userId).eq("merchantDomain", purchase.merchantDomain).eq("kind", "returns"),
      )
      .order("desc")
      .first();

    const claimId = await openClaim(ctx, {
      userId,
      purchaseId: item.purchaseId,
      itemId: args.itemId,
      type: "return_credit",
      expectedCents,
      policyId: policy?._id,
    });

    if (fee > 0) {
      await ctx.db.insert("claimNotes", {
        claimId,
        userId,
        kind: "expected_change",
        text: "Fee deducted per policy",
        oldCents: fullCents,
        newCents: expectedCents,
      });
    }

    return claimId;
  },
});

/**
 * Appends one ledger event and recomputes claim status from the full
 * ledger (ARCHITECTURE_PATTERNS: derived sums are never stored). Dedupes
 * by idempotencyKey (D10) and refuses to touch a dismissed claim, which is
 * terminal.
 */
export async function applyEvent(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  kind: EventKind,
  cents: number,
  evidence: string,
  idempotencyKey?: string,
) {
  if (claim.status === "dismissed") throw new ConvexError("Claim is dismissed");
  if (idempotencyKey) {
    const dup = await ctx.db
      .query("ledgerEvents")
      .withIndex("by_key", (q) => q.eq("idempotencyKey", idempotencyKey))
      .first();
    if (dup) return { deduped: true as const, status: claim.status };
  }
  assertCents(cents, "cents");

  await ctx.db.insert("ledgerEvents", { claimId: claim._id, userId: claim.userId, kind, cents, evidence, idempotencyKey });
  const events = await ctx.db
    .query("ledgerEvents")
    .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
    .collect();
  const b = balance(claim.expectedCents, events);
  const status = statusAfterEvent(claim.status, kind, b);
  const patch: Partial<Doc<"claims">> = { status, version: claim.version + 1 };
  if (status === "confirmed") {
    await cancelPending(ctx, claim._id);
    patch.attentionAt = undefined;
  }
  await ctx.db.patch(claim._id, patch);
  return { deduped: false as const, status };
}

export const applyEventInternal = internalMutation({
  args: {
    claimId: v.id("claims"),
    userId: v.id("users"),
    kind: eventKind,
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    return applyEvent(ctx, claim, args.kind, args.cents, args.evidence, args.idempotencyKey);
  },
});

export const confirmCredit = mutation({
  args: { claimId: v.id("claims"), cents: v.number(), evidence: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    return applyEvent(ctx, claim, "confirmed_credit", args.cents, args.evidence, args.idempotencyKey);
  },
});

export const recordLaterDebit = mutation({
  args: { claimId: v.id("claims"), cents: v.number(), evidence: v.string(), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    return applyEvent(ctx, claim, "later_debit", args.cents, args.evidence, args.idempotencyKey);
  },
});

/**
 * Corrects the expected amount without touching the ledger (D24): no
 * ledger event, just a note. Unapproves any not-yet-sent draft (no
 * outboundId) since its body may cite the old amount, and cancels any
 * pending reminder since the claim's terms just changed.
 */
export const adjustExpected = mutation({
  args: { claimId: v.id("claims"), expectedCents: v.number(), reason: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertPositiveCents(args.expectedCents, "expectedCents");
    const oldCents = claim.expectedCents;

    await ctx.db.patch(claim._id, { expectedCents: args.expectedCents, version: claim.version + 1 });

    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
      .collect();
    for (const d of drafts) {
      if (d.approvedAt && !d.outboundId) await ctx.db.patch(d._id, { approvedAt: undefined });
    }

    await cancelPending(ctx, claim._id);

    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "expected_change",
      text: args.reason,
      oldCents,
      newCents: args.expectedCents,
    });
  },
});

export const dismiss = mutation({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    await cancelPending(ctx, claim._id);
    await ctx.db.patch(claim._id, { status: "dismissed", version: claim.version + 1, attentionAt: undefined });
    await ctx.db.insert("claimNotes", { claimId: claim._id, userId, kind: "status", text: "Dismissed by user" });
  },
});

export const clearAttention = mutation({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    await ownedClaim(ctx, claimId, userId);
    await ctx.db.patch(claimId, { attentionAt: undefined });
  },
});

export const get = query({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    const item = await ctx.db.get(claim.itemId);
    const purchase = await ctx.db.get(claim.purchaseId);
    const events = await ctx.db
      .query("ledgerEvents")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const drafts = await ctx.db
      .query("drafts")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .order("desc")
      .collect();
    const replies = await ctx.db
      .query("replies")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const followUps = await ctx.db
      .query("followUps")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const notes = await ctx.db
      .query("claimNotes")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect();
    const policy = claim.policyId ? await ctx.db.get(claim.policyId) : null;
    const messages = claim.threadId
      ? await ctx.runQuery(components.agentmail.lib.listInboundMessages, { threadId: claim.threadId })
      : [];
    return {
      claim,
      item,
      purchase,
      events,
      drafts,
      replies,
      followUps,
      notes,
      policy,
      messages,
      balance: balance(claim.expectedCents, events),
    };
  },
});
