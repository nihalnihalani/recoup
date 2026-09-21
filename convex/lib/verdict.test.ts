import { describe, expect, it } from "vitest";
import { formatCents, verdict } from "./verdict";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20);

/** `cents[i]` observed `daysAgo[i]` days before NOW. */
function hist(points: Array<[daysAgo: number, cents: number]>) {
  return points.map(([daysAgo, cents]) => ({ observedAt: NOW - daysAgo * DAY, cents }));
}

describe("verdict: unknown", () => {
  it("says unknown when there is no current price, even with history", () => {
    const v = verdict({ currentCents: null, listCents: 20_000, history: hist([[10, 100], [0, 100]]), now: NOW });
    expect(v.label).toBe("unknown");
    expect(v.reason.length).toBeGreaterThan(0);
  });
});

describe("verdict: not_enough_history", () => {
  it("fires with no history at all", () => {
    const v = verdict({ currentCents: 10_000, listCents: null, history: [], now: NOW });
    expect(v.label).toBe("not_enough_history");
    expect(v.reason).toContain("$100.00");
  });

  it("fires with fewer than 3 observations even over a long span", () => {
    const v = verdict({ currentCents: 10_000, listCents: null, history: hist([[30, 10_000], [0, 10_000]]), now: NOW });
    expect(v.label).toBe("not_enough_history");
  });

  it("fires with 3 observations spanning just under 7 days", () => {
    const history = [
      { observedAt: NOW - 7 * DAY + 1, cents: 10_000 },
      { observedAt: NOW - 3 * DAY, cents: 10_000 },
      { observedAt: NOW, cents: 10_000 },
    ];
    expect(verdict({ currentCents: 10_000, listCents: null, history, now: NOW }).label).toBe("not_enough_history");
  });

  it("stops firing at exactly 3 observations over exactly 7 days", () => {
    const v = verdict({
      currentCents: 10_000,
      listCents: null,
      history: hist([[7, 10_000], [3, 10_000], [0, 10_000]]),
      now: NOW,
    });
    expect(v.label).toBe("good_price");
  });

  it("mentions the store's claimed discount when a list price cannot be verified yet", () => {
    const v = verdict({ currentCents: 7_500, listCents: 10_000, history: hist([[0, 7_500]]), now: NOW });
    expect(v.label).toBe("not_enough_history");
    expect(v.reason).toContain("25% off");
    expect(v.reason).toContain("$100.00");
  });

  it("ignores a list price that is not above the current price", () => {
    const v = verdict({ currentCents: 10_000, listCents: 10_000, history: hist([[0, 10_000]]), now: NOW });
    expect(v.label).toBe("not_enough_history");
    expect(v.reason).not.toContain("% off");
  });
});

describe("verdict: inflated_discount", () => {
  it("fires with only 2 observations 2 days apart when the was-price was never seen", () => {
    const v = verdict({
      currentCents: 7_500,
      listCents: 10_000,
      history: hist([[2, 7_500], [0, 7_500]]),
      now: NOW,
    });
    expect(v.label).toBe("inflated_discount");
    expect(v.reason).toContain("$100.00");
    expect(v.reason).toContain("Sep 18, 2026");
  });

  it("does not fire when the span is under 2 days", () => {
    const history = [
      { observedAt: NOW - 2 * DAY + 1, cents: 7_500 },
      { observedAt: NOW, cents: 7_500 },
    ];
    expect(verdict({ currentCents: 7_500, listCents: 10_000, history, now: NOW }).label).toBe("not_enough_history");
  });

  it("does not fire with a single observation", () => {
    const v = verdict({ currentCents: 7_500, listCents: 10_000, history: hist([[0, 7_500]]), now: NOW });
    expect(v.label).toBe("not_enough_history");
  });

  it("does not fire when we saw a price exactly 2% under the was-price", () => {
    const v = verdict({
      currentCents: 7_500,
      listCents: 10_000,
      history: hist([[10, 9_800], [5, 8_000], [0, 7_500]]),
      now: NOW,
    });
    expect(v.label).toBe("good_price");
  });

  it("fires when the closest we saw was just over 2% under the was-price", () => {
    const v = verdict({
      currentCents: 7_500,
      listCents: 10_000,
      history: hist([[10, 9_799], [5, 8_000], [0, 7_500]]),
      now: NOW,
    });
    expect(v.label).toBe("inflated_discount");
  });

  it("does not fire when a price above the was-price was seen", () => {
    const v = verdict({
      currentCents: 7_500,
      listCents: 10_000,
      history: hist([[10, 11_000], [5, 8_000], [0, 7_500]]),
      now: NOW,
    });
    expect(v.label).toBe("good_price");
  });

  it("takes precedence over a full-history verdict", () => {
    const v = verdict({
      currentCents: 9_000,
      listCents: 15_000,
      history: hist([[20, 8_000], [10, 8_000], [5, 8_000], [0, 9_000]]),
      now: NOW,
    });
    expect(v.label).toBe("inflated_discount");
  });
});

