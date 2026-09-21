import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAGE,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "./limits";

/**
 * D75: a resumable, bounded data-retention sweep. NEVER touches
 * `ledgerEvents`, `claims`, `claimNotes`, `drafts`, `replies`, `purchases`,
 * `items` or `policies` -- ledger history is append-only forever (Invariant:
 * financial and case history is never purged). This file only reads those
 * tables (never writes/deletes) in two places, both to avoid destroying
 * something they reference:
 *  - `priceChecks` pruning below excludes any check a `claims` row still
 *    references via `openedFromPriceCheckId` (read-only `claims.by_item`
 *    lookup);
 *  - the never-verified-account rule below refuses to delete a `users` row
 *    that turns out to own any `purchases`/`watches`/`claims`/`profiles`
 *    row (read-only `by_user` lookups) -- defense in depth, since sign-in
 *    itself is gated on verification and an unverified account should
 *    never have been able to create any of these in the first place.
 *
 * Design (opsState cursor per table, D75): one `opsState` row keyed
 * `"retention"` holds `{ step, page }` JSON in its `cursor` string field --
 * `step` indexes into `STEPS` below (which table/rule is being swept) and
 * `page` is that table's own `.paginate()` continuation cursor. Each call
 * to `sweep` reads and processes exactly one `RETENTION_PAGE`-sized page of
 * ONE step, then either advances `page` (more of this step left) or `step`
 * (this step's table is fully caught up, move to the next one, wrapping
 * `STEPS.length - 1` back to `0`). It self-reschedules (`ctx.scheduler
 * .runAfter(0, ...)`) after every page EXCEPT the one that completes the
 * very last step of a full cycle -- at that point it stops, and the daily
 * cron (`crons.ts`) starts the next cycle. This means a single cron firing
 * can chain through many scheduled `sweep` calls (as many as it takes to
 * catch every table up), but each individual call still reads/writes at
 * most `RETENTION_PAGE` rows -- bounded regardless of backlog size, and
 * resumable across redeploys or a crash mid-cycle since the cursor is
 * persisted before any reschedule.
 */

const RETENTION_OPS_KEY = "retention";
const DAY_MS = 86_400_000;

/**
 * Cycle order. `users` (never-verified accounts, D107 hygiene addendum)
 * runs last since it is the most expensive per-row check (several extra
 * indexed lookups per candidate) and the least urgent (mirrors the ~4,800/
 * day unverified signup ceiling, not a fast-growing operational table).
 */
const STEPS = ["processedEvents", "watchChecks", "priceChecks", "offerChecks", "mailLog", "opsState", "users"] as const;
type Step = (typeof STEPS)[number];

type Cursor = { step: number; page: string | null };

function parseCursor(raw: string | undefined): Cursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<Cursor>;
      if (typeof parsed.step === "number" && Number.isInteger(parsed.step) && parsed.step >= 0 && parsed.step < STEPS.length) {
        return { step: parsed.step, page: typeof parsed.page === "string" ? parsed.page : null };
      }
    } catch {
      // Malformed/foreign cursor value: fall through and start the cycle over.
    }
  }
  return { step: 0, page: null };
}

type StepResult = { isDone: boolean; continueCursor: string; deleted: number; patched: number };

// ---------------------------------------------------------------------------
// processedEvents: clear `payload` (up to 60KB of raw email) for terminal
// (succeeded/failed) rows once they are old enough that nothing will ever
// retry them off it. The row itself, its `summary`/`errorSummary`, and
// every other field are kept -- only the payload blob is cleared.
// ---------------------------------------------------------------------------

const TERMINAL_EVENT_STATUSES = new Set<Doc<"processedEvents">["status"]>(["succeeded", "failed"]);

async function sweepProcessedEvents(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("processedEvents").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_PAYLOAD_DAYS * DAY_MS;
  let patched = 0;
  for (const row of result.page) {
    if (!TERMINAL_EVENT_STATUSES.has(row.status)) continue;
    if (row._creationTime >= cutoff) continue;
    if (row.payload === undefined) continue; // already cleared; no-op write avoided
    await ctx.db.patch(row._id, { payload: undefined });
    patched++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted: 0, patched };
}

// ---------------------------------------------------------------------------
// watchChecks / priceChecks / offerChecks: prune observations older than
// RETENTION_OBSERVATION_DAYS, but NEVER one of the newest RETENTION_KEEP_
// NEWEST per parent (watch/item/offer), regardless of age -- a parent that
// has gone quiet (paused watch, returned item) keeps its most recent
// history instead of losing everything. `priceChecks` additionally never
// deletes a check a `claims` row still references via
// `openedFromPriceCheckId` (D75 risk note: an open price-adjustment claim's
// evidence must survive even past the keep-newest window).
// ---------------------------------------------------------------------------

