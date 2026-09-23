/**
 * KX3 guard (M25, D233; RISKS KX3). A vitest setup file (vitest.config.mts `setupFiles`) for every server-side
 * (edge-runtime) test file: it FAILS a test that fakes or mocks only `Date` while the code it exercises schedules work.
 *
 * Why: convex-test fires a scheduled function (`ctx.scheduler.runAfter` / `runAt`) with `globalThis.setTimeout`. When
 * a test fakes only `Date` (`vi.useFakeTimers({ toFake: ["Date"] })`, or `vi.setSystemTime` without fake timers), that
 * timer is REAL: the job runs in the background while the test is still calling functions, and convex-test decides
 * "inside a mutation" from a global flag, so the job can join the test's own write layer and fail intermittently
 * ("Write outside of transaction", the D231 flake). A test must fake the timers with the clock
 * (`vi.useFakeTimers()`, or `pinClock` / `CLOCK_AND_TIMERS`) and flush scheduled work explicitly
 * (`t.finishAllScheduledFunctions(vi.runAllTimers)`, or `vi.advanceTimersByTime` + `finishInProgressScheduledFunctions`).
 *
 * How: this file wraps `globalThis.setTimeout` before any test module loads. When timers are faked the wrapper is not
 * called at all (vitest replaced the global). When it IS called from convex-test's scheduler (`frameworkSetTimeout` in
 * the stack) with the clock faked or mocked and a delay under `KX3_SHORT_DELAY_MS`, the call is a violation, and the
 * test fails in `afterEach` naming the delay. A long delay (a reminder days away) never fires during a test and is
 * allowed. The DOM (happy-dom) files are not wrapped: they do not run convex-test.
 * `convex/testing/kx3Guard.test.ts` proves the guard fires, and that the fixed patterns pass.
 */
import { afterEach, beforeEach, vi } from "vitest";

/** A scheduled job due sooner than this can fire while the test is still running. */
export const KX3_SHORT_DELAY_MS = 60_000;

type Violation = { delayMs: number };
const STATE = Symbol.for("recoup.test.kx3Guard");
type GuardState = { violations: Violation[]; installed: boolean };

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
  if (!state().installed) {
    const underlying = globalThis.setTimeout;
    const guarded = function (this: unknown, handler: unknown, timeout?: number, ...args: unknown[]) {
      const delayMs = typeof timeout === "number" ? timeout : 0;
      // Only convex-test's scheduler matters (any other real timer is not a scheduled Convex function). The stack is
      // checked FIRST: vitest's own timer machinery calls setTimeout too, and must not re-enter `vi` from here.
      if (delayMs < KX3_SHORT_DELAY_MS && (new Error().stack ?? "").includes("frameworkSetTimeout")) {
        if (vi.isFakeTimers() || vi.getMockedSystemTime() !== null) state().violations.push({ delayMs });
      }
      return (underlying as unknown as (...a: unknown[]) => unknown).call(globalThis, handler, timeout, ...args);
    };
    globalThis.setTimeout = guarded as unknown as typeof setTimeout;
    state().installed = true;
  }

  beforeEach(() => {
    state().violations = [];
  });
  afterEach(() => {
    const found = takeKx3Violations();
    if (found.length > 0) {
      throw new Error(
        `KX3 (D233): this test fakes or mocks only Date, and the code it exercised scheduled ${found.length} job(s) ` +
          `(delays ${[...new Set(found.map((v) => v.delayMs))].join(", ")} ms) that fire on REAL timers in the background. ` +
          `Fake the timers with the clock (vi.useFakeTimers(), or pinClock / CLOCK_AND_TIMERS from convex/test.setup.ts) ` +
          `and flush scheduled work explicitly (t.finishAllScheduledFunctions(vi.runAllTimers)).`,
      );
    }
  });
}
