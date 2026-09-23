/**
 * Watches (W1): a product the user has NOT bought yet, checked every two hours
 * and on demand, with a verdict line (W1b) computed from our own history.
 *
 * The external half is `priceWatch.observePrice`, shared with owned items.
 * `recordWatchCheck` is where the acceptance rules live; they are D16's
 * (`priceWatch.rejectionReason`) with one difference: a watch has no purchase
 * currency, so the first accepted observation fixes the currency and a later
 * different one is a rejection. A rejected or failed check is still a
 * `watchChecks` row with a `note` and no cents.
 *
 * Spend is bounded in the mutations that schedule it (`convex/limits.ts`).
 */
import { ConvexError, v, type Infer } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { variantMatch, verdictValidator, watchStatus } from "./schema";
import { ownedWatch, requireUserId } from "./lib/access";
import { isTombstoned } from "./lib/accountState";
import { isPriceStale } from "./lib/freshness";
import { logEvent } from "./lib/log";
import { sanitizeError } from "./lib/errors";
import { assertCurrency, assertNonEmpty, assertPositiveCents, assertQty, assertTimestamp } from "./lib/money";
import { claimDrop } from "./notify";
import { defaultWatchName, parseProductUrl } from "./lib/watchUrl";
import { verdictWithQualifier, type QualifiedVerdict } from "./lib/verdict";
import { imageUrlChange } from "./lib/imageUrl";
import { cleanLine, meaningfulName } from "./lib/text";
import { charge, consumeGlobalBudget, takeGlobalBudget } from "./lib/budget";
import { schedulePolicyFetch } from "./policies";
import { ensurePurchaseTransaction } from "./transactions";
import { errorNote, observePrice, rejectionReason, truncate, type PageObservation } from "./priceWatch";
import {
  GLOBAL_DAILY_BUDGETS,
  INELIGIBLE_REST_MS,
  MARKET_MAX_POINTS,
  MAX_PURCHASES_PER_USER,
  MAX_WATCHES_PER_USER,
  MAX_WATCH_CREATES_PER_HOUR,
  STALE_PRICE_MS,
  WATCH_CHECK_COOLDOWN_MS,
  WATCH_CHECK_INTERVAL_MS,
  WATCH_CREATE_WINDOW_MS,
  WATCH_SWEEP_BUMP_MS,
  WATCH_SWEEP_PAGE,
  WATCH_SWEEP_PER_USER,
  WATCH_SWEEP_STAGGER_MS,
} from "./limits";

/**
 * QA-M16-4 (D217): a purchase date is never a future instant. It is validated like any user timestamp
 * (`assertTimestamp`: finite, not negative, at most a day ahead) and then CLAMPED to the server's now instead of
 * refused. The client sends its own clock for "bought today", and a device clock running a few seconds or minutes
 * fast would otherwise make "I bought it today" fail; clamping keeps exactly what the user meant (today, now) and
 * still guarantees the invariant every window depends on: a price-adjustment window counted from it can never run
 * past the store's rule. Anything more than a day ahead is still refused by `assertTimestamp`.
 */
export function purchasedAtNotAfterNow(purchasedAt: number, now: number = Date.now()): number {
  return Math.min(assertTimestamp(purchasedAt, "purchasedAt", now), now);
}

/**
 * P06 (D73): a client-supplied coarse "now" for DISPLAY computations only
 * (never eligibility, cooldowns or money -- those keep reading `Date.now()`
 * in the mutation/action that enforces them). Validated so a broken or
 * malicious client cannot skew what a query displays by much: finite, within
 * a day of the server's own clock, then rounded down to a 5-minute step so
 * the reactive result only changes on that cadence instead of every render.
 * The bounds check reads `Date.now()`, but only to THROW on a bad argument --
 * it never contributes to any returned field, so it does not create the
 * staleness problem the "no wall clock in a query" guideline warns about.
 */
export function assertCoarseNow(now: number | undefined): number | undefined {
  if (now === undefined) return undefined;
  if (!Number.isFinite(now)) throw new ConvexError("now must be a valid time");
  if (Math.abs(now - Date.now()) > 86_400_000) throw new ConvexError("now must be close to the current time");
  return Math.floor(now / 300_000) * 300_000;
}

/** Accepted watch checks carried into a purchase's price history by `markBought`. */
const CARRY_OVER_CHECKS = 90;
/** Rows `markBought` may walk to find them; failed checks sit between accepted ones. */
const CARRY_OVER_SCAN = 360;
const MAX_ORDER_REF_CHARS = 100;

