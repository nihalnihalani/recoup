/**
 * M29 — the deadline sweep (C50, D158, D212, SEC-CH-6; contract rev 5.2/5.5 §11.2 M29). One cron (`crons.ts`
 * "deadline sweep") runs two things, both in-app only (reminder-only, D03: nothing here ever sends a message):
 *
 * 1. **Re-evaluation of not-yet-due paths (rev 5.2).** `not_yet_due` opportunities whose `reevaluateAt` ≤ now are
 *    re-evaluated through M20's `internal.opportunities.sweepReevaluateDue` (one bounded page on
 *    `by_status_and_reevaluate_at`; tombstone and archive gates are `evaluateTransaction`'s), run as a nested mutation
 *    under its own `transactionLimits`, so a failing or heavy page rolls back alone and never takes the attention pass
 *    with it. Contract test: "R05-04c re-evaluated on 2026-10-11 → new outcome recorded".
 *
 * 2. **User-deadline attention (C50).** A bounded, resumable scan of `by_status_and_next_deadline_at` (status `open`,
 *    then `case_open`; `nextDeadlineAt` holds USER-obligor deadlines only, DA-A-5) over the window
 *    [now − ATTENTION_CLEAR_LOOKBACK_MS, now + DEADLINE_ATTENTION_LEAD_MS]. A cheap check on the paged row decides
 *    which opportunities need a look; each gets its own scheduled `remind`, which RE-READS the opportunity, its current
 *    evaluation, its case and the account (SEC-CH-6) and only then sets or clears `opportunities.deadlineAttention`
 *    (this module is its only writer, D241). Closed, dismissed, superseded, tombstoned and example work is never
 *    touched, so "a reminder for a case closed after scheduling is a no-op".
 *
 *    Attention is due while a user deadline is running (`open`, never `met`, D212) and ends within
 *    `DEADLINE_ATTENTION_LEAD_MS`, the outcome still leaves the user something to do — an approvable outcome,
 *    `needs_facts`, or `manual_review` (D158: a review must never silently use up a notice window) — and, for an open
 *    case, the claim is neither closed for ask nor submitted on its required channel. It is cleared once the deadline
 *    passes ("after the deadline passes → no attention"), is met, or the work closes.
 *
 * 3. **Reconciliation of passed deadlines (P06-OW-1, re-audit).** An `open` opportunity whose user deadline passed
 *    after its last evaluation is re-evaluated once (`opportunities.evaluateInternal`, one per transaction), so a stored
 *    in-window verdict (R01: likely_eligible, "start a claim", the deadline "open") never outlives its window — the
 *    time-based state is materialised by this scheduled job, never by filtering on a client's `now` (D73).
 *
 * Every page records its outcome in the `opsState` row `DEADLINE_SWEEP_OPS_KEY`, which `ops.backlog` reports.
 */
