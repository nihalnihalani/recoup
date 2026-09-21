/**
 * Operator controls and diagnostics (P12, T22). Every export here is
 * internal -- an operator drives these through `npx convex run` with an
 * admin key (`docs/ops/RUNBOOK.md`), never a public client.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { GLOBAL_DAILY_BUDGETS, type GlobalBudgetKind } from "./limits";
import { utcDay } from "./lib/budget";

function assertGlobalBudgetKind(kind: string): asserts kind is GlobalBudgetKind {
  if (!Object.prototype.hasOwnProperty.call(GLOBAL_DAILY_BUDGETS, kind)) {
    throw new ConvexError(
      `Unknown global budget kind: ${kind}. Valid kinds: ${Object.keys(GLOBAL_DAILY_BUDGETS).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// pauseKind / resumeKind (D79)
// ---------------------------------------------------------------------------

/**
 * Operator kill switch (D79): pauses every path that draws from a
 * deployment-wide global budget (`limits.ts`'s `GLOBAL_DAILY_BUDGETS`) by
 * writing today's (UTC) global `usage` row for `kind` up to its max --
 * exactly the row `lib/budget.ts`'s `tryConsumeGlobalBudget`/
 * `consumeGlobalBudget` already read-and-increment, so every caller through
 * `charge`/`tryCharge`/`takeGlobalBudget` sees the switch as exhausted for
 * the rest of the UTC day, the same as if real traffic had used it up.
 * Never lowers an already-higher count (organic usage that happens to sit at
 * or above max is left alone); safe to call more than once.
 */
export const pauseKind = internalMutation({
  args: { kind: v.string() },
  returns: v.object({ day: v.string(), kind: v.string(), count: v.number(), max: v.number() }),
  handler: async (ctx, { kind }) => {
    assertGlobalBudgetKind(kind);
    const day = utcDay(Date.now());
    const max = GLOBAL_DAILY_BUDGETS[kind].max;
    const row = await ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", kind))
      .first();
    if (row) {
      if (row.count < max) await ctx.db.patch(row._id, { count: max });
    } else {
      await ctx.db.insert("usage", { userId: undefined, day, kind, count: max });
    }
    return { day, kind, count: max, max };
  },
});

/**
 * Reverses `pauseKind` (D79): clears today's (UTC) global usage row for
 * `kind` entirely, so the switch reports 0/max again -- NOT the same as
 * setting it to whatever real usage was before the pause (that number was
 * never recorded); a paused switch resumes at zero for the rest of the day.
 * A no-op (not an error) when there is nothing to clear.
 */
export const resumeKind = internalMutation({
  args: { kind: v.string() },
  returns: v.object({ day: v.string(), kind: v.string(), cleared: v.boolean() }),
  handler: async (ctx, { kind }) => {
    assertGlobalBudgetKind(kind);
    const day = utcDay(Date.now());
    const row = await ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", kind))
      .first();
    if (row) await ctx.db.delete(row._id);
    return { day, kind, cleared: row !== null };
  },
});

// ---------------------------------------------------------------------------
// backlog
// ---------------------------------------------------------------------------

/** Rows one indexed count reads before giving up and reporting `truncated: true`. Overridable per call (mainly for tests) via `args.scanLimit`. */
const DEFAULT_SCAN_LIMIT = 2000;

/**
 * Mirrors `market.ts`'s private `MARKET_CLAIM_STALE_MS` (F8/D103: a
 * `queued`/`running` claim older than this is treated as abandoned, almost
 * certainly a crashed or killed `lookup` action rather than one still
 * genuinely in flight -- a real ShopSavvy call times out at 30s). Not
 * exported there, so duplicated here; keep the two in sync if that constant
 * ever changes.
 */
const MARKET_RUNNING_STALE_MS = 15 * 60_000;

const countShape = v.object({
  /** Capped at the scan limit; see `truncated`. */
  count: v.number(),
  /** True when the scan hit its limit before exhausting the underlying rows -- the real count is at least `count`, possibly more. */
  truncated: v.boolean(),
});

function summarize(rowCount: number, limit: number): { count: number; truncated: boolean } {
  return rowCount > limit ? { count: limit, truncated: true } : { count: rowCount, truncated: false };
}