const MAX_NAME_CHARS = 200;
/** `list` page size. */
const LIST_LIMIT = 100;
/** Newest checks the verdict is computed from, in `list` and `get` alike (5 days at the 2h cadence). */
const VERDICT_WINDOW = 60;
/** Accepted points returned per watch for the sparkline. */
const SPARK_POINTS = 30;
/** Checks returned by `get`. */
const GET_CHECKS = 90;

const LIVE_STATUSES = ["active", "paused", "bought"] as const;

// ---------------------------------------------------------------------------
// Return shapes
// ---------------------------------------------------------------------------

const sparkPoint = v.object({ observedAt: v.number(), observedCents: v.number() });

const watchSummary = v.object({
  _id: v.id("watches"),
  _creationTime: v.number(),
  name: v.string(),
  productUrl: v.string(),
  merchantDomain: v.string(),
  /** The product page's Open Graph image, once a check has seen one. */
  imageUrl: v.union(v.string(), v.null()),
  currency: v.union(v.string(), v.null()),
  targetCents: v.union(v.number(), v.null()),
  status: watchStatus,
  /** Raw timestamp of the last attempt (accepted or not); the client derives display text (P06/D73). */
  lastCheckedAt: v.union(v.number(), v.null()),
  /** Raw timestamp of the last ACCEPTED observation, distinct from `lastCheckedAt` (P06/D73). */
  lastObservedAt: v.union(v.number(), v.null()),
  /** True when `lastObservedAt` is missing or older than STALE_PRICE_MS (as of the query's `now`, or never true when no `now` was given). */
  priceStale: v.boolean(),
  nextCheckAt: v.number(),
  /** Latest accepted price. */
  lastCents: v.union(v.number(), v.null()),
  /** The page's claimed "was" price at the latest accepted check, unverified. */
  listCents: v.union(v.number(), v.null()),
  /** True when a target is set, the latest accepted price is at or under it, and that price is not stale. */
  targetHit: v.boolean(),
  /** Raw timestamp of the last requested check, if any; the client derives "checking" from this plus its own clock (P06/D73, replaces the old `checking` boolean). */
  checkRequestedAt: v.union(v.number(), v.null()),
  /** Why the most recent check produced no price, when it did not. */
  lastNote: v.union(v.string(), v.null()),
  purchaseId: v.union(v.id("purchases"), v.null()),
  verdict: verdictValidator,
  /** Accepted observations, oldest first, at most 30. */
  spark: v.array(sparkPoint),
  /**
   * Prices for the same product from ShopSavvy, oldest first (W1b). Third-party
   * evidence, always shown as such: it reaches back years where `spark` starts
   * the day the watch started, but it never opens a claim or sends an alert.
   * `null` when the lookup has not run, found nothing, or is not configured.
   */
  market: v.union(
    v.object({
      source: v.literal("shopsavvy"),
      points: v.array(
        v.object({
          observedAt: v.number(),
          cents: v.number(),
          retailer: v.union(v.string(), v.null()),
        }),
      ),
      lowestCents: v.number(),
      highestCents: v.number(),
      /** Oldest point, so the UI can say how far back the evidence goes. */
      since: v.number(),
      /** Why there is no history, when there is none. */
      note: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
});

const watchCheckView = v.object({
  _id: v.id("watchChecks"),
  observedAt: v.number(),
  observedCents: v.union(v.number(), v.null()),
  listCents: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  confidence: v.union(v.number(), v.null()),
  variantMatch: v.union(variantMatch, v.null()),
  sourceUrl: v.string(),
  note: v.union(v.string(), v.null()),
});

const recordResult = v.object({
  watchCheckId: v.id("watchChecks"),
  accepted: v.boolean(),
  note: v.union(v.string(), v.null()),
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function recentChecks(ctx: QueryCtx, watchId: Id<"watches">, n: number) {
  return await ctx.db
    .query("watchChecks")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .order("desc")
    .take(n);
}

/** Third-party dated prices for the verdict (W1b). Bounded by MARKET_MAX_POINTS on write. */
async function marketFor(ctx: QueryCtx, watchId: Id<"watches">): Promise<Array<Doc<"marketPrices">>> {
  return await ctx.db
    .query("marketPrices")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .take(MARKET_MAX_POINTS);
}

/**
 * `checks` newest first. The verdict only ever sees the newest VERDICT_WINDOW.
 *
 * `argsNow` is the caller's validated, coarse `now` (P06/D73) -- optional,
 * since a query must not read the wall clock itself. When it is missing, the
 * "now" used for the verdict/staleness math falls back to the freshest thing
 * this watch actually knows (`lastObservedAt`, or the newest accepted check),
 * never to `Date.now()`: without a real clock reference from the client, this
 * function cannot honestly judge staleness against the present moment, so it
 * judges against the watch's own data instead, which can only ever say
 * "fresh", never lie "stale".
 */
function summarise(
  watch: Doc<"watches">,
  checks: Doc<"watchChecks">[],
  argsNow: number | undefined,
  market: Array<Doc<"marketPrices">> = [],
): Infer<typeof watchSummary> {
  const window = checks.slice(0, VERDICT_WINDOW);
  const accepted = window.flatMap((c) =>
    c.observedCents === undefined ? [] : [{ observedAt: c.observedAt, cents: c.observedCents, listCents: c.listCents }],
  );
  const latest = accepted[0];
  const currentCents = watch.lastCents ?? null;
  const listCents = latest?.listCents ?? null;
  const now = argsNow ?? watch.lastObservedAt ?? latest?.observedAt ?? watch._creationTime;
  // F-T24b-1 (D118): the same rule `lib/freshness.ts`'s `isPriceStale` expresses for
  // `insights.trackedTable` -- unified here now that this file is free (D115 deferred this exact
  // edit past T18.3, which has now landed above).
  const priceStale = isPriceStale(watch.lastObservedAt, now);
  // F10 (D103): fall back to the last check ATTEMPT's timestamp when there
  // has never been an accepted observation, so a message built from it can
  // at least say how long we have been trying (both fields are set together
  // by recordWatchCheck, so today `lastCents`/`currentCents` would already
  // be null in that case -- this only matters if that ever changes).
  const priceObservedAt = watch.lastObservedAt ?? watch.lastCheckedAt;
  const result: QualifiedVerdict = verdictWithQualifier({
    currentCents,
    listCents,
    history: accepted.map(({ observedAt, cents }) => ({ observedAt, cents })),
    now,
    currency: watch.currency,
    market: market.map((m) => ({ observedAt: m.observedAt, cents: m.cents })),
    // Force verdictCore's own staleness branch to fire whenever OUR (more
    // reliable) `priceStale` says so, rather than trusting it to re-derive
    // the same answer from `now` -- `now` itself can fall back to
    // `watch.lastObservedAt` right above when the caller omitted its own
    // coarse `now`, which would make "now - priceObservedAt" trivially zero
    // and mask real staleness. An artificially-old timestamp (already past
    // STALE_PRICE_MS) makes verdictCore compute its own honest reason text
    // instead of duplicating it here.
    priceObservedAt: priceStale ? now - STALE_PRICE_MS - 1 : priceObservedAt,
  });
  const marketPoints = [...market].sort((a, b) => a.observedAt - b.observedAt);
  const marketPrices = marketPoints.map((m) => m.cents);
  const newest = checks[0];
  return {
    _id: watch._id,
    _creationTime: watch._creationTime,
    name: watch.name,
    productUrl: watch.productUrl,
    merchantDomain: watch.merchantDomain,
    imageUrl: watch.imageUrl ?? null,
    currency: watch.currency ?? null,
    targetCents: watch.targetCents ?? null,
    status: watch.status,
    lastCheckedAt: watch.lastCheckedAt ?? null,
    lastObservedAt: watch.lastObservedAt ?? null,
    priceStale,
    nextCheckAt: watch.nextCheckAt,
    lastCents: currentCents,
    listCents,
    targetHit:
      !priceStale &&
      watch.targetCents !== undefined &&
      currentCents !== null &&
      currentCents <= watch.targetCents,
    checkRequestedAt: watch.checkRequestedAt ?? null,
    lastNote: newest && newest.observedCents === undefined ? (newest.note ?? null) : null,
    purchaseId: watch.purchaseId ?? null,
    verdict: result,
    spark: accepted
      .slice(0, SPARK_POINTS)
      .reverse()
      .map(({ observedAt, cents }) => ({ observedAt, observedCents: cents })),
    market:
      marketPoints.length === 0
        ? watch.marketNote === undefined
          ? null
          : {
              source: "shopsavvy" as const,
              points: [],
              lowestCents: 0,
              highestCents: 0,
              since: 0,
              note: watch.marketNote,
            }
        : {
            source: "shopsavvy" as const,
            points: marketPoints.map((m) => ({
              observedAt: m.observedAt,
              cents: m.cents,
              retailer: m.retailer === "market" ? null : m.retailer,
            })),
            lowestCents: Math.min(...marketPrices),
            highestCents: Math.max(...marketPrices),
            since: marketPoints[0].observedAt,
            note: watch.marketNote ?? null,
          },
  };
}

/**
 * The caller's non-archived watches, newest first. `[]` when signed out --
 * and, per D115 6b-3/T18.3, `[]` for a tombstoned (`accountState` status
 * `deleting`/`deleted`) caller too, so a just-revoked but still momentarily
 * valid JWT cannot keep reading this account's watches mid-purge.
 *
 * `now` (P06/D73) is an optional coarse timestamp (validated by
 * `assertCoarseNow`) the client refreshes on its own cadence and re-passes;
 * it drives only display-derived fields (`priceStale`, `targetHit`, the
 * verdict) -- never eligibility. Omitting it is safe: staleness then falls
 * back to each watch's own data (see `summarise`) instead of a wall-clock read.
 */
export const list = query({
  args: { now: v.optional(v.number()) },
  returns: v.array(watchSummary),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || (await isTombstoned(ctx, userId))) return [];
    // One bounded indexed page per live status, rather than reading every row
    // the user ever had and dropping the archived ones afterwards.
    const pages = await Promise.all(
      LIVE_STATUSES.map((status) =>
        ctx.db
          .query("watches")
          .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
          .order("desc")
          .take(LIST_LIMIT),
      ),
    );
    const watches = pages
      .flat()
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, LIST_LIMIT);
    const now = assertCoarseNow(args.now);
    return await Promise.all(
      watches.map(async (w) =>
        summarise(w, await recentChecks(ctx, w._id, VERDICT_WINDOW), now, await marketFor(ctx, w._id)),
      ),
    );
  },
});

/**
 * One watch with its recent checks (newest first). `null` when missing, archived or not the
 * caller's -- and, per D115 6b-3/T18.3, `null` for a tombstoned caller too (see `list`'s doc
 * comment). Same `now` contract as `list`.
 */
export const get = query({
  args: { watchId: v.id("watches"), now: v.optional(v.number()) },
  returns: v.union(v.object({ watch: watchSummary, checks: v.array(watchCheckView) }), v.null()),
  handler: async (ctx, { watchId, now: argsNow }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || (await isTombstoned(ctx, userId))) return null;
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.userId !== userId || watch.status === "archived") return null;
    const checks = await recentChecks(ctx, watchId, GET_CHECKS);
    const now = assertCoarseNow(argsNow);
    return {
      watch: summarise(watch, checks, now, await marketFor(ctx, watchId)),
      checks: checks.map((c) => ({
        _id: c._id,
        observedAt: c.observedAt,
        observedCents: c.observedCents ?? null,
        listCents: c.listCents ?? null,
        currency: c.currency ?? null,
        confidence: c.confidence ?? null,
        variantMatch: c.variantMatch ?? null,
        sourceUrl: c.sourceUrl,
        note: c.note ?? null,
      })),
    };
  },
});

