/**
 * Daily spend budgets (pre-launch review B1, B3-B5, H1-H3).
 *
 * One `usage` row per (user, UTC day, kind). The counter is read and
 * incremented inside the mutation that schedules the paid work, so the check
 * and the spend commit together and two concurrent calls cannot both pass
 * (OCC serialises them on the row). Everything fails closed: over the cap is a
 * refusal, and a refused call has spent nothing.
 *
 * Rows with no `userId` are deployment-wide kill switches.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { logEvent } from "./log";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
  GLOBAL_MONTHLY_BUDGETS,
  type Budget,
  type BudgetKind,
  type GlobalBudgetKind,
} from "../limits";

/** The UTC calendar day a timestamp falls on, `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function plainWords(kind: string): string {
  const known = (DAILY_BUDGETS as Record<string, Budget>)[kind] ?? (GLOBAL_DAILY_BUDGETS as Record<string, { label: string }>)[kind];
  return known?.label ?? kind.replace(/_/g, " ");
}

function assertMax(max: number): void {
  if (!Number.isSafeInteger(max) || max < 0) throw new Error("budget max must be a non-negative integer");
}

function assertUnits(units: number): void {
  if (!Number.isSafeInteger(units) || units < 1) throw new Error("budget units must be a positive integer");
}

// ---------------------------------------------------------------------------
// P12-W4 (re-audit): a DURABLE operator pause per global kind. `ops.pauseKind` writes the opsState row
// `budgetPause:<kind>`; every global charge below reads it and refuses while it exists, on every UTC day, until
// `ops.resumeKind` deletes it. (Before, a pause only pinned today's usage row to max and silently lapsed at 00:00 UTC.)
// ---------------------------------------------------------------------------

export const BUDGET_PAUSE_KEY_PREFIX = "budgetPause:";
export function budgetPauseKey(kind: string): string {
  return `${BUDGET_PAUSE_KEY_PREFIX}${kind}`;
}

/** The UTC calendar month a timestamp falls on, `YYYY-MM` (the `day` of a monthly usage row). */
export function utcMonth(now: number): string {
  return new Date(now).toISOString().slice(0, 7);
}

/** The usage `kind` of a global kind's monthly row (P03-SK-1). */
export function monthlyKind(kind: string): string {
  return `${kind}@month`;
}

/**
 * P03-SK-1: the room left this UTC month for a global kind billed against a monthly provider plan, with its row; null
 * for a kind without a monthly cap.
 */
async function monthlyRoom(ctx: QueryCtx, kind: string, now: number) {
  const budget = (GLOBAL_MONTHLY_BUDGETS as Record<string, { max: number } | undefined>)[kind];
  if (!budget) return null;
  const month = utcMonth(now);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", month).eq("kind", monthlyKind(kind)))
    .first();
  return { row, month, room: Math.max(0, budget.max - (row?.count ?? 0)) };
}

async function spendMonthly(ctx: MutationCtx, kind: string, m: NonNullable<Awaited<ReturnType<typeof monthlyRoom>>>, units: number) {
  if (m.row) await ctx.db.patch(m.row._id, { count: m.row.count + units });
  else await ctx.db.insert("usage", { userId: undefined, day: m.month, kind: monthlyKind(kind), count: units });
}

/** True while an operator pause of this global kind is in force (one indexed point read). */
export async function isGlobalKindPaused(ctx: QueryCtx, kind: string): Promise<boolean> {
  const row = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", budgetPauseKey(kind))).first();
  return row !== null;
}

/**
 * P12-W7: one structured, redacted line per refused (or short-granted) global charge, so an operator sees a switch
 * that is paused or spent instead of inferring it from user complaints.
 */
function logExhausted(kind: string, reason: "paused" | "spent", want: number, granted: number): void {
  try {
    logEvent("budget_exhausted", { kind, reason, want, granted });
  } catch {
    // Never let a log line turn a refusal into a failure.
  }
}

/**
 * Takes up to `want` units from one counter and returns how many were granted
 * (0 when the day is spent). Never throws for being over. For the global row (no user) an operator pause grants 0.
 */
async function take(
  ctx: MutationCtx,
  userId: Id<"users"> | undefined,
  kind: string,
  max: number,
  want: number,
  now: number,
): Promise<number> {
  assertMax(max);
  assertUnits(want);
  if (userId === undefined && (await isGlobalKindPaused(ctx, kind))) {
    logExhausted(kind, "paused", want, 0);
    return 0;
  }
  const day = utcDay(now);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", kind))
    .first();
  const used = row?.count ?? 0;
  const monthly = userId === undefined ? await monthlyRoom(ctx, kind, now) : null;
  const granted = Math.max(0, Math.min(want, max - used, monthly?.room ?? Number.POSITIVE_INFINITY));
  if (userId === undefined && granted < want) logExhausted(kind, "spent", want, granted);
  if (granted === 0) return 0;
  if (row) await ctx.db.patch(row._id, { count: used + granted });
  else await ctx.db.insert("usage", { userId, day, kind, count: granted });
  if (monthly) await spendMonthly(ctx, kind, monthly, granted);
  return granted;
}

/**
 * Charges one use of `kind` to `userId` for today (UTC). Throws a
 * user-readable `ConvexError` when the user is already at `max`.
 */
export async function consumeBudget(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: string,
  max: number,
  now: number = Date.now(),
): Promise<void> {
  if ((await take(ctx, userId, kind, max, 1, now)) === 0) {
    throw new ConvexError(`You have reached today's limit for ${plainWords(kind)}. It resets at midnight UTC.`);
  }
}

