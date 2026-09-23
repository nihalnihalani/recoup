#!/usr/bin/env node
// T17 (P11): verify that patches/@agentmail+convex+0.1.0.patch was actually
// applied to node_modules. Wired as `npm run verify:patch`, and run in CI
// right after `npm ci` (which runs postinstall -> `patch-package
// --error-on-fail`).
//
// Why this exists: docs/team/VERIFICATION.md records that patch-package had
// silently NOT been applied in this tree until it was rerun by hand ("T01
// (sonnet-backend) + lead re-run ... found: patch-package had not been
// applied in this tree (`npx patch-package` reran) -> P11/T17 must gate on
// it"). `postinstall` running patch-package is not sufficient proof by
// itself -- e.g. `npm install <pkg>` reinstalling @agentmail/convex,
// `--ignore-scripts`, or a stale node_modules cache can all leave the patch
// unapplied without any install step failing. This script inspects the
// actual patched file on disk instead of trusting that postinstall ran.
//
// The patch (patches/@agentmail+convex+0.1.0.patch) adds:
//  1. An `env` block declaring AGENTMAIL_API_KEY to the agentmail Convex
//     component definition, fixing a real production crash
//     ("AGENTMAIL_API_KEY is not set", commit 59a9df4) caused by the
//     component's isolated runtime not seeing the env var without it.
//  2. P11-W3 (+P12-W11, F-T18.4-1, D119/D115 6b-5): `purgeInbox` and
//     `purgeOutbound` (account-deletion mail purging, dist `lib.js`) and the
//     `by_inbox` indexes they scan by (dist `schema.js`, on
//     inboundMessages/outboundMessages/events). Until this fix, this script
//     checked ONLY (1) -- `convex.config.js`'s `env` block -- even though
//     account deletion depends on (2) too (`convex/mailPurge.ts`). Reverting
//     only the `lib.js`/`schema.js` hunks (leaving `convex.config.js` alone)
//     passed `verify:patch` every time; docs/ops/RELEASE.md §2 has carried a
//     MANUAL grep for this since D119 for exactly that reason. This check
//     replaces that manual step.
//
// (2)'s check compares the deployed dist files against the patch's own src
// files (also shipped in the npm package, also patched): every `export
// const <name>` in `src/component/lib.ts` must also appear, in the same
// order, in `dist/component/lib.js`; every index name in
// `src/component/schema.ts` must appear, in the same order, in
// `dist/component/schema.js`. This is deliberately NOT a hardcoded list of
// names -- it fails on ANY dist/src drift the patch introduces, present or
// future, not just the two names D119 happened to add. A literal minimum
// (both purge exports; at least 3 `by_inbox` indexes) is asserted
// separately, so a src file that itself regressed cannot silently satisfy
// parity with a dist file that lost the same hunks.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Overridable for tests only (a fixture tree with its own node_modules/), so
// this script's own logic runs unmodified against constructed dist/src
// pairs instead of the real, currently-correct install. Unset in every real
// invocation (`npm run verify:patch`, CI): defaults to this script's own
// repo.
const repoRoot = process.env.CHECK_PATCH_ROOT
  ? path.resolve(process.env.CHECK_PATCH_ROOT)
  : path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const COMPONENT_DIST = path.join(repoRoot, "node_modules/@agentmail/convex/dist/component");
const COMPONENT_SRC = path.join(repoRoot, "node_modules/@agentmail/convex/src/component");

const CONFIG_TARGET = path.join(COMPONENT_DIST, "convex.config.js");
const LIB_DIST = path.join(COMPONENT_DIST, "lib.js");
const LIB_SRC = path.join(COMPONENT_SRC, "lib.ts");
const SCHEMA_DIST = path.join(COMPONENT_DIST, "schema.js");
const SCHEMA_SRC = path.join(COMPONENT_SRC, "schema.ts");