// ---------------------------------------------------------------------------
// Public writes
// ---------------------------------------------------------------------------

/** Fails closed: throws unless the caller is under both the standing cap and the hourly create cap. */
async function consumeCreateLimit(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<void> {
  const recent = await ctx.db
    .query("watches")
    .withIndex("by_user", (q) =>
      q.eq("userId", userId).gt("_creationTime", now - WATCH_CREATE_WINDOW_MS),
    )
    .take(MAX_WATCH_CREATES_PER_HOUR);
  if (recent.length >= MAX_WATCH_CREATES_PER_HOUR) {
    throw new ConvexError("You have added a lot of items in the last hour; try again a little later");
  }
  let live = 0;
  for (const status of LIVE_STATUSES) {
    const page = await ctx.db
      .query("watches")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
      .take(MAX_WATCHES_PER_USER);
    live += page.length;
  }
  if (live >= MAX_WATCHES_PER_USER) {
    throw new ConvexError(`You can watch up to ${MAX_WATCHES_PER_USER} items; archive one to add another`);
  }
}

function cleanTarget(targetCents: number | undefined): number | undefined {
  return targetCents === undefined ? undefined : assertPositiveCents(targetCents, "targetCents");
}

/** Paste a link. The first check is scheduled here, inside the transaction that consumed the limits. */
export const create = mutation({
  args: {
    productUrl: v.string(),
    name: v.optional(v.string()),
    targetCents: v.optional(v.number()),
  },
  returns: v.id("watches"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const parsed = parseProductUrl(args.productUrl);
    if (!parsed) throw new ConvexError("Paste a full product link starting with http:// or https://");
    // Control characters never reach a stored name (review LOW, subject injection; F1).
    const givenName = args.name === undefined ? undefined : cleanLine(args.name);
    if (givenName !== undefined && givenName.length > MAX_NAME_CHARS) {
      throw new ConvexError(`name must be at most ${MAX_NAME_CHARS} characters`);
    }
    const targetCents = cleanTarget(args.targetCents);

    const now = Date.now();
    await consumeCreateLimit(ctx, userId, now);
    // The first check is paid: it draws from the deployment-wide switch like every other check.
    await consumeGlobalBudget(ctx, "price_check", GLOBAL_DAILY_BUDGETS.price_check.max, 1, now);

    const watchId = await ctx.db.insert("watches", {
      userId,
      name: givenName ? givenName : defaultWatchName(parsed.productUrl),
      productUrl: parsed.productUrl,
      merchantDomain: parsed.merchantDomain,
      targetCents,
      status: "active",
      // The first check is scheduled right below, so the row starts just out
      // of the sweep's reach; otherwise a tick landing in the next few seconds
      // would pay for the same page twice.
      nextCheckAt: now + WATCH_SWEEP_BUMP_MS,
      checkRequestedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.watches.checkWatch, { watchId });
    return watchId;
  },
});

/** "Check now". The cooldown is stamped on the row at schedule time, so two rapid clicks cannot both pass. */
export const checkNow = mutation({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, watchId, userId);
    if (watch.status === "archived" || watch.status === "bought") {
      throw new ConvexError("This item is no longer being watched");
    }
    const now = Date.now();
    const last = Math.max(watch.checkRequestedAt ?? 0, watch.lastCheckedAt ?? 0);
    if (now - last < WATCH_CHECK_COOLDOWN_MS) {
      throw new ConvexError("This item was just checked; try again in a few minutes");
    }
    // H2: the cooldown is per watch, so 50 watches could still buy 7,200 checks a day. Per-user and global caps.
    await charge(ctx, userId, "watch_check", now);
    await ctx.db.patch(watchId, { checkRequestedAt: now });
    await ctx.scheduler.runAfter(0, internal.watches.checkWatch, { watchId });
    return null;
  },
});

