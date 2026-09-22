import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  assertCents,
  assertCurrency,
  assertPositiveCents,
  assertQty,
  toCents, assertTimestamp, assertWindowDays, assertNonEmpty } from "./money";

describe("toCents", () => {
  test("toCents(79.99)=7999", () => {
    expect(toCents(79.99)).toBe(7999);
  });

  test("toCents(80)=8000", () => {
    expect(toCents(80)).toBe(8000);
  });

  test("toCents(0.1+0.2)=30", () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
  });

  test("toCents(Infinity) throws", () => {
    expect(() => toCents(Infinity)).toThrow(ConvexError);
  });

  test("toCents(NaN) throws", () => {
    expect(() => toCents(NaN)).toThrow(ConvexError);
  });
});

describe("assertCents", () => {
  test("assertCents(-1) throws", () => {
    expect(() => assertCents(-1)).toThrow(ConvexError);
  });

  test("assertCents(1.5) throws", () => {
    expect(() => assertCents(1.5)).toThrow(ConvexError);
  });

  test("assertCents(0) ok", () => {
    expect(assertCents(0)).toBe(0);
  });
});

describe("assertPositiveCents", () => {
  test("assertPositiveCents(0) throws", () => {
    expect(() => assertPositiveCents(0)).toThrow(ConvexError);
  });

  test("assertPositiveCents(1) ok", () => {
    expect(assertPositiveCents(1)).toBe(1);
  });

  test("assertPositiveCents(1.5) throws", () => {
    expect(() => assertPositiveCents(1.5)).toThrow(ConvexError);
  });
});

describe("assertQty", () => {
  test("assertQty(0) throws", () => {
    expect(() => assertQty(0)).toThrow(ConvexError);
  });

  test("assertQty(1) ok", () => {
    expect(assertQty(1)).toBe(1);
  });

  test("assertQty(1.5) throws", () => {
    expect(() => assertQty(1.5)).toThrow(ConvexError);
  });
});

describe("assertCurrency", () => {
  test('assertCurrency("USD") ok', () => {
    expect(assertCurrency("USD")).toBe("USD");
  });

  test('assertCurrency("usd") throws', () => {
    expect(() => assertCurrency("usd")).toThrow(ConvexError);
  });

  test('assertCurrency("US$") throws', () => {
    expect(() => assertCurrency("US$")).toThrow(ConvexError);
  });

  test('assertCurrency("XXX") ok (valid ISO code)', () => {
    expect(assertCurrency("XXX")).toBe("XXX");
  });
});

describe("non-money boundaries (D43)", () => {
  const now = Date.UTC(2026, 8, 1);
  test("assertTimestamp accepts past and up to a day ahead", () => {
    expect(assertTimestamp(0, "t", now)).toBe(0);
    expect(assertTimestamp(now + 86_400_000, "t", now)).toBe(now + 86_400_000);
  });
  test("assertTimestamp rejects negative, non-finite and far-future", () => {
    expect(() => assertTimestamp(-1, "t", now)).toThrow(ConvexError);
    expect(() => assertTimestamp(NaN, "t", now)).toThrow(ConvexError);
    expect(() => assertTimestamp(Infinity, "t", now)).toThrow(ConvexError);
    expect(() => assertTimestamp(now + 86_400_001, "t", now)).toThrow(ConvexError);
  });
  test("assertWindowDays accepts 0..3650 whole days only", () => {
    expect(assertWindowDays(0)).toBe(0);
    expect(assertWindowDays(3650)).toBe(3650);
    for (const bad of [-1, 3651, 1.5, NaN]) expect(() => assertWindowDays(bad)).toThrow(ConvexError);
  });
  test("assertNonEmpty rejects blank strings", () => {
    expect(assertNonEmpty("a.example", "d")).toBe("a.example");
    expect(() => assertNonEmpty("  ", "d")).toThrow(ConvexError);
  });
});

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §3.1): Money, the R01 two-decimal carve-out (DA-A-13),
// the typed-amount cap (D145, SEC-MF-4) and the decimal grammar (DA-A-26).
// ---------------------------------------------------------------------------
import {
  assertMoney,
  assertSameCurrency,
  assertUserAmount,
  assertUserMoney,
  claimCurrency,
  currencyExponent,
  formatMinor,
  isTwoDecimalCurrency,
  parseDecimalToMinor,
} from "./money";
import { MAX_USER_AMOUNT_MINOR } from "../limits";

