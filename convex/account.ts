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
 *     until every owned row is gone, then attempts the AgentMail inbox
 *     delete over REST (bounded retry/backoff), then calls `purgeAuth`
 *     (internalMutation) to remove the Convex Auth rows and the `users` row
 *     itself REGARDLESS of whether the inbox delete ever succeeded (6b-4b,
 *     D115: auth rows are not provider-dependent, and leaving them forever
 *     just because a third-party DELETE call keeps failing is its own bug --
 *     see `purge`'s own docstring for the exact `deleting`/`deleted`/
 *     `inboxDeleted` semantics this produces), then marks the tombstone
 *     `deleted`. `accountState` itself is never deleted -- it IS the
 *     tombstone (D77).
 *  3. `purgeStep` deletes at most `RETENTION_PAGE` rows from ONE table per
 *     call (a smaller, byte-budgeted `PROCESSED_EVENTS_PAGE` for
 *     `processedEvents` specifically -- 6b-6, D115: see the module's
 *     "byte-aware paging" note below), in the contract's fixed
 *     child-before-parent order, storing its position in
 *     `accountState.progress` so a crash/redeploy mid-purge resumes exactly
 *     where it left off (same resumable-cursor shape as `retention.ts`'s
 *     `sweep`, reused here per instruction).
 *  4. `reDriveStuckDeletions` (internalMutation, cron-driven, 6b-4c/D115)
 *     re-schedules `purge` for any `deleting` row whose chain died (no live
 *     `_scheduled_functions` job) more than `STUCK_DELETION_AGE_MS` ago --
 *     the failure mode `beforeSessionCreation` (see `convex/auth.ts`) alone
 *     cannot fix: blocking sign-in stops a zombie account from being used,
 *     but does nothing to actually finish deleting it.
 *
 * Sign-in itself is gated on the tombstone too (6b-4a, D115): `convex/auth.ts`'s
 * `callbacks.beforeSessionCreation` throws the same error a wrong password
 * gets for any `deleting` or `deleted` user, closing the gap where every
 * app-level query/mutation refused a tombstoned caller (via
 * `requireUserId`) but a fresh sign-in itself did not.
 *
 * `exportPage` is the read side: one table's rows, 200 at a time (25 for
 * `processedEvents`), always scoped to the caller's own id (never accepted
 * as an argument) via a `by_user`-family index, or -- for the handful of
 * tables that carry a `userId` field but no index on it -- by iterating the
 * user's own parent rows (also index-scoped) and reading each parent's
 * children. It refuses once deletion has started: a paged export racing a
 * purge could otherwise observe a table that is only partially gone.
 *
 * **Cursor trust (6b-1, D115):** `exportPage`'s `cursor` argument is a plain
 * client-supplied string with no signature -- a caller can hand-craft any
 * JSON they like. For the "direct" and "status" table kinds this is
 * harmless (the cursor only ever resumes a `.paginate()` call that is
 * ITSELF re-scoped to `userId` on every call). For the "via-parent" kind,
 * though, the decoded cursor's `queue`/`pid` are parent-table ids read
 * directly by `takeByField` with NO ownership check of their own -- so
 * without a guard, a forged cursor naming another user's `claims`/`items`/
 * `watches`/`offers` id would read that user's `ledgerEvents`/`drafts`/
 * `priceChecks`/etc. straight through (an IDOR, not merely a bug). Every
 * parent id taken from the cursor is therefore re-verified with
 * `isOwnedParent` before its children are ever read; an unowned or
 * nonexistent id is dropped silently and advances the cursor exactly the
 * way an exhausted OWNED parent with zero children would, so the response
 * shape never becomes an existence oracle for another user's rows. Child
 * rows are additionally filtered by `userId` as defense in depth. The same
 * check is applied to `purgeStep`'s delete-side twin (`drainParentTable`)
 * even though its cursor is never client-supplied (`purgeStep` takes only
 * `{ userId }`; its cursor lives server-side in `accountState.progress`) --
 * cheap insurance, and it happens to also fix a structural bug (6b-2,
 * D115): the original code left an in-progress parent's id sitting in
 * `queue[0]` even after it was promoted to `pid`, so once that parent's
 * children were exhausted, `queue` was never advanced past it and the very
 * same parent was re-entered from the queue on the next call. On the
 * read side (`exportPage`) that produced duplicate rows and a cursor that
 * never reached `null` for any parent with more than one page of children;
 * on the delete side it was merely a single wasted re-read (a deleted row
 * never comes back), which is why only the read side counted as a bug.
 *
 * **Byte-aware paging (6b-6, D115):** `processedEvents` rows can each hold
 * up to `inbound.ts`'s `MAX_TEXT_CHARS` (60,000) characters of mail text;
 * at worst-case multibyte UTF-8 (~3 bytes/char) 200 rows -- the page size
 * every other table uses -- can read ~36 MB in one `.paginate()` call,
 * comfortably over Convex's 16 MiB per-transaction read limit, so both
 * `exportPage` and `purgeStep` would throw deterministically (and purge
 * would stall on this table forever) the moment a user's mail happened to
 * be CJK or similarly multibyte. Both call sites use the smaller,
 * budget-derived `PROCESSED_EVENTS_PAGE` (see `limits.ts`) for this one
 * table instead of `EXPORT_PAGE`/`RETENTION_PAGE`. Convex allows only a
 * single `.paginate()` call per function execution (documented in detail
 * below, on `ParentCursor`), so the page size has to be chosen up front --
 * there is no way to start a `.paginate()` call and abort it partway
 * through once a running byte estimate crosses the budget.
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
 * `requestDeletion` and `purgeAuth` -- through some path other than the
 * guarded `signIn`, which is now ALSO gated on the tombstone directly via
 * `convex/auth.ts`'s `callbacks.beforeSessionCreation`, 6b-4a/D115 -- would
 * otherwise survive purge).
 */
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { accountStateStatus } from "./schema";
import { requireUserId } from "./lib/access";
import { sanitizeError } from "./lib/errors";
import { rateLimiter } from "./lib/rateLimits";
import { RETENTION_PAGE, PROCESSED_EVENTS_PAGE, STUCK_DELETION_AGE_MS, STUCK_DELETION_REDRIVE_PAGE } from "./limits";

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
 * 6b-1 (D115): true only if `id` names a row that actually exists in
 * `table` AND is owned by `userId`. Every parent id a "via-parent"
 * read/delete takes off a resumable cursor (`queue[i]`/`pid`) must pass
 * this before its children are read -- see the module docstring's "Cursor
 * trust" note for why (`exportPage`'s cursor is a client-supplied string
 * with no signature; the child-table reads below it are scoped only by
 * parent id, not by owner). A malformed/foreign id string (wrong table,
 * garbage encoding) is treated the same as "not found", not as an error --
 * a forged cursor must never behave observably differently from one naming
 * a real, unowned row, or the difference becomes an existence oracle.
 */
