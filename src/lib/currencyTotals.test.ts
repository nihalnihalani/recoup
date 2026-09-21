import { describe, expect, it } from "vitest";
import { orderedCurrencies, recoveredByCurrency } from "./currencyTotals";

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
