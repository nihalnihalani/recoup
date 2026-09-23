/**
 * R04 v1 code packs (paths a, b, c) against EVERY runnable case of docs/rules/fixtures/R04.json, loaded (hash-checked,
 * unmodified) through M08's loader, plus the contract §10 R04 rows and D147(1)'s named tests (M22). Expected values
 * are the researcher's hand-written ones (M02/M2D/M2E); nothing here is computed by the evaluator under test.
 *
 * Which pack runs. A case with `results: [{path, …}]` runs each named path's pack; a case with one `outcome` runs the
 * pack its `path` names (a variant inherits its case's path; R04-08's variants list their own `results`).
 *
 * Fixture → evaluator input (README cross-pack rule 2). Each fixture fact becomes resolution rows for M11's
 * `resolveCell` (user_confirmed → confirmed, observed → observed, derived → derived, extracted_candidate → candidate,
 * missing → no row, conflicting → one row per candidate in its `conflict_kind`). Bag and itinerary facts sit on `txn`
 * (one bag per fixture). Names map to `air.<name>` one to one, except (keys_air.ts header): `exemption_facts` → the
 * three `air.exemption_*` booleans; `carrier_claim_deadlines` → `air.carrier_claim_deadline`; `expense_lines[i]` →
 * subject `line:<i+1>` with `air.expense_amount`/`_date`/`_description`/`_receipt`/`_allocated_to` (a null receipt or
 * allocation is no row); `property_items[i]` → `line:<i+1>` with `air.property_item`/`_claimed_value`/`_proof`
 * (proof "none" is no row). Not mapped: `itinerary` (a description of the segments; the segment length is its own
 * fact) and `reimbursements_received` (R04-12: the paid line is already recorded by its `allocated_to`, which is what
 * excludes it, spec §15.5).
 *
 * Assertion mapping (contract rev 5.5 §10, D158/D161), compared as SETS of (key, reason-class):
 *   fixture `missing_facts`              ↔ missingFacts with reason missing | user_unknown | conflicting (either class:
 *                                          assumption-class rows are the facts the user may still add on a likely path)
 *   fixture `unconfirmed_decisive_facts` ↔ missingFacts with reason candidate_unconfirmed | conflict_capped
 * with names rendered as the fixture writes them ("receipt for E4", "proof for suitcase"). `amount.refund_at_least` /
 * `amount.estimate` ↔ amount.estimate (null ↔ no amount); `amount.cap_display` ↔ the explanation carries that line and
 * no estimate equals the floor; `assumptions` ↔ the listed assumptions are present (by id); `deadline` ↔ no deadline
 * row with a date; `reevaluate_when` ↔ reevaluate.when; `next_action` ↔ D154's add_evidence baggage_report;
 * `forbidden_outputs` ↔ the case-specific checks in FORBIDDEN; `dedupe` ↔ an identical result hash.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Id } from "../../_generated/dataModel";
import { loadRuleFixtureFile, REPO_ROOT, type FixtureFact, type RuleFixtureCase } from "../../testing/ruleFixtures.loader";
import { assertEvaluationBounds } from "../../opportunities";
import { getFactSpec, type FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r04View, type CellRow, type R04Path, type R04View } from "../facts/snapshot_air";
import { resultHash } from "./outcome";
import {
  evaluateR04V1,
  R04_ADAPTERS,
  R04_PARAM_PASSAGES,
  R04_SOURCES,
  R04_V1_PACKS,
  R04_V1_PARAMS,
  r04BagFeeRefundV1,
  r04DelayedBagExpensesV1,
  r04PropertyLossV1,
} from "./r04_baggage_v1";
import * as prod from "./registry";
import { activePacksForCategory as testActiveForCategory, resetTestRegistry, setTestActivations } from "./testRegistry";
import { ENGINE_VERSION, type EvaluationResult, type MissingFact } from "./types";

const FILE = loadRuleFixtureFile("R04");
const TXN_ID = "fixturetxn4" as Id<"transactions">;
const TXN = "txn";
const PACK = { a: r04BagFeeRefundV1, b: r04DelayedBagExpensesV1, c: r04PropertyLossV1 } as const;

// ---------------------------------------------------------------------------
// Fixture → rows
// ---------------------------------------------------------------------------

const DIRECT = [
  "itinerary_scope", "longest_us_foreign_nonstop_segment_minutes", "operating_carrier_last_segment", "bag_fee_merchant_of_record",
  "bag_fee_paid", "bag_tag_number", "deplane_opportunity_at", "bag_delivered_or_picked_up_at", "bag_status", "mbr_filed",
  "mbr_reference", "mbr_filed_at", "exemption_documented_by_carrier", "large_aircraft_segment_on_ticket", "incident_date",
  "carrier_liability_limit", "carrier_exclusions", "user_claimed_total",
] as const;
const KEY_OF: Record<string, string> = {
  ...Object.fromEntries(DIRECT.map((n) => [n, `air.${n}`])),
  carrier_claim_deadlines: "air.carrier_claim_deadline",
};
const EXEMPTIONS: Record<string, string> = {
  failed_recheck_at_first_us_entry: "air.exemption_failed_recheck",
  failed_pickup_on_time_bag: "air.exemption_failed_pickup",
  voluntary_separation_agreed: "air.exemption_voluntary_separation",
};
const NOT_MAPPED = new Set(["itinerary", "reimbursements_received"]);
const NAME_OF: Record<string, string> = Object.fromEntries(Object.entries(KEY_OF).map(([n, k]) => [k, n]));

type Money = { amount_minor: number; currency: string };
type ExpenseLine = { id: string; date: string; description: string; amount: Money; receipt: string | null; allocated_to: string | null };
type PropertyItem = { item: string; claimed_value: Money; proof: string };

const ROW_STATE: Record<string, ResolveRow["state"]> = {
  user_confirmed: "user_confirmed", observed: "observed", derived: "derived", extracted_candidate: "extracted_candidate",
};
const sourceOf = (state: string, evidence: unknown): ResolveRow["source"] =>
  state === "user_confirmed" ? { kind: "user" } : state === "derived" ? { kind: "derived" } : { kind: "evidence", ref: String(evidence ?? "fixture document") };

function toValue(key: string, raw: unknown): FactValue {
  const spec = getFactSpec(key);
  if (!spec) throw new Error(`${key} is not catalogued`);
  switch (spec.value) {
    case "code": return { kind: "code", code: raw as string };
    case "text": return { kind: "text", text: raw as string };
    case "identifier": return { kind: "identifier", scheme: spec.identifierScheme!, value: raw as string };
    case "instant": return { kind: "instant", epochMs: Date.parse(raw as string) };
    case "bool": return { kind: "bool", value: raw as boolean };
    case "count": return { kind: "count", n: raw as number };
    case "minutes": return { kind: "minutes", minutes: raw as number };
    case "local_date": return { kind: "local_date", date: raw as string };
    case "money": return { kind: "money", amountMinor: (raw as Money).amount_minor, currency: (raw as Money).currency };
    default: throw new Error(`no fixture conversion for ${spec.value}`);
  }
}

function rowsFor(subjectKey: string, key: string, fact: Pick<FixtureFact, "state" | "value" | "candidates"> & Record<string, unknown>): CellRow[] {
  if (fact.state === "missing" || fact.value === undefined) return [];
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    return (fact.candidates ?? []).map((c, i) => {
      const state = kind === "candidates" ? "extracted_candidate" : String(c.state);
      return { subjectKey, key, row: { state: ROW_STATE[state], value: toValue(key, c.value), at: i + 1, source: sourceOf(state, c.evidence) } };
    });
  }
  if (fact.value === null) return [];
  return [{ subjectKey, key, row: { state: ROW_STATE[fact.state], value: toValue(key, fact.value), at: 1, source: sourceOf(fact.state, fact.evidence) } }];
}

function rowsOf(facts: Readonly<Record<string, FixtureFact>>): CellRow[] {
  const rows: CellRow[] = [];
  for (const [name, fact] of Object.entries(facts)) {
    if (NOT_MAPPED.has(name)) continue;
    if (name === "exemption_facts") {
      for (const [member, key] of Object.entries(EXEMPTIONS)) {
        rows.push(...rowsFor(TXN, key, { ...fact, value: fact.value === null ? null : (fact.value as Record<string, unknown>)[member] }));
      }
      continue;
    }
    if (name === "expense_lines") {
      (fact.value as ExpenseLine[] | null ?? []).forEach((l, i) => {
        const s = `line:${i + 1}`;
        const part = (key: string, value: unknown) => rows.push(...rowsFor(s, key, { state: fact.state, value }));
        part("air.expense_amount", l.amount);
        part("air.expense_date", l.date);
        part("air.expense_description", l.description);
        part("air.expense_receipt", l.receipt);
        part("air.expense_allocated_to", l.allocated_to);
      });
      continue;
    }
    if (name === "property_items") {
      (fact.value as PropertyItem[] | null ?? []).forEach((p, i) => {
        const s = `line:${i + 1}`;
        const part = (key: string, value: unknown) => rows.push(...rowsFor(s, key, { state: fact.state, value }));
        part("air.property_item", p.item);
        part("air.property_claimed_value", p.claimed_value);
        part("air.property_proof", p.proof === "none" ? null : p.proof);
      });
      continue;
    }
    const key = KEY_OF[name];
    if (!key) throw new Error(`fixture fact ${name} has no R04 key mapping`);
    rows.push(...rowsFor(TXN, key, fact));
  }
  return rows;
}

const viewOf = (facts: Readonly<Record<string, FixtureFact>>, extra: CellRow[] = []): R04View =>
  r04View(buildAirSnapshot({ transactionId: TXN_ID, rows: [...rowsOf(facts), ...extra] }));

function verificationFor(p: R04Path, c: Pick<RuleFixtureCase, "source" | "clock">): Record<string, { lastVerifiedAt: string }> {
  if (c.source && "record" in c.source) return {};
  const date = c.source ? c.source.last_verified_on : c.clock.slice(0, 10);
  return Object.fromEntries(R04_SOURCES[p].map((s) => [s.sourceId, { lastVerifiedAt: date }]));
}

function run(p: R04Path, view: R04View, now: number, verification: Record<string, { lastVerifiedAt: string }>): EvaluationResult {
  const pack = PACK[p];
  return evaluateR04V1(p, {
    snapshot: view, snapshotHash: "fixture", engineVersion: ENGINE_VERSION, remedyKey: pack.remedyKey, subjectKey: TXN,
    pack: { ruleId: pack.ruleId, scenarioId: "R04", version: pack.version, params: R04_V1_PARAMS, sources: pack.sources },
    verification, caseContext: { settledMinorByLossKey: {} }, now,
  });
}
const runCase = (p: R04Path, c: RuleFixtureCase) => run(p, viewOf(c.facts), c.now, verificationFor(p, c));

/** Fixture names for a missing-fact row ("receipt for E4", "proof for suitcase", or the fact name). */
function nameOf(m: MissingFact, facts: Readonly<Record<string, FixtureFact>>): string {
  const line = /^line:(\d+)$/.exec(m.subjectKey);
  if (line) {
    const i = Number(line[1]) - 1;
    if (m.key === "air.expense_receipt") return `receipt for ${(facts.expense_lines.value as ExpenseLine[])[i].id}`;
    if (m.key === "air.property_proof") return `proof for ${(facts.property_items.value as PropertyItem[])[i].item}`;
    return `${m.key} ${m.subjectKey}`;
  }
  return NAME_OF[m.key] ?? m.key;
}
const UNRESOLVED = new Set(["missing", "user_unknown", "conflicting"]);
const CAPPED = new Set(["candidate_unconfirmed", "conflict_capped"]);
const namesOf = (r: EvaluationResult, cls: Set<string>, facts: Readonly<Record<string, FixtureFact>>) =>
  r.missingFacts.filter((m) => cls.has(m.reason)).map((m) => nameOf(m, facts)).sort();

