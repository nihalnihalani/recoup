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
import { offerStatus, variantMatch } from "./schema";
import { ownedWatch, requireUserId } from "./lib/access";
import { defaultWatchName } from "./lib/watchUrl";
import { EXCLUDED_HOSTS, matchConfidence, selectStorePages, type SearchHit } from "./lib/offerMatch";
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

/** Not a hostname, so it can never collide with a real store's row. */
const FIND_MARKER = "~find";
/** A marker still unfinished after this long belongs to a search that died; stop saying "searching". */
const SEARCH_PENDING_MS = 5 * 60_000;
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
  /** The cheapest CONFIRMED offer that beats the watch's own latest price, else null. */
  best: v.union(bestView, v.null()),
  /** True while a scheduled search has not recorded yet. */
  searching: v.boolean(),
  /** When `find` may be called again for this watch; null when it may be called now. */
  nextFindAt: v.union(v.number(), v.null()),
});

const EMPTY: Infer<typeof offersForWatch> = { offers: [], best: null, searching: false, nextFindAt: null };

/** What the extractor saw on one page. Cents are integer minor units. */
const observation = {
  observedCents: v.optional(v.number()),
  currency: v.optional(v.string()),
  confidence: v.optional(v.number()),
  isRange: v.optional(v.boolean()),
  variantMatch: v.optional(variantMatch),
  note: v.optional(v.string()),
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
      await appendOfferCheck(
        ctx,
        { offerId, watchId: offer.watchId, userId: offer.userId },
        offer,
        offer.lastCheckedAt ?? Math.floor(offer._creationTime),
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

/** Offers for one watch. The empty shape when signed out, not the owner, or the watch is archived. */
export const listForWatch = query({
  args: { watchId: v.id("watches") },
  returns: offersForWatch,
  handler: async (ctx, { watchId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return EMPTY;
    const watch = await ctx.db.get(watchId);
    if (!watch || watch.userId !== userId || watch.status === "archived") return EMPTY;

    const now = Date.now();
    const rows = await watchRows(ctx, watchId);
    const marker = rows.find(isMarker);
    const offers = rows.filter((r) => !isMarker(r) && r.userId === userId);
    const confirmed = offers.filter((o) => o.status === "confirmed").sort(byCentsThenUnknown);
    const candidates = offers
      .filter((o) => o.status === "candidate")
      .sort((a, b) => (b.matchConfidence ?? 0) - (a.matchConfidence ?? 0));

    // `confirmed` is sorted cheapest first, so the first comparable row is the best one.
    let best: Infer<typeof bestView> | null = null;
    if (watch.lastCents !== undefined) {
      for (const o of confirmed) {
        if (o.lastCents === undefined || o.currency === undefined) continue;
        if (watch.currency !== undefined && o.currency !== watch.currency) continue;
        if (o.lastCents < watch.lastCents) {
          best = { storeDomain: o.storeDomain, cents: o.lastCents, currency: o.currency, productUrl: o.productUrl };
        }
        break;
      }
    }

    const nextFindAt = marker ? foundAt(marker) + OFFER_FIND_COOLDOWN_MS : null;
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
      })),
      best,
      searching:
        marker !== undefined && marker.lastCheckedAt === undefined && now - foundAt(marker) < SEARCH_PENDING_MS,
      nextFindAt: nextFindAt !== null && nextFindAt > now ? nextFindAt : null,
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
      if (c.storeDomain === FIND_MARKER || c.storeDomain === watch.merchantDomain) continue;
      const price = priceFields(c, watch.currency, now);
      const existing = byStore.get(c.storeDomain);
      if (existing?.status === "rejected") continue;
      if (existing?.status === "confirmed") {
        if (existing.productUrl !== c.productUrl) continue;
        await ctx.db.patch(existing._id, price);
        await appendOfferCheck(ctx, { offerId: existing._id, watchId, userId: existing.userId }, price, now);
        written++;
        continue;
      }
      const fields = {
        productUrl: c.productUrl,
        title: c.title.slice(0, MAX_TITLE_CHARS),
        variantMatch: c.variantMatch,
        matchConfidence: matchConfidence(c.variantMatch, c.confidence),
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
        await appendOfferCheck(ctx, { offerId: existing._id, watchId, userId: existing.userId }, price, now);
      } else {
        if (stores >= MAX_OFFERS_PER_WATCH || inserted.has(c.storeDomain)) continue;
        const offerId = await ctx.db.insert("offers", {
          watchId,
          userId: watch.userId,
          storeDomain: c.storeDomain,
          status: "candidate",
          ...fields,
        });
        await appendOfferCheck(ctx, { offerId, watchId, userId: watch.userId }, price, now);
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
    const results: Array<{ offerId: Id<"offers"> } & ReturnType<typeof pickObservation>> = [];
    // Same reasoning as searchOffers: independent reads run together (bounded by MAX_OFFER_RECHECKS).
    const reads = await Promise.all(
      offers.map(async (offer) => {
        try {
          const obs = await deps.observe(ctx as ActionCtx, watch.name, offer.productUrl);
          return { offerId: offer.offerId, ...pickObservation(obs) };
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
    const now = Date.now();
    let written = 0;
    for (const r of results.slice(0, MAX_OFFER_RECHECKS)) {
      const offer = await ctx.db.get(r.offerId);
      if (!offer || offer.watchId !== watchId || offer.status !== "confirmed" || isMarker(offer)) continue;
      const price = priceFields(r, watch.currency, now);
      await ctx.db.patch(offer._id, price);
      await appendOfferCheck(ctx, { offerId: offer._id, watchId, userId: offer.userId }, price, now);
      written++;
    }
    return written;
  },
});
