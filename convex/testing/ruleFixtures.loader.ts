/**
 * Test-only loader for the hand-written rule fixtures in
 * `docs/rules/fixtures/R0x.json` (M02, format `recoup.rule-fixtures/v1`,
 * see `docs/rules/README.md`). M08; consumed by the M12/M21/M22 evaluator
 * tests.
 *
 * What it guarantees, or throws a `RuleFixtureError` naming the file and
 * case:
 *  - **Provenance.** The file's SHA-256 equals `docs/rules/manifest.json`
 *    `fixtures[<path>]`, and the manifest pack that points at the file has
 *    the same `ruleId`, version and spec. A fixture edit without a manifest
 *    refresh is drift, and drift fails loudly. Every file in the fixtures
 *    directory must be registered in the manifest.
 *  - **Shape.** Every case and variant is validated (unknown keys too, so a
 *    typo such as `facts_overide` cannot silently drop an override). Every
 *    fact is `{type, value, state}` with a known type and state, and a
 *    non-null value matches its type. Money is integer `amount_minor` plus an
 *    ISO-4217 code, everywhere it appears. Clocks are ISO-8601 with an offset.
 *  - **Resolution, per each file's `conventions.loader`.**
 *    `facts_from` + `facts_override` copy another case's resolved facts,
 *    then replace the named ones. A variant's `change` replaces the named
 *    facts for that variant only. `clock` and `source` on a variant override
 *    the case; `context_change` replaces named `context` entries; `action`
 *    defaults to "evaluate". A case with a top-level `expected` is itself runnable; each
 *    variant is runnable and must carry its own `expected` (nothing is
 *    inherited, and nothing is ever computed).
 *  - **Vocabulary.** Fixture outcome names map to the M01 contract's
 *    `evaluationOutcome` through the README alias table
 *    (`likely_eligible_missing_evidence` → `likely_eligible`; `not_yet_due`
 *    1:1 since contract rev 5.2). The contract list is read from the schema
 *    validator itself (`convex/schema.ts` `evaluationOutcome`). An unknown
 *    name throws. The verbatim `expected` stays in `expectedAsWritten`.
 *
 * `now` is `Date.parse(clock)`. Inject it; evaluators never read the wall
 * clock (D138, README "Every fixture clock must be injected as `now`").
 *
 * The file name has two dots on purpose. The Convex bundler skips any file
 * whose name has more than one dot (`node_modules/convex/dist/cjs/bundler/
 * index.js:370-372`), so this Node-only module (`node:fs`, `node:crypto`) is
 * never deployed. Any single-dot `.ts` file under `convex/testing/` WOULD be
 * deployed, and would also collide with the `testing` module in `api`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Infer } from "convex/values";
import { z } from "zod";
import { evaluationOutcome } from "../schema";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RULES_MANIFEST_PATH = "docs/rules/manifest.json";
export const RULE_FIXTURES_DIR = "docs/rules/fixtures";

/** The contract's `evaluationOutcome` (M01 §2.4), read from the schema validator so it can never drift from code. */
export type ContractOutcome = Infer<typeof evaluationOutcome>;
export const CONTRACT_OUTCOMES: readonly ContractOutcome[] = Object.freeze(evaluationOutcome.members.map((m) => m.value));

/**
 * `docs/rules/README.md` "Outcome vocabulary mapping": fixture wording
 * (mission §9) → contract outcome. `ruleFixtures.loader.test.ts` fails if
 * this table and the README table ever disagree.
 */
export const FIXTURE_OUTCOME_ALIASES: Readonly<Record<string, ContractOutcome>> = Object.freeze({
  eligible: "eligible",
  likely_eligible_missing_evidence: "likely_eligible",
  possible_contract_benefit: "possible_contract_benefit",
  needs_facts: "needs_facts",
  manual_review: "manual_review",
  not_eligible: "not_eligible",
  deadline_passed: "deadline_passed",
  source_unverified: "source_unverified",
  unsupported: "unsupported",
  not_yet_due: "not_yet_due", // D147(6), contract rev 5.2
});