/** Fixture assumption wording → the pack's assumption id. */
const ASSUMPTION_IDS: Record<string, string> = {
  "a segment on the ticket uses an aircraft with more than 60 seats (254.4 floor applies)": "r04.large_aircraft",
};

/** forbidden_outputs, case by case (each is a thing the evaluator must NOT produce). */
const FORBIDDEN: Record<string, (r: EvaluationResult) => void> = {
  "R04-04": (r) => {
    // "estimate of 60,000 (user total)", "estimate of 470,000 (the floor)", "a per-day cap applied by Recoup"
    expect(r.amount?.estimate.amountMinor).not.toBe(60_000);
    expect(r.amount?.estimate.amountMinor).not.toBe(470_000);
    expect(r.amount?.basis).toBe("documented_total");
    expect(JSON.stringify(r.amount?.inputs)).not.toMatch(/per day|daily/i);
  },
  "R04-06": (r) => {
    // "estimate 470,000", "estimate 620,000", "the words 'you will receive $4,700'"
    expect(r.amount).toBeNull();
    expect(r.explanation.join(" ").toLowerCase()).not.toContain("you will receive");
  },
  "R04-06b": (r) => {
    // "$4,700 floor for a 2024-12-10 incident", "estimate 380,000"
    expect(r.amount).toBeNull();
    expect(r.explanation.join(" ")).not.toContain("$4,700");
  },
  "R04-09": (r) => {
    // "choosing the user's time without evidence", "choosing the courier time silently"
    expect(r.outcome).toBe("needs_facts");
    expect(r.amount).toBeNull();
  },
};

