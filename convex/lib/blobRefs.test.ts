/**
 * M14 (SEC-UP-7, DA-A-28(d)): the orphan sweep deletes every old `_storage`
 * blob that no REGISTERED field references, so an unregistered storage field
 * would lose its files. These tests walk `schema.tables` and fail on any
 * `v.id("_storage")` field, at any depth, that `BLOB_REFERENCES` does not
 * cover through a usable index.
 */
import { describe, expect, it } from "vitest";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import schema from "../schema";
import { BLOB_REFERENCES } from "./blobRefs";
import { chargeStoredBytes, releaseStoredBytes, storedBytes, STORED_BYTES_DAY, STORED_BYTES_KIND } from "./blobRefs";
import { setup, signedIn } from "../test.setup";
import { MAX_EVIDENCE_BYTES_PER_USER } from "../limits";

type AnyValidator = {
  kind: string;
  tableName?: string;
  fields?: Record<string, AnyValidator>;
  element?: AnyValidator;
  members?: AnyValidator[];
  key?: AnyValidator;
  value?: AnyValidator;
};
type TableDefs = Record<string, { validator: AnyValidator; " indexes"(): { indexDescriptor: string; fields: string[] }[] }>;

/** Every path under `validator` whose value is `v.id("_storage")`, e.g. `storageId` or `files[].blob`. */
function storagePaths(validator: AnyValidator, path = ""): string[] {
  switch (validator.kind) {
    case "id":
      return validator.tableName === "_storage" ? [path] : [];
    case "object":
      return Object.entries(validator.fields ?? {}).flatMap(([k, f]) => storagePaths(f, path ? `${path}.${k}` : k));
    case "array":
      return storagePaths(validator.element!, `${path}[]`);
    case "union":
      return (validator.members ?? []).flatMap((m) => storagePaths(m, path));
    case "record":
      return [...storagePaths(validator.key!, `${path}{key}`), ...storagePaths(validator.value!, `${path}{}`)];
    default:
      return [];
  }
}

function storageFieldsOf(tables: TableDefs): string[] {
  return Object.entries(tables).flatMap(([table, def]) => [...new Set(storagePaths(def.validator))].map((p) => `${table}.${p}`));
}

/** A registry entry covers `table.path` only if the index it names exists and is led by that field. */
function covered(tables: TableDefs, fieldRef: string): boolean {
  return BLOB_REFERENCES.some((ref) => {
    if (`${ref.table}.${ref.field}` !== fieldRef) return false;
    const index = tables[ref.table]?.[" indexes"]().find((i) => i.indexDescriptor === ref.index);
    return index?.fields[0] === ref.field;
  });
}

describe("lib/blobRefs — BLOB_REFERENCES covers every _storage field in the schema", () => {
  it("every v.id(\"_storage\") field in schema.ts, at any depth, is registered with an index led by that field", () => {
    const tables = schema.tables as unknown as TableDefs;
    const fields = storageFieldsOf(tables);
    expect(fields).toContain("evidence.storageId"); // the walker sees the one field that exists today
    expect(fields.filter((f) => !covered(tables, f))).toEqual([]);
  });

  it("every registry entry names a real storage field (no stale entries that would read as coverage)", () => {
    const tables = schema.tables as unknown as TableDefs;
    const fields = new Set(storageFieldsOf(tables));
    for (const ref of BLOB_REFERENCES) expect(fields.has(`${ref.table}.${ref.field}`), `${ref.table}.${ref.field}`).toBe(true);
  });

  it("the check is not vacuous: an unregistered storage field, nested or top-level, is reported", () => {
    const synthetic = defineSchema({
      evidence: defineTable({ storageId: v.optional(v.id("_storage")) }).index("by_storage", ["storageId"]),
      avatars: defineTable({ image: v.id("_storage") }).index("by_image", ["image"]),
      packets: defineTable({ files: v.array(v.object({ blob: v.id("_storage") })) }),
    });
    const tables = synthetic.tables as unknown as TableDefs;
    const uncovered = storageFieldsOf(tables).filter((f) => !covered(tables, f));
    expect(uncovered.sort()).toEqual(["avatars.image", "packets.files[].blob"]);
  });
});

describe("lib/blobRefs — lifetime stored-bytes counter (D173)", () => {
  it("chargeStoredBytes is all or nothing against MAX_EVIDENCE_BYTES_PER_USER", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const results = await t.run(async (ctx) => {
      const first = await chargeStoredBytes(ctx, userId, MAX_EVIDENCE_BYTES_PER_USER - 10);
      const over = await chargeStoredBytes(ctx, userId, 11); // one byte past the cap: refused, nothing written
      const afterRefusal = await storedBytes(ctx, userId);
      const exact = await chargeStoredBytes(ctx, userId, 10); // exactly to the cap: allowed
      return { first, over, afterRefusal, exact, final: await storedBytes(ctx, userId) };
    });
    expect(results).toEqual({ first: true, over: false, afterRefusal: MAX_EVIDENCE_BYTES_PER_USER - 10, exact: true, final: MAX_EVIDENCE_BYTES_PER_USER });
    const rows = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(rows).toEqual([expect.objectContaining({ userId, day: STORED_BYTES_DAY, kind: STORED_BYTES_KIND, count: MAX_EVIDENCE_BYTES_PER_USER })]);
  });

  it("releaseStoredBytes clamps at 0 and never creates a row; counters are per user", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const counts = await t.run(async (ctx) => {
      await releaseStoredBytes(ctx, a.userId, 500); // nothing counted yet: no row appears
      const noRow = (await ctx.db.query("usage").collect()).length;
      await chargeStoredBytes(ctx, a.userId, 300);
      await chargeStoredBytes(ctx, b.userId, 700);
      await releaseStoredBytes(ctx, a.userId, 1_000); // more than counted: clamps at 0
      return { noRow, a: await storedBytes(ctx, a.userId), b: await storedBytes(ctx, b.userId) };
    });
    expect(counts).toEqual({ noRow: 0, a: 0, b: 700 });
  });
});
