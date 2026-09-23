/**
 * R02 v1 code pack against EVERY runnable case of docs/rules/fixtures/R02.json, loaded (hash-checked, unmodified)
 * through M08's loader, plus the contract §10 R02 rows (M22). Expected values are the researcher's hand-written ones
 * (M02/M2D/M2E); nothing here is computed by the evaluator under test.
 *
 * Fixture → evaluator input (README cross-pack rule 2). Each fixture fact becomes resolution rows for M11's
 * `resolveCell` on subject `txn`: user_confirmed → a confirmed row, observed → observed, derived → derived,
 * extracted_candidate → a candidate row, missing → no row, conflicting → one row per candidate in its
 * `conflict_kind` (all candidates, or each candidate's own state). Names map to catalogue keys one to one
 * (`air.<name>`), except (keys_air.ts header): `original_airports`/`changed_airports` → one key per member;
 * `ancillary_fees_paid` (money[]) → the total `air.ancillary_fees_total` (an empty confirmed list is a confirmed 0);
 * `itinerary_legs` with a flown leg → `air.partly_flown` true. `delay_cause_controllable` (R02-05) is an R15 input,
 * not an R02 fact, and is not mapped. The clock is `now`; the fixture `source` becomes the verification record of
 * every R02 source (default: verified on the clock's date; `record: "missing"` → no record).
 *
 * Assertion mapping (contract rev 5.5 §10, D158/D161), compared as SETS of (key, reason-class):
 *   fixture `missing_facts`              ↔ missingFacts with reason missing | user_unknown | conflicting
 *   fixture `unconfirmed_decisive_facts` ↔ missingFacts with reason candidate_unconfirmed | conflict_capped
 * `amount.refund_due` ↔ amount.estimate (null ↔ no amount); `deadline: null` ↔ no deadline with a firm date;
 * `deadline.date` ↔ the carrier timer's local due date (null ↔ no due date), `deadline.status` ↔ its status,
 * `deadline.kind` ↔ the timer (carrier vs ticket agent); `path` R02.a ↔ next action track, R02.b ↔ request_refund;
 * `explanation` ↔ the result names the same facts; `dedupe` ↔ an identical result hash on re-evaluation;
 * `forbidden_outputs` ↔ the case-specific checks in FORBIDDEN below.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { loadRuleFixtureFile, type FixtureFact, type RuleFixtureCase } from "../../testing/ruleFixtures.loader";
import { assertEvaluationBounds } from "../../opportunities";
import { getFactSpec, type FactValue } from "../facts/catalog";
import { AIR_VOUCHER_ACCEPTANCE } from "../facts/keys_air";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r02View, R02_BOUND_KEYS, type CellRow, type R02View } from "../facts/snapshot_air";
import { resultHash } from "./outcome";
import {
  evaluateR02V1,
  r02Adapter,
  r02AirRefundV1,
  R02_AGENT_TIMER_ID,
  R02_CARRIER_TIMER_CREDIT_ID,
  R02_CARRIER_TIMER_OTHER_ID,
  R02_PARAM_PASSAGES,
  R02_SOURCES,
  R02_V1_PARAMS,
} from "./r02_air_refund_v1";
import * as prod from "./registry";
import { activePack as testActivePack, resetTestRegistry, setTestActivations } from "./testRegistry";
import { ENGINE_VERSION, type EvaluationResult, type MissingFact } from "./types";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../testing/ruleFixtures.loader";

const FILE = loadRuleFixtureFile("R02");
const TXN_ID = "fixturetxn1" as Id<"transactions">;
const TXN = "txn";

// ---------------------------------------------------------------------------
// Fixture → rows
// ---------------------------------------------------------------------------

const DIRECT = [
  "itinerary_scope", "operating_carrier", "marketing_carrier", "merchant_of_record", "ticket_refundability", "event_type",
  "ticket_number", "original_flight_number", "changed_flight_number", "original_sched_departure_at",
  "original_sched_arrival_at", "changed_sched_departure_at", "changed_sched_arrival_at", "actual_arrival_at",
  "original_connections", "changed_connections", "original_cabin", "changed_cabin", "passenger_disability_relevant",
  "offer_type", "consumer_response", "consumer_response_at", "flew_changed_or_alternative",
  "changed_or_alternative_departs_at", "payment_method_class", "fare_paid", "taxes_paid", "already_refunded",
] as const;
const KEY_OF: Record<string, string> = {
  ...Object.fromEntries(DIRECT.map((n) => [n, `air.${n}`])),
  ancillary_fees_paid: "air.ancillary_fees_total",
  itinerary_legs: "air.partly_flown",
};
const SPLIT: Record<string, Record<string, string>> = {
  original_airports: { origin: "air.original_origin_airport", destination: "air.original_destination_airport" },
  changed_airports: { origin: "air.changed_origin_airport", destination: "air.changed_destination_airport" },
};
/** Fixture facts that are not R02 inputs. */
const NOT_R02 = new Set(["delay_cause_controllable"]);
const NAME_OF: Record<string, string> = Object.fromEntries(Object.entries(KEY_OF).map(([n, k]) => [k, n]));

