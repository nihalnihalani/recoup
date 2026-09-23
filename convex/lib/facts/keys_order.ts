/**
 * Online / mail / telephone order keys (M21, wave 2): the facts R05 v1 (FTC Mail, Internet, or Telephone Order
 * Merchandise Rule, 16 CFR 435; docs/rules/R05-mail-internet-order.md §5) reads, plus `retail.order_total`, the
 * confirmed order total incl. tax + shipping that is both R05's refund amount ("amount tendered", FTC-MITOR-G6) and the
 * retail paid-total cap of `recovery.summary` (contract §3.4, D148 wave-2 note).
 *
 * Every key lives on the order transaction itself (subject `txn`, category `retail_order`). The spec's structured
 * facts are split into scalar keys because a fact value is one scalar (`lib/facts/catalog.ts`):
 *   - `shipping_representation` → `order.ship_time_kind` (+ `order.ship_time_days` | `order.ship_by_date`) and the
 *     verbatim `order.ship_time_text`; a confirmed "no time was stated" is `ship_time_kind = none_stated`;
 *   - `shipped_at` → `order.shipped` (a user may confirm "not shipped") + `order.shipped_at` (first carrier-possession
 *     scan, never "label created", spec L3);
 *   - `delay_notices` (the FIRST delay-option notice) → `order.delay_notice_received`, `…_received_at`,
 *     `order.delay_revised_ship_kind` (+ `order.delay_revised_ship_date`) and `order.delay_notice_offers_cancel`;
 *   - `buyer_response` → `order.buyer_response` (+ `order.buyer_response_at`).
 * "I don't know" is the fact layer's `user_unknown`, so the spec's `unknown` enum members are not codes here.
 *
 * `order.refund_vests_on` is catalogued so a pack can name it (the anchor of the seller's prompt-refund deadline);
 * only R05's evaluator derives it — the user never asserts it. Keys are never renamed.
 */
import type { FactSpec } from "./catalog";

const RETAIL = ["retail_order"] as const;
const TXN = ["transaction"] as const;
const ORDER_DOCS = ["order_confirmation", "receipt"] as const;

