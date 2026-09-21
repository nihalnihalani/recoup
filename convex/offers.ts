/**
 * Offers (W3): the same item at other stores.
 *
 * `find` consumes the spend limits and schedules `search`. `search` runs one
 * Firecrawl web search for the product name, keeps at most one page per store
 * (`lib/offerMatch.ts`), prices each with the shared extractor
 * (`priceWatch.observePrice`) and writes everything in ONE mutation,
 * `recordCandidates`, where the D16 acceptance rules live.
 *
 * A search result is never trusted: it is stored as a `candidate`, and only a
 * row the user `confirmed` is re-checked (`recheck`) or allowed into `best`.
 *
 * Spend limits need a timestamp per find, and a search that finds nothing
 * leaves no offer row behind. So `find` inserts a MARKER row into `offers`
 * (`storeDomain` = FIND_MARKER, status `rejected`, so every reader that skips
 * rejected rows skips it): the cooldown and the daily cap are counted off the
 * markers' `_creationTime`, and the marker doubles as the pending row the UI
 * watches (`searching`).
 */
import { ConvexError, v, type Infer } from "convex/values";
import { FirecrawlClient, type SearchResponse } from "@firecrawl/firecrawl-convex";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { offerStatus, priceSource, variantMatch } from "./schema";
import { ownedWatch, requireUserId } from "./lib/access";
import { assertTimestamp } from "./lib/money";
import { isTombstoned } from "./lib/accountState";
import { defaultWatchName } from "./lib/watchUrl";
import {
  EXCLUDED_HOSTS,
  FIND_MARKER,
  matchConfidence,
  sameStore,
  selectStorePages,
  titleSimilarity,
  TITLE_DRIFT_THRESHOLD,
  type SearchHit,
} from "./lib/offerMatch";
import { observePrice, rejectionReason, truncate, type Observation, type PageObservation } from "./priceWatch";
import {
  MAX_OFFER_FINDS_PER_DAY,
  MAX_OFFER_PAGES_PER_FIND,
  MAX_OFFER_RECHECKS,
  MAX_OFFERS_PER_WATCH,
  OFFER_FIND_COOLDOWN_MS,
  OFFER_FIND_WINDOW_MS,
  OFFER_SEARCH_LIMIT,
} from "./limits";

const firecrawl = new FirecrawlClient(components.firecrawl);

/** A marker still unfinished after this long belongs to a search that died; stop saying "searching". */
const SEARCH_PENDING_MS = 5 * 60_000;
/**
 * Fixed marker on `note` when a recheck/refresh found the confirmed URL
 * showing a different product than the one the user vouched for (P04:
 * "confirmed offer matching may silently authorize later variants"). The
 * OLD price/currency are left as they were -- still shown, just no longer
 * refreshed -- until the user looks again and re-confirms or rejects it.
 * Not an `offerStatus` literal: that enum is schema-owned outside this
 * task's file set (see the task report's "known gaps"), so this is the
 * in-scope equivalent -- a fixed, matchable string on the existing `note`
 * field, which the UI already renders and which `listForWatch`'s `best`
 * computation already skips (see `needsReconfirm` below).
 */
export const NEEDS_RECONFIRM_NOTE =
  "This store's listing may have changed since you confirmed it; check it before trusting this price.";
/** `listForWatch` page size. */
const LIST_LIMIT = 20;
/**
 * Every row one watch can have: MAX_OFFERS_PER_WATCH stores plus the markers
 * of one window (older ones are deleted by `find`). Reading this many rows off
 * `by_watch` is therefore reading ALL of them, so filtering by status
 * afterwards cannot miss a row.
 */
