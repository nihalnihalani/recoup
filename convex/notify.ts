/**
 * Drop emails (W2): tell the account holder, once per watch per price, that a
 * watched item got cheaper.
 *
 * Claim-before-send. `claimDrop` runs inside `watches.recordWatchCheck`, the
 * same transaction that accepts the price: it inserts a `mailLog` row under
 * `watch:<watchId>:<cents>` only when no row has that key, then schedules
 * `sendDrop` with the row id. A check that records twice, or a price that
 * comes back a week later, finds the row and stops. The row is also the in-app
 * backstop (`drops`), so an alert that could not be mailed (no address, no
 * inbox, daily cap) is still stored, as `failed` with the reason.
 *
 * `sent` means handed to the AgentMail component's send queue from the user's
 * own Recoup inbox; the component owns retries and delivery from there.
 * This path never goes through `drafts.approveAndSend`: that gate is for mail
 * to merchants, and this mail only ever goes to `users.email`.
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mailStatus } from "./schema";
import { agentmail } from "./mail";
import {
  DROP_EMAIL_COUNT_SCAN,
  DROP_EMAIL_WINDOW_MS,
  DROP_MIN_CENTS,
  DROP_MIN_PERCENT,
  MAX_DROP_EMAILS_PER_DAY,
} from "./limits";

/** Stored on a row that was recorded but not mailed because the user is over the daily cap. */
export const DAILY_LIMIT_ERROR = "daily alert limit";
const MAX_ERROR_CHARS = 1000;
/** Rows `drops` returns. */
const DROPS_LIMIT = 30;
/** Rows `drops` may walk to find them, should another mail kind ever share the table. */
const DROPS_SCAN = 200;

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * Is this accepted price worth an email? Pure.
 *
 * (a) With a target: the price is at or under it. A price that merely holds or
 *     rises while already under the target is not news, so it stays quiet.
 * (b) Without a target: it fell from the previous accepted price by at least
 *     max($1.00, 2%). The first observation has nothing to fall from.
 */
