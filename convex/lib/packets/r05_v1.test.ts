/**
 * r05_v1 packet template (M21): rendered from a real R05 v1 evaluation's bound facts (the R05-01 facts of
 * docs/rules/fixtures/R05.json), it states only bound, known facts (DA-A-15), passes SEC-AI-4 (`packetFindings` = []),
 * and its text is pinned by a snapshot.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildOrderSnapshot } from "../facts/snapshot_order";
import type { CellRow } from "../facts/snapshot_retail";
import { evaluateR05V1, r05LateOrderV1, R05_REMEDY_KEY, R05_V1_PARAMS, R05_V1_SOURCES } from "../rules/r05_late_order_v1";
import { ENGINE_VERSION, type EvaluationResult } from "../rules/types";
import { factReader, packetFindings, PacketRenderError, type PacketContext } from "./common";
import { r05V1Letter } from "./r05_v1";

const row = (key: string, value: FactValue, state: ResolveRow["state"] = "user_confirmed"): CellRow =>
  ({ subjectKey: "txn", key, row: { state, value, at: 1, source: state === "user_confirmed" ? { kind: "user" } : { kind: "evidence", ref: "email" } } });
const code = (c: string): FactValue => ({ kind: "code", code: c });

/** R05-01: "Ships within 3 days" missed; no delay notice; not shipped (clock 2026-09-10). */
function r05_01(overrides: CellRow[] = []): CellRow[] {
  const base: CellRow[] = [
    row("order.channel", code("internet")),
    row("order.seller_name", { kind: "text", text: "Example Outfitters LLC" }),
    row("order.buyer_country", code("US")), row("order.ship_to_country", code("US")), row("order.seller_country", code("US")),
    row("order.merchandise_category", code("general_merchandise"), "derived"),
    row("order.payment_terms", code("paid_at_order"), "derived"),
    row("card.payment_instrument_class", code("consumer_credit_card")),
    row("order.properly_completed_at", { kind: "instant", epochMs: Date.parse("2026-09-01T10:00:00-04:00") }),
    row("order.ship_time_kind", code("calendar_days")),
    row("order.ship_time_days", { kind: "count", n: 3 }),
    row("order.ship_time_text", { kind: "text", text: "Ships within 3 days" }),
    row("order.shipped", { kind: "bool", value: false }),
    row("order.delay_notice_received", { kind: "bool", value: false }),
    row("retail.order_total", { kind: "money", amountMinor: 15000, currency: "USD" }),
    row("retail.order_ref", { kind: "identifier", scheme: "order_ref", value: "EO-778812" }),
    row("order.ship_to_time_zone", code("America/New_York")),
  ];
  const keys = new Set(overrides.map((o) => o.key));
  return [...base.filter((b) => !keys.has(b.key)), ...overrides];
}

