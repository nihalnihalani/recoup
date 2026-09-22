/**
 * Quote verification for extracted facts (DA-A-6, D145; contract rev 5 §2.6 "Quote verification"; M23).
 *
 * An extracted fact cites the passage it came from (`factSource.evidence.locator` + `quoteStatus`). The status says
 * how far that citation can be trusted, and only `verified` ever counts toward a rule's `evidenceSupports`:
 *
 *   - `verified` needs BOTH
 *       (i)  the quote is really there: `normalizeForMatch(text.slice(start, end)) === normalizeForMatch(quote)` at a
 *            `text_span` locator (no 40-character minimum — that floor is for policy passages only, D17/D45), or the
 *            quote appears on the cited page / in the cited header / in the document for the other locators — always
 *            against a DETERMINISTIC text layer: email or paste text, or a PDF text layer read by `lib/pdfText`;
 *       (ii) the emitted VALUE parses back out of the quote for its kind: money through `parseDecimalToMinor` (one
 *            amount, no sign marker, no contradicting currency), dates through the date grammar below, identifiers
 *            and codes exactly, counts and minutes as their numbers, text as contained words;
 *   - `unverifiable` when there is no deterministic text layer at all — content the model transcribed from an image
 *            or an image-only PDF. It is never `verified`, whatever the model says;
 *   - `unverified` for everything else: a quote that is not at its locator, or a value that does not parse from it
 *            (a digit-swapped amount, a different day).
 *
 * Pure: no ctx, clock, network or model. `lib/facts/write.putFact` stores whatever status a caller computed here.
 */
import { parseDecimalToMinor, type CurrencyMode } from "./money";
import { normalizeForMatch } from "./passage";

export type QuoteStatus = "verified" | "unverified" | "unverifiable";

/** The deterministic text a document offers, or null when it has none (a photo, an image-only PDF). */
export type TextLayer = {
  /** The whole text layer (email or paste text; PDF pages joined with "\n"). */
  text: string;
  /** PDF only: each page's text, 1-based page n at index n − 1. */
  pages?: readonly string[];
  /** Email only: the headers kept on the evidence row. */
  headers?: Partial<Record<"from" | "date" | "subject" | "message_id", string>>;
} | null;

export type QuoteLocator =
  | { kind: "text_span"; start: number; end: number; quote: string }
  | { kind: "pdf_page"; page: number; quote?: string }
  | { kind: "email_header"; header: "from" | "date" | "subject" | "message_id" }
  | { kind: "whole_document" };

/** The value kinds a quote can bind (`factValue` minus `user_unknown`, which is never extracted). */
export type QuotedValue =
  | { kind: "money"; amountMinor: number; currency: string }
  | { kind: "instant"; epochMs: number }
  | { kind: "local_date"; date: string; timeZone?: string }
  | { kind: "local_datetime"; dateTime: string; timeZone?: string }
  | { kind: "code"; code: string }
  | { kind: "text"; text: string }
  | { kind: "identifier"; scheme: string; value: string }
  | { kind: "bool"; value: boolean }
  | { kind: "count"; n: number }
  | { kind: "minutes"; minutes: number };

// ---------------------------------------------------------------------------
// (i) the quote is at its locator
// ---------------------------------------------------------------------------

/** The quote text a locator carries, if any (an `email_header` quote is the header itself). */
function quoteOf(locator: QuoteLocator, layer: NonNullable<TextLayer>): string | null {
  switch (locator.kind) {
    case "text_span":
      return locator.quote;
    case "pdf_page":
      return locator.quote ?? null;
    case "email_header":
      return layer.headers?.[locator.header] ?? null;
    case "whole_document":
      return null;
  }
}

/** (i) Is the quote really at the locator? Never true for an empty quote. */
export function quoteAtLocator(layer: NonNullable<TextLayer>, locator: QuoteLocator, quote: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length === 0) return false;
  switch (locator.kind) {
    case "text_span": {
      const { start, end } = locator;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > layer.text.length) return false;
      return normalizeForMatch(layer.text.slice(start, end)) === q;
    }
    case "pdf_page": {
      const page = layer.pages?.[locator.page - 1];
      return Number.isSafeInteger(locator.page) && locator.page >= 1 && page !== undefined && normalizeForMatch(page).includes(q);
    }
    case "email_header":
      // The header is the text layer here: the quote IS the header value.
      return layer.headers?.[locator.header] !== undefined && normalizeForMatch(layer.headers[locator.header]!) === q;
    case "whole_document":
      return normalizeForMatch(layer.text).includes(q);
  }
}

