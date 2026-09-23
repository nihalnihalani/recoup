/**
 * R05 v1 — late or unshipped mail / Internet / telephone order (FTC Mail, Internet, or Telephone Order Merchandise
 * Rule, 16 CFR 435; spec docs/rules/R05-mail-internet-order.md, M09/M09b/M09c-approved; fixtures
 * docs/rules/fixtures/R05.json; M27 review fixes M21b under D234). Pure: no ctx, no clock (`now` is injected), no
 * randomness, no `lib/ai`.
 *
 * What it evaluates. One online/mail/phone order (subject `txn`, facts `lib/facts/keys_order.ts`) against the seller's
 * SHIPPING duty (435.1(e): shipment = placing the goods with the carrier; delivery dates are not this rule, §1):
 *   1. scope (§2, §6, §16.2): US order (buyer, ship-to and seller), placed online / by mail / by phone, not an excluded
 *      category, not C.O.D., a known seller. Known non-US → `unsupported`; in-store, excluded or C.O.D. → `not_eligible`.
 *      Country, category and payment terms are ASSUMPTION-class (DA-A-2, D212(a)): unknown, they are assumed to hold and
 *      add an assumption (so the best outcome is `likely_eligible`). A conflicting value is never assumed: it is asked.
 *      Channel and seller are required. Scope never depends on the time zone or the calendar.
 *   2. the applicable time T (§4, 435.2(a)(1)): the seller's stated time (calendar or business days — Mon–Fri without
 *      federal holidays, A2 — or a date), else 30 days, or 50 when the buyer applied to the seller for credit; counted in
 *      the buyer's local dates from the properly completed order, day 0 = the order day, day T inclusive (A1, A5).
 *   3. §8 case 6 (435.2(c)(4)): a seller that told the buyer it will not ship owes a prompt refund from that notice (A3).
 *   4. shipment by T → `not_eligible`; shipment after T is covered only by a valid delay option (§8 cases 2, 3), else
 *      `manual_review`. A cancellation sent under a valid option BEFORE the shipment → `manual_review`, never
 *      `not_eligible` (435.2(c)(1)); one sent after the shipment is ineffective. A partial shipment leaves the unshipped
 *      remainder to the not-shipped analysis (435.1(d) "unshipped merchandise"; fixture R05-01c).
 *   5. not shipped: the option logic of §8 decides whether the refund right has vested (→ `eligible`), is not ripe yet
 *      (→ `not_yet_due` with `reevaluate.at` = the day after the period, or `.when` + the user's own action for a
 *      consented indefinite delay, §16.5, D154), or waits on a missing fact (→ `needs_facts`). Vesting date = the day
 *      after the period (A3), the buyer's cancellation date, or the seller's notice date.
 *   6. the seller's prompt-refund deadline (§9, 435.1(b)): a COUNTERPARTY deadline, 7 working days after vesting,
 *      refund SENT; its anchor is the derived vesting date. A vesting date that rests on an unconfirmed input OR on an
 *      assumption that moves it (R05.A-credit, R05.A-renewed) gives `unknown_anchor` — never a firm date, overdue or
 *      `escalate` (D154(2) extended, D234). A seller-creditor refund (one billing cycle) is not computed.
 *   7. the estimate is `retail.order_total` (the amount tendered incl. tax + shipping, FTC-MITOR-G6), never an item
 *      total (contract wave-2 note). Refunds already received are ledger credits on the case (contract §3.2/§3.4, D234
 *      (16)); the estimate stays the order total.
 *
 * Outcomes come only from `deriveOutcome`. `eligible` needs every decisive fact confirmed (D147(2)): a fact used only as
 * an extracted candidate caps the outcome at `likely_eligible`. A negative, not-yet-due or review verdict never rests on
 * a candidate (contract §4 rule 3, D212(b), D234(1)) — alone, inside the 5c same-answer branch, or across time zones:
 * the candidate is asked instead. Conflicts follow D152/D154 (5a/5b/5c) by candidate testing; 5c keeps only a positive
 * answer. A confirmed "not shipped" against a confirmed or observed carrier scan is 5a; against a candidate scan the
 * confirmation stands and the scan is shown as information (D234(14)).
 *
 * Time zone (A5). With `order.ship_to_time_zone` unknown the evaluation runs in every committed US zone: the same
 * outcome and amount everywhere → that answer, with the counterparty timer waiting for the latest-ending zone (D234
 * (8)); otherwise the zone is asked (`needs_facts`), or reviewed when two confirmed zones disagree. No zone is guessed.
 *
 * Result text (D234, M27 R05-01). Timing and vesting text appears only where the rule applies: an excluded,
 * out-of-scope or unverified result names its reason and draws no conclusion under Part 435.
 *
 * Status. `lifecycle: "researched"` is informative only; the manifest and the lead's activation entry decide.
 */
import type { Id } from "../../_generated/dataModel";
import { formatMinor, isTwoDecimalCurrency } from "../money";
import { alternatives, knownCell, withOverride, type Cell, type CellLookup, type ConflictKind } from "../facts/resolve";
import type { KnownValue } from "../facts/catalog";
import { formatFactValue } from "../facts/values";
import type { CellRow } from "../facts/snapshot_retail";
import { buildOrderSnapshot, orderBoundFacts, txnCell, type OrderSnapshot } from "../facts/snapshot_order";
import { computeDeadline } from "../deadlines/engine";
import { addCalendarDays, BeyondCalendarError, nthBusinessDay, nthCalendarDay } from "../deadlines/calendar";
import { localParts, startOfLocalDay, US_ZONES, zoneRule, type ZoneRule } from "../deadlines/usZones";
import { addMissing, evaluateConditions } from "./conditions";
import { candidateCombinations, deriveOutcome, notYetDueAction, sameAnswer, sourceStale, withSameAnswer } from "./outcome";
import {
  emptyFlags,
  isApprovable,
  lookupFrom,
  unresolvedReason,
  type AmountCalc,
  type Assumption,
  type CaseContext,
  type ComputedCondition,
  type ConditionNode,
  type ConditionResult,
  type ConflictFlag,
  type DeadlineResult,
  type DeadlineSpec,
  type Dimensions,
  type EngineCell,
  type EvaluationInput,
  type EvaluationResult,
  type FactRef,
  type Flags,
  type MissingFact,
  type MissingReason,
  type NextAction,
  type Outcome,
  type RulePack,
  type RuleSourceMeta,
  type SourceRef,
  type Tri,
} from "./types";

export const R05_V1_RULE_ID = "R05.mitor_shipment.us_ftc";
export const R05_V1_VERSION = 1;
export const R05_REMEDY_KEY = "order_refund";
/** R03's remedy key, for the declared alternative (`r05_late_order_v1.test.ts` checks it against the R03 pack). */
export const R05_R03_REMEDY_KEY = "billing_error_credit";
export const R05_V1_REFUND_DEADLINE_ID = "r05.v1.prompt_refund";
export const R05_V1_TIMING_ID = "r05.v1.timing";

/**
 * R05 v1 parameters. Every number cites the passage it comes from and the words that state it
 * (`R05_V1_PARAM_SOURCES`); no legal number appears in the evaluation code without one (README "From spec to evaluator").
 */
export interface R05Params {
  /** No stated time: 30 days after receipt of a properly completed order. */
  defaultShipDays: number;
  /** No stated time and the buyer applied to the seller for credit: 50 days. */
  creditApplicationShipDays: number;
  /** A definite revised date at most this many days after T: silence is consent to the delay. */
  deemedConsentMaxDaysAfterT: number;
  /** A later or indefinite revised date: deemed cancelled unless shipped, or expressly consented to, within this many days of T. */
  autoCancelDaysAfterT: number;
  /** Prompt refund: sent within this many working days of vesting. */
  promptRefundWorkingDays: number;
  /** README rule 3: past this many days after the last verification the pack is `source_unverified`. */
  refreshWindowDays: number;
  /** README rule 5: the rule version in force from this date (an order before it is a known effective-date mismatch). */
  effectiveFrom: string;
}

export const R05_V1_PARAMS: R05Params = Object.freeze({
  defaultShipDays: 30,
  creditApplicationShipDays: 50,
  deemedConsentMaxDaysAfterT: 30,
  autoCancelDaysAfterT: 30,
  promptRefundWorkingDays: 7,
  refreshWindowDays: 180,
  effectiveFrom: "2014-12-08",
});

/**
 * The passage each parameter comes from and the words in it that state the value. `P-…` ids are spec §13 passages;
 * "Refresh policy" is the spec header row (README rule 3: "R05 180"); `FR-2014-22092` is the DATES line captured in
 * `sources/federal-register-notices.txt`. `r05_late_order_v1.test.ts` resolves each id to its text and finds the quote.
 */
export const R05_V1_PARAM_SOURCES: Readonly<Record<keyof R05Params, { passages: readonly string[]; quote: string }>> = Object.freeze({
  defaultShipDays: { passages: ["P-435.2(a)(1)"], quote: "within thirty (30) days after receipt of a properly completed order" },
  creditApplicationShipDays: { passages: ["P-435.2(a)(1)"], quote: "the seller shall have fifty (50) days" },
  deemedConsentMaxDaysAfterT: { passages: ["P-435.2(b)(1)(ii)"], quote: "thirty (30) days or less later than the applicable time" },
  autoCancelDaysAfterT: { passages: ["P-435.2(b)(1)(iii)", "P-435.2(c)"], quote: "within thirty (30) days of the applicable time" },
  promptRefundWorkingDays: { passages: ["P-435.1(b)"], quote: "within seven (7) working days" },
  refreshWindowDays: { passages: ["Refresh policy"], quote: "180 days" },
  effectiveFrom: { passages: ["FR-2014-22092"], quote: "effective on December 8, 2014" },
});

