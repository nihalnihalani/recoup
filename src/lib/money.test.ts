import { describe, expect, it } from "vitest";
import { currencyExponent as serverExponent } from "../../convex/lib/money";
import { currencyExponent, fmt, formatMinor, hundredthsToInput, parseHundredths } from "./money";

// Intl output is locale-dependent (the test runner's default locale); compare with the same formatter on a
// hand-written decimal string, so each expectation pins the DIGITS, not the locale's symbol placement.
const intl = (decimal: string, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(
    decimal as Intl.StringNumericLiteral,
  );

describe("currencyExponent (display)", () => {
  it("follows ISO 4217: USD 2, JPY 0, KWD 3", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("GBP")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
  });

  it("knows no exponent for a code that is not a currency", () => {
    expect(currencyExponent("ZZZ")).toBeNull();
    expect(currencyExponent("usd")).toBeNull();
    expect(currencyExponent("")).toBeNull();
  });

  it("agrees with the server wherever the server admits the currency (two-decimal, DA-A-13)", () => {
    for (const code of ["USD", "GBP", "EUR", "CAD", "AUD", "JPY", "KWD", "ZZZ"]) {
      const server = serverExponent(code, "legacy_r01");
      if (server !== null) expect(currencyExponent(code), code).toBe(server);
    }
  });
});

describe("formatMinor (ISO minor units)", () => {
  it("places the decimal point by the currency's exponent", () => {
    expect(formatMinor(1234, "USD")).toBe(intl("12.34", "USD"));
    expect(formatMinor(1200, "JPY")).toBe(intl("1200", "JPY"));
    expect(formatMinor(12345, "KWD")).toBe(intl("12.345", "KWD"));
    expect(formatMinor(5, "USD")).toBe(intl("0.05", "USD"));
  });

  it("never divides by a guessed 100 when the exponent is unknown", () => {
    expect(formatMinor(1234, "ZZZ")).toBe("1234 ZZZ (minor units)");
  });

  it("formats large amounts exactly, with no floating-point drift", () => {
    expect(formatMinor(900_719_925_474_099, "USD")).toBe(intl("9007199254740.99", "USD"));
  });

  it("does not throw on a non-integer", () => {
    expect(formatMinor(Number.NaN, "USD")).toBe("— USD");
    expect(formatMinor(1.5, "USD")).toBe("— USD");
  });
});

describe("fmt (legacy hundredths)", () => {
  it("is the ISO display for two-decimal currencies", () => {
    expect(fmt(1234, "USD")).toBe(formatMinor(1234, "USD"));
    expect(fmt(900, "USD")).toBe(intl("9.00", "USD"));
    expect(fmt(-250, "USD")).toBe(intl("-2.50", "USD"));
  });

  it("shows a yen price stored as hundredths in whole yen (¥1,200 is stored as 120000)", () => {
    expect(fmt(120_000, "JPY")).toBe(formatMinor(1200, "JPY"));
  });

  it("shows three digits for KWD (12.34 stored as 1234)", () => {
    expect(fmt(1234, "KWD")).toBe(formatMinor(12_340, "KWD"));
  });

  it("falls back to the code when Intl refuses it", () => {
    expect(fmt(1234, "not-a-code")).toBe("12.34 not-a-code");
  });
});

describe("parseHundredths", () => {
  it("reads plain and grouped decimals by string arithmetic", () => {
    expect(parseHundredths("12")).toBe(1200);
    expect(parseHundredths("12.5")).toBe(1250);
    expect(parseHundredths("12.50")).toBe(1250);
    expect(parseHundredths(" $1,234.05 ")).toBe(123_405);
    expect(parseHundredths("0.29")).toBe(29);
  });

  it("rejects what a person could mean two ways, or a sign", () => {
    for (const bad of ["", "12.345", "12,34", "1.234,50", "1,23,456", "12.", ".5", "-12.50", "(12.50)", "1e3", "12 50", "٣"]) {
      expect(parseHundredths(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses values beyond the safe-integer range", () => {
    expect(parseHundredths("90071992547409.92")).toBeNull();
  });

  it("round-trips with hundredthsToInput", () => {
    for (const cents of [0, 5, 99, 100, 1250, 123_405]) {
      expect(parseHundredths(hundredthsToInput(cents))).toBe(cents);
    }
    expect(hundredthsToInput(5)).toBe("0.05");
  });
});
