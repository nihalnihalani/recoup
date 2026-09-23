/**
 * M27 review findings for R02 v1 (docs/reviews/2026-09-23-pack-review-R02-R05.md, R02 section) and the lead's rulings
 * D234/D235: one describe per finding, named by its id, each asserting the reviewer's "Regression test" row. Each
 * fails on the reviewed revision `3d5cb7f` and passes after M22b (the few that pin a ruling rather than a fix say so).
 * Facts are built directly as resolution rows; only exports that existed at `3d5cb7f` are used, so the same file runs
 * against both revisions.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { getFactSpec, type FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r02View, type CellRow } from "../facts/snapshot_air";
import { resultHash } from "./outcome";
import { evaluateR02V1, r02AirRefundV1, R02_CARRIER_TIMER_CREDIT_ID, R02_SOURCES, R02_V1_PARAMS } from "./r02_air_refund_v1";
import { ENGINE_VERSION, type EvaluationResult } from "./types";

const TXN_ID = "m27txnr02" as Id<"transactions">;
type State = ResolveRow["state"];
type F = [FactValue, State?] | [FactValue, State, FactValue, State];
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const yes = (b: boolean): FactValue => ({ kind: "bool", value: b });
const txt = (t: string): FactValue => ({ kind: "text", text: t });
const n = (x: number): FactValue => ({ kind: "count", n: x });
const unknown: FactValue = { kind: "user_unknown" };

/** R02-01's confirmed facts (cancellation, rejected on 2026-10-01, credit card, USD 448.80). */
const R02_01: Record<string, F> = {
  itinerary_scope: [code("domestic"), "derived"], operating_carrier: [txt("XA")], marketing_carrier: [txt("XA")],
  merchant_of_record: [code("carrier")], ticket_refundability: [code("nonrefundable")], event_type: [code("cancellation")],
  original_sched_departure_at: [at("2026-10-05T07:00:00-04:00")], offer_type: [code("rebooking")], consumer_response: [code("rejected")],
  consumer_response_at: [at("2026-10-01T15:20:00-04:00")], flew_changed_or_alternative: [yes(false)], payment_method_class: [code("credit_card")],
  fare_paid: [usd(38_000)], taxes_paid: [usd(4_380)], ancillary_fees_total: [usd(2_500)], already_refunded: [usd(0)],
};
/** R02-02a's confirmed facts (domestic schedule change, every criterion confirmed equal) with the arrival to vary. */
const R02_02: Record<string, F> = {
  itinerary_scope: [code("domestic"), "derived"], merchant_of_record: [code("carrier")], ticket_refundability: [code("nonrefundable")],
  event_type: [code("schedule_change")], original_sched_departure_at: [at("2026-11-10T10:00:00-05:00")],
  original_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")], changed_sched_departure_at: [at("2026-11-10T10:00:00-05:00")],
  original_origin_airport: [txt("BOS")], original_destination_airport: [txt("ATL")], changed_origin_airport: [txt("BOS")],
  changed_destination_airport: [txt("ATL")], original_connections: [n(0)], changed_connections: [n(0)], original_cabin: [code("economy")],
  changed_cabin: [code("economy")], consumer_response: [code("rejected")], consumer_response_at: [at("2026-11-02T09:00:00-05:00")],
  flew_changed_or_alternative: [yes(false)], payment_method_class: [code("credit_card")], fare_paid: [usd(21_900)], taxes_paid: [usd(3_120)],
  already_refunded: [usd(0)], operating_carrier: [txt("XA")], marketing_carrier: [txt("XA")], ancillary_fees_total: [usd(0)], offer_type: [code("rebooking")],
};
const NOW_01 = Date.parse("2026-10-02T12:00:00-04:00");
const NOW_02 = Date.parse("2026-11-03T12:00:00-05:00");

