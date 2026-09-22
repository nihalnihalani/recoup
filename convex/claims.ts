import { ConvexError, v } from "convex/values";
import { components } from "./_generated/api";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedClaim, ownedItem, requireUserId } from "./lib/access";
import { balance, deriveStatus, newToken, provisionalOutstanding, statusAfterEvent } from "./lib/ledger";
import { assertCents, assertPositiveCents, assertUserAmount, claimCurrency } from "./lib/money";
import { assertMaxChars } from "./lib/text";
import schema, { claimStatus, eventKind, money, nonCashKind } from "./schema";
import { cancelPending } from "./followUps";
import { claimBalance, claimEvents, balanceValidator } from "./lib/balance";
import { isClosedForAsk } from "./lib/claimState";
import { syncOpportunityClosure } from "./lib/opportunityClosure";
import { agentmail } from "./mail";

/**
 * P08 (T16, docs/reviews/2026-09-21-phase0-reproduction.md's boundary.test.ts
 * finding): no free-text field here had an application-level length cap --
 * unlike every other free-text field in the app (draft subject/body, purchase
 * / item names), which all go through `boundedLine`/`.slice(...)`. A single
 * call could write a multi-megabyte string into a `ledgerEvents`/
 * `claimNotes` row. These bound length only (no control-character cleanup):
 * callers already control the shape of these strings (auto-generated
 * evidence text, or a user-typed reason/evidence the client is free to
 * display verbatim).
 */
const MAX_EVIDENCE_CHARS = 2_000;
const MAX_REASON_CHARS = 500;
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
/** A non-cash remedy's description ("Store voucher, expires 2027-01-31"): one line, not a document. */
const MAX_NON_CASH_DESCRIPTION_CHARS = 500;
/** Non-cash rows `get` returns per claim: a handful per case in practice; bounded read (guidelines). */
const MAX_NON_CASH_READ = 100;

/**
 * Same accepted deviation as `drafts.sendCtx` (D12a): the AgentMail
 * component's ctx types predate convex 1.46's `runMutation` overload.
 */
