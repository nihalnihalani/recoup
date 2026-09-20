import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

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

/**
 * Fires a scheduled reminder. Acts on the claim's current status only
 * (D28): `confirmed` and `dismissed` claims cancel their pending reminders
 * without touching `attentionAt`; every other status gets `attentionAt` set
 * so the board surfaces it. Does not gate on claimVersion — a partial
 * credit bumps version on every event and would otherwise silently kill
 * reminders.
 */
export const fire = internalMutation({
  args: { claimId: v.id("claims") },
  handler: async (ctx, { claimId }) => {
    const claim = await ctx.db.get(claimId);
    const pending = (
      await ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect()
    ).filter((f) => f.status === "pending");
    if (!claim || claim.status === "confirmed" || claim.status === "dismissed") {
      for (const f of pending) await ctx.db.patch(f._id, { status: "cancelled" });
      return;
    }
    for (const f of pending) await ctx.db.patch(f._id, { status: "fired" });
    await ctx.db.patch(claimId, { attentionAt: Date.now() });
  },
});