type Money = { amount_minor: number; currency: string };

function toValue(key: string, raw: unknown, facts: Readonly<Record<string, FixtureFact>>): FactValue {
  const spec = getFactSpec(key);
  if (!spec) throw new Error(`${key} is not catalogued`);
  if (key === "air.ancillary_fees_total") {
    const list = raw as Money[];
    const currencies = new Set(list.map((m) => m.currency));
    const fare = facts.fare_paid?.value as Money | null | undefined;
    const currency = [...currencies][0] ?? fare?.currency ?? "USD";
    if (currencies.size > 1) throw new Error("mixed-currency ancillary list");
    return { kind: "money", amountMinor: list.reduce((a, m) => a + m.amount_minor, 0), currency };
  }
  if (key === "air.partly_flown") {
    return { kind: "bool", value: Object.values(raw as Record<string, string>).some((leg) => /^flown\b/.test(leg)) };
  }
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

const ROW_STATE: Record<string, ResolveRow["state"]> = {
  user_confirmed: "user_confirmed", observed: "observed", derived: "derived", extracted_candidate: "extracted_candidate",
};
const sourceOf = (state: string, evidence: unknown): ResolveRow["source"] =>
  state === "user_confirmed" ? { kind: "user" } : state === "derived" ? { kind: "derived" } : { kind: "evidence", ref: String(evidence ?? "fixture document") };

function rowsFor(subjectKey: string, key: string, fact: FixtureFact, convert: (raw: unknown) => FactValue): CellRow[] {
  if (fact.state === "missing") return [];
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    return (fact.candidates ?? []).map((c, i) => {
      const state = kind === "candidates" ? "extracted_candidate" : String(c.state);
      return { subjectKey, key, row: { state: ROW_STATE[state], value: convert(c.value), at: i + 1, source: sourceOf(state, c.evidence) } };
    });
  }
  return [{ subjectKey, key, row: { state: ROW_STATE[fact.state], value: convert(fact.value), at: 1, source: sourceOf(fact.state, fact.evidence) } }];
}

function rowsOf(facts: Readonly<Record<string, FixtureFact>>): CellRow[] {
  const rows: CellRow[] = [];
  for (const [name, fact] of Object.entries(facts)) {
    if (NOT_R02.has(name)) continue;
    const split = SPLIT[name];
    if (split) {
      for (const [member, key] of Object.entries(split)) {
        const memberFact = { ...fact, value: fact.value === null ? null : (fact.value as Record<string, unknown>)[member] } as FixtureFact;
        rows.push(...rowsFor(TXN, key, memberFact, (raw) => ({ kind: "text", text: String((raw as Record<string, unknown>)?.[member] ?? raw) })));
      }
      continue;
    }
    const key = KEY_OF[name];
    if (!key) throw new Error(`fixture fact ${name} has no R02 key mapping`);
    rows.push(...rowsFor(TXN, key, fact, (raw) => toValue(key, raw, facts)));
  }
  return rows;
}

function viewOf(facts: Readonly<Record<string, FixtureFact>>, extra: CellRow[] = []): R02View {
  return r02View(buildAirSnapshot({ transactionId: TXN_ID, rows: [...rowsOf(facts), ...extra] }));
}

function verificationFor(c: Pick<RuleFixtureCase, "source" | "clock">): Record<string, { lastVerifiedAt: string }> {
  if (c.source && "record" in c.source) return {};
  const date = c.source ? c.source.last_verified_on : c.clock.slice(0, 10);
  return Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: date }]));
}