const WATCH_ROWS = MAX_OFFERS_PER_WATCH + 60;
const MAX_TITLE_CHARS = 200;
/** `offerChecks` rows dropped at once when a candidate is replaced by another page; a candidate only gains rows from finds. */
const STALE_CHECKS_PAGE = 100;
/** A retry inside this window that saw the same price writes no second `offerChecks` row. */
export const OFFER_CHECK_DEDUPE_MS = 30 * 60_000;
const MAX_QUERY_CHARS = 200;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const offerView = v.object({
  _id: v.id("offers"),
  storeDomain: v.string(),
  productUrl: v.string(),
  title: v.string(),
  status: offerStatus,
  variantMatch: v.union(variantMatch, v.null()),
  matchConfidence: v.union(v.number(), v.null()),
  lastCents: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  lastCheckedAt: v.union(v.number(), v.null()),
  note: v.union(v.string(), v.null()),
  /** Where this row's data came from (T13/P04): never presented as a Recoup read when it is not one. Defaults to "recoup" for rows written before this field existed. */
  source: priceSource,
});

const bestView = v.object({
  storeDomain: v.string(),
  cents: v.number(),
  currency: v.string(),
  productUrl: v.string(),
});

const offersForWatch = v.object({
  /** Confirmed (cheapest first, unknown price last), then candidates (most trusted first). Rejected omitted. At most 20. */
  offers: v.array(offerView),
  /** The cheapest CONFIRMED, in-stock, non-flagged offer that beats the watch's own latest price, else null. */
  best: v.union(bestView, v.null()),
  /**
   * Raw deadline of the pending search marker, or undefined when none is
   * pending (T13/P06: no wall-clock read in this query). The client derives
   * "searching" by comparing this to its own clock: `now < searchingUntil`.
   */
  searchingUntil: v.optional(v.number()),
  /**
   * Raw time `find` may be called again, or undefined when it has never been
   * called (or its cooldown window has rolled off the read window). Never
   * nulled once past: the client compares it to its own clock the same way
   * (`nextFindAt === undefined || nextFindAt <= now`).
   */
  nextFindAt: v.optional(v.number()),
});

const EMPTY: Infer<typeof offersForWatch> = { offers: [], best: null, searchingUntil: undefined, nextFindAt: undefined };

/** What the extractor saw on one page. Cents are integer minor units. */
const observation = {
  observedCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  confidence: v.optional(v.number()),
  isRange: v.optional(v.boolean()),
  variantMatch: v.optional(variantMatch),
  note: v.optional(v.string()),
  /** The extractor's own read of the product's name, when it returned one (T13: the recheck-side drift signal -- a recheck has no fresh `title` the way a search hit does, only this). */
  productName: v.optional(v.string()),
};

