/**
 * M2A (mission §20; contract §11.2 row M2A): product copy matches implemented coverage.
 *  1. `coverageCopy` derives exactly what `convex/lib/rules/coverage.ts` reports from the production activation data.
 *  2. README.md and hackathon.md carry the generated coverage sentence verbatim, so they go stale loudly.
 *  3. No product page, index.html, README.md or hackathon.md claims a recovery path the production registry does not
 *     evaluate, or guaranteed recovery, automatic resolution, legal representation, "every right", or billing.
 *     A sentence that names such a thing only to deny it ("not active", "no billing", "not a law firm") is allowed.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coverageRows } from "../../convex/lib/rules/coverage";
import { CHECK_WORDS, checkedScenarios, COVERAGE_PROMISE, coverageSummary } from "./coverageCopy";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const componentFiles = (dir: string) =>
  readdirSync(path.join(ROOT, dir))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .map((f) => `${dir}/${f}`);

/** Product copy under §20 (source files are scanned with comments removed; labels-only data files are excluded). */
const COPY_SOURCES = [
  "src/pages/SignIn.tsx",
  "src/pages/Board.tsx",
  ...componentFiles("src/components/dashboard"),
  "src/pages/Add.tsx",
  ...componentFiles("src/components/add").filter((f) => !f.endsWith("docTypes.ts")),
  "src/pages/Opportunities.tsx",
  "src/components/opportunity/OpportunityRow.tsx",
  "src/pages/Privacy.tsx",
  "convex/lib/privacyFacts.ts",
];
const DOCS = ["README.md", "hackathon.md", "index.html"];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Sentences (and markdown/list lines) of a text, whitespace-collapsed. */
function sentences(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

const NEGATION = /\b(not|never|no|none|isn't|aren't|doesn't|don't|cannot|can't|without|pending|until)\b/i;

/** Claims §20 forbids outright unless the sentence denies them. `every right` is forbidden even when negated in copy. */
const FORBIDDEN: readonly { name: string; pattern: RegExp; negatable: boolean }[] = [
  { name: "every right", pattern: /\bevery right\b|\ball (of )?your rights\b/i, negatable: false },
  { name: "guaranteed recovery", pattern: /\bguarantee(d|s)?\b/i, negatable: true },
  { name: "guaranteed recovery", pattern: /\b(gets?|will get) (you )?(the difference|your money) back\b/i, negatable: true },
  { name: "automatic resolution", pattern: /\bautomatic(ally)? (resolv|recover|refund|claim|fil|dispute|get)\w*/i, negatable: true },
  { name: "automatic resolution", pattern: /\b(resolv|recover)\w* (it )?(automatically|for you)\b/i, negatable: true },
  { name: "legal representation", pattern: /\blegal representation\b|\brepresents? you\b|\byour (lawyer|attorney)\b|\blaw firm\b/i, negatable: true },
  { name: "billing", pattern: /\b(subscription|pricing|paid plan|per month|free trial|success fee|billing|checkout|upgrade to)\b/i, negatable: true },
];

/** What a sentence must mention to be about a scenario (topic words, not the whole title). */
const SCENARIO_TOPICS: Readonly<Record<string, RegExp>> = {
  R02: /\b(flight|airline)s?\b[^.]{0,40}\b(refund|cancel)|\bcancel+ed flight|\bairline refund/i,
  R03: /\bbilling error|\bchargeback|\bdispute (a|the) (card )?charge/i,
  R04: /\b(baggage|luggage|bag fee|delayed bag|lost bag|damaged bag)/i,
  R05: /\blate (online )?order|\border[^.]{0,20}(did not|didn't) ship|\bmissing order|\blate shipment/i,
  R06: /\bpurchase protection/i,
  R07: /\breturn protection/i,
  R08: /\bextended warranty/i,
  R09: /\bdenied boarding|\bbumped from/i,
  R10: /\bwarranty (claim|defect|repair)/i,
  R11: /\bproduct recall|\bservice program/i,
  R12: /\btrip[- ](delay|cancellation)/i,
  R13: /\bATM\b|\bbank transfer|\bdebit (card )?error|\bRegulation E\b/i,
  R16: /\bsubscription (renewal|cancel)/i,
  R17: /\bmedical bill/i,
  R18: /\bvehicle recall/i,
  R19: /\bcancel+ed event/i,
  R20: /\bbest[- ]rate guarantee/i,
  R21: /\boutage credit|\bmissed[- ]appointment/i,
  R22: /\bregulator refund/i,
  R23: /\bclass[- ]action|\bsettlement claim/i,
  R24: /\bunclaimed property/i,
  R25: /\bshipping guarantee/i,
};

function copyTexts(): { file: string; text: string }[] {
  return [
    ...COPY_SOURCES.map((file) => ({ file, text: stripComments(read(file)) })),
    ...DOCS.map((file) => ({ file, text: read(file) })),
    { file: "coverageSummary()", text: coverageSummary() },
  ];
}

describe("coverageCopy derives exactly what the server's coverage report says", () => {
  it("the checked scenarios equal coverage.ts's active rows, with the same live-verification state", () => {
    const fromServer = coverageRows()
      .filter((row) => row.status !== "not_checked")
      .map((row) => ({ scenarioId: row.scenarioId, ruleId: row.ruleId, version: row.version, liveVerified: row.status === "implemented_verified" }));
    const fromCopy = checkedScenarios().map(({ scenarioId, ruleId, version, liveVerified }) => ({ scenarioId, ruleId, version, liveVerified }));
    expect(fromCopy).toEqual(fromServer);
  });

  it("every checked scenario has plain words, and the summary names only those", () => {
    const checked = checkedScenarios();
    for (const c of checked) expect(CHECK_WORDS[c.scenarioId], c.scenarioId).toBeDefined();
    const summary = coverageSummary();
    expect(summary.startsWith(`${COVERAGE_PROMISE}.`)).toBe(true);
    for (const [id, words] of Object.entries(CHECK_WORDS)) {
      expect(summary.includes(words!), id).toBe(checked.some((c) => c.scenarioId === id));
    }
  });

  it("withdrawing a pack takes it out of the copy; a live verification drops the 'pending' note", () => {
    const r01 = { ruleId: "R01.retail_price_adjustment", version: 1 };
    expect(checkedScenarios([{ ...r01, status: "active", decision: "D1" }, { ...r01, status: "withdrawn", decision: "D2" }], [])).toEqual([]);
    expect(coverageSummary([])).toBe(`${COVERAGE_PROMISE}. None is switched on yet.`);
    const verified = checkedScenarios([{ ...r01, status: "active", decision: "D1" }], [
      { ...r01, deployment: "adorable-lion-138", verifiedOn: "2026-09-30", decision: "D300", evidence: "VERIFICATION.md#r01" },
    ]);
    expect(verified[0].liveVerified).toBe(true);
    expect(coverageSummary(verified)).not.toContain("pending");
  });

  it("README.md and hackathon.md carry the generated coverage sentence verbatim", () => {
    for (const doc of ["README.md", "hackathon.md"]) {
      expect(read(doc).replace(/\s+/g, " "), doc).toContain(coverageSummary());
    }
  });
});

describe("§20: product copy claims only what is implemented", () => {
  it("never claims a recovery path the production registry does not evaluate", () => {
    const active = new Set(checkedScenarios().map((c) => c.scenarioId));
    const offenders: string[] = [];
    for (const { file, text } of copyTexts()) {
      for (const sentence of sentences(text)) {
        for (const [id, topic] of Object.entries(SCENARIO_TOPICS)) {
          if (active.has(id as never) || !topic.test(sentence) || NEGATION.test(sentence)) continue;
          offenders.push(`${file} [${id}]: ${sentence.slice(0, 160)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never claims guaranteed recovery, automatic resolution, legal representation, every right, or billing", () => {
    const offenders: string[] = [];
    for (const { file, text } of copyTexts()) {
      for (const sentence of sentences(text)) {
        for (const rule of FORBIDDEN) {
          if (!rule.pattern.test(sentence)) continue;
          if (rule.negatable && NEGATION.test(sentence)) continue;
          offenders.push(`${file} [${rule.name}]: ${sentence.slice(0, 160)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses the house phrase on the landing page, /add and /opportunities", () => {
    for (const page of ["src/pages/SignIn.tsx", "src/pages/Add.tsx", "src/pages/Opportunities.tsx"]) {
      expect(read(page), page).toContain("coverageSummary()");
    }
  });

  it("the scanner itself catches a planted claim (it is not vacuous)", () => {
    const planted = sentences("Recoup gets the difference back. We check every right. Get your lost luggage refunded today.");
    expect(planted.some((s) => FORBIDDEN.some((r) => r.pattern.test(s)))).toBe(true);
    expect(planted.some((s) => SCENARIO_TOPICS.R04.test(s) && !NEGATION.test(s))).toBe(true);
  });
});
