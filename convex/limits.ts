/**
 * Spend limits for public paths that cost Firecrawl or OpenAI credit.
 *
 * `@convex-dev/rate-limiter` is not installed in this project, so these are
 * enforced inside the mutation that schedules the spend, off timestamps and
 * indexed counts on the rows themselves (the same shape as
 * `priceWatch.CHECK_COOLDOWN_MS`). Every check fails closed.
 */

/** Non-archived watches per user: each one costs 12 scrapes + 12 extractions a day at the 2h cadence, so 50 caps a user at ~600 automatic paid checks a day; the global `price_check` switch below bounds the total. */
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

/** Drop emails per user per rolling 24h (W2, review B2): the address is unverified, so this is also the most mail one account can aim at somebody else's inbox in a day; 5 is more than anyone reads, and the in-app list still shows the rest. */
export const MAX_DROP_EMAILS_PER_DAY = 5;
export const DROP_EMAIL_WINDOW_MS = 86_400_000;

/** mailLog rows read to count the daily cap. 50 watches x 12 checks a day can claim more than 200 rows; a full page counts as over the cap, so an undercount can only ever withhold mail (fails closed). */
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

/**
 * Daily re-check of confirmed other-store offers. A confirmed offer is a store the user told us sells the same
 * item, so its price is worth keeping current; a candidate nobody confirmed is not, and is never re-read.
 * One page per tick, stalest first, so a big day is bounded and every offer comes round within a few days.
 */
export const OFFER_RECHECK_PAGE = 60;
/** Watches one tick may schedule. Each one re-reads up to MAX_OFFER_RECHECKS of its confirmed offers. */
export const OFFER_RECHECK_WATCHES = 20;
/** Spacing between scheduled re-checks; Firecrawl is rate limited per key. */
export const OFFER_RECHECK_STAGGER_MS = 5_000;

// --- Daily budgets (pre-launch review B1, B3-B5, H1-H3) ----------------------
//
// Counted in the `usage` table, one row per (user, UTC day, kind), by
// `lib/budget.ts`. Sized for a hackathon demo with real money behind the keys:
// generous for one person clicking, useless for a script.

export type Budget = {
  /** Most uses per user per UTC day. */
  max: number;
  /** Plain words for the refusal: "You have reached today's limit for <label>." */
  label: string;
  /** Deployment-wide switch this kind also draws from, and how many units one use costs. */
  global?: { kind: GlobalBudgetKind; units: number };
};

export type GlobalBudgetKind = "price_check" | "policy_fetch" | "drop_email" | "market_lookup" | "claim_email" | "inbound_extract";

/**
 * Deployment-wide daily kill switches (usage rows with no userId), so the worst day is bounded in dollars whatever
 * the number of accounts.
 */
export const GLOBAL_DAILY_BUDGETS: Record<GlobalBudgetKind, { max: number; label: string }> = {
  /** One unit = one ShopSavvy lookup (3 credits + 1 per day of history). Bounds the trial plan's 1,000 monthly credits against any number of accounts. */
  market_lookup: { max: 40, label: "market history look-ups" },
  /** One unit = one scrape + one extraction (~1-2 cents). The two sweeps alone can use 1,800 a day (50/h + 50/2h); 3,000 leaves room for manual checks and caps the day at roughly $50. */
  price_check: { max: 3_000, label: "price checks" },
  /** One unit = one policy research (a search that scrapes 3 pages plus up to 3 extractions, ~5 cents). 500 is ~250 new stores a day and at most about $25. */
  policy_fetch: { max: 500, label: "store policy look-ups" },
  /** One ShopSavvy lookup bills 3 credits plus one per day of history; at MARKET_HISTORY_DAYS=14 that is 17. The trial plan holds 1,000 credits a month, so 20 a day is about a third of it and leaves room to demo. */
  /** Drop alerts leave from one shared inbox to unverified addresses (B2); 300 a day keeps the sending domain's reputation safe however many accounts exist. */
  drop_email: { max: 300, label: "price alert emails" },
  /** Claim emails leave from one shared inbox to caller-chosen addresses (B1); bounds the deployment-wide total whatever the number of accounts (T01/D76). */
  claim_email: { max: 100, label: "claim emails" },
  /** One unit = one inbound-email extraction model call; a refused paste becomes needs_review and is retried hourly (T01/D76). Global-only: no per-user counterpart. */
  inbound_extract: { max: 500, label: "reading pasted or forwarded emails" },
};

