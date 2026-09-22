/**
 * Clock-shift vitest setup file (M08; the M04/D138 sweep shim, committed).
 * Loaded ONLY when `RECOUP_CLOCK_SHIFT_DAYS` is set (see vitest.config.mts);
 * `npm run test:clockshift` sets it to 400.
 *
 * Makes the process's REAL clock read "now + N days" while it keeps
 * advancing in real time. Any test that silently depends on today's date
 * then fails the way it would N days from now. D138 was exactly that: a
 * fixed `now` compared with the server clock.
 *  - `Date.now` is patched on the underlying Date, so the shift survives
 *    vitest's `resetDate()` (`vi.useRealTimers()` after a Date-only fake).
 *  - `globalThis.Date` is replaced by a subclass, so a zero-argument
 *    `new Date()` is shifted too. It is re-installed before each test in
 *    case a previous test's `vi.useRealTimers()` restored vitest's
 *    captured Date.
 *  - `vi.useFakeTimers()` without `setSystemTime` starts from the shifted
 *    `Date.now()`. Pinned tests (`vi.setSystemTime`, `pinClock`) are
 *    unaffected by design.
 *  - Before every test that runs on the real (unfaked) clock, the shift is
 *    asserted to be in effect, so a green run proves the shim was active.
 *
 * Limits: only the JavaScript clock inside vitest workers moves, not the OS
 * clock. `performance.now()` and timers are not shifted.
 */
import { beforeEach, expect, vi } from "vitest";

const DAY_MS = 86_400_000;
const days = Number(process.env.RECOUP_CLOCK_SHIFT_DAYS);
if (!Number.isFinite(days) || days === 0) {
  throw new Error(`clockShift.setup.ts: RECOUP_CLOCK_SHIFT_DAYS must be a non-zero number of days, got "${process.env.RECOUP_CLOCK_SHIFT_DAYS}"`);
}
const OFFSET_MS = days * DAY_MS;

type ShiftGlobals = { Date: DateConstructor; __recoupTrueDate?: DateConstructor; __recoupTrueNow?: () => number };
const g = globalThis as unknown as ShiftGlobals;
const TrueDate: DateConstructor = g.__recoupTrueDate ?? g.Date;
g.__recoupTrueDate = TrueDate;
const trueNow: () => number = g.__recoupTrueNow ?? TrueDate.now.bind(TrueDate);
g.__recoupTrueNow = trueNow;
TrueDate.now = () => trueNow() + OFFSET_MS;

class ShiftedDate extends TrueDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(TrueDate.now());
    else super(...(args as [string | number | Date]));
  }
  static override now(): number {
    return TrueDate.now();
  }
}
g.Date = ShiftedDate as unknown as DateConstructor;

beforeEach(() => {
  if (vi.getMockedSystemTime() !== null || vi.isFakeTimers()) return;
  g.Date = ShiftedDate as unknown as DateConstructor;
  const skew = Math.abs(new Date().getTime() - (trueNow() + OFFSET_MS));
  expect(skew, "clock-shift shim not in effect (new Date())").toBeLessThan(60_000);
  expect(Math.abs(Date.now() - trueNow() - OFFSET_MS), "clock-shift shim not in effect (Date.now())").toBeLessThan(60_000);
});