function cancelCtx(ctx: MutationCtx): Parameters<typeof agentmail.cancel>[0] {
  return ctx as unknown as Parameters<typeof agentmail.cancel>[0];
}

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

  // D46: never trust that the caller's ids belong together.
  const item = await ctx.db.get(args.itemId);
  if (!item || item.userId !== args.userId) throw new ConvexError("Item not found");
  if (item.purchaseId !== args.purchaseId) {
    throw new ConvexError("Item does not belong to this purchase");
  }

  const existing = await ctx.db
    .query("claims")
    .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
    .collect();
  // D44: an item is returned once, so one return_credit claim per item
  // unless the earlier one was dismissed (a confirmed return still blocks:
  // this is replaceability, not closed-for-ask). Price adjustments may repeat
  // once the previous one is closed for ask (`lib/claimState.isClosedForAsk`,
  // contract §5: confirmed/dismissed today, + denied / non-cash in wave 2).
  const blocks = (c: Doc<"claims">) =>
    args.type === "return_credit" ? c.status !== "dismissed" : !isClosedForAsk(c);
  if (existing.some((c) => c.type === args.type && blocks(c))) {
    throw new ConvexError(
      args.type === "return_credit"
        ? "A return claim already exists for this item"
        : "An open claim of this type already exists for this item",
    );
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
    if (!priceCheck || priceCheck.userId !== args.userId || priceCheck.itemId !== args.itemId) {
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
  returns: v.id("claims"),
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
 * D112 6a-1 migration safety: an internal caller that derives its
 * idempotency key through `lib/idempotency.ts`'s `internalKey` (a fixed
 * 32-hex-char hash of an external, unbounded input such as an RFC
 * Message-ID) also passes the OLD raw key it used to write before this
 * change (`legacyIdempotencyKey`), so a ledger row written under the old,
 * unhashed format is still found and deduped rather than double-applied
 * under the new hashed key. One extra indexed `by_claim_key` read, only
 * when a legacy key is supplied and differs from the primary one.
 */
async function findLedgerDuplicate(
  ctx: MutationCtx,
  claimId: Id<"claims">,
  idempotencyKey: string,
  legacyIdempotencyKey?: string,
): Promise<Doc<"ledgerEvents"> | null> {
  const primary = await ctx.db
    .query("ledgerEvents")
    .withIndex("by_claim_key", (q) => q.eq("claimId", claimId).eq("idempotencyKey", idempotencyKey))
    .first();
  if (primary) return primary;
  if (!legacyIdempotencyKey || legacyIdempotencyKey === idempotencyKey) return null;
  return await ctx.db
    .query("ledgerEvents")
    .withIndex("by_claim_key", (q) => q.eq("claimId", claimId).eq("idempotencyKey", legacyIdempotencyKey))
    .first();
}

type LedgerKind = Doc<"ledgerEvents">["kind"];

/**
 * Appends one ledger event and recomputes claim status from the full
 * ledger (ARCHITECTURE_PATTERNS: derived sums are never stored). Refuses a
 * dismissed claim, which is terminal. Idempotency keys are scoped to the
 * claim (D38): the same key with the same kind and cents is a no-op, the
 * same key with different facts is a conflict. A later debit can never
 * exceed the net confirmed credit (D40); a provisional release can never
 * exceed the outstanding provisional credit (§3.2). `currency`, when given,
 * is stamped on the row (every NEW writer passes the claim's currency) and
 * a dedupe hit with a different stamped currency is a conflict.
 *
 * D112 6a-1: `MAX_IDEMPOTENCY_KEY_CHARS` is NOT enforced here any more --
 * only on the client-supplied keys the public mutations below take
 * directly. An internal caller (`replies.apply`, `intake.applyRefund`)
 * derives a fixed-length key through `lib/idempotency.ts` instead, so no
 * length bound is meaningful for it; `legacyIdempotencyKey`, when passed, is
 * the pre-migration raw key the same caller used to write (see
 * `findLedgerDuplicate` above).
 *
 * Not exported: every write goes through `applyEvent` (which refuses
 * `confirmed_credit`) or `writeConfirmedCredit` (the one confirmed-credit
 * writer, SEC-MF-5 as amended by D145).
 */
async function appendLedgerEvent(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  kind: LedgerKind,
  cents: number,
  evidence: string,
  idempotencyKey: string,
  legacyIdempotencyKey?: string,
  currency?: string,
) {
  if (claim.status === "dismissed") throw new ConvexError("Claim is dismissed");
  assertPositiveCents(cents, "cents");
  assertMaxChars(evidence, "evidence", MAX_EVIDENCE_CHARS);
  if (idempotencyKey.trim().length === 0) throw new ConvexError("idempotencyKey must not be empty");

  const dup = await findLedgerDuplicate(ctx, claim._id, idempotencyKey, legacyIdempotencyKey);
  if (dup) {
    const currencyDiffers = currency !== undefined && dup.currency !== undefined && dup.currency !== currency;
    if (dup.kind !== kind || dup.cents !== cents || currencyDiffers) throw new ConvexError("idempotency conflict");
    return { deduped: true as const, status: claim.status };
  }

  if (kind === "later_debit") {
    const before = await claimBalance(ctx, claim);
    if (cents > before.confirmed - before.debited) {
      throw new ConvexError("A later debit cannot exceed the confirmed credit");
    }
  }
  if (kind === "provisional_released") {
    const outstanding = provisionalOutstanding(await claimEvents(ctx, claim._id));
    if (cents > outstanding) {
      throw new ConvexError("A release cannot exceed the outstanding provisional credit");
    }
  }

  await ctx.db.insert("ledgerEvents", {
    claimId: claim._id,
    userId: claim.userId,
    kind,
    cents,
    evidence,
    idempotencyKey,
    ...(currency === undefined ? {} : { currency }),
  });
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

/**
 * The ledger write every other module uses (replies, intake, the claim
 * mutations below). It can NEVER write `confirmed_credit`: only the user's
 * own confirmation creates confirmed money (mission §6, SEC-MF-5), through
 * `writeConfirmedCredit`. The type excludes it and a runtime check refuses it.
 */
export async function applyEvent(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  kind: Exclude<LedgerKind, "confirmed_credit">,
  cents: number,
  evidence: string,
  idempotencyKey: string,
  legacyIdempotencyKey?: string,
  currency?: string,
) {
  if ((kind as LedgerKind) === "confirmed_credit") {
    throw new ConvexError("A confirmed credit is recorded only by the user's own confirmation");
  }
  return await appendLedgerEvent(ctx, claim, kind, cents, evidence, idempotencyKey, legacyIdempotencyKey, currency);
}

/**
 * THE only writer of `confirmed_credit` (SEC-MF-5 as amended by D145; DA-A-16). Reached only from
 * user-authenticated mutations in this file: `confirmCredit` and `finalizeProvisionalCredit`. The amount is a
 * user-typed amount, so it is bounded by `MAX_USER_AMOUNT_MINOR` (D145).
 */
async function writeConfirmedCredit(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  cents: number,
  evidence: string,
  idempotencyKey: string,
  currency: string | undefined,
) {
  assertUserAmount(cents, "cents");
  const result = await appendLedgerEvent(ctx, claim, "confirmed_credit", cents, evidence, idempotencyKey, undefined, currency);
  // DA-B-7: a settled claim closes its opportunity in this same mutation.
  await syncOpportunityClosure(ctx, claim._id);
  return result;
}

/** The claim's currency (`lib/money.claimCurrency`): its own, else its purchase's; null when neither is known. */
async function currencyOf(ctx: MutationCtx, claim: Doc<"claims">): Promise<string | null> {
  if (claim.currency !== undefined) return claim.currency;
  return claimCurrency(claim, await ctx.db.get(claim.purchaseId));
}

/** As `currencyOf`, for the new money writers that REQUIRE a currency (§2.4: ledgerEvents.currency). */
async function requireCurrency(ctx: MutationCtx, claim: Doc<"claims">): Promise<string> {
  const currency = await currencyOf(ctx, claim);
  if (currency === null) throw new ConvexError("This claim's currency is unknown");
  return currency;
}

/**
 * Internal-only ledger path. Admits only the merchant/system-sourced kinds (`promised_credit`, `later_debit`);
 * `confirmed_credit` and both provisional kinds are user-recorded and have their own authenticated mutations.
 */
export const applyEventInternal = internalMutation({
  args: {
    claimId: v.id("claims"),
    userId: v.id("users"),
    kind: eventKind,
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const claim = await ctx.db.get(args.claimId);
    if (!claim || claim.userId !== args.userId) throw new ConvexError("Claim not found");
    const kind = args.kind;
    if (kind !== "promised_credit" && kind !== "later_debit") {
      throw new ConvexError(`${kind} cannot be recorded through applyEventInternal`);
    }
    return applyEvent(ctx, claim, kind, args.cents, args.evidence, args.idempotencyKey);
  },
});

const applyEventResult = v.object({ deduped: v.boolean(), status: claimStatus });

/**
 * The user confirms money posted (the only source of confirmed recovery, mission §6).
 * rev 5 N5 (D148): while a provisional credit is outstanding the user must say which this is. Without
 * `separateFromProvisional: true` the mutation writes nothing and throws
 * `ConvexError({ kind: "ProvisionalOutstanding", provisionalMinor })`; the UI then offers "the provisional
 * credit became final" (→ `finalizeProvisionalCredit`) or "a separate credit" (→ this mutation with the flag).
 * A genuinely separate posting is never refused. A retry of a credit already recorded under this key dedupes.
 */
export const confirmCredit = mutation({
  args: {
    claimId: v.id("claims"),
    cents: v.number(),
    evidence: v.string(),
    idempotencyKey: v.string(),
    separateFromProvisional: v.optional(v.boolean()),
  },
  returns: applyEventResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    // D112 6a-1: the 128-char bound is enforced HERE, at the public
    // mutation that takes a client-supplied key, not inside `applyEvent`.
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    assertPositiveCents(args.cents, "cents");
    assertUserAmount(args.cents, "cents");
    if (args.separateFromProvisional !== true) {
      const provisionalMinor = provisionalOutstanding(await claimEvents(ctx, claim._id));
      if (provisionalMinor > 0 && !(await findLedgerDuplicate(ctx, claim._id, args.idempotencyKey))) {
        throw new ConvexError({ kind: "ProvisionalOutstanding", provisionalMinor });
      }
    }
    return writeConfirmedCredit(ctx, claim, args.cents, args.evidence, args.idempotencyKey, (await currencyOf(ctx, claim)) ?? undefined);
  },
});

export const recordLaterDebit = mutation({
  args: { claimId: v.id("claims"), cents: v.number(), evidence: v.string(), idempotencyKey: v.string() },
  returns: applyEventResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    return applyEvent(ctx, claim, "later_debit", args.cents, args.evidence, args.idempotencyKey);
  },
});

