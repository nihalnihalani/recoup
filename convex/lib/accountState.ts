/**
 * Account-lifecycle and alert-eligibility gates shared by every mail-sending
 * path (T01, D77). `isTombstoned` is the single choke point `lib/access.ts`'s
 * `requireUserId` uses to refuse a `deleting`/`deleted` account, and every
 * scheduled reader of `alertGate` (T06's `sendDrop`, sweeps, re-claims) skips
 * a tombstoned user the same way.
 */
import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { mailReason } from "../schema";

export type MailReason = Infer<typeof mailReason>;

/** A fixed, non-enumerating message per refusal reason (never echoes provider detail). */
const GATE_MESSAGES: Record<MailReason, string> = {
  unverified: "Verify your email address to receive price alerts.",
  opted_out: "You have turned off price alerts.",
  deleted: "This account is being deleted.",
  address_suppressed: "Your email address is not accepting alerts right now.",
  daily_cap: "Today's alert limit has been reached.",
  global_cap: "Recoup has reached today's alert limit.",
  no_email: "Add an email address to receive price alerts.",
  not_configured: "Alerts are not configured for this deployment.",
  watch_inactive: "This watch is no longer active.",
  send_failed: "The last alert failed to send.",
};

export type AlertGateResult = { ok: true; to: string } | { ok: false; reason: MailReason; message: string };

function refuse(reason: MailReason): AlertGateResult {
  return { ok: false, reason, message: GATE_MESSAGES[reason] };
}

/** True once an `accountState` row exists for the user (D77): the table only ever holds `deleting`/`deleted` rows, so any row means tombstoned. Absence of a row = active. One indexed read. */
export async function isTombstoned(ctx: QueryCtx, userId: Id<"users">): Promise<boolean> {
  const row = await ctx.db
    .query("accountState")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return row !== null;
}

/**
 * Whether an alert may be sent to this user right now, and if not, the exact
 * reason. Evaluated in this order (contract-fixed; earlier reasons win):
 * deleted -> no_email -> unverified -> opted_out -> address_suppressed.
 */
export async function alertGate(ctx: QueryCtx, userId: Id<"users">): Promise<AlertGateResult> {
  if (await isTombstoned(ctx, userId)) return refuse("deleted");

  const user = await ctx.db.get(userId);
  const email = user?.email;
  if (!email) return refuse("no_email");

  if (!user?.emailVerificationTime) return refuse("unverified");

  const settings = await ctx.db
    .query("alertSettings")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (settings?.alertsEnabled === false) return refuse("opted_out");
  if (settings?.suppressedAt !== undefined) return refuse("address_suppressed");

  return { ok: true, to: email };
}
