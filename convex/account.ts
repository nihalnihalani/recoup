/**
 * P09: authenticated data export and account deletion (T18, D77, D83, D87).
 *
 * Deletion is a tombstone-first, resumable, bounded process:
 *  1. `requestDeletion` (public mutation) inserts the `accountState` row
 *     (status `deleting`) FIRST, revokes every session, then schedules
 *     `purge` -- all in the one transaction, so a crash right after this
 *     mutation commits still leaves the account unusable (`lib/access.ts`'s
 *     `requireUserId` refuses any tombstoned user everywhere else in the
 *     app) even if `purge` itself never runs.
 *  2. `purge` (internalAction) repeatedly calls `purgeStep` (internalMutation)
 *     until every owned row is gone, then deletes the AgentMail inbox over
 *     REST, then calls `purgeAuth` (internalMutation) to remove the
 *     Convex Auth rows and the `users` row itself, then marks the tombstone
 *     `deleted`. `accountState` itself is never deleted -- it IS the
 *     tombstone (D77).
 *  3. `purgeStep` deletes at most `RETENTION_PAGE` rows from ONE table per
 *     call, in the contract's fixed child-before-parent order, storing its
 *     position in `accountState.progress` so a crash/redeploy mid-purge
 *     resumes exactly where it left off (same resumable-cursor shape as
 *     `retention.ts`'s `sweep`, reused here per instruction).
 *
 * `exportPage` is the read side: one table's rows, 200 at a time, always
 * scoped to the caller's own id (never accepted as an argument) via a
 * `by_user`-family index, or -- for the handful of tables that carry a
 * `userId` field but no index on it -- by iterating the user's own parent
 * rows (also index-scoped) and reading each parent's children. It refuses
 * once deletion has started: a paged export racing a purge could otherwise
 * observe a table that is only partially gone.
 *
 * **Session revocation, and the exported name used (report requirement):**
 * `@convex-dev/auth/server` exports `invalidateSessions(ctx, { userId })`,
 * but its signature is `(ctx: GenericActionCtx<DataModel>, args) =>
 * Promise<void>` (`node_modules/@convex-dev/auth/dist/server/implementation
 * /index.js`'s `invalidateSessions` calls `callInvalidateSessions`, which
 * does `ctx.runMutation("auth:store", ...)` -- an action-only method).
 * `requestDeletion` must be a plain mutation (the contract requires the
 * tombstone write and the revoke in the SAME transaction, and only a
 * mutation can write `ctx.db` transactionally), and a `MutationCtx` has no
 * `runMutation`. Calling the exported helper from `requestDeletion` is
 * therefore a compile error, not a design choice. `revokeAuthSessions`
 * below reimplements the exact same logic the library uses internally
 * (`invalidateSessionsImpl`, the unexported mutation-context half of the
 * same feature: delete every `authRefreshTokens` row for each of the
 * user's `authSessions`, then the sessions themselves) directly against
 * `ctx.db`, using the library's own documented table/index names
 * (`authSessions.userId`, `authRefreshTokens.sessionId`). `purgeAuth` calls
 * the same helper again defensively (a session minted between
 * `requestDeletion` and `purgeAuth` -- sign-in itself is not gated on
 * `isTombstoned`, only every app-level query/mutation is, via
 * `requireUserId` -- would otherwise survive purge).
 */
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { accountStateStatus } from "./schema";
import { requireUserId } from "./lib/access";
import { sanitizeError } from "./lib/errors";
import { RETENTION_PAGE } from "./limits";

const CONFIRMATION_PHRASE = "delete my account";

/** Page size for both `exportPage` (contract: "paginate({ numItems: 200 })") and `purgeStep` (reuses T16's `RETENTION_PAGE`, also 200 today) -- named separately so the two call sites read as independent decisions even though the numbers agree. */
const EXPORT_PAGE = 200;

// ---------------------------------------------------------------------------
// Table topology shared by `exportPage` (read) and `purgeStep` (delete).
// ---------------------------------------------------------------------------

const EXPORT_TABLES = v.union(
  v.literal("purchases"),
  v.literal("items"),
  v.literal("claims"),
  v.literal("ledgerEvents"),
  v.literal("claimNotes"),
  v.literal("drafts"),
  v.literal("replies"),
  v.literal("followUps"),
  v.literal("policies"),
  v.literal("priceChecks"),
  v.literal("watches"),
  v.literal("watchChecks"),
  v.literal("offers"),
  v.literal("offerChecks"),
  v.literal("marketPrices"),
  v.literal("mailLog"),
  v.literal("processedEvents"),
  v.literal("alertSettings"),
  v.literal("profiles"),
);
type ExportTable =
  | "purchases" | "items" | "claims" | "ledgerEvents" | "claimNotes" | "drafts" | "replies" | "followUps"
  | "policies" | "priceChecks" | "watches" | "watchChecks" | "offers" | "offerChecks" | "marketPrices"
  | "mailLog" | "processedEvents" | "alertSettings" | "profiles";

