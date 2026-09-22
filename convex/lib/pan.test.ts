/**
 * D142 + D148 C5 (contract rev 5 §2.6, SEC-SD-2 as amended): a digit run is masked to `•••• <last4>` only
 * when it is Luhn-valid AND carries a card-network issuer prefix at that brand's length (Visa 16/19 only)
 * AND its separators are single spaces or single hyphens. Everything else — IMEIs, 13-digit tickets and
 * EAN-13s, order refs — survives unchanged. Every keep-sample below is PROVEN Luhn-valid in the test, so
 * the Luhn gate alone would have destroyed it (rev 3's Luhn-only rule; rev 4's 13-digit Visa).
 */
import { describe, expect, it } from "vitest";
import { cardBrand, containsPan, detectPans, luhnValid, maskPans } from "./pan";

/** Appends the Luhn check digit to `body` (computed independently of the module under test). */
function withLuhn(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}
/** Independent Luhn check used to prove the samples, not the module's own `luhnValid`. */
function isLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
/** GS1 EAN-13 check: weights 1,3 alternating over the first 12 digits. */
function isEan13(d: string): boolean {
  if (!/^\d{13}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(d[12]);
}
const digitsOf = (s: string) => s.replace(/\D/g, "");

/** Standard network test numbers (published by the networks/processors for testing). */
const TEST_PANS: { brand: string; pan: string; groups: number[] }[] = [
  { brand: "visa", pan: "4111111111111111", groups: [4, 4, 4, 4] },
  { brand: "visa", pan: withLuhn("411111111111111100"), groups: [4, 4, 4, 4, 3] }, // 19-digit Visa
  { brand: "mastercard", pan: "5555555555554444", groups: [4, 4, 4, 4] },
  { brand: "mastercard", pan: "2223003122003222", groups: [4, 4, 4, 4] }, // 2-series
  { brand: "amex", pan: "378282246310005", groups: [4, 6, 5] },
  { brand: "amex", pan: "371449635398431", groups: [4, 6, 5] },
  { brand: "discover", pan: "6011111111111117", groups: [4, 4, 4, 4] },
  { brand: "jcb", pan: "3530111333300000", groups: [4, 4, 4, 4] },
  { brand: "diners", pan: "36227206271667", groups: [4, 6, 4] }, // 14 digits
  { brand: "unionpay", pan: "6200000000000005", groups: [4, 4, 4, 4] },
];
function grouped(pan: string, groups: number[], sep: string): string {
  const out: string[] = [];
  let at = 0;
  for (const g of groups) {
    out.push(pan.slice(at, at + g));
    at += g;
  }
  return out.join(sep);
}

describe("maskPans: standard test PANs are masked in every allowed separator form (D142)", () => {
  it("every sample is Luhn-valid (independent check)", () => {
    for (const { pan } of TEST_PANS) expect(isLuhn(pan), pan).toBe(true);
  });

  for (const { brand, pan, groups } of TEST_PANS) {
    for (const [label, sep] of [["plain", ""], ["single spaces", " "], ["single hyphens", "-"]] as const) {
      it(`${brand} ${pan.length}-digit, ${label}`, () => {
        const shown = grouped(pan, groups, sep);
        const text = `Paid with card ${shown} on 2026-09-01.`;
        const masked = maskPans(text);
        expect(masked).toBe(`Paid with card •••• ${pan.slice(-4)} on 2026-09-01.`);
        expect(digitsOf(masked)).not.toContain(pan);
        expect(containsPan(text)).toBe(true);
        expect(containsPan(masked)).toBe(false);
      });
    }
  }

  it("mixed single separators, several PANs in one text, and a PAN followed by an expiry are all masked", () => {
    expect(maskPans("4111-1111 1111-1111")).toBe("•••• 1111");
    expect(maskPans("A 5555 5555 5555 4444, B 3782 822463 10005.")).toBe("A •••• 4444, B •••• 0005.");
    // A trailing space-separated group must not hide the card inside a longer run.
    expect(maskPans("card 4111 1111 1111 1111 12/27 cvv")).toBe("card •••• 1111 12/27 cvv");
    expect(maskPans("card 4111111111111111 1227")).toBe("card •••• 1111 1227");
  });

  it("is idempotent and reports each match with its span, brand and last 4", () => {
    const text = "x 5555 5555 5555 4444 y";
    const once = maskPans(text);
    expect(maskPans(once)).toBe(once);
    expect(detectPans(text)).toEqual([{ start: 2, end: 21, brand: "mastercard", last4: "4444" }]);
  });
});

describe("keep-samples survive unchanged (D142 required tests, rev 5 C5)", () => {
  // Constructed here, proven here: an Amazon-style order ref with a Luhn-valid 17-digit body.
  const constructedOrderRef = (() => {
    const d = withLuhn("1129876543210987");
    return `${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10)}`;
  })();
  // An EAN-13 in the German range (40x, a Visa-looking prefix) that is BOTH EAN-13-valid and Luhn-valid.
  const constructedEan13 = (() => {
    for (let n = 0; n < 1_000_000; n++) {
      const body = `4006381${String(n).padStart(5, "0")}`;
      for (let c = 0; c <= 9; c++) {
        const cand = body + String(c);
        if (isEan13(cand) && isLuhn(cand)) return cand;
      }
    }
    throw new Error("no EAN-13 that is also Luhn-valid found");
  })();

  const KEEP: { what: string; text: string }[] = [
    { what: "IMEI (15, TAC 35)", text: "352099001761481" },
    { what: "13-digit Visa-prefix string (ticket-shaped)", text: "4221234567897" },
    { what: "13-digit Visa-prefix string", text: "4006381333932" },
    { what: "Amazon-style order ref (lead sample)", text: "112-3456789-1234562" },
    { what: "Amazon-style order ref (constructed)", text: constructedOrderRef },
    { what: "EAN-13, German 400 range (constructed)", text: constructedEan13 },
  ];

  it("each keep-sample is Luhn-valid, so the brand/length/separator gates are what keep it", () => {
    for (const { what, text } of KEEP) expect(isLuhn(digitsOf(text)), what).toBe(true);
    expect(isEan13(constructedEan13)).toBe(true);
    expect(constructedEan13.startsWith("4")).toBe(true);
    expect(/^112-\d{7}-\d{7}$/.test(constructedOrderRef)).toBe(true);
  });

  for (const { what, text } of KEEP) {
    it(`${what}: ${text} survives in running text`, () => {
      const t = `Ref ${text} (see receipt).`;
      expect(maskPans(t)).toBe(t);
      expect(detectPans(t)).toEqual([]);
      expect(containsPan(t)).toBe(false);
    });
  }

  it("Luhn-valid runs with no issuer prefix, a wrong brand length, or an invalid Luhn are kept", () => {
    expect(isLuhn("1234567812345670")).toBe(true);
    expect(maskPans("1234567812345670")).toBe("1234567812345670"); // no network prefix
    const visa17 = withLuhn("4111111111111111"); // Visa prefix, 17 digits
    expect(maskPans(visa17)).toBe(visa17);
    const amex16 = withLuhn("378282246310005"); // Amex prefix, 16 digits
    expect(maskPans(amex16)).toBe(amex16);
    expect(maskPans("4111111111111112")).toBe("4111111111111112"); // fails Luhn
  });

  it("rule (c): other separators are not a card number (double spaces, dots, slashes, newlines)", () => {
    for (const t of ["4111  1111  1111  1111", "4111.1111.1111.1111", "4111/1111/1111/1111", "4111\n1111\n1111\n1111"]) {
      expect(maskPans(t)).toBe(t);
    }
  });

  it("a card number is never split out of a single longer unseparated digit run", () => {
    const tracking = `9${"4111111111111111"}00`; // 19 digits, not a card prefix; contains a PAN as a substring
    expect(maskPans(tracking)).toBe(tracking);
  });
});

describe("cardBrand / luhnValid", () => {
  it("maps prefixes to brands only at each brand's valid lengths (Visa 16/19 only)", () => {
    expect(cardBrand("4111111111111111")).toBe("visa");
    expect(cardBrand("4221234567897")).toBeNull(); // 13-digit Visa dropped (C5)
    expect(cardBrand(withLuhn("411111111111111100"))).toBe("visa");
    expect(cardBrand("2720990000000007")).toBe("mastercard");
    expect(cardBrand("2721000000000000")).toBeNull();
    expect(cardBrand("3528000000000000")).toBe("jcb");
    expect(cardBrand("3527000000000000")).toBeNull();
    expect(cardBrand("30500000000000")).toBe("diners");
    expect(cardBrand("30600000000000")).toBeNull();
    expect(cardBrand("6440000000000000")).toBe("discover");
    expect(cardBrand("340000000000000")).toBe("amex");
  });

  it("luhnValid agrees with the independent check on 1,000 generated bodies", () => {
    for (let i = 0; i < 1000; i++) {
      const body = String(1_000_000_000_000 + i * 7_919);
      const good = withLuhn(body);
      expect(luhnValid(good)).toBe(true);
      const bad = good.slice(0, -1) + String((Number(good.slice(-1)) + 1) % 10);
      expect(luhnValid(bad)).toBe(isLuhn(bad));
    }
    expect(luhnValid("")).toBe(false);
    expect(luhnValid("12a4")).toBe(false);
  });
});
