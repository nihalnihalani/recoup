import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  BeyondCalendarError,
  dayNumber,
  isBusinessDay,
  isIsoDate,
  nthBusinessDay,
  nthCalendarDay,
  weekday,
} from "./calendar";

describe("calendar (local dates, no zones)", () => {
  it("validates real calendar dates only", () => {
    expect(isIsoDate("2026-02-28")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-2-3")).toBe(false);
    expect(() => dayNumber("2026-13-01")).toThrow(RangeError);
  });

  it("adds calendar days across months and years; knows weekdays", () => {
    expect(addCalendarDays("2026-12-25", 10)).toBe("2027-01-04");
    expect(addCalendarDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(weekday("2026-09-23")).toBe(3); // a Wednesday
  });

  it("counts calendar days with and without the anchor day", () => {
    expect(nthCalendarDay("2026-10-25", 14, false)).toBe("2026-11-08");
    expect(nthCalendarDay("2026-10-25", 14, true)).toBe("2026-11-07");
  });

  it("skips weekends and the committed federal holidays", () => {
    // Thanksgiving 2026 is Thursday 11-26.
    expect(isBusinessDay("2026-11-26", "us_federal")).toBe(false);
    expect(isBusinessDay("2026-11-26", "none")).toBe(true);
    expect(isBusinessDay("2026-11-28", "none")).toBe(false); // Saturday
    // From Tue 2026-11-24: Wed 25 = 1, (Thu 26 holiday), Fri 27 = 2, Mon 30 = 3.
    expect(nthBusinessDay("2026-11-24", 3, "us_federal", false)).toBe("2026-11-30");
    expect(nthBusinessDay("2026-11-24", 3, "none", false)).toBe("2026-11-27");
    // Anchor day counts when it is itself a business day.
    expect(nthBusinessDay("2026-11-24", 1, "us_federal", true)).toBe("2026-11-24");
    // A Saturday anchor never counts, even with anchorDayCounts.
    expect(nthBusinessDay("2026-11-28", 1, "us_federal", true)).toBe("2026-11-30");
  });

  it("walks past the committed holiday table only by throwing BeyondCalendarError", () => {
    expect(() => nthBusinessDay("2030-12-20", 10, "us_federal", false)).toThrow(BeyondCalendarError);
    expect(nthBusinessDay("2030-12-20", 2, "us_federal", false)).toBe("2030-12-24");
    // Without a holiday table there is no horizon.
    expect(nthBusinessDay("2030-12-20", 10, "none", false)).toBe("2031-01-03");
  });
});
