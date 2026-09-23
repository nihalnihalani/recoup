/**
 * M27c re-review findings for R04 v1 (recoup-wt-m27d-evidence/review.md) and the lead's rulings D270: one describe per
 * finding, named by its id, each asserting the reviewer's repro/regression. Every test here fails on `24dc6bf` (the
 * revision M27c reviewed) and passes after the batch-3 fixes. Facts reuse the review's own probe setups
 * (recoup-wt-m27d-evidence/probes/zz_m27d_targeted.test.ts.txt) so the repro numbers match the evidence exactly.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r04View, type CellRow, type R04Path } from "../facts/snapshot_air";
import { evaluateR04V1, R04_ADAPTERS, R04_SOURCES, R04_V1_PARAMS, r04BagFeeRefundV1, r04DelayedBagExpensesV1, r04PropertyLossV1 } from "./r04_baggage_v1";
import { ENGINE_VERSION, type EvaluationResult } from "./types";

const TXN_ID = "m27ctxnr04" as Id<"transactions">;
const PACK = { a: r04BagFeeRefundV1, b: r04DelayedBagExpensesV1, c: r04PropertyLossV1 } as const;
type State = ResolveRow["state"];
type F = [FactValue, State?] | [FactValue, State, FactValue, State];
type Facts = Record<string, F | null>;
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const yes = (b: boolean): FactValue => ({ kind: "bool", value: b });
const txt = (t: string): FactValue => ({ kind: "text", text: t });
const day = (d: string): FactValue => ({ kind: "local_date", date: d });
const tag = (t: string): FactValue => ({ kind: "identifier", scheme: "bag_tag", value: t });
const cand = (v: FactValue): F => [v, "extracted_candidate"];
const CLOCK = Date.parse("2026-09-23T12:00:00-07:00");

function rows(subjectKey: string, facts: Facts): CellRow[] {
  const out: CellRow[] = [];
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) continue;
    const key = name.includes(".") ? name : `air.${name}`;
    const src = (s: State) => (s === "user_confirmed" ? { kind: "user" as const } : s === "derived" ? { kind: "derived" as const } : { kind: "evidence" as const, ref: "doc" });
    out.push({ subjectKey, key, row: { state: f[1] ?? "user_confirmed", value: f[0], at: 1, source: src(f[1] ?? "user_confirmed") } });
    if (f.length === 4) out.push({ subjectKey, key, row: { state: f[3], value: f[2], at: 2, source: src(f[3]) } });
  }
  return out;
}
function r04(p: R04Path, rs: CellRow[], bag = "txn", now = CLOCK): EvaluationResult {
  const pack = PACK[p];
  return evaluateR04V1(p, {
    snapshot: r04View(buildAirSnapshot({ transactionId: TXN_ID, rows: rs }), bag), snapshotHash: "m27c", engineVersion: ENGINE_VERSION,
    remedyKey: pack.remedyKey, subjectKey: bag,
    pack: { ruleId: pack.ruleId, scenarioId: "R04", version: 1, params: R04_V1_PARAMS, sources: pack.sources },
    verification: Object.fromEntries(R04_SOURCES[p].map((s) => [s.sourceId, { lastVerifiedAt: new Date(now).toISOString().slice(0, 10) }])),
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}
const line = (i: number, amount: number, dateStr: string) => rows(`line:${i}`, { expense_amount: [usd(amount)], expense_date: [day(dateStr)], expense_receipt: [txt(`evidence:r${i}`)] });

describe("N-R04-1 (medium, D270(2) revises D234 (11)): a bag's loss key is permanent — the tag never moves it", () => {
  it("incident bag: no tag, then a candidate tag, then a confirmed tag → the same loss key throughout, on paths a and c", () => {
    const bagA = {
      bag_fee_paid: [usd(4_000)] as F, deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")] as F,
      bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")] as F, mbr_filed: [yes(true)] as F, bag_status: [code("delivered")] as F,
      exemption_failed_recheck: [yes(false)] as F, exemption_failed_pickup: [yes(false)] as F, exemption_voluntary_separation: [yes(false)] as F,
    };
    const trip = rows("txn", { itinerary_scope: [code("domestic"), "derived"] });
    const runA = (extra: Facts) => r04("a", [...trip, ...rows("incident:abc", { ...bagA, ...extra })], "incident:abc");
    const noTag = runA({});
    const candidateTag = runA({ bag_tag_number: cand(tag("0123456789")) });
    const confirmedTag = runA({ bag_tag_number: [tag("0123456789")] });
    expect(noTag.lossKeys).toEqual([`txn:${TXN_ID}:bag_fee:abc`]);
    expect(candidateTag.lossKeys).toEqual([`txn:${TXN_ID}:bag_fee:abc`]);
    expect(confirmedTag.lossKeys).toEqual([`txn:${TXN_ID}:bag_fee:abc`]); // was bag_fee:0123456789 on 24dc6bf

    // A single-bag trip recorded on txn (no incident): loss identity is "txn", also unaffected by a confirmed tag.
    const txnBag = r04("a", rows("txn", { itinerary_scope: [code("domestic"), "derived"], ...bagA, bag_tag_number: [tag("0123456789")] }));
    expect(txnBag.lossKeys).toEqual([`txn:${TXN_ID}:bag_fee:txn`]); // was bag_fee:0123456789 on 24dc6bf
  });
});

describe("N-R04-2 (medium, D270(6)): path b's A2 window is bounded on both sides", () => {
  it("undelivered, no deplane time known: every expense line is excluded (the window's lower bound is unknown)", () => {
    const lostNoDeplane = rows("txn", {
      itinerary_scope: [code("domestic"), "derived"], bag_status: [code("delayed_undelivered")], mbr_filed: [yes(true)],
      large_aircraft_segment_on_ticket: [yes(true)],
    });
    const r = r04("b", [...lostNoDeplane, ...line(1, 5_000, "2020-01-01"), ...line(2, 7_000, "2030-12-31")]);
    expect(r.amount).toBeNull(); // was likely_eligible 12,000 (both lines) on 24dc6bf
    expect(r.explanation.join(" ")).toContain("flight date is not known yet");
  });

  it("undelivered, deplane time known: a line dated long after the clock is excluded, not admitted through an open upper bound", () => {
    const withDeplane = rows("txn", {
      itinerary_scope: [code("domestic"), "derived"], bag_status: [code("delayed_undelivered")], mbr_filed: [yes(true)],
      large_aircraft_segment_on_ticket: [yes(true)], deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")],
    });
    const r = r04("b", [...withDeplane, ...line(1, 5_000, "2026-09-13"), ...line(2, 7_000, "2030-12-31")], "txn", CLOCK);
    expect(r.amount?.estimate.amountMinor).toBe(5_000); // was likely_eligible 12,000 (both lines) on 24dc6bf
    expect(r.explanation.join(" ")).toContain("dated 2030-12-31");
  });
});

describe("D270(3)/D271/L13/R-3 (closed): D253(3) extends fully to path a", () => {
  const facts = {
    itinerary_scope: [code("domestic"), "derived"] as F, bag_fee_paid: [usd(4_000)] as F, mbr_filed: [yes(true)] as F,
    deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")] as F, bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")] as F,
    bag_status: [code("delivered")] as F, exemption_failed_recheck: [yes(false)] as F, exemption_failed_pickup: [yes(false)] as F,
    exemption_voluntary_separation: [yes(false)] as F,
  };

  it("a KNOWN charter service type makes path a unsupported, same as R02", () => {
    const scheduled = r04("a", rows("txn", { ...facts, service_type: [code("scheduled")] }));
    expect(scheduled.outcome).toBe("eligible");

    const charter = r04("a", rows("txn", { ...facts, service_type: [code("public_charter")] }));
    expect(charter.outcome).toBe("unsupported"); // was "eligible" on 24dc6bf (path a had no service-type check at all)
    expect(charter.disqualifierIds).toContain("r04.a.scheduled_service");

    const candidateCharter = r04("a", rows("txn", { ...facts, service_type: cand(code("public_charter")) }));
    expect(candidateCharter.outcome).toBe("needs_facts"); // D234 (1): a candidate never decides the negative
    expect(candidateCharter.missingFacts.map((m) => `${m.key}:${m.reason}`)).toContain("air.service_type:candidate_unconfirmed");
  });

  it("D271: an unknown service type caps at likely_eligible with A8, and the next action stays track (D270(4), path a has no timer)", () => {
    const missing = r04("a", rows("txn", facts)); // service_type not recorded at all
    expect(missing.outcome).toBe("likely_eligible"); // was "eligible", uncapped, before D271 wired the cap in
    expect(missing.assumptions.map((a) => a.id)).toEqual(["r04.a.scheduled_flight"]);
    expect(missing.missingFacts.map((m) => `${m.key}:${m.reason}`)).toContain("air.service_type:missing");
    expect(missing.nextAction).toEqual({ kind: "track" }); // never escalate: path a has no carrier timer at all (L6)
  });
});

describe("D270(8): the 32 bound-fact budget does not stretch to 8 path-b expense lines; it holds 5, itemized manually", () => {
  it("R04_MAX_EXPENSE_LINES is pinned at 5, and the manual_review reason instructs itemizing the rest manually", () => {
    const bBase = {
      itinerary_scope: [code("domestic"), "derived"] as F, large_aircraft_segment_on_ticket: [yes(true)] as F,
      deplane_opportunity_at: [at("2026-09-05T21:40:00-07:00")] as F, bag_status: [code("delivered")] as F,
      bag_delivered_or_picked_up_at: [at("2026-09-06T10:00:00-07:00")] as F, mbr_filed: [yes(true)] as F,
    };
    const sixLines = [1, 2, 3, 4, 5, 6].flatMap((i) => line(i, 1_000, "2026-09-05"));
    const r = r04("b", [...rows("txn", bBase), ...sixLines]);
    expect(r.outcome).toBe("manual_review");
    expect(r.nextAction.kind).toBe("manual_review");
    expect(r.nextAction.kind === "manual_review" ? r.nextAction.reason : "").toContain("itemizing the rest manually"); // new wording; absent on 24dc6bf
  });
});

describe("L-R04-adjacent: R04_ADAPTERS still resolve a bag by its incident id (sanity for D270(2))", () => {
  it("two bags on their own incidents run independently, keyed by incident id, never a position or a tag", () => {
    const trip = rows("txn", { itinerary_scope: [code("domestic"), "derived"] });
    const bagFacts = (fee: number) => ({
      bag_fee_paid: [usd(fee)] as F, deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")] as F,
      bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")] as F, mbr_filed: [yes(true)] as F, bag_status: [code("delivered")] as F,
      exemption_failed_recheck: [yes(false)] as F, exemption_failed_pickup: [yes(false)] as F, exemption_voluntary_separation: [yes(false)] as F,
    });
    const input = { transactionId: TXN_ID, rows: [...trip, ...rows("incident:bagone", { ...bagFacts(4_000), bag_tag_number: [tag("0111111111")] }), ...rows("incident:bagtwo", { ...bagFacts(3_500), bag_tag_number: [tag("0222222222")] })] };
    const runs = R04_ADAPTERS.a.runs(input);
    expect(runs.map((r) => r.snapshot.bagLossId)).toEqual(["bagone", "bagtwo"]); // was the confirmed tags on 24dc6bf
  });
});

// ===================== Batch-3 re-check findings (Opus 5.5, 1fca780) =====================
// Facts reuse the re-check probe's own base (recoup-wt-batch3-evidence/r04/zz_b3r04_deplane.test.ts).

describe("R04 F1 (medium, D234 (1)/D247): a candidate deplane time that sets path b's A2 lower bound must be listed as unconfirmed", () => {
  const bBase = (dep: F | null, extra: Facts = {}) => ({
    itinerary_scope: [code("domestic"), "derived"] as F, large_aircraft_segment_on_ticket: [yes(true)] as F, mbr_filed: [yes(true)] as F,
    bag_status: [code("delivered")] as F, bag_delivered_or_picked_up_at: [at("2026-09-14T10:00:00-07:00")] as F, deplane_opportunity_at: dep, ...extra,
  });
  const lines = [...line(1, 20_000, "2026-09-08"), ...line(2, 3_000, "2026-09-13")];

  it("a candidate deplane time is listed as candidate_unconfirmed, even though it still decides the window (the leaf-guard/cap pattern, not a value change)", () => {
    const truth = r04("b", [...rows("txn", bBase([at("2026-09-12T21:40:00-07:00")])), ...lines]);
    expect(truth.outcome).toBe("likely_eligible");
    expect(truth.amount?.estimate.amountMinor).toBe(3_000); // line 1 (2026-09-08) is before the true deplane day

    const candidateDeplane = r04("b", [...rows("txn", bBase(cand(at("2026-09-05T21:40:00-07:00")))), ...lines]);
    expect(candidateDeplane.amount?.estimate.amountMinor).toBe(23_000); // unchanged: the fix lists the cell, it does not alter the window
    expect(candidateDeplane.missingFacts.map((m) => `${m.key}:${m.reason}`)).toContain("air.deplane_opportunity_at:candidate_unconfirmed"); // was not listed on 1fca780
  });

  it("the same guard applies to an undelivered bag (the upper bound is open, only the lower bound is candidate)", () => {
    const und: Facts = { bag_status: cand(code("delayed_undelivered")), bag_delivered_or_picked_up_at: null };
    const undelivered = r04("b", [...rows("txn", bBase(cand(at("2026-09-05T21:40:00-07:00")), und)), ...lines]);
    expect(undelivered.missingFacts.map((m) => `${m.key}:${m.reason}`)).toContain("air.deplane_opportunity_at:candidate_unconfirmed"); // was not listed on 1fca780
  });
});

describe("R04 F2 (low): when lines are excluded only because the deplane time is unknown, the next action asks for it", () => {
  it("every receipted line excluded for a missing deplane time → answer_questions [air.deplane_opportunity_at], not add_evidence", () => {
    const bBase: Facts = {
      itinerary_scope: [code("domestic"), "derived"], large_aircraft_segment_on_ticket: [yes(true)], bag_status: [code("delayed_undelivered")], mbr_filed: [yes(true)],
    };
    const r = r04("b", [...rows("txn", bBase), ...line(1, 5_000, "2026-09-13")]);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.amount).toBeNull();
    expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "air.deplane_opportunity_at" }] }); // was add_evidence [expense_receipt] on 1fca780
  });
});
