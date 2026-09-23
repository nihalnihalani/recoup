/**
 * Drop emails (W2): tell the account holder, once per watch per price, that a
 * watched item got cheaper.
 *
 * Claim-before-send. `claimDrop` runs inside `watches.recordWatchCheck`, the
 * same transaction that accepts the price: it inserts a `mailLog` row under
 * `watch:<watchId>:<cents>` only when no row has that key, then schedules
 * `sendDrop` with the row id. A check that records twice, or a price that
 * comes back a week later, finds the row and stops. The row is also the
 * in-app backstop (`drops`), so an alert that could not be mailed (no
 * address, no inbox, daily cap, opted out, ...) is still stored, as
 * `suppressed` with the reason.
 *
 * T06/D68/D85 durable-delivery rewrite: `sendDrop` is now ONE
 * `internalMutation` -- read the claimed row, re-check the send-time gate,
 * try the enqueue, and commit `queued` + the reconcile schedule all in the
 * same transaction that leaves `claimed`. No action is involved, so a row
 * can never be left "in flight" outside a transaction: it is either still
 * `claimed` (nothing was ever enqueued -- safe to retry from a sweep) or it
 * already moved to `queued`/`failed` (enqueued exactly once). `claimed` ->
 * `queued` once the component has an outboundId for the message -> `sent`
 * once `reconcileDrop` has confirmed a real AgentMail message id (F3, the
 * same claimed/queued/sent shape `drafts.approveAndSend` uses for mail to
 * merchants). `unknown` means reconciliation exhausted its attempts with no
 * definite answer; `sweepStalled` (and the hourly cron) keeps re-checking
 * it. The UI shows "Sending" for `queued`/`unknown` and "Emailed" only for
 * `sent`. This path never goes through `drafts.approveAndSend` itself: that
 * gate is for mail to merchants, and this mail only ever goes to
 * `users.email`.
 */
import { ConvexError, v } from "convex/values";
import type { OutboundId } from "@agentmail/convex";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mailReason as mailReasonValidator, mailStatus } from "./schema";
import { agentmail } from "./mail";
import { suppressAddress, tokenFor } from "./alerts";
import { alertGate, isTombstoned, type MailReason } from "./lib/accountState";
import { requireUserId } from "./lib/access";
import { rateLimiter } from "./lib/rateLimits";
import { sanitizeError } from "./lib/errors";
import { BACKOFF_MS, isAmbiguousSendFailure, isTerminalSendFailure } from "./drafts";
import { clearPendingMailEvent, getPendingMailEvent } from "./mailEvents";
import {
  DROP_EMAIL_COUNT_SCAN,
  DROP_EMAIL_WINDOW_MS,
  DROP_MIN_CENTS,
  DROP_MIN_PERCENT,
  DROP_RECLAIM_MIN_MS,
  MAIL_RECONCILE_STALL_MS,
  MAIL_SWEEP_PAGE,
  MAX_DROP_EMAILS_PER_DAY,
} from "./limits";
import { takeGlobalBudget } from "./lib/budget";

/**
 * Where a recipient can open the app. APP_URL is the public site; SITE_URL is what auth uses and is
 * localhost on a dev deployment. A localhost link is useless to the reader and a spam signal (found
 * live: the first alert carried one and landed in spam), so it is left out rather than printed.
 */
