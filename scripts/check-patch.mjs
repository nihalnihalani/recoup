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
// The patch (patches/@agentmail+convex+0.1.0.patch) adds an `env` block
// declaring AGENTMAIL_API_KEY to the agentmail Convex component definition,
// fixing a real production crash ("AGENTMAIL_API_KEY is not set", commit
// 59a9df4) caused by the component's isolated runtime not seeing the env
// var without it.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TARGET = path.join(
  repoRoot,
  "node_modules/@agentmail/convex/dist/component/convex.config.js",
);

// Matches `env: { AGENTMAIL_API_KEY` allowing for whitespace/formatting
// differences between patch-package versions and package re-publishes.
const PATCH_PATTERN = /env\s*:\s*\{\s*AGENTMAIL_API_KEY\b/;

function fail(message) {
  console.error(`[verify:patch] FAILED - ${message}`);
  process.exit(1);
}

if (!existsSync(TARGET)) {
  fail(
    `${path.relative(repoRoot, TARGET)} does not exist. Run \`npm ci\` (full install, with scripts) so postinstall can run patch-package.`,
  );
}

const contents = readFileSync(TARGET, "utf8");

if (!PATCH_PATTERN.test(contents)) {
  fail(
    `${path.relative(repoRoot, TARGET)} is missing the "env: { AGENTMAIL_API_KEY" declaration from patches/@agentmail+convex+0.1.0.patch.\n` +
      "patch-package did not apply (or a later install reverted it). Run `npx patch-package --error-on-fail` and re-check.",
  );
}

console.log(
  `[verify:patch] OK - ${path.relative(repoRoot, TARGET)} has the AGENTMAIL_API_KEY env declaration.`,
);