/** `purgeStep`'s table order (contract, verbatim): child rows before the parents they point at, so a crash mid-purge never leaves a dangling reference. */
const PURGE_STEPS = [
  "followUps", "claimNotes", "drafts", "replies", "ledgerEvents", "claims", "priceChecks", "items",
  "purchases", "policies", "offerChecks", "offers", "marketPrices", "watchChecks", "watches", "mailLog",
  "usage", "alertSettings", "processedEvents", "profiles",
] as const;
type PurgeTable = (typeof PURGE_STEPS)[number];

/** A table reached directly by a `userId`-prefixed index on the table itself (a plain `by_user`, or the first field of a compound index -- a valid index-range prefix). */
type DirectSpec = { kind: "direct"; index: string };
/** A table with a `userId` field but no `userId`-prefixed index: reached by iterating the user's own rows in `parentTable` (via ITS index) and reading/deleting each parent's children off `childIndex`. */
type ParentSpec = { kind: "parent"; parentTable: TableNames; parentIndex: string; childTable: TableNames; childIndex: string; childField: string };
/** `processedEvents` has only `by_user_status` (no plain `by_user`): iterate the fixed status list instead of a parent table. */
type StatusSpec = { kind: "status"; table: TableNames };

type TableSpec = DirectSpec | ParentSpec | StatusSpec;

const PROCESSED_EVENT_STATUSES = ["received", "processing", "succeeded", "failed", "needs_review"] as const;

function claimChild(childTable: TableNames, childIndex: string): ParentSpec {
  return { kind: "parent", parentTable: "claims", parentIndex: "by_user", childTable, childIndex, childField: "claimId" };
}

/** One entry per table `exportPage`/`purgeStep` ever touch: the 19 exportable tables plus `usage` (purged, but not exported -- internal quota counters, not user data). */
const TABLE_SPECS: Record<ExportTable | "usage", TableSpec> = {
  profiles: { kind: "direct", index: "by_user" },
  purchases: { kind: "direct", index: "by_user" },
  items: { kind: "direct", index: "by_user" },
  watches: { kind: "direct", index: "by_user" },
  mailLog: { kind: "direct", index: "by_user" },
  offers: { kind: "direct", index: "by_user" },
  claims: { kind: "direct", index: "by_user" },
  alertSettings: { kind: "direct", index: "by_user" },
  // Compound indexes whose FIRST field is `userId`: an `eq` on just that field is a valid index-range prefix and returns every row for the user.
  policies: { kind: "direct", index: "by_user_domain_kind" },
  usage: { kind: "direct", index: "by_user_day_kind" },
  processedEvents: { kind: "status", table: "processedEvents" },
  ledgerEvents: claimChild("ledgerEvents", "by_claim"),
  claimNotes: claimChild("claimNotes", "by_claim"),
  drafts: claimChild("drafts", "by_claim"),
  replies: claimChild("replies", "by_claim"),
  followUps: claimChild("followUps", "by_claim"),
  priceChecks: { kind: "parent", parentTable: "items", parentIndex: "by_user", childTable: "priceChecks", childIndex: "by_item", childField: "itemId" },
  watchChecks: { kind: "parent", parentTable: "watches", parentIndex: "by_user", childTable: "watchChecks", childIndex: "by_watch", childField: "watchId" },
  offerChecks: { kind: "parent", parentTable: "offers", parentIndex: "by_user", childTable: "offerChecks", childIndex: "by_offer", childField: "offerId" },
  marketPrices: { kind: "parent", parentTable: "watches", parentIndex: "by_user", childTable: "marketPrices", childIndex: "by_watch", childField: "watchId" },
};

type RawPage = { page: Array<Doc<any>>; isDone: boolean; continueCursor: string };

async function paginateByUser(ctx: QueryCtx | MutationCtx, table: TableNames, index: string, userId: Id<"users">, cursor: string | null, numItems: number): Promise<RawPage> {
  return await (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq("userId", userId)).paginate({ cursor, numItems });
}