/**
 * A point-in-time read of the signals an operator would otherwise have to
 * piece together from the dashboard by hand (P12: "no service targets or
 * smoke checks"). Every count is bounded by `scanLimit` (default
 * `DEFAULT_SCAN_LIMIT`) and flags `truncated` rather than ever attempting an
 * unbounded scan -- the same discipline the app's own reactive queries use
 * (`insights.ts`'s `truncated` flag, D101).
 */
export const backlog = internalQuery({
  args: { scanLimit: v.optional(v.number()) },
  returns: v.object({
    now: v.number(),
    /** Active watches whose `nextCheckAt` is due but a sweep tick has not yet picked them up (`watches.sweep`, `by_status_nextCheck`). */
    dueWatches: countShape,
    /** Owned items whose `nextCheckAt` is due but a tick has not yet picked them up (`priceWatch.runAll`, `by_nextCheck`). */
    dueItems: countShape,
    /** `processedEvents` rows stuck `failed` (inbound webhook/paste processing that gave up; `intake.retryFailed` retries some of these hourly). */
    processedEventsFailed: countShape,
    /** `mailLog` rows `queued` (component has an outboundId, no confirmed message id yet) -- the hourly mail sweep re-checks these past `nextCheckAt`. */
    mailLogQueued: countShape,
    /** `mailLog` rows `unknown` (reconciliation exhausted its backoff with no message id) -- same sweep, same caveat. */
    mailLogUnknown: countShape,
    /** Watches whose `marketState` is `running` and whose claim (`marketClaimedAt`) is older than `MARKET_RUNNING_STALE_MS` -- almost certainly an abandoned lookup (F8/D103); `market.requestLookup`'s own stale-reclaim only fires on the NEXT `requestLookup` call for that watch, so a watch nobody asks about again can sit here indefinitely until an operator notices. No index on `marketState` exists, so this one scans watches in `_creationTime` order up to `scanLimit` rather than reading an indexed page -- `truncated` here means "more than `scanLimit` watches exist beyond what was scanned", not "more matches exist within the scanned rows". */
    staleMarketRunning: countShape,
  }),
  handler: async (ctx, { scanLimit }) => {
    const limit = scanLimit !== undefined && scanLimit > 0 ? Math.floor(scanLimit) : DEFAULT_SCAN_LIMIT;
    const now = Date.now();

    // Only `active` watches are ever swept (`watches.sweep`); `paused` watches are deliberately excluded from automatic checks.
    const dueWatchRows = await ctx.db
      .query("watches")
      .withIndex("by_status_nextCheck", (q) => q.eq("status", "active").lte("nextCheckAt", now))
      .take(limit + 1);

    const dueItemRows = await ctx.db
      .query("items")
      .withIndex("by_nextCheck", (q) => q.lte("nextCheckAt", now))
      .take(limit + 1);

    const failedEventRows = await ctx.db
      .query("processedEvents")
      .withIndex("by_status", (q) => q.eq("status", "failed"))
      .take(limit + 1);

    const queuedMailRows = await ctx.db
      .query("mailLog")
      .withIndex("by_status_nextCheck", (q) => q.eq("status", "queued"))
      .take(limit + 1);

    const unknownMailRows = await ctx.db
      .query("mailLog")
      .withIndex("by_status_nextCheck", (q) => q.eq("status", "unknown"))
      .take(limit + 1);

    // No index on marketState: bounded table scan, newest first.
    const scannedWatches = await ctx.db.query("watches").order("desc").take(limit);
    const staleMarketCount = scannedWatches.filter(
      (w) => w.marketState === "running" && (w.marketClaimedAt === undefined || now - w.marketClaimedAt >= MARKET_RUNNING_STALE_MS),
    ).length;

    return {
      now,
      dueWatches: summarize(dueWatchRows.length, limit),
      dueItems: summarize(dueItemRows.length, limit),
      processedEventsFailed: summarize(failedEventRows.length, limit),
      mailLogQueued: summarize(queuedMailRows.length, limit),
      mailLogUnknown: summarize(unknownMailRows.length, limit),
      staleMarketRunning: { count: staleMarketCount, truncated: scannedWatches.length >= limit },
    };
  },
});