function rowsOf(facts: Record<string, F | null>, extra: CellRow[] = []): CellRow[] {
  const rows: CellRow[] = [];
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) continue;
    const key = name.includes(".") ? name : `air.${name}`;
    const source = (s: State) => (s === "user_confirmed" ? { kind: "user" as const } : { kind: "evidence" as const, ref: "doc" });
    rows.push({ subjectKey: "txn", key, row: { state: f[1] ?? "user_confirmed", value: f[0], at: 1, source: source(f[1] ?? "user_confirmed") } });
    if (f.length === 4) rows.push({ subjectKey: "txn", key, row: { state: f[3], value: f[2], at: 2, source: source(f[3]) } });
  }
  return [...rows, ...extra];
}
function run(facts: Record<string, F | null>, now: number, extra: CellRow[] = [], verifiedOn = new Date(now).toISOString().slice(0, 10)): EvaluationResult {
  return evaluateR02V1({
    snapshot: r02View(buildAirSnapshot({ transactionId: TXN_ID, rows: rowsOf(facts, extra) })), snapshotHash: "m27", engineVersion: ENGINE_VERSION,
    remedyKey: r02AirRefundV1.remedyKey, subjectKey: "txn",
    pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: 1, params: R02_V1_PARAMS, sources: R02_SOURCES },
    verification: Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: verifiedOn }])),
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}
const listed = (r: EvaluationResult) => r.missingFacts.map((m) => `${m.key}:${m.reason}`).sort();
const carrierTimer = (r: EvaluationResult) => r.deadlines.find((d) => d.id.startsWith("r02.v1.carrier_refund"));
const cand = (v: FactValue): F => [v, "extracted_candidate"];

describe("R02-01 (high): a negative verdict never rests on one unconfirmed candidate (D234 (1))", () => {
  it.each([
    ["consumer_response = accepted_compensation", { consumer_response: cand(code("accepted_compensation")) }, "air.consumer_response"],
    ["flew = true", { flew_changed_or_alternative: cand(yes(true)) }, "air.flew_changed_or_alternative"],
    ["ticket_refundability = refundable", { ticket_refundability: cand(code("refundable")) }, "air.ticket_refundability"],
    ["itinerary_scope = non_us", { itinerary_scope: cand(code("non_us")) }, "air.itinerary_scope"],
  ] as const)("a candidate %s → needs_facts asking it; the confirmed value keeps its verdict", (_n, change, key) => {
    const r = run({ ...R02_01, ...change }, NOW_01);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain(`${key}:candidate_unconfirmed`);
    const confirmed = run({ ...R02_01, ...Object.fromEntries(Object.entries(change).map(([k, v]) => [k, [v[0]] as F])) }, NOW_01);
    expect(["not_eligible", "unsupported"]).toContain(confirmed.outcome);
  });

  it("an OBSERVED accepted_compensation is asked too (P-260.7: only the user's own agreement counts)", () => {
    const r = run({ ...R02_01, consumer_response: [code("accepted_compensation"), "observed"] }, NOW_01);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.consumer_response:candidate_unconfirmed");
  });

  it("a single candidate changed arrival at +2h59 → needs_facts, not not_eligible", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: cand(at("2026-11-10T16:59:00-05:00")) }, NOW_02);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.changed_sched_arrival_at:candidate_unconfirmed");
  });

  it("a 5c pair of candidates both below 3 h is never a not_eligible with an empty question list", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T16:40:00-05:00"), "extracted_candidate", at("2026-11-10T16:50:00-05:00"), "extracted_candidate"] }, NOW_02);
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => m.key)).toContain("air.changed_sched_arrival_at");
  });

  it("R02-09a (a confirmed acceptance of compensation) stays not_eligible", () => {
    expect(run({ ...R02_01, consumer_response: [code("accepted_compensation")] }, NOW_01).outcome).toBe("not_eligible");
  });
});

describe("R02-02 (high): event_type is decisive (§16.8) for every event", () => {
  const straddle = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T17:10:00-05:00")] as F, actual_arrival_at: [at("2026-11-10T16:50:00-05:00")] as F };
  it("straddle + a candidate schedule_change → likely_eligible with event_type listed as unconfirmed", () => {
    const r = run({ ...straddle, event_type: cand(code("schedule_change")) }, NOW_02);
    expect(r.outcome).toBe("likely_eligible");
    expect(listed(r)).toContain("air.event_type:candidate_unconfirmed");
  });
  it("event_type missing or \"I don't know\" → needs_facts asking it", () => {
    expect(listed(run({ ...straddle, event_type: null }, NOW_02))).toEqual(["air.event_type:missing"]);
    expect(listed(run({ ...straddle, event_type: [unknown] }, NOW_02))).toEqual(["air.event_type:user_unknown"]);
  });
  it("a confirmed operational_delay with the straddle → manual_review", () => {
    expect(run({ ...straddle, event_type: [code("operational_delay")] }, NOW_02).outcome).toBe("manual_review");
  });
  it("R02-02b with only event_type a candidate → likely_eligible (capped)", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T17:00:00-05:00")], event_type: cand(code("schedule_change")) }, NOW_02);
    expect(r.outcome).toBe("likely_eligible");
  });
});

