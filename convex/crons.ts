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

export default crons;