async function sweepWatchChecks(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("watchChecks").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_OBSERVATION_DAYS * DAY_MS;
  const newestCache = new Map<Id<"watches">, Set<Id<"watchChecks">>>();
  let deleted = 0;
  for (const row of result.page) {
    if (row._creationTime >= cutoff) continue;
    let newest = newestCache.get(row.watchId);
    if (!newest) {
      const top = await ctx.db
        .query("watchChecks")
        .withIndex("by_watch", (q) => q.eq("watchId", row.watchId))
        .order("desc")
        .take(RETENTION_KEEP_NEWEST);
      newest = new Set(top.map((r) => r._id));
      newestCache.set(row.watchId, newest);
    }
    if (newest.has(row._id)) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

async function sweepPriceChecks(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("priceChecks").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_OBSERVATION_DAYS * DAY_MS;
  const newestCache = new Map<Id<"items">, Set<Id<"priceChecks">>>();
  const referencedCache = new Map<Id<"items">, Set<Id<"priceChecks">>>();
  let deleted = 0;
  for (const row of result.page) {
    if (row._creationTime >= cutoff) continue;
    let newest = newestCache.get(row.itemId);
    if (!newest) {
      const top = await ctx.db
        .query("priceChecks")
        .withIndex("by_item", (q) => q.eq("itemId", row.itemId))
        .order("desc")
        .take(RETENTION_KEEP_NEWEST);
      newest = new Set(top.map((r) => r._id));
      newestCache.set(row.itemId, newest);
    }
    if (newest.has(row._id)) continue;
    let referenced = referencedCache.get(row.itemId);
    if (!referenced) {
      // Read-only: never deletes/patches `claims` (see module docstring).
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_item", (q) => q.eq("itemId", row.itemId))
        .collect();
      referenced = new Set(claims.flatMap((c) => (c.openedFromPriceCheckId ? [c.openedFromPriceCheckId] : [])));
      referencedCache.set(row.itemId, referenced);
    }
    if (referenced.has(row._id)) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

async function sweepOfferChecks(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("offerChecks").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_OBSERVATION_DAYS * DAY_MS;
  const newestCache = new Map<Id<"offers">, Set<Id<"offerChecks">>>();
  let deleted = 0;
  for (const row of result.page) {
    if (row._creationTime >= cutoff) continue;
    let newest = newestCache.get(row.offerId);
    if (!newest) {
      const top = await ctx.db
        .query("offerChecks")
        .withIndex("by_offer", (q) => q.eq("offerId", row.offerId))
        .order("desc")
        .take(RETENTION_KEEP_NEWEST);
      newest = new Set(top.map((r) => r._id));
      newestCache.set(row.offerId, newest);
    }
    if (newest.has(row._id)) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

// ---------------------------------------------------------------------------
// mailLog: delete (not merely clear) terminal rows once they are old.
// Unlike processedEvents, mailLog carries no large payload worth keeping
// around -- the whole row is disposable once its outcome is this old.
// ---------------------------------------------------------------------------

const TERMINAL_MAIL_STATUSES = new Set<Doc<"mailLog">["status"]>(["sent", "failed", "suppressed"]);

async function sweepMailLog(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("mailLog").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_MAILLOG_DAYS * DAY_MS;
  let deleted = 0;
  for (const row of result.page) {
    if (!TERMINAL_MAIL_STATUSES.has(row.status)) continue;
    if (row._creationTime >= cutoff) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

// ---------------------------------------------------------------------------
// opsState stash rows: `mailEvent:<messageId>` (F8 pending AgentMail events
// not yet mapped to a row, D99 N7 -- never deleted for terminal/unknown
// ids before this) and `e2e:code:<email>` (D102 E2E verification-code
// capture). Every other opsState key (this sweep's own "retention" cursor,
// `authMigrate`, market.ts's migration cursor, ...) is a durable control
// row and is left alone by construction: only these two prefixes match.
// ---------------------------------------------------------------------------

function isStashKey(key: string): boolean {
  return key.startsWith("mailEvent:") || key.startsWith("e2e:code:");
}

async function sweepOpsStateStash(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("opsState").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_STASH_DAYS * DAY_MS;
  let deleted = 0;
  for (const row of result.page) {
    if (!isStashKey(row.key)) continue;
    if (row.updatedAt >= cutoff) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

// ---------------------------------------------------------------------------
// D107 hygiene addendum: `authSignUpGlobal`'s 200/h cap still admits up to
// ~4,800 unverified signups a day with nothing pruning them. A `users` row
// with no `emailVerificationTime`, older than RETENTION_UNVERIFIED_DAYS,
// cannot own any application data (every mutation resolves the caller
// through a session, and `@convex-dev/auth`'s Password provider refuses to
// mint one -- `signInSeeded`'s real gate, see convex/testing.ts -- until
// emailVerified is set) -- so deleting it is safe. Defended anyway: skip
// (never delete) a candidate that turns out to own any `purchases`/
// `watches`/`claims`/`profiles` row, asserted in retention.test.ts by
// seeding exactly that shape and counting owned rows survive.
// ---------------------------------------------------------------------------

async function ownsAnything(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const [purchase, watch, claim, profile] = await Promise.all([
    ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    ctx.db.query("claims").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
  ]);
  return purchase !== null || watch !== null || claim !== null || profile !== null;
}

/**
 * Deletes a never-verified user's auth rows, children first, then the user
 * itself. `.collect()` (not `.take()`) on the per-user/per-account pages
 * below is safe unbounded: an account that never verified realistically
 * carries at most one `authAccounts` row (the password provider) and at
 * most a handful of `authVerificationCodes`/`authSessions` -- nothing here
 * scales with real usage the way e.g. `priceChecks` does.
 */
async function deleteNeverVerifiedUser(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const accounts = await ctx.db
    .query("authAccounts")
    .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
    .collect();
  for (const account of accounts) {
    const codes = await ctx.db
      .query("authVerificationCodes")
      .withIndex("accountId", (q) => q.eq("accountId", account._id))
      .collect();
    for (const code of codes) await ctx.db.delete(code._id);
    await ctx.db.delete(account._id);
  }
  const sessions = await ctx.db
    .query("authSessions")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .collect();
  for (const session of sessions) {
    const tokens = await ctx.db
      .query("authRefreshTokens")
      .withIndex("sessionId", (q) => q.eq("sessionId", session._id))
      .collect();
    for (const token of tokens) await ctx.db.delete(token._id);
    await ctx.db.delete(session._id);
  }
  await ctx.db.delete(userId);
}

async function sweepNeverVerifiedUsers(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("users").paginate({ cursor: page, numItems: RETENTION_PAGE });
  const cutoff = now - RETENTION_UNVERIFIED_DAYS * DAY_MS;
  let deleted = 0;
  for (const user of result.page) {
    if (user.emailVerificationTime !== undefined) continue;
    if (user._creationTime >= cutoff) continue;
    if (await ownsAnything(ctx, user._id)) continue; // defensive; see module docstring
    await deleteNeverVerifiedUser(ctx, user._id);
    deleted++;
  }
  // `deleted` counts users removed (the primary row this step targets), not
  // the auth child rows deleted alongside each one.
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function runStep(ctx: MutationCtx, table: Step, page: string | null, now: number): Promise<StepResult> {
  switch (table) {
    case "processedEvents":
      return sweepProcessedEvents(ctx, page, now);
    case "watchChecks":
      return sweepWatchChecks(ctx, page, now);
    case "priceChecks":
      return sweepPriceChecks(ctx, page, now);
    case "offerChecks":
      return sweepOfferChecks(ctx, page, now);
    case "mailLog":
      return sweepMailLog(ctx, page, now);
    case "opsState":
      return sweepOpsStateStash(ctx, page, now);
    case "users":
      return sweepNeverVerifiedUsers(ctx, page, now);
  }
}

/**
 * One bounded page of one retention rule; see the module docstring for the
 * cursor/self-reschedule design. `table` in the return value names which
 * step this particular call processed; `done` is true only once this call
 * completed the LAST step of a full cycle (every table caught up as of
 * `now`) -- at that point it stops self-rescheduling and waits for the
 * next cron firing.
 */
export const sweep = internalMutation({
  args: {},
  returns: v.object({ table: v.string(), deleted: v.number(), patched: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const opsRow = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", RETENTION_OPS_KEY))
      .unique();
    const { step, page } = parseCursor(opsRow?.cursor);
    const table = STEPS[step];

    const result = await runStep(ctx, table, page, now);

    const stepDone = result.isDone;
    const nextStep = stepDone ? (step + 1) % STEPS.length : step;
    const nextPage = stepDone ? null : result.continueCursor;
    const cycleComplete = stepDone && step === STEPS.length - 1;

    const cursor: Cursor = { step: nextStep, page: nextPage };
    const serialized = JSON.stringify(cursor);
    if (opsRow) await ctx.db.patch(opsRow._id, { cursor: serialized, updatedAt: now });
    else await ctx.db.insert("opsState", { key: RETENTION_OPS_KEY, cursor: serialized, updatedAt: now });

    if (!cycleComplete) {
      await ctx.scheduler.runAfter(0, internal.retention.sweep, {});
    }

    return { table, deleted: result.deleted, patched: result.patched, done: cycleComplete };
  },
});
