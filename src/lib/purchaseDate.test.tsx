// @vitest-environment happy-dom
/**
 * QA-M16-4 (D217), client side, under TZ=Asia/Kolkata (UTC+05:30): a purchase date picked in the viewer's own time
 * zone never becomes a future instant, so a price-adjustment window never shows more than its policy days.
 * Before this fix, "today" picked at 09:30 IST (04:00Z) became noon UTC — 8 hours ahead — and the meter read
 * "14d 8h left of 14 days".
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { WindowMeter } from "../components/charts/WindowMeter";
import { render, screen } from "../test/dom";
import { fromDateInput, toDateInput, todayInput } from "./ui";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** 2026-09-23 09:30 IST = 04:00Z. */
const MORNING_IST = Date.UTC(2026, 8, 23, 4, 0);
/** 2026-09-23 17:29 IST = 11:59Z, the last minute before noon UTC. */
const LATE_AFTERNOON_IST = Date.UTC(2026, 8, 23, 11, 59);

let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "Asia/Kolkata";
});
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("the test really runs in Asia/Kolkata", () => {
  it("has a +05:30 offset", () => {
    expect(new Date(MORNING_IST).getTimezoneOffset()).toBe(-330);
    expect(todayInput(MORNING_IST)).toBe("2026-09-23");
  });
});

describe("fromDateInput (QA-M16-4)", () => {
  it("today is the moment it was entered, never noon UTC ahead of it", () => {
    for (const now of [MORNING_IST, LATE_AFTERNOON_IST]) {
      expect(fromDateInput("2026-09-23", { now })).toBe(now);
    }
  });

  it("an earlier day keeps the noon-UTC convention and is never later than now", () => {
    expect(fromDateInput("2026-09-20", { now: MORNING_IST })).toBe(Date.UTC(2026, 8, 20, 12));
    expect(fromDateInput("2026-09-22", { now: MORNING_IST })!).toBeLessThanOrEqual(MORNING_IST);
  });

  it("a later day is refused for a purchase, and allowed only when asked (a promised date)", () => {
    expect(fromDateInput("2026-09-24", { now: MORNING_IST })).toBeNull();
    expect(fromDateInput("2026-09-24", { now: MORNING_IST, allowFuture: true })).toBe(Date.UTC(2026, 8, 24, 12));
  });

  it("refuses malformed input", () => {
    expect(fromDateInput("", { now: MORNING_IST })).toBeNull();
    expect(fromDateInput("23/09/2026", { now: MORNING_IST })).toBeNull();
  });

  it("toDateInput reads the day in the viewer's zone, so a stored noon-UTC date round-trips", () => {
    expect(toDateInput(Date.UTC(2026, 8, 20, 12))).toBe("2026-09-20");
    // 20:00Z on the 22nd is 01:30 on the 23rd in Kolkata: the picker shows the local day.
    expect(toDateInput(Date.UTC(2026, 8, 22, 20))).toBe("2026-09-23");
  });
});

describe("WindowMeter with a purchase bought 'today' (QA-M16-4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never shows more than the policy window, at any time before 17:30 IST", () => {
    for (const now of [MORNING_IST, MORNING_IST + 3 * HOUR, LATE_AFTERNOON_IST]) {
      vi.setSystemTime(now);
      const purchasedAt = fromDateInput(todayInput(now), { now })!;
      render(<WindowMeter purchasedAt={purchasedAt} endsAt={purchasedAt + 14 * DAY} />);
      const label = screen.getByRole("img").getAttribute("aria-label")!;
      expect(label).toBe("Price-adjustment window: 14d 0h left of 14 days");
      document.body.innerHTML = "";
    }
  });
});
