/**
 * M27c re-review findings for R02 v1 (recoup-wt-m27d-evidence/review.md) and the lead's rulings D270: one describe per
 * finding, named by its id, each asserting the reviewer's repro/regression. Every test here fails on `24dc6bf` (the
 * revision M27c reviewed) and passes after the batch-3 fixes. Facts reuse the review's own probe setups
 * (recoup-wt-m27d-evidence/probes/zz_m27d_targeted.test.ts.txt) so the repro numbers match the evidence exactly.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { components, type SummaryOpportunity } from "../../recovery";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r02View, type CellRow } from "../facts/snapshot_air";
import { evaluateR02V1, r02AirRefundV1, R02_SOURCES, R02_V1_PARAMS } from "./r02_air_refund_v1";
import { ENGINE_VERSION, type EvaluationResult } from "./types";

const TXN_ID = "m27ctxnr02" as Id<"transactions">;
type State = ResolveRow["state"];
type F = [FactValue, State?] | [FactValue, State, FactValue, State];
type Facts = Record<string, F | null>;
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const yes = (b: boolean): FactValue => ({ kind: "bool", value: b });
const txt = (t: string): FactValue => ({ kind: "text", text: t });
const n = (x: number): FactValue => ({ kind: "count", n: x });
const cand = (v: FactValue): F => [v, "extracted_candidate"];

/** R02-02a's confirmed facts (domestic schedule change): the arrival varies per test. */
const R02_02: Facts = {
  service_type: [code("scheduled")], itinerary_scope: [code("domestic"), "derived"], merchant_of_record: [code("carrier")],
  ticket_refundability: [code("nonrefundable")], event_type: [code("schedule_change")],
  original_sched_departure_at: [at("2026-11-10T10:00:00-05:00")], original_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")],
  changed_sched_departure_at: [at("2026-11-10T10:00:00-05:00")], changed_sched_arrival_at: [at("2026-11-10T16:59:00-05:00")],
  original_origin_airport: [txt("BOS")],
  original_destination_airport: [txt("ATL")], changed_origin_airport: [txt("BOS")], changed_destination_airport: [txt("ATL")],
  original_connections: [n(0)], changed_connections: [n(0)], original_cabin: [code("economy")], changed_cabin: [code("economy")],
  consumer_response: [code("rejected")], consumer_response_at: [at("2026-11-02T09:00:00-05:00")],
  flew_changed_or_alternative: [yes(false)], payment_method_class: [code("credit_card")], fare_paid: [usd(21_900)],
  taxes_paid: [usd(3_120)], already_refunded: [usd(0)], operating_carrier: [txt("XA")], marketing_carrier: [txt("XA")],
  ancillary_fees_total: [usd(0)], offer_type: [code("rebooking")],
};
/** R02-01's confirmed facts (cancellation, rejected, USD 448.80). */
const R02_01: Facts = {
  service_type: [code("scheduled")], itinerary_scope: [code("domestic"), "derived"], operating_carrier: [txt("XA")],
  marketing_carrier: [txt("XA")], merchant_of_record: [code("carrier")], ticket_refundability: [code("nonrefundable")],
  event_type: [code("cancellation")], original_sched_departure_at: [at("2026-10-05T07:00:00-04:00")], offer_type: [code("rebooking")],
  consumer_response: [code("rejected")], consumer_response_at: [at("2026-10-01T15:20:00-04:00")], flew_changed_or_alternative: [yes(false)],
  payment_method_class: [code("credit_card")], fare_paid: [usd(38_000)], taxes_paid: [usd(4_380)], ancillary_fees_total: [usd(2_500)],
  already_refunded: [usd(0)],
};
const NOW_02 = Date.parse("2026-11-03T12:00:00-05:00");
const NOW_01 = Date.parse("2026-10-02T12:00:00-04:00");

