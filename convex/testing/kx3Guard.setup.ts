/**
 * KX3 guard (M25, D233, widened D247; RISKS KX3). A vitest setup file (vitest.config.mts `setupFiles`) for every
 * server-side (edge-runtime) test file: it FAILS a test whose code schedules a Convex job under ~60s that runs on a
 * REAL timer in the background, whether or not the test fakes `Date`.
 *
 * Why (D233): convex-test fires a scheduled function (`ctx.scheduler.runAfter` / `runAt`) with `globalThis.setTimeout`.
 * A real timer runs the job while the test is still calling functions, and convex-test decides "inside a mutation"
 * from a global flag, so the job can join the test's own write layer and fail intermittently ("Write outside of
 * transaction", the D231 flake).
 *
 * Why widened (D247): the original guard only fired when the test had faked or mocked `Date` (`vi.useFakeTimers({
 * toFake: ["Date"] })`, or `vi.setSystemTime` without fake timers) -- the exact D231 repro shape. QA-M25-1 found the
 * SAME race with `Date` left entirely real too: nothing about the hazard depends on `Date` being faked, only on the
 * scheduled job's timer being real while the test keeps running. The guard no longer conditions on `Date`'s state at
 * all; it fires on every short-delay convex-test-scheduled `setTimeout` it sees, full stop. A test schedules a
 * Convex job only by faking the timers themselves (`vi.useFakeTimers()`, `fakeSchedulerTimersEach()` /
 * `SCHEDULER_TIMERS`, or `pinClock` / `CLOCK_AND_TIMERS` -- all in `convex/test.setup.ts`) and flushing explicitly
 * (`t.finishAllScheduledFunctions(vi.runAllTimers)`, or `vi.advanceTimersByTime` + `finishInProgressScheduledFunctions`).
 * A test that schedules no Convex job (only a third-party component's own retry/backoff timer, which never goes
 * through convex-test's scheduler) may still run on real timers -- the guard checks the call stack for
 * `frameworkSetTimeout`, convex-test's own scheduler entry point, not for real timers in general.
 *
 * How: this file wraps `globalThis.setTimeout` before any test module loads. When ALL timers are faked
 * (`vi.useFakeTimers()`) the wrapper is not called at all (vitest replaced the global) -- there is nothing to guard.
 * When it IS called from convex-test's scheduler (`frameworkSetTimeout` in the stack) with a delay under
 * `KX3_SHORT_DELAY_MS`, the call is a violation, and the test fails in `afterEach` naming the delay. A long delay (a
 * reminder days away) never fires during a test and is allowed. The DOM (happy-dom) files are not wrapped: they do
 * not run convex-test.
 * `convex/testing/kx3Guard.test.ts` proves the guard fires (Date faked, Date mocked only, and fully real), and that
 * the fixed patterns pass.
 */
import { afterEach, beforeEach, vi } from "vitest";

/** A scheduled job due sooner than this can fire while the test is still running. */
export const KX3_SHORT_DELAY_MS = 60_000;

/** `dateFaked` is diagnostic only (D247: it no longer gates whether a call counts as a violation). */
type Violation = { delayMs: number; dateFaked: boolean; stack: string };
const STATE = Symbol.for("recoup.test.kx3Guard");
type GuardState = { violations: Violation[]; installed: boolean; underlying?: typeof setTimeout };

function state(): GuardState {
  const g = globalThis as Record<symbol, GuardState | undefined>;
  return (g[STATE] ??= { violations: [], installed: false });
}

/** The violations recorded in the current test so far, cleared (for the guard's own proof test). */
export function takeKx3Violations(): Violation[] {
  const out = state().violations;
  state().violations = [];
  return out;
}

/** Whether this file's setTimeout wrapper is installed (edge-runtime files only). */
export function kx3GuardInstalled(): boolean {
  return state().installed;
}

if (typeof document === "undefined") {
  // Wrap once per global object (a worker may evaluate this module more than once); register the hooks every time.
  // Captured once, at first load -- before any test can fake timers -- so it is always the REAL setTimeout,
  // regardless of how many times a later test toggles vi.useFakeTimers()/vi.useRealTimers() (which restores
  // whatever globalThis.setTimeout was at the time faking started, i.e. this wrapper, not the native function).
  const underlying = (state().underlying ??= globalThis.setTimeout);
  if (!state().installed) {
    const guarded = function (this: unknown, handler: unknown, timeout?: number, ...args: unknown[]) {
      const delayMs = typeof timeout === "number" ? timeout : 0;
      // Only convex-test's scheduler matters (any other real timer is not a scheduled Convex function). The stack is
      // checked FIRST: vitest's own timer machinery calls setTimeout too, and must not re-enter `vi` from here.
      if (delayMs < KX3_SHORT_DELAY_MS && (new Error().stack ?? "").includes("frameworkSetTimeout")) {
        state().violations.push({
          delayMs,
          dateFaked: vi.isFakeTimers() || vi.getMockedSystemTime() !== null,
          stack: new Error().stack ?? "",
        });
      }
      return (underlying as unknown as (...a: unknown[]) => unknown).call(globalThis, handler, timeout, ...args);
    };
    globalThis.setTimeout = guarded as unknown as typeof setTimeout;
    state().installed = true;
  }

  beforeEach(() => {
    state().violations = [];
  });
  afterEach(async () => {
    // Let background work this test left running (e.g. a component workpool loop still in flight) take a few REAL
    // event-loop turns now, so a job it schedules is charged to THIS test, not to whichever test runs next.
    for (let i = 0; i < 5; i++) await new Promise((resolve) => underlying(resolve, 0));
    const found = takeKx3Violations();
    if (found.length > 0) {
      // The stack is convex-test's own async machinery (AsyncLocalStorage crosses the test file's original call
      // site), so it never usefully names a line in the test file itself -- kept on the violation for ad hoc
      // debugging, not surfaced here.
      throw new Error(
        `KX3 (D233/D247): this test's code scheduled ${found.length} Convex job(s) ` +
          `(delays ${[...new Set(found.map((v) => v.delayMs))].join(", ")} ms) that run on REAL timers in the ` +
          `background${found.every((v) => v.dateFaked) ? " (Date was faked, but the timers were not)" : ""}. ` +
          `Fake the timers (vi.useFakeTimers(), fakeSchedulerTimersEach() / SCHEDULER_TIMERS, or pinClock / ` +
          `CLOCK_AND_TIMERS -- all in convex/test.setup.ts) and flush scheduled work explicitly ` +
          `(t.finishAllScheduledFunctions(vi.runAllTimers)).`,
      );
    }
  });
}