const candidate = v.object({
  storeDomain: v.string(),
  productUrl: v.string(),
  title: v.string(),
  ...observation,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isMarker(row: Doc<"offers">): boolean {
  return row.storeDomain === FIND_MARKER;
}

/** True when a later read found a different product at this offer's URL (T13/P04): its price is untrusted until the user looks again. */
function needsReconfirm(row: Pick<Doc<"offers">, "note">): boolean {
  return row.note === NEEDS_RECONFIRM_NOTE;
}

/** When a find happened, in whole ms (`_creationTime` can carry a fraction). */
function foundAt(marker: Doc<"offers">): number {
  return Math.floor(marker._creationTime);
}

/** Every row of one watch, newest first (see WATCH_ROWS for why this is bounded AND complete). */
async function watchRows(ctx: QueryCtx, watchId: Id<"watches">): Promise<Doc<"offers">[]> {
  return await ctx.db
    .query("offers")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .order("desc")
    .take(WATCH_ROWS);
}

/**
 * The CONFIRMED offers of one watch, cheapest first (unknown price last). Complete for the same reason
 * `watchRows` is. Shared with the dashboard read models (`insights.ts`), which never show anything else.
 */
export async function confirmedOffers(
  ctx: QueryCtx,
  watchId: Id<"watches">,
  userId: Id<"users">,
): Promise<Doc<"offers">[]> {
  const rows = await watchRows(ctx, watchId);
  return rows
    .filter((r) => !isMarker(r) && r.userId === userId && r.status === "confirmed")
    .sort(byCentsThenUnknown);
}

/** The name to search and match on, or null when the watch has nothing that names the product. */
function searchName(watch: Doc<"watches">): string | null {
  if (watch.name !== defaultWatchName(watch.productUrl)) return watch.name.slice(0, MAX_QUERY_CHARS);
  // Placeholder is "host: readable tail"; the tail is the only product-ish part.
  const tail = watch.name.includes(": ") ? watch.name.slice(watch.name.indexOf(": ") + 2).trim() : "";
  return tail.length > 0 ? tail : null;
}

async function ownedOffer(ctx: QueryCtx | MutationCtx, offerId: Id<"offers">, userId: Id<"users">) {
  const offer = await ctx.db.get(offerId);
  if (!offer || offer.userId !== userId || isMarker(offer)) throw new ConvexError("Offer not found");
  return offer;
}

/**
 * D16 for an offer: the price fields to store for one observation. A page with
 * no single price, a range, low confidence, an unsure variant or a currency
 * other than the watch's keeps a `note` and NO cents.
 */
function priceFields(
  obs: Observation,
  watchCurrency: string | undefined,
  now: number,
): Pick<Doc<"offers">, "lastCents" | "currency" | "lastCheckedAt" | "note"> {
  let rejection = rejectionReason(obs, watchCurrency ?? null, "this item is tracked");
  if (rejection === null && obs.observedCents !== undefined && !/^[A-Z]{3}$/.test(obs.currency ?? "")) {
    rejection = "The page does not state a recognisable currency";
  }
  const accepted = rejection === null && obs.observedCents !== undefined;
  const note = rejection ?? obs.note ?? (accepted ? undefined : "The page does not show a single price");
  return {
    lastCents: accepted ? obs.observedCents : undefined,
    currency: obs.currency,
    lastCheckedAt: now,
    note: note === undefined ? undefined : truncate(note),
  };
}

/**
 * Per-store price history. Called from every place that stores an accepted
 * price into `offers.lastCents`, in the same transaction, so the series and
 * the row cannot drift. A rejected or unpriced observation (`cents` undefined)
 * writes nothing, and neither does a repeat of the newest row's price inside
 * OFFER_CHECK_DEDUPE_MS (an action retry, or a search that lands right after a recheck).
 */
async function appendOfferCheck(
  ctx: MutationCtx,
  offer: { offerId: Id<"offers">; watchId: Id<"watches">; userId: Id<"users"> },
  price: { lastCents?: number; currency?: string },
  observedAt: number,
  source: Infer<typeof priceSource>,
): Promise<void> {
  if (price.lastCents === undefined) return;
  const newest = await ctx.db
    .query("offerChecks")
    .withIndex("by_offer", (q) => q.eq("offerId", offer.offerId))
    .order("desc")
    .first();
  if (
    newest &&
    newest.observedCents === price.lastCents &&
    Math.abs(observedAt - newest.observedAt) < OFFER_CHECK_DEDUPE_MS
  ) {
    return;
  }
  await ctx.db.insert("offerChecks", {
    offerId: offer.offerId,
    watchId: offer.watchId,
    userId: offer.userId,
    observedCents: price.lastCents,
    currency: price.currency,
    observedAt,
    source,
  });
}

// ---------------------------------------------------------------------------
// Public: find, confirm, reject
// ---------------------------------------------------------------------------

/** Fails closed: throws unless the caller is under the per-watch cooldown and the per-user daily cap. */
async function consumeFindLimit(
  ctx: MutationCtx,
  userId: Id<"users">,
  watchId: Id<"watches">,
  now: number,
): Promise<void> {
  const since = now - OFFER_FIND_WINDOW_MS;
  const rows = await watchRows(ctx, watchId);
  const lastMarker = rows.find(isMarker);
  if (lastMarker && now - foundAt(lastMarker) < OFFER_FIND_COOLDOWN_MS) {
    throw new ConvexError("Other stores were searched recently for this item; try again in a few hours");
  }
  // One find leaves at most 1 marker + MAX_OFFER_PAGES_PER_FIND rows, so a
  // full page here already proves the cap was passed.
  const page = MAX_OFFER_FINDS_PER_DAY * (MAX_OFFER_PAGES_PER_FIND + 1) + 1;
  const recent = await ctx.db
    .query("offers")
    .withIndex("by_user", (q) => q.eq("userId", userId).gt("_creationTime", since))
    .take(page);
  if (recent.length >= page || recent.filter(isMarker).length >= MAX_OFFER_FINDS_PER_DAY) {
    throw new ConvexError("You have searched other stores a lot today; try again tomorrow");
  }
  // Markers outside the window no longer count for anything.
  for (const row of rows) {
    if (isMarker(row) && row._creationTime < since) await ctx.db.delete(row._id);
  }
}

/** "Find it at other stores". The limits are consumed in the transaction that schedules the spend. */
export const find = mutation({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    const userId = await requireUserId(ctx);
    const watch = await ownedWatch(ctx, watchId, userId);
    if (watch.status !== "active" && watch.status !== "paused") {
      throw new ConvexError("This item is no longer being watched");
    }
    const named = watch.name !== defaultWatchName(watch.productUrl);
    if (!named && watch.lastCents === undefined) {
      throw new ConvexError("This item has not been read yet; name it or wait for its first price check");
    }
    if (searchName(watch) === null) {
      throw new ConvexError("Name this item first so other stores can be searched for it");
    }
    await consumeFindLimit(ctx, userId, watchId, Date.now());
    await ctx.db.insert("offers", {
      watchId,
      userId,
      storeDomain: FIND_MARKER,
      productUrl: watch.productUrl,
      title: "",
      status: "rejected",
    });
    await ctx.scheduler.runAfter(0, internal.offers.search, { watchId });
    return null;
  },
});

async function decide(ctx: MutationCtx, offerId: Id<"offers">, status: "confirmed" | "rejected"): Promise<null> {
  const userId = await requireUserId(ctx);
  const offer = await ownedOffer(ctx, offerId, userId);
  if (offer.status !== status) await ctx.db.patch(offerId, { status }); // a retry is a no-op
  // An offer priced before per-store history existed starts its series at the price it was confirmed with.
  if (status === "confirmed" && offer.lastCents !== undefined) {
    const any = await ctx.db
      .query("offerChecks")
      .withIndex("by_offer", (q) => q.eq("offerId", offerId))
      .first();
    if (!any) {
      // `offer.lastCheckedAt` is the provider's own observation time for a ShopSavvy candidate
      // (market.ts stamps it from `store.observedAt`), so this also satisfies "observedAt = the
      // provider observation time" for a shopsavvy candidate's first history point (T13).
      await appendOfferCheck(
        ctx,
        { offerId, watchId: offer.watchId, userId: offer.userId },
        offer,
        offer.lastCheckedAt ?? Math.floor(offer._creationTime),
        offer.source ?? "recoup",
      );
    }
  }
  return null;
}

/** "Yes, this is the same product." Only a confirmed offer is re-checked or ranked into `best`. Idempotent. */
export const confirm = mutation({
  args: { offerId: v.id("offers") },
  returns: v.null(),
  handler: async (ctx, { offerId }) => await decide(ctx, offerId, "confirmed"),
});

/** "Not the same product." The row is kept so a later search does not offer the store again. Idempotent. */
export const reject = mutation({
  args: { offerId: v.id("offers") },
  returns: v.null(),
  handler: async (ctx, { offerId }) => await decide(ctx, offerId, "rejected"),
});

// ---------------------------------------------------------------------------
// Public: read
// ---------------------------------------------------------------------------

function byCentsThenUnknown(a: Doc<"offers">, b: Doc<"offers">): number {
  if (a.lastCents === undefined) return b.lastCents === undefined ? 0 : 1;
  if (b.lastCents === undefined) return -1;
  return a.lastCents - b.lastCents;
}

/**
 * Offers for one watch. The empty shape when signed out, not the owner, or
 * the watch is archived. No wall clock is read here (T13/P06): `now` is an
 * optional coarse, display-only client clock (same 5-minute-step, ±1-day
 * convention as T12's watches.list/get) that this query does not need for
 * anything it computes -- accepted and validated only so every list-shaped
 * query takes the argument uniformly -- and every timestamp returned is raw
 * server state the client compares against its own clock.
 */
export const listForWatch = query({
  args: { watchId: v.id("watches"), now: v.optional(v.number()) },
  returns: offersForWatch,
  handler: async (ctx, { watchId, now }) => {
    if (now !== undefined) assertTimestamp(now, "now");
    const userId = await getAuthUserId(ctx);
    if (!userId) return EMPTY;
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.userId !== userId || watch.status === "archived") return EMPTY;

    const rows = await watchRows(ctx, watchId);
    const marker = rows.find(isMarker);
    const offers = rows.filter((r) => !isMarker(r) && r.userId === userId);
    const confirmed = offers.filter((o) => o.status === "confirmed").sort(byCentsThenUnknown);
    const candidates = offers
      .filter((o) => o.status === "candidate")
      .sort((a, b) => (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0));

    // `confirmed` is sorted cheapest first, so the first comparable, trustworthy row is the best one.
    let best: Infer<typeof bestView> | null = null;
    if (watch.lastCents !== undefined) {
      for (const o of confirmed) {
        if (o.lastCents === undefined || o.currency === undefined) continue;
        // A price flagged for reconfirmation (variant drift, T13/P04) never drives "best": keep
        // looking past it rather than stopping here, the same way an unpriced row is skipped above.
        if (needsReconfirm(o)) continue;
        if (watch.currency !== undefined && o.currency !== watch.currency) continue;
        if (o.lastCents < watch.lastCents) {
          best = { storeDomain: o.storeDomain, cents: o.lastCents, currency: o.currency, productUrl: o.productUrl };
        }
        break;
      }
    }

    return {
      offers: [...confirmed, ...candidates].slice(0, LIST_LIMIT).map((o) => ({
        _id: o._id,
        storeDomain: o.storeDomain,
        productUrl: o.productUrl,
        title: o.title,
        status: o.status,
        variantMatch: o.variantMatch ?? null,
        matchConfidence: o.matchConfidence ?? null,
        lastCents: o.lastCents ?? null,
        currency: o.currency ?? null,
        lastCheckedAt: o.lastCheckedAt ?? null,
        note: o.note ?? null,
        source: o.source ?? "recoup",
      })),
      best,
      searchingUntil: marker !== undefined && marker.lastCheckedAt === undefined ? foundAt(marker) + SEARCH_PENDING_MS : undefined,
      nextFindAt: marker !== undefined ? foundAt(marker) + OFFER_FIND_COOLDOWN_MS : undefined,
    };
  },
});

