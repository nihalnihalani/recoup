/**
 * M27 review findings for R04 v1 (docs/reviews/2026-09-23-pack-review-R02-R05.md, R04 section) and the lead's rulings
 * D234/D235: one describe per finding, named by its id, each asserting the reviewer's "Regression test" row. Each
 * fails on the reviewed revision `3d5cb7f` and passes after M22b. Facts are built directly as resolution rows (receipts
 * as `evidence:<id>` references, D235 (D)); runs come from the pack's own adapter where the bag set matters. Only exports
 * that existed at `3d5cb7f` are used, so the same file runs against both revisions.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { boundFactsHash } from "../canonical";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r04View, type CellRow, type R04Path, type R04View } from "../facts/snapshot_air";
import { resultHash } from "./outcome";
import { evaluateR04V1, R04_ADAPTERS, R04_SOURCES, R04_V1_PARAMS, r04BagFeeRefundV1, r04DelayedBagExpensesV1, r04PropertyLossV1 } from "./r04_baggage_v1";
import { ENGINE_VERSION, type EvaluationResult } from "./types";

const TXN_ID = "m27txnr04" as Id<"transactions">;
const PACK = { a: r04BagFeeRefundV1, b: r04DelayedBagExpensesV1, c: r04PropertyLossV1 } as const;
type State = ResolveRow["state"];
type F = [FactValue, State?] | [FactValue, State, FactValue, State];
type Facts = Record<string, F | null>;
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number, currency = "USD"): FactValue => ({ kind: "money", amountMinor: n, currency });
const yes = (b: boolean): FactValue => ({ kind: "bool", value: b });
const txt = (t: string): FactValue => ({ kind: "text", text: t });
const day = (d: string): FactValue => ({ kind: "local_date", date: d });
const tag = (t: string): FactValue => ({ kind: "identifier", scheme: "bag_tag", value: t });
const cand = (v: FactValue): F => [v, "extracted_candidate"];
const CLOCK = Date.parse("2026-09-23T12:00:00-07:00");

/** R04-01 (path a): delivered 13h15m after deplaning, MBR filed, fee USD 40.00, no exemption, all confirmed. */
const A: Facts = {
  service_type: [code("scheduled")], // D270(3)/D271: recorded so this case's expected outcome is preserved (A8)
  itinerary_scope: [code("domestic"), "derived"], operating_carrier_last_segment: [txt("XA")], bag_fee_merchant_of_record: [code("carrier")],
  bag_tag_number: [tag("0123456789")], bag_fee_paid: [usd(4_000)], deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")],
  bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")], bag_status: [code("delivered"), "derived"], mbr_filed: [yes(true)],
  mbr_reference: [txt("SEAXA12345")], mbr_filed_at: [at("2026-09-12T22:05:00-07:00")],
  exemption_failed_recheck: [yes(false)], exemption_failed_pickup: [yes(false)], exemption_voluntary_separation: [yes(false)],
};
/** R04-04 (path b): delivered after 44 h, MBR filed, large aircraft; lines 1–3 receipted (41,250), line 4 without one. */
const B: Facts = {
  itinerary_scope: [code("domestic"), "derived"], bag_status: [code("delivered"), "derived"], deplane_opportunity_at: [at("2026-09-05T15:10:00-07:00")],
  bag_delivered_or_picked_up_at: [at("2026-09-07T11:00:00-07:00")], mbr_filed: [yes(true)], large_aircraft_segment_on_ticket: [yes(true)],
};
type Line = { amount: number; date?: string; receipt?: F | null; allocated?: F | null; currency?: string };
const B_LINES: Line[] = [
  { amount: 3_250, date: "2026-09-05", receipt: [txt("evidence:rcpt001")] },
  { amount: 35_600, date: "2026-09-06", receipt: [txt("evidence:rcpt002")] },
  { amount: 2_400, date: "2026-09-06", receipt: [txt("evidence:rcpt003")] },
  { amount: 18_750, date: "2026-09-06" },
];