export function publicAppUrl(): string | null {
  for (const raw of [process.env.APP_URL, process.env.SITE_URL]) {
    const url = raw?.trim().replace(/\/+$/, "");
    if (!url || !/^https:\/\//i.test(url)) continue;
    if (/^https:\/\/(localhost|127\.|\[::1\])/i.test(url)) continue;
    return url;
  }
  return null;
}

/**
 * F7 (checkpoint 4): the unsubscribe link's origin is `CONVEX_SITE_URL` --
 * the deployment's own HTTP-actions origin, where `http.ts` actually serves
 * `/alerts/unsubscribe` -- not `SITE_URL` (the frontend's own origin, which
 * may not proxy that route at all, or may be unset/localhost on a dev
 * deployment). Returns `null` -- never a malformed or relative header value
 * -- unless the variable is set to a real `https://` origin, so an unset or
 * non-https deployment omits BOTH `List-Unsubscribe` headers entirely
 * (`sendDrop` below) rather than emitting a broken/insecure one.
 */
function unsubscribeBase(): string | null {
  const base = (process.env.CONVEX_SITE_URL ?? "").trim().replace(/\/+$/, "");
  return base && /^https:\/\//i.test(base) ? base : null;
}

function unsubscribeUrl(base: string, token: string): string {
  return `${base}/alerts/unsubscribe?token=${token}`;
}

export const DROP_SUBJECT = "Recoup price alert: an item you are watching dropped";
const MAX_ERROR_CHARS = 1000;
/** Rows `drops` returns. */
const DROPS_LIMIT = 30;
/** Rows `drops` may walk to find them, should another mail kind ever share the table. */
const DROPS_SCAN = 200;

/** A fixed, non-enumerating message per refusal reason, mirroring `lib/accountState.ts`'s GATE_MESSAGES for the two reasons that gate does not itself produce. */
const REASON_MESSAGES: Record<MailReason, string> = {
  unverified: "Verify your email address to receive price alerts.",
  opted_out: "You have turned off price alerts.",
  deleted: "This account is being deleted.",
  address_suppressed: "Your email address is not accepting alerts right now.",
  daily_cap: "Today's alert limit has been reached.",
  global_cap: "Recoup has reached today's alert limit.",
  no_email: "Add an email address to receive price alerts.",
  not_configured: "Price alerts are not configured on this deployment.",
  watch_inactive: "This item is no longer being watched.",
  send_failed: "The last alert failed to send.",
};

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
  // A row that never went out (suppressed/failed) did not use up an email.
  const used = recent.filter((r) => r.kind === "price_drop" && r.status !== "failed" && r.status !== "suppressed").length;
  return used >= MAX_DROP_EMAILS_PER_DAY || recent.length >= DROP_EMAIL_COUNT_SCAN;
}

/** Reasons a transient dedupe row may be re-claimed after `DROP_RECLAIM_MIN_MS` (D70). Never opted_out/deleted/address_suppressed. */
const RECLAIMABLE_REASONS = new Set<MailReason>([
  "send_failed",
  "daily_cap",
  "global_cap",
  "no_email",
  "not_configured",
  "watch_inactive",
  "unverified",
]);

/**
 * Called by `watches.recordWatchCheck` with the watch as it was BEFORE the
 * check was applied, so `watch.lastCents` is the previous accepted price.
 * Returns the claimed/suppressed row id, or null when there is nothing to
 * record at all: the watch is not active, the price is not a qualifying
 * drop, or an existing dedupe row is not (yet) eligible for re-claim.
 */
