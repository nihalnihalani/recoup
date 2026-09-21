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
 */

/** Prices arrive as decimal dollars; everything inside Recoup is integer cents. */
export function toCents(price: unknown): number | null {
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;
  const cents = Math.round(price * 100);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function epoch(value: unknown): number | null {
  const raw = str(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** One dated price for one store. `retailer` and `storeDomain` are kept so every point can say where it came from. */
export type MarketPoint = {
  observedAt: number;
  cents: number;
  currency: string | null;
  retailer?: string;
  storeDomain?: string | null;
};

/** One store's listing of the product, with whatever dated points came back. */
export type MarketOffer = {
  /** ShopSavvy's retailer label ("Best Buy"), or the host when it omits one. */
  retailer: string;
  /** Bare registrable host, so it can be compared with our own `storeDomain`. */
  storeDomain: string | null;
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

function parsePoints(raw: unknown, currency: string | null): MarketPoint[] {
  if (!Array.isArray(raw)) return [];
  const points: MarketPoint[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const cents = toCents(e.price);
    // `timestamp` on history rows; the SDK's docs also show a `date` form.
    const observedAt = epoch(e.timestamp) ?? epoch(e.date);
    if (cents === null || observedAt === null) continue;
    points.push({ observedAt, cents, currency: str(e.currency) ?? currency });
  }
  return points.sort((a, b) => a.observedAt - b.observedAt);
}

/**
 * Reads the `{ success, data: [...] }` envelope. Anything malformed is dropped
 * rather than guessed at: a missing price is not the same as a free product.
 */
export function parseSnapshot(body: unknown): MarketSnapshot | null {
  if (typeof body !== "object" || body === null) return null;
  const root = body as Record<string, unknown>;
  const data = root.data;
  const product = Array.isArray(data) ? data[0] : data;
  if (typeof product !== "object" || product === null) return null;
  const p = product as Record<string, unknown>;

  const rawOffers = Array.isArray(p.offers) ? p.offers : [];
  const offers: MarketOffer[] = [];
  for (const entry of rawOffers) {
    if (typeof entry !== "object" || entry === null) continue;
    const o = entry as Record<string, unknown>;
    const productUrl = str(o.URL) ?? str(o.url);
    const storeDomain = hostOf(productUrl);
    const retailer = str(o.retailer) ?? storeDomain;
    if (!retailer) continue;
    const currency = str(o.currency);
    offers.push({
      retailer,
      storeDomain,
      productUrl,
      cents: toCents(o.price),
      currency,
      observedAt: epoch(o.timestamp),
      availability: str(o.availability),
      condition: str(o.condition),
      seller: str(o.seller),
      history: parsePoints(o.history, currency),
    });
  }

  const images = Array.isArray(p.images) ? p.images : [];
  const imageUrl = images.map(str).find((u): u is string => u !== null && u.startsWith("https://")) ?? null;

  return {
    title: str(p.title_short) ?? str(p.title),
    brand: str(p.brand),
    imageUrl,
    offers,
  };
}

/**
 * Every dated point for one currency, newest last, deduplicated per store and
 * day. An offer's own `observedAt` counts as a point: ShopSavvy dates each
 * listing, so a listing last seen in June is a June price.
 */
/**
 * ShopSavvy matches a product across tens of thousands of sellers, so a handful of rows are a
 * different variant, an accessory, or a used unit: the mixer we tested spanned $69.99 to $829.99
 * around a ~$450 product. Reporting the raw minimum as "it has been this cheap" would be a lie, so
 * points are kept only within a band around the median. The band is wide on purpose (a real sale is
 * evidence, a bundle price is not), and everything kept still shows its store and date.
 */
export function withoutOutliers(points: MarketPoint[]): MarketPoint[] {
  if (points.length < 4) return points;
  const sorted = points.map((p) => p.cents).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median <= 0) return points;
  // Asymmetric on purpose. The low end is the claim a shopper acts on ("it has been this cheap"),
  // so it must survive a genuine sale; the high end only frames the range, so a bundle or a
  // multi-pack listed well above the product is cut sooner.
  return points.filter((p) => p.cents >= median * 0.4 && p.cents <= median * 1.75);
}

export function flattenHistory(snapshot: MarketSnapshot, currency: string): MarketPoint[] {
  const byKey = new Map<string, MarketPoint>();
  for (const offer of snapshot.offers) {
    // A marketplace seller's price is not the store's price, so it never joins the history.
    if (offer.seller !== null) continue;
    const candidates: MarketPoint[] = [...offer.history];
    if (offer.cents !== null && offer.observedAt !== null) {
      candidates.push({ observedAt: offer.observedAt, cents: offer.cents, currency: offer.currency });
    }
    for (const point of candidates) {
      if ((point.currency ?? currency) !== currency) continue;
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
    if ((offer.currency ?? currency) !== currency) continue;
    if (offer.storeDomain !== null && ownDomain !== null && offer.storeDomain === ownDomain) continue;
    if (offer.availability !== null && offer.availability !== "in") continue;
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
