/**
 * Types and plain-language copy for the opportunity components (M15; mission §14, §20; contract §5, §9).
 * Pure: no React, no clock, so every mapping is unit-testable. Prop types come from the server's own return
 * validators (`FunctionReturnType`) and `Doc<>`, never hand-written copies.
 */
import type { FunctionReturnType } from "convex/server";
import type { Infer } from "convex/values";
import type { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import type { cellView } from "../../../convex/facts";
import { isFactKey, type FactValue } from "../../../convex/lib/facts/catalog";
import { formatMinor } from "../../lib/money";

export type TransactionOpportunities = FunctionReturnType<typeof api.opportunities.forPurchase>;
export type OpportunityView = TransactionOpportunities["opportunities"][number];
export type CoverageRow = TransactionOpportunities["pathsNotChecked"][number];
export type Opportunity = Doc<"opportunities">;
export type Evaluation = Doc<"evaluations">;
export type Outcome = Evaluation["outcome"];
export type AuthorityClass = Opportunity["authorityClass"];
export type CashClass = Opportunity["cashClass"];
export type DeadlineResult = Evaluation["deadlines"][number];
export type MissingFact = Evaluation["missingFacts"][number];
export type NextAction = Evaluation["nextAction"];
export type AmountCalc = NonNullable<Evaluation["amount"]>;
/** One `facts.list` cell, as its `cellView` validator declares it (every status's optional fields in one shape). */
export type FactCell = Infer<typeof cellView>;
export type OpenCaseResult = FunctionReturnType<typeof api.opportunities.openCase>;
export type ScenarioId = Opportunity["scenarioId"];

/**
 * Scenario titles, as `convex/lib/rules/coverage.ts` `SCENARIO_TITLES` names them. Copied because that module pulls
 * the rule engine into the browser bundle; `model.test.ts` compares the two maps so they cannot drift.
 */
export const SCENARIO_TITLES: Readonly<Record<ScenarioId, string>> = {
  R01: "Retail price adjustment",
  R02: "Airline cancellation or significant-change refund",
  R03: "Credit-card billing error",
  R04: "Delayed, lost or damaged baggage",
  R05: "Late or missing online order",
  R06: "Card purchase protection",
  R07: "Card return protection",
  R08: "Card extended warranty",
  R09: "Involuntary denied boarding",
  R10: "Warranty defect",
  R11: "Product recall or service program",
  R12: "Card trip-delay or trip-cancellation benefit",
  R13: "Debit, ATM or bank transfer error",
  R14: "Airline extra service not provided",
  R15: "Airline commitment after a controllable disruption",
  R16: "Subscription renewal or cancellation",
  R17: "Surprise medical bill",
  R18: "Vehicle recall",
  R19: "Cancelled event or undelivered service",
  R20: "Hotel best-rate guarantee",
  R21: "Outage or missed-appointment credit",
  R22: "Regulator refund program",
  R23: "Class-action settlement",
  R24: "Unclaimed property",
  R25: "Small-business shipping or service guarantee",
};

/**
 * What kind of right this is. A promise is the business's own word, never "the law" (mission §14): only
 * `legal_entitlement` may say the law requires it.
 */
export const AUTHORITY_COPY: Readonly<Record<AuthorityClass, { label: string; description: string }>> = {
  legal_entitlement: {
    label: "Legal entitlement",
    description: "A law or regulation gives you this right when its conditions are met.",
  },
  contract_benefit: {
    label: "Contract benefit",
    description: "A benefit in a contract you hold, such as a card's benefit guide. Its terms decide it, not a law.",
  },
  merchant_promise: {
    label: "Merchant or carrier promise",
    description: "The business's own published policy. It is a promise the business made, not a law.",
  },
  settlement_or_program: {
    label: "Settlement or program",
    description: "A settlement or a refund program with its own rules and deadlines.",
  },
  goodwill: {
    label: "Goodwill",
    description: "Nothing requires it; the business may agree as a courtesy.",
  },
};

/** The outcome as a chip. `dot` is the chip's colour; the label always carries the meaning on its own. */
export const OUTCOME_COPY: Readonly<Record<Outcome, { label: string; dot: string }>> = {
  eligible: { label: "Eligible on these facts", dot: "bg-moss" },
  likely_eligible: { label: "Likely eligible", dot: "bg-moss" },
  possible_contract_benefit: { label: "Possible benefit", dot: "bg-gold" },
  needs_facts: { label: "Needs your answers", dot: "bg-gold" },
  manual_review: { label: "Needs a closer look", dot: "bg-gold" },
  not_eligible: { label: "Not eligible", dot: "bg-gray-300" },
  deadline_passed: { label: "Deadline passed", dot: "bg-rust" },
  source_unverified: { label: "Source not verified", dot: "bg-gray-300" },
  unsupported: { label: "Not supported", dot: "bg-gray-300" },
  not_yet_due: { label: "Not yet due", dot: "bg-gray-300" },
};

export const CASH_COPY: Readonly<Record<CashClass, { label: string; description: string }>> = {
  cash: { label: "Cash", description: "Money back to your card or account." },
  non_cash: { label: "Non-cash", description: "A voucher, points, a repair or a replacement: not money, and not added to cash totals." },
  provisional: { label: "Provisional credit", description: "A temporary credit that can still be reversed." },
};

/**
 * Whether the card shows an amount, and how it is worded. Only when the evaluation computed an estimate, and never
 * for a path that is not ripe (`not_yet_due` is never shown as owed, contract §5), ineligible, unsupported,
 * unverified, awaiting facts or under review. The amount is always "estimated", never guaranteed (§20).
 */
export function amountHeading(outcome: Outcome, amount: AmountCalc | null): string | null {
  if (amount === null) return null;
  switch (outcome) {
    case "eligible":
      return "Estimated recovery";
    case "likely_eligible":
      return "Estimated recovery, if the assumptions below hold";
    case "possible_contract_benefit":
      return "Possible benefit, if the contract terms cover it";
    case "deadline_passed":
      return "Estimated amount, but the deadline has passed";
    default:
      return null;
  }
}

/**
 * A catalogued fact key as words: "retail.purchase_date" → "purchase date". Used where server text names keys.
 * Only keys in the fact catalogue are rewritten, so a domain name or anything else with a dot is left alone.
 */
export function humanizeKeys(text: string): string {
  return text.replace(/\b[a-z]+\.([a-z]+(?:_[a-z]+)*)\b/g, (match, name: string) => (isFactKey(match) ? name.replace(/_/g, " ") : match));
}

/**
 * The explanation lines worth showing. The amount block states the estimate and its formula itself, so a line that
 * repeats the estimate is dropped; when no amount is shown (e.g. `not_yet_due`), dropping it also keeps an estimate
 * from appearing in words the card does not stand behind.
 */
export function explanationLines(evaluation: Pick<Evaluation, "explanation">): string[] {
  return evaluation.explanation.filter((line) => !/^Estimated /.test(line)).map(humanizeKeys);
}

const MUST_BE: Readonly<Record<DeadlineResult["mustBe"], string>> = {
  received: "must be received by",
  sent: "must be sent by",
  filed: "must be filed by",
  paid: "must be paid by",
  n_a: "ends",
};

export function mustBeCopy(mustBe: DeadlineResult["mustBe"]): string {
  return MUST_BE[mustBe];
}

/** A `YYYY-MM-DD` local date as a readable date, without shifting it through a time zone. */
export function formatLocalDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [, y, m, d] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12)).toLocaleDateString(undefined, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
}