/** Same, without the throw: false when the user is at the cap. For side effects a write should survive without. */
export async function tryConsumeBudget(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: string,
  max: number,
  now: number = Date.now(),
): Promise<boolean> {
  return (await take(ctx, userId, kind, max, 1, now)) === 1;
}

/**
 * F2 (D266 audit): a global refusal is either a durable operator pause (P12-W4 -- outlives UTC midnight, only
 * `ops.resumeKind` lifts it) or an ordinary daily/monthly cap (resets at midnight UTC, or next calendar month for a
 * `GLOBAL_MONTHLY_BUDGETS` kind). The two need different copy: "back tomorrow" is false for an operator pause, and
 * promising a reset time nobody controls is misleading. Read BEFORE the charge attempt, in the same transaction, so
 * it reflects the reason for the refusal that is about to happen, not a later state.
 */
export async function globalBudgetMessage(ctx: MutationCtx | QueryCtx, kind: string): Promise<string> {
  const label = plainWords(kind);
  return (await isGlobalKindPaused(ctx, kind))
    ? `Recoup has paused ${label} for now. Check back later.`
    : `Recoup has reached today's limit for ${label}. It resets at midnight UTC.`;
}

/**
 * The deployment-wide kill switch: charges `units` to the row with no user.
 * All or nothing; throws when the whole deployment is out for the day.
 */
export async function consumeGlobalBudget(
  ctx: MutationCtx,
  kind: string,
  max: number,
  units: number = 1,
  now: number = Date.now(),
): Promise<void> {
  // Read before charging: whichever reason applies now is the one the refusal (if any) is about to be for.
  const message = await globalBudgetMessage(ctx, kind);
  if (!(await tryConsumeGlobalBudget(ctx, kind, max, units, now))) {
    throw new ConvexError(message);
  }
}

/** All-or-nothing global charge without the throw. */
export async function tryConsumeGlobalBudget(
  ctx: MutationCtx,
  kind: string,
  max: number,
  units: number = 1,
  now: number = Date.now(),
): Promise<boolean> {
  assertMax(max);
  assertUnits(units);
  if (await isGlobalKindPaused(ctx, kind)) {
    logExhausted(kind, "paused", units, 0);
    return false;
  }
  const day = utcDay(now);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", kind))
    .first();
  const used = row?.count ?? 0;
  const monthly = await monthlyRoom(ctx, kind, now);
  if (used + units > max || (monthly !== null && units > monthly.room)) {
    logExhausted(kind, "spent", units, 0);
    return false;
  }
  if (row) await ctx.db.patch(row._id, { count: used + units });
  else await ctx.db.insert("usage", { userId: undefined, day, kind, count: units });
  if (monthly) await spendMonthly(ctx, kind, monthly, units);
  return true;
}

/** For sweeps: takes up to `want` global units and returns how many the sweep may spend (possibly 0). */
export async function takeGlobalBudget(
  ctx: MutationCtx,
  kind: GlobalBudgetKind,
  want: number,
  now: number = Date.now(),
): Promise<number> {
  if (want <= 0) return 0;
  return take(ctx, undefined, kind, GLOBAL_DAILY_BUDGETS[kind].max, want, now);
}

export function isBudgetKind(kind: string): kind is BudgetKind {
  return Object.prototype.hasOwnProperty.call(DAILY_BUDGETS, kind);
}

/**
 * Charges a named budget from `limits.ts`: the user's daily cap first, then
 * the global switch the kind draws from, if any. Throws on either.
 */
export async function charge(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: BudgetKind,
  now: number = Date.now(),
): Promise<void> {
  const budget: Budget = DAILY_BUDGETS[kind];
  await consumeBudget(ctx, userId, kind, budget.max, now);
  if (budget.global) {
    await consumeGlobalBudget(ctx, budget.global.kind, GLOBAL_DAILY_BUDGETS[budget.global.kind].max, budget.global.units, now);
  }
}

/** `charge` without the throw, for work a write should survive without. A refusal charges nothing. */
export async function tryCharge(
  ctx: MutationCtx,
  userId: Id<"users">,
  kind: BudgetKind,
  now: number = Date.now(),
): Promise<boolean> {
  const budget: Budget = DAILY_BUDGETS[kind];
  if (budget.global) {
    // Check the global switch before touching the user's counter, so a refusal leaves both untouched.
    if (await isGlobalKindPaused(ctx, budget.global.kind)) {
      logExhausted(budget.global.kind, "paused", budget.global.units, 0);
      return false;
    }
    const day = utcDay(now);
    const globalRow = await ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", budget.global!.kind))
      .first();
    const monthly = await monthlyRoom(ctx, budget.global.kind, now);
    if ((globalRow?.count ?? 0) + budget.global.units > GLOBAL_DAILY_BUDGETS[budget.global.kind].max || (monthly !== null && budget.global.units > monthly.room)) {
      logExhausted(budget.global.kind, "spent", budget.global.units, 0);
      return false;
    }
  }
  if (!(await tryConsumeBudget(ctx, userId, kind, budget.max, now))) return false;
  if (budget.global) {
    return tryConsumeGlobalBudget(ctx, budget.global.kind, GLOBAL_DAILY_BUDGETS[budget.global.kind].max, budget.global.units, now);
  }
  return true;
}