function rowsOf(facts: Facts, extra: CellRow[] = []): CellRow[] {
  const rows: CellRow[] = [];
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) continue;
    const key = name.includes(".") ? name : `air.${name}`;
    const source = (s: State) => (s === "user_confirmed" ? { kind: "user" as const } : s === "derived" ? { kind: "derived" as const } : { kind: "evidence" as const, ref: "doc" });
    rows.push({ subjectKey: "txn", key, row: { state: f[1] ?? "user_confirmed", value: f[0], at: 1, source: source(f[1] ?? "user_confirmed") } });
    if (f.length === 4) rows.push({ subjectKey: "txn", key, row: { state: f[3], value: f[2], at: 2, source: source(f[3]) } });
  }
  return [...rows, ...extra];
}
function run(facts: Facts, now: number, extra: CellRow[] = [], verifiedOn = new Date(now).toISOString().slice(0, 10)): EvaluationResult {
  return evaluateR02V1({
    snapshot: r02View(buildAirSnapshot({ transactionId: TXN_ID, rows: rowsOf(facts, extra) })), snapshotHash: "m27c", engineVersion: ENGINE_VERSION,
    remedyKey: r02AirRefundV1.remedyKey, subjectKey: "txn",
    pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: 1, params: R02_V1_PARAMS, sources: R02_SOURCES },
    verification: Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: verifiedOn }])),
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}
const listed = (r: EvaluationResult) => r.missingFacts.map((m) => `${m.key}:${m.reason}`).sort();

describe("N-R02-1 (high): a candidate that selects the rule still decides a negative (D234 (1))", () => {
  it("(a) R02-02a shape: a candidate event_type must not turn not_eligible into a settled verdict", () => {
    const confirmedChange = run(R02_02, NOW_02);
    expect(confirmedChange.outcome).toBe("not_eligible"); // control: below threshold, no candidate involved

    const candidateChange = run({ ...R02_02, event_type: cand(code("schedule_change")) }, NOW_02);
    expect(candidateChange.outcome).toBe("needs_facts"); // was not_eligible on 24dc6bf
    expect(listed(candidateChange)).toContain("air.event_type:candidate_unconfirmed");

    const confirmedCancellation = run({ ...R02_02, event_type: [code("cancellation")] }, NOW_02);
    expect(confirmedCancellation.outcome).toBe("eligible");
    expect(confirmedCancellation.amount?.estimate.amountMinor).toBe(25_020);
  });

  it("(c) a candidate operational_delay must not hide an airport change c3 never tests for a delay", () => {
    const airport: Facts = { ...R02_02, changed_destination_airport: [txt("PDK")] };
    const confirmedScheduleChange = run(airport, NOW_02);
    expect(confirmedScheduleChange.outcome).toBe("eligible"); // control: c3 catches the airport change

    const candidateOpDelay = run({ ...airport, event_type: cand(code("operational_delay")) }, NOW_02);
    expect(candidateOpDelay.outcome).toBe("needs_facts"); // was not_eligible on 24dc6bf
    expect(listed(candidateOpDelay)).toContain("air.event_type:candidate_unconfirmed");
  });

  it("(d) an operational-delay straddle: a candidate itinerary_scope must not remove the manual_review it would trigger confirmed", () => {
    const straddle: Facts = {
      ...R02_02, event_type: [code("operational_delay")], changed_sched_arrival_at: [at("2026-11-10T16:50:00-05:00")],
      actual_arrival_at: [at("2026-11-10T17:10:00-05:00")],
    };
    const confirmedDomestic = run(straddle, NOW_02);
    expect(confirmedDomestic.outcome).toBe("manual_review"); // control: revised (2h50) fails, actual (3h10) passes

    const candidateInternational = run({ ...straddle, itinerary_scope: cand(code("international")) }, NOW_02);
    expect(candidateInternational.outcome).toBe("needs_facts"); // was not_eligible on 24dc6bf
    expect(listed(candidateInternational)).toContain("air.itinerary_scope:candidate_unconfirmed");
  });

  it("(b) R02-02's own reverse-straddle repro: a candidate schedule_change must not settle it either", () => {
    const rev: Facts = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T16:50:00-05:00")], actual_arrival_at: [at("2026-11-10T17:10:00-05:00")] };
    const confirmedOpDelay = run({ ...rev, event_type: [code("operational_delay")] }, NOW_02);
    expect(confirmedOpDelay.outcome).toBe("manual_review"); // control

    const candidateScheduleChange = run({ ...rev, event_type: cand(code("schedule_change")) }, NOW_02);
    expect(candidateScheduleChange.outcome).toBe("needs_facts"); // was not_eligible ([]) on 24dc6bf
    expect(listed(candidateScheduleChange)).toContain("air.event_type:candidate_unconfirmed");
  });

  it("(e) L4 (downgrade flown): a candidate event_type must not keep a manual_review resting on it", () => {
    const down: Facts = {
      ...R02_02, changed_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")], event_type: [code("downgrade")],
      original_cabin: [code("business")], changed_cabin: [code("economy")], flew_changed_or_alternative: [yes(true)],
    };
    const late = Date.parse("2026-11-11T12:00:00-05:00");
    const confirmed = run(down, late);
    expect(confirmed.outcome).toBe("manual_review"); // control: L4

    const candidateEvent = run({ ...down, event_type: cand(code("downgrade")) }, late);
    expect(candidateEvent.outcome).toBe("needs_facts"); // was manual_review resting on the candidate on 24dc6bf
    expect(listed(candidateEvent)).toContain("air.event_type:candidate_unconfirmed");
  });
});

