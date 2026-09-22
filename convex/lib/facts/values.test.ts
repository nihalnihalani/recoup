import { describe, it, expect } from "vitest";
import { formatFactValue, sameFactValue, validateFactValue, validateIdentifier } from "./values";
import { getFactSpec, type FactSpec, type FactValue } from "./catalog";

const spec = (key: string): FactSpec => {
  const s = getFactSpec(key);
  if (!s) throw new Error(key);
  return s;
};
const check = (key: string, value: FactValue, opts: { userSource?: boolean } = {}) =>
  validateFactValue(spec(key), value, { userSource: opts.userSource ?? false });

describe("sameFactValue / formatFactValue", () => {
  it("compares by value, not identity, and treats an absent optional like undefined", () => {
    expect(sameFactValue({ kind: "money", amountMinor: 1, currency: "USD" }, { kind: "money", currency: "USD", amountMinor: 1 })).toBe(true);
    expect(sameFactValue({ kind: "money", amountMinor: 1, currency: "USD" }, { kind: "money", amountMinor: 1, currency: "EUR" })).toBe(false);
    expect(sameFactValue({ kind: "local_date", date: "2026-09-01" }, { kind: "local_date", date: "2026-09-01", timeZone: undefined })).toBe(true);
    expect(sameFactValue({ kind: "count", n: 1 }, { kind: "minutes", minutes: 1 })).toBe(false);
    expect(sameFactValue({ kind: "user_unknown" }, { kind: "user_unknown" })).toBe(true);
  });

  it("formats every kind for an explanation line", () => {
    expect(formatFactValue({ kind: "money", amountMinor: 12050, currency: "USD" })).toBe("USD 120.50");
    expect(formatFactValue({ kind: "count", n: 3 })).toBe("3");
    expect(formatFactValue({ kind: "bool", value: false })).toBe("no");
    expect(formatFactValue({ kind: "user_unknown" })).toBe("I don't know");
    expect(formatFactValue({ kind: "instant", epochMs: Date.UTC(2026, 8, 10, 19) })).toBe("2026-09-10T19:00:00.000Z");
    expect(formatFactValue({ kind: "identifier", scheme: "order_ref", value: "NW-1" })).toBe("NW-1");
  });
});