import { v } from "convex/values";
import { internalMutation, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { isTombstoned } from "./lib/accountState";
import { isClosedForAsk, isSubmitted, type ClaimArtifacts } from "./lib/claimState";
import { logEvent } from "./lib/log";
import { APPROVABLE_OUTCOMES, type Outcome } from "./lib/rules/types";

const DAY_MS = 86_400_000;

/** Attention starts this long before a user deadline's due instant (two weeks: R03's notice window is 60 days). */
export const DEADLINE_ATTENTION_LEAD_MS = 14 * DAY_MS;
/**
 * The scan also looks this far into the past, so attention on a deadline that just passed is cleared even after a
 * missed tick (the cron is hourly; this covers two days of outage).
 */
export const ATTENTION_CLEAR_LOOKBACK_MS = 2 * DAY_MS;
/** Opportunities read per page (and so reminders scheduled at most per page). */
export const DEADLINE_SWEEP_PAGE = 100;
/** Drafts / packets / submissions read per claim to decide "submitted" (DA-A-9). */
const ARTIFACTS_PER_CLAIM = 50;
/** `opsState` row the sweep stamps on every page (`ops.backlog.deadlineSweep`). */
export const DEADLINE_SWEEP_OPS_KEY = "deadlineSweep";
/**
 * The nested re-evaluation page's own budget: well inside a mutation's limits (4,096 ranges / 16 MiB read /
 * 16,000 writes), leaving headroom for the attention page. Measured at M20's 50-transaction page in
 * deadlines.test.ts.
 */
export const REEVALUATE_TRANSACTION_LIMITS = {
  databaseQueries: 3_000,
  documentsRead: 20_000,
  bytesRead: 12 * 1024 * 1024,
  documentsWritten: 4_000,
} as const;

/** Outcomes that still leave the user something to do before their deadline (D158 adds manual_review). */
export const ATTENTION_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([...APPROVABLE_OUTCOMES, "needs_facts", "manual_review"]);

export type DeadlineAttention = { dueAt: number; deadlineId: string };
type OpportunityState = Pick<Doc<"opportunities">, "status" | "outcome" | "nextDeadlineAt" | "isExample">;
type DeadlineState = { id: string; obligor: "user" | "counterparty"; status: string; dueAt?: number };

/**
 * Pure: the attention an opportunity should carry at `now`, or null. `deadlines` are its CURRENT evaluation's;
 * `openCase` is its active claim's state when the opportunity is `case_open` (null when that claim is missing or not
 * the owner's).
 */
export function attentionFor(input: {
  opportunity: OpportunityState;
  deadlines: readonly DeadlineState[] | null;
  openCase: { closedForAsk: boolean; submitted: boolean } | null;
  now: number;
}): DeadlineAttention | null {
  const { opportunity: o, deadlines, openCase, now } = input;
  if (o.status !== "open" && o.status !== "case_open") return null; // closed, dismissed, superseded: never
  if (o.isExample === true) return null; // an example is not a real obligation (D27)
  if (!ATTENTION_OUTCOMES.has(o.outcome)) return null;
  const due = o.nextDeadlineAt;
  if (due === undefined || due <= now || due - now > DEADLINE_ATTENTION_LEAD_MS) return null;
  // Re-read against the current evaluation: a user deadline with this exact due instant, still running (never `met`,
  // never `passed`; D212, DA-A-5).
  const deadline = (deadlines ?? []).find((d) => d.obligor === "user" && d.dueAt === due && d.status === "open");
  if (!deadline) return null;
  if (o.status === "case_open" && (openCase === null || openCase.closedForAsk || openCase.submitted)) return null;
  return { dueAt: due, deadlineId: deadline.id };
}

/**
 * Pure display rule (for readers of `opportunities.deadlineAttention`, e.g. M24's /opportunities page): the stored
 * attention is current only for a live card whose next user deadline is still the one it was set for and not passed.
 */
export function deadlineAttentionActive(
  o: Pick<Doc<"opportunities">, "status" | "nextDeadlineAt" | "deadlineAttention">,
  now: number,
): boolean {
  const a = o.deadlineAttention;
  return a !== undefined && (o.status === "open" || o.status === "case_open") && a.dueAt === o.nextDeadlineAt && now < a.dueAt;
}

/**
 * The sweep's cheap per-row check (no extra reads): does this opportunity need `remind` to look at it? A row whose
 * attention may have to be SET (not yet set for this deadline), may have to be CLEARED (set, but the deadline passed or
 * the outcome no longer qualifies), or is an open case with attention (a submission or closure since clears it).
 */
export function needsReminder(o: Doc<"opportunities">, now: number): boolean {
  const due = o.nextDeadlineAt;
  const candidate =
    due !== undefined && due > now && due - now <= DEADLINE_ATTENTION_LEAD_MS && ATTENTION_OUTCOMES.has(o.outcome) && o.isExample !== true;
  const a = o.deadlineAttention;
  if (!candidate) return a !== undefined;
  return a === undefined || a.dueAt !== due || o.status === "case_open";
}

async function claimArtifacts(ctx: QueryCtx, claimId: Doc<"claims">["_id"]): Promise<ClaimArtifacts> {
  const [drafts, packets, submissions] = await Promise.all([
    ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claimId)).take(ARTIFACTS_PER_CLAIM),
    ctx.db.query("packets").withIndex("by_claim", (q) => q.eq("claimId", claimId)).take(ARTIFACTS_PER_CLAIM),
    ctx.db.query("submissions").withIndex("by_claim", (q) => q.eq("claimId", claimId)).take(ARTIFACTS_PER_CLAIM),
  ]);
  return { drafts, packets, submissions };
}

/** Re-reads everything `attentionFor` needs (SEC-CH-6): the current evaluation and, for an open case, its claim. */
async function desiredAttention(ctx: QueryCtx, o: Doc<"opportunities">, now: number): Promise<DeadlineAttention | null> {
  if (o.status !== "open" && o.status !== "case_open") return null;
  const evaluation = o.currentEvaluationId ? await ctx.db.get(o.currentEvaluationId) : null;
  if (!evaluation || evaluation.userId !== o.userId) return null;
  let openCase: { closedForAsk: boolean; submitted: boolean } | null = null;
  if (o.status === "case_open" && o.activeClaimId) {
    const claim = await ctx.db.get(o.activeClaimId);
    if (claim && claim.userId === o.userId) {
      openCase = { closedForAsk: isClosedForAsk(claim), submitted: isSubmitted(claim, await claimArtifacts(ctx, claim._id)) };
    }
  }
  return attentionFor({ opportunity: o, deadlines: evaluation.deadlines, openCase, now });
}

