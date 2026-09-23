// @vitest-environment node
/**
 * M19: unit tests for scripts/check-rule-packs.mjs on fixture manifests
 * (in memory, plus one throwaway git repo for BASE resolution). The live
 * repository is checked last, and must pass with "no active packs" until
 * M12/M18 land activation.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkRulePacks,
  engineClosure,
  parseDecisions,
  readAtRev,
  readExportedLiteral,
  resolveBase,
} from "../../scripts/check-rule-packs.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const PACK_FILE = "convex/lib/rules/r09_example_v1.ts";
const PACK_SRC = "export const pack = { ruleId: 'R09.example', version: 1 };\n";
const FIXTURES = "docs/rules/fixtures/R09.json";
const FIXTURES_SRC = '{"cases":[]}\n';
const CAPTURE = "docs/rules/sources/example.txt";
const CAPTURE_SRC = "# URL: https://example.gov/x\ncaptured text\n";
/** The engine pin of a closure (check 7): SHA-256 over sorted "<path>\t<sha256>\n" lines, computed here by hand. */
const pinOf = (entries: Array<[string, string]>) => sha([...entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, src]) => `${f}\t${sha(src)}\n`).join(""));

type Manifest = {
  packs: Array<Record<string, unknown>>;
  sources: Array<Record<string, unknown>>;
  fixtures: Record<string, string>;
};

function manifest(lifecycle = "reviewed", extra: Record<string, unknown> = {}): Manifest {
  return {
    packs: [
      {
        ruleId: "R09.example",
        scenarioId: "R09",
        version: 1,
        lifecycle,
        fixtures: FIXTURES,
        sources: ["example-src"],
        packFile: PACK_FILE,
        packFileSha256: sha(PACK_SRC),
        // DA-B-6: an active pack pins its engine closure (here: the pack file alone, it imports nothing).
        engineRoots: [PACK_FILE],
        engineClosureSha256: pinOf([[PACK_FILE, PACK_SRC]]),
        engineClosureDecision: "D170", // D197: the lead's re-pin decision
        engineEpoch: 1, // D206(3): the runtime engine epoch
        ...extra,
      },
      { ruleId: "R08.draft", scenarioId: "R08", version: 1, lifecycle: "researched", fixtures: null, sources: [] },
    ],
    sources: [{ sourceId: "example-src", capturedPath: CAPTURE, capturedSha256: sha(CAPTURE_SRC), rawResponseSha256: sha("raw") }],
    fixtures: { [FIXTURES]: sha(FIXTURES_SRC) },
  };
}

const DECISIONS = [
  "## Mission 2",
  "- D170 · **R09.example v1 activated.** Reviewed by M27; the lead records activation.",
  "- D171 · **Something else entirely.**",
  "- D172 · **R09.example v1 withdrawn** (source changed).",
].join("\n");

function activation(entries: Array<Record<string, unknown>>): string {
  return [
    "export type Activation = { ruleId: string; version: number; status: \"active\" | \"withdrawn\"; decision: string };",
    `export const ACTIVATIONS: readonly Activation[] = ${JSON.stringify(entries, null, 2)};`,
    "",
  ].join("\n");
}

const ACTIVE = { ruleId: "R09.example", version: 1, status: "active", decision: "D170" };

function files(overrides: Record<string, string | null> = {}) {
  const map: Record<string, string | null> = { [PACK_FILE]: PACK_SRC, [FIXTURES]: FIXTURES_SRC, [CAPTURE]: CAPTURE_SRC, ...overrides };
  return (rel: string) => (map[rel] === null || map[rel] === undefined ? null : Buffer.from(map[rel] as string));
}

/** engineEpochs.ts text (D206(3)): by default the exact mirror of the manifest's epoch entries. */
function epochsFile(entries: Array<Record<string, unknown>>): string {
  return [
    "export type EngineEpoch = { ruleId: string; version: number; engineEpoch: number; engineClosureSha256: string };",
    `export const ENGINE_EPOCHS: readonly EngineEpoch[] = ${JSON.stringify(entries, null, 2)};`,
    "",
  ].join("\n");
}
const mirrorOf = (m: Manifest) =>
  epochsFile(m.packs.filter((p) => p.engineEpoch !== undefined).map((p) => ({
    ruleId: p.ruleId, version: p.version, engineEpoch: p.engineEpoch, engineClosureSha256: p.engineClosureSha256,
  })));

