/**
 * R05 v1 packet template (M21): the buyer's request to the SELLER to cancel an unshipped mail / Internet / telephone
 * order and make the prompt refund 16 CFR 435 requires (spec §7, §10, §12 step 1). Pure and deterministic.
 *
 * It states ONLY bound facts (read through the FactReader, so an unbound or unconfirmed key throws and `packets.prepare`
 * asks for a confirmation first — DA-A-15) plus server fields (the claim's ask, its token, the evaluation's refund
 * deadline). Rule text is fixed pack text (`textBlocks`, exempt from SEC-AI-4). The recipient is left to the user:
 * Recoup holds the seller's name, never a guessed contact address (§12). No legal threat and no "you can sue" (L1).
 */
import { fill, formatLocalDate, formatMoney, type FactReader, type PacketContext, type PacketDraft, type PacketTemplate } from "./common";
import { R05_V1_REFUND_DEADLINE_ID, R05_V1_RULE_ID, R05_V1_VERSION } from "../rules/r05_late_order_v1";

const TXN = "txn";

export const R05_V1_RULE_TEXT =
  "Under the FTC Mail, Internet, or Telephone Order Merchandise Rule (16 CFR Part 435), a seller that cannot ship an order " +
  "within the time it stated (or, if it stated none, within 30 days) must offer the buyer the choice to agree to the delay " +
  "or to cancel and get a prompt refund, and must treat the order as cancelled and refund it when it neither ships nor " +
  "makes that offer in time.";
export const R05_V1_REFUND_TEXT =
  "A prompt refund is sent within 7 working days (16 CFR 435.1(b)) to the way I paid. Store credit, vouchers or scrip are not a refund.";

const BODY = `{{seller}}

Re: {{subject}}

{{facts}}

${R05_V1_RULE_TEXT}

{{request}}{{refund_by}} ${R05_V1_REFUND_TEXT}

Reference: {{token}}`;

function boolFact(facts: FactReader, key: string): boolean | null {
  if (!facts.has(TXN, key)) return null;
  const v = facts.value(TXN, key);
  return v.kind === "bool" ? v.value : null;
}

/** The facts paragraph, built only from what is bound and known. */
function factLines(facts: FactReader): string {
  const lines: string[] = [];
  const ref = facts.has(TXN, "retail.order_ref") ? ` (order ${facts.text(TXN, "retail.order_ref")})` : "";
  lines.push(`I placed an order with you${ref}.`);
  if (facts.has(TXN, "order.ship_time_text")) {
    lines.push(`You stated: "${facts.text(TXN, "order.ship_time_text")}".`);
  } else if (facts.has(TXN, "order.ship_by_date")) {
    lines.push(`You stated that the order would ship by ${formatLocalDate(facts.localDate(TXN, "order.ship_by_date"))}.`);
  }
  const partial = boolFact(facts, "order.partially_shipped") === true;
  if (boolFact(facts, "order.shipped") === false) {
    lines.push(partial ? "Part of the order has not been shipped." : "The order has not been shipped.");
  }
  const notice = boolFact(facts, "order.delay_notice_received");
  if (notice === false) lines.push("I have not received any notice offering me the choice to agree to a delay or to cancel.");
  if (notice === true && boolFact(facts, "order.delay_notice_offers_cancel") === false) {
    lines.push("Your delay notice did not offer me the choice to cancel and receive a prompt refund.");
  }
  if (facts.has(TXN, "order.buyer_response") && facts.text(TXN, "order.buyer_response") === "cancelled") {
    lines.push("I cancelled the order in reply to your delay notice.");
  }
  return lines.join(" ");
}

export const r05V1Letter: PacketTemplate = {
  ruleId: R05_V1_RULE_ID,
  version: R05_V1_VERSION,
  templateId: "r05_v1.letter",
  channels: ["postal_mail", "web_form", "portal", "chat"],
  textBlocks: [R05_V1_RULE_TEXT, R05_V1_REFUND_TEXT],
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const seller = facts.text(TXN, "order.seller_name");
    const partial = boolFact(facts, "order.partially_shipped") === true;
    const request = partial
      ? `Please cancel the part of the order that was not shipped and refund ${formatMoney(context.amount)} for it to my original payment method.`
      : `Please cancel the order and refund ${formatMoney(context.amount)}, the full amount I paid, to my original payment method.`;
    const refund = context.deadlines.find((d) => d.id === R05_V1_REFUND_DEADLINE_ID && d.dueLocalDate !== undefined && (d.status === "open" || d.status === "overdue"));
    const body = fill(BODY, {
      seller,
      subject: "Request to cancel an unshipped order and refund it",
      facts: factLines(facts),
      request,
      refund_by: refund?.dueLocalDate ? ` By my count the refund is due by ${formatLocalDate(refund.dueLocalDate)}.` : "",
      token: context.claimToken,
    });
    return {
      recipient: null,
      body,
      requestedRemedy: partial
        ? `Cancel the unshipped part of the order and refund ${formatMoney(context.amount)} to the original payment method`
        : `Cancel the order and refund ${formatMoney(context.amount)} to the original payment method`,
    };
  },
};
