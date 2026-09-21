import { v, type Infer } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { watchStatus } from "./schema";
import { confirmedOffers } from "./offers";
import { MAX_ITEMS_PER_PURCHASE } from "./limits";

/**
 * Read models for the dashboard: what happened lately, and how each store is
 * behaving. Both are derived on read from rows that already exist; nothing here
 * writes, and nothing is shown that was not observed or recorded.
 *
 * D72 canonical counting: a watch with `purchaseId` set (i.e. bought) is
 * skipped entirely here — its checks and drops are carried by the purchase
 * item `markBought` created, so a converted watch is counted exactly once.
 * Every read below is a bounded, status-indexed page, never a table scan
 * filtered after the fact, so archive/needs_review/rejected churn beyond a
 * page's bound can never push an active/confirmed row out of view (P05). A
 * page that comes back full sets `truncated`, so a sampled window is always
 * labelled as such and never presented as an account total (D72 invariant).
 */

const MAX_WATCHES = 40;
const MAX_PURCHASES = 40;
const MAX_CLAIMS = 40;
const CHECKS_PER_PRODUCT = 12;
const FEED_LIMIT = 40;
/**
 * D93 (D103): a ceiling on the TOTAL number of purchase items `activity`/
 * `sources` fetch price-check history for, across every purchase combined --
 * not per purchase. `MAX_ITEMS_PER_PURCHASE` (50, shared app-wide) times
 * `MAX_PURCHASES` (40) purchases is up to 2,000 items, each costing another
 * `CHECKS_PER_PRODUCT` reads: unbounded per-purchase caps alone cannot stop
 * that multiplication (a account with many purchases, each holding a modest
 * item count, still blows past any reasonable read budget). Once this many
 * items have been read this call, later purchases still get their
 * `purchase_added` event, just no per-item price events -- `truncated` says so.
 */
const MAX_ITEMS_TOTAL = 150;
/** Watch statuses that can still contribute to the dashboard (archived never read at all). */
const COUNTED_WATCH_STATUSES = ["active", "paused", "bought"] as const;

/** Shown alongside `activity`/`sources` so the UI can render the sampled window instead of implying a total. */
export const WINDOW_NOTE = `recent activity (up to ${MAX_WATCHES} watches, ${MAX_PURCHASES} purchases, last ${CHECKS_PER_PRODUCT} checks per item)`;

const activityKind = v.union(
  v.literal("price_drop"),
  v.literal("price_rise"),
  v.literal("price_seen"),
  v.literal("price_unreadable"),
  v.literal("watch_added"),
  v.literal("purchase_added"),
  v.literal("alert_sent"),
  v.literal("claim_opened"),
  v.literal("ask_sent"),
  v.literal("reply_received"),
  v.literal("credit_promised"),
  v.literal("credit_confirmed"),
  v.literal("charged_again"),
);

const activityEvent = v.object({
  id: v.string(),
  at: v.number(),
  kind: activityKind,
  /** Product or claim the event is about. */
  subject: v.string(),
  storeDomain: v.optional(v.string()),
  currency: v.optional(v.string()),
  cents: v.optional(v.number()),
  /** Signed change against the previous observation of the same product; negative is cheaper. */
  deltaCents: v.optional(v.number()),
  note: v.optional(v.string()),
  watchId: v.optional(v.id("watches")),
  purchaseId: v.optional(v.id("purchases")),
  claimId: v.optional(v.id("claims")),
});

type ActivityEvent = typeof activityEvent.type;