describe("verdict: good_price / fair / wait", () => {
  const base = hist([[20, 10_000], [14, 10_000], [7, 10_000]]);

  it("good_price at the lowest seen", () => {
    const v = verdict({ currentCents: 9_000, listCents: null, history: [...base, ...hist([[0, 9_000]])], now: NOW });
    expect(v.label).toBe("good_price");
    expect(v.reason).toContain("$90.00");
  });

  it("good_price at exactly 1% above the lowest seen", () => {
    const history = [...hist([[20, 10_000], [14, 12_000], [7, 12_000]]), ...hist([[0, 10_100]])];
    expect(verdict({ currentCents: 10_100, listCents: null, history, now: NOW }).label).toBe("good_price");
  });

  it("fair just over 1% above the lowest and not above the median bar", () => {
    const history = [...hist([[20, 10_000], [14, 12_000], [7, 12_000]]), ...hist([[0, 10_101]])];
    const v = verdict({ currentCents: 10_101, listCents: null, history, now: NOW });
    expect(v.label).toBe("fair");
    expect(v.reason).toContain("$100.00");
  });

  it("fair at exactly 5% above the median", () => {
    // sorted: 8000, 10000, 10000, 10000, 10500 -> median 10000
    const history = [...hist([[25, 8_000]]), ...base, ...hist([[0, 10_500]])];
    expect(verdict({ currentCents: 10_500, listCents: null, history, now: NOW }).label).toBe("fair");
  });

  it("wait just over 5% above the median", () => {
    const history = [...hist([[25, 8_000]]), ...base, ...hist([[0, 10_501]])];
    const v = verdict({ currentCents: 10_501, listCents: null, history, now: NOW });
    expect(v.label).toBe("wait");
    expect(v.reason).toContain("$80.00");
  });

  it("uses the mean of the two middle values for an even-length history", () => {
    // sorted: 8000, 10000, 12000, 13000 -> median 11000; the 5% bar is 11550
    const history = hist([[21, 8_000], [14, 10_000], [7, 12_000], [0, 13_000]]);
    expect(verdict({ currentCents: 11_550, listCents: null, history, now: NOW }).label).toBe("fair");
    expect(verdict({ currentCents: 11_551, listCents: null, history, now: NOW }).label).toBe("wait");
  });

  it("ignores observations dated in the future", () => {
    const history = [...base, ...hist([[0, 10_000]]), { observedAt: NOW + DAY, cents: 1 }];
    expect(verdict({ currentCents: 10_000, listCents: null, history, now: NOW }).label).toBe("good_price");
  });
});

describe("formatCents", () => {
  it("formats cents as money in the given currency", () => {
    expect(formatCents(123_456)).toBe("$1,234.56");
    expect(formatCents(5_000, "EUR")).toContain("50.00");
  });

  it("falls back to a plain amount for an unknown currency code", () => {
    expect(formatCents(5_000, "not-a-code")).toBe("50.00 not-a-code");
  });
});
