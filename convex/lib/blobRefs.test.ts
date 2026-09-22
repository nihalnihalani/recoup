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
