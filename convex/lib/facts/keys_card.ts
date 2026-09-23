/**
 * Card-charge keys (M21, wave 2): the facts R03 v1 (Fair Credit Billing Act / Regulation Z §1026.13;
 * docs/rules/R03-credit-card-billing-error.md §5) reads. A `card_charge` transaction is ONE statement line (DA-A-30:
 * the natural key carries a per-line identity, so two identical duplicate-charge lines are two transactions), so every
 * key lives on the transaction itself (subject `txn`).
 *
 * The spec's `disputed_transaction` object is split into scalar keys (`card.charge_date`, `card.merchant_descriptor`,
 * `card.charge_amount`, and `card.correct_amount` for wrong-amount / computational errors); `delivery_evidence` into
 * `card.delivery_promised_by`, `card.delivery_status`, `card.delivered_at` and `card.delivery_tracking_summary`.
 * Calendar-date facts are `local_date` values: the 60-day window is day arithmetic on the dates the creditor states
 * (transmittal) and records (receipt) — spec §11 "Calendar-day zone". "I don't know" is the fact layer's
 * `user_unknown`, so the spec's `unknown` enum members are not codes here.
 *
 * `card.payment_instrument_class` is shared with R05 (the refund form and the R03 alternative depend on it), so it is
 * catalogued for retail orders too. Keys are never renamed.
 */
import type { FactSpec } from "./catalog";
import { US_TIME_ZONE_IDS } from "./keys_order";

const CARD = ["card_charge"] as const;
const TXN = ["transaction"] as const;
const STATEMENT = ["card_statement"] as const;
const DELIVERY_DOCS = ["order_confirmation", "shipping_notice", "delivery_notice"] as const;

export const CARD_FACT_SPECS = [
  {
    key: "card.payment_instrument_class",
    domain: "card",
    categories: ["card_charge", "retail_order"],
    subject: TXN,
    value: "code",
    codes: [
      "consumer_credit_card", "consumer_open_end_other", "business_credit_card", "debit_card", "prepaid", "ach", "p2p", "bnpl",
    ],
    question: {
      prompt: "How did you pay: a personal credit card, a business card, a debit card, or something else?",
      why: "The credit-card billing-error rights cover personal credit cards; debit cards follow a different federal rule.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.error_type",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "code",
    codes: [
      "unauthorized_charge", "duplicate_charge", "wrong_amount", "not_delivered_as_agreed", "not_accepted",
      "credit_issued_not_reflected", "promised_credit_not_issued", "computational_error", "clarification_request",
      "statement_not_sent", "quality_dispute_accepted_goods",
    ],
    question: {
      prompt: "What is wrong with this charge?",
      why: "Each kind of billing error has its own rules and its own start date for the 60-day window.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.charge_date",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: { prompt: "What date does the statement show for this charge?", why: "Your notice names the date of the charge." },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.merchant_descriptor",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "text",
    question: { prompt: "How is the merchant named on the statement line?", why: "Your notice identifies the charge the way the statement does." },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.charge_amount",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "money",
    question: { prompt: "What amount does the statement line show?", why: "The disputed amount is based on it." },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.correct_amount",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "money",
    question: {
      prompt: "What should the charge have been?",
      why: "For a wrong amount, the disputed amount is the difference.",
    },
    evidenceHint: ["receipt", "order_confirmation"],
    userAssertable: true,
  },
  {
    key: "card.first_statement_transmitted_on",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "When was the first statement showing this problem sent or made available to you?",
      why: "Your notice must reach the card issuer within 60 days of that date; the closing date is not the start date.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.statement_closing_date",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "What is the closing date on that statement?",
      why: "It helps find the statement; the 60 days count from when the statement was sent, not from the closing date.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.posting_date",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "When did the charge post to your account?",
      why: "Until the statement date is known, Recoup shows the earliest possible deadline from it.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.credit_issue_date",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "When did the merchant issue the refund or credit?",
      why: "A missing credit is disputed from the statement it should have appeared on.",
    },
    evidenceHint: ["refund_notice", "merchant_correspondence"],
    userAssertable: true,
  },
  {
    key: "card.billing_error_address",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "text",
    question: {
      prompt: "What is the billing-error address printed on your statement (not the payment address)?",
      why: "The notice counts only when it arrives at that address.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.billing_address_time_zone",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "code",
    codes: US_TIME_ZONE_IDS,
    question: {
      prompt: "Which time zone is the billing-error address in?",
      why: "The last day of the window ends at midnight there.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.electronic_notice_stipulated",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Does your statement's billing-rights section say the issuer accepts billing-error notices electronically, and how?",
      why: "Only an electronic channel the issuer names there counts as written notice; an ordinary email does not.",
    },
    evidenceHint: STATEMENT,
    userAssertable: true,
  },
  {
    key: "card.notice_channel_planned",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "code",
    codes: ["mail_to_billing_error_address", "stipulated_electronic", "email_customer_service", "phone", "app_dispute_button"],
    question: {
      prompt: "How do you plan to send the notice?",
      why: "A phone call or an ordinary email does not preserve your formal billing-error rights.",
    },
    userAssertable: true,
  },
  {
    key: "card.notice_received_on",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: {
      prompt: "On what date did the card issuer receive your notice?",
      why: "The notice counts only if it arrived within 60 days; a return receipt shows the date.",
    },
    evidenceHint: ["submission_proof"],
    userAssertable: true,
  },
  {
    key: "card.merchant_contacted",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Have you already contacted the merchant about this?",
      why: "You do not have to; it only changes what your letter says.",
    },
    evidenceHint: ["merchant_correspondence"],
    userAssertable: true,
  },
  {
    key: "card.delivery_promised_by",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "local_date",
    question: { prompt: "By when was the order promised to arrive?", why: "Late or missing delivery is judged against what was agreed." },
    evidenceHint: DELIVERY_DOCS,
    userAssertable: true,
  },
  {
    key: "card.delivery_status",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "code",
    codes: ["not_delivered", "delivered", "delivered_late", "wrong_goods", "wrong_quantity", "wrong_location", "refused"],
    question: {
      prompt: "What happened with the delivery?",
      why: "The card issuer may not deny a non-delivery claim without checking that the goods were delivered as agreed.",
    },
    evidenceHint: DELIVERY_DOCS,
    userAssertable: true,
  },
  {
    key: "card.delivered_at",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "instant",
    question: { prompt: "When was it delivered?", why: "A delivery after the agreed date can still be a billing error." },
    evidenceHint: DELIVERY_DOCS,
    userAssertable: true,
  },
  {
    key: "card.delivery_tracking_summary",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "text",
    question: {
      prompt: "What does the tracking show?",
      why: "Tracking records are the evidence for a delivery problem.",
    },
    evidenceHint: DELIVERY_DOCS,
    userAssertable: true,
  },
  {
    key: "card.existing_dispute_open",
    domain: "card",
    categories: CARD,
    subject: TXN,
    value: "bool",
    question: {
      prompt: "Do you already have a dispute open with the card issuer for this charge?",
      why: "Recoup will not prepare a second notice for the same charge.",
    },
    userAssertable: true,
  },
] as const satisfies readonly FactSpec[];
