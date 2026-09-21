import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * Price watch (T09). Every tick costs one Firecrawl scrape plus one OpenAI
 * extraction per eligible item. Two hours keeps that small while giving the
 * price charts twelve real readings a day; an adjustment window is short, so a
 * drop found half a day sooner matters. `runAll` is idempotent — a tick with
 * nothing in an open window does nothing at all.
 */
crons.interval("price watch", { hours: 2 }, internal.priceWatch.runAll, {});

/**
 * Watches (W1). The tick is not the cadence: each watch carries its own
 * `nextCheckAt` (WATCH_CHECK_INTERVAL_MS after its last check), so an hourly tick only
 * spreads the load and picks up new or resumed watches sooner. A tick with
 * nothing due costs one indexed read.
 */
crons.interval("watch sweep", { hours: 1 }, internal.watches.sweep, {});

/**
 * Inbound mail safety net: unstick rows whose action died and re-run failed ones that still
 * have attempts left. A tick with nothing to do costs two bounded indexed reads.
 */
crons.interval("retry failed inbound", { hours: 1 }, internal.intake.retryFailed, {});

export default crons;
