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
    await ctx.db.patch(row._id, { alertsEnabled: false, suppressedAt: Date.now(), suppressedReason: "user_unsubscribed" });
    return true;
  },
});
