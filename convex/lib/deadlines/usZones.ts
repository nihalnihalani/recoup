/**
 * Committed US time-zone table (contract §4, DA-A-23: part of the engine's closure). Pure: no ctx, no clock, and no
 * dependency on the runtime's tz database — the same inputs give the same instants on every runtime and forever.
 *
 * Rules encoded (15 U.S.C. 260a as amended by the Energy Policy Act of 2005, in force since 2007): daylight time
 * starts the second Sunday of March at 02:00 local standard time and ends the first Sunday of November at 02:00
 * local daylight time. Zones that do not observe DST (Arizona outside the Navajo Nation, Hawaii, the territories)
 * keep their standard offset all year. Years before 2007 had different rules; they are refused (`RangeError`), and
 * the deadline engine reports such a computation as outside its committed calendar.
 *
 * `UTC` is accepted as a reference zone for exact-instant specs whose arithmetic needs no local calendar; it is not a
 * US zone and never takes part in the "earliest-ending zone" choice.
 */

export interface ZoneRule {
  id: string;
  label: string;
  /** Minutes east of UTC in standard time (e.g. New York −300). */
  stdOffsetMinutes: number;
  observesDst: boolean;
}

/** First year the encoded DST rule is valid for. */
export const DST_RULE_FROM_YEAR = 2007;

/** The US zones (states, DC and inhabited territories). Earliest-ending selection ranges over exactly these. */
export const US_ZONES: readonly ZoneRule[] = Object.freeze([
  { id: "America/New_York", label: "Eastern", stdOffsetMinutes: -300, observesDst: true },
  { id: "America/Chicago", label: "Central", stdOffsetMinutes: -360, observesDst: true },
  { id: "America/Denver", label: "Mountain", stdOffsetMinutes: -420, observesDst: true },
  { id: "America/Phoenix", label: "Arizona", stdOffsetMinutes: -420, observesDst: false },
  { id: "America/Los_Angeles", label: "Pacific", stdOffsetMinutes: -480, observesDst: true },
  { id: "America/Anchorage", label: "Alaska", stdOffsetMinutes: -540, observesDst: true },
  { id: "America/Adak", label: "Hawaii–Aleutian (Aleutians)", stdOffsetMinutes: -600, observesDst: true },
  { id: "Pacific/Honolulu", label: "Hawaii", stdOffsetMinutes: -600, observesDst: false },
  { id: "America/Puerto_Rico", label: "Atlantic (Puerto Rico)", stdOffsetMinutes: -240, observesDst: false },
  { id: "America/St_Thomas", label: "Atlantic (U.S. Virgin Islands)", stdOffsetMinutes: -240, observesDst: false },
  { id: "Pacific/Guam", label: "Chamorro (Guam)", stdOffsetMinutes: 600, observesDst: false },
  { id: "Pacific/Saipan", label: "Chamorro (Northern Mariana Islands)", stdOffsetMinutes: 600, observesDst: false },
  { id: "Pacific/Pago_Pago", label: "Samoa (American Samoa)", stdOffsetMinutes: -660, observesDst: false },
]);

const UTC_RULE: ZoneRule = { id: "UTC", label: "UTC", stdOffsetMinutes: 0, observesDst: false };

