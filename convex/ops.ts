/**
 * Operator controls and diagnostics (P12, T22). Every export here is
 * internal -- an operator drives these through `npx convex run` with an
 * admin key (`docs/ops/RUNBOOK.md`), never a public client.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { GLOBAL_DAILY_BUDGETS, MARKET_CLAIM_STALE_MS, type GlobalBudgetKind } from "./limits";
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

const countShape = v.object({
  /** Capped at the scan limit; see `truncated`. */
  count: v.number(),
  /** True when the scan hit its limit before exhausting the underlying rows -- the real count is at least `count`, possibly more. */
  truncated: v.boolean(),
});

function summarize(rowCount: number, limit: number): { count: number; truncated: boolean } {
  return rowCount > limit ? { count: limit, truncated: true } : { count: rowCount, truncated: false };
}

// ---------------------------------------------------------------------------
// retention cursor diagnostic (D112 RUNBOOK/ops item, T24b)
// ---------------------------------------------------------------------------

/** The `opsState` key `retention.ts`'s resumable sweep keeps its cursor under. */
const RETENTION_OPS_KEY = "retention";

/**
 * Mirrors `retention.ts`'s private `STEPS` cycle order and `Cursor` shape
 * (`{ step, page }` JSON in the opsState row's `cursor` string field) --
 * ops.ts does not own `retention.ts` in this task, so this is a deliberate,
 * documented, read-only duplicate (the same shape as this file's own
 * pre-T24b duplicate of `market.ts`'s stale-claim threshold, which F-T22-2
 * above replaced with a shared import; there is no equivalent shared export
 * to import here). Keep this in sync if `retention.ts`'s `STEPS` or cursor
 * JSON shape ever changes.
 */
const RETENTION_STEPS = ["processedEvents", "watchChecks", "priceChecks", "offerChecks", "mailLog", "opsState", "users"] as const;

/** Longer than the daily cron cadence (D110) with real margin, so the normal idle gap between one
 * cycle finishing and the next day's cron starting is never itself mistaken for a stall. */
const RETENTION_STALL_MS = 48 * 60 * 60_000;

function parseRetentionCursor(raw: string | undefined): { step: number; page: string | null } {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { step?: unknown; page?: unknown };
      if (
        typeof parsed.step === "number" &&
        Number.isInteger(parsed.step) &&
        parsed.step >= 0 &&
        parsed.step < RETENTION_STEPS.length
      ) {
        return { step: parsed.step, page: typeof parsed.page === "string" ? parsed.page : null };
      }
    } catch {
      // Malformed/foreign cursor value: same fallback as retention.ts's own `parseCursor`.
    }
  }
  return { step: 0, page: null };
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
    /** Watches whose `marketState` is `running` and whose claim (`marketClaimedAt`) is older than `MARKET_CLAIM_STALE_MS` (limits.ts, shared with `market.ts`'s own reclaim, F-T22-2) -- almost certainly an abandoned lookup (F8/D103); `market.requestLookup`'s own stale-reclaim only fires on the NEXT `requestLookup` call for that watch, so a watch nobody asks about again can sit here indefinitely until an operator notices. No index on `marketState` exists, so this one scans watches in `_creationTime` order up to `scanLimit` rather than reading an indexed page -- `truncated` here means "more than `scanLimit` watches exist beyond what was scanned", not "more matches exist within the scanned rows". */
    staleMarketRunning: countShape,
    /**
     * D112: read from the `retention` opsState row `retention.ts`'s resumable sweep maintains.
     * `rule` names the table/step the cursor currently sits at (`RETENTION_STEPS[cursor.step]`);
     * `cursorAgeMs` is how long ago that row was last patched (0 when the sweep has never run at
     * all); `stalled` is true when the cursor is mid-cycle (not sitting at the idle "just started
     * or just completed a full cycle" position) AND has not advanced in over `RETENTION_STALL_MS`
     * -- a healthy sweep self-reschedules on every page, so a real multi-day gap while mid-cycle
     * means something (most likely a poison page an item on it keeps throwing on) stopped it.
     */
    retention: v.object({ rule: v.string(), cursorAgeMs: v.number(), stalled: v.boolean() }),
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
      (w) => w.marketState === "running" && (w.marketClaimedAt === undefined || now - w.marketClaimedAt >= MARKET_CLAIM_STALE_MS),
    ).length;

    const retentionRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", RETENTION_OPS_KEY))
      .unique();
    const retentionCursor = parseRetentionCursor(retentionRow?.cursor);
    const retentionCursorAgeMs = retentionRow ? now - retentionRow.updatedAt : 0;
    const retentionMidCycle = retentionCursor.step !== 0 || retentionCursor.page !== null;

    return {
      now,
      dueWatches: summarize(dueWatchRows.length, limit),
      dueItems: summarize(dueItemRows.length, limit),
      processedEventsFailed: summarize(failedEventRows.length, limit),
      mailLogQueued: summarize(queuedMailRows.length, limit),
      mailLogUnknown: summarize(unknownMailRows.length, limit),
      staleMarketRunning: { count: staleMarketCount, truncated: scannedWatches.length >= limit },
      retention: {
        rule: RETENTION_STEPS[retentionCursor.step],
        cursorAgeMs: retentionCursorAgeMs,
        stalled: retentionMidCycle && retentionCursorAgeMs > RETENTION_STALL_MS,
      },
    };
  },
});