const ECFR_435 = "https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-435";
const FTC_GUIDE = "https://www.ftc.gov/business-guidance/resources/business-guide-ftcs-mail-internet-or-telephone-order-merchandise-rule";

const reg = (passageId: string): RuleSourceMeta => ({
  sourceId: "ecfr-16cfr435", passageId, url: ECFR_435, effective: R05_V1_PARAMS.effectiveFrom, refreshWindowDays: R05_V1_PARAMS.refreshWindowDays,
});
const guide = (passageId: string): RuleSourceMeta => ({ sourceId: "federal-web-excerpts", passageId, url: FTC_GUIDE, effective: "unknown" });

/** The passages R05 v1 relies on (spec §13 and the FTC guide excerpts). The regulation carries the refresh window. */
export const R05_V1_SOURCES: readonly RuleSourceMeta[] = Object.freeze([
  reg("P-435.1(b)"), reg("P-435.1(e)"), reg("P-435.2(a)(1)"), reg("P-435.2(b)(1)"), reg("P-435.2(b)(1)(ii)"),
  reg("P-435.2(b)(1)(iii)"), reg("P-435.2(c)"), reg("P-435.3(a)"),
  guide("FTC-MITOR-G2"), guide("FTC-MITOR-G3"), guide("FTC-MITOR-G5"), guide("FTC-MITOR-G6"), guide("FTC-MITOR-G7"),
]);

const TXN = "txn";
const DAY_ONE = 1;

/** The keys whose conflicts are candidate-tested (D152): every fact the evaluation decides on. */
const DECISIVE_KEYS = [
  "order.channel", "order.seller_name", "order.buyer_country", "order.ship_to_country", "order.seller_country",
  "order.merchandise_category", "order.payment_terms", "order.properly_completed_at", "order.ship_time_kind",
  "order.ship_time_days", "order.ship_by_date", "order.shipped", "order.shipped_at", "order.partially_shipped",
  "order.delay_notice_received", "order.delay_notice_received_at", "order.delay_revised_ship_kind",
  "order.delay_revised_ship_date", "order.delay_notice_offers_cancel", "order.buyer_response", "order.buyer_response_at",
  "order.seller_cancelled_at", "retail.order_total",
] as const;

/**
 * One spec fact split over several keys (keys_order.ts). Candidate testing evaluates a reading "as if confirmed", so
 * when one member of a group is a tested conflict alternative, the group's other candidate members are read as
 * confirmed too (they are the rest of the same reading).
 */
const COMPOSITES: readonly (readonly string[])[] = [
  ["order.ship_time_kind", "order.ship_time_days", "order.ship_by_date"],
  ["order.shipped", "order.shipped_at"],
  ["order.delay_notice_received", "order.delay_notice_received_at", "order.delay_revised_ship_kind", "order.delay_revised_ship_date", "order.delay_notice_offers_cancel"],
  ["order.buyer_response", "order.buyer_response_at"],
];

const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  "serial_subscription_after_first", "seeds_or_growing_plants", "service", "negative_option_plan",
]);
const MAIL_INTERNET_PHONE: ReadonlySet<string> = new Set(["internet", "mail", "telephone"]);
const CONSUMER_CREDIT: ReadonlySet<string> = new Set(["consumer_credit_card", "consumer_open_end_other"]);

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** A copy of `flags` without the named optional keys (never an explicit `undefined`: results are stored). */
function without(flags: Flags, ...keys: ("notYetDue" | "manualReviewReason")[]): Flags {
  const copy: Flags = { ...flags };
  for (const k of keys) delete copy[k];
  return copy;
}

function usable(cell: Cell): KnownValue | null {
  return cell.status === "candidate" || cell.known ? cell.value : null;
}
const refOf = (cell: Pick<Cell, "subjectKey" | "key">): FactRef => ({ subjectKey: cell.subjectKey, key: cell.key });
const codeOf = (v: KnownValue | null): string | null => (v && v.kind === "code" ? v.code : null);
const boolOf = (v: KnownValue | null): boolean | null => (v && v.kind === "bool" ? v.value : null);
const instantOf = (v: KnownValue | null): number | null => (v && v.kind === "instant" ? v.epochMs : null);
const countOf = (v: KnownValue | null): number | null => (v && v.kind === "count" ? v.n : null);
const dateOf = (v: KnownValue | null): string | null => (v && v.kind === "local_date" ? v.date : null);

// ---------------------------------------------------------------------------
// Scope (§2, §6, §16.2): zone- and calendar-independent
// ---------------------------------------------------------------------------

interface Leaf {
  cond: ComputedCondition;
  /** Assumption-class facts that could not be read and were assumed to hold. */
  assumed: Assumption | null;
  /** Shown as the result's reason when this leaf fails from known facts (M27 R05-01). */
  failReason: string | null;
}

function computed(
  id: string, label: string, kind: ComputedCondition["kind"], result: Tri, facts: readonly Cell[],
  o: { unknown?: readonly { cell: Cell; reason: MissingReason }[]; candidates?: readonly Cell[]; note?: string; passage?: string; neededFor?: string[] } = {},
): ComputedCondition {
  return {
    op: "computed", id, label, kind, result, facts: facts.map(refOf),
    ...(result === "unknown" && o.unknown ? { unknownFacts: o.unknown.map((u) => ({ fact: refOf(u.cell), reason: u.reason })) } : {}),
    ...(o.candidates && o.candidates.length > 0 ? { candidateFacts: o.candidates.map(refOf) } : {}),
    ...(o.note !== undefined ? { note: o.note } : {}),
    ...(o.passage !== undefined ? { sourcePassageId: o.passage } : {}),
    ...(o.neededFor !== undefined ? { neededFor: o.neededFor } : {}),
  };
}

/**
 * A scope leaf. `bad(code)` names a disqualifying value. A KNOWN bad value fails; a candidate bad value is asked, never
 * failed on (rule 3: from known facts only). A conflicting value is asked, never assumed (M27 R05-10). Required facts
 * that cannot be read are unknown; assumption-class ones are assumed to hold (DA-A-2).
 */
function scopeLeaf(
  id: string, label: string, kind: ComputedCondition["kind"], cells: readonly Cell[], cls: "required" | "assumption",
  bad: (v: KnownValue) => boolean, passage: string, assumption: Assumption | null, failReason: string | null,
): Leaf {
  const knownBad = cells.filter((c) => c.known && bad(c.value));
  if (knownBad.length > 0) return { cond: computed(id, label, kind, "fail", cells, { passage }), assumed: null, failReason };
  const candidateBad = cells.filter((c) => c.status === "candidate" && bad(c.value));
  const conflicting = cells.filter((c) => c.status === "conflicting");
  if (candidateBad.length > 0 || conflicting.length > 0) {
    const unknown = [
      ...candidateBad.map((cell) => ({ cell, reason: "candidate_unconfirmed" as const })),
      ...conflicting.map((cell) => ({ cell, reason: "conflicting" as const })),
    ];
    return { cond: computed(id, label, kind, "unknown", cells, { unknown, passage }), assumed: null, failReason: null };
  }
  const unreadable = cells.filter((c) => usable(c) === null);
  const candidates = cells.filter((c) => c.status === "candidate");
  if (unreadable.length > 0 && cls === "required") {
    return { cond: computed(id, label, kind, "unknown", cells, { unknown: unreadable.map((cell) => ({ cell, reason: unresolvedReason(cell) })), candidates, passage }), assumed: null, failReason: null };
  }
  const assumed = unreadable.length > 0 ? assumption : null;
  return {
    cond: computed(id, label, kind, "pass", cells, { candidates, passage, ...(assumed ? { note: `assumed (${label})` } : {}) }),
    assumed,
    failReason: null,
  };
}

const A_US: Assumption = {
  id: "R05.A-us",
  text: "Recoup assumes this is a US order: you, the delivery address and the seller are in the United States.",
  changesOutcomeIf: "you, the delivery address or the seller is outside the United States (Recoup does not check this rule then)",
};
const A_CATEGORY: Assumption = {
  id: "R05.A-category",
  text: "Recoup assumes you ordered ordinary merchandise (not seeds or plants, a later issue of a subscription, a service, or a negative-option plan).",
  changesOutcomeIf: "the order is one the rule excludes",
};
const A_NOT_COD: Assumption = {
  id: "R05.A-not-cod",
  text: "Recoup assumes the order was not cash on delivery.",
  changesOutcomeIf: "the order was cash on delivery (the rule does not cover C.O.D. orders)",
};
const A_EFFECTIVE: Assumption = {
  id: "R05.A-effective",
  text: "Recoup assumes the order was placed after 2014-12-08, when the current version of the rule took effect.",
  changesOutcomeIf: "the order date from your documents is right and it predates the current rule",
};

interface Scope {
  leaves: Leaf[];
  unsupportedReason: string | null;
}

