/// <reference types="vite/client" />
/**
 * P01-P12 re-audit, batch 2 (P11-W3 / P12-W11, F-T18.4-1; D244): `scripts/check-patch.mjs` (`npm run verify:patch`)
 * checked only one regex in the dist `convex.config.js` -- the deployed dist `lib.js` and `schema.js` hunks
 * (purgeInbox, purgeOutbound, the by_inbox indexes they scan by) that account deletion actually depends on
 * (`convex/mailPurge.ts`) were never verified. Reverting only those hunks passed `verify:patch` every time; this
 * was a manual step in docs/ops/RELEASE.md §2 for exactly that reason.
 *
 * The script is exercised as a real child process (its own file, unmodified) against constructed fixture trees --
 * not by importing/reimplementing its logic -- so this test proves the ACTUAL script fails closed, the same way a
 * reviewer running `npm run verify:patch` against a bad tree would see it fail. `CHECK_PATCH_ROOT` (an env var the
 * script reads only for this purpose; unset in every real invocation) points it at each fixture instead of this
 * repo's real, currently-correct `node_modules/`.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = path.join(repoRoot, "scripts/check-patch.mjs");

const GOOD_CONFIG = `export default { env: { AGENTMAIL_API_KEY: process.env.AGENTMAIL_API_KEY } };\n`;

const GOOD_LIB = [
  `export const createInbox = internalAction({ handler: async () => null });`,
  `export const cleanupFinalizedOutbound = mutation({ handler: async () => null });`,
  `export const purgeInbox = internalMutation({ handler: async () => null });`,
  `export const purgeOutbound = internalMutation({ handler: async () => null });`,
  ``,
].join("\n");

/** The pre-patch shape: same file, purgeInbox/purgeOutbound never added. */
const REVERTED_LIB = [
  `export const createInbox = internalAction({ handler: async () => null });`,
  `export const cleanupFinalizedOutbound = mutation({ handler: async () => null });`,
  ``,
].join("\n");

const GOOD_SCHEMA = [
  `export default defineSchema({`,
  `  inboundMessages: defineTable({ inboxId: v.string() })`,
  `    .index("by_status", ["status"])`,
  `    .index("by_inbox", ["inboxId"]),`,
  `  inboxes: defineTable({ inboxId: v.string() }).index("by_inboxId", ["inboxId"]),`,
  `  outboundMessages: defineTable({ inboxId: v.string() })`,
  `    .index("by_inbox", ["inboxId"])`,
  `    .index("by_thread", ["threadId"]),`,
  `  events: defineTable({ inboxId: v.string() })`,
  `    .index("by_message", ["messageId"])`,
  `    .index("by_inbox", ["inboxId"]),`,
  `});`,
  ``,
].join("\n");

/** The pre-patch shape: only inboundMessages' (pre-existing) by_inbox; outboundMessages/events never got theirs. */
const REVERTED_SCHEMA = [
  `export default defineSchema({`,
  `  inboundMessages: defineTable({ inboxId: v.string() })`,
  `    .index("by_status", ["status"])`,
  `    .index("by_inbox", ["inboxId"]),`,
  `  inboxes: defineTable({ inboxId: v.string() }).index("by_inboxId", ["inboxId"]),`,
  `  outboundMessages: defineTable({ inboxId: v.string() })`,
  `    .index("by_thread", ["threadId"]),`,
  `  events: defineTable({ inboxId: v.string() })`,
  `    .index("by_message", ["messageId"]),`,
  `});`,
  ``,
].join("\n");

/** Builds `<tmp>/node_modules/@agentmail/convex/{dist,src}/component/*` and returns the fixture root. */
function buildFixture(opts: { config?: string; libDist: string; libSrc: string; schemaDist: string; schemaSrc: string }): string {
  const root = mkdtempSync(path.join(tmpdir(), "check-patch-fixture-"));
  const dist = path.join(root, "node_modules/@agentmail/convex/dist/component");
  const src = path.join(root, "node_modules/@agentmail/convex/src/component");
  mkdirSync(dist, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(dist, "convex.config.js"), opts.config ?? GOOD_CONFIG);
  writeFileSync(path.join(dist, "lib.js"), opts.libDist);
  writeFileSync(path.join(src, "lib.ts"), opts.libSrc);
  writeFileSync(path.join(dist, "schema.js"), opts.schemaDist);
  writeFileSync(path.join(src, "schema.ts"), opts.schemaSrc);
  return root;
}

/** Runs the real script against `root`; never throws -- returns exit status and combined output instead. */
function runCheckPatch(root: string): { status: number; output: string } {
  try {
    const output = execFileSync("node", [SCRIPT], {
      env: { ...process.env, CHECK_PATCH_ROOT: root },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? 1, output: `${e.stdout}${e.stderr}` };
  }
}

describe("P11-W3 (+P12-W11): verify:patch also checks the purgeInbox/purgeOutbound/by_inbox dist hunks", () => {
  it("passes when lib.js and schema.js both have the full patch, matching their own src", () => {
    const root = buildFixture({ libDist: GOOD_LIB, libSrc: GOOD_LIB, schemaDist: GOOD_SCHEMA, schemaSrc: GOOD_SCHEMA });
    try {
      const { status, output } = runCheckPatch(root);
      expect(status).toBe(0);
      expect(output).toContain("purgeInbox and purgeOutbound");
      expect(output).toContain("3 by_inbox indexes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when dist lib.js is reverted (purgeInbox/purgeOutbound missing) even though convex.config.js is patched", () => {
    // This is exactly the case F-T18.4-1 names: today's script checks only convex.config.js, so a scratch copy with
    // ONLY the lib.js/schema.js hunks reverted passes `verify:patch` -- the bug this test proves is now fixed.
    const root = buildFixture({ libDist: REVERTED_LIB, libSrc: GOOD_LIB, schemaDist: GOOD_SCHEMA, schemaSrc: GOOD_SCHEMA });
    try {
      const { status, output } = runCheckPatch(root);
      expect(status).not.toBe(0);
      expect(output).toContain("purgeInbox");
      expect(output).toContain("purgeOutbound");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when dist schema.js is reverted (outboundMessages/events lost their by_inbox index)", () => {
    const root = buildFixture({ libDist: GOOD_LIB, libSrc: GOOD_LIB, schemaDist: REVERTED_SCHEMA, schemaSrc: GOOD_SCHEMA });
    try {
      const { status, output } = runCheckPatch(root);
      expect(status).not.toBe(0);
      expect(output).toContain("by_inbox");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when dist matches its OWN reverted src (parity alone cannot be satisfied by regressing both)", () => {
    // Defense in depth: the explicit minimum (purgeInbox/purgeOutbound present; >= 3 by_inbox) is checked
    // independently of dist/src parity, so a src file that also lost the hunks cannot make a bad dist pass.
    const root = buildFixture({ libDist: REVERTED_LIB, libSrc: REVERTED_LIB, schemaDist: REVERTED_SCHEMA, schemaSrc: REVERTED_SCHEMA });
    try {
      const { status, output } = runCheckPatch(root);
      expect(status).not.toBe(0);
      expect(output).toContain("purgeInbox");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("still fails closed on a missing/unpatched convex.config.js (pre-existing check, unchanged)", () => {
    const root = buildFixture({ config: "export default {};\n", libDist: GOOD_LIB, libSrc: GOOD_LIB, schemaDist: GOOD_SCHEMA, schemaSrc: GOOD_SCHEMA });
    try {
      const { status, output } = runCheckPatch(root);
      expect(status).not.toBe(0);
      expect(output).toContain("AGENTMAIL_API_KEY");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
