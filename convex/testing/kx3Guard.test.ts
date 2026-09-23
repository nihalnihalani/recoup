/**
 * M25 (KX3, D233): proof that `kx3Guard.setup.ts` fires on the pattern behind the D231 flake, and stays quiet on the
 * fixed patterns. Each case schedules a harmless internal job (`notify.sweepStalled` over an empty mail log) the way
 * a mutation under test would, then reads the guard's record directly (and clears it, so the proof test itself passes).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { CLOCK_AND_TIMERS, pinClock, setup } from "../test.setup";
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
    expect(takeKx3Violations()).toEqual([{ delayMs: 0 }]);
    await t.finishAllScheduledFunctions(() => {}); // let the real-timer job finish inside this test
    takeKx3Violations();
  });

  it("FIRES: vi.setSystemTime without fake timers (Date mocked only) + a short job", async () => {
    vi.setSystemTime(NOW);
    const t = setup();
    await scheduleAfter(t, 1_000);
    expect(takeKx3Violations()).toEqual([{ delayMs: 1_000 }]);
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

  it("quiet: real clock and real timers (the guard is about a faked clock; see the M25 finding on unfaked files)", async () => {
    const t = setup();
    await scheduleAfter(t, 0);
    expect(takeKx3Violations()).toEqual([]);
    await t.finishAllScheduledFunctions(() => {});
  });
});
