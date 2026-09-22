#!/usr/bin/env node
// M19 (contract §2.7, D145(b) DA-A-11, D148 wave-2 note 2): on-demand
// re-verification of the captured rule sources recorded in
// docs/rules/manifest.json.
//
// WHO RUNS IT: the lead, from a checkout of main with dependencies installed:
//   node scripts/verify-rule-sources.mjs            # today's date
//   node scripts/verify-rule-sources.mjs --date 2026-10-01
//   node scripts/verify-rule-sources.mjs --only ecfr-14cfr260 --only R01.target.all_channels
// Run it at every wave close, before release, and weekly while any slice's
// pack is active. It is NEVER run in CI: it needs the network, and a
// third-party site being down must not fail a build.
//
// WHAT IT DOES
//  - Builds one target per recorded, reproducible hash:
//    * each manifest `sources[]` entry whose capture file header records the
//      exact fetch URL and "SHA-256 of raw response" -> fetch that URL and
//      compare the raw-response SHA-256 with the manifest's
//      `rawResponseSha256`. eCFR versioner URLs are re-pointed to the
//      title's current `up_to_date_as_of` date (titles.json), so an
//      amendment after the capture date shows up as drift. The versioner's
//      part/section XML is byte-identical across dates while the text is
//      unchanged (checked 2026-09-23: part 260 at 2026-01-02, 09-10 and
//      09-18 all hash d79cfeb9…);
//    * each Federal Register document in the `fr-notices` capture file
//      (per-document URL + "SHA-256 of full-text response");
//    * each section of `federal-web-pages-excerpts.md` that records a
//      SHA-256 next to its URL (e.g. Public Law 119-10 on govinfo);
//    * each R01 merchant pack with `contentHash` + `contentHashSection`
//      -> the R01 spec §2.1 normalized-text hash (below), compared with
//      `contentHash`.
//  - Lists MANUAL-VERIFICATION items instead of fetching:
//    hosts that refuse non-browser clients (transportation.gov,
//    consumerfinance.gov: HTTP 403), browser captures with no recorded hash
//    (FTC pages, the Best Buy pack), and sources with no reproducible hash.
//    The lead re-verifies those in a browser and records
//    `method: "browser"` in convex/lib/rules/verification.ts.
//  - On drift (fetched fine, hash differs) or failure (HTTP error,
//    timeout, section markers not found) writes
//    docs/rules/review-items/<date>-<id>.md. Unchanged targets write
//    nothing.
//  - Prints a summary table and, for unchanged sources, a suggested
//    `VERIFICATION` block for the lead to paste into
//    convex/lib/rules/verification.ts.
//  - NEVER edits the manifest, a capture, a spec, a fixture or any logic.
//    The only files it writes are review items (README rules 1-2: a changed
//    source opens a review; it never rewrites logic).
//
// NORMALIZATION (R01 spec §2.1, "Reproducible hashes"): drop <script>,
// <style>, <noscript>, <svg> elements; replace every other tag with a space;
// decode HTML entities; Unicode NFC; collapse every whitespace run to one
// space; cut from the first occurrence of section_start (inclusive) to the
// next section_end (exclusive); TRIM leading and trailing whitespace of the
// cut; SHA-256 of the UTF-8 bytes. Checked 2026-09-23 against live pages: it
// reproduces the published Apple (2a44c2f6…), Costco (02f32d90…) and Target
// (9cc32d9c…) content hashes. The committed federal captures are
// renderings that this normalization does NOT reproduce (inline tags and
// entities were rendered differently), which is why federal targets compare
// the raw response instead; a drift review item also shows the normalized
// hash of the fetched body for the reviewer.
//
// EXIT CODES: 0 = every fetched target unchanged (manual items do not fail);
// 1 = drift in at least one target; 2 = no drift but at least one failure.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BROWSER_ONLY_HOSTS = ["transportation.gov", "consumerfinance.gov"];
const USER_AGENT = "recoup-verify-rule-sources/1 (on-demand source re-verification)";
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HTML entity decoding (dependency-free; HTML 4 named set + apos, numeric,
// and the HTML5 legacy no-semicolon forms of the Latin-1 set). An unknown
// named entity is left as written and reported, so a mismatch caused by it is
// explainable rather than silent.
// ---------------------------------------------------------------------------

const LATIN1_NAMES =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(
    " ",
  );
const OTHER_ENTITIES = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, fnof: 402,
  circ: 710, tilde: 732, ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221, bdquo: 8222,
  dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242, Prime: 8243, lsaquo: 8249,
  rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465, weierp: 8472, real: 8476, trade: 8482,
  alefsym: 8501, larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629, lArr: 8656, uArr: 8657,
  rArr: 8658, dArr: 8659, hArr: 8660, forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712,
  notin: 8713, ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733, infin: 8734,
  ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756, sim: 8764, cong: 8773,
  asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834, sup: 8835, nsub: 8836, sube: 8838,
  supe: 8839, oplus: 8853, otimes: 8855, perp: 8869, sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970,
  rfloor: 8971, lang: 10216, rang: 10217, loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  thetasym: 977, upsih: 978, piv: 982, sigmaf: 962,
};
const GREEK_UPPER = "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho".split(" ");
const GREEK_UPPER_2 = "Sigma Tau Upsilon Phi Chi Psi Omega".split(" ");
const GREEK_LOWER = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho".split(" ");
const GREEK_LOWER_2 = "sigma tau upsilon phi chi psi omega".split(" ");

