// @vitest-environment happy-dom
/**
 * M15: the dashboard's money comes only from `recovery.summary` (SEC-MF-1, DA-A-34), per currency (QA-2), with
 * disjoint tiles, "of which provisional" and the over-credit line (contract §3.4, §9).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { formatMinor } from "../../lib/money";
import { render, screen, within } from "../../test/dom";
import type { RecoverySummary } from "./model";
import { StatCards } from "./StatCards";

const NOW = Date.UTC(2026, 8, 23, 12);

const tile = (amountMinor: number, provisionalMinor = 0, components = amountMinor > 0 ? 1 : 0) => ({
  amountMinor,
  provisionalMinor,
  components,
});
const emptyTiles = { potential: tile(0), ready: tile(0), sendingOrUnknown: tile(0), asked: tile(0), promised: tile(0) };

function summary(overrides: Partial<RecoverySummary> = {}): RecoverySummary {
  return {
    asOf: NOW,
    complete: true,
    currencies: [],
    nonCash: [],
    unsupportedCurrencies: [],
    counts: { notYetDue: 0, needsAnswers: 0, deadlinesThisWeek: 0 },
    ...overrides,
  };
}

function renderCards(s: RecoverySummary, onlyExamples = false) {
  render(
    <StatCards
      watches={[]}
      activity={[]}
      activityTruncated={false}
      activityWindowNote=""
      summary={s}
      onlyExamples={onlyExamples}
      now={NOW}
    />,
  );
}

describe("StatCards money (DA-A-34, QA-2)", () => {
  it("takes no tracking.overview prop, so overview totals cannot reach it", () => {
    expectTypeOf<Parameters<typeof StatCards>[0]>().not.toHaveProperty("overview");
    expectTypeOf<Parameters<typeof StatCards>[0]>().not.toHaveProperty("scoped");
    expectTypeOf<Parameters<typeof StatCards>[0]["summary"]>().toEqualTypeOf<RecoverySummary>();
  });

  it("shows Recovered per currency, never summed across currencies", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "USD", recoveredMinor: 12_000, overCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
          { currency: "EUR", recoveredMinor: 5_000, overCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
        ],
      }),
    );
    const card = screen.getByRole("region", { name: "Recovered" });
    expect(card.textContent).toContain(formatMinor(12_000, "USD"));
    expect(card.textContent).toContain(formatMinor(5_000, "EUR"));
    // 12,000 + 5,000 in either currency would be the cross-currency sum.
    expect(document.body.textContent).not.toContain(formatMinor(17_000, "USD"));
    expect(document.body.textContent).not.toContain(formatMinor(17_000, "EUR"));
  });

  it("renders each tile once per currency, with 'of which provisional' inside its tile", () => {
    renderCards(
      summary({
        currencies: [
          {
            currency: "USD",
            recoveredMinor: 0,
            overCreditMinor: 0,
            tiles: { potential: tile(2_500), ready: tile(0), sendingOrUnknown: tile(0), asked: tile(4_000, 1_500), promised: tile(0) },
            askedUserReportedMinor: 0,
            cappedAtPaidTotal: false,
            paidTotalPartial: false,
          },
        ],
      }),
    );
    const usd = screen.getByRole("group", { name: "USD recovery" });
    for (const label of ["Potential", "Ready to ask", "Sending or unknown", "Asked", "Promised"]) {
      expect(within(usd).getAllByText(label)).toHaveLength(1);
    }
    expect(usd.textContent).toContain(formatMinor(2_500, "USD"));
    expect(usd.textContent).toContain("estimated, not guaranteed");
    expect(usd.textContent).toContain(`of which provisional ${formatMinor(1_500, "USD")}`);
    // The provisional part sits inside Asked; it is not a separate, additive figure.
    expect(usd.textContent).not.toContain(formatMinor(5_500, "USD"));
  });

  it("keeps the over-credit line and the paid-total cap note visible", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "USD", recoveredMinor: 6_000, overCreditMinor: 2_000, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: true, paidTotalPartial: true },
        ],
      }),
    );
    expect(screen.getByText(/Over-credit \/ possible double credit/).textContent).toContain(formatMinor(2_000, "USD"));
    expect(screen.getByText(/cap based on item prices only/)).toBeDefined();
  });

  it("uses each currency's own exponent (JPY has no minor unit)", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "JPY", recoveredMinor: 1_200, overCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
        ],
      }),
    );
    expect(screen.getByRole("region", { name: "Recovered" }).textContent).toContain(formatMinor(1_200, "JPY"));
  });

  it("labels a partial summary and never invents a currency when nothing is recovered", () => {
    renderCards(summary({ complete: false }), true);
    const card = screen.getByRole("region", { name: "Recovered" });
    expect(card.textContent).toContain("Partial");
    expect(card.textContent).toContain("the example is never counted");
    expect(card.textContent).not.toMatch(/\$|USD/);
    expect(screen.getByText(/checks supported recovery paths/)).toBeDefined();
  });

  it("names the claims left out because their currency is not two-decimal, instead of showing them as money", () => {
    renderCards(summary({ unsupportedCurrencies: [{ currency: "JPY", claims: 2 }] }));
    expect(screen.getByText(/2 claims in JPY are not in these totals/)).toBeDefined();
  });

  it("shows non-cash remedies and not-yet-due paths as counts, never as money", () => {
    renderCards(
      summary({
        nonCash: [{ kind: "voucher", count: 2 }],
        counts: { notYetDue: 1, needsAnswers: 3, deadlinesThisWeek: 1 },
      }),
    );
    expect(screen.getByText("2 vouchers (non-cash)")).toBeDefined();
    expect(screen.getByText("1 not yet due")).toBeDefined();
    expect(screen.getByText("3 paths need your answers")).toBeDefined();
    expect(screen.getByText("1 deadline of yours this week")).toBeDefined();
  });
});