function run(view: R02View, now: number, verification: Record<string, { lastVerifiedAt: string }>): EvaluationResult {
  return evaluateR02V1({
    snapshot: view, snapshotHash: "fixture", engineVersion: ENGINE_VERSION, remedyKey: r02AirRefundV1.remedyKey, subjectKey: TXN,
    pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: r02AirRefundV1.version, params: R02_V1_PARAMS, sources: R02_SOURCES },
    verification, caseContext: { settledMinorByLossKey: {} }, now,
  });
}
const runCase = (c: RuleFixtureCase) => run(viewOf(c.facts), c.now, verificationFor(c));

const UNRESOLVED = new Set(["missing", "user_unknown", "conflicting"]);
const CAPPED = new Set(["candidate_unconfirmed", "conflict_capped"]);
const namesOf = (list: MissingFact[], cls: Set<string>) => list.filter((m) => cls.has(m.reason)).map((m) => NAME_OF[m.key] ?? m.key).sort();
const carrierTimer = (r: EvaluationResult) => r.deadlines.find((d) => d.id === R02_CARRIER_TIMER_CREDIT_ID || d.id === R02_CARRIER_TIMER_OTHER_ID);

/** forbidden_outputs, case by case (each is a thing the evaluator must NOT produce). */
const FORBIDDEN: Record<string, (r: EvaluationResult) => void> = {
  "R02-05": (r) => {
    // "any cash-compensation opportunity for delay inconvenience", "any amount"
    expect(["eligible", "likely_eligible", "possible_contract_benefit"]).not.toContain(r.outcome);
    expect(r.amount).toBeNull();
  },
  "R02-07": (r) => {
    // "picking the candidate favourable to the user"
    expect(r.outcome).toBe("needs_facts");
    expect(r.amount).toBeNull();
  },
};

