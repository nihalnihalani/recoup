/**
 * KC1 (D237, M25): CI never reports the browser suite as a silent success. Without the E2E secrets the `e2e` job must
 * show as SKIPPED (a job-level `if:` on a secrets-check job's output) with a visible warning annotation, and when it
 * does run, nothing may turn a Playwright failure into a pass. Static checks on `.github/workflows/ci.yml`, plus a
 * proof that the checks fail on the old shape (per-step `if:` inside a job that always "succeeds").
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "../..");
const CI = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");

/** A job's block: from `  <name>:` to the next job key at the same indent. */
function job(ci: string, name: string): string | null {
  const m = new RegExp(`\\n {2}${name.replace(/[-]/g, "\\-")}:\\n([\\s\\S]*?)(?=\\n {2}[A-Za-z0-9_-]+:\\n|$)`).exec(ci);
  return m ? m[1] : null;
}
const executable = (block: string) => block.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");

/** Every way the workflow could report e2e as green without running Playwright, or hide a failure. */
function kc1Problems(ci: string): string[] {
  const problems: string[] = [];
  const check = job(ci, "e2e-secrets");
  const e2e = job(ci, "e2e");
  if (!check) problems.push("no e2e-secrets job");
  if (!e2e) return [...problems, "no e2e job"];
  const run = executable(e2e);
  if (!/^ {4}if: needs\.e2e-secrets\.outputs\.present == 'true'\s*$/m.test(run)) problems.push("e2e has no job-level if on the secrets check (it would report success when skipped)");
  if (!/^ {4}needs: \[[^\]]*\be2e-secrets\b[^\]]*\]\s*$/m.test(run)) problems.push("e2e does not need e2e-secrets");
  if (/steps\.[A-Za-z0-9_]+\.outputs\.present/.test(run)) problems.push("e2e still skips per step (a green job that ran nothing)");
  if (!/^\s+run: npx playwright test\s*$/m.test(run)) problems.push("e2e does not run `npx playwright test`");
  if (/continue-on-error|\|\|\s*true/.test(run)) problems.push("e2e can swallow a Playwright failure");
  if (check) {
    const c = executable(check);
    if (!/::warning title=e2e skipped: secrets not configured::/.test(c)) problems.push("no visible warning annotation when skipped");
    if (!/present=false/.test(c) || !/present=true/.test(c)) problems.push("the secrets check does not publish present=true/false");
    if (!/outputs:\n\s+present: \$\{\{ steps\.check\.outputs\.present \}\}/.test(c)) problems.push("the secrets check does not expose its output");
    if (/echo "\$HAS_(URL|KEY)"|echo \$\{\{ secrets\./.test(c)) problems.push("a secret value is echoed");
  }
  return problems;
}

describe("KC1: the e2e job is visibly skipped without secrets, never a silent success", () => {
  it("ci.yml has the secrets-check job, the job-level skip, a visible annotation, and no way to swallow a failure", () => {
    expect(kc1Problems(CI)).toEqual([]);
  });

  it("the check fails on the old shape (one e2e job whose steps each skip, reporting success)", () => {
    const old = [
      "jobs:",
      "  e2e:",
      "    name: e2e",
      "    needs: checks",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: check for e2e secrets",
      "        id: e2e_secrets",
      "        run: echo present=false >> \"$GITHUB_OUTPUT\"",
      "      - name: run Playwright suite",
      "        if: steps.e2e_secrets.outputs.present == 'true'",
      "        run: npx playwright test",
      "",
    ].join("\n");
    expect(kc1Problems(old)).toEqual(expect.arrayContaining([
      "no e2e-secrets job",
      "e2e has no job-level if on the secrets check (it would report success when skipped)",
      "e2e still skips per step (a green job that ran nothing)",
    ]));
  });

  it("the check fails when a Playwright failure could be swallowed", () => {
    expect(kc1Problems(CI.replace("run: npx playwright test", "run: npx playwright test || true"))).toContain("e2e can swallow a Playwright failure");
  });
});