/** name -> code point, for `&name;`. */
const NAMED = new Map([
  ...LATIN1_NAMES.map((n, i) => [n, 160 + i]),
  ...Object.entries(OTHER_ENTITIES),
  ...GREEK_UPPER.map((n, i) => [n, 913 + i]),
  ...GREEK_UPPER_2.map((n, i) => [n, 931 + i]),
  ...GREEK_LOWER.map((n, i) => [n, 945 + i]),
  ...GREEK_LOWER_2.map((n, i) => [n, 963 + i]),
  ["AMP", 38], ["LT", 60], ["GT", 62], ["QUOT", 34], ["COPY", 169], ["REG", 174],
]);
/** HTML5 legacy names decoded even without a trailing semicolon (text content). */
const LEGACY = new Map([
  ...LATIN1_NAMES.map((n, i) => [n, 160 + i]),
  ["amp", 38], ["AMP", 38], ["lt", 60], ["LT", 60], ["gt", 62], ["GT", 62], ["quot", 34], ["QUOT", 34],
  ["COPY", 169], ["REG", 174],
]);
const LEGACY_BY_LENGTH = [...LEGACY.keys()].sort((a, b) => b.length - a.length);
/** HTML5 numeric reference replacements for 0x80-0x9F (windows-1252). */
const C1_REMAP = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x2c6,
  0x89: 0x2030, 0x8a: 0x160, 0x8b: 0x2039, 0x8c: 0x152, 0x8e: 0x17d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
  0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x2dc, 0x99: 0x2122, 0x9a: 0x161, 0x9b: 0x203a,
  0x9c: 0x153, 0x9e: 0x17e, 0x9f: 0x178,
};

function fromNumeric(code) {
  if (C1_REMAP[code]) return String.fromCodePoint(C1_REMAP[code]);
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
  return String.fromCodePoint(code);
}

/** Decodes HTML character references. Returns the text and any named references it could not decode. */
export function decodeEntities(text) {
  const unknown = new Set();
  const out = text.replace(/&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/g, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const digits = body.slice(hex ? 2 : 1).replace(/;$/, "");
      return fromNumeric(parseInt(digits, hex ? 16 : 10));
    }
    if (body.endsWith(";")) {
      const code = NAMED.get(body.slice(0, -1));
      if (code !== undefined) return String.fromCodePoint(code);
    }
    // No semicolon (or unknown with one): the longest legacy prefix decodes, the rest stays (HTML5 text rule).
    const name = body.replace(/;$/, "");
    const legacy = LEGACY_BY_LENGTH.find((n) => name.startsWith(n));
    if (legacy && !body.endsWith(";")) return String.fromCodePoint(LEGACY.get(legacy)) + body.slice(legacy.length);
    if (legacy && body.endsWith(";") && legacy !== name) return String.fromCodePoint(LEGACY.get(legacy)) + body.slice(legacy.length);
    unknown.add(whole);
    return whole;
  });
  return { text: out, unknown: [...unknown] };
}