/** Up to `n` rows of `table` matching `field === value`, via a plain bounded (non-paginated) index read. Convex allows only ONE `.paginate()` call per function execution (a hard platform limit -- see the "via-parent" design note below), so every CHILD-level read in this module uses `.take()` instead; only the PARENT-level read below uses the one `.paginate()` call a via-parent function is allowed. */
async function takeByField(ctx: QueryCtx | MutationCtx, table: TableNames, index: string, field: string, value: string, n: number): Promise<Doc<any>[]> {
  return await (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq(field, value)).take(n);
}

/**
 * Composite resumable cursor for a "via-parent" table:
 *  - `p`: the parent list's own pagination cursor (for fetching the NEXT
 *    batch of parent ids, once `queue` runs out); meaningless once
 *    `parentsDone` is true.
 *  - `parentsDone`: true once a `.paginate()` call has reported the parent
 *    list itself exhausted (distinct from `p === null`, which also means
 *    "start of the list" on the very first call).
 *  - `queue`: parent ids already fetched by a PRIOR `.paginate()` call but
 *    not yet fully processed -- kept in the cursor itself so working
 *    through them needs no further `.paginate()` calls.
 *  - `pid`: the one parent a previous call stopped PARTWAY through (its
 *    children alone exceeded that call's row budget).
 *
 * Design note (why this shape exists): Convex allows only a single
 * `.paginate()` call per function execution ("Only a single paginated query
 * is allowed per function execution", enforced by the platform -- verified
 * empirically against convex-test; not called out in this repo's own
 * guidelines). A naive "paginate the parents, and for each one paginate its
 * children" walk calls `.paginate()` an unbounded number of times per call,
 * which is invalid. Each `purgeStep`/`exportPage` call therefore performs
 * AT MOST ONE `.paginate()` call total, for the parent list, fetching up to
 * `PARENT_BATCH` parent ids at once; the whole batch is carried in `queue`
 * across calls (no cursor needed to re-read it) and drained with plain
 * `.take()` reads against each parent's children. One consequence: a call
 * whose fetched parent batch turns out to be entirely childless returns
 * fewer than `numItems` rows for that call (never more) rather than issuing
 * a second `.paginate()` to look further -- still correct and bounded, just
 * not always packed to the page size; the next call resumes from `p`.
 */
type ParentCursor = { p: string | null; parentsDone: boolean; queue: string[]; pid: string | null };
/** `readParentTable`'s cursor additionally tracks how far into `pid`'s children a prior call already returned (deleting, purge's twin below, needs no such bookkeeping -- a deleted row simply stops coming back). */
type ReadParentCursor = ParentCursor & { skip: number };

function decodeParentCursor(raw: string | null): ParentCursor {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ParentCursor>;
      return {
        p: typeof parsed.p === "string" ? parsed.p : null,
        parentsDone: parsed.parentsDone === true,
        queue: Array.isArray(parsed.queue) ? parsed.queue.filter((x): x is string => typeof x === "string") : [],
        pid: typeof parsed.pid === "string" ? parsed.pid : null,
      };
    } catch {
      // Malformed/foreign cursor: restart this table's parent scan.
    }
  }
  return { p: null, parentsDone: false, queue: [], pid: null };
}

function decodeReadParentCursor(raw: string | null): ReadParentCursor {
  const base = decodeParentCursor(raw);
  let skip = 0;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ReadParentCursor>;
      if (typeof parsed.skip === "number" && Number.isInteger(parsed.skip) && parsed.skip >= 0) skip = parsed.skip;
    } catch {
      // Already handled by decodeParentCursor above.
    }
  }
  return { ...base, skip };
}

/** Parent ids fetched per `.paginate()` call; also the practical ceiling on how many (possibly childless) parents one call works through. */
const PARENT_BATCH = RETENTION_PAGE;

/**
 * Fetches the next batch of parent ids into `queue`/`p`/`parentsDone` --
 * the ONE `.paginate()` call a via-parent function is allowed -- but only
 * when the queue handed in is already empty and there might be more parents
 * left; otherwise returns the state unchanged (no paginate() call made).
 */
async function refillParentQueue(ctx: QueryCtx | MutationCtx, spec: ParentSpec, userId: Id<"users">, state: ParentCursor): Promise<ParentCursor> {
  if (state.queue.length > 0 || state.parentsDone) return state;
  const parentPage = await paginateByUser(ctx, spec.parentTable, spec.parentIndex, userId, state.p, PARENT_BATCH);
  return { p: parentPage.isDone ? null : parentPage.continueCursor, parentsDone: parentPage.isDone, queue: parentPage.page.map((r) => r._id as string), pid: null };
}