describe("R02 v1 code pack × docs/rules/fixtures/R02.json (unmodified, via M08's loader)", () => {
  it("loads the file (hash-checked) with every case runnable, and the pack's refresh window matches the fixtures'", () => {
    expect(FILE.ruleId).toBe(r02AirRefundV1.ruleId);
    expect(FILE.ruleVersion).toBe(r02AirRefundV1.version);
    expect(FILE.cases.length).toBe(25); // 13 cases: 5 with a top-level expected + 20 variants
    for (const c of FILE.cases) {
      if (c.source && "refresh_window_days" in c.source) {
        for (const s of R02_SOURCES) expect(s.refreshWindowDays).toBe(c.source.refresh_window_days);
      }
    }
  });

  describe.each(FILE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = runCase(c);
    const e = c.expected as Record<string, unknown> & { outcome: string };

    it(`outcome ${e.outcome}`, () => {
      expect(r.outcome).toBe(e.outcome);
      assertEvaluationBounds(r);
    });

    it("missing_facts ↔ unresolved class; unconfirmed_decisive_facts ↔ capped class (D158/D161)", () => {
      expect(namesOf(r.missingFacts, UNRESOLVED)).toEqual([...((e.missing_facts as string[] | undefined) ?? [])].sort());
      expect(namesOf(r.missingFacts, CAPPED)).toEqual([...((e.unconfirmed_decisive_facts as string[] | undefined) ?? [])].sort());
    });

    it("amount and deadline (where the fixture states them)", () => {
      if (e.amount === null) expect(r.amount).toBeNull();
      const amount = e.amount as { refund_due?: Money | null; formula?: string } | null | undefined;
      if (amount && amount.refund_due === null) expect(r.amount).toBeNull();
      if (amount?.refund_due) expect(r.amount?.estimate).toEqual({ amountMinor: amount.refund_due.amount_minor, currency: amount.refund_due.currency });
      if (amount?.formula) expect(r.amount?.formula).toBe(amount.formula);

      if (e.deadline === null) expect(r.deadlines.filter((d) => d.dueAt !== undefined)).toEqual([]);
      const deadline = e.deadline as { kind?: string; date?: string | null; status?: string; disclosed_conflict?: string } | null | undefined;
      if (deadline) {
        const d = deadline.kind === "ticket_agent_refund_issuance" ? r.deadlines.find((x) => x.id === R02_AGENT_TIMER_ID) : carrierTimer(r);
        expect(d, "the deadline row").toBeDefined();
        expect(d!.obligor).toBe("counterparty");
        if (deadline.date === null) expect(d!.dueAt).toBeUndefined();
        if (typeof deadline.date === "string") expect(d!.dueLocalDate).toBe(deadline.date);
        if (deadline.status) expect(d!.status).toBe(deadline.status);
        if (deadline.disclosed_conflict) {
          expect(d!.basis).toContain("20 business days");
          expect(r.explanation.join(" ")).toContain("DOT-REF-3");
        }
      }
    });

    it("path, next action, explanation, dedupe, forbidden outputs", async () => {
      if (e.path === "R02.a") expect(r.nextAction.kind).toBe("track");
      if (e.path === "R02.b" || typeof e.next_action === "string") expect(r.nextAction).toEqual({ kind: "request_refund" });
      if (typeof e.explanation === "string") {
        const text = r.explanation.join(" ");
        if (c.caseId === "R02-10") {
          expect(text).toContain("renumbered");
          expect(text).toContain("2027-07-07");
        } else {
          // R02-13 (5a): names both values and how to resolve it.
          expect(text).toContain("rejected");
          expect(text).toContain("accepted_rebooking");
          expect(text.toLowerCase()).toContain("upload proof");
          expect(text.toLowerCase()).toContain("correct your confirmation");
        }
      }
      if (e.dedupe !== undefined) {
        const again = runCase(c);
        expect(await resultHash(again, "b")).toBe(await resultHash(r, "b"));
        const first = runCase(FILE.cases.find((x) => x.id === "R02-01")!);
        expect(r.outcome).toBe(first.outcome);
        expect(r.amount).toEqual(first.amount);
        expect(r.lossKeys).toEqual(first.lossKeys);
      }
      if (e.overlap !== undefined) {
        // R12 is never additive: undeclared → `alternative` at case opening (D145); the pack declares nothing additive.
        expect(r.overlap.filter((o) => o.withScenario === "R12" && (o.relation === "complementary" || o.relation === "coordinated"))).toEqual([]);
      }
      FORBIDDEN[c.id]?.(r);
      if (r.outcome === "not_yet_due") expect(r.reevaluate).toBeDefined();
      else expect(r.reevaluate).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Contract §10 R02 rows (M22) — built from R02-01's facts, one change at a time
// ---------------------------------------------------------------------------

const R02_01 = FILE.cases.find((c) => c.id === "R02-01")!;
const R02_02A = FILE.cases.find((c) => c.id === "R02-02a")!;
type Facts = Record<string, FixtureFact>;
const C = (type: FixtureFact["type"], value: unknown): FixtureFact => ({ type, value, state: "user_confirmed" });
const M = (type: FixtureFact["type"]): FixtureFact => ({ type, value: null, state: "missing" });
const with_ = (base: RuleFixtureCase, change: Facts, drop: string[] = []): Facts => {
  const out: Facts = { ...(base.facts as Facts), ...change };
  for (const d of drop) delete out[d];
  return out;
};
const verified = verificationFor(R02_01);
const evalFacts = (facts: Facts, now = R02_01.now) => run(viewOf(facts), now, verificationFor({ source: null, clock: new Date(now).toISOString() }));

/** R02-02a's facts (domestic schedule change, every criterion confirmed equal) with a changed schedule. */
const scheduleChange = (change: Facts) => with_(R02_02A, change);

describe("§10 R02: significance is any §260.2 criterion (DA-A-24: disability asked only when decisive)", () => {
  it("(1) departure 3 h earlier → eligible; 2 h 59 m earlier → not_eligible", () => {
    const at = (iso: string) => evalFacts(scheduleChange({ changed_sched_departure_at: C("datetime", iso), changed_sched_arrival_at: C("datetime", "2026-11-10T14:00:00-05:00") }), R02_02A.now);
    expect(at("2026-11-10T07:00:00-05:00").outcome).toBe("eligible");
    expect(at("2026-11-10T07:01:00-05:00").outcome).toBe("not_eligible");
  });

  it("(2) international thresholds are 6 h: +5 h 59 m → not_eligible, +6 h → eligible", () => {
    const at = (iso: string) => evalFacts(scheduleChange({ itinerary_scope: { type: "enum", value: "international", state: "derived" }, changed_sched_arrival_at: C("datetime", iso) }), R02_02A.now);
    expect(at("2026-11-10T19:59:00-05:00").outcome).toBe("not_eligible");
    expect(at("2026-11-10T20:00:00-05:00").outcome).toBe("eligible");
  });

  it("(3) a different airport, (4) an added connection, (5) a downgrade → eligible", () => {
    const base = { changed_sched_arrival_at: C("datetime", "2026-11-10T14:30:00-05:00") };
    expect(evalFacts(scheduleChange({ ...base, changed_airports: C("object", { origin: "BOS", destination: "PDK" }) }), R02_02A.now).outcome).toBe("eligible");
    expect(evalFacts(scheduleChange({ ...base, changed_connections: C("integer", 1) }), R02_02A.now).outcome).toBe("eligible");
    expect(evalFacts(scheduleChange({ ...base, changed_cabin: C("enum", "economy"), original_cabin: C("enum", "business") }), R02_02A.now).outcome).toBe("eligible");
  });

  it("disability criteria are never asked (not decisive until raised); a confirmed disability → manual_review (L11)", () => {
    const below = evalFacts(scheduleChange({ changed_sched_arrival_at: C("datetime", "2026-11-10T16:59:00-05:00") }), R02_02A.now);
    expect(below.outcome).toBe("not_eligible");
    expect(below.missingFacts.map((m) => m.key)).not.toContain("air.passenger_disability_relevant");
    const raised = evalFacts(scheduleChange({ changed_sched_arrival_at: C("datetime", "2026-11-10T16:59:00-05:00"), passenger_disability_relevant: C("boolean", true) }), R02_02A.now);
    expect(raised.outcome).toBe("manual_review");
    expect(raised.nextAction.kind).toBe("manual_review");
  });

  it("the criterion the event names is asked first; the others only once it fails", () => {
    const arrivalMissing = evalFacts(with_(R02_02A, { changed_sched_arrival_at: M("datetime") }, ["original_airports", "changed_airports", "original_connections", "changed_connections", "original_cabin", "changed_cabin", "changed_sched_departure_at"]), R02_02A.now);
    expect(arrivalMissing.outcome).toBe("needs_facts");
    expect(arrivalMissing.missingFacts.map((m) => m.key)).toEqual(["air.changed_sched_arrival_at"]);
    const belowWithOthersMissing = evalFacts(with_(R02_02A, { changed_sched_arrival_at: C("datetime", "2026-11-10T16:59:00-05:00") }, ["original_airports", "changed_airports"]), R02_02A.now);
    expect(belowWithOthersMissing.outcome).toBe("needs_facts");
    expect(belowWithOthersMissing.missingFacts.map((m) => m.key).sort()).toEqual([
      "air.changed_destination_airport", "air.changed_origin_airport", "air.original_destination_airport", "air.original_origin_airport",
    ]);
  });
});

describe("§10 R02 / DA-A-24: a cancellation with a confirmed 4-hour change → no disability and no time-zone question", () => {
  it.each([
    ["cancellation, rebooked 4 h later, rejected", with_(R02_01, { changed_sched_arrival_at: C("datetime", "2026-10-05T14:00:00-04:00"), original_sched_arrival_at: C("datetime", "2026-10-05T10:00:00-04:00") })],
    ["schedule change of 4 h, rejected", with_(R02_01, { event_type: C("enum", "schedule_change"), original_sched_arrival_at: C("datetime", "2026-10-05T10:00:00-04:00"), changed_sched_arrival_at: C("datetime", "2026-10-05T14:00:00-04:00") })],
  ])("%s", (_name, facts) => {
    const r = evalFacts(facts);
    expect(r.outcome).toBe("eligible");
    const keys = r.missingFacts.map((m) => m.key);
    expect(keys).not.toContain("air.passenger_disability_relevant");
    expect(keys).not.toContain("air.home_time_zone");
    expect(r.assumptions).toEqual([]);
    // The unknown home zone only labels the airline's timer (earliest-ending US zone), never the outcome.
    expect(carrierTimer(r)?.dueLocalDate).toBe("2026-10-13");
  });
});

describe("§10 R02: accepted alternative → not_eligible; \"I don't know\" → needs_facts (DA-A-1)", () => {
  it("accepted rebooking and flew it → not_eligible", () => {
    const r = evalFacts(with_(R02_01, { consumer_response: C("enum", "accepted_rebooking"), flew_changed_or_alternative: C("boolean", true) }));
    expect(r.outcome).toBe("not_eligible");
    expect(r.disqualifierIds).toContain("r02.v1.not_flown");
  });

  it("accepted rebooking on a flight that has not departed yet → not_eligible (260.6(a)(1)(i))", () => {
    const r = evalFacts(with_(R02_01, {
      consumer_response: C("enum", "accepted_rebooking"), flew_changed_or_alternative: M("boolean"),
      changed_or_alternative_departs_at: C("datetime", "2026-10-06T07:00:00-04:00"),
    }));
    expect(r.outcome).toBe("not_eligible");
  });

  it("accepted rebooking but did not fly it → manual_review (L5)", () => {
    expect(evalFacts(with_(R02_01, { consumer_response: C("enum", "accepted_rebooking") })).outcome).toBe("manual_review");
  });

  it("\"I don't know\" whether I accepted → needs_facts, the decision is asked with reason user_unknown", () => {
    const view = r02View(buildAirSnapshot({
      transactionId: TXN_ID,
      rows: [
        ...rowsOf(with_(R02_01, {}, ["consumer_response"])),
        { subjectKey: TXN, key: "air.consumer_response", row: { state: "user_confirmed", value: { kind: "user_unknown" }, at: 5, source: { kind: "user" } } },
      ],
    }));
    const r = run(view, R02_01.now, verified);
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["air.consumer_response", "user_unknown"]]);
    expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: TXN, key: "air.consumer_response" }] });
  });

  it("no response, the changed flight still to depart → not_yet_due at its departure date, next action wait", () => {
    const r = evalFacts(with_(R02_01, {
      consumer_response: C("enum", "no_response"), consumer_response_at: M("datetime"), flew_changed_or_alternative: M("boolean"),
      changed_or_alternative_departs_at: C("datetime", "2026-10-05T11:00:00-04:00"),
    }));
    expect(r.outcome).toBe("not_yet_due");
    expect(r.reevaluate?.at).toBe("2026-10-05");
    expect(r.nextAction.kind).toBe("wait");
    expect(r.amount).toBeNull();
  });
});

