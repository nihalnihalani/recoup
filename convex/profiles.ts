import { ConvexError, v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalMutation, internalQuery, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { requireUserId } from "./lib/access";
import { isTombstoned } from "./lib/accountState";
import { inboxTransport } from "./account";
import { rateLimiter } from "./lib/rateLimits";
import { logEvent } from "./lib/log";
import { sanitizeError } from "./lib/errors";

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
 * The signed-in user's inbox, or `null` when signed out OR tombstoned
 * (ARCHITECTURE_PATTERNS §Auth: `me` branches in the UI, it does not throw;
 * `getAuthUserId`, not `requireUserId`, so this stays reachable for an
 * already-open tab's still-valid JWT the same way `account.deletionStatus`
 * does -- see that function's own docstring). `inboxEmail` is `null` until
 * `ensureInbox` has run once.
 *
 * T18.5 (D124 LOW): previously ungated (D115 6b's own inventory noted this
 * "by design", since the profiles row itself is purged early and the read
 * only ever produced nulls for a mid-purge account) -- but for a
 * DELETING/DELETED account whose `profiles` row has NOT yet been purged
 * (before `purgeStep` reaches that table, or a re-drive still in flight),
 * this still returned a live inbox address for a tombstoned account, a
 * needless exception to the same `deleted`-hides-everything rule
 * `requireUserId` enforces everywhere else. Gated the same way `account.me`-
 * shaped reads elsewhere check the tombstone, without needing the caller to
 * distinguish "signed out" from "deleted" (`me` never threw for either).
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
    if (await isTombstoned(ctx, userId)) return null;
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
 * Fills in (or, for any caller outside the `claimProvisioning` flow below,
 * idempotently inserts) the profile row with a real inbox. If a REAL
 * (already-provisioned) profile already exists for the user it wins and the
 * freshly created inbox is ignored, so a caller that bypasses
 * `claimProvisioning` can never leave the user with two live addresses in
 * the database (the losing AgentMail inbox is orphaned, never routed to,
 * because inbound routing resolves the user through `profiles.by_inbox`).
 *
 * T18.5 (D124 B3): `ensureInbox`'s own tombstone check (`requireActiveUserId`)
 * runs BEFORE the remote `createInboxRemote` POST, not after -- so a
 * `requestDeletion` landing while that POST is in flight (the purge's
 * `profiles` step already ran, or has not reached this user's row yet) would
 * otherwise let this `save` call insert a live profile row for an account
 * that is already tombstoned: a row `purgeStep` will never see again (its
 * `mailLog`/`profiles` steps only run once, driven by `purge`'s own single
 * pass), pointing at an inbox that will therefore never be deleted, while
 * `deletionStatus`/`accountDeletion.ts`'s copy both keep reporting
 * `inboxDeleted: true` (vacuously -- no `accountState.inboxId` was ever
 * recorded for it). Refusing here, at the actual write, closes the race
 * regardless of how long the POST took: returns `null` instead of writing,
 * and the caller (`ensureInbox`) is responsible for deleting the
 * now-orphaned remote inbox it just created (see its own docstring). The
 * PLACEHOLDER row `claimProvisioning` left behind is not otherwise touched
 * here -- ordinary `account.ts` purge removes any `profiles` row for a
 * tombstoned user regardless of shape.
 */
export const save = internalMutation({
  args: { userId: v.id("users"), inboxId: v.string(), inboxEmail: v.string() },
  returns: v.union(v.object({ inboxId: v.string(), inboxEmail: v.string(), created: v.boolean() }), v.null()),
  handler: async (ctx, args) => {
    if (await isTombstoned(ctx, args.userId)) return null;
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing?.inboxId && existing.inboxEmail) {
      // Already finalized -- a concurrent winner's own save() already
      // landed (or a caller outside the claim flow raced this one).
      return { inboxId: existing.inboxId, inboxEmail: existing.inboxEmail, created: false };
    }
    if (existing) {
      // Fills in the placeholder `claimProvisioning` created.
      await ctx.db.patch(existing._id, { inboxId: args.inboxId, inboxEmail: args.inboxEmail, provisioningAt: undefined });
    } else {
      await ctx.db.insert("profiles", args);
    }
    return { inboxId: args.inboxId, inboxEmail: args.inboxEmail, created: true };
  },
});

// ---------------------------------------------------------------------------
// Single-flight provisioning (T18.5 addendum, F-AUD-2/D126)
//
// Without this, N concurrent `ensureInbox` calls for the same user (e.g. N
// browser tabs opened at once, or a client retrying a slow first call) each
// independently POST /inboxes and each independently call `save` -- `save`'s
// own "first writer wins" check stops the DATABASE from ever holding two
// rows, but does nothing to stop N-1 REMOTE AgentMail inboxes from being
// created and immediately orphaned (no `profiles` row ever points at them,
// so no purge can ever find and delete them). `claimProvisioning` makes
// provisioning itself single-flight: the FIRST caller claims the (possibly
// new) profile row by stamping `provisioningAt`, so every OTHER concurrent
// caller sees the claim and waits for it instead of also POSTing.
// ---------------------------------------------------------------------------

/** How long a claimed-but-unfinished placeholder row may sit before a later caller may reclaim it (e.g. the original claimant crashed mid-POST). */
const PROVISIONING_STALE_MS = 10 * 60_000;

const claimResult = v.union(
  v.object({ kind: v.literal("ready"), inboxId: v.string(), inboxEmail: v.string() }),
  v.object({ kind: v.literal("claimed") }),
  v.object({ kind: v.literal("pending") }),
);
type ClaimResult = Infer<typeof claimResult>;

/**
 * Atomically claims the right to provision this user's inbox, or reports
 * that it is already done (`"ready"`) or already in flight (`"pending"`).
 * Convex serializes concurrent mutations via optimistic concurrency control
 * on the rows they read/write, so of any number of simultaneous callers that
 * all read "no row yet" (or the same stale placeholder), only one write
 * actually commits first; every other one is transparently retried by the
 * platform and, on retry, observes THAT write and returns `"pending"` --
 * there is no external lock to manage here, only this read-then-write
 * shape. Unauthenticated on purpose: the only caller is `ensureInbox`, which
 * has already resolved and owns `userId`.
 *
 * B-2 (D129, checkpoint 6d): `ensureInbox`'s own tombstone check
 * (`requireActiveUserId`) runs before this is ever called, but -- same shape
 * as B-3's race -- a `requestDeletion` landing between that check and this
 * mutation (including one whose purge has already fully run, past this
 * user's own `profiles` step) previously still let this insert a placeholder
 * row nothing would ever purge again. Gated here, at the write, the same way
 * `save`'s own write-time check already is.
 */
export const claimProvisioning = internalMutation({
  args: { userId: v.id("users") },
  returns: claimResult,
  handler: async (ctx, { userId }): Promise<ClaimResult> => {
    if (await isTombstoned(ctx, userId)) {
      throw new ConvexError("This account is being deleted.");
    }
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing?.inboxId && existing.inboxEmail) {
      return { kind: "ready", inboxId: existing.inboxId, inboxEmail: existing.inboxEmail };
    }
    const now = Date.now();
    if (existing) {
      if (existing.provisioningAt !== undefined && now - existing.provisioningAt < PROVISIONING_STALE_MS) {
        return { kind: "pending" };
      }
      // No claim yet, or a stale one (e.g. the original claimant's action
      // crashed after this write but before the provider ever answered):
      // reclaim it for this call.
      await ctx.db.patch(existing._id, { provisioningAt: now });
      return { kind: "claimed" };
    }
    await ctx.db.insert("profiles", { userId, provisioningAt: now });
    return { kind: "claimed" };
  },
});

/**
 * B-3 (D129, checkpoint 6d): releases a claim `ensureInbox` is abandoning
 * because the provider POST (or the `inboxProvision` rate limiter) itself
 * failed -- so the NEXT caller can retry immediately instead of waiting out
 * the full `PROVISIONING_STALE_MS` window behind what would otherwise still
 * look like a live in-flight claim (every OTHER concurrent caller sees
 * `"pending"` and polls for up to `PROVISIONING_POLL_MAX_ATTEMPTS *
 * PROVISIONING_POLL_INTERVAL_MS` before giving up on a row nothing is ever
 * going to finish). Only clears `provisioningAt` -- never deletes the row or
 * touches `inboxId`/`inboxEmail` (by construction this call's own claim
 * never reached `save`, so there is nothing else on the row to protect); a
 * row a CONCURRENT winner has since finished (`inboxId`/`inboxEmail` now
 * set) is left alone rather than regressed.
 */
export const releaseProvisioning = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing && existing.provisioningAt !== undefined && !existing.inboxId) {
      await ctx.db.patch(existing._id, { provisioningAt: undefined });
    }
    return null;
  },
});