export function isAlertableDrop(args: {
  cents: number;
  previousCents: number | undefined;
  targetCents: number | undefined;
}): boolean {
  const { cents, previousCents, targetCents } = args;
  if (targetCents !== undefined) {
    if (cents > targetCents) return false;
    return previousCents === undefined || previousCents > targetCents || cents < previousCents;
  }
  if (previousCents === undefined) return false;
  const drop = previousCents - cents;
  // Integer form of drop >= 2% of previous; no float rounding at the boundary.
  return drop >= DROP_MIN_CENTS && drop * 100 >= previousCents * DROP_MIN_PERCENT;
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Fails closed: anything that is not clearly under the cap counts as over it. */
async function overDailyCap(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<boolean> {
  const recent = await ctx.db
    .query("mailLog")
    .withIndex("by_user", (q) => q.eq("userId", userId).gt("_creationTime", now - DROP_EMAIL_WINDOW_MS))
    .order("desc")
    .take(DROP_EMAIL_COUNT_SCAN);
  // A row that never went out (no inbox, over the cap) did not use up an email.
  const used = recent.filter((r) => r.kind === "price_drop" && r.status !== "failed").length;
  return used >= MAX_DROP_EMAILS_PER_DAY || recent.length >= DROP_EMAIL_COUNT_SCAN;
}

/**
 * Called by `watches.recordWatchCheck` with the watch as it was BEFORE the
 * check was applied, so `watch.lastCents` is the previous accepted price.
 * Returns the claimed row, or null when there is nothing to send: not active,
 * not a qualifying drop, or this watch+price was already claimed.
 */
export async function claimDrop(
  ctx: MutationCtx,
  watch: Doc<"watches">,
  cents: number,
  currency: string,
): Promise<Id<"mailLog"> | null> {
  if (watch.status !== "active") return null;
  const previousCents = watch.lastCents;
  if (!isAlertableDrop({ cents, previousCents, targetCents: watch.targetCents })) return null;

  const dedupeKey = `watch:${watch._id}:${cents}`;
  const already = await ctx.db
    .query("mailLog")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .first();
  if (already) return null;

  const user = await ctx.db.get(watch.userId);
  const capped = await overDailyCap(ctx, watch.userId, Date.now());
  const mailLogId = await ctx.db.insert("mailLog", {
    userId: watch.userId,
    dedupeKey,
    kind: "price_drop",
    watchId: watch._id,
    to: user?.email ?? "",
    subject: `Price drop: ${watch.name} is now ${money(cents, currency)}`.slice(0, 250),
    status: capped ? "failed" : "claimed",
    error: capped ? DAILY_LIMIT_ERROR : undefined,
    cents,
    previousCents,
  });
  if (!capped) await ctx.scheduler.runAfter(0, internal.notify.sendDrop, { mailLogId });
  return mailLogId;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

const dropContextValidator = v.union(
  v.null(),
  v.object({
    /** Why this row cannot be mailed; null when it can. */
    problem: v.union(v.string(), v.null()),
    inboxId: v.union(v.string(), v.null()),
    to: v.union(v.string(), v.null()),
    subject: v.string(),
    text: v.string(),
    watchId: v.union(v.id("watches"), v.null()),
  }),
);

/**
 * Everything `sendDrop` needs, message text included. Null when the row is
 * gone or is no longer `claimed`, so a re-run of the action sends nothing.
 * Unauthenticated on purpose: the only caller is `sendDrop`.
 */
export const dropContext = internalQuery({
  args: { mailLogId: v.id("mailLog") },
  returns: dropContextValidator,
  handler: async (ctx, { mailLogId }) => {
    const row = await ctx.db.get(mailLogId);
    if (!row || row.status !== "claimed") return null;
    const watch = row.watchId ? await ctx.db.get(row.watchId) : null;
    const user = await ctx.db.get(row.userId);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .unique();
    const to = user?.email?.trim() || null;
    // Alerts go out from one shared app inbox (ALERTS_INBOX_ID, not a secret), so watching works the moment
    // someone signs up and does not spend one of the org's limited AgentMail inboxes per account. A user's
    // own Recoup inbox is only needed for mail to a store, where replies must come back to them.
    const inboxId = process.env.ALERTS_INBOX_ID?.trim() || profile?.inboxId || null;

    let problem: string | null = null;
    if (!watch || row.cents === undefined) problem = "The watched item no longer exists";
    else if (watch.status !== "active") problem = "This item is no longer being watched";
    else if (!to) problem = "Your account has no email address to send alerts to";
    else if (!inboxId) problem = "Price alerts are not configured on this deployment";

    let text = "";
    if (watch && row.cents !== undefined) {
      const currency = watch.currency ?? "USD";
      const lines = [
        `${watch.name} dropped in price.`,
        "",
        `Now: ${money(row.cents, currency)}`,
        row.previousCents === undefined
          ? "Before: this is the first price we have seen"
          : `Before: ${money(row.previousCents, currency)}`,
      ];
      if (watch.targetCents !== undefined) lines.push(`Your target: ${money(watch.targetCents, currency)}`);
      lines.push(
        `Store: ${watch.merchantDomain}`,
        `Link: ${watch.productUrl}`,
        `Checked: ${new Date(row._creationTime).toUTCString()}`,
        "",
        `See it in Recoup: ${process.env.SITE_URL ?? ""}/watching`,
        "",
        "Recoup uses no affiliate links.",
      );
      text = lines.join("\n");
    }
    return { problem, inboxId, to, subject: row.subject, text, watchId: row.watchId ?? null };
  },
});

/** Ends a claimed row as `sent` or `failed`. A row already ended is left alone. */
export const finishDrop = internalMutation({
  args: {
    mailLogId: v.id("mailLog"),
    error: v.union(v.string(), v.null()),
    to: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { mailLogId, error, to }) => {
    const row = await ctx.db.get(mailLogId);
    if (!row || row.status !== "claimed") return null;
    const recipient = to === undefined ? {} : { to };
    if (error === null) await ctx.db.patch(mailLogId, { ...recipient, status: "sent", sentAt: Date.now() });
    else await ctx.db.patch(mailLogId, { ...recipient, status: "failed", error: error.slice(0, MAX_ERROR_CHARS) });
    return null;
  },
});

/**
 * Same accepted deviation as `drafts.sendCtx` (D12a): the component's ctx type
 * predates convex 1.46's `runMutation` overload, so a real ctx fails the
 * structural check though the runtime call is identical. One cast, here.
 */
function sendCtx(ctx: { runMutation: unknown }): Parameters<typeof agentmail.sendMessage>[0] {
  return ctx as unknown as Parameters<typeof agentmail.sendMessage>[0];
}

/** Mails one claimed drop. Never throws past the scheduler: every outcome is recorded on the row. */
export const sendDrop = internalAction({
  args: { mailLogId: v.id("mailLog") },
  returns: v.null(),
  handler: async (ctx, { mailLogId }) => {
    let error: string | null = null;
    let to: string | undefined;
    try {
      const drop = await ctx.runQuery(internal.notify.dropContext, { mailLogId });
      if (!drop) return null;
      to = drop.to ?? undefined;
      if (drop.problem !== null || drop.inboxId === null || drop.to === null) {
        error = drop.problem ?? "The alert could not be addressed";
      } else {
        await agentmail.sendMessage(sendCtx(ctx), drop.inboxId, {
          to: drop.to,
          subject: drop.subject,
          text: drop.text,
          labels: drop.watchId ? [`watch:${drop.watchId}`] : [],
        });
      }
    } catch (err) {
      console.error(`notify.sendDrop failed for ${mailLogId}`, err);
      error = `Send failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    try {
      await ctx.runMutation(internal.notify.finishDrop, { mailLogId, error, to });
    } catch (err) {
      console.error(`notify.sendDrop could not record the outcome for ${mailLogId}`, err);
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// In-app backstop
// ---------------------------------------------------------------------------

const dropView = v.object({
  _id: v.id("mailLog"),
  _creationTime: v.number(),
  watchId: v.union(v.id("watches"), v.null()),
  watchName: v.union(v.string(), v.null()),
  cents: v.union(v.number(), v.null()),
  previousCents: v.union(v.number(), v.null()),
  status: mailStatus,
  error: v.union(v.string(), v.null()),
});

/** The caller's last 30 price-drop alerts, newest first, mailed or not. `[]` when signed out. */
export const drops = query({
  args: {},
  returns: v.array(dropView),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows: Doc<"mailLog">[] = [];
    let scanned = 0;
    const newestFirst = ctx.db
      .query("mailLog")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc");
    for await (const row of newestFirst) {
      if (row.kind === "price_drop") rows.push(row);
      if (rows.length >= DROPS_LIMIT || ++scanned >= DROPS_SCAN) break;
    }
    return await Promise.all(
      rows.map(async (row) => {
        const watch = row.watchId ? await ctx.db.get(row.watchId) : null;
        return {
          _id: row._id,
          _creationTime: row._creationTime,
          watchId: row.watchId ?? null,
          watchName: watch?.name ?? null,
          cents: row.cents ?? null,
          previousCents: row.previousCents ?? null,
          status: row.status,
          error: row.error ?? null,
        };
      }),
    );
  },
});
