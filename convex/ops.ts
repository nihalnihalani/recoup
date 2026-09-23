/**
 * Operator controls and diagnostics (P12, T22; M1B for C58). Every registered
 * function here is internal. An operator drives them through
 * `npx convex run` with an admin key (`docs/ops/RUNBOOK.md`), never from a
 * public client; `ops.test.ts` fails if any export becomes public.
 *
 * M1B adds:
 *  - `setFlag`, `getFlag` and `flagAudit`, over `lib/flags.ts`. `setFlag`
 *    is the ONLY flag writer, and it refuses to enable an approval-gated flag
 *    (`live_document_extraction`, D145) without an `approvalRef` naming the
 *    DECISIONS entry that records the user's approval.
 *  - `recordRuleEvaluationFailure(ctx, …)`, a plain helper M12's
 *    `recordEvaluation` catch path calls. It keeps per-UTC-day `opsState`
 *    counters and writes a redacted `rule_evaluation_failed` line.
 *  - `staleSourcePacks(packs, verification, now)`, pure: verification
 *    records against refresh windows.
 *  - `backlog` fields `asOf`, `flags`, `ruleEvaluationFailures`,
 *    `staleSources`, `extraction`, `orphanSweep` and `recoveryRetention`,
 *    all computed at the `now` argument.
 *
 * M29 (C58) adds:
 *  - `ruleSourceInputs()` is WIRED: the production registry's active packs,
 *    their sources' refresh windows and mandatory review dates (the manifest's
 *    `refreshDays` / `mandatoryReviewBy`, mirrored in each pack's `sources` and
 *    checked equal by ops.m29.test.ts) against the lead-owned
 *    `lib/rules/verification.ts`, at the coarse `asOf`.
 *  - `backlog` fields `deadlineSweep` (the M29 cron's last page and its age),
 *    `reevaluateDue` (not-yet-due paths waiting for their re-evaluation date)
 *    and `userDeadlinesSoon` (running user deadlines inside the attention
 *    window), each bounded by `scanLimit`.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { GLOBAL_DAILY_BUDGETS, MARKET_CLAIM_STALE_MS, type GlobalBudgetKind } from "./limits";
import { utcDay } from "./lib/budget";
import {
  FLAGS,
  FLAG_NAMES,
  flagAuditKey,
  flagAuditPrefix,
  flagAuditPrefixEnd,
  flagAuditSeq,
  flagKey,
  flagNameValidator,
  flagRow,
  flagStateValidator,
  normalizeApprovalRef,
  readFlag,
} from "./lib/flags";
import { logEvent } from "./lib/log";
import { activePacks } from "./lib/rules/registry";
import { VERIFICATION } from "./lib/rules/verification";
import type { AnyRulePack } from "./lib/rules/types";
import { DEADLINE_ATTENTION_LEAD_MS, DEADLINE_SWEEP_OPS_KEY, parseSweepRecord } from "./deadlines";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

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
/** M29: the backlog's opportunity counts (`reevaluateDue`, `userDeadlinesSoon`) read at most this many rows per range. */
export const OPPORTUNITY_SCAN_CAP = 500;

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
// M1B: rule-evaluation failure counters (P12/C58)
// ---------------------------------------------------------------------------

/** `opsState` key prefix of the per-UTC-day counter rows: `ruleEvalFailures:YYYY-MM-DD`. */
const RULE_EVAL_FAILURES_PREFIX = "ruleEvalFailures:";
/** Distinct `ruleId@version` labels kept per day (and in `backlog`'s merged view); the rest fold into `"other"`. */
const MAX_RULE_LABELS = 32;
const MAX_RULE_ID_CHARS = 100;
/** Days `backlog.ruleEvaluationFailures` covers, ending at (and including) `asOf`'s UTC day. */
const RULE_FAILURE_WINDOW_DAYS = 7;

/**
 * What M12's `recordEvaluation` catch path passes to
 * `recordRuleEvaluationFailure`. Every field is sanitized, never trusted.
 */
export type RuleEvaluationFailure = {
  /** The mutation's clock (`Date.now()` in the calling mutation). A non-finite value falls back to `Date.now()`. */
  now: number;
  scenarioId: string;
  ruleId: string;
  ruleVersion: number;
  /** Whatever was caught. It reaches only the redacted log line, never the database. */
  error: unknown;
  trigger?: string;
  transactionId?: Id<"transactions">;
  opportunityId?: Id<"opportunities">;
};

type FailureCounter = { count: number; byRule: Record<string, number>; lastAt: number | null };

function stripControl(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? stripControl(value).slice(0, max) : "";
}

function ruleLabel(ruleId: unknown, ruleVersion: unknown): string {
  const id = boundedText(ruleId, MAX_RULE_ID_CHARS) || "unknown";
  const version = typeof ruleVersion === "number" && Number.isInteger(ruleVersion) && ruleVersion >= 0 ? String(ruleVersion) : "?";
  return `${id}@${version}`;
}