describe("§10 R02: merchant of record and the carrier timer (D143.2, DA-A-5, DA-A-25)", () => {
  it("carrier → track (track_automatic), 7 business days for a credit card", () => {
    const r = evalFacts(R02_01.facts as Facts);
    expect(r.outcome).toBe("eligible");
    expect(r.nextAction).toEqual({ kind: "track" });
    const d = carrierTimer(r)!;
    expect([d.id, d.obligor, d.status, d.dueLocalDate]).toEqual([R02_CARRIER_TIMER_CREDIT_ID, "counterparty", "open", "2026-10-13"]);
  });

  it("cash / check / debit / other → 20 calendar days, with the DOT page's '20 business days' disclosed", () => {
    for (const pay of ["cash", "check", "debit_card", "other", "miles"]) {
      const r = evalFacts(with_(R02_01, { payment_method_class: C("enum", pay) }));
      const d = carrierTimer(r)!;
      expect(d.id, pay).toBe(R02_CARRIER_TIMER_OTHER_ID);
      expect(d.dueLocalDate, pay).toBe("2026-10-21");
      expect(d.basis).toContain("20 business days");
    }
  });

  it("an unknown payment class → timer unknown_anchor, outcome unaffected, never asked", () => {
    const r = evalFacts(with_(R02_01, { payment_method_class: M("enum") }));
    expect(r.outcome).toBe("eligible");
    expect(r.missingFacts).toEqual([]);
    const d = carrierTimer(r)!;
    expect(d.status).toBe("unknown_anchor");
    expect(d.dueAt).toBeUndefined();
  });

  it("ticket agent → request_refund (399.80(l)); its timer is not computable", () => {
    const r = evalFacts(with_(R02_01, { merchant_of_record: C("enum", "ticket_agent") }));
    expect(r.nextAction).toEqual({ kind: "request_refund" });
    expect(r.deadlines.map((d) => [d.id, d.status])).toEqual([[R02_AGENT_TIMER_ID, "unknown_anchor"]]);
  });

  it("carrier deadline + 1 day → overdue, next action escalate, outcome unchanged", () => {
    const now = Date.parse("2026-10-15T12:00:00-04:00");
    const r = run(viewOf(R02_01.facts), now, verificationFor({ source: null, clock: "2026-10-15T12:00:00-04:00" }));
    expect(r.outcome).toBe("eligible");
    const d = carrierTimer(r)!;
    expect(d.status).toBe("overdue");
    expect(d.overdueSince).toBe(d.dueAt);
    expect(r.nextAction.kind).toBe("escalate");
    // …and the day itself is still in time.
    const onDay = run(viewOf(R02_01.facts), Date.parse("2026-10-13T20:00:00-04:00"), verified);
    expect(carrierTimer(onDay)!.status).toBe("open");
    expect(onDay.nextAction.kind).toBe("track");
  });

  it("a confirmed home time zone moves the local due date (A1)", () => {
    const r = evalFacts(with_(R02_01, { consumer_response_at: C("datetime", "2026-10-01T23:30:00-04:00") }));
    expect(carrierTimer(r)!.dueLocalDate).toBe("2026-10-13"); // Eastern: still 1 October
    const view = viewOf(with_(R02_01, { consumer_response_at: C("datetime", "2026-10-01T23:30:00-04:00") }), [
      { subjectKey: TXN, key: "air.home_time_zone", row: { state: "user_confirmed", value: { kind: "code", code: "Pacific/Guam" }, at: 1, source: { kind: "user" } } },
    ]);
    const guam = run(view, R02_01.now, verified);
    expect(carrierTimer(guam)!.dueLocalDate).toBe("2026-10-14"); // Guam: 2 October → 7 business days
    expect(guam.explanation.join(" ")).not.toContain("time zone is not known");
  });
});

