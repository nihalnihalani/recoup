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
import type { MutationCtx } from "../_generated/server";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
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

/**
 * Takes up to `want` units from one counter and returns how many were granted
 * (0 when the day is spent). Never throws for being over.
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
  const day = utcDay(now);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", kind))
    .first();
  const used = row?.count ?? 0;
  const granted = Math.max(0, Math.min(want, max - used));
  if (granted === 0) return 0;
  if (row) await ctx.db.patch(row._id, { count: used + granted });
  else await ctx.db.insert("usage", { userId, day, kind, count: granted });
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
  if (!(await tryConsumeGlobalBudget(ctx, kind, max, units, now))) {
    throw new ConvexError(`Recoup has reached today's limit for ${plainWords(kind)}. It resets at midnight UTC.`);
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
  const day = utcDay(now);
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", kind))
    .first();
  const used = row?.count ?? 0;
  if (used + units > max) return false;
  if (row) await ctx.db.patch(row._id, { count: used + units });
  else await ctx.db.insert("usage", { userId: undefined, day, kind, count: units });
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
    const day = utcDay(now);
    const globalRow = await ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", budget.global!.kind))
      .first();
    if ((globalRow?.count ?? 0) + budget.global.units > GLOBAL_DAILY_BUDGETS[budget.global.kind].max) return false;
  }
  if (!(await tryConsumeBudget(ctx, userId, kind, budget.max, now))) return false;
  if (budget.global) {
    return tryConsumeGlobalBudget(ctx, budget.global.kind, GLOBAL_DAILY_BUDGETS[budget.global.kind].max, budget.global.units, now);
  }
  return true;
}
