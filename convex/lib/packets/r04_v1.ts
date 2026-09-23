/**
 * R04 v1 packet templates (M22; contract §6). Deterministic text from the evaluation's bound facts (N6) and server
 * fields only: no context, clock, randomness or `lib/ai`; every fact is read through the `FactReader` (DA-A-15).
 *
 *   r04_v1.letter  the registered template. Paths a, b and c share R04 v1's ruleId/version and a packet context carries
 *                  no remedy path, so the letter is picked from the path's bound-fact set (a binds the 260.5(f)
 *                  exemptions, b the reimbursement key, c neither) — the wrong letter can never be written.
 *     bag_fee_refund_request  path a — the bag-fee refund is automatic after the report (260.5(d)); this is the
 *                             user-initiated request when it has not arrived (DOT-REF-8: ask the airline).
 *     expense_claim           path b — documented, unallocated incidental expenses (receipts attached).
 *     property_claim          path c — lost or damaged items, with the values the user documented.
 *
 * The airline's claim channel and deadlines are not captured in v1, so the recipient is always entered by the user.
 * The 14 CFR 254.4 figure is never stated in a packet (a limit, never a payout). SEC-AI-4: every number is a bound value
 * or fixed pack text; a date never stands directly before an amount.
 */
import { localParts, US_ZONES } from "../deadlines/usZones";
import { lineSubject, R04_MAX_EXPENSE_LINES, R04_MAX_PROPERTY_ITEMS } from "../facts/snapshot_air";
import { R04_ALLOCATION_REF, R04_RECEIPT_REF, R04_V1_RULE_ID, R04_V1_VERSION } from "../rules/r04_baggage_v1";
import type { BoundFactValue } from "../rules/types";
import { fill, formatLocalDate, formatMoney, type FactReader, type ManualChannel, type PacketContext, type PacketDraft, type PacketTemplate } from "./common";

const TXN = "txn";
const CHANNELS: readonly ManualChannel[] = Object.freeze(["web_form", "portal", "postal_mail", "in_person"]);

export const R04_FEE_RULE_TEXT =
  "Under 14 CFR 260.5, once a Mishandled Baggage Report has been filed and a checked bag is lost or significantly delayed, the carrier must refund at least the fee paid to transport that bag, in the original form of payment (14 CFR 260.10).";
export const R04_EXPENSE_GUIDANCE_TEXT =
  "DOT guidance states that airlines must compensate passengers for reasonable, verifiable and actual incidental expenses while their bags are delayed, and may not set an arbitrary daily amount for those expenses.";
export const R04_PROPERTY_GUIDANCE_TEXT =
  "DOT guidance states that once an airline determines a bag is lost, it is responsible for compensating the passenger for the bag's contents, subject to depreciation and its liability limits.";

/** The bag subject the evaluation bound (txn, or the bag's incident): per-bag keys are bound on the bag itself. */
function bagSubject(boundFacts: readonly BoundFactValue[]): string {
  return boundFacts.find((b) => b.key === "air.bag_status" || b.key === "air.bag_tag_number")?.subjectKey ?? TXN;
}

/** Where the evaluation bound `key` for this bag: a trip-level key (deplane, incident date) may sit on `txn` (M22b). */
function boundAt(boundFacts: readonly BoundFactValue[], bag: string, key: string): string {
  return boundFacts.find((b) => b.key === key && b.subjectKey === bag)?.subjectKey
    ?? boundFacts.find((b) => b.key === key && b.subjectKey === TXN)?.subjectKey
    ?? bag;
}

function bagLine(facts: FactReader, bag: string): string {
  const tag = facts.has(bag, "air.bag_tag_number") ? `bag tag ${facts.text(bag, "air.bag_tag_number")}` : "my checked bag";
  const report = facts.has(bag, "air.mbr_reference") ? ` (Mishandled Baggage Report ${facts.text(bag, "air.mbr_reference")})` : "";
  return `${tag}${report}`;
}

/**
 * The arrival date: the bound incident date (the destination's local date, A3), else the deplane instant's date when
 * it is the same in every US zone; otherwise no date is stated (a packet never states a date that could be a day off).
 */
