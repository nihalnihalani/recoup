/**
 * M08: unit tests for `ruleFixtures.loader.ts` against all four committed
 * fixture files (R02–R05) and against synthetic documents for every failure
 * mode. Runs in the suite default (edge-runtime) on purpose, because the
 * evaluator tests that consume the loader run there too.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_OUTCOMES,
  FIXTURE_OUTCOME_ALIASES,
  REPO_ROOT,
  RuleFixtureError,
  fixtureRelPath,
  loadAllRuleFixtures,
  loadRuleFixtureFile,
  missingFactsWithValues,
  missingRequiredCategories,
  moneyWithoutCurrency,
  parseRuleFixtureDocument,
  readRulesManifest,
  sha256Hex,
  verifyFixtureHash,
  type RuleFixtureCase,
  type RuleFixtureFile,
} from "./ruleFixtures.loader";

const SCENARIOS = ["R02", "R03", "R04", "R05"] as const;

function byId(file: RuleFixtureFile, id: string): RuleFixtureCase {
  const found = file.cases.find((c) => c.id === id);
  if (!found) throw new Error(`${file.scenario}: no runnable fixture ${id}`);
  return found;
}

function outcomesOf(c: RuleFixtureCase): string[] {
  return c.expected.outcome !== undefined ? [c.expected.outcome] : c.expected.results.map((r) => r.outcome);
}

// ---------------------------------------------------------------------------
// The committed files
// ---------------------------------------------------------------------------

describe("rule fixtures: committed files (docs/rules/fixtures)", () => {
  it("loads every manifest-registered file (hash-checked), and only R02–R05 are registered today", () => {
    const files = loadAllRuleFixtures();
    expect(files.map((f) => f.scenario)).toEqual([...SCENARIOS]);
    const manifest = readRulesManifest();
    for (const f of files) expect(f.sha256).toBe(manifest.fixtures[f.relPath]);
  });

  describe.each(SCENARIOS)("%s", (scenario) => {
    const file = loadRuleFixtureFile(scenario);

    it("agrees with its manifest pack (ruleId, version, spec)", () => {
      const pack = readRulesManifest().packs.find((p) => p.fixtures === fixtureRelPath(scenario));
      expect(pack?.ruleId).toBe(file.ruleId);
      expect(pack?.version).toBe(file.ruleVersion);
      expect(pack?.spec).toBe(file.spec);
      expect(file.ruleId.startsWith(`${scenario}.`)).toBe(true);
    });

    it("has at least 12 hand-written cases and at least one runnable fixture per case", () => {
      expect(file.sourceCaseCount).toBeGreaterThanOrEqual(12);
      expect(new Set(file.cases.map((c) => c.caseId)).size).toBe(file.sourceCaseCount);
      expect(file.cases.length).toBeGreaterThanOrEqual(file.sourceCaseCount);
    });

    it("covers every mission §17 category group", () => {
      expect(missingRequiredCategories(file)).toEqual([]);
    });

    it("gives every runnable fixture a unique id, an offset clock, a finite now, facts, and contract outcomes only", () => {
      expect(new Set(file.cases.map((c) => c.id)).size).toBe(file.cases.length);
      for (const c of file.cases) {
        expect(c.clock, c.id).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
        expect(c.now, c.id).toBe(Date.parse(c.clock));
        expect(Number.isFinite(c.now), c.id).toBe(true);
        expect(Object.keys(c.facts).length, c.id).toBeGreaterThan(0);
        for (const o of outcomesOf(c)) expect(CONTRACT_OUTCOMES as readonly string[], c.id).toContain(o);
      }
    });

    it("never leaks the mission's long outcome name past the loader", () => {
      const json = JSON.stringify(file.cases.map((c) => c.expected));
      expect(json).not.toContain("likely_eligible_missing_evidence");
    });

    it("returns deep-frozen fixtures (a test cannot mutate another test's facts)", () => {
      const first = file.cases[0];
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.facts)).toBe(true);
      expect(Object.isFrozen(Object.values(first.facts)[0])).toBe(true);
      expect(Object.isFrozen(first.expected)).toBe(true);
    });
  });

  describe("resolution semantics on real cases", () => {
    const r02 = loadRuleFixtureFile("R02");
    const r04 = loadRuleFixtureFile("R04");
    const r05 = loadRuleFixtureFile("R05");

    it("facts_from + empty facts_override copies the referenced case's facts; case-level source applies (R02-11 ← R02-01)", () => {
      const base = byId(r02, "R02-01");
      const stale = byId(r02, "R02-11");
      expect(stale.facts).toEqual(base.facts);
      expect(base.source).toBeNull();
      expect(stale.source).toEqual({ last_verified_on: "2026-07-01", refresh_window_days: 30 });
      expect(stale.expected.outcome).toBe("source_unverified");
    });

    it("a case without top-level expected is not runnable; its variants are, with `change` applied over facts_from (R04-02)", () => {
      expect(r04.cases.some((c) => c.id === "R04-02")).toBe(false);
      const ids = r04.cases.filter((c) => c.caseId === "R04-02").map((c) => c.id);
      expect(ids).toEqual(["R04-02a", "R04-02b", "R04-02c"]);
      const origin = byId(r04, "R04-01");
      const v = byId(r04, "R04-02b");
      expect(v.variantId).toBe("R04-02b");
      expect(v.clock).toBe("2026-09-23T12:00:00-07:00"); // inherited from the case
      expect(v.facts.bag_delivered_or_picked_up_at.value).toBe("2026-09-13T09:40:00-07:00");
      const { bag_delivered_or_picked_up_at: _changed, ...rest } = v.facts;
      const { bag_delivered_or_picked_up_at: _original, ...originRest } = origin.facts;
      expect(rest).toEqual(originRest);
      expect(v.annotations.delay).toBe("12h00m");
    });

    it("variant clocks override the case clock (R05-05 has no case clock; R05-04c overrides R05-04's)", () => {
      expect(r05.cases.some((c) => c.id === "R05-05")).toBe(false);
      expect(byId(r05, "R05-05a").clock).toBe("2026-08-30T12:00:00-04:00");
      expect(byId(r05, "R05-05c").now).toBe(Date.parse("2026-09-01T09:00:00-04:00"));
      const base = byId(r05, "R05-04");
      const later = byId(r05, "R05-04c");
      expect(base.clock).toBe("2026-10-12T12:00:00-04:00");
      expect(later.clock).toBe("2026-10-05T12:00:00-04:00");
      expect(later.facts).toEqual(base.facts); // `change: {}`
    });

    it("variant source and clock both override (R02-10b)", () => {
      const v = byId(r02, "R02-10b");
      expect(v.source).toEqual({ last_verified_on: "2026-09-23", refresh_window_days: 30 });
      expect(v.clock).toBe("2027-07-08T12:00:00-04:00");
      expect(byId(r02, "R02-10").source).toBeNull();
    });

    it("maps likely_eligible_missing_evidence → likely_eligible and keeps the original wording (R04-04)", () => {
      const c = byId(r04, "R04-04");
      expect(c.expected.outcome).toBe("likely_eligible");
      expect((c.expectedAsWritten as { outcome: string }).outcome).toBe("likely_eligible_missing_evidence");
    });

    it("maps every per-path outcome of a multi-path expectation (R04-05)", () => {
      const c = byId(r04, "R04-05");
      expect(c.expected.outcome).toBeUndefined();
      expect(c.expected.results?.map((r) => [r.path, r.outcome])).toEqual([
        ["R04.a", "eligible"],
        ["R04.b", "likely_eligible"],
      ]);
      expect(c.expected.relationship).toBe("complementary_distinct_loss_lines");
    });
  });

  it("advisory ratchet: only the known fact is state=missing with a non-null value", () => {
    // Conventions: "Missing facts are state=missing with value null". R02-05's
    // delay_cause_controllable is {value: "unknown", state: "missing"}; reported
    // to the rules owner (M08 doc). A NEW occurrence fails here.
    const found = SCENARIOS.flatMap((s) => missingFactsWithValues(loadRuleFixtureFile(s)));
    expect(found).toEqual(["R02-05.delay_cause_controllable"]);
  });

  it("advisory ratchet: only the known amount_minor has no currency beside it", () => {
    // R04-04's expected.amount.excluded[0] is {line, amount_minor, reason} with
    // no currency (the conventions define money as amount_minor + ISO-4217);
    // reported to the rules owner (M08 doc). A NEW occurrence fails here.
    const found = SCENARIOS.flatMap((s) => moneyWithoutCurrency(loadRuleFixtureFile(s)));
    expect(found).toEqual(["R04-04 expected.amount.excluded[0]"]);
  });

  it("the alias table matches docs/rules/README.md 'Outcome vocabulary mapping' and every file's vocabulary", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "docs/rules/README.md"), "utf8");
    const section = readme.split(/^### Outcome vocabulary mapping\s*$/m)[1]?.split(/^#{1,3} /m)[0];
    expect(section, "README section '### Outcome vocabulary mapping' not found").toBeDefined();
    const rows = [...(section ?? "").matchAll(/^\|\s*`([a-z_]+)`\s*\|\s*`([a-z_]+)`/gm)].map((m) => [m[1], m[2]]);
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.fromEntries(rows)).toEqual({ ...FIXTURE_OUTCOME_ALIASES });
    for (const s of SCENARIOS) {
      expect([...loadRuleFixtureFile(s).outcomeVocabulary].sort()).toEqual(Object.keys(FIXTURE_OUTCOME_ALIASES).sort());
    }
    expect([...new Set(Object.values(FIXTURE_OUTCOME_ALIASES))].sort()).toEqual([...CONTRACT_OUTCOMES].sort());
  });
});

// ---------------------------------------------------------------------------
// Drift: hash and manifest
// ---------------------------------------------------------------------------

describe("rule fixtures: drift fails loudly", () => {
  it("a manifest hash that does not match the file throws with both hashes", () => {
    const manifest = readRulesManifest();
    const rel = fixtureRelPath("R03");
    const tampered = { ...manifest, fixtures: { ...manifest.fixtures, [rel]: "0".repeat(64) } };
    expect(() => loadRuleFixtureFile("R03", { manifest: tampered })).toThrow(/fixture drift: SHA-256 is [0-9a-f]{64} but .* records 0{64}/);
  });

  it("an edited file (one byte) no longer verifies against the recorded hash", () => {
    const manifest = readRulesManifest();
    const rel = fixtureRelPath("R05");
    const bytes = readFileSync(path.join(REPO_ROOT, rel));
    expect(verifyFixtureHash(rel, bytes, manifest)).toBe(sha256Hex(bytes));
    const edited = Buffer.from(bytes);
    edited[edited.length - 2] ^= 1;
    expect(() => verifyFixtureHash(rel, edited, manifest)).toThrow(RuleFixtureError);
  });

  it("an unregistered file, a missing pack, or a pack that disagrees on ruleId/version throws", () => {
    const manifest = readRulesManifest();
    const rel = fixtureRelPath("R02");
    const { [rel]: _dropped, ...otherHashes } = manifest.fixtures;
    expect(() => loadRuleFixtureFile("R02", { manifest: { ...manifest, fixtures: otherHashes } })).toThrow(/not registered/);
    const noPack = { ...manifest, packs: manifest.packs.filter((p) => p.fixtures !== rel) };
    expect(() => loadRuleFixtureFile("R02", { manifest: noPack })).toThrow(/exactly one .* pack/);
    const wrongVersion = { ...manifest, packs: manifest.packs.map((p) => (p.fixtures === rel ? { ...p, version: 2 } : p)) };
    expect(() => loadRuleFixtureFile("R02", { manifest: wrongVersion })).toThrow(/version 2 vs rule_version v1/);
    const wrongId = { ...manifest, packs: manifest.packs.map((p) => (p.fixtures === rel ? { ...p, ruleId: "R02.other" } : p)) };
    expect(() => loadRuleFixtureFile("R02", { manifest: wrongId })).toThrow(/ruleId R02.other/);
  });
});

// ---------------------------------------------------------------------------
// Synthetic documents: resolution rules and every validation failure
// ---------------------------------------------------------------------------

const VOCAB = Object.keys(FIXTURE_OUTCOME_ALIASES);
const fact = (value: unknown, type = "string", state = "user_confirmed") => ({ type, value, state });

function doc(cases: unknown[]) {
  return {
    schema: "recoup.rule-fixtures/v1",
    rule_id: "RX.synthetic",
    rule_version: "v1",
    spec: "docs/rules/RX.md",
    construction: "synthetic (M08 loader test)",
    conventions: { outcome_vocabulary: VOCAB, loader: "see docs/rules/README.md" },
    cases,
  };
}

function kase(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `case ${id}`,
    categories: ["positive"],
    clock: "2026-09-23T12:00:00-04:00",
    facts: { a: fact("A"), b: fact("B") },
    expected: { outcome: "eligible" },
    ...extra,
  };
}

const parse = (cases: unknown[]) => parseRuleFixtureDocument(doc(cases), { scenario: "RX", relPath: "synthetic/RX.json" });

describe("rule fixtures: synthetic documents", () => {
  it("resolves a facts_from chain with overrides at each level, in declaration-independent order", () => {
    const file = parse([
      kase("RX-03", { facts: undefined, facts_from: "RX-02", facts_override: { c: fact("C3") } }),
      kase("RX-02", { facts: undefined, facts_from: "RX-01", facts_override: { b: fact("B2") } }),
      kase("RX-01"),
    ]);
    const facts = (id: string) => Object.fromEntries(Object.entries(byId(file, id).facts).map(([k, v]) => [k, v.value]));
    expect(facts("RX-01")).toEqual({ a: "A", b: "B" });
    expect(facts("RX-02")).toEqual({ a: "A", b: "B2" });
    expect(facts("RX-03")).toEqual({ a: "A", b: "B2", c: "C3" });
  });

  it("variant change replaces/adds facts for that variant only; the base case is unaffected", () => {
    const file = parse([
      kase("RX-01", {
        variants: [{ id: "RX-01b", change: { b: fact("B*"), z: fact(3, "integer") }, expected: { outcome: "not_eligible" } }],
      }),
    ]);
    expect(byId(file, "RX-01").facts.b.value).toBe("B");
    expect(byId(file, "RX-01").facts.z).toBeUndefined();
    expect(byId(file, "RX-01b").facts.b.value).toBe("B*");
    expect(byId(file, "RX-01b").facts.z.value).toBe(3);
    expect(byId(file, "RX-01b").expected.outcome).toBe("not_eligible");
  });

  const failures: Array<[string, unknown[], RegExp]> = [
    ["a facts_from cycle", [kase("RX-01", { facts: undefined, facts_from: "RX-02" }), kase("RX-02", { facts: undefined, facts_from: "RX-01" })], /cycle/],
    ["a dangling facts_from", [kase("RX-01", { facts: undefined, facts_from: "RX-99" })], /names no case/],
    ["both facts and facts_from", [kase("RX-01"), kase("RX-02", { facts_from: "RX-01" })], /both `facts` and `facts_from`/],
    ["neither facts nor facts_from", [kase("RX-01", { facts: undefined })], /neither `facts` nor `facts_from`/],
    ["a duplicate id", [kase("RX-01"), kase("RX-01")], /duplicate/],
    ["a variant id not prefixed by its case id", [kase("RX-01", { variants: [{ id: "RY-01a", expected: { outcome: "eligible" } }] })], /does not start with/],
    ["a variant without expected", [kase("RX-01", { variants: [{ id: "RX-01a", change: {} }] })], /variants never inherit/],
    ["a case with neither expected nor variants", [kase("RX-01", { expected: undefined })], /no top-level `expected` and no variants/],
    ["a runnable case without a clock", [kase("RX-01", { clock: undefined })], /no `clock`/],
    ["a clock without a UTC offset", [kase("RX-01", { clock: "2026-09-23T12:00:00" })], /UTC offset/],
    ["an outcome outside the vocabulary", [kase("RX-01", { expected: { outcome: "eligable" } })], /not in this file's conventions.outcome_vocabulary/],
    ["the contract name used directly in a fixture", [kase("RX-01", { expected: { outcome: "likely_eligible" } })], /not in this file's conventions/],
    ["expected with both outcome and results", [kase("RX-01", { expected: { outcome: "eligible", results: [{ path: "p", outcome: "eligible" }] } })], /exactly one of/],
    ["a typo'd key (facts_overide)", [kase("RX-01"), kase("RX-02", { facts: undefined, facts_from: "RX-01", facts_overide: {} })], /Unrecognized key/],
    ["a fact without a value key", [kase("RX-01", { facts: { a: { type: "string", state: "derived" } } })], /no `value` key/],
    ["a fact value of the wrong type", [kase("RX-01", { facts: { a: fact("yes", "boolean") } })], /does not match type boolean/],
    ["an unknown fact state", [kase("RX-01", { facts: { a: fact("A", "string", "guessed") } })], /state/],
    ["a conflicting fact without candidates", [kase("RX-01", { facts: { a: fact(null, "date", "conflicting") } })], /needs `candidates`/],
    ["fractional money in a fact", [kase("RX-01", { facts: { m: fact({ amount_minor: 12.5, currency: "USD" }, "money") } })], /does not match type money/],
    ["fractional money inside expected", [kase("RX-01", { expected: { outcome: "eligible", amount: { estimate: { amount_minor: 1.5, currency: "USD" } } } })], /money at amount.estimate: amount_minor must be an integer/],
    ["a non-ISO currency inside expected", [kase("RX-01", { expected: { outcome: "eligible", amount: [{ amount_minor: 100, currency: "$" }] } })], /money at amount\[0\]: currency must be an ISO-4217 code/],
    ["a lower-case currency", [kase("RX-01", { facts: { m: fact({ amount_minor: 100, currency: "usd" }, "money") } })], /does not match type money/],
  ];

  it.each(failures)("throws RuleFixtureError on %s", (_label, cases, message) => {
    expect(() => parse(cases)).toThrow(RuleFixtureError);
    expect(() => parse(cases)).toThrow(message);
  });

  it("rejects a vocabulary entry the alias table does not know", () => {
    const bad = { ...doc([kase("RX-01")]), conventions: { outcome_vocabulary: [...VOCAB, "maybe"], loader: "x" } };
    expect(() => parseRuleFixtureDocument(bad, { scenario: "RX", relPath: "synthetic/RX.json" })).toThrow(/"maybe" has no contract mapping/);
  });
});
