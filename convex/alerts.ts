/**
 * Alert opt-in/out, unsubscribe tokens, and address suppression (T01, D69).
 *
 * `alertSettings` is one row per user; this module is the single owner of
 * its lifecycle. `suppressAddress` is called by T06's mail-event/polling
 * paths when AgentMail reports a bounce or complaint, but lives here so the
 * row's transitions never drift across two modules.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { suppressedReason as suppressedReasonValidator } from "./schema";
import { requireUserId } from "./lib/access";
import { agentmail } from "./mail";

/** 32 bytes of CSPRNG randomness as lowercase hex (64 chars): opaque, never reused as auth. */
function newUnsubscribeToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The user's alertSettings row, creating one (alerts enabled, fresh token) if absent. */
async function getOrCreateSettings(ctx: MutationCtx, userId: Id<"users">, now: number) {
  const existing = await ctx.db
    .query("alertSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing) return existing;
  const id = await ctx.db.insert("alertSettings", {
    userId,
    alertsEnabled: true,
    unsubscribeToken: newUnsubscribeToken(),
    updatedAt: now,
  });
  return (await ctx.db.get(id))!;
}

/** Returns this user's unsubscribe token, creating their `alertSettings` row if it does not exist yet. */
export async function tokenFor(ctx: MutationCtx, userId: Id<"users">, now: number = Date.now()): Promise<string> {
  const row = await getOrCreateSettings(ctx, userId, now);
  return row.unsubscribeToken;
}

/**
 * Marks this user's address suppressed after an AgentMail bounce or
 * complaint (D69): alerts stay suppressed until the user explicitly
 * re-enables via `setAlerts({ enabled: true })`. Never touches
 * `alertsEnabled` — a bounce is a distinct gate reason (`address_suppressed`)
 * from the user's own opt-out toggle (`opted_out`).
 */
export async function suppressAddress(
  ctx: MutationCtx,
  userId: Id<"users">,
  reason: "bounced" | "complained",
  now: number = Date.now(),
): Promise<void> {
  const row = await getOrCreateSettings(ctx, userId, now);
  await ctx.db.patch(row._id, { suppressedAt: now, suppressedReason: reason, updatedAt: now });
  await cancelPendingDrops(ctx, userId, "address_suppressed", now);
}

// ---------------------------------------------------------------------------
// P02-OW-3 / P01-2 (D244): closing the alert gate cancels alerts still pending
// ---------------------------------------------------------------------------

/**
 * Same accepted deviation as `drafts.sendCtx` / `claims.cancelCtx` (D12a): the
 * component's ctx type predates convex 1.46's `runMutation` overload. One cast, here.
 */
function cancelCtx(ctx: MutationCtx): Parameters<typeof agentmail.cancel>[0] {
  return ctx as unknown as Parameters<typeof agentmail.cancel>[0];
}

/**
 * Newest `queued` rows read per call. The daily cap is MAX_DROP_EMAILS_PER_DAY (5) and
 * a row leaves `queued` once reconciled, so a pending send is always among the newest few.
 */
const CANCEL_SCAN = 10;

/** Why the gate closed on an alert already handed to the mail component. */
export type CancelReason = "opted_out" | "deleted" | "address_suppressed";

/**
 * P02-SK-3: a cancel also succeeds while the component's POST is already in
 * flight, so success does not prove nothing was sent. The copy says what we
 * did (asked for cancellation), never that the alert was not delivered.
 */
const CANCEL_REQUESTED_MESSAGES: Record<CancelReason, string> = {
  opted_out: "You turned off price alerts while this one was being sent. We asked for it to be cancelled, but it may already have gone out.",
  deleted: "This account is being deleted. We asked for this alert to be cancelled, but it may already have gone out.",
  address_suppressed:
    "Your email address stopped accepting alerts while this one was being sent. We asked for it to be cancelled, but it may already have gone out.",
};

/**
 * Cancels this user's price-drop alerts that are still pending in the AgentMail
 * component. Called in the same transaction as every change that closes the alert
 * gate: `setAlerts({enabled:false})`, `unsubscribeByToken`, `suppressAddress`
 * (bounce/complaint) and `account.requestDeletion`.
 *
 * This is the send-time half of the gate. `notify.sendDrop` checks `alertGate` in
 * the same transaction that enqueues the send, so a gate that closes first is always
 * seen there. What it could not see is a gate that closes AFTER the enqueue and
 * before the component's workpool POSTs; the component skips a row that is `failed`
 * by the time it dispatches (`getOutboundForSend`), so cancelling here closes that
 * window. `claimed` rows need nothing: `sendDrop` re-runs the gate when it runs.
 *
 * Per row: `agentmail.cancel` succeeds only while the component row is `pending`
 * (`cancelSend` throws for any other status, or for an id it does not have). On
 * success the row becomes `suppressed` with `reason`; none of these reasons is ever
 * re-claimed (`notify.RECLAIMABLE_REASONS`), so a cancelled alert is never re-sent.
 * On failure the row is left `queued`: the send already finished one way or the
 * other, and `reconcileDrop` records what actually happened (a delivered alert ends
 * `sent`, never `suppressed`). Returns how many cancels were requested.
 */
export async function cancelPendingDrops(
  ctx: MutationCtx,
  userId: Id<"users">,
  reason: CancelReason,
  now: number = Date.now(),
): Promise<number> {
  const queued = await ctx.db
    .query("mailLog")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "queued"))
    .order("desc")
    .take(CANCEL_SCAN);
  let cancelled = 0;
  for (const row of queued) {
    if (!row.outboundId) continue;
    try {
      await agentmail.cancel(cancelCtx(ctx), row.outboundId);
    } catch {
      continue; // Not pending any more: left for reconciliation to record truthfully.
    }
    await ctx.db.patch(row._id, {
      status: "suppressed",
      reason,
      error: CANCEL_REQUESTED_MESSAGES[reason],
      nextCheckAt: undefined,
      lastCheckedAt: now,
    });
    cancelled++;
  }
  return cancelled;
}