/** Deterministic PRNG (mulberry32) so the property tests are reproducible without a new dependency. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A random integer in [0, max], built from two draws so it spans the whole safe range. */
function randInt(r: () => number, max: number): number {
  const hi = Math.floor(r() * Math.floor(max / 2 ** 20 + 1));
  const lo = Math.floor(r() * 2 ** 20);
  return Math.min(max, hi * 2 ** 20 + lo);
}
/** Formats minor units as a plain or comma-grouped major-unit decimal, written by string ops only (no floats). */
function asDecimal(minor: number, grouped: boolean, fracDigits: 0 | 1 | 2): string {
  const s = String(minor).padStart(3, "0");
  let major = s.slice(0, -2).replace(/^0+(?=\d)/, "");
  const frac = s.slice(-2);
  if (grouped) major = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (fracDigits === 0) return major;
  if (fracDigits === 1) return `${major}.${frac[0]}`;
  return `${major}.${frac}`;
}
const ok = (amountMinor: number) => ({ ok: true, amountMinor });

describe("parseDecimalToMinor (DA-A-26)", () => {
  test("accepts the two grammars: plain and comma-grouped, up to E fraction digits", () => {
    expect(parseDecimalToMinor("12.50", "USD")).toEqual(ok(1250));
    expect(parseDecimalToMinor("12.5", "USD")).toEqual(ok(1250));
    expect(parseDecimalToMinor("12", "USD")).toEqual(ok(1200));
    expect(parseDecimalToMinor("0.99", "USD")).toEqual(ok(99));
    expect(parseDecimalToMinor("1,234.50", "USD")).toEqual(ok(123450));
    expect(parseDecimalToMinor("1234.50", "USD")).toEqual(ok(123450));
    expect(parseDecimalToMinor("1,234,567", "USD")).toEqual(ok(123456700));
    expect(parseDecimalToMinor("  12.50  ", "USD")).toEqual(ok(1250)); // ASCII spaces trimmed
  });

  test.each([
    ["12,34", "comma decimal / short group"],
    ["1.234,50", "European grouping"],
    ["1,23,456", "Indian grouping"],
    ["1,2345.00", "long group"],
    ["0,123", "leading-zero group"],
    ["12.", "trailing dot"],
    [".5", "no integer part"],
    ["\uff11\uff12.\uff15\uff10", "full-width digits"],
    ["12\u00a0345.00", "NBSP inside the number"],
    ["1\u202f234.50", "narrow NBSP grouping"],
    ["1e3", "exponent"],
    ["1.5e2", "exponent with fraction"],
    ["12.345", "more fraction digits than E"],
    ["", "empty"],
    ["   ", "blank"],
    ["\t12.50", "tab is not an ASCII space"],
    ["$12.50", "currency symbol"],
    ["USD 12.50", "currency code"],
    ["+12.50", "explicit plus"],
    ["12.50.1", "two dots"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["0x10", "hex"],
    ["9007199254740992.00", "beyond the safe-integer range"],
  ])("rejects %j (%s) — never a number", (s) => {
    const r = parseDecimalToMinor(s, "USD");
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ ok: false, signMarked: false });
  });

  test.each([["-12.50"], ["\u221212.50"], ["(12.50)"], ["12.50 CR"], ["12.50CR"], ["12.50 cr"], ["12.50 DR"], ["12.50-"], [" (1,234.50) "]])(
    "sign marker %j → { signMarked: true } for needs_review, never positive",
    (s) => {
      expect(parseDecimalToMinor(s, "USD")).toEqual({ ok: false, signMarked: true });
    },
  );

  test("a currency outside the new-scenario table is unsupported; the R01 carve-out admits 2-decimal ISO codes only", () => {
    expect(parseDecimalToMinor("12.50", "EUR")).toEqual({ ok: false, signMarked: false, reason: "unsupported_currency" });
    expect(parseDecimalToMinor("12.50", "GBP", "legacy_r01")).toEqual(ok(1250));
    expect(parseDecimalToMinor("1200", "JPY", "legacy_r01")).toEqual({ ok: false, signMarked: false, reason: "unsupported_currency" });
  });

  test("property: every amount round-trips in all three shapes and both groupings (500 seeds)", () => {
    const r = rng(0xc0ffee);
    for (let i = 0; i < 500; i++) {
      const n = randInt(r, 10 ** 13);
      expect(parseDecimalToMinor(asDecimal(n, false, 2), "USD")).toEqual(ok(n));
      expect(parseDecimalToMinor(asDecimal(n, true, 2), "USD")).toEqual(ok(n));
      const tenths = n - (n % 10);
      expect(parseDecimalToMinor(asDecimal(tenths, true, 1), "USD")).toEqual(ok(tenths));
      const whole = n - (n % 100);
      expect(parseDecimalToMinor(asDecimal(whole, true, 0), "USD")).toEqual(ok(whole));
    }
  });

  test("property: every malformation of a valid amount is rejected, every sign marker flagged (500 seeds)", () => {
    const r = rng(0xbadf00d);
    for (let i = 0; i < 500; i++) {
      const n = randInt(r, 10 ** 12);
      const s = asDecimal(n, true, 2);
      const malformed = [
        `${s}0`, // a third fraction digit
        s.replace(".", ","), // decimal comma
        `${s.split(".")[0]}.`, // trailing dot
        `.${s.split(".")[1]}`, // no integer part
        `${s}e1`, // exponent tail
        `${s.slice(0, 1)}\u00a0${s.slice(1)}`, // NBSP inside
        s.replace(/[0-9]/g, (d) => String.fromCharCode(0xff10 + Number(d))), // full-width
      ];
      for (const m of malformed) expect(parseDecimalToMinor(m, "USD").ok, m).toBe(false);
      for (const signed of [`-${s}`, `(${s})`, `${s} CR`]) {
        expect(parseDecimalToMinor(signed, "USD"), signed).toEqual({ ok: false, signMarked: true });
      }
    }
  });
});

