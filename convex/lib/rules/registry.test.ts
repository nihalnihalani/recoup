/**
 * DA-A-11 / D145 (c): the production registry returns only packs `activation.ts` marks active (last entry wins); the
 * test registry is importable only from `*.test.ts`; the engine modules stay pure (no ctx, clock, randomness or
 * `lib/ai`, contract §4 grep test).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../testing/ruleFixtures.loader";
import { ACTIVATIONS, type Activation } from "./activation";
import { VERIFICATION } from "./verification";
import { r01PriceAdjustmentV1 } from "./r01_price_adjustment_v1";
import * as prod from "./registry";

const R01: Activation = { ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "D999" };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (name === "_generated" || name === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => path.relative(REPO_ROOT, f).split(path.sep).join("/");

describe("production registry (DA-A-11)", () => {
  it("returns only activation.ts actives — with no activation, nothing evaluates in production", () => {
    const expected = prod.resolveActivePacks(ACTIVATIONS, prod.IMPLEMENTED_PACKS);
    expect(prod.activePacks()).toEqual(expected);
    expect(prod.REGISTRY_KIND).toBe("production");
    if (ACTIVATIONS.length === 0) {
      expect(prod.activePacks()).toEqual([]);
      expect(prod.activePack("R01")).toBeNull();
      expect(prod.activePacksForCategory("retail_order")).toEqual([]);
      expect(prod.isPackActive(R01.ruleId, 1)).toBe(false);
    }
  });

  it("an activation entry activates exactly that (ruleId, version); the LAST entry for it wins", () => {
    expect(prod.resolveActivePacks([R01], prod.IMPLEMENTED_PACKS)).toEqual([r01PriceAdjustmentV1]);
    expect(prod.resolveActivePacks([R01, { ...R01, status: "withdrawn", decision: "D1000" }], prod.IMPLEMENTED_PACKS)).toEqual([]);
    expect(prod.resolveActivePacks([{ ...R01, status: "withdrawn" }, R01], prod.IMPLEMENTED_PACKS)).toEqual([r01PriceAdjustmentV1]);
    expect(prod.resolveActivePacks([{ ...R01, version: 2 }], prod.IMPLEMENTED_PACKS)).toEqual([]);
    expect(prod.resolveActivePacks([{ ...R01, ruleId: "R01.other" }], prod.IMPLEMENTED_PACKS)).toEqual([]);
  });

  it("activation.ts and verification.ts are lead-owned DATA: no imports, literal initializers", () => {
    for (const f of ["activation.ts", "verification.ts"]) {
      const src = readFileSync(path.join(REPO_ROOT, "convex/lib/rules", f), "utf8");
      expect(src).not.toMatch(/^\s*import\s/m);
      expect(src).not.toMatch(/\.\.\.|\bfunction\b|=>/);
    }
    expect(Array.isArray(ACTIVATIONS)).toBe(true);
    expect(typeof VERIFICATION).toBe("object");
  });
});

describe("module boundaries (grep tests)", () => {
  const files = walk(path.join(REPO_ROOT, "convex"));

  it("testRegistry is imported only by *.test.ts files (named, dynamic or bare side-effect imports)", () => {
    const offenders = files
      .filter((f) => !f.endsWith(".test.ts") && !f.endsWith("testRegistry.ts"))
      .filter((f) => {
        const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        // `import … from "…testRegistry"`, a dynamic `import("…testRegistry")`, and a bare side-effect
        // `import "…testRegistry"` (DA-B-4) all count.
        return /from\s+["'][^"']*testRegistry["']|import\(\s*["'][^"']*testRegistry["']\s*\)|\bimport\s+["'][^"']*testRegistry["']/.test(code);
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("rule and deadline modules are pure: no lib/ai, no ctx, no wall clock, no randomness", () => {
    const pure = files.filter((f) => /convex\/lib\/(rules|deadlines)\/[^/]+\.ts$/.test(rel(f)) && !f.endsWith(".test.ts"));
    expect(pure.length).toBeGreaterThanOrEqual(12);
    for (const f of pure) {
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(src, rel(f)).not.toMatch(/lib\/ai["']|from\s+["']\.\.\/ai["']/);
      expect(src, rel(f)).not.toMatch(/Date\.now\(|new Date\(\s*\)|Math\.random|performance\.now/);
      expect(src, rel(f)).not.toMatch(/_generated\/server|\bctx\./);
    }
  });
});