// ---------------------------------------------------------------------------
// Search: read, search + observe, record
// ---------------------------------------------------------------------------

/** What `search` and `recheck` need. Unauthenticated on purpose: called only by those actions. */
export const watchForSearch = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.union(v.object({ name: v.string(), merchantDomain: v.string() }), v.null()),
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch || (watch.status !== "active" && watch.status !== "paused")) return null;
    const name = searchName(watch);
    return name === null ? null : { name, merchantDomain: watch.merchantDomain };
  },
});

/** Injectable so `searchOffers` and `recheckConfirmedOffers` run in tests without Firecrawl or OpenAI. */
export type OfferDeps = {
  search: (ctx: ActionCtx, query: string, options?: Parameters<FirecrawlClient["search"]>[2]) => Promise<SearchResponse>;
  observe: (ctx: ActionCtx, name: string | null, productUrl: string) => Promise<PageObservation>;
};

const defaultDeps: OfferDeps = {
  search: firecrawl.search.bind(firecrawl),
  observe: observePrice,
};

type Runner = Pick<ActionCtx, "runQuery" | "runMutation">;

/** Narrows one untyped search result to the two fields we use. */
function toHit(raw: unknown): SearchHit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { url?: unknown; title?: unknown; metadata?: { sourceURL?: unknown; title?: unknown } | null };
  const url = typeof r.url === "string" ? r.url : typeof r.metadata?.sourceURL === "string" ? r.metadata.sourceURL : null;
  if (url === null) return null;
  const title = typeof r.title === "string" ? r.title : typeof r.metadata?.title === "string" ? r.metadata.title : undefined;
  return { url, title };
}