type Expect = Record<string, unknown> & { outcome: string; path?: string };

function pathsOf(c: RuleFixtureCase): { p: R04Path; e: Expect }[] {
  const e = c.expected as Record<string, unknown>;
  const toPath = (label: string): R04Path => {
    const m = /^R04\.([abc])$/.exec(label.trim());
    if (!m) throw new Error(`${c.id}: path "${label}"`);
    return m[1] as R04Path;
  };
  if (Array.isArray(e.results)) return (e.results as Expect[]).map((r) => ({ p: toPath(r.path!), e: r }));
  const label = /^(R04\.[abc])/.exec(c.path ?? "")?.[1];
  if (!label) throw new Error(`${c.id}: no path`);
  return [{ p: toPath(label), e: e as Expect }];
}

const RUNS = FILE.cases.flatMap((c) => pathsOf(c).map(({ p, e }) => [`${c.id} (R04.${p})`, c, p, e] as const));

describe("R04 v1 code packs × docs/rules/fixtures/R04.json (unmodified, via M08's loader)", () => {
  it("loads the file (hash-checked) with every case runnable; every result names a path", () => {
    expect(FILE.ruleId).toBe(r04BagFeeRefundV1.ruleId);
    expect(FILE.ruleVersion).toBe(r04BagFeeRefundV1.version);
    expect(FILE.cases.length).toBe(26); // 13 cases: 8 with a top-level expected + 18 variants
    expect(RUNS.length).toBe(28); // R04-05 and R04-08 each run two paths
    for (const c of FILE.cases) {
      if (c.source && "refresh_window_days" in c.source) {
        for (const p of ["a", "b", "c"] as const) for (const s of R04_SOURCES[p]) expect(s.refreshWindowDays).toBe(c.source.refresh_window_days);
      }
    }
  });

  describe.each(RUNS)("%s", (_id, c, p, e) => {
    const r = runCase(p, c);

    it(`outcome ${e.outcome}`, () => {
      expect(r.outcome).toBe(e.outcome);
      assertEvaluationBounds(r);
    });

    it("missing_facts ↔ unresolved class; unconfirmed_decisive_facts ↔ capped class (D158/D161)", () => {
      if (e.missing_facts !== undefined || c.expected.outcome !== undefined) {
        expect(namesOf(r, UNRESOLVED, c.facts)).toEqual([...((e.missing_facts as string[] | undefined) ?? [])].sort());
      }
      expect(namesOf(r, CAPPED, c.facts)).toEqual([...((e.unconfirmed_decisive_facts as string[] | undefined) ?? [])].sort());
    });

    it("amount, cap display, assumptions, deadline, re-evaluation, next action", () => {
      if (e.amount === null) expect(r.amount).toBeNull();
      const amount = e.amount as { refund_at_least?: Money; estimate?: Money | null; formula?: string; cap_display?: string; excluded?: { line: string }[] } | null | undefined;
      if (amount?.refund_at_least) {
        expect(r.amount?.estimate).toEqual({ amountMinor: amount.refund_at_least.amount_minor, currency: amount.refund_at_least.currency });
        expect(r.amount?.formula).toBe("refund >= fee paid for that bag (260.5(e))");
      }
      if (amount?.estimate) expect(r.amount?.estimate).toEqual({ amountMinor: amount.estimate.amount_minor, currency: amount.estimate.currency });
      if (amount && amount.estimate === null) expect(r.amount).toBeNull();
      if (amount?.cap_display) {
        expect(r.explanation.join(" ")).toContain(amount.cap_display);
        if (r.amount?.cap) expect(r.amount.estimate.amountMinor).not.toBe(r.amount.cap.amount.amountMinor);
      }
      for (const ex of amount?.excluded ?? []) {
        const n = (c.facts.expense_lines.value as ExpenseLine[]).findIndex((l) => l.id === ex.line) + 1;
        expect(r.lossKeys).not.toContain(`txn:${TXN_ID}:exp:${n}`);
        expect(r.amount?.formula).not.toContain(`line ${n}`);
      }
      for (const text of (e.assumptions as string[] | undefined) ?? []) {
        expect(ASSUMPTION_IDS[text], `unmapped fixture assumption: ${text}`).toBeDefined();
        expect(r.assumptions.map((a) => a.id)).toContain(ASSUMPTION_IDS[text]);
      }
      if (e.deadline !== undefined) expect(r.deadlines.filter((d) => d.dueAt !== undefined)).toEqual([]);
      if (e.reevaluate_when !== undefined) expect(r.reevaluate?.when).toBe(e.reevaluate_when);
      if (e.next_action !== undefined) {
        // "file a Mishandled Baggage Report with the operating carrier" — the user's own action (D154).
        expect(r.nextAction).toEqual({ kind: "add_evidence", docTypes: ["baggage_report"] });
      }
      if (r.outcome === "not_yet_due") expect(r.reevaluate).toBeDefined();
      else expect(r.reevaluate).toBeUndefined();
    });

    it("explanation, dedupe, forbidden outputs", async () => {
      if (typeof e.explanation === "string") {
        // R04-13 (5a): names both values and how to resolve it.
        const text = r.explanation.join(" ");
        expect(text).toContain("2026-09-13T17:55:00.000Z"); // 10:55 -07:00 (user)
        expect(text).toContain("2026-09-13T15:30:00.000Z"); // 08:30 -07:00 (courier scan)
        expect(text.toLowerCase()).toContain("upload proof");
      }
      if ((c.expected as Record<string, unknown>).dedupe !== undefined) {
        const again = runCase(p, c);
        expect(await resultHash(again, "b")).toBe(await resultHash(r, "b"));
        const first = runCase("a", FILE.cases.find((x) => x.id === "R04-01")!);
        expect([r.outcome, r.amount, r.lossKeys]).toEqual([first.outcome, first.amount, first.lossKeys]);
      }
      FORBIDDEN[c.id]?.(r);
      // $4,700 / $3,800 is a limit, never an estimate (mission §10, D143(4)).
      expect([470_000, 380_000]).not.toContain(r.amount?.estimate.amountMinor);
    });
  });
});