describe("N-R02-2 (medium): an extracted service type of \"unknown\" gives an uncapped eligible", () => {
  it("a candidate air.service_type = unknown caps at likely_eligible with A8, like every other unresolved form", () => {
    const candidateUnknown = run({ ...R02_01, service_type: cand(code("unknown")) }, NOW_01);
    expect(candidateUnknown.outcome).toBe("likely_eligible"); // was "eligible", no A8, on 24dc6bf
    expect(candidateUnknown.amount?.estimate.amountMinor).toBe(44_880);
    expect(candidateUnknown.assumptions.map((a) => a.id)).toEqual(["r02.v1.scheduled_flight"]);
    expect(listed(candidateUnknown)).toContain("air.service_type:candidate_unconfirmed");

    // Controls, unaffected by the fix.
    expect(run({ ...R02_01, service_type: null }, NOW_01).outcome).toBe("likely_eligible");
    expect(run({ ...R02_01, service_type: [code("scheduled")] }, NOW_01).outcome).toBe("eligible");
  });
});

describe("P-R02-1 (medium): a confirmed downgrade flown with the cabins missing asks, never not_eligible", () => {
  it("flew=true, event_type=downgrade (confirmed), both cabins missing → needs_facts asking the cabins", () => {
    const down: Facts = {
      ...R02_02, changed_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")], event_type: [code("downgrade")],
      original_cabin: null, changed_cabin: null, flew_changed_or_alternative: [yes(true)],
    };
    const late = Date.parse("2026-11-11T12:00:00-05:00");
    const r = run(down, late);
    expect(r.outcome).toBe("needs_facts"); // was not_eligible ([], disq r02.v1.not_flown) on 24dc6bf
    expect(listed(r)).toEqual(["air.changed_cabin:missing", "air.original_cabin:missing"]);
    expect(r.disqualifierIds).toEqual([]);

    // Controls: cabins confirmed equal → not_eligible; cabins confirmed a downgrade → manual_review (L4).
    const equal = run({ ...down, original_cabin: [code("economy")], changed_cabin: [code("economy")] }, late);
    expect(equal.outcome).toBe("not_eligible");
    const downgrade = run({ ...down, original_cabin: [code("business")], changed_cabin: [code("economy")] }, late);
    expect(downgrade.outcome).toBe("manual_review");
  });
});

describe("D270(1) (revises D234 (17), fixes N-X-1): R02 shares no loss key with R04 path a", () => {
  it("a recorded bag fee never appears in R02's lossKeys, so a shared-key component no longer hides R04a", () => {
    const r = run(R02_01, NOW_01, [{ subjectKey: "txn", key: "air.bag_fee_paid", row: { state: "user_confirmed", value: usd(4_000), at: 1, source: { kind: "user" } } }]);
    expect(r.lossKeys).toEqual([`txn:${TXN_ID}:fare_unused`]); // was [fare_unused, "bag_fee:txn"] on 24dc6bf

    // End to end: two opportunities that used to share the bag_fee key now form two SEPARATE components, so the fee
    // is no longer hidden inside the fare's outstanding total (the review's repro: 44,880 + 4,000 additive).
    const r02Opp: SummaryOpportunity = { id: "r02", currency: "USD", estimateMinor: 44_880, lossKeys: r.lossKeys, anchor: "t1" };
    const r04aOpp: SummaryOpportunity = { id: "r04a", currency: "USD", estimateMinor: 4_000, lossKeys: [`txn:${TXN_ID}:bag_fee:t1`], anchor: "t1" };
    const comps = components([], [r02Opp, r04aOpp]);
    expect(comps.map((c) => c.outstanding).sort((a, b) => a - b)).toEqual([4_000, 44_880]); // was one component, 44,880, on 24dc6bf
  });
});