/** Set or clear (`null`) the target price. */
export const setTarget = mutation({
  args: { watchId: v.id("watches"), targetCents: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { watchId, targetCents }) => {
    const userId = await requireUserId(ctx);
    await ownedWatch(ctx, watchId, userId);
    await ctx.db.patch(watchId, { targetCents: cleanTarget(targetCents ?? undefined) });
    return null;
  },
});

/** Rename a watch. A user-given name is never overwritten by the extractor. */
export const rename = mutation({
  args: { watchId: v.id("watches"), name: v.string() },
  returns: v.null(),
  handler: async (ctx, { watchId, name }) => {
    const userId = await requireUserId(ctx);
    await ownedWatch(ctx, watchId, userId);
    const trimmed = assertNonEmpty(cleanLine(name), "name");
    if (trimmed.length > MAX_NAME_CHARS) {
      throw new ConvexError(`name must be at most ${MAX_NAME_CHARS} characters`);
    }
    await ctx.db.patch(watchId, { name: trimmed });
    return null;
  },
});

/** Pause or resume. Resuming makes the watch due at the next sweep; it does not spend anything itself. */
export const setStatus = mutation({
  args: { watchId: v.id("watches"), status: v.union(v.literal("active"), v.literal("paused")) },
  returns: v.null(),
  handler: async (ctx, { watchId, status }) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, watchId, userId);
    if (watch.status === "archived" || watch.status === "bought") {
      throw new ConvexError("This item is no longer being watched");
    }
    if (watch.status === status) return null; // a retry is a no-op
    if (status === "paused") {
      await ctx.db.patch(watchId, { status });
      return null;
    }
    const now = Date.now();
    // Due now, unless it was checked recently enough that its old slot is still ahead.
    const dueAt = Math.max(now, (watch.lastCheckedAt ?? 0) + WATCH_CHECK_INTERVAL_MS);
    await ctx.db.patch(watchId, { status, nextCheckAt: dueAt });
    return null;
  },
});