describe("R04-05 / §10: the bag fee and the expenses are separate, complementary loss lines", () => {
  const c = FILE.cases.find((x) => x.id === "R04-05")!;
  it("distinct loss keys, declared complementary, 3,500 + 8,000 counted separately", () => {
    const a = runCase("a", c);
    const b = runCase("b", c);
    expect(a.lossKeys.filter((k) => b.lossKeys.includes(k))).toEqual([]);
    expect(a.overlap).toContainEqual({ withScenario: "R04", withRemedyKey: r04DelayedBagExpensesV1.remedyKey, relation: "complementary" });
    expect((a.amount?.estimate.amountMinor ?? 0) + (b.amount?.estimate.amountMinor ?? 0)).toBe(11_500);
    // The fee is claimed from the airline even though a travel agency charged it (DOT-REF-8).
    expect(a.explanation.join(" ")).toContain("(XA)");
    expect(a.nextAction).toEqual({ kind: "track" });
  });
});

// ---------------------------------------------------------------------------
// D147(1) named tests and contract §10 R04 rows
// ---------------------------------------------------------------------------

type Facts = Record<string, FixtureFact>;
const C = (type: FixtureFact["type"], value: unknown): FixtureFact => ({ type, value, state: "user_confirmed" });
const X = (type: FixtureFact["type"], value: unknown): FixtureFact => ({ type, value, state: "extracted_candidate" });
const M = (type: FixtureFact["type"]): FixtureFact => ({ type, value: null, state: "missing" });
const R04_01 = FILE.cases.find((x) => x.id === "R04-01")!;
const with_ = (base: Facts, change: Facts, drop: string[] = []): Facts => {
  const out: Facts = { ...base, ...change };
  for (const d of drop) delete out[d];
  return out;
};
const evalPath = (p: R04Path, facts: Facts, now = R04_01.now) => run(p, viewOf(facts), now, verificationFor(p, { source: null, clock: new Date(now).toISOString() }));
const line = (id: string, amountMinor: number, receipt: string | null, allocated: string | null = null): ExpenseLine => ({
  id, date: "2026-09-13", description: id, amount: { amount_minor: amountMinor, currency: "USD" }, receipt, allocated_to: allocated,
});
/** R04-01's confirmed facts plus a confirmed large aircraft and confirmed expense lines. */
const confirmedBag = (lines: ExpenseLine[]) => with_(R04_01.facts as Facts, {
  large_aircraft_segment_on_ticket: C("boolean", true),
  expense_lines: C("array", lines),
});