function parseFailureCounter(cursor: string | undefined): FailureCounter {
  const empty: FailureCounter = { count: 0, byRule: {}, lastAt: null };
  if (cursor === undefined) return empty;
  try {
    const parsed = JSON.parse(cursor) as { count?: unknown; byRule?: unknown; lastAt?: unknown };
    if (typeof parsed !== "object" || parsed === null || typeof parsed.count !== "number" || !Number.isFinite(parsed.count)) return empty;
    const byRule: Record<string, number> = {};
    if (typeof parsed.byRule === "object" && parsed.byRule !== null && !Array.isArray(parsed.byRule)) {
      for (const [label, n] of Object.entries(parsed.byRule as Record<string, unknown>)) {
        if (typeof n === "number" && Number.isFinite(n) && n > 0) byRule[label] = n;
      }
    }
    return {
      count: Math.max(0, parsed.count),
      byRule,
      lastAt: typeof parsed.lastAt === "number" && Number.isFinite(parsed.lastAt) ? parsed.lastAt : null,
    };
  } catch {
    return empty;
  }
}

function failureCounterKey(day: string): string {
  return `${RULE_EVAL_FAILURES_PREFIX}${day}`;
}

/**
 * **API for M12.** Call this in the `catch` of `recordEvaluation` (or of
 * `evaluateTransaction`'s per-scenario loop) when evaluating one rule throws:
 *
 * ```ts
 * import { recordRuleEvaluationFailure } from "./ops";
 * try {
 *   result = evaluate(pack, snapshot, now);
 * } catch (error) {
 *   await recordRuleEvaluationFailure(ctx, { now, scenarioId, ruleId: pack.ruleId, ruleVersion: pack.version, error, trigger, transactionId });
 *   continue; // or return a manual_review result -- but do NOT rethrow
 * }
 * ```
 *
 * It (1) writes one redacted `rule_evaluation_failed` log line through
 * `logEvent`, carrying the caught error, and (2) increments the per-UTC-day
 * counter row `ruleEvalFailures:<YYYY-MM-DD>` in `opsState`. That row holds
 * `{ count, byRule: { "<ruleId>@<version>": n }, lastAt }`, with at most 32
 * labels and the rest in `"other"`. `ops.backlog.ruleEvaluationFailures`
 * reads it.
 *
 * - **It never throws.** It is built for a catch path, so every input is
 *   sanitized and any internal failure is swallowed after one log attempt.
 * - **The counter is part of the calling transaction.** If the caller
 *   rethrows, the mutation rolls back and the count is lost (the log line
 *   survives). Record, then continue or return.
 * - **Nothing personal is stored.** The counter holds only labels and
 *   counts. The error reaches only the redacted log line.
 * - **One hot row per day.** Concurrent failures on the same day conflict
 *   and retry under OCC. That is acceptable because failures are rare by
 *   construction.
 */
export async function recordRuleEvaluationFailure(ctx: MutationCtx, input: RuleEvaluationFailure): Promise<void> {
  try {
    const at = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
    const day = utcDay(at);
    const label = ruleLabel(input.ruleId, input.ruleVersion);
    logEvent("rule_evaluation_failed", {
      day,
      scenarioId: boundedText(input.scenarioId, 8),
      ruleId: boundedText(input.ruleId, MAX_RULE_ID_CHARS),
      ruleVersion: typeof input.ruleVersion === "number" && Number.isFinite(input.ruleVersion) ? input.ruleVersion : null,
      trigger: input.trigger === undefined ? undefined : boundedText(input.trigger, 40),
      transactionId: input.transactionId,
      opportunityId: input.opportunityId,
      error: input.error,
    });

    const key = failureCounterKey(day);
    const row = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .first();
    const counter = parseFailureCounter(row?.cursor);
    counter.count += 1;
    const labelled = Object.keys(counter.byRule).filter((l) => l !== "other").length;
    const slot = label in counter.byRule || labelled < MAX_RULE_LABELS ? label : "other";
    counter.byRule[slot] = (counter.byRule[slot] ?? 0) + 1;
    counter.lastAt = counter.lastAt === null ? at : Math.max(counter.lastAt, at);
    const cursor = JSON.stringify(counter);
    if (row) await ctx.db.patch(row._id, { cursor, updatedAt: at });
    else await ctx.db.insert("opsState", { key, cursor, updatedAt: at });
  } catch (error) {
    try {
      logEvent("rule_evaluation_failed", { stage: "failure_counter_write", error });
    } catch {
      // Nothing left to do; never throw from a catch path.
    }
  }
}

const ruleEvaluationFailuresShape = v.object({
  windowDays: v.number(),
  total: v.number(),
  /** One entry per UTC day, newest (asOf's day) first. */
  days: v.array(v.object({ day: v.string(), count: v.number() })),
  /** `ruleId@version` labels across the window, most failures first; at most 32 plus `"other"`. */
  byRule: v.array(v.object({ rule: v.string(), count: v.number() })),
  lastAt: v.union(v.number(), v.null()),
});

