/**
 * Test-only seeding/reset harness for the Playwright browser suite (T20a,
 * D83/D95/D102). Every export here is internal (never public) and every
 * handler's first call is `assertE2EEnabled()`, which throws unless:
 *
 *   1. `process.env.E2E_SEED_ENABLED === "true"` (opt-in per deployment), and
 *   2. `process.env.CONVEX_SITE_URL` does NOT contain `cool-oyster-399`, the
 *      documented production host (D83 item 6, D95, D102) -- checked even
 *      when (1) holds, so a misconfigured env var can never seed/reset
 *      production data.
 *
 * Intended only for the disposable dev deployment `adorable-lion-138` (D83
 * item 3). `E2E_SEED_ENABLED` must never be set on a production deployment.
 *
 * `seedUser` creates a real, verified account through the actual Password
 * auth path (`@convex-dev/auth/server`'s `createAccount`, the same helper
 * `Password()` itself calls) rather than hand-rolling a hash, then patches
 * `users.emailVerificationTime` the same way a completed code-verification
 * flow would -- so the account is indistinguishable from one that signed up
 * for real, except no code was ever sent (there's no real mail transport on
 * this deployment). `lastCodeFor` reads the code `lib/authMail.ts`'s
 * `authMailTransport.send` captures into `opsState` key `e2e:code:<email>`
 * (D102; that capture hook is backend-owned, not this file) for any *real*
 * verify/reset code the e2e suite triggers through the UI.
 *
 * `PASSWORD_PROVIDER_ID` below must stay in sync with `convex/auth.ts`'s own
 * (unexported) `PASSWORD_PROVIDER_ID` -- both are the string literal
 * `"password"`, the id `Password<DataModel>({...})` uses by not overriding
 * `id` (auth.ts is backend-owned and out of scope for this file to import
 * from).
 */
import { ConvexError, v } from "convex/values";
import { createAccount } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/email";
import { openClaim } from "./claims";
import { windowEndsAt } from "./lib/ledger";

/** D83 item 6 / D95 / D102: the documented production host. Substring match against `CONVEX_SITE_URL`. */
const PRODUCTION_HOST_MARKER = "cool-oyster-399";
/** Must match `convex/auth.ts`'s `PASSWORD_PROVIDER_ID` (see module doc comment). */
const PASSWORD_PROVIDER_ID = "password";
const DEFAULT_PASSWORD = "E2ePassword123!";
const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_CHARS = 128;
/** Generous per-table read/delete cap: this module only ever seeds a handful of rows per user. */
const BOUND = 500;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Mirrors `market.ts`'s private `OUT_OF_STOCK_NOTE` literal (not exported there yet -- D102 tracks that export separately, owned by integrations). */
const SHOPSAVVY_OUT_OF_STOCK_NOTE = "Out of stock according to ShopSavvy; confirm it is the same item";

/** Every exported function in this module calls this first. */
function assertE2EEnabled(): void {
  if (process.env.E2E_SEED_ENABLED !== "true") {
    throw new ConvexError("convex/testing.ts is disabled on this deployment: E2E_SEED_ENABLED is not \"true\"");
  }
  const siteUrl = process.env.CONVEX_SITE_URL ?? "";
  if (siteUrl.includes(PRODUCTION_HOST_MARKER)) {
    throw new ConvexError(
      `convex/testing.ts refuses to seed or reset data: CONVEX_SITE_URL ("${siteUrl}") looks like the production deployment`,
    );
  }
}

// ---------------------------------------------------------------------------
// seedUser
// ---------------------------------------------------------------------------

/**
 * Creates a verified user through the real Password auth path and returns
 * its id. `password` defaults to a fixed, obviously-fake value so callers
 * that only need a signed-in fixture don't have to invent one. Calling this
 * twice with the SAME email+password is a no-op the second time (the
 * library's own `createAccount` returns the existing account when the
 * supplied secret matches); a DIFFERENT password against an already-seeded
 * email throws, same as a real duplicate sign-up.
 */
export const seedUser = internalAction({
  args: { email: v.string(), password: v.optional(v.string()) },
  returns: v.object({ userId: v.id("users") }),
  handler: async (ctx, args) => {
    assertE2EEnabled();
    const email = normalizeEmail(args.email);
    const password = args.password ?? DEFAULT_PASSWORD;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_CHARS || password.length > MAX_PASSWORD_CHARS) {
      throw new ConvexError(`password must be ${MIN_PASSWORD_CHARS}-${MAX_PASSWORD_CHARS} characters`);
    }

    const { user } = await createAccount(ctx, {
      provider: PASSWORD_PROVIDER_ID,
      account: { id: email, secret: password },
      profile: { email },
    });

    const userId: Id<"users"> = await ctx.runMutation(internal.testing.markVerified, { userId: user._id });
    return { userId };
  },
});