function run(opts: Partial<Parameters<typeof checkRulePacks>[0]> = {}) {
  const m = (opts.manifest as Manifest | undefined) ?? manifest();
  return checkRulePacks({
    manifest: m,
    baseManifest: null,
    activationSource: null,
    baseActivationSource: null,
    verificationSource: null,
    decisionsText: DECISIONS,
    readRepoFile: files(),
    today: "2026-09-23",
    engineEpochsSource: mirrorOf(m),
    ...opts,
  });
}

describe("check-rule-packs: activation", () => {
  it("passes with 'no active packs' when activation.ts does not exist (before M12)", () => {
    const r = run();
    expect(r.errors).toEqual([]);
    expect(r.activeCount).toBe(0);
    expect(r.notes.join("\n")).toMatch(/activation\.ts not present: no active packs/);
    expect(r.notes.join("\n")).toMatch(/engine pin: no active pack to pin/);
  });

  it("passes with 'no active packs' for an empty ACTIVATIONS array", () => {
    const r = run({ activationSource: activation([]) });
    expect(r.errors).toEqual([]);
    expect(r.notes).toContain("no active packs");
  });

  it("accepts a consistent activation: reviewed manifest pack, pinned pack file, DECISIONS entry naming the ruleId", () => {
    const r = run({ activationSource: activation([ACTIVE]) });
    expect(r.errors).toEqual([]);
    expect(r.activeCount).toBe(1);
  });

  it("fails when the cited DECISIONS id does not exist, or its text does not mention the ruleId", () => {
    expect(run({ activationSource: activation([{ ...ACTIVE, decision: "D999" }]) }).errors.join("\n")).toMatch(/cites D999, which is not in docs\/team\/DECISIONS\.md/);
    expect(run({ activationSource: activation([{ ...ACTIVE, decision: "D171" }]) }).errors.join("\n")).toMatch(/cites D171, whose text does not mention R09\.example/);
  });

  it("fails when the manifest pack is missing or below reviewed", () => {
    expect(run({ activationSource: activation([{ ...ACTIVE, version: 2 }]) }).errors.join("\n")).toMatch(/no pack with that ruleId and version/);
    expect(run({ manifest: manifest("researched"), activationSource: activation([ACTIVE]) }).errors.join("\n")).toMatch(/lifecycle is "researched" \(needs >= reviewed\)/);
  });

  it("fails when the manifest says active but activation.ts does not (and passes when both agree)", () => {
    expect(run({ manifest: manifest("active"), activationSource: activation([]) }).errors.join("\n")).toMatch(/"active" in the manifest but not active/);
    expect(run({ manifest: manifest("active"), activationSource: activation([ACTIVE]) }).errors).toEqual([]);
  });

  it("the last entry for a (ruleId, version) wins: an appended withdrawal deactivates", () => {
    const r = run({ activationSource: activation([ACTIVE, { ...ACTIVE, status: "withdrawn", decision: "D172" }]) });
    expect(r.errors).toEqual([]);
    expect(r.activeCount).toBe(0);
  });

  it("rejects malformed entries and non-literal (executable) content", () => {
    expect(run({ activationSource: activation([{ ...ACTIVE, status: "on" }]) }).errors.join("\n")).toMatch(/status must be "active" or "withdrawn"/);
    expect(run({ activationSource: activation([{ ...ACTIVE, decision: "170" }]) }).errors.join("\n")).toMatch(/decision must be a DECISIONS id/);
    expect(run({ activationSource: activation([{ ...ACTIVE, reviewer: "x" }]) }).errors.join("\n")).toMatch(/unknown keys: reviewer/);
    expect(run({ activationSource: "export const ACTIVATIONS = [...OTHER];" }).errors.join("\n")).toMatch(/is not a literal/);
    expect(run({ activationSource: "export const ACTIVATIONS = load();" }).errors.join("\n")).toMatch(/is not a literal/);
    expect(run({ activationSource: "export const OTHER = [];" }).errors.join("\n")).toMatch(/has no `export const ACTIVATIONS`/);
  });
});