/** Bounded: exactly `RULE_FAILURE_WINDOW_DAYS` indexed point reads. */
async function readRuleEvaluationFailures(ctx: Pick<QueryCtx, "db">, asOf: number) {
  const days: Array<{ day: string; count: number }> = [];
  const merged = new Map<string, number>();
  let lastAt: number | null = null;
  for (let i = 0; i < RULE_FAILURE_WINDOW_DAYS; i++) {
    const day = utcDay(asOf - i * DAY_MS);
    const row = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", failureCounterKey(day)))
      .first();
    const counter = parseFailureCounter(row?.cursor);
    days.push({ day, count: counter.count });
    for (const [label, n] of Object.entries(counter.byRule)) merged.set(label, (merged.get(label) ?? 0) + n);
    if (counter.lastAt !== null) lastAt = lastAt === null ? counter.lastAt : Math.max(lastAt, counter.lastAt);
  }
  const sorted = [...merged.entries()]
    .filter(([label]) => label !== "other")
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const byRule = sorted.slice(0, MAX_RULE_LABELS).map(([rule, count]) => ({ rule, count }));
  const folded = sorted.slice(MAX_RULE_LABELS).reduce((sum, [, n]) => sum + n, 0) + (merged.get("other") ?? 0);
  if (folded > 0) byRule.push({ rule: "other", count: folded });
  return {
    windowDays: RULE_FAILURE_WINDOW_DAYS,
    total: days.reduce((sum, d) => sum + d.count, 0),
    days,
    byRule,
    lastAt,
  };
}

// ---------------------------------------------------------------------------
// M1B: stale-source packs (README rule 3; contract §2.7 "Refresh and staleness")
// ---------------------------------------------------------------------------

/** One active pack's refresh window and pinned sources (manifest `refreshDays` + `sources`). */
export type RuleSourceWindow = {
  ruleId: string;
  version: number;
  refreshDays: number;
  sourceIds: readonly string[];
  /**
   * M29 (D234 E5, as `lib/rules/outcome.sourceStale`): per source, the manifest's mandatory review date
   * "YYYY-MM-DD". From that date (UTC) a source is stale until a verification dated on or after it; an unreadable date
   * fails closed (stale).
   */
  mandatoryReviewBy?: Readonly<Record<string, string>>;
};

/**
 * `lib/rules/verification.ts`'s shape (lead-owned): per `sourceId`, when it
 * was last verified. The value is a date-only `"YYYY-MM-DD"` string (read as
 * UTC midnight, the conservative end of that day), an ISO instant, or epoch ms.
 */
export type SourceVerification = Readonly<Record<string, { readonly lastVerifiedAt: string | number }>>;

export type StaleSourceStatus = "never_verified" | "stale" | "due_soon";

export type StaleSourcePack = {
  ruleId: string;
  version: number;
  refreshDays: number;
  status: StaleSourceStatus;
  /** The earliest window end among the pack's verified sources; `null` when none is verified or the window is unusable. */
  windowEndsAt: number | null;
  /** The pack's sources that are not fresh. */
  sourceIds: string[];
};

const staleSourcePackShape = v.object({
  ruleId: v.string(),
  version: v.number(),
  refreshDays: v.number(),
  status: v.union(v.literal("never_verified"), v.literal("stale"), v.literal("due_soon")),
  windowEndsAt: v.union(v.number(), v.null()),
  sourceIds: v.array(v.string()),
});

/** "Due soon" starts this many days before a window ends, capped at a quarter of the window, so a 7-day window warns 1.75 days out. */
const DUE_SOON_MAX_DAYS = 7;
const SEVERITY: Record<StaleSourceStatus | "fresh", number> = { never_verified: 3, stale: 2, due_soon: 1, fresh: 0 };

