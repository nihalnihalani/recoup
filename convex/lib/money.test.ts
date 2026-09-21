import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import {
  assertCents,
  assertCurrency,
  assertPositiveCents,
  assertQty,
  assertTimestamp,
  assertWindowDays,
  toCents,
} from "./money";

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

describe("assertTimestamp (D43/R6)", () => {
  test("a recent past timestamp is ok", () => {
    expect(assertTimestamp(Date.now() - 1000)).toBeGreaterThan(0);
  });

  test("0 is ok", () => {
    expect(assertTimestamp(0)).toBe(0);
  });

  test("negative throws", () => {
    expect(() => assertTimestamp(-1)).toThrow(ConvexError);
  });

  test("more than a day in the future throws", () => {
    expect(() => assertTimestamp(Date.now() + 2 * 86_400_000)).toThrow(ConvexError);
  });

  test("NaN throws", () => {
    expect(() => assertTimestamp(NaN)).toThrow(ConvexError);
  });
});

describe("assertWindowDays (D43/R6)", () => {
  test("0 is ok", () => {
    expect(assertWindowDays(0)).toBe(0);
  });

  test("3650 is ok", () => {
    expect(assertWindowDays(3650)).toBe(3650);
  });

  test("3651 throws", () => {
    expect(() => assertWindowDays(3651)).toThrow(ConvexError);
  });

  test("negative throws", () => {
    expect(() => assertWindowDays(-1)).toThrow(ConvexError);
  });

  test("non-integer throws", () => {
    expect(() => assertWindowDays(1.5)).toThrow(ConvexError);
  });
});
