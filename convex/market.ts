/**
 * Third-party price history (W1b, day one).
 *
 * Our own history starts when a watch starts, so a brand-new watch can only say
 * "not enough history yet". ShopSavvy has indexed retail prices for years, so
 * one call per watched product gives a range a shopper has actually seen, plus
 * the other stores selling it.
 *
 * Boundaries, enforced here and relied on elsewhere:
 *  - Prices from this source are written to `marketPrices` and to `offers` rows
 *    marked `source: "shopsavvy"`. They are never written to `watchChecks`,
 *    which is the record of what Recoup read itself.
 *  - They never open a claim and never send an alert. Both of those are
 *    statements about money and stay with our own read of the store's page.
 *
 * State machine (D71): `marketState` on the watch is the single source of
 * truth for where a lookup stands —
 *   not_configured -> (key set) -> queued -> running -> success
 *                                                     -> empty_result
 *                                                     -> retryable_failure -> queued (auto retry) -> ... -> terminal_failure
 *                                                     -> terminal_failure
 * `requestLookup` is the only place that moves a watch into `queued`: it reads
 * the current state, refuses or charges, and schedules `lookup` in the same
 * transaction, so two callers racing for the same watch can only ever produce
 * one charge and one scheduled fetch (Convex's OCC serialises the two
 * mutations on the watch row). `lookup` never writes the database directly;
 * it always ends by calling `recordSnapshot`, which re-reads the watch and
 * refuses to write if it stopped being eligible while the fetch was in
 * flight (archived, bought, or the owner's account was tombstoned).
 */
import { v, type Infer } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { ownedWatch, requireUserId } from "./lib/access";
import { isTombstoned } from "./lib/accountState";
import { logEvent } from "./lib/log";
import { sanitizeError } from "./lib/errors";
import { tryCharge, tryConsumeGlobalBudget } from "./lib/budget";
import { cleanStoreUrl, FIND_MARKER, registrableHost, sameStore } from "./lib/offerMatch";
import { WATCH_ROWS } from "./offers";
import { parseSnapshot, flattenHistory, hostOf, type MarketSnapshot } from "./lib/shopsavvy";
import { marketState } from "./schema";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
  MARKET_CLAIM_STALE_MS,
  MARKET_HISTORY_DAYS,
  MARKET_MAX_ATTEMPTS,
  MARKET_MAX_POINTS,
  MARKET_MAX_STORES,
  MARKET_REFRESH_MIN_AGE_MS,
  MARKET_RETRY_BACKOFF_MS,
  MAX_OFFERS_PER_WATCH,
} from "./limits";

const BASE_URL = "https://api.shopsavvy.com/v1";
const TIMEOUT_MS = 30_000;

/**
 * A response past this many characters is treated as malformed rather than
 * parsed (P04/T04 boundary hardening applied to the transport itself): a
 * real product's price history is a few KB of JSON, and reading an unbounded
 * body into memory before validating any of it is the kind of thing a
 * hostile or corrupted response could exploit. The body is always read as
 * text and length-checked before `JSON.parse` ever sees it.
 */
const MAX_RESPONSE_CHARS = 2_000_000;

/** Bounded resumable cursor key for `migrateStamps` (D75-style, via `opsState`). */
const MIGRATE_OPS_KEY = "market.migrateStamps";
/** Watches one `migrateStamps` transaction scans before rescheduling itself. */
const MIGRATE_PAGE = 100;

type MarketState = Infer<typeof marketState>;

/** Shared shape of `requestLookup`/`refresh`'s result, annotated explicitly so every early return's
 * string literals stay narrowed to `MarketState` instead of widening to `string` (and, for `refresh`,
 * to work around the same-file `ctx.runMutation` circularity the Convex guidelines call out). */
type RequestLookupResult = { scheduled: boolean; state: MarketState; reason?: string };

