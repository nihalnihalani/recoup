#!/usr/bin/env node
// M19 (contract §2.7, D146 R4-4, DA-A-11/23): rule-pack consistency gate.
// Runs in CI on every push and PR (`checks` job) and locally:
//   node scripts/check-rule-packs.mjs                 # base resolved automatically (below)
//   node scripts/check-rule-packs.mjs --base <rev>    # explicit base for the append-only checks
//
// CHECKS (each failure is printed; exit 1 if any):
//  1. Manifest sanity: every pack and merchant pack has a ruleId, a version
//     and a lifecycle in draft|researched|reviewed|active|superseded|withdrawn.
//  2. Captures: every `sources[].capturedPath` exists and its SHA-256 equals
//     `capturedSha256`.
//  3. Reviewed-pack immutability: a pack (or merchant pack) with lifecycle
//     >= reviewed that records `packFile` must also record `packFileSha256`,
//     and the file's SHA-256 must match. So editing a reviewed pack's code
//     fails; a change needs a new pack version file. An ACTIVE pack must
//     record both. The fixture file of a pack >= reviewed must match its
//     `fixtures` hash.
//  4. Activation (`convex/lib/rules/activation.ts`, lead-owned data):
//     `export const ACTIVATIONS: readonly { ruleId; version; status: "active"|"withdrawn"; decision }[]`.
//     The file is append-only: for a repeated (ruleId, version) the LAST
//     entry wins, and a withdrawal is appended, never edited in. For every
//     effective `active` entry:
//       - the manifest has that pack (ruleId + version) at lifecycle >= reviewed;
//       - `decision` names a DECISIONS.md entry (`- D<n> ·`) that exists and
//         whose text mentions the ruleId.
//     Every entry's `decision` must exist, including withdrawals. A manifest
//     pack marked `active` must be effectively active in ACTIVATIONS.
//     A missing file means "no active packs" and passes (M12 creates it).
//  5. Verification (`convex/lib/rules/verification.ts`, lead-owned data):
//     `export const VERIFICATION: Record<sourceId, { lastVerifiedAt; sha256; method? }>`.
//     Keys are manifest sourceIds or merchant-pack ruleIds, dates are
//     YYYY-MM-DD and not in the future, hashes are 64 hex, and method is
//     fetch|browser. A missing file passes.
//  6. Append-only, against a BASE revision:
//       - every pack or merchant pack at lifecycle >= reviewed in BASE still
//         exists, its recorded hashes (packFileSha256, contentHash,
//         passageHashes, its fixture hash, and capturedSha256 /
//         rawResponseSha256 of every source it cites) are unchanged, and its
//         lifecycle only moves forward (reviewed -> active|superseded|withdrawn,
//         active -> superseded|withdrawn);
//       - ACTIVATIONS in BASE is an exact prefix of ACTIVATIONS now: an
//         earlier entry is never removed or edited.
//     Entries still at draft/researched stay editable. The researcher
//     revises fixtures and hashes freely until review. Immutability starts
//     at `reviewed` (README rule 1; contract §2.7 "any existing manifest
//     entry with status >= reviewed").
//  7. Engine pin (DA-B-6, D190/D193; contract §2.7 "Engine versioning",
//     DA-A-23 pulled forward): every effectively ACTIVE pack's manifest entry
//     records `engineRoots` (repo paths: the pack file plus the modules that
//     build and resolve its input and the outcome/deadline engine) and
//     `engineClosureSha256`. The closure is the transitive closure of RELATIVE
//     value imports from those roots within convex/ (type-only imports are
//     erased at runtime and skipped; _generated/** and *.test.ts are never
//     followed); its hash is SHA-256 over the sorted lines
//     "<path>\t<sha256 of the file>\n". Editing any file in the closure
//     (e.g. lib/rules/outcome.ts or lib/money.ts) without recording the new
//     pin fails. `--print-engine-closure` prints each active pack's closure.
//     Re-pin protocol (D197): the entry also records `engineClosureDecision`
//     ("D###"), the lead's re-pin decision, which must exist in DECISIONS.md.
//     A lane whose change alters the closure runs the pack's fixtures
//     unchanged, asks the lead for a re-pin decision id, and updates both the
//     hash and the decision id in its own commit.
//  8. Engine epoch (D206(3), M20): every effectively ACTIVE pack's entry
//     records `engineEpoch`, a positive integer the lead controls; the runtime
//     engine version is `${ruleId}@v${version}/e${engineEpoch}`. The runtime
//     copy, `convex/lib/rules/engineEpochs.ts` (lead-controlled data, parsed
//     as a pure literal), must EQUAL the manifest: one entry per manifest
//     entry that records an epoch, with the same engineEpoch and
//     engineClosureSha256, and nothing else. Against BASE an epoch never
//     decreases, and an increase (a BEHAVIOURAL re-pin, which invalidates
//     approvals) must come with a new engineClosureDecision; a hash-only
//     re-pin keeps the epoch.
//
// BASE for check 6, first match wins:
//   a. `--base <rev>` or env RULE_PACKS_BASE. CI sets it to the push's
//      `github.event.before`, or to the PR's base SHA for a pull request, so
//      every commit in a push is covered, not just the last one.
//      An all-zero SHA (new branch) is ignored.
//   b. the merge base of HEAD and origin/main, when that is not HEAD itself.
//      This is what a lane branch changes relative to main.
//   c. HEAD~1, for a checkout sitting exactly at origin/main.
// A base missing from a shallow clone is fetched (`git fetch --depth=1
// origin <sha>`). If it still cannot be read, the check FAILS instead of
// silently skipping. A base with no manifest (before it existed) passes.
//
// PARSING: activation.ts and verification.ts are parsed with the TypeScript
// compiler's parser and never executed. Only literals are accepted (arrays,
// objects, strings, numbers, booleans, null, `as const`, `satisfies`, type
// annotations). Anything else (identifiers, spreads, calls) fails, because
// the files must stay data-only.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const LIFECYCLES = ["draft", "researched", "reviewed", "active", "superseded", "withdrawn"];
const AT_LEAST_REVIEWED = new Set(["reviewed", "active", "superseded", "withdrawn"]);
const FORWARD = {
  reviewed: ["reviewed", "active", "superseded", "withdrawn"],
  active: ["active", "superseded", "withdrawn"],
  superseded: ["superseded"],
  withdrawn: ["withdrawn"],
};
export const PATHS = {
  manifest: "docs/rules/manifest.json",
  activation: "convex/lib/rules/activation.ts",
  verification: "convex/lib/rules/verification.ts",
  engineEpochs: "convex/lib/rules/engineEpochs.ts",
  decisions: "docs/team/DECISIONS.md",
};

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Literal-only parsing of the lead-owned data files
// ---------------------------------------------------------------------------

