/**
 * Committed US federal holiday table (5 U.S.C. 6103(a), with the observance rule of 5 U.S.C. 6103(b) / E.O. 11582:
 * a holiday on a Saturday is observed the Friday before, one on a Sunday the Monday after). Juneteenth is included
 * from 2021 (Pub. L. 117-17). Inauguration Day (DC area only) is not a nationwide holiday and is excluded.
 *
 * These are OBSERVED dates — the days a federal "business day" count skips. The table is data, part of the engine
 * closure (DA-A-23): a change here is an engine change. Business-day arithmetic that needs a date outside
 * [FEDERAL_HOLIDAY_TABLE_FIRST_DATE, FEDERAL_HOLIDAY_TABLE_LAST_DATE] yields `beyond_calendar` rather than guessing.
 * Note that New Year's Day 2022 and 2028 fall on a Saturday and are observed on 2021-12-31 and 2027-12-31.
 */

export const FEDERAL_HOLIDAY_TABLE_FIRST_DATE = "2021-01-01";
export const FEDERAL_HOLIDAY_TABLE_LAST_DATE = "2030-12-31";

export type FederalHoliday =
  | "new_years_day" | "mlk_day" | "washingtons_birthday" | "memorial_day" | "juneteenth" | "independence_day"
  | "labor_day" | "columbus_day" | "veterans_day" | "thanksgiving" | "christmas";

/** Observed date → holiday. */
export const US_FEDERAL_HOLIDAYS_OBSERVED: Readonly<Record<string, FederalHoliday>> = Object.freeze({
  // 2021
  "2021-01-01": "new_years_day", "2021-01-18": "mlk_day", "2021-02-15": "washingtons_birthday", "2021-05-31": "memorial_day",
  "2021-06-18": "juneteenth", "2021-07-05": "independence_day", "2021-09-06": "labor_day", "2021-10-11": "columbus_day",
  "2021-11-11": "veterans_day", "2021-11-25": "thanksgiving", "2021-12-24": "christmas",
  // 2022 (New Year's Day 2022 is observed 2021-12-31)
  "2021-12-31": "new_years_day", "2022-01-17": "mlk_day", "2022-02-21": "washingtons_birthday", "2022-05-30": "memorial_day",
  "2022-06-20": "juneteenth", "2022-07-04": "independence_day", "2022-09-05": "labor_day", "2022-10-10": "columbus_day",
  "2022-11-11": "veterans_day", "2022-11-24": "thanksgiving", "2022-12-26": "christmas",
  // 2023
  "2023-01-02": "new_years_day", "2023-01-16": "mlk_day", "2023-02-20": "washingtons_birthday", "2023-05-29": "memorial_day",
  "2023-06-19": "juneteenth", "2023-07-04": "independence_day", "2023-09-04": "labor_day", "2023-10-09": "columbus_day",
  "2023-11-10": "veterans_day", "2023-11-23": "thanksgiving", "2023-12-25": "christmas",
  // 2024
  "2024-01-01": "new_years_day", "2024-01-15": "mlk_day", "2024-02-19": "washingtons_birthday", "2024-05-27": "memorial_day",
  "2024-06-19": "juneteenth", "2024-07-04": "independence_day", "2024-09-02": "labor_day", "2024-10-14": "columbus_day",
  "2024-11-11": "veterans_day", "2024-11-28": "thanksgiving", "2024-12-25": "christmas",
  // 2025
  "2025-01-01": "new_years_day", "2025-01-20": "mlk_day", "2025-02-17": "washingtons_birthday", "2025-05-26": "memorial_day",
  "2025-06-19": "juneteenth", "2025-07-04": "independence_day", "2025-09-01": "labor_day", "2025-10-13": "columbus_day",
  "2025-11-11": "veterans_day", "2025-11-27": "thanksgiving", "2025-12-25": "christmas",
  // 2026
  "2026-01-01": "new_years_day", "2026-01-19": "mlk_day", "2026-02-16": "washingtons_birthday", "2026-05-25": "memorial_day",
  "2026-06-19": "juneteenth", "2026-07-03": "independence_day", "2026-09-07": "labor_day", "2026-10-12": "columbus_day",
  "2026-11-11": "veterans_day", "2026-11-26": "thanksgiving", "2026-12-25": "christmas",
  // 2027
  "2027-01-01": "new_years_day", "2027-01-18": "mlk_day", "2027-02-15": "washingtons_birthday", "2027-05-31": "memorial_day",
  "2027-06-18": "juneteenth", "2027-07-05": "independence_day", "2027-09-06": "labor_day", "2027-10-11": "columbus_day",
  "2027-11-11": "veterans_day", "2027-11-25": "thanksgiving", "2027-12-24": "christmas",
  // 2028 (New Year's Day 2028 is observed 2027-12-31)
  "2027-12-31": "new_years_day", "2028-01-17": "mlk_day", "2028-02-21": "washingtons_birthday", "2028-05-29": "memorial_day",
  "2028-06-19": "juneteenth", "2028-07-04": "independence_day", "2028-09-04": "labor_day", "2028-10-09": "columbus_day",
  "2028-11-10": "veterans_day", "2028-11-23": "thanksgiving", "2028-12-25": "christmas",
  // 2029
  "2029-01-01": "new_years_day", "2029-01-15": "mlk_day", "2029-02-19": "washingtons_birthday", "2029-05-28": "memorial_day",
  "2029-06-19": "juneteenth", "2029-07-04": "independence_day", "2029-09-03": "labor_day", "2029-10-08": "columbus_day",
  "2029-11-12": "veterans_day", "2029-11-22": "thanksgiving", "2029-12-25": "christmas",
  // 2030
  "2030-01-01": "new_years_day", "2030-01-21": "mlk_day", "2030-02-18": "washingtons_birthday", "2030-05-27": "memorial_day",
  "2030-06-19": "juneteenth", "2030-07-04": "independence_day", "2030-09-02": "labor_day", "2030-10-14": "columbus_day",
  "2030-11-11": "veterans_day", "2030-11-28": "thanksgiving", "2030-12-25": "christmas",
});

/** True when the table covers `date` ("YYYY-MM-DD"). */
export function inHolidayTable(date: string): boolean {
  return date >= FEDERAL_HOLIDAY_TABLE_FIRST_DATE && date <= FEDERAL_HOLIDAY_TABLE_LAST_DATE;
}

/** The observed federal holiday on `date`, or null. Throws `RangeError` outside the committed table. */
export function federalHolidayOn(date: string): FederalHoliday | null {
  if (!inHolidayTable(date)) throw new RangeError(`no committed federal holiday data for ${date}`);
  return US_FEDERAL_HOLIDAYS_OBSERVED[date] ?? null;
}
