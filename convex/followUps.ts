import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { isTombstoned } from "./lib/accountState";

const DAY_MS = 86_400_000;
/** Floor on the reminder delay: never nag a merchant sooner than a week (D26). */
export const MIN_REMINDER_DAYS = 7;

/**
 * When to remind the user about a claim (D26): the later of seven days and
 * the merchant's own returns window, so the reminder lands while there is
 * still a window to point at. Falls back to the floor when no returns policy
 * snapshot has been captured for the merchant.
 */
export async function reminderFireAt(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  from: number = Date.now(),
): Promise<number> {
  const purchase = await ctx.db.get(claim.purchaseId);
  let days = MIN_REMINDER_DAYS;
  if (purchase) {
    const policy = await ctx.db
      .query("policies")
      .withIndex("by_user_domain_kind", (q) =>
        q
          .eq("userId", claim.userId)
          .eq("merchantDomain", purchase.merchantDomain)
          .eq("kind", "returns"),
      )
      .order("desc")
      .first();
    if (policy?.windowDays && Number.isFinite(policy.windowDays)) {
      days = Math.max(days, Math.min(policy.windowDays, 365));
    }
  }
  return from + days * DAY_MS;
}

/** Cancels every pending follow-up for a claim (D28). */
export async function cancelPending(ctx: MutationCtx, claimId: Id<"claims">) {
  const rows = await ctx.db
    .query("followUps")
    .withIndex("by_claim", (q) => q.eq("claimId", claimId))
    .collect();
  for (const f of rows) {
    if (f.status !== "pending") continue;
    await ctx.scheduler.cancel(f.scheduledFnId);
    await ctx.db.patch(f._id, { status: "cancelled" });
  }
}

/**
 * Schedules a reminder-only follow-up for a claim, cancelling any pending
 * one first (D28). Schedule-first pattern: `runAt` before the insert, so
 * the row always carries a valid `scheduledFnId`.
 */
export async function scheduleReminder(
  ctx: MutationCtx,
  claim: Doc<"claims">,
  fireAt: number,
) {
  await cancelPending(ctx, claim._id);
  const scheduledFnId = await ctx.scheduler.runAt(fireAt, internal.followUps.fire, {
    claimId: claim._id,
  });
  await ctx.db.insert("followUps", {
    claimId: claim._id,
    userId: claim.userId,
    fireAt,
    claimVersion: claim.version,
    status: "pending",
    scheduledFnId,
  });
}

/** Schedules the default reminder for a claim: `reminderFireAt` from now (D26, D28). */
export async function scheduleClaimReminder(ctx: MutationCtx, claim: Doc<"claims">) {
  await scheduleReminder(ctx, claim, await reminderFireAt(ctx, claim));
}

/**
 * Fires a scheduled reminder. Acts on the claim's current status only
 * (D28): `confirmed` and `dismissed` claims cancel their pending reminders
 * without touching `attentionAt`; every other status gets `attentionAt` set
 * so the board surfaces it. Acts only on pending rows that are due (D42);
 * with none, it is a no-op. Does not gate on claimVersion — a partial
 * credit bumps version on every event and would otherwise silently kill
 * reminders. D87 (D103): a tombstoned owner's claim is treated the same as
 * `confirmed`/`dismissed` -- the pending reminders are cancelled, without
 * setting `attentionAt` on a board nobody signed in to see (the account is
 * being deleted).
 */
export const fire = internalMutation({
  args: { claimId: v.id("claims") },
  returns: v.null(),
  handler: async (ctx, { claimId }) => {
    const now = Date.now();
    // D42: only a pending reminder that is actually due may act. A stale or
    // duplicate scheduler run finds no such row and leaves the claim alone.
    const pending = (
      await ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect()
    ).filter((f) => f.status === "pending" && f.fireAt <= now);
    if (pending.length === 0) return null;
    const claim = await ctx.db.get(claimId);
    if (
      !claim ||
      claim.status === "confirmed" ||
      claim.status === "dismissed" ||
      (await isTombstoned(ctx, claim.userId))
    ) {
      for (const f of pending) await ctx.db.patch(f._id, { status: "cancelled" });
      return null;
    }
    for (const f of pending) await ctx.db.patch(f._id, { status: "fired" });
    await ctx.db.patch(claimId, { attentionAt: now });
    return null;
  },
});
