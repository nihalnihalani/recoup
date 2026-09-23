/**
 * R02 v1 and R04 v1 packet templates (M22), rendered from the bound facts of real pack evaluations through the template
 * the server selects (D249: `templateFor(ruleId, version, { remedyKey })` — R02's one `r02_v1.letter`, R04's one
 * template per path). For every letter: (a) a snapshot of the draft,
 * (b) `packetFindings(...)` is [] (SEC-AI-4), (c) every fact the template read is bound and known (DA-A-15). Also:
 * nothing unconfirmed is ever stated (an unconfirmed ticket number or merchant of record stops rendering), the letter
 * always matches the path, a deadline date is never a day early, and the 14 CFR 254.4 figure never appears.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildAirSnapshot, r02View, r04View, type CellRow } from "../facts/snapshot_air";
import { evaluateR02V1, r02AirRefundV1, R02_SOURCES, R02_V1_PARAMS } from "../rules/r02_air_refund_v1";
import { evaluateR04V1, R04_SOURCES, R04_V1_PACKS, R04_V1_PARAMS } from "../rules/r04_baggage_v1";
import { ENGINE_VERSION, type EvaluationResult } from "../rules/types";
import { factReader, packetFindings, PacketRenderError, type PacketContext, type PacketTemplate } from "./common";
import { templateFor } from "./index";
import { r02AgentRefundRequest, r02V1Letter, R02_V1_TEMPLATES } from "./r02_v1";
import { r04BagFeeRefundRequest, r04ExpenseClaim, r04PropertyClaim, R04_V1_TEMPLATES } from "./r04_v1";
import { R04_REMEDY_KEYS } from "../rules/r04_baggage_v1";

const TXN_ID = "packettxn1" as Id<"transactions">;
const NOW = Date.parse("2026-10-15T12:00:00-04:00");
const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const row = (subjectKey: string, key: string, value: FactValue, state: ResolveRow["state"] = "user_confirmed"): CellRow =>
  ({ subjectKey, key, row: { state, value, at: 1, source: { kind: "user" } } });

const R02_ROWS: CellRow[] = [
  row("txn", "air.itinerary_scope", code("domestic"), "derived"),
  row("txn", "air.operating_carrier", { kind: "text", text: "XA" }),
  row("txn", "air.merchant_of_record", code("carrier")),
  row("txn", "air.ticket_refundability", code("nonrefundable")),
  row("txn", "air.event_type", code("cancellation")),
  row("txn", "air.ticket_number", { kind: "identifier", scheme: "eticket", value: "0012345678901" }),
  row("txn", "air.original_flight_number", { kind: "identifier", scheme: "flight_number", value: "XA100" }),
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
    snapshot: r02View(buildAirSnapshot({ transactionId: TXN_ID, rows })), snapshotHash: "t", engineVersion: ENGINE_VERSION,
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
  row("txn", "air.mbr_reference", { kind: "text", text: "SEAXA12345" }),
  row("txn", "air.exemption_failed_recheck", { kind: "bool", value: false }),
  row("txn", "air.exemption_failed_pickup", { kind: "bool", value: false }),
  row("txn", "air.exemption_voluntary_separation", { kind: "bool", value: false }),
  row("line:1", "air.expense_amount", usd(3250)),
  row("line:1", "air.expense_date", { kind: "local_date", date: "2026-09-13" }),
  row("line:1", "air.expense_receipt", { kind: "text", text: "evidence:rcpt001" }),
  row("line:2", "air.expense_amount", usd(18750)),
  row("line:2", "air.expense_date", { kind: "local_date", date: "2026-09-13" }),
  row("line:3", "air.expense_amount", usd(2400)),
  row("line:3", "air.expense_date", { kind: "local_date", date: "2026-09-13" }),
  row("line:3", "air.expense_receipt", { kind: "text", text: "evidence:rcpt003" }),
  row("line:3", "air.expense_allocated_to", { kind: "text", text: "card_benefit:baggage_delay" }),
];

function r04(path: "a" | "b" | "c", rows: CellRow[], bag = "txn"): EvaluationResult {
  const pack = R04_V1_PACKS[{ a: 0, b: 1, c: 2 }[path]];
  return evaluateR04V1(path, {
    snapshot: r04View(buildAirSnapshot({ transactionId: TXN_ID, rows }), bag), snapshotHash: "t", engineVersion: ENGINE_VERSION,
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

/** Renders through the template the server selects for the claim's remedy (what `packets.prepare` does, D249). */
function check(ctx: PacketContext, template: PacketTemplate = templateFor(ctx.ruleId, ctx.ruleVersion, { remedyKey: ctx.remedyKey })!) {
  const facts = factReader(ctx.boundFacts);
  const draft = template.compose(ctx, facts);
  expect(packetFindings(draft.body, ctx, template, draft.recipient?.text ?? null)).toEqual([]);
  for (const u of facts.used) {
    const b = ctx.boundFacts.find((x) => x.subjectKey === u.subjectKey && x.key === u.key);
    expect(b, `${u.key} is bound`).toBeDefined();
    expect(["confirmed", "observed", "derived"]).toContain(b!.status);
  }
  expect(draft.body.length).toBeLessThanOrEqual(8000);
  expect(draft.recipient).toBeNull(); // the refund / claim channel is not captured in v1: the user enters it
  expect(draft.body).not.toMatch(/4,700|3,800/);
  // SEC-AI-4 (M21's finding): a formatted date never stands directly before a formatted amount.
  expect(draft.body).not.toMatch(/\d{4},?\s+USD/);
  return draft;
}