const remindResult = v.union(v.literal("set"), v.literal("cleared"), v.literal("unchanged"), v.literal("skipped"));

/**
 * One opportunity's attention, decided from its state NOW (SEC-CH-6), not from what the sweep saw when it scheduled
 * this: a missing opportunity or a tombstoned account is skipped without a write; otherwise attention is set, cleared
 * or left as it is. A reminder for work closed after scheduling finds nothing to do and writes nothing.
 */
export const remind = internalMutation({
  args: { opportunityId: v.id("opportunities") },
  returns: remindResult,
  handler: async (ctx, { opportunityId }) => {
    const now = Date.now();
    const o = await ctx.db.get(opportunityId);
    if (!o) return "skipped";
    if (await isTombstoned(ctx, o.userId)) return "skipped";
    const desired = await desiredAttention(ctx, o, now);
    const current = o.deadlineAttention;
    if (desired !== null) {
      if (current !== undefined && current.dueAt === desired.dueAt && current.deadlineId === desired.deadlineId) return "unchanged";
      await ctx.db.patch(o._id, { deadlineAttention: { setAt: now, ...desired } });
      return "set";
    }
    if (current === undefined) return "unchanged";
    await ctx.db.patch(o._id, { deadlineAttention: undefined });
    return "cleared";
  },
});

/**
 * The cycle's phases, in order: attention over `open`, then `case_open` opportunities, then P06-OW-1 reconciliation of
 * `open` opportunities whose user deadline passed after their last evaluation.
 */
export type SweepPhase = "open" | "case_open" | "reconcile";
const sweepPhase = v.union(v.literal("open"), v.literal("case_open"), v.literal("reconcile"));
const NEXT_PHASE: Record<SweepPhase, SweepPhase | null> = { open: "case_open", case_open: "reconcile", reconcile: null };

/** What the cycle has done so far, for `ops.backlog` (JSON in the opsState row's `cursor` field). */
export type DeadlineSweepRecord = {
  cycleNow: number;
  phase: SweepPhase;
  scanned: number;
  scheduled: number;
  /** P06-OW-1: opportunities sent back for re-evaluation because their deadline passed after they were evaluated. */
  reconciled: number;
  reevaluated: number | null;
  reevaluateFailed: boolean;
  done: boolean;
};

/** Parses the stored record; anything unreadable reads as "no record" (the backlog shows `null`s, never throws). */
export function parseSweepRecord(raw: string | undefined): DeadlineSweepRecord | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<DeadlineSweepRecord>;
    if (typeof r.cycleNow !== "number" || (r.phase !== "open" && r.phase !== "case_open" && r.phase !== "reconcile")) return null;
    return {
      cycleNow: r.cycleNow, phase: r.phase,
      scanned: typeof r.scanned === "number" ? r.scanned : 0,
      scheduled: typeof r.scheduled === "number" ? r.scheduled : 0,
      reconciled: typeof r.reconciled === "number" ? r.reconciled : 0,
      reevaluated: typeof r.reevaluated === "number" ? r.reevaluated : null,
      reevaluateFailed: r.reevaluateFailed === true,
      done: r.done === true,
    };
  } catch {
    return null;
  }
}

/**
 * P06-OW-1 (pure): an `open` opportunity whose user deadline has passed (`nextDeadlineAt` ≤ now) but whose stored
 * evaluation predates that instant still says what it said inside the window (R01: likely_eligible, open_case, the
 * deadline "open"). It needs one re-evaluation; afterwards `lastEvaluatedAt` > `nextDeadlineAt` (or the passed deadline
 * leaves `nextDeadlineAt`), so it is never sent twice.
 */
export function needsReconcile(o: Pick<Doc<"opportunities">, "status" | "nextDeadlineAt" | "lastEvaluatedAt" | "isExample">, now: number): boolean {
  return o.status === "open" && o.isExample !== true && o.nextDeadlineAt !== undefined && o.nextDeadlineAt <= now && o.lastEvaluatedAt <= o.nextDeadlineAt;
}