/** An instant in the viewer's own time zone. */
export function formatInstant(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `advisoryActBy` is a local date (`YYYY-MM-DD`) for end-of-day rules, else an ISO instant. */
export function formatActBy(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatLocalDate(value);
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : formatInstant(ms);
}

/** When a deadline is due, as the user reads it: the local date (and zone) when the rule counts days, else the instant. */
export function formatDue(d: Pick<DeadlineResult, "dueAt" | "dueLocalDate" | "timeZone">): string | null {
  if (d.dueLocalDate !== undefined) return `${formatLocalDate(d.dueLocalDate)}${d.timeZone ? ` (${d.timeZone} time)` : ""}`;
  if (d.dueAt !== undefined) return formatInstant(d.dueAt);
  return null;
}

/** "3 days 4 hours left" from a positive remaining time; the display only, never a decision. */
export function remainingCopy(ms: number): string {
  if (ms <= 0) return "time is up by this device's clock";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${plural(days, "day")}${hours > 0 ? ` ${plural(hours, "hour")}` : ""} left`;
  if (hours > 0) return `${plural(hours, "hour")} ${plural(minutes % 60, "minute")} left`;
  return minutes > 0 ? `${plural(minutes, "minute")} left` : "less than a minute left";
}

const DOC_TYPE_WORDS: Readonly<Record<string, string>> = {
  policy_page: "the store's policy page",
  baggage_report: "a baggage report",
  order_confirmation: "the order confirmation",
  receipt: "the receipt",
  card_statement: "the card statement",
};

export function docTypeWords(docType: string): string {
  return DOC_TYPE_WORDS[docType] ?? docType.replace(/_/g, " ");
}

/** `wait` (not_yet_due): "Check again on <date>" or "after <event>" (contract §5). */
export function waitCopy(reevaluate: { at?: string; when?: string }): string {
  if (reevaluate.at && reevaluate.when) return `Check again on ${formatLocalDate(reevaluate.at)}, or after ${reevaluate.when}.`;
  if (reevaluate.at) return `Check again on ${formatLocalDate(reevaluate.at)}.`;
  if (reevaluate.when) return `Check again after ${reevaluate.when}.`;
  return "Check again later.";
}

const RELATION_COPY: Readonly<Record<Evaluation["overlap"][number]["relation"], string>> = {
  alternative: "Alternative for the same loss: only one of them is recovered",
  coordinated: "Coordinated with",
  primary_secondary: "Secondary to, after the primary path is settled:",
  complementary: "Covers a different part of the loss than",
  distinct_lines: "A separate expense line from",
};

export function relationCopy(relation: Evaluation["overlap"][number]["relation"]): string {
  return RELATION_COPY[relation];
}

/** Other opportunities on the same transaction that share a loss key: undeclared, they are alternatives (D145). */
export function sharedLossViews(view: OpportunityView, all: readonly OpportunityView[]): OpportunityView[] {
  const keys = new Set(view.opportunity.lossKeys);
  return all.filter(
    (other) => other.opportunity._id !== view.opportunity._id && other.opportunity.lossKeys.some((key) => keys.has(key)),
  );
}

/** A fact value in words. Money values are ISO minor units (`formatMinor`). */
export function describeFactValue(value: FactValue): string {
  switch (value.kind) {
    case "money":
      return formatMinor(value.amountMinor, value.currency);
    case "instant":
      return formatInstant(value.epochMs);
    case "local_date":
      return `${formatLocalDate(value.date)}${value.timeZone ? ` (${value.timeZone})` : ""}`;
    case "local_datetime":
      return `${value.dateTime.replace("T", " ")}${value.timeZone ? ` (${value.timeZone})` : ""}`;
    case "code":
      return value.code;
    case "text":
      return value.text;
    case "identifier":
      return value.value;
    case "bool":
      return value.value ? "Yes" : "No";
    case "count":
      return String(value.n);
    case "minutes":
      return `${value.minutes} min`;
    case "user_unknown":
      return "I don't know";
  }
}