describe("check-rule-packs: reviewed-pack immutability", () => {
  it("fails when a reviewed pack's code file was edited", () => {
    const r = run({ readRepoFile: files({ [PACK_FILE]: `${PACK_SRC}// tweak\n` }) });
    expect(r.errors.join("\n")).toMatch(/r09_example_v1\.ts was edited .* A reviewed pack never changes/);
  });

  it("fails when the pinned pack file is missing, or only one of packFile/packFileSha256 is recorded", () => {
    expect(run({ readRepoFile: files({ [PACK_FILE]: null }) }).errors.join("\n")).toMatch(/pack file .* does not exist/);
    expect(run({ manifest: manifest("reviewed", { packFileSha256: undefined }) }).errors.join("\n")).toMatch(/must record both packFile and packFileSha256/);
  });

  it("requires an active pack to pin its code file; a reviewed pack without code yet is allowed", () => {
    const noFile = { packFile: undefined, packFileSha256: undefined };
    expect(run({ manifest: manifest("reviewed", noFile) }).errors).toEqual([]);
    expect(run({ manifest: manifest("active", noFile), activationSource: activation([ACTIVE]) }).errors.join("\n")).toMatch(/is active but pins no code file/);
  });

  it("fails when a reviewed pack's fixture file no longer matches its manifest hash", () => {
    expect(run({ readRepoFile: files({ [FIXTURES]: '{"cases":[1]}\n' }) }).errors.join("\n")).toMatch(/fixture file .* does not match its manifest hash/);
  });

  it("does not pin a researched pack's files", () => {
    const r = run({ manifest: manifest("researched"), readRepoFile: files({ [PACK_FILE]: "edited", [FIXTURES]: "edited" }) });
    expect(r.errors).toEqual([]);
  });

  it("fails when a capture file does not match capturedSha256", () => {
    expect(run({ readRepoFile: files({ [CAPTURE]: `${CAPTURE_SRC}edited\n` }) }).errors.join("\n")).toMatch(/capture: example-src: .* hashes to/);
  });
});

describe("check-rule-packs: append-only against BASE", () => {
  it("fails when a reviewed entry's recorded hash changes (code file re-pinned to a new hash)", () => {
    const edited = `${PACK_SRC}// v1 edited in place\n`;
    const r = run({
      baseManifest: manifest(),
      manifest: manifest("reviewed", { packFileSha256: sha(edited) }),
      readRepoFile: files({ [PACK_FILE]: edited }),
    });
    expect(r.errors.join("\n")).toMatch(/append-only: pack R09\.example v1 \(reviewed at base\): packFileSha256 changed/);
  });

  it("fails when a source cited by a reviewed pack gets a new hash, or the entry is removed or moves backwards", () => {
    const base = manifest();
    const cur = manifest();
    cur.sources[0].rawResponseSha256 = sha("raw v2");
    expect(run({ baseManifest: base, manifest: cur }).errors.join("\n")).toMatch(/source example-src rawResponseSha256 changed/);

    const removed = manifest();
    removed.packs = removed.packs.filter((p) => p.ruleId !== "R09.example");
    expect(run({ baseManifest: base, manifest: removed }).errors.join("\n")).toMatch(/was reviewed at base and has been removed/);

    expect(run({ baseManifest: base, manifest: manifest("researched") }).errors.join("\n")).toMatch(/lifecycle moved backwards: reviewed → researched/);
  });

  it("allows forward lifecycle moves, new entries, and any change to entries still at draft/researched", () => {
    const base = manifest();
    const cur = manifest("active");
    cur.packs.push({ ruleId: "R09.example", scenarioId: "R09", version: 2, lifecycle: "researched", fixtures: null, sources: [] });
    cur.packs[1] = { ...cur.packs[1], fixtures: "docs/rules/fixtures/R08.json" };
    cur.fixtures["docs/rules/fixtures/R08.json"] = sha("new researched fixture");
    expect(run({ baseManifest: base, manifest: cur, activationSource: activation([ACTIVE]) }).errors).toEqual([]);

    const researchedBase = manifest("researched");
    const rehashed = manifest("researched");
    rehashed.fixtures[FIXTURES] = sha("revised by the researcher");
    expect(run({ baseManifest: researchedBase, manifest: rehashed }).errors).toEqual([]);
  });

  it("ACTIVATIONS is append-only: editing or removing an earlier entry fails; appending passes", () => {
    const base = activation([ACTIVE]);
    const withdrawn = { ...ACTIVE, status: "withdrawn", decision: "D172" };
    expect(run({ baseActivationSource: base, activationSource: activation([ACTIVE, withdrawn]) }).errors).toEqual([]);
    expect(run({ baseActivationSource: base, activationSource: activation([withdrawn]) }).errors.join("\n")).toMatch(/ACTIVATIONS\[0\] was edited/);
    expect(run({ baseActivationSource: base, activationSource: activation([]) }).errors.join("\n")).toMatch(/ACTIVATIONS\[0\] was removed/);
    expect(run({ baseActivationSource: base, activationSource: null }).errors.join("\n")).toMatch(/was deleted but had 1 entries at base/);
  });
});

