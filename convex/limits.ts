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

/** Cadence of automatic checks per watch: every check costs one scrape plus one extraction; two hours matches the owned-item price watch and gives the charts twelve real readings a day. */
export const WATCH_CHECK_INTERVAL_MS = 2 * 3_600_000;

/** Watches one sweep tick may schedule, so a bad day cannot burn the scrape quota (same bound as priceWatch FANOUT_LIMIT). */
export const WATCH_SWEEP_PAGE = 50;

/** Spacing between scrapes scheduled by one sweep; Firecrawl is rate limited per key. */
export const WATCH_SWEEP_STAGGER_MS = 2_000;

/** How far a sweep pushes `nextCheckAt` while the check is in flight, so the next tick does not double-schedule a slow page. */
export const WATCH_SWEEP_BUMP_MS = 600_000;

/** Drop emails per user per rolling 24h (W2): 50 watches x 4 checks could otherwise mail 200 times on a volatile day; 20 is more than anyone reads, and the in-app list still shows the rest. */
export const MAX_DROP_EMAILS_PER_DAY = 20;
export const DROP_EMAIL_WINDOW_MS = 86_400_000;

/** mailLog rows read to count the daily cap: 50 watches x 4 checks a day is 200 claims at the very most, so 200 sees the whole window. */
export const DROP_EMAIL_COUNT_SCAN = 200;

/** Smallest drop worth an email when no target is set (W2): the larger of $1.00 and 2% of the previous price, so cent-level jitter on a cheap item and rounding noise on a dear one both stay quiet. */
export const DROP_MIN_CENTS = 100;
export const DROP_MIN_PERCENT = 2;

/** `fetchBoth` skips a policy kind researched this recently for the same user and store (M1): policies change over months, each fetch costs a search plus up to 3 extractions, and a failed re-fetch must not pile onto a snapshot the user just confirmed. */
export const POLICY_REFETCH_MIN_AGE_MS = 86_400_000;

// --- Offers (W3): the same item at other stores ------------------------------

/** "Find at other stores" per watch: one find costs a search plus up to 5 scrapes and 5 extractions, and the set of stores selling a product does not change within a few hours (same 6h cadence as the price checks). */
export const OFFER_FIND_COOLDOWN_MS = 6 * 3_600_000;

/** Finds per user per rolling day: 10 finds is at most 10 searches + 50 scrapes + 50 extractions a day, about a quarter of what a full watch list already costs. */
export const MAX_OFFER_FINDS_PER_DAY = 10;
export const OFFER_FIND_WINDOW_MS = 24 * 3_600_000;

/** Results asked of one search: enough to survive dropping the own store, social hosts and duplicate stores and still leave 5. */
export const OFFER_SEARCH_LIMIT = 8;

/** Store pages priced per find: each is a paid scrape plus an extraction, and nobody compares more than five stores. */
export const MAX_OFFER_PAGES_PER_FIND = 5;

/** Stores kept per watch (any status): bounds every per-watch read in offers.ts so it is always the complete set. */
export const MAX_OFFERS_PER_WATCH = 40;

/** Confirmed offers one recheck re-reads, stalest first: each is a paid scrape plus an extraction riding on the watch's own 6h check. */
export const MAX_OFFER_RECHECKS = 10;