function pickObservation(obs: PageObservation): Observation {
  return {
    observedCents: obs.observedCents,
    currency: obs.currency,
    confidence: obs.confidence,
    isRange: obs.isRange,
    variantMatch: obs.variantMatch,
    note: obs.note,
  };
}

/**
 * The body of `search` as a plain helper (no action-in-action). Never throws:
 * a failed search or a dead page is logged and stores no offer; the find
 * marker is still finished so the UI stops saying "searching".
 */
export async function searchOffers(
  ctx: Runner,
  watchId: Id<"watches">,
  deps: OfferDeps = defaultDeps,
): Promise<number> {
  const candidates: Infer<typeof candidate>[] = [];
  let failure: string | undefined;
  try {
    const watch = await ctx.runQuery(internal.offers.watchForSearch, { watchId });
    if (!watch) return 0;
    const res = await deps.search(ctx as ActionCtx, `${watch.name} buy`, {
      limit: OFFER_SEARCH_LIMIT,
      excludeDomains: [watch.merchantDomain, ...EXCLUDED_HOSTS],
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true, maxAge: 3_600_000 },
    });
    const hits = (res.web ?? []).flatMap((raw) => toHit(raw) ?? []);
    const pages = selectStorePages(hits, watch.merchantDomain, MAX_OFFER_PAGES_PER_FIND);
    // The reads are independent and each takes 15-30s (full-page scrape, then extraction), so run them
    // together: a find is as slow as its slowest store, not the sum. At most MAX_OFFER_PAGES_PER_FIND at once.
    const observed = await Promise.all(
      pages.map(async (page) => {
        try {
          return { page, obs: await deps.observe(ctx as ActionCtx, watch.name, page.productUrl) };
        } catch (err) {
          console.error(`offers.search could not read ${page.storeDomain} for ${watchId}`, err);
          return null; // a failure stores nothing
        }
      }),
    );
    for (const entry of observed) {
      if (!entry) continue;
      // No verdict on the variant means the page was never read as a product; "none" means it is another product.
      if (entry.obs.variantMatch !== "exact" && entry.obs.variantMatch !== "unsure") continue;
      candidates.push({ ...entry.page, ...pickObservation(entry.obs) });
    }
  } catch (err) {
    console.error(`offers.search failed for ${watchId}`, err);
    failure = truncate(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return await ctx.runMutation(internal.offers.recordCandidates, { watchId, candidates, failure });
  } catch (err) {
    console.error(`offers.recordCandidates failed for ${watchId}`, err);
    return 0;
  }
}

