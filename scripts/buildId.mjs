import { execSync } from "node:child_process";

/**
 * P12-W6: the frontend build id: `RECOUP_BUILD_ID` when set (a CI or release job), else the git revision, with
 * `-dirty` when tracked files had uncommitted changes, else "unknown" (no git, e.g. a CI tarball with no `.git`).
 * Never a secret: it is served publicly (`<meta name="recoup-build">`, `dist/build-info.json`).
 *
 * Extracted from vite.config.ts (F6, fe2 review) so its env-override and no-git fallback paths are unit-testable
 * (`scripts/buildId.test.ts`) without going through a real Vite build. `run` is injectable for that; production
 * code never passes it and gets the real `execSync`.
 */
export function defaultRun(command) {
  return execSync(command, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
}

export function buildId(env = process.env, run = defaultRun) {
  const explicit = env.RECOUP_BUILD_ID?.trim();
  if (explicit) return explicit;
  try {
    const sha = run("git rev-parse --short=12 HEAD");
    return run("git status --porcelain --untracked-files=no").length > 0 ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}
