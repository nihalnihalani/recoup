/**
 * Optional backfill (contract §8): `linkLegacyPurchases` walks every purchase in pages, ensures its transaction
 * (M11, DA-A-35) and evaluates it with trigger `migration`, which LINKS any open legacy price claim (DA-A-3). Linking
 * is already lazy and mandatory inside `evaluateTransaction`; this only brings Potential completeness forward.
 *
 * Idempotent (re-running writes no new evaluation row for an unchanged result), resumable (an `opsState` cursor),
 * bounded (one page per transaction, then it schedules itself), and tombstone-safe. Internal only; the lead runs it
 * after activating a pack (`npx convex run migrations:linkLegacyPurchases '{}'`). Each page writes one
 * `migration_progress` log line; `ops.backlog.migrations.linkLegacyPurchases` shows its cursor's age (P12-S-4).
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { isTombstoned } from "./lib/accountState";
import { evaluatePurchase } from "./opportunities";
import { recordRuleEvaluationFailure } from "./ops";
import { logEvent } from "./lib/log";

export const LINK_LEGACY_CURSOR_KEY = "migration:linkLegacyPurchases";
/** Purchases per page: each evaluates up to MAX_ITEMS_PER_PURCHASE items, so a page stays well inside one transaction. */
export const LINK_LEGACY_PAGE = 20;

export const linkLegacyPurchases = internalMutation({
  args: { restart: v.optional(v.boolean()), chain: v.optional(v.boolean()) },
  returns: v.object({ processed: v.number(), done: v.boolean() }),
  handler: async (ctx, { restart, chain }) => {
    const now = Date.now();
    const state = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", LINK_LEGACY_CURSOR_KEY)).first();
    const cursor = restart ? null : (state?.cursor ?? null);
    const page = await ctx.db.query("purchases").paginate({ cursor, numItems: LINK_LEGACY_PAGE });
    let processed = 0;
    for (const purchase of page.page) {
      if (await isTombstoned(ctx, purchase.userId)) continue;
      try {
        await evaluatePurchase(ctx, purchase._id, "migration", now);
        processed += 1;
      } catch (error) {
        await recordRuleEvaluationFailure(ctx, { now, scenarioId: "R01", ruleId: "migration", ruleVersion: 0, error, trigger: "migration" });
      }
    }
    const next = page.isDone ? undefined : page.continueCursor;
    if (state) await ctx.db.patch(state._id, { cursor: next, updatedAt: now });
    else await ctx.db.insert("opsState", { key: LINK_LEGACY_CURSOR_KEY, cursor: next, updatedAt: now });
    if (!page.isDone && chain !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.linkLegacyPurchases, { chain: true });
    }
    // P12-S-4 (re-audit): one progress line per page, so an operator can follow the backfill in the logs (its cursor
    // age is `ops.backlog.migrations.linkLegacyPurchases`).
    try {
      logEvent("migration_progress", { migration: "linkLegacyPurchases", pageRows: page.page.length, processed, done: page.isDone, restart: restart === true });
    } catch {
      // A log line never fails the page.
    }
    return { processed, done: page.isDone };
  },
});
