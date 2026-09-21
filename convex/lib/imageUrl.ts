/**
 * Product images. The only source is the Open Graph image a product page
 * declares about itself, read off the scrape we already paid for. It is shown
 * in an <img>, so only an absolute https URL of a sane length is ever stored.
 */

export const MAX_IMAGE_URL_CHARS = 2000;

/** The URL when it is an absolute https URL of at most MAX_IMAGE_URL_CHARS, else undefined. */
export function cleanImageUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_IMAGE_URL_CHARS) return undefined;
  if (!/^https:\/\//i.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/** Metadata keys a scrape may carry the Open Graph image under, most specific first. */
const IMAGE_KEYS = ["ogImage", "og:image", "og:image:secure_url", "image"] as const;

/**
 * The page's Open Graph image from a scrape result's `metadata`. The metadata
 * is an open record from outside, so every value is narrowed: a string, or the
 * first string of an array (pages with several og:image tags).
 */
export function pageImageUrl(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const record = metadata as Record<string, unknown>;
  for (const key of IMAGE_KEYS) {
    const value = record[key];
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const clean = cleanImageUrl(candidate);
      if (clean !== undefined) return clean;
    }
  }
  return undefined;
}

/** The patch value for a row's `imageUrl`: the clean URL when the row has none or it changed, else undefined. */
export function imageUrlChange(current: string | undefined, raw: unknown): string | undefined {
  const clean = cleanImageUrl(raw);
  return clean !== undefined && clean !== current ? clean : undefined;
}