describe("validateFactValue — kinds and domains", () => {
  it("refuses a value of the wrong kind for the key", () => {
    expect(() => check("retail.quantity", { kind: "money", amountMinor: 1, currency: "USD" })).toThrow(/count/);
    expect(() => check("retail.unit_price", { kind: "count", n: 1 })).toThrow(/money/);
  });

  it("money: non-negative safe integers in an admitted currency; the user cap applies to user-entered amounts", () => {
    expect(check("retail.unit_price", { kind: "money", amountMinor: 12000, currency: "GBP" })).toEqual({
      kind: "money", amountMinor: 12000, currency: "GBP",
    });
    expect(() => check("retail.unit_price", { kind: "money", amountMinor: -1, currency: "USD" })).toThrow();
    expect(() => check("retail.unit_price", { kind: "money", amountMinor: 1.5, currency: "USD" })).toThrow();
    expect(() => check("retail.unit_price", { kind: "money", amountMinor: 1, currency: "usd" })).toThrow();
    expect(() => check("retail.unit_price", { kind: "money", amountMinor: 1, currency: "JPY" })).toThrow(/currency/); // not 2-decimal
    expect(() => check("retail.unit_price", { kind: "money", amountMinor: 1e12, currency: "USD" }, { userSource: true })).toThrow(/larger/);
    expect(check("retail.unit_price", { kind: "money", amountMinor: 1e12, currency: "USD" })).toMatchObject({ amountMinor: 1e12 });
  });

  it("count: whole numbers inside the key's bounds", () => {
    expect(check("retail.quantity", { kind: "count", n: 2 })).toEqual({ kind: "count", n: 2 });
    expect(() => check("retail.quantity", { kind: "count", n: 0 })).toThrow(/at least 1/);
    expect(() => check("retail.quantity", { kind: "count", n: 100_001 })).toThrow(/at most/);
    expect(() => check("retail.quantity", { kind: "count", n: 1.5 })).toThrow();
    expect(check("retail.window_days", { kind: "count", n: 0 })).toEqual({ kind: "count", n: 0 });
  });

  it("instant: a finite, non-negative whole number of ms before year 2200", () => {
    expect(check("retail.purchase_date", { kind: "instant", epochMs: Date.UTC(2026, 8, 10) }).kind).toBe("instant");
    expect(() => check("retail.purchase_date", { kind: "instant", epochMs: -1 })).toThrow();
    expect(() => check("retail.purchase_date", { kind: "instant", epochMs: Number.NaN })).toThrow();
    expect(() => check("retail.purchase_date", { kind: "instant", epochMs: Date.UTC(2200, 0, 1) })).toThrow();
  });

  it("code: only the key's closed list; currency codes must be real ISO 4217", () => {
    expect(check("retail.policy_temporal", { kind: "code", code: "A-T2" })).toEqual({ kind: "code", code: "A-T2" });
    expect(() => check("retail.policy_temporal", { kind: "code", code: "A-T3" })).toThrow(/not one of/);
    expect(check("retail.currency", { kind: "code", code: "EUR" })).toEqual({ kind: "code", code: "EUR" });
    expect(() => check("retail.currency", { kind: "code", code: "ZZZ" })).toThrow(/currency/);
    expect(() => check("retail.currency", { kind: "code", code: "eur" })).toThrow(/currency/);
  });

  it("bool passes through", () => {
    expect(check("retail.policy_confirmed", { kind: "bool", value: true })).toEqual({ kind: "bool", value: true });
  });

  it("user_unknown is never validated here (writers decide who may say it)", () => {
    expect(() => check("retail.quantity", { kind: "user_unknown" })).toThrow(/I don't know/);
  });
});

describe("validateFactValue — text (D142: masked, never refused)", () => {
  it("masks a card number inside free text and keeps the rest", () => {
    expect(check("retail.item_name", { kind: "text", text: "Gift card 4111 1111 1111 1111 refill" })).toEqual({
      kind: "text", text: "Gift card •••• 1111 refill",
    });
  });

  it("keeps Luhn-valid non-card numbers in free text (C5 keep-samples)", () => {
    const text = "IMEI 352099001761481, ticket 4221234567897, order 112-3456789-1234562, EAN 4006381333932";
    expect(check("retail.item_name", { kind: "text", text })).toEqual({ kind: "text", text });
  });

  it("strips control characters except line breaks, trims, and bounds the length after masking", () => {
    expect(check("retail.item_name", { kind: "text", text: "  a\u0000b\nc  " })).toEqual({ kind: "text", text: "ab\nc" });
    expect(() => check("retail.item_name", { kind: "text", text: "   " })).toThrow(/empty/);
    expect(() => check("retail.item_name", { kind: "text", text: "x".repeat(501) })).toThrow(/500/);
  });
});

describe("validateFactValue — identifiers (D142: own format, never the free-text masker)", () => {
  it("keeps a Luhn-valid order ref unchanged", () => {
    expect(check("retail.order_ref", { kind: "identifier", scheme: "order_ref", value: "112-3456789-1234562" })).toEqual({
      kind: "identifier", scheme: "order_ref", value: "112-3456789-1234562",
    });
  });

  it("refuses a scheme other than the key's", () => {
    expect(() => check("retail.order_ref", { kind: "identifier", scheme: "imei", value: "352099001761481" })).toThrow(/order_ref/);
  });

  it("validates each scheme's own format", () => {
    expect(validateIdentifier("imei", "352099001761481")).toBe("352099001761481");
    expect(() => validateIdentifier("imei", "352099001761482")).toThrow(/IMEI/); // Luhn fails
    expect(validateIdentifier("eticket", "4221234567897")).toBe("4221234567897");
    expect(validateIdentifier("eticket", "016-7712345678")).toBe("0167712345678");
    expect(() => validateIdentifier("eticket", "12345")).toThrow();
    expect(validateIdentifier("pnr", "abc12d")).toBe("ABC12D");
    expect(() => validateIdentifier("pnr", "ABC-12")).toThrow();
    expect(validateIdentifier("flight_number", "dl 1234")).toBe("DL1234");
    expect(() => validateIdentifier("flight_number", "D1")).toThrow();
    expect(validateIdentifier("bag_tag", "DL123456")).toBe("DL123456");
    expect(validateIdentifier("bag_tag", "0006123456")).toBe("0006123456");
    expect(validateIdentifier("tracking", "1Z999AA10123456784")).toBe("1Z999AA10123456784");
    expect(() => validateIdentifier("tracking", "1Z 999")).toThrow();
    expect(validateIdentifier("serial", "C02XK1ABJG5H")).toBe("C02XK1ABJG5H");
    expect(validateIdentifier("order_ref", "  NW-48377 ")).toBe("NW-48377");
    expect(() => validateIdentifier("order_ref", "a\nb")).toThrow();
    expect(() => validateIdentifier("order_ref", "x".repeat(101))).toThrow();
    expect(() => validateIdentifier("order_ref", "")).toThrow();
  });
});