function scopeOf(s: OrderSnapshot): Scope {
  const cell = (key: Parameters<typeof txnCell>[1]) => txnCell(s, key) as Cell;
  const countries = [cell("order.buyer_country"), cell("order.ship_to_country"), cell("order.seller_country")];
  const isForeign = (v: KnownValue) => v.kind === "code" && v.code !== "US";
  const jurisdiction = scopeLeaf("r05.v1.us_order", "A US order (buyer, delivery address and seller)", "applicability", countries, "assumption", isForeign, "P-435.2(a)(1)", A_US, null);
  const foreign = countries.flatMap((c) => (c.known && isForeign(c.value) ? [{ key: c.key, value: c.value }] : []));
  const unsupportedReason = foreign.length > 0
    ? `Recoup checks the FTC shipping rule for US orders only (${foreign.map((c) => `${c.key.replace("order.", "").replace(/_/g, " ")} ${formatFactValue(c.value)}`).join(", ")}), so it does not check this order under that rule.`
    : null;
  const channel = scopeLeaf("r05.v1.channel", "Ordered online, by mail or by phone", "applicability", [cell("order.channel")], "required",
    (v) => v.kind === "code" && !MAIL_INTERNET_PHONE.has(v.code), "P-435.2(a)(1)", null,
    "The FTC shipping rule covers orders placed online, by mail or by phone; an order placed in a store is not covered (435.2(a)(1)).");
  const category = scopeLeaf("r05.v1.category", "Merchandise the rule covers (not seeds or plants, a later subscription issue, a service or a negative-option plan)", "exclusion",
    [cell("order.merchandise_category")], "assumption", (v) => v.kind === "code" && EXCLUDED_CATEGORIES.has(v.code), "P-435.3(a)", A_CATEGORY,
    "The FTC shipping rule does not cover this kind of order: seeds and growing plants, later issues of a subscription, services, or negative-option plans (435.3(a)).");
  const cod = scopeLeaf("r05.v1.not_cod", "Not a cash-on-delivery order", "exclusion", [cell("order.payment_terms")], "assumption",
    (v) => v.kind === "code" && v.code === "cod", "P-435.3(a)", A_NOT_COD,
    "The FTC shipping rule does not cover C.O.D. (cash on delivery) orders (435.3(a)(3)).");
  const seller = scopeLeaf("r05.v1.seller", "The seller is known", "applicability", [cell("order.seller_name")], "required", () => false, "P-435.2(a)(1)", null, null);
  return { leaves: [jurisdiction, channel, category, cod, seller], unsupportedReason };
}

// ---------------------------------------------------------------------------
// The applicable time and the option logic (spec §4, §8) for one fact assignment in one zone
// ---------------------------------------------------------------------------

type Verdict =
  | { kind: "vested"; vestDate: string | null; text: string; passages: string[] }
  | { kind: "not_yet_due"; at?: string; when?: string; userAction?: NextAction; text: string; passages: string[] }
  | { kind: "on_time"; text: string; passages: string[] }
  | { kind: "manual"; text: string; passages: string[] }
  | { kind: "unknown"; cells: Cell[] };

interface Timing {
  verdict: Verdict;
  /** Every cell the verdict was read from (candidates among them cap or block, see `core`). */
  used: Cell[];
  /** The last day of the applicable time, when computed. */
  T: string | null;
  tText: string | null;
  assumptions: Assumption[];
}

const A_CREDIT: Assumption = {
  id: "R05.A-credit",
  text: "Recoup assumes you did not apply to the seller for credit to pay for this order (that would give the seller 50 days instead of 30).",
  changesOutcomeIf: "you applied to the seller for credit to pay for the order",
};
const A_RENEWED: Assumption = {
  id: "R05.A-renewed",
  text: "Recoup assumes you did not expressly agree to a further delay after the revised ship date passed.",
  changesOutcomeIf: "you agreed to a new delay after the revised ship date",
};
const A_CONSENT_TIMING: Assumption = {
  id: "R05.A-consent-timing",
  text: "Recoup assumes you agreed to the delay within 30 days of the original shipping time.",
  changesOutcomeIf: "you agreed to the delay more than 30 days after the original shipping time (the order was then already cancelled)",
};
/** Assumptions that move the vesting date toward the buyer: a timer resting on one is never firm (D234, M27 R05-05). */
const DATE_MOVING_ASSUMPTIONS: ReadonlySet<string> = new Set([A_CREDIT.id, A_RENEWED.id]);

function endOfLocalDay(zone: ZoneRule, date: string): number {
  return startOfLocalDay(zone, addCalendarDays(date, DAY_ONE)) - 1;
}

