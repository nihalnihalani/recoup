/**
 * r03_v1 packet template (M21): rendered from real R03 v1 evaluations' bound facts (the R03-01, R03-03 and R03-08
 * facts of docs/rules/fixtures/R03.json), it states only bound, known facts (DA-A-15), passes SEC-AI-4
 * (`packetFindings` = []), addresses only the billing-error address taken from the statement, and its text is pinned
 * by snapshots.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import type { FactValue } from "../facts/catalog";
import type { ResolveRow } from "../facts/resolve";
import { buildCardSnapshot } from "../facts/snapshot_card";
import type { CellRow } from "../facts/snapshot_retail";
import { evaluateR03V1, r03BillingErrorV1, r03RequiredChannel, R03_REMEDY_KEY, R03_V1_PARAMS, R03_V1_SOURCES } from "../rules/r03_billing_error_v1";
import { ENGINE_VERSION, type EvaluationResult } from "../rules/types";
import { factReader, packetFindings, PacketRenderError, type PacketContext } from "./common";
import { r03V1Letter } from "./r03_v1";

const row = (key: string, value: FactValue, state: ResolveRow["state"] = "user_confirmed"): CellRow =>
  ({ subjectKey: "txn", key, row: { state, value, at: 1, source: state === "user_confirmed" ? { kind: "user" } : { kind: "evidence", ref: "statement" } } });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const date = (d: string): FactValue => ({ kind: "local_date", date: d });
const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
const ADDRESS = "PO Box 0000, Example City, ST 00000";

function withRows(base: CellRow[], overrides: CellRow[]): CellRow[] {
  const keys = new Set(overrides.map((o) => o.key));
  return [...base.filter((b) => !keys.has(b.key)), ...overrides];
}

/** R03-01: a duplicate charge; first statement transmitted 2026-09-10 (clock 2026-09-23). */
const R03_01: CellRow[] = [
  row("card.payment_instrument_class", code("consumer_credit_card")),
  row("card.error_type", code("duplicate_charge")),
  row("card.charge_date", date("2026-09-02")),
  row("card.merchant_descriptor", { kind: "text", text: "ACME HOME GOODS" }),
  row("card.charge_amount", usd(12999)),
  row("card.first_statement_transmitted_on", date("2026-09-10")),
  row("card.statement_closing_date", date("2026-09-07")),
  row("card.billing_error_address", { kind: "text", text: ADDRESS }),
  row("card.electronic_notice_stipulated", { kind: "bool", value: false }),
  row("card.notice_channel_planned", code("mail_to_billing_error_address")),
  row("card.merchant_contacted", { kind: "bool", value: false }),
  row("card.existing_dispute_open", { kind: "bool", value: false }),
];
/** R03-03's line as a wrong amount with its first statement confirmed. */
const WRONG_AMOUNT = withRows(R03_01, [
  row("card.error_type", code("wrong_amount")), row("card.charge_date", date("2026-09-01")),
  row("card.merchant_descriptor", { kind: "text", text: "CITY FURNITURE" }), row("card.charge_amount", usd(94000)), row("card.correct_amount", usd(49000)),
]);
/** R03-08: goods not delivered by the agreed date; merchant not contacted. */
const R03_08 = withRows(R03_01, [
  row("card.error_type", code("not_delivered_as_agreed")), row("card.charge_date", date("2026-08-12")),
  row("card.merchant_descriptor", { kind: "text", text: "PARTY RENTALS ONLINE" }), row("card.charge_amount", usd(54000)),
  row("card.first_statement_transmitted_on", date("2026-08-28")), row("card.delivery_promised_by", date("2026-08-20")),
  row("card.delivery_tracking_summary", { kind: "text", text: "no shipment record" }),
]);

function evaluate(rows: CellRow[], now = Date.parse("2026-09-23T12:00:00-04:00")): EvaluationResult {
  return evaluateR03V1({
    snapshot: buildCardSnapshot({ transactionId: "cardline1" as Id<"transactions">, rows }),
    snapshotHash: "t", engineVersion: ENGINE_VERSION, remedyKey: R03_REMEDY_KEY, subjectKey: "txn",
    pack: { ruleId: r03BillingErrorV1.ruleId, scenarioId: "R03", version: 1, params: R03_V1_PARAMS, sources: R03_V1_SOURCES },
    verification: Object.fromEntries(["ecfr-12cfr1026.13", "ecfr-12cfr1026-suppI-13", "usc-15-1666"].map((id) => [id, { lastVerifiedAt: "2026-09-23" }])),
    caseContext: { settledMinorByLossKey: {} }, now,
  });
}
function ctxOf(r: EvaluationResult): PacketContext {
  return {
    scenarioId: "R03", ruleId: r.ruleId, ruleVersion: r.ruleVersion, amount: r.amount!.estimate, boundFacts: r.boundFacts,
    deadlines: r.deadlines, claimToken: "RC-R03TEST", channel: r03RequiredChannel(r),
  };
}
function renderChecked(rows: CellRow[]) {
  const r = evaluate(rows);
  const ctx = ctxOf(r);
  const facts = factReader(ctx.boundFacts);
  const draft = r03V1Letter.compose(ctx, facts);
  expect(packetFindings(draft.body, ctx, r03V1Letter, draft.recipient?.text ?? null)).toEqual([]);
  expect(packetFindings(draft.requestedRemedy, ctx, r03V1Letter, draft.recipient?.text ?? null)).toEqual([]);
  const bound = new Set(ctx.boundFacts.map((b) => `${b.subjectKey}/${b.key}`));
  for (const u of facts.used) expect(bound.has(`${u.subjectKey}/${u.key}`), u.key).toBe(true);
  expect(draft.body).not.toMatch(/contact(ed)? the merchant first|before (writing|contacting) you.*merchant/i); // no merchant-first gate
  return { r, ctx, draft };
}