/**
 * The user records a PROVISIONAL credit (e.g. an issuer's provisional credit during an investigation, §3.2).
 * It is shown as "of which provisional", never as recovered money, and never changes the claim's status.
 * The amount must be in the claim's currency.
 */
export const recordProvisionalCredit = mutation({
  args: { claimId: v.id("claims"), amount: money, evidence: v.string(), idempotencyKey: v.string() },
  returns: applyEventResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    assertPositiveCents(args.amount.amountMinor, "amount");
    assertUserAmount(args.amount.amountMinor, "amount");
    const currency = await requireCurrency(ctx, claim);
    if (args.amount.currency !== currency) {
      throw new ConvexError(`currency mismatch: this claim is in ${currency}`);
    }
    return applyEvent(ctx, claim, "provisional_credit", args.amount.amountMinor, args.evidence, args.idempotencyKey, undefined, currency);
  },
});

/**
 * The provisional credit became final (DA-A-16). Writes `provisional_released` under the derived key
 * `${idempotencyKey}:release` and `confirmed_credit` under `${idempotencyKey}:confirm` — two events, two keys,
 * so one client key never collides with itself (repro A.2) — the confirmed credit through the same single
 * writer `confirmCredit` uses. A retry dedupes both. `cents` may not exceed the outstanding provisional credit.
 */
