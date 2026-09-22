// @vitest-environment node
/**
 * M19: unit tests for scripts/verify-rule-sources.mjs. No network: every
 * fetch is a stub serving fixture bodies, and every file lives in a
 * throwaway directory.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTargets,
  decodeEntities,
  formatSummary,
  normalizePageText,
  sectionContentHash,
  verifySources,
} from "../../scripts/verify-rule-sources.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const DATE = "2026-10-01";

// --- fixture upstream bodies -------------------------------------------------
const ECFR_URL_PINNED = "https://www.ecfr.gov/api/versioner/v1/full/2026-09-18/title-14.xml?part=260";
const ECFR_URL_CURRENT = "https://www.ecfr.gov/api/versioner/v1/full/2026-09-30/title-14.xml?part=260";
const ECFR_BODY = "<PART><HD>PART 260</HD><P>A refund is due.</P></PART>";
const GOVINFO_URL = "https://www.govinfo.gov/content/pkg/USCODE-2024/html/sec.htm";
const GOVINFO_BODY = "<html><body>49 U.S.C. 42305</body></html>";
const FR_URL_A = "https://www.federalregister.gov/documents/full_text/text/2024/04/26/2024-07177.txt";
const FR_URL_B = "https://www.federalregister.gov/documents/full_text/text/2025/11/17/2025-20042.txt";
const PL_URL = "https://www.govinfo.gov/link/plaw/119/public/10?link-type=html";
const MERCHANT_URL = "https://help.merchant.example/price-match";
const MERCHANT_HTML = [
  "<html><head><style>.x{color:red}</style><script>var a = 'Price Match Policy';</script></head><body>",
  "<nav>Home</nav><h1>Price Match Policy</h1>",
  "<p>We&rsquo;ll  match a lower price&nbsp;within <b>14</b> days &amp; refund the difference.</p>",
  "<svg><text>ignored</text></svg><h2>Was this helpful?</h2></body></html>",
].join("\n");
// §2.1 by hand: section text between the markers, whitespace collapsed, trimmed.
const MERCHANT_SECTION = "Price Match Policy We\u2019ll match a lower price within 14 days & refund the difference."; // NBSP collapses: JS \s (like Python's Unicode \s) matches U+00A0

function writeRepo(dir: string) {
  const files: Record<string, string> = {
    "docs/rules/sources/ecfr.txt": `# Captured source text\n# URL: ${ECFR_URL_PINNED}\n# SHA-256 of raw response (t14.xml): ${sha(ECFR_BODY)}\n\nPART 260\n`,
    "docs/rules/sources/usc.txt": `# URL: ${GOVINFO_URL}\n# SHA-256 of raw response (usc.html): ${sha(GOVINFO_BODY)}\n\n49 U.S.C.\n`,
    "docs/rules/sources/fr.txt": [
      "# Captured Federal Register passages",
      "",
      "## FR-2024-07177 — DOT — Refunds final rule",
      `- URL: ${FR_URL_A}`,
      `- SHA-256 of full-text response: ${sha("FR A")}`,
      "",
      "## FR-2025-20042 — DOT — ANPRM withdrawal",
      `- URL: ${FR_URL_B}`,
      `- SHA-256 of full-text response: ${sha("FR B")}`,
      "",
    ].join("\n"),
    "docs/rules/sources/excerpts.md": [
      "# Captured excerpts",
      "## DOT — Refunds (consumer page)",
      "- URL: https://www.transportation.gov/individuals/aviation-consumer-protection/refunds",
      "## FTC — Business Guide",
      "- URL: https://www.ftc.gov/business-guidance/resources/guide",
      "## Public Law 119-10",
      `- URL: ${PL_URL} — SHA-256 ${sha("PL 119-10")}`,
      "",
    ].join("\n"),
  };
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  const manifest = {
    packs: [
      { ruleId: "R02.example", version: 1, lifecycle: "researched", sources: ["ecfr-14cfr260", "usc-49-42305", "fr-notices", "federal-web-excerpts"] },
      {
        ruleId: "R01.example",
        version: 1,
        lifecycle: "researched",
        sources: [],
        merchantPacks: [
          { ruleId: "R01.merchant", version: 1, lifecycle: "researched", url: MERCHANT_URL, contentHash: sha(MERCHANT_SECTION), contentHashSection: ["Price Match Policy", "Was this helpful?"] },
          { ruleId: "R01.walled", version: 1, lifecycle: "researched", url: "https://walled.example/p", contentHash: null, contentHashNote: "bot-walled; browser capture only" },
          { ruleId: "R01.nopack", version: null, lifecycle: "draft", url: "https://none.example/p", status: "no pack → unsupported" },
        ],
      },
    ],
    sources: [
      { sourceId: "ecfr-14cfr260", url: "https://www.ecfr.gov/current/title-14/part-260", kind: "federal_regulation", capturedPath: "docs/rules/sources/ecfr.txt", capturedSha256: sha("c1"), rawResponseSha256: sha(ECFR_BODY) },
      { sourceId: "usc-49-42305", url: GOVINFO_URL, kind: "federal_statute", capturedPath: "docs/rules/sources/usc.txt", capturedSha256: sha("c2"), rawResponseSha256: sha(GOVINFO_BODY) },
      { sourceId: "fr-notices", url: "https://www.federalregister.gov/documents/full_text/text/", kind: "federal_register_notices", capturedPath: "docs/rules/sources/fr.txt", capturedSha256: sha("c3"), rawResponseSha256: null },
      { sourceId: "federal-web-excerpts", url: null, kind: "agency_guidance_and_fr_notices", capturedPath: "docs/rules/sources/excerpts.md", capturedSha256: sha("c4"), rawResponseSha256: null },
    ],
    fixtures: {},
  };
  writeFileSync(path.join(dir, "docs/rules/manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

type Resp = { status?: number; body: string } | Error;

function stubFetch(overrides: Record<string, Resp> = {}) {
  const served: Record<string, Resp> = {
    "https://www.ecfr.gov/api/versioner/v1/titles.json": { body: JSON.stringify({ titles: [{ number: 14, up_to_date_as_of: "2026-09-30" }] }) },
    [ECFR_URL_CURRENT]: { body: ECFR_BODY },
    [GOVINFO_URL]: { body: GOVINFO_BODY },
    [FR_URL_A]: { body: "FR A" },
    [FR_URL_B]: { body: "FR B" },
    [PL_URL]: { body: "PL 119-10" },
    [MERCHANT_URL]: { body: MERCHANT_HTML },
    ...overrides,
  };
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const r = served[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, arrayBuffer: async () => new TextEncoder().encode(r.body).buffer };
  };
  return { fetchImpl, calls };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "recoup-m19-verify-"));
  dirs.push(dir);
  const manifest = writeRepo(dir);
  const manifestBytes = readFileSync(path.join(dir, "docs/rules/manifest.json"));
  const outDir = path.join(dir, "docs/rules/review-items");
  const readRepoFile = (rel: string) => readFileSync(path.join(dir, rel), "utf8");
  return { dir, manifest, manifestBytes, outDir, readRepoFile };
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).map((p) => p.split(path.sep).join("/")).sort();
}

describe("verify-rule-sources: targets", () => {
  it("builds fetch targets for recorded reproducible hashes and manual items for browser-only or hashless sources", () => {
    const { manifest, readRepoFile } = setup();
    const { targets, manual } = buildTargets(manifest, readRepoFile);
    expect(targets.map((t: { id: string; method: string }) => `${t.id}:${t.method}`)).toEqual([
      "ecfr-14cfr260:raw",
      "usc-49-42305:raw",
      "fr-notices#FR-2024-07177:raw",
      "fr-notices#FR-2025-20042:raw",
      "federal-web-excerpts#public-law-119-10:raw",
      "R01.merchant:r01-section",
    ]);
    const reasons = Object.fromEntries(manual.map((m: { id: string; reason: string }) => [m.id, m.reason]));
    expect(reasons["federal-web-excerpts#dot-refunds-consumer-page"]).toMatch(/transportation\.gov refuses non-browser clients \(HTTP 403\)/);
    expect(reasons["federal-web-excerpts#ftc-business-guide"]).toMatch(/browser capture with no recorded hash/);
    expect(reasons["R01.walled"]).toMatch(/bot-walled/);
    expect(reasons["R01.nopack"]).toMatch(/no pack/);
  });
});

describe("verify-rule-sources: runs", () => {
  it("unchanged sources: exit 0 and no output files at all", async () => {
    const { manifest, outDir, readRepoFile, dir } = setup();
    const before = allFiles(dir);
    const { fetchImpl, calls } = stubFetch();
    const res = await verifySources({ manifest, readRepoFile, fetchImpl, date: DATE, outDir });
    expect(res.results.map((r: { status: string }) => r.status)).toEqual(Array(6).fill("unchanged"));
    expect(res.exitCode).toBe(0);
    expect(res.reviewItems).toEqual([]);
    expect(existsSync(outDir)).toBe(false);
    expect(allFiles(dir)).toEqual(before);
    // eCFR is checked at the title's current date, not only the pinned capture date.
    expect(calls).toContain(ECFR_URL_CURRENT);
    expect(calls).not.toContain(ECFR_URL_PINNED);
    expect(calls.filter((u) => u.includes("transportation.gov"))).toEqual([]);
  });

  it("drift: exit 1 and exactly one review item <date>-<id>.md naming both hashes; manifest and captures untouched", async () => {
    const { manifest, manifestBytes, outDir, readRepoFile, dir } = setup();
    const capturesBefore = readRepoFile("docs/rules/sources/ecfr.txt");
    const amended = "<PART><HD>PART 260</HD><P>A refund is due within 7 days.</P></PART>";
    const { fetchImpl } = stubFetch({ [ECFR_URL_CURRENT]: { body: amended } });
    const res = await verifySources({ manifest, readRepoFile, fetchImpl, date: DATE, outDir });
    expect(res.exitCode).toBe(1);
    expect(res.reviewItems.map((f: string) => path.relative(dir, f))).toEqual([`docs/rules/review-items/${DATE}-ecfr-14cfr260.md`]);
    const item = readFileSync(res.reviewItems[0], "utf8");
    expect(item).toMatch(/^# Rule source drift: ecfr-14cfr260/);
    expect(item).toContain(sha(ECFR_BODY));
    expect(item).toContain(sha(amended));
    expect(item).toContain("eCFR re-pointed 2026-09-18 → 2026-09-30");
    expect(item).toMatch(/Packs citing it: `R02\.example`/);
    expect(item).toMatch(/Do not edit the manifest hash/);
    expect(readFileSync(path.join(dir, "docs/rules/manifest.json"))).toEqual(manifestBytes);
    expect(readRepoFile("docs/rules/sources/ecfr.txt")).toBe(capturesBefore);
    expect(allFiles(dir).filter((f) => f.startsWith("docs/rules/review-items/"))).toEqual([`docs/rules/review-items/${DATE}-ecfr-14cfr260.md`]);
  });

  it("merchant drift is detected on the §2.1 normalized section, not on the raw page", async () => {
    const { manifest, outDir, readRepoFile } = setup();
    // Page chrome and scripts change, the section text does not: unchanged.
    const reskinned = MERCHANT_HTML.replace("<nav>Home</nav>", "<nav class='new'>Home | Deals</nav>").replace("var a", "var b");
    let res = await verifySources({ manifest, readRepoFile, fetchImpl: stubFetch({ [MERCHANT_URL]: { body: reskinned } }).fetchImpl, date: DATE, outDir, only: ["R01.merchant"] });
    expect(res.results[0].status).toBe("unchanged");
    // The window changes from 14 to 7 days: drift.
    res = await verifySources({ manifest, readRepoFile, fetchImpl: stubFetch({ [MERCHANT_URL]: { body: MERCHANT_HTML.replace("<b>14</b>", "<b>7</b>") } }).fetchImpl, date: DATE, outDir, only: ["R01.merchant"] });
    expect(res.results[0].status).toBe("drift");
    expect(res.exitCode).toBe(1);
    expect(readFileSync(res.reviewItems[0], "utf8")).toMatch(/R01 spec §2\.1 normalized section text/);
  });

  it("failure (HTTP error, network error, missing section marker): exit 2 and a review item per failure", async () => {
    const { manifest, outDir, readRepoFile } = setup();
    const { fetchImpl } = stubFetch({
      [GOVINFO_URL]: { status: 503, body: "busy" },
      [PL_URL]: new Error("The operation was aborted"),
      [MERCHANT_URL]: { body: "<html><body>This page moved.</body></html>" },
    });
    const res = await verifySources({ manifest, readRepoFile, fetchImpl, date: DATE, outDir });
    expect(res.exitCode).toBe(2);
    const byId = Object.fromEntries(res.results.map((r: { id: string; status: string; error?: string }) => [r.id, `${r.status}${r.error ? ` ${r.error}` : ""}`]));
    expect(byId["usc-49-42305"]).toBe("error HTTP 503");
    expect(byId["federal-web-excerpts#public-law-119-10"]).toMatch(/^error Error: The operation was aborted/);
    expect(byId["R01.merchant"]).toMatch(/^error section marker not found: "Price Match Policy"/);
    expect(res.reviewItems).toHaveLength(3);
    expect(readFileSync(res.reviewItems[0], "utf8")).toMatch(/^# Rule source verification failure:/);
  });

  it("without eCFR titles.json it checks the pinned date and says so", async () => {
    const { manifest, outDir, readRepoFile } = setup();
    const { fetchImpl, calls } = stubFetch({
      "https://www.ecfr.gov/api/versioner/v1/titles.json": { status: 500, body: "" },
      [ECFR_URL_PINNED]: { body: ECFR_BODY },
    });
    const res = await verifySources({ manifest, readRepoFile, fetchImpl, date: DATE, outDir, only: ["ecfr-14cfr260"] });
    expect(calls).toContain(ECFR_URL_PINNED);
    expect(res.results[0]).toMatchObject({ status: "unchanged", note: expect.stringMatching(/pinned 2026-09-18 only/) });
  });

  it("the summary prints a table, the manual list and suggested VERIFICATION entries for fully verified sources only", async () => {
    const { manifest, outDir, readRepoFile } = setup();
    const res = await verifySources({ manifest, readRepoFile, fetchImpl: stubFetch().fetchImpl, date: DATE, outDir });
    const text = formatSummary(res, DATE);
    expect(text).toMatch(/^verify-rule-sources 2026-10-01/);
    expect(text).toMatch(/6 fetched: 6 unchanged, 0 drift, 0 failed\. 4 manual\./);
    expect(text).toMatch(/MANUAL VERIFICATION/);
    const json = JSON.parse(text.slice(text.indexOf("{", text.indexOf("Suggested VERIFICATION"))));
    expect(Object.keys(json).sort()).toEqual(["R01.merchant", "ecfr-14cfr260", "fr-notices", "usc-49-42305"]);
    expect(json["ecfr-14cfr260"]).toEqual({ lastVerifiedAt: DATE, sha256: sha(ECFR_BODY), method: "fetch" });
    expect(json["fr-notices"].sha256).toBe(sha("c3")); // verified document by document: the capture file's hash
    expect(json["federal-web-excerpts"]).toBeUndefined(); // has browser-only parts
  });
});

describe("verify-rule-sources: §2.1 normalization", () => {
  it("drops script/style/noscript/svg, turns tags into spaces, decodes entities, NFC, collapses whitespace", () => {
    const { text } = normalizePageText("<p>a<script>x</script>b</p><style>s</style><noscript>n</noscript><svg>v</svg>c&amp;d\n\t é");
    expect(text).toBe(" a b c&d \u00e9");
  });

  it("trims the cut section (required for the published hashes to reproduce, M09b B.3)", () => {
    const html = "<div>  START  body text  <i>END</i></div>";
    expect(sectionContentHash(html, ["START", "END"]).sha256).toBe(sha("START body text"));
    expect(sectionContentHash(html, ["NOPE", "END"])).toMatchObject({ sha256: null, missingMarker: "NOPE" });
  });

  it("decodes named, numeric, windows-1252 and legacy no-semicolon references and reports unknown ones", () => {
    const { text, unknown } = decodeEntities("&amp; &sect; &#8217; &#x2014; &#150; &copyx &AMP; &nbsp;x &rsquor; &referer");
    expect(text).toBe("& § ’ — – ©x &  x &rsquor; &referer");
    expect(unknown).toEqual(["&rsquor;", "&referer"]);
  });
});

describe("verify-rule-sources: never in CI", () => {
  it("refuses to run when CI is set, before touching the network", () => {
    const res = spawnSync(process.execPath, ["scripts/verify-rule-sources.mjs"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, CI: "true" } });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/refusing to run in CI/);
  });

  it("no CI step runs it (only comments may mention it) and no npm script wraps it", () => {
    const ci = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const executable = ci.split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(executable.filter((l) => /verify-rule-sources/.test(l))).toEqual([]);
    expect(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).not.toMatch(/verify-rule-sources/);
  });
});