/** Scheduled by `find`. */
export const search = internalAction({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    await searchOffers(ctx, watchId);
    return null;
  },
});

/**
 * Upserts one search's results by (watchId, storeDomain) and finishes the find
 * marker. A new store is inserted as `candidate`; an existing candidate is
 * replaced; a `rejected` row is never touched; a `confirmed` row only has its
 * price fields refreshed, and only when the search found the very URL the user
 * confirmed (a different page at the same store is not what they vouched for).
 *
 * Unauthenticated on purpose: called only by `searchOffers`, and tests.
 * Ownership is read off the watch. Returns how many rows were written.
 */
export const recordCandidates = internalMutation({
  args: { watchId: v.id("watches"), candidates: v.array(candidate), failure: v.optional(v.string()) },
  returns: v.number(),
  handler: async (ctx, { watchId, candidates, failure }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return 0;
    // D87: a scheduled path (searchOffers -> here) never writes a tombstoned owner's rows.
    if (await isTombstoned(ctx, watch.userId)) return 0;
    const now = Date.now();
    const rows = await watchRows(ctx, watchId);

    const marker = rows.find(isMarker);
    if (marker && marker.lastCheckedAt === undefined) {
      await ctx.db.patch(marker._id, { lastCheckedAt: now, note: failure });
    }

    const byStore = new Map<string, Doc<"offers">>();
    for (const row of rows) if (!isMarker(row)) byStore.set(row.storeDomain, row);

    let stores = byStore.size;
    const inserted = new Set<string>();
    let written = 0;
    for (const c of candidates.slice(0, MAX_OFFER_PAGES_PER_FIND)) {
      if (c.variantMatch !== "exact" && c.variantMatch !== "unsure") continue; // "none" is never stored
      if (c.storeDomain === FIND_MARKER || sameStore(c.storeDomain, watch.merchantDomain)) continue;
      const price = priceFields(c, watch.currency, now);
      const existing = byStore.get(c.storeDomain);
      if (existing?.status === "rejected") continue;
      if (existing?.status === "confirmed") {
        if (existing.productUrl !== c.productUrl) continue;
        // P04: the URL the user confirmed can start showing a different product. A title that no
        // longer resembles the one they vouched for is drift: flag it and leave the price as it
        // was, rather than silently authorizing whatever this read happens to be.
        if (titleSimilarity(existing.title, c.title) < TITLE_DRIFT_THRESHOLD) {
          await ctx.db.patch(existing._id, { lastCheckedAt: now, note: NEEDS_RECONFIRM_NOTE });
          written++;
          continue;
        }
        await ctx.db.patch(existing._id, price);
        await appendOfferCheck(ctx, { offerId: existing._id, watchId, userId: existing.userId }, price, now, "recoup");
        written++;
        continue;
      }
      const fields = {
        productUrl: c.productUrl,
        title: c.title.slice(0, MAX_TITLE_CHARS),
        variantMatch: c.variantMatch,
        matchConfidence: matchConfidence(c.variantMatch, c.confidence),
        source: "recoup" as const,
        ...price,
      };
      if (existing) {
        await ctx.db.patch(existing._id, fields);
        // Another page of the same store is another listing: its prices do not continue the old page's series.
        if (existing.productUrl !== c.productUrl) {
          const stale = await ctx.db
            .query("offerChecks")
            .withIndex("by_offer", (q) => q.eq("offerId", existing._id))
            .take(STALE_CHECKS_PAGE);
          for (const row of stale) await ctx.db.delete(row._id);
        }
        await appendOfferCheck(ctx, { offerId: existing._id, watchId, userId: existing.userId }, price, now, "recoup");
      } else {
        if (stores >= MAX_OFFERS_PER_WATCH || inserted.has(c.storeDomain)) continue;
        const offerId = await ctx.db.insert("offers", {
          watchId,
          userId: watch.userId,
          storeDomain: c.storeDomain,
          status: "candidate",
          ...fields,
        });
        await appendOfferCheck(ctx, { offerId, watchId, userId: watch.userId }, price, now, "recoup");
        inserted.add(c.storeDomain);
        stores++;
      }
      written++;
    }
    return written;
  },
});