export const DAILY_BUDGETS = {
  /** One paste = one model call on up to 60k characters (~15k tokens). Nobody pastes 30 order emails a day by hand. */
  paste: { max: 30, label: "reading pasted emails" },
  /** One retry = one more model call on the same email; 20 covers a bad afternoon of forwarded mail. */
  intake_retry: { max: 20, label: "re-reading emails" },
  /** One refresh = one policy research (~5 cents). A user has a handful of stores; 10 re-reads a day is plenty. */
  policy_refresh: { max: 10, label: "re-reading store policies", global: { kind: "policy_fetch", units: 1 } },
  /** One fetchBoth = two policy researches (~10 cents), shared by purchases.create, purchases.confirm and watches.markBought. 15 new stores a day is a heavy import. */
  policy_fetch: { max: 15, label: "looking up store policies", global: { kind: "policy_fetch", units: 2 } },
  /** One draft = one model call and one stored row. 30 covers rewriting every open claim several times. */
  draft_generate: { max: 30, label: "writing drafts" },
  /** Mail to a caller-chosen address from our sending domain (B1): 10 a day is more claims than anyone files and too few to be a relay. Global claim_email cap added T01/D76: charge() enforces both. */
  claim_email: { max: 10, label: "sending claim emails", global: { kind: "claim_email", units: 1 } },
  /** Manual "check the price now" on owned items: one scrape + one extraction each; 40 is every item on a big order, twice. */
  item_check: { max: 40, label: "checking prices on your purchases", global: { kind: "price_check", units: 1 } },
  /** Manual "check now" on watches, on top of the 10-minute per-watch cooldown (H2): 40 is most of a full watch list once a day. */
  watch_check: { max: 40, label: "checking prices on watched items", global: { kind: "price_check", units: 1 } },
  /** A paid third-party lookup; see MARKET_HISTORY_DAYS for what one costs. */
  market_lookup: { max: 5, label: "market history look-ups", global: { kind: "market_lookup", units: 1 } },
  /**
   * D112 6a-2: per-user half of the `inbound_extract` gate (the global
   * counterpart above stays `GLOBAL_DAILY_BUDGETS.inbound_extract`, D76).
   * Before this, `inbound_extract` was global-only, so one known inbox
   * address flooding it could pause every OTHER user's intake for the day.
   * Charged first, in `intake.beginEvent`/`replies.classify`, deliberately
   * NOT wired to the global switch via `global: {...}` here -- the two are
   * checked independently, in that fixed order, by the caller (an
   * over-cap refusal here writes a distinct `needs_review` summary and no
   * global-pause marker, so `charge()`'s auto-chaining would be wrong).
   * 50/day is a heavy day of forwarded mail and replies -- comfortably
   * above `intake_retry`'s own 20/day -- while still bounding one
   * account's daily share of the shared 500/day global switch to a tenth.
   */
  inbound_extract: { max: 50, label: "reading pasted or forwarded emails" },
} as const satisfies Record<string, Budget>;

export type BudgetKind = keyof typeof DAILY_BUDGETS;

// --- ShopSavvy market history ------------------------------------------------

/** Days of history asked for per lookup. One credit per day, so this is the price of the feature. */
export const MARKET_HISTORY_DAYS = 14;
/** Most dated points kept per watch. A chart needs a shape, not every row. */
export const MARKET_MAX_POINTS = 120;
/** Most stores one lookup may add as offer candidates, so a popular product cannot flood the panel. */
export const MARKET_MAX_STORES = 8;

/** Sends per claim, ever (B1): the first ask, a corrected address and one follow-up. */
export const MAX_SENDS_PER_CLAIM = 3;

// --- Auth mail + account lifecycle (T01/T05/T06/T18) -------------------------