/** Mission §17 fixture categories every rule file must cover (contract §9 activation gate, §10). Each entry lists the accepted category tags. */
export const REQUIRED_CATEGORY_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  positive: ["positive"],
  negative: ["negative"],
  missing_fact: ["missing_fact"],
  contradictory_fact: ["contradictory_fact"],
  boundary_time: ["boundary_time"],
  unsupported: ["unsupported_jurisdiction", "unsupported_product", "unsupported_payment"],
  stale_or_missing_source: ["stale_source", "stale_or_changing_source", "missing_source"],
  exclusion: ["exclusion"],
  duplicate_evaluation: ["duplicate_evaluation"],
  overlapping_remedy: ["overlapping_remedy"],
});

export const FACT_TYPES = ["enum", "string", "datetime", "date", "boolean", "integer", "money", "money[]", "observation", "object", "array"] as const;
/** docs/rules/README.md "Fixture format" state list (cross-pack rule 2 maps each to a contract cell status). */
export const FACT_STATES = ["user_confirmed", "observed", "derived", "extracted_candidate", "conflicting", "missing", "assumption"] as const;

export type FixtureFact = {
  type: (typeof FACT_TYPES)[number];
  value: unknown;
  state: (typeof FACT_STATES)[number];
  candidates?: ReadonlyArray<{ value: unknown } & Record<string, unknown>>;
} & Record<string, unknown>;

/** Source-state override: a last-verified date + refresh window, or README cross-pack rule 8 (X5) "no current source record". */
export type FixtureSource =
  | { last_verified_on: string; refresh_window_days: number; note?: string }
  | { record: "missing"; note?: string };

export type FixturePathResult = { path: string; outcome: ContractOutcome } & Record<string, unknown>;

/** A fixture's `expected`, verbatim except that every outcome is in the contract vocabulary. */
export type FixtureExpected = Record<string, unknown> &
  ({ outcome: ContractOutcome; results?: undefined } | { outcome?: undefined; results: FixturePathResult[] });

/** One runnable fixture: a case with a top-level `expected`, or one variant. Deep-frozen. */
export type RuleFixtureCase = {
  /** The variant id for a variant, else the case id. Unique within the file. */
  id: string;
  caseId: string;
  variantId: string | null;
  title: string;
  categories: readonly string[];
  /** R04's path label (`"R04.a"`, `"R04.a + R04.b"`), else null. */
  path: string | null;
  clock: string;
  /** `Date.parse(clock)`: pass this as `now`. */
  now: number;
  /** Source-freshness override, or null for "verified current" (file conventions). */
  source: FixtureSource | null;
  /** What the fixture exercises: `"evaluate"` (default) or e.g. R01's `"send_existing_claim"`. */
  action: string;
  facts: Readonly<Record<string, FixtureFact>>;
  /** Non-fact state (existing claims, prior opportunities, ShopSavvy history): the case's `context` with the variant's `context_change` applied. `{}` when absent. Not copied by `facts_from`. */
  context: Readonly<Record<string, unknown>>;
  expected: FixtureExpected;
  expectedAsWritten: unknown;
  /** Descriptive fields the loader does not interpret (`mission_domain_fixture`, `window_end`, `applies_from`, `delta`, `day`, `delay`, `drop`). */
  annotations: Readonly<Record<string, unknown>>;
  justification: unknown;
};

export type RuleFixtureFile = {
  scenario: string;
  relPath: string;
  sha256: string | null;
  ruleId: string;
  ruleVersion: number;
  spec: string;
  /** R01's evaluation tier label, else null. */
  tier: string | null;
  outcomeVocabulary: readonly string[];
  sourceCaseCount: number;
  variantCount: number;
  cases: readonly RuleFixtureCase[];
};

