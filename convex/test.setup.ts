/// <reference types="vite/client" />
import { afterEach, beforeEach, vi } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test"; // for .schema only
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test"; // for .schema only
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

// D51: several mounted components' own `/test` re-export resolves to an
// empty module map when loaded from here, so any dispatch into them fails
// with "Could not find module". `@agentmail/convex/test`'s glob is
// `"./component/**/!(*.*.*)*.ts"` (meant to skip the `_generated/*.d.ts`
// stubs) but that extglob negation is not honored by Vite's `import.meta.glob`
// matcher, so it silently matches nothing at all — not even `lib.ts` — which
// is why `sendMessage`/`onEvent` dispatch previously failed here (documented
// at drafts.test.ts:402-437) even though the file-level comment blamed a
// dist-vs-src split. `@convex-dev/rate-limiter`'s package `exports` block
// only exposes deep `src/…` paths through `/test`, and its nested
// `@convex-dev/batch-worker` component is not auto-registered by convex-test
// at all. The fix for all of them is the same: glob each component's `src/`
// tree directly out of node_modules with a plain `**/*.ts` pattern.
// `{ exhaustive: true }` is required for `import.meta.glob` to walk into
// node_modules at all when the glob call itself lives outside the package
// (unlike `workpool.modules`/`rl.modules`, whose own glob is evaluated from
// inside the package and needs no such flag — `@convex-dev/workpool`'s plain
// `**/*.ts` glob is not affected by the extglob bug and works as shipped, but
// it is nested twice under "agentmail" here, so it is re-globbed the same way
// for consistency and to rule out any evaluation-site difference). Every
// component ships `_generated/*.ts` alongside its real modules so
// convex-test's root-prefix inference has something to anchor on.
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

export function setup() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest(schema, modules);
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}

/** Inserts a user row and returns an identity-bound handle (getAuthUserId parses `subject.split("|")[0]`). */
export async function signedIn(t: ReturnType<typeof setup>, name = "Tester") {
  const userId: Id<"users"> = await t.run(async (ctx) => ctx.db.insert("users", { name }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

// ---------------------------------------------------------------------------
// M08 helpers (additive; the exports above keep their signatures)
// ---------------------------------------------------------------------------

export type SignedInUser = Awaited<ReturnType<typeof signedIn>>;

/**
 * Two independent signed-in users for two-user isolation tests: `owner` owns
 * the rows under test; `other` is the foreign caller whose every read and
 * write must be refused with the same error as a missing id. Each is
 * `{ userId, as }` exactly as `signedIn` returns. Names default to
 * "Owner"/"Other" so assertion messages say which side leaked.
 */
export async function twoUsers(
  t: Parameters<typeof signedIn>[0],
  names: readonly [string, string] = ["Owner", "Other"],
): Promise<{ owner: SignedInUser; other: SignedInUser }> {
  const owner = await signedIn(t, names[0]);
  const other = await signedIn(t, names[1]);
  return { owner, other };
}

/** What `pinClock` fakes: the clock and the timers convex-test's scheduler uses, never `performance` (KX3). */
export const CLOCK_AND_TIMERS: NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"] = [
  "Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate",
];

/**
 * Pins the wall clock at `at` (`Date.now()`, `new Date()`), the D138/M04 pattern, and fakes the timers with it
 * (KX3, D233). Returns the restore function.
 *
 * Use it whenever a test passes a FIXED time to code that compares it with
 * the server clock. Every public query taking `now` validates it with
 * `watches.assertCoarseNow` (±24 h of `Date.now()`), so `{ now: Date.UTC(…) }`
 * without a pin passes on the day it was written and fails the next day
 * (D138). `convex/testing/clockPins.test.ts` fails on any such unpinned call.
 *
 * Why the timers too (M25, KX3): with only `Date` faked, convex-test fires a `runAfter(0)` job on a REAL timer in the
 * background, where it can join the test's own mutation and fail intermittently ("Write outside of transaction",
 * D233). With the timers faked, scheduled work runs only when the test flushes it
 * (`t.finishAllScheduledFunctions(vi.runAllTimers)`). `performance` stays real, so measured `ms` stay real. (The M08
 * worry that faked timers starve a nested `ctx.runQuery` inside `t.run` no longer holds on convex-test 0.0.59: the
 * read-budget measurements are non-zero with timers faked.) `convex/testing/kx3Guard.setup.ts` fails any test that
 * fakes or mocks only `Date` while the code under test schedules short-delay work.
 *
 * The pinned clock is frozen: it moves only with `vi.setSystemTime(later)` or
 * `vi.advanceTimersByTime(ms)`. convex-test stamps `_creationTime` from this
 * clock but keeps it monotonic, so moving the clock BACKWARD after inserting
 * rows is clamped (QA-15).
 */
export function pinClock(at: number | Date): () => void {
  vi.useFakeTimers({ toFake: CLOCK_AND_TIMERS });
  vi.setSystemTime(at);
  return () => {
    vi.useRealTimers();
  };
}

/**
 * `pinClock` for a whole `describe` block (or file): pins before each test
 * and restores after it. Call it at the top of the block:
 *
 *   describe("overview at a fixed instant", () => {
 *     const NOW = Date.UTC(2026, 8, 21, 12);
 *     pinClockEach(NOW);
 *     it("…", async () => { await as.query(api.tracking.overview, { now: NOW }); });
 *   });
 */
export function pinClockEach(at: number | Date): void {
  let restore: (() => void) | undefined;
  beforeEach(() => {
    restore = pinClock(at);
  });
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
}