function factRows(subjectKey: string, facts: Facts): CellRow[] {
  const rows: CellRow[] = [];
  const source = (s: State) => (s === "user_confirmed" ? { kind: "user" as const } : s === "derived" ? { kind: "derived" as const } : { kind: "evidence" as const, ref: "doc" });
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) continue;
    const key = name.includes(".") ? name : `air.${name}`;
    rows.push({ subjectKey, key, row: { state: f[1] ?? "user_confirmed", value: f[0], at: 1, source: source(f[1] ?? "user_confirmed") } });
    if (f.length === 4) rows.push({ subjectKey, key, row: { state: f[3], value: f[2], at: 2, source: source(f[3]) } });
  }
  return rows;
}
function lineRows(lines: readonly Line[]): CellRow[] {
  return lines.flatMap((l, i) => factRows(`line:${i + 1}`, {
    expense_amount: [usd(l.amount, l.currency)], expense_description: [txt(`line ${i + 1}`)],
    expense_date: l.date === undefined ? null : [day(l.date)], expense_receipt: l.receipt ?? null, expense_allocated_to: l.allocated ?? null,
  }));
}
const verified = (p: R04Path, now: number) => Object.fromEntries(R04_SOURCES[p].map((s) => [s.sourceId, { lastVerifiedAt: new Date(now).toISOString().slice(0, 10) }]));
function evaluate(p: R04Path, view: R04View, now: number): EvaluationResult {
  const pack = PACK[p];
  return evaluateR04V1(p, {
    snapshot: view, snapshotHash: "m27", engineVersion: ENGINE_VERSION, remedyKey: pack.remedyKey, subjectKey: view.bagSubjectKey,
    pack: { ruleId: pack.ruleId, scenarioId: "R04", version: pack.version, params: R04_V1_PARAMS, sources: pack.sources },
    verification: verified(p, now), caseContext: { settledMinorByLossKey: {} }, now,
  });
}
/** One bag on `txn` (the fixture shape). */
const run = (p: R04Path, facts: Facts, now = CLOCK, extra: CellRow[] = []) =>
  evaluate(p, r04View(buildAirSnapshot({ transactionId: TXN_ID, rows: [...factRows("txn", facts), ...extra] })), now);
/** Every run the pack's adapter makes for these rows, keyed by subject. */
function runsOf(p: R04Path, rows: CellRow[], now = CLOCK): Map<string, EvaluationResult> {
  return new Map(R04_ADAPTERS[p].runs({ transactionId: TXN_ID, rows }).map((r) => [r.subjectKey, evaluate(p, r.snapshot, now)]));
}
const listed = (r: EvaluationResult) => r.missingFacts.map((m) => `${m.subjectKey === "txn" ? "" : `${m.subjectKey}/`}${m.key}:${m.reason}`).sort();
const keysOf = (r: EvaluationResult) => r.missingFacts.map((m) => m.key);
const { bag_delivered_or_picked_up_at: _d, bag_status: _s, ...A_NO_DELIVERY } = A;

describe("R04-01 (high): a still-missing bag is never extrapolated to the clock (D234 (10))", () => {
  it.each([
    ["deplane + 13 h", "2026-09-13T10:40:00-07:00"],
    ["deplane + 14 h", "2026-09-13T11:40:00-07:00"],
  ])("confirmed delayed_undelivered, no delivery instant, %s → never eligible", (_n, now) => {
    const r = run("a", { ...A_NO_DELIVERY, bag_status: [code("delayed_undelivered")] }, Date.parse(now));
    expect(r.outcome).not.toBe("eligible");
    expect(r.outcome).toBe("needs_facts");
    expect(keysOf(r)).toContain("air.bag_delivered_or_picked_up_at");
  });
  it("declared lost is still eligible (R04-02-style control)", () => {
    expect(run("a", { ...A_NO_DELIVERY, bag_status: [code("declared_lost")] }).outcome).toBe("eligible");
  });
});