/** Fixed, non-enumerating user-facing copy per terminal-ish state (D71). Never the raw provider error. */
const MARKET_NOTE: Partial<Record<MarketState, string>> = {
  not_configured: "Market history is not configured on this deployment",
  empty_result: "ShopSavvy has no price history for this product",
  retryable_failure: "Could not read market history; we will try again",
  terminal_failure: "Market history is unavailable for this product",
};

/**
 * A day of history costs a credit, so the window is a constant and never a caller's argument.
 * The parameter names are `start`/`end`: `start_date`/`end_date` are accepted and silently
 * ignored, which returns every offer with an empty history array (found live).
 */
function historyRange(now: number): { start: string; end: string } {
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { start: day(now - MARKET_HISTORY_DAYS * 86_400_000), end: day(now) };
}

/** An HTTP response ShopSavvy returned with a non-2xx status. Only the status is kept — the body can echo the key back. */
class ShopSavvyHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`ShopSavvy returned ${status}`);
    this.status = status;
  }
}

/** The response body could not be trusted enough to parse: too large, or not valid JSON. */
class MalformedResponseError extends Error {}

/**
 * One live call. Returns null when the key is unset (the feature is simply
 * off) and throws on anything else, so the caller classifies the failure.
 * The body is read as text with a bounded length before it is ever parsed.
 */