export const finalizeProvisionalCredit = mutation({
  args: { claimId: v.id("claims"), cents: v.number(), evidence: v.string(), idempotencyKey: v.string() },
  returns: applyEventResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    assertPositiveCents(args.cents, "cents");
    assertUserAmount(args.cents, "cents");
    const currency = await requireCurrency(ctx, claim);
    const released = await applyEvent(
      ctx, claim, "provisional_released", args.cents, args.evidence, `${args.idempotencyKey}:release`, undefined, currency,
    );
    const fresh = await ctx.db.get(claim._id);
    if (!fresh) throw new ConvexError("Claim not found");
    const confirmed = await writeConfirmedCredit(ctx, fresh, args.cents, args.evidence, `${args.idempotencyKey}:confirm`, currency);
    return { deduped: released.deduped && confirmed.deduped, status: confirmed.status };
  },
});

/** The provisional credit was reversed (§3.2): releases it with no confirmed money. Status unchanged. */
export const reverseProvisionalCredit = mutation({
  args: { claimId: v.id("claims"), cents: v.number(), evidence: v.string(), idempotencyKey: v.string() },
  returns: applyEventResult,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    assertPositiveCents(args.cents, "cents");
    assertUserAmount(args.cents, "cents");
    const currency = await requireCurrency(ctx, claim);
    return applyEvent(ctx, claim, "provisional_released", args.cents, args.evidence, args.idempotencyKey, undefined, currency);
  },
});

/**
 * Records a non-cash remedy (voucher, points, repair, replacement…; contract §3.2, M10 wave 1): an append-only
 * `nonCashRemedies` row, `promised` or `received`, that never touches the ledger, the claim's status or its
 * version, and never enters a cash total (mission §6: non-cash is not interchangeable with cash). A face value,
 * when given, is a user-typed amount in the claim's currency, shown per item only. Idempotency is per claim
 * (same key + same facts → dedupe; different facts → conflict). Closing a claim on a non-cash resolution is
 * `recordNonCashResolution` (M20, wave 2).
 */
export const recordNonCashRemedy = mutation({
  args: {
    claimId: v.id("claims"),
    kind: nonCashKind,
    description: v.string(),
    faceValue: v.optional(money),
    state: v.union(v.literal("promised"), v.literal("received")),
    idempotencyKey: v.string(),
  },
  returns: v.object({ deduped: v.boolean(), remedyId: v.id("nonCashRemedies") }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    if (claim.status === "dismissed") throw new ConvexError("Claim is dismissed");
    assertMaxChars(args.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY_CHARS);
    if (args.idempotencyKey.trim().length === 0) throw new ConvexError("idempotencyKey must not be empty");
    const description = args.description.trim();
    if (description.length === 0) throw new ConvexError("description must not be empty");
    assertMaxChars(description, "description", MAX_NON_CASH_DESCRIPTION_CHARS);
    if (args.faceValue) {
      assertPositiveCents(args.faceValue.amountMinor, "faceValue");
      assertUserAmount(args.faceValue.amountMinor, "faceValue");
      const currency = await requireCurrency(ctx, claim);
      if (args.faceValue.currency !== currency) throw new ConvexError(`currency mismatch: this claim is in ${currency}`);
    }

    const dup = await ctx.db
      .query("nonCashRemedies")
      .withIndex("by_claim_and_idempotency_key", (q) => q.eq("claimId", claim._id).eq("idempotencyKey", args.idempotencyKey))
      .unique();
    if (dup) {
      const same =
        dup.kind === args.kind &&
        dup.state === args.state &&
        dup.description === description &&
        dup.faceValue?.amountMinor === args.faceValue?.amountMinor &&
        dup.faceValue?.currency === args.faceValue?.currency;
      if (!same) throw new ConvexError("idempotency conflict");
      return { deduped: true, remedyId: dup._id };
    }
    const remedyId = await ctx.db.insert("nonCashRemedies", {
      userId,
      claimId: claim._id,
      kind: args.kind,
      description,
      ...(args.faceValue ? { faceValue: args.faceValue } : {}),
      state: args.state,
      idempotencyKey: args.idempotencyKey,
      recordedAt: Date.now(),
    });
    return { deduped: false, remedyId };
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
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, args.claimId, userId);
    if (claim.status === "dismissed") throw new ConvexError("Claim is dismissed");
    assertPositiveCents(args.expectedCents, "expectedCents");
    assertMaxChars(args.reason, "reason", MAX_REASON_CHARS);
    const oldCents = claim.expectedCents;

    // D41: the new expected amount can settle or un-settle the claim.
    const b = await claimBalance(ctx, { _id: claim._id, expectedCents: args.expectedCents });
    const status = deriveStatus(claim.status, b);
    const patch: Partial<Doc<"claims">> = {
      expectedCents: args.expectedCents,
      status,
      version: claim.version + 1,
    };
    if (status === "confirmed") patch.attentionAt = undefined;
    await ctx.db.patch(claim._id, patch);

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
    return null;
  },
});