describe("R02 v1 packet templates", () => {
  it("one registered letter for R02 v1 (remedy fare_refund; the merchant of record picks agent vs carrier)", () => {
    expect(R02_V1_TEMPLATES.map((t) => [t.ruleId, t.version, t.templateId, t.remedyKey])).toEqual([["R02.airline_fare_refund.us_dot", 1, "r02_v1.letter", "fare_refund"]]);
    expect(templateFor("R02.airline_fare_refund.us_dot", 1, { remedyKey: "fare_refund" })).toBe(r02V1Letter);
    expect(templateFor("R02.airline_fare_refund.us_dot", 1)).toBe(r02V1Letter);
  });

  it("ticket agent → refund request to the agency (399.80(l))", () => {
    const r = r02(R02_ROWS.map((x) => (x.key === "air.merchant_of_record" ? row("txn", x.key, code("ticket_agent")) : x)));
    expect(r.nextAction).toEqual({ kind: "request_refund" });
    const draft = check(ctxOf(r, 44880));
    expect(draft.body).toContain("You were the merchant of record");
    expect(draft.requestedRemedy).toBe("Refund of USD 448.80 to the original form of payment");
    expect(draft.body).toMatchSnapshot();
  });

  it("carrier overdue → escalation naming the missed deadline; with the zone unknown, the latest local date (M20b E1)", () => {
    const r = r02(R02_ROWS);
    expect(r.nextAction.kind).toBe("escalate");
    const draft = check(ctxOf(r, 44880));
    expect(draft.body.startsWith("Overdue refund:")).toBe(true);
    expect(draft.body).toContain("The refund was due by October 14, 2026, and I have not received it.");
    expect(draft.body).toContain("Office of Aviation Consumer Protection");
    expect(draft.body).toMatchSnapshot();
  });

  it("with a confirmed home zone the date is that zone's (New York: October 13)", () => {
    const r = r02([...R02_ROWS, row("txn", "air.home_time_zone", code("America/New_York"))]);
    expect(check(ctxOf(r, 44880)).body).toContain("The refund was due by October 13, 2026");
  });

  it("carrier, deadline not yet passed → a plain request with the due date and no complaint line", () => {
    const r = r02(R02_ROWS, Date.parse("2026-10-02T12:00:00-04:00"));
    expect(r.nextAction).toEqual({ kind: "track" });
    const draft = check(ctxOf(r, 44880));
    expect(draft.body.startsWith("Refund request:")).toBe(true);
    expect(draft.body).toContain("The refund is due by October 14, 2026.");
    expect(draft.body).not.toContain("complaint");
  });

  it("an unconfirmed ticket number or merchant of record is never stated: rendering stops with a confirm-first error", () => {
    for (const key of ["air.ticket_number", "air.merchant_of_record"]) {
      const r = r02(R02_ROWS.map((x) => (x.key === key ? { ...x, row: { ...x.row, state: "extracted_candidate" as const } } : x)));
      let error: unknown;
      try {
        r02V1Letter.compose(ctxOf(r, 44880), factReader(r.boundFacts));
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PacketRenderError);
      expect((error as PacketRenderError).key).toBe(key);
    }
    const agent = r02(R02_ROWS.map((x) => (x.key === "air.ticket_number" ? { ...x, row: { ...x.row, state: "extracted_candidate" as const } } : x)));
    expect(() => r02AgentRefundRequest.compose(ctxOf(agent, 44880), factReader(agent.boundFacts))).toThrow(PacketRenderError);
  });
});