/** Action-only split: `createAccount` needs an action ctx, but patching a row needs `ctx.db`. Not part of the public T20a surface; still gated. */
export const markVerified = internalMutation({
  args: { userId: v.id("users") },
  returns: v.id("users"),
  handler: async (ctx, { userId }) => {
    assertE2EEnabled();
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("seedUser: created user row not found");
    if (user.emailVerificationTime === undefined) {
      await ctx.db.patch(userId, { emailVerificationTime: Date.now() });
    }
    return userId;
  },
});

// ---------------------------------------------------------------------------
// seedFixtures
// ---------------------------------------------------------------------------

/**
 * Seeds one of everything the e2e specs need, all owned by `userId`, none
 * marked `isExample` (that flag is reserved for the in-app "load example
 * data" feature, `examples.ts`, and must stay distinguishable from e2e
 * fixtures so a spec can't accidentally assert against the wrong rows):
 *
 *  - one active watch with 3 watchChecks
 *  - one bought watch, converted to a purchase with an item and 12 priceChecks
 *  - one purchase with a price-adjustment claim (`detected`) and, for the
 *    same merchant, a returns policy snapshot
 *  - three offers on the active watch: one `confirmed`, one `candidate`, and
 *    one ShopSavvy-sourced `candidate` that is out of stock
 *  - one mailLog row `sent`, one `queued`
 */