describe("isTwoDecimalCurrency (R01 carve-out, DA-A-13 / O6)", () => {
  test("two-decimal ISO codes pass; zero/three-decimal, unknown and malformed codes do not", () => {
    for (const c of ["USD", "GBP", "EUR", "CAD", "AUD"]) expect(isTwoDecimalCurrency(c), c).toBe(true);
    for (const c of ["JPY", "KRW", "KWD", "BHD"]) expect(isTwoDecimalCurrency(c), c).toBe(false);
    // Intl reports 2 digits for ANY well-formed unknown code; those are not currencies.
    for (const c of ["ZZZ", "XXX", "usd", "US$", "", "USDX"]) expect(isTwoDecimalCurrency(c), c).toBe(false);
  });

  test("currencyExponent: new scenarios are USD-only (O6); the R01 path keeps every 2-decimal ISO code", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("GBP")).toBeNull();
    expect(currencyExponent("GBP", "legacy_r01")).toBe(2);
    expect(currencyExponent("EUR", "legacy_r01")).toBe(2);
    expect(currencyExponent("JPY", "legacy_r01")).toBeNull();
  });
});

describe("assertMoney / assertSameCurrency", () => {
  test("accepts integer minor units in a supported currency, returns the value", () => {
    expect(assertMoney({ amountMinor: 4000, currency: "USD" })).toEqual({ amountMinor: 4000, currency: "USD" });
    expect(assertMoney({ amountMinor: 0, currency: "USD" })).toEqual({ amountMinor: 0, currency: "USD" });
  });

  test("refuses negative, fractional, non-finite and unsafe amounts, and bad currencies", () => {
    for (const amountMinor of [-1, 1.5, NaN, Infinity, 2 ** 53]) {
      expect(() => assertMoney({ amountMinor, currency: "USD" }), String(amountMinor)).toThrow(ConvexError);
    }
    for (const currency of ["usd", "US$", "ZZZ", ""]) {
      expect(() => assertMoney({ amountMinor: 1, currency }), currency).toThrow(ConvexError);
    }
  });

  test("DA-A-13: a GBP amount is refused on a new scenario but accepted on the R01 legacy path", () => {
    expect(() => assertMoney({ amountMinor: 12_000, currency: "GBP" })).toThrow(/unsupported currency/);
    expect(assertMoney({ amountMinor: 12_000, currency: "GBP" }, "legacy_r01")).toEqual({ amountMinor: 12_000, currency: "GBP" });
    expect(() => assertMoney({ amountMinor: 1_200, currency: "JPY" }, "legacy_r01")).toThrow(/unsupported currency/);
  });

  test("DA-A-13: a GBP purchase against a USD observation is refused (never mixed, D16)", () => {
    const gbp = { amountMinor: 12_000, currency: "GBP" };
    expect(assertSameCurrency(gbp, { amountMinor: 9_500, currency: "GBP" })).toBe("GBP");
    expect(() => assertSameCurrency(gbp, { amountMinor: 9_500, currency: "USD" })).toThrow(/currency mismatch/);
  });
});

