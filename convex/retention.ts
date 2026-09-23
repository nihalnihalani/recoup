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
  PROCESSED_EVENTS_PAGE,
} from "./limits";
import { EVALUATION_RETENTION_DAYS, EVIDENCE_RETENTION_DAYS, EVIDENCE_TEXT_KINDS, ORPHAN_BLOB_MIN_AGE_HOURS } from "./lib/privacyFacts";
import { isBlobReferenced, releaseEvidenceBlob } from "./lib/blobRefs";
import { pruneMarketPoints } from "./lib/marketRetention";

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

/**
 * M14b (D163): this step pages `PROCESSED_EVENTS_PAGE` (25) rows, not
 * `RETENTION_PAGE` (200). It must read each row, payload included, before
 * it can decide anything, and a payload holds up to 60,000 chars
 * (`inbound.ts` MAX_TEXT_CHARS): about 180 KB of 3-byte UTF-8 (CJK). Two
 * hundred such rows is ~36 MB, and even 100 (~18 MB) exceed Convex's 16 MiB
 * per-transaction read limit. The call then threw on the same persisted
 * cursor every day, which stalled the whole cycle for good. 25 rows is the
 * budget 6b-6 derived for this table in `account.ts` (see
 * `PROCESSED_EVENTS_PAGE` in limits.ts). Every other step keeps
 * `RETENTION_PAGE`: their rows are small.
 */
async function sweepProcessedEvents(ctx: MutationCtx, page: string | null, now: number): Promise<StepResult> {
  const result = await ctx.db.query("processedEvents").paginate({ cursor: page, numItems: PROCESSED_EVENTS_PAGE });
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

// ===========================================================================
// M14 (contract rev 5 §2.6, §8): transaction-recovery retention.
//
// Two more resumable sweeps, each with its OWN opsState row and daily cron
// (`crons.ts`), deliberately separate from `sweep` above:
//  - `sweep`'s `STEPS` order and `{ step, page }` cursor are mirrored by hand
//    in `ops.ts` (`RETENTION_STEPS`) and pinned by existing tests, so inserting
//    steps there would shift every index under a live cursor;
//  - a failure here (a blob delete, a new table's validator) cannot stall
//    the D75 sweep, and vice versa.
// Both follow `sweep`'s design: one bounded page per call, the cursor
// persisted before any self-reschedule, `updatedAt` stamped on every page
// (M1B's `ops.backlog` reports the row's age), and a stop after the page
// that completes a cycle until the next cron firing.
//
// **Stable page bounds.** Each cycle fixes `startedAt` in its cursor, and
// every window's cutoff derives from it, so each `.paginate()` range stays
// identical across the calls of one cycle and a continuation cursor is
// always resumed against the exact query that produced it. A cycle that
// stalls for days just uses an older cutoff, which clears less, never more.
// ===========================================================================

/** opsState key of `sweepRecovery`'s cursor (exported for `ops.backlog`, M1B). */
export const RECOVERY_RETENTION_OPS_KEY = "retentionRecovery";
/** opsState key of `sweepOrphanBlobs`'s cursor (the key M1B's `ops.backlog` reads). */
export const ORPHAN_SWEEP_OPS_KEY = "orphanSweep";

/** `sweepRecovery`'s cycle order. Evidence first: it is the privacy promise (D146); evaluation pruning is housekeeping (DA-A-32). */
export const RECOVERY_STEPS = ["evidence", "evaluations", "marketPrices"] as const;

/** Watches per call of the `marketPrices` step (each prunes at most `MARKET_PRUNE_BATCH` old points; P07-W5). */
export const MARKET_RETENTION_WATCH_PAGE = 20;

/**
 * Evidence rows per call: `text` holds up to 60,000 chars (§2.6), the same
 * worst case `PROCESSED_EVENTS_PAGE` is sized for (6b-6), plus one
 * transaction read and at most two one-row claim reads per distinct
 * transaction.
 */
export const EVIDENCE_RETENTION_PAGE = PROCESSED_EVENTS_PAGE;
/** Evaluation rows per call: the same byte budget as `account.ts`'s `EVALUATION_PAGE` (bounded §2.4 arrays, ~100 KB/row worst case). */
export const EVALUATION_PRUNE_PAGE = 50;
/**
 * `_storage` rows per call. A blob's own row is tiny, but checking whether a
 * blob is referenced reads the referencing document itself (an evidence row
 * of up to ~180 KB), so this page is sized like the evidence one.
 */
export const ORPHAN_SWEEP_PAGE = 25;

type CycleCursor = { step: number; page: string | null; startedAt: number };

/** A fresh cycle (step 0, no page) always restamps `startedAt`; a malformed cursor restarts the cycle. */
function parseCycleCursor(raw: string | undefined, stepCount: number, now: number): CycleCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<CycleCursor>;
      const step = parsed.step ?? 0;
      const page = typeof parsed.page === "string" ? parsed.page : null;
      const startedAt = parsed.startedAt;
      if (Number.isInteger(step) && step >= 0 && step < stepCount && typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt <= now) {
        if (step === 0 && page === null) return { step: 0, page: null, startedAt: now };
        return { step, page, startedAt };
      }
    } catch {
      // Malformed/foreign cursor value: start the cycle over.
    }
  }
  return { step: 0, page: null, startedAt: now };
}

