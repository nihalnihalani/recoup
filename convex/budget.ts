/**
 * Function registrations for the daily budgets in `lib/budget.ts`.
 *
 * Mutations charge a budget by calling the helpers directly, in the transaction
 * that schedules the paid work. Actions have no `ctx.db`, so they call
 * `internal.budget.consume` BEFORE doing anything paid: a refused call throws
 * out of the action having spent nothing.
 */
import { ConvexError, v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { charge, isBudgetKind, takeGlobalBudget } from "./lib/budget";

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