describe("R04-02 (high): a negative verdict never rests on an extracted candidate (D234 (1))", () => {
  it("a candidate delivery at 11h59m → needs_facts listing the delivery; confirmed → not_eligible", () => {
    const r = run("a", { ...A, bag_delivered_or_picked_up_at: cand(at("2026-09-13T09:39:00-07:00")) });
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.bag_delivered_or_picked_up_at:candidate_unconfirmed");
    expect(run("a", { ...A, bag_delivered_or_picked_up_at: [at("2026-09-13T09:39:00-07:00")] }).outcome).toBe("not_eligible");
  });
  it("a candidate recheck = true → needs_facts listing it; confirmed → not_eligible", () => {
    const r = run("a", { ...A, exemption_failed_recheck: cand(yes(true)) });
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.exemption_failed_recheck:candidate_unconfirmed");
    expect(run("a", { ...A, exemption_failed_recheck: [yes(true)] }).outcome).toBe("not_eligible");
  });
  it("a candidate non_us scope → needs_facts on a and b; confirmed → unsupported", () => {
    expect(run("a", { ...A, itinerary_scope: cand(code("non_us")) }).outcome).toBe("needs_facts");
    expect(run("b", { ...B, itinerary_scope: cand(code("international")) }, CLOCK, lineRows(B_LINES)).outcome).toBe("needs_facts");
    expect(run("a", { ...A, itinerary_scope: [code("non_us")] }).outcome).toBe("unsupported");
  });
  it("a candidate voluntary separation, a candidate fee of 0 → never not_eligible", () => {
    expect(run("a", { ...A, exemption_voluntary_separation: cand(yes(true)) }).outcome).toBe("needs_facts");
    expect(run("a", { ...A, bag_fee_paid: cand(usd(0)) }).outcome).toBe("needs_facts");
  });
  it("path b: a candidate deplane and delivery at the same instant → not not_eligible", () => {
    const same = cand(at("2026-09-05T15:10:00-07:00"));
    expect(run("b", { ...B, deplane_opportunity_at: same, bag_delivered_or_picked_up_at: same }, CLOCK, lineRows(B_LINES)).outcome).not.toBe("not_eligible");
  });
  it("path c: a candidate status delivered → needs_facts", () => {
    const r = run("c", { ...B, bag_status: cand(code("delivered")) });
    expect(r.outcome).toBe("needs_facts");
    expect(listed(r)).toContain("air.bag_status:candidate_unconfirmed");
  });
});

describe("R04-03 (high): path b needs a real delay (D234 (9), D235 (D))", () => {
  const short = { ...B, deplane_opportunity_at: [at("2026-09-05T21:40:00-07:00")] as F, bag_delivered_or_picked_up_at: [at("2026-09-05T22:00:00-07:00")] as F, mbr_filed: null };
  const oneLine = lineRows([{ amount: 2_500, date: "2026-09-05", receipt: [txt("evidence:rcpt900")] }]);
  it("status delivered, a 20-minute pickup, no MBR → not approvable, amount null", () => {
    const r = run("b", short, CLOCK, oneLine);
    expect(["eligible", "likely_eligible"]).not.toContain(r.outcome);
    expect(r.amount).toBeNull();
  });
  it("a confirmed 'no MBR' with a short span → not_eligible; a damaged bag after 25 min with an MBR → not approvable", () => {
    expect(run("b", { ...short, mbr_filed: [yes(false)] }, CLOCK, oneLine).outcome).toBe("not_eligible");
    const damaged = run("b", { ...short, bag_status: [code("damaged")], bag_delivered_or_picked_up_at: [at("2026-09-05T22:05:00-07:00")], mbr_filed: [yes(true)] }, CLOCK, oneLine);
    expect(["eligible", "likely_eligible"]).not.toContain(damaged.outcome);
  });
  it("R04-04 (44 h, MBR) is unchanged: likely_eligible 41,250", () => {
    const r = run("b", B, CLOCK, lineRows(B_LINES));
    expect([r.outcome, r.amount?.estimate.amountMinor]).toEqual(["likely_eligible", 41_250]);
  });
});

