/**
 * Spend limits for public paths that cost Firecrawl or OpenAI credit.
 *
 * `@convex-dev/rate-limiter` is not installed in this project, so these are
 * enforced inside the mutation that schedules the spend, off timestamps and
 * indexed counts on the rows themselves (the same shape as
 * `priceWatch.CHECK_COOLDOWN_MS`). Every check fails closed.
 */

/** Non-archived watches per user: each one costs 4 scrapes + 4 extractions a day, so 50 caps a user at ~200 paid calls a day. */
export const MAX_WATCHES_PER_USER = 50;

/** Creates per user per rolling hour (archived rows count): every create schedules a paid check, and nobody pastes more than 20 links an hour by hand. */
export const MAX_WATCH_CREATES_PER_HOUR = 20;
export const WATCH_CREATE_WINDOW_MS = 3_600_000;

/** Manual "check now" per watch: the scraper serves a cached page for up to an hour, so re-checking sooner than 10 minutes buys nothing and still costs an extraction. */
export const WATCH_CHECK_COOLDOWN_MS = 600_000;

/** Cadence of automatic checks per watch: retailer prices move on the order of a day; same 6h compromise as the owned-item price watch. */
export const WATCH_CHECK_INTERVAL_MS = 6 * 3_600_000;

/** Watches one sweep tick may schedule, so a bad day cannot burn the scrape quota (same bound as priceWatch FANOUT_LIMIT). */
export const WATCH_SWEEP_PAGE = 50;

/** Spacing between scrapes scheduled by one sweep; Firecrawl is rate limited per key. */
export const WATCH_SWEEP_STAGGER_MS = 2_000;

/** How far a sweep pushes `nextCheckAt` while the check is in flight, so the next tick does not double-schedule a slow page. */
export const WATCH_SWEEP_BUMP_MS = 600_000;
