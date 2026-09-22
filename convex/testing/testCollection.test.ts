/**
 * M08 / QA-13 guard: no test file may silently fall outside the suite.
 *
 * QA-13 was a class of bug, not one file: `vitest.config.mts` only collected
 * `*.test.ts`, so a component test named `*.test.tsx` would never have run
 * and `npm run test:ci` (which counts only collected files) could not notice.
 * This test walks `convex/` and `src/`, finds every file that LOOKS like a
 * test (`*.test.*` / `*.spec.*`), and fails unless the `include` globs in
 * `vitest.config.mts` actually collect it. It also requires every
 * `*.test.tsx` to open with the per-file DOM docblock, because the suite
 * default environment (edge-runtime) has no `document`.
 *
 * The include list is read from the config source rather than by importing
 * the config (which would load Vite into a test worker). Only globs of the
 * form `<dir>/**\/*<suffix>` are understood; anything else fails with a
 * request to update this guard, so the guard can never pass vacuously.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_LIKE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const DOM_DOCBLOCK = /^\/\/ @vitest-environment happy-dom\s*$/;

type IncludeGlob = { pattern: string; dir: string; suffix: string };

function readIncludeGlobs(): IncludeGlob[] {
  const source = readFileSync(path.join(REPO_ROOT, "vitest.config.mts"), "utf8");
  const block = source.match(/\binclude:\s*\[([^\]]*)\]/);
  if (!block) throw new Error("vitest.config.mts: no `include: [...]` array found; update convex/testing/testCollection.test.ts");
  const patterns = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return patterns.map((pattern) => {
    const m = pattern.match(/^([A-Za-z0-9_./-]+)\/\*\*\/\*(\.[A-Za-z0-9.]+)$/);
    if (!m) throw new Error(`vitest.config.mts: include glob "${pattern}" is not of the form <dir>/**/*<suffix>; update convex/testing/testCollection.test.ts`);
    return { pattern, dir: m[1], suffix: m[2] };
  });
}

function listTestLikeFiles(root: string): string[] {
  const entries = readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: "utf8" });
  return entries
    .map((rel) => path.posix.join(root, rel.split(path.sep).join("/")))
    .filter((rel) => !rel.includes("/node_modules/") && !rel.includes("/_generated/"))
    .filter((rel) => TEST_LIKE.test(path.posix.basename(rel)));
}

function isCollected(rel: string, globs: IncludeGlob[]): boolean {
  return globs.some((g) => rel.startsWith(`${g.dir}/`) && rel.endsWith(g.suffix));
}

describe("test collection guard (M08, QA-13)", () => {
  const globs = readIncludeGlobs();
  const candidates = [...listTestLikeFiles("convex"), ...listTestLikeFiles("src")];

  it("reads a non-empty include list that covers *.test.tsx under src/", () => {
    expect(globs.length).toBeGreaterThan(0);
    expect(globs.map((g) => g.pattern)).toContain("src/**/*.test.tsx");
  });

  it("finds the suite's own test files (walker sanity check)", () => {
    expect(candidates).toContain("convex/testing/testCollection.test.ts");
    expect(candidates).toContain("src/test/dom.test.tsx");
  });

  it("every test-like file under convex/ and src/ is collected by vitest.config.mts", () => {
    const orphans = candidates.filter((rel) => !isCollected(rel, globs));
    expect(orphans, "these files look like tests but vitest.config.mts never collects them").toEqual([]);
  });

  it("every *.test.tsx opens with `// @vitest-environment happy-dom`", () => {
    const tsx = candidates.filter((rel) => rel.endsWith(".test.tsx"));
    expect(tsx.length).toBeGreaterThan(0);
    const missing = tsx.filter((rel) => {
      const firstLine = readFileSync(path.join(REPO_ROOT, rel), "utf8").split("\n", 1)[0];
      return !DOM_DOCBLOCK.test(firstLine);
    });
    expect(missing, "component tests must select the DOM environment on line 1").toEqual([]);
  });
});