/** Turns one product's observations (newest first) into drop / rise / first-seen / unreadable events. */
function priceEvents(
  checks: Array<{ _id: string; observedAt: number; observedCents?: number; currency?: string; note?: string }>,
  base: Pick<ActivityEvent, "subject" | "storeDomain" | "watchId" | "purchaseId">,
): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  const oldestFirst = [...checks].reverse();
  let previous: number | undefined;
  for (const check of oldestFirst) {
    if (check.observedCents === undefined) {
      out.push({ ...base, id: check._id, at: check.observedAt, kind: "price_unreadable", note: check.note });
      continue;
    }
    const delta = previous === undefined ? undefined : check.observedCents - previous;
    // An unchanged price is not news; the chart already shows it.
    if (delta !== 0) {
      out.push({
        ...base,
        id: check._id,
        at: check.observedAt,
        kind: delta === undefined ? "price_seen" : delta < 0 ? "price_drop" : "price_rise",
        cents: check.observedCents,
        deltaCents: delta,
        currency: check.currency,
      });
    }
    previous = check.observedCents;
  }
  return out;
}

type Paged<T> = { rows: T[]; truncated: boolean };

/**
 * The caller's active/paused/bought watches, newest first: one bounded
 * indexed page per status (`by_user_status`, T01) instead of a `by_user` page
 * filtered after the fact. Archived rows are never read, so no amount of
 * archive churn can hide an active one behind the page bound (P05).
 */
async function userWatches(ctx: QueryCtx, userId: Id<"users">): Promise<Paged<Doc<"watches">>> {
  const pages = await Promise.all(
    COUNTED_WATCH_STATUSES.map((status) =>
      ctx.db
        .query("watches")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
        .order("desc")
        .take(MAX_WATCHES),
    ),
  );
  return { rows: pages.flat(), truncated: pages.some((page) => page.length >= MAX_WATCHES) };
}

/** The caller's active purchases, newest first: one bounded indexed page (`by_user_status`, T01). */
async function userPurchases(ctx: QueryCtx, userId: Id<"users">): Promise<Paged<Doc<"purchases">>> {
  const rows = await ctx.db
    .query("purchases")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "active"))
    .order("desc")
    .take(MAX_PURCHASES);
  return { rows, truncated: rows.length >= MAX_PURCHASES };
}

/**
 * Reads each purchase's items, in order, against ONE shared budget of
 * `MAX_ITEMS_TOTAL` across every purchase combined (see its doc comment).
 *
 * C2/D107: this used to hand out a FIXED per-purchase share up front (an
 * equal split of the budget across every purchase, sized to the worst
 * case of `MAX_ITEMS_PER_PURCHASE` each) so the reads below could run in
 * parallel with no shared counter. That meant a purchase with only 1 item
 * still reserved and burned a full 50-item share -- with `MAX_ITEMS_TOTAL
 * = 150`, only the 3 newest purchases ever got read at all, however small
 * they actually were (10 purchases x 1 item each silently produced 0
 * `bought`/price events for 7 of them). Sequential and budgeted by ROWS
 * ACTUALLY READ instead: a purchase that holds fewer items than its cap
 * only spends what it holds, leaving the rest of the shared budget for
 * later purchases. `truncated` is set only on a REAL cut -- a purchase
 * that itself held more than its allotted cap, or one skipped outright
 * because the shared budget was already spent -- never merely because a
 * purchase's cap came in under `MAX_ITEMS_PER_PURCHASE` (that no longer
 * implies a cut once the cap can legitimately be sized to a purchase that
 * turned out smaller). The checks-per-item fan-out callers run afterward
 * can still be fully parallel: it only needs the item lists resolved here.
 */
async function itemsWithinBudget(
  ctx: QueryCtx,
  purchases: Doc<"purchases">[],
): Promise<{ perPurchase: Doc<"items">[][]; truncated: boolean }> {
  let room = MAX_ITEMS_TOTAL;
  let truncated = false;
  const perPurchase: Doc<"items">[][] = [];
  for (const purchase of purchases) {
    if (room <= 0) {
      perPurchase.push([]);
      truncated = true;
      continue;
    }
    const cap = Math.min(MAX_ITEMS_PER_PURCHASE, room);
    const page = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
      .take(cap + 1);
    const cut = page.length > cap;
    const kept = cut ? page.slice(0, cap) : page;
    room -= kept.length;
    if (cut) truncated = true;
    perPurchase.push(kept);
  }
  return { perPurchase, truncated };
}

