import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";
import schema from "./schema";
import { requireUserId } from "./lib/access";

/** Shown in the UI as "forward your order emails here". */
const DISPLAY_NAME = "Recoup";
const DEFAULT_BASE_URL = "https://api.agentmail.to/v0";
const SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** A short, lowercase local-part suffix so two users never collide on `recoup-…`. */
function usernameSuffix(): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += SUFFIX_ALPHABET[Math.floor(Math.random() * SUFFIX_ALPHABET.length)];
  }
  return out;
}

/**
 * The signed-in user's inbox, or `null` when signed out
 * (ARCHITECTURE_PATTERNS §Auth: `me` branches in the UI, it does not throw).
 * `inboxEmail` is `null` until `ensureInbox` has run once.
 */
export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      inboxId: v.union(v.string(), v.null()),
      inboxEmail: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      userId,
      inboxId: profile?.inboxId ?? null,
      inboxEmail: profile?.inboxEmail ?? null,
    };
  },
});

/**
 * Unauthenticated on purpose: called by `ensureInbox`, which has already
 * resolved the caller from `ctx.auth` but has no `ctx.db` of its own.
 */
export const byUser = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(schema.doc("profiles"), v.null()),
  handler: async (ctx, { userId }) =>
    await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
});

/**
 * Unauthenticated on purpose: inbound mail arrives with an inbox id and no
 * identity, so this is how a webhook learns which user owns the message.
 */
export const byInbox = internalQuery({
  args: { inboxId: v.string() },
  returns: v.union(schema.doc("profiles"), v.null()),
  handler: async (ctx, { inboxId }) =>
    await ctx.db
      .query("profiles")
      .withIndex("by_inbox", (q) => q.eq("inboxId", inboxId))
      .unique(),
});

/**
 * Idempotent write half of `ensureInbox`. If a profile already exists for the
 * user it wins and the freshly created inbox is ignored, so two concurrent
 * `ensureInbox` calls can never leave the user with two live addresses in the
 * database (the losing AgentMail inbox is orphaned, never routed to, because
 * inbound routing resolves the user through `profiles.by_inbox`).
 */
export const save = internalMutation({
  args: { userId: v.id("users"), inboxId: v.string(), inboxEmail: v.string() },
  returns: v.object({ inboxId: v.string(), inboxEmail: v.string(), created: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing) {
      return { inboxId: existing.inboxId, inboxEmail: existing.inboxEmail, created: false };
    }
    await ctx.db.insert("profiles", args);
    return { inboxId: args.inboxId, inboxEmail: args.inboxEmail, created: true };
  },
});

/**
 * Creates an inbox on AgentMail.
 *
 * `@agentmail/convex@0.1.0` exposes `agentmail.createInbox(ctx, …)` on the
 * client, but the component function it dispatches to (`lib.createInbox`) is
 * registered as an `internalAction`, which a parent app cannot reach across
 * the component boundary: the call fails at runtime with "Couldn't resolve
 * agentmail.lib.createInbox" (verified live on the dev deployment
 * 2026-09-20). Sending is unaffected — `lib.enqueueSend` is public — so only
 * provisioning goes direct. This mirrors the component's own request exactly
 * (same base URL, bearer auth and snake_case body), so it can be swapped back
 * to `agentmail.createInbox` the moment the component publishes a fix.
 */
async function createInboxRemote(): Promise<{ inboxId: string; inboxEmail: string }> {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  if (!apiKey) throw new ConvexError("Email is not configured on this deployment");
  const baseUrl = (process.env.AGENTMAIL_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");

  const response = await fetch(`${baseUrl}/inboxes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ username: `recoup-${usernameSuffix()}`, display_name: DISPLAY_NAME }),
  });
  if (!response.ok) {
    // Never echo the response body: it can quote the request's auth header.
    throw new ConvexError(`AgentMail could not create an inbox (${response.status})`);
  }
  // D32: AgentMail answers in snake_case; these are the only two fields we use.
  const body = (await response.json()) as { inbox_id?: unknown; email?: unknown };
  const inboxId = typeof body.inbox_id === "string" ? body.inbox_id : null;
  const inboxEmail = typeof body.email === "string" ? body.email : null;
  if (!inboxId || !inboxEmail) throw new ConvexError("AgentMail did not return an inbox");
  return { inboxId, inboxEmail };
}

/**
 * Tombstone-aware resolution of the caller for `ensureInbox`, which has no
 * `ctx.db` of its own (D115 6b-3). `ctx.runQuery` from an action propagates
 * the same request's `ctx.auth`, so this resolves the same user the bare
 * `getAuthUserId` this action used to call would, but also refuses a
 * deleting/deleted account before `createInboxRemote`'s `fetch` is ever
 * reached (checkpoint 6b F3b: a deleted account used to still get a brand
 * new AgentMail inbox provisioned for it, forever unreachable by any purge).
 */
export const requireActiveUserId = internalQuery({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => requireUserId(ctx),
});

/**
 * Provisions the caller's AgentMail inbox on first use and returns its
 * address. Idempotent: a second call returns the stored address without
 * touching AgentMail, so the UI can call it on every sign-in.
 */
export const ensureInbox = action({
  args: {},
  returns: v.string(),
  handler: async (ctx): Promise<string> => {
    const userId = await ctx.runQuery(internal.profiles.requireActiveUserId, {});

    const existing = await ctx.runQuery(internal.profiles.byUser, { userId });
    if (existing) return existing.inboxEmail;

    const { inboxId, inboxEmail } = await createInboxRemote();
    const saved = await ctx.runMutation(internal.profiles.save, { userId, inboxId, inboxEmail });
    return saved.inboxEmail;
  },
});
