import { describe, expect, it } from "vitest";
import {
  FEDERAL_HOLIDAY_TABLE_FIRST_DATE,
  FEDERAL_HOLIDAY_TABLE_LAST_DATE,
  federalHolidayOn,
  US_FEDERAL_HOLIDAYS_OBSERVED,
} from "./usFederalHolidays";

/**
 * Two independent checks of the committed table:
 *  1. OPM's published 2026 federal holiday list, written out by hand.
 *  2. A rule-based generator written here (5 U.S.C. 6103 + the Saturday→Friday / Sunday→Monday observance rule),
 *     which shares no code with the data file.
 */
describe("usFederalHolidays", () => {
  it("matches OPM's 2026 list (hand-copied), including Independence Day observed on Friday 2026-07-03", () => {
    const y2026 = Object.entries(US_FEDERAL_HOLIDAYS_OBSERVED)
      .filter(([d]) => d.startsWith("2026-"))
      .map(([d]) => d)
      .sort();
    expect(y2026).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
      "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
    ]);
  });

  it("New Year's Day on a Saturday is observed on the previous year's December 31 (2022, 2028)", () => {
    expect(federalHolidayOn("2021-12-31")).toBe("new_years_day");
    expect(federalHolidayOn("2027-12-31")).toBe("new_years_day");
    expect(federalHolidayOn("2028-01-01")).toBeNull(); // a Saturday; the observed day is Friday
  });

  it("equals an independent rule-based generation for every year 2021–2030", () => {
    const dow = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
    const nth = (y: number, m: number, wd: number, n: number) => {
      let c = 0;
      for (let d = 1; d <= 31; d++) if (dow(y, m, d) === wd && ++c === n) return iso(Date.UTC(y, m - 1, d));
      throw new Error("unreachable");
    };
    const lastMonday = (y: number, m: number) => {
      for (let d = 31; d >= 1; d--) {
        const t = Date.UTC(y, m - 1, d);
        if (new Date(t).getUTCMonth() === m - 1 && new Date(t).getUTCDay() === 1) return iso(t);
      }
      throw new Error("unreachable");
    };
    const observed = (y: number, m: number, d: number) => {
      const t = Date.UTC(y, m - 1, d);
      const w = new Date(t).getUTCDay();
      return iso(w === 6 ? t - 86_400_000 : w === 0 ? t + 86_400_000 : t);
    };
    const expected: string[] = [];
    for (let y = 2021; y <= 2030; y++) {
      expected.push(
        observed(y, 1, 1), nth(y, 1, 1, 3), nth(y, 2, 1, 3), lastMonday(y, 5), observed(y, 6, 19), observed(y, 7, 4),
        nth(y, 9, 1, 1), nth(y, 10, 1, 2), observed(y, 11, 11), nth(y, 11, 4, 4), observed(y, 12, 25),
      );
    }
    expect(Object.keys(US_FEDERAL_HOLIDAYS_OBSERVED).sort()).toEqual([...new Set(expected)].sort());
    expect(Object.keys(US_FEDERAL_HOLIDAYS_OBSERVED)).toHaveLength(110);
  });

  it("refuses dates outside the committed table instead of guessing", () => {
    expect(FEDERAL_HOLIDAY_TABLE_FIRST_DATE).toBe("2021-01-01");
    expect(FEDERAL_HOLIDAY_TABLE_LAST_DATE).toBe("2030-12-31");
    expect(() => federalHolidayOn("2031-01-01")).toThrow(RangeError);
    expect(() => federalHolidayOn("2020-12-31")).toThrow(RangeError);
    expect(federalHolidayOn("2030-12-31")).toBeNull();
  });
});