async function writeCycleCursor(ctx: MutationCtx, key: string, cursor: CycleCursor, now: number): Promise<void> {
  const row = await ctx.db
    .query("opsState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  const serialized = JSON.stringify(cursor);
  if (row) await ctx.db.patch(row._id, { cursor: serialized, updatedAt: now });
  else await ctx.db.insert("opsState", { key, cursor: serialized, updatedAt: now });
}

async function readCycleCursor(ctx: MutationCtx, key: string, stepCount: number, now: number): Promise<CycleCursor> {
  const row = await ctx.db
    .query("opsState")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return parseCycleCursor(row?.cursor, stepCount, now);
}

// ---------------------------------------------------------------------------
// Evidence (DA-A-7, D145, D146; contract §2.6 "Retention")
// ---------------------------------------------------------------------------

const EVIDENCE_TEXT_KIND_SET = new Set<string>(EVIDENCE_TEXT_KINDS);

type TransactionRetentionView = { hasCase: boolean; archived: boolean } | null;

/**
 * "Has a case" (§2.6): any claim, in any status, referencing the transaction
 * through `claims.by_transaction_and_status`, or, for retail, any claim on
 * its purchase through `claims.by_purchase_type` (legacy claims carry no
 * `transactionId`). Read-only: never writes claims.
 */
async function transactionRetentionView(ctx: MutationCtx, transactionId: Id<"transactions">): Promise<TransactionRetentionView> {
  const txn = await ctx.db.get(transactionId);
  if (!txn) return null;
  const byTransaction = await ctx.db
    .query("claims")
    .withIndex("by_transaction_and_status", (q) => q.eq("transactionId", transactionId))
    .first();
  let hasCase = byTransaction !== null;
  if (!hasCase && txn.purchaseId) {
    const purchaseId = txn.purchaseId;
    const byPurchase = await ctx.db
      .query("claims")
      .withIndex("by_purchase_type", (q) => q.eq("purchaseId", purchaseId))
      .first();
    hasCase = byPurchase !== null;
  }
  return { hasCase, archived: txn.status === "archived" };
}

/**
 * Whether an `active` evidence row past the window is kept. The rules,
 * verbatim from §2.6 and published through `lib/privacyFacts.ts`:
 *  - email/paste: kept only if pinned or its transaction has a case;
 *  - upload: also kept while attached to a transaction that is not archived;
 *  - `manual_note`/`system_capture`: out of scope, never touched.
 */
async function keepEvidence(
  ctx: MutationCtx,
  row: Doc<"evidence">,
  cache: Map<Id<"transactions">, TransactionRetentionView>,
): Promise<boolean> {
  const isText = EVIDENCE_TEXT_KIND_SET.has(row.kind);
  if (!isText && row.kind !== "upload") return true;
  if (row.pinnedAt !== undefined) return true;
  if (row.transactionId === undefined) return false;
  let view = cache.get(row.transactionId);
  if (view === undefined) {
    view = await transactionRetentionView(ctx, row.transactionId);
    cache.set(row.transactionId, view);
  }
  if (view === null) return false; // dangling link: treated as unattached
  if (view.hasCase) return true;
  return row.kind === "upload" && !view.archived;
}

/**
 * Clears one row's content: the blob (if any, and if still present), then
 * `text`, the storage link and the extraction summary (derived from the
 * content), all in this mutation. `headers`, `contentHash` (DA-A-20: a
 * re-upload of the same bytes revives the row) and metadata such as
 * `fileName` stay. Facts, with their ≤ 300-char locator quotes, live in
 * their own table and are never touched here.
 */
async function clearEvidenceContent(ctx: MutationCtx, row: Doc<"evidence">): Promise<void> {
  // D173: deletes the blob and releases its bytes from the lifetime stored-bytes counter; the patch below removes
  // `storageId` in this same mutation, so a retried page never releases twice.
  await releaseEvidenceBlob(ctx, row);
  await ctx.db.patch(row._id, { text: undefined, storageId: undefined, extractionSummary: undefined, retention: "content_deleted" });
}

async function sweepEvidenceStep(ctx: MutationCtx, page: string | null, startedAt: number): Promise<StepResult> {
  const cutoff = startedAt - EVIDENCE_RETENTION_DAYS * DAY_MS;
  // Only `active` rows received before the cutoff: a cleared row leaves this range for good.
  const result = await ctx.db
    .query("evidence")
    .withIndex("by_retention_and_received_at", (q) => q.eq("retention", "active").lt("receivedAt", cutoff))
    .paginate({ cursor: page, numItems: EVIDENCE_RETENTION_PAGE });
  const cache = new Map<Id<"transactions">, TransactionRetentionView>();
  let patched = 0;
  for (const row of result.page) {
    if (await keepEvidence(ctx, row, cache)) continue;
    await clearEvidenceContent(ctx, row);
    patched++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted: 0, patched };
}

// ---------------------------------------------------------------------------
// Evaluations (DA-A-32; contract §8 "Retention")
// ---------------------------------------------------------------------------

type OpportunityRetentionView = { currentEvaluationId?: Id<"evaluations">; caseLinked: boolean };

/**
 * Keep reasons for an opportunity's evaluations:
 *  - `currentEvaluationId`: the one the card shows;
 *  - `caseLinked`: `activeClaimId` is set, or any claim references the
 *    opportunity through `claims.by_opportunity`.
 * `caseLinked` also covers every approval binding: `drafts.binding` is
 * written only on a draft of a claim linked to that opportunity, so a bound
 * evaluation's opportunity always has a claim. `packets.binding` (wave 2)
 * sits on the same claims. A missing opportunity keeps only the claim check.
 */
async function opportunityRetentionView(ctx: MutationCtx, opportunityId: Id<"opportunities">): Promise<OpportunityRetentionView> {
  const opp = await ctx.db.get(opportunityId);
  if (opp?.activeClaimId) return { currentEvaluationId: opp.currentEvaluationId, caseLinked: true };
  const claim = await ctx.db
    .query("claims")
    .withIndex("by_opportunity", (q) => q.eq("opportunityId", opportunityId))
    .first();
  return { currentEvaluationId: opp?.currentEvaluationId, caseLinked: claim !== null };
}

async function pruneEvaluationsStep(ctx: MutationCtx, page: string | null, startedAt: number): Promise<StepResult> {
  const cutoff = startedAt - EVALUATION_RETENTION_DAYS * DAY_MS;
  const result = await ctx.db
    .query("evaluations")
    .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
    .paginate({ cursor: page, numItems: EVALUATION_PRUNE_PAGE });
  const cache = new Map<Id<"opportunities">, OpportunityRetentionView>();
  let deleted = 0;
  for (const row of result.page) {
    if (row.evaluatedAt >= cutoff) continue; // belt and braces next to `_creationTime`
    let view = cache.get(row.opportunityId);
    if (!view) {
      view = await opportunityRetentionView(ctx, row.opportunityId);
      cache.set(row.opportunityId, view);
    }
    if (view.currentEvaluationId === row._id || view.caseLinked) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

async function runRecoveryStep(ctx: MutationCtx, step: (typeof RECOVERY_STEPS)[number], page: string | null, startedAt: number): Promise<StepResult> {
  switch (step) {
    case "evidence":
      return sweepEvidenceStep(ctx, page, startedAt);
    case "evaluations":
      return pruneEvaluationsStep(ctx, page, startedAt);
    case "marketPrices":
      return pruneMarketStep(ctx, page);
  }
}

/**
 * P07-W5: one page of watches, each trimmed to its newest `MARKET_MAX_POINTS` market points. New points are trimmed on
 * write (`market.recordSnapshot`); this catches history written before that bound and watches never refreshed since.
 */
async function pruneMarketStep(ctx: MutationCtx, page: string | null): Promise<StepResult> {
  const result = await ctx.db.query("watches").paginate({ cursor: page, numItems: MARKET_RETENTION_WATCH_PAGE });
  let deleted = 0;
  for (const watch of result.page) deleted += await pruneMarketPoints(ctx, watch._id);
  return { isDone: result.isDone, continueCursor: result.continueCursor, deleted, patched: 0 };
}

/**
 * One bounded page of the transaction-recovery retention cycle (evidence,
 * then evaluations). Never touches the ledger, claims, drafts, replies,
 * purchases, transactions or facts (contract §8). Same return shape as
 * `sweep`.
 */
export const sweepRecovery = internalMutation({
  args: {},
  returns: v.object({ table: v.string(), deleted: v.number(), patched: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cursor = await readCycleCursor(ctx, RECOVERY_RETENTION_OPS_KEY, RECOVERY_STEPS.length, now);
    const table = RECOVERY_STEPS[cursor.step];

    const result = await runRecoveryStep(ctx, table, cursor.page, cursor.startedAt);

    const stepDone = result.isDone;
    const cycleComplete = stepDone && cursor.step === RECOVERY_STEPS.length - 1;
    const next: CycleCursor = stepDone
      ? { step: cycleComplete ? 0 : cursor.step + 1, page: null, startedAt: cursor.startedAt }
      : { step: cursor.step, page: result.continueCursor, startedAt: cursor.startedAt };
    await writeCycleCursor(ctx, RECOVERY_RETENTION_OPS_KEY, next, now);

    if (!cycleComplete) await ctx.scheduler.runAfter(0, internal.retention.sweepRecovery, {});
    return { table, deleted: result.deleted, patched: result.patched, done: cycleComplete };
  },
});

// ---------------------------------------------------------------------------
// Orphan blobs (SEC-UP-7, DA-A-28(d); contract §2.6 "Orphan sweep")
// ---------------------------------------------------------------------------

/**
 * One bounded page of `_storage` blobs created before the cycle's cutoff
 * (`startedAt − ORPHAN_BLOB_MIN_AGE_HOURS`). Each blob that no
 * `BLOB_REFERENCES` field references is deleted. The age floor covers the
 * upload window: the upload httpAction stores the blob, then its finalize
 * mutation binds it, so a blob younger than 24 h may still be about to gain
 * its row. A referenced blob is never deleted. The reference check and the
 * delete run in one transaction, so a finalize that binds the blob
 * concurrently conflicts with this mutation instead of racing it.
 */
export const sweepOrphanBlobs = internalMutation({
  args: {},
  returns: v.object({ scanned: v.number(), deleted: v.number(), done: v.boolean() }),
  handler: async (ctx) => {
    const now = Date.now();
    const cursor = await readCycleCursor(ctx, ORPHAN_SWEEP_OPS_KEY, 1, now);
    const cutoff = cursor.startedAt - ORPHAN_BLOB_MIN_AGE_HOURS * 3_600_000;

    const result = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .paginate({ cursor: cursor.page, numItems: ORPHAN_SWEEP_PAGE });
    let deleted = 0;
    for (const blob of result.page) {
      if (await isBlobReferenced(ctx, blob._id)) continue;
      await ctx.storage.delete(blob._id);
      deleted++;
    }

    const next: CycleCursor = result.isDone
      ? { step: 0, page: null, startedAt: cursor.startedAt }
      : { step: 0, page: result.continueCursor, startedAt: cursor.startedAt };
    await writeCycleCursor(ctx, ORPHAN_SWEEP_OPS_KEY, next, now);

    if (!result.isDone) await ctx.scheduler.runAfter(0, internal.retention.sweepOrphanBlobs, {});
    return { scanned: result.page.length, deleted, done: result.isDone };
  },
});
