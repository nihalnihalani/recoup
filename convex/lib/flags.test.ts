/**
 * M1B: typed server feature flags (`lib/flags.ts`), contract §2.6 "Live
 * extraction (D145)" and §11.1 row M1B. Reads only; the one writer is the
 * internal `ops.setFlag` (tested in `convex/ops.test.ts`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { setup } from "../test.setup";
import {
  FLAGS,
  FLAG_NAMES,
  flagAuditKey,
  flagKey,
  flagNameValidator,
  isFlagOn,
  MAX_APPROVAL_REF_CHARS,
  normalizeApprovalRef,
  readFlag,
  type FlagName,
} from "./flags";

describe("flag registry", () => {
  it("registers live_document_extraction as an approval-gated flag (D145)", () => {
    expect(FLAG_NAMES).toContain("live_document_extraction");
    expect(FLAGS.live_document_extraction.requiresApproval).toBe(true);
  });

  it("the validator's literals are exactly FLAG_NAMES, so a flag cannot exist in one and not the other", () => {
    const literals = flagNameValidator.members.map((m) => m.value).sort();
    expect(literals).toEqual([...FLAG_NAMES].sort());
  });

  it("key builders are stable: flag:<name> and flagAudit:<name>:<10-digit seq> (sortable by seq)", () => {
    expect(flagKey("live_document_extraction")).toBe("flag:live_document_extraction");
    expect(flagAuditKey("live_document_extraction", 7)).toBe("flagAudit:live_document_extraction:0000000007");
    expect(flagAuditKey("live_document_extraction", 10) > flagAuditKey("live_document_extraction", 9)).toBe(true);
  });
});

describe("normalizeApprovalRef", () => {
  it("accepts a DECISIONS id, alone or followed by a note, trimmed", () => {
    expect(normalizeApprovalRef("D9001")).toBe("D9001");
    expect(normalizeApprovalRef("  D9001: user approved OpenAI document processing  ")).toBe(
      "D9001: user approved OpenAI document processing",
    );
  });

  it("refuses empty, whitespace-only, missing, and non-DECISIONS values", () => {
    for (const bad of [undefined, null, "", "   ", "yes", "approved", "d151", "D", "DX1", "151", "D9001x"]) {
      expect(normalizeApprovalRef(bad), String(bad)).toBeNull();
    }
  });

  it("refuses an over-long reference and one carrying control characters", () => {
    expect(normalizeApprovalRef(`D9001 ${"x".repeat(MAX_APPROVAL_REF_CHARS)}`)).toBeNull();
    expect(normalizeApprovalRef("D9001\nforged second line")).toBeNull();
  });
});

describe("readFlag / isFlagOn", () => {
  it("every flag defaults OFF on an empty deployment", async () => {
    const t = setup();
    for (const name of FLAG_NAMES) {
      expect(await t.run((ctx) => isFlagOn(ctx, name))).toBe(false);
      expect(await t.run((ctx) => readFlag(ctx, name))).toEqual({
        name,
        on: false,
        approvalRef: null,
        updatedAt: null,
        invalid: false,
      });
    }
  });

  it("reads a stored ON row with a valid approvalRef as on", async () => {
    const t = setup();
    await t.run((ctx) =>
      ctx.db.insert("opsState", {
        key: "flag:live_document_extraction",
        cursor: JSON.stringify({ on: true, approvalRef: "D9001" }),
        updatedAt: 1_000,
      }),
    );
    expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction"))).toBe(true);
    expect(await t.run((ctx) => readFlag(ctx, "live_document_extraction"))).toEqual({
      name: "live_document_extraction",
      on: true,
      approvalRef: "D9001",
      updatedAt: 1_000,
      invalid: false,
    });
  });

  it("fails closed: a hand-written ON row without a valid approvalRef stays OFF and is reported invalid", async () => {
    const t = setup();
    for (const cursor of [
      JSON.stringify({ on: true }),
      JSON.stringify({ on: true, approvalRef: "   " }),
      JSON.stringify({ on: true, approvalRef: "yes" }),
    ]) {
      await t.run(async (ctx) => {
        const row = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "flag:live_document_extraction")).first();
        if (row) await ctx.db.patch(row._id, { cursor });
        else await ctx.db.insert("opsState", { key: "flag:live_document_extraction", cursor, updatedAt: 1 });
      });
      expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction")), cursor).toBe(false);
      const state = await t.run((ctx) => readFlag(ctx, "live_document_extraction"));
      expect(state.on, cursor).toBe(false);
      expect(state.invalid, cursor).toBe(true);
    }
  });

  it("fails closed on a malformed or foreign cursor value", async () => {
    const t = setup();
    for (const cursor of ["not json", "true", JSON.stringify({ on: "yes", approvalRef: "D9001" }), undefined]) {
      await t.run(async (ctx) => {
        const row = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "flag:live_document_extraction")).first();
        if (row) await ctx.db.replace(row._id, { key: "flag:live_document_extraction", cursor, updatedAt: 1 });
        else await ctx.db.insert("opsState", { key: "flag:live_document_extraction", cursor, updatedAt: 1 });
      });
      expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction")), String(cursor)).toBe(false);
      expect((await t.run((ctx) => readFlag(ctx, "live_document_extraction"))).invalid, String(cursor)).toBe(true);
    }
  });

  it("a stored OFF row is off and valid", async () => {
    const t = setup();
    await t.run((ctx) =>
      ctx.db.insert("opsState", { key: "flag:live_document_extraction", cursor: JSON.stringify({ on: false, approvalRef: null }), updatedAt: 5 }),
    );
    expect(await t.run((ctx) => readFlag(ctx, "live_document_extraction"))).toEqual({
      name: "live_document_extraction",
      on: false,
      approvalRef: null,
      updatedAt: 5,
      invalid: false,
    });
  });

  it("an unknown flag name (only reachable through a cast) throws instead of silently reading OFF", async () => {
    const t = setup();
    await expect(t.run((ctx) => isFlagOn(ctx, "not_a_flag" as FlagName))).rejects.toThrow(/Unknown flag/);
  });
});

// ---------------------------------------------------------------------------
// Only ops.ts writes flag rows (the public API cannot set flags)
// ---------------------------------------------------------------------------

const CONVEX_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "_generated" || entry === "node_modules") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("single writer", () => {
  it("no non-test module other than lib/flags.ts and ops.ts builds a flag key or writes a flag:/flagAudit: row", () => {
    const allowed = new Set([path.join(CONVEX_DIR, "lib", "flags.ts"), path.join(CONVEX_DIR, "ops.ts")]);
    const offenders = sourceFiles(CONVEX_DIR)
      .filter((file) => !allowed.has(file))
      .filter((file) => /\bflagKey\s*\(|\bflagAuditKey\s*\(|["'`]flag(Audit)?:/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(CONVEX_DIR, file));
    expect(offenders).toEqual([]);
  });
});