/**
 * Read-only walk of a "via-parent" table, `numItems` rows at a time,
 * resumable via `cursorRaw`. `purgeStep`'s `drainParentTable` below is the
 * delete-and-resume twin (simpler: deleting a row is itself the "advance"
 * step, so it needs no `skip`).
 */
async function readParentTable(ctx: QueryCtx, spec: ParentSpec, userId: Id<"users">, cursorRaw: string | null, numItems: number): Promise<{ rows: Doc<any>[]; cursor: string | null }> {
  let { p, parentsDone, queue, pid, skip } = decodeReadParentCursor(cursorRaw);
  const rows: Doc<any>[] = [];

  // Resume a parent a previous call stopped partway through.
  if (pid !== null) {
    const need = numItems - rows.length;
    const batch = await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, pid, skip + need + 1);
    const slice = batch.slice(skip, skip + need);
    rows.push(...slice);
    if (batch.length > skip + need) {
      return { rows, cursor: JSON.stringify({ p, parentsDone, queue, pid, skip: skip + slice.length } satisfies ReadParentCursor) };
    }
    pid = null;
    skip = 0;
  }

  ({ p, parentsDone, queue, pid } = await refillParentQueue(ctx, spec, userId, { p, parentsDone, queue, pid }));

  while (rows.length < numItems && queue.length > 0) {
    const parentId = queue[0];
    const need = numItems - rows.length;
    const batch = await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, parentId, need + 1);
    const slice = batch.slice(0, need);
    rows.push(...slice);
    if (batch.length > need) {
      return { rows, cursor: JSON.stringify({ p, parentsDone, queue, pid: parentId, skip: slice.length } satisfies ReadParentCursor) };
    }
    queue = queue.slice(1);
  }

  if (queue.length === 0 && parentsDone) return { rows, cursor: null };
  return { rows, cursor: JSON.stringify({ p, parentsDone, queue, pid: null, skip: 0 } satisfies ReadParentCursor) };
}

// ---------------------------------------------------------------------------
// exportPage
// ---------------------------------------------------------------------------

export const exportPage = query({
  args: { table: EXPORT_TABLES, cursor: v.optional(v.string()) },
  returns: v.object({ rows: v.array(v.any()), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, { table, cursor }) => {
    const userId = await requireUserId(ctx); // throws for a deleting/deleted account (D77): exportPage never runs mid-purge.
    const spec = TABLE_SPECS[table];
    const cursorIn = cursor ?? null;

    if (spec.kind === "direct") {
      const page = await paginateByUser(ctx, table, spec.index, userId, cursorIn, EXPORT_PAGE);
      return { rows: page.page, cursor: page.isDone ? null : page.continueCursor };
    }

    if (spec.kind === "status") {
      // One status's page per call (never a second `.paginate()` here, the
      // platform's hard per-execution limit -- see `ParentCursor`'s
      // docstring above for the same constraint on the "parent" branch): a
      // status with fewer than `EXPORT_PAGE` remaining rows still just
      // advances `s` for the NEXT call rather than looking further here.
      const { s, c } = decodeStatusCursor(cursorIn);
      if (s >= PROCESSED_EVENT_STATUSES.length) return { rows: [], cursor: null };
      const page = await (ctx.db.query(spec.table) as any)
        .withIndex("by_user_status", (q: any) => q.eq("userId", userId).eq("status", PROCESSED_EVENT_STATUSES[s]))
        .paginate({ cursor: c, numItems: EXPORT_PAGE });
      if (!page.isDone) return { rows: page.page, cursor: JSON.stringify({ s, c: page.continueCursor }) };
      const nextS = s + 1;
      return { rows: page.page, cursor: nextS >= PROCESSED_EVENT_STATUSES.length ? null : JSON.stringify({ s: nextS, c: null }) };
    }

    return await readParentTable(ctx, spec, userId, cursorIn, EXPORT_PAGE);
  },
});

function decodeStatusCursor(raw: string | null): { s: number; c: string | null } {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<{ s: number; c: string | null }>;
      if (typeof parsed.s === "number" && Number.isInteger(parsed.s) && parsed.s >= 0) {
        return { s: parsed.s, c: typeof parsed.c === "string" ? parsed.c : null };
      }
    } catch {
      // Malformed/foreign cursor: restart from the first status.
    }
  }
  return { s: 0, c: null };
}

// ---------------------------------------------------------------------------
// Session revocation (see module docstring for the exported-name finding).
// ---------------------------------------------------------------------------

async function revokeAuthSessions(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
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
}

/** Same fixed copy as `lib/accountState.ts`'s `GATE_MESSAGES.deleted` (kept as a local literal rather than importing that module-private map). */
const MAIL_DELETED_MESSAGE = "This account is being deleted.";