/**
 * The newest things that happened on the caller's account, newest first, with
 * `truncated` set when any bounded page below came back full (D72: a sampled
 * window, never presented as the full history). `{ events: [], truncated:
 * false, windowNote }` when signed out.
 */
export const activity = query({
  args: {},
  returns: v.object({ events: v.array(activityEvent), truncated: v.boolean(), windowNote: v.string() }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { events: [], truncated: false, windowNote: WINDOW_NOTE };
    const events: ActivityEvent[] = [];
    const watches = await userWatches(ctx, userId);
    const purchases = await userPurchases(ctx, userId);
    let truncated = watches.truncated || purchases.truncated;

    // D72 canonical counting: a bought watch's checks and drops are carried by
    // the purchase item `markBought` created, so it contributes nothing here.
    // D93: fanned out with Promise.all (each watch's checks page is an
    // independent read) instead of one page at a time in series.
    const liveWatchRows = watches.rows.filter((w) => !w.purchaseId);
    const watchEventLists = await Promise.all(
      liveWatchRows.map(async (watch) => {
        const base = { subject: watch.name, storeDomain: watch.merchantDomain, watchId: watch._id };
        const checks = await ctx.db
          .query("watchChecks")
          .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
          .order("desc")
          .take(CHECKS_PER_PRODUCT);
        if (checks.length >= CHECKS_PER_PRODUCT) truncated = true;
        return [{ ...base, id: `${watch._id}:added`, at: watch._creationTime, kind: "watch_added" as const }, ...priceEvents(checks, base)];
      }),
    );
    events.push(...watchEventLists.flat());

    // D93/C2 (D107): MAX_ITEMS_TOTAL bounds the grand total of items whose
    // price history is actually read, across every purchase combined (see
    // its doc comment) -- not just per purchase, which cannot bound the
    // purchases x items product. `itemsWithinBudget` reads the item lists
    // sequentially, budgeted by rows actually read; the checks-per-item fan
    // -out below is still fully parallel, since it only needs those lists.
    const { perPurchase: purchaseItems, truncated: itemsCut } = await itemsWithinBudget(ctx, purchases.rows);
    if (itemsCut) truncated = true;

    const purchaseEventLists = await Promise.all(
      purchases.rows.map(async (purchase, i) => {
        const purchaseEvents: ActivityEvent[] = [
          {
            id: `${purchase._id}:added`,
            at: purchase._creationTime,
            kind: "purchase_added",
            subject: purchase.merchant,
            storeDomain: purchase.merchantDomain,
            purchaseId: purchase._id,
            note: purchase.isExample ? "Example" : undefined,
          },
        ];
        const itemEventLists = await Promise.all(
          purchaseItems[i].map(async (item) => {
            const checks = await ctx.db
              .query("priceChecks")
              .withIndex("by_item", (q) => q.eq("itemId", item._id))
              .order("desc")
              .take(CHECKS_PER_PRODUCT);
            if (checks.length >= CHECKS_PER_PRODUCT) truncated = true;
            return priceEvents(checks, {
              subject: item.name,
              storeDomain: purchase.merchantDomain,
              purchaseId: purchase._id,
            });
          }),
        );
        purchaseEvents.push(...itemEventLists.flat());
        return purchaseEvents;
      }),
    );
    events.push(...purchaseEventLists.flat());

    const mails = await ctx.db
      .query("mailLog")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    for (const mail of mails) {
      if (mail.status !== "sent") continue;
      events.push({
        id: mail._id,
        at: mail.sentAt ?? mail._creationTime,
        kind: "alert_sent",
        subject: mail.subject,
        cents: mail.cents,
        watchId: mail.watchId,
      });
    }

    const claims = await ctx.db
      .query("claims")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_CLAIMS);
    if (claims.length >= MAX_CLAIMS) truncated = true;
    // D93: each claim's own reads (item/purchase lookups, drafts/replies/
    // ledger pages) are independent of every other claim's, so they run in
    // parallel too.
    const claimEventLists = await Promise.all(
      claims.map(async (claim) => {
        const claimEvents: ActivityEvent[] = [];
        const [item, purchase, drafts, replies, ledger] = await Promise.all([
          ctx.db.get(claim.itemId),
          ctx.db.get(claim.purchaseId),
          ctx.db
            .query("drafts")
            .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
            .collect(),
          ctx.db
            .query("replies")
            .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
            .collect(),
          ctx.db
            .query("ledgerEvents")
            .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
            .collect(),
        ]);
        const base = {
          subject: item?.name ?? "Claim",
          storeDomain: purchase?.merchantDomain,
          currency: purchase?.currency,
          claimId: claim._id,
          purchaseId: claim.purchaseId,
        };
        claimEvents.push({
          ...base,
          id: `${claim._id}:opened`,
          at: claim._creationTime,
          kind: "claim_opened",
          cents: claim.expectedCents,
          note: claim.isExample ? "Example" : undefined,
        });

        for (const draft of drafts) {
          if (!draft.agentmailMessageId || draft.approvedAt === undefined) continue;
          claimEvents.push({ ...base, id: `${draft._id}:sent`, at: draft.approvedAt, kind: "ask_sent", note: draft.to });
        }

        for (const reply of replies) {
          claimEvents.push({
            ...base,
            id: reply._id,
            at: reply.receivedAt,
            kind: "reply_received",
            note: reply.summary,
          });
        }

        for (const entry of ledger) {
          claimEvents.push({
            ...base,
            id: entry._id,
            at: entry._creationTime,
            kind:
              entry.kind === "confirmed_credit"
                ? "credit_confirmed"
                : entry.kind === "promised_credit"
                  ? "credit_promised"
                  : "charged_again",
            cents: entry.cents,
          });
        }
        return claimEvents;
      }),
    );
    events.push(...claimEventLists.flat());

    const sorted = events.sort((a, b) => b.at - a.at);
    if (sorted.length > FEED_LIMIT) truncated = true;
    return { events: sorted.slice(0, FEED_LIMIT), truncated, windowNote: WINDOW_NOTE };
  },
});