function arrivalLine(context: PacketContext, facts: FactReader, bag: string): string {
  const incident = boundAt(context.boundFacts, bag, "air.incident_date");
  const deplane = boundAt(context.boundFacts, bag, "air.deplane_opportunity_at");
  let date: string | null = facts.has(incident, "air.incident_date") ? facts.localDate(incident, "air.incident_date") : null;
  if (date === null && facts.has(deplane, "air.deplane_opportunity_at")) {
    const v = facts.value(deplane, "air.deplane_opportunity_at");
    if (v.kind === "instant") {
      try {
        const dates = new Set(US_ZONES.map((z) => localParts(z, v.epochMs).date));
        if (dates.size === 1) date = [...dates][0];
      } catch {
        date = null;
      }
    }
  }
  return date ? ` I arrived on ${formatLocalDate(date)} without it.` : "";
}

export const r04BagFeeRefundRequest: PacketTemplate = Object.freeze({
  ruleId: R04_V1_RULE_ID,
  version: R04_V1_VERSION,
  templateId: "r04_v1.bag_fee_refund_request",
  channels: CHANNELS,
  textBlocks: Object.freeze([R04_FEE_RULE_TEXT]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const bag = bagSubject(context.boundFacts);
    const lost = facts.has(bag, "air.bag_status") && facts.text(bag, "air.bag_status") === "declared_lost";
    if (!facts.has(bag, "air.mbr_filed") && !facts.has(bag, "air.mbr_reference") && !facts.has(bag, "air.mbr_filed_at")) {
      facts.value(bag, "air.mbr_filed"); // throws "confirm the baggage report first"
    }
    const body = fill(
      [
        "Bag-fee refund request: {{bag}}",
        "Reference: {{token}}",
        "",
        "My checked bag was {{what}}, and I filed a Mishandled Baggage Report.{{arrival}}",
        "",
        "I request a refund of the fee I paid to check it. The amount I am asking for is {{amount}}, to my original form of payment.",
        "",
        "{{rule}}",
      ].join("\n"),
      {
        bag: bagLine(facts, bag),
        token: context.claimToken,
        what: lost ? "declared lost" : "significantly delayed",
        arrival: arrivalLine(context, facts, bag),
        amount: formatMoney(context.amount),
        rule: R04_FEE_RULE_TEXT,
      },
    );
    return { recipient: null, body, requestedRemedy: `Refund of the checked-bag fee, ${formatMoney(context.amount)}, to the original form of payment` };
  },
});

function lineOrdinals(context: PacketContext, max: number): number[] {
  const ordinals = context.boundFacts.map((b) => /^line:(\d+)$/.exec(b.subjectKey)?.[1]).filter((x): x is string => x !== undefined).map(Number);
  return [...new Set(ordinals)].sort((a, b) => a - b).slice(0, max);
}

/**
 * The expense lines to list: amount known, an attached receipt (`evidence:<id>`, R04-11) and no known allocation to
 * another remedy (R04-12) — the pack's own rules. The pack also applies the A2 date window and sets aside a line equal
 * to a bag fee, which the bound facts cannot fully show, so the lines are itemised only when they add up to exactly the
 * claim's ask; otherwise the letter points to the attached receipts (it never states a total it cannot show).
 */
function documentedLines(context: PacketContext, facts: FactReader): string[] | null {
  const lines: { n: number; money: { amountMinor: number; currency: string } }[] = [];
  for (const n of lineOrdinals(context, R04_MAX_EXPENSE_LINES)) {
    const s = lineSubject(n);
    if (!facts.has(s, "air.expense_amount") || !facts.has(s, "air.expense_receipt")) continue;
    if (!R04_RECEIPT_REF.test(facts.text(s, "air.expense_receipt"))) continue;
    if (facts.has(s, "air.expense_allocated_to") && R04_ALLOCATION_REF.test(facts.text(s, "air.expense_allocated_to"))) continue;
    lines.push({ n, money: facts.money(s, "air.expense_amount") });
  }
  const sum = lines.reduce((a, l) => a + l.money.amountMinor, 0);
  if (lines.length === 0 || sum !== context.amount.amountMinor || lines.some((l) => l.money.currency !== context.amount.currency)) return null;
  return lines.map((l) => `Expense ${l.n}: ${formatMoney(l.money)}, receipt attached.`);
}

