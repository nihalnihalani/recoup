/**
 * Function registrations for the daily budgets in `lib/budget.ts`.
 *
 * Mutations charge a budget by calling the helpers directly, in the transaction
 * that schedules the paid work. Actions have no `ctx.db`, so they call
 * `internal.budget.consume` BEFORE doing anything paid: a refused call throws
 * out of the action having spent nothing.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { charge, isBudgetKind, takeGlobalBudget, utcDay } from "./lib/budget";
import { requireUserId } from "./lib/access";
import { assertCoarseNow } from "./watches";
import { DAILY_BUDGETS, GLOBAL_DAILY_BUDGETS, type Budget, type GlobalBudgetKind } from "./limits";

/**
 * Unauthenticated on purpose: internal only. Every caller is a public action
 * that has already resolved `userId` from `ctx.auth`.
 */
export const consume = internalMutation({
  args: { userId: v.id("users"), kind: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, kind }) => {
    if (!isBudgetKind(kind)) throw new ConvexError(`Unknown budget kind: ${kind}`);
    await charge(ctx, userId, kind);
    return null;
  },
});

/**
 * For the price-watch cron, which fans out from an action: takes up to `want`
 * units of the global paid-check switch and returns how many it may schedule.
 */
export const takeGlobalPriceChecks = internalMutation({
  args: { want: v.number() },
  returns: v.number(),
  handler: async (ctx, { want }) => {
    if (!Number.isSafeInteger(want) || want <= 0) return 0;
    return await takeGlobalBudget(ctx, "price_check", Math.min(want, 1_000));
  },
});

const kindStatus = v.object({
  kind: v.string(),
  /** This user's count today for this kind. */
  userUsed: v.number(),
  userMax: v.number(),
  /** The deployment-wide switch this kind draws from, when it has one (0/0 otherwise -- see `paused`). */
  globalUsed: v.number(),
  globalMax: v.number(),
  /** True only when this kind draws from a global switch AND that switch is at/over its max today. A kind with no global switch is never paused by this field. */
  paused: v.boolean(),
});

/**
 * Today's spend against every named per-user budget, for the signed-in user
 * (P06/D73): `now` is required and coarse (`assertCoarseNow`), matching
 * `watches.list`'s contract, so this query never reads the wall clock itself
 * -- the UTC calendar day it reports on is entirely a function of the
 * caller's own `now`.
 */
export const status = query({
  args: { now: v.number() },
  returns: v.object({ day: v.string(), kinds: v.array(kindStatus) }),
  handler: async (ctx, { now }) => {
    const userId = await requireUserId(ctx);
    // `now` is a required argument, so this is always a number, never undefined.
    const coarse = assertCoarseNow(now) as number;
    const day = utcDay(coarse);

    const kinds = await Promise.all(
      (Object.entries(DAILY_BUDGETS) as Array<[string, Budget]>).map(async ([kind, budget]) => {
        const userRow = await ctx.db
          .query("usage")
          .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", kind))
          .first();
        let globalUsed = 0;
        let globalMax = 0;
        let paused = false;
        if (budget.global) {
          const globalKind: GlobalBudgetKind = budget.global.kind;
          const globalRow = await ctx.db
            .query("usage")
            .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", globalKind))
            .first();
          globalUsed = globalRow?.count ?? 0;
          globalMax = GLOBAL_DAILY_BUDGETS[globalKind].max;
          paused = globalUsed >= globalMax;
        }
        return { kind, userUsed: userRow?.count ?? 0, userMax: budget.max, globalUsed, globalMax, paused };
      }),
    );
    return { day, kinds };
  },
});
