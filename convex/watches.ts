/**
 * Watches (W1): a product the user has NOT bought yet, checked every six hours
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
import { assertCurrency, assertNonEmpty, assertPositiveCents, assertQty, assertTimestamp } from "./lib/money";
import { claimDrop } from "./notify";
import { defaultWatchName, parseProductUrl } from "./lib/watchUrl";
import { verdict, type Verdict } from "./lib/verdict";
import { imageUrlChange } from "./lib/imageUrl";
import { cleanLine } from "./lib/text";
import { charge, consumeGlobalBudget, takeGlobalBudget } from "./lib/budget";
import { schedulePolicyFetch } from "./policies";
import { errorNote, observePrice, rejectionReason, truncate, type PageObservation } from "./priceWatch";
import {
  GLOBAL_DAILY_BUDGETS,
  MAX_PURCHASES_PER_USER,
  MAX_WATCHES_PER_USER,
  MAX_WATCH_CREATES_PER_HOUR,
  WATCH_CHECK_COOLDOWN_MS,
  WATCH_CHECK_INTERVAL_MS,
  WATCH_CREATE_WINDOW_MS,
  WATCH_SWEEP_BUMP_MS,
  WATCH_SWEEP_PAGE,
  WATCH_SWEEP_STAGGER_MS,
} from "./limits";

/** Accepted watch checks carried into a purchase's price history by `markBought`. */
const CARRY_OVER_CHECKS = 90;
/** Rows `markBought` may walk to find them; failed checks sit between accepted ones. */
const CARRY_OVER_SCAN = 360;
const MAX_ORDER_REF_CHARS = 100;

const MAX_NAME_CHARS = 200;
/** `list` page size. */
const LIST_LIMIT = 100;
/** Newest checks the verdict is computed from, in `list` and `get` alike (15 days at the 6h cadence). */
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
  lastCheckedAt: v.union(v.number(), v.null()),
  nextCheckAt: v.number(),
  /** Latest accepted price. */
  lastCents: v.union(v.number(), v.null()),
  /** The page's claimed "was" price at the latest accepted check, unverified. */
  listCents: v.union(v.number(), v.null()),
  /** True when a target is set and the latest accepted price is at or under it. */
  targetHit: v.boolean(),
  /** True while a scheduled check has not recorded yet. */
  checking: v.boolean(),
  /** Why the most recent check produced no price, when it did not. */
  lastNote: v.union(v.string(), v.null()),
  purchaseId: v.union(v.id("purchases"), v.null()),
  verdict: verdictValidator,
  /** Accepted observations, oldest first, at most 30. */
  spark: v.array(sparkPoint),
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

/** `checks` newest first. The verdict only ever sees the newest VERDICT_WINDOW. */
function summarise(
  watch: Doc<"watches">,
  checks: Doc<"watchChecks">[],
  now: number,
): Infer<typeof watchSummary> {
  const window = checks.slice(0, VERDICT_WINDOW);
  const accepted = window.flatMap((c) =>
    c.observedCents === undefined ? [] : [{ observedAt: c.observedAt, cents: c.observedCents, listCents: c.listCents }],
  );
  const latest = accepted[0];
  const currentCents = watch.lastCents ?? null;
  const listCents = latest?.listCents ?? null;
  const result: Verdict = verdict({
    currentCents,
    listCents,
    history: accepted.map(({ observedAt, cents }) => ({ observedAt, cents })),
    now,
    currency: watch.currency,
  });
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
    nextCheckAt: watch.nextCheckAt,
    lastCents: currentCents,
    listCents,
    targetHit:
      watch.targetCents !== undefined && currentCents !== null && currentCents <= watch.targetCents,
    checking:
      watch.checkRequestedAt !== undefined &&
      watch.checkRequestedAt > (watch.lastCheckedAt ?? 0) &&
      now - watch.checkRequestedAt < WATCH_CHECK_COOLDOWN_MS,
    lastNote: newest && newest.observedCents === undefined ? (newest.note ?? null) : null,
    purchaseId: watch.purchaseId ?? null,
    verdict: result,
    spark: accepted
      .slice(0, SPARK_POINTS)
      .reverse()
      .map(({ observedAt, cents }) => ({ observedAt, observedCents: cents })),
  };
}

/** The caller's non-archived watches, newest first. `[]` when signed out. */
export const list = query({
  args: {},
  returns: v.array(watchSummary),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
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
    const now = Date.now();
    return await Promise.all(
      watches.map(async (w) => summarise(w, await recentChecks(ctx, w._id, VERDICT_WINDOW), now)),
    );
  },
});

/** One watch with its recent checks (newest first). `null` when missing, archived or not the caller's. */
export const get = query({
  args: { watchId: v.id("watches") },
  returns: v.union(v.object({ watch: watchSummary, checks: v.array(watchCheckView) }), v.null()),
  handler: async (ctx, { watchId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.userId !== userId || watch.status === "archived") return null;
    const checks = await recentChecks(ctx, watchId, GET_CHECKS);
    return {
      watch: summarise(watch, checks, Date.now()),
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
    const purchasedAt = assertTimestamp(args.purchasedAt, "purchasedAt");
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
      console.error(`watches.checkWatch failed for ${watchId}`, err);
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
      lastCheckedAt: now,
      nextCheckAt: now + WATCH_CHECK_INTERVAL_MS,
    };
    if (observedCents !== undefined) {
      patch.lastCents = observedCents;
      if (watch.currency === undefined) patch.currency = args.currency;
    }
    // The page controls this string; it is stored as one clean line like a name the user typed.
    const productName = args.productName === undefined ? undefined : cleanLine(args.productName);
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
    // H3: every check is paid, so the tick only schedules what the deployment-wide daily switch still allows.
    // Rows left out stay due and are picked up by the first tick after the switch resets.
    const allowed = await takeGlobalBudget(ctx, "price_check", due.length, now);
    due.length = allowed;
    for (let i = 0; i < due.length; i++) {
      await ctx.db.patch(due[i]._id, {
        nextCheckAt: now + WATCH_SWEEP_BUMP_MS,
        checkRequestedAt: now,
      });
      await ctx.scheduler.runAfter(i * WATCH_SWEEP_STAGGER_MS, internal.watches.checkWatch, {
        watchId: due[i]._id,
      });
    }
    return due.length;
  },
});