/** Hide a watch for good. Idempotent. Checks are kept. */
export const archive = mutation({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, watchId, userId);
    if (watch.status !== "archived") await ctx.db.patch(watchId, { status: "archived" });
    return null;
  },
});

/** "Acme" from `acme.example`, "Big Store" from `big-store.co.uk`: the first label, spaced and capitalised. */
function merchantName(merchantDomain: string): string {
  const label = merchantDomain.split(".")[0] ?? "";
  const words = label.split(/[-_]+/).filter((w) => w.length > 0);
  if (words.length === 0) return merchantDomain;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * "I bought it" (W4). The watch becomes an active purchase with one item, its
 * accepted price history carries over, and both policy kinds are researched
 * exactly as `purchases.create` does, so the price-adjustment window starts
 * counting down. The watch ends as `bought`: never swept, checked or alerted
 * again. A second call is refused, so a retry cannot create a second purchase.
 */
export const markBought = mutation({
  args: {
    watchId: v.id("watches"),
    paidCents: v.number(),
    purchasedAt: v.number(),
    qty: v.optional(v.number()),
    orderRef: v.optional(v.string()),
  },
  returns: v.id("purchases"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, args.watchId, userId);
    if (watch.status === "bought") throw new ConvexError("This item is already marked as bought");
    if (watch.status !== "active" && watch.status !== "paused") {
      throw new ConvexError("This item is no longer being watched");
    }
    // Same validations as `purchases.create`, except a paid price of zero is refused.
    const unitCents = assertPositiveCents(args.paidCents, "paidCents");
    const purchasedAt = purchasedAtNotAfterNow(args.purchasedAt);
    const qty = assertQty(args.qty ?? 1);
    const currency = assertCurrency(watch.currency ?? "USD");
    const orderRef = (args.orderRef === undefined ? "" : cleanLine(args.orderRef)) || undefined;
    if (orderRef !== undefined && orderRef.length > MAX_ORDER_REF_CHARS) {
      throw new ConvexError(`orderRef must be at most ${MAX_ORDER_REF_CHARS} characters`);
    }

    // B4: the same ceiling as `purchases.create`, archived rows included.
    const held = await ctx.db
      .query("purchases")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PURCHASES_PER_USER);
    if (held.length >= MAX_PURCHASES_PER_USER) {
      throw new ConvexError(`You can keep up to ${MAX_PURCHASES_PER_USER} purchases`);
    }

    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: merchantName(watch.merchantDomain),
      // Already the bare registrable host: `parseProductUrl` normalised it at create.
      merchantDomain: watch.merchantDomain,
      orderRef,
      purchasedAt,
      currency,
      status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: watch.name,
      unitCents,
      qty,
      productUrl: watch.productUrl,
      returned: false,
      imageUrl: watch.imageUrl,
    });

    // Newest accepted checks, bounded; inserted oldest first so `by_item`
    // (creation order) reads the same way the watch's history did.
    const carried: Doc<"watchChecks">[] = [];
    let scanned = 0;
    const newestFirst = ctx.db
      .query("watchChecks")
      .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
      .order("desc");
    for await (const check of newestFirst) {
      if (check.observedCents !== undefined) carried.push(check);
      if (carried.length >= CARRY_OVER_CHECKS || ++scanned >= CARRY_OVER_SCAN) break;
    }
    for (const check of carried.reverse()) {
      await ctx.db.insert("priceChecks", {
        itemId,
        userId,
        observedCents: check.observedCents,
        currency: check.currency,
        confidence: check.confidence,
        variantMatch: check.variantMatch,
        observedAt: check.observedAt,
        sourceUrl: check.sourceUrl,
      });
    }

    // DA-A-35: this is a direct purchase insert, so it must create the transaction itself.
    await ensurePurchaseTransaction(ctx, purchaseId);
    await ctx.db.patch(watch._id, { status: "bought", purchaseId });
    // B4: same shared daily budget as `purchases.create`; over it the purchase is still made, without the research.
    await schedulePolicyFetch(ctx, userId, watch.merchantDomain);
    return purchaseId;
  },
});