function literalValue(node, where) {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) || ts.isTypeAssertionExpression(node)) {
    return literalValue(node.expression, where);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/g, ""));
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
    return -Number(node.operand.text.replace(/_/g, ""));
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((e) => literalValue(e, where));
  if (ts.isObjectLiteralExpression(node)) {
    const out = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p)) throw new Error(`${where}: only plain \`key: value\` properties are allowed (data-only file)`);
      const name = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
      if (name === null) throw new Error(`${where}: computed property names are not allowed (data-only file)`);
      out[name] = literalValue(p.initializer, where);
    }
    return out;
  }
  throw new Error(`${where}: \`${node.getText()}\` is not a literal (the file must be data-only)`);
}

/** Reads `export const <name> = <literal>` from TypeScript source without executing it. Returns undefined if not exported. */
export function readExportedLiteral(sourceText, exportName, fileLabel) {
  const sf = ts.createSourceFile(fileLabel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === exportName) {
        if (!d.initializer) throw new Error(`${fileLabel}: \`${exportName}\` has no initializer`);
        return literalValue(d.initializer, `${fileLabel} ${exportName}`);
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Engine closure (check 7)
// ---------------------------------------------------------------------------

/** Relative VALUE module specifiers of a TypeScript source (type-only imports/exports are skipped). */
export function relativeImports(sourceText, fileLabel) {
  const sf = ts.createSourceFile(fileLabel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = [];
  for (const st of sf.statements) {
    let spec = null;
    if (ts.isImportDeclaration(st)) {
      if (st.importClause?.isTypeOnly) continue;
      const named = st.importClause?.namedBindings;
      // `import { type A, type B } from "x"` with no default import is type-only too.
      if (st.importClause && !st.importClause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)) continue;
      spec = st.moduleSpecifier;
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      if (st.isTypeOnly) continue;
      spec = st.moduleSpecifier;
    }
    if (spec && ts.isStringLiteral(spec) && spec.text.startsWith(".")) out.push(spec.text);
  }
  return out;
}

const followable = (rel) => rel.startsWith("convex/") && !rel.startsWith("convex/_generated/") && !/\.test\.tsx?$/.test(rel);

/**
 * The engine closure of `roots` (repo-relative paths): every file reachable through relative value imports, within
 * convex/ (excluding _generated/** and tests). Returns the sorted files with their hashes and the closure hash, or
 * the missing files.
 */
export function engineClosure(roots, readRepoFile) {
  const seen = new Map();
  const missing = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel) || !followable(rel)) continue;
    const bytes = readRepoFile(rel);
    if (!bytes) {
      missing.push(rel);
      continue;
    }
    seen.set(rel, sha256Hex(bytes));
    for (const spec of relativeImports(bytes.toString("utf8"), rel)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((c) => /\.tsx?$/.test(c) && readRepoFile(c));
      if (target) queue.push(target);
      else if (followable(`${base}.ts`)) missing.push(`${base} (imported by ${rel})`);
    }
  }
  const files = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sha256 = sha256Hex(files.map(([f, h]) => `${f}\t${h}\n`).join(""));
  return { files, sha256, missing };
}

