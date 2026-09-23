/**
 * SEC-AI-4 content check (M13; moved here by M20 under D206(4) so lib code — `lib/packets/common.ts` — can
 * use it without importing a Convex function module). `drafts.ts` re-exports `unverifiedContent`; behaviour is
 * identical to the drafts copy it replaces, including M13's DA-B-19 change (every finding listed). Pure: no ctx, no clock.
 */
/** Values the server gave the writer (or bound): the only emails, links and amounts a claim email may state. */
export type Allowances = { emails: Set<string>; urls: Set<string>; hosts: Set<string>; amountsMinor: Set<number> };

const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[A-Za-z]{2,}/g;
const URL_IN_TEXT = /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;
const PHONE_IN_TEXT = /(?:\+\d{1,3}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g;
const CURRENCY_CODES = "USD|EUR|GBP|CAD|AUD";
const CURRENCY_WORDS = "dollars?|euros?|pounds?|bucks";
/**
 * Money in every form DA-B-5 names: a leading symbol ("$450"), a two-decimal number with or without a code ("95.00
 * USD"), a number then a code or word ("40 dollars"), a code first ("USD 450"), and a trailing symbol ("450$").
 */
const AMOUNT_IN_TEXT = new RegExp(
  [
    "[$€£]\\s?\\d[\\d,]*(?:\\.\\d{1,2})?",
    `\\b(?:${CURRENCY_CODES})\\s?\\d[\\d,]*(?:\\.\\d{1,2})?`,
    `\\b\\d[\\d,]*(?:\\.\\d{1,2})?\\s?[$€£]`,
    `\\b\\d[\\d,]*\\.\\d{2}\\b(?:\\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS}))?`,
    `\\b\\d[\\d,]*\\s?(?:${CURRENCY_CODES}|${CURRENCY_WORDS})\\b`,
  ].join("|"),
  "gi",
);
const NUMBER_WORDS =
  "zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million";
/** A spelled amount: number words (with "and"/hyphens between them) next to a currency word or code (DA-B-5). */
const SPELLED_AMOUNT = new RegExp(
  `\\b(?:${NUMBER_WORDS})(?:[\\s-]+(?:and[\\s-]+)?(?:${NUMBER_WORDS}))*\\s+(?:${CURRENCY_WORDS}|${CURRENCY_CODES})\\b`,
  "gi",
);
/** "claims [at] evil.example", "claims (at) evil.example" → an address (DA-B-5). */
const BRACKET_AT = /\s*[[(]\s*at\s*[\])]\s*/gi;
/** "claims at evil.example" when no path follows (a path makes it a bare link, checked below). */
const WORD_AT = /\b([A-Za-z0-9._%+-]+)\s+at\s+((?:[a-z0-9-]+\.)+[a-z]{2,})\b(?![/.\w-])/gi;
/** A bare `host.tld/path` token (no scheme) — DA-B-5. A host without a path is not a link and is left alone. */
const BARE_LINK = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(\/[^\s<>()"']*)/gi;

export function normalizeUrl(raw: string): string {
  return raw.replace(/[.,;:!?)\]]+$/, "").replace(/^www\./i, "https://www.").replace(/\/+$/, "").toLowerCase();
}

function hostOf(raw: string): string | null {
  try {
    return new URL(normalizeUrl(raw)).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Minor units of an amount token ("$1,234.50", "79.99 USD", "40 dollars"), by string arithmetic; null if unreadable. */
function amountTokenMinor(token: string): number | null {
  const m = /(\d[\d,]*)(?:\.(\d{1,2}))?/.exec(token);
  if (!m) return null;
  const whole = Number(m[1].replace(/,/g, ""));
  const frac = m[2] === undefined ? 0 : Number(m[2].padEnd(2, "0"));
  const minor = whole * 100 + frac;
  return Number.isSafeInteger(minor) ? minor : null;
}

/**
 * SEC-AI-4 (M13): the post-generation check on a claim email. Any email address, link, phone number or money amount
 * in the body that the server did not supply — the recipient, the store's confirmed contact, the user's own
 * addresses, the item and policy links (or the store's own site), and the claim's own amounts — is listed. A
 * non-empty list blocks approval until the user edits the text or acknowledges it (`acknowledgeUnverifiedContent`).
 * EVERY distinct finding is listed (DA-B-19): the acknowledgment's `findingsHash` covers the whole list, so it can
 * never cover a finding the user was not shown. The list stays small because the body is capped at 1,200 characters,
 * which is also why the patterns never see unbounded input. Pure.
 */
export function unverifiedContent(body: string, allowed: Allowances): string[] {
  const findings: string[] = [];
  const seen = new Set<string>();
  const add = (f: string) => {
    if (!seen.has(f)) {
      seen.add(f);
      findings.push(f);
    }
  };
  const hostAllowed = (host: string) => [...allowed.hosts].some((h) => host === h || host.endsWith(`.${h}`));
  // 1. Links with a scheme or "www.".
  for (const m of body.matchAll(URL_IN_TEXT)) {
    const url = normalizeUrl(m[0]);
    const host = hostOf(m[0]);
    if (!allowed.urls.has(url) && !(host !== null && hostAllowed(host))) add(`link ${m[0]}`);
  }
  // 2. Addresses, after undoing the obfuscations DA-B-5 names ("[at]", "(at)", " at " before a bare host).
  let rest = body.replace(URL_IN_TEXT, " ").replace(BRACKET_AT, "@");
  rest = rest.replace(WORD_AT, (whole, local: string, host: string) => (hostAllowed(host.toLowerCase()) ? whole : `${local}@${host}`));
  for (const m of rest.matchAll(EMAIL_IN_TEXT)) {
    if (!allowed.emails.has(m[0].toLowerCase())) add(`email ${m[0]}`);
  }
  rest = rest.replace(EMAIL_IN_TEXT, " ");
  // 3. Bare `host.tld/path` links with no scheme.
  for (const m of rest.matchAll(BARE_LINK)) {
    const token = m[0].replace(/[.,;:!?)\]]+$/, "");
    if (!allowed.urls.has(normalizeUrl(`https://${token}`)) && !hostAllowed(m[1].toLowerCase())) add(`link ${token}`);
  }
  rest = rest.replace(BARE_LINK, " ");
  // 4. Phone numbers, then amounts (numeric in every symbol/code position, and spelled out).
  for (const m of rest.matchAll(PHONE_IN_TEXT)) add(`phone ${m[0].trim()}`);
  for (const m of rest.matchAll(AMOUNT_IN_TEXT)) {
    const minor = amountTokenMinor(m[0]);
    if (minor === null || !allowed.amountsMinor.has(minor)) add(`amount ${m[0].trim()}`);
  }
  // A spelled amount is never something the server wrote; it is always listed.
  for (const m of rest.matchAll(SPELLED_AMOUNT)) add(`amount ${m[0].trim()}`);
  return findings;
}
