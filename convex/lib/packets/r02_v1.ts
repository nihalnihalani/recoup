/**
 * R02 v1 packet templates (M22; contract §6). Deterministic text from the evaluation's bound facts (N6) and server
 * fields only: no context, clock, randomness or `lib/ai`. Every fact is read through the `FactReader`, so a fact that is
 * not bound or not known (confirmed/observed/derived) stops rendering with "confirm X first" (DA-A-15).
 *
 *   r02_v1.letter  the registered template (remedy `fare_refund`, D249). Both letters are the same remedy, so the
 *                  remedy key cannot tell them apart: the letter is picked from the bound merchant of record, and an
 *                  unconfirmed merchant of record stops rendering ("confirm it first").
 *     agent_refund_request  R02.b — a ticket agent took the payment: it refunds on request (14 CFR 399.80(l)).
 *     carrier_request       R02.a — the airline refunds automatically; the letter asks for it, and once the airline's
 *                           deadline has passed in every US time zone it says so (DA-A-5 overdue → escalate) — only
 *                           on a confirmed scheduled flight, never on assumption A8 (M27 R3-04, D253(3)).
 *
 * The recipient is never guessed: the airline's or agency's refund channel is not captured in the pack, so the user
 * enters it. A deadline date is the LATEST local due date when the time zone is unknown (M20b E1), so the letter
 * never calls the airline late, or names a date, that is a day early.
 * SEC-AI-4: every number in the body is a bound value or fixed pack text (`textBlocks`); a date is never placed directly
 * before an amount.
 */
import { localParts, US_ZONES } from "../deadlines/usZones";
import type { DeadlineResult } from "../rules/types";
import { R02_CARRIER_TIMER_CREDIT_ID, R02_CARRIER_TIMER_OTHER_ID, R02_REMEDY_KEY, R02_V1_RULE_ID, R02_V1_VERSION } from "../rules/r02_air_refund_v1";
import { fill, formatLocalDate, formatMoney, PacketRenderError, type FactReader, type ManualChannel, type PacketContext, type PacketDraft, type PacketTemplate } from "./common";

const TXN = "txn";
const CHANNELS: readonly ManualChannel[] = Object.freeze(["web_form", "portal", "chat", "postal_mail"]);

/** Fixed pack text (verbatim; exempt from SEC-AI-4 as pack text). Each states the rule it relies on. */
export const R02_AGENT_RULE_TEXT =
  "Under 14 CFR 399.80(l), a ticket agent that is the merchant of record must provide, upon request, a prompt refund of airfare that is due under 14 CFR part 260, including taxes and ancillary fees: within 7 business days for a credit card purchase, or within 20 calendar days for cash, check, debit card or other forms of payment.";
export const R02_CARRIER_RULE_TEXT =
  "Under 14 CFR 260.6, a carrier that is the merchant of record must provide a full refund of the airfare, including taxes and ancillary fees, in the original form of payment when a flight is cancelled or significantly changed and the passenger does not accept the alternative. The refund is automatic and due within 7 business days (credit card) or 20 calendar days (other forms of payment) of the refund request (14 CFR 260.2, prompt refund).";
export const R02_COMPLAINT_TEXT =
  "If the refund is not issued, I will file a complaint with the U.S. Department of Transportation's Office of Aviation Consumer Protection.";

const EVENT_TEXT: Readonly<Record<string, string>> = Object.freeze({
  cancellation: "was cancelled",
  renumbered_only: "was cancelled and replaced by a flight with a different number",
  schedule_change: "was significantly changed",
  operational_delay: "was significantly delayed",
  downgrade: "was changed to a lower class of service",
  airport_change: "was moved to a different airport",
  added_connection: "was changed to add a connection",
});

/**
 * The local date of a bound instant, only when it is the same date in every US zone (the committed zone table): the
 * consumer's zone is not bound, and a packet never states a date that could be a day off. Null → the date is omitted.
 */
function usDate(facts: FactReader, key: string): string | null {
  if (!facts.has(TXN, key)) return null;
  const v = facts.value(TXN, key);
  if (v.kind === "local_date") return v.date;
  if (v.kind !== "instant") return null;
  try {
    const dates = new Set(US_ZONES.map((z) => localParts(z, v.epochMs).date));
    return dates.size === 1 ? [...dates][0] : null;
  } catch {
    return null;
  }
}

/**
 * "On October 1, 2026, I rejected …" / "I did not respond …" — from the bound decision (never a guess). L-T3: the
 * "did not travel" clause is read from the bound `air.flew_changed_or_alternative` (never stated unconditionally,
 * which could contradict the facts), and the wording is chosen by `offer_type` — "rejected the alternative" is never
 * said when no alternative was offered (offer_type = none).
 */
function decisionText(facts: FactReader): string {
  const response = facts.has(TXN, "air.consumer_response") ? facts.text(TXN, "air.consumer_response") : null;
  const offer = facts.has(TXN, "air.offer_type") ? facts.text(TXN, "air.offer_type") : null;
  const flewValue = facts.has(TXN, "air.flew_changed_or_alternative") ? facts.value(TXN, "air.flew_changed_or_alternative") : null;
  const flew = flewValue?.kind === "bool" ? flewValue.value : null;
  const notTravelled = flew === false ? ", and I did not travel on a replacement flight" : "";
  if (response === "rejected" && offer !== "none") {
    const on = usDate(facts, "air.consumer_response_at");
    return `${on ? `On ${formatLocalDate(on)}, I` : "I"} rejected the alternative the airline offered${notTravelled}.`;
  }
  if (response === "no_response" && offer !== "none") return `I did not accept the alternative the airline offered${notTravelled}.`;
  if (offer === "none") return "No alternative flight or compensation was offered to me.";
  return "I did not accept any alternative or compensation.";
}