describe("check-rule-packs: engine pin (DA-B-6, D190/D193)", () => {
  const ENGINE = "convex/lib/rules/outcome_example.ts";
  const ENGINE_SRC = 'import { money } from "../money_example";\nimport type { T } from "./types_example";\nexport const rule = 1;\n';
  const MONEY = "convex/lib/money_example.ts";
  const MONEY_SRC = 'import { cap } from "../limits_example";\nimport { v } from "convex/values";\nexport const money = cap;\n';
  const LIMITS = "convex/limits_example.ts";
  const LIMITS_SRC = "export const cap = 100;\n";
  const TYPES = "convex/lib/rules/types_example.ts";
  const PACK_WITH_ENGINE = 'import { rule } from "./outcome_example";\nimport "../../_generated/api";\nexport const pack = rule;\n';
  const closureFiles = { [PACK_FILE]: PACK_WITH_ENGINE, [ENGINE]: ENGINE_SRC, [MONEY]: MONEY_SRC, [LIMITS]: LIMITS_SRC, [TYPES]: "export type T = 1;\n", "convex/_generated/api.ts": "export const api = 1;\n" };
  const pinned = pinOf([[PACK_FILE, PACK_WITH_ENGINE], [ENGINE, ENGINE_SRC], [MONEY, MONEY_SRC], [LIMITS, LIMITS_SRC]]);
  const activeWith = (extra: Record<string, unknown>, fileOverrides: Record<string, string | null> = {}) =>
    run({
      manifest: manifest("reviewed", { packFileSha256: sha(PACK_WITH_ENGINE), engineRoots: [PACK_FILE, ENGINE], engineClosureSha256: pinned, ...extra }),
      activationSource: activation([ACTIVE]),
      readRepoFile: files({ ...closureFiles, ...fileOverrides }),
    });

  it("follows relative VALUE imports within convex/ transitively; skips type-only imports, packages and _generated", () => {
    const c = engineClosure([PACK_FILE], files(closureFiles));
    expect(c.files.map(([f]) => f)).toEqual([MONEY, ENGINE, PACK_FILE, LIMITS].sort());
    expect(c.sha256).toBe(pinned);
    expect(c.missing).toEqual([]);
  });

  it("an active pack whose engine closure matches its pin passes", () => {
    const r = activeWith({});
    expect(r.errors).toEqual([]);
    expect(r.notes.join("\n")).toMatch(/engine pin: 1\/1 active pack\(s\) match/);
  });

  it("editing ANY file in the closure (the engine, lib/money, limits) without a new pin fails", () => {
    for (const [file, src] of [[ENGINE, `${ENGINE_SRC}// tweak\n`], [MONEY, `${MONEY_SRC}// tweak\n`], [LIMITS, "export const cap = 101;\n"]] as const) {
      expect(activeWith({}, { [file]: src }).errors.join("\n"), file).toMatch(
        /engine pin: pack R09\.example v1: closure changed: run the pack's fixtures unchanged, then ask the lead for a re-pin decision id/,
      );
    }
    // A type-only dependency is erased at runtime and not pinned.
    expect(activeWith({}, { [TYPES]: "export type T = 2;\n" }).errors).toEqual([]);
  });

  it("an active pack must record engineRoots (including its pack file) and engineClosureSha256", () => {
    expect(activeWith({ engineRoots: undefined }).errors.join("\n")).toMatch(/records no engineRoots/);
    expect(activeWith({ engineRoots: [ENGINE] }).errors.join("\n")).toMatch(/engineRoots must include the pack file/);
    expect(activeWith({ engineClosureSha256: undefined }).errors.join("\n")).toMatch(/records no engineClosureSha256 \(current closure: [0-9a-f]{64}, 4 files\)/);
    expect(activeWith({}, { [MONEY]: null }).errors.join("\n")).toMatch(/cannot read convex\/lib\/money_example/);
  });

  it("D197: an active pack records its re-pin decision (engineClosureDecision), which must exist in DECISIONS", () => {
    expect(activeWith({ engineClosureDecision: undefined }).errors.join("\n")).toMatch(/records no engineClosureDecision/);
    expect(activeWith({ engineClosureDecision: "193" }).errors.join("\n")).toMatch(/records no engineClosureDecision/);
    expect(activeWith({ engineClosureDecision: "D999" }).errors.join("\n")).toMatch(/engineClosureDecision D999 is not in docs\/team\/DECISIONS\.md/);
    expect(activeWith({ engineClosureDecision: "D171" }).errors).toEqual([]);
  });

  it("a reviewed pack that is not active needs no pin", () => {
    expect(run({ manifest: manifest("reviewed", { engineRoots: undefined, engineClosureSha256: undefined }) }).errors).toEqual([]);
  });
});