describe("R02-03 (high): a downgrade flown after accepting the rebooking is the L4 review", () => {
  const down = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")] as F, event_type: [code("downgrade")] as F, original_cabin: [code("business")] as F, changed_cabin: [code("economy")] as F, flew_changed_or_alternative: [yes(true)] as F };
  const now = Date.parse("2026-11-11T12:00:00-05:00");
  it("accepted_rebooking + flew + downgrade → manual_review (L4)", () => {
    const r = run({ ...down, consumer_response: [code("accepted_rebooking")] }, now);
    expect(r.outcome).toBe("manual_review");
    expect(r.explanation.join(" ")).toContain("L4");
  });
  it("flew + accepted_rebooking without a downgrade → not_eligible (unchanged)", () => {
    expect(run({ ...down, original_cabin: [code("economy")], consumer_response: [code("accepted_rebooking")] }, now).outcome).toBe("not_eligible");
  });
});

describe("R02-04 (medium): a manual_review shows no firm carrier date (D234 (6)); L5 has no timer", () => {
  const late = Date.parse("2026-10-20T12:00:00-04:00");
  it("renumbered-only (R02-10 shape) + consumer_response_at + credit card, clock after the would-be due date", () => {
    const r = run({ ...R02_01, event_type: [code("renumbered_only"), "derived"] }, late);
    expect(r.outcome).toBe("manual_review");
    expect(r.deadlines.filter((d) => d.dueAt !== undefined || d.overdueSince !== undefined)).toEqual([]);
  });
  it("L5: accepted rebooking, not flown → no carrier timer at all", () => {
    const r = run({ ...R02_01, consumer_response: [code("accepted_rebooking")] }, late);
    expect(r.outcome).toBe("manual_review");
    expect(r.deadlines).toEqual([]);
  });
});

describe("R02-06 (medium): with the zone unknown the carrier is late only after the latest zone (D234 (8), D235 (A))", () => {
  it("anchor 2026-10-01T00:30-04:00, clock 2026-10-10 → open, no escalate, 'on or about 2026-10-09 – 2026-10-13'", () => {
    const r = run({ ...R02_01, consumer_response_at: [at("2026-10-01T00:30:00-04:00")] }, Date.parse("2026-10-10T12:00:00-04:00"));
    expect(carrierTimer(r)?.status).toBe("open");
    expect(r.nextAction.kind).toBe("track");
    expect(r.explanation.join(" ")).toContain("2026-10-09 – 2026-10-13");
  });
  it("with a confirmed home zone (New York) the date is 2026-10-13, as before", () => {
    const r = run({ ...R02_01, consumer_response_at: [at("2026-10-01T00:30:00-04:00")], home_time_zone: [code("America/New_York")] }, Date.parse("2026-10-10T12:00:00-04:00"));
    expect(carrierTimer(r)?.dueLocalDate).toBe("2026-10-13");
  });
});

describe("R02-07 (medium): a candidate payment class selects no timer and never escalates (D234 (3))", () => {
  it("candidate credit_card → timer unknown_anchor, no dueAt; at 10-15 no escalate; the outcome is not affected", () => {
    const early = run({ ...R02_01, payment_method_class: cand(code("credit_card")) }, NOW_01);
    expect(early.outcome).toBe("eligible");
    expect(carrierTimer(early)?.status).toBe("unknown_anchor");
    expect(carrierTimer(early)?.dueAt).toBeUndefined();
    const later = run({ ...R02_01, payment_method_class: cand(code("credit_card")) }, Date.parse("2026-10-15T12:00:00-04:00"));
    expect(later.nextAction.kind).not.toBe("escalate");
  });
  it("a confirmed credit_card → 2026-10-13 (unchanged); a candidate home zone is ignored", () => {
    expect(carrierTimer(run(R02_01, NOW_01))?.dueLocalDate).toBe("2026-10-13");
    const withCandZone = run({ ...R02_01, home_time_zone: cand(code("Pacific/Guam")) }, NOW_01);
    expect(carrierTimer(withCandZone)?.dueLocalDate).toBe(carrierTimer(run(R02_01, NOW_01))?.dueLocalDate);
  });
});

