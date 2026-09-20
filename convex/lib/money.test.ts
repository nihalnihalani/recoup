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
