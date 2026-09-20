/**
 * Pure helpers for policy research (T08). No Convex, no network, no SDKs —
 * everything here is unit-testable in isolation.
 *
 * Two jobs:
 *  1. Verbatim passage verification (D17). A passage is stored only if it is
 *     found verbatim in the scraped markdown after whitespace normalization,
 *     together with its `passageStart` offset into the *original* text.
 *  2. Picking the best search result to scrape for a given policy kind.
 */

export type PolicyKind = "price_adjustment" | "returns";

/** Collapses every run of whitespace to a single space and trims. */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes whitespace while remembering, for each character of the result,
 * the index it came from in the original string.
 */
function normalizeWithMap(text: string): { normalized: string; offsets: number[] } {
  const chars: string[] = [];
  const offsets: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v") {
      if (chars.length > 0) pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      chars.push(" ");
      offsets.push(i);
      pendingSpace = false;
    }
    chars.push(ch);
    offsets.push(i);
  }
  return { normalized: chars.join(""), offsets };
}

export type LocatedPassage = { passage: string; passageStart: number };

/** A quoted passage shorter than this is not evidence of anything. */
export const MIN_PASSAGE_CHARS = 12;
/** `policies.passage` is display copy on a card; keep it bounded (D30). */
export const MAX_PASSAGE_CHARS = 600;

/**
 * Locates `passage` inside `source` comparing whitespace-normalized text.
 * Returns the passage exactly as it appears in `source` plus the offset it
 * starts at, or `null` when the model did not copy from the page (D17).
 *
 * The returned passage is truncated to `MAX_PASSAGE_CHARS`; a prefix of a
 * verbatim substring is still verbatim and still starts at `passageStart`.
 */
export function locatePassage(source: string, passage: string): LocatedPassage | null {
  const needle = normalizeWhitespace(passage);
  if (needle.length < MIN_PASSAGE_CHARS) return null;
  const { normalized, offsets } = normalizeWithMap(source);
  const idx = normalized.indexOf(needle);
  if (idx === -1) return null;
  const start = offsets[idx];
  const end = offsets[idx + needle.length - 1];
  return { passage: source.slice(start, end + 1).slice(0, MAX_PASSAGE_CHARS), passageStart: start };
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Reduces user or extractor input to a bare registrable-ish host
 * (`https://WWW.BestBuy.com/x` → `bestbuy.com`). Returns `null` when the
 * input is not a plausible domain, so callers can fail closed.
 */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (s.length === 0 || s.length > 253) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split("/")[0].split("?")[0].split("#")[0];
  s = s.split("@").pop() ?? s;
  s = s.split(":")[0];
  if (s.startsWith("www.")) s = s.slice(4);
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!DOMAIN_RE.test(s)) return null;
  return s;
}

/** True when `url`'s host is `domain` or a subdomain of it. */
export function hostMatchesDomain(url: string, domain: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host === domain || host.endsWith(`.${domain}`);
}

const EMAIL_RE = /^[^\s@,;<>]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Conservative check before storing a contact address the model produced. */
export function isEmail(value: string): boolean {
  const s = value.trim();
  return s.length <= 254 && EMAIL_RE.test(s);
}

/** A returns/price window the UI can count down. Anything else is unusable. */
export function sanitizeWindowDays(value: number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) return undefined;
  return value;
}

/** Loose shape of one Firecrawl search hit; the component returns the API response as-is. */
export type SearchHit = {
  url?: unknown;
  title?: unknown;
  markdown?: unknown;
  metadata?: { sourceURL?: unknown; url?: unknown; title?: unknown } | unknown;
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A search hit is either a bare result (`url`) or a scraped document (`metadata.sourceURL`). */
export function hitUrl(hit: SearchHit): string | null {
  const meta = (hit.metadata ?? {}) as { sourceURL?: unknown; url?: unknown };
  return str(hit.url) ?? str(meta.sourceURL) ?? str(meta.url);
}

export function hitMarkdown(hit: SearchHit): string | null {
  return str(hit.markdown);
}

export function hitTitle(hit: SearchHit): string | null {
  const meta = (hit.metadata ?? {}) as { title?: unknown };
  return str(hit.title) ?? str(meta.title);
}

const KIND_KEYWORDS: Record<PolicyKind, string[]> = {
  price_adjustment: [
    "price-adjust",
    "priceadjust",
    "price_adjust",
    "price adjustment",
    "price-match",
    "pricematch",
    "price match",
    "price-guarantee",
    "price-protection",
    "lower-price",
  ],
  returns: ["return", "refund", "exchange"],
};

const GENERIC_KEYWORDS = [
  "policy",
  "policies",
  "help",
  "support",
  "customer-service",
  "customerservice",
  "customer-care",
  "faq",
];

function hasAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/** Higher is better. `null` means the hit is not usable at all. */
export function scoreHit(
  hit: SearchHit,
  opts: { domain: string; kind: PolicyKind; position: number },
): number | null {
  const url = hitUrl(hit);
  if (!url || !hostMatchesDomain(url, opts.domain)) return null;
  const lowerUrl = url.toLowerCase();
  const title = (hitTitle(hit) ?? "").toLowerCase();
  const markdown = hitMarkdown(hit);
  let score = 0;
  if (hasAny(lowerUrl, KIND_KEYWORDS[opts.kind])) score += 100;
  if (hasAny(title, KIND_KEYWORDS[opts.kind])) score += 40;
  if (hasAny(lowerUrl, GENERIC_KEYWORDS)) score += 25;
  if (markdown) score += markdown.length >= 400 ? 15 : 5;
  // Firecrawl already ranks results; use position only as a tiebreak.
  score -= opts.position;
  return score;
}

export type ChosenPage = { url: string; markdown: string | null };

/**
 * Picks the on-domain search result most likely to be the policy page for
 * `kind`. Off-domain results are discarded outright so a third-party blog can
 * never become a stored "merchant policy".
 */
export function chooseBestResult(
  hits: readonly SearchHit[],
  opts: { domain: string; kind: PolicyKind },
): ChosenPage | null {
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestHit: SearchHit | null = null;
  for (let position = 0; position < hits.length; position++) {
    const hit = hits[position];
    const score = scoreHit(hit, { domain: opts.domain, kind: opts.kind, position });
    if (score === null || score <= bestScore) continue;
    bestScore = score;
    bestHit = hit;
  }
  if (bestHit === null) return null;
  const url = hitUrl(bestHit);
  if (!url) return null;
  return { url, markdown: hitMarkdown(bestHit) };
}