describe("R02-08 (medium): a rejection with a future departure still asks whether you flew", () => {
  it("R02-01 without flew, confirmed departure 2026-10-06, clock 10-02 → needs_facts [flew]", () => {
    const r = run({ ...R02_01, flew_changed_or_alternative: null, changed_or_alternative_departs_at: [at("2026-10-06T11:00:00-04:00")] }, NOW_01);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toEqual(["air.flew_changed_or_alternative:missing"]);
  });
});

describe("R02-09 (medium): only the user's own confirmed disability triggers the L11 review", () => {
  const below = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T16:59:00-05:00")] as F };
  it("a candidate or observed `true` → not_eligible (as R02-02a); user_confirmed `true` → manual_review", () => {
    expect(run({ ...below, passenger_disability_relevant: cand(yes(true)) }, NOW_02).outcome).toBe("not_eligible");
    expect(run({ ...below, passenger_disability_relevant: [yes(true), "observed"] }, NOW_02).outcome).toBe("not_eligible");
    expect(run({ ...below, passenger_disability_relevant: [yes(true)] }, NOW_02).outcome).toBe("manual_review");
  });
  it("R02-02b + a candidate `true` stays eligible", () => {
    expect(run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T17:00:00-05:00")], passenger_disability_relevant: cand(yes(true)) }, NOW_02).outcome).toBe("eligible");
  });
});

describe("R02-10 (medium): refunds never change the outcome (D234 (4), D235 (B))", () => {
  it("R02-01 + already_refunded 44,880 → eligible, no estimate, 'nothing outstanding'", () => {
    const r = run({ ...R02_01, already_refunded: [usd(44_880)] }, NOW_01);
    expect(r.outcome).toBe("eligible");
    expect(r.amount).toBeNull();
    expect(r.explanation.join(" ")).toContain("Nothing is outstanding");
  });
  it("an over-refund is flagged", () => {
    expect(run({ ...R02_01, already_refunded: [usd(50_000)] }, NOW_01).explanation.join(" ")).toContain("more than you paid");
  });
  it("renumbered (R02-10) and 5a (R02-13) keep manual_review; response missing (R02-04) keeps needs_facts", () => {
    expect(run({ ...R02_01, already_refunded: [usd(44_880)], event_type: [code("renumbered_only"), "derived"] }, NOW_01).outcome).toBe("manual_review");
    expect(run({ ...R02_01, already_refunded: [usd(44_880)], consumer_response: [code("rejected"), "user_confirmed", code("accepted_rebooking"), "observed"] }, NOW_01).outcome).toBe("manual_review");
    expect(run({ ...R02_01, already_refunded: [usd(44_880)], consumer_response: null }, NOW_01).outcome).toBe("needs_facts");
  });
  it("a candidate full refund is never not_eligible", () => {
    expect(run({ ...R02_01, already_refunded: cand(usd(44_880)) }, NOW_01).outcome).not.toBe("not_eligible");
  });
});

describe("R02-11 (medium): not_yet_due only from known facts", () => {
  const noResponse = { ...R02_01, consumer_response: [code("no_response")] as F, consumer_response_at: null, flew_changed_or_alternative: null };
  it("a candidate future departure → needs_facts asking it (not not_yet_due)", () => {
    const r = run({ ...noResponse, changed_or_alternative_departs_at: cand(at("2026-10-05T11:00:00-04:00")) }, NOW_01);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.changed_or_alternative_departs_at:candidate_unconfirmed");
  });
  it("a candidate no_response with a confirmed future departure → needs_facts asking the decision", () => {
    const r = run({ ...noResponse, consumer_response: cand(code("no_response")), changed_or_alternative_departs_at: [at("2026-10-05T11:00:00-04:00")] }, NOW_01);
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.consumer_response:candidate_unconfirmed");
  });
  it("the confirmed no-response case is unchanged: not_yet_due at 2026-10-05", () => {
    const r = run({ ...noResponse, changed_or_alternative_departs_at: [at("2026-10-05T11:00:00-04:00")] }, NOW_01);
    expect([r.outcome, r.reevaluate?.at]).toEqual(["not_yet_due", "2026-10-05"]);
  });
});

describe("R02-12 (medium): an unknown compliance date or zone is capped with an assumption (README rule 5, D234 (8))", () => {
  const agent = { ...R02_01, merchant_of_record: [code("ticket_agent")] as F };
  it("(1) R02.b with no date at all → likely_eligible with the assumption", () => {
    const r = run({ ...agent, consumer_response_at: null, original_sched_departure_at: null }, NOW_01);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((a) => a.id)).toContain("r02.v1.after_compliance_date");
  });
  it("(2) R02.b with only confirmed 2023 arrivals → source_unverified", () => {
    const r = run({ ...agent, consumer_response_at: null, original_sched_departure_at: null, original_sched_arrival_at: [at("2023-05-03T10:00:00-04:00")] }, NOW_01);
    expect(r.outcome).toBe("source_unverified");
  });
  it("(3) an anchor at 2024-10-28T03:00Z: zone unknown → likely_eligible; confirmed New York → source_unverified", () => {
    const f = { ...R02_01, consumer_response_at: [at("2024-10-28T03:00:00Z")] as F, original_sched_departure_at: [at("2024-10-30T07:00:00-04:00")] as F };
    const now = Date.parse("2024-10-29T12:00:00-04:00");
    expect(run(f, now).outcome).toBe("likely_eligible");
    expect(run({ ...f, home_time_zone: [code("America/New_York")] }, now).outcome).toBe("source_unverified");
  });
});