/** The cheapest current price held in one currency, with the product it belongs to. */
const bestInCurrency = v.object({ cents: v.number(), subject: v.string() });

const sourceRow = v.object({
  domain: v.string(),
  /** Products of the caller's that live at this store. */
  watching: v.number(),
  bought: v.number(),
  /** Confirmed same-product listings at this store for watches that live elsewhere. */
  offers: v.number(),
  checks: v.number(),
  /** Checks that produced a usable price. checks - priced = pages we could not read. */
  priced: v.number(),
  drops: v.number(),
  lastCheckedAt: v.optional(v.number()),
  /**
   * Cheapest current price held at this store, one entry per currency (D72):
   * money is never summed or compared across currencies, so a store with both
   * a USD and a EUR listing gets two independent entries, not one min().
   */
  bests: v.record(v.string(), bestInCurrency),
});

type SourceRow = typeof sourceRow.type;

/**
 * One row per store the caller's products touch: how much we watch there, how
 * often the page could actually be read, and how often the price fell.
 * `truncated` is set when any bounded page below came back full (D72: a
 * sampled window, never presented as the full history).
 * `{ rows: [], truncated: false, windowNote }` when signed out.
 */
export const sources = query({
  args: {},
  returns: v.object({ rows: v.array(sourceRow), truncated: v.boolean(), windowNote: v.string() }),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { rows: [], truncated: false, windowNote: WINDOW_NOTE };
    const rows = new Map<string, SourceRow>();
    const row = (domain: string): SourceRow => {
      let existing = rows.get(domain);
      if (!existing) {
        existing = { domain, watching: 0, bought: 0, offers: 0, checks: 0, priced: 0, drops: 0, bests: {} };
        rows.set(domain, existing);
      }
      return existing;
    };
    /** Records a currency's best price only against prior prices in that SAME currency (D72). */
    const considerBest = (target: SourceRow, cents: number, currency: string, subject: string) => {
      const existing = target.bests[currency];
      if (!existing || cents < existing.cents) target.bests[currency] = { cents, subject };
    };
    const tally = (
      target: SourceRow,
      checks: Array<{ observedAt: number; observedCents?: number; currency?: string }>,
      subject: string,
    ) => {
      const oldestFirst = [...checks].reverse();
      let previous: number | undefined;
      let previousCurrency: string | undefined;
      for (const check of oldestFirst) {
        target.checks += 1;
        target.lastCheckedAt = Math.max(target.lastCheckedAt ?? 0, check.observedAt);
        if (check.observedCents === undefined) continue;
        target.priced += 1;
        // A "drop" only means something between two prices in the same currency (D72).
        if (previous !== undefined && previousCurrency === check.currency && check.observedCents < previous) {
          target.drops += 1;
        }
        previous = check.observedCents;
        previousCurrency = check.currency;
      }
      if (previous !== undefined && previousCurrency !== undefined) {
        considerBest(target, previous, previousCurrency, subject);
      }
    };

    let truncated = false;
    const watches = await userWatches(ctx, userId);
    const purchases = await userPurchases(ctx, userId);
    truncated = watches.truncated || purchases.truncated;

    // D72 canonical counting: a bought watch's checks, drops and offers are
    // carried by the purchase item `markBought` created, so it is skipped
    // here. D93: fanned out with Promise.all -- every watch's reads are
    // independent, and mutating the shared `rows` map from parallel branches
    // is safe here because every mutation (`+=`, `Math.max`, `considerBest`'s
    // min) is commutative, so it does not matter which branch runs first.
    await Promise.all(
      watches.rows
        .filter((w) => !w.purchaseId)
        .map(async (watch) => {
          const target = row(watch.merchantDomain);
          target.watching += 1;
          const checks = await ctx.db
            .query("watchChecks")
            .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
            .order("desc")
            .take(CHECKS_PER_PRODUCT);
          if (checks.length >= CHECKS_PER_PRODUCT) truncated = true;
          tally(target, checks, watch.name);

          // Shared with priceHistory/trackedTable (offers.ts): reads every row
          // for the watch, so a confirmed offer behind any number of candidate
          // or rejected rows is never missed (P05).
          for (const offer of await confirmedOffers(ctx, watch._id, userId)) {
            const store = row(offer.storeDomain);
            store.offers += 1;
            if (offer.lastCheckedAt !== undefined) {
              store.lastCheckedAt = Math.max(store.lastCheckedAt ?? 0, offer.lastCheckedAt);
            }
            if (offer.lastCents !== undefined && offer.currency !== undefined) {
              considerBest(store, offer.lastCents, offer.currency, watch.name);
            }
          }
        }),
    );

    // D93/C2 (D107): same MAX_ITEMS_TOTAL discipline as `activity` (see its
    // doc comment and `itemsWithinBudget`'s) -- budgeted by rows actually
    // read, not a fixed per-purchase up-front reservation.
    const nonExample = purchases.rows.filter((p) => !p.isExample);
    const { perPurchase: sourceItems, truncated: itemsCut } = await itemsWithinBudget(ctx, nonExample);
    if (itemsCut) truncated = true;
    await Promise.all(
      nonExample.map(async (purchase, i) => {
        const target = row(purchase.merchantDomain);
        await Promise.all(
          sourceItems[i].map(async (item) => {
            target.bought += 1;
            const checks = await ctx.db
              .query("priceChecks")
              .withIndex("by_item", (q) => q.eq("itemId", item._id))
              .order("desc")
              .take(CHECKS_PER_PRODUCT);
            if (checks.length >= CHECKS_PER_PRODUCT) truncated = true;
            tally(target, checks, item.name);
          }),
        );
      }),
    );

    const sorted = [...rows.values()].sort(
      (a, b) => b.watching + b.bought + b.offers - (a.watching + a.bought + a.offers) || b.checks - a.checks,
    );
    return { rows: sorted, truncated, windowNote: WINDOW_NOTE };
  },
});

