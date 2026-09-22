/**
 * ShopSavvy Data API: parsing only, no `ctx` and no network (the call lives in
 * `convex/market.ts`).
 *
 * Why this source exists: our own price history starts the day a watch starts,
 * so a new watch can say nothing useful about whether today's price is good.
 * ShopSavvy has indexed retail prices since 2008, so one call gives a new watch
 * a price across other stores and whatever dated points it holds.
 *
 * Two rules this data lives under, enforced by the callers:
 *  - It is always labelled as ShopSavvy in the UI; it is never presented as a
 *    price Recoup read itself.
 *  - It never opens a claim and never sends an alert. Only our own read of the
 *    store's page can do either, because a claim is a statement about money.
 *
 * Shapes below were taken from live responses on 2026-09-20 (the published
 * docs page is an index, and the official SDK's types match these).
 *
 * Boundary hardening (P04): this is untrusted third-party input. Every field
 * is bounded (string length, array length), every timestamp is range-checked
 * against a caller-supplied clock, every price is a strictly positive integer
 * number of cents, every URL is validated the same way a user-pasted product
 * URL would be (`convex/lib/watchUrl.ts`, imported, never duplicated), and a
 * currency that was never stated is dropped rather than assumed. None of this
 * invents a fact the provider did not state; ambiguous input just contributes
 * nothing instead of contributing a guess.
 */
import { parseProductUrl } from "./watchUrl";

/**
 * A single provider response is bounded to this many offers; the rest are
 * dropped before they are even validated. A real product has a handful of
 * sellers — thousands would only ever be a malformed or hostile response, and
 * without a cap a single call could force this pure function to do unbounded
 * work.
 */
export const MARKET_PARSE_MAX_OFFERS = 200;
/** Same reasoning, per offer's dated history array. */
export const MARKET_PARSE_MAX_POINTS_PER_OFFER = 400;
/**
 * `withoutOutliers` only has enough of a distribution to filter once it holds
 * at least this many points (see that function's doc comment). Exported so
 * `verdict.ts` can require the same floor before trusting a market-derived
 * series: below it, "outlier filtering was effective" is not a fact we can
 * claim, so a thin market series is treated the same as no series at all.
 */
export const MIN_OUTLIER_POINTS = 4;

/** Every free-text field from the provider is capped to this length before it is stored or shown. */
const MAX_STR_CHARS = 200;

/** ShopSavvy's own history goes back to 2008; anything older is a corrupted or placeholder date, not a real listing. */
const MIN_EPOCH_MS = Date.UTC(2010, 0, 1);
/** Beyond ordinary clock skew, a "future" price is not a price anyone has actually seen yet. */
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Prices arrive as decimal dollars; everything inside Recoup is integer cents.
 *
 * Rounding rule: `Math.round(price * 100)`. Dollar amounts are always
 * non-negative here, so "round half away from zero" and "round half up" are
 * the same operation — the ambiguity that matters for negative numbers never
 * arises. This also absorbs the IEEE-754 noise decimal dollars produce (e.g.
 * `19.99 * 100 === 1998.9999999999998`) by rounding it back to the intended
 * integer, `1999`, rather than truncating it down to `1998`. The result must
 * additionally be a positive safe integer: non-finite input (`NaN`,
 * `Infinity`), zero, negative, or a value so large that cents would exceed
 * `Number.MAX_SAFE_INTEGER` are all rejected rather than stored as a price
 * that arithmetic could silently corrupt.
 */