/**
 * Cancels the user's in-flight outbound mail at deletion-request time, not
 * deferred to the (possibly much later) `mailLog` purge step: any row still
 * `queued` -- the component has an outboundId but `notify.reconcileDrop`
 * has not yet confirmed a message id -- is flipped to `suppressed`/`deleted`
 * immediately, in the SAME transaction as the tombstone write. No provider
 * call is made (the send already happened; nothing to cancel there) -- this
 * only retires Recoup's own bookkeeping row early and truthfully instead of
 * leaving it looking actionable while the account winds down. Bounded via
 * the existing `by_user_status` index; a user realistically has 0-1 rows in
 * this state at any moment, so `RETENTION_PAGE` is far more headroom than
 * ever needed (any pathological overflow is still cleaned up, unlabelled,
 * by the ordinary `mailLog` purge step later).
 */
async function suppressQueuedMail(ctx: MutationCtx, userId: Id<"users">, now: number): Promise<void> {
  const queued = await ctx.db
    .query("mailLog")
    .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "queued"))
    .take(RETENTION_PAGE);
  for (const row of queued) {
    await ctx.db.patch(row._id, { status: "suppressed", reason: "deleted", error: MAIL_DELETED_MESSAGE, lastCheckedAt: now });
  }
}

// ---------------------------------------------------------------------------
// requestDeletion
// ---------------------------------------------------------------------------

export const requestDeletion = mutation({
  args: { confirmation: v.string() },
  returns: v.null(),
  handler: async (ctx, { confirmation }) => {
    // Deliberately NOT `requireUserId`: that helper throws for an already-
    // tombstoned caller (D77's own choke point), which would turn a SECOND
    // `requestDeletion` call into an error instead of the contract's
    // required no-op. `userId` still comes from `ctx.auth` only, never an
    // argument -- the invariant ("deletion cannot target another user") is
    // unaffected.
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    if (confirmation !== CONFIRMATION_PHRASE) {
      throw new ConvexError(`Type "${CONFIRMATION_PHRASE}" to confirm.`);
    }

    const existing = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return null; // Idempotent: already deleting/deleted.

    // Captured now (see `purge`'s docstring): `profiles` is the last table
    // `purgeStep` drains, so this is the only point where reading it back is
    // guaranteed to still find the inbox id.
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    const now = Date.now();
    await ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: now, attempts: 0 });
    await revokeAuthSessions(ctx, userId);
    await suppressQueuedMail(ctx, userId, now);
    await ctx.scheduler.runAfter(0, internal.account.purge, { userId, inboxId: profile?.inboxId });
    return null;
  },
});

// ---------------------------------------------------------------------------
// purgeStep
// ---------------------------------------------------------------------------

type Progress = { table: string; cursor?: string };

/**
 * Deletes one row, first clearing any pending `mailEvent:<id>` stash entry
 * for it (D99 N7/F8: `mailEvents.onEvent` parks an event it cannot yet map
 * to a row under `opsState` key `mailEvent:<agentmailMessageId>` -- see
 * `convex/mailEvents.ts`. A `mailLog`/`drafts` row being purged is the row
 * that stash would eventually resolve against; once it is gone nothing ever
 * will, so any pending stash for its message id is deleted alongside it
 * instead of lingering for `RETENTION_STASH_DAYS`). Checked generically by
 * field presence rather than by table name so every call site -- direct,
 * via-parent, and status-iterated deletes alike -- gets the same cleanup
 * for free.
 */
async function deleteRow(ctx: MutationCtx, row: Doc<any>): Promise<void> {
  const messageId = (row as { agentmailMessageId?: unknown }).agentmailMessageId;
  if (typeof messageId === "string" && messageId) {
    const stash = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", `mailEvent:${messageId}`))
      .unique();
    if (stash) await ctx.db.delete(stash._id);
  }
  await ctx.db.delete(row._id);
}

/** Deletes up to `numItems` rows from a direct table's page, returning how many were removed. */
async function deleteDirectPage(ctx: MutationCtx, table: TableNames, index: string, userId: Id<"users">, cursor: string | null, numItems: number): Promise<{ deleted: number; isDone: boolean; continueCursor: string }> {
  const page = await paginateByUser(ctx, table, index, userId, cursor, numItems);
  for (const row of page.page) await deleteRow(ctx, row);
  return { deleted: page.page.length, isDone: page.isDone, continueCursor: page.continueCursor };
}