/** Verification/reset code lifetime passed as `Email({ maxAge })` to the auth provider (D65). */
export const VERIFICATION_CODE_TTL_S = 900;

/** How long `notify`/`mailEvents` waits before treating a `claimed`/`queued`/`unknown` row as stalled and re-checking it. */
export const MAIL_RECONCILE_STALL_MS = 1_800_000;

/** mailLog rows one `sweepStalled` tick may reschedule. */
export const MAIL_SWEEP_PAGE = 50;

/** A dedupe-keyed drop row in a transient failure state can be re-claimed after this long (D70). */
export const DROP_RECLAIM_MIN_MS = 86_400_000;

/**
 * 6b-6 (D115): read-limit safety margin for the `processedEvents` pages
 * `account.exportPage`/`account.purgeStep` read in one `.paginate()` call --
 * well under Convex's 16 MiB per-transaction read cap, leaving headroom for
 * every other read the same call makes (the account/profile row, the
 * accountState progress row, etc.).
 */
export const MAX_PAGE_BYTES = 6 * 1024 * 1024;

/**
 * 6b-6 (D115): page size for the byte-aware, status-iterated branch of
 * `account.exportPage`/`account.purgeStep` that walks `processedEvents`.
 * Convex allows only ONE `.paginate()` call per function execution
 * (`account.ts`'s `ParentCursor` docstring documents the same platform
 * constraint elsewhere in that module), so the page size has to be chosen
 * BEFORE the read -- there is no way to inspect a running byte count and
 * stop mid-`.paginate()`. Sized conservatively off the worst case a single
 * row's `payload` can hold: `inbound.ts`'s `MAX_TEXT_CHARS` (60,000) at 3
 * bytes/char (multibyte UTF-8 -- CJK and similar scripts; plain ASCII never
 * gets close) is ~180 KB/row; `MAX_PAGE_BYTES / 180 KB` rounds down to
 * about 34, so 25 keeps real headroom under the budget even before counting
 * the row's other fields.
 */
export const PROCESSED_EVENTS_PAGE = 25;

/**
 * 6b-4c (D115): how long an `accountState` row may sit in `deleting` before
 * `account.reDriveStuckDeletions`'s daily cron treats a chain with no live
 * scheduled `purge` job as dead and reschedules it. 24h is generous next to
 * the inbox-delete backoff schedule (worst case ~32h across all 5 attempts)
 * so a chain that is merely slow is never mistaken for one that died.
 */
export const STUCK_DELETION_AGE_MS = 86_400_000;

/** Stuck `deleting` rows one `account.reDriveStuckDeletions` run may reschedule (contract-fixed bound). */
export const STUCK_DELETION_REDRIVE_PAGE = 50;

// --- ShopSavvy market-history state machine (T09, D71) -----------------------

/**
 * Attempts (claim + fetch) before a market lookup gives up as `terminal_failure`.
 *
 * D105 (D103 F9 follow-up): raised from 3 to 4. At 3, `MARKET_RETRY_BACKOFF_MS[2]`
 * (the 6h step) was dead code: the 3rd attempt's post-failure count (3) already
 * failed `< MARKET_MAX_ATTEMPTS` and went straight to `terminal_failure`, so only
 * index [0] (10m, before attempt 2) and [1] (1h, before attempt 3) were ever
 * read -- contradicting D71's own description ("3 attempts with 10m/1h/6h
 * backoff"). 4 attempts makes all three backoff steps reachable (10m before
 * attempt 2, 1h before attempt 3, 6h before attempt 4), matching the backoff
 * array's own length. `market.ts` (a different lane's file) already
 * documented this gap and deferred the constant change here.
 */
export const MARKET_MAX_ATTEMPTS = 4;

/** Backoff before each retry after attempts 1, 2 and 3 (10m, 1h, 6h) -- D105: all three are now reachable. */
export const MARKET_RETRY_BACKOFF_MS = [600_000, 3_600_000, 21_600_000];

/** A `success` market lookup can only be manually refreshed after this long. */
export const MARKET_REFRESH_MIN_AGE_MS = 7 * 86_400_000;

