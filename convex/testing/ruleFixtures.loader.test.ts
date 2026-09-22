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
  FACT_STATES,
  FIXTURE_OUTCOME_ALIASES,
  PENDING_OUTCOMES,
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

/** Every manifest-registered fixture file (new files are covered automatically). */
const SCENARIOS: readonly string[] = Object.keys(readRulesManifest().fixtures)
  .map((p) => p.match(/\/([A-Za-z0-9_-]+)\.json$/)![1])
  .sort();

/**
 * Known data gaps are ratchets: a test fails on a NEW entry, never on a fixed
 * one (the rules researcher can fix fixtures without touching this file;
 * whoever next edits it should then shrink the list).
 */
function expectOnlyKnown(found: readonly string[], known: readonly string[], what: string) {
  expect(found.filter((f) => !known.includes(f)), `new ${what}`).toEqual([]);
}

/**
 * Mission §17 category groups a file does not cover yet. R01 v1 (72fe1a2)
 * tags no case missing_fact or contradictory_fact; contract §9's activation
 * gate needs every group, so this is reported to the lead in the M08 doc.
 */
const KNOWN_CATEGORY_GAPS: Readonly<Record<string, readonly string[]>> = {
  R01: ["missing_fact", "contradictory_fact"],
};

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
  it("loads every manifest-registered file (hash-checked), R01–R05 included", () => {
    const files = loadAllRuleFixtures();
    expect(files.map((f) => f.scenario)).toEqual([...SCENARIOS]);
    expect(SCENARIOS).toEqual(expect.arrayContaining(["R01", "R02", "R03", "R04", "R05"]));
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

    it("covers every mission §17 category group (except the pinned known gaps)", () => {
      expectOnlyKnown(missingRequiredCategories(file), KNOWN_CATEGORY_GAPS[scenario] ?? [], `${scenario} category gap`);
    });

    it("gives every runnable fixture a unique id, an offset clock, a finite now, facts, and contract (or flagged pending) outcomes only", () => {
      expect(new Set(file.cases.map((c) => c.id)).size).toBe(file.cases.length);
      for (const c of file.cases) {
        expect(c.clock, c.id).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
        expect(c.now, c.id).toBe(Date.parse(c.clock));
        expect(Number.isFinite(c.now), c.id).toBe(true);
        expect(Object.keys(c.facts).length, c.id).toBeGreaterThan(0);
        const pending = outcomesOf(c).filter((o) => !(CONTRACT_OUTCOMES as readonly string[]).includes(o));
        expectOnlyKnown(pending, PENDING_OUTCOMES, `${c.id} outcome outside the contract`);
        expect(c.pendingContractOutcome, c.id).toBe(pending.length > 0);
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

  // Data-independent property check: the loader's output equals a direct
  // reading of the raw JSON under the documented rules. It holds for any
  // revision of the fixtures (M2D edits them), so it never pins data values.
  describe.each(SCENARIOS)("%s resolution matches the raw file under the documented rules", (scenario) => {
    type RawCase = {
      id: string;
      clock?: string;
      source?: unknown;
      action?: string;
      context?: Record<string, unknown>;
      facts?: Record<string, unknown>;
      facts_from?: string;
      facts_override?: Record<string, unknown>;
      expected?: { outcome?: string; results?: Array<{ outcome: string }> };
      variants?: Array<{
        id: string;
        clock?: string;
        source?: unknown;
        action?: string;
        change?: Record<string, unknown>;
        context_change?: Record<string, unknown>;
        expected: { outcome?: string; results?: Array<{ outcome: string }> };
      }>;
    };
    const file = loadRuleFixtureFile(scenario);
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, fixtureRelPath(scenario)), "utf8")) as { cases: RawCase[] };
    const rawById = new Map(raw.cases.map((c) => [c.id, c]));
    const resolve = (id: string): Record<string, unknown> => {
      const c = rawById.get(id)!;
      return c.facts ?? { ...resolve(c.facts_from!), ...(c.facts_override ?? {}) };
    };
    const mapOutcome = (o: string) => ((PENDING_OUTCOMES as readonly string[]).includes(o) ? o : FIXTURE_OUTCOME_ALIASES[o]);
    const mappedOutcomes = (e: { outcome?: string; results?: Array<{ outcome: string }> }) =>
      e.outcome !== undefined ? [mapOutcome(e.outcome)] : (e.results ?? []).map((r) => mapOutcome(r.outcome));

    it("one runnable fixture per case-with-expected plus one per variant", () => {
      const expectedCount = raw.cases.reduce((n, c) => n + (c.expected ? 1 : 0) + (c.variants?.length ?? 0), 0);
      expect(file.cases.length).toBe(expectedCount);
    });

    it("facts, clock, source, context, action and outcomes follow facts_from/override, change and variant-wins", () => {
      for (const c of raw.cases) {
        if (c.expected) {
          const got = byId(file, c.id);
          expect(got.facts, c.id).toEqual(resolve(c.id));
          expect(got.clock, c.id).toBe(c.clock);
          expect(got.source, c.id).toEqual(c.source ?? null);
          expect(got.context, c.id).toEqual(c.context ?? {});
          expect(got.action, c.id).toBe(c.action ?? "evaluate");
          expect(got.expectedAsWritten, c.id).toEqual(c.expected);
          expect(outcomesOf(got), c.id).toEqual(mappedOutcomes(c.expected));
        }
        for (const v of c.variants ?? []) {
          const got = byId(file, v.id);
          expect(got.caseId, v.id).toBe(c.id);
          expect(got.facts, v.id).toEqual({ ...resolve(c.id), ...(v.change ?? {}) });
          expect(got.clock, v.id).toBe(v.clock ?? c.clock);
          expect(got.source, v.id).toEqual(v.source ?? c.source ?? null);
          expect(got.context, v.id).toEqual({ ...(c.context ?? {}), ...(v.context_change ?? {}) });
          expect(got.action, v.id).toBe(v.action ?? c.action ?? "evaluate");
          expect(got.expectedAsWritten, v.id).toEqual(v.expected);
          expect(outcomesOf(got), v.id).toEqual(mappedOutcomes(v.expected));
        }
      }
    });
  });

  it("advisory ratchet: only the known fact is state=missing with a non-null value", () => {
    // Conventions: "Missing facts are state=missing with value null". R02-05's
    // delay_cause_controllable is {value: "unknown", state: "missing"}; reported
    // to the rules owner (M08 doc). A NEW occurrence fails here.
    // README cross-pack rule 2 now states it; M2D fixes R02-05.
    const found = SCENARIOS.flatMap((s) => missingFactsWithValues(loadRuleFixtureFile(s)));
    expectOnlyKnown(found, ["R02-05.delay_cause_controllable"], "missing fact with a value");
  });

  it("advisory ratchet: only the known amount_minor has no currency beside it", () => {
    // R04-04's expected.amount.excluded[0] is {line, amount_minor, reason} with
    // no currency (the conventions define money as amount_minor + ISO-4217);
    // reported to the rules owner (M08 doc). A NEW occurrence fails here.
    const found = SCENARIOS.flatMap((s) => moneyWithoutCurrency(loadRuleFixtureFile(s)));
    expectOnlyKnown(found, ["R04-04 expected.amount.excluded[0]"], "amount_minor without currency");
  });

  it("the alias table matches docs/rules/README.md 'Outcome vocabulary mapping'; pending rows are known; files use only known names", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "docs/rules/README.md"), "utf8");
    const section = readme.split(/^### Outcome vocabulary mapping\s*$/m)[1]?.split(/^#{1,3} /m)[0];
    expect(section, "README section '### Outcome vocabulary mapping' not found").toBeDefined();
    const tableRows = (section ?? "").split("\n").filter((l) => /^\|\s*`[a-z_]+`/.test(l));
    const mapped = tableRows.flatMap((l) => {
      const m = l.match(/^\|\s*`([a-z_]+)`[^|]*\|\s*`([a-z_]+)`/);
      return m ? [[m[1], m[2]] as const] : [];
    });
    const pending = tableRows.filter((l) => /\|\s*\*\*none yet\*\*/.test(l)).map((l) => l.match(/`([a-z_]+)`/)![1]);
    expect(mapped.length + pending.length, "every README row is either mapped or 'none yet'").toBe(tableRows.length);
    expect(Object.fromEntries(mapped)).toEqual({ ...FIXTURE_OUTCOME_ALIASES });
    expectOnlyKnown(pending, PENDING_OUTCOMES, "README 'none yet' outcome the loader does not know");
    const known = [...Object.keys(FIXTURE_OUTCOME_ALIASES), ...PENDING_OUTCOMES];
    for (const s of SCENARIOS) expectOnlyKnown(loadRuleFixtureFile(s).outcomeVocabulary, known, `${s} vocabulary entry`);
    expect([...new Set(Object.values(FIXTURE_OUTCOME_ALIASES))].sort()).toEqual([...CONTRACT_OUTCOMES].sort());
  });

  it("accepts every fact state docs/rules/README.md 'Fixture format' documents", () => {
    const readme = readFileSync(path.join(REPO_ROOT, "docs/rules/README.md"), "utf8");
    const m = readme.match(/state ∈ ([a-z_ |]+)/);
    expect(m, "README 'state ∈ …' list not found").not.toBeNull();
    const documented = m![1].split("|").map((x) => x.trim()).filter(Boolean);
    expect(documented.length).toBeGreaterThanOrEqual(5);
    expectOnlyKnown(documented, FACT_STATES, "README fact state the loader rejects");
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

const VOCAB = [...Object.keys(FIXTURE_OUTCOME_ALIASES), ...PENDING_OUTCOMES];
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

  it("variant context_change replaces named context entries; action defaults to evaluate; source record 'missing' and tier load", () => {
    const d = {
      ...doc([
        kase("RX-01", {
          context: { claims: [], history: { low: 1 } },
          variants: [
            { id: "RX-01a", action: "send_existing_claim", context_change: { claims: [{ status: "drafted" }] }, expected: { outcome: "deadline_passed" } },
            { id: "RX-01b", source: { record: "missing" }, expected: { outcome: "source_unverified" } },
          ],
        }),
      ]),
      tier: "v1 legacy tier",
    };
    const file = parseRuleFixtureDocument(d, { scenario: "RX", relPath: "synthetic/RX.json" });
    expect(file.tier).toBe("v1 legacy tier");
    expect(byId(file, "RX-01").action).toBe("evaluate");
    expect(byId(file, "RX-01").context).toEqual({ claims: [], history: { low: 1 } });
    expect(byId(file, "RX-01a").action).toBe("send_existing_claim");
    expect(byId(file, "RX-01a").context).toEqual({ claims: [{ status: "drafted" }], history: { low: 1 } });
    expect(byId(file, "RX-01b").source).toEqual({ record: "missing" });
    expect(byId(file, "RX-01b").context).toEqual({ claims: [], history: { low: 1 } });
  });

  it("maps likely_eligible_missing_evidence → likely_eligible per path and keeps the verbatim block", () => {
    const file = parse([
      kase("RX-01", { expected: { results: [{ path: "a", outcome: "eligible" }, { path: "b", outcome: "likely_eligible_missing_evidence" }], relationship: "distinct" } }),
    ]);
    const c = byId(file, "RX-01");
    expect(c.expected.results?.map((r) => [r.path, r.outcome])).toEqual([["a", "eligible"], ["b", "likely_eligible"]]);
    expect(c.expected.relationship).toBe("distinct");
    expect(JSON.stringify(c.expectedAsWritten)).toContain("likely_eligible_missing_evidence");
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
    ["an unknown source shape", [kase("RX-01", { source: { record: "stale" } })], /source/],
  ];

  it.each(failures)("throws RuleFixtureError on %s", (_label, cases, message) => {
    expect(() => parse(cases)).toThrow(RuleFixtureError);
    expect(() => parse(cases)).toThrow(message);
  });

  it("passes a README 'none yet' outcome through unmapped and flags the fixture (not_yet_due, D147(6))", () => {
    const file = parse([
      kase("RX-01", {
        expected: undefined,
        variants: [
          { id: "RX-01a", expected: { outcome: "not_yet_due", reevaluate_at: "2026-10-11" } },
          { id: "RX-01b", expected: { outcome: "not_eligible" } },
        ],
      }),
    ]);
    expect(byId(file, "RX-01a").expected.outcome).toBe("not_yet_due");
    expect(byId(file, "RX-01a").pendingContractOutcome).toBe(true);
    expect(byId(file, "RX-01b").pendingContractOutcome).toBe(false);
  });

  it("rejects a vocabulary entry the alias table does not know", () => {
    const bad = { ...doc([kase("RX-01")]), conventions: { outcome_vocabulary: [...VOCAB, "maybe"], loader: "x" } };
    expect(() => parseRuleFixtureDocument(bad, { scenario: "RX", relPath: "synthetic/RX.json" })).toThrow(/"maybe" has no contract mapping/);
  });
});