describe("§10 R02: a one-hour delay with no other qualifying event → no cash opportunity", () => {
  it("R02-05 (flew) and the same delay not flown → not_eligible, no amount, R15 pointer", () => {
    const r05 = FILE.cases.find((c) => c.id === "R02-05")!;
    const notFlown = evalFacts(with_(r05, {
      flew_changed_or_alternative: C("boolean", false), consumer_response: C("enum", "rejected"), merchant_of_record: C("enum", "carrier"),
      ticket_refundability: C("enum", "nonrefundable"),
    }), r05.now);
    for (const r of [runCase(r05), notFlown]) {
      expect(r.outcome).toBe("not_eligible");
      expect(r.amount).toBeNull();
    }
    expect(notFlown.explanation.join(" ")).toContain("R15");
  });
});

describe("§10 R02 / DA-A-18: a voucher recorded as accepted → the acceptance fact makes R02 not_eligible", () => {
  it("AIR_VOUCHER_ACCEPTANCE written after a 'rejected' answer (which the writer supersedes) → not_eligible", () => {
    const view = viewOf(with_(R02_01, {}, ["consumer_response"]), [
      { subjectKey: TXN, key: "air.consumer_response", row: { state: "superseded", value: { kind: "code", code: "rejected" }, at: 1, source: { kind: "user" } } },
      { subjectKey: AIR_VOUCHER_ACCEPTANCE.subjectKey, key: AIR_VOUCHER_ACCEPTANCE.key, row: { state: "user_confirmed", value: AIR_VOUCHER_ACCEPTANCE.value, at: 99, source: { kind: "user" } } },
    ]);
    const r = run(view, R02_01.now, verified);
    expect(r.outcome).toBe("not_eligible");
    expect(r.disqualifierIds).toContain("r02.v1.deemed_request");
    expect(getFactSpec(AIR_VOUCHER_ACCEPTANCE.key)?.codes).toContain(AIR_VOUCHER_ACCEPTANCE.value.code);
  });
});