/** Poll interval/budget for a `"pending"` caller waiting on another call's in-flight provisioning -- real time, run from an action (never a mutation, which cannot sleep). */
const PROVISIONING_POLL_INTERVAL_MS = 200;
const PROVISIONING_POLL_MAX_ATTEMPTS = 40; // ~8s total, generous over a real AgentMail POST's normal latency.

/**
 * Waits for another caller's in-flight `claimProvisioning` win to finish,
 * rather than racing it with a second provider POST. Returns the finished
 * address, or `null` if the wait budget runs out (the winning call is
 * unusually slow, failed outright, or the account was deleted mid-wait and
 * the placeholder row was left as-is for the ordinary purge to sweep -- see
 * `save`'s own docstring) -- never throws past the scheduler-less caller.
 */
async function waitForProvisioning(ctx: ActionCtx, userId: Id<"users">): Promise<string | null> {
  for (let i = 0; i < PROVISIONING_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((resolve) => setTimeout(resolve, PROVISIONING_POLL_INTERVAL_MS));
    const profile = await ctx.runQuery(internal.profiles.byUser, { userId });
    if (profile?.inboxId && profile.inboxEmail) return profile.inboxEmail;
    if (!profile) return null; // Purged (account deleted) while we were waiting.
  }
  return null;
}

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
 *
 * T18.5 addendum (F-AUD-2/D126): single-flight, via `claimProvisioning` --
 * of any number of concurrent calls for the same user, exactly ONE ever
 * POSTs to AgentMail and writes `save`; every other one either sees the
 * already-finished result (`"ready"`) or waits for the in-flight one to
 * finish (`"pending"`, `waitForProvisioning`) instead of also provisioning
 * (previously: N concurrent calls created N remote inboxes, N-1 of them
 * immediately and permanently orphaned -- no `profiles` row ever pointed at
 * them, so no purge could ever find and delete them). `rateLimiter`'s
 * `inboxProvision` (defined in `lib/rateLimits.ts`, previously never
 * applied anywhere) is consumed only by the actual claimed-and-provisioning
 * branch, not by every call -- it exists as a secondary guard against a
 * stale-reclaim thrash (the winner of a just-reclaimed stale placeholder
 * still cannot provision more than once per its own window), not to
 * throttle the normal single-POST path this claim already makes exact.
 *
 * T18.5 (D124 B3): returns `null` in the (rare) race where the account was
 * deleted between the initial `requireActiveUserId` check and `save`
 * landing -- see `save`'s own docstring for why the check has to live there,
 * not just here. When that happens, the inbox this call itself just created
 * on AgentMail is otherwise orphaned (no `profiles` row will ever record it,
 * so no future purge could ever find it to delete it): deleted right here,
 * synchronously, via the same `inboxTransport` the account-deletion purge
 * itself uses (`convex/account.ts`), before returning.
 *
 * B-3 (D129, checkpoint 6d): the provider POST (`createInboxRemote`) and the
 * `inboxProvision` rate limiter are both wrapped so a failure releases this
 * call's claim (`releaseProvisioning`) before rethrowing a sanitized error --
 * previously a failed POST left the placeholder looking claimed for the
 * full `PROVISIONING_STALE_MS` window, and every OTHER caller (this user's
 * own retry included) either saw `"pending"` and polled `waitForProvisioning`
 * to a timeout, or a fresh `claimProvisioning` call saw the same still-fresh
 * `provisioningAt` and also had to wait.
 *
 * B-5 (D129, checkpoint 6d): `save` returning `created: false` is not only
 * the tombstoned case (`saved === null`) -- a stale-reclaim race can also
 * leave THIS call as the loser: another concurrent claimant (that reclaimed
 * the SAME stale placeholder, or is racing it some other way) already saved
 * ITS OWN inbox first, so `save` here reports the WINNER's address with
 * `created: false` rather than inserting. Previously only `saved === null`
 * triggered the compensating delete, so a stale-reclaim loser's own
 * just-created inbox was left permanently orphaned (no `profiles` row would
 * ever point at it) even though the row itself was never tombstoned. Both
 * cases now delete THIS call's own `inboxId` (never the winner's) and return
 * the winner's real address instead of `null`.
 *
 * B-4 (D129, checkpoint 6d): if that compensating delete ITSELF fails (the
 * provider is down for both the create and the cleanup), the orphaned
 * `inboxId` is recorded in a structured `logEvent` line before the error is
 * rethrown -- previously the raw transport error propagated with no trace
 * of which inbox was left behind for an operator to clean up by hand (see
 * RUNBOOK's "Account deletion" section for the equivalent manual-DELETE
 * path this mirrors).
 */