export async function fetchSnapshot(productUrl: string, now: number): Promise<MarketSnapshot | null> {
  const key = process.env.SHOPSAVVY_API_KEY;
  if (!key) return null;

  const { start, end } = historyRange(now);
  const url =
    `${BASE_URL}/products/offers/history?ids=${encodeURIComponent(productUrl)}` +
    `&start=${start}&end=${end}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new ShopSavvyHttpError(res.status);

  // F8 (D103): a declared Content-Length already over the cap is rejected BEFORE the body is ever
  // buffered into memory, so a malformed or hostile multi-hundred-MB response costs nothing to refuse.
  // This is an optimization, not the guard: the header is caller-supplied and can be absent, wrong, or
  // a lie, so the post-read check on the actual decoded length below stays as the authoritative one.
  const declaredLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_CHARS) {
    await res.body?.cancel();
    throw new MalformedResponseError("declared a size over the cap");
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new MalformedResponseError("exceeded the size cap");

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new MalformedResponseError("was not valid JSON");
  }
  return parseSnapshot(body, now);
}

/** 400/401/403/malformed -> give up; 429/5xx/timeout/network -> worth another attempt. */
function classifyFetchError(err: unknown): "retryable_failure" | "terminal_failure" {
  if (err instanceof MalformedResponseError) return "terminal_failure";
  if (err instanceof ShopSavvyHttpError) {
    return err.status === 429 || err.status >= 500 ? "retryable_failure" : "terminal_failure";
  }
  // Timeouts (AbortSignal.timeout -> DOMException) and network failures (TypeError) land here.
  return "retryable_failure";
}

/**
 * What `lookup` needs about the watch. No longer gated on `marketFetchedAt`
 * (the state machine in `requestLookup`/`markRunning` replaces that gate) —
 * only existence and archived/bought-ness, since neither an archived nor a
 * bought watch is ever worth spending a fetch on, even mid-flight (F8/D103:
 * `requestLookup` already refuses to schedule for a bought watch, but a fetch
 * already in flight when the watch is marked bought must stop here too).
 */
export const watchForMarket = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.union(
    v.object({
      productUrl: v.string(),
      currency: v.string(),
      merchantDomain: v.string(),
      /** `marketAttempts` before this run, so `lookup` can compute the next backoff step. */
      attempts: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.status === "archived" || watch.status === "bought") return null;
    return {
      productUrl: watch.productUrl,
      currency: watch.currency ?? "USD",
      merchantDomain: watch.merchantDomain,
      attempts: watch.marketAttempts ?? 0,
    };
  },
});

const pointArg = v.object({
  retailer: v.string(),
  storeDomain: v.optional(v.string()),
  cents: v.number(),
  currency: v.string(),
  observedAt: v.number(),
  marketKey: v.string(),
});

const storeArg = v.object({
  retailer: v.string(),
  storeDomain: v.string(),
  productUrl: v.string(),
  cents: v.optional(v.number()),
  currency: v.optional(v.string()),
  observedAt: v.optional(v.number()),
  /** From T04's `MarketOffer.availability` (T13): undefined when the provider did not state one, treated as in stock. */
  inStock: v.optional(v.boolean()),
});

/**
 * Fixed note on a ShopSavvy-sourced candidate the provider reports out of stock (T13/P04): never
 * priced, so it can never become "best"; still shown, qualified. Exported (D102) so
 * `src/lib/offerNotes.ts` can be verified against it by a test rather than duplicating the string by
 * hand.
 */
export const OUT_OF_STOCK_NOTE = "Out of stock according to ShopSavvy; confirm it is the same item";

/**
 * Fixed note on a ShopSavvy-sourced candidate priced in a currency other than the watch's own
 * (F5a/D103): never priced (never written to `lastCents`/`currency`), so it can never be compared,
 * ranked, or silently treated as cheaper/pricier than a same-currency offer just because the raw
 * numbers happen to differ; still shown, qualified, the same shape as an out-of-stock row.
 */
export const CURRENCY_MISMATCH_NOTE = "Listed by ShopSavvy in a different currency; price not shown here";

/**
 * C5 (D107, Opus checkpoint-5 recheck): charges the per-user `market_lookup`
 * counter only for attempt 1 -- a brand-new watch's first automatic check, or
 * ANY manual refresh (a deliberate, user-initiated ask, whatever `attempts`
 * happens to be: a manual re-try mid-backoff or a manual refresh out of
 * `terminal_failure` are both still "the user asking"). A purely automatic
 * retry continuation (`trigger === "auto"` with `attempts > 0`, i.e. the
 * scheduled follow-up after an earlier failure in THIS cycle) draws only from
 * the deployment-wide global counter.
 *
 * Before this, every attempt -- including the automatic retries F7/D103
 * itself schedules -- charged the per-user counter, so one watch's own
 * MARKET_MAX_ATTEMPTS-long failure chain could by itself exhaust the user's
 * whole daily allowance, self-locking out even a same-day MANUAL refresh
 * (DA-style self-lockout).
 */
async function chargeMarketLookup(
  ctx: MutationCtx,
  userId: Id<"users">,
  trigger: "auto" | "manual",
  attempts: number,
  now: number,
): Promise<boolean> {
  if (trigger === "auto" && attempts > 0) {
    const budget = DAILY_BUDGETS.market_lookup;
    const global = budget.global!;
    return tryConsumeGlobalBudget(ctx, global.kind, GLOBAL_DAILY_BUDGETS[global.kind].max, global.units, now);
  }
  return tryCharge(ctx, userId, "market_lookup", now);
}

/**
 * The transactional claim (D71). Both the public `refresh` and the automatic
 * path from `watches.recordWatchCheck` go through this: it is the only place
 * that reads the current state, decides whether another lookup is allowed,
 * charges the budget it draws from, and schedules the fetch — all in one
 * mutation, so two callers racing on the same watch can only ever produce one
 * scheduled job and one charge.
 */
export const requestLookup = internalMutation({
  args: { watchId: v.id("watches"), trigger: v.union(v.literal("auto"), v.literal("manual")) },
  returns: v.object({ scheduled: v.boolean(), state: marketState, reason: v.optional(v.string()) }),
  handler: async (ctx, { watchId, trigger }): Promise<RequestLookupResult> => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return { scheduled: false, state: "not_configured", reason: "not_found" };
    const now = Date.now();

    const current = watch.marketState;
    if (watch.status === "archived") return { scheduled: false, state: current ?? "not_configured", reason: "archived" };
    if (watch.status === "bought") return { scheduled: false, state: current ?? "not_configured", reason: "bought" };
    if (await isTombstoned(ctx, watch.userId)) {
      return { scheduled: false, state: current ?? "not_configured", reason: "deleted" };
    }

    if (!process.env.SHOPSAVVY_API_KEY) {
      // Never set marketFetchedAt for this branch: it is not a retrieval, and a key added later must be
      // able to run the very first lookup rather than being blocked by a stale "already looked up" mark.
      if (current !== "not_configured") await ctx.db.patch(watchId, { marketState: "not_configured" });
      return { scheduled: false, state: "not_configured", reason: "not_configured" };
    }

    if (current === "queued" || current === "running") {
      // F8 (D103): a claim that never resolved -- the scheduled `lookup` action crashed, or was killed
      // mid-flight, before it ever reached `recordSnapshot` -- must not strand the watch "in flight"
      // forever: every later `requestLookup` call would otherwise refuse for good. Reclaim it once its
      // claim is old enough that whatever was supposed to finish it almost certainly did not; treat the
      // reclaim as a fresh attempt below (falls through past this gate rather than returning here). If
      // the stale run DOES eventually finish, `recordSnapshot`'s own re-read (state must still be
      // "running") skips its write once this reclaim has moved the state on.
      const stale = watch.marketClaimedAt !== undefined && now - watch.marketClaimedAt >= MARKET_CLAIM_STALE_MS;
      if (!stale) return { scheduled: false, state: current, reason: "in_flight" };
    } else if (current === "success") {
      const stillFresh = watch.marketFetchedAt !== undefined && watch.marketFetchedAt > now - MARKET_REFRESH_MIN_AGE_MS;
      if (trigger === "auto" || stillFresh) return { scheduled: false, state: current, reason: "too_recent" };
    } else if (current === "empty_result" && trigger === "auto") {
      return { scheduled: false, state: current, reason: "empty_result" };
    } else if (current === "terminal_failure" && trigger === "auto") {
      return { scheduled: false, state: current, reason: "terminal_failure" };
    } else if (current === "retryable_failure" && watch.marketNextRetryAt !== undefined && now < watch.marketNextRetryAt) {
      return { scheduled: false, state: current, reason: "retryable_backoff" };
    }

    // F7 (D103): the auto path used to charge only the deployment-wide global switch, so one user with
    // enough watches could exhaust the ENTIRE global market_lookup budget (40/day) on their own watches'
    // first checks alone, starving every other user's for the rest of the day (DA-7). Charging the SAME
    // per-user counter for an auto lookup's FIRST attempt bounds one user's auto-triggered spend the same
    // way. C5 (D107): a pure retry continuation charges the global counter only -- see
    // `chargeMarketLookup`'s doc comment for why.
    const attempts = watch.marketAttempts ?? 0;
    if (!(await chargeMarketLookup(ctx, watch.userId, trigger, attempts, now))) {
      return { scheduled: false, state: current ?? "not_configured", reason: "budget" };
    }

    const patch: Partial<Doc<"watches">> = { marketState: "queued", marketClaimedAt: now };
    // C6 (D107): a manual refresh out of `terminal_failure` must regain a
    // full retry chain -- otherwise `marketAttempts` is still sitting at
    // MARKET_MAX_ATTEMPTS from the exhausted cycle, and the very next
    // failure (even just one) has nowhere left to go and jumps straight back
    // to terminal_failure, defeating the point of letting the user retry by
    // hand. Scoped to exactly this transition (not e.g. a retryable_failure
    // resumed past its backoff, which IS a genuine continuation of the same
    // chain and must keep counting from where it left off).
    if (current === "terminal_failure") patch.marketAttempts = 0;
    await ctx.db.patch(watchId, patch);
    await ctx.scheduler.runAfter(0, internal.market.lookup, { watchId });
    return { scheduled: true, state: "queued" };
  },
});

/**
 * A user asking for market history on a watch, or asking again once a
 * `success` is old enough to refresh. Owner-checked; the claim, the budget
 * and the state gate all live in `requestLookup`.
 */
export const refresh = mutation({
  args: { watchId: v.id("watches") },
  returns: v.object({ scheduled: v.boolean(), state: marketState, reason: v.optional(v.string()) }),
  handler: async (ctx, { watchId }) => {
    const userId = await requireUserId(ctx);
    await ownedWatch(ctx, watchId, userId); // throws for a non-owner or unknown watch
    const result: RequestLookupResult = await ctx.runMutation(internal.market.requestLookup, {
      watchId,
      trigger: "manual",
    });
    return result;
  },
});

/** `queued` (or, during the T12 rewiring window, undefined — see the file header) -> `running`. Anything else: false, and `lookup` exits without fetching or writing. */
export const markRunning = internalMutation({
  args: { watchId: v.id("watches") },
  returns: v.boolean(),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return false;
    if (watch.marketState !== "queued" && watch.marketState !== undefined) return false;
    await ctx.db.patch(watchId, { marketState: "running" });
    return true;
  },
});

/**
 * Writes one lookup's result. Re-reads the watch so a status change made
 * while the fetch was in flight (archived, bought, or the account tombstoned,
 * D87) wins: the write is skipped entirely, including the state patch, which
 * is safe because none of those watches can re-enter `queued` through
 * `requestLookup` again.
 */
export const recordSnapshot = internalMutation({
  args: {
    watchId: v.id("watches"),
    outcome: marketState,
    points: v.array(pointArg),
    stores: v.array(storeArg),
    /** Set only by `lookup`'s retry/terminal classification; omitted for success/empty_result. */
    attempts: v.optional(v.number()),
    nextRetryAt: v.optional(v.number()),
  },
  returns: v.object({ skipped: v.boolean(), points: v.number(), stores: v.number() }),
  handler: async (ctx, { watchId, outcome, points, stores, attempts, nextRetryAt }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return { skipped: true, points: 0, stores: 0 };
    if (watch.status === "archived" || watch.status === "bought") return { skipped: true, points: 0, stores: 0 };
    if (watch.marketState !== "running") return { skipped: true, points: 0, stores: 0 };
    if (await isTombstoned(ctx, watch.userId)) return { skipped: true, points: 0, stores: 0 };

    const now = Date.now();

    let written = 0;
    for (const point of points.slice(0, MARKET_MAX_POINTS)) {
      const existing = await ctx.db
        .query("marketPrices")
        .withIndex("by_key", (q) => q.eq("watchId", watchId).eq("marketKey", point.marketKey))
        .unique();
      if (existing) continue;
      await ctx.db.insert("marketPrices", {
        ...point,
        watchId,
        userId: watch.userId,
        source: "shopsavvy",
        retrievedAt: now,
      });
      written++;
    }

    // Stores ShopSavvy lists become offer candidates: the user still confirms each match (W3),
    // and an unconfirmed offer never drives a verdict or an alert. Bounded by MAX_OFFERS_PER_WATCH
    // across the watch's whole offer list, not just this call's additions.
    let added = 0;
    if (stores.length > 0) {
      // Own-store exclusion is enforced here too (not only by `lookup`'s pre-filtering, T13/P04):
      // this mutation is the actual write path, so it is the authoritative gate. Reduced to a
      // registrable host so a watch on `shop.acme.example` still excludes a "competitor" row that
      // is really just `acme.example` under a different subdomain.
      const ownDomain = registrableHost(hostOf(watch.productUrl) ?? watch.merchantDomain) ?? watch.merchantDomain;
      const watchCurrency = watch.currency ?? "USD";
      // by_watch rows include the offers.ts find-marker (storeDomain "~find"); it must not count
      // toward the per-watch cap or collide with a real store's dedupe key. F11 (D103): taken with
      // `WATCH_ROWS` (offers.ts's own generous "MAX_OFFERS_PER_WATCH stores plus one window's markers"
      // bound), not the narrower MAX_OFFERS_PER_WATCH + MARKET_MAX_STORES this used before -- that
      // narrower bound could be crowded out by FIND_MARKER rows, undercounting the real total and
      // letting more than MAX_OFFERS_PER_WATCH stores in overall (DA-8).
      const existingOffers = (
        await ctx.db
          .query("offers")
          .withIndex("by_watch", (q) => q.eq("watchId", watchId))
          .take(WATCH_ROWS)
      ).filter((r) => r.storeDomain !== FIND_MARKER);
      const known = new Set(existingOffers.map((r) => r.storeDomain));
      let total = existingOffers.length;
      for (const store of stores.slice(0, MARKET_MAX_STORES)) {
        if (total >= MAX_OFFERS_PER_WATCH) break;
        if (sameStore(store.storeDomain, ownDomain)) continue;
        if (known.has(store.storeDomain)) continue;
        known.add(store.storeDomain);
        // A store ShopSavvy reports out of stock is never priced (T13/P04): it can never become
        // "best" this way, and is still shown, qualified by the note.
        //
        // F5a (D103): nor is one priced in a currency other than the watch's own -- `flattenHistory`
        // already excludes a mismatched currency from the market POINTS series (shopsavvy.ts), but
        // nothing did the same for STORE CANDIDATES until now: a EUR-priced amazon.de row on a USD
        // watch would have been written priced, and only `offers.listForWatch`'s `best` computation
        // (a different file) happened to exclude it from ranking -- never shown as an unpriced,
        // qualified candidate the way an out-of-stock one already is (DA-11).
        const currencyMismatch = store.currency !== undefined && store.currency !== watchCurrency;
        const priced = store.inStock !== false && !currencyMismatch;
        await ctx.db.insert("offers", {
          watchId,
          userId: watch.userId,
          storeDomain: store.storeDomain,
          productUrl: store.productUrl,
          title: store.retailer,
          status: "candidate",
          source: "shopsavvy",
          lastCents: priced ? store.cents : undefined,
          currency: priced ? store.currency : undefined,
          lastCheckedAt: store.observedAt,
          note: priced ? "Listed by ShopSavvy; confirm it is the same item" : currencyMismatch ? CURRENCY_MISMATCH_NOTE : OUT_OF_STOCK_NOTE,
        });
        added++;
        total++;
      }
    }

    const patch: Partial<Doc<"watches">> = { marketState: outcome, marketNote: MARKET_NOTE[outcome] };
    // not_configured is reachable here only via the T12-rewiring transition window (see file header);
    // it is never a retrieval, so marketFetchedAt/marketObservedAt stay untouched for it.
    if (outcome !== "not_configured") {
      patch.marketFetchedAt = now;
      if (points.length > 0) patch.marketObservedAt = Math.max(...points.map((p) => p.observedAt));
    }
    if (attempts !== undefined) {
      patch.marketAttempts = attempts;
    } else if (outcome === "success" || outcome === "empty_result") {
      // F9 (D103): a prior failed cycle's attempt count must not carry into a success/empty_result --
      // otherwise a LATER failure (say, after a manual refresh) starts counting from that stale
      // non-zero value and can reach MARKET_MAX_ATTEMPTS, and so go straight to terminal_failure, too
      // early (DA-4).
      patch.marketAttempts = 0;
    }
    patch.marketNextRetryAt = outcome === "retryable_failure" ? nextRetryAt : undefined;
    await ctx.db.patch(watchId, patch);

    return { skipped: false, points: written, stores: added };
  },
});

/**
 * Asks ShopSavvy about one watched product. Never throws past the scheduler:
 * every outcome, including a malformed response or a network failure, ends
 * as a classified state on the watch via `recordSnapshot`. A retryable
 * failure schedules its own continuation (another `requestLookup("auto")`
 * after the backoff) so the retry is automatic and still goes through the
 * same claim/gate/charge path as any other attempt.
 */
export const lookup = internalAction({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const running = await ctx.runMutation(internal.market.markRunning, { watchId });
    if (!running) return null;

    const watch = await ctx.runQuery(internal.market.watchForMarket, { watchId });
    if (!watch) {
      // Gone or archived between the claim and now; recordSnapshot's own re-read would refuse anyway,
      // but there is nothing to fetch without a productUrl.
      return null;
    }

    const now = Date.now();
    let snapshot: MarketSnapshot | null = null;
    let fetchError: "retryable_failure" | "terminal_failure" | null = null;
    try {
      snapshot = await fetchSnapshot(watch.productUrl, now);
    } catch (err) {
      fetchError = classifyFetchError(err);
      // T24c (D109): structured, redacted line instead of a bare console.error -- marketNote (what
      // the user sees) is always the fixed copy regardless; this is operator-only.
      logEvent("market_failed", { watchId, error: sanitizeError(err instanceof Error ? err.message : String(err)) });
    }

    if (fetchError !== null) {
      const nextAttempts = watch.attempts + 1;
      const outcome = fetchError === "retryable_failure" && nextAttempts < MARKET_MAX_ATTEMPTS ? "retryable_failure" : "terminal_failure";
      // F9 (D103): with MARKET_MAX_ATTEMPTS = 3, only MARKET_RETRY_BACKOFF_MS[0] (10m) and [1] (1h) are
      // ever read here -- the 3rd attempt's `nextAttempts` (3) already fails `< MARKET_MAX_ATTEMPTS`
      // above and goes straight to terminal_failure, so index [2] (6h) is presently dead. D71's own
      // description ("3 attempts with 10m/1h/6h backoff") promises all three are reachable; today only
      // two are. This file does not own limits.ts, so it cannot change either constant -- see the task
      // report's "known gaps"/limits.ts-edit note for the recommended fix (raise MARKET_MAX_ATTEMPTS to
      // 4, which the backoff array already has enough entries for).
      const nextRetryAt = outcome === "retryable_failure" ? now + MARKET_RETRY_BACKOFF_MS[watch.attempts] : undefined;
      await ctx.runMutation(internal.market.recordSnapshot, {
        watchId,
        outcome,
        points: [],
        stores: [],
        attempts: nextAttempts,
        nextRetryAt,
      });
      if (outcome === "retryable_failure" && nextRetryAt !== undefined) {
        await ctx.scheduler.runAfter(nextRetryAt - now, internal.market.requestLookup, { watchId, trigger: "auto" });
      }
      return null;
    }

    if (snapshot === null) {
      // The key was unset. Reachable in steady state only during the T12 rewiring window (watches.ts
      // still calling `lookup` directly, see the file header); requestLookup already handles this
      // branch for every caller that goes through the claim.
      await ctx.runMutation(internal.market.recordSnapshot, { watchId, outcome: "not_configured", points: [], stores: [] });
      return null;
    }

    // Reduced to a registrable host (T13/P04): `hostOf` alone returns the full hostname (e.g.
    // `shop.acme.example`), which would never equal a candidate store's already-registrable
    // `cleanStoreUrl().storeDomain` (`acme.example`) and so would let the watch's own store back in
    // as a "competitor" whenever the watched product page sits on a subdomain. `recordSnapshot`
    // re-applies this same exclusion as the authoritative gate; this pass just avoids fetching a
    // needless own-store candidate in the common case.
    const ownDomain = registrableHost(hostOf(watch.productUrl) ?? watch.merchantDomain) ?? watch.merchantDomain;
    const points = flattenHistory(snapshot, watch.currency)
      .slice(-MARKET_MAX_POINTS)
      .map((p) => {
        const day = new Date(p.observedAt).toISOString().slice(0, 10);
        const store = p.storeDomain ?? p.retailer ?? "unknown";
        return {
          retailer: p.retailer ?? store,
          storeDomain: p.storeDomain ?? undefined,
          cents: p.cents,
          currency: watch.currency,
          observedAt: p.observedAt,
          // Store AND day: two stores priced on one day are two facts, not a collision.
          marketKey: `${store}:${day}`,
        };
      });

    const stores: Array<{
      retailer: string;
      storeDomain: string;
      productUrl: string;
      cents?: number;
      currency?: string;
      observedAt?: number;
      inStock?: boolean;
    }> = [];
    for (const offer of snapshot.offers) {
      // A marketplace seller's listing is not the store's own price.
      if (offer.seller !== null || offer.productUrl === null) continue;
      const cleaned = cleanStoreUrl(offer.productUrl);
      if (!cleaned || sameStore(cleaned.storeDomain, ownDomain)) continue;
      stores.push({
        retailer: offer.retailer,
        storeDomain: cleaned.storeDomain,
        productUrl: cleaned.productUrl,
        cents: offer.cents ?? undefined,
        currency: offer.currency ?? undefined,
        observedAt: offer.observedAt ?? undefined,
        // `null`/"in" both mean in stock (shopsavvy.ts's own convention); anything else stated is out of stock.
        inStock: offer.availability === null || offer.availability === "in",
      });
    }

    await ctx.runMutation(internal.market.recordSnapshot, {
      watchId,
      outcome: points.length === 0 ? "empty_result" : "success",
      points,
      stores,
    });
    return null;
  },
});

/** Every market point for a watch, oldest first. Used by the verdict and the chart. */
export async function marketPointsFor(
  ctx: QueryCtx,
  watchId: Id<"watches">,
): Promise<Array<Doc<"marketPrices">>> {
  return await ctx.db
    .query("marketPrices")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .take(MARKET_MAX_POINTS);
}

/**
 * One-time, bounded, resumable conversion of pre-D71 watches: back then the
 * only persisted state was `marketFetchedAt` (a timestamp or nothing) plus a
 * free-text `marketNote`. Any watch that already has `marketFetchedAt` set
 * but no `marketState` gets classified from what it actually has —
 * `marketPrices` rows mean a lookup once succeeded (`success`); none mean it
 * did not (`not_configured`, clearing `marketFetchedAt` so a key added later
 * can run the very first real lookup rather than being blocked by the old
 * stamp). Never charges or schedules anything. Safe to call repeatedly:
 * finished watches are never revisited twice within a run (the cursor only
 * moves forward) and a watch already carrying `marketState` is left alone.
 */
export const migrateStamps = internalMutation({
  args: {},
  returns: v.object({ done: v.boolean(), scanned: v.number(), migrated: v.number() }),
  handler: async (ctx) => {
    const opsRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", MIGRATE_OPS_KEY))
      .unique();
    const cursor = opsRow?.cursor ?? null;

    const page = await ctx.db.query("watches").paginate({ cursor, numItems: MIGRATE_PAGE });

    let migrated = 0;
    for (const watch of page.page) {
      if (watch.marketFetchedAt === undefined || watch.marketState !== undefined) continue;
      const anyPoint = await ctx.db
        .query("marketPrices")
        .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
        .first();
      if (anyPoint) {
        await ctx.db.patch(watch._id, { marketState: "success" });
      } else {
        await ctx.db.patch(watch._id, { marketState: "not_configured", marketFetchedAt: undefined });
      }
      migrated++;
    }

    const now = Date.now();
    if (opsRow) await ctx.db.patch(opsRow._id, { cursor: page.continueCursor, updatedAt: now });
    else await ctx.db.insert("opsState", { key: MIGRATE_OPS_KEY, cursor: page.continueCursor, updatedAt: now });

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.market.migrateStamps, {});
    }
    return { done: page.isDone, scanned: page.page.length, migrated };
  },
});