// Matches `env: { AGENTMAIL_API_KEY` allowing for whitespace/formatting
// differences between patch-package versions and package re-publishes.
const PATCH_PATTERN = /env\s*:\s*\{\s*AGENTMAIL_API_KEY\b/;

function fail(message) {
  console.error(`[verify:patch] FAILED - ${message}`);
  process.exit(1);
}

function rel(target) {
  return path.relative(repoRoot, target);
}

function readOrFail(target, hint) {
  if (!existsSync(target)) {
    fail(`${rel(target)} does not exist. ${hint}`);
  }
  return readFileSync(target, "utf8");
}

// ---------------------------------------------------------------------------
// 1. convex.config.js: AGENTMAIL_API_KEY env declaration.
// ---------------------------------------------------------------------------

const configContents = readOrFail(
  CONFIG_TARGET,
  "Run `npm ci` (full install, with scripts) so postinstall can run patch-package.",
);

if (!PATCH_PATTERN.test(configContents)) {
  fail(
    `${rel(CONFIG_TARGET)} is missing the "env: { AGENTMAIL_API_KEY" declaration from patches/@agentmail+convex+0.1.0.patch.\n` +
      "patch-package did not apply (or a later install reverted it). Run `npx patch-package --error-on-fail` and re-check.",
  );
}

console.log(`[verify:patch] OK - ${rel(CONFIG_TARGET)} has the AGENTMAIL_API_KEY env declaration.`);

// ---------------------------------------------------------------------------
// 2. lib.js: purgeInbox / purgeOutbound (P11-W3 / P12-W11 / F-T18.4-1).
// ---------------------------------------------------------------------------

/** `export const <name>` declarations, in file order. Matches both the compiled dist .js and the shipped src .ts (same shape). */
function exportedConstNames(source) {
  return [...source.matchAll(/^export const (\w+)/gm)].map((m) => m[1]);
}

const libDistContents = readOrFail(
  LIB_DIST,
  "Run `npm ci` (full install, with scripts) so postinstall can run patch-package.",
);
const libDistExports = exportedConstNames(libDistContents);

const REQUIRED_LIB_EXPORTS = ["purgeInbox", "purgeOutbound"];
const missingLibExports = REQUIRED_LIB_EXPORTS.filter((name) => !libDistExports.includes(name));
if (missingLibExports.length > 0) {
  fail(
    `${rel(LIB_DIST)} is missing ${missingLibExports.map((n) => `"export const ${n}"`).join(" and ")} from patches/@agentmail+convex+0.1.0.patch ` +
      "(T18.4/D115 6b-5, account-deletion mail purging -- convex/mailPurge.ts calls these).\n" +
      "patch-package did not apply (or a later install reverted it). Run `npx patch-package --error-on-fail` and re-check.",
  );
}

// Dist/src parity: every export src declares must survive into dist, in the same order -- not just the two names
// above. `src/component/lib.ts` ships in the npm package alongside `dist/`; if it is missing, the install itself is
// broken (fail closed rather than silently skip the parity half of this check).
if (existsSync(LIB_SRC)) {
  const libSrcExports = exportedConstNames(readFileSync(LIB_SRC, "utf8"));
  if (libSrcExports.join(",") !== libDistExports.join(",")) {
    const missing = libSrcExports.filter((n) => !libDistExports.includes(n));
    fail(
      `${rel(LIB_DIST)}'s exports do not match ${rel(LIB_SRC)}'s (dist: [${libDistExports.join(", ")}]; src: [${libSrcExports.join(", ")}]).` +
        (missing.length > 0 ? ` Missing from dist: ${missing.join(", ")}.` : " Order or membership differs.") +
        "\npatch-package did not apply the full patch (or a later install reverted part of it). Run `npx patch-package --error-on-fail` and re-check.",
    );
  }
} else {
  fail(`${rel(LIB_SRC)} does not exist. Run \`npm ci\` (full install, with scripts) so the @agentmail/convex package's src/ ships alongside dist/.`);
}

console.log(`[verify:patch] OK - ${rel(LIB_DIST)} has purgeInbox and purgeOutbound, matching ${rel(LIB_SRC)}.`);

// ---------------------------------------------------------------------------
// 3. schema.js: by_inbox indexes (P11-W3 / P12-W11 / F-T18.4-1).
// ---------------------------------------------------------------------------

/** `.index("name", ...)` declarations, in file order (name only; matches both dist .js and src .ts). */
function indexNames(source) {
  return [...source.matchAll(/\.index\(\s*["'`](\w+)["'`]/g)].map((m) => m[1]);
}

const schemaDistContents = readOrFail(
  SCHEMA_DIST,
  "Run `npm ci` (full install, with scripts) so postinstall can run patch-package.",
);
const schemaDistIndexes = indexNames(schemaDistContents);
const byInboxCount = schemaDistIndexes.filter((n) => n === "by_inbox").length;

if (byInboxCount < 3) {
  fail(
    `${rel(SCHEMA_DIST)} has only ${byInboxCount} "by_inbox" index declaration(s); patches/@agentmail+convex+0.1.0.patch puts one on each of ` +
      "inboundMessages, outboundMessages and events (>= 3 expected; a 4th, unrelated `by_inboxId` index on a different table is not part of this count).\n" +
      "patch-package did not apply (or a later install reverted it). Run `npx patch-package --error-on-fail` and re-check.",
  );
}

if (existsSync(SCHEMA_SRC)) {
  const schemaSrcIndexes = indexNames(readFileSync(SCHEMA_SRC, "utf8"));
  if (schemaSrcIndexes.join(",") !== schemaDistIndexes.join(",")) {
    fail(
      `${rel(SCHEMA_DIST)}'s indexes do not match ${rel(SCHEMA_SRC)}'s (dist: [${schemaDistIndexes.join(", ")}]; src: [${schemaSrcIndexes.join(", ")}]).\n` +
        "patch-package did not apply the full patch (or a later install reverted part of it). Run `npx patch-package --error-on-fail` and re-check.",
    );
  }
} else {
  fail(`${rel(SCHEMA_SRC)} does not exist. Run \`npm ci\` (full install, with scripts) so the @agentmail/convex package's src/ ships alongside dist/.`);
}

console.log(`[verify:patch] OK - ${rel(SCHEMA_DIST)} has ${byInboxCount} by_inbox indexes, matching ${rel(SCHEMA_SRC)}.`);