// ---------------------------------------------------------------------------
// Recheck: confirmed offers only
// ---------------------------------------------------------------------------

/**
 * True when this watch has at least one CONFIRMED offer overdue for a
 * recheck (F5): never checked, or checked more than `OFFER_FIND_COOLDOWN_MS`
 * ago -- the same cadence `find` already respects. `watches.checkWatch` calls
 * this before scheduling `recheck`, so a watch with no confirmed offers (the
 * common case) costs nothing beyond this one indexed read, and one with some
 * is not re-scraped on every 2h watch check.
 */
export const dueForRecheck = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.boolean(),
  handler: async (ctx, { watchId }) => {
    const rows = await watchRows(ctx, watchId);
    const now = Date.now();
    return rows.some(
      (r) =>
        !isMarker(r) &&
        r.status === "confirmed" &&
        (r.lastCheckedAt === undefined || now - r.lastCheckedAt >= OFFER_FIND_COOLDOWN_MS),
    );
  },
});

/** The confirmed offers of one watch, at most MAX_OFFER_RECHECKS. Unauthenticated on purpose: called only by `recheck`. */
export const confirmedForWatch = internalQuery({
  args: { watchId: v.id("watches") },
  returns: v.array(v.object({ offerId: v.id("offers"), productUrl: v.string() })),
  handler: async (ctx, { watchId }) => {
    const rows = await watchRows(ctx, watchId);
    return rows
      .filter((r) => !isMarker(r) && r.status === "confirmed")
      .sort((a, b) => (a.lastCheckedAt ?? 0) - (b.lastCheckedAt ?? 0)) // stalest first
      .slice(0, MAX_OFFER_RECHECKS)
      .map((r) => ({ offerId: r._id, productUrl: r.productUrl }));
  },
});