// ---------------------------------------------------------------------------
// Per-store price history (dashboard chart + table)
// ---------------------------------------------------------------------------

/** Watches either read model considers, newest first. */
const MAX_TRACKED = 30;
/** Points per store in `priceHistory` (10 days at the two-hour cadence). */
const CHART_POINTS = 120;
/**
 * Points per store behind `trackedTable`'s changePct. Smaller than the chart's
 * window because the table reads every watch at once: 30 watches x 9 stores.
 */
const TABLE_POINTS = 20;
/** Confirmed offers shown beside the primary store, cheapest first. Bounds the per-watch fan-out. */
const MAX_OFFER_STORES = 8;
/** Rows read to break a tie between default-watch candidates. */
const TIE_BREAK_SCAN = 60;
const LIVE_STATUSES = ["active", "paused", "bought"] as const;

const pricePoint = v.object({ at: v.number(), cents: v.number() });
type PricePoint = Infer<typeof pricePoint>;

const historyStore = v.object({
  domain: v.string(),
  isPrimary: v.boolean(),
  productUrl: v.string(),
  /** The price currently held for this store; null when the latest read of an offer was not accepted. */
  lastCents: v.union(v.number(), v.null()),
  /** The oldest plotted point. */
  firstCents: v.union(v.number(), v.null()),
  /** (newest point - oldest point) / oldest point * 100, one decimal; null with fewer than two points. */
  changePct: v.union(v.number(), v.null()),
  lastCheckedAt: v.union(v.number(), v.null()),
  /** Accepted observations only, oldest first, at most 120. */
  points: v.array(pricePoint),
});
type HistoryStore = Infer<typeof historyStore>;