describe("R02 v1 pack invariants", () => {
  afterEach(() => resetTestRegistry());

  it("every parameter cites passages present in the spec or the captured excerpts", () => {
    const spec = readFileSync(path.join(REPO_ROOT, "docs/rules/R02-airline-refund.md"), "utf8");
    const excerpts = readFileSync(path.join(REPO_ROOT, "docs/rules/sources/federal-web-pages-excerpts.md"), "utf8");
    for (const [param, passages] of Object.entries(R02_PARAM_PASSAGES)) {
      expect(passages.length, param).toBeGreaterThan(0);
      for (const id of passages) expect(spec.includes(id) || excerpts.includes(`**${id}**`), `${param}: ${id}`).toBe(true);
    }
    expect(Object.keys(R02_PARAM_PASSAGES).sort()).toEqual(Object.keys(R02_V1_PARAMS).sort());
    expect(Object.isFrozen(R02_V1_PARAMS)).toBe(true);
    for (const s of R02_SOURCES) expect(spec.includes(s.passageId) || excerpts.includes(`**${s.passageId}**`), s.passageId).toBe(true);
  });

  it("the production registry never returns R02 v1 (not activated); the test registry does (DA-A-11)", () => {
    expect(prod.IMPLEMENTED_PACKS).toContain(r02AirRefundV1);
    expect(prod.activePack("R02")).toBeNull();
    expect(prod.activePacksForCategory("air_travel")).toEqual([]);
    setTestActivations([{ ruleId: r02AirRefundV1.ruleId, version: 1, status: "active", decision: "TEST" }]);
    expect(testActivePack("R02")).toBe(r02AirRefundV1);
    setTestActivations([]);
    expect(testActivePack("R02")).toBeNull();
  });

  it("bound facts are canonical, value-only and ≤ 32 (N6)", () => {
    const r = runCase(R02_01);
    expect(r.boundFacts.length).toBe(R02_BOUND_KEYS.length);
    expect(r.boundFacts.length).toBeLessThanOrEqual(32);
    const ids = r.boundFacts.map((b) => `${b.subjectKey}\u0000${b.key}`);
    expect(ids).toEqual([...ids].sort());
    expect(r.boundFacts.find((b) => b.key === "air.fare_paid")?.value).toEqual({ kind: "money", amountMinor: 38000, currency: "USD" });
  });

  it("a candidate anchor or a disputed anchor never gives a firm carrier date (D154)", () => {
    const candidate = evalFacts(with_(R02_01, { consumer_response_at: { type: "datetime", value: "2026-10-01T15:20:00-04:00", state: "extracted_candidate" } }));
    expect(candidate.outcome).toBe("likely_eligible");
    expect(carrierTimer(candidate)!.status).toBe("unknown_anchor");
    expect(carrierTimer(candidate)!.dueAt).toBeUndefined();
    const disputed = evalFacts(with_(R02_01, {
      consumer_response_at: { type: "datetime", value: null, state: "conflicting", conflict_kind: "candidates", candidates: [{ value: "2026-10-01T15:20:00-04:00", evidence: "email" }, { value: "2026-09-25T09:00:00-04:00", evidence: "chat" }] },
    }), Date.parse("2026-11-30T12:00:00-05:00"));
    expect(disputed.outcome).toBe("likely_eligible");
    const d = carrierTimer(disputed)!;
    expect(d.status).toBe("disputed_anchor");
    expect(d.overdueSince).toBeUndefined();
    expect(disputed.nextAction).toEqual({ kind: "track" });
  });

  it("D208 adapter: live rows → one run on the ticket (txn), whose evaluation equals the direct one", () => {
    const runs = r02Adapter.runs({ transactionId: TXN_ID, isExample: false, rows: rowsOf(R02_01.facts) });
    expect(runs.map((r) => r.subjectKey)).toEqual([TXN]);
    expect(runs[0].lookup.get(TXN, "air.fare_paid").status).toBe("confirmed");
    expect(run(runs[0].snapshot, R02_01.now, verified)).toEqual(runCase(R02_01));
    expect(r02Adapter.runs({ transactionId: TXN_ID, isExample: false, rows: [] })).toHaveLength(1);
  });

  it("the pack declares itself researched and cites only captured sources", () => {
    expect(r02AirRefundV1.lifecycle).toBe("researched");
    expect(r02AirRefundV1.fixturesPath).toBe("docs/rules/fixtures/R02.json");
    expect(new Set(R02_SOURCES.map((s) => s.sourceId))).toEqual(new Set(["ecfr-14cfr260", "usc-49-42305", "ecfr-14cfr399.80l", "federal-web-excerpts", "fr-notices"]));
  });
});