function timing(s: OrderSnapshot, p: R05Params, now: number, zone: ZoneRule): Timing {
  const used: Cell[] = [];
  const assumptions: Assumption[] = [];
  const read = (key: Parameters<typeof txnCell>[1]): { cell: Cell; v: KnownValue | null } => {
    const cell = txnCell(s, key) as Cell;
    const v = usable(cell);
    if (v !== null && !used.includes(cell)) used.push(cell);
    return { cell, v };
  };
  /** Looks without making the verdict depend on the value. */
  const peek = (key: Parameters<typeof txnCell>[1]): KnownValue | null => usable(txnCell(s, key) as Cell);
  const out = (verdict: Verdict, T: string | null = null, tText: string | null = null): Timing => ({ verdict, used, T, tText, assumptions });
  const unknown = (cells: Cell[], T: string | null = null, tText: string | null = null) => out({ kind: "unknown", cells }, T, tText);
  const localOf = (ms: number) => localParts(zone, ms).date;

  // §8 case 6 (435.2(c)(4); A3): the seller told the buyer it will not ship → a prompt refund is due from that notice.
  const unshippedRemains = boolOf(peek("order.shipped")) !== true || boolOf(peek("order.partially_shipped")) === true;
  if (instantOf(peek("order.seller_cancelled_at")) !== null && unshippedRemains) {
    const notice = read("order.seller_cancelled_at");
    return out({
      kind: "vested", vestDate: localOf(instantOf(notice.v)!),
      text: "The seller told you it will not ship the order, so it must treat the order as cancelled and refund you promptly (435.2(c)(4)).",
      passages: ["P-435.2(c)", "P-435.1(b)"],
    });
  }

  // 1. The applicable time T (§4).
  const order = read("order.properly_completed_at");
  const kind = read("order.ship_time_kind");
  const tMissing: Cell[] = [];
  if (instantOf(order.v) === null) tMissing.push(order.cell);
  let rep: { unit: "calendar_days" | "business_days"; n: number; stated: boolean } | { date: string } | null = null;
  const kindCode = codeOf(kind.v);
  if (kindCode === null) tMissing.push(kind.cell);
  else if (kindCode === "none_stated") {
    const terms = read("order.payment_terms");
    const t = codeOf(terms.v);
    if (t === null) assumptions.push(A_CREDIT);
    rep = { unit: "calendar_days", n: t === "seller_credit_application" ? p.creditApplicationShipDays : p.defaultShipDays, stated: false };
  } else if (kindCode === "calendar_days" || kindCode === "business_days") {
    const days = read("order.ship_time_days");
    const n = countOf(days.v);
    if (n === null) tMissing.push(days.cell);
    else rep = { unit: kindCode, n, stated: true };
  } else {
    const byDate = read("order.ship_by_date");
    const d = dateOf(byDate.v);
    if (d === null) tMissing.push(byDate.cell);
    else rep = { date: d };
  }
  const shipped = read("order.shipped");
  if (tMissing.length > 0 || rep === null) {
    return unknown(boolOf(shipped.v) === null ? [...tMissing, shipped.cell] : tMissing);
  }
  const orderLocal = localOf(instantOf(order.v)!);
  let T: string;
  let tText: string;
  if ("date" in rep) {
    T = rep.date;
    tText = `the seller's stated ship-by date ${T}`;
  } else if (rep.n === 0) {
    T = orderLocal;
    tText = `the seller's stated time (same day) from the order on ${orderLocal}`;
  } else if (rep.unit === "calendar_days") {
    T = nthCalendarDay(orderLocal, rep.n, false);
    tText = rep.stated
      ? `${rep.n} days (the seller's stated time) after the order on ${orderLocal}`
      : `${rep.n} days after the properly completed order on ${orderLocal} (no shipping time was stated)`;
  } else {
    T = nthBusinessDay(orderLocal, rep.n, "us_federal", false);
    tText = `${rep.n} business days (the seller's stated time; weekends and federal holidays skipped) after the order on ${orderLocal}`;
  }
  const tEnd = endOfLocalDay(zone, T);
  const t30 = addCalendarDays(T, p.autoCancelDaysAfterT);
  const deemedLimit = addCalendarDays(T, p.deemedConsentMaxDaysAfterT);

  // 2. The first delay-option notice (§8), read lazily: only the facts on the path are required.
  type Notice =
    | { state: "unknown"; cells: Cell[] }
    | { state: "none"; why: string }
    | { state: "valid"; R: string | "indefinite"; response: string; responseAt: number | null; responseAtCell: Cell | null };
  const notice = (): Notice => {
    const received = read("order.delay_notice_received");
    const r = boolOf(received.v);
    if (r === null) return { state: "unknown", cells: [received.cell] };
    if (!r) return { state: "none", why: `no delay-option notice arrived by ${T}` };
    const at = read("order.delay_notice_received_at");
    const atMs = instantOf(at.v);
    if (atMs === null) return { state: "unknown", cells: [at.cell] };
    if (atMs > tEnd) return { state: "none", why: `the delay notice arrived after the shipping time ended (${localOf(atMs)}), too late to be a valid first offer (435.2(b)(1))` };
    const offers = read("order.delay_notice_offers_cancel");
    const o = boolOf(offers.v);
    if (o === null) return { state: "unknown", cells: [offers.cell] };
    if (!o) return { state: "none", why: "the delay notice did not offer to cancel with a prompt refund, so it was not the option the rule requires (435.2(b)(1))" };
    const revised = read("order.delay_revised_ship_kind");
    const rk = codeOf(revised.v);
    if (rk === null) return { state: "unknown", cells: [revised.cell] };
    let R: string | "indefinite" = "indefinite";
    if (rk === "date") {
      const rd = read("order.delay_revised_ship_date");
      const d = dateOf(rd.v);
      if (d === null) return { state: "unknown", cells: [rd.cell] };
      R = d < T ? T : d;
    }
    const resp = read("order.buyer_response");
    const rc = codeOf(resp.v);
    if (rc === null) return { state: "unknown", cells: [resp.cell] };
    if (rc === "no_response") return { state: "valid", R, response: rc, responseAt: null, responseAtCell: null };
    const respAt = read("order.buyer_response_at");
    return { state: "valid", R, response: rc, responseAt: instantOf(respAt.v), responseAtCell: respAt.cell };
  };
  /** Case 2 (definite R ≤ T + 30) vs case 3 (later or indefinite). */
  const deemedConsent = (R: string | "indefinite") => R !== "indefinite" && R <= deemedLimit;
  /** Express consent counts under case 3 only within 30 days of T; an unknown time is assumed timely. */
  const timelyConsent = (n: Extract<Notice, { state: "valid" }>): boolean => {
    if (n.response !== "consented") return false;
    if (n.responseAt === null) {
      assumptions.push(A_CONSENT_TIMING);
      return true;
    }
    return n.responseAt <= endOfLocalDay(zone, t30);
  };
  const cancelled = (n: Extract<Notice, { state: "valid" }>): Verdict => ({
    kind: "vested",
    vestDate: n.responseAt === null ? null : localOf(n.responseAt),
    text: "You cancelled the unshipped order in answer to the seller's delay notice, so the seller owes a prompt refund (435.2(c)(1)).",
    passages: ["P-435.2(c)", "P-435.1(b)"],
  });

  // 3. Shipped (the whole order): on time, covered by a valid delay option, or late (§8, §16.4).
  const shippedValue = boolOf(shipped.v);
  if (shippedValue === null) return unknown([shipped.cell], T, tText);
  const partial = shippedValue ? boolOf(read("order.partially_shipped").v) === true : false;
  if (shippedValue && !partial) {
    const at = read("order.shipped_at");
    const atMs = instantOf(at.v);
    if (atMs === null) return unknown([at.cell], T, tText);
    const shippedLocal = localOf(atMs);
    // A cancellation under a valid option: sent before the shipment it binds the seller (435.2(c)(1), M27 R05-08);
    // sent after it, it is ineffective.
    let cancelledFirst = false;
    if (boolOf(peek("order.delay_notice_received")) === true && codeOf(peek("order.buyer_response")) === "cancelled") {
      const n = notice();
      if (n.state === "unknown") return unknown(n.cells, T, tText);
      if (n.state === "valid" && n.response === "cancelled") {
        if (n.responseAt === null) return unknown([n.responseAtCell ?? txnCell(s, "order.buyer_response_at") as Cell], T, tText);
        cancelledFirst = n.responseAt <= atMs;
      }
    }
    if (cancelledFirst) {
      return out({
        kind: "manual",
        text: `You cancelled the order under the seller's delay offer before it shipped on ${shippedLocal}. The rule required the seller to treat the order as cancelled and refund you (435.2(c)(1)); what follows once it shipped anyway, and when the seller received your cancellation, needs review.`,
        passages: ["P-435.2(c)", "P-435.2(b)(1)"],
      }, T, tText);
    }
    if (atMs <= tEnd) {
      return out({ kind: "on_time", text: `The seller shipped on ${shippedLocal}, within the applicable time (by ${T}); a missed delivery date is not this rule.`, passages: ["P-435.1(e)", "P-435.2(a)(1)"] }, T, tText);
    }
    const n = notice();
    if (n.state === "unknown") return unknown(n.cells, T, tText);
    if (n.state === "valid") {
      // A cancellation after the shipment is ineffective: the delay the option allowed still covers the shipment.
      if (deemedConsent(n.R)) {
        if (atMs <= endOfLocalDay(zone, n.R as string)) {
          return out({ kind: "on_time", text: `The seller offered a delay to ${n.R as string} before the shipping time ended and shipped on ${shippedLocal}; you are deemed to have agreed (435.2(b)(1)(ii)).`, passages: ["P-435.2(b)(1)(ii)"] }, T, tText);
        }
      } else {
        const consent = timelyConsent(n);
        if (atMs <= endOfLocalDay(zone, t30) || (consent && (n.R === "indefinite" || atMs <= endOfLocalDay(zone, n.R)))) {
          return out({ kind: "on_time", text: `The seller shipped on ${shippedLocal}, within the delay the rule allowed (435.2(b)(1)(iii)).`, passages: ["P-435.2(b)(1)(iii)"] }, T, tText);
        }
      }
    }
    return out({
      kind: "manual",
      text: `The order shipped on ${shippedLocal}, after the applicable time (${T}) without a delay you agreed to. The rule required the seller to treat the order as cancelled (435.2(c)), but its text does not say what follows once a late shipment is accepted.`,
      passages: ["P-435.2(b)(1)", "P-435.2(c)"],
    }, T, tText);
  }

  // 4. Not shipped, or the unshipped remainder of a partial shipment (435.1(d) "unshipped merchandise").
  const day1 = (d: string) => addCalendarDays(d, DAY_ONE);
  const what = partial ? "The unshipped part of the order" : "The order";
  if (now <= tEnd) {
    // A cancellation under an early delay option vests at once (435.2(c)(1)); nothing else is ripe before T. An unknown
    // step of that option is asked, never read as "not yet due" (D212(b), M27 R05-16).
    const early = boolOf(peek("order.delay_notice_received")) === true && codeOf(peek("order.buyer_response")) === "cancelled";
    if (early) {
      const n = notice();
      if (n.state === "unknown") return unknown(n.cells, T, tText);
      if (n.state === "valid" && n.response === "cancelled") return out(cancelled(n), T, tText);
    }
    return out({
      kind: "not_yet_due", at: day1(T),
      text: `The seller still has until the end of ${T} to ship or to offer you a delay.`, passages: ["P-435.2(a)(1)"],
    }, T, tText);
  }
  const n = notice();
  if (n.state === "unknown") return unknown(n.cells, T, tText);
  if (n.state === "none") {
    return out({
      kind: "vested", vestDate: day1(T),
      text: `${what} did not ship by ${T} and ${n.why}: the seller had to treat it as cancelled and refund you (435.2(c)(5)).`,
      passages: ["P-435.2(c)", "P-435.2(b)(1)"],
    }, T, tText);
  }
  if (n.response === "cancelled") return out(cancelled(n), T, tText);
  if (deemedConsent(n.R)) {
    const R = n.R as string;
    if (now <= endOfLocalDay(zone, R)) {
      return out({ kind: "not_yet_due", at: day1(R), text: `The seller offered a delay to ${R}; staying silent means you agreed to wait until then (435.2(b)(1)(ii)).`, passages: ["P-435.2(b)(1)(ii)"] }, T, tText);
    }
    assumptions.push(A_RENEWED);
    return out({ kind: "vested", vestDate: day1(R), text: `${what} did not ship by the revised date ${R}, so it is cancelled and a prompt refund is due (435.2(c)(3)).`, passages: ["P-435.2(b)(1)(ii)", "P-435.2(c)"] }, T, tText);
  }
  if (timelyConsent(n)) {
    if (n.R === "indefinite") {
      return out({
        kind: "not_yet_due",
        when: "buyer cancels before shipment (continuing right to cancel, 435.2(b)(1)(iii)(B))",
        userAction: { kind: "answer_questions", keys: [{ subjectKey: TXN, key: "order.buyer_response" }] },
        text: "You agreed to wait without a new ship date. You can cancel before shipment for a prompt refund (continuing right to cancel); tell Recoup when you have.",
        passages: ["P-435.2(b)(1)(iii)"],
      }, T, tText);
    }
    const R = n.R;
    if (now <= endOfLocalDay(zone, R)) {
      return out({ kind: "not_yet_due", at: day1(R), text: `You agreed to wait until ${R}.`, passages: ["P-435.2(b)(1)(iii)"] }, T, tText);
    }
    assumptions.push(A_RENEWED);
    return out({ kind: "vested", vestDate: day1(R), text: `${what} did not ship by the date you agreed to (${R}), so a prompt refund is due (435.2(c)(3)).`, passages: ["P-435.2(b)(1)(iii)", "P-435.2(c)"] }, T, tText);
  }
  if (now <= endOfLocalDay(zone, t30)) {
    return out({
      kind: "not_yet_due", at: day1(t30),
      text: `The seller could not give a date within 30 days of ${T}. Unless it ships by ${t30} or you agree to the delay, the order is cancelled automatically.`,
      passages: ["P-435.2(b)(1)(iii)", "P-435.2(c)"],
    }, T, tText);
  }
  return out({
    kind: "vested", vestDate: day1(t30),
    text: `The seller neither shipped within 30 days of ${T} (by ${t30}) nor had your consent to the delay, so the order was cancelled automatically (435.2(c)(2)).`,
    passages: ["P-435.2(b)(1)(iii)", "P-435.2(c)"],
  }, T, tText);
}

// ---------------------------------------------------------------------------
// The core evaluation of one fact assignment in one zone
// ---------------------------------------------------------------------------

interface Core {
  dims: Omit<Dimensions, "readyForApproval">;
  flags: Flags;
  conditions: ConditionResult[];
  missing: MissingFact[];
  unconfirmed: MissingFact[];
  assumptions: Assumption[];
  amount: AmountCalc | null;
  /** The vesting date, and whether a firm timer may rest on it (not when it rests on a candidate or a date-moving assumption). */
  vest: { date: string | null; fromCandidate: boolean } | null;
  /** The applicable-time, verdict and vesting lines: shown only where the rule applies (M27 R05-01). */
  timingLines: string[];
  /** Other result text (amount review, an unconfirmed carrier scan). */
  notes: string[];
  /** The reason text of a scope leaf that failed from known facts. */
  scopeReason: string | null;
  verdictKind: Verdict["kind"];
  passages: string[];
  sellerCreditor: boolean;
}

type BaseFlags = Pick<Flags, "sourceStale" | "effectiveDateMismatch">;