describe("check-rule-packs: engine epoch (D206(3), M20)", () => {
  const PIN = pinOf([[PACK_FILE, PACK_SRC]]);
  const activeRun = (m: Manifest, extra: Partial<Parameters<typeof checkRulePacks>[0]> = {}) =>
    run({ manifest: m, activationSource: activation([ACTIVE]), ...extra });

  it("an active pack records engineEpoch, and engineEpochs.ts mirrors the manifest exactly", () => {
    expect(activeRun(manifest()).errors).toEqual([]);
    expect(activeRun(manifest()).notes.join("\n")).toMatch(/engine epoch: R09\.example v1 e1/);
    expect(activeRun(manifest("reviewed", { engineEpoch: undefined })).errors.join("\n")).toMatch(/is active but records no engineEpoch/);
    expect(activeRun(manifest("reviewed", { engineEpoch: 0 })).errors.join("\n")).toMatch(/engineEpoch must be a positive integer/);
  });

  it("drift between engineEpochs.ts and the manifest fails: epoch, hash, a missing or an extra entry, a missing file", () => {
    const m = manifest();
    const bad = (entries: Array<Record<string, unknown>>) => activeRun(m, { engineEpochsSource: epochsFile(entries) }).errors.join("\n");
    expect(bad([{ ruleId: "R09.example", version: 1, engineEpoch: 2, engineClosureSha256: PIN }])).toMatch(/engineEpoch 2 ≠ manifest 1/);
    expect(bad([{ ruleId: "R09.example", version: 1, engineEpoch: 1, engineClosureSha256: "0".repeat(64) }])).toMatch(/engineClosureSha256 000000000000… ≠ manifest/);
    expect(bad([])).toMatch(/records engineEpoch 1 but convex\/lib\/rules\/engineEpochs\.ts has no entry/);
    expect(bad([
      { ruleId: "R09.example", version: 1, engineEpoch: 1, engineClosureSha256: PIN },
      { ruleId: "R08.draft", version: 1, engineEpoch: 1, engineClosureSha256: PIN },
    ])).toMatch(/R08\.draft v1\) has no manifest entry recording an engineEpoch/);
    expect(activeRun(m, { engineEpochsSource: null }).errors.join("\n")).toMatch(/engineEpochs\.ts is missing/);
    expect(activeRun(m, { engineEpochsSource: "export const ENGINE_EPOCHS = makeEpochs();\n" }).errors.join("\n")).toMatch(/engine epoch:/);
  });

  it("against BASE: an epoch never decreases; a bump needs a new (behavioural) decision; a hash-only re-pin keeps it", () => {
    const base = manifest("reviewed", { engineEpoch: 2 });
    expect(activeRun(manifest("reviewed", { engineEpoch: 1 }), { baseManifest: base }).errors.join("\n")).toMatch(/engineEpoch decreased 2 → 1/);
    expect(activeRun(manifest("reviewed", { engineEpoch: 3 }), { baseManifest: base }).errors.join("\n")).toMatch(/needs a new behavioural re-pin decision/);
    expect(activeRun(manifest("reviewed", { engineEpoch: 3, engineClosureDecision: "D171" }), { baseManifest: base }).errors).toEqual([]);
    expect(activeRun(manifest("reviewed", { engineEpoch: 2, engineClosureDecision: "D171" }), { baseManifest: base }).errors).toEqual([]);
  });
});