describe("assertUserAmount (D145, SEC-MF-4)", () => {
  test("MAX_USER_AMOUNT_MINOR is USD 1,000,000", () => {
    expect(MAX_USER_AMOUNT_MINOR).toBe(100_000_000);
  });

  test("0..MAX accepted; above the cap, 10^12, negative, fractional and non-finite refused", () => {
    expect(assertUserAmount(0)).toBe(0);
    expect(assertUserAmount(MAX_USER_AMOUNT_MINOR)).toBe(MAX_USER_AMOUNT_MINOR);
    for (const n of [MAX_USER_AMOUNT_MINOR + 1, 10 ** 12, -1, 1.5, NaN, Infinity]) {
      expect(() => assertUserAmount(n), String(n)).toThrow(ConvexError);
    }
  });

  test("assertUserMoney = assertMoney (currency admitted by the mode) + the typed-amount cap", () => {
    expect(assertUserMoney({ amountMinor: 4_000, currency: "USD" })).toEqual({ amountMinor: 4_000, currency: "USD" });
    expect(() => assertUserMoney({ amountMinor: 10 ** 12, currency: "USD" })).toThrow(/larger than Recoup accepts/);
    expect(() => assertUserMoney({ amountMinor: 4_000, currency: "GBP" })).toThrow(/unsupported currency/);
    expect(assertUserMoney({ amountMinor: 4_000, currency: "GBP" }, "legacy_r01").currency).toBe("GBP");
  });
});

describe("claimCurrency / formatMinor", () => {
  test("the claim's own currency wins; a legacy claim falls back to its purchase; unknown is null, never USD", () => {
    expect(claimCurrency({ currency: "EUR" }, { currency: "USD" })).toBe("EUR");
    expect(claimCurrency({}, { currency: "GBP" })).toBe("GBP");
    expect(claimCurrency({}, null)).toBeNull();
    expect(claimCurrency({}, undefined)).toBeNull();
  });

  test("formats minor units by string arithmetic with the ISO code", () => {
    expect(formatMinor(123_450, "USD")).toBe("USD 1,234.50");
    expect(formatMinor(5, "USD")).toBe("USD 0.05");
    expect(formatMinor(0, "GBP")).toBe("GBP 0.00");
    expect(formatMinor(100_000_000, "USD")).toBe("USD 1,000,000.00");
    expect(() => formatMinor(-1, "USD")).toThrow(ConvexError);
  });
});