export function toCents(price: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const cents = Math.round(price * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** Trims and caps a provider string field; empty after trimming is treated as absent. */
function str(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, MAX_STR_CHARS) : null;
}

/**
 * A provider timestamp, or null when it cannot be trusted: not parseable,
 * dated before ShopSavvy's own history begins, or dated more than a day past
 * `now`. `now` is threaded down from the caller rather than read here so this
 * stays a pure function; only an action (never a query or mutation) may call
 * the exported functions below without passing one, which is why `now`
 * defaults to `Date.now()` no deeper than `parseSnapshot`'s own signature.
 */
function epoch(value: unknown, now: number): number | null {
  const raw = str(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (ms > now + FUTURE_TOLERANCE_MS) return null;
  if (ms < MIN_EPOCH_MS) return null;
  return ms;
}

/** A condition string naming a used, refurbished, opened, renewed, bundled, or accessory listing — never the product itself at full retail. */
const EXCLUDED_CONDITION_RE = /used|refurb|open.?box|renewed|bundle|accessor(?:y|ies)/i;

function isExcludedCondition(condition: string | null): boolean {
  return condition !== null && EXCLUDED_CONDITION_RE.test(condition);
}

/** `null` and the literal "in" both mean in stock; anything else the provider states is out of stock. */
function isInStock(availability: string | null): boolean {
  return availability === null || availability === "in";
}

/** One dated price for one store. `retailer` and `storeDomain` are kept so every point can say where it came from. */
export type MarketPoint = {
  observedAt: number;
  cents: number;
  /** Never defaulted: a point that did not state its own currency is dropped before this type is constructed. */
  currency: string | null;
  retailer?: string;
  storeDomain?: string | null;
  /** False when the provider marked this specific point out of stock or otherwise unavailable. History keeps the point either way; only the comparable ("candidate store") set drops it. */
  inStock: boolean;
};

/** One store's listing of the product, with whatever dated points came back. */
export type MarketOffer = {
  /** ShopSavvy's retailer label ("Best Buy"), or the host when it omits one. */
  retailer: string;
  /** Bare registrable host, so it can be compared with our own `storeDomain`. Null when the URL failed validation. */
  storeDomain: string | null;
  /** Validated the same way a user-pasted product URL is (`convex/lib/watchUrl.ts`); null for anything that is not a real, public, http(s) shop link. */
  productUrl: string | null;
  cents: number | null;
  currency: string | null;
  /** When ShopSavvy last saw this price. Old timestamps are common and are shown as read. */
  observedAt: number | null;
  availability: string | null;
  condition: string | null;
  /** A marketplace seller name; a third-party listing is not the store's own price. */
  seller: string | null;
  history: MarketPoint[];
};

export type MarketSnapshot = {
  title: string | null;
  brand: string | null;
  imageUrl: string | null;
  offers: MarketOffer[];
};

/** The host, minus `www.`, or null when the URL is unusable. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function parsePoints(raw: unknown, now: number): MarketPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: MarketPoint[] = [];
  for (const entry of raw.slice(0, MARKET_PARSE_MAX_POINTS_PER_OFFER)) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const cents = toCents(e.price);
    // `timestamp` on history rows; the SDK's docs also show a `date` form.
    const observedAt = epoch(e.timestamp, now) ?? epoch(e.date, now);
    // A point never inherits its parent offer's currency: one that did not state its own is dropped.
    const currency = str(e.currency);
    if (cents === null || observedAt === null || currency === null) continue;
    points.push({ observedAt, cents, currency, inStock: isInStock(str(e.availability)) });
  }
  return points.sort((a, b) => a.observedAt - b.observedAt);
}

/**
 * What one ShopSavvy response body says, kept apart so the caller never has to
 * guess (QA-1, P03):
 *  - `snapshot`: a product envelope (possibly with no usable offers — the
 *    caller decides what zero points means);
 *  - `empty`: the provider's own "nothing for that product" answer —
 *    `success: false`, or a `data` that is absent, `null` or `[]`. A
 *    legitimate empty result, not a failure and never "not configured";
 *  - `malformed`: not an envelope at all (a non-object or top-level array
 *    root, or a `data` that is neither a product object nor a list starting
 *    with one) — the same class as a body that is not JSON.
 */
export type ShopSavvyEnvelope =
  | { kind: "snapshot"; snapshot: MarketSnapshot }
  | { kind: "empty" }
  | { kind: "malformed" };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the `{ success, data: [...] }` envelope. Anything malformed is dropped
 * rather than guessed at: a missing price is not the same as a free product.
 * An explicit `success: false` is trusted over any `data` the same body might
 * also carry — the provider is telling us it has nothing to give for this
 * request, so none of that data is read.
 *
 * `now` bounds every timestamp found inside (see `epoch`); it defaults to
 * `Date.now()` because only actions call this without passing one explicitly.
 */
export function parseEnvelope(body: unknown, now: number = Date.now()): ShopSavvyEnvelope {
  if (!isPlainRecord(body)) return { kind: "malformed" };
  if (body.success === false) return { kind: "empty" };
  const data = body.data;
  if (data === undefined || data === null) return { kind: "empty" };
  if (Array.isArray(data) && data.length === 0) return { kind: "empty" };
  const product: unknown = Array.isArray(data) ? data[0] : data;
  if (!isPlainRecord(product)) return { kind: "malformed" };
  return { kind: "snapshot", snapshot: readProduct(product, now) };
}

/**
 * The snapshot inside a product envelope, or null for every other answer
 * (empty or malformed alike). Callers that must tell those two apart — as
 * `convex/market.ts` must, to avoid recording a provider's empty answer as
 * anything else — use `parseEnvelope` instead.
 */
export function parseSnapshot(body: unknown, now: number = Date.now()): MarketSnapshot | null {
  const envelope = parseEnvelope(body, now);
  return envelope.kind === "snapshot" ? envelope.snapshot : null;
}

function readProduct(p: Record<string, unknown>, now: number): MarketSnapshot {
  const rawOffers = Array.isArray(p.offers) ? p.offers : [];
  const offers: MarketOffer[] = [];
  for (const entry of rawOffers.slice(0, MARKET_PARSE_MAX_OFFERS)) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const rawUrl = str(o.URL) ?? str(o.url);
    // Reuse the same validation a user-pasted product URL goes through: not http(s), carrying
    // credentials, on an unusual port, or pointing at a bare IP or an internal-only name are all
    // rejected here rather than trusted through to storage or the UI.
    const parsedUrl = rawUrl ? parseProductUrl(rawUrl) : null;
    const productUrl = parsedUrl?.productUrl ?? null;
    const storeDomain = parsedUrl?.merchantDomain ?? null;
    const retailer = str(o.retailer) ?? storeDomain;
    if (!retailer) continue;
    const currency = str(o.currency);
    offers.push({
      retailer,
      storeDomain,
      productUrl,
      cents: toCents(o.price),
      currency,
      observedAt: epoch(o.timestamp, now),
      availability: str(o.availability),
      condition: str(o.condition),
      seller: str(o.seller),
      history: parsePoints(o.history, now),
    });
  }

  const images = Array.isArray(p.images) ? p.images.slice(0, MARKET_PARSE_MAX_OFFERS) : [];
  const imageUrl = images.map(str).find((u): u is string => u !== null && u.startsWith("https://")) ?? null;

  return {
    title: str(p.title_short) ?? str(p.title),
    brand: str(p.brand),
    imageUrl,
    offers,
  };
}

/**
 * ShopSavvy matches a product across tens of thousands of sellers, so a handful of rows are a
 * different variant, an accessory, or a used unit: the mixer we tested spanned $69.99 to $829.99
 * around a ~$450 product. Reporting the raw minimum as "it has been this cheap" would be a lie, so
 * points are kept only within a band around the median. The band is wide on purpose (a real sale is
 * evidence, a bundle price is not), and everything kept still shows its store and date.
 *
 * Below `MIN_OUTLIER_POINTS` there is not enough of a distribution to find a median worth trusting,
 * so the series is returned unfiltered — callers that need to know whether filtering actually ran
 * (i.e. `verdict.ts`'s market fallback) check `points.length >= MIN_OUTLIER_POINTS` themselves.
 */
export function withoutOutliers(points: MarketPoint[]): MarketPoint[] {
  if (points.length < MIN_OUTLIER_POINTS) return points;
  const sorted = points.map((p) => p.cents).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return points;
  // Asymmetric on purpose. The low end is the claim a shopper acts on ("it has been this cheap"),
  // so it must survive a genuine sale; the high end only frames the range, so a bundle or a
  // multi-pack listed well above the product is cut sooner.
  return points.filter((p) => p.cents >= median * 0.4 && p.cents <= median * 1.75);
}

/**
 * Every dated point for one currency, newest last, deduplicated per store and
 * day. An offer's own `observedAt` counts as a point: ShopSavvy dates each
 * listing, so a listing last seen in June is a June price.
 *
 * Exclusions, all silent (the offer or point simply never joins history):
 *  - a marketplace seller's listing (not the store's own price)
 *  - a used/refurbished/open-box/renewed/bundle/accessory listing (condition)
 *  - a point whose currency does not exactly match `currency` — including a
 *    point with no currency at all, which is never assumed to be this one
 *
 * Not excluded: an out-of-stock point stays in history (a shopper could have
 * paid that price when it was in stock) but is flagged `inStock: false`.
 */
export function flattenHistory(snapshot: MarketSnapshot, currency: string): MarketPoint[] {
  const byKey = new Map<string, MarketPoint>();
  for (const offer of snapshot.offers) {
    if (offer.seller !== null || isExcludedCondition(offer.condition)) continue;
    const candidates: MarketPoint[] = [...offer.history];
    if (offer.cents !== null && offer.observedAt !== null) {
      candidates.push({
        observedAt: offer.observedAt,
        cents: offer.cents,
        currency: offer.currency,
        inStock: isInStock(offer.availability),
      });
    }
    for (const point of candidates) {
      // No default: a point with no currency of its own is excluded, never assumed to match.
      if (point.currency === null || point.currency !== currency) continue;
      const day = new Date(point.observedAt).toISOString().slice(0, 10);
      const key = `${offer.storeDomain ?? offer.retailer}:${day}`;
      const existing = byKey.get(key);
      // Keep the lowest price seen for a store on a day: that is what a shopper could have paid.
      if (!existing || point.cents < existing.cents) {
        byKey.set(key, { ...point, retailer: offer.retailer, storeDomain: offer.storeDomain });
      }
    }
  }
  return withoutOutliers([...byKey.values()]).sort((a, b) => a.observedAt - b.observedAt);
}

/** What the day-one verdict needs: the range a shopper has actually seen. */
export type MarketStats = {
  lowestCents: number;
  highestCents: number;
  points: number;
  /** Oldest point, so the UI can say how far back the evidence goes. */
  since: number;
  /** Cheapest current listing from a store other than the watched one. */
  best: { retailer: string; storeDomain: string | null; cents: number; productUrl: string | null } | null;
};

/**
 * @deprecated Nothing outside this file's own tests calls this: `convex/market.ts` re-exports it
 * (`export { marketStats };`) but nothing imports that re-export either, and the watch summary's
 * market block (`convex/watches.ts`) is built from `flattenHistory` directly. Left in place,
 * hardened to the same currency/condition/availability/URL rules as `flattenHistory`, because
 * deleting it would remove `market.ts`'s import and re-export — a file this task does not own
 * (see the task report's "known gaps" for the one-line caller change that finishes the removal).
 */
export function marketStats(
  snapshot: MarketSnapshot,
  currency: string,
  ownDomain: string | null,
): MarketStats | null {
  const points = withoutOutliers(flattenHistory(snapshot, currency));
  if (points.length === 0) return null;

  let best: MarketStats["best"] = null;
  for (const offer of snapshot.offers) {
    if (offer.cents === null || offer.seller !== null) continue;
    // No default: an offer with no currency of its own is excluded, never assumed to match.
    if (offer.currency === null || offer.currency !== currency) continue;
    if (isExcludedCondition(offer.condition)) continue;
    if (!isInStock(offer.availability)) continue;
    if (offer.storeDomain !== null && ownDomain !== null && offer.storeDomain === ownDomain) continue;
    if (!best || offer.cents < best.cents) {
      best = {
        retailer: offer.retailer,
        storeDomain: offer.storeDomain,
        cents: offer.cents,
        productUrl: offer.productUrl,
      };
    }
  }

  const prices = points.map((p) => p.cents);
  return {
    lowestCents: Math.min(...prices),
    highestCents: Math.max(...prices),
    points: points.length,
    since: points[0].observedAt,
    best,
  };
}