function verifiedAtMs(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Pure. Lists the packs that need the lead's `scripts/verify-rule-sources.mjs`
 * run, most urgent first (never_verified, stale, due_soon, then ruleId).
 * Packs whose sources are all fresh are omitted.
 *
 * - **never_verified:** a pinned source has no verification record, or an
 *   unparsable one (README rule 8: no current source record means
 *   `source_unverified`).
 * - **stale:** `now > lastVerifiedAt + refreshDays days`. An evaluation now
 *   returns `source_unverified` (`sourceStale`). A pack without a usable
 *   (positive, finite) window can never be shown fresh, so it is stale too.
 * - **due_soon:** inside the last `min(7, refreshDays / 4)` days of the
 *   window. Exactly at the window end is still due_soon, not stale.
 *
 * `now` should be coarse (`backlog` passes `asOf`). M12's `sourceStale`
 * uses the same boundary, `now > lastVerifiedAt + refreshDays days`.
 */
export function staleSourcePacks(
  packs: readonly RuleSourceWindow[],
  verification: SourceVerification,
  now: number,
): StaleSourcePack[] {
  const out: StaleSourcePack[] = [];
  for (const pack of packs) {
    const windowMs = pack.refreshDays * DAY_MS;
    if (!(Number.isFinite(windowMs) && windowMs > 0)) {
      out.push({ ruleId: pack.ruleId, version: pack.version, refreshDays: pack.refreshDays, status: "stale", windowEndsAt: null, sourceIds: [...pack.sourceIds] });
      continue;
    }
    const dueSoonMs = Math.min(DUE_SOON_MAX_DAYS * DAY_MS, windowMs / 4);
    let worst: StaleSourceStatus | "fresh" = "fresh";
    let windowEndsAt: number | null = null;
    const lapsed: string[] = [];
    for (const sourceId of pack.sourceIds) {
      const record = Object.prototype.hasOwnProperty.call(verification, sourceId) ? verification[sourceId] : undefined;
      const verifiedAt = verifiedAtMs(record?.lastVerifiedAt);
      let status: StaleSourceStatus | "fresh";
      if (verifiedAt === null) {
        status = "never_verified";
      } else {
        const end = verifiedAt + windowMs;
        windowEndsAt = windowEndsAt === null ? end : Math.min(windowEndsAt, end);
        status = now > end ? "stale" : now > end - dueSoonMs ? "due_soon" : "fresh";
      }
      // M29 (D234 E5): a mandatory review date not yet covered by a verification on or after it.
      const reviewRaw = pack.mandatoryReviewBy && Object.prototype.hasOwnProperty.call(pack.mandatoryReviewBy, sourceId)
        ? pack.mandatoryReviewBy[sourceId]
        : undefined;
      if (reviewRaw !== undefined && status !== "never_verified") {
        const reviewBy = Date.parse(`${reviewRaw}T00:00:00Z`);
        if (!Number.isFinite(reviewBy)) {
          status = "stale";
        } else if (!(verifiedAt !== null && verifiedAt >= reviewBy)) {
          windowEndsAt = windowEndsAt === null ? reviewBy : Math.min(windowEndsAt, reviewBy);
          const reviewStatus: StaleSourceStatus | "fresh" = now >= reviewBy ? "stale" : now > reviewBy - dueSoonMs ? "due_soon" : "fresh";
          if (SEVERITY[reviewStatus] > SEVERITY[status]) status = reviewStatus;
        }
      }
      if (status !== "fresh") lapsed.push(sourceId);
      if (SEVERITY[status] > SEVERITY[worst]) worst = status;
    }
    if (worst !== "fresh") {
      out.push({ ruleId: pack.ruleId, version: pack.version, refreshDays: pack.refreshDays, status: worst, windowEndsAt, sourceIds: lapsed });
    }
  }
  return out.sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || a.ruleId.localeCompare(b.ruleId) || a.version - b.version);
}

/**
 * Pure (M29, C58): the refresh windows of `packs` as `staleSourcePacks` reads them — one entry per (pack, refresh
 * window), from each source's `refreshWindowDays` and `mandatoryReviewBy` (the manifest's `refreshDays` /
 * `mandatoryReviewBy`, which every pack mirrors; ops.m29.test.ts checks them equal). A pack with no windowed source
 * (R01 v1: its parameter source is the per-purchase policy snapshot, D145 d) is listed in `withoutWindow` instead —
 * it can never go stale here, exactly as `lib/rules/outcome.sourceStale` never makes it `source_unverified`.
 */
export function ruleSourceWindows(
  packs: readonly Pick<AnyRulePack, "ruleId" | "version" | "sources">[],
): { windows: RuleSourceWindow[]; withoutWindow: string[] } {
  const windows: RuleSourceWindow[] = [];
  const withoutWindow: string[] = [];
  for (const pack of packs) {
    const byDays = new Map<number, { sourceIds: string[]; mandatoryReviewBy: Record<string, string> }>();
    for (const s of pack.sources) {
      if (s.refreshWindowDays === undefined) continue;
      const group = byDays.get(s.refreshWindowDays) ?? { sourceIds: [], mandatoryReviewBy: {} };
      if (!group.sourceIds.includes(s.sourceId)) group.sourceIds.push(s.sourceId);
      if (s.mandatoryReviewBy !== undefined) group.mandatoryReviewBy[s.sourceId] = s.mandatoryReviewBy;
      byDays.set(s.refreshWindowDays, group);
    }
    if (byDays.size === 0) {
      withoutWindow.push(`${pack.ruleId}@v${pack.version}`);
      continue;
    }
    for (const [refreshDays, g] of [...byDays.entries()].sort((a, b) => a[0] - b[0])) {
      windows.push({
        ruleId: pack.ruleId, version: pack.version, refreshDays, sourceIds: g.sourceIds,
        ...(Object.keys(g.mandatoryReviewBy).length > 0 ? { mandatoryReviewBy: g.mandatoryReviewBy } : {}),
      });
    }
  }
  return { windows, withoutWindow };
}

