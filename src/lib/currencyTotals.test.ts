import { describe, expect, it } from "vitest";
import { orderedCurrencies, recoveredByCurrency, sumCentsByCurrency } from "./currencyTotals";
import { pinDefaultLocale } from "../test/locale";

// The labels below are en-US strings ("$50.00"); the formatter uses the machine's default locale, so pin it (M16:
// this file failed 5/15 under LANG=de_DE.UTF-8 — a locale time-bomb like D138).
pinDefaultLocale("en-US");

describe("orderedCurrencies", () => {
  it("puts primaryCurrency first, the rest alphabetical after it", () => {
    expect(
      orderedCurrencies({ USD: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 }, EUR: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 }, GBP: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 } }, "USD"),
    ).toEqual(["USD", "EUR", "GBP"]);
  });

  it("falls back to alphabetical order when primaryCurrency is null", () => {
    expect(
      orderedCurrencies({ USD: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 }, EUR: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 } }, null),
    ).toEqual(["EUR", "USD"]);
  });

  it("never invents a currency: a primaryCurrency absent from byCurrency is not added as a row", () => {
    expect(orderedCurrencies({ EUR: { foundCents: 0, recoveredCents: 0, exampleFoundCents: 0 } }, "USD")).toEqual(["EUR"]);
  });

  it("returns an empty list for an empty byCurrency", () => {
    expect(orderedCurrencies({}, null)).toEqual([]);
  });
});

describe("recoveredByCurrency", () => {
  it("collapses to a single value when only one currency is present", () => {
    const lines = recoveredByCurrency({ USD: { foundCents: 0, recoveredCents: 5000, exampleFoundCents: 0 } }, "USD");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ currency: "USD", cents: 5000, label: "$50.00" });
  });

  it("renders one line per currency, primaryCurrency first, never summing across currencies", () => {
    // 3 EUR items whose claim is still open plus $50 USD already recovered:
    // the USD row must read $50.00, never a mixed or EUR-labelled figure.
    const lines = recoveredByCurrency(
      {
        USD: { foundCents: 0, recoveredCents: 5000, exampleFoundCents: 0 },
        EUR: { foundCents: 1200, recoveredCents: 0, exampleFoundCents: 0 },
      },
      "USD",
    );
    expect(lines).toEqual([
      { currency: "USD", cents: 5000, label: "$50.00" },
      { currency: "EUR", cents: 0, label: "€0.00" },
    ]);
  });

  it("returns an empty array when there is nothing to report yet (zero-currencies case)", () => {
    expect(recoveredByCurrency({}, null)).toEqual([]);
  });

  it("passes an unrecognised currency code straight through to the formatter without throwing", () => {
    const lines = recoveredByCurrency({ ZZZ: { foundCents: 0, recoveredCents: 1234, exampleFoundCents: 0 } }, "ZZZ");
    expect(lines).toHaveLength(1);
    expect(lines[0].currency).toBe("ZZZ");
    expect(lines[0].cents).toBe(1234);
    expect(typeof lines[0].label).toBe("string");
    expect(lines[0].label.length).toBeGreaterThan(0);
  });
});

describe("sumCentsByCurrency", () => {
  it("collapses to a single value when every entry shares one currency (F-T14-1)", () => {
    const lines = sumCentsByCurrency(
      [
        { currency: "USD", cents: 500 },
        { currency: "USD", cents: 1500 },
        { currency: "USD", cents: 0 },
      ],
      "USD",
    );
    expect(lines).toEqual([{ currency: "USD", cents: 2000, label: "$20.00" }]);
  });

  it("sums per currency instead of across currencies, primaryCurrency first", () => {
    // 3 EUR items with an open drop plus 1 USD item with an open drop: the
    // USD row must read its own total, never a mixed or EUR-labelled sum
    // (the bug StatCards had: `mainCurrency` picked one currency and the
    // reduce summed raw cents across both).
    const lines = sumCentsByCurrency(
      [
        { currency: "EUR", cents: 1200 },
        { currency: "EUR", cents: 300 },
        { currency: "EUR", cents: 500 },
        { currency: "USD", cents: 4000 },
      ],
      "USD",
    );
    expect(lines).toEqual([
      { currency: "USD", cents: 4000, label: "$40.00" },
      { currency: "EUR", cents: 2000, label: "€20.00" },
    ]);
  });

  it("orders alphabetically after a primaryCurrency that isn't among the entries, never inventing it as a row", () => {
    const lines = sumCentsByCurrency(
      [
        { currency: "GBP", cents: 100 },
        { currency: "EUR", cents: 200 },
      ],
      "USD",
    );
    expect(lines.map((l) => l.currency)).toEqual(["EUR", "GBP"]);
  });

  it("falls back to alphabetical order when primaryCurrency is null", () => {
    const lines = sumCentsByCurrency(
      [
        { currency: "USD", cents: 100 },
        { currency: "EUR", cents: 200 },
      ],
      null,
    );
    expect(lines.map((l) => l.currency)).toEqual(["EUR", "USD"]);
  });

  it("still produces a row for a currency whose entries sum to zero", () => {
    const lines = sumCentsByCurrency([{ currency: "USD", cents: 0 }], "USD");
    expect(lines).toEqual([{ currency: "USD", cents: 0, label: "$0.00" }]);
  });

  it("returns an empty array for no entries, never inventing a currency", () => {
    expect(sumCentsByCurrency([], "USD")).toEqual([]);
    expect(sumCentsByCurrency([], null)).toEqual([]);
  });

  it("passes an unrecognised currency code straight through to the formatter without throwing", () => {
    const lines = sumCentsByCurrency([{ currency: "ZZZ", cents: 1234 }], "ZZZ");
    expect(lines).toHaveLength(1);
    expect(lines[0].currency).toBe("ZZZ");
    expect(lines[0].cents).toBe(1234);
    expect(typeof lines[0].label).toBe("string");
    expect(lines[0].label.length).toBeGreaterThan(0);
  });
});