// ---------------------------------------------------------------------------
// Check: read, observe, record
// ---------------------------------------------------------------------------

/** What `checkWatch` needs. Unauthenticated on purpose: called only by `checkWatch`. */
export const watchForCheck = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.union(
    v.object({ productUrl: v.string(), name: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.status === "archived" || watch.status === "bought") return null;
    // D87: a scheduled job outlives the account it was queued for; refuse to spend on a deleted user.
    if (await isTombstoned(ctx, watch.userId)) return null;
    // A placeholder name says nothing about the product; let the extractor name it.
    const named = watch.name !== defaultWatchName(watch.productUrl);
    return { productUrl: watch.productUrl, name: named ? watch.name : null };
  },
});

/**
 * Scrapes one watched page and records what it saw. Never throws past the
 * scheduler: a dead page, a missing key or a refusing model all end as a
 * `watchChecks` row with a note, and the watch still moves to its next slot.
 */
export const checkWatch = internalAction({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.runQuery(internal.watches.watchForCheck, { watchId });
    if (!watch) return null;

    let observed: PageObservation;
    try {
      observed = await observePrice(ctx, watch.name, watch.productUrl);
    } catch (err) {
      // T24c (D109): structured, redacted line instead of a bare console.error.
      logEvent("price_check_failed", { watchId, error: sanitizeError(err instanceof Error ? err.message : String(err)) });
      observed = { note: errorNote("Price check failed", err) };
    }
    const result = await ctx.runMutation(internal.watches.recordWatchCheck, {
      watchId,
      sourceUrl: watch.productUrl,
      ...observed,
    });

    // F5: a watch's confirmed "same item at another store" offers were never
    // re-checked after the initial find, so "Cheapest confirmed" could go
    // stale forever. Ride this successful check to also refresh them, but
    // only when at least one is actually overdue (`dueForRecheck` reuses
    // `OFFER_FIND_COOLDOWN_MS`, the same cadence `offers.find` already
    // respects), so a watch with no confirmed offers -- the common case --
    // costs nothing extra, and one with some is not re-scraped every 2h tick.
    if (result.accepted) {
      const due = await ctx.runQuery(internal.offers.dueForRecheck, { watchId });
      if (due) await ctx.scheduler.runAfter(0, internal.offers.recheck, { watchId });
    }
    return null;
  },
});

