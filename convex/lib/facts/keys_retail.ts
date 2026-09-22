/**
 * Retail-order fact keys (M11, wave 1). They cover what the legacy retail adapter reads from `purchases` / `items` /
 * `priceChecks` (`lib/facts/legacyRetail.ts`) and R01 v1's FactRequirements (contract §2.7): the policy-derived
 * parameters (`window_days`, `policy_confirmed`, `policy_temporal`) are catalogued so packs can name them, but only
 * the pack's parameter source supplies them — the user never asserts them.
 *
 * Fixture alignment: these are the key names used by `docs/rules/fixtures/R01.json`. Keys are never renamed.
 */
import type { FactSpec } from "./catalog";

const RETAIL = ["retail_order"] as const;
const ORDER_DOCS = ["order_confirmation", "receipt"] as const;

export const RETAIL_FACT_SPECS = [
  {
    key: "retail.merchant",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "text",
    question: { prompt: "Which store did you buy from?", why: "Each store has its own price-adjustment policy." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.order_ref",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "identifier",
    identifierScheme: "order_ref",
    question: { prompt: "What is the order number?", why: "The store uses it to find your purchase." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.purchase_date",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "instant",
    question: {
      prompt: "When did you buy it?",
      why: "Price-adjustment windows count from the purchase date.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.currency",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "code",
    codes: "iso4217",
    question: {
      prompt: "Which currency did you pay in?",
      why: "Recoup never converts currencies, so a price drop only counts in the currency you paid.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.item_name",
    domain: "retail",
    categories: RETAIL,
    subject: ["item"],
    value: "text",
    question: { prompt: "What is the item called on your receipt?", why: "A price only counts for the exact item you bought." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.quantity",
    domain: "retail",
    categories: RETAIL,
    subject: ["item"],
    value: "count",
    min: 1,
    max: 100_000,
    question: { prompt: "How many did you buy?", why: "The difference is owed per unit." },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.unit_price",
    domain: "retail",
    categories: RETAIL,
    subject: ["item"],
    value: "money",
    currencyMode: "legacy_r01",
    question: {
      prompt: "What did you pay for one unit, before tax?",
      why: "The adjustment is the difference between what you paid and the lower price.",
    },
    evidenceHint: ORDER_DOCS,
    userAssertable: true,
  },
  {
    key: "retail.observed_price",
    domain: "retail",
    categories: RETAIL,
    subject: ["item"],
    value: "money",
    currencyMode: "legacy_r01",
    question: {
      prompt: "What is the store's current price?",
      why: "Recoup reads it from the store's product page; you do not need to enter it.",
    },
    userAssertable: false,
  },
  {
    key: "retail.window_days",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "count",
    max: 3650,
    question: {
      prompt: "How many days does the store's price-adjustment window last?",
      why: "It comes from the store's policy page, not from you.",
    },
    evidenceHint: ["policy_page"],
    userAssertable: false,
  },
  {
    key: "retail.policy_confirmed",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "bool",
    question: {
      prompt: "Have you checked the store's price-adjustment policy?",
      why: "Confirm it on the purchase page; until then the result carries that assumption.",
    },
    evidenceHint: ["policy_page"],
    userAssertable: false,
  },
  {
    key: "retail.policy_temporal",
    domain: "retail",
    categories: RETAIL,
    subject: ["transaction"],
    value: "code",
    codes: ["A-T1", "A-T2"],
    question: {
      prompt: "Was the policy text retrieved near your purchase date?",
      why: "Recoup works this out from when the policy page was read (assumption A-T1 / A-T2).",
    },
    userAssertable: false,
  },
] as const satisfies readonly FactSpec[];