describe("R04-04 (high): paths b and c consider every bag", () => {
  const trip = factRows("txn", { itinerary_scope: [code("domestic"), "derived"], large_aircraft_segment_on_ticket: [yes(true)] });
  it("two bags, the second declared lost → path c runs it: likely_eligible, never not_eligible", () => {
    const rows = [
      ...trip,
      ...factRows("incident:aaa", { bag_status: [code("delivered")], deplane_opportunity_at: [at("2026-09-05T15:10:00-07:00")], bag_delivered_or_picked_up_at: [at("2026-09-05T15:40:00-07:00")] }),
      ...factRows("incident:bbb", { bag_status: [code("declared_lost")], mbr_filed: [yes(true)], incident_date: [day("2026-09-08")] }),
    ];
    const c = runsOf("c", rows);
    expect(c.get("incident:bbb")?.outcome).toBe("likely_eligible");
  });
  it("path b's delay passes when any bag is delayed", () => {
    const rows = [
      ...trip,
      ...factRows("incident:aaa", { bag_status: [code("delivered")], deplane_opportunity_at: [at("2026-09-05T15:10:00-07:00")], bag_delivered_or_picked_up_at: [at("2026-09-05T15:10:00-07:00")] }),
      ...factRows("incident:zzz", { bag_status: [code("delayed_undelivered")], mbr_filed: [yes(true)], deplane_opportunity_at: [at("2026-09-05T15:10:00-07:00")] }),
      ...lineRows([{ amount: 3_250, date: "2026-09-06", receipt: [txt("evidence:rcpt001")] }]),
    ];
    const b = [...runsOf("b", rows).values()];
    expect(b.length).toBe(1);
    expect([b[0].outcome, b[0].amount?.estimate.amountMinor]).toEqual(["likely_eligible", 3_250]);
  });
});

describe("R04-05 (high): a bag's loss key does not move when another bag is added (D234 (11))", () => {
  const bagFacts = (t: string): Facts => ({
    bag_tag_number: [tag(t)], bag_fee_paid: [usd(4_000)], deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")],
    bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")], mbr_filed: [yes(true)], bag_status: [code("delivered")],
  });
  it("evaluate incident:mmm, then add incident:ccc (sorts earlier): mmm's loss keys are identical, the two differ", () => {
    const trip = factRows("txn", { itinerary_scope: [code("domestic"), "derived"] });
    const before = runsOf("a", [...trip, ...factRows("incident:mmm", bagFacts("0333333333"))]);
    const after = runsOf("a", [...trip, ...factRows("incident:mmm", bagFacts("0333333333")), ...factRows("incident:ccc", bagFacts("0111111111"))]);
    expect(after.get("incident:mmm")?.lossKeys).toEqual(before.get("incident:mmm")?.lossKeys);
    expect(after.get("incident:ccc")?.lossKeys).not.toEqual(after.get("incident:mmm")?.lossKeys);
  });
});

describe("R04-06 (high): per-bag facts belong to their bag", () => {
  const perBag: Facts = {
    deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")], bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")],
    mbr_filed: [yes(true)], exemption_failed_recheck: [yes(false)], exemption_failed_pickup: [yes(false)], exemption_voluntary_separation: [yes(false)],
  };
  it("(1) one txn fee never gives two fee estimates on different loss keys", () => {
    const runs = runsOf("a", [
      ...factRows("txn", { itinerary_scope: [code("domestic"), "derived"], bag_fee_paid: [usd(7_000)] }),
      ...factRows("incident:aaa", perBag), ...factRows("incident:bbb", perBag),
    ]);
    const withFee = [...runs.values()].filter((r) => r.amount?.estimate.amountMinor === 7_000);
    expect(new Set(withFee.flatMap((r) => r.lossKeys)).size).toBeLessThanOrEqual(1);
  });
  it("(2) both bags are evaluated, and bag 2 without its own delivery time → needs_facts", () => {
    const runs = runsOf("a", [
      ...factRows("txn", { ...A }),
      ...factRows("incident:bag2", { bag_fee_paid: [usd(3_500)], bag_status: [code("delivered")] }),
    ]);
    expect([...runs.keys()].sort()).toEqual(["incident:bag2", "txn"]);
    expect(runs.get("incident:bag2")?.outcome).toBe("needs_facts");
    expect(runs.get("txn")?.outcome).toBe("eligible");
  });
  it("(3) bound facts contain the txn ref of a trip-level fact the bag used", () => {
    const runs = runsOf("a", [
      ...factRows("txn", { itinerary_scope: [code("domestic"), "derived"], deplane_opportunity_at: [at("2026-09-12T21:40:00-07:00")] }),
      ...factRows("incident:aaa", { bag_fee_paid: [usd(4_000)], bag_delivered_or_picked_up_at: [at("2026-09-13T10:55:00-07:00")], mbr_filed: [yes(true)] }),
    ]);
    const bound = runs.get("incident:aaa")!.boundFacts;
    expect(bound.some((b) => b.subjectKey === "txn" && b.key === "air.deplane_opportunity_at" && b.status !== "missing")).toBe(true);
  });
});

