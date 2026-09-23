// @vitest-environment happy-dom
/**
 * M15: the dashboard's money comes only from `recovery.summary` (SEC-MF-1, DA-A-34), per currency (QA-2), with
 * disjoint tiles, "of which provisional" and the over-credit line (contract §3.4, §9).
 */
import axe from "axe-core";
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
const emptyTiles = { potential: tile(0), ready: tile(0), sendingOrUnknown: tile(0), asked: tile(0), refused: tile(0), promised: tile(0) };

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
          { currency: "USD", recoveredMinor: 12_000, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
          { currency: "EUR", recoveredMinor: 5_000, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
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
            extraCreditedMinor: 0,
            possibleDoubleCreditMinor: 0,
            tiles: { potential: tile(2_500), ready: tile(0), sendingOrUnknown: tile(0), asked: tile(4_000, 1_500), refused: tile(0), promised: tile(0) },
            askedUserReportedMinor: 0,
            cappedAtPaidTotal: false,
            paidTotalPartial: false,
          },
        ],
      }),
    );
    const usd = screen.getByRole("group", { name: "USD recovery" });
    for (const label of ["Potential", "Ready to ask", "Sending or unknown", "Asked", "Refused", "Promised"]) {
      expect(within(usd).getAllByText(label)).toHaveLength(1);
    }
    expect(usd.textContent).toContain(formatMinor(2_500, "USD"));
    expect(usd.textContent).toContain("estimated, not guaranteed");
    // DA-B-13: a refused claim can still sit in Asked in wave 1, so the hint never claims "no answer".
    expect(usd.textContent).toContain("sent or submitted; no money yet");
    expect(usd.textContent).not.toContain("no answer yet");
    expect(usd.textContent).toContain(`of which provisional ${formatMinor(1_500, "USD")}`);
    // The provisional part sits inside Asked; it is not a separate, additive figure.
    expect(usd.textContent).not.toContain(formatMinor(5_500, "USD"));
  });

  it("DA-B-8: extra credited money is a neutral line; only a possible double credit is red; the deprecated sum is never shown", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "USD", recoveredMinor: 2_500, overCreditMinor: 700, extraCreditedMinor: 200, possibleDoubleCreditMinor: 500, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: true, paidTotalPartial: true },
        ],
      }),
    );
    const extra = screen.getByText(/More than you asked — often tax or shipping/);
    expect(extra.textContent).toContain(formatMinor(200, "USD"));
    expect(extra.className).not.toMatch(/red/);
    const double = screen.getByText(/Possible double credit/);
    expect(double.textContent).toContain(formatMinor(500, "USD"));
    expect(double.className).toContain("text-red-700");
    expect(document.body.textContent).not.toContain(formatMinor(700, "USD"));
    expect(document.body.textContent).not.toMatch(/Over-credit/);
    expect(screen.getByText(/cap based on item prices only/)).toBeDefined();
  });

  it("S1: a refund that included tax (asked 25, received 27) shows no double-credit alarm", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "USD", recoveredMinor: 2_500, overCreditMinor: 200, extraCreditedMinor: 200, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
        ],
      }),
    );
    expect(screen.queryByText(/Possible double credit/)).toBeNull();
    expect(document.querySelector(".text-red-700")).toBeNull();
  });

  it("DA-B-13: a refused claim shows as refused, its amount exactly once, never under 'no answer yet'", () => {
    renderCards(
      summary({
        currencies: [
          {
            currency: "USD", recoveredMinor: 0, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0,
            tiles: { ...emptyTiles, refused: tile(4_321), asked: tile(1_000) },
            askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false,
          },
        ],
      }),
    );
    const usd = screen.getByRole("group", { name: "USD recovery" });
    const refused = within(usd).getByText("Refused").closest("div")!;
    expect(refused.textContent).toContain(formatMinor(4_321, "USD"));
    expect(refused.textContent).toContain("The merchant said no — no money yet");
    expect(usd.textContent!.split(formatMinor(4_321, "USD")).length - 1).toBe(1);
    expect(document.body.textContent).not.toContain("no answer yet");
  });

  it("the tiles add up to the displayed outstanding total, per currency, never across currencies", () => {
    const tiles = { potential: tile(100), ready: tile(200), sendingOrUnknown: tile(300), asked: tile(400), refused: tile(500), promised: tile(600) };
    renderCards(
      summary({
        currencies: [
          { currency: "USD", recoveredMinor: 0, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
          { currency: "EUR", recoveredMinor: 0, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: { ...emptyTiles, asked: tile(7_000) }, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
        ],
      }),
    );
    const usd = screen.getByRole("group", { name: "USD recovery" });
    const eur = screen.getByRole("group", { name: "EUR recovery" });
    expect(usd.textContent).toContain(`${formatMinor(2_100, "USD")} still outstanding`);
    expect(eur.textContent).toContain(`${formatMinor(7_000, "EUR")} still outstanding`);
    // 2,100 + 7,000 in either currency would be a cross-currency sum.
    expect(document.body.textContent).not.toContain(formatMinor(9_100, "USD"));
    expect(document.body.textContent).not.toContain(formatMinor(9_100, "EUR"));
  });

  it("every tile the summary can return has a place on the dashboard (no amount can silently vanish)", () => {
    const keys = Object.keys(emptyTiles).sort();
    renderCards(summary({ currencies: [{ currency: "USD", recoveredMinor: 0, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false }] }));
    const usd = screen.getByRole("group", { name: "USD recovery" });
    expect(within(usd).getAllByRole("term")).toHaveLength(keys.length);
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    const { container } = render(
      <main>
        <h1>Board</h1>
        <StatCards
          watches={[]}
          activity={[]}
          activityTruncated={false}
          activityWindowNote=""
          summary={summary({
            nonCash: [{ kind: "voucher", count: 1 }],
            counts: { notYetDue: 1, needsAnswers: 1, deadlinesThisWeek: 0 },
            currencies: [
              { currency: "USD", recoveredMinor: 2_500, overCreditMinor: 700, extraCreditedMinor: 200, possibleDoubleCreditMinor: 500, tiles: { ...emptyTiles, refused: tile(1_000) }, askedUserReportedMinor: 0, cappedAtPaidTotal: true, paidTotalPartial: false },
            ],
          })}
          onlyExamples={false}
          now={NOW}
        />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("uses each currency's own exponent (JPY has no minor unit)", () => {
    renderCards(
      summary({
        currencies: [
          { currency: "JPY", recoveredMinor: 1_200, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
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
    // P05-OW3 (SK-3): the Recovery panel is labelled partial too, and its empty state does not claim there is nothing.
    const panel = screen.getByRole("region", { name: "Recovery by currency" });
    expect(panel.textContent).toContain("Partial");
    expect(panel.textContent).toContain("Some records were too many to read in full");
    expect(panel.textContent).not.toContain("No recovery paths with an amount yet");
    expect(panel.textContent).toContain("Some records were too many to read in full, so there may be some.");
  });

  it("P05-OW3: a partial summary WITH currency rows labels the Recovery panel as partial", () => {
    renderCards(
      summary({
        complete: false,
        currencies: [
          { currency: "USD", recoveredMinor: 0, overCreditMinor: 0, extraCreditedMinor: 0, possibleDoubleCreditMinor: 0, tiles: emptyTiles, askedUserReportedMinor: 0, cappedAtPaidTotal: false, paidTotalPartial: false },
        ],
      }),
    );
    const panel = screen.getByRole("region", { name: "Recovery by currency" });
    expect(panel.textContent).toContain("Partial");
    // F7 fix: cause-neutral wording. `complete: false` has several distinct server-side causes (a per-claim
    // ledger-event cut, a per-claim draft/packet/submission cut, the 2x scan caps, a non-cash-remedy cut, and the
    // claims/open-paths caps) -- the UI does not know which one fired, so it must not name only the caps.
    expect(panel.textContent).toContain("Some records were too many to read in full, so these totals may be missing some money.");
    expect(panel.textContent).not.toContain("most recent 200 claims");
  });

  it("P05-OW3: a complete summary is not labelled partial, and its empty state says so plainly", () => {
    renderCards(summary({ complete: true }));
    const panel = screen.getByRole("region", { name: "Recovery by currency" });
    expect(panel.textContent).not.toContain("Partial");
    expect(panel.textContent).toContain("No recovery paths with an amount yet");
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