export const dismiss = mutation({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, { claimId }) => {
    const userId = await requireUserId(ctx);
    const claim = await ownedClaim(ctx, claimId, userId);
    // D48: a confirmed claim holds real recovered money; it cannot be dismissed.
    if (claim.status === "confirmed") throw new ConvexError("A confirmed claim cannot be dismissed");
    await cancelPending(ctx, claim._id);
    await ctx.db.patch(claim._id, { status: "dismissed", version: claim.version + 1, attentionAt: undefined });
    // DA-B-7: the opportunity reopens in this same mutation, not at the next evaluation.
    await syncOpportunityClosure(ctx, claim._id);

    // D57: dismissing a claim with a send in flight best-effort cancels it
    // with AgentMail so it doesn't land after the user has walked away. A
    // cancel failure never blocks the dismissal itself; either outcome is
    // recorded as a note.
    if (claim.status === "queued") {
      const newest = (
        await ctx.db
          .query("drafts")
          .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
          .collect()
      )
        .filter((d) => d.outboundId)
        .sort((a, b) => b.version - a.version)[0];
      if (newest?.outboundId) {
        let cancelled = true;
        try {
          await agentmail.cancel(cancelCtx(ctx), newest.outboundId);
        } catch {
          cancelled = false;
        }
        await ctx.db.insert("claimNotes", {
          claimId: claim._id,
          userId,
          kind: "status",
          text: cancelled ? "Dismissed; pending send cancelled" : "Dismissed; send could not be cancelled",
        });
        return null;
      }
    }
    await ctx.db.insert("claimNotes", { claimId: claim._id, userId, kind: "status", text: "Dismissed by user" });
    return null;
  },
});

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

export const get = query({
  args: { claimId: v.id("claims") },
  returns: v.object({
    claim: schema.doc("claims"),
    item: v.union(schema.doc("items"), v.null()),
    purchase: v.union(schema.doc("purchases"), v.null()),
    events: v.array(schema.doc("ledgerEvents")),
    drafts: v.array(schema.doc("drafts")),
    replies: v.array(schema.doc("replies")),
    followUps: v.array(schema.doc("followUps")),
    notes: v.array(schema.doc("claimNotes")),
    policy: v.union(schema.doc("policies"), v.null()),
    // Opaque component data (`@agentmail/convex`'s own `listInboundMessages`
    // query declares no `returns` validator of its own); nothing in this app
    // has a schema for it.
    messages: v.any(),
    balance: balanceValidator,
    /** Outstanding provisional credit (§3.2): shown as "of which provisional", never in `balance`. */
    provisionalMinor: v.number(),
    /** Non-cash remedies, oldest first (never summed with cash). */
    nonCashRemedies: v.array(schema.doc("nonCashRemedies")),
  }),
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
    const nonCashRemedies = (
      await ctx.db
        .query("nonCashRemedies")
        .withIndex("by_claim_and_idempotency_key", (q) => q.eq("claimId", claimId))
        .take(MAX_NON_CASH_READ)
    ).sort((a, b) => a.recordedAt - b.recordedAt || a._creationTime - b._creationTime);
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
      provisionalMinor: provisionalOutstanding(events),
      nonCashRemedies,
    };
  },
});