describe("R04 v1 packet templates", () => {
  it("one template per R04 remedy (D249); each path's evaluation selects its own letter, and none is guessed", () => {
    expect(R04_V1_TEMPLATES.map((t) => [t.templateId, t.remedyKey])).toEqual([
      ["r04_v1.bag_fee_refund_request", R04_REMEDY_KEYS.a],
      ["r04_v1.expense_claim", R04_REMEDY_KEYS.b],
      ["r04_v1.property_claim", R04_REMEDY_KEYS.c],
    ]);
    const expected = { a: r04BagFeeRefundRequest, b: r04ExpenseClaim, c: r04PropertyClaim };
    for (const p of ["a", "b", "c"] as const) {
      const r = r04(p, R04_ROWS);
      expect(r.remedyKey).toBe(R04_REMEDY_KEYS[p]);
      expect(templateFor(r.ruleId, r.ruleVersion, { remedyKey: r.remedyKey })).toBe(expected[p]);
    }
    expect(templateFor("R04.baggage.us_dot", 1)).toBeNull();
  });

  it("path a → bag-fee refund request", () => {
    const r = r04("a", R04_ROWS);
    expect(r.outcome).toBe("eligible");
    const draft = check(ctxOf(r, 4000));
    expect(draft.body).toContain("bag tag 0123456789 (Mishandled Baggage Report SEAXA12345)");
    expect(draft.body).toMatchSnapshot();
  });

  it("path a, bag on its incident and the trip's incident date on txn → the arrival date comes from the trip", () => {
    const rows = [
      row("txn", "air.itinerary_scope", code("domestic"), "derived"),
      row("txn", "air.incident_date", { kind: "local_date", date: "2026-09-12" }),
      ...R04_ROWS.filter((x) => x.subjectKey === "txn" && x.key.startsWith("air.") && !["air.itinerary_scope", "air.large_aircraft_segment_on_ticket"].includes(x.key))
        .map((x) => ({ ...x, subjectKey: "incident:bag1" })),
    ];
    const r = r04("a", rows, "incident:bag1");
    expect(r.outcome).toBe("eligible");
    const draft = check(ctxOf(r, 4000));
    expect(draft.body).toContain("I arrived on September 12, 2026 without it.");
  });

  it("path b → expense claim listing only documented, unallocated lines", () => {
    const r = r04("b", R04_ROWS);
    expect(r.amount?.estimate.amountMinor).toBe(3250);
    const draft = check(ctxOf(r, 3250));
    expect(draft.body).toContain("Expense 1: USD 32.50, receipt attached.");
    expect(draft.body).not.toContain("Expense 2");
    expect(draft.body).not.toContain("Expense 3");
    expect(draft.body).toMatchSnapshot();
  });

  it("path b: when the listed lines do not add up to the ask, the letter itemises nothing it cannot show", () => {
    const r = r04("b", R04_ROWS);
    const draft = check(ctxOf(r, 5000));
    expect(draft.body).toContain("(itemised in the attached receipts)");
    expect(draft.body).not.toContain("Expense 1");
  });

  it("path c → property claim with documented values as evidence, never the federal limit", () => {
    const rows = [
      ...R04_ROWS.filter((x) => !x.subjectKey.startsWith("line:") && x.key !== "air.bag_delivered_or_picked_up_at"),
      row("txn", "air.bag_status", code("declared_lost")),
      row("line:1", "air.property_item", { kind: "text", text: "laptop" }),
      row("line:1", "air.property_claimed_value", usd(240000)),
      row("line:1", "air.property_proof", { kind: "text", text: "receipt 2024-11" }),
      row("line:2", "air.property_item", { kind: "text", text: "suitcase" }),
      row("line:2", "air.property_claimed_value", usd(50000)),
    ];
    const r = r04("c", rows);
    expect(r.outcome).toBe("likely_eligible");
    const draft = check(ctxOf(r, 290000));
    expect(draft.body).toContain("- laptop, value USD 2,400.00 (proof attached)");
    expect(draft.body).toContain("- suitcase, value USD 500.00");
    expect(draft.body).toMatchSnapshot();
  });
});