export class RuleFixtureError extends Error {
  constructor(where: string, message: string) {
    super(`${where}: ${message}`);
    this.name = "RuleFixtureError";
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const ISO_DATETIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_4217 = /^[A-Z]{3}$/;

const isoDate = z.string().refine((s) => ISO_DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "must be YYYY-MM-DD");
const clock = z
  .string()
  .refine((s) => ISO_DATETIME_WITH_OFFSET.test(s) && Number.isFinite(Date.parse(s)), "must be ISO-8601 with a UTC offset");
// Descriptive keys (e.g. `label`) may ride along on a money object.
const money = z.object({ amount_minor: z.number().int(), currency: z.string().regex(ISO_4217) }).passthrough();

const valueSchemaByType: Record<FixtureFact["type"], z.ZodTypeAny> = {
  enum: z.string(),
  string: z.string(),
  datetime: clock,
  date: isoDate,
  boolean: z.boolean(),
  integer: z.number().int(),
  money,
  "money[]": z.array(money),
  // R01 price observation: money plus variantMatch/confidence/isRange/… (accepted or rejected by the evaluator).
  observation: money,
  object: z.record(z.unknown()),
  array: z.array(z.unknown()),
};

const factSchema = z
  .object({
    type: z.enum(FACT_TYPES),
    value: z.unknown(),
    state: z.enum(FACT_STATES),
    candidates: z.array(z.object({ value: z.unknown() }).passthrough()).min(1).optional(),
  })
  .passthrough()
  .superRefine((fact, ctx) => {
    if (!("value" in fact)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fact has no `value` key (use null for missing)" });
      return;
    }
    const valueSchema = valueSchemaByType[fact.type];
    if (fact.value !== null) {
      const r = valueSchema.safeParse(fact.value);
      if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `value does not match type ${fact.type}: ${r.error.issues[0]?.message}` });
    }
    if (fact.state === "conflicting") {
      if (!fact.candidates) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "a conflicting fact needs `candidates`" });
      for (const c of fact.candidates ?? []) {
        if (c.value === null) continue;
        const r = valueSchema.safeParse(c.value);
        if (!r.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `candidate value does not match type ${fact.type}` });
      }
    }
  });

const factsSchema = z.record(factSchema);

const sourceSchema = z.union([
  z.object({ last_verified_on: isoDate, refresh_window_days: z.number().int().positive(), note: z.string().optional() }).strict(),
  z.object({ record: z.literal("missing"), note: z.string().optional() }).strict(),
]);

const pathResultSchema = z.object({ path: z.string().min(1), outcome: z.string() }).passthrough();
const expectedSchema = z
  .object({ outcome: z.string().optional(), results: z.array(pathResultSchema).min(1).optional() })
  .passthrough()
  .refine((e) => (e.outcome === undefined) !== (e.results === undefined), "expected needs exactly one of `outcome` or `results`");

/** Keys the loader does not interpret, carried through as annotations. Anything else unknown is an error. */
const CASE_ANNOTATION_KEYS = ["mission_domain_fixture", "window_end", "applies_from"] as const;
const VARIANT_ANNOTATION_KEYS = ["delta", "day", "delay", "drop"] as const;

const variantSchema = z
  .object({
    id: z.string().min(1),
    change: factsSchema.optional(),
    clock: clock.optional(),
    source: sourceSchema.optional(),
    action: z.string().min(1).optional(),
    context_change: z.record(z.unknown()).optional(),
    expected: expectedSchema.optional(),
    justification: z.unknown().optional(),
    delta: z.unknown().optional(),
    day: z.unknown().optional(),
    delay: z.unknown().optional(),
    drop: z.unknown().optional(),
  })
  .strict();

const caseSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    categories: z.array(z.string().regex(/^[a-z][a-z_]*$/)).min(1),
    path: z.string().min(1).optional(),
    clock: clock.optional(),
    source: sourceSchema.optional(),
    facts: factsSchema.optional(),
    facts_from: z.string().min(1).optional(),
    facts_override: factsSchema.optional(),
    expected: expectedSchema.optional(),
    variants: z.array(variantSchema).optional(),
    action: z.string().min(1).optional(),
    context: z.record(z.unknown()).optional(),
    justification: z.unknown().optional(),
    mission_domain_fixture: z.unknown().optional(),
    window_end: z.unknown().optional(),
    applies_from: z.unknown().optional(),
  })
  .strict();