/** IANA links and legacy names that follow one of the table's rules. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "US/Eastern": "America/New_York",
  "America/Detroit": "America/New_York",
  "America/Indiana/Indianapolis": "America/New_York",
  "America/Indianapolis": "America/New_York",
  "America/Kentucky/Louisville": "America/New_York",
  "America/Louisville": "America/New_York",
  "US/Central": "America/Chicago",
  "America/Menominee": "America/Chicago",
  "America/Indiana/Knox": "America/Chicago",
  "America/North_Dakota/Center": "America/Chicago",
  "US/Mountain": "America/Denver",
  "America/Boise": "America/Denver",
  "US/Arizona": "America/Phoenix",
  "US/Pacific": "America/Los_Angeles",
  "US/Alaska": "America/Anchorage",
  "America/Juneau": "America/Anchorage",
  "America/Sitka": "America/Anchorage",
  "America/Nome": "America/Anchorage",
  "America/Yakutat": "America/Anchorage",
  "America/Metlakatla": "America/Anchorage",
  "US/Aleutian": "America/Adak",
  "US/Hawaii": "Pacific/Honolulu",
  "US/Samoa": "Pacific/Pago_Pago",
  "Etc/UTC": "UTC",
});

/** The rule for a zone id (an alias resolves to its target), or null when the zone is not in the committed table. */
export function zoneRule(zoneId: string): ZoneRule | null {
  if (zoneId === "UTC") return UTC_RULE;
  const id = ALIASES[zoneId] ?? zoneId;
  if (id === "UTC") return UTC_RULE;
  return US_ZONES.find((z) => z.id === id) ?? null;
}

const MINUTE = 60_000;

/** Day of month of the n-th `weekday` (0 = Sunday) in a UTC-calendar month (month 0-based). */
function nthWeekday(year: number, month0: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** The UTC instants [start, end) of daylight time in `year` for a zone with standard offset `std` minutes. */
export function dstBounds(year: number, stdOffsetMinutes: number): { start: number; end: number } {
  if (!Number.isSafeInteger(year) || year < DST_RULE_FROM_YEAR) {
    throw new RangeError(`US DST rule not committed for ${year}`);
  }
  const startDay = nthWeekday(year, 2, 0, 2); // second Sunday of March
  const endDay = nthWeekday(year, 10, 0, 1); // first Sunday of November
  return {
    // 02:00 local standard time
    start: Date.UTC(year, 2, startDay, 2) - stdOffsetMinutes * MINUTE,
    // 02:00 local daylight time
    end: Date.UTC(year, 10, endDay, 2) - (stdOffsetMinutes + 60) * MINUTE,
  };
}

/** The zone's UTC offset in minutes at a UTC instant. */
export function offsetMinutesAt(zone: ZoneRule, utcMs: number): number {
  if (!zone.observesDst) return zone.stdOffsetMinutes;
  const localYear = new Date(utcMs + zone.stdOffsetMinutes * MINUTE).getUTCFullYear();
  const { start, end } = dstBounds(localYear, zone.stdOffsetMinutes);
  return utcMs >= start && utcMs < end ? zone.stdOffsetMinutes + 60 : zone.stdOffsetMinutes;
}

/** The zone's local calendar date ("YYYY-MM-DD") and minutes past local midnight at a UTC instant. */
export function localParts(zone: ZoneRule, utcMs: number): { date: string; minutes: number } {
  const shifted = new Date(utcMs + offsetMinutesAt(zone, utcMs) * MINUTE);
  const date = shifted.toISOString().slice(0, 10);
  return { date, minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/**
 * The UTC instant of a local wall-clock time. A wall time inside the spring-forward gap does not exist and resolves
 * forward (02:30 → 03:30 daylight); a wall time inside the fall-back overlap resolves to its FIRST occurrence
 * (daylight). Local midnight — the only wall time end-of-day deadlines use — is never in either.
 */
export function localToUtc(zone: ZoneRule, date: string, minutesOfDay: number): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError(`not a local date: ${date}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + minutesOfDay * MINUTE;
  const valid: number[] = [];
  for (const off of [zone.stdOffsetMinutes + (zone.observesDst ? 60 : 0), zone.stdOffsetMinutes]) {
    const utc = wall - off * MINUTE;
    if (offsetMinutesAt(zone, utc) === off) valid.push(utc);
  }
  if (valid.length > 0) return Math.min(...valid);
  // In the gap: interpret with the standard offset, which lands after the gap.
  return wall - zone.stdOffsetMinutes * MINUTE;
}

/** The first instant of the local day `date` in `zone`. */
export function startOfLocalDay(zone: ZoneRule, date: string): number {
  return localToUtc(zone, date, 0);
}