function core(s: OrderSnapshot, p: R05Params, now: number, zone: ZoneRule, base: BaseFlags): Core {
  const flags: Flags = { ...emptyFlags(), ...base };
  const notes: string[] = [];
  const cell = (key: Parameters<typeof txnCell>[1]) => txnCell(s, key) as Cell;

  const scope = scopeOf(s);
  if (scope.unsupportedReason) flags.unsupportedReason = scope.unsupportedReason;

  // Timing (§4, §8).
  const t = timing(s, p, now, zone);
  const v = t.verdict;
  const usedCandidates = t.used.filter((c) => c.status === "candidate");
  const firm = usedCandidates.length === 0;
  let timingResult: Tri;
  let timingUnknown: { cell: Cell; reason: MissingReason }[] = [];
  let timingCandidates: Cell[] = [];
  if (v.kind === "unknown") {
    timingResult = "unknown";
    timingUnknown = v.cells.map((c) => ({ cell: c, reason: unresolvedReason(c) }));
  } else if (v.kind === "vested") {
    timingResult = "pass";
    timingCandidates = usedCandidates;
  } else if (!firm) {
    // A negative, not-yet-due or review verdict never rests on an unconfirmed value: confirm it first (D212(b)).
    timingResult = "unknown";
    timingUnknown = usedCandidates.map((c) => ({ cell: c, reason: "candidate_unconfirmed" as const }));
  } else {
    timingResult = v.kind === "on_time" ? "fail" : "unknown";
    if (v.kind === "not_yet_due") {
      flags.notYetDue = { ...(v.at !== undefined ? { at: v.at } : {}), ...(v.when !== undefined ? { when: v.when } : {}), ...(v.userAction ? { userAction: v.userAction } : {}) };
    }
    if (v.kind === "manual") flags.manualReviewReason = v.text;
  }
  const tNote = t.T ? `Applicable shipping time ends ${t.T} (${t.tText}).` : undefined;
  const timingLeaf = computed(R05_V1_TIMING_ID, "The seller missed its shipping duty and the refund right has vested", "timing", timingResult, t.used, {
    unknown: timingUnknown, candidates: timingCandidates, ...(tNote ? { note: tNote } : {}), passage: "P-435.2(c)", neededFor: ["timing"],
  });

  const tree: ConditionNode = { op: "all", children: [...scope.leaves.map((l) => l.cond), timingLeaf] };
  const evaluated = evaluateConditions(tree, lookupFrom([]));
  const missing = [...evaluated.decisiveMissing];
  const unconfirmed = [...evaluated.decisiveUnconfirmed];
  const failedScope = scope.leaves.find((l) => l.cond.result === "fail" && l.failReason !== null);

  const assumptions: Assumption[] = [];
  if (evaluated.result !== "fail") {
    for (const l of scope.leaves) if (l.assumed && !assumptions.some((a) => a.id === l.assumed!.id)) assumptions.push(l.assumed);
    if (v.kind === "vested" || v.kind === "not_yet_due") for (const a of t.assumptions) if (!assumptions.some((x) => x.id === a.id)) assumptions.push(a);
  }

  // Amount (§7, §8): only once the refund right has vested. The whole amount tendered — never an item total; a refund
  // already received is a ledger credit on the case, never netted here (D234(16)).
  let amount: AmountCalc | null = null;
  let amountCalculable: Tri = evaluated.result === "fail" ? "fail" : "unknown";
  if (v.kind === "vested") {
    const partialCell = cell("order.partially_shipped");
    const partialValue = boolOf(usable(partialCell));
    if (partialCell.status === "candidate") {
      // README cross-pack rule 1: an amount input is decisive for the estimate (M27 R05-17).
      addMissing(unconfirmed, { subjectKey: partialCell.subjectKey, key: partialCell.key, reason: "candidate_unconfirmed", class: "required", neededFor: ["amount"] });
    }
    const totalCell = cell("retail.order_total");
    const total = usable(totalCell);
    if (total === null) {
      addMissing(missing, { subjectKey: totalCell.subjectKey, key: totalCell.key, reason: unresolvedReason(totalCell), class: "required", neededFor: ["amount"] });
    } else if (total.kind === "money") {
      if (totalCell.status === "candidate") {
        addMissing(unconfirmed, { subjectKey: totalCell.subjectKey, key: totalCell.key, reason: "candidate_unconfirmed", class: "required", neededFor: ["amount"] });
      }
      if (partialValue === true || partialCell.status === "user_unknown") {
        amountCalculable = "unknown";
        notes.push(partialValue === true
          ? "Part of the order shipped: only the unshipped part is refunded, and the FTC's method for that amount is guidance only (FTC-MITOR-G7), so the amount needs review."
          : "You don't know whether part of the order shipped, so the refund amount needs review (FTC-MITOR-G7).");
      } else if (total.amountMinor <= 0) {
        amountCalculable = "fail";
        notes.push("The order total on file is zero, so there is no amount to ask for.");
      } else if (isTwoDecimalCurrency(total.currency)) {
        amountCalculable = "pass";
        amount = {
          estimate: { amountMinor: total.amountMinor, currency: total.currency },
          basis: "documented_total",
          formula: "the amount you paid for the order (order total incl. tax and shipping); no store credit",
          inputs: [{ label: "order total paid", value: String(total.amountMinor), fact: refOf(totalCell) }],
        };
      }
    }
  }

  // D234(14): a confirmed "not shipped" stands against an unconfirmed carrier scan; the scan is shown as information.
  const shippedCell = cell("order.shipped");
  const scanCell = cell("order.shipped_at");
  if (shippedCell.status === "confirmed" && boolOf(shippedCell.value) === false && scanCell.status === "candidate" && scanCell.value.kind === "instant") {
    notes.push(`A document Recoup has not confirmed shows a carrier scan on ${localParts(zone, scanCell.value.epochMs).date}; Recoup relies on your confirmation that the order has not shipped. If the carrier did take it, tell Recoup.`);
  }

  const termsCode = codeOf(usable(cell("order.payment_terms")));
  const dims: Omit<Dimensions, "readyForApproval"> = {
    applies: evaluated.result,
    factsKnown: missing.length === 0 ? "pass" : "unknown",
    evidenceSupports: unconfirmed.length === 0 ? "pass" : "unknown",
    windowOpen: "pass", // R05 sets no user deadline (§11: the buyer has none to preserve the rule's protections)
    amountCalculable,
  };
  const timingLines: string[] = [];
  if (t.T) timingLines.push(`The seller's applicable shipping time ended on ${t.T}: ${t.tText}.`);
  if (v.kind !== "unknown") timingLines.push(v.text);
  const assumed = t.assumptions.some((a) => DATE_MOVING_ASSUMPTIONS.has(a.id));
  const vest = v.kind === "vested" ? { date: v.vestDate, fromCandidate: !firm || assumed } : null;
  if (vest?.date) timingLines.push(`Your right to a prompt refund vested on ${vest.date}${assumed ? " (on the assumption named below)" : ""}.`);
  return {
    dims, flags, conditions: evaluated.conditions, missing, unconfirmed, assumptions, amount, vest, timingLines, notes,
    scopeReason: failedScope?.failReason ?? null, verdictKind: v.kind,
    passages: v.kind === "unknown" ? ["P-435.2(a)(1)", "P-435.2(c)"] : v.passages, sellerCreditor: termsCode === "seller_credit_application",
  };
}

// ---------------------------------------------------------------------------
// Candidate testing (D152/D154) and the final result in one zone
// ---------------------------------------------------------------------------

const AMOUNT_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible"]);
/** The refund deadline is shown only where a refund may be owed (never for not_eligible/needs_facts/not_yet_due/…). */
const DEADLINE_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>(["eligible", "likely_eligible", "possible_contract_benefit", "manual_review"]);

function outcomeOf(c: Core): { outcome: Outcome; amount: AmountCalc | null } {
  const outcome = deriveOutcome({ ...c.dims, readyForApproval: "unknown" }, c.flags, c.assumptions);
  return { outcome, amount: AMOUNT_OUTCOMES.has(outcome) ? c.amount : null };
}

function conflictFlag(cell: Extract<Cell, { status: "conflicting" }>): Omit<ConflictFlag, "sameAnswer"> {
  return {
    key: cell.key,
    subjectKey: cell.subjectKey,
    kind: cell.conflict.kind,
    values: cell.conflict.values.map((v) => ({ value: formatFactValue(v.value), source: v.source.ref ? `${v.source.kind}: ${v.source.ref}` : v.source.kind })),
  };
}

function refundSpec(p: R05Params, zone: ZoneRule): DeadlineSpec {
  return {
    id: R05_V1_REFUND_DEADLINE_ID,
    label: `The seller's prompt-refund deadline (refund sent within ${p.promptRefundWorkingDays} working days after your refund right vested)`,
    obligor: "counterparty",
    anchor: { subjectPattern: TXN, factKey: "order.refund_vests_on" },
    anchorKind: "refund_duty_start",
    offset: { amount: p.promptRefundWorkingDays, unit: "business_days" },
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "local_end_of_day",
    timeZone: { fixed: zone.id },
    holidays: "us_federal",
    mustBe: "sent",
    sourcePassageId: "P-435.1(b)",
  };
}

const VEST_SOURCE = { kind: "derived", ref: R05_V1_RULE_ID };

/** The derived vesting-date cell the refund deadline is anchored on. */
function vestCell(zone: ZoneRule, vest: Core["vest"], conflict: { kind: ConflictFlag["kind"]; dates: string[] } | null): EngineCell {
  const value = (date: string) => ({ kind: "local_date" as const, date, timeZone: zone.id });
  if (conflict) {
    return { subjectKey: TXN, key: "order.refund_vests_on", status: "conflicting", conflict: { kind: conflict.kind, values: conflict.dates.map((d) => ({ value: value(d), source: VEST_SOURCE })) } };
  }
  if (!vest || vest.date === null) return { subjectKey: TXN, key: "order.refund_vests_on", status: "missing" };
  return { subjectKey: TXN, key: "order.refund_vests_on", status: vest.fromCandidate ? "candidate" : "derived", value: value(vest.date) };
}