const documentSchema = z
  .object({
    schema: z.literal("recoup.rule-fixtures/v1"),
    rule_id: z.string().min(1),
    rule_version: z.string().regex(/^v[1-9]\d*$/),
    tier: z.string().min(1).optional(),
    spec: z.string().min(1),
    construction: z.unknown(),
    conventions: z.object({ outcome_vocabulary: z.array(z.string()).min(1), loader: z.string().min(1) }).passthrough(),
    cases: z.array(caseSchema).min(1),
  })
  .strict();

const manifestSchema = z
  .object({
    fixtures: z.record(z.string().regex(/^[0-9a-f]{64}$/)),
    packs: z.array(
      z
        .object({
          ruleId: z.string(),
          scenarioId: z.string(),
          version: z.number().int().nullable(),
          spec: z.string().optional(),
          fixtures: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type RulesManifest = z.infer<typeof manifestSchema>;

type ParsedCase = z.infer<typeof caseSchema>;
type ParsedExpected = z.infer<typeof expectedSchema>;

function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Pure parsing / resolution (no I/O)
// ---------------------------------------------------------------------------

function toContractOutcome(fixtureOutcome: string, vocabulary: readonly string[], where: string): ContractOutcome {
  if (!vocabulary.includes(fixtureOutcome)) {
    throw new RuleFixtureError(where, `outcome "${fixtureOutcome}" is not in this file's conventions.outcome_vocabulary`);
  }
  const mapped = FIXTURE_OUTCOME_ALIASES[fixtureOutcome];
  if (!mapped) throw new RuleFixtureError(where, `outcome "${fixtureOutcome}" has no contract mapping (docs/rules/README.md alias table)`);
  return mapped;
}

function normalizeExpected(expected: ParsedExpected, vocabulary: readonly string[], where: string): FixtureExpected {
  const copy = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
  if (expected.outcome !== undefined) {
    return { ...copy, outcome: toContractOutcome(expected.outcome, vocabulary, where) } as FixtureExpected;
  }
  const results = (expected.results ?? []).map((r, i) => ({
    ...(JSON.parse(JSON.stringify(r)) as Record<string, unknown>),
    path: r.path,
    outcome: toContractOutcome(r.outcome, vocabulary, `${where} results[${i}]`),
  }));
  return { ...copy, results } as FixtureExpected;
}

/** Visits every object carrying `amount_minor` anywhere under `value`, with its dotted trail. */
function visitMoney(value: unknown, visit: (obj: Record<string, unknown>, trail: string) => void, trail = ""): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => visitMoney(v, visit, `${trail}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if ("amount_minor" in obj) visit(obj, trail || "(root)");
  for (const [k, v] of Object.entries(obj)) visitMoney(v, visit, trail ? `${trail}.${k}` : k);
}

/**
 * Throws unless every `amount_minor` anywhere under `value` is an integer and
 * any `currency` beside it is ISO-4217. A missing `currency` is reported by
 * `moneyWithoutCurrency` instead (one known case in R04, see the M08 doc).
 */
function assertMoneyShapes(value: unknown, where: string): void {
  visitMoney(value, (obj, trail) => {
    if (!Number.isInteger(obj.amount_minor)) throw new RuleFixtureError(where, `money at ${trail}: amount_minor must be an integer (minor units)`);
    if ("currency" in obj && !(typeof obj.currency === "string" && ISO_4217.test(obj.currency))) {
      throw new RuleFixtureError(where, `money at ${trail}: currency must be an ISO-4217 code`);
    }
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Validates and resolves one fixture document already parsed from JSON.
 * Pure: no file or manifest access (`loadRuleFixtureFile` adds those).
 */
export function parseRuleFixtureDocument(
  doc: unknown,
  opts: { scenario: string; relPath: string; sha256?: string | null },
): RuleFixtureFile {
  const where = opts.relPath;
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) throw new RuleFixtureError(where, `invalid fixture document: ${formatZodError(parsed.error)}`);
  const d = parsed.data;
  const vocabulary = d.conventions.outcome_vocabulary;
  for (const name of vocabulary) {
    if (!FIXTURE_OUTCOME_ALIASES[name]) {
      throw new RuleFixtureError(where, `conventions.outcome_vocabulary entry "${name}" has no contract mapping (docs/rules/README.md alias table)`);
    }
  }

  const seen = new Set<string>();
  const byId = new Map<string, ParsedCase>();
  for (const c of d.cases) {
    for (const id of [c.id, ...(c.variants ?? []).map((v) => v.id)]) {
      if (seen.has(id)) throw new RuleFixtureError(where, `duplicate case/variant id "${id}"`);
      seen.add(id);
    }
    byId.set(c.id, c);
    for (const v of c.variants ?? []) {
      if (!v.id.startsWith(c.id)) throw new RuleFixtureError(where, `variant "${v.id}" does not start with its case id "${c.id}"`);
    }
  }

  const resolved = new Map<string, Record<string, FixtureFact>>();
  const resolveFacts = (caseId: string, chain: string[]): Record<string, FixtureFact> => {
    const done = resolved.get(caseId);
    if (done) return done;
    if (chain.includes(caseId)) throw new RuleFixtureError(where, `facts_from cycle: ${[...chain, caseId].join(" -> ")}`);
    const c = byId.get(caseId);
    if (!c) throw new RuleFixtureError(where, `${chain.at(-1)}: facts_from "${caseId}" names no case in this file`);
    let facts: Record<string, FixtureFact>;
    if (c.facts !== undefined) {
      if (c.facts_from !== undefined || c.facts_override !== undefined) {
        throw new RuleFixtureError(where, `${c.id}: has both \`facts\` and \`facts_from\`/\`facts_override\``);
      }
      facts = clone(c.facts) as Record<string, FixtureFact>;
    } else if (c.facts_from !== undefined) {
      facts = { ...clone(resolveFacts(c.facts_from, [...chain, caseId])), ...(clone(c.facts_override ?? {}) as Record<string, FixtureFact>) };
    } else {
      throw new RuleFixtureError(where, `${c.id}: has neither \`facts\` nor \`facts_from\``);
    }
    resolved.set(caseId, facts);
    return facts;
  };

  const cases: RuleFixtureCase[] = [];
  let variantCount = 0;
  for (const c of d.cases) {
    const caseFacts = resolveFacts(c.id, []);
    const variants = c.variants ?? [];
    variantCount += variants.length;
    if (c.expected === undefined && variants.length === 0) {
      throw new RuleFixtureError(where, `${c.id}: no top-level \`expected\` and no variants`);
    }
    const base = {
      caseId: c.id,
      title: c.title,
      categories: c.categories,
      path: c.path ?? null,
      justification: c.justification ?? null,
    };
    const caseAnnotations = Object.fromEntries(CASE_ANNOTATION_KEYS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]));

    const push = (item: Omit<RuleFixtureCase, "now">, rawExpected: ParsedExpected, itemWhere: string) => {
      assertMoneyShapes(item.facts, itemWhere);
      assertMoneyShapes(rawExpected, itemWhere);
      const now = Date.parse(item.clock);
      cases.push(deepFreeze({ ...item, now }));
    };

    if (c.expected !== undefined) {
      const itemWhere = `${where} ${c.id}`;
      if (c.clock === undefined) throw new RuleFixtureError(where, `${c.id}: has a top-level \`expected\` but no \`clock\``);
      push(
        {
          ...base,
          id: c.id,
          variantId: null,
          clock: c.clock,
          source: c.source ?? null,
          action: c.action ?? "evaluate",
          facts: clone(caseFacts),
          context: clone(c.context ?? {}),
          expected: normalizeExpected(c.expected, vocabulary, itemWhere),
          expectedAsWritten: clone(c.expected),
          annotations: clone(caseAnnotations),
          justification: clone(base.justification),
        },
        c.expected,
        itemWhere,
      );
    }
    for (const v of variants) {
      const itemWhere = `${where} ${v.id}`;
      if (v.expected === undefined) throw new RuleFixtureError(where, `${v.id}: variant has no \`expected\` (variants never inherit the case's)`);
      const vClock = v.clock ?? c.clock;
      if (vClock === undefined) throw new RuleFixtureError(where, `${v.id}: no \`clock\` on the variant or its case`);
      const variantAnnotations = Object.fromEntries(VARIANT_ANNOTATION_KEYS.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]));
      push(
        {
          ...base,
          id: v.id,
          variantId: v.id,
          clock: vClock,
          source: v.source ?? c.source ?? null,
          action: v.action ?? c.action ?? "evaluate",
          facts: { ...clone(caseFacts), ...(clone(v.change ?? {}) as Record<string, FixtureFact>) },
          context: { ...clone(c.context ?? {}), ...clone(v.context_change ?? {}) },
          expected: normalizeExpected(v.expected, vocabulary, itemWhere),
          expectedAsWritten: clone(v.expected),
          annotations: clone({ ...caseAnnotations, ...variantAnnotations }),
          justification: clone(v.justification ?? base.justification),
        },
        v.expected,
        itemWhere,
      );
    }
  }

  return deepFreeze({
    scenario: opts.scenario,
    relPath: opts.relPath,
    sha256: opts.sha256 ?? null,
    ruleId: d.rule_id,
    ruleVersion: Number(d.rule_version.slice(1)),
    spec: d.spec,
    tier: d.tier ?? null,
    outcomeVocabulary: [...vocabulary],
    sourceCaseCount: d.cases.length,
    variantCount,
    cases,
  });
}

