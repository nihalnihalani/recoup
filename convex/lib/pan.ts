/**
 * Card-number (PAN) masking for FREE TEXT (D142, D148 C5; contract rev 5 §2.6; SEC-SD-2 as amended).
 *
 * A run of ASCII digits is a card number — and is replaced by `•••• <last4>` — only when ALL hold:
 *   (a) it is Luhn-valid;
 *   (b) it carries a card-network issuer prefix at that brand's length:
 *       Visa 4 → 16 or 19 (never 13: Frontier/Spirit e-tickets and EAN-13 codes 400–440 collide, C5);
 *       Mastercard 51–55 and 2221–2720 → 16; Amex 34/37 → 15;
 *       Discover 6011, 644–649, 65 → 16–19; JCB 3528–3589 → 16–19;
 *       Diners 300–305, 36, 38–39 → 14–19; UnionPay 62 → 16–19;
 *   (c) its separators are single spaces or single hyphens only.
 * Luhn alone is not enough: every IMEI is Luhn-valid, and ~1 in 10 of any digit string passes by chance.
 *
 * Callers run `maskPans` before persisting, hashing, logging, exporting or sending text to a model.
 * It never refuses input. TYPED IDENTIFIERS (IMEI, ticket number, order ref, tracking number — `factValue`
 * kind `identifier`) are validated by their own scheme's format and must NEVER be passed through this
 * free-text masker (D142).
 *
 * Grouped runs are examined at group boundaries only, so a card number followed by a separated expiry
 * ("4111 1111 1111 1111 12/27") is still found, while a card-shaped substring inside one longer
 * unseparated digit run is not (it is some other identifier).
 */

export type CardBrand = "visa" | "mastercard" | "amex" | "discover" | "jcb" | "diners" | "unionpay";
export type PanMatch = { start: number; end: number; brand: CardBrand; last4: string };

const MASK = "•••• ";
/** Shortest and longest length any brand in (b) allows. */
const MIN_LEN = 14;
const MAX_LEN = 19;

/** Luhn (mod 10) over a string of ASCII digits. False for an empty or non-digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

const between = (s: string, lo: number, hi: number) => {
  const n = Number(s);
  return n >= lo && n <= hi;
};

/** The network whose issuer prefix AND length rule (b) matches `digits`, or null. Does not check Luhn. */
export function cardBrand(digits: string): CardBrand | null {
  if (!/^\d+$/.test(digits)) return null;
  const len = digits.length;
  const p2 = digits.slice(0, 2);
  const p3 = digits.slice(0, 3);
  const p4 = digits.slice(0, 4);
  const len16to19 = len >= 16 && len <= 19;
  if (digits[0] === "4") return len === 16 || len === 19 ? "visa" : null;
  if ((between(p2, 51, 55) || between(p4, 2221, 2720)) && len === 16) return "mastercard";
  if ((p2 === "34" || p2 === "37") && len === 15) return "amex";
  if ((p4 === "6011" || between(p3, 644, 649) || p2 === "65") && len16to19) return "discover";
  if (between(p4, 3528, 3589) && len16to19) return "jcb";
  if ((between(p3, 300, 305) || p2 === "36" || p2 === "38" || p2 === "39") && len >= 14 && len <= 19) return "diners";
  if (p2 === "62" && len16to19) return "unionpay";
  return null;
}

/** A maximal run of digit groups joined by single spaces/hyphens (rule c). */
const RUN = /\d+(?:[ -]\d+)*/g;

/** Every card number in `text`, left to right, non-overlapping, preferring the longest match at each group. */
export function detectPans(text: string): PanMatch[] {
  const out: PanMatch[] = [];
  for (const m of text.matchAll(RUN)) {
    const base = m.index ?? 0;
    const groups: { start: number; end: number; digits: string }[] = [];
    for (const g of m[0].matchAll(/\d+/g)) {
      const start = base + (g.index ?? 0);
      groups.push({ start, end: start + g[0].length, digits: g[0] });
    }
    let i = 0;
    while (i < groups.length) {
      let matched = false;
      let digits = "";
      const candidates: { j: number; digits: string }[] = [];
      for (let j = i; j < groups.length; j++) {
        digits += groups[j].digits;
        if (digits.length > MAX_LEN) break;
        candidates.push({ j, digits });
      }
      for (let k = candidates.length - 1; k >= 0; k--) {
        const c = candidates[k];
        if (c.digits.length < MIN_LEN) break;
        const brand = cardBrand(c.digits);
        if (brand && luhnValid(c.digits)) {
          out.push({ start: groups[i].start, end: groups[c.j].end, brand, last4: c.digits.slice(-4) });
          i = c.j + 1;
          matched = true;
          break;
        }
      }
      if (!matched) i += 1;
    }
  }
  return out;
}

/** True when `text` holds at least one card number (DA-A-8 text-layer pre-scan forces `store_only`). */
export function containsPan(text: string): boolean {
  return detectPans(text).length > 0;
}

/** Replaces every card number in `text` with `•••• <last4>`. Never throws, never refuses; idempotent. */
export function maskPans(text: string): string {
  const matches = detectPans(text);
  if (matches.length === 0) return text;
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + MASK + m.last4;
    at = m.end;
  }
  return out + text.slice(at);
}