describe("check-rule-packs: verification.ts", () => {
  const good = { lastVerifiedAt: "2026-09-23", sha256: sha("x"), method: "fetch" };
  const src = (v: Record<string, unknown>) => `export const VERIFICATION = ${JSON.stringify(v)} as const;\n`;

  it("accepts entries keyed by manifest sourceIds with valid dates, hashes and methods", () => {
    expect(run({ verificationSource: src({ "example-src": good }) }).errors).toEqual([]);
  });

  it("rejects unknown keys, future dates, bad hashes and methods", () => {
    const errs = run({
      verificationSource: src({
        "no-such-source": good,
        "example-src": { lastVerifiedAt: "2026-09-24", sha256: "abc", method: "guess" },
      }),
    }).errors.join("\n");
    expect(errs).toMatch(/no-such-source is not a manifest sourceId/);
    expect(errs).toMatch(/2026-09-24 is in the future/);
    expect(errs).toMatch(/sha256 must be 64 lowercase hex/);
    expect(errs).toMatch(/method must be "fetch" or "browser"/);
  });
});

describe("check-rule-packs: parsing helpers", () => {
  it("reads literal exports through `as const`, annotations and satisfies, without executing anything", () => {
    const text = 'export const A: readonly { x: number }[] = [{ x: 1 }, { x: -2 }] as const;\nexport const B = { "k": [true, null, `t`] } satisfies object;\n';
    expect(readExportedLiteral(text, "A", "t.ts")).toEqual([{ x: 1 }, { x: -2 }]);
    expect(readExportedLiteral(text, "B", "t.ts")).toEqual({ k: [true, null, "t"] });
    expect(readExportedLiteral(text, "C", "t.ts")).toBeUndefined();
    expect(() => readExportedLiteral("export const A = { [k]: 1 };", "A", "t.ts")).toThrow(/computed property names/);
  });

  it("parses DECISIONS entries up to the next entry or heading", () => {
    const d = parseDecisions("## H\n- D1 · one\n  continued\n- D2 · two\n## Next\ntext");
    expect(d.get("D1")).toBe("- D1 · one\n  continued");
    expect(d.get("D2")).toBe("- D2 · two");
  });
});

describe("check-rule-packs: BASE resolution in a real git repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recoup-m19-git-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const g = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  it("uses HEAD~1 without origin/main, honours an explicit base, and reads files at a revision", () => {
    g("init", "-q");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "t");
    writeFileSync(path.join(dir, "m.json"), '{"v":1}');
    g("add", "m.json");
    g("commit", "-q", "-m", "one");
    const first = g("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "m.json"), '{"v":2}');
    g("commit", "-q", "-am", "two");

    expect(resolveBase(dir, {})).toEqual({ rev: first, how: "HEAD~1" });
    expect(resolveBase(dir, { explicit: "abc123" })).toEqual({ rev: "abc123", how: "--base" });
    expect(resolveBase(dir, { explicit: "0000000000000000000000000000000000000000" }).how).toBe("HEAD~1");
    expect(readAtRev(dir, first, "m.json")).toBe('{"v":1}');
    expect(readAtRev(dir, first, "missing.json")).toBeNull();
    expect(readAtRev(dir, "f".repeat(40), "m.json")).toBeUndefined();
  });
});

describe("deploy gate (DA-B-6, D191)", () => {
  it("deploy:dev runs check-rule-packs, typecheck and the tests before `convex dev --once`; no script runs `convex deploy`", async () => {
    const { readFileSync } = await import("node:fs");
    const scripts = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).scripts as Record<string, string>;
    const steps = scripts["deploy:dev"].split("&&").map((x) => x.trim());
    expect(steps).toEqual(["node scripts/check-rule-packs.mjs", "npm run typecheck", "vitest run", "convex dev --once"]);
    for (const [name, cmd] of Object.entries(scripts)) expect(cmd, name).not.toMatch(/convex\s+deploy/);
  });
});

describe("check-rule-packs: this repository", () => {
  it("the CLI passes on the current tree", () => {
    const res = spawnSync(process.execPath, ["scripts/check-rule-packs.mjs"], { cwd: REPO_ROOT, encoding: "utf8" });
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/\[check-rule-packs\] OK/);
  });
});