describe("R04-07 (medium): the compliance gate needs a known date (D234 (8))", () => {
  const lostNoDates: Facts = {
    itinerary_scope: [code("domestic")], bag_fee_paid: [usd(4_000)], bag_status: [code("declared_lost")], mbr_filed: [yes(true)],
    exemption_failed_recheck: [yes(false)], exemption_failed_pickup: [yes(false)], exemption_voluntary_separation: [yes(false)],
  };
  it("a lost bag with no dates → likely_eligible with the temporal assumption; before 2024-10-28 → source_unverified", () => {
    const r = run("a", lostNoDates);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((x) => x.id)).toContain("r04.a.after_compliance_date");
    expect(run("a", lostNoDates, Date.parse("2024-09-20T12:00:00-07:00")).outcome).toBe("source_unverified");
  });
  it("a candidate deplane → likely_eligible with the deplane listed as candidate_unconfirmed", () => {
    const r = run("a", { ...lostNoDates, deplane_opportunity_at: cand(at("2026-09-12T21:40:00-07:00")) });
    expect(r.outcome).toBe("likely_eligible");
    expect(listed(r)).toContain("air.deplane_opportunity_at:candidate_unconfirmed");
  });
  it("incident_date 2024-09-12 → source_unverified; a confirmed MBR 2024-11-05 + incident 2024-10-20 → source_unverified", () => {
    expect(run("a", { ...lostNoDates, incident_date: [day("2024-09-12")] }).outcome).toBe("source_unverified");
    expect(run("a", { ...lostNoDates, incident_date: [day("2024-10-20")], mbr_filed_at: [at("2024-11-05T10:00:00-05:00")] }).outcome).toBe("source_unverified");
  });
  it("R04-01 (confirmed dates, 2026) is unchanged: eligible", () => {
    expect(run("a", A).outcome).toBe("eligible");
  });
});

describe("R04-08 (medium): the 254.4 floor is never a cap", () => {
  it("no carrier limit → amount.cap undefined, explanation 'at least $4,700'; a carrier limit of 500,000 → cap 500,000", () => {
    const r = run("b", B, CLOCK, lineRows(B_LINES));
    expect(r.amount?.cap).toBeUndefined();
    expect(r.explanation.join(" ")).toContain("at least $4,700");
    const withLimit = run("b", { ...B, carrier_liability_limit: [usd(500_000)] }, CLOCK, lineRows(B_LINES));
    expect(withLimit.amount?.cap?.amount).toEqual({ amountMinor: 500_000, currency: "USD" });
  });
});