describe("D147(1): path a may reach eligible; the likely_eligible cap covers only the property and expense paths", () => {
  it("fee path, all decisive facts confirmed → eligible", () => {
    const r = evalPath("a", confirmedBag([line("E1", 3000, "rcpt-1")]));
    expect(r.outcome).toBe("eligible");
    expect(r.assumptions).toEqual([]);
    expect(r.missingFacts).toEqual([]);
    expect(r.dimensions.readyForApproval).toBe("pass");
  });

  it("expense path, same facts → likely_eligible + assumption (carrier contract not captured)", () => {
    const r = evalPath("b", confirmedBag([line("E1", 3000, "rcpt-1")]));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((a) => a.id)).toEqual(["r04.v1.carrier_contract_not_captured"]);
    expect(r.dimensions).toMatchObject({ applies: "pass", factsKnown: "pass", evidenceSupports: "pass" });
  });

  it("property path, same facts with a declared-lost bag → likely_eligible + the same assumption", () => {
    const r = evalPath("c", with_(confirmedBag([]), { bag_status: C("enum", "declared_lost") }));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((a) => a.id)).toContain("r04.v1.carrier_contract_not_captured");
  });

  it("fee path with an extracted-candidate report date → likely_eligible (D147(2))", () => {
    const r = evalPath("a", with_(R04_01.facts as Facts, { mbr_filed_at: X("datetime", "2026-09-12T22:05:00-07:00") }, ["mbr_filed", "mbr_reference"]));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["air.mbr_filed_at", "candidate_unconfirmed"]]);
    // …and once the report is confirmed, the cap lifts.
    expect(evalPath("a", with_(R04_01.facts as Facts, { mbr_filed_at: C("datetime", "2026-09-12T22:05:00-07:00") }, ["mbr_filed", "mbr_reference"])).outcome).toBe("eligible");
  });

  it("fee path with an extracted-candidate fee → likely_eligible, fee listed as unconfirmed", () => {
    const r = evalPath("a", with_(R04_01.facts as Facts, { bag_fee_paid: X("money", { amount_minor: 4000, currency: "USD" }) }));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["air.bag_fee_paid", "candidate_unconfirmed"]]);
  });

  it("fee unknown → likely_eligible with the fee asked (spec §15.2.5); a 0 fee → not_eligible", () => {
    const unknown = evalPath("a", with_(R04_01.facts as Facts, { bag_fee_paid: M("money") }));
    expect(unknown.outcome).toBe("likely_eligible");
    expect(unknown.amount).toBeNull();
    expect(unknown.missingFacts.map((m) => [m.key, m.reason, m.class])).toEqual([["air.bag_fee_paid", "missing", "assumption"]]);
    expect(evalPath("a", with_(R04_01.facts as Facts, { bag_fee_paid: C("money", { amount_minor: 0, currency: "USD" }) })).outcome).toBe("not_eligible");
  });

  it("unrecorded exemptions are an assumption, never a question (the fee path stays likely, not needs_facts)", () => {
    const r = evalPath("a", with_(R04_01.facts as Facts, {}, ["exemption_facts"]));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((a) => a.id)).toEqual(["r04.a.no_exemption"]);
    expect(r.missingFacts).toEqual([]);
  });

  it("260.5(g): travelling without the bag by agreement exempts a delayed bag but not a lost one", () => {
    const voluntary = { exemption_facts: C("object", { failed_recheck_at_first_us_entry: false, failed_pickup_on_time_bag: false, voluntary_separation_agreed: true }) };
    expect(evalPath("a", with_(R04_01.facts as Facts, voluntary)).outcome).toBe("not_eligible");
    expect(evalPath("a", with_(R04_01.facts as Facts, { ...voluntary, bag_status: C("enum", "declared_lost"), bag_delivered_or_picked_up_at: M("datetime") })).outcome).toBe("eligible");
  });
});