/**
 * Re-reads the price of one watch's CONFIRMED offers. Never throws: a page
 * that cannot be fetched is logged and its row left as it was. Exported for
 * the watch sweep, which can also schedule `internal.offers.recheck`.
 */
export async function recheckConfirmedOffers(
  ctx: Runner,
  watchId: Id<"watches">,
  deps: OfferDeps = defaultDeps,
): Promise<number> {
  try {
    const watch = await ctx.runQuery(internal.offers.watchForSearch, { watchId });
    if (!watch) return 0;
    const offers = await ctx.runQuery(internal.offers.confirmedForWatch, { watchId });
    const results: Array<{ offerId: Id<"offers"> } & ReturnType<typeof pickObservation> & { productName?: string }> = [];
    // Same reasoning as searchOffers: independent reads run together (bounded by MAX_OFFER_RECHECKS).
    const reads = await Promise.all(
      offers.map(async (offer) => {
        try {
          const obs = await deps.observe(ctx as ActionCtx, watch.name, offer.productUrl);
          // `productName` rides along outside `pickObservation` (T13): it is the drift signal
          // `recordRechecks` compares against the confirmed offer's stored title -- a recheck has
          // no freshly-searched page title the way `searchOffers`'s candidates do.
          return { offerId: offer.offerId, ...pickObservation(obs), productName: obs.productName };
        } catch (err) {
          console.error(`offers.recheck could not read offer ${offer.offerId}`, err);
          return null;
        }
      }),
    );
    for (const read of reads) if (read) results.push(read);
    if (results.length === 0) return 0;
    return await ctx.runMutation(internal.offers.recordRechecks, { watchId, results });
  } catch (err) {
    console.error(`offers.recheck failed for ${watchId}`, err);
    return 0;
  }
}

export const recheck = internalAction({
  args: { watchId: v.id("watches") },
  returns: v.null(),
  handler: async (ctx, { watchId }) => {
    await recheckConfirmedOffers(ctx, watchId);
    return null;
  },
});

/**
 * Refreshes the price fields of re-read offers. Re-decides at write time: a
 * row the user un-confirmed while the scrape was in flight is left alone.
 * Unauthenticated on purpose: called only by `recheckConfirmedOffers`, and tests.
 */
export const recordRechecks = internalMutation({
  args: {
    watchId: v.id("watches"),
    results: v.array(v.object({ offerId: v.id("offers"), ...observation })),
  },
  returns: v.number(),
  handler: async (ctx, { watchId, results }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return 0;
    // D87: a scheduled path (recheckConfirmedOffers -> here) never writes a tombstoned owner's rows.
    if (await isTombstoned(ctx, watch.userId)) return 0;
    const now = Date.now();
    let written = 0;
    for (const r of results.slice(0, MAX_OFFER_RECHECKS)) {
      const offer = await ctx.db.get(r.offerId);
      if (!offer || offer.watchId !== watchId || offer.status !== "confirmed" || isMarker(offer)) continue;
      // P04: a recheck that no longer looks like the confirmed product -- "none" variant, or a
      // freshly-read product name that does not resemble the stored title -- must not silently
      // authorize whatever price it saw. Flag it instead of updating the price.
      const drift =
        r.variantMatch === "none" ||
        (r.productName !== undefined && titleSimilarity(offer.title, r.productName) < TITLE_DRIFT_THRESHOLD);
      if (drift) {
        await ctx.db.patch(offer._id, { lastCheckedAt: now, note: NEEDS_RECONFIRM_NOTE });
        written++;
        continue;
      }
      const price = priceFields(r, watch.currency, now);
      await ctx.db.patch(offer._id, price);
      await appendOfferCheck(ctx, { offerId: offer._id, watchId, userId: offer.userId }, price, now, "recoup");
      written++;
    }
    return written;
  },
});