/**
 * F8 (D103): a `queued`/`running` market claim older than this is reclaimable -- the scheduled
 * `market.lookup` action almost certainly crashed or was killed rather than still being genuinely in
 * flight (a real ShopSavvy call times out at 30s; 15 minutes is generous headroom past that plus retry
 * scheduling, chosen to make a false reclaim of a run that is actually still going vanishingly
 * unlikely, while still bounding how long a stuck watch stays unrecoverable).
 *
 * F-T22-2: was duplicated privately in both `market.ts` (the reclaim itself) and `ops.ts` (`backlog`'s
 * `staleMarketRunning` diagnostic, which used to define its own copy `MARKET_RUNNING_STALE_MS`); the two
 * could drift apart with nothing to notice. Single source of truth here now; both import it.
 */
export const MARKET_CLAIM_STALE_MS = 15 * 60_000;

/** Beyond this age, `lastObservedAt` is "may be out of date" and `verdict()` returns `unknown` (D73). */
export const STALE_PRICE_MS = 3 * 86_400_000;

// --- Cron fairness (D74) ------------------------------------------------------

/** Owned items one `priceWatch.runAll` tick advances per user, off `items.by_nextCheck`. */
export const PRICE_CHECK_PER_USER_PER_TICK = 10;

/** Watches one `watches.sweep` tick advances per user, off `watches.by_status_nextCheck`. */
export const WATCH_SWEEP_PER_USER = 10;

/**
 * F1/F2 (D103): how far `priceWatch.eligibleItems` and `watches.sweep` push
 * `nextCheckAt`/`by_status_nextCheck` for a row whose ineligibility is not
 * expected to clear on its own (closed price-adjustment window, no product
 * link, returned item, example purchase, archived purchase; a tombstoned
 * owner's row in either table) -- far enough that it permanently leaves the
 * scan's head instead of being re-read (and, before this, never re-stamped
 * at all) on every tick, which is what let a backlog of such rows starve
 * every other item/watch behind them out of the scan indefinitely. A year is
 * arbitrary but effectively "never" at a 2h/1h cadence, and small enough to
 * stay an ordinary, safe timestamp (nowhere near Number.MAX_SAFE_INTEGER).
 */
export const INELIGIBLE_REST_MS = 365 * 86_400_000;

// --- Retention (T22, D75) -----------------------------------------------------

/** `processedEvents.payload` is cleared this many days after a row reaches a terminal status. */
export const RETENTION_PAYLOAD_DAYS = 30;

/** Observational checks (priceChecks/watchChecks/offerChecks) older than this are pruned. */
export const RETENTION_OBSERVATION_DAYS = 180;

/** Newest rows per parent kept when pruning observational checks, regardless of age. */
export const RETENTION_KEEP_NEWEST = 30;

/** Terminal mailLog rows (sent/failed/suppressed) older than this are pruned. */
export const RETENTION_MAILLOG_DAYS = 90;

/** Rows one resumable retention pass reads before rescheduling itself. */
export const RETENTION_PAGE = 200;

/** `opsState` stash rows (`mailEvent:*` F8 pending events, `e2e:code:*` capture, D99 N7) older than this are pruned. */
export const RETENTION_STASH_DAYS = 7;

/** D107 hygiene: `users` rows with no `emailVerificationTime` older than this are pruned (verification gates sign-in, so they own no application data). */
export const RETENTION_UNVERIFIED_DAYS = 7;

// --- Input bounds (B4, M1) ---------------------------------------------------

/** Purchases per user, archived included: bounds every `by_user` read and the policy research a user can ever trigger. */
export const MAX_PURCHASES_PER_USER = 200;
/** Line items on one purchase: each can become a scraped page every two hours. */
export const MAX_ITEMS_PER_PURCHASE = 50;
export const MAX_MERCHANT_CHARS = 120;
export const MAX_ITEM_NAME_CHARS = 200;
export const MAX_ORDER_REF_CHARS = 100;
export const MAX_DOMAIN_CHARS = 253;