function tripLine(facts: FactReader): string {
  const ticket = facts.text(TXN, "air.ticket_number");
  const flight = facts.has(TXN, "air.original_flight_number") ? ` for flight ${facts.text(TXN, "air.original_flight_number")}` : "";
  const departs = usDate(facts, "air.original_sched_departure_at");
  return `ticket ${ticket}${flight}${departs ? `, originally scheduled to depart on ${formatLocalDate(departs)}` : ""}`;
}

function eventText(facts: FactReader): string {
  return EVENT_TEXT[facts.text(TXN, "air.event_type")] ?? "was significantly changed";
}

const requestedRemedy = (context: PacketContext) => `Refund of ${formatMoney(context.amount)} to the original form of payment`;

export const r02AgentRefundRequest: PacketTemplate = Object.freeze({
  ruleId: R02_V1_RULE_ID,
  version: R02_V1_VERSION,
  templateId: "r02_v1.agent_refund_request",
  channels: CHANNELS,
  textBlocks: Object.freeze([R02_AGENT_RULE_TEXT]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const body = fill(
      [
        "Refund request: {{trip}}",
        "Reference: {{token}}",
        "",
        "You were the merchant of record for {{trip}}. The flight {{event}}. {{decision}}",
        "",
        "I request a refund of the airfare, taxes and fees. The amount I am asking for is {{amount}}, to my original form of payment.",
        "",
        "{{rule}}",
        "",
        "Please confirm the refund and tell me when it will be issued.",
      ].join("\n"),
      {
        trip: tripLine(facts),
        token: context.claimToken,
        event: eventText(facts),
        decision: decisionText(facts),
        amount: formatMoney(context.amount),
        rule: R02_AGENT_RULE_TEXT,
      },
    );
    return { recipient: null, body, requestedRemedy: requestedRemedy(context) };
  },
});

/** The airline's firm timer (a date is stated only when the timer has one; `unknown_anchor` / disputed → none). */
function carrierTimer(deadlines: readonly DeadlineResult[]): { date: string; overdue: boolean } | null {
  const d = deadlines.find((x) => (x.id === R02_CARRIER_TIMER_CREDIT_ID || x.id === R02_CARRIER_TIMER_OTHER_ID) && x.dueAt !== undefined && x.dueLocalDate !== undefined);
  if (!d) return null;
  // M20b E1: with the zone unknown the range's LATEST date is the one true in every zone ("due by" never a day early).
  return { date: d.dueLocalDateRange?.latest ?? d.dueLocalDate!, overdue: d.status === "overdue" };
}

export const r02CarrierRequest: PacketTemplate = Object.freeze({
  ruleId: R02_V1_RULE_ID,
  version: R02_V1_VERSION,
  templateId: "r02_v1.carrier_request",
  channels: CHANNELS,
  textBlocks: Object.freeze([R02_CARRIER_RULE_TEXT, R02_COMPLAINT_TEXT]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const timer = carrierTimer(context.deadlines);
    const overdue = timer?.overdue === true;
    // M27 R3-04 / D253(3): the overdue letter (lateness + a DOT complaint) never rests on assumption A8 — it needs a
    // confirmed scheduled flight; otherwise rendering stops with "confirm air.service_type first".
    if (overdue && facts.text(TXN, "air.service_type") !== "scheduled") throw new PacketRenderError(TXN, "air.service_type", "not_known");
    const due = timer === null
      ? "I have not received the refund."
      : overdue
        ? `The refund was due by ${formatLocalDate(timer.date)}, and I have not received it.`
        : `The refund is due by ${formatLocalDate(timer.date)}.`;
    const body = fill(
      [
        "{{headline}}: {{trip}}",
        "Reference: {{token}}",
        "",
        "The flight {{event}}. {{decision}} {{due}}",
        "",
        "The amount I am asking for is {{amount}}, to my original form of payment.",
        "",
        "{{rule}}",
        "",
        "{{closing}}",
      ].join("\n"),
      {
        headline: overdue ? "Overdue refund" : "Refund request",
        trip: tripLine(facts),
        token: context.claimToken,
        event: eventText(facts),
        decision: decisionText(facts),
        due,
        amount: formatMoney(context.amount),
        rule: R02_CARRIER_RULE_TEXT,
        closing: overdue ? R02_COMPLAINT_TEXT : "Please confirm the refund and tell me when it will be issued.",
      },
    );
    return { recipient: null, body, requestedRemedy: requestedRemedy(context) };
  },
});

/**
 * The registered R02 v1 template (remedy `fare_refund`): the bound merchant of record picks the letter (a ticket agent → the 399.80(l)
 * request; the carrier → the carrier letter). Reading it through the FactReader means an unconfirmed merchant of
 * record stops rendering with "confirm it first".
 */
export const r02V1Letter: PacketTemplate = Object.freeze({
  ruleId: R02_V1_RULE_ID,
  version: R02_V1_VERSION,
  templateId: "r02_v1.letter",
  remedyKey: R02_REMEDY_KEY,
  channels: CHANNELS,
  textBlocks: Object.freeze([...r02AgentRefundRequest.textBlocks, ...r02CarrierRequest.textBlocks]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const mor = facts.text(TXN, "air.merchant_of_record");
    return (mor === "ticket_agent" ? r02AgentRefundRequest : r02CarrierRequest).compose(context, facts);
  },
});

/** For `lib/packets/index.ts` (`PACKET_TEMPLATES`): only the dispatcher is registered. */
export const R02_V1_TEMPLATES: readonly PacketTemplate[] = Object.freeze([r02V1Letter]);