function evaluate(rows: CellRow[], now = Date.parse("2026-09-10T12:00:00-04:00")): EvaluationResult {
  return evaluateR05V1({
    snapshot: buildOrderSnapshot({ transactionId: "ordertxn1" as Id<"transactions">, rows }),
    snapshotHash: "t", engineVersion: ENGINE_VERSION, remedyKey: R05_REMEDY_KEY, subjectKey: "txn",
    pack: { ruleId: r05LateOrderV1.ruleId, scenarioId: "R05", version: 1, params: R05_V1_PARAMS, sources: R05_V1_SOURCES },
    verification: { "ecfr-16cfr435": { lastVerifiedAt: "2026-09-10" } },
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}

function ctxOf(r: EvaluationResult): PacketContext {
  return {
    scenarioId: "R05", ruleId: r.ruleId, ruleVersion: r.ruleVersion, amount: r.amount!.estimate, boundFacts: r.boundFacts,
    deadlines: r.deadlines, claimToken: "RC-R05TEST", channel: "web_form",
  };
}

describe("r05_v1.letter", () => {
  it("belongs to R05 v1 and renders for the manual channels", () => {
    expect(r05V1Letter).toMatchObject({ ruleId: r05LateOrderV1.ruleId, version: r05LateOrderV1.version, templateId: "r05_v1.letter" });
    expect(r05V1Letter.channels).toEqual(["postal_mail", "web_form", "portal", "chat"]);
  });

  it("R05-01: snapshot; SEC-AI-4 clean; every fact read is bound; no recipient is guessed", () => {
    const r = evaluate(r05_01());
    expect(r.outcome).toBe("eligible");
    const ctx = ctxOf(r);
    const facts = factReader(ctx.boundFacts);
    const draft = r05V1Letter.compose(ctx, facts);
    expect(draft.body).toMatchInlineSnapshot(`
      "Example Outfitters LLC

      Re: Request to cancel an unshipped order and refund it

      I placed an order with you (order EO-778812). You stated: "Ships within 3 days". The order has not been shipped. I have not received any notice offering me the choice to agree to a delay or to cancel.

      Under the FTC Mail, Internet, or Telephone Order Merchandise Rule (16 CFR Part 435), a seller that cannot ship an order within the time it stated (or, if it stated none, within 30 days) must offer the buyer the choice to agree to the delay or to cancel and get a prompt refund, and must treat the order as cancelled and refund it when it neither ships nor makes that offer in time.

      Please cancel the order and refund USD 150.00, the full amount I paid, to my original payment method. By my count the refund is due by September 16, 2026. A prompt refund is sent within 7 working days (16 CFR 435.1(b)) to the way I paid. Store credit, vouchers or scrip are not a refund.

      Reference: RC-R05TEST"
    `);
    expect(draft.requestedRemedy).toBe("Cancel the order and refund USD 150.00 to the original payment method");
    expect(draft.recipient).toBeNull();
    expect(packetFindings(draft.body, ctx, r05V1Letter, null)).toEqual([]);
    expect(packetFindings(draft.requestedRemedy, ctx, r05V1Letter, null)).toEqual([]);
    const bound = new Set(ctx.boundFacts.map((b) => `${b.subjectKey}/${b.key}`));
    expect(facts.used.length).toBeGreaterThan(0);
    for (const u of facts.used) expect(bound.has(`${u.subjectKey}/${u.key}`), u.key).toBe(true);
    expect(draft.body).not.toMatch(/sue|lawsuit|attorney/i); // L1: the rule states no private right of action
  });

  it("an inadequate delay notice and a partial shipment are stated only from confirmed facts", () => {
    const r = evaluate(r05_01([
      row("order.delay_notice_received", { kind: "bool", value: true }),
      row("order.delay_notice_received_at", { kind: "instant", epochMs: Date.parse("2026-09-03T09:00:00-04:00") }),
      row("order.delay_notice_offers_cancel", { kind: "bool", value: false }),
      row("order.partially_shipped", { kind: "bool", value: true }),
      row("order.ship_time_text", { kind: "text", text: "Ships within 3 days" }, "extracted_candidate"),
    ]));
    expect(r.outcome).toBe("eligible");
    const draft = r05V1Letter.compose({ ...ctxOf({ ...r, amount: { estimate: { amountMinor: 5000, currency: "USD" }, basis: "user_claimed", formula: "", inputs: [] } }) }, factReader(r.boundFacts));
    expect(draft.body).toContain("Your delay notice did not offer me the choice to cancel and receive a prompt refund.");
    expect(draft.body).toContain("Part of the order has not been shipped.");
    expect(draft.body).toContain("Please cancel the part of the order that was not shipped and refund USD 50.00 for it");
    expect(draft.body).not.toContain("the full amount I paid");
    expect(draft.requestedRemedy).toBe("Cancel the unshipped part of the order and refund USD 50.00 to the original payment method");
    expect(draft.body).not.toContain("Ships within 3 days"); // an extracted quote is never stated
  });

  it("an unconfirmed seller cannot be stated: rendering refuses with 'not_known' (packets.prepare asks to confirm it)", () => {
    const r = evaluate(r05_01([row("order.seller_name", { kind: "text", text: "Example Outfitters LLC" }, "extracted_candidate")]));
    expect(r.outcome).toBe("likely_eligible");
    expect(() => r05V1Letter.compose(ctxOf(r), factReader(r.boundFacts))).toThrow(PacketRenderError);
    try {
      r05V1Letter.compose(ctxOf(r), factReader(r.boundFacts));
    } catch (e) {
      expect(e).toMatchObject({ key: "order.seller_name", reason: "not_known" });
    }
  });

  it("SEC-AI-4: an amount, link or address the server did not supply is flagged after a user edit", () => {
    const r = evaluate(r05_01());
    const ctx = ctxOf(r);
    const draft = r05V1Letter.compose(ctx, factReader(ctx.boundFacts));
    const edited = `${draft.body}\nAlso send $500 to refunds@evil.example or see www.evil.example/claim.`;
    const findings = packetFindings(edited, ctx, r05V1Letter, null);
    expect(findings).toEqual(expect.arrayContaining(["amount $500", "email refunds@evil.example", "link www.evil.example/claim."]));
  });
});