async function isOwnedParent(ctx: QueryCtx | MutationCtx, table: TableNames, id: string, userId: Id<"users">): Promise<boolean> {
  try {
    // Same dynamic-table-name cast `paginateByUser`/`takeByField` above already use: `table` is a
    // runtime union of literal table names, not the single literal `ctx.db.get`'s overload wants.
    const doc: Doc<any> | null = await (ctx.db as any).get(table, id);
    return doc !== null && (doc as { userId?: Id<"users"> }).userId === userId;
  } catch {
    return false;
  }
}

/**
 * Read-only walk of a "via-parent" table, `numItems` rows at a time,
 * resumable via `cursorRaw`. `purgeStep`'s `drainParentTable` below is the
 * delete-and-resume twin (simpler: deleting a row is itself the "advance"
 * step, so it needs no `skip`).
 *
 * 6b-1/6b-2 (D115): `queue[0]` is popped the moment this function commits to
 * reading it (whether that read finishes in this call or spills into `pid`
 * for the next one) -- `pid` and `queue` are therefore always disjoint. The
 * previous shape left a parent's id sitting in BOTH `pid` and `queue[0]`
 * while it was being drained across multiple calls, so once that parent's
 * children were exhausted (`pid` cleared) the very same id was still at
 * `queue[0]` and got re-entered from scratch by the loop below -- the
 * "never terminates for a parent with > `numItems` children" bug (6b-2):
 * every subsequent call re-read the same parent's children from the start,
 * returning duplicates forever and never advancing the cursor to `null`.
 */