export const ensureInbox = action({
  args: {},
  returns: v.union(v.string(), v.null()),
  handler: async (ctx): Promise<string | null> => {
    const userId = await ctx.runQuery(internal.profiles.requireActiveUserId, {});

    const claim = await ctx.runMutation(internal.profiles.claimProvisioning, { userId });
    if (claim.kind === "ready") return claim.inboxEmail;
    if (claim.kind === "pending") return await waitForProvisioning(ctx, userId);

    // claim.kind === "claimed": this call, and only this call, provisions.
    let inboxId: string;
    let inboxEmail: string;
    try {
      await rateLimiter.limit(ctx, "inboxProvision", { key: userId, throws: true });
      ({ inboxId, inboxEmail } = await createInboxRemote());
    } catch (err) {
      // B-3: release the claim so the next call can retry immediately
      // instead of finding this placeholder still "claimed".
      await ctx.runMutation(internal.profiles.releaseProvisioning, { userId });
      throw err;
    }

    const saved = await ctx.runMutation(internal.profiles.save, { userId, inboxId, inboxEmail });
    if (saved === null || !saved.created) {
      // saved === null: B-3/B-4's original race -- tombstoned mid-POST.
      // !saved.created: B-5 -- a concurrent stale-reclaim winner already
      // saved ITS OWN inbox first; THIS call's own just-created inbox
      // (`inboxId`, never `saved.inboxId`) is the one now orphaned.
      try {
        await inboxTransport.deleteInbox(inboxId);
      } catch (err) {
        logEvent("notification_failed", { inboxId, error: sanitizeError(err instanceof Error ? err.message : String(err)) });
        throw err;
      }
      return saved === null ? null : saved.inboxEmail;
    }
    return saved.inboxEmail;
  },
});