describe("D270(5) (confirmation, not a fix): a disability candidate is ignored; only a confirmed value triggers manual_review", () => {
  it("already correctly implemented before batch 3 (spec §5 'user-confirmed only', D234 (7)) — pinned here", () => {
    const belowThreshold = { ...R02_02, changed_sched_arrival_at: [at("2026-11-10T15:30:00-05:00")] as F }; // 1h30, below 3h
    const candidate = run({ ...belowThreshold, passenger_disability_relevant: cand(yes(true)) }, NOW_02);
    expect(candidate.outcome).toBe("not_eligible"); // the candidate is ignored: not asked, and it never triggers L11
    expect(listed(candidate)).not.toContain("air.passenger_disability_relevant:candidate_unconfirmed");

    const confirmed = run({ ...belowThreshold, passenger_disability_relevant: [yes(true)] }, NOW_02);
    expect(confirmed.outcome).toBe("manual_review"); // only the user's own confirmation raises L11
  });
});

describe("D270(4)/R-4 (O-1): while A8 caps R02, the card never escalates — it asks to confirm the service type", () => {
  it("overdue + service type missing → answer_questions [air.service_type], not escalate; the timer still shows", () => {
    const r = run({ ...R02_01, service_type: null }, Date.parse("2026-10-15T12:00:00-04:00"));
    expect(r.outcome).toBe("likely_eligible");
    expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "air.service_type" }] }); // was escalate on 24dc6bf
    expect(r.deadlines.some((d) => d.status === "overdue")).toBe(true); // the timer is still shown
  });
});

// ===================== Batch-3 re-check findings (Opus 5.5, 1fca780) =====================
// Facts reuse the re-check probe's own bases (recoup-wt-batch3-evidence/r02/zz_r02_targeted.test.ts.txt).

/** L4 base: R02-02 with a downgrade, flown, business→economy (confirmed), arrival unchanged. */
const L4: Facts = {
  ...R02_02, event_type: [code("downgrade")], changed_sched_arrival_at: [at("2026-11-10T14:00:00-05:00")],
  flew_changed_or_alternative: [yes(true)], original_cabin: [code("business")], changed_cabin: [code("economy")],
};

describe("R02 F1 (medium): the accepted_rebooking branch needs the not_flown cabins-unresolved guard too", () => {
  it("accepted_rebooking, flown, confirmed downgrade, cabins missing → needs_facts asking the cabins", () => {
    const p1r: Facts = { ...L4, original_cabin: null, changed_cabin: null, consumer_response: [code("accepted_rebooking")], consumer_response_at: null };
    const r = run(p1r, NOW_02);
    expect(r.outcome).toBe("needs_facts"); // was not_eligible ([], disq r02.v1.deemed_request) on 1fca780
    expect(listed(r)).toEqual(["air.changed_cabin:missing", "air.original_cabin:missing"]);

    // Controls: cabins confirmed business->economy → manual_review (L4); cabins confirmed equal → not_eligible.
    const downgrade = run({ ...p1r, original_cabin: [code("business")], changed_cabin: [code("economy")] }, NOW_02);
    expect(downgrade.outcome).toBe("manual_review");
    const equal = run({ ...p1r, original_cabin: [code("economy")], changed_cabin: [code("economy")] }, NOW_02);
    expect(equal.outcome).toBe("not_eligible");
  });
});

describe("R02 F2 (medium, N-R02-1 residual): a candidate or missing event_type must not pick the voucher anchor and decide not_yet_due", () => {
  const vch: Facts = {
    ...R02_01, offer_type: [code("voucher_or_credit")], consumer_response: [code("no_response")], consumer_response_at: null,
    flew_changed_or_alternative: null, original_sched_departure_at: [at("2026-10-05T07:00:00-04:00")], original_sched_arrival_at: [at("2026-10-05T10:00:00-04:00")],
    changed_sched_departure_at: [at("2026-10-20T07:00:00-04:00")], changed_sched_arrival_at: [at("2026-10-20T10:00:00-04:00")],
  };
  const NOW_V = Date.parse("2026-10-10T12:00:00-04:00");

  it("a candidate event_type must be listed as unconfirmed, not silently decide not_yet_due", () => {
    // The voucher anchor is oDep (past → ripe → eligible) for cancellation, cDep (future → not_yet_due) for
    // schedule_change: confirmed cancellation (vch's own default) gives eligible; confirmed schedule_change is the
    // matching control for the candidate below.
    const confirmedCancellation = run(vch, NOW_V);
    expect(confirmedCancellation.outcome).toBe("eligible");
    const confirmedScheduleChange = run({ ...vch, event_type: [code("schedule_change")] }, NOW_V);
    expect(confirmedScheduleChange.outcome).toBe("not_yet_due"); // control

    const candidateScheduleChange = run({ ...vch, event_type: cand(code("schedule_change")) }, NOW_V);
    expect(candidateScheduleChange.outcome).toBe("needs_facts"); // was not_yet_due, event not listed, on 1fca780
    expect(listed(candidateScheduleChange)).toContain("air.event_type:candidate_unconfirmed");
  });

  it("a wholly missing event_type is asked, never defaults the voucher anchor to changed_sched_departure_at", () => {
    const missing = run({ ...vch, event_type: null }, NOW_V);
    expect(missing.outcome).toBe("needs_facts"); // was not_yet_due (missing listed but outcome unchanged) on 1fca780
    expect(listed(missing)).toContain("air.event_type:missing");
    expect(missing.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "air.event_type" }] });
  });

  it("reverse (earlier departure): the same guard applies", () => {
    const vch2: Facts = {
      ...vch, event_type: [code("schedule_change")], flew_changed_or_alternative: [yes(false)],
      original_sched_departure_at: [at("2026-10-20T07:00:00-04:00")], original_sched_arrival_at: [at("2026-10-20T10:00:00-04:00")],
      changed_sched_departure_at: [at("2026-10-08T07:00:00-04:00")], changed_sched_arrival_at: [at("2026-10-08T10:00:00-04:00")],
    };
    const candidateCancellation = run({ ...vch2, event_type: cand(code("cancellation")) }, NOW_V);
    expect(candidateCancellation.outcome).toBe("needs_facts"); // was not_yet_due on 1fca780
    expect(listed(candidateCancellation)).toContain("air.event_type:candidate_unconfirmed");
  });
});