const priceHistoryView = v.object({
  watchId: v.id("watches"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
  currency: v.string(),
  status: watchStatus,
  targetCents: v.union(v.number(), v.null()),
  /** The primary store first, then confirmed offers cheapest first (at most 8). */
  stores: v.array(historyStore),
  /** The lowest plotted point across every store; the earliest one on a tie. */
  lowest: v.union(v.null(), v.object({ cents: v.number(), at: v.number(), domain: v.string() })),
  /** The caller's non-archived watches, newest first, at most 30. `stores` counts the primary store. */
  options: v.array(v.object({ watchId: v.id("watches"), name: v.string(), stores: v.number() })),
});

const trackedRow = v.object({
  watchId: v.id("watches"),
  name: v.string(),
  imageUrl: v.union(v.string(), v.null()),
  status: watchStatus,
  currency: v.union(v.string(), v.null()),
  targetCents: v.union(v.number(), v.null()),
  stores: v.array(
    v.object({
      domain: v.string(),
      isPrimary: v.boolean(),
      lastCents: v.union(v.number(), v.null()),
      changePct: v.union(v.number(), v.null()),
    }),
  ),
  /** The cheapest price currently held across the row's stores, and where. */
  lowestCents: v.union(v.number(), v.null()),
  lowestDomain: v.union(v.string(), v.null()),
});

/** Percent change across a series (oldest first), one decimal. Null with fewer than two points. */
export function changePct(points: PricePoint[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].cents;
  const last = points[points.length - 1].cents;
  if (first <= 0) return null;
  return Math.round(((last - first) / first) * 1000) / 10;
}

/** The caller's non-archived watches, newest first: one bounded indexed page per live status. */
async function liveWatches(ctx: QueryCtx, userId: Id<"users">): Promise<Doc<"watches">[]> {
  const pages = await Promise.all(
    LIVE_STATUSES.map((status) =>
      ctx.db
        .query("watches")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
        .order("desc")
        .take(MAX_TRACKED),
    ),
  );
  return pages
    .flat()
    .sort((a, b) => b._creationTime - a._creationTime)
    .slice(0, MAX_TRACKED);
}

/** The watch's own page: the newest `limit` accepted checks, oldest first. Failed checks sit between, hence 2x. */
async function primaryPoints(ctx: QueryCtx, watchId: Id<"watches">, limit: number): Promise<PricePoint[]> {
  const rows = await ctx.db
    .query("watchChecks")
    .withIndex("by_watch", (q) => q.eq("watchId", watchId))
    .order("desc")
    .take(limit * 2);
  return rows
    .flatMap((c) => (c.observedCents === undefined ? [] : [{ at: c.observedAt, cents: c.observedCents }]))
    .slice(0, limit)
    .reverse();
}

/** One confirmed offer's series, oldest first. An offer priced before `offerChecks` existed is its one known point. */
async function offerPoints(ctx: QueryCtx, offer: Doc<"offers">, limit: number): Promise<PricePoint[]> {
  const rows = await ctx.db
    .query("offerChecks")
    .withIndex("by_offer", (q) => q.eq("offerId", offer._id))
    .order("desc")
    .take(limit);
  if (rows.length === 0) {
    return offer.lastCents === undefined
      ? []
      : [{ at: offer.lastCheckedAt ?? Math.floor(offer._creationTime), cents: offer.lastCents }];
  }
  return rows.map((c) => ({ at: c.observedAt, cents: c.observedCents })).reverse();
}

/**
 * F5a (D103): the currency each entry of `storeSeries`'s returned array
 * prices in, in the same order (primary store first, then
 * `offers.slice(0, MAX_OFFER_STORES)`) -- kept separate from `HistoryStore`
 * itself (which has no `currency` field; adding one would be a public-schema
 * change) purely so `priceHistory`/`trackedTable` can scope their "lowest"
 * comparison to one currency (D72: money is never compared across
 * currencies) without touching what is sent to the client.
 */
function storeCurrencies(watch: Doc<"watches">, offers: Doc<"offers">[]): Array<string | null> {
  return [watch.currency ?? null, ...offers.slice(0, MAX_OFFER_STORES).map((o) => o.currency ?? null)];
}

/** Shared by both read models: the primary store, then the watch's confirmed offers, each with its own series. */
async function storeSeries(
  ctx: QueryCtx,
  watch: Doc<"watches">,
  offers: Doc<"offers">[],
  pointsPerStore: number,
): Promise<HistoryStore[]> {
  const primary = await primaryPoints(ctx, watch._id, pointsPerStore);
  const stores: HistoryStore[] = [
    {
      domain: watch.merchantDomain,
      isPrimary: true,
      productUrl: watch.productUrl,
      lastCents: watch.lastCents ?? null,
      firstCents: primary[0]?.cents ?? null,
      changePct: changePct(primary),
      lastCheckedAt: watch.lastCheckedAt ?? null,
      points: primary,
    },
  ];
  for (const offer of offers.slice(0, MAX_OFFER_STORES)) {
    const points = await offerPoints(ctx, offer, pointsPerStore);
    stores.push({
      domain: offer.storeDomain,
      isPrimary: false,
      productUrl: offer.productUrl,
      lastCents: offer.lastCents ?? null,
      firstCents: points[0]?.cents ?? null,
      changePct: changePct(points),
      lastCheckedAt: offer.lastCheckedAt ?? null,
      points,
    });
  }
  return stores;
}

/**
 * One watch's price at every store we hold it for: the chart behind the
 * dashboard. Without a `watchId` it picks the caller's watch with the most
 * confirmed stores (then most accepted observations, then newest). `null` when
 * signed out, when the caller has no watches, or when the watch is missing,
 * archived or someone else's.
 */
export const priceHistory = query({
  args: { watchId: v.optional(v.id("watches")) },
  returns: v.union(v.null(), priceHistoryView),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const watches = await liveWatches(ctx, userId);
    const offersByWatch = new Map<Id<"watches">, Doc<"offers">[]>();
    for (const w of watches) offersByWatch.set(w._id, await confirmedOffers(ctx, w._id, userId));

    let watch: Doc<"watches"> | null = null;
    if (args.watchId !== undefined) {
      watch = watches.find((w) => w._id === args.watchId) ?? (await ctx.db.get(args.watchId));
      if (!watch || watch.userId !== userId || watch.status === "archived") return null;
    } else {
      if (watches.length === 0) return null;
      const most = Math.max(...watches.map((w) => offersByWatch.get(w._id)?.length ?? 0));
      const tied = watches.filter((w) => (offersByWatch.get(w._id)?.length ?? 0) === most);
      watch = tied[0];
      if (tied.length > 1) {
        let best = -1;
        // `tied` is newest first and only a strictly larger count replaces the pick, so newest wins a tie.
        for (const w of tied) {
          const observations = (await primaryPoints(ctx, w._id, TIE_BREAK_SCAN)).length;
          if (observations > best) {
            best = observations;
            watch = w;
          }
        }
      }
    }

    const offers = offersByWatch.get(watch._id) ?? (await confirmedOffers(ctx, watch._id, userId));
    const stores = await storeSeries(ctx, watch, offers, CHART_POINTS);

    // F5a (D103): "lowest" only ever compares points priced in the primary
    // store's own currency (D72) -- a store whose offer is in a different
    // currency is still shown in `stores`, just excluded from this
    // comparison, the same way `insights.sources`'s `considerBest` already
    // scopes a store's "best" price to matching currencies.
    const currencies = storeCurrencies(watch, offers);
    const primaryCurrency = currencies[0];
    let lowest: { cents: number; at: number; domain: string } | null = null;
    for (let i = 0; i < stores.length; i++) {
      if (primaryCurrency !== null && currencies[i] !== primaryCurrency) continue;
      const store = stores[i];
      for (const p of store.points) {
        if (lowest === null || p.cents < lowest.cents || (p.cents === lowest.cents && p.at < lowest.at)) {
          lowest = { cents: p.cents, at: p.at, domain: store.domain };
        }
      }
    }

    return {
      watchId: watch._id,
      name: watch.name,
      imageUrl: watch.imageUrl ?? null,
      currency: watch.currency ?? offers.find((o) => o.currency !== undefined)?.currency ?? "USD",
      status: watch.status,
      targetCents: watch.targetCents ?? null,
      stores,
      lowest,
      options: watches.map((w) => ({
        watchId: w._id,
        name: w.name,
        stores: 1 + Math.min(offersByWatch.get(w._id)?.length ?? 0, MAX_OFFER_STORES),
      })),
    };
  },
});