describe("R04-09 (medium): travelling without the bag by agreement does not decide a bag whose status is unknown", () => {
  const voluntary = { ...A_NO_DELIVERY, exemption_voluntary_separation: [yes(true)] as F };
  it("voluntary, status and delivery unknown → needs_facts asking bag_status", () => {
    const r = run("a", voluntary);
    expect(r.outcome).toBe("needs_facts");
    expect(keysOf(r)).toContain("air.bag_status");
  });
  it("voluntary + delivered 13h15m → not_eligible; voluntary + declared_lost → eligible", () => {
    expect(run("a", { ...voluntary, bag_delivered_or_picked_up_at: A.bag_delivered_or_picked_up_at, bag_status: [code("delivered")] }).outcome).toBe("not_eligible");
    expect(run("a", { ...voluntary, bag_status: [code("declared_lost")] }).outcome).toBe("eligible");
  });
});

describe("R04-10 (medium): only expense lines dated within the delay count (spec A2)", () => {
  it.each([
    ["before the flight (2026-08-01)", { amount: 99_900, date: "2026-08-01", receipt: [txt("evidence:rcpt801")] as F }],
    ["after the clock (2026-10-15)", { amount: 50_000, date: "2026-10-15", receipt: [txt("evidence:rcpt802")] as F }],
    ["undated", { amount: 7_000, receipt: [txt("evidence:rcpt803")] as F }],
  ])("a receipted line %s is not added: R04-04 stays 41,250", (_n, line) => {
    const r = run("b", B, CLOCK, lineRows([...B_LINES, line]));
    expect(r.amount?.estimate.amountMinor).toBe(41_250);
  });
  it("an undated line asks its date", () => {
    const r = run("b", B, CLOCK, lineRows([...B_LINES, { amount: 7_000, receipt: [txt("evidence:rcpt803")] }]));
    expect(r.missingFacts.some((m) => m.subjectKey === "line:5" && m.key === "air.expense_date")).toBe(true);
  });
});

describe("R04-11 (medium): a receipt is an attached document, not typed text", () => {
  it.each(["none", "lost it", "I don't have a receipt"])("line 4's receipt typed as %j → excluded and asked; 41,250", (typed) => {
    const lines = B_LINES.map((l, i) => (i === 3 ? { ...l, receipt: [txt(typed)] as F } : l));
    const r = run("b", B, CLOCK, lineRows(lines));
    expect(r.amount?.estimate.amountMinor).toBe(41_250);
    expect(r.missingFacts.some((m) => m.subjectKey === "line:4" && m.key === "air.expense_receipt")).toBe(true);
  });
});

describe("R04-12 (medium): only a named remedy allocation excludes a line", () => {
  const R12: Facts = {
    itinerary_scope: [code("domestic"), "derived"], deplane_opportunity_at: [at("2026-09-05T15:10:00-07:00")],
    bag_delivered_or_picked_up_at: [at("2026-09-07T11:00:00-07:00")], mbr_filed: [yes(true)],
  };
  const lines = (alloc1: F | null, alloc2: F | null = null): CellRow[] => lineRows([
    { amount: 3_250, date: "2026-09-05", receipt: [txt("evidence:rcpt301")], allocated: alloc1 },
    { amount: 12_000, date: "2026-09-06", receipt: [txt("evidence:rcpt302")], allocated: alloc2 },
  ]);
  it("allocated_to 'no' → the line is included (15,250); card_benefit:baggage_delay → excluded (12,000)", () => {
    expect(run("b", R12, CLOCK, lines([txt("no")])).amount?.estimate.amountMinor).toBe(15_250);
    expect(run("b", R12, CLOCK, lines([txt("card_benefit:baggage_delay")])).amount?.estimate.amountMinor).toBe(12_000);
  });
  it("a candidate allocation cannot exclude a line on its own: it is asked", () => {
    const r = run("b", R12, CLOCK, lines(cand(txt("card_benefit:baggage_delay"))));
    expect(r.amount?.estimate.amountMinor).not.toBe(12_000);
    expect(r.missingFacts.some((m) => m.subjectKey === "line:1" && m.key === "air.expense_allocated_to")).toBe(true);
  });
  it("every line receipted and answered 'no'/'none' → not 'add receipts'", () => {
    const r = run("b", R12, CLOCK, lines([txt("no")], [txt("none")]));
    expect(r.amount?.estimate.amountMinor).toBe(15_250);
    expect(r.nextAction).not.toEqual({ kind: "add_evidence", docTypes: ["expense_receipt"] });
  });
});