// ---------------------------------------------------------------------------
// DECISIONS.md
// ---------------------------------------------------------------------------

/** Map of decision id -> entry text, from lines `- D<n> · …` up to the next entry or heading. */
export function parseDecisions(text) {
  const map = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^- (D\d+) ·/);
    if (m) {
      current = m[1];
      map.set(current, line);
    } else if (/^#{1,6} /.test(line)) {
      current = null;
    } else if (current) {
      map.set(current, `${map.get(current)}\n${line}`);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Checks (pure: all inputs passed in)
// ---------------------------------------------------------------------------

function packEntries(manifest) {
  const out = [];
  for (const p of manifest?.packs ?? []) {
    out.push({ entry: p, key: `${p.ruleId}@${p.version}`, label: `pack ${p.ruleId} v${p.version}` });
    for (const mp of p.merchantPacks ?? []) {
      out.push({ entry: mp, key: `${mp.ruleId}@${mp.version}`, label: `merchant pack ${mp.ruleId} v${mp.version}`, parent: p });
    }
  }
  return out;
}

function recordedHashes(entry, manifest) {
  const h = {};
  if (entry.packFileSha256 !== undefined) h.packFileSha256 = entry.packFileSha256;
  if (entry.contentHash !== undefined) h.contentHash = entry.contentHash;
  if (entry.passageHashes !== undefined) h.passageHashes = JSON.stringify(entry.passageHashes);
  if (entry.fixtures) h[`fixtures ${entry.fixtures}`] = manifest.fixtures?.[entry.fixtures] ?? null;
  for (const sid of entry.sources ?? []) {
    const s = (manifest.sources ?? []).find((x) => x.sourceId === sid);
    h[`source ${sid} capturedSha256`] = s?.capturedSha256 ?? null;
    h[`source ${sid} rawResponseSha256`] = s?.rawResponseSha256 ?? null;
  }
  return h;
}

/**
 * @param {object} input
 * @param {object} input.manifest
 * @param {object|null} input.baseManifest           manifest at BASE, or null (no base / no manifest there)
 * @param {string|null} input.activationSource       activation.ts text, or null if absent
 * @param {string|null} input.baseActivationSource   activation.ts text at BASE, or null
 * @param {string|null} input.verificationSource     verification.ts text, or null if absent
 * @param {string} input.decisionsText
 * @param {(rel: string) => Buffer|null} input.readRepoFile  null when the file does not exist
 * @param {string} input.today                        YYYY-MM-DD
 * @param {string|null} [input.engineEpochsSource]   engineEpochs.ts text, or null if absent
 */
export function checkRulePacks(input) {
  const { manifest, baseManifest, activationSource, baseActivationSource, verificationSource, decisionsText, readRepoFile, today } = input;
  const errors = [];
  const notes = [];
  const packs = packEntries(manifest);

  // 1. manifest sanity
  for (const { entry, label } of packs) {
    if (typeof entry.ruleId !== "string" || !entry.ruleId) errors.push(`manifest: ${label} has no ruleId`);
    if (!LIFECYCLES.includes(entry.lifecycle)) errors.push(`manifest: ${label} has unknown lifecycle "${entry.lifecycle}"`);
    if (entry.version !== null && !Number.isInteger(entry.version)) errors.push(`manifest: ${label} version must be an integer or null`);
  }

  // 2. captures
  for (const s of manifest.sources ?? []) {
    if (!s.capturedPath) continue;
    const bytes = readRepoFile(s.capturedPath);
    if (!bytes) errors.push(`capture: ${s.sourceId}: ${s.capturedPath} does not exist`);
    else if (s.capturedSha256 && sha256Hex(bytes) !== s.capturedSha256) {
      errors.push(`capture: ${s.sourceId}: ${s.capturedPath} hashes to ${sha256Hex(bytes).slice(0, 12)}…, manifest capturedSha256 is ${s.capturedSha256.slice(0, 12)}…`);
    }
  }

  // 3. reviewed-pack immutability
  for (const { entry, label } of packs) {
    if (!AT_LEAST_REVIEWED.has(entry.lifecycle)) continue;
    const hasFile = entry.packFile !== undefined;
    const hasHash = entry.packFileSha256 !== undefined;
    if (hasFile !== hasHash) errors.push(`immutability: ${label} (${entry.lifecycle}) must record both packFile and packFileSha256`);
    if (entry.lifecycle === "active" && !(hasFile && hasHash)) errors.push(`immutability: ${label} is active but pins no code file (packFile + packFileSha256)`);
    if (hasFile && hasHash) {
      const bytes = readRepoFile(entry.packFile);
      if (!bytes) errors.push(`immutability: ${label}: pack file ${entry.packFile} does not exist`);
      else if (sha256Hex(bytes) !== entry.packFileSha256) {
        errors.push(
          `immutability: ${label} (${entry.lifecycle}): ${entry.packFile} was edited (sha256 ${sha256Hex(bytes).slice(0, 12)}… ≠ recorded ${String(entry.packFileSha256).slice(0, 12)}…). A reviewed pack never changes; write a new version file.`,
        );
      }
    }
    if (entry.fixtures) {
      const bytes = readRepoFile(entry.fixtures);
      const recorded = manifest.fixtures?.[entry.fixtures];
      if (!bytes || !recorded || sha256Hex(bytes) !== recorded) errors.push(`immutability: ${label} (${entry.lifecycle}): fixture file ${entry.fixtures} does not match its manifest hash`);
    }
  }

  // 4. activation
  const decisions = parseDecisions(decisionsText ?? "");
  let activations = [];
  if (activationSource === null) {
    notes.push(`${PATHS.activation} not present: no active packs`);
  } else {
    let raw;
    try {
      raw = readExportedLiteral(activationSource, "ACTIVATIONS", PATHS.activation);
    } catch (err) {
      errors.push(`activation: ${err.message}`);
    }
    if (raw === undefined && !errors.some((e) => e.startsWith("activation:"))) errors.push(`activation: ${PATHS.activation} has no \`export const ACTIVATIONS\``);
    if (raw !== undefined && !Array.isArray(raw)) errors.push("activation: ACTIVATIONS must be an array");
    if (Array.isArray(raw)) activations = raw;
  }
  activations.forEach((a, i) => {
    const where = `activation: ACTIVATIONS[${i}]`;
    if (typeof a?.ruleId !== "string" || !a.ruleId) errors.push(`${where} has no ruleId`);
    if (!Number.isInteger(a?.version) || a.version < 1) errors.push(`${where} version must be a positive integer`);
    if (a?.status !== "active" && a?.status !== "withdrawn") errors.push(`${where} status must be "active" or "withdrawn"`);
    if (typeof a?.decision !== "string" || !/^D\d+$/.test(a.decision)) errors.push(`${where} decision must be a DECISIONS id like "D170"`);
    else if (!decisions.has(a.decision)) errors.push(`${where} (${a.ruleId} v${a.version} ${a.status}) cites ${a.decision}, which is not in ${PATHS.decisions}`);
    const extra = Object.keys(a ?? {}).filter((k) => !["ruleId", "version", "status", "decision"].includes(k));
    if (extra.length) errors.push(`${where} has unknown keys: ${extra.join(", ")}`);
  });
  const effective = new Map();
  for (const a of activations) effective.set(`${a?.ruleId}@${a?.version}`, a);
  const active = [...effective.values()].filter((a) => a?.status === "active");
  for (const a of active) {
    const label = `activation: ${a.ruleId} v${a.version}`;
    const pack = packs.find((p) => p.key === `${a.ruleId}@${a.version}`);
    if (!pack) errors.push(`${label} is active but ${PATHS.manifest} has no pack with that ruleId and version`);
    else if (!AT_LEAST_REVIEWED.has(pack.entry.lifecycle)) errors.push(`${label} is active but its manifest lifecycle is "${pack.entry.lifecycle}" (needs >= reviewed)`);
    const text = decisions.get(a.decision);
    if (text && !text.includes(a.ruleId)) errors.push(`${label} cites ${a.decision}, whose text does not mention ${a.ruleId}`);
  }
  for (const { entry, label } of packs) {
    if (entry.lifecycle !== "active") continue;
    const eff = effective.get(`${entry.ruleId}@${entry.version}`);
    if (eff?.status !== "active") errors.push(`activation: ${label} is "active" in the manifest but not active in ${PATHS.activation}`);
  }
  if (activationSource !== null && active.length === 0) notes.push("no active packs");
  if (active.length) notes.push(`active packs: ${active.map((a) => `${a.ruleId} v${a.version} (${a.decision})`).join(", ")}`);

  // 5. verification
  if (verificationSource === null) {
    notes.push(`${PATHS.verification} not present`);
  } else {
    let v;
    try {
      v = readExportedLiteral(verificationSource, "VERIFICATION", PATHS.verification);
      if (v === undefined) errors.push(`verification: ${PATHS.verification} has no \`export const VERIFICATION\``);
    } catch (err) {
      errors.push(`verification: ${err.message}`);
    }
    if (v !== undefined && (v === null || typeof v !== "object" || Array.isArray(v))) errors.push("verification: VERIFICATION must be an object keyed by sourceId");
    else if (v) {
      const known = new Set([...(manifest.sources ?? []).map((s) => s.sourceId), ...packs.map((p) => p.entry.ruleId)]);
      for (const [key, rec] of Object.entries(v)) {
        const where = `verification: ${key}`;
        if (!known.has(key)) errors.push(`${where} is not a manifest sourceId or merchant-pack ruleId`);
        if (typeof rec?.lastVerifiedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rec.lastVerifiedAt)) errors.push(`${where} lastVerifiedAt must be YYYY-MM-DD`);
        else if (rec.lastVerifiedAt > today) errors.push(`${where} lastVerifiedAt ${rec.lastVerifiedAt} is in the future`);
        if (typeof rec?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(rec.sha256)) errors.push(`${where} sha256 must be 64 lowercase hex characters`);
        if (rec?.method !== undefined && rec.method !== "fetch" && rec.method !== "browser") errors.push(`${where} method must be "fetch" or "browser"`);
      }
    }
  }

  // 6. append-only against BASE
  if (baseManifest) {
    const now = new Map(packs.map((p) => [p.key, p]));
    for (const b of packEntries(baseManifest)) {
      if (!AT_LEAST_REVIEWED.has(b.entry.lifecycle)) continue;
      const cur = now.get(b.key);
      if (!cur) {
        errors.push(`append-only: ${b.label} was ${b.entry.lifecycle} at base and has been removed from the manifest`);
        continue;
      }
      if (!FORWARD[b.entry.lifecycle].includes(cur.entry.lifecycle)) {
        errors.push(`append-only: ${b.label} lifecycle moved backwards: ${b.entry.lifecycle} → ${cur.entry.lifecycle}`);
      }
      const before = recordedHashes(b.entry, baseManifest);
      const after = recordedHashes(cur.entry, manifest);
      for (const [k, v] of Object.entries(before)) {
        if (after[k] !== v) errors.push(`append-only: ${b.label} (${b.entry.lifecycle} at base): ${k} changed from ${String(v).slice(0, 12)}… to ${String(after[k]).slice(0, 12)}…`);
      }
    }
  } else {
    notes.push("append-only: no base manifest to compare against");
  }
  if (baseActivationSource !== null && baseActivationSource !== undefined) {
    let base;
    try {
      base = readExportedLiteral(baseActivationSource, "ACTIVATIONS", `${PATHS.activation} (base)`) ?? [];
    } catch (err) {
      errors.push(`append-only: cannot read ACTIVATIONS at base: ${err.message}`);
    }
    if (Array.isArray(base)) {
      if (activationSource === null && base.length > 0) errors.push(`append-only: ${PATHS.activation} was deleted but had ${base.length} entries at base`);
      base.forEach((entry, i) => {
        if (JSON.stringify(activations[i]) !== JSON.stringify(entry)) {
          errors.push(`append-only: ACTIVATIONS[${i}] was ${activations[i] === undefined ? "removed" : "edited"} (base: ${JSON.stringify(entry)}); append a new entry instead`);
        }
      });
    }
  }

  // 7. engine pin for every effectively active pack (DA-B-6)
  let pinned = 0;
  for (const a of active) {
    const pack = packs.find((p) => p.key === `${a.ruleId}@${a.version}`);
    if (!pack) continue; // reported by check 4
    const label = `engine pin: ${pack.label}`;
    const roots = pack.entry.engineRoots;
    const recorded = pack.entry.engineClosureSha256;
    if (!Array.isArray(roots) || roots.length === 0 || roots.some((r) => typeof r !== "string")) {
      errors.push(`${label} is active but records no engineRoots (the pack file + its snapshot builder, resolve, and the outcome/deadline engine)`);
      continue;
    }
    if (pack.entry.packFile !== undefined && !roots.includes(pack.entry.packFile)) errors.push(`${label}: engineRoots must include the pack file ${pack.entry.packFile}`);
    const closure = engineClosure(roots, readRepoFile);
    if (closure.missing.length) errors.push(`${label}: cannot read ${closure.missing.join(", ")}`);
    if (typeof recorded !== "string" || !/^[0-9a-f]{64}$/.test(recorded)) {
      errors.push(`${label} is active but records no engineClosureSha256 (current closure: ${closure.sha256}, ${closure.files.length} files)`);
    } else if (recorded !== closure.sha256) {
      errors.push(
        `${label}: closure changed: run the pack's fixtures unchanged, then ask the lead for a re-pin decision id ` +
          `(the closure of ${closure.files.length} files hashes to ${closure.sha256}, recorded ${recorded.slice(0, 12)}…; ` +
          "record the new engineClosureSha256 and engineClosureDecision together; node scripts/check-rule-packs.mjs --print-engine-closure lists the files).",
      );
    } else pinned += 1;
    const decision = pack.entry.engineClosureDecision;
    if (typeof decision !== "string" || !/^D\d+$/.test(decision)) {
      errors.push(`${label} is active but records no engineClosureDecision (the lead's re-pin decision id, e.g. "D193"; D197)`);
    } else if (!decisions.has(decision)) {
      errors.push(`${label}: engineClosureDecision ${decision} is not in ${PATHS.decisions}`);
    }
  }
  notes.push(active.length === 0 ? "engine pin: no active pack to pin" : `engine pin: ${pinned}/${active.length} active pack(s) match their recorded engine closure`);

  // 8. engine epoch (D206(3))
  const epochLabel = "engine epoch";
  for (const a of active) {
    const pack = packs.find((p) => p.key === `${a.ruleId}@${a.version}`);
    if (pack && pack.entry.engineEpoch === undefined) {
      errors.push(`${epochLabel}: ${pack.label} is active but records no engineEpoch (a positive integer; 1 for a first activation)`);
    }
  }
  const withEpoch = packs.filter((p) => p.entry.engineEpoch !== undefined);
  for (const p of withEpoch) {
    if (!Number.isInteger(p.entry.engineEpoch) || p.entry.engineEpoch < 1) errors.push(`${epochLabel}: ${p.label} engineEpoch must be a positive integer`);
  }
  const epochsSource = input.engineEpochsSource ?? null;
  let epochs = [];
  if (epochsSource === null) {
    if (withEpoch.length > 0) errors.push(`${epochLabel}: ${PATHS.engineEpochs} is missing but the manifest records ${withEpoch.length} epoch(s)`);
  } else {
    try {
      const raw = readExportedLiteral(epochsSource, "ENGINE_EPOCHS", PATHS.engineEpochs);
      if (!Array.isArray(raw)) errors.push(`${epochLabel}: ENGINE_EPOCHS must be an array`);
      else epochs = raw;
    } catch (err) {
      errors.push(`${epochLabel}: ${err.message}`);
    }
  }
  const seenEpochs = new Set();
  epochs.forEach((e, i) => {
    const where = `${epochLabel}: ENGINE_EPOCHS[${i}]`;
    const extra = Object.keys(e ?? {}).filter((k) => !["ruleId", "version", "engineEpoch", "engineClosureSha256"].includes(k));
    if (extra.length) errors.push(`${where} has unknown keys: ${extra.join(", ")}`);
    const key = `${e?.ruleId}@${e?.version}`;
    if (seenEpochs.has(key)) errors.push(`${where} repeats ${e?.ruleId} v${e?.version}`);
    seenEpochs.add(key);
    const p = withEpoch.find((x) => x.key === key);
    if (!p) {
      errors.push(`${where} (${e?.ruleId} v${e?.version}) has no manifest entry recording an engineEpoch`);
      return;
    }
    if (e.engineEpoch !== p.entry.engineEpoch) errors.push(`${where}: engineEpoch ${e.engineEpoch} ≠ manifest ${p.entry.engineEpoch} for ${p.label}`);
    if (e.engineClosureSha256 !== p.entry.engineClosureSha256) {
      errors.push(`${where}: engineClosureSha256 ${String(e.engineClosureSha256).slice(0, 12)}… ≠ manifest ${String(p.entry.engineClosureSha256).slice(0, 12)}… for ${p.label} (update both together)`);
    }
  });
  for (const p of withEpoch) {
    if (!seenEpochs.has(p.key)) errors.push(`${epochLabel}: ${p.label} records engineEpoch ${p.entry.engineEpoch} but ${PATHS.engineEpochs} has no entry for it`);
  }
  if (baseManifest) {
    const baseByKey = new Map(packEntries(baseManifest).map((b) => [b.key, b]));
    for (const p of withEpoch) {
      const b = baseByKey.get(p.key);
      const before = b?.entry.engineEpoch;
      if (before === undefined || !Number.isInteger(p.entry.engineEpoch)) continue;
      if (p.entry.engineEpoch < before) errors.push(`${epochLabel}: ${p.label} engineEpoch decreased ${before} → ${p.entry.engineEpoch}`);
      else if (p.entry.engineEpoch > before && p.entry.engineClosureDecision === b.entry.engineClosureDecision) {
        errors.push(`${epochLabel}: ${p.label} engineEpoch ${before} → ${p.entry.engineEpoch} needs a new behavioural re-pin decision (engineClosureDecision is still ${b.entry.engineClosureDecision})`);
      }
    }
  }
  if (withEpoch.length) notes.push(`engine epoch: ${withEpoch.map((p) => `${p.entry.ruleId} v${p.entry.version} e${p.entry.engineEpoch}`).join(", ")}`);

  return { errors, notes, activeCount: active.length };
}