/** Every non-archived watch of the caller's with its stores side by side, newest first. `[]` when signed out. */
export const trackedTable = query({
  args: {},
  returns: v.array(trackedRow),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const out: Infer<typeof trackedRow>[] = [];
    for (const watch of await liveWatches(ctx, userId)) {
      const offers = await confirmedOffers(ctx, watch._id, userId);
      const stores = await storeSeries(ctx, watch, offers, TABLE_POINTS);
      // F5a (D103): same currency scoping as `priceHistory.lowest`.
      const currencies = storeCurrencies(watch, offers);
      const primaryCurrency = currencies[0];
      let lowest: { cents: number; domain: string } | null = null;
      for (let i = 0; i < stores.length; i++) {
        if (primaryCurrency !== null && currencies[i] !== primaryCurrency) continue;
        const store = stores[i];
        if (store.lastCents !== null && (lowest === null || store.lastCents < lowest.cents)) {
          lowest = { cents: store.lastCents, domain: store.domain };
        }
      }
      out.push({
        watchId: watch._id,
        name: watch.name,
        imageUrl: watch.imageUrl ?? null,
        status: watch.status,
        currency: watch.currency ?? null,
        targetCents: watch.targetCents ?? null,
        stores: stores.map((s) => ({
          domain: s.domain,
          isPrimary: s.isPrimary,
          lastCents: s.lastCents,
          changePct: s.changePct,
        })),
        lowestCents: lowest?.cents ?? null,
        lowestDomain: lowest?.domain ?? null,
      });
    }
    return out;
  },
});