/**
 * The stale-source diagnostic's inputs (M29 wires them; the wave-1 acceptance, D237, flagged `wired: false`): the
 * PRODUCTION registry's active packs (`activation.ts`) and the lead-owned `verification.ts`. `backlog` evaluates them at
 * its coarse `asOf`.
 */
function ruleSourceInputs(): { wired: boolean; packs: RuleSourceWindow[]; withoutWindow: string[]; verification: SourceVerification } {
  const { windows, withoutWindow } = ruleSourceWindows(activePacks());
  return { wired: true, packs: windows, withoutWindow, verification: VERIFICATION };
}

// ---------------------------------------------------------------------------
// M1B: orphan-sweep cursor age (SEC-UP-7; M14 writes the row)
// ---------------------------------------------------------------------------

/**
 * `opsState` keys whose `updatedAt` M14's sweeps patch on every page, the
 * cycle-completing page included. Each row is absent before its first run.
 * Confirmed with M14. They equal `retention.ts`'s exported
 * `ORPHAN_SWEEP_OPS_KEY` / `RECOVERY_RETENTION_OPS_KEY`: switch to importing
 * those once M14 has landed (they do not exist on main yet). Only the age is
 * read; the cursor JSON is never parsed here.
 */
const ORPHAN_SWEEP_OPS_KEY = "orphanSweep";
const RECOVERY_RETENTION_OPS_KEY = "retentionRecovery";

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
  args: {
    scanLimit: v.optional(v.number()),
    /**
     * M1B: the instant to report at. Pass it. Queries must not read the wall
     * clock (guidelines; mission P06). If it is omitted, `Date.now()` is used
     * once, which is kept only so a one-shot `npx convex run ops:backlog` and
     * pre-M1B callers still work. Every M1B section is computed at this value
     * (`asOf` is it floored to the hour), never at the server clock.
     */
    now: v.optional(v.number()),
  },
  returns: v.object({
    now: v.number(),
    /** M1B: `now` floored to the hour, the coarse instant the stale-source and rule-failure sections use. */
    asOf: v.number(),
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
    /**
     * T18.5 (D124 B6): `account.stuckDeletions`'s own read, wired in here so
     * an operator sees account-deletion health alongside every other
     * backlog signal instead of having to run a second `npx convex run`.
     * `stuck` is `deleting` for over `STUCK_DELETION_AGE_MS` with no live
     * scheduled `purge` job (the daily `reDriveStuckDeletions` cron will
     * pick these up on its own within 24h; a persistently nonzero count
     * across repeated `backlog` calls means that cron itself is not
     * running, not that any one row is unrecoverable). `deletingTotal` is
     * every `deleting` row currently scanned (bounded the same way
     * `stuckDeletions` itself bounds its scan, `STUCK_SCAN_CAP` in
     * `account.ts`) -- most of it is ordinary in-flight purge, not stuck.
     */
    deletions: v.object({ stuck: v.number(), deletingTotal: v.number() }),
    /** M1B (D145): every flag's effective state, in `FLAG_NAMES` order, including `live_document_extraction` and its `approvalRef`. `invalid` marks a row that reads as OFF because it was not written by `setFlag`. */
    flags: v.array(flagStateValidator),
    /** M1B (P12/C58): `recordEvaluation` failures from the per-UTC-day counters, over the `windowDays` days ending at `asOf` (newest first). */
    ruleEvaluationFailures: ruleEvaluationFailuresShape,
    /**
     * M1B (P12/C58, README rule 3): active packs whose sources are past, or
     * within 7 days of, their refresh window at `asOf`. `inputsWired` is
     * false until the production registry (M12) and
     * `lib/rules/verification.ts` (lead) exist and are wired in
     * `ruleSourceInputs`. Until then nothing is checked, and this says so
     * instead of reporting "all fresh".
     */
    staleSources: v.object({
      asOf: v.number(),
      inputsWired: v.boolean(),
      checkedPacks: v.number(),
      packs: v.array(staleSourcePackShape),
      /** M29: active packs with no refresh-windowed source (`ruleId@vN`, e.g. R01 v1) — never stale by design, listed so "not checked" is visible. */
      withoutRefreshWindow: v.array(v.string()),
    }),
    /**
     * M1B (DA-A-8, D145): evidence waiting on the user (`awaiting_doc_type`, which is never extracted),
     * pending extraction (`queued`, `running`) and `failed`. Each is bounded like every other count.
     */
    extraction: v.object({ awaitingDocType: countShape, queued: countShape, running: countShape, failed: countShape }),
    /** M1B (SEC-UP-7): age of the orphan-blob sweep's `opsState` row (`ORPHAN_SWEEP_OPS_KEY`), `null` before its first run. */
    orphanSweep: v.object({ ageMs: v.union(v.number(), v.null()) }),
    /** M1B (DA-A-7): age of the evidence/evaluation retention sweep's `opsState` row (`RECOVERY_RETENTION_OPS_KEY`), `null` before its first run. The older `retention` field above is the pre-wave-1 sweep. */
    recoveryRetention: v.object({ ageMs: v.union(v.number(), v.null()) }),
    /**
     * M29 (C50/C58): the hourly deadline sweep's `opsState` row (`deadlines.DEADLINE_SWEEP_OPS_KEY`). `ageMs` is `null`
     * before its first run; a value well past an hour means the cron is not running. `lastCycle` is the latest cycle's
     * running totals (`reevaluated` null and `reevaluateFailed` true when the re-evaluation page rolled back).
     */
    deadlineSweep: v.object({
      ageMs: v.union(v.number(), v.null()),
      lastCycle: v.union(
        v.null(),
        v.object({
          cycleNow: v.number(), phase: v.union(v.literal("open"), v.literal("case_open"), v.literal("reconcile")), scanned: v.number(),
          scheduled: v.number(), reconciled: v.number(), reevaluated: v.union(v.number(), v.null()), reevaluateFailed: v.boolean(),
          done: v.boolean(),
        }),
      ),
    }),
    /** M29 (rev 5.2): `open` not-yet-due opportunities whose `reevaluateAt` ≤ `now` (waiting for the sweep's re-evaluation page). Capped at `min(scanLimit, OPPORTUNITY_SCAN_CAP)`. */
    reevaluateDue: countShape,
    /** M29 (C50): `open` + `case_open` opportunities whose next USER deadline falls in (now, now + the attention window]. Each status capped at `min(scanLimit, OPPORTUNITY_SCAN_CAP)`. */
    userDeadlinesSoon: countShape,
  }),
  handler: async (ctx, { scanLimit, now: nowArg }) => {
    const limit = scanLimit !== undefined && scanLimit > 0 ? Math.floor(scanLimit) : DEFAULT_SCAN_LIMIT;
    if (nowArg !== undefined && !Number.isFinite(nowArg)) throw new ConvexError("now must be a finite epoch-ms time");
    const now = nowArg ?? Date.now();
    const asOf = Math.floor(now / HOUR_MS) * HOUR_MS;

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

    // Explicit type: `ops.backlog`'s own handler return type would otherwise
    // be inferred circularly through `internal`'s full api type (which
    // includes `ops.backlog` itself) the moment a handler calls
    // `ctx.runQuery(internal.<anything>, …)` without an explicit annotation
    // somewhere in the chain -- the same fix `drafts.generate` needed after
    // T18.5 (D124 B5) for the identical reason.
    const deletions: { stuck: number; deleting: number } = await ctx.runQuery(internal.account.stuckDeletions, {});

    // ---- M1B ----
    const flags = [];
    for (const name of FLAG_NAMES) flags.push(await readFlag(ctx, name));

    const ruleEvaluationFailures = await readRuleEvaluationFailures(ctx, asOf);

    const sourceInputs = ruleSourceInputs();
    const staleSources = {
      asOf,
      inputsWired: sourceInputs.wired,
      checkedPacks: sourceInputs.packs.length,
      packs: staleSourcePacks(sourceInputs.packs, sourceInputs.verification, asOf),
      withoutRefreshWindow: sourceInputs.withoutWindow,
    };

    const countExtraction = async (status: "awaiting_doc_type" | "queued" | "running" | "failed") => {
      const rows = await ctx.db
        .query("evidence")
        .withIndex("by_extraction_status_and_extraction_started_at", (q) => q.eq("extractionStatus", status))
        .take(limit + 1);
      return summarize(rows.length, limit);
    };
    const extraction = {
      awaitingDocType: await countExtraction("awaiting_doc_type"),
      queued: await countExtraction("queued"),
      running: await countExtraction("running"),
      failed: await countExtraction("failed"),
    };

    const sweepAge = async (key: string) => {
      const row = await ctx.db
        .query("opsState")
        .withIndex("by_key", (q) => q.eq("key", key))
        .first();
      return { ageMs: row ? now - row.updatedAt : null };
    };
    const orphanSweep = await sweepAge(ORPHAN_SWEEP_OPS_KEY);
    const recoveryRetention = await sweepAge(RECOVERY_RETENTION_OPS_KEY);

    // ---- M29 ---- (opportunity counts capped at OPPORTUNITY_SCAN_CAP, below `limit`: the rows are larger than the
    // other sections' and three ranges are read; measured at the caps in ops.m29.test.ts)
    const oppLimit = Math.min(limit, OPPORTUNITY_SCAN_CAP);
    const deadlineSweepRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", DEADLINE_SWEEP_OPS_KEY))
      .first();
    const deadlineSweep = {
      ageMs: deadlineSweepRow ? now - deadlineSweepRow.updatedAt : null,
      lastCycle: parseSweepRecord(deadlineSweepRow?.cursor),
    };
    const reevaluateDueRows = await ctx.db
      .query("opportunities")
      .withIndex("by_status_and_reevaluate_at", (q) => q.eq("status", "open").gt("reevaluateAt", 0).lte("reevaluateAt", now))
      .take(oppLimit + 1);
    let deadlinesSoon = 0;
    let deadlinesSoonTruncated = false;
    for (const status of ["open", "case_open"] as const) {
      const rows = await ctx.db
        .query("opportunities")
        .withIndex("by_status_and_next_deadline_at", (q) =>
          q.eq("status", status).gt("nextDeadlineAt", now).lte("nextDeadlineAt", now + DEADLINE_ATTENTION_LEAD_MS),
        )
        .take(oppLimit + 1);
      const s = summarize(rows.length, oppLimit);
      deadlinesSoon += s.count;
      if (s.truncated) deadlinesSoonTruncated = true;
    }

    return {
      now,
      asOf,
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
      deletions: { stuck: deletions.stuck, deletingTotal: deletions.deleting },
      flags,
      ruleEvaluationFailures,
      staleSources,
      extraction,
      orphanSweep,
      recoveryRetention,
      deadlineSweep,
      reevaluateDue: summarize(reevaluateDueRows.length, oppLimit),
      userDeadlinesSoon: { count: deadlinesSoon, truncated: deadlinesSoonTruncated },
    };
  },
});

