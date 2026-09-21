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

export type GlobalBudgetKind = "price_check" | "policy_fetch" | "drop_email";

/**
 * Deployment-wide daily kill switches (usage rows with no userId), so the worst day is bounded in dollars whatever
 * the number of accounts.
 */
export const GLOBAL_DAILY_BUDGETS: Record<GlobalBudgetKind, { max: number; label: string }> = {
  /** One unit = one scrape + one extraction (~1-2 cents). The two sweeps alone can use 1,800 a day (50/h + 50/2h); 3,000 leaves room for manual checks and caps the day at roughly $50. */
  price_check: { max: 3_000, label: "price checks" },
  /** One unit = one policy research (a search that scrapes 3 pages plus up to 3 extractions, ~5 cents). 500 is ~250 new stores a day and at most about $25. */
  policy_fetch: { max: 500, label: "store policy look-ups" },
  /** Drop alerts leave from one shared inbox to unverified addresses (B2); 300 a day keeps the sending domain's reputation safe however many accounts exist. */
  drop_email: { max: 300, label: "price alert emails" },
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
  /** Mail to a caller-chosen address from our sending domain (B1): 10 a day is more claims than anyone files and too few to be a relay. */
  claim_email: { max: 10, label: "sending claim emails" },
  /** Manual "check the price now" on owned items: one scrape + one extraction each; 40 is every item on a big order, twice. */
  item_check: { max: 40, label: "checking prices on your purchases", global: { kind: "price_check", units: 1 } },
  /** Manual "check now" on watches, on top of the 10-minute per-watch cooldown (H2): 40 is most of a full watch list once a day. */
  watch_check: { max: 40, label: "checking prices on watched items", global: { kind: "price_check", units: 1 } },
} as const satisfies Record<string, Budget>;

export type BudgetKind = keyof typeof DAILY_BUDGETS;

/** Sends per claim, ever (B1): the first ask, a corrected address and one follow-up. */
export const MAX_SENDS_PER_CLAIM = 3;

// --- Input bounds (B4, M1) ---------------------------------------------------

/** Purchases per user, archived included: bounds every `by_user` read and the policy research a user can ever trigger. */
export const MAX_PURCHASES_PER_USER = 200;
/** Line items on one purchase: each can become a scraped page every two hours. */
export const MAX_ITEMS_PER_PURCHASE = 50;
export const MAX_MERCHANT_CHARS = 120;
export const MAX_ITEM_NAME_CHARS = 200;
export const MAX_ORDER_REF_CHARS = 100;
export const MAX_DOMAIN_CHARS = 253;