export const r04ExpenseClaim: PacketTemplate = Object.freeze({
  ruleId: R04_V1_RULE_ID,
  version: R04_V1_VERSION,
  templateId: "r04_v1.expense_claim",
  channels: CHANNELS,
  textBlocks: Object.freeze([R04_EXPENSE_GUIDANCE_TEXT]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const bag = bagSubject(context.boundFacts);
    const lines = documentedLines(context, facts);
    const body = fill(
      [
        "Delayed-bag expense claim: {{bag}}",
        "Reference: {{token}}",
        "",
        "My checked bag did not arrive with me.{{arrival}} While it was delayed I bought the following essentials:",
        "",
        "{{lines}}",
        "",
        "The total I am claiming is {{amount}}.",
        "",
        "{{guidance}}",
        "",
        "Please tell me if you need anything else to process this claim.",
      ].join("\n"),
      {
        bag: bagLine(facts, bag),
        token: context.claimToken,
        arrival: arrivalLine(context, facts, bag),
        lines: lines === null ? "(itemised in the attached receipts)" : lines.join("\n"),
        amount: formatMoney(context.amount),
        guidance: R04_EXPENSE_GUIDANCE_TEXT,
      },
    );
    return { recipient: null, body, requestedRemedy: `Reimbursement of documented expenses, ${formatMoney(context.amount)}` };
  },
});

export const r04PropertyClaim: PacketTemplate = Object.freeze({
  ruleId: R04_V1_RULE_ID,
  version: R04_V1_VERSION,
  templateId: "r04_v1.property_claim",
  channels: CHANNELS,
  textBlocks: Object.freeze([R04_PROPERTY_GUIDANCE_TEXT]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    const bag = bagSubject(context.boundFacts);
    const status = facts.text(bag, "air.bag_status");
    const what = status === "declared_lost" ? "declared lost" : status === "pilfered" ? "returned with items missing" : "damaged";
    const items: string[] = [];
    for (const n of lineOrdinals(context, R04_MAX_PROPERTY_ITEMS)) {
      const s = lineSubject(n);
      if (!facts.has(s, "air.property_item")) continue;
      const value = facts.has(s, "air.property_claimed_value") ? `, value ${formatMoney(facts.money(s, "air.property_claimed_value"))}` : "";
      const proof = facts.has(s, "air.property_proof") ? " (proof attached)" : "";
      items.push(`- ${facts.text(s, "air.property_item")}${value}${proof}`);
    }
    const body = fill(
      [
        "Baggage property claim: {{bag}}",
        "Reference: {{token}}",
        "",
        "My checked bag was {{what}}.{{arrival}} The affected items are:",
        "",
        "{{items}}",
        "",
        "The amount I am claiming is {{amount}}. I understand you will assess the items under your contract of carriage.",
        "",
        "{{guidance}}",
      ].join("\n"),
      {
        bag: bagLine(facts, bag),
        token: context.claimToken,
        what,
        arrival: arrivalLine(context, facts, bag),
        items: items.length > 0 ? items.join("\n") : "- (listed in the attached documents)",
        amount: formatMoney(context.amount),
        guidance: R04_PROPERTY_GUIDANCE_TEXT,
      },
    );
    return { recipient: null, body, requestedRemedy: `Compensation for the lost or damaged items, ${formatMoney(context.amount)}` };
  },
});

/** The path an R04 evaluation is for, from its bound-fact set (`snapshot_air.r04BoundFacts`). */
export function r04PathOf(boundFacts: readonly BoundFactValue[]): "a" | "b" | "c" {
  if (boundFacts.some((b) => b.key === "air.exemption_failed_recheck")) return "a";
  if (boundFacts.some((b) => b.key === "air.reimbursement_received")) return "b";
  return "c";
}

const BY_PATH = { a: r04BagFeeRefundRequest, b: r04ExpenseClaim, c: r04PropertyClaim } as const;

/** The registered R04 v1 template: the path's own letter. */
export const r04V1Letter: PacketTemplate = Object.freeze({
  ruleId: R04_V1_RULE_ID,
  version: R04_V1_VERSION,
  templateId: "r04_v1.letter",
  channels: CHANNELS,
  textBlocks: Object.freeze([...r04BagFeeRefundRequest.textBlocks, ...r04ExpenseClaim.textBlocks, ...r04PropertyClaim.textBlocks]),
  compose(context: PacketContext, facts: FactReader): PacketDraft {
    return BY_PATH[r04PathOf(context.boundFacts)].compose(context, facts);
  },
});

/** For `lib/packets/index.ts` (`PACKET_TEMPLATES`): only the dispatcher is registered. */
export const R04_V1_TEMPLATES: readonly PacketTemplate[] = Object.freeze([r04V1Letter]);
