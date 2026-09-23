// @vitest-environment node
/**
 * QA2-1 (P10-OW-12b re-review): a static guard pinning the split between the main Playwright config (every
 * spec REQUIRES `RECOUP_PROVIDER_MODE=stub`, `e2e/global-setup.ts`) and the live-provider smoke suite
 * (`e2e/smoke/live-provider.spec.ts`, which REQUIRES the opposite). The first version of this fix ran the smoke
 * spec under the main config, whose `globalSetup` refused it outright -- unable to execute under either
 * provider mode. This file reads the actual config/setup SOURCE (not just today's behavior) so a future edit
 * that re-merges the two configs, or points `playwright.smoke.config.ts` back at the stub-requiring
 * `globalSetup`, fails a fast, no-Playwright-install-needed unit test instead of silently reintroducing QA2-1.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

describe("QA2-1: the main e2e config and the live-provider smoke config never both cover one spec", () => {
  it("playwright.config.ts excludes e2e/smoke/** (testIgnore) and still requires stub mode (globalSetup) for everything it does cover", () => {
    const main = read("playwright.config.ts");
    expect(main).toMatch(/testIgnore:\s*["']smoke\/\*\*["']/);
    expect(main).toMatch(/globalSetup:\s*["']\.\/e2e\/global-setup\.ts["']/);
    // The main testDir is still e2e/ as a whole -- testIgnore is what carves smoke/ back out, not a narrower
    // testDir/testMatch that would silently stop covering some OTHER future e2e/ subdirectory too.
    expect(main).toMatch(/testDir:\s*["']\.\/e2e["']/);
  });

  it("playwright.smoke.config.ts exists, is scoped to e2e/smoke only, and does NOT require stub mode", () => {
    const smoke = read("playwright.smoke.config.ts");
    expect(smoke).toMatch(/testDir:\s*["']\.\/e2e\/smoke["']/);
    // The defining fix: no ACTUAL `globalSetup:` config property in the object this file exports (prose
    // mentioning the word or the path, e.g. a comment explaining the absence, is fine and expected here).
    expect(smoke).not.toMatch(/^\s*globalSetup\s*:/m);
  });

  it("e2e/global-setup.ts (the main suite's gate) has no RECOUP_LIVE_SMOKE (or similar) bypass of its stub-mode refusal", () => {
    const setup = read("e2e/global-setup.ts");
    // It must still throw for a non-"stub" mode unconditionally -- no `if (process.env.RECOUP_LIVE_SMOKE...)`
    // escape hatch that would let the live-smoke spec sneak through the main config's own gate instead of using
    // its dedicated one.
    expect(setup).toMatch(/mode\s*!==\s*["']stub["']/);
    expect(setup).not.toMatch(/RECOUP_LIVE_SMOKE/);
  });

  it("e2e/smoke/live-provider.spec.ts still refuses to run against a deployment reporting stub mode (belt and suspenders even without the main config's globalSetup)", () => {
    const spec = read("e2e/smoke/live-provider.spec.ts");
    expect(spec).toMatch(/mode\s*===\s*["']stub["']/);
  });
});