export const seedFixtures = internalMutation({
  args: { userId: v.id("users") },
  returns: v.object({
    activeWatchId: v.id("watches"),
    boughtWatchId: v.id("watches"),
    boughtPurchaseId: v.id("purchases"),
    claimPurchaseId: v.id("purchases"),
    claimId: v.id("claims"),
    offerIds: v.array(v.id("offers")),
    mailLogIds: v.array(v.id("mailLog")),
  }),
  handler: async (ctx, { userId }) => {
    assertE2EEnabled();
    const user = await ctx.db.get(userId);
    if (!user) throw new ConvexError("seedFixtures: user not found");

    const now = Date.now();
    const activeDomain = "e2e-active.example";
    const activeProductUrl = `https://${activeDomain}/p/e2e-active-item`;

    // --- one active watch with 3 watchChecks -------------------------------
    const activeWatchId = await ctx.db.insert("watches", {
      userId,
      name: "E2E active watch",
      productUrl: activeProductUrl,
      merchantDomain: activeDomain,
      currency: "USD",
      targetCents: 9000,
      status: "active",
      lastCheckedAt: now - HOUR,
      nextCheckAt: now + HOUR,
      lastCents: 9500,
      lastObservedAt: now - HOUR,
    });
    const watchCheckHistory: Array<[number, number]> = [
      [3 * HOUR, 10000],
      [2 * HOUR, 9800],
      [1 * HOUR, 9500],
    ];
    for (const [ago, cents] of watchCheckHistory) {
      await ctx.db.insert("watchChecks", {
        watchId: activeWatchId,
        userId,
        observedCents: cents,
        currency: "USD",
        confidence: 1,
        variantMatch: "exact",
        observedAt: now - ago,
        sourceUrl: activeProductUrl,
        note: "E2E fixture observation",
      });
    }

    // --- one bought watch converted to a purchase with an item + 12 priceChecks
    const boughtDomain = "e2e-bought.example";
    const boughtProductUrl = `https://${boughtDomain}/p/e2e-bought-item`;
    const boughtWatchId = await ctx.db.insert("watches", {
      userId,
      name: "E2E bought watch",
      productUrl: boughtProductUrl,
      merchantDomain: boughtDomain,
      currency: "USD",
      status: "bought",
      lastCheckedAt: now - DAY,
      nextCheckAt: now + DAY,
      lastCents: 8000,
      lastObservedAt: now - DAY,
    });
    const boughtPurchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "E2e Bought Store",
      merchantDomain: boughtDomain,
      orderRef: "E2E-BOUGHT-1",
      purchasedAt: now - 10 * DAY,
      currency: "USD",
      status: "active",
    });
    await ctx.db.patch(boughtWatchId, { purchaseId: boughtPurchaseId });
    const boughtItemId = await ctx.db.insert("items", {
      purchaseId: boughtPurchaseId,
      userId,
      name: "E2E bought item",
      unitCents: 10000,
      qty: 1,
      productUrl: boughtProductUrl,
      returned: false,
    });
    for (let i = 0; i < 12; i++) {
      await ctx.db.insert("priceChecks", {
        itemId: boughtItemId,
        userId,
        observedCents: 10000 - i * 100,
        currency: "USD",
        confidence: 1,
        variantMatch: "exact",
        observedAt: now - (12 - i) * HOUR,
        sourceUrl: boughtProductUrl,
        note: "E2E fixture observation",
      });
    }

    // --- a purchase with a price-adjustment claim `detected` + a returns policy snapshot
    const claimDomain = "e2e-claim.example";
    const claimProductUrl = `https://${claimDomain}/p/e2e-claim-item`;
    const adjustmentPolicyId = await ctx.db.insert("policies", {
      userId,
      merchantDomain: claimDomain,
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      contactEmail: `help@${claimDomain}`,
      passage: "E2E fixture policy: price adjustments honored within 14 days of purchase.",
      sourceUrl: `https://${claimDomain}/price-adjustments`,
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
    });
    // A returns policy snapshot for the same merchant, unattached to the claim above.
    await ctx.db.insert("policies", {
      userId,
      merchantDomain: claimDomain,
      kind: "returns",
      windowDays: 30,
      channel: "email",
      contactEmail: `help@${claimDomain}`,
      passage: "E2E fixture policy: returns accepted within 30 days of delivery.",
      sourceUrl: `https://${claimDomain}/returns`,
      retrievedAt: now,
      confidence: 1,
      confirmedByUser: true,
    });
    const claimPurchasedAt = now - 5 * DAY;
    const claimPurchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "E2e Claim Store",
      merchantDomain: claimDomain,
      orderRef: "E2E-CLAIM-1",
      purchasedAt: claimPurchasedAt,
      currency: "USD",
      status: "active",
    });
    const claimItemId = await ctx.db.insert("items", {
      purchaseId: claimPurchaseId,
      userId,
      name: "E2E claim item",
      unitCents: 12000,
      qty: 1,
      productUrl: claimProductUrl,
      returned: false,
    });
    const dropCheckId = await ctx.db.insert("priceChecks", {
      itemId: claimItemId,
      userId,
      observedCents: 9500,
      currency: "USD",
      confidence: 1,
      variantMatch: "exact",
      observedAt: now - 2 * HOUR,
      sourceUrl: claimProductUrl,
      note: "E2E fixture observation",
    });
    const claimId = await openClaim(ctx, {
      userId,
      purchaseId: claimPurchaseId,
      itemId: claimItemId,
      type: "price_adjustment",
      expectedCents: 2500,
      windowEndsAt: windowEndsAt(claimPurchasedAt, 14),
      policyId: adjustmentPolicyId,
      openedFromPriceCheckId: dropCheckId,
    });

    // --- three offers on the active watch -----------------------------------
    const confirmedOfferId = await ctx.db.insert("offers", {
      watchId: activeWatchId,
      userId,
      storeDomain: "e2e-confirmed-store.example",
      productUrl: "https://e2e-confirmed-store.example/p/e2e-active-item",
      title: "E2E Confirmed Store",
      status: "confirmed",
      variantMatch: "exact",
      matchConfidence: 0.95,
      lastCents: 9200,
      currency: "USD",
      lastCheckedAt: now - HOUR,
      source: "recoup",
    });
    const candidateOfferId = await ctx.db.insert("offers", {
      watchId: activeWatchId,
      userId,
      storeDomain: "e2e-candidate-store.example",
      productUrl: "https://e2e-candidate-store.example/p/e2e-active-item",
      title: "E2E Candidate Store",
      status: "candidate",
      variantMatch: "unsure",
      matchConfidence: 0.6,
      lastCents: 9300,
      currency: "USD",
      lastCheckedAt: now - HOUR,
      source: "recoup",
    });
    const outOfStockOfferId = await ctx.db.insert("offers", {
      watchId: activeWatchId,
      userId,
      storeDomain: "e2e-shopsavvy-store.example",
      productUrl: "https://e2e-shopsavvy-store.example/p/e2e-active-item",
      title: "E2E ShopSavvy Store",
      status: "candidate",
      lastCheckedAt: now - HOUR,
      source: "shopsavvy",
      note: SHOPSAVVY_OUT_OF_STOCK_NOTE,
    });

    // --- one mailLog `sent` drop, one `queued` ------------------------------
    const to = user.email ?? "";
    const sentMailLogId = await ctx.db.insert("mailLog", {
      userId,
      dedupeKey: `watch:${activeWatchId}:9500`,
      kind: "price_drop",
      watchId: activeWatchId,
      to,
      subject: "Price drop on E2E active watch",
      status: "sent",
      cents: 9500,
      previousCents: 10000,
      sentAt: now - HOUR,
      outboundId: "e2e-outbound-sent" as never,
      agentmailMessageId: "e2e-message-sent",
    });
    const queuedMailLogId = await ctx.db.insert("mailLog", {
      userId,
      dedupeKey: `watch:${boughtWatchId}:8000`,
      kind: "price_drop",
      watchId: boughtWatchId,
      to,
      subject: "Price drop on E2E bought watch",
      status: "queued",
      cents: 8000,
      previousCents: 8500,
      claimedAt: now - 10 * 60_000,
      outboundId: "e2e-outbound-queued" as never,
      nextCheckAt: now + HOUR,
      lastCheckedAt: now,
    });

    return {
      activeWatchId,
      boughtWatchId,
      boughtPurchaseId,
      claimPurchaseId,
      claimId,
      offerIds: [confirmedOfferId, candidateOfferId, outOfStockOfferId],
      mailLogIds: [sentMailLogId, queuedMailLogId],
    };
  },
});