// ---------------------------------------------------------------------------
// Git plumbing for BASE
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(repoRoot, args) {
  try {
    return git(repoRoot, args);
  } catch {
    return null;
  }
}

/** Resolves BASE (see header). Returns { rev, how } or { rev: null, how }. */
export function resolveBase(repoRoot, { explicit } = {}) {
  const fromEnv = explicit ?? process.env.RULE_PACKS_BASE ?? "";
  if (fromEnv && !/^0+$/.test(fromEnv)) return { rev: fromEnv, how: explicit ? "--base" : "RULE_PACKS_BASE" };
  const head = tryGit(repoRoot, ["rev-parse", "HEAD"]);
  const mb = tryGit(repoRoot, ["merge-base", "HEAD", "origin/main"]);
  if (mb && mb !== head) return { rev: mb, how: "merge-base HEAD origin/main" };
  const parent = tryGit(repoRoot, ["rev-parse", "HEAD~1"]);
  if (parent) return { rev: parent, how: "HEAD~1" };
  return { rev: null, how: "no parent commit" };
}

/** File contents at `rev`, fetching the commit if a shallow clone lacks it. `undefined` = the rev cannot be read; `null` = the file did not exist there. */
export function readAtRev(repoRoot, rev, rel) {
  const has = () => tryGit(repoRoot, ["cat-file", "-e", `${rev}^{commit}`]) !== null;
  if (!has()) tryGit(repoRoot, ["fetch", "--no-tags", "--depth=1", "origin", rev]);
  if (!has()) return undefined;
  try {
    return execFileSync("git", ["show", `${rev}:${rel}`], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Local YYYY-MM-DD (a lastVerifiedAt written today in the lead's zone is not "in the future"). */
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const argv = process.argv.slice(2);
  const baseIdx = argv.indexOf("--base");
  const explicit = baseIdx >= 0 ? argv[baseIdx + 1] : undefined;
  const readText = (rel) => (existsSync(path.join(repoRoot, rel)) ? readFileSync(path.join(repoRoot, rel), "utf8") : null);

  const base = resolveBase(repoRoot, { explicit });
  const errors = [];
  let baseManifest = null;
  let baseActivationSource = null;
  if (base.rev) {
    const m = readAtRev(repoRoot, base.rev, PATHS.manifest);
    if (m === undefined) errors.push(`append-only: base ${base.rev} (${base.how}) cannot be read, even after fetching it`);
    else if (m !== null) baseManifest = JSON.parse(m);
    const a = m === undefined ? null : readAtRev(repoRoot, base.rev, PATHS.activation);
    baseActivationSource = a ?? null;
  }

  const result = checkRulePacks({
    manifest: JSON.parse(readText(PATHS.manifest)),
    baseManifest,
    activationSource: readText(PATHS.activation),
    baseActivationSource,
    verificationSource: readText(PATHS.verification),
    decisionsText: readText(PATHS.decisions) ?? "",
    readRepoFile: (rel) => (existsSync(path.join(repoRoot, rel)) ? readFileSync(path.join(repoRoot, rel)) : null),
    today: localDate(),
    engineEpochsSource: readText(PATHS.engineEpochs),
  });
  errors.push(...result.errors);

  if (argv.includes("--print-engine-closure")) {
    const manifest = JSON.parse(readText(PATHS.manifest));
    const readRepoFile = (rel) => (existsSync(path.join(repoRoot, rel)) ? readFileSync(path.join(repoRoot, rel)) : null);
    for (const p of packEntries(manifest)) {
      if (!Array.isArray(p.entry.engineRoots)) continue;
      const c = engineClosure(p.entry.engineRoots, readRepoFile);
      console.log(`${p.label}: engineClosureSha256 ${c.sha256} (${c.files.length} files)`);
      for (const [f, h] of c.files) console.log(`  ${h}  ${f}`);
      for (const m of c.missing) console.log(`  MISSING ${m}`);
    }
    return;
  }
  console.log(`[check-rule-packs] base: ${base.rev ? `${base.rev.slice(0, 12)} (${base.how})` : base.how}`);
  for (const n of result.notes) console.log(`[check-rule-packs] ${n}`);
  if (errors.length) {
    for (const e of errors) console.error(`[check-rule-packs] FAIL ${e}`);
    console.error(`[check-rule-packs] FAILED - ${errors.length} problem(s).`);
    process.exit(1);
  }
  console.log("[check-rule-packs] OK");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
