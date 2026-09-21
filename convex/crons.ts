import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Price watch (T09). Six hours is a compromise: retailer sale prices move on
 * the order of a day, and every tick costs one Firecrawl scrape plus one
 * OpenAI extraction per eligible item. `runAll` is idempotent — a tick with
 * nothing in an open window does nothing at all.
 */
crons.interval("price watch", { hours: 6 }, internal.priceWatch.runAll, {});

/**
 * Watches (W1). The tick is not the cadence: each watch carries its own
 * `nextCheckAt` (six hours after its last check), so an hourly tick only
 * spreads the load and picks up new or resumed watches sooner. A tick with
 * nothing due costs one indexed read.
 */
crons.interval("watch sweep", { hours: 1 }, internal.watches.sweep, {});

export default crons;