/**
 * Deletes up to `numItems` rows from a "via-parent" table's page (children
 * only -- the parent table is its own, later, step), same one-`.paginate()`-
 * call design as `readParentTable`, but simpler: a deleted row never comes
 * back, so resuming mid-parent needs no `skip` -- `.take(need + 1)` against
 * the same parent id on the next call naturally returns the next batch.
 */
async function drainParentTable(ctx: MutationCtx, spec: ParentSpec, userId: Id<"users">, cursorRaw: string | null, numItems: number): Promise<{ deleted: number; cursor: string | null }> {
  let { p, parentsDone, queue, pid } = decodeParentCursor(cursorRaw);
  let deleted = 0;

  async function drain(parentId: string, remaining: number): Promise<{ count: number; hasMore: boolean }> {
    const batch = await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, parentId, remaining + 1);
    const toDelete = batch.slice(0, remaining);
    for (const row of toDelete) await deleteRow(ctx, row);
    return { count: toDelete.length, hasMore: batch.length > remaining };
  }

  if (pid !== null) {
    const result = await drain(pid, numItems - deleted);
    deleted += result.count;
    if (result.hasMore) return { deleted, cursor: JSON.stringify({ p, parentsDone, queue, pid } satisfies ParentCursor) };
    pid = null;
  }

  ({ p, parentsDone, queue, pid } = await refillParentQueue(ctx, spec, userId, { p, parentsDone, queue, pid }));

  while (deleted < numItems && queue.length > 0) {
    const parentId = queue[0];
    const result = await drain(parentId, numItems - deleted);
    deleted += result.count;
    if (result.hasMore) return { deleted, cursor: JSON.stringify({ p, parentsDone, queue, pid: parentId } satisfies ParentCursor) };
    queue = queue.slice(1);
  }

  if (queue.length === 0 && parentsDone) return { deleted, cursor: null };
  return { deleted, cursor: JSON.stringify({ p, parentsDone, queue, pid: null } satisfies ParentCursor) };
}

/** One status's page per call (never more than one `.paginate()` call), so a status with fewer than `numItems` remaining rows still just advances to the next status on the FOLLOWING call rather than issuing a second `.paginate()` here. */
async function deleteStatusPage(ctx: MutationCtx, userId: Id<"users">, cursorRaw: string | null, numItems: number): Promise<{ deleted: number; cursor: string | null }> {
  const { s, c } = decodeStatusCursor(cursorRaw);
  if (s >= PROCESSED_EVENT_STATUSES.length) return { deleted: 0, cursor: null };
  const page = await (ctx.db.query("processedEvents") as any)
    .withIndex("by_user_status", (q: any) => q.eq("userId", userId).eq("status", PROCESSED_EVENT_STATUSES[s]))
    .paginate({ cursor: c, numItems });
  for (const row of page.page) await deleteRow(ctx, row);
  if (!page.isDone) return { deleted: page.page.length, cursor: JSON.stringify({ s, c: page.continueCursor }) };
  const nextS = s + 1;
  return { deleted: page.page.length, cursor: nextS >= PROCESSED_EVENT_STATUSES.length ? null : JSON.stringify({ s: nextS, c: null }) };
}

/**
 * One bounded, resumable page of the purge. Reads/writes `accountState
 * .progress` to track which of `PURGE_STEPS` is current and that table's own
 * pagination cursor; returns `{ done: true }` only once every step's table
 * is confirmed empty for this user (a table with zero matching rows still
 * counts as "processed" -- the step advances immediately on an empty page).
 */
export const purgeStep = internalMutation({
  args: { userId: v.id("users") },
  returns: v.object({ done: v.boolean() }),
  handler: async (ctx, { userId }) => {
    const stateRow = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!stateRow) return { done: true }; // No tombstone (already fully purged, or never requested): nothing to do.

    const progress: Progress = stateRow.progress ?? { table: PURGE_STEPS[0], cursor: undefined };
    let stepIndex = PURGE_STEPS.indexOf(progress.table as PurgeTable);
    if (stepIndex < 0) stepIndex = 0; // Unrecognized table (schema drift/foreign value): restart the cycle safely.
    const table = PURGE_STEPS[stepIndex];
    const spec = TABLE_SPECS[table];
    const cursorIn = progress.table === table ? (progress.cursor ?? null) : null;

    let stepDone: boolean;
    let nextCursor: string | null;
    if (spec.kind === "direct") {
      const result = await deleteDirectPage(ctx, table, spec.index, userId, cursorIn, RETENTION_PAGE);
      stepDone = result.isDone;
      nextCursor = result.isDone ? null : result.continueCursor;
    } else if (spec.kind === "status") {
      const result = await deleteStatusPage(ctx, userId, cursorIn, RETENTION_PAGE);
      stepDone = result.cursor === null;
      nextCursor = result.cursor;
    } else {
      const result = await drainParentTable(ctx, spec, userId, cursorIn, RETENTION_PAGE);
      stepDone = result.cursor === null;
      nextCursor = result.cursor;
    }

    const isLastStep = stepIndex === PURGE_STEPS.length - 1;
    const allDone = stepDone && isLastStep;
    const nextProgress: Progress = stepDone
      ? { table: PURGE_STEPS[isLastStep ? stepIndex : stepIndex + 1], cursor: undefined }
      : { table, cursor: nextCursor ?? undefined };

    await ctx.db.patch(stateRow._id, { progress: nextProgress });
    return { done: allDone };
  },
});