describe("R02 F3 (medium, D247): candidate cabins must never decide not_eligible on a confirmed, flown downgrade", () => {
  it("original_cabin a candidate 'economy' (truth business), changed_cabin confirmed 'economy' → needs_facts [original_cabin]", () => {
    const r = run({ ...L4, changed_cabin: [code("economy")], original_cabin: cand(code("economy")) }, NOW_02);
    expect(r.outcome).toBe("needs_facts"); // was not_eligible ([], disq r02.v1.not_flown) on 1fca780
    expect(listed(r)).toEqual(["air.original_cabin:candidate_unconfirmed"]);

    // Controls: dropping the candidate also asks; confirmed business (the truth) gives manual_review (L4).
    const dropped = run({ ...L4, changed_cabin: [code("economy")], original_cabin: null }, NOW_02);
    expect(dropped.outcome).toBe("needs_facts");
    const confirmedBusiness = run({ ...L4, changed_cabin: [code("economy")], original_cabin: [code("business")] }, NOW_02);
    expect(confirmedBusiness.outcome).toBe("manual_review");
  });
});

describe("R02 F4 (low, pre-existing): an operational-delay straddle with the scope MISSING is asked, not not_eligible", () => {
  it("itinerary_scope missing (not merely candidate) on the reverse-straddle base → needs_facts [itinerary_scope]", () => {
    const straddle: Facts = { ...R02_02, event_type: [code("operational_delay")], changed_sched_arrival_at: [at("2026-11-10T16:50:00-05:00")], actual_arrival_at: [at("2026-11-10T17:10:00-05:00")] };
    const r = run({ ...straddle, itinerary_scope: null }, NOW_02);
    expect(r.outcome).toBe("needs_facts"); // was not_eligible ([], disq r02.v1.sig.c2) on 1fca780
    expect(listed(r)).toEqual(["air.itinerary_scope:missing"]);

    // Controls: confirmed domestic → manual_review (the genuine straddle); confirmed international → not_eligible.
    const domestic = run({ ...straddle, itinerary_scope: [code("domestic"), "derived"] }, NOW_02);
    expect(domestic.outcome).toBe("manual_review");
    const international = run({ ...straddle, itinerary_scope: [code("international")] }, NOW_02);
    expect(international.outcome).toBe("not_eligible");
  });
});

describe("R02 F5 (low, pre-existing): flew=true with a confirmed downgrade shown by the cabins but event_type missing asks the event", () => {
  it("original_cabin=business, changed_cabin=economy (confirmed), flew=true, event_type missing → needs_facts [event_type]", () => {
    const r = run({ ...L4, event_type: null }, NOW_02);
    expect(r.outcome).toBe("needs_facts"); // was not_eligible ([], disq r02.v1.not_flown) on 1fca780
    expect(listed(r)).toEqual(["air.event_type:missing"]);

    // Controls: confirmed downgrade or schedule_change both give manual_review (L4, the cabins decide it either way).
    expect(run({ ...L4, event_type: [code("downgrade")] }, NOW_02).outcome).toBe("manual_review");
    expect(run({ ...L4, event_type: [code("schedule_change")] }, NOW_02).outcome).toBe("manual_review");
  });
});
