// @vitest-environment node
/**
 * P1/P2 static guards for the PDF text layer (security baseline §7): one exact-pinned pdf.js, imported only as its
 * legacy build and worker, only by `lib/pdfText`, and nothing in `convex/` that renders, reads annotations, loads the
 * scripting build or hands pdf.js a location to fetch or read.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PDFJS_VERSION = "6.3.289";
const PDFJS_INTEGRITY = "sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==";
const ALLOWED_IMPORTS = new Set(["pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs"]);

/** Every non-test source file under convex/ (not `_generated`), with its text. */
function convexSources(): Array<{ rel: string; text: string }> {
  const entries = readdirSync(path.join(REPO, "convex"), { recursive: true, encoding: "utf8" });
  return entries
    .map((rel) => path.posix.join("convex", rel.split(path.sep).join("/")))
    .filter((rel) => /\.(ts|tsx|js|mjs)$/.test(rel) && !rel.includes("/_generated/") && !/\.(test|spec)\.[a-z]+$/.test(rel))
    .map((rel) => ({ rel, text: readFileSync(path.join(REPO, rel), "utf8") }));
}

/** Source without block and line comments (a comment may name an API; only code is checked). */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(REPO, rel), "utf8")) as Record<string, unknown>;
}

describe("pdf.js pin and imports (P1)", () => {
  it(`pins pdfjs-dist exactly at ${PDFJS_VERSION} as a runtime dependency, with the reviewed lockfile integrity`, () => {
    const pkg = json("package.json") as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies["pdfjs-dist"]).toBe(PDFJS_VERSION);
    expect(pkg.devDependencies?.["pdfjs-dist"]).toBeUndefined();
    const lock = json("package-lock.json") as { packages: Record<string, { version?: string; integrity?: string }> };
    expect(lock.packages["node_modules/pdfjs-dist"]).toMatchObject({ version: PDFJS_VERSION, integrity: PDFJS_INTEGRITY });
    const pdfjsCopies = Object.keys(lock.packages).filter((k) => k.endsWith("node_modules/pdfjs-dist"));
    expect(pdfjsCopies).toEqual(["node_modules/pdfjs-dist"]);
  });

  it("imports pdf.js only in lib/pdfText, only as the legacy build and its worker", () => {
    const importers: string[] = [];
    for (const { rel, text } of convexSources()) {
      for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](pdfjs-dist[^"']*)["']/g)) {
        importers.push(rel);
        expect(ALLOWED_IMPORTS.has(m[1]), `${rel} imports ${m[1]}`).toBe(true);
      }
      expect(/pdfjs-dist(?!\/legacy\/build\/pdf(?:\.worker)?\.mjs["'])/.test(withoutComments(text)), `${rel} names another pdf.js entry`).toBe(false);
    }
    expect([...new Set(importers)]).toEqual(["convex/lib/pdfText.ts"]);
  });

  it("nothing in convex/ renders, reads annotations, loads scripting, or gives pdf.js a location", () => {
    const FORBIDDEN = [/\brender\s*\(/, /getOperatorList/, /getAnnotations/, /pdf\.scripting/, /cMapUrl/, /standardFontDataUrl/, /wasmUrl/, /iccUrl/];
    for (const { rel, text } of convexSources()) {
      const code = withoutComments(text);
      for (const re of FORBIDDEN) expect(re.test(code), `${rel} matches ${re}`).toBe(false);
    }
    const pdfText = readFileSync(path.join(REPO, "convex/lib/pdfText.ts"), "utf8");
    expect(/\burl\s*:/i.test(withoutComments(pdfText)), "lib/pdfText passes a url option").toBe(false);
    expect(/\bpassword\s*:/i.test(withoutComments(pdfText)), "lib/pdfText passes a password").toBe(false);
    expect(/\bgetTextContent\b/.test(pdfText)).toBe(true);
  });
});

describe("the Node runtime pdf.js runs on (P2)", () => {
  it("convex.json pins Node 22 for actions and bundles pdf.js (no externalPackages)", () => {
    expect(json("convex.json")).toEqual({ node: { nodeVersion: "22" } });
  });

  it("engines.node allows only the Node 22 releases pdf.js supports", () => {
    expect((json("package.json") as { engines: { node: string } }).engines.node).toBe(">=22.13 <23");
  });
});

describe("the advisory gate live extraction depends on (P5, D227)", () => {
  /** The `advisories` job's block of ci.yml: from its key to the next job key at the same indent. */
  function advisoriesJob(ci: string): string | null {
    const m = /\n {2}advisories:\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:\n|$)/.exec(ci);
    return m ? m[1] : null;
  }

  it("CI has an `advisories` job that fails on high or critical advisories in production dependencies", () => {
    const job = advisoriesJob(readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8"));
    expect(job, "ci.yml has no `advisories` job").not.toBeNull();
    const executable = (job ?? "").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(executable).toMatch(/^\s+run: npm audit --omit=dev --audit-level=high\s*$/m);
    // It must be able to fail the run: no continue-on-error, no `|| true`, no conditional skip.
    expect(executable).not.toMatch(/continue-on-error|\|\|\s*true|^\s+if:/m);
  });

  it("a daily schedule runs the advisories job (an advisory published on a quiet day is still caught); every other job skips it", () => {
    const ci = readFileSync(path.join(REPO, ".github/workflows/ci.yml"), "utf8");
    const on = /\non:\n([\s\S]*?)\n(?=\S)/.exec(ci)?.[1] ?? "";
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: "\d{1,2} \d{1,2} \* \* \*"$/m);
    const jobsBlock = ci.slice(ci.indexOf("\njobs:\n"));
    const jobs = [...jobsBlock.matchAll(/\n {2}([A-Za-z0-9_-]+):\n([\s\S]*?)(?=\n {2}[A-Za-z0-9_-]+:\n|$)/g)].map((m) => ({ name: m[1], body: m[2] }));
    expect(jobs.map((j) => j.name)).toEqual(expect.arrayContaining(["checks", "clockshift", "localeshift", "advisories", "e2e"]));
    // A job skips the schedule through its own `if:`, or through `needs:` on a job that skips it (a skipped need skips
    // the job; `e2e` keeps its own secrets `if:`, KC1).
    const ownSkip = new Map(jobs.map((j) => [j.name, /^ {4}if: github\.event_name != 'schedule'$/m.test(j.body)]));
    const needs = new Map(jobs.map((j) => [j.name, [...(/^ {4}needs: \[?([^\]\n]*)\]?$/m.exec(j.body)?.[1] ?? "").matchAll(/[A-Za-z0-9_-]+/g)].map((m) => m[0])]));
    const skipsSchedule = (name: string, seen = new Set<string>()): boolean =>
      ownSkip.get(name) === true || (needs.get(name) ?? []).some((n) => !seen.has(n) && skipsSchedule(n, new Set([...seen, name])));
    for (const job of jobs) {
      expect(skipsSchedule(job.name), `${job.name} ${job.name === "advisories" ? "must run" : "must skip"} on the schedule`).toBe(job.name !== "advisories");
    }
    expect(/^ {4}(if|needs):/m.test(jobs.find((j) => j.name === "advisories")?.body ?? "")).toBe(false);
  });

  it("the guard itself fails on a workflow without the job", () => {
    expect(advisoriesJob("jobs:\n  checks:\n    runs-on: ubuntu-latest\n")).toBeNull();
  });
});
