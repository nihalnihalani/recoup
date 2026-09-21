import { normalizeDomain } from "./policyText";

/** Longer than any real product URL; a bound on what we store and hand to the scraper. */
export const MAX_URL_CHARS = 2_000;
const MAX_DEFAULT_NAME_CHARS = 80;

export type ProductUrl = { productUrl: string; merchantDomain: string };

/**
 * A pasted product link, or null when it is not one we will scrape: not
 * http(s), carrying credentials, or pointing at a bare IP / single-label host
 * (nothing on a private network is a shop).
 */
export function parseProductUrl(input: string): ProductUrl | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  const merchantDomain = normalizeDomain(url.hostname);
  if (!merchantDomain) return null;
  const tld = merchantDomain.split(".").pop() ?? "";
  if (!/^[a-z][a-z0-9-]*$/.test(tld)) return null; // 127.0.0.1 and friends
  url.hash = "";
  return { productUrl: url.toString(), merchantDomain };
}

/**
 * The placeholder name for a watch the user did not name: host plus the last
 * path segment. Deterministic, so "is the name still the default?" is a
 * comparison and needs no extra column.
 */
export function defaultWatchName(productUrl: string): string {
  let url: URL;
  try {
    url = new URL(productUrl);
  } catch {
    return productUrl.slice(0, MAX_DEFAULT_NAME_CHARS);
  }
  const host = url.hostname.replace(/^www\./, "");
  const tail = url.pathname.split("/").filter((s) => s.length > 0).pop();
  let readable = "";
  if (tail) {
    try {
      readable = decodeURIComponent(tail);
    } catch {
      readable = tail;
    }
    readable = readable.replace(/\.(html?|php|aspx?)$/i, "").replace(/[-_+]+/g, " ").trim();
  }
  return (readable ? `${host}: ${readable}` : host).slice(0, MAX_DEFAULT_NAME_CHARS);
}
