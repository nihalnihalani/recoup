/**
 * Pure rules for "the same item at other stores" (W3): which search results
 * are shops at all, one result per store, how much a match is trusted, and
 * what a stored store URL looks like. No Convex imports; unit-tested directly.
 */
import { parseProductUrl } from "./watchUrl";

/** Marketplaces of individuals and social sites: a listing there is not a store's price. */
export const EXCLUDED_HOSTS: ReadonlyArray<string> = [
  "facebook.com",
  "craigslist.org",
  "reddit.com",
  "pinterest.com",
  "youtube.com",
  "instagram.com",
  "tiktok.com",
];

/** Exact query-parameter names that only track the click. `utm_*` is matched by prefix. */
const TRACKING_PARAMS: ReadonlySet<string> = new Set(["gclid", "fbclid", "ref", "tag", "affid", "irclickid"]);

/** Second-level labels that are part of the public suffix under a two-letter TLD (co.uk, com.au, ...). */
const SUFFIX_SECOND_LEVELS: ReadonlySet<string> = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ne", "or"]);

const MAX_TITLE_CHARS = 200;

/**
 * The registrable host of a hostname: `shop.nike.com` -> `nike.com`,
 * `www.johnlewis.co.uk` -> `johnlewis.co.uk`. A heuristic, not the public
 * suffix list (no new packages): good enough to keep one row per store.
 */
export function registrableHost(hostname: string): string | null {
  let host = hostname.trim().toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((l) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^[a-z][a-z0-9-]*$/.test(tld)) return null; // bare IPs
  const take =
    labels.length >= 3 && tld.length === 2 && SUFFIX_SECOND_LEVELS.has(labels[labels.length - 2]) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * A store URL exactly as found, minus click tracking (utm_*, gclid, fbclid,
 * ref, tag, affid, irclickid) and the fragment. Never adds a parameter. Null
 * when the URL is not one we would scrape (see `parseProductUrl`).
 */
export function cleanStoreUrl(input: string): { productUrl: string; storeDomain: string } | null {
  const parsed = parseProductUrl(input);
  if (!parsed) return null;
  const url = new URL(parsed.productUrl);
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) url.searchParams.delete(key);
  }
  const storeDomain = registrableHost(url.hostname);
  if (!storeDomain) return null;
  return { productUrl: url.toString(), storeDomain };
}

export type SearchHit = { url: string; title?: string };
export type StorePage = { storeDomain: string; productUrl: string; title: string };

/**
 * Not a hostname, so it can never collide with a real store's row. Shared by
 * `offers.ts` (the pending-search marker row) and `market.ts` (excluded from
 * the by-watch existing-rows count the same way a marker is).
 */
export const FIND_MARKER = "~find";

/**
 * True when `a` and `b` name the same store once reduced to a registrable
 * host (T13/P04): `shop.acme.example` and `outlet.acme.example` are the same
 * store, `acme.example` and `acme-outlet.example` are not. Either side may
 * already be a bare registrable host (e.g. `watch.merchantDomain`) or a full
 * hostname; `registrableHost` is idempotent on an already-registrable input,
 * and a host it cannot parse falls back to a plain lowercase compare so a
 * malformed value never silently matches everything.
 */
export function sameStore(a: string, b: string): boolean {
  const ra = registrableHost(a) ?? a.trim().toLowerCase();
  const rb = registrableHost(b) ?? b.trim().toLowerCase();
  return ra === rb;
}

/**
 * Rough, dependency-free similarity between two product titles/names, 0..1:
 * lowercase, split into alphanumeric tokens, Jaccard overlap of the token
 * sets (divided by the LARGER set, so a short title fully contained in a
 * longer one still scores below 1 unless they are close in length). This is
 * not NLP — it only has to catch "the listing at this URL is obviously a
 * different product now" (P04: confirmed offer matching must not silently
 * authorize a later variant), not judge close variants against each other.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap / Math.max(ta.size, tb.size);
}

/** Below this, two titles are treated as different products (T13). Documented, not tuned against real data. */
export const TITLE_DRIFT_THRESHOLD = 0.3;

/**
 * Search results -> at most `max` store pages: the watch's own store and the
 * excluded hosts are dropped, and only the first result per registrable host
 * is kept (search order is the ranking we trust).
 */
export function selectStorePages(hits: ReadonlyArray<SearchHit>, ownDomain: string, max: number): StorePage[] {
  const own = registrableHost(ownDomain) ?? ownDomain.toLowerCase();
  const seen = new Set<string>();
  const out: StorePage[] = [];
  for (const hit of hits) {
    if (out.length >= max) break;
    const cleaned = cleanStoreUrl(hit.url);
    if (!cleaned) continue;
    const { storeDomain, productUrl } = cleaned;
    if (storeDomain === own || EXCLUDED_HOSTS.includes(storeDomain) || seen.has(storeDomain)) continue;
    seen.add(storeDomain);
    const title = hit.title?.trim();
    out.push({ storeDomain, productUrl, title: (title ? title : storeDomain).slice(0, MAX_TITLE_CHARS) });
  }
  return out;
}

/**
 * How much a candidate is trusted to be the same product: the extractor's
 * confidence for an exact variant, half of it when the variant is unsure,
 * nothing when the page is not that product.
 */
export function matchConfidence(variantMatch: "exact" | "unsure" | "none", confidence: number | undefined): number {
  const c = confidence === undefined || !Number.isFinite(confidence) ? 0 : Math.min(1, Math.max(0, confidence));
  if (variantMatch === "exact") return c;
  if (variantMatch === "unsure") return c / 2;
  return 0;
}