// ---------------------------------------------------------------------------
// purgeAuth
// ---------------------------------------------------------------------------

/**
 * Deletes the Convex Auth rows for `userId`, then the `users` row itself.
 * `accountState` is left in place (it is the tombstone). Covers every auth
 * table D87's reproduction report named except `authVerifiers`: that table
 * has no index on `userId` or `sessionId` (only `signature`), so it cannot
 * be swept without an unbounded table scan; Recoup mounts only the Password
 * provider (no OAuth), and `authVerifiers` exists solely for OAuth PKCE, so
 * in practice no row is ever created for any Recoup user -- recorded as a
 * known gap in the task report rather than silently skipped.
 */
export const purgeAuth = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);

    // Defensive re-sweep: sign-in itself is not gated on `isTombstoned` (only
    // app-level queries/mutations are, via `requireUserId`), so a session
    // could have been minted after `requestDeletion`'s own revoke.
    await revokeAuthSessions(ctx, userId);

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

      // D87: the Password provider's own failed-sign-in lockout
      // (`retrieveAccountWithCredentialsImpl`) keys `authRateLimits
      // .identifier` on the authAccounts row id, not the email.
      const byAccount = await ctx.db
        .query("authRateLimits")
        .withIndex("identifier", (q) => q.eq("identifier", account._id))
        .unique();
      if (byAccount) await ctx.db.delete(byAccount._id);

      await ctx.db.delete(account._id);
    }

    if (user?.email) {
      // D87: the email-verification/reset-code path (`verifyCodeAndSignIn
      // .ts`) keys the SAME table on the raw email value instead.
      const byEmail = await ctx.db
        .query("authRateLimits")
        .withIndex("identifier", (q) => q.eq("identifier", user.email as string))
        .unique();
      if (byEmail) await ctx.db.delete(byEmail._id);

      // D99 (N7): the E2E code-capture stash (`convex/lib/authMail.ts`'s
      // `recordE2ECode`, read back by `convex/testing.ts`'s `lastCodeFor`)
      // is keyed by email, not userId -- a dev/E2E-only row in practice
      // (`recordE2ECode` refuses unless `E2E_SEED_ENABLED=true`), but
      // cleaned up unconditionally since it is cheap and user-scoped.
      const codeRow = await ctx.db
        .query("opsState")
        .withIndex("by_key", (q) => q.eq("key", `e2e:code:${user.email}`))
        .unique();
      if (codeRow) await ctx.db.delete(codeRow._id);
    }

    if (user) await ctx.db.delete(userId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------

/** Backoff schedule for AgentMail inbox-deletion retries (contract, verbatim): 1m, 10m, 1h, 6h, 24h. File-local: this module does not own `limits.ts` (T18's file list is `account.ts`/`account.test.ts`/`lib/accountState.ts` only), mirroring T04's precedent of keeping a task-scoped constant local to its own file. */
const INBOX_DELETE_BACKOFF_MS = [60_000, 600_000, 3_600_000, 21_600_000, 86_400_000];
const INBOX_DELETE_MAX_ATTEMPTS = 5;
const DEFAULT_AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";

/**
 * The live DELETE call, mirroring `profiles.ts`'s `createInboxRemote` (same
 * base URL/bearer-auth convention, response body never echoed back -- it can
 * quote the request's own auth header). Exposed as an object method (not a
 * bare function) so tests can `vi.spyOn(inboxTransport, "deleteInbox")`,
 * the same seam `convex/lib/authMail.ts`'s `authMailTransport` and
 * `convex/mail.ts`'s `agentmail.sendMessage` already use in this codebase.
 */
export const inboxTransport = {
  async deleteInbox(inboxId: string): Promise<void> {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) throw new Error("AgentMail is not configured on this deployment");
    const baseUrl = (process.env.AGENTMAIL_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL).replace(/\/$/, "");
    const response = await fetch(`${baseUrl}/inboxes/${inboxId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok && response.status !== 404) {
      // 404 = already gone (a prior attempt's DELETE landed but the
      // response was lost, or there was never a profile/inbox at all):
      // treated as success. Never echo the body: it can quote the auth header.
      throw new Error(`AgentMail could not delete the inbox (${response.status})`);
    }
  },
};

/**
 * Drives the whole purge to completion: bounded/resumable app-data deletion,
 * then the AgentMail inbox (bounded retry/backoff, truthful on failure),
 * then the auth rows and the tombstone's final `deleted` status.
 *
 * `inboxId` is captured ONCE by `requestDeletion` (before anything is
 * deleted) and threaded through every reschedule of this action as an
 * explicit argument, rather than re-read from the `profiles` table here:
 * `profiles` is itself the LAST table `purgeStep` drains, so by the time
 * this function's app-data loop reports `done`, the profile row (and the
 * inbox id it carried) is already gone. Passing it along is what lets the
 * inbox still be deleted afterward.
 *
 * Never throws past the scheduler -- an inbox-deletion failure reschedules
 * itself instead, and the loop over `purgeStep` has no failure mode of its
 * own (a thrown mutation would simply fail the whole action and Convex
 * would not retry it, so any transient `purgeStep` error is left to surface
 * in the server log and be retried by re-running `purge`, the same
 * tolerance `market.lookup` gives its own internal steps).
 */
export const purge = internalAction({
  args: { userId: v.id("users"), inboxId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { userId, inboxId }) => {
    // Bounded: one action invocation cannot spin forever (platform execution
    // limits, and defense against an unforeseen non-converging cursor bug).
    // Real completion typically takes a handful of calls; if more remain
    // after this many, reschedule immediately and pick up from the
    // persisted `accountState.progress` cursor instead of looping longer.
    const MAX_STEPS_PER_RUN = 500;
    let done = false;
    for (let i = 0; i < MAX_STEPS_PER_RUN; i++) {
      const result = await ctx.runMutation(internal.account.purgeStep, { userId });
      if (result.done) {
        done = true;
        break;
      }
    }
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.account.purge, { userId, inboxId });
      return null;
    }

    try {
      if (inboxId) await inboxTransport.deleteInbox(inboxId);
    } catch (err) {
      const attempts = await ctx.runMutation(internal.account.recordPurgeFailure, {
        userId,
        error: sanitizeError(err instanceof Error ? err.message : String(err)),
      });
      if (attempts < INBOX_DELETE_MAX_ATTEMPTS) {
        const delay = INBOX_DELETE_BACKOFF_MS[Math.min(attempts - 1, INBOX_DELETE_BACKOFF_MS.length - 1)];
        await ctx.scheduler.runAfter(delay, internal.account.purge, { userId, inboxId });
      }
      // 5th failure: `recordPurgeFailure` already left status `deleting` /
      // `inboxDeleted: false` and stopped retrying -- truthful, not `deleted`.
      return null;
    }

    await ctx.runMutation(internal.account.purgeAuth, { userId });
    await ctx.runMutation(internal.account.finishPurge, { userId });
    return null;
  },
});

export const recordPurgeFailure = internalMutation({
  args: { userId: v.id("users"), error: v.string() },
  returns: v.number(),
  handler: async (ctx, { userId, error }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return INBOX_DELETE_MAX_ATTEMPTS; // Tombstone gone (shouldn't happen): stop retrying.
    const attempts = row.attempts + 1;
    await ctx.db.patch(row._id, { attempts, lastError: error, inboxDeleted: false });
    return attempts;
  },
});

export const finishPurge = internalMutation({
  args: { userId: v.id("users") },
  returns: v.null(),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return null;
    await ctx.db.patch(row._id, { status: "deleted", completedAt: Date.now(), inboxDeleted: true });
    return null;
  },
});

// ---------------------------------------------------------------------------
// deletionStatus
// ---------------------------------------------------------------------------

/**
 * Deliberately uses `getAuthUserId` (not `requireUserId`): this is read by a
 * still-open tab WHILE the account is tombstoned, so it must not throw for
 * the very state it exists to report.
 */
export const deletionStatus = query({
  args: {},
  returns: v.union(v.null(), v.object({ status: accountStateStatus, inboxDeleted: v.optional(v.boolean()), attempts: v.number() })),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return null; // Active account: no tombstone.
    return { status: row.status, inboxDeleted: row.inboxDeleted, attempts: row.attempts };
  },
});