/** ISO 3166-1 alpha-2 (249 officially assigned codes). */
export const ISO_3166_ALPHA2: readonly string[] = Object.freeze(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO " +
    "FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE " +
    "JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO " +
    "MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW " +
    "PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM " +
    "TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

/**
 * IANA ids of the committed US zone table (`lib/deadlines/usZones.ts` US_ZONES; `keys_order.test.ts` asserts the two
 * lists match). A zone outside it cannot be computed by the deadline engine.
 */
export const US_TIME_ZONE_IDS: readonly string[] = Object.freeze([
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles",
  "America/Anchorage", "America/Adak", "Pacific/Honolulu", "America/Puerto_Rico", "America/St_Thomas",
  "Pacific/Guam", "Pacific/Saipan", "Pacific/Pago_Pago",
]);

export const ORDER_FACT_SPECS = [
  {
    key: "retail.order_total",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "money",
    // The paid-total cap covers every retail purchase (R01 included), so it takes the R01 two-decimal set (DA-A-13).
    currencyMode: "legacy_r01",
    question: {
      prompt: "What was the order total you paid, including tax and shipping?",
      why: "A refund of an unshipped order is the whole amount you paid, and Recoup never counts more than that as recovered.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.channel",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["internet", "mail", "telephone", "in_store"],
    question: {
      prompt: "How did you place the order: online, by mail, by phone, or in a store?",
      why: "The FTC shipping rule covers online, mail and phone orders only.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.seller_name",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "text",
    question: {
      prompt: "Who is the seller on the order confirmation?",
      why: "On a marketplace the seller can be a third party; the shipping duty is the seller's.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.buyer_country",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ISO_3166_ALPHA2,
    question: { prompt: "Which country do you live in?", why: "Recoup checks this rule for US orders only." },
    userAssertable: true,
  },
  {
    key: "order.ship_to_country",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ISO_3166_ALPHA2,
    question: { prompt: "Which country was the order shipped to?", why: "Recoup checks this rule for US orders only." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.seller_country",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ISO_3166_ALPHA2,
    question: { prompt: "Which country is the seller in?", why: "Recoup checks this rule for US orders only." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.merchandise_category",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["general_merchandise", "serial_subscription_after_first", "seeds_or_growing_plants", "service", "negative_option_plan"],
    question: {
      prompt: "What did you order?",
      why: "The rule does not cover seeds and plants, later issues of a subscription, services, or negative-option plans.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.payment_terms",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["paid_at_order", "cod", "seller_credit_application", "bill_later"],
    question: {
      prompt: "How was the order paid: at checkout, cash on delivery, or with credit you applied for from the seller?",
      why: "Cash-on-delivery orders are not covered, and a credit application gives the seller 50 days instead of 30.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.properly_completed_at",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "instant",
    question: {
      prompt: "When did the seller have your payment and everything it needed to ship the order?",
      why: "The seller's shipping time counts from a properly completed order, not from when you started checkout.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.ship_time_kind",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["none_stated", "calendar_days", "business_days", "date"],
    question: {
      prompt: "Did the seller state when it would ship (for example \"ships in 3 days\" or \"ships by Sep 10\")?",
      why: "A stated shipping time replaces the 30-day default.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.ship_time_days",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "count",
    min: 0,
    max: 366,
    question: {
      prompt: "How many days did the seller say it would take to ship (the upper number of a range)?",
      why: "The shipping time ends that many days after your order.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.ship_by_date",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "local_date",
    question: { prompt: "Which date did the seller say it would ship by?", why: "That date ends the shipping time." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.ship_time_text",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "text",
    question: { prompt: "What exactly did the seller say about shipping?", why: "Your request quotes the seller's own words." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "order.shipped",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Has the order been handed to a carrier? (\"Label created\" does not count.)",
      why: "The rule is about shipping, not delivery: it counts from when the carrier takes the package.",
    },
    evidenceHint: ["shipping_notice"],
    userAssertable: true,
  },
  {
    key: "order.shipped_at",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "instant",
    question: {
      prompt: "When did the carrier first scan the package as accepted or picked up?",
      why: "That scan is the shipping date the rule looks at.",
    },
    evidenceHint: ["shipping_notice"],
    userAssertable: true,
  },
  {
    key: "order.partially_shipped",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Did part of the order ship while another part did not?",
      why: "Only the unshipped part is refunded, and that amount needs a person to check it.",
    },
    evidenceHint: ["shipping_notice"],
    userAssertable: true,
  },
  {
    key: "order.delay_notice_received",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Did the seller email you about a shipping delay (check spam too)?",
      why: "A delay notice that lets you cancel changes when your refund is due.",
    },
    evidenceHint: ["delay_notice"],
    userAssertable: true,
  },
  {
    key: "order.delay_notice_received_at",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "instant",
    question: { prompt: "When did the first delay notice arrive?", why: "A notice sent after the shipping time is not a valid delay offer." },
    evidenceHint: ["delay_notice"],
    userAssertable: true,
  },
  {
    key: "order.delay_revised_ship_kind",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["date", "indefinite"],
    question: {
      prompt: "Did the delay notice give a new ship date, or say it could not give one?",
      why: "A delay of more than 30 days, or an open-ended one, cancels the order unless you agree to it.",
    },
    evidenceHint: ["delay_notice"],
    userAssertable: true,
  },
  {
    key: "order.delay_revised_ship_date",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "local_date",
    question: { prompt: "Which new ship date did the delay notice give?", why: "It decides whether staying silent means you agreed." },
    evidenceHint: ["delay_notice"],
    userAssertable: true,
  },
  {
    key: "order.delay_notice_offers_cancel",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Did the delay notice offer you the choice to cancel and get a prompt refund?",
      why: "A notice without that choice is not the delay offer the rule requires.",
    },
    evidenceHint: ["delay_notice"],
    userAssertable: true,
  },
  {
    key: "order.buyer_response",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: ["no_response", "consented", "cancelled"],
    question: {
      prompt: "How did you answer the delay notice: no reply, agreed to wait, or cancelled?",
      why: "Agreeing to an open-ended delay keeps the order; cancelling before it ships makes a refund due.",
    },
    evidenceHint: ["merchant_correspondence"],
    userAssertable: true,
  },
  {
    key: "order.buyer_response_at",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "instant",
    question: { prompt: "When did you send that answer?", why: "Consent to a long delay counts only within 30 days of the shipping time." },
    evidenceHint: ["merchant_correspondence"],
    userAssertable: true,
  },
  {
    key: "order.ship_to_time_zone",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "code",
    codes: US_TIME_ZONE_IDS,
    question: {
      prompt: "Which time zone is the delivery address in?",
      why: "The shipping days are counted in your local dates.",
    },
    userAssertable: true,
  },
  {
    key: "order.refund_vests_on",
    domain: "order",
    categories: RETAIL,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "When did your right to a refund begin?",
      why: "Recoup works this out from the shipping time and any delay notice; you do not need to enter it.",
    },
    userAssertable: false,
  },
] as const satisfies readonly FactSpec[];