async function readParentTable(ctx: QueryCtx, spec: ParentSpec, userId: Id<"users">, cursorRaw: string | null, numItems: number): Promise<{ rows: Doc<any>[]; cursor: string | null }> {
  let { p, parentsDone, queue, pid, skip } = decodeReadParentCursor(cursorRaw);
  const rows: Doc<any>[] = [];

  // Resume a parent a previous call stopped partway through. `pid` is never
  // also present in `queue` (see this function's docstring), so there is
  // nothing to pop here -- just verify ownership before reading again.
  if (pid !== null) {
    if (await isOwnedParent(ctx, spec.parentTable, pid, userId)) {
      const need = numItems - rows.length;
      const batch = (await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, pid, skip + need + 1))
        .filter((row) => (row as { userId?: Id<"users"> }).userId === userId);
      const slice = batch.slice(skip, skip + need);
      rows.push(...slice);
      if (batch.length > skip + need) {
        return { rows, cursor: JSON.stringify({ p, parentsDone, queue, pid, skip: skip + slice.length } satisfies ReadParentCursor) };
      }
    }
    // Exhausted, OR the id was unowned/nonexistent (6b-1: treated identically -- zero children either way): advance past it.
    pid = null;
    skip = 0;
  }

  ({ p, parentsDone, queue, pid } = await refillParentQueue(ctx, spec, userId, { p, parentsDone, queue, pid }));

  while (rows.length < numItems && queue.length > 0) {
    const parentId = queue[0];
    queue = queue.slice(1); // 6b-2: pop before reading, so a parent spanning multiple calls is never re-entered via the queue.
    if (!(await isOwnedParent(ctx, spec.parentTable, parentId, userId))) continue; // 6b-1: forged/foreign id -- silently zero children.
    const need = numItems - rows.length;
    const batch = (await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, parentId, need + 1))
      .filter((row) => (row as { userId?: Id<"users"> }).userId === userId);
    const slice = batch.slice(0, need);
    rows.push(...slice);
    if (batch.length > need) {
      return { rows, cursor: JSON.stringify({ p, parentsDone, queue, pid: parentId, skip: slice.length } satisfies ReadParentCursor) };
    }
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
      // status with fewer than `PROCESSED_EVENTS_PAGE` remaining rows still
      // just advances `s` for the NEXT call rather than looking further
      // here. `PROCESSED_EVENTS_PAGE` (25), not `EXPORT_PAGE` (200): 6b-6,
      // D115 -- see the module docstring's "Byte-aware paging" note.
      const { s, c } = decodeStatusCursor(cursorIn);
      if (s >= PROCESSED_EVENT_STATUSES.length) return { rows: [], cursor: null };
      const page = await (ctx.db.query(spec.table) as any)
        .withIndex("by_user_status", (q: any) => q.eq("userId", userId).eq("status", PROCESSED_EVENT_STATUSES[s]))
        .paginate({ cursor: c, numItems: PROCESSED_EVENTS_PAGE });
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
    // guaranteed to still find the inbox id. Persisted on the tombstone row
    // itself (`inboxId`, 6b-4c/D115), not only threaded as a `purge` action
    // argument, so a later re-drive (`reDriveStuckDeletions`) can recover it
    // even after the app-data purge (and `profiles` with it) is long gone.
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    const now = Date.now();
    const stateId = await ctx.db.insert("accountState", {
      userId, status: "deleting", requestedAt: now, attempts: 0, inboxId: profile?.inboxId,
    });
    await revokeAuthSessions(ctx, userId);
    await suppressQueuedMail(ctx, userId, now);
    const jobId = await ctx.scheduler.runAfter(0, internal.account.purge, { userId });
    // 6b-4c (D115): recorded so `reDriveStuckDeletions` can tell this chain
    // is (still) alive with one indexed `ctx.db.system.get` instead of an
    // unbounded scan of `_scheduled_functions`.
    await ctx.db.patch(stateId, { activePurgeJobId: jobId });
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
 *
 * 6b-1/6b-2 (D115): mirrors `readParentTable`'s fix -- `queue[0]` is popped
 * before it is drained (never left sitting in both `pid` and `queue[0]`),
 * and every parent id is ownership-checked via `isOwnedParent` before its
 * children are read. Neither defect was exploitable here (`purgeStep`'s
 * cursor lives server-side in `accountState.progress`, never accepted from
 * a caller), but the queue/pid overlap did cost one wasted re-read per
 * multi-page parent (a deleted row simply returns nothing the second time,
 * so it was never an infinite loop the way `readParentTable`'s was) --
 * fixed as the same shared shape for both functions, and the ownership
 * check is cheap insurance against this cursor ever becoming
 * caller-influenced in the future.
 */
async function drainParentTable(ctx: MutationCtx, spec: ParentSpec, userId: Id<"users">, cursorRaw: string | null, numItems: number): Promise<{ deleted: number; cursor: string | null }> {
  let { p, parentsDone, queue, pid } = decodeParentCursor(cursorRaw);
  let deleted = 0;

  async function drain(parentId: string, remaining: number): Promise<{ count: number; hasMore: boolean }> {
    const batch = (await takeByField(ctx, spec.childTable, spec.childIndex, spec.childField, parentId, remaining + 1))
      .filter((row) => (row as { userId?: Id<"users"> }).userId === userId);
    const toDelete = batch.slice(0, remaining);
    for (const row of toDelete) await deleteRow(ctx, row);
    return { count: toDelete.length, hasMore: batch.length > remaining };
  }

  if (pid !== null) {
    if (await isOwnedParent(ctx, spec.parentTable, pid, userId)) {
      const result = await drain(pid, numItems - deleted);
      deleted += result.count;
      if (result.hasMore) return { deleted, cursor: JSON.stringify({ p, parentsDone, queue, pid } satisfies ParentCursor) };
    }
    pid = null;
  }

  ({ p, parentsDone, queue, pid } = await refillParentQueue(ctx, spec, userId, { p, parentsDone, queue, pid }));

  while (deleted < numItems && queue.length > 0) {
    const parentId = queue[0];
    queue = queue.slice(1); // 6b-2: pop before draining, matching `readParentTable`.
    if (!(await isOwnedParent(ctx, spec.parentTable, parentId, userId))) continue; // 6b-1: forged/foreign id -- nothing to delete.
    const result = await drain(parentId, numItems - deleted);
    deleted += result.count;
    if (result.hasMore) return { deleted, cursor: JSON.stringify({ p, parentsDone, queue, pid: parentId } satisfies ParentCursor) };
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
      // PROCESSED_EVENTS_PAGE (25), not RETENTION_PAGE (200): 6b-6, D115 -- see the module docstring's "Byte-aware paging" note.
      const result = await deleteStatusPage(ctx, userId, cursorIn, PROCESSED_EVENTS_PAGE);
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

    // Defensive re-sweep: even though sign-in is now ALSO gated on the
    // tombstone directly (6b-4a, D115: `convex/auth.ts`'s
    // `callbacks.beforeSessionCreation`), that gate runs in the library's
    // OWN mutation, a different code path than this one -- kept here too in
    // case a session is ever minted through some other route this app does
    // not control (or before that gate existed, for whatever tombstone rows
    // predate the deploy that added it).
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

      // LOW (D115, checkpoint 6b): our OWN named rate limits (distinct from
      // the library's `authRateLimits` table above) are also keyed by this
      // email and otherwise persist forever -- e.g. blocking a legitimate
      // future re-signup at the same address with a stale `authSignUp`
      // bucket from the deleted account's own history. `authMailGlobal`/
      // `authSignUpGlobal` are deployment-wide, not per-email, and stay
      // untouched.
      await rateLimiter.reset(ctx, "authAttempt", { key: user.email });
      await rateLimiter.reset(ctx, "authSignUp", { key: user.email });
      await rateLimiter.reset(ctx, "authMailPerEmail", { key: user.email });

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

/** Backoff schedule for AgentMail inbox-deletion retries (contract, verbatim): 1m, 10m, 1h, 6h, 24h. File-local (not `limits.ts`): task-scoped, mirroring T04's precedent of keeping a task-scoped constant local to its own file. */
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

/** `purge` action-ctx helper: records the just-armed retry/resume job on the tombstone row, so a stuck-chain check needs no scan (6b-4c, D115). No-op if the tombstone is already gone. */
export const setActivePurgeJob = internalMutation({
  args: { userId: v.id("users"), jobId: v.id("_scheduled_functions") },
  returns: v.null(),
  handler: async (ctx, { userId, jobId }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (row) await ctx.db.patch(row._id, { activePurgeJobId: jobId });
    return null;
  },
});

/** `purge` action-ctx helper: the durably-stored `inboxId` for this tombstone (see `requestDeletion`'s comment on why it lives on the row, not only threaded as an argument). `null` if the tombstone itself is gone. */
export const getPurgeContext = internalQuery({
  args: { userId: v.id("users") },
  returns: v.union(v.null(), v.object({ inboxId: v.optional(v.string()) })),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return null;
    return { inboxId: row.inboxId };
  },
});

/**
 * Drives the whole purge to completion: bounded/resumable app-data deletion,
 * then the AgentMail inbox (bounded retry/backoff, truthful on failure),
 * then the auth rows and the tombstone's final status.
 *
 * **`deleting`/`deleted`/`inboxDeleted` semantics (6b-4b, D115 -- the exact
 * contract, decided and documented here as instructed):**
 *  - While the app-data purge (`purgeStep` loop below) is still running, or
 *    while an inbox-delete retry remains (`attempts < INBOX_DELETE_MAX_ATTEMPTS`),
 *    the row stays `status: "deleting"`, `inboxDeleted: false` (or unset).
 *    The auth rows and `users` row are NOT yet touched: the retry chain is
 *    still alive and might still succeed.
 *  - On a successful inbox delete (or when there was never an inbox to
 *    delete): `purgeAuth` runs, then `status: "deleted"`, `inboxDeleted: true`.
 *  - On the FINAL failed attempt (`attempts === INBOX_DELETE_MAX_ATTEMPTS`,
 *    i.e. the retry chain is now dead): `purgeAuth` STILL runs -- auth rows
 *    are not provider-dependent, and the previous behaviour (leave the
 *    tombstone `deleting` forever, auth rows intact) was exactly checkpoint
 *    6b's F2b finding, a permanent zombie account reachable by sign-in
 *    despite `requestDeletion` having been called. `status` becomes
 *    `"deleted"` and `inboxDeleted` STAYS `false` -- `"deleted"` here means
 *    "Recoup's side is fully gone", not "the provider confirmed the
 *    mailbox is gone too"; `inboxDeleted` is the only field that answers
 *    the second question, and it is never set `true` unless the DELETE
 *    call actually returned success or 404. `lastError` (already
 *    sanitized by `recordPurgeFailure`, never the raw provider body) is
 *    left on the row as the reason. `deletionStatus`'s own docstring below
 *    repeats this for the client-facing reader.
 *
 * `inboxId` is captured ONCE by `requestDeletion` and persisted on the
 * `accountState` row itself (`getPurgeContext`) rather than only threaded as
 * an argument through every reschedule of this action: `profiles` is itself
 * the LAST table `purgeStep` drains, so by the time this function's
 * app-data loop reports `done`, the profile row (and the inbox id it
 * carried) is already gone -- and a `reDriveStuckDeletions` re-drive
 * (6b-4c) may be resuming a chain whose own in-flight scheduled call, with
 * whatever argument it carried, was lost entirely. `inboxId` stays as an
 * OPTIONAL argument only for backward compatibility with an existing direct
 * caller (`lifecycle.test.ts`, T21-owned, out of scope for this task to
 * edit) that still passes it; the handler always prefers the persisted
 * value and falls back to the argument only if the row somehow has none
 * (should not happen for any tombstone created after this change).
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
  handler: async (ctx, { userId, inboxId: argInboxId }) => {
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
      const jobId = await ctx.scheduler.runAfter(0, internal.account.purge, { userId });
      await ctx.runMutation(internal.account.setActivePurgeJob, { userId, jobId });
      return null;
    }

    const context = await ctx.runQuery(internal.account.getPurgeContext, { userId });
    if (!context) return null; // Tombstone gone (shouldn't happen -- `accountState` is never deleted): nothing left to do.
    const inboxId = context.inboxId ?? argInboxId; // Prefer the durably-persisted value; the argument is only a backward-compat fallback (see this function's own docstring).

    let inboxDeleted = true; // No inbox to delete (never provisioned one) counts as vacuously deleted, same as before 6b-4b.
    if (inboxId) {
      try {
        await inboxTransport.deleteInbox(inboxId);
      } catch (err) {
        const attempts = await ctx.runMutation(internal.account.recordPurgeFailure, {
          userId,
          error: sanitizeError(err instanceof Error ? err.message : String(err)),
        });
        if (attempts < INBOX_DELETE_MAX_ATTEMPTS) {
          const delay = INBOX_DELETE_BACKOFF_MS[Math.min(attempts - 1, INBOX_DELETE_BACKOFF_MS.length - 1)];
          const jobId = await ctx.scheduler.runAfter(delay, internal.account.purge, { userId });
          await ctx.runMutation(internal.account.setActivePurgeJob, { userId, jobId });
          // Retry chain still alive: status stays "deleting"; purgeAuth NOT run yet (6b-4b).
          return null;
        }
        // 6b-4b (D115): retry chain exhausted -- fall through to purgeAuth/finishPurge
        // below anyway (auth rows are not provider-dependent), but truthfully
        // record that the inbox itself was never confirmed deleted.
        inboxDeleted = false;
      }

      // T18.4 (D115 6b-5), wired here per that module's own "Call site"
      // note: drains the AgentMail component's own per-inbox rows
      // (`inboundMessages`/`outboundMessages`/`events`), which the REST
      // delete above never touches -- an independent system from the
      // remote inbox resource, so this runs regardless of that REST call's
      // outcome (including a retry that will run again later: the
      // component purge is idempotent, so re-invoking it on a later retry
      // just reports `{ complete: true, deleted: 0 }`).
      const mailResult = await ctx.runAction(internal.mailPurge.purgeInboxData, { inboxId });
      await ctx.runMutation(internal.account.recordMailDataPurged, { userId, complete: mailResult.complete });
    }

    await ctx.runMutation(internal.account.purgeAuth, { userId });
    await ctx.runMutation(internal.account.finishPurge, { userId, inboxDeleted });
    return null;
  },
});

/**
 * T18.4 (D115 6b-5): records whether `mailPurge.purgeInboxData` fully
 * drained the AgentMail component's own rows for this user's inbox.
 * `complete: false` is stored and surfaced exactly as reported -- never
 * silently coerced to `true` -- so an operator (via `deletionStatus`) can
 * tell a genuinely finished purge from one whose component-side cleanup is
 * still incomplete, the same truthfulness `inboxDeleted` already gives the
 * REST-side delete.
 */
export const recordMailDataPurged = internalMutation({
  args: { userId: v.id("users"), complete: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { userId, complete }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (row) await ctx.db.patch(row._id, { mailDataPurged: complete });
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
  args: { userId: v.id("users"), inboxDeleted: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { userId, inboxDeleted }) => {
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return null;
    // `activePurgeJobId: undefined` clears the pointer: nothing is scheduled
    // for this row anymore, so `reDriveStuckDeletions` must not act on it --
    // it already won't (that cron only ever looks at `status: "deleting"`
    // rows, and this row is now `"deleted"`), but clearing it too keeps the
    // field truthful rather than pointing at a long-finished job.
    await ctx.db.patch(row._id, { status: "deleted", completedAt: Date.now(), inboxDeleted, activePurgeJobId: undefined });
    return null;
  },
});

// ---------------------------------------------------------------------------
// reDriveStuckDeletions (6b-4c, D115)
// ---------------------------------------------------------------------------

/** True if `jobId` names a `_scheduled_functions` row that is still `pending` or `inProgress`. `undefined`/a vanished row means no live job. */
async function hasLiveJob(ctx: QueryCtx | MutationCtx, jobId: Id<"_scheduled_functions"> | undefined): Promise<boolean> {
  if (!jobId) return false;
  const job = await ctx.db.system.get("_scheduled_functions", jobId);
  return job !== null && (job.state.kind === "pending" || job.state.kind === "inProgress");
}

/** `deleting` rows one `stuckDeletions`/`reDriveStuckDeletions` call ever inspects: generous headroom over `STUCK_DELETION_REDRIVE_PAGE` since not every scanned row is old enough or actually stuck, but still a bounded, indexed (`by_status`) read rather than an unbounded scan. */
const STUCK_SCAN_CAP = 200;

/**
 * Ops-facing count of tombstones whose purge chain appears dead: `deleting`
 * for more than `STUCK_DELETION_AGE_MS` with no live scheduled `purge` job.
 * Read-only counterpart to `reDriveStuckDeletions` below (D115: "stuck rows
 * surfaced via an internal query" -- wired into `ops.backlog` after T24b,
 * per that lane's own file, not this one).
 */
export const stuckDeletions = internalQuery({
  args: {},
  returns: v.object({ stuck: v.number(), deleting: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("accountState")
      .withIndex("by_status", (q) => q.eq("status", "deleting"))
      .take(STUCK_SCAN_CAP);
    let stuck = 0;
    for (const row of rows) {
      if (now - row.requestedAt < STUCK_DELETION_AGE_MS) continue;
      if (!(await hasLiveJob(ctx, row.activePurgeJobId))) stuck++;
    }
    return { stuck, deleting: rows.length };
  },
});

/**
 * Daily cron-driven re-drive (`convex/crons.ts`): reschedules `purge` for
 * every `deleting` row that is both older than `STUCK_DELETION_AGE_MS` AND
 * has no live scheduled `purge` job (`activePurgeJobId` missing, or naming a
 * `_scheduled_functions` row that is no longer `pending`/`inProgress` --
 * e.g. a process crash between `recordPurgeFailure` and the retry's own
 * `ctx.scheduler.runAfter` call, or between the app-data purge loop's
 * `MAX_STEPS_PER_RUN` reschedule and ITS `setActivePurgeJob` call). Bounded
 * to `STUCK_DELETION_REDRIVE_PAGE` reschedules per run (contract-fixed) so
 * a bad day cannot flood the scheduler. A row with a genuinely live chain is
 * never double-scheduled: `hasLiveJob` is checked for every candidate before
 * rescheduling.
 */
export const reDriveStuckDeletions = internalMutation({
  args: {},
  returns: v.object({ rescheduled: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db
      .query("accountState")
      .withIndex("by_status", (q) => q.eq("status", "deleting"))
      .take(STUCK_SCAN_CAP);
    let rescheduled = 0;
    for (const row of rows) {
      if (rescheduled >= STUCK_DELETION_REDRIVE_PAGE) break;
      if (now - row.requestedAt < STUCK_DELETION_AGE_MS) continue;
      if (await hasLiveJob(ctx, row.activePurgeJobId)) continue; // A live chain is not double-scheduled.
      const jobId = await ctx.scheduler.runAfter(0, internal.account.purge, { userId: row.userId });
      await ctx.db.patch(row._id, { activePurgeJobId: jobId });
      rescheduled++;
    }
    return { rescheduled };
  },
});

// ---------------------------------------------------------------------------
// deletionStatus
// ---------------------------------------------------------------------------

/**
 * Deliberately uses `getAuthUserId` (not `requireUserId`): this is read by a
 * still-open tab WHILE the account is tombstoned, so it must not throw for
 * the very state it exists to report. (An already-open tab's JWT keeps
 * validating for the rest of its own lifetime even after `requestDeletion`
 * revokes the underlying session row; 6b-4a's `beforeSessionCreation` gate
 * only blocks a brand-NEW sign-in, so this read stays reachable exactly
 * when it needs to be.)
 *
 * `inboxDeleted` must be read literally, not inferred from `status`
 * (6b-4b, D115): `status: "deleted"` means Recoup's own side (app data +
 * auth rows) is fully gone, which now happens even when the AgentMail
 * inbox delete permanently failed after its retry budget -- that case is
 * reported as `status: "deleted", inboxDeleted: false`, never silently
 * rounded up to `true`. See `purge`'s own docstring for the full state
 * table.
 */
export const deletionStatus = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      status: accountStateStatus,
      inboxDeleted: v.optional(v.boolean()),
      // T18.4 (D115 6b-5): reported literally, same truthfulness rule as `inboxDeleted` above -- never coerced to `true`.
      mailDataPurged: v.optional(v.boolean()),
      attempts: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const row = await ctx.db
      .query("accountState")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (!row) return null; // Active account: no tombstone.
    return { status: row.status, inboxDeleted: row.inboxDeleted, mailDataPurged: row.mailDataPurged, attempts: row.attempts };
  },
});