/**
 * D234(14), M27 R05-04: the spec's single `shipped_at` fact is two keys here, so a confirmed "not shipped" against a
 * confirmed or observed carrier scan on `order.shipped_at` is the cross-key conflict the single fact had. It is
 * surfaced as a conflict on `order.shipped` (5a → manual_review, disputed anchor). A candidate scan is not a conflict.
 */
function withShipmentConflict(s: OrderSnapshot): OrderSnapshot {
  const shipped = txnCell(s, "order.shipped") as Cell;
  const scan = txnCell(s, "order.shipped_at") as Cell;
  if (!(shipped.status === "confirmed" && shipped.value.kind === "bool" && !shipped.value.value) || !scan.known) return s;
  const kind: ConflictKind = scan.status === "confirmed" ? "confirmed_vs_confirmed" : "confirmed_vs_observed";
  const synth: Cell = {
    subjectKey: TXN, key: "order.shipped", status: "conflicting", known: false, capsOutcomeAt: null,
    conflict: {
      kind,
      values: [
        { value: shipped.value, source: shipped.source, sources: [shipped.source] },
        { value: { kind: "bool", value: true }, source: scan.source, sources: [scan.source] },
      ],
    },
  };
  return { ...s, lookup: withOverride(s.lookup, synth) };
}

interface ZoneResult {
  zone: ZoneRule;
  outcome: Outcome;
  amount: AmountCalc | null;
  core: Core;
  flags: Flags;
  missing: MissingFact[];
  unconfirmed: MissingFact[];
  deadlines: DeadlineResult[];
  extraExplanation: string[];
  /** Timing text to show (the core's, or the 5c summary). */
  timingLines: string[];
}

