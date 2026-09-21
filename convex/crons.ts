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

/**
 * Durable mail delivery safety net (T06, D68). Picks up `mailLog` rows stuck
 * `claimed` (a crash between claim and the enqueue transaction), `queued`
 * (a reconcile that never got its scheduled follow-up), or `unknown`
 * (reconciliation exhausted its backoff) past their `nextCheckAt`, and
 * re-drives them via `sendDrop`/`reconcileDrop`. A tick with nothing due
 * costs one bounded indexed read per status.
 */
crons.interval("mail sweep", { hours: 1 }, internal.notify.sweepStalled, {});

/**
 * Data retention (D75, T16). `retention.sweep` self-reschedules through a
 * bounded page at a time until every rule has caught up for the day, then
 * stops; this daily firing starts the next cycle. See convex/retention.ts's
 * module docstring for the cursor/self-reschedule design.
 */
crons.interval("retention sweep", { hours: 24 }, internal.retention.sweep, {});

/**
 * Confirmed other-store offers (W3), once a day at 13:00 UTC, which is early morning on the US west
 * coast where the demo account lives. Convex crons are UTC and do not follow daylight saving, so this
 * drifts by an hour in winter; a re-check is not time-critical, it just has to be recent.
 */
crons.cron("offer prices", "0 13 * * *", internal.offers.sweepRechecks, {});

export default crons;