describe("R02-13 (medium): airports are compared as IATA codes", () => {
  const plusOne = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T15:00:00-05:00")] as F };
  it("'Boston Logan (BOS)' or 'KATL' → needs_facts, not eligible", () => {
    expect(run({ ...plusOne, changed_origin_airport: [txt("Boston Logan (BOS)")] }, NOW_02).outcome).toBe("needs_facts");
    expect(run({ ...plusOne, changed_destination_airport: [txt("KATL")] }, NOW_02).outcome).toBe("needs_facts");
  });
  it("BOS → PVD stays eligible", () => {
    expect(run({ ...plusOne, changed_origin_airport: [txt("PVD")] }, NOW_02).outcome).toBe("eligible");
  });
});

describe("R02-14 (low, ruling D234 (2)): offer_type decides nothing on a rejection", () => {
  it("a candidate offer_type on the rejected path does not cap (pins the ruling; unchanged behaviour)", () => {
    expect(run({ ...R02_01, offer_type: cand(code("rebooking")) }, NOW_01).outcome).toBe("eligible");
  });
});

describe("R02-15 (low, D234 (17)): a recorded bag fee shares R04 path a's loss key", () => {
  it("R02's loss keys include the bag fee's key, so an overlap unions instead of adding", () => {
    const r = run(R02_01, NOW_01, [
      { subjectKey: "txn", key: "air.bag_fee_paid", row: { state: "user_confirmed", value: usd(4_000), at: 1, source: { kind: "user" } } },
      { subjectKey: "txn", key: "air.bag_tag_number", row: { state: "user_confirmed", value: { kind: "identifier", scheme: "bag_tag", value: "0123456789" }, at: 1, source: { kind: "user" } } },
    ]);
    expect(r.lossKeys).toEqual([`txn:${TXN_ID}:fare_unused`, `txn:${TXN_ID}:bag_fee:0123456789`]);
    expect(getFactSpec("air.ancillary_fees_total")?.question.prompt).toContain("not checked-bag fees");
  });
});

describe("R02-16 (low): bound facts include every significance input", () => {
  it("an airport-change result binds the airports, connections and cabins; ≤ 32", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T15:00:00-05:00")], changed_destination_airport: [txt("PDK")] }, NOW_02);
    const keys = r.boundFacts.map((b) => b.key);
    expect(keys).toEqual(expect.arrayContaining(["air.changed_destination_airport", "air.original_connections", "air.changed_cabin"]));
    expect(r.boundFacts.length).toBeLessThanOrEqual(32);
  });
});

describe("R02-17 (low): the precedence of a known disqualifier over the reviews is documented and pinned", () => {
  it("the limitation says so; renumbered-only + flew → not_eligible", () => {
    expect(r02AirRefundV1.knownLimitations.join(" ")).toMatch(/known disqualifier .* outranks the L1\/L11\/straddle reviews/);
    expect(run({ ...R02_01, event_type: [code("renumbered_only"), "derived"], flew_changed_or_alternative: [yes(true)] }, NOW_01).outcome).toBe("not_eligible");
  });
});

describe("R02-18 (low): R03 is declared as the alternative channel; R12 is recorded", () => {
  const r03 = { withScenario: "R03", withRemedyKey: "billing_error_credit", relation: "alternative" };
  it("the pack declares R03; a known credit-card payment carries it on the result, a debit card does not", () => {
    expect(r02AirRefundV1.overlap).toEqual([r03]);
    expect(run(R02_01, NOW_01).overlap).toEqual([r03]);
    expect(run({ ...R02_01, payment_method_class: [code("debit_card")] }, NOW_01).overlap).toEqual([]);
    expect(r02AirRefundV1.knownLimitations.join(" ")).toContain("R12");
  });
});