function evaluateInZone(s0: OrderSnapshot, p: R05Params, now: number, zone: ZoneRule, base: BaseFlags): ZoneResult {
  const s = withShipmentConflict(s0);
  const conflicting = DECISIVE_KEYS.map((k) => s.lookup.get(TXN, k)).filter((c): c is Extract<Cell, { status: "conflicting" }> => c.status === "conflicting");
  const baseCore = core(s, p, now, zone, base);
  let final = baseCore;
  let flags = baseCore.flags;
  let missing = baseCore.missing;
  let unconfirmed = baseCore.unconfirmed;
  let timingLines = baseCore.timingLines;
  let vc: EngineCell = vestCell(zone, baseCore.vest, null);
  const extraExplanation: string[] = [];

  if (conflicting.length > 0) {
    const choices = conflicting.map((c) =>
      alternatives(c).map((alt) =>
        alt.status === "candidate" ? knownCell(alt.subjectKey, alt.key, "confirmed", alt.value, { kind: "user" }) : alt,
      ),
    );
    const combos = candidateCombinations(choices);
    const tested = (combos ?? []).map((combo) => {
      let lookup = combo.reduce((l, cellAlt) => withOverride(l, cellAlt), s.lookup);
      for (const alt of combo) {
        for (const member of COMPOSITES.find((g) => g.includes(alt.key)) ?? []) {
          const m = lookup.get(TXN, member);
          if (member !== alt.key && m.status === "candidate") lookup = withOverride(lookup, knownCell(TXN, member, "confirmed", m.value, { kind: "user" }));
        }
      }
      const sub: OrderSnapshot = { ...s, lookup };
      const c = core(sub, p, now, zone, base);
      return { core: c, answer: outcomeOf(c) };
    });
    const dates = [...new Set(tested.map((t) => t.core.vest?.date).filter((d): d is string => typeof d === "string"))].sort();
    const confirmedKinds = conflicting.filter((c) => c.conflict.kind !== "candidates");
    const conflictKeys = new Set(conflicting.map((c) => `${c.subjectKey}\u0000${c.key}`));
    const notConflict = (m: MissingFact) => !conflictKeys.has(`${m.subjectKey}\u0000${m.key}`);
    const same = combos !== null && sameAnswer(tested.map((t) => t.answer));
    // 5c keeps only a positive answer; two readings that agree on a negative, not-yet-due or review verdict are asked
    // (D212(b), D234(1), M27 R05-03) — unless the conflict decides nothing on this path (DA-A-24).
    const decisive = baseCore.missing.some((m) => conflictKeys.has(`${m.subjectKey}\u0000${m.key}`));
    const positive = same && isApprovable(tested[0].answer.outcome);
    const list = withSameAnswer(conflicting.map(conflictFlag), confirmedKinds.length === 0 && positive);
    const describe = (f: Omit<ConflictFlag, "sameAnswer">) => `${f.key}: ${f.values.map((x) => `${x.value} (${x.source})`).join(" vs ")}`;
    vc = vestCell(zone, null, dates.length > 0 ? { kind: confirmedKinds.length > 0 ? confirmedKinds[0].conflict.kind : "candidates", dates } : null);

    if (confirmedKinds.length > 0) {
      // 5a: the user cannot settle it by answering.
      const shippedNote = confirmedKinds.some((c) => c.key === "order.shipped") ? shippedConflictNote(s0, zone) : "";
      const reason = `A value you confirmed contradicts another source — ${confirmedKinds.map((c) => describe(conflictFlag(c))).join("; ")}.${shippedNote} Upload proof (for example a dated screenshot) or correct your confirmation.`;
      flags = { ...baseCore.flags, manualReviewReason: reason, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = baseCore.missing.filter(notConflict);
      timingLines = [];
      extraExplanation.push(reason);
    } else if (positive) {
      // 5c: every value gives the same positive outcome and amount — the answer stands, capped; the keys are still asked.
      final = tested[0].core;
      flags = { ...final.flags, conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = final.missing.filter(notConflict);
      unconfirmed = final.unconfirmed.filter(notConflict);
      for (const c of conflicting) addMissing(unconfirmed, { subjectKey: c.subjectKey, key: c.key, reason: "conflict_capped", class: "required", neededFor: ["confirmation"] });
      // No candidate's dates are stated as fact (D154(2), M27 R05-19).
      timingLines = [`Your documents give different readings of ${conflicting.map((c) => c.key).join(", ")}; every reading gives the same answer, but the dates depend on which one is right, so none is shown as fact.`];
      extraExplanation.push(`Confirm which reading is right to remove the cap.`);
    } else if (same && !decisive) {
      // The conflict decides nothing on this path: the base answer stands.
    } else {
      // 5b: the user answers which value is right.
      flags = { ...without(baseCore.flags, "notYetDue", "manualReviewReason"), conflictingKeys: conflicting.map((c) => c.key), conflicts: list };
      missing = [...baseCore.missing];
      for (const c of conflicting) addMissing(missing, { subjectKey: c.subjectKey, key: c.key, reason: "conflicting", class: "required", neededFor: ["outcome"] });
      timingLines = [];
      extraExplanation.push(`Your documents disagree on ${list.map(describe).join("; ")}, and the answer depends on which is right.`);
    }
  }

  const dims = { ...final.dims, factsKnown: missing.length === 0 ? final.dims.factsKnown : ("unknown" as Tri) };
  const outcome = deriveOutcome({ ...dims, readyForApproval: "unknown" }, flags, final.assumptions);
  const amount = AMOUNT_OUTCOMES.has(outcome) ? final.amount : null;
  const deadlines: DeadlineResult[] = [];
  if (DEADLINE_OUTCOMES.has(outcome) && !final.sellerCreditor && (vc.status !== "missing" || final.vest !== null)) {
    deadlines.push(computeDeadline(refundSpec(p, zone), lookupFrom([vc]), now));
  }
  if (DEADLINE_OUTCOMES.has(outcome) && final.sellerCreditor && final.vest) {
    extraExplanation.push("The seller extended you credit, so its refund is due within one billing cycle of that account (435.1(b)(2)); Recoup does not compute that date.");
  }
  return { zone, outcome, amount, core: final, flags, missing, unconfirmed, deadlines, extraExplanation, timingLines };
}

/** The carrier scan, as the buyer's local date (A5, M27 R05-14). */
function shippedConflictNote(s: OrderSnapshot, zone: ZoneRule): string {
  const at = txnCell(s, "order.shipped_at") as Cell;
  if (!(at.known && at.value.kind === "instant")) return "";
  return ` The carrier recorded the package as accepted on ${localParts(zone, at.value.epochMs).date}: if that is right, the order shipped, and a package lost in transit is not a shipping-time problem under the FTC rule — check with the seller and the carrier.`;
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

function refundFormText(instrument: string | null): string | null {
  switch (instrument) {
    case "consumer_credit_card":
    case "consumer_open_end_other":
      return "Refund form: a credit memo to your card issuer, with a copy to you (435.1(d)(2)(ii)); store credit or vouchers are not a refund (FTC-MITOR-G2).";
    case null:
      return null;
    default:
      return "Refund form: back to the way you paid, or cash, check or money order if that is not possible (435.1(b)); store credit or vouchers are not a refund (FTC-MITOR-G2).";
  }
}

const SOURCE_TEXT = "The FTC rule's text on file has not been verified as current, so Recoup draws no conclusion about this order under it until the source is re-checked.";
const EFFECTIVE_TEXT = "This order predates the current version of the FTC rule (effective 2014-12-08), which is the version Recoup checks, so it draws no conclusion under it.";

function nextActionFor(
  outcome: Outcome, flags: Flags, missing: readonly MissingFact[], deadlines: readonly DeadlineResult[], cc: CaseContext, reason: string,
): NextAction {
  switch (outcome) {
    case "eligible":
    case "likely_eligible":
    case "possible_contract_benefit": {
      if (cc.activeClaimId === undefined) return { kind: "open_case" };
      const overdue = deadlines.find((d) => d.id === R05_V1_REFUND_DEADLINE_ID && d.status === "overdue");
      if (overdue) return { kind: "escalate", reason: `The seller's prompt-refund deadline (${overdue.dueLocalDate ?? "the computed date"}) has passed without a refund.` };
      return { kind: "continue_case", claimId: cc.activeClaimId };
    }
    case "not_yet_due":
      return notYetDueAction(flags.notYetDue ?? {});
    case "needs_facts": {
      const keys: FactRef[] = [];
      for (const m of missing) if (!keys.some((k) => k.subjectKey === m.subjectKey && k.key === m.key)) keys.push({ subjectKey: m.subjectKey, key: m.key });
      return keys.length > 0 ? { kind: "answer_questions", keys } : { kind: "none", reason };
    }
    case "manual_review":
      return { kind: "manual_review", reason: flags.manualReviewReason ?? reason };
    case "unsupported":
      return { kind: "none", reason: flags.unsupportedReason ?? reason };
    case "source_unverified":
      return { kind: "none", reason: flags.effectiveDateMismatch ? EFFECTIVE_TEXT : SOURCE_TEXT };
    default:
      return { kind: "none", reason };
  }
}

const sameAnswerKey = (z: ZoneResult) => `${z.outcome}|${z.amount ? `${z.amount.estimate.amountMinor} ${z.amount.estimate.currency}` : "null"}`;

export function evaluateR05V1(input: EvaluationInput<OrderSnapshot, R05Params, CaseContext>): EvaluationResult {
  const { snapshot: s, pack, now, caseContext: cc } = input;
  const p = pack.params;
  // README rule 3 (staleness) and rule 5 (an order before the rule version's effective date is a known mismatch; an
  // extracted one adds an assumption, never a mismatch, M27 R05-14).
  const base: BaseFlags = {};
  if (sourceStale(pack.sources, input.verification, now).stale) base.sourceStale = true;
  const orderAt = txnCell(s, "order.properly_completed_at") as Cell;
  const zoneCell = txnCell(s, "order.ship_to_time_zone") as Cell;
  const zoneCode = zoneCell.known && zoneCell.value.kind === "code" ? zoneCell.value.code : null;
  const knownZone = zoneCode ? zoneRule(zoneCode) : null;
  const orderValue = usable(orderAt);
  const orderDate = orderValue && orderValue.kind === "instant"
    ? (knownZone ? localParts(knownZone, orderValue.epochMs).date : new Date(orderValue.epochMs).toISOString().slice(0, 10))
    : null;
  const earlyOrder = orderDate !== null && orderDate < p.effectiveFrom;
  if (earlyOrder && orderAt.known) base.effectiveDateMismatch = true;

  // A5: the buyer's local dates. Unknown zone → every committed US zone must agree (otherwise the zone is asked).
  const runs = (knownZone ? [knownZone] : US_ZONES).map((z) => {
    try {
      return evaluateInZone(s, p, now, z, base);
    } catch (err) {
      if (err instanceof BeyondCalendarError || err instanceof RangeError) return null;
      throw err;
    }
  });
  const ok = runs.filter((r): r is ZoneResult => r !== null);
  const extra: string[] = [];
  let chosen: ZoneResult;
  let flags: Flags;
  let missing: MissingFact[];
  let deadlines: DeadlineResult[];
  let timingLines: string[];
  let zoneAsked = false;
  if (ok.length === 0) {
    // Every computation left the committed calendar (before 2007 or past the holiday table). Scope does not depend on
    // the calendar, so a known scope failure still decides (M27 R05-20); otherwise a person decides.
    const scope = scopeOf(s);
    const failed = scope.leaves.find((l) => l.cond.result === "fail");
    const applies = evaluateConditions({ op: "all", children: scope.leaves.map((l) => l.cond) }, lookupFrom([])).result;
    const stubFlags: Flags = { ...emptyFlags(), ...base, ...(scope.unsupportedReason ? { unsupportedReason: scope.unsupportedReason } : {}) };
    const stub: Core = {
      dims: { applies: applies === "fail" ? "fail" : "unknown", factsKnown: "unknown", evidenceSupports: "unknown", windowOpen: "pass", amountCalculable: "unknown" },
      flags: stubFlags, conditions: scope.leaves.map((l) => ({ id: l.cond.id, label: l.cond.label, result: l.cond.result, kind: l.cond.kind, facts: [...l.cond.facts] })),
      missing: [], unconfirmed: [], assumptions: [], amount: null, vest: null, timingLines: [], notes: [],
      scopeReason: failed?.failReason ?? null, verdictKind: "unknown", passages: ["P-435.2(a)(1)"], sellerCreditor: false,
    };
    chosen = { zone: US_ZONES[0], outcome: "manual_review", amount: null, core: stub, flags: stubFlags, missing: [], unconfirmed: [], deadlines: [], extraExplanation: [], timingLines: [] };
    flags = failed || scope.unsupportedReason
      ? stubFlags
      : { ...stubFlags, manualReviewReason: "These dates fall outside the calendar Recoup has verified (2007 onward for time zones, through 2030 for holidays)." };
    missing = [];
    deadlines = [];
    timingLines = [];
  } else if (knownZone || new Set(ok.map(sameAnswerKey)).size === 1) {
    // One answer. With the zone unknown, a counterparty timer waits for the latest-ending zone (D234(8)): the dates
    // shown are those of the zone that gives the seller the most time.
    chosen = knownZone
      ? ok[0]
      : [...ok].sort((a, b) =>
          (b.flags.notYetDue?.at ?? "").localeCompare(a.flags.notYetDue?.at ?? "") ||
          (b.deadlines[0]?.dueAt ?? 0) - (a.deadlines[0]?.dueAt ?? 0))[0];
    flags = chosen.flags;
    missing = chosen.missing;
    deadlines = chosen.deadlines;
    timingLines = chosen.timingLines;
    if (!knownZone && ok.length < runs.length) {
      flags = { ...flags, manualReviewReason: flags.manualReviewReason ?? "Some of these dates fall outside the calendar Recoup has verified." };
    }
    if (!knownZone) {
      extra.push(`Your time zone is not known; every US time zone gives this answer (dates shown for ${chosen.zone.label}, which gives the seller the most time).`);
      // D235(A): the seller's date is a range across the plausible zones; overdue and escalate use the latest.
      const dues = ok.flatMap((z) => z.deadlines.filter((x) => x.id === R05_V1_REFUND_DEADLINE_ID && x.dueLocalDate !== undefined).map((x) => x.dueLocalDate!)).sort();
      if (dues.length > 0 && dues[0] !== dues[dues.length - 1]) {
        const range = `on or about ${dues[0]} – ${dues[dues.length - 1]}`;
        deadlines = deadlines.map((x) => (x.id === R05_V1_REFUND_DEADLINE_ID ? { ...x, basis: `${x.basis} Due ${range}: your time zone is not known, so it counts as overdue only after the latest-ending US zone's date.` } : x));
        extra.push(`The seller's refund is due ${range} (your time zone is not known).`);
      }
    }
  } else {
    // The local date decides the answer: ask for the zone (DA-A-24: decisive only). Never one zone's verdict, negative
    // or positive (D234, M27 R05-02): the result waits for the zone.
    chosen = ok[0];
    flags = without(chosen.flags, "notYetDue", "manualReviewReason");
    missing = [...chosen.missing];
    zoneAsked = true;
    if (zoneCell.status === "conflicting" && zoneCell.conflict.kind !== "candidates") {
      flags = { ...flags, manualReviewReason: `Two time zones you confirmed for the delivery address disagree (${zoneCell.conflict.values.map((x) => formatFactValue(x.value)).join(" vs ")}), and the answer depends on which is right. Correct the one that is wrong.` };
    } else {
      addMissing(missing, { subjectKey: TXN, key: "order.ship_to_time_zone", reason: unresolvedReason(zoneCell), class: "required", neededFor: ["dates"] });
    }
    deadlines = [];
    timingLines = [];
    extra.push("The answer depends on your local date; tell Recoup which time zone the delivery address is in.");
  }
  const c = chosen.core;
  let unconfirmed = chosen.unconfirmed;
  const assumptions = [...c.assumptions];
  if (earlyOrder && !orderAt.known && !assumptions.some((a) => a.id === A_EFFECTIVE.id)) assumptions.push(A_EFFECTIVE);
  const d = {
    ...c.dims,
    ...(zoneAsked ? { applies: "unknown" as Tri } : {}),
    factsKnown: missing.length === 0 && !zoneAsked ? c.dims.factsKnown : ("unknown" as Tri),
  };
  const outcome = deriveOutcome({ ...d, readyForApproval: "unknown" }, flags, assumptions);
  if (outcome === "unsupported") {
    // Nothing is asked that cannot change an unsupported answer, except a candidate country (M27 R05-15).
    const countryKeys = new Set(["order.buyer_country", "order.ship_to_country", "order.seller_country"]);
    missing = missing.filter((m) => countryKeys.has(m.key) && m.reason !== "missing");
    unconfirmed = unconfirmed.filter((m) => countryKeys.has(m.key));
  }
  const amount = AMOUNT_OUTCOMES.has(outcome) ? c.amount : null;
  const dimensions: Dimensions = { ...d, readyForApproval: isApprovable(outcome) && amount !== null ? "pass" : "fail" };
  if (!DEADLINE_OUTCOMES.has(outcome)) deadlines = [];

  const instrument = codeOf(usable(txnCell(s, "card.payment_instrument_class") as Cell));
  const paidByCredit = instrument !== null && CONSUMER_CREDIT.has(instrument);
  const approvable = isApprovable(outcome);
  // What the result may say (M27 R05-01): an excluded, out-of-scope or unverified result names its reason only.
  let explanation: string[];
  let reason: string;
  if (outcome === "unsupported") {
    reason = flags.unsupportedReason ?? "Recoup does not check this order under the FTC shipping rule.";
    explanation = [reason];
  } else if (outcome === "source_unverified") {
    reason = flags.effectiveDateMismatch ? EFFECTIVE_TEXT : SOURCE_TEXT;
    explanation = [reason];
  } else if (outcome === "not_eligible" && c.scopeReason) {
    reason = c.scopeReason;
    explanation = [reason, ...(paidByCredit ? ["Other paths may still apply, such as the merchant's own policy or, for a card payment, the credit-card billing-error path (R03)."] : [])];
  } else {
    const shownTiming = timingLines;
    reason = shownTiming.find((line) => !line.startsWith("The seller's applicable shipping time")) ?? "The FTC shipping rule does not give a refund on these facts.";
    const refundForm = approvable ? refundFormText(instrument) : null;
    const r03Line = approvable && paidByCredit
      ? "You paid by credit card: the billing-error path (R03) is an alternative for the same money, with its own 60-day notice clock that runs regardless."
      : outcome === "not_eligible" && c.verdictKind === "on_time" && paidByCredit
        ? "If a promised delivery date was missed, the credit-card billing-error path (R03, 'late delivery') is separate and has its own 60-day notice clock."
        : null;
    explanation = [
      ...chosen.extraExplanation,
      ...extra,
      ...(amount ? [`Refund due: ${formatMinor(amount.estimate.amountMinor, amount.estimate.currency)}, the whole amount you paid including shipping (FTC-MITOR-G6).`] : []),
      ...shownTiming,
      ...c.notes,
      ...(refundForm ? [refundForm] : []),
      ...(r03Line ? [r03Line] : []),
      ...assumptions.map((a) => a.text),
    ];
  }
  explanation = explanation.slice(0, 12);
  const nextAction = nextActionFor(outcome, flags, [...missing, ...unconfirmed], deadlines, cc, reason);

  const passages = [...new Set(["P-435.2(a)(1)", ...(outcome === "not_eligible" && c.scopeReason ? ["P-435.3(a)"] : c.passages), ...(amount ? ["FTC-MITOR-G6"] : [])])];
  const sourceRefs: SourceRef[] = passages
    .map((id) => pack.sources.find((x) => x.passageId === id))
    .filter((x): x is RuleSourceMeta => x !== undefined)
    .slice(0, 8)
    .map((x) => ({ sourceId: x.sourceId, passageId: x.passageId, url: x.url, effective: x.effective }));

  return {
    scenarioId: "R05",
    ruleId: pack.ruleId,
    ruleVersion: pack.version,
    engineVersion: input.engineVersion,
    remedyKey: input.remedyKey,
    subjectKey: input.subjectKey,
    snapshotHash: input.snapshotHash,
    outcome,
    dimensions,
    conditions: c.conditions,
    missingFacts: [...missing, ...unconfirmed],
    assumptions,
    disqualifierIds: c.conditions.filter((x) => x.result === "fail" && x.kind !== "timing").map((x) => x.id),
    amount,
    deadlines,
    sourceRefs,
    lossKeys: r05LossKeys(s),
    overlap: approvable && paidByCredit ? [{ withScenario: "R03", withRemedyKey: R05_R03_REMEDY_KEY, relation: "alternative" }] : [],
    nextAction,
    explanation,
    flags,
    boundFacts: orderBoundFacts(s),
    ...(outcome === "not_yet_due" && flags.notYetDue
      ? { reevaluate: { ...(flags.notYetDue.at !== undefined ? { at: flags.notYetDue.at } : {}), ...(flags.notYetDue.when !== undefined ? { when: flags.notYetDue.when } : {}) } }
      : {}),
  };
}

/**
 * The pack's run adapter (D208, M20's `PackAdapter.runs` shape): one run per order transaction, on subject `txn`,
 * over the transaction's live fact rows. Pure. Wired as the pack's `adapter` (M20, D208).
 */
export function r05AdapterRuns(input: { transactionId: Id<"transactions">; isExample: boolean; rows: readonly CellRow[] }): { subjectKey: string; snapshot: OrderSnapshot; lookup: CellLookup }[] {
  const snapshot = buildOrderSnapshot({ transactionId: input.transactionId, rows: input.rows });
  return [{ subjectKey: TXN, snapshot, lookup: snapshot.lookup }];
}

/** Loss key (§3.3): `txn:<paidTxnId>:paid` — the order's paid money, shared with R03 on the related card charge. */
export function r05LossKeys(s: Pick<OrderSnapshot, "transactionId">): string[] {
  return [`txn:${s.transactionId}:paid`];
}

export const r05LateOrderV1: RulePack<OrderSnapshot, R05Params, CaseContext> = {
  ruleId: R05_V1_RULE_ID,
  scenarioId: "R05",
  version: R05_V1_VERSION,
  // Informative only: the manifest + the lead's activation entry decide status.
  lifecycle: "researched",
  authority: { class: "legal_entitlement", subtype: "Federal trade regulation rule, 16 CFR part 435 (15 U.S.C. 57a), with FTC business guidance" },
  jurisdiction: "US — mail, Internet or telephone orders (16 CFR 435.2)",
  categories: ["retail_order"],
  remedyKey: R05_REMEDY_KEY,
  remedyType: "cash_refund",
  cashClass: "cash",
  params: R05_V1_PARAMS,
  sources: R05_V1_SOURCES,
  requirements: [
    { subjectPattern: TXN, key: "order.channel", class: "required" },
    { subjectPattern: TXN, key: "order.seller_name", class: "required" },
    { subjectPattern: TXN, key: "order.properly_completed_at", class: "required" },
    { subjectPattern: TXN, key: "order.ship_time_kind", class: "required" },
    { subjectPattern: TXN, key: "order.ship_time_days", class: "required" },
    { subjectPattern: TXN, key: "order.ship_by_date", class: "required" },
    { subjectPattern: TXN, key: "order.shipped", class: "required" },
    { subjectPattern: TXN, key: "order.shipped_at", class: "required" },
    { subjectPattern: TXN, key: "order.delay_notice_received", class: "required" },
    { subjectPattern: TXN, key: "order.delay_notice_received_at", class: "required" },
    { subjectPattern: TXN, key: "order.delay_notice_offers_cancel", class: "required" },
    { subjectPattern: TXN, key: "order.delay_revised_ship_kind", class: "required" },
    { subjectPattern: TXN, key: "order.delay_revised_ship_date", class: "required" },
    { subjectPattern: TXN, key: "order.buyer_response", class: "required" },
    { subjectPattern: TXN, key: "order.seller_cancelled_at", class: "required" },
    { subjectPattern: TXN, key: "retail.order_total", class: "required" },
    { subjectPattern: TXN, key: "order.ship_to_time_zone", class: "required" },
    { subjectPattern: TXN, key: "order.buyer_country", class: "assumption", assumptionText: A_US.text },
    { subjectPattern: TXN, key: "order.ship_to_country", class: "assumption", assumptionText: A_US.text },
    { subjectPattern: TXN, key: "order.seller_country", class: "assumption", assumptionText: A_US.text },
    { subjectPattern: TXN, key: "order.merchandise_category", class: "assumption", assumptionText: A_CATEGORY.text },
    { subjectPattern: TXN, key: "order.payment_terms", class: "assumption", assumptionText: `${A_NOT_COD.text} ${A_CREDIT.text}` },
    { subjectPattern: TXN, key: "order.buyer_response_at", class: "assumption", assumptionText: A_CONSENT_TIMING.text },
  ],
  fixturesPath: "docs/rules/fixtures/R05.json",
  lateAskDeadlineIds: [],
  overlap: [{ withScenario: "R03", withRemedyKey: R05_R03_REMEDY_KEY, relation: "alternative" }],
  knownLimitations: [
    "L1: the rule is enforced by the FTC; the captured text states no private right of action. Recoup asks the seller to honour the cancellation and refund the rule requires and points to R03 for card payments — never 'you can sue under the FTC rule'.",
    "L2: 'working days' is undefined in part 435; Recoup counts Mon–Fri without federal holidays (A2).",
    "L3: 'label created' is not shipment; only the first carrier-possession scan counts.",
    "L4: on a marketplace the seller may be a third party; an unknown seller is asked.",
    "L5: for a range such as '3–5 days' the upper bound governs (A4); the extracted days carry it.",
    "L6: state law may add rights (435.3(b)); not evaluated.",
    "L8: non-US buyers, sellers or delivery addresses (incl. US territories' own country codes) are unsupported — a conservative scope choice.",
    "Only the first delay-option notice is modelled; a renewed option after a missed revised date is an assumption (R05.A-renewed), and a seller timer resting on it is never firm.",
    "A partial shipment's refund amount is left to review (FTC-MITOR-G7 is guidance only).",
    "A refund by a seller who extended credit is due within one billing cycle; Recoup does not compute that date.",
    "Unknown country, category and payment terms are assumed (US order, ordinary merchandise, paid at order) and cap the outcome at likely_eligible.",
    "A refund already received is recorded as a confirmed credit on the R05 case (contract §3.2/§3.4) and nets the outstanding amount there; the estimate stays the order total (contract §10 R05, D234(16)).",
    "A buyer's cancellation is dated when the buyer sent it; the rule turns on when the seller received it (A3), so a mailed cancellation can vest a few days earlier here than in law.",
    "A confirmed 'not shipped' against a confirmed or observed carrier scan goes to review, even when the user overrode an observation of 'shipped' (the live scan stays).",
  ],
  evaluate: evaluateR05V1,
  adapter: { runs: r05AdapterRuns }, // M20 (D208), wired with M21's authorization
};
