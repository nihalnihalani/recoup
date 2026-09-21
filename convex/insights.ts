import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";

/**
 * Read models for the dashboard: what happened lately, and how each store is
 * behaving. Both are derived on read from rows that already exist; nothing here
 * writes, and nothing is shown that was not observed or recorded.
 */

const MAX_WATCHES = 40;
const MAX_PURCHASES = 40;
const MAX_CLAIMS = 40;
const CHECKS_PER_PRODUCT = 12;
const FEED_LIMIT = 40;

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

async function userWatches(ctx: QueryCtx, userId: Id<"users">) {
  return await ctx.db
    .query("watches")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_WATCHES);
}

async function userPurchases(ctx: QueryCtx, userId: Id<"users">) {
  const rows = await ctx.db
    .query("purchases")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(MAX_PURCHASES);
  return rows.filter((p) => p.status === "active");
}

/** The newest things that happened on the caller's account, newest first. `[]` when signed out. */
export const activity = query({
  args: {},
  returns: v.array(activityEvent),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const events: ActivityEvent[] = [];

    for (const watch of await userWatches(ctx, userId)) {
      if (watch.status === "archived") continue;
      const base = { subject: watch.name, storeDomain: watch.merchantDomain, watchId: watch._id };
      events.push({ ...base, id: `${watch._id}:added`, at: watch._creationTime, kind: "watch_added" });
      const checks = await ctx.db
        .query("watchChecks")
        .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
        .order("desc")
        .take(CHECKS_PER_PRODUCT);
      events.push(...priceEvents(checks, base));
    }

    for (const purchase of await userPurchases(ctx, userId)) {
      events.push({
        id: `${purchase._id}:added`,
        at: purchase._creationTime,
        kind: "purchase_added",
        subject: purchase.merchant,
        storeDomain: purchase.merchantDomain,
        purchaseId: purchase._id,
        note: purchase.isExample ? "Example" : undefined,
      });
      const items = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
        .collect();
      for (const item of items) {
        const checks = await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", item._id))
          .order("desc")
          .take(CHECKS_PER_PRODUCT);
        events.push(
          ...priceEvents(checks, {
            subject: item.name,
            storeDomain: purchase.merchantDomain,
            purchaseId: purchase._id,
          }),
        );
      }
    }

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
    for (const claim of claims) {
      const item = await ctx.db.get(claim.itemId);
      const purchase = await ctx.db.get(claim.purchaseId);
      const base = {
        subject: item?.name ?? "Claim",
        storeDomain: purchase?.merchantDomain,
        currency: purchase?.currency,
        claimId: claim._id,
        purchaseId: claim.purchaseId,
      };
      events.push({
        ...base,
        id: `${claim._id}:opened`,
        at: claim._creationTime,
        kind: "claim_opened",
        cents: claim.expectedCents,
        note: claim.isExample ? "Example" : undefined,
      });

      const drafts = await ctx.db
        .query("drafts")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect();
      for (const draft of drafts) {
        if (!draft.agentmailMessageId || draft.approvedAt === undefined) continue;
        events.push({ ...base, id: `${draft._id}:sent`, at: draft.approvedAt, kind: "ask_sent", note: draft.to });
      }

      const replies = await ctx.db
        .query("replies")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect();
      for (const reply of replies) {
        events.push({
          ...base,
          id: reply._id,
          at: reply.receivedAt,
          kind: "reply_received",
          note: reply.summary,
        });
      }

      const ledger = await ctx.db
        .query("ledgerEvents")
        .withIndex("by_claim", (q) => q.eq("claimId", claim._id))
        .collect();
      for (const entry of ledger) {
        events.push({
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
    }

    return events.sort((a, b) => b.at - a.at).slice(0, FEED_LIMIT);
  },
});

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
  /** Cheapest current price we hold at this store, with its product, for the card's headline. */
  bestCents: v.optional(v.number()),
  bestSubject: v.optional(v.string()),
  currency: v.optional(v.string()),
});

type SourceRow = typeof sourceRow.type;

/**
 * One row per store the caller's products touch: how much we watch there, how
 * often the page could actually be read, and how often the price fell. `[]`
 * when signed out.
 */
export const sources = query({
  args: {},
  returns: v.array(sourceRow),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = new Map<string, SourceRow>();
    const row = (domain: string): SourceRow => {
      let existing = rows.get(domain);
      if (!existing) {
        existing = { domain, watching: 0, bought: 0, offers: 0, checks: 0, priced: 0, drops: 0 };
        rows.set(domain, existing);
      }
      return existing;
    };
    const tally = (
      target: SourceRow,
      checks: Array<{ observedAt: number; observedCents?: number; currency?: string }>,
      subject: string,
    ) => {
      const oldestFirst = [...checks].reverse();
      let previous: number | undefined;
      for (const check of oldestFirst) {
        target.checks += 1;
        target.lastCheckedAt = Math.max(target.lastCheckedAt ?? 0, check.observedAt);
        if (check.observedCents === undefined) continue;
        target.priced += 1;
        if (previous !== undefined && check.observedCents < previous) target.drops += 1;
        previous = check.observedCents;
        target.currency = target.currency ?? check.currency;
      }
      if (previous !== undefined && (target.bestCents === undefined || previous < target.bestCents)) {
        target.bestCents = previous;
        target.bestSubject = subject;
      }
    };

    for (const watch of await userWatches(ctx, userId)) {
      if (watch.status === "archived") continue;
      const target = row(watch.merchantDomain);
      if (watch.status === "bought") target.bought += 1;
      else target.watching += 1;
      const checks = await ctx.db
        .query("watchChecks")
        .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
        .order("desc")
        .take(CHECKS_PER_PRODUCT);
      tally(target, checks, watch.name);

      const offers = await ctx.db
        .query("offers")
        .withIndex("by_watch", (q) => q.eq("watchId", watch._id))
        .take(20);
      for (const offer of offers) {
        if (offer.status !== "confirmed") continue;
        const store = row(offer.storeDomain);
        store.offers += 1;
        if (offer.lastCheckedAt !== undefined) {
          store.lastCheckedAt = Math.max(store.lastCheckedAt ?? 0, offer.lastCheckedAt);
        }
        if (offer.lastCents !== undefined && (store.bestCents === undefined || offer.lastCents < store.bestCents)) {
          store.bestCents = offer.lastCents;
          store.bestSubject = watch.name;
          store.currency = store.currency ?? offer.currency;
        }
      }
    }

    for (const purchase of await userPurchases(ctx, userId)) {
      if (purchase.isExample) continue;
      const target = row(purchase.merchantDomain);
      const items = await ctx.db
        .query("items")
        .withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id))
        .collect();
      for (const item of items) {
        target.bought += 1;
        const checks = await ctx.db
          .query("priceChecks")
          .withIndex("by_item", (q) => q.eq("itemId", item._id))
          .order("desc")
          .take(CHECKS_PER_PRODUCT);
        tally(target, checks, item.name);
      }
    }

    return [...rows.values()].sort(
      (a, b) => b.watching + b.bought + b.offers - (a.watching + a.bought + a.offers) || b.checks - a.checks,
    );
  },
});