describe("R04-13 (medium): the bag fee entered as an expense line is not counted twice (D234 (17))", () => {
  it("a line equal to the fee → not in the path-b estimate and listed for confirmation", () => {
    const r = run("b", { ...A, large_aircraft_segment_on_ticket: [yes(true)] }, CLOCK, lineRows([
      { amount: 4_000, date: "2026-09-12", receipt: [txt("evidence:rcpt401")] },
      { amount: 2_000, date: "2026-09-13", receipt: [txt("evidence:rcpt402")] },
    ]));
    expect(r.amount?.estimate.amountMinor).toBe(2_000);
    expect(r.missingFacts.some((m) => m.subjectKey === "line:1" && m.key === "air.expense_allocated_to")).toBe(true);
  });
});

describe("R04-14 (medium): the incident date is bound on path b, so a changed floor re-hashes", () => {
  const hashOf = async (r: EvaluationResult) => await resultHash(r, await boundFactsHash(r.boundFacts));
  it("changing or adding incident_date changes resultHash", async () => {
    const lines = lineRows([{ amount: 3_250, date: "2026-09-06", receipt: [txt("evidence:rcpt001")] }]);
    const none = await hashOf(run("b", B, CLOCK, lines));
    const d2026 = await hashOf(run("b", { ...B, incident_date: [day("2026-09-08")] }, CLOCK, lines));
    const d2024 = await hashOf(run("b", { ...B, incident_date: [day("2024-12-10")] }, CLOCK, lines));
    expect(d2026).not.toBe(none);
    expect(d2024).not.toBe(d2026);
  });
});

describe("R04-15 (medium): no bag fact → no R04 run", () => {
  it("rows with only itinerary or R02 facts → [] for a, b and c", () => {
    const rows = factRows("txn", { itinerary_scope: [code("domestic"), "derived"], fare_paid: [usd(35_000)], event_type: [code("cancellation")] });
    for (const p of ["a", "b", "c"] as const) expect(R04_ADAPTERS[p].runs({ transactionId: TXN_ID, rows })).toEqual([]);
    for (const p of ["a", "b", "c"] as const) expect(R04_ADAPTERS[p].runs({ transactionId: TXN_ID, rows: [] })).toEqual([]);
  });
});

describe("R04-16 (medium): conflicts on exemption, MBR and large-aircraft facts follow D152", () => {
  const conflictKeys = (r: EvaluationResult) => r.flags.conflicts.map((c) => c.key);
  it("recheck: user false vs observed true (5a) → manual_review naming the key", () => {
    const r = run("a", { ...A, exemption_failed_recheck: [yes(true), "observed", yes(false), "user_confirmed"] });
    expect(r.outcome).toBe("manual_review");
    expect(conflictKeys(r)).toContain("air.exemption_failed_recheck");
  });
  it("recheck: candidates false vs true (5b) → needs_facts naming the key", () => {
    const r = run("a", { ...A, exemption_failed_recheck: [yes(false), "extracted_candidate", yes(true), "extracted_candidate"] });
    expect(r.outcome).toBe("needs_facts");
    expect(conflictKeys(r)).toContain("air.exemption_failed_recheck");
  });
  it("mbr_filed: observed false vs user true, with a reference (5a) → manual_review", () => {
    const r = run("a", { ...A, mbr_filed: [yes(false), "observed", yes(true), "user_confirmed"] });
    expect(r.outcome).toBe("manual_review");
    expect(conflictKeys(r)).toContain("air.mbr_filed");
  });
  it("large aircraft: 5a on path c → manual_review; 5b on path b → needs_facts", () => {
    const c = run("c", { ...B, bag_status: [code("declared_lost")], large_aircraft_segment_on_ticket: [yes(false), "observed", yes(true), "user_confirmed"] });
    expect(c.outcome).toBe("manual_review");
    expect(conflictKeys(c)).toContain("air.large_aircraft_segment_on_ticket");
    const b = run("b", { ...B, large_aircraft_segment_on_ticket: [yes(false), "extracted_candidate", yes(true), "extracted_candidate"] }, CLOCK, lineRows(B_LINES));
    expect(b.outcome).toBe("needs_facts");
    expect(conflictKeys(b)).toContain("air.large_aircraft_segment_on_ticket");
  });
});

