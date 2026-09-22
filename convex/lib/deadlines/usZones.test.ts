import { describe, expect, it } from "vitest";
import { dstBounds, localParts, localToUtc, offsetMinutesAt, startOfLocalDay, US_ZONES, zoneRule } from "./usZones";

const NY = zoneRule("America/New_York")!;
const PHX = zoneRule("America/Phoenix")!;
const LA = zoneRule("America/Los_Angeles")!;

describe("usZones: committed US DST rule (second Sunday of March → first Sunday of November)", () => {
  it("2026: daylight time starts 2026-03-08 07:00Z in New York and ends 2026-11-01 06:00Z", () => {
    // 2026-03-08 02:00 EST = 07:00Z; 2026-11-01 02:00 EDT = 06:00Z (hand-computed).
    expect(dstBounds(2026, -300)).toEqual({ start: Date.parse("2026-03-08T07:00:00Z"), end: Date.parse("2026-11-01T06:00:00Z") });
    expect(offsetMinutesAt(NY, Date.parse("2026-03-08T06:59:59.999Z"))).toBe(-300);
    expect(offsetMinutesAt(NY, Date.parse("2026-03-08T07:00:00Z"))).toBe(-240);
    expect(offsetMinutesAt(NY, Date.parse("2026-11-01T05:59:59.999Z"))).toBe(-240);
    expect(offsetMinutesAt(NY, Date.parse("2026-11-01T06:00:00Z"))).toBe(-300);
  });

  it("each zone switches at ITS OWN 02:00 local (Los Angeles 2026-03-08 10:00Z)", () => {
    expect(offsetMinutesAt(LA, Date.parse("2026-03-08T09:59:59Z"))).toBe(-480);
    expect(offsetMinutesAt(LA, Date.parse("2026-03-08T10:00:00Z"))).toBe(-420);
  });

  it("zones without DST keep their standard offset all year", () => {
    expect(offsetMinutesAt(PHX, Date.parse("2026-07-01T12:00:00Z"))).toBe(-420);
    expect(offsetMinutesAt(zoneRule("Pacific/Honolulu")!, Date.parse("2026-07-01T12:00:00Z"))).toBe(-600);
    expect(offsetMinutesAt(zoneRule("Pacific/Guam")!, Date.parse("2026-07-01T12:00:00Z"))).toBe(600);
  });

  it("local midnight: the 23-hour and 25-hour days", () => {
    expect(startOfLocalDay(NY, "2026-03-08")).toBe(Date.parse("2026-03-08T05:00:00Z"));
    expect(startOfLocalDay(NY, "2026-03-09")).toBe(Date.parse("2026-03-09T04:00:00Z")); // 23 h later
    expect(startOfLocalDay(NY, "2026-11-01")).toBe(Date.parse("2026-11-01T04:00:00Z"));
    expect(startOfLocalDay(NY, "2026-11-02")).toBe(Date.parse("2026-11-02T05:00:00Z")); // 25 h later
  });

  it("a wall time in the spring gap resolves forward; one in the fall overlap resolves to its first occurrence", () => {
    expect(localToUtc(NY, "2026-03-08", 2 * 60 + 30)).toBe(Date.parse("2026-03-08T07:30:00Z")); // 03:30 EDT
    expect(localToUtc(NY, "2026-11-01", 60 + 30)).toBe(Date.parse("2026-11-01T05:30:00Z")); // 01:30 EDT (first)
  });

  it("localParts inverts localToUtc", () => {
    const t = localToUtc(LA, "2026-09-23", 9 * 60 + 15);
    expect(t).toBe(Date.parse("2026-09-23T16:15:00Z"));
    expect(localParts(LA, t)).toEqual({ date: "2026-09-23", minutes: 9 * 60 + 15 });
  });

  it("aliases resolve; unknown and non-US zones are null; UTC is a reference zone only", () => {
    expect(zoneRule("US/Eastern")?.id).toBe("America/New_York");
    expect(zoneRule("America/Boise")?.id).toBe("America/Denver");
    expect(zoneRule("Europe/London")).toBeNull();
    expect(zoneRule("UTC")?.stdOffsetMinutes).toBe(0);
    expect(US_ZONES.some((z) => z.id === "UTC")).toBe(false);
  });

  it("years before the 2007 rule are refused, never guessed", () => {
    expect(() => dstBounds(2006, -300)).toThrow(RangeError);
    expect(() => offsetMinutesAt(NY, Date.parse("2005-07-01T00:00:00Z"))).toThrow(RangeError);
  });
});
