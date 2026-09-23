/**
 * M27c re-review template lows (recoup-wt-m27d-evidence/review.md, "Lows (fix in the same edit where cheap)"): one
 * describe per finding, named by its id. Every test here fails on `24dc6bf` (the revision M27c reviewed) and passes
 * after the batch-3 fixes.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r02View, r04View, type CellRow } from "../facts/snapshot_air";
import { evaluateR02V1, r02AirRefundV1, R02_SOURCES, R02_V1_PARAMS } from "../rules/r02_air_refund_v1";
import { evaluateR04V1, R04_REMEDY_KEYS, R04_SOURCES, R04_V1_PACKS, R04_V1_PARAMS } from "../rules/r04_baggage_v1";
import { ENGINE_VERSION, type EvaluationResult } from "../rules/types";
import { factReader, type PacketContext } from "./common";
import { selectTemplate, templateFor } from "./index";
import { R02_V1_TEMPLATES } from "./r02_v1";
import { R04_V1_TEMPLATES } from "./r04_v1";

const TXN_ID = "m27cpackettxn" as Id<"transactions">;
const NOW = Date.parse("2026-10-15T12:00:00-04:00");
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const row = (subjectKey: string, key: string, value: FactValue, state: ResolveRow["state"] = "user_confirmed"): CellRow =>
  ({ subjectKey, key, row: { state, value, at: 1, source: { kind: "user" } } });

const R02_ROWS: CellRow[] = [
  row("txn", "air.service_type", code("scheduled")),
  row("txn", "air.itinerary_scope", code("domestic"), "derived"),
  row("txn", "air.operating_carrier", { kind: "text", text: "XA" }),
  row("txn", "air.merchant_of_record", code("carrier")),
  row("txn", "air.ticket_refundability", code("nonrefundable")),
  row("txn", "air.event_type", code("cancellation")),
  row("txn", "air.ticket_number", { kind: "identifier", scheme: "eticket", value: "0012345678901" }),
  row("txn", "air.original_sched_departure_at", at("2026-10-05T07:00:00-04:00")),
  row("txn", "air.offer_type", code("rebooking")),
  row("txn", "air.consumer_response", code("rejected")),
  row("txn", "air.consumer_response_at", at("2026-10-01T15:20:00-04:00")),
  row("txn", "air.flew_changed_or_alternative", { kind: "bool", value: false }),
  row("txn", "air.payment_method_class", code("credit_card")),
  row("txn", "air.fare_paid", usd(38000)),
  row("txn", "air.taxes_paid", usd(4380)),
  row("txn", "air.ancillary_fees_total", usd(2500)),
  row("txn", "air.already_refunded", usd(0)),
];
function r02(rows: CellRow[], now = NOW): EvaluationResult {
  return evaluateR02V1({
    snapshot: r02View(buildAirSnapshot({ transactionId: TXN_ID, rows })), snapshotHash: "m27c", engineVersion: ENGINE_VERSION,
    remedyKey: r02AirRefundV1.remedyKey, subjectKey: "txn",
    pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: 1, params: R02_V1_PARAMS, sources: R02_SOURCES },
    verification: Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: new Date(now).toISOString().slice(0, 10) }])),
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}

const R04_ROWS: CellRow[] = [
  row("txn", "air.itinerary_scope", code("domestic"), "derived"),
  row("txn", "air.large_aircraft_segment_on_ticket", { kind: "bool", value: true }),
  row("txn", "air.bag_tag_number", { kind: "identifier", scheme: "bag_tag", value: "0123456789" }),
  row("txn", "air.bag_fee_paid", usd(4000)),
  row("txn", "air.deplane_opportunity_at", at("2026-09-12T21:40:00-07:00")),
  row("txn", "air.bag_delivered_or_picked_up_at", at("2026-09-13T10:55:00-07:00")),
  row("txn", "air.mbr_filed", { kind: "bool", value: true }),
  row("txn", "air.bag_status", code("declared_lost")),
];
function r04(path: "a" | "b" | "c", rows: CellRow[], bag = "txn"): EvaluationResult {
  const pack = R04_V1_PACKS[{ a: 0, b: 1, c: 2 }[path]];
  return evaluateR04V1(path, {
    snapshot: r04View(buildAirSnapshot({ transactionId: TXN_ID, rows }), bag), snapshotHash: "m27c", engineVersion: ENGINE_VERSION,
    remedyKey: pack.remedyKey, subjectKey: bag,
    pack: { ruleId: pack.ruleId, scenarioId: "R04", version: 1, params: R04_V1_PARAMS, sources: pack.sources },
    verification: Object.fromEntries(R04_SOURCES[path].map((s) => [s.sourceId, { lastVerifiedAt: "2026-09-23" }])),
    caseContext: { settledMinorByLossKey: {} }, now: Date.parse("2026-09-23T12:00:00-07:00"),
  });
}
function ctxOf(r: EvaluationResult, amountMinor: number): PacketContext {
  return {
    scenarioId: r.scenarioId, ruleId: r.ruleId, ruleVersion: r.ruleVersion, amount: { amountMinor, currency: "USD" },
    boundFacts: r.boundFacts, deadlines: r.deadlines, claimToken: "RC-TEST-0001", channel: "web_form", remedyKey: r.remedyKey,
  };
}

describe("L-T1: a typed proof value never renders \"(proof attached)\"", () => {
  it("path c, proof typed \"none\" → no \"(proof attached)\"; an attached evidence reference still shows it", () => {
    const rows: CellRow[] = [
      ...R04_ROWS,
      row("line:1", "air.property_item", { kind: "text", text: "laptop" }),
      row("line:1", "air.property_claimed_value", usd(240000)),
      row("line:1", "air.property_proof", { kind: "text", text: "none" }),
      row("line:2", "air.property_item", { kind: "text", text: "camera" }),
      row("line:2", "air.property_claimed_value", usd(50000)),
      row("line:2", "air.property_proof", { kind: "text", text: "evidence:rcpt099" }),
    ];
    const r = r04("c", rows);
    const template = templateFor(r.ruleId, r.ruleVersion, { remedyKey: r.remedyKey })!;
    const draft = template.compose(ctxOf(r, 290_000), factReader(r.boundFacts));
    expect(draft.body).toContain("- laptop, value USD 2,400.00"); // was "... (proof attached)" on 24dc6bf
    expect(draft.body).not.toContain("laptop, value USD 2,400.00 (proof attached)");
    expect(draft.body).toContain("- camera, value USD 500.00 (proof attached)");
  });
});

describe("L-T2 (D249): a caller-supplied templateId never bypasses the per-remedy selection", () => {
  it("a path-b claim's templateId pointed at path a's template is refused, not rendered under the wrong remedy", () => {
    const t = selectTemplate(R04_V1_TEMPLATES, "R04.baggage.us_dot", 1, { remedyKey: R04_REMEDY_KEYS.b, templateId: "r04_v1.bag_fee_refund_request" });
    expect(t).toBeNull(); // was the bag-fee-refund template on 24dc6bf, rendering the wrong remedy's letter
    // The matching remedy's own templateId still resolves normally.
    expect(selectTemplate(R04_V1_TEMPLATES, "R04.baggage.us_dot", 1, { remedyKey: R04_REMEDY_KEYS.b, templateId: "r04_v1.expense_claim" })).not.toBeNull();
    // A single-template pack (R02) is unaffected: its one template still resolves by templateId alone.
    expect(selectTemplate(R02_V1_TEMPLATES, "R02.airline_fare_refund.us_dot", 1, { templateId: "r02_v1.letter" })).not.toBeNull();
  });
});

describe("L-T3: \"did not travel\" is read from the bound flew fact, and worded by offer_type", () => {
  it("offer_type = none → no \"rejected the alternative\" (nothing was offered to reject)", () => {
    const rows = R02_ROWS.map((x) => (x.key === "air.offer_type" ? row("txn", x.key, code("none")) : x));
    const r = r02(rows);
    const template = templateFor(r.ruleId, r.ruleVersion, { remedyKey: r.remedyKey })!;
    const draft = template.compose(ctxOf(r, 44_880), factReader(r.boundFacts));
    expect(draft.body).not.toContain("rejected the alternative"); // was stated unconditionally on 24dc6bf
    expect(draft.body).toContain("No alternative flight or compensation was offered to me.");
  });

  it("rejected + an offer, flew confirmed false → \"did not travel\" IS read from the bound fact, not asserted blind", () => {
    const r = r02(R02_ROWS);
    const template = templateFor(r.ruleId, r.ruleVersion, { remedyKey: r.remedyKey })!;
    const draft = template.compose(ctxOf(r, 44_880), factReader(r.boundFacts));
    expect(draft.body).toContain("rejected the alternative the airline offered, and I did not travel on a replacement flight.");
  });
});
