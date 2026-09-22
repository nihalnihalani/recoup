/**
 * M14 (SEC-UP-7, DA-A-28(d), contract rev 5 §2.6): the registry of every
 * application table field that references a `_storage` blob, plus the two
 * helpers every blob-deleting path shares.
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
import type { Id, TableNames } from "../_generated/dataModel";

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

/**
 * Deletes the blob if it still exists and reports whether it did. A missing
 * blob is not an error. It is the state a crash between "blob deleted" and
 * "row deleted/patched" leaves behind (SEC-DEL-2), and `ctx.storage.delete`
 * on a missing id throws, so every caller that re-runs after such a crash
 * must go through this check to converge.
 */
export async function deleteBlobIfPresent(ctx: MutationCtx, storageId: Id<"_storage">): Promise<boolean> {
  const meta = await ctx.db.system.get("_storage", storageId);
  if (meta === null) return false;
  await ctx.storage.delete(storageId);
  return true;
}
