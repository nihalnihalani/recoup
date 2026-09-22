/**
 * M14 (SEC-UP-7, DA-A-28(d), contract rev 5 §2.6): the registry of every
 * application table field that references a `_storage` blob, the reference
 * check the orphan sweep uses, and (M14c, D173) the per-user lifetime
 * stored-bytes counter plus `releaseEvidenceBlob`, the one place an evidence
 * row gives up its blob.
 *
 * Why a registry: the daily orphan sweep (`retention.sweepOrphanBlobs`)
 * deletes every `_storage` blob older than `ORPHAN_BLOB_MIN_AGE_HOURS` that
 * no registered field references. A blob referenced by a field that is NOT
 * registered here would look like an orphan and be deleted. So any feature
 * that stores a blob must add its field here. `lib/blobRefs.test.ts` walks
 * `schema.tables` and fails if any `v.id("_storage")` field, at any depth, is
 * missing from `BLOB_REFERENCES`.
 *
 * Each entry names an index whose FIRST field is the storage field, so
 * "is this blob referenced?" is one indexed `.first()` per entry, never a
 * table scan. A storage id nested inside an array cannot be indexed that way.
 * A future feature that needs one must design its own lookup (e.g. a side
 * table), and the registry test forces that decision.
 *
 * The AgentMail and other components keep their own isolated file storage.
 * `ctx.db.system.query("_storage")` in the app sees only the app's blobs, so
 * component-held files are outside this registry by construction.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import { MAX_EVIDENCE_BYTES_PER_USER } from "../limits";

export type BlobReference = {
  /** The table holding the reference. */
  readonly table: TableNames;
  /** Top-level field of type `v.id("_storage")` (optional or required). */
  readonly field: string;
  /** An index on `table` whose first field is `field`. */
  readonly index: string;
};

export const BLOB_REFERENCES: readonly BlobReference[] = [
  // Uploads (M13 `finalizeUpload` binds it; unique through `by_storage`).
  { table: "evidence", field: "storageId", index: "by_storage" },
];

/** True if any registered field references `storageId`. One indexed `.first()` per registry entry. */
export async function isBlobReferenced(ctx: QueryCtx | MutationCtx, storageId: Id<"_storage">): Promise<boolean> {
  for (const ref of BLOB_REFERENCES) {
    // `ref.table`/`ref.index` are runtime strings, so the typed overloads cannot apply (the same
    // dynamic-table cast `account.ts`'s `paginateByUser` uses).
    const hit = await (ctx.db.query(ref.table) as any).withIndex(ref.index, (q: any) => q.eq(ref.field, storageId)).first();
    if (hit !== null) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lifetime stored-bytes counter (D173, M14c)
// ---------------------------------------------------------------------------

/**
 * Per-user bytes of evidence blobs currently stored, on one never-reset `usage` row
 * `{ userId, day: STORED_BYTES_DAY, kind: STORED_BYTES_KIND }` (the same "lifetime" shape as M13's
 * `evidence_rows` count). It enforces `MAX_EVIDENCE_BYTES_PER_USER`:
 *  - charged by `evidence.finalizeUpload` (M13) through `chargeStoredBytes`, for `_storage.size`, only when a blob
 *    is actually bound (a new row or a DA-A-20 revive; never a duplicate or a refusal);
 *  - released through `releaseEvidenceBlob` wherever a row loses its blob: retention's `clearEvidenceContent` and
 *    the account purge's `deleteEvidencePage`. The orphan sweep releases nothing, because an orphan was never
 *    bound and so never charged.
 * The account purge deletes the row itself with every other `usage` row.
 *
 * No backfill: evidence uploads are new in this mission and no deployment holds uploaded evidence from before the
 * counter existed, so every account starts correctly at 0 (D173).
 */
export const STORED_BYTES_DAY = "lifetime";
export const STORED_BYTES_KIND = "evidence_stored_bytes";

async function storedBytesRow(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<Doc<"usage"> | null> {
  return await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", STORED_BYTES_DAY).eq("kind", STORED_BYTES_KIND))
    .first();
}

/** The user's counted stored bytes (0 before the first charge). */
export async function storedBytes(ctx: QueryCtx | MutationCtx, userId: Id<"users">): Promise<number> {
  return (await storedBytesRow(ctx, userId))?.count ?? 0;
}

/**
 * Charges `bytes` against `MAX_EVIDENCE_BYTES_PER_USER`, all or nothing: returns false and writes nothing when the
 * charge would exceed the cap. For M13's `finalizeUpload`.
 */
export async function chargeStoredBytes(ctx: MutationCtx, userId: Id<"users">, bytes: number): Promise<boolean> {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error("chargeStoredBytes: bytes must be a finite, non-negative number");
  const row = await storedBytesRow(ctx, userId);
  const used = row?.count ?? 0;
  if (used + bytes > MAX_EVIDENCE_BYTES_PER_USER) return false;
  if (row) await ctx.db.patch(row._id, { count: used + bytes });
  else await ctx.db.insert("usage", { userId, day: STORED_BYTES_DAY, kind: STORED_BYTES_KIND, count: bytes });
  return true;
}

/** Releases `bytes`, clamped at 0. Never creates the row: with nothing counted there is nothing to release. */
export async function releaseStoredBytes(ctx: MutationCtx, userId: Id<"users">, bytes: number): Promise<void> {
  if (!Number.isFinite(bytes) || bytes <= 0) return;
  const row = await storedBytesRow(ctx, userId);
  if (!row || row.count === 0) return;
  await ctx.db.patch(row._id, { count: Math.max(0, row.count - bytes) });
}

/**
 * The one place an evidence row gives up its blob. It deletes the blob if it is still present, and releases the
 * bytes `finalizeUpload` charged for it (`sizeBytes`, recorded from `_storage.size`; the live `_storage` size if
 * that field is somehow missing). The CALLER must, in this same mutation, clear the row's `storageId` or delete the
 * row. The release is keyed on that transition, not on whether the blob physically existed. A retried call finds
 * the row without a `storageId` (or gone) and never reaches this function again, so bytes are never released twice.
 */
export async function releaseEvidenceBlob(ctx: MutationCtx, row: Doc<"evidence">): Promise<void> {
  if (!row.storageId) return;
  const meta = await ctx.db.system.get("_storage", row.storageId);
  if (meta !== null) await ctx.storage.delete(row.storageId);
  await releaseStoredBytes(ctx, row.userId, row.sizeBytes ?? meta?.size ?? 0);
}
