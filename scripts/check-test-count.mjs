#!/usr/bin/env node
// T17 (P11): the enforced CI test gate. Wired as `npm run test:ci`.
//
// Why this exists: package.json's `test` script used to be
// `vitest run --passWithNoTests`, so an empty or misconfigured test suite
// (e.g. an include glob that silently matches nothing) would exit 0 and
// CI would report green with zero tests run
// (docs/reviews/2026-09-21-phase0-reproduction.md P11, "still_present",
// package.json:11).
//
// This script runs vitest itself (with the JSON reporter, to a throwaway
// file so console output from tests can never corrupt the report) and then
// fails unless:
//   1. vitest's own run succeeded (no failing tests), AND
//   2. at least `minCount` (default 600) tests ran in total, AND
//   3. every collected test file has at least one test (a file that
//      collects zero tests -- e.g. an empty describe, or a collection
//      error -- is exactly the "silently misconfigured suite" failure mode
//      --passWithNoTests was hiding).
//
// Usage: node scripts/check-test-count.mjs [minCount]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const minCount = Number(process.argv[2] ?? 600);
if (!Number.isFinite(minCount) || minCount <= 0) {
  console.error(`[test:ci] FAILED - invalid minCount argument: ${process.argv[2]}`);
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), "recoup-vitest-json-"));
const outFile = path.join(workDir, "results.json");

let vitestRunFailed = false;
try {
  execFileSync(
    "npx",
    ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`],
    { stdio: "inherit" },
  );
} catch {
  // vitest exits non-zero on any failing test (or a collection error). We
  // still want to read whatever JSON it wrote so the failure message below
  // is specific, so don't bail out here -- just remember it failed.
  vitestRunFailed = true;
}

if (!existsSync(outFile)) {
  console.error(
    `[test:ci] FAILED - vitest did not produce a JSON report at ${outFile}. ` +
      "It likely crashed before collecting any tests; see the vitest output above.",
  );
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}

/** @type {{numTotalTests?: number, numFailedTests?: number, testResults?: Array<{name: string, assertionResults?: Array<unknown>, status?: string}>}} */
const report = JSON.parse(readFileSync(outFile, "utf8"));
rmSync(workDir, { recursive: true, force: true });

const total = report.numTotalTests ?? 0;
const testFiles = report.testResults ?? [];
const emptyFiles = testFiles
  .filter((file) => (file.assertionResults?.length ?? 0) === 0)
  .map((file) => file.name);

let ok = true;

if (vitestRunFailed) {
  console.error(
    `[test:ci] FAILED - vitest reported failures (numFailedTests=${report.numFailedTests ?? "unknown"}).`,
  );
  ok = false;
}

if (total < minCount) {
  console.error(
    `[test:ci] FAILED - only ${total} test(s) ran across ${testFiles.length} file(s); need at least ${minCount}.`,
  );
  ok = false;
}

if (emptyFiles.length > 0) {
  console.error(
    `[test:ci] FAILED - ${emptyFiles.length} file(s) collected 0 tests:\n` +
      emptyFiles.map((name) => `  - ${name}`).join("\n"),
  );
  ok = false;
}

if (!ok) {
  process.exit(1);
}

console.log(
  `[test:ci] OK - ${total} tests passed across ${testFiles.length} file(s) (minimum ${minCount}).`,
);