describe("r03_v1.letter", () => {
  it("belongs to R03 v1 and renders for postal mail or the designated electronic means", () => {
    expect(r03V1Letter).toMatchObject({ ruleId: r03BillingErrorV1.ruleId, version: r03BillingErrorV1.version, templateId: "r03_v1.letter" });
    expect(r03V1Letter.channels).toEqual(["postal_mail", "portal"]);
  });

  it("R03-01 (duplicate charge): snapshot; addressed to the billing-error address from the statement", () => {
    const { r, draft } = renderChecked(R03_01);
    expect(r.outcome).toBe("eligible");
    expect(draft.recipient).toEqual({ text: ADDRESS, source: "user_entered_from_document" });
    expect(draft.requestedRemedy).toBe("Correct the billing error and credit USD 129.99 with related charges");
    expect(draft.body).toMatchInlineSnapshot(`
      "PO Box 0000, Example City, ST 00000

      Name: ____________________
      Account number: ____________________ (fill in before sending)

      Re: Billing-error notice — USD 129.99 from ACME HOME GOODS, dated September 2, 2026

      I am writing to dispute a billing error of USD 129.99 on my account.

      The charge: USD 129.99 from ACME HOME GOODS, dated September 2, 2026. It first appeared on the statement sent to me on September 10, 2026. This charge is a duplicate of another charge for the same purchase.

      Please correct the error and credit USD 129.99, together with any related finance or other charges, and send me documentation of your findings.

      This is a billing-error notice under the Fair Credit Billing Act (15 U.S.C. 1666) and Regulation Z (12 CFR 1026.13). Please acknowledge it in writing within 30 days of receiving it, and correct the error or explain in writing after a reasonable investigation within two complete billing cycles, and in no event later than 90 days. While it is being resolved, I understand I need not pay the disputed amount or related charges, and it may not be reported as delinquent.

      Reference: RC-R03TEST"
    `);
  });

  it("a wrong amount states the correct amount and disputes the difference", () => {
    const { r, draft } = renderChecked(WRONG_AMOUNT);
    expect(r.amount?.estimate).toEqual({ amountMinor: 45000, currency: "USD" });
    expect(draft.body).toContain("I am writing to dispute a billing error of USD 450.00 on my account.");
    expect(draft.body).toContain("The correct amount is USD 490.00.");
  });

  it("R03-08 (not delivered as agreed): snapshot, with the non-delivery investigation text", () => {
    const { draft } = renderChecked(R03_08);
    expect(draft.body).toMatchInlineSnapshot(`
      "PO Box 0000, Example City, ST 00000

      Name: ____________________
      Account number: ____________________ (fill in before sending)

      Re: Billing-error notice — USD 540.00 from PARTY RENTALS ONLINE, dated August 12, 2026

      I am writing to dispute a billing error of USD 540.00 on my account.

      The charge: USD 540.00 from PARTY RENTALS ONLINE, dated August 12, 2026. It first appeared on the statement sent to me on August 28, 2026. The goods or services were not delivered to me as agreed. Delivery was promised by August 20, 2026. Tracking shows: no shipment record.

      Please correct the error and credit USD 540.00, together with any related finance or other charges, and send me documentation of your findings.

      This is a billing-error notice under the Fair Credit Billing Act (15 U.S.C. 1666) and Regulation Z (12 CFR 1026.13). Please acknowledge it in writing within 30 days of receiving it, and correct the error or explain in writing after a reasonable investigation within two complete billing cycles, and in no event later than 90 days. While it is being resolved, I understand I need not pay the disputed amount or related charges, and it may not be reported as delinquent.

      For goods not delivered as agreed, the rule does not allow the claim to be denied without a reasonable investigation showing they were actually delivered, mailed or sent as agreed (comment 13(f)-3.ii).

      Reference: RC-R03TEST"
    `);
  });

  it("without the billing-error address the user must enter one (never guessed); the body says where it goes", () => {
    const rows = R03_01.filter((x) => x.key !== "card.billing_error_address");
    const { draft } = renderChecked(rows);
    expect(draft.recipient).toBeNull();
    expect(draft.body.startsWith("[Billing-error address from your statement — not the payment address]")).toBe(true);
  });

  it("an extracted error type cannot be stated: rendering refuses with 'not_known'", () => {
    const r = evaluate(withRows(R03_01, [row("card.error_type", code("duplicate_charge"), "extracted_candidate")]));
    expect(r.outcome).toBe("likely_eligible");
    expect(() => r03V1Letter.compose(ctxOf(r), factReader(r.boundFacts))).toThrow(PacketRenderError);
  });

  it("SEC-AI-4: a phone number or an amount the server did not supply is flagged after a user edit", () => {
    const { ctx, draft } = renderChecked(R03_01);
    const findings = packetFindings(`${draft.body}\nCall me at 555-123-4567 about the $999.00 refund.`, ctx, r03V1Letter, ADDRESS);
    expect(findings).toEqual(expect.arrayContaining(["phone 555-123-4567", "amount $999.00"]));
  });
});
