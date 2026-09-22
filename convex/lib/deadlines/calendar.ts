/**
 * Local-calendar arithmetic on ISO dates ("YYYY-MM-DD"). Pure: dates are day numbers, never instants, so no zone or
 * DST can shift them. Business days skip Saturdays, Sundays and — with `holidays: "us_federal"` — the committed
 * observed federal holidays (`usFederalHolidays.ts`). A business-day computation that touches a date outside that
 * table throws `BeyondCalendarError`; the engine reports it as `beyond_calendar`.
 */
import { federalHolidayOn, inHolidayTable } from "./usFederalHolidays";

export type HolidayRule = "none" | "us_federal";

export class BeyondCalendarError extends Error {
  readonly date: string;
  constructor(date: string) {
    super(`date ${date} is outside the committed holiday calendar`);
    this.name = "BeyondCalendarError";
    this.date = date;
  }
}

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a valid ISO date; throws on anything else (including 2026-02-30). */
export function dayNumber(date: string): number {
  const m = ISO_DATE.exec(date);
  if (!m) throw new RangeError(`not an ISO date: ${date}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (new Date(ms).toISOString().slice(0, 10) !== date) throw new RangeError(`not a calendar date: ${date}`);
  return ms / DAY_MS;
}

export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function isIsoDate(s: string): boolean {
  try {
    dayNumber(s);
    return true;
  } catch {
    return false;
  }
}

export function addCalendarDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(date: string): number {
  return new Date(dayNumber(date) * DAY_MS).getUTCDay();
}

export function isWeekend(date: string): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

/** A business day: not a weekend and, under `us_federal`, not an observed federal holiday. */
export function isBusinessDay(date: string, holidays: HolidayRule): boolean {
  if (holidays === "us_federal" && !inHolidayTable(date)) throw new BeyondCalendarError(date);
  if (isWeekend(date)) return false;
  return holidays === "none" || federalHolidayOn(date) === null;
}

/**
 * The `n`-th counted business day of a period anchored on `anchor` (n ≥ 1). With `anchorDayCounts` and a business-day
 * anchor, the anchor itself is day 1; otherwise counting starts on the next business day after the anchor.
 */
export function nthBusinessDay(anchor: string, n: number, holidays: HolidayRule, anchorDayCounts: boolean): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("business-day count must be ≥ 1");
  let count = 0;
  let day = dayNumber(anchor);
  if (anchorDayCounts && isBusinessDay(anchor, holidays)) {
    count = 1;
    if (n === 1) return anchor;
  }
  // A bounded walk: n business days never span more than 3n + 30 calendar days even with every holiday.
  for (let i = 0; i < n * 3 + 30; i++) {
    day += 1;
    const date = fromDayNumber(day);
    if (isBusinessDay(date, holidays)) {
      count += 1;
      if (count === n) return date;
    }
  }
  throw new RangeError("business-day walk did not terminate");
}

/** The `n`-th counted calendar day (n ≥ 1): the anchor itself when it counts, else anchor + n. */
export function nthCalendarDay(anchor: string, n: number, anchorDayCounts: boolean): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError("calendar-day count must be ≥ 1");
  return addCalendarDays(anchor, anchorDayCounts ? n - 1 : n);
}