// ---------------------------------------------------------------------------
// (ii) the value parses back out of the quote
// ---------------------------------------------------------------------------

const AMOUNT_TOKEN = /(?<![\d.,])[-−(]?\d[\d,]*(?:\.\d+)?\)?(?:\s?(?:CR|DR)\b)?(?![\d.])/gi;
const CURRENCY_SYMBOLS: Readonly<Record<string, readonly string[]>> = {
  $: ["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "MXN"],
  "€": ["EUR"],
  "£": ["GBP"],
  "¥": ["JPY", "CNY"],
};

/** Every currency the quote names, by ISO code or symbol; the value's currency must be among them when any is named. */
function currenciesNamed(quote: string): Set<string> | null {
  const named = new Set<string>();
  for (const m of quote.matchAll(/\b[A-Z]{3}\b/g)) {
    if (/^(?:CR|DR)$/.test(m[0])) continue;
    try {
      new Intl.NumberFormat("en-US", { style: "currency", currency: m[0] });
      named.add(m[0]);
    } catch {
      // Not a currency code (an order prefix, an airport): ignored.
    }
  }
  let symbol = false;
  for (const [sym, codes] of Object.entries(CURRENCY_SYMBOLS)) {
    if (quote.includes(sym)) {
      symbol = true;
      for (const c of codes) named.add(c);
    }
  }
  return named.size > 0 || symbol ? named : null;
}

function moneyParses(quote: string, value: Extract<QuotedValue, { kind: "money" }>, mode: CurrencyMode): boolean {
  const tokens = [...quote.matchAll(AMOUNT_TOKEN)].map((m) => m[0]);
  // Exactly one amount: a quote naming several numbers does not say which one the value is.
  if (tokens.length !== 1) return false;
  const parsed = parseDecimalToMinor(tokens[0], value.currency, mode);
  if (!parsed.ok || parsed.amountMinor !== value.amountMinor) return false; // a sign-marked amount never matches
  const named = currenciesNamed(quote);
  return named === null || named.has(value.currency);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The date grammar (M23): ISO `2026-09-01`; `September 1, 2026` / `Sep 1 2026` / `Sept. 1st, 2026`;
 * `1 September 2026`; US numeric `09/01/2026` or `9/1/26`. A numeric date whose day and month could be swapped (both
 * ≤ 12 and different) is AMBIGUOUS and yields every reading, so it verifies only a value that every reading agrees
 * with — i.e. never, unless day = month. Returns the ISO dates the quote can mean, or [] when it holds none.
 */
export function datesInQuote(quote: string): string[] {
  const out = new Set<string>();
  const iso = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return;
    out.add(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  };
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  for (const m of quote.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) iso(Number(m[1]), Number(m[2]), Number(m[3]));
  const monthName = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  for (const m of quote.matchAll(new RegExp(`\\b${monthName}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"))) {
    iso(Number(m[3]), month(m[1]), Number(m[2]));
  }
  for (const m of quote.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${monthName}\\.?,?\\s+(\\d{4})\\b`, "gi"))) {
    iso(Number(m[3]), month(m[2]), Number(m[1]));
  }
  for (const m of quote.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})\b/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    iso(year(m[3]), a, b); // US month/day
    if (a <= 12 && b <= 12 && a !== b) iso(year(m[3]), b, a); // ambiguous: day/month too
  }
  return [...out];
}

function dateParses(quote: string, isoDate: string): boolean {
  const dates = datesInQuote(quote);
  // Every reading must be this date: one date, or an unambiguous one.
  return dates.length === 1 && dates[0] === isoDate;
}

/** `hh:mm` (24h or with am/pm) in the quote, as minutes after midnight; null when it states no time. */
function timeInQuote(quote: string): number | null {
  const m = /\b(\d{1,2}):(\d{2})(?:\s?([ap])\.?m\.?)?\b/i.exec(quote);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  }
  return h <= 23 && min <= 59 ? h * 60 + min : null;
}