describe("R04-17 (low): a reimbursement not tied to a line is disclosed (D234 (13))", () => {
  it("the limitation says so, and a recorded reimbursement adds an assumption and asks the allocation", () => {
    expect(r04DelayedBagExpensesV1.knownLimitations.join(" ")).toMatch(/reimbursement not tied to lines/i);
    const r = run("b", { ...B, reimbursement_received: [usd(3_250)] }, CLOCK, lineRows(B_LINES));
    expect(r.assumptions.map((a) => a.id)).toContain("r04.v1.unallocated_reimbursement");
    expect(r.missingFacts.some((m) => m.subjectKey === "line:1" && m.key === "air.expense_allocated_to")).toBe(true);
  });
});

describe("R04-18 (low): a candidate 'MBR not filed' is a question", () => {
  it("R04-03 facts + candidate mbr_filed = false → answer_questions [air.mbr_filed]", () => {
    const r = run("a", {
      itinerary_scope: [code("domestic"), "derived"], bag_fee_paid: [usd(3_500)], deplane_opportunity_at: [at("2026-09-18T19:00:00-05:00")],
      bag_delivered_or_picked_up_at: [at("2026-09-19T15:00:00-05:00")], mbr_filed: cand(yes(false)),
    });
    expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "air.mbr_filed" }] });
  });
});

describe("R04-19 (low): the reason names the deciding condition", () => {
  it("a confirmed recheck exemption with a 13h15m delivery → the reason cites 260.5(f)", () => {
    const r = run("a", { ...A, exemption_failed_recheck: [yes(true)] });
    expect(r.outcome).toBe("not_eligible");
    expect(r.nextAction.kind === "none" ? r.nextAction.reason : "").toContain("260.5(f)");
  });
  it("a delivery before the deplane time is not not_eligible", () => {
    expect(run("a", { ...A, bag_delivered_or_picked_up_at: [at("2026-09-12T20:00:00-07:00")] }).outcome).not.toBe("not_eligible");
  });
});

describe("R04-20 (low): instants in explanations are labelled", () => {
  it("a 5a delivery-time conflict shows both times labelled UTC", () => {
    const r = run("a", { ...A, bag_delivered_or_picked_up_at: [at("2026-09-13T08:30:00-07:00"), "observed", at("2026-09-13T10:55:00-07:00"), "user_confirmed"] });
    expect(r.explanation.join(" ")).toContain("2026-09-13 17:55 UTC");
  });
});

describe("R04-21 (low): path c may be settled by a repair", () => {
  it("a knownLimitation says so", () => {
    expect(r04PropertyLossV1.knownLimitations.join(" ")).toMatch(/repair/i);
  });
});

describe("R04-22 (low): one non-USD line does not hide the USD lines", () => {
  it("R04-04 + a receipted EUR line → likely_eligible 41,250, the EUR line set aside", () => {
    const r = run("b", B, CLOCK, lineRows([...B_LINES, { amount: 5_000, date: "2026-09-06", receipt: [txt("evidence:rcpt501")], currency: "EUR" }]));
    expect([r.outcome, r.amount?.estimate.amountMinor]).toEqual(["likely_eligible", 41_250]);
  });
});

describe("DA-A-25: path a is tracked (track_automatic); b and c are claims (request)", () => {
  it("caseMode", () => {
    const mode = (p: R04Path) => (PACK[p] as unknown as { caseMode?: (r: EvaluationResult) => string }).caseMode?.(run(p, A));
    expect([mode("a"), mode("b"), mode("c")]).toEqual(["track_automatic", "request", "request"]);
  });
});
