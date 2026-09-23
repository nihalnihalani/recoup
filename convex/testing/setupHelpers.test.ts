/**
 * M08: tests for the additive `convex/test.setup.ts` helpers `twoUsers`,
 * `pinClock` and `pinClockEach`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "../_generated/api";
import { pinClock, pinClockEach, setup, twoUsers } from "../test.setup";

const DAY = 86_400_000;
const FIXED = Date.UTC(2026, 8, 20, 12);

describe("twoUsers", () => {
  it("returns two distinct users whose identities resolve to their own ids", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    expect(owner.userId).not.toBe(other.userId);
    const subjects = await Promise.all(
      [owner, other].map((u) => u.as.run(async (ctx) => (await ctx.auth.getUserIdentity())?.subject)),
    );
    expect(subjects[0]?.split("|")[0]).toBe(owner.userId);
    expect(subjects[1]?.split("|")[0]).toBe(other.userId);
    const names = await t.run(async (ctx) => [await ctx.db.get(owner.userId), await ctx.db.get(other.userId)].map((u) => u?.name));
    expect(names).toEqual(["Owner", "Other"]);
  });

  it("accepts custom names", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t, ["Alice", "Bob"]);
    const names = await t.run(async (ctx) => [await ctx.db.get(owner.userId), await ctx.db.get(other.userId)].map((u) => u?.name));
    expect(names).toEqual(["Alice", "Bob"]);
  });
});

describe("pinClock", () => {
  afterEach(() => vi.useRealTimers());

  it("pins Date.now() and new Date(), fakes the timers (KX3) but not performance; restore returns to the real clock and timers", () => {
    const realSetTimeout = globalThis.setTimeout;
    const realPerformanceNow = performance.now;
    const restore = pinClock(FIXED);
    expect(Date.now()).toBe(FIXED);
    expect(new Date().getTime()).toBe(FIXED);
    expect(globalThis.setTimeout).not.toBe(realSetTimeout); // scheduled work runs only when a test flushes it
    expect(performance.now).toBe(realPerformanceNow);
    restore();
    expect(globalThis.setTimeout).toBe(realSetTimeout);
    expect(Math.abs(Date.now() - FIXED)).toBeGreaterThan(DAY); // the suite does not run on 2026-09-20
  });

  it("accepts a Date and stays frozen until moved explicitly", () => {
    pinClock(new Date(FIXED));
    const first = Date.now();
    expect(Date.now()).toBe(first);
    vi.setSystemTime(FIXED + DAY);
    expect(Date.now()).toBe(FIXED + DAY);
  });

  it("makes a fixed `now` acceptable to a public query guarded by assertCoarseNow (the D138 mechanism)", async () => {
    const t = setup();
    const { owner } = await twoUsers(t);
    // Unpinned: a time two days from the real clock is refused.
    await expect(owner.as.query(api.budget.status, { now: Date.now() - 2 * DAY })).rejects.toThrow(ConvexError);
    // Pinned: the fixture's fixed instant is "now", whatever the calendar says.
    const restore = pinClock(FIXED);
    const status = await owner.as.query(api.budget.status, { now: FIXED });
    expect(status.day).toBe("2026-09-20");
    restore();
  });
});

describe("pinClockEach", () => {
  pinClockEach(FIXED);

  it("pins before the first test", () => {
    expect(Date.now()).toBe(FIXED);
  });

  it("re-pins before the next test even after a test moved the clock", () => {
    expect(Date.now()).toBe(FIXED);
    vi.setSystemTime(FIXED + 7 * DAY);
  });

  it("and again", () => {
    expect(Date.now()).toBe(FIXED);
  });
});
