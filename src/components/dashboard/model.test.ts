import { describe, expect, it } from "vitest";
import { watchedTotalsByCurrency, type Watch } from "./model";

/** Only the fields `watchedTotalsByCurrency` reads; the rest of a `watches.list` row is irrelevant here. */
function watch(currency: string | undefined, points: [number, number][]): Watch {
  return {
    currency,
    spark: points.map(([observedAt, observedCents]) => ({ observedAt, observedCents })),
  } as unknown as Watch;
}

describe("watchedTotalsByCurrency (QA-2)", () => {
  it("mixed currencies → separate series, never summed", () => {
    const totals = watchedTotalsByCurrency([
      watch("USD", [[1, 10_000], [3, 9_000]]),
      watch("EUR", [[2, 5_000]]),
      watch("USD", [[2, 2_000]]),
    ]);
    expect(totals.map((t) => t.currency)).toEqual(["USD", "EUR"]);
    const usd = totals.find((t) => t.currency === "USD")!;
    const eur = totals.find((t) => t.currency === "EUR")!;
    // USD alone: 10,000 + 2,000 (carried back) at t=1; 10,000 + 2,000 at t=2; 9,000 + 2,000 at t=3.
    expect(usd.series).toEqual([
      { at: 1, value: 12_000 },
      { at: 2, value: 12_000 },
      { at: 3, value: 11_000 },
    ]);
    // EUR alone, at its own time only: no USD price is ever added into it.
    expect(eur.series).toEqual([{ at: 2, value: 5_000 }]);
    // And no series anywhere carries a cross-currency total (17,000 = 12,000 USD + 5,000 EUR).
    for (const t of totals) for (const p of t.series) expect(p.value).not.toBe(17_000);
  });

  it("puts the currency with more readings first when watch counts tie, so the small chart has a line", () => {
    const totals = watchedTotalsByCurrency([watch("EUR", [[1, 100]]), watch("USD", [[1, 100], [2, 90], [3, 80]])]);
    expect(totals.map((t) => t.currency)).toEqual(["USD", "EUR"]);
  });

  it("orders by how many watches share a currency, then by code", () => {
    const totals = watchedTotalsByCurrency([
      watch("GBP", [[1, 100]]),
      watch("EUR", [[1, 100]]),
      watch("GBP", [[1, 100]]),
      watch("CAD", [[1, 100]]),
    ]);
    expect(totals.map((t) => [t.currency, t.members])).toEqual([
      ["GBP", 2],
      ["CAD", 1],
      ["EUR", 1],
    ]);
  });

  it("leaves out a watch whose currency is unknown or that has no price yet, instead of guessing USD", () => {
    const totals = watchedTotalsByCurrency([watch(undefined, [[1, 100]]), watch("USD", [])]);
    expect(totals).toEqual([]);
  });

  it("carries a price forward and back only within its own currency", () => {
    const totals = watchedTotalsByCurrency([watch("USD", [[5, 300]]), watch("USD", [[1, 100], [9, 50]])]);
    expect(totals[0].series).toEqual([
      { at: 1, value: 400 },
      { at: 5, value: 400 },
      { at: 9, value: 350 },
    ]);
  });
});
