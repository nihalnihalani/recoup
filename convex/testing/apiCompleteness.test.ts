/**
 * M25 phase 1 (D250): offline completeness check for `convex/_generated/api.d.ts` -- no live `npx convex dev`/
 * codegen run, no network. The rule QA verified against git history (D251's D175-lapse note: 122 = 122 at `472ccc1`;
 * 122 vs 120 -- a real gap -- at `41e6b08`, closed the next commit): every `.ts` file under `convex/` whose BASENAME
 * has exactly one dot (excludes every `*.test.ts`, `*.setup.ts`, `*.kit.ts`, `*.loader.ts`, `*.d.ts` -- two dots each),
 * excluding `_generated/` and `schema.ts`, and INCLUDING `"use node"` files, must appear in `api.d.ts`'s
 * `import type * as <alias> from "../<path>.js";` list -- and `api.d.ts` must list no module that does not exist on
 * disk (a stale entry after a file was deleted or renamed, same D175 lapse in the other direction).
 *
 * A one-dot filename is exactly Convex's own module-naming convention for a file codegen turns into an `api`/
 * `internal` namespace; codegen includes every such file regardless of whether it exports a `query`/`mutation`/
 * `action` (so `lib/*` helper modules appear too, matching the real file below). Multi-dot names (tests and the
 * handful of `*.setup.ts`/`*.kit.ts`/`*.loader.ts` test-support files under `convex/testing/`) are excluded by the
 * SAME dot-count rule that a real `.test.ts` file is -- no separate path-based exclusion needed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./ruleFixtures.loader";

const CONVEX_ROOT = path.join(REPO_ROOT, "convex");
const API_DTS_PATH = path.join(CONVEX_ROOT, "_generated", "api.d.ts");

/**
 * Every `.ts` file under `convexRoot` whose basename has exactly one dot, as the module path `api.d.ts` would use
 * (relative to `convexRoot`, `/`-separated, no extension) -- e.g. `convex/lib/facts/keys_air.ts` -> `lib/facts/keys_air`.
 * `_generated/` and `schema.ts` are excluded per D250; `node_modules` is defensive (none exists under `convex/`).
 */
function singleDotConvexModules(convexRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "_generated" || name === "node_modules") continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      if ((name.match(/\./g) ?? []).length !== 1) continue; // excludes *.test.ts, *.setup.ts, *.kit.ts, *.loader.ts, *.d.ts
      const rel = path.relative(convexRoot, full).replace(/\\/g, "/").replace(/\.ts$/, "");
      if (rel === "schema") continue;
      out.push(rel);
    }
  };
  walk(convexRoot);
  return out.sort();
}

/** The module paths `api.d.ts` imports (`"../<path>.js"` -> `<path>`), from its `import type * as <alias> from "../<path>.js";` lines. */
function apiDtsModules(apiDtsSource: string): string[] {
  const re = /^import type \* as [A-Za-z0-9_]+ from "\.\.\/(.+)\.js";$/gm;
  return [...apiDtsSource.matchAll(re)].map((m) => m[1]!).sort();
}

describe("offline api.d.ts completeness (D250, QA-M25-1)", () => {
  const realModules = singleDotConvexModules(CONVEX_ROOT);
  const realApiDtsSource = readFileSync(API_DTS_PATH, "utf8");
  const realImports = apiDtsModules(realApiDtsSource);

  it("finds real single-dot modules to check (the walk itself works, and excludes schema/_generated/tests)", () => {
    expect(realModules.length).toBeGreaterThan(50); // ~124 at the time of writing; a generous floor, not a pin
    expect(realModules).not.toContain("schema");
    expect(realModules.some((m) => m.startsWith("_generated/"))).toBe(false);
    expect(realModules.some((m) => m.includes("testing/"))).toBe(false); // every convex/testing/ file is multi-dot
    // `"use node"` files are included, same as any other module (they still need a real api.d.ts entry).
    const evidenceExtractSrc = readFileSync(path.join(CONVEX_ROOT, "evidenceExtract.ts"), "utf8");
    expect(evidenceExtractSrc).toMatch(/^"use node";/m);
    expect(realModules).toContain("evidenceExtract");
  });

  it("passes on the REAL api.d.ts: every single-dot module is imported, and api.d.ts imports nothing else (D175 lapse, both directions)", () => {
    expect(realImports).toEqual(realModules);
  });

  it("FAILS (proof) when one import line is deleted from a scratch copy of api.d.ts's import list: a real module goes undetected", () => {
    // The exact D175-lapse shape (D251: 122 vs 120 at `41e6b08`) -- a module M22 added was missing from api.d.ts.
    const mutated = realImports.filter((_, i) => i !== 0); // delete one entry from a scratch COPY; the real file is untouched
    expect(mutated).toHaveLength(realImports.length - 1);
    const missing = realModules.filter((m) => !mutated.includes(m));
    expect(missing).toHaveLength(1); // this is what would have failed the check above, had it run against the mutated copy
    expect(mutated).not.toEqual(realModules);
  });

  it("FAILS (proof) when a scratch copy of api.d.ts's import list names a module that does not exist on disk (a stale entry)", () => {
    const mutated = [...realImports, "lib/a_module_that_was_deleted"].sort();
    const stale = mutated.filter((m) => !realModules.includes(m));
    expect(stale).toEqual(["lib/a_module_that_was_deleted"]);
    expect(mutated).not.toEqual(realModules);
  });

  it("the parser itself is exercised by a literal scratch api.d.ts source string, not only the real file", () => {
    const scratch = [
      "/* eslint-disable */",
      "import type * as account from \"../account.js\";",
      "import type * as lib_money from \"../lib/money.js\";",
      "",
      "export const api = {} as any;",
    ].join("\n");
    expect(apiDtsModules(scratch)).toEqual(["account", "lib/money"]);
  });
});