describe("R02-20 (low): after the renumbered-flight pause the renumbered path is source_unverified", () => {
  it("renumbered_only, clock 2027-08-01, sources verified that day → source_unverified", () => {
    const f = { ...R02_01, event_type: [code("renumbered_only"), "derived"] as F, consumer_response_at: [at("2027-07-20T10:00:00-04:00")] as F, original_sched_departure_at: [at("2027-07-25T07:00:00-04:00")] as F };
    expect(run(f, Date.parse("2027-08-01T12:00:00-04:00")).outcome).toBe("source_unverified");
  });
});

describe("R02-21 (low): an absurd amount never throws", () => {
  it("a candidate fare of MAX_SAFE_INTEGER + taxes → an evaluation, amount null", () => {
    let r: EvaluationResult | null = null;
    expect(() => { r = run({ ...R02_01, fare_paid: cand(usd(Number.MAX_SAFE_INTEGER)) }, NOW_01); }).not.toThrow();
    expect(r!.amount).toBeNull();
  });
});

describe("R02-22 (low): a note never contradicts its result", () => {
  it("a changed arrival 2h59m30s later reads 2h59m", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T16:59:30-05:00")] }, NOW_02);
    expect(r.conditions.find((c) => c.id === "r02.v1.sig.c2")?.note).toContain("2h59m");
  });
});

describe("R02-23 (low): an \"I don't know\" answer does not hold back the next stage", () => {
  it("user_unknown response with the merchant of record missing → both are listed", () => {
    const r = run({ ...R02_01, consumer_response: [unknown], merchant_of_record: null }, NOW_01);
    expect(listed(r)).toEqual(expect.arrayContaining(["air.consumer_response:user_unknown", "air.merchant_of_record:missing"]));
  });
});

describe("R02-24 (low): a failed significance tells the user what else exists", () => {
  it("R02-02b at +2h00 → not_eligible, the explanation mentions 260.6(b) and R15", () => {
    const r = run({ ...R02_02, changed_sched_arrival_at: [at("2026-11-10T16:00:00-05:00")] }, NOW_02);
    expect(r.outcome).toBe("not_eligible");
    expect(r.explanation.join(" ")).toMatch(/260\.6\(b\)/);
    expect(r.explanation.join(" ")).toContain("R15");
  });
});

describe("D235 (B): already_refunded is money refunded before the case; case credits are never subtracted", () => {
  it("the question says so, and settled case money does not change the estimate", async () => {
    expect(getFactSpec("air.already_refunded")?.question.prompt).toContain("before you started this case");
    const plain = run(R02_01, NOW_01);
    const withCredit = evaluateR02V1({
      snapshot: r02View(buildAirSnapshot({ transactionId: TXN_ID, rows: rowsOf(R02_01) })), snapshotHash: "m27", engineVersion: ENGINE_VERSION,
      remedyKey: r02AirRefundV1.remedyKey, subjectKey: "txn",
      pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: 1, params: R02_V1_PARAMS, sources: R02_SOURCES },
      verification: Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: "2026-10-02" }])),
      caseContext: { settledMinorByLossKey: { [`txn:${TXN_ID}:fare_unused`]: 20_000 } }, now: NOW_01,
    });
    expect(withCredit.amount?.estimate).toEqual(plain.amount?.estimate);
    expect(await resultHash(withCredit, "b")).toBe(await resultHash(plain, "b"));
  });
});

describe("DA-A-25: the carrier path is tracked (track_automatic), the agency path requested", () => {
  it("caseMode", () => {
    const mode = (r02AirRefundV1 as unknown as { caseMode?: (r: EvaluationResult) => string }).caseMode;
    expect(mode?.(run(R02_01, NOW_01))).toBe("track_automatic");
    expect(mode?.(run({ ...R02_01, merchant_of_record: [code("ticket_agent")] }, NOW_01))).toBe("request");
  });
  it("a confirmed carrier deadline + 1 day still escalates", () => {
    const r = run(R02_01, Date.parse("2026-10-15T12:00:00-04:00"));
    expect(carrierTimer(r)?.id).toBe(R02_CARRIER_TIMER_CREDIT_ID);
    expect(r.nextAction.kind).toBe("escalate");
  });
});