async function recordPage(ctx: MutationCtx, page: DeadlineSweepRecord, firstOfCycle: boolean, at: number): Promise<void> {
  const row = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", DEADLINE_SWEEP_OPS_KEY)).first();
  const prev = firstOfCycle ? null : parseSweepRecord(row?.cursor);
  const sameCycle = prev !== null && prev.cycleNow === page.cycleNow;
  const record: DeadlineSweepRecord = sameCycle
    ? {
        ...page,
        scanned: prev.scanned + page.scanned, scheduled: prev.scheduled + page.scheduled, reconciled: prev.reconciled + page.reconciled,
        reevaluated: prev.reevaluated, reevaluateFailed: prev.reevaluateFailed,
      }
    : page;
  const cursor = JSON.stringify(record);
  if (row) await ctx.db.patch(row._id, { cursor, updatedAt: at });
  else await ctx.db.insert("opsState", { key: DEADLINE_SWEEP_OPS_KEY, cursor, updatedAt: at });
}

/**
 * The cron target (hourly). The first call of a cycle (no `phase`) runs the re-evaluation page, then scans `open`
 * opportunities; each page schedules its work and, while its range is not done, its own continuation (same `now`, so
 * the index range is stable across pages), then moves on to `case_open`, then to `reconcile` (P06-OW-1: every `open`
 * opportunity whose user deadline passed after its last evaluation is re-evaluated once, through
 * `opportunities.evaluateInternal`, so no card keeps an in-window verdict — "likely eligible", "start a claim" — after
 * its deadline). `now` defaults to the clock; tests pass it.
 */
export const sweep = internalMutation({
  args: {
    now: v.optional(v.number()),
    phase: v.optional(sweepPhase),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(),
    scheduled: v.number(),
    reconciled: v.number(),
    reevaluated: v.union(v.number(), v.null()),
    continued: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const now = args.now ?? Date.now();
    const phase: SweepPhase = args.phase ?? "open";
    let reevaluated: number | null = null;
    let reevaluateFailed = false;
    if (args.phase === undefined) {
      try {
        const r: { transactions: number } = await ctx.runMutation(
          internal.opportunities.sweepReevaluateDue,
          { now },
          { transactionLimits: REEVALUATE_TRANSACTION_LIMITS },
        );
        reevaluated = r.transactions;
      } catch (error) {
        // Rolled back alone (a nested mutation); the attention pass still runs and the next tick retries.
        reevaluateFailed = true;
        logEvent("rule_evaluation_failed", { stage: "deadline_sweep_reevaluate", error });
      }
    }

    const page = await ctx.db
      .query("opportunities")
      .withIndex("by_status_and_next_deadline_at", (q) =>
        phase === "reconcile"
          ? q.eq("status", "open").gt("nextDeadlineAt", 0).lte("nextDeadlineAt", now)
          : q.eq("status", phase).gte("nextDeadlineAt", now - ATTENTION_CLEAR_LOOKBACK_MS).lte("nextDeadlineAt", now + DEADLINE_ATTENTION_LEAD_MS),
      )
      .paginate({ numItems: DEADLINE_SWEEP_PAGE, cursor: args.cursor ?? null });

    let scheduled = 0;
    let reconciled = 0;
    if (phase === "reconcile") {
      const subjectsByTxn = new Map<Doc<"transactions">["_id"], Set<string>>();
      for (const o of page.page) {
        if (!needsReconcile(o, now)) continue;
        const subjects = subjectsByTxn.get(o.transactionId) ?? new Set<string>();
        subjects.add(o.subjectKey);
        subjectsByTxn.set(o.transactionId, subjects);
        reconciled += 1;
      }
      for (const [transactionId, subjects] of subjectsByTxn) {
        await ctx.scheduler.runAfter(0, internal.opportunities.evaluateInternal, { transactionId, trigger: "fact_change", subjects: [...subjects] });
        scheduled += 1;
      }
    } else {
      for (const o of page.page) {
        if (!needsReminder(o, now)) continue;
        await ctx.scheduler.runAfter(0, internal.deadlines.remind, { opportunityId: o._id });
        scheduled += 1;
      }
    }

    let continued = true;
    const next = NEXT_PHASE[phase];
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.deadlines.sweep, { now, phase, cursor: page.continueCursor });
    } else if (next !== null) {
      await ctx.scheduler.runAfter(0, internal.deadlines.sweep, { now, phase: next, cursor: null });
    } else {
      continued = false;
    }
    await recordPage(
      ctx,
      { cycleNow: now, phase, scanned: page.page.length, scheduled, reconciled, reevaluated, reevaluateFailed, done: !continued },
      args.phase === undefined,
      now,
    );
    return { scanned: page.page.length, scheduled, reconciled, reevaluated, continued };
  },
});