describe("§10 R04 rows", () => {
  it("documented expense lines of 3,000 + 2,000 → estimate 5,000 (documented_total); $4,700 only as the carrier's minimum limit", () => {
    const r = evalPath("b", confirmedBag([line("E1", 3000, "rcpt-1"), line("E2", 2000, "rcpt-2")]));
    expect(r.amount?.estimate).toEqual({ amountMinor: 5000, currency: "USD" });
    expect(r.amount?.basis).toBe("documented_total");
    expect(r.amount?.cap).toMatchObject({ amount: { amountMinor: 470_000, currency: "USD" }, sourcePassageId: "P-254.4" });
    expect(r.amount?.cap?.note).toContain("at least $4,700 per passenger");
    expect(r.explanation.join(" ")).toContain("Carrier liability limit: at least $4,700 per passenger (federal floor on the carrier's cap)");
  });

  it("unreceipted lines are excluded (and their receipt is asked, without blocking)", () => {
    const r = evalPath("b", confirmedBag([line("E1", 3000, "rcpt-1"), line("E2", 2000, null)]));
    expect(r.amount?.estimate).toEqual({ amountMinor: 3000, currency: "USD" });
    expect(r.missingFacts).toContainEqual({ subjectKey: "line:2", key: "air.expense_receipt", reason: "missing", class: "assumption", neededFor: ["amount"] });
    expect(r.lossKeys).toEqual([`txn:${TXN_ID}:exp:1`]);
  });

  it("the bag-fee path is separate, and one expense line cannot sit in two active cases (its own loss key; allocated → excluded)", () => {
    const facts = confirmedBag([line("E1", 3000, "rcpt-1"), line("E2", 2000, "rcpt-2", "card_benefit:baggage_delay")]);
    const a = evalPath("a", facts);
    const b = evalPath("b", facts);
    expect(a.lossKeys).toEqual([`txn:${TXN_ID}:bag_fee:1`]);
    expect(b.lossKeys).toEqual([`txn:${TXN_ID}:exp:1`]);
    expect(b.amount?.estimate.amountMinor).toBe(3000);
    expect(a.remedyKey).not.toBe(b.remedyKey);
  });

  it("the bag-fee refund has no stated day count: no counterparty timer, next action track", () => {
    const r = evalPath("a", R04_01.facts as Facts);
    expect(r.deadlines).toEqual([]);
    expect(r.nextAction).toEqual({ kind: "track" });
    // Weeks later it is still tracked, never escalated by date.
    expect(evalPath("a", R04_01.facts as Facts, Date.parse("2027-01-15T12:00:00-08:00")).nextAction).toEqual({ kind: "track" });
  });

  it("the international expense and property paths → unsupported (path a still applies)", () => {
    const intl = with_(confirmedBag([line("E1", 3000, "rcpt-1")]), { itinerary_scope: { type: "enum", value: "international", state: "derived" }, longest_us_foreign_nonstop_segment_minutes: C("integer", 600) });
    const b = evalPath("b", intl);
    expect(b.outcome).toBe("unsupported");
    expect(b.explanation.join(" ")).not.toContain("$4,700"); // part 254's floor never applies to a treaty itinerary
    expect(evalPath("c", with_(intl, { bag_status: C("enum", "damaged") })).outcome).toBe("unsupported");
    expect(evalPath("a", intl).outcome).toBe("not_eligible"); // 13h15m ≤ 15 h
  });

  it("R04-03b (D147(6), D154): MBR confirmed not filed → not_yet_due, reevaluate.when 'MBR filed', next action add_evidence baggage_report", () => {
    const r = runCase("a", FILE.cases.find((x) => x.id === "R04-03b")!);
    expect(r.outcome).toBe("not_yet_due");
    expect(r.reevaluate).toEqual({ when: "MBR filed" });
    expect(r.nextAction).toEqual({ kind: "add_evidence", docTypes: ["baggage_report"] });
    expect(r.outcome).not.toBe("not_eligible");
  });

  it("an unconfirmed 'not filed' is asked, never not_yet_due (only KNOWN facts set notYetDue)", () => {
    const r = evalPath("a", with_(R04_01.facts as Facts, { mbr_filed: X("boolean", false) }, ["mbr_reference", "mbr_filed_at"]));
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => m.key)).toEqual(["air.mbr_filed"]);
  });

  it("an international bag with an unknown segment length is asked only when the 15 h / 30 h choice matters", () => {
    const intl = (deliveredAt: string) => with_(R04_01.facts as Facts, {
      itinerary_scope: { type: "enum", value: "international", state: "derived" },
      bag_delivered_or_picked_up_at: C("datetime", deliveredAt),
    });
    expect(evalPath("a", intl("2026-09-13T10:55:00-07:00")).outcome).toBe("not_eligible"); // 13h15m: ≤ 15 h either way
    expect(evalPath("a", intl("2026-09-15T10:55:00-07:00")).outcome).toBe("eligible"); // 61h15m: > 30 h either way
    const middle = evalPath("a", intl("2026-09-13T21:40:00-07:00")); // 24h: depends on the segment
    expect(middle.outcome).toBe("needs_facts");
    expect(middle.missingFacts.map((m) => m.key)).toEqual(["air.longest_us_foreign_nonstop_segment_minutes"]);
  });

  it("the liability floor is versioned by incident date, with the 2025 enforcement delay disclosed", () => {
    const lost = (date: string) => evalPath("c", with_(confirmedBag([]), { bag_status: C("enum", "declared_lost"), incident_date: C("date", date) }));
    expect(lost("2025-01-21").explanation.join(" ")).toContain("at least $3,800 per passenger (federal floor in force before 2025-01-22)");
    expect(lost("2025-01-22").explanation.join(" ")).toContain("DOT delayed enforcement of this figure to 2025-03-20");
    expect(lost("2025-03-20").explanation.join(" ")).not.toContain("delayed enforcement");
  });
});