// ---------------------------------------------------------------------------
// resetRetentionCursor (F-T23-3, T18.5 addendum)
// ---------------------------------------------------------------------------

/**
 * Hand-resets `retention.ts`'s resumable-sweep cursor (the `opsState` row
 * keyed `"retention"`, `RETENTION_OPS_KEY`), the same write RUNBOOK.md's
 * old §11 instructed by hand via `npx convex run --inline-mutation` -- a
 * flag that does not exist in this repo's pinned `convex@1.46.0` CLI (only
 * `--inline-query` does; there is no equivalent ad hoc inline-mutation
 * escape hatch). `{"step":0,"page":null}` (the default, `step` omitted or 0)
 * restarts the whole cycle from `RETENTION_STEPS[0]`; `{"step":N}` skips
 * only the stuck step for this cycle, matching the two RUNBOOK options
 * exactly. Returns the cursor as it was before the reset (parsed the same
 * way `backlog`'s own `retention` field is, so an operator can confirm what
 * they just overwrote) -- `null` if the row did not exist yet (the sweep has
 * never run: nothing to reset, and this call still creates the row so the
 * next `retention.sweep` starts from the requested step instead of its own
 * default).
 */
export const resetRetentionCursor = internalMutation({
  args: { step: v.optional(v.number()) },
  returns: v.union(v.object({ step: v.number(), page: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, { step }) => {
    if (step !== undefined && (!Number.isInteger(step) || step < 0 || step >= RETENTION_STEPS.length)) {
      throw new ConvexError(`step must be an integer in [0, ${RETENTION_STEPS.length - 1}]`);
    }
    const row = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", RETENTION_OPS_KEY))
      .unique();
    const previous = row ? parseRetentionCursor(row.cursor) : null;
    const cursor = JSON.stringify({ step: step ?? 0, page: null });
    const now = Date.now();
    if (row) {
      await ctx.db.patch(row._id, { cursor, updatedAt: now });
    } else {
      await ctx.db.insert("opsState", { key: RETENTION_OPS_KEY, cursor, updatedAt: now });
    }
    return previous;
  },
});

// ---------------------------------------------------------------------------
// M1B: feature flags (lib/flags.ts). setFlag is the ONLY writer.
// ---------------------------------------------------------------------------

const MAX_REASON_CHARS = 500;
const DEFAULT_AUDIT_LIMIT = 20;
const MAX_AUDIT_LIMIT = 100;

function cleanReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const cleaned = stripControl(raw).slice(0, MAX_REASON_CHARS);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Operator-only flag switch (D145; contract §2.6 "Live extraction").
 * Internal: `npx convex run ops:setFlag '{"name":"live_document_extraction","on":true,"approvalRef":"D<n>"}'`.
 *
 * - **Enabling an approval-gated flag** (all current flags; see `FLAGS`)
 *   requires `approvalRef` to name the DECISIONS entry where the lead
 *   recorded the user's explicit data-flow approval: `D<digits>`, optionally
 *   followed by a note (`normalizeApprovalRef`). Anything else is refused.
 *   The refusal writes a `flag_changed` line with `outcome: "refused"` and
 *   throws, so nothing is stored.
 * - **Disabling never needs a reference.** Turning a gate off is always safe.
 *   The stored `approvalRef` is cleared.
 * - **Every accepted call, a no-op included,** appends one audit row
 *   (`flagAudit:<name>:<seq>`, read by `flagAudit`) and one `flag_changed`
 *   line with `outcome: "applied"`. The audit row holds from/to,
 *   approvalRef, the bounded `reason`, and the time.
 */
export const setFlag = internalMutation({
  args: {
    name: flagNameValidator,
    on: v.boolean(),
    approvalRef: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  returns: v.object({
    name: flagNameValidator,
    from: v.boolean(),
    to: v.boolean(),
    /** The reference the flag is now ON under; `null` when it is now OFF. */
    approvalRef: v.union(v.string(), v.null()),
    auditSeq: v.number(),
    changed: v.boolean(),
  }),
  handler: async (ctx, { name, on, approvalRef: rawApprovalRef, reason: rawReason }) => {
    const now = Date.now();
    const current = await readFlag(ctx, name);
    const approvalRef = normalizeApprovalRef(rawApprovalRef);

    if (on && FLAGS[name].requiresApproval && approvalRef === null) {
      logEvent("flag_changed", { flag: name, from: current.on, to: true, outcome: "refused", refusal: "approval_ref_required" });
      throw new ConvexError(
        `Refusing to enable ${name}: approvalRef must name the DECISIONS entry that records the user's explicit approval ("D<n>" or "D<n>: note"). D145: this flag stays off until the user approves the data flow.`,
      );
    }

    const storedRef = on ? approvalRef : null;
    const cursor = JSON.stringify({ on, approvalRef: storedRef });
    const row = await flagRow(ctx, name);
    if (row) await ctx.db.patch(row._id, { cursor, updatedAt: now });
    else await ctx.db.insert("opsState", { key: flagKey(name), cursor, updatedAt: now });

    const lastAudit = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.gte("key", flagAuditPrefix(name)).lt("key", flagAuditPrefixEnd(name)))
      .order("desc")
      .first();
    const auditSeq = (lastAudit ? (flagAuditSeq(name, lastAudit.key) ?? 0) : 0) + 1;
    const reason = cleanReason(rawReason);
    await ctx.db.insert("opsState", {
      key: flagAuditKey(name, auditSeq),
      cursor: JSON.stringify({ from: current.on, to: on, approvalRef, reason, at: now }),
      updatedAt: now,
    });

    const changed = current.on !== on;
    logEvent("flag_changed", { flag: name, from: current.on, to: on, outcome: "applied", approvalRef, auditSeq, changed });
    return { name, from: current.on, to: on, approvalRef: storedRef, auditSeq, changed };
  },
});

/**
 * One flag's state, the same value `isFlagOn` gates on. This is how an
 * **action** checks a flag (actions have no `ctx.db`):
 * `const { on } = await ctx.runQuery(internal.ops.getFlag, { name: "live_document_extraction" })`.
 * Prefer re-checking in the mutation that commits the gated work too.
 */
export const getFlag = internalQuery({
  args: { name: flagNameValidator },
  returns: flagStateValidator,
  handler: async (ctx, { name }) => await readFlag(ctx, name),
});

const flagAuditEntry = v.object({
  seq: v.number(),
  from: v.boolean(),
  to: v.boolean(),
  approvalRef: v.union(v.string(), v.null()),
  reason: v.union(v.string(), v.null()),
  at: v.number(),
});

/** A flag's audit trail, newest first. Bounded: `limit` defaults to 20 and is capped at 100. Unparsable rows are skipped. */
export const flagAudit = internalQuery({
  args: { name: flagNameValidator, limit: v.optional(v.number()) },
  returns: v.array(flagAuditEntry),
  handler: async (ctx, { name, limit }) => {
    const take =
      limit !== undefined && Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_AUDIT_LIMIT) : DEFAULT_AUDIT_LIMIT;
    const rows = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.gte("key", flagAuditPrefix(name)).lt("key", flagAuditPrefixEnd(name)))
      .order("desc")
      .take(take);
    const out: Array<{ seq: number; from: boolean; to: boolean; approvalRef: string | null; reason: string | null; at: number }> = [];
    for (const row of rows) {
      const seq = flagAuditSeq(name, row.key);
      if (seq === null || row.cursor === undefined) continue;
      try {
        const e = JSON.parse(row.cursor) as { from?: unknown; to?: unknown; approvalRef?: unknown; reason?: unknown; at?: unknown };
        if (typeof e.from !== "boolean" || typeof e.to !== "boolean") continue;
        out.push({
          seq,
          from: e.from,
          to: e.to,
          approvalRef: typeof e.approvalRef === "string" ? e.approvalRef : null,
          reason: typeof e.reason === "string" ? e.reason : null,
          at: typeof e.at === "number" ? e.at : row.updatedAt,
        });
      } catch {
        // Skip a malformed (hand-edited) audit row rather than fail the whole read.
      }
    }
    return out;
  },
});
