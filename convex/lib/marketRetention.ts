/**
 * P07-W5: market price history is bounded per watch. `marketPrices` rows are third-party dated prices (ShopSavvy);
 * a watch keeps only its newest `MARKET_MAX_POINTS`. Enforced after every snapshot write (`market.recordSnapshot`)
 * and, for history written before this bound existed, by the retention cycle (`retention.sweepRecovery`).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { MARKET_MAX_POINTS } from "../limits";

/** Old points deleted per call, beyond the newest `MARKET_MAX_POINTS` (bounded; later calls finish the job). */
export const MARKET_PRUNE_BATCH = 200;

/** Deletes a watch's market points beyond its newest `MARKET_MAX_POINTS`, at most `MARKET_PRUNE_BATCH`; returns how many. */
export async function pruneMarketPoints(ctx: MutationCtx, watchId: Id<"watches">): Promise<number> {
  const rows = await ctx.db
    .query("marketPrices")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .order("desc")
    .take(MARKET_MAX_POINTS + MARKET_PRUNE_BATCH);
  const old = rows.slice(MARKET_MAX_POINTS);
  for (const row of old) await ctx.db.delete(row._id);
  return old.length;
}