/** The §17 category groups a parsed file does NOT cover (empty = complete). */
export function missingRequiredCategories(file: RuleFixtureFile): string[] {
  const present = new Set(file.cases.flatMap((c) => c.categories));
  return Object.entries(REQUIRED_CATEGORY_GROUPS)
    .filter(([, tags]) => !tags.some((t) => present.has(t)))
    .map(([group]) => group);
}

/**
 * Advisory: facts whose state is `missing` but whose value is not null. The
 * file conventions say "Missing facts are state=missing with value null".
 * Returned as `<id>.<fact>` so a test can pin the known list.
 */
export function missingFactsWithValues(file: RuleFixtureFile): string[] {
  const out = new Set<string>();
  for (const c of file.cases) {
    for (const [name, fact] of Object.entries(c.facts)) {
      if (fact.state === "missing" && fact.value !== null) out.add(`${c.id}.${name}`);
    }
  }
  return [...out].sort();
}

/**
 * Advisory: `amount_minor` values with no `currency` beside them, anywhere in
 * a fixture's facts or expected block (the conventions define money as
 * `amount_minor` + ISO-4217). Returned as `<id> <trail>`.
 */
export function moneyWithoutCurrency(file: RuleFixtureFile): string[] {
  const out: string[] = [];
  for (const c of file.cases) {
    visitMoney(c.facts, (obj, trail) => {
      if (!("currency" in obj)) out.push(`${c.id} facts.${trail}`);
    });
    visitMoney(c.expectedAsWritten, (obj, trail) => {
      if (!("currency" in obj)) out.push(`${c.id} expected.${trail}`);
    });
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// File + manifest access
// ---------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readRulesManifest(): RulesManifest {
  const where = RULES_MANIFEST_PATH;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(REPO_ROOT, RULES_MANIFEST_PATH), "utf8"));
  } catch (err) {
    throw new RuleFixtureError(where, `cannot read/parse: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new RuleFixtureError(where, `invalid manifest: ${formatZodError(parsed.error)}`);
  return parsed.data;
}

export function fixtureRelPath(scenario: string): string {
  return `${RULE_FIXTURES_DIR}/${scenario}.json`;
}

/**
 * Throws unless `bytes` hash to the manifest's recorded value for `relPath`
 * and the manifest pack that owns the file agrees on id, version and spec
 * (checked after parsing, in `loadRuleFixtureFile`).
 */
export function verifyFixtureHash(relPath: string, bytes: Uint8Array, manifest: RulesManifest): string {
  const expected = manifest.fixtures[relPath];
  if (!expected) {
    throw new RuleFixtureError(relPath, `not registered in ${RULES_MANIFEST_PATH} "fixtures" (every fixture file needs a recorded SHA-256)`);
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected) {
    throw new RuleFixtureError(
      relPath,
      `fixture drift: SHA-256 is ${actual} but ${RULES_MANIFEST_PATH} records ${expected}. ` +
        "A fixture change is a spec change: the rules researcher refreshes the manifest hash in the same commit, and a reviewed pack gets a new version.",
    );
  }
  return actual;
}

/** Loads, hash-checks and resolves `docs/rules/fixtures/<scenario>.json`. */
export function loadRuleFixtureFile(scenario: string, opts: { manifest?: RulesManifest } = {}): RuleFixtureFile {
  const relPath = fixtureRelPath(scenario);
  const manifest = opts.manifest ?? readRulesManifest();
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(REPO_ROOT, relPath));
  } catch (err) {
    throw new RuleFixtureError(relPath, `cannot read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Hash the exact bytes on disk first; only a file whose bytes match the
  // manifest is parsed at all.
  const sha256 = verifyFixtureHash(relPath, bytes, manifest);
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new RuleFixtureError(relPath, `not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const file = parseRuleFixtureDocument(doc, { scenario, relPath, sha256 });

  const packs = manifest.packs.filter((p) => p.fixtures === relPath);
  if (packs.length !== 1) {
    throw new RuleFixtureError(relPath, `expected exactly one ${RULES_MANIFEST_PATH} pack with "fixtures": "${relPath}", found ${packs.length}`);
  }
  const pack = packs[0];
  const mismatches = [
    pack.ruleId !== file.ruleId ? `ruleId ${pack.ruleId} vs rule_id ${file.ruleId}` : null,
    pack.version !== file.ruleVersion ? `version ${pack.version} vs rule_version v${file.ruleVersion}` : null,
    pack.scenarioId !== scenario ? `scenarioId ${pack.scenarioId} vs file ${scenario}` : null,
    pack.spec !== undefined && pack.spec !== file.spec ? `spec ${pack.spec} vs ${file.spec}` : null,
  ].filter((m): m is string => m !== null);
  if (mismatches.length > 0) throw new RuleFixtureError(relPath, `manifest pack disagrees with the file: ${mismatches.join("; ")}`);
  if (file.cases.length === 0) throw new RuleFixtureError(relPath, "no runnable cases");
  return file;
}

/** Every fixture file registered in the manifest. Throws if the directory holds an unregistered `.json`. */
export function loadAllRuleFixtures(): RuleFixtureFile[] {
  const manifest = readRulesManifest();
  const registered = Object.keys(manifest.fixtures).sort();
  const onDisk = readdirSync(path.join(REPO_ROOT, RULE_FIXTURES_DIR))
    .filter((name) => name.endsWith(".json"))
    .map((name) => `${RULE_FIXTURES_DIR}/${name}`)
    .sort();
  const unregistered = onDisk.filter((p) => !registered.includes(p));
  if (unregistered.length > 0) {
    throw new RuleFixtureError(RULE_FIXTURES_DIR, `files not registered in ${RULES_MANIFEST_PATH}: ${unregistered.join(", ")}`);
  }
  return registered.map((relPath) => {
    const m = relPath.match(/^docs\/rules\/fixtures\/([A-Za-z0-9_-]+)\.json$/);
    if (!m) throw new RuleFixtureError(RULES_MANIFEST_PATH, `unexpected fixtures key "${relPath}"`);
    return loadRuleFixtureFile(m[1], { manifest });
  });
}