export const settings = query({
  args: {},
  returns: v.object({
    alertsEnabled: v.boolean(),
    emailVerified: v.boolean(),
    email: v.union(v.string(), v.null()),
    suppressedReason: v.union(suppressedReasonValidator, v.null()),
  }),
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const user = await ctx.db.get(userId);
    const row = await ctx.db
      .query("alertSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return {
      alertsEnabled: row?.alertsEnabled ?? true,
      emailVerified: user?.emailVerificationTime !== undefined,
      email: user?.email ?? null,
      suppressedReason: row?.suppressedReason ?? null,
    };
  },
});

export const setAlerts = mutation({
  args: { enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { enabled }) => {
    const userId = await requireUserId(ctx);
    const now = Date.now();
    const row = await getOrCreateSettings(ctx, userId, now);
    if (enabled) {
      // Explicit re-enable clears suppression from any of the three reasons
      // (D69 overrides the earlier user_unsubscribed-only rule): the user is
      // asking for alerts back, whatever suppressed them before. F11a: also
      // rotate the unsubscribe token, so a stale token -- already used for a
      // one-click unsubscribe, or leaked from an old email -- cannot silently
      // re-disable alerts the user just turned back on.
      await ctx.db.patch(row._id, {
        alertsEnabled: true,
        suppressedAt: undefined,
        suppressedReason: undefined,
        unsubscribeToken: newUnsubscribeToken(),
        updatedAt: now,
      });
    } else {
      await ctx.db.patch(row._id, { alertsEnabled: false, updatedAt: now });
      await cancelPendingDrops(ctx, userId, "opted_out", now);
    }
    return null;
  },
});

/** Driven by the one-click unsubscribe link (T06's GET/POST route); never throws, never leaks whether the token was valid to its own caller's caller. */
export const unsubscribeByToken = internalMutation({
  args: { token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("alertSettings")
      .withIndex("by_unsubscribeToken", (q) => q.eq("unsubscribeToken", token))
      .first();
    if (!row) return false;
    const now = Date.now();
    await ctx.db.patch(row._id, { alertsEnabled: false, suppressedAt: now, suppressedReason: "user_unsubscribed" });
    await cancelPendingDrops(ctx, row.userId, "opted_out", now);
    return true;
  },
});
