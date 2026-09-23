import { describe, expect, test } from "vitest";
import { boughtVerdict, claimThresholdCents, priceStats } from "../../src/lib/priceStats";
import { pinDefaultLocale } from "../../src/test/locale";

// The verdict text is formatted in the machine's default locale; the assertions are en-US strings ("20.00").
// Pinned (M16, D189): under LANG=de_DE.UTF-8 this file failed with "20,00 $ below what you paid".
pinDefaultLocale("en-US");

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 1);

describe("priceStats", () => {
  test("no points gives null fields and a zero swing", () => {
    expect(priceStats([])).toEqual({
      count: 0,
      lowest: null,
      highest: null,
      average: null,
      swingPct: 0,
      first: null,
      latest: null,
      trackingSince: null,
      daysAtCurrentPrice: null,
    });
  });

  test("one point has no swing", () => {
    const stats = priceStats([{ at: T0, cents: 5000 }]);
    expect(stats).toMatchObject({ count: 1, lowest: 5000, highest: 5000, average: 5000, swingPct: 0, trackingSince: T0 });
    expect(stats.daysAtCurrentPrice).toBe(0);
  });

  test("low, high, rounded average and swing of the average", () => {
    const stats = priceStats([
      { at: T0, cents: 10000 },
      { at: T0 + DAY, cents: 9000 },
      { at: T0 + 2 * DAY, cents: 9501 },
    ]);
    expect(stats.lowest).toBe(9000);
    expect(stats.highest).toBe(10000);
    expect(stats.average).toBe(9500); // 9500.33 rounded
    expect(stats.swingPct).toBeCloseTo((1000 / (28501 / 3)) * 100, 6);
    expect(stats.first).toEqual({ at: T0, cents: 10000 });
    expect(stats.latest).toEqual({ at: T0 + 2 * DAY, cents: 9501 });
  });

  test("days at the current price count the trailing run only, up to now", () => {
    const points = [
      { at: T0, cents: 9000 },
      { at: T0 + DAY, cents: 10000 },
      { at: T0 + 2 * DAY, cents: 9000 },
      { at: T0 + 4 * DAY, cents: 9000 },
    ];
    expect(priceStats(points).daysAtCurrentPrice).toBe(2);
    expect(priceStats(points, T0 + 7 * DAY + 1000).daysAtCurrentPrice).toBe(5);
  });

  test("unsorted input is read oldest first and not mutated", () => {
    const points = [
      { at: T0 + DAY, cents: 8000 },
      { at: T0, cents: 9000 },
    ];
    const stats = priceStats(points);
    expect(stats.first?.cents).toBe(9000);
    expect(stats.latest?.cents).toBe(8000);
    expect(points[0].cents).toBe(8000);
  });
});

describe("boughtVerdict", () => {
  const now = T0 + 10 * DAY;
  const open = now + 3 * DAY;

  test("no latest price", () => {
    expect(boughtVerdict({ paidCents: 10000, now }).kind).toBe("no_price");
    expect(boughtVerdict({ paidCents: 10000, claimStatus: "sent", now }).kind).toBe("no_price");
  });

  test("a live claim outranks the price", () => {
    const base = { paidCents: 10000, latestCents: 8000, windowEndsAt: open, now };
    expect(boughtVerdict({ ...base, claimStatus: "confirmed" })).toMatchObject({ kind: "recovered", label: "Back on card", tone: "green" });
    expect(boughtVerdict({ ...base, claimStatus: "promised" }).kind).toBe("promised");
    // P02-OW-4: a queued send is not yet confirmed sent, so it reads "sending", not "asked".
    expect(boughtVerdict({ ...base, claimStatus: "queued" }).kind).toBe("sending");
    for (const claimStatus of ["sent", "packet"]) {
      expect(boughtVerdict({ ...base, claimStatus }).kind).toBe("asked");
    }
    for (const claimStatus of ["detected", "drafted", "reopened", "dismissed"]) {
      expect(boughtVerdict({ ...base, claimStatus }).kind).toBe("claim_now");
    }
  });

  test("claim now states the amount and the time left", () => {
    const verdict = boughtVerdict({ paidCents: 10000, latestCents: 8000, windowEndsAt: open, now, currency: "USD" });
    expect(verdict).toMatchObject({ kind: "claim_now", label: "Claim now" });
    expect(verdict.reason).toContain("20.00");
    expect(verdict.reason).toContain("3 days");
  });

  test("an unknown window still says claim now, and says the window is unknown", () => {
    const verdict = boughtVerdict({ paidCents: 10000, latestCents: 8000, now });
    expect(verdict.kind).toBe("claim_now");
    expect(verdict.reason).toMatch(/window is unknown/);
  });

  test("the threshold is the larger of $1 and 2%", () => {
    expect(claimThresholdCents(2000)).toBe(100);
    expect(claimThresholdCents(50000)).toBe(1000);
    expect(boughtVerdict({ paidCents: 2000, latestCents: 1901, windowEndsAt: open, now }).kind).toBe("hold");
    expect(boughtVerdict({ paidCents: 2000, latestCents: 1900, windowEndsAt: open, now }).kind).toBe("claim_now");
    expect(boughtVerdict({ paidCents: 50000, latestCents: 49001, windowEndsAt: open, now }).kind).toBe("hold");
    expect(boughtVerdict({ paidCents: 50000, latestCents: 49000, windowEndsAt: open, now }).kind).toBe("claim_now");
  });

  test("a drop after the window shut", () => {
    expect(boughtVerdict({ paidCents: 10000, latestCents: 8000, windowEndsAt: now, now }).kind).toBe("window_closed");
    expect(boughtVerdict({ paidCents: 10000, latestCents: 9950, windowEndsAt: now - DAY, now }).kind).toBe("window_closed");
  });

  test("above paid and holding", () => {
    expect(boughtVerdict({ paidCents: 10000, latestCents: 10500, windowEndsAt: open, now })).toMatchObject({
      kind: "above_paid",
      label: "Price went up since you bought",
      tone: "red",
    });
    expect(boughtVerdict({ paidCents: 10000, latestCents: 10000, windowEndsAt: open, now })).toMatchObject({
      kind: "hold",
      label: "Holding at what you paid",
    });
  });
});
