import { describe, expect, it } from "vitest";
import { CHECK_PENDING_MS, canFindOtherStores, isChecking, isSearching, roundToCoarse } from "./time";

describe("roundToCoarse", () => {
  it("rounds down to the nearest 5-minute step", () => {
    expect(roundToCoarse(0)).toBe(0);
    expect(roundToCoarse(299_999)).toBe(0);
    expect(roundToCoarse(300_000)).toBe(300_000);
    expect(roundToCoarse(300_001)).toBe(300_000);
  });

  it("matches convex/watches.ts's assertCoarseNow rounding for a real timestamp", () => {
    const t = Date.UTC(2026, 8, 21, 12, 34, 56, 789);
    expect(roundToCoarse(t)).toBe(Date.UTC(2026, 8, 21, 12, 30, 0, 0));
  });

  it("is idempotent", () => {
    const t = Date.UTC(2026, 8, 21, 12, 34, 56);
    expect(roundToCoarse(roundToCoarse(t))).toBe(roundToCoarse(t));
  });
});

describe("isChecking", () => {
  const now = 1_000_000;

  it("is false when no check was ever requested", () => {
    expect(isChecking(null, null, now)).toBe(false);
    expect(isChecking(null, 500, now)).toBe(false);
  });

  it("is true right after a request with no completed check yet", () => {
    expect(isChecking(now, null, now)).toBe(true);
  });

  it("is false once the last completed check is at least as new as the request", () => {
    expect(isChecking(now - 1000, now, now)).toBe(false);
    expect(isChecking(now - 1000, now - 1000, now)).toBe(false);
  });

  it("is true while the request is newer than the last completed check and still recent", () => {
    expect(isChecking(now - 1000, now - 2000, now)).toBe(true);
  });

  it("gives up once the request is older than CHECK_PENDING_MS, even with no completed check", () => {
    expect(isChecking(now - CHECK_PENDING_MS - 1, null, now)).toBe(false);
    expect(isChecking(now - CHECK_PENDING_MS + 1, null, now)).toBe(true);
  });
});

describe("isSearching", () => {
  it("is false when there is no pending marker", () => {
    expect(isSearching(undefined, 1000)).toBe(false);
  });

  it("is true strictly before the deadline", () => {
    expect(isSearching(2000, 1000)).toBe(true);
  });

  it("is false at or after the deadline", () => {
    expect(isSearching(1000, 1000)).toBe(false);
    expect(isSearching(1000, 1001)).toBe(false);
  });
});

describe("canFindOtherStores", () => {
  it("is enabled when a find has never been made", () => {
    expect(canFindOtherStores(undefined, 1000)).toBe(true);
  });

  it("is enabled once the cooldown has rolled off, inclusive of the boundary", () => {
    expect(canFindOtherStores(1000, 1000)).toBe(true);
    expect(canFindOtherStores(1000, 1001)).toBe(true);
  });

  it("is disabled while still inside the cooldown", () => {
    expect(canFindOtherStores(1001, 1000)).toBe(false);
  });
});