describe("R04 v1 pack invariants", () => {
  afterEach(() => resetTestRegistry());

  it("every parameter cites passages present in the spec or the captured sources", () => {
    const spec = readFileSync(path.join(REPO_ROOT, "docs/rules/R04-baggage.md"), "utf8");
    const excerpts = readFileSync(path.join(REPO_ROOT, "docs/rules/sources/federal-web-pages-excerpts.md"), "utf8");
    const notices = readFileSync(path.join(REPO_ROOT, "docs/rules/sources/federal-register-notices.txt"), "utf8");
    const cited = (id: string) => spec.includes(id) || excerpts.includes(`**${id}**`) || notices.includes(`## ${id}`);
    for (const [param, passages] of Object.entries(R04_PARAM_PASSAGES)) {
      expect(passages.length, param).toBeGreaterThan(0);
      for (const id of passages) expect(cited(id), `${param}: ${id}`).toBe(true);
    }
    expect(Object.keys(R04_PARAM_PASSAGES).sort()).toEqual(Object.keys(R04_V1_PARAMS).sort());
    expect(Object.isFrozen(R04_V1_PARAMS)).toBe(true);
    for (const p of ["a", "b", "c"] as const) for (const s of R04_SOURCES[p]) expect(cited(s.passageId), s.passageId).toBe(true);
  });

  it("three packs, one rule id and version, three remedy keys; production never returns them; the test seam does", () => {
    expect(R04_V1_PACKS.map((p) => [p.ruleId, p.version, p.remedyKey])).toEqual([
      ["R04.baggage.us_dot", 1, "bag_fee_refund"], ["R04.baggage.us_dot", 1, "delayed_bag_expenses"], ["R04.baggage.us_dot", 1, "lost_or_damaged_property"],
    ]);
    for (const p of R04_V1_PACKS) expect(prod.IMPLEMENTED_PACKS).toContain(p);
    expect(prod.activePack("R04")).toBeNull();
    expect(prod.activePacksForCategory("air_travel")).toEqual([]);
    setTestActivations([{ ruleId: "R04.baggage.us_dot", version: 1, status: "active", decision: "TEST" }]);
    expect(testActiveForCategory("air_travel")).toEqual([...R04_V1_PACKS]);
    setTestActivations([]);
    expect(testActiveForCategory("air_travel")).toEqual([]);
  });

  it("bound facts are canonical, value-only and ≤ 32 on every path (N6)", () => {
    const facts = with_(confirmedBag(Array.from({ length: 12 }, (_, i) => line(`E${i + 1}`, 100 + i, `r${i}`))), {});
    for (const p of ["a", "b", "c"] as const) {
      const r = evalPath(p, facts);
      expect(r.boundFacts.length, p).toBeLessThanOrEqual(32);
      const ids = r.boundFacts.map((b) => `${b.subjectKey}\u0000${b.key}`);
      expect(ids).toEqual([...ids].sort());
    }
  });

  it("D208 adapters: path a runs once per bag (incident subjects, stable ordinals); b and c run once", () => {
    const bagRows = (incident: string, fee: number): CellRow[] => rowsOf(with_(R04_01.facts as Facts, { bag_fee_paid: C("money", { amount_minor: fee, currency: "USD" }) }, ["itinerary_scope", "operating_carrier_last_segment"]))
      .map((r) => ({ ...r, subjectKey: incident }));
    const rows = [
      ...rowsOf({ itinerary_scope: { type: "enum", value: "domestic", state: "derived" }, operating_carrier_last_segment: C("string", "XA") }),
      ...bagRows("incident:bagtwo", 3500),
      ...bagRows("incident:bagone", 4000),
    ];
    const input = { transactionId: TXN_ID, isExample: false, rows };
    const a = R04_ADAPTERS.a.runs(input);
    expect(a.map((r) => [r.subjectKey, r.snapshot.bagOrdinal])).toEqual([["incident:bagone", 1], ["incident:bagtwo", 2]]);
    const results = a.map((r) => run("a", r.snapshot, R04_01.now, verificationFor("a", R04_01)));
    expect(results.map((r) => [r.outcome, r.amount?.estimate.amountMinor, r.lossKeys[0]])).toEqual([
      ["eligible", 4000, `txn:${TXN_ID}:bag_fee:1`], ["eligible", 3500, `txn:${TXN_ID}:bag_fee:2`],
    ]);
    expect(R04_ADAPTERS.b.runs(input).map((r) => r.subjectKey)).toEqual(["incident:bagone"]);
    expect(R04_ADAPTERS.c.runs(input).map((r) => r.subjectKey)).toEqual(["incident:bagone"]);
    // A single bag recorded on the transaction itself: one run on txn, identical to the direct evaluation.
    const single = R04_ADAPTERS.a.runs({ transactionId: TXN_ID, isExample: false, rows: rowsOf(R04_01.facts) });
    expect(single.map((r) => r.subjectKey)).toEqual([TXN]);
    expect(run("a", single[0].snapshot, R04_01.now, verificationFor("a", R04_01))).toEqual(runCase("a", R04_01));
  });

  it("the packs declare themselves researched and cite only captured sources", () => {
    for (const p of R04_V1_PACKS) {
      expect(p.lifecycle).toBe("researched");
      expect(p.fixturesPath).toBe("docs/rules/fixtures/R04.json");
      for (const s of p.sources) expect(["ecfr-14cfr260", "ecfr-14cfr254", "federal-web-excerpts", "fr-notices"]).toContain(s.sourceId);
    }
  });
});
