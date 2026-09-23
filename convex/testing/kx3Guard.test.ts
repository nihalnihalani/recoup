/**
 * M25 (KX3, D233; widened D247): proof that `kx3Guard.setup.ts` fires on the pattern behind the D231 flake, on the
 * WIDER D247 pattern (real timers with Date left entirely real too), and stays quiet on the fixed patterns. Each
 * case schedules a harmless internal job (`notify.sweepStalled` over an empty mail log) the way a mutation under
 * test would, then reads the guard's record directly (and clears it, so the proof test itself passes).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { CLOCK_AND_TIMERS, SCHEDULER_TIMERS, fakeSchedulerTimersEach, pinClock, setup } from "../test.setup";
import { KX3_SHORT_DELAY_MS, kx3GuardInstalled, takeKx3Violations } from "./kx3Guard.setup";

const NOW = Date.UTC(2026, 8, 24, 15);

afterEach(() => {
  vi.useRealTimers();
});

async function scheduleAfter(t: ReturnType<typeof setup>, ms: number) {
  await t.run(async (ctx) => {
    await ctx.scheduler.runAfter(ms, internal.notify.sweepStalled, {});
  });
}

describe("KX3 guard", () => {
  it("is installed for server-side test files", () => {
    expect(kx3GuardInstalled()).toBe(true);
  });

  it("FIRES: Date-only fake timers + a runAfter(0) job (the D231 pattern)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toMatchObject([{ delayMs: 0, dateFaked: true }]);
    await t.finishAllScheduledFunctions(() => {}); // let the real-timer job finish inside this test
    takeKx3Violations();
  });

  it("FIRES: vi.setSystemTime without fake timers (Date mocked only) + a short job", async () => {
    vi.setSystemTime(NOW);
    const t = setup();
    await scheduleAfter(t, 1_000);
    expect(takeKx3Violations()).toMatchObject([{ delayMs: 1_000, dateFaked: true }]);
    await t.finishAllScheduledFunctions(() => {});
    takeKx3Violations();
  });

  // D247 (QA-M25-1): the original guard only fired when Date was faked or mocked -- this exact case, everything
  // real, passed silently. That was the gap: convex-test races happen from a real-timer scheduled job regardless of
  // Date's state. The widened guard fires here too.
  it("FIRES (D247): real clock AND real timers -- a scheduled job on real timers is a hazard on its own, Date faked or not", async () => {
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toMatchObject([{ delayMs: 0, dateFaked: false }]);
    await t.finishAllScheduledFunctions(() => {});
    takeKx3Violations();
  });

  it("quiet: all timers faked (vi.useFakeTimers()), flushed explicitly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(takeKx3Violations()).toEqual([]);
  });

  // D247: the common fix for a file that needs no Date control at all -- fake only the scheduler's timers.
  it("quiet: fakeSchedulerTimersEach()'s SCHEDULER_TIMERS (timers faked, Date left real), flushed explicitly", async () => {
    expect(SCHEDULER_TIMERS).not.toContain("Date");
    vi.useFakeTimers({ toFake: SCHEDULER_TIMERS });
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(takeKx3Violations()).toEqual([]);
    // The exported helper itself installs and tears down the same way (asserted structurally: it is a function that
    // registers beforeEach/afterEach, proven by the file-level uses across the suite; here just a smoke check).
    expect(typeof fakeSchedulerTimersEach).toBe("function");
  });

  it("quiet: pinClock (the clock and CLOCK_AND_TIMERS), and a job days away under a Date-only fake", async () => {
    expect(CLOCK_AND_TIMERS).toEqual(expect.arrayContaining(["Date", "setTimeout"]));
    const restore = pinClock(NOW);
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    restore();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const t2 = setup();
    await scheduleAfter(t2, KX3_SHORT_DELAY_MS * 60 * 24); // a reminder a day away never fires during a test
    expect(takeKx3Violations()).toEqual([]);
  });

  it("records a non-empty stack per violation, for the thrown message's best-effort source line", async () => {
    const t = setup();
    await scheduleAfter(t, 0);
    const [violation] = takeKx3Violations();
    expect(violation!.stack.length).toBeGreaterThan(0);
    await t.finishAllScheduledFunctions(() => {});
  });
});
