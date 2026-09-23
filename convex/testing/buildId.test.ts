// @vitest-environment node
/**
 * F6 regression (fe2 review, P12-W6): scripts/buildId.mjs's env-override and no-git fallback paths, unit-tested
 * with an injected `run` instead of a real Vite build or a real git checkout. On origin/main (a1e636f), this logic
 * lived only inline in vite.config.ts with no test at all, so a broken fallback (e.g. a CI tarball with no `.git`
 * throwing past the try/catch) shipped a build with no `recoup-build` meta tag and no way to tell. Placed under
 * convex/testing/, matching checkRulePacks.test.ts's precedent for testing a root scripts/*.mjs file.
 */
import { describe, expect, it } from "vitest";
import { buildId } from "../../scripts/buildId.mjs";

describe("buildId", () => {
  it("RECOUP_BUILD_ID, when set, wins over git entirely", () => {
    const run = () => {
      throw new Error("run must not be called when RECOUP_BUILD_ID is set");
    };
    expect(buildId({ RECOUP_BUILD_ID: "release-42" }, run)).toBe("release-42");
  });

  it("a blank RECOUP_BUILD_ID (whitespace only) falls through to git, not an empty id", () => {
    const calls: string[] = [];
    const run = (cmd: string) => {
      calls.push(cmd);
      return cmd.includes("rev-parse") ? "abc123def456" : "";
    };
    expect(buildId({ RECOUP_BUILD_ID: "   " }, run)).toBe("abc123def456");
    expect(calls.length).toBe(2);
  });

  it("a clean tree returns the bare short SHA", () => {
    const run = (cmd: string) => (cmd.includes("rev-parse") ? "abc123def456" : "");
    expect(buildId({}, run)).toBe("abc123def456");
  });

  it("a dirty tree (porcelain status has output) appends -dirty", () => {
    const run = (cmd: string) => (cmd.includes("rev-parse") ? "abc123def456" : " M src/App.tsx");
    expect(buildId({}, run)).toBe("abc123def456-dirty");
  });

  it("no git available (CI tarball with no .git) falls back to 'unknown', not a thrown error", () => {
    const run = () => {
      throw new Error("spawn git ENOENT");
    };
    expect(buildId({}, run)).toBe("unknown");
  });
});