/**
 * The value occurs in the quote as a whole token: not inside a longer run of letters or digits, and not a piece of a
 * longer separated identifier ("112-3456789" inside "112-3456789-1234562").
 */
function containsToken(quote: string, token: string, flags = ""): boolean {
  if (token.length === 0) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9]|[A-Za-z0-9][-_/.])${escaped}(?![A-Za-z0-9]|[-_/.][A-Za-z0-9])`, flags).test(quote);
}

function integerTokens(quote: string): number[] {
  return [...quote.matchAll(/(?<![\d.,])\d+(?![\d.,]*\d)/g)].map((m) => Number(m[0]));
}

/** (ii) Does the emitted value parse back out of the quote? */
export function valueParsesFromQuote(value: QuotedValue, quote: string, mode: CurrencyMode = "new_scenario"): boolean {
  switch (value.kind) {
    case "money":
      return moneyParses(quote, value, mode);
    case "instant": {
      if (!Number.isFinite(value.epochMs)) return false;
      return dateParses(quote, new Date(value.epochMs).toISOString().slice(0, 10));
    }
    case "local_date":
      return /^\d{4}-\d{2}-\d{2}$/.test(value.date) && dateParses(quote, value.date);
    case "local_datetime": {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value.dateTime);
      if (!m || !dateParses(quote, m[1])) return false;
      const t = timeInQuote(quote);
      return t === null || t === Number(m[2]) * 60 + Number(m[3]);
    }
    case "identifier":
      // Identifiers exactly: case and punctuation included (DA-A-6).
      return containsToken(quote, value.value);
    case "code":
      return containsToken(quote, value.code, "i");
    case "text": {
      const want = normalizeForMatch(value.text).toLowerCase();
      return want.length > 0 && normalizeForMatch(quote).toLowerCase().includes(want);
    }
    case "count": {
      const ints = integerTokens(quote);
      return ints.length === 1 && ints[0] === value.n;
    }
    case "minutes": {
      const m = /(\d+)\s*(h|hr|hrs|hours?|min|mins|minutes?)\b/gi;
      const found = [...quote.matchAll(m)].map((x) => (/^h/i.test(x[2]) ? Number(x[1]) * 60 : Number(x[1])));
      const total = found.reduce((a, b) => a + b, 0);
      return found.length > 0 && total === value.minutes;
    }
    case "bool":
      // A yes/no is not a value a quote states deterministically; the user confirms it.
      return false;
  }
}

// ---------------------------------------------------------------------------
// The status
// ---------------------------------------------------------------------------

/**
 * The quote status of one extracted fact (DA-A-6). `layer` is null when the document has no deterministic text
 * layer, which makes the fact `unverifiable` — never `verified`, whatever the model quoted. `currencyMode` is the
 * value's path (`legacy_r01` for retail keys, D145 O6 carve-out).
 */
export function verifyQuote(input: {
  layer: TextLayer;
  locator: QuoteLocator;
  value: QuotedValue;
  currencyMode?: CurrencyMode;
}): QuoteStatus {
  if (input.layer === null) return "unverifiable";
  const quote = quoteOf(input.locator, input.layer);
  if (quote === null) return "unverified";
  if (!quoteAtLocator(input.layer, input.locator, quote)) return "unverified";
  return valueParsesFromQuote(input.value, quote, input.currencyMode ?? "new_scenario") ? "verified" : "unverified";
}

/** Only a verified quote supports a rule's evidence dimension; `unverified` and `unverifiable` never do. */
export function countsTowardEvidence(status: QuoteStatus): boolean {
  return status === "verified";
}

/**
 * A pack's `evidenceSupports` over the facts it relies on: `pass` only when every cited quote is verified; any
 * `unverified` or `unverifiable` quote leaves it `unknown` (never `pass`, and never `fail` — a weak citation is not
 * evidence against the claim). No cited quote at all is `unknown` too.
 */
export function evidenceSupportsFrom(statuses: readonly QuoteStatus[]): "pass" | "unknown" {
  return statuses.length > 0 && statuses.every(countsTowardEvidence) ? "pass" : "unknown";
}