export async function claimDrop(
  ctx: MutationCtx,
  watch: Doc<"watches">,
  cents: number,
  /** Unused since B2 took the price out of the subject; kept so the caller's contract does not change. */
  _currency: string,
): Promise<Id<"mailLog"> | null> {
  if (watch.status !== "active") return null;
  const previousCents = watch.lastCents;
  if (!isAlertableDrop({ cents, previousCents, targetCents: watch.targetCents })) return null;

  const now = Date.now();
  const dedupeKey = `watch:${watch._id}:${cents}`;
  const existing = await ctx.db
    .query("mailLog")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .first();

  if (existing) {
    // D70: re-claim keys on `claimedAt` (last touched), not `_creationTime`,
    // so a permanently failing row is not re-claimed on every check after
    // day one -- only after DROP_RECLAIM_MIN_MS since it was LAST touched.
    const eligible =
      (existing.status === "failed" || existing.status === "suppressed") &&
      existing.reason !== undefined &&
      RECLAIMABLE_REASONS.has(existing.reason) &&
      (existing.claimedAt ?? existing._creationTime) < now - DROP_RECLAIM_MIN_MS;
    if (!eligible) return null;

    // F6 (checkpoint 4, D79): a re-claim must pass the SAME daily-cap and
    // global-budget checks a fresh claim does -- without this, the 24h
    // re-claim window was a back door around both caps, and in particular
    // around the operator kill switch (D79: pinning the global `drop_email`
    // usage row to max for the day), which must pause retries, not just
    // first sends.
    const gate = await alertGate(ctx, watch.userId);
    let reclaimReason: MailReason | undefined;
    if (!gate.ok) reclaimReason = gate.reason;
    else if (await overDailyCap(ctx, watch.userId, now)) reclaimReason = "daily_cap";
    else if ((await takeGlobalBudget(ctx, "drop_email", 1, now)) === 0) reclaimReason = "global_cap";

    if (reclaimReason !== undefined) {
      await ctx.db.patch(existing._id, {
        status: "suppressed",
        reason: reclaimReason,
        error: REASON_MESSAGES[reclaimReason],
        providerStatus: undefined,
        claimedAt: now,
        nextCheckAt: undefined,
        lastCheckedAt: now,
      });
      return existing._id;
    }

    await ctx.db.patch(existing._id, {
      status: "claimed",
      error: undefined,
      reason: undefined,
      providerStatus: undefined,
      claimedAt: now,
      nextCheckAt: now + MAIL_RECONCILE_STALL_MS,
      lastCheckedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.notify.sendDrop, { mailLogId: existing._id });
    return existing._id;
  }

  const gate = await alertGate(ctx, watch.userId);
  const user = await ctx.db.get(watch.userId);

  let reason: MailReason | undefined;
  if (!gate.ok) reason = gate.reason;
  else if (await overDailyCap(ctx, watch.userId, now)) reason = "daily_cap";
  // Only a mail that would really go out draws from the global switch.
  else if ((await takeGlobalBudget(ctx, "drop_email", 1, now)) === 0) reason = "global_cap";

  const suppressed = reason !== undefined;
  const mailLogId = await ctx.db.insert("mailLog", {
    userId: watch.userId,
    dedupeKey,
    kind: "price_drop",
    watchId: watch._id,
    to: user?.email ?? "",
    subject: DROP_SUBJECT,
    status: suppressed ? "suppressed" : "claimed",
    reason,
    error: suppressed ? REASON_MESSAGES[reason as MailReason] : undefined,
    cents,
    previousCents,
    claimedAt: now,
    nextCheckAt: suppressed ? undefined : now + MAIL_RECONCILE_STALL_MS,
    lastCheckedAt: now,
  });
  if (!suppressed) await ctx.scheduler.runAfter(0, internal.notify.sendDrop, { mailLogId });
  return mailLogId;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/**
 * Same accepted deviation as `drafts.sendCtx` (D12a): the component's ctx type
 * predates convex 1.46's `runMutation` overload, so a real ctx fails the
 * structural check though the runtime call is identical. One cast, here.
 */
function sendCtx(ctx: MutationCtx): Parameters<typeof agentmail.sendMessage>[0] {
  return ctx as unknown as Parameters<typeof agentmail.sendMessage>[0];
}

/** Same deviation as `sendCtx`, for the read side (`drafts.statusCtx`). */
function statusCtx(ctx: QueryCtx | MutationCtx): Parameters<typeof agentmail.status>[0] {
  return ctx as unknown as Parameters<typeof agentmail.status>[0];
}

/** Builds the fixed-shape message body for one claimed row (B2: never the sender's own text). */
function buildMessage(row: Doc<"mailLog">, watch: Doc<"watches">): string {
  const currency = /^[A-Z]{3}$/.test(watch.currency ?? "") ? (watch.currency as string) : "USD";
  const lines = [
    "An item you are watching in Recoup dropped in price.",
    "",
    `Now: ${money(row.cents ?? 0, currency)}`,
    row.previousCents === undefined
      ? "Before: this is the first price we have seen"
      : `Before: ${money(row.previousCents, currency)}`,
  ];
  if (watch.targetCents !== undefined) lines.push(`Your target: ${money(watch.targetCents, currency)}`);
  lines.push(`Store: ${watch.merchantDomain}`, `Checked: ${new Date(row._creationTime).toUTCString()}`, "");
  const appUrl = publicAppUrl();
  if (appUrl) lines.push(`See it in Recoup: ${appUrl}/watching`, "");
  lines.push("Recoup uses no affiliate links.");
  return lines.join("\n");
}

/**
 * Enqueues one claimed drop with the component, in the SAME transaction that
 * leaves `claimed` (T06/D68). A row not `claimed` (already handled by a
 * concurrent call, or by a previous run of this same scheduled function) is
 * left alone and this returns immediately -- Convex's OCC serialises
 * concurrent invocations on this row, so a second `sendDrop` for the same
 * `mailLogId` always observes the first one's committed status change and
 * no-ops.
 *
 * The gate and the watch/inbox checks are re-run here (send-time recheck):
 * time may have passed since `claimDrop` (a sweep-triggered retry, or a
 * 24h re-claim), and the user's alert eligibility or the watch's status may
 * have changed since.
 *
 * P02-OW-3 (D244): this check runs in the transaction that enqueues, but the
 * component POSTs later, from its own workpool. The other half of the
 * send-time check is `alerts.cancelPendingDrops`: every change that closes
 * the gate (opt-out, one-click unsubscribe, bounce/complaint suppression,
 * deletion) cancels this user's still-pending component sends in its own
 * transaction. Whichever commits first, no POST starts after the gate closes.
 */
export const sendDrop = internalMutation({
  args: { mailLogId: v.id("mailLog") },
  returns: v.null(),
  handler: async (ctx, { mailLogId }) => {
    const row = await ctx.db.get(mailLogId);
    if (!row || row.status !== "claimed") return null;
    const now = Date.now();

    const refuse = async (reason: MailReason) => {
      await ctx.db.patch(mailLogId, {
        status: "suppressed",
        reason,
        error: REASON_MESSAGES[reason],
        lastCheckedAt: now,
      });
    };

    const gate = await alertGate(ctx, row.userId);
    if (!gate.ok) return await refuse(gate.reason);

    const watch = row.watchId ? await ctx.db.get(row.watchId) : null;
    if (!watch || watch.status !== "active") return await refuse("watch_inactive");

    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", row.userId))
      .unique();
    // Alerts go out from one shared app inbox (ALERTS_INBOX_ID, not a secret), so watching works the moment
    // someone signs up and does not spend one of the org's limited AgentMail inboxes per account.
    const inboxId = process.env.ALERTS_INBOX_ID?.trim() || profile?.inboxId || null;
    if (!inboxId) return await refuse("not_configured");

    const to = gate.to;
    const text = buildMessage(row, watch);
    // F7 (checkpoint 4): only spend a token lookup (which can create the
    // user's `alertSettings` row) when a header can actually be built.
    const base = unsubscribeBase();
    const headers =
      base !== null
        ? {
            // T06(g).5: one-click unsubscribe (RFC 8058). The page/form route lives at http.ts's
            // /alerts/unsubscribe; mail scanners that prefetch GET links never disable anything (GET
            // writes nothing there), only a real client's POST (or the header's one-click semantics) does.
            "List-Unsubscribe": `<${unsubscribeUrl(base, await tokenFor(ctx, row.userId, now))}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          }
        : undefined;

    // F11b (checkpoint 4): the `try` covers ONLY the network/component call.
    // Everything after a successful enqueue -- the `queued` patch and
    // scheduling the reconcile -- happens unconditionally, outside the
    // catch, so a hypothetical failure there can never be mis-recorded as
    // `failed` after the message was already, genuinely, handed to the
    // provider (see `queuedPatch` below, pulled out pure so the shape of
    // this patch is unit-testable without needing to force the Convex
    // scheduler itself to throw, which convex-test does not support).
    let outboundId: OutboundId;
    try {
      outboundId = await agentmail.sendMessage(sendCtx(ctx), inboxId, {
        to,
        subject: DROP_SUBJECT,
        text,
        labels: [`watch:${watch._id}`],
        ...(headers ? { headers } : {}),
      });
    } catch (err) {
      await ctx.db.patch(mailLogId, {
        status: "failed",
        reason: "send_failed",
        // F12b: never let the component/provider's own error text reach
        // `mailLog.error` (and from there, the `drops` view) verbatim.
        error: sanitizeError(err instanceof Error ? err.message : String(err)),
        lastCheckedAt: now,
      });
      return null;
    }

    await ctx.db.patch(mailLogId, queuedPatch(to, outboundId, now));
    await ctx.scheduler.runAfter(BACKOFF_MS[0], internal.notify.reconcileDrop, { mailLogId, attempt: 1 });
    return null;
  },
});

/**
 * F11b: the exact patch `sendDrop` applies to `mailLogId` after a successful
 * enqueue. Pure and exported so its shape can be unit-tested directly --
 * convex-test offers no way to force `ctx.scheduler.runAfter` to throw, so
 * this cannot be driven end-to-end; the structural guarantee (this patch and
 * the following `scheduler.runAfter` both run unconditionally, never inside
 * the `try/catch` around `sendMessage`) is enforced by `sendDrop`'s own
 * source shape above, which this helper documents and mirrors exactly.
 */
export function queuedPatch(
  to: string,
  outboundId: OutboundId,
  now: number,
): {
  status: "queued";
  to: string;
  outboundId: OutboundId;
  attempt: number;
  reason: undefined;
  error: undefined;
  nextCheckAt: number;
  lastCheckedAt: number;
} {
  return {
    status: "queued",
    to,
    outboundId,
    attempt: 0,
    reason: undefined,
    error: undefined,
    nextCheckAt: now + BACKOFF_MS[0],
    lastCheckedAt: now,
  };
}

/**
 * F10 (checkpoint 4): never let a suppression side effect create a fresh
 * `alertSettings` row (`alerts.suppressAddress` -> `getOrCreateSettings`) for
 * a tombstoned user. The caller's own mailLog status change is applied
 * either way -- this only guards the settings-row side effect.
 */
async function suppressUnlessTombstoned(
  ctx: MutationCtx,
  userId: Id<"users">,
  reason: "bounced" | "complained",
): Promise<void> {
  if (await isTombstoned(ctx, userId)) return;
  await suppressAddress(ctx, userId, reason);
}

/**
 * Applies one AgentMail delivery observation to a queued row (F3, same shape
 * as `drafts.applySendOutcome`). Exported as a plain function, not
 * registered: `reconcileDrop` and `recheckDrop` are the only production
 * callers, and tests drive the transitions directly.
 *
 * - `complained` -> stays `sent` (it was delivered), providerStatus recorded, address suppressed
 * - `bounced | rejected`, or `failed` from a provider 4xx -> `failed`, reason `send_failed`, providerStatus recorded;
 *   `bounced` also suppresses
 * - `failed` for any other reason (S-M03-1: lost response, timeout, 5xx) -> `unknown`, never re-claimed
 * - a real `agentmailMessageId` (any other status) -> `sent`, unless F8's
 *   `mailEvents.onEvent` already recorded an early bounce/complaint for this
 *   same message id (it can arrive before we ever learn the id ourselves) --
 *   that pending event is applied now instead of being lost.
 * - still pending, attempts left -> reschedule on the backoff, attempt+1
 * - still pending, attempts spent -> `unknown`, with `nextCheckAt` so the sweep keeps re-checking it
 */
export async function applyDropOutcome(
  ctx: MutationCtx,
  mailLogId: Id<"mailLog">,
  attempt: number,
  status: {
    status: string;
    agentmailMessageId: string | null;
    errorMessage: string | null;
  } | null,
): Promise<"sent" | "failed" | "retrying" | "unknown" | "gone"> {
  const row = await ctx.db.get(mailLogId);
  if (!row || !row.outboundId || (row.status !== "queued" && row.status !== "unknown")) return "gone";
  const now = Date.now();

  if (status?.status === "complained") {
    await ctx.db.patch(mailLogId, {
      status: "sent",
      providerStatus: "complained",
      sentAt: row.sentAt ?? now,
      agentmailMessageId: status.agentmailMessageId ?? row.agentmailMessageId,
      lastCheckedAt: now,
    });
    await suppressUnlessTombstoned(ctx, row.userId, "complained");
    return "sent";
  }

  if (status && isTerminalSendFailure(status)) {
    await ctx.db.patch(mailLogId, {
      status: "failed",
      reason: "send_failed",
      providerStatus: status.status,
      // F12b: the component/provider's own error text must never reach
      // `mailLog.error` (and from there, the `drops` view) verbatim.
      error: status.errorMessage ? sanitizeError(status.errorMessage) : `Delivery ${status.status}`,
      agentmailMessageId: status.agentmailMessageId ?? row.agentmailMessageId,
      lastCheckedAt: now,
    });
    if (status.status === "bounced") await suppressUnlessTombstoned(ctx, row.userId, "bounced");
    return "failed";
  }

  // S-M03-1: a component `failed` that is not a provider 4xx (a lost response, a timeout, a 5xx) may have been
  // accepted by the provider. It is `unknown`, never `failed`/`send_failed`, so the D70 24-hour re-claim (which only
  // re-sends `failed`/`suppressed` rows) can never mail the same alert twice. The sweep keeps re-checking it like any
  // other unknown row; the component row is final, so it stays unknown unless a delivery webhook says otherwise.
  if (status && isAmbiguousSendFailure(status)) {
    await ctx.db.patch(mailLogId, {
      status: "unknown",
      providerStatus: "failed",
      nextCheckAt: now + MAIL_RECONCILE_STALL_MS,
      lastCheckedAt: now,
    });
    return "unknown";
  }

  if (status?.agentmailMessageId) {
    // F8: `mailEvents.onEvent` cannot join a bounce/complaint webhook back to
    // this row until it knows the AgentMail message id, which is only
    // recorded here -- so an event that arrived while this row was still
    // `queued` was stashed (`mailEvents.storePendingMailEvent`) rather than
    // applied. Consume it now, before this settles as a plain `sent`.
    const pending = await getPendingMailEvent(ctx, status.agentmailMessageId, now);
    if (pending?.reason === "bounced") {
      await ctx.db.patch(mailLogId, {
        status: "failed",
        reason: "send_failed",
        providerStatus: pending.providerStatus,
        error: `The email ${pending.providerStatus} after delivery`.slice(0, MAX_ERROR_CHARS),
        agentmailMessageId: status.agentmailMessageId,
        lastCheckedAt: now,
      });
      await suppressUnlessTombstoned(ctx, row.userId, "bounced");
      await clearPendingMailEvent(ctx, status.agentmailMessageId);
      return "failed";
    }
    await ctx.db.patch(mailLogId, {
      status: "sent",
      sentAt: now,
      providerStatus: pending?.reason === "complained" ? "complained" : status.status,
      agentmailMessageId: status.agentmailMessageId,
      lastCheckedAt: now,
    });
    if (pending?.reason === "complained") {
      await suppressUnlessTombstoned(ctx, row.userId, "complained");
      await clearPendingMailEvent(ctx, status.agentmailMessageId);
    }
    return "sent";
  }

  if (attempt < BACKOFF_MS.length) {
    await ctx.db.patch(mailLogId, { attempt: attempt + 1, nextCheckAt: now + BACKOFF_MS[attempt], lastCheckedAt: now });
    await ctx.scheduler.runAfter(BACKOFF_MS[attempt], internal.notify.reconcileDrop, {
      mailLogId,
      attempt: attempt + 1,
    });
    return "retrying";
  }

  await ctx.db.patch(mailLogId, { status: "unknown", nextCheckAt: now + MAIL_RECONCILE_STALL_MS, lastCheckedAt: now });
  return "unknown";
}

/** The scheduled delivery check (F3, same backoff as `drafts.reconcileSend`). */
export const reconcileDrop = internalMutation({
  args: { mailLogId: v.id("mailLog"), attempt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.mailLogId);
    if (!row || !row.outboundId) return null;
    const status = await agentmail.status(statusCtx(ctx), row.outboundId);
    await applyDropOutcome(ctx, args.mailLogId, args.attempt, status);
    return null;
  },
});

/**
 * Lets the owner ask for one more delivery check on demand, e.g. after a
 * drop has sat `unknown` for a while (D56 pattern, mirrors
 * `drafts.recheckSend`). T06(g).6: reads `agentmail.status` inline (with
 * the backoff already exhausted) rather than scheduling, so the caller sees
 * the outcome immediately if AgentMail has since resolved it.
 */
export const recheckDrop = mutation({
  args: { mailLogId: v.id("mailLog") },
  returns: v.null(),
  handler: async (ctx, { mailLogId }) => {
    const userId = await requireUserId(ctx);
    const row = await ctx.db.get(mailLogId);
    if (!row || row.userId !== userId) throw new ConvexError("Alert not found");
    if (row.status !== "queued" && row.status !== "unknown") {
      throw new ConvexError("This alert cannot be rechecked");
    }
    await rateLimiter.limit(ctx, "dropRecheck", { key: mailLogId, throws: true });
    if (!row.outboundId) return null;
    const status = await agentmail.status(statusCtx(ctx), row.outboundId);
    await applyDropOutcome(ctx, mailLogId, BACKOFF_MS.length, status);
    return null;
  },
});

/**
 * Durable-delivery safety net (T06, D68): picks up `mailLog` rows stuck
 * `claimed` (a crash between claim and the enqueue transaction -- safe to
 * resend because enqueue and the `claimed` -> `queued` transition are
 * atomic, so a `claimed` row was NEVER enqueued), `queued` (a reconcile
 * whose own follow-up schedule was lost), or `unknown` (backoff exhausted)
 * past their `nextCheckAt`. Bounded per status by `MAIL_SWEEP_PAGE` so a bad
 * day cannot fan out unboundedly; returns the number of rows it rescheduled.
 * Wired to the hourly `crons.ts` "mail sweep" job.
 */
export const sweepStalled = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const now = Date.now();
    let count = 0;
    for (const status of ["claimed", "queued", "unknown"] as const) {
      const due = await ctx.db
        .query("mailLog")
        .withIndex("by_status_nextCheck", (q) => q.eq("status", status).lte("nextCheckAt", now))
        .take(MAIL_SWEEP_PAGE);
      for (const row of due) {
        await ctx.db.patch(row._id, { nextCheckAt: now + MAIL_RECONCILE_STALL_MS, lastCheckedAt: now });
        if (status === "claimed") {
          await ctx.scheduler.runAfter(0, internal.notify.sendDrop, { mailLogId: row._id });
        } else {
          await ctx.scheduler.runAfter(0, internal.notify.reconcileDrop, {
            mailLogId: row._id,
            attempt: row.attempt ?? 1,
          });
        }
        count++;
      }
    }
    return count;
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
  reason: v.union(mailReasonValidator, v.null()),
  providerStatus: v.union(v.string(), v.null()),
  canRecheck: v.boolean(),
});

/**
 * The caller's last 30 price-drop alerts, newest first, mailed or not. `[]` when signed out --
 * and, per D115 6b-3/T18.3, `[]` for a tombstoned (`accountState` status `deleting`/`deleted`)
 * caller too, so a just-revoked but still momentarily valid JWT cannot keep reading this
 * account's alert history mid-purge.
 */
export const drops = query({
  args: {},
  returns: v.array(dropView),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || (await isTombstoned(ctx, userId))) return [];
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
          reason: row.reason ?? null,
          providerStatus: row.providerStatus ?? null,
          canRecheck: row.status === "queued" || row.status === "unknown",
        };
      }),
    );
  },
});