/**
 * Stores one observation of a watched page and moves the watch on.
 *
 * Unauthenticated on purpose: the caller is `checkWatch`, and tests. Nothing
 * here takes a `userId` from outside; ownership is read off the watch.
 */
export const recordWatchCheck = internalMutation({
  args: {
    watchId: v.id("watches"),
    sourceUrl: v.string(),
    /** Integer minor units, already converted by the caller. */
    observedCents: v.optional(v.number()),
    listCents: v.optional(v.number()),
    currency: v.optional(v.string()),
    confidence: v.optional(v.number()),
    isRange: v.optional(v.boolean()),
    variantMatch: v.optional(variantMatch),
    productName: v.optional(v.string()),
    note: v.optional(v.string()),
    /** The page's Open Graph image; stored only when it is an absolute https URL (lib/imageUrl.ts). */
    imageUrl: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args) => {
    const watch = await ctx.db.get(args.watchId);
    if (!watch) throw new ConvexError("Watch not found");
    const now = Date.now();

    let rejection = rejectionReason(args, watch.currency ?? null, "this item is tracked");
    // Normalise (ARCHITECTURE_PATTERNS §Actions): the first accepted currency
    // becomes the watch's currency, so it must at least look like one.
    if (rejection === null && args.observedCents !== undefined && !/^[A-Z]{3}$/.test(args.currency ?? "")) {
      rejection = "The page does not state a recognisable currency";
    }
    const accepted = rejection === null && args.observedCents !== undefined;
    const observedCents = accepted ? args.observedCents : undefined;
    // A "was" price is kept only beside an accepted price it actually exceeds.
    const listCents =
      observedCents !== undefined &&
      args.listCents !== undefined &&
      Number.isSafeInteger(args.listCents) &&
      args.listCents > observedCents
        ? args.listCents
        : undefined;
    const note = rejection === null ? args.note : rejection;

    const watchCheckId = await ctx.db.insert("watchChecks", {
      watchId: watch._id,
      userId: watch.userId,
      observedCents,
      listCents,
      currency: args.currency,
      confidence: args.confidence,
      variantMatch: args.variantMatch,
      observedAt: now,
      sourceUrl: args.sourceUrl,
      note: note === undefined ? undefined : truncate(note),
    });

    const patch: Partial<Doc<"watches">> = {
      // Attempt, whether or not it produced a usable price (P06/D73): a
      // failed read still bumps this, so "when did we last try" is honest.
      lastCheckedAt: now,
      nextCheckAt: now + WATCH_CHECK_INTERVAL_MS,
    };
    if (observedCents !== undefined) {
      patch.lastCents = observedCents;
      // The last SUCCESSFUL observation, distinct from `lastCheckedAt`
      // (P06/D73): this is what `priceStale`/the verdict's staleness gate
      // compare against, so a run of failed reads cannot make an old price
      // look current just because we keep trying.
      patch.lastObservedAt = now;
      if (watch.currency === undefined) patch.currency = args.currency;
    }
    // The page controls this string; it is stored as one clean line like a name the user typed.
    // A page we could not read yields a name that is punctuation only ("."), which must not
    // replace the readable default; `meaningfulName` returns null for those (seen live 2026-09-20).
    const productName = meaningfulName(args.productName);
    if (
      productName &&
      args.variantMatch !== "none" &&
      watch.name === defaultWatchName(watch.productUrl)
    ) {
      patch.name = productName.slice(0, MAX_NAME_CHARS);
    }
    // A page that is "not that product" says nothing about what this one looks like.
    const imageUrl = args.variantMatch === "none" ? undefined : imageUrlChange(watch.imageUrl, args.imageUrl);
    if (imageUrl !== undefined) patch.imageUrl = imageUrl;
    await ctx.db.patch(watch._id, patch);

    // W2: `watch` is still the row as it was before this check, so its
    // `lastCents` is the previous accepted price. The claim is written here,
    // in the transaction that accepted the price, so a re-run cannot mail twice.
    if (observedCents !== undefined) {
      await claimDrop(ctx, watch, observedCents, watch.currency ?? args.currency ?? "USD");
    }

    // W1b/T10 (D71): once we know the product is real and what currency it
    // prices in, ask ShopSavvy for the history we do not have. `requestLookup`
    // is the single source of truth for whether a lookup is due -- it reads
    // `marketState`, checks archived/tombstoned, and charges the budget it
    // draws from, all in its own transaction, so this call site no longer
    // duplicates any of that gating. The one check kept here is `bought`: a
    // bought watch is never checked again (see `watchForCheck`), so a
    // scheduled call that would immediately no-op is not worth the scheduler
    // slot.
    if (observedCents !== undefined && watch.status !== "bought") {
      await ctx.scheduler.runAfter(0, internal.market.requestLookup, { watchId: watch._id, trigger: "auto" });
    }

    return { watchCheckId, accepted, note: note === undefined ? null : truncate(note) };
  },
});

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * The cron target (hourly). The tick is not the cadence: each watch carries
 * its own `nextCheckAt`, and a tick with nothing due costs one indexed read.
 * Idempotent: every scheduled row is pushed out of the due range in the same
 * transaction, so a second tick cannot schedule it again while it is in flight.
 *
 * Fairness (D74): the page is read exactly as before (`WATCH_SWEEP_PAGE`,
 * earliest-due-first), but at most `WATCH_SWEEP_PER_USER` rows per user in
 * that page are actually scheduled. EVERY row in the page -- scheduled or
 * merely rotated past the per-user cap -- is bumped `WATCH_SWEEP_BUMP_MS`
 * out of the due range, so one user's backlog cannot make the same page
 * repeat forever: each tick drains a full `WATCH_SWEEP_PAGE` worth of rows
 * out of the due set, advancing the scan deep enough to reach a quieter
 * user's watch within a bounded number of ticks, not just `PER_USER` at a
 * time. Rows cut purely by the global budget are the one exception: left
 * completely untouched (not bumped), so they stay due and are retried as
 * soon as the switch resets (H3), same as before this change. F2 (D103): a
 * tombstoned owner's watches are bumped `INELIGIBLE_REST_MS` out of the due
 * set (not scheduled), instead of being skipped untouched -- left alone, a
 * backlog of them (say the exact page size) would occupy the same due page
 * on every subsequent tick forever, since nothing else ever moves their
 * `nextCheckAt`, permanently starving any live watch behind them out of the
 * scan. The account purge (not this sweep) is what removes them for good;
 * this bump only keeps them from crowding the due set meanwhile.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    const due = await ctx.db
      .query("watches")
      .withIndex("by_status_nextCheck", (q) => q.eq("status", "active").lte("nextCheckAt", now))
      .take(WATCH_SWEEP_PAGE);

    const perUser = new Map<Id<"users">, number>();
    const candidates: Doc<"watches">[] = []; // under the per-user cap; pending the global budget
    const rotated: Doc<"watches">[] = []; // over the per-user cap this tick; bumped, not scheduled
    for (const w of due) {
      if (await isTombstoned(ctx, w.userId)) {
        await ctx.db.patch(w._id, { nextCheckAt: now + INELIGIBLE_REST_MS });
        continue;
      }
      const count = perUser.get(w.userId) ?? 0;
      if (count < WATCH_SWEEP_PER_USER) {
        perUser.set(w.userId, count + 1);
        candidates.push(w);
      } else {
        rotated.push(w);
      }
    }

    // H3: every check is paid, so the tick only schedules what the deployment-wide daily switch still allows.
    // Rows cut here (not by the per-user cap) stay due and are picked up by the first tick after the switch resets.
    const allowed = await takeGlobalBudget(ctx, "price_check", candidates.length, now);
    const toSchedule = candidates.slice(0, allowed);

    for (let i = 0; i < toSchedule.length; i++) {
      await ctx.db.patch(toSchedule[i]._id, {
        nextCheckAt: now + WATCH_SWEEP_BUMP_MS,
        checkRequestedAt: now,
      });
      await ctx.scheduler.runAfter(i * WATCH_SWEEP_STAGGER_MS, internal.watches.checkWatch, {
        watchId: toSchedule[i]._id,
      });
    }
    for (const w of rotated) {
      await ctx.db.patch(w._id, { nextCheckAt: now + WATCH_SWEEP_BUMP_MS });
    }
    return toSchedule.length;
  },
});
