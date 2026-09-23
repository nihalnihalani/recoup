/**
 * R03 v1 packet template (M21): the consumer's written billing-error notice to the CREDITOR at the billing-error
 * address (12 CFR 1026.13(b); spec §10, §12). Pure and deterministic.
 *
 * It states ONLY bound facts (read through the FactReader — an unbound or unconfirmed key throws, DA-A-15) plus
 * server fields (the claim's ask and token). Contents follow 1026.13(b)(2)–(3): enough to identify the account, the
 * belief and reasons, and the type, date and amount of the error. Recoup never stores a card number, so the name and
 * account lines are left for the user to fill in. The recipient is the billing-error address the user took from the
 * statement (never guessed, §12); without it the user must enter one. No merchant-first language (comment
 * 13(a)(3)-3). Rule text is fixed pack text (`textBlocks`, exempt from SEC-AI-4).
 */
import { fill, formatLocalDate, formatMoney, type FactReader, type PacketContext, type PacketDraft, type PacketTemplate } from "./common";
import { R03_V1_RULE_ID, R03_V1_VERSION } from "../rules/r03_billing_error_v1";

const TXN = "txn";

export const R03_V1_IDENTITY_TEXT = "Name: ____________________\nAccount number: ____________________ (fill in before sending)";
export const R03_V1_RULE_TEXT =
  "This is a billing-error notice under the Fair Credit Billing Act (15 U.S.C. 1666) and Regulation Z (12 CFR 1026.13). " +
  "Please acknowledge it in writing within 30 days of receiving it, and correct the error or explain in writing after a " +
  "reasonable investigation within two complete billing cycles, and in no event later than 90 days. While it is being " +
  "resolved, I understand I need not pay the disputed amount or related charges, and it may not be reported as delinquent.";
export const R03_V1_NONDELIVERY_TEXT =
  "For goods not delivered as agreed, the rule does not allow the claim to be denied without a reasonable investigation " +
  "showing they were actually delivered, mailed or sent as agreed (comment 13(f)-3.ii).";

const ERROR_SENTENCE: Readonly<Record<string, string>> = Object.freeze({
  unauthorized_charge: "I did not make or authorize this charge.",
  duplicate_charge: "This charge is a duplicate of another charge for the same purchase.",
  wrong_amount: "This charge is for the wrong amount.",
  not_delivered_as_agreed: "The goods or services were not delivered to me as agreed.",
  not_accepted: "I did not accept the goods or services, which did not conform to the agreement.",
  credit_issued_not_reflected: "The merchant issued a credit that has not been reflected on my account.",
  promised_credit_not_issued: "I returned the goods and the promised credit was never issued.",
  computational_error: "The amount reflects a computational error.",
  clarification_request: "I request clarification and documentation of this charge, which I believe is in error.",
});

const BODY = `{{recipient}}

${R03_V1_IDENTITY_TEXT}

Re: Billing-error notice — {{line}}

I am writing to dispute a billing error of {{amount}} on my account.

{{facts}}

Please correct the error and credit {{amount}}, together with any related finance or other charges, and send me documentation of your findings.

${R03_V1_RULE_TEXT}{{nondelivery}}

Reference: {{token}}`;

/**
 * "USD 129.99 from ACME HOME GOODS, dated September 2, 2026". The amount comes first: a date followed by a currency
 * code ("2026, USD 129.99") would read to SEC-AI-4 as an unsupplied amount "2026 USD".
 */
function lineText(facts: FactReader): string {
  let text = formatMoney(facts.money(TXN, "card.charge_amount"));
  if (facts.has(TXN, "card.merchant_descriptor")) text += ` from ${facts.text(TXN, "card.merchant_descriptor")}`;
  if (facts.has(TXN, "card.charge_date")) text += `, dated ${formatLocalDate(facts.localDate(TXN, "card.charge_date"))}`;
  return text;
}

function factLines(facts: FactReader, errorType: string): string {
  const lines: string[] = [];
  lines.push(`The charge: ${lineText(facts)}.`);
  if (facts.has(TXN, "card.first_statement_transmitted_on")) {
    lines.push(`It first appeared on the statement sent to me on ${formatLocalDate(facts.localDate(TXN, "card.first_statement_transmitted_on"))}.`);
  }
  const sentence = ERROR_SENTENCE[errorType];
  if (sentence) lines.push(sentence);
  if ((errorType === "wrong_amount" || errorType === "computational_error") && facts.has(TXN, "card.correct_amount")) {
    lines.push(`The correct amount is ${formatMoney(facts.money(TXN, "card.correct_amount"))}.`);
  }
  if (errorType === "credit_issued_not_reflected" && facts.has(TXN, "card.credit_issue_date")) {
    lines.push(`The merchant issued the credit on ${formatLocalDate(facts.localDate(TXN, "card.credit_issue_date"))}.`);
  }
  if (errorType === "not_delivered_as_agreed" || errorType === "not_accepted") {
    if (facts.has(TXN, "card.delivery_promised_by")) {
      lines.push(`Delivery was promised by ${formatLocalDate(facts.localDate(TXN, "card.delivery_promised_by"))}.`);
    }
    if (facts.has(TXN, "card.delivery_tracking_summary")) lines.push(`Tracking shows: ${facts.text(TXN, "card.delivery_tracking_summary")}.`);
  }
  if (facts.has(TXN, "card.merchant_contacted")) {
    const v = facts.value(TXN, "card.merchant_contacted");
    if (v.kind === "bool" && v.value) lines.push("I have also contacted the merchant.");
  }
  return lines.join(" ");
}

export const r03V1Letter: PacketTemplate = {
  ruleId: R03_V1_RULE_ID,
  version: R03_V1_VERSION,
  templateId: "r03_v1.letter",
  channels: ["postal_mail", "portal"],
  textBlocks: [R03_V1_IDENTITY_TEXT, R03_V1_RULE_TEXT, R03_V1_NONDELIVERY_TEXT],
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const errorType = facts.text(TXN, "card.error_type");
    const address = facts.has(TXN, "card.billing_error_address") ? facts.text(TXN, "card.billing_error_address") : null;
    const goods = errorType === "not_delivered_as_agreed" || errorType === "not_accepted";
    const body = fill(BODY, {
      recipient: address ?? "[Billing-error address from your statement — not the payment address]",
      line: lineText(facts),
      amount: formatMoney(context.amount),
      facts: factLines(facts, errorType),
      nondelivery: goods ? `\n\n${R03_V1_NONDELIVERY_TEXT}` : "",
      token: context.claimToken,
    });
    return {
      recipient: address === null ? null : { text: address, source: "user_entered_from_document" },
      body,
      requestedRemedy: `Correct the billing error and credit ${formatMoney(context.amount)} with related charges`,
    };
  },
};
