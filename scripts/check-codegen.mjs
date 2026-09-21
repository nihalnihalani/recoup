#!/usr/bin/env node
// T17 (P11): verify convex/_generated/** is not stale relative to what
// `npx convex codegen` would produce from the current convex/ sources.
// Wired as `npm run codegen:check`.
//
// This closes docs/reviews/2026-09-21-phase0-reproduction.md's P11 finding
// "Lockfile/generated Convex API consistency is unverified from a clean
// checkout" -- and the underlying drift is real, not hypothetical: as of
// this writing, running this exact check finds convex/_generated/api.d.ts
// on `main` is missing entries for lib/authMail.ts, lib/email.ts and
// mailEvents.ts (added by other in-flight lanes without a codegen re-run).
// That is a genuine bug for another owner to fix, not this script.
//
// IMPORTANT LIMITATION (documented per the T17 contract: "must not require
// a deployment; document if it does"): `npx convex codegen`, with or
// without --dry-run, ALWAYS requires a reachable, already-linked Convex
// deployment -- it calls getDeploymentSelection()/
// loadSelectedDeploymentCredentials() unconditionally
// (node_modules/convex/dist/esm/cli/codegen.js), and it explicitly REFUSES
// a preview CONVEX_DEPLOY_KEY ("Codegen requires an existing deployment so
// doesn't support CONVEX_DEPLOY_KEY. Generate code in dev and commit it to
// the repo instead."). There is no deployment-free / offline mode for a
// project using Convex components (this repo mounts agentmail, workpool,
// rate-limiter, static-hosting), because codegen needs to read each
// component's schema from the deployment.
//
// Consequence: this check CANNOT run in a stock GitHub-hosted CI job with
// no secrets. It only runs when the environment already points at a real,
// reachable deployment (CONVEX_DEPLOYMENT, or CONVEX_URL + CONVEX_ADMIN_KEY
// for a non-preview deploy key) -- see docs/ops/INSTALL.md for how to wire
// a dedicated CI/codegen deployment's admin key as a secret. Without that,
// it prints a clear skip notice and exits 0 rather than failing every PR
// for a reason contributors cannot fix. The `checks` CI job treats this as
// informational, matching how the `e2e` job skips without secrets (see
// .github/workflows/ci.yml).
//
// How it verifies drift, once a deployment is available: it makes an
// isolated `git worktree` at HEAD (so nobody's uncommitted work leaks in),
// symlinks node_modules into it (avoids a second npm install), runs the
// real (non---dry-run) `convex codegen` there so it writes actual files,
// then runs `git diff --exit-code -- convex/_generated` inside that
// worktree. The worktree never touches this checkout's working tree.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Local dev never exports CONVEX_DEPLOYMENT into the shell -- `npx convex
// dev` writes it into .env.local and the Convex CLI loads that file itself
// (dotenv) on every invocation. So the gate has to check .env.local too, not
// just process.env (which is how CI would supply CONVEX_URL/CONVEX_ADMIN_KEY
// as secrets instead).
function envLocalHasDeployment() {
  const envLocalPath = path.join(repoRoot, ".env.local");
  if (!existsSync(envLocalPath)) return false;
  const contents = readFileSync(envLocalPath, "utf8");
  return /^CONVEX_DEPLOYMENT=\S+/m.test(contents);
}

const hasDeployment =
  !!process.env.CONVEX_DEPLOYMENT ||
  (!!process.env.CONVEX_URL && !!process.env.CONVEX_ADMIN_KEY) ||
  envLocalHasDeployment();

if (!hasDeployment) {
  console.log(
    "[codegen:check] SKIPPED - no reachable Convex deployment is configured " +
      "(CONVEX_DEPLOYMENT, or CONVEX_URL + CONVEX_ADMIN_KEY).\n" +
      "`convex codegen` always needs an existing deployment to read component " +
      "schemas from, and explicitly refuses a preview CONVEX_DEPLOY_KEY, so this " +
      "cannot run in a plain CI job without a dedicated deployment's admin key.\n" +
      "See docs/ops/INSTALL.md (\"codegen:check\") for how to wire one up, and run " +
      "`npm run codegen:check` locally (where `npx convex dev` has already linked a " +
      "deployment) before pushing.",
  );
  process.exit(0);
}

let worktreeDir;
try {
  worktreeDir = mkdtempSync(path.join(tmpdir(), "recoup-codegen-"));
  // mkdtemp already created the dir; `git worktree add` needs to create it
  // itself, so hand it a not-yet-existing child path instead.
  const wtPath = path.join(worktreeDir, "wt");

  execFileSync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  try {
    symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(wtPath, "node_modules"),
    );
    const envLocal = path.join(repoRoot, ".env.local");
    if (existsSync(envLocal)) {
      copyFileSync(envLocal, path.join(wtPath, ".env.local"));
    }

    const args = ["convex", "codegen"];
    if (process.env.CONVEX_URL) args.push("--url", process.env.CONVEX_URL);
    if (process.env.CONVEX_ADMIN_KEY) args.push("--admin-key", process.env.CONVEX_ADMIN_KEY);

    execFileSync("npx", args, { cwd: wtPath, stdio: "inherit", env: process.env });

    execFileSync("git", ["diff", "--exit-code", "--", "convex/_generated"], {
      cwd: wtPath,
      stdio: "inherit",
    });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }
} catch (err) {
  console.error(
    "[codegen:check] FAILED - convex/_generated is stale relative to `npx convex codegen`, " +
      "or codegen itself errored (see output above). Regenerate with `npx convex dev` " +
      "(or `npx convex codegen`) locally and commit the result.\n" +
      `  (${err instanceof Error ? err.message : String(err)})`,
  );
  process.exit(1);
} finally {
  if (worktreeDir) rmSync(worktreeDir, { recursive: true, force: true });
}

console.log("[codegen:check] OK - convex/_generated matches `npx convex codegen` output.");