// ---------------------------------------------------------------------------
// lastCodeFor
// ---------------------------------------------------------------------------

/** `e2e:code:<email>` opsState key that `lib/authMail.ts`'s capture hook writes (D102); `cursor` holds the raw code. */
function e2eCodeKey(email: string): string {
  return `e2e:code:${email}`;
}

/** Reads the last verify/reset code captured for `email`, or `null` if none has been captured. */
export const lastCodeFor = internalQuery({
  args: { email: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { email }) => {
    assertE2EEnabled();
    const normalized = normalizeEmail(email);
    const row = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", e2eCodeKey(normalized)))
      .unique();
    return row?.cursor ?? null;
  },
});

// ---------------------------------------------------------------------------
// resetUser
// ---------------------------------------------------------------------------

async function deleteAll(ctx: MutationCtx, rows: Array<{ _id: Id<any> }>): Promise<void> {
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * Deletes everything `seedUser`/`seedFixtures` could have created for
 * `email`, children before parents, so a run is repeatable. Bounded reads
 * throughout (`BOUND` per table/sub-table): this module only ever seeds a
 * handful of rows per user, never production-scale data.
 */
export const resetUser = internalMutation({
  args: { email: v.string() },
  returns: v.object({ deleted: v.boolean() }),
  handler: async (ctx, { email }) => {
    assertE2EEnabled();
    const normalized = normalizeEmail(email);

    // The code-capture row is keyed by email, not userId, and may outlive a
    // partially-seeded (or already-deleted) user row.
    const codeRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", e2eCodeKey(normalized)))
      .unique();
    if (codeRow) await ctx.db.delete(codeRow._id);

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", normalized))
      .unique();
    if (!user) return { deleted: false };
    const userId = user._id;

    // Claims and every table hanging off a claim.
    const claims = await ctx.db.query("claims").withIndex("by_user", (q) => q.eq("userId", userId)).take(BOUND);
    for (const claim of claims) {
      await deleteAll(ctx, await ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).take(BOUND));
      await deleteAll(ctx, await ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).take(BOUND));
      await deleteAll(ctx, await ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).take(BOUND));
      await deleteAll(ctx, await ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).take(BOUND));
      await deleteAll(ctx, await ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claim._id)).take(BOUND));
      await ctx.db.delete(claim._id);
    }

    // Items (+ their priceChecks) and purchases.
    const items = await ctx.db.query("items").withIndex("by_user", (q) => q.eq("userId", userId)).take(BOUND);
    for (const item of items) {
      await deleteAll(ctx, await ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", item._id)).take(BOUND));
      await ctx.db.delete(item._id);
    }
    await deleteAll(ctx, await ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).take(BOUND));

    // Watches (+ watchChecks, offers, offerChecks).
    const watches = await ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", userId)).take(BOUND);
    for (const watch of watches) {
      await deleteAll(ctx, await ctx.db.query("watchChecks").withIndex("by_watch", (q) => q.eq("watchId", watch._id)).take(BOUND));
      const offers = await ctx.db.query("offers").withIndex("by_watch", (q) => q.eq("watchId", watch._id)).take(BOUND);
      for (const offer of offers) {
        await deleteAll(ctx, await ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offer._id)).take(BOUND));
        await ctx.db.delete(offer._id);
      }
      await ctx.db.delete(watch._id);
    }

    // Policies.
    await deleteAll(ctx, await ctx.db.query("policies").withIndex("by_user_domain_kind", (q) => q.eq("userId", userId)).take(BOUND));

    // Mail log.
    await deleteAll(ctx, await ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", userId)).take(BOUND));

    // Auth rows: authAccounts (+ their authVerificationCodes) and authSessions (+ their authRefreshTokens).
    const accounts = await ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", userId)).take(BOUND);
    for (const account of accounts) {
      await deleteAll(ctx, await ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", account._id)).take(BOUND));
      await ctx.db.delete(account._id);
    }
    const sessions = await ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).take(BOUND);
    for (const session of sessions) {
      await deleteAll(ctx, await ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", session._id)).take(BOUND));
      await ctx.db.delete(session._id);
    }

    await ctx.db.delete(userId);

    return { deleted: true };
  },
});