/** R01 §2.1 steps before the cut: drop script/style/noscript/svg, tags -> space, decode entities, NFC, collapse whitespace. */
export function normalizePageText(html) {
  const withoutElements = html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const withoutTags = withoutElements.replace(/<[^>]*>/g, " ");
  const { text, unknown } = decodeEntities(withoutTags);
  return { text: text.normalize("NFC").replace(/\s+/g, " "), unknownEntities: unknown };
}

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** R01 §2.1 content hash of the [start, end) section, trimmed; null when a marker is missing. */
export function sectionContentHash(html, [start, end]) {
  const { text, unknownEntities } = normalizePageText(html);
  const i = text.indexOf(start);
  const j = i < 0 ? -1 : text.indexOf(end, i + start.length);
  if (i < 0 || j < 0) return { sha256: null, missingMarker: i < 0 ? start : end, unknownEntities };
  return { sha256: sha256Hex(Buffer.from(text.slice(i, j).trim(), "utf8")), missingMarker: null, unknownEntities };
}

// ---------------------------------------------------------------------------
// Capture-file parsing
// ---------------------------------------------------------------------------

/** `# URL: <url>` and `# SHA-256 of raw response (...): <hex>` from a capture file header. */
export function parseCaptureHeader(text) {
  const header = text.split("\n").filter((l) => l.startsWith("#"));
  const url = header.map((l) => l.match(/^#\s*URL:\s*(\S+)/)).find(Boolean)?.[1] ?? null;
  const rawSha256 = header.map((l) => l.match(/^#\s*SHA-256 of raw response[^:]*:\s*([0-9a-f]{64})/i)).find(Boolean)?.[1] ?? null;
  return { url, rawSha256 };
}

/** Federal Register blocks: `## FR-<id> …`, `- URL: …`, `- SHA-256 of full-text response: <hex>`. */
export function parseFrNotices(text) {
  const out = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const id = block.match(/^(FR-[0-9A-Za-z-]+)/)?.[1];
    const url = block.match(/^- URL:\s*(\S+)/m)?.[1];
    const sha256 = block.match(/SHA-256 of full-text response:\s*([0-9a-f]{64})/i)?.[1];
    if (id) out.push({ id, url: url ?? null, sha256: sha256 ?? null });
  }
  return out;
}

/** `## <title>` sections of the excerpts file that name a `- URL:`; a 64-hex SHA-256 on that line makes it fetchable. */
export function parseExcerptSections(text) {
  const out = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const title = block.split("\n", 1)[0].trim();
    const urlLine = block.match(/^- URL:\s*(.+)$/m)?.[1];
    if (!urlLine) continue;
    const url = urlLine.match(/(https?:\/\/\S+)/)?.[1] ?? null;
    const sha256 = urlLine.match(/\b([0-9a-f]{64})\b/i)?.[1] ?? null;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    out.push({ id: slug, title, url, sha256 });
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isBrowserOnlyHost(url) {
  const host = hostOf(url);
  return BROWSER_ONLY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, url: string|null, reason: string }} ManualItem
 * @typedef {Record<string, any> & { id: string, sourceId: string, kind: string, method: "raw" | "r01-section", url: string, expected: string }} Target
 * @param {any} manifest
 * @param {(rel: string) => string} readRepoFile
 * @returns {{ targets: Target[], manual: ManualItem[] }}
 */
export function buildTargets(manifest, readRepoFile) {
  const targets = [];
  const manual = [];
  const citedBy = (sourceId) => (manifest.packs ?? []).filter((p) => (p.sources ?? []).includes(sourceId)).map((p) => p.ruleId);

  for (const s of manifest.sources ?? []) {
    const base = { sourceId: s.sourceId, kind: s.kind, capturedPath: s.capturedPath, capturedSha256: s.capturedSha256 ?? null, citedBy: citedBy(s.sourceId) };
    let text = null;
    try {
      text = s.capturedPath ? readRepoFile(s.capturedPath) : null;
    } catch {
      manual.push({ id: s.sourceId, url: s.url ?? null, reason: `capture file ${s.capturedPath} is missing` });
      continue;
    }
    if (s.sourceId === "fr-notices" || /federal-register-notices/.test(s.capturedPath ?? "")) {
      for (const doc of parseFrNotices(text ?? "")) {
        const id = `${s.sourceId}#${doc.id}`;
        if (doc.url && doc.sha256) targets.push({ ...base, id, method: "raw", url: doc.url, expected: doc.sha256 });
        else manual.push({ id, url: doc.url, reason: "no URL or full-text SHA-256 recorded" });
      }
      continue;
    }
    if (/excerpts\.md$/.test(s.capturedPath ?? "")) {
      for (const sec of parseExcerptSections(text ?? "")) {
        const id = `${s.sourceId}#${sec.id}`;
        if (sec.url && isBrowserOnlyHost(sec.url)) {
          manual.push({ id, url: sec.url, reason: `${hostOf(sec.url)} refuses non-browser clients (HTTP 403): re-verify in a browser` });
        } else if (sec.url && sec.sha256) {
          targets.push({ ...base, id, method: "raw", url: sec.url, expected: sec.sha256 });
        } else {
          manual.push({ id, url: sec.url, reason: "browser capture with no recorded hash: re-verify in a browser" });
        }
      }
      continue;
    }
    const header = parseCaptureHeader(text ?? "");
    const url = header.url ?? s.url ?? null;
    const expected = s.rawResponseSha256 ?? null;
    if (!url || !expected) {
      manual.push({ id: s.sourceId, url, reason: "no reproducible raw-response hash recorded" });
    } else if (isBrowserOnlyHost(url)) {
      manual.push({ id: s.sourceId, url, reason: `${hostOf(url)} refuses non-browser clients (HTTP 403): re-verify in a browser` });
    } else {
      if (header.rawSha256 && header.rawSha256 !== expected) {
        manual.push({ id: s.sourceId, url, reason: `capture header hash ${header.rawSha256.slice(0, 12)}… differs from manifest rawResponseSha256 ${expected.slice(0, 12)}…` });
      }
      targets.push({ ...base, id: s.sourceId, method: "raw", url, expected });
    }
  }

  for (const pack of manifest.packs ?? []) {
    for (const mp of pack.merchantPacks ?? []) {
      if (mp.version === null || (mp.lifecycle === "draft" && !mp.contentHash)) {
        manual.push({ id: mp.ruleId, url: mp.url ?? null, reason: `no pack (${mp.status ?? mp.lifecycle}); nothing to verify` });
      } else if (mp.contentHash && Array.isArray(mp.contentHashSection) && mp.contentHashSection.length === 2) {
        targets.push({
          id: mp.ruleId, sourceId: mp.ruleId, kind: "merchant_pack", method: "r01-section", url: mp.url,
          expected: mp.contentHash, section: mp.contentHashSection, citedBy: [pack.ruleId],
        });
      } else {
        manual.push({ id: mp.ruleId, url: mp.url ?? null, reason: mp.contentHashNote ?? "no reproducible contentHash: re-verify in a browser" });
      }
    }
  }
  return { targets, manual };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const ECFR_FULL = /^(https:\/\/www\.ecfr\.gov\/api\/versioner\/v1\/full\/)(\d{4}-\d{2}-\d{2})(\/title-(\d+)\.xml.*)$/;

async function fetchBytes(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "follow", headers: { "user-agent": USER_AGENT }, signal: controller.signal });
    const body = Buffer.from(await res.arrayBuffer());
    return { status: res.status, ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

async function ecfrCurrentDates(fetchImpl) {
  try {
    const { ok, body } = await fetchBytes(fetchImpl, "https://www.ecfr.gov/api/versioner/v1/titles.json");
    if (!ok) return null;
    const titles = JSON.parse(body.toString("utf8")).titles ?? [];
    return new Map(titles.map((t) => [String(t.number), t.up_to_date_as_of]));
  } catch {
    return null;
  }
}

/**
 * Verifies every target. Pure apart from `fetchImpl` and the review-item
 * writes into `outDir`.
 * @param {{ manifest: any, readRepoFile: (rel: string) => string, fetchImpl: (url: string, init?: any) => Promise<any>, date: string, outDir: string, only?: string[] }} opts
 * @returns {Promise<{ results: Array<Target & { status: "unchanged" | "drift" | "error", actual: string|null, fetchedUrl: string, note: string, error?: string }>, manual: ManualItem[], reviewItems: string[], exitCode: number }>}
 */
export async function verifySources({ manifest, readRepoFile, fetchImpl, date, outDir, only = [] }) {
  const { targets: all, manual } = buildTargets(manifest, readRepoFile);
  const targets = only.length ? all.filter((t) => only.some((o) => t.id === o || t.sourceId === o)) : all;
  const needsEcfr = targets.some((t) => ECFR_FULL.test(t.url));
  const ecfrDates = needsEcfr ? await ecfrCurrentDates(fetchImpl) : null;
  const cache = new Map();
  /** @type {any[]} */
  const results = [];

  for (const t of targets) {
    let url = t.url;
    let note = "";
    const m = url.match(ECFR_FULL);
    if (m) {
      const current = ecfrDates?.get(m[4]);
      if (current) {
        url = `${m[1]}${current}${m[3]}`;
        note = current === m[2] ? `eCFR as of ${current} (capture date)` : `eCFR re-pointed ${m[2]} → ${current}`;
      } else {
        note = `eCFR titles.json unavailable: pinned ${m[2]} only (reproducibility, not currency)`;
      }
    }
    let result;
    try {
      if (!cache.has(url)) cache.set(url, fetchBytes(fetchImpl, url));
      const res = await cache.get(url);
      if (!res.ok) {
        result = { status: "error", actual: null, error: `HTTP ${res.status}` };
      } else if (t.method === "r01-section") {
        const h = sectionContentHash(res.body.toString("utf8"), t.section);
        if (h.sha256 === null) result = { status: "error", actual: null, error: `section marker not found: "${h.missingMarker}"`, unknownEntities: h.unknownEntities };
        else result = { status: h.sha256 === t.expected ? "unchanged" : "drift", actual: h.sha256, unknownEntities: h.unknownEntities };
      } else {
        const actual = sha256Hex(res.body);
        const drift = actual !== t.expected;
        result = {
          status: drift ? "drift" : "unchanged",
          actual,
          normalizedSha256: drift ? sha256Hex(Buffer.from(normalizePageText(res.body.toString("utf8")).text.trim(), "utf8")) : undefined,
        };
      }
    } catch (err) {
      result = { status: "error", actual: null, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    results.push({ ...t, fetchedUrl: url, note, ...result });
  }

  const reviewItems = [];
  for (const r of results.filter((x) => x.status !== "unchanged")) {
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${date}-${r.id.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`);
    writeFileSync(file, renderReviewItem(r, date));
    reviewItems.push(file);
  }
  const drift = results.some((r) => r.status === "drift");
  const failed = results.some((r) => r.status === "error");
  return { results, manual, reviewItems, exitCode: drift ? 1 : failed ? 2 : 0 };
}

export function renderReviewItem(r, date) {
  const lines = [
    `# Rule source ${r.status === "drift" ? "drift" : "verification failure"}: ${r.id}`,
    "",
    `- Date: ${date}`,
    `- Result: **${r.status}**${r.error ? ` (${r.error})` : ""}`,
    `- Manifest entry: ${r.kind === "merchant_pack" ? `packs[].merchantPacks[] ruleId \`${r.sourceId}\`` : `sources[] sourceId \`${r.sourceId}\``}`,
    `- Kind: ${r.kind}`,
    `- Fetched: ${r.fetchedUrl}${r.note ? ` (${r.note})` : ""}`,
    `- Method: ${r.method === "r01-section" ? `R01 spec §2.1 normalized section text, markers ${JSON.stringify(r.section)}` : "SHA-256 of the raw response bytes"}`,
    `- Expected (manifest): \`${r.expected}\``,
    `- Actual: ${r.actual ? `\`${r.actual}\`` : "n/a"}`,
  ];
  if (r.normalizedSha256) lines.push(`- Normalized-text SHA-256 of the fetched body (§2.1 steps, whole page, trimmed; for the reviewer): \`${r.normalizedSha256}\``);
  if (r.unknownEntities?.length) lines.push(`- Undecoded HTML entities in the page (may explain a false drift): ${r.unknownEntities.join(" ")}`);
  if (r.capturedPath) lines.push(`- Committed capture: \`${r.capturedPath}\``);
  lines.push(`- Packs citing it: ${r.citedBy?.length ? r.citedBy.map((x) => `\`${x}\``).join(", ") : "none"}`);
  lines.push(
    "",
    "## What to do (docs/rules/README.md rules 1–2)",
    "",
    r.status === "drift"
      ? "- The upstream text or response changed since the capture. Diff the new text against the committed capture; if a passage, threshold or deadline the packs rely on changed, capture it as a NEW source/pack version (new manifest entry) and re-run the affected fixtures. Earlier versions stay."
      : "- The source could not be verified (network, HTTP status or missing section marker). Retry; if it persists, re-verify in a browser and record `method: \"browser\"` in `convex/lib/rules/verification.ts`.",
    "- Do not edit the manifest hash, the capture or any evaluator to make this pass. Until reviewed, the affected packs' sources are not current (`sourceStale` → `source_unverified`).",
    "- This file was written by `scripts/verify-rule-sources.mjs`; the script never edits logic.",
    "",
  );
  return lines.join("\n");
}

export function formatSummary({ results, manual, reviewItems }, date) {
  const rows = results.map((r) => [
    r.id, r.method, r.status.toUpperCase(), r.expected.slice(0, 12), r.actual ? r.actual.slice(0, 12) : "-", r.error ?? r.note ?? "",
  ]);
  const head = ["target", "method", "result", "expected", "actual", "note"];
  const widths = head.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((row) => String(row[i]).length))));
  const fmt = (row) => row.map((c, i) => String(c).slice(0, 60).padEnd(widths[i])).join("  ");
  const out = [`verify-rule-sources ${date}`, "", fmt(head), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt), ""];
  const count = (s) => results.filter((r) => r.status === s).length;
  out.push(`${results.length} fetched: ${count("unchanged")} unchanged, ${count("drift")} drift, ${count("error")} failed. ${manual.length} manual.`);
  if (manual.length) {
    out.push("", "MANUAL VERIFICATION (re-verify in a browser; record method \"browser\" in convex/lib/rules/verification.ts):");
    for (const m of manual) out.push(`  - ${m.id}${m.url ? ` ${m.url}` : ""}: ${m.reason}`);
  }
  if (reviewItems.length) {
    out.push("", "REVIEW ITEMS WRITTEN:");
    for (const f of reviewItems) out.push(`  - ${f}`);
  }
  // A source counts as verified only when every one of its targets was fetched
  // and unchanged and none of its parts needs a browser. The sha256 is the
  // hash that was compared: the raw-response or content hash for a single
  // target, and the capture file's capturedSha256 for a source verified
  // document by document (fr-notices), since that file records every
  // per-document hash.
  const verified = {};
  const manualSources = new Set(manual.map((m) => m.id.split("#", 1)[0]));
  for (const r of results.filter((x) => x.status === "unchanged")) {
    const key = r.sourceId;
    if (verified[key] || manualSources.has(key)) continue;
    const siblings = results.filter((x) => x.sourceId === key);
    if (!siblings.every((x) => x.status === "unchanged")) continue;
    const sha256 = siblings.length === 1 ? r.expected : r.capturedSha256;
    if (sha256) verified[key] = { lastVerifiedAt: date, sha256, method: "fetch" };
  }
  if (Object.keys(verified).length) {
    out.push("", "Suggested VERIFICATION entries (paste into convex/lib/rules/verification.ts with a DECISIONS verification entry):");
    out.push(JSON.stringify(verified, null, 2));
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Today's date in the operator's local time zone (the lead runs this by hand), YYYY-MM-DD. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseArgs(argv) {
  const args = { date: localDate(), only: [], manifest: "docs/rules/manifest.json", out: "docs/rules/review-items" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") args.date = argv[++i];
    else if (a === "--only") args.only.push(argv[++i]);
    else if (a === "--manifest") args.manifest = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error(`--date must be YYYY-MM-DD, got ${args.date}`);
  return args;
}

async function main() {
  if (process.env.CI) {
    console.error("verify-rule-sources: refusing to run in CI (on-demand only; contract §2.7).");
    process.exit(2);
  }
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(path.resolve(repoRoot, args.manifest), "utf8"));
  const summary = await verifySources({
    manifest,
    readRepoFile: (rel) => readFileSync(path.join(repoRoot, rel), "utf8"),
    fetchImpl: globalThis.fetch,
    date: args.date,
    outDir: path.resolve(repoRoot, args.out),
    only: args.only,
  });
  const shown = (f) => (f.startsWith(repoRoot + path.sep) ? path.relative(repoRoot, f) : f);
  console.log(formatSummary({ ...summary, reviewItems: summary.reviewItems.map(shown) }, args.date));
  process.exit(summary.exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
