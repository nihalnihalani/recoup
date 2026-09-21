import { ConvexError, v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Id } from "./_generated/dataModel";
import { agentmail } from "./mail";

/** Signed-out callers get nulls instead of a thrown error so the UI can branch. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { user: null, profile: null };
    const user = await ctx.db.get(userId);
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return { user, profile };
  },
});

export const byUser = internalQuery({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) =>
    ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
});

export const byInbox = internalQuery({
  args: { inboxId: v.string() },
  handler: (ctx, { inboxId }) =>
    ctx.db.query("profiles").withIndex("by_inbox", (q) => q.eq("inboxId", inboxId)).unique(),
});

/**
 * Idempotent under concurrent calls: re-checks `by_user` inside the same
 * mutation transaction and returns the existing row if one already won the
 * race, telling the caller whether the inbox it just created ended up
 * unused so it can clean up the orphan.
 */
export const save = internalMutation({
  args: { userId: v.id("users"), inboxId: v.string(), inboxEmail: v.string() },
  handler: async (ctx, args): Promise<{ profileId: Id<"profiles">; created: boolean }> => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing) return { profileId: existing._id, created: false };
    const profileId = await ctx.db.insert("profiles", args);
    return { profileId, created: true };
  },
});

/**
 * Creates the user's AgentMail inbox on first use. Safe to call
 * concurrently: `save` is the single source of truth for "did this
 * profile already exist", and a losing caller deletes its now-orphaned
 * inbox rather than leaving it dangling in AgentMail (D32).
 */
export const ensureInbox = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");

    const existing = await ctx.runQuery(internal.profiles.byUser, { userId });
    if (existing) return existing.inboxEmail;

    const suffix = Math.random().toString(36).slice(2, 8);
    const inbox = await agentmail.createInbox(ctx, { username: `recoup-${suffix}`, displayName: "Recoup" });
    const inboxId: string = inbox.inbox_id;
    const inboxEmail: string = inbox.email;

    const result = await ctx.runMutation(internal.profiles.save, { userId, inboxId, inboxEmail });
    if (!result.created) {
      console.error("profiles.ensureInbox: deleting orphaned inbox created by a losing concurrent call", {
        userId,
        inboxId,
      });
      try {
        await agentmail.deleteInbox(ctx, inboxId);
      } catch (err) {
        console.error("profiles.ensureInbox: failed to delete orphaned inbox", { inboxId, err });
      }
      const canonical = await ctx.runQuery(internal.profiles.byUser, { userId });
      return canonical?.inboxEmail ?? inboxEmail;
    }
    return inboxEmail;
  },
});
