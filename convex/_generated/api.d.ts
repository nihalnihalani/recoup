/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as alerts from "../alerts.js";
import type * as auth from "../auth.js";
import type * as budget from "../budget.js";
import type * as claims from "../claims.js";
import type * as crons from "../crons.js";
import type * as drafts from "../drafts.js";
import type * as evidence from "../evidence.js";
import type * as examples from "../examples.js";
import type * as facts from "../facts.js";
import type * as followUps from "../followUps.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as insights from "../insights.js";
import type * as intake from "../intake.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_accountState from "../lib/accountState.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_amountReview from "../lib/amountReview.js";
import type * as lib_authMail from "../lib/authMail.js";
import type * as lib_authMigrate from "../lib/authMigrate.js";
import type * as lib_balance from "../lib/balance.js";
import type * as lib_blobRefs from "../lib/blobRefs.js";
import type * as lib_budget from "../lib/budget.js";
import type * as lib_canonical from "../lib/canonical.js";
import type * as lib_claimState from "../lib/claimState.js";
import type * as lib_deadlines_calendar from "../lib/deadlines/calendar.js";
import type * as lib_deadlines_engine from "../lib/deadlines/engine.js";
import type * as lib_deadlines_usFederalHolidays from "../lib/deadlines/usFederalHolidays.js";
import type * as lib_deadlines_usZones from "../lib/deadlines/usZones.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_facts_catalog from "../lib/facts/catalog.js";
import type * as lib_facts_keys_air from "../lib/facts/keys_air.js";
import type * as lib_facts_keys_card from "../lib/facts/keys_card.js";
import type * as lib_facts_keys_order from "../lib/facts/keys_order.js";
import type * as lib_facts_keys_retail from "../lib/facts/keys_retail.js";
import type * as lib_facts_legacyRetail from "../lib/facts/legacyRetail.js";
import type * as lib_facts_resolve from "../lib/facts/resolve.js";
import type * as lib_facts_snapshot_air from "../lib/facts/snapshot_air.js";
import type * as lib_facts_snapshot_order from "../lib/facts/snapshot_order.js";
import type * as lib_facts_snapshot_retail from "../lib/facts/snapshot_retail.js";
import type * as lib_facts_subject from "../lib/facts/subject.js";
import type * as lib_facts_values from "../lib/facts/values.js";
import type * as lib_facts_write from "../lib/facts/write.js";
import type * as lib_flags from "../lib/flags.js";
import type * as lib_freshness from "../lib/freshness.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_imageUrl from "../lib/imageUrl.js";
import type * as lib_latestPolicy from "../lib/latestPolicy.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_log from "../lib/log.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_offerMatch from "../lib/offerMatch.js";
import type * as lib_opportunityClosure from "../lib/opportunityClosure.js";
import type * as lib_pan from "../lib/pan.js";
import type * as lib_passage from "../lib/passage.js";
import type * as lib_policyText from "../lib/policyText.js";
import type * as lib_privacyFacts from "../lib/privacyFacts.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_rules_activation from "../lib/rules/activation.js";
import type * as lib_rules_applicable from "../lib/rules/applicable.js";
import type * as lib_rules_conditions from "../lib/rules/conditions.js";
import type * as lib_rules_coverage from "../lib/rules/coverage.js";
import type * as lib_rules_outcome from "../lib/rules/outcome.js";
import type * as lib_rules_r01_price_adjustment_v1 from "../lib/rules/r01_price_adjustment_v1.js";
import type * as lib_rules_r02_air_refund_v1 from "../lib/rules/r02_air_refund_v1.js";
import type * as lib_rules_r05_late_order_v1 from "../lib/rules/r05_late_order_v1.js";
import type * as lib_rules_registry from "../lib/rules/registry.js";
import type * as lib_rules_testRegistry from "../lib/rules/testRegistry.js";
import type * as lib_rules_types from "../lib/rules/types.js";
import type * as lib_rules_verification from "../lib/rules/verification.js";
import type * as lib_schedule from "../lib/schedule.js";
import type * as lib_schemas from "../lib/schemas.js";
import type * as lib_shopsavvy from "../lib/shopsavvy.js";
import type * as lib_sniff from "../lib/sniff.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_verdict from "../lib/verdict.js";
import type * as lib_watchUrl from "../lib/watchUrl.js";
import type * as limits from "../limits.js";
import type * as mail from "../mail.js";
import type * as mailEvents from "../mailEvents.js";
import type * as mailPurge from "../mailPurge.js";
import type * as market from "../market.js";
import type * as migrations from "../migrations.js";
import type * as notify from "../notify.js";
import type * as offers from "../offers.js";
import type * as opportunities from "../opportunities.js";
import type * as ops from "../ops.js";
import type * as policies from "../policies.js";
import type * as priceWatch from "../priceWatch.js";
import type * as profiles from "../profiles.js";
import type * as purchases from "../purchases.js";
import type * as recovery from "../recovery.js";
import type * as replies from "../replies.js";
import type * as retention from "../retention.js";
import type * as testing from "../testing.js";
import type * as tracking from "../tracking.js";
import type * as transactions from "../transactions.js";
import type * as watches from "../watches.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  alerts: typeof alerts;
  auth: typeof auth;
  budget: typeof budget;
  claims: typeof claims;
  crons: typeof crons;
  drafts: typeof drafts;
  evidence: typeof evidence;
  examples: typeof examples;
  facts: typeof facts;
  followUps: typeof followUps;
  http: typeof http;
  inbound: typeof inbound;
  insights: typeof insights;
  intake: typeof intake;
  "lib/access": typeof lib_access;
  "lib/accountState": typeof lib_accountState;
  "lib/ai": typeof lib_ai;
  "lib/amountReview": typeof lib_amountReview;
  "lib/authMail": typeof lib_authMail;
  "lib/authMigrate": typeof lib_authMigrate;
  "lib/balance": typeof lib_balance;
  "lib/blobRefs": typeof lib_blobRefs;
  "lib/budget": typeof lib_budget;
  "lib/canonical": typeof lib_canonical;
  "lib/claimState": typeof lib_claimState;
  "lib/deadlines/calendar": typeof lib_deadlines_calendar;
  "lib/deadlines/engine": typeof lib_deadlines_engine;
  "lib/deadlines/usFederalHolidays": typeof lib_deadlines_usFederalHolidays;
  "lib/deadlines/usZones": typeof lib_deadlines_usZones;
  "lib/email": typeof lib_email;
  "lib/errors": typeof lib_errors;
  "lib/facts/catalog": typeof lib_facts_catalog;
  "lib/facts/keys_air": typeof lib_facts_keys_air;
  "lib/facts/keys_card": typeof lib_facts_keys_card;
  "lib/facts/keys_order": typeof lib_facts_keys_order;
  "lib/facts/keys_retail": typeof lib_facts_keys_retail;
  "lib/facts/legacyRetail": typeof lib_facts_legacyRetail;
  "lib/facts/resolve": typeof lib_facts_resolve;
  "lib/facts/snapshot_air": typeof lib_facts_snapshot_air;
  "lib/facts/snapshot_order": typeof lib_facts_snapshot_order;
  "lib/facts/snapshot_retail": typeof lib_facts_snapshot_retail;
  "lib/facts/subject": typeof lib_facts_subject;
  "lib/facts/values": typeof lib_facts_values;
  "lib/facts/write": typeof lib_facts_write;
  "lib/flags": typeof lib_flags;
  "lib/freshness": typeof lib_freshness;
  "lib/idempotency": typeof lib_idempotency;
  "lib/imageUrl": typeof lib_imageUrl;
  "lib/latestPolicy": typeof lib_latestPolicy;
  "lib/ledger": typeof lib_ledger;
  "lib/log": typeof lib_log;
  "lib/money": typeof lib_money;
  "lib/offerMatch": typeof lib_offerMatch;
  "lib/opportunityClosure": typeof lib_opportunityClosure;
  "lib/pan": typeof lib_pan;
  "lib/passage": typeof lib_passage;
  "lib/policyText": typeof lib_policyText;
  "lib/privacyFacts": typeof lib_privacyFacts;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/rules/activation": typeof lib_rules_activation;
  "lib/rules/applicable": typeof lib_rules_applicable;
  "lib/rules/conditions": typeof lib_rules_conditions;
  "lib/rules/coverage": typeof lib_rules_coverage;
  "lib/rules/outcome": typeof lib_rules_outcome;
  "lib/rules/r01_price_adjustment_v1": typeof lib_rules_r01_price_adjustment_v1;
  "lib/rules/r02_air_refund_v1": typeof lib_rules_r02_air_refund_v1;
  "lib/rules/r05_late_order_v1": typeof lib_rules_r05_late_order_v1;
  "lib/rules/registry": typeof lib_rules_registry;
  "lib/rules/testRegistry": typeof lib_rules_testRegistry;
  "lib/rules/types": typeof lib_rules_types;
  "lib/rules/verification": typeof lib_rules_verification;
  "lib/schedule": typeof lib_schedule;
  "lib/schemas": typeof lib_schemas;
  "lib/shopsavvy": typeof lib_shopsavvy;
  "lib/sniff": typeof lib_sniff;
  "lib/text": typeof lib_text;
  "lib/verdict": typeof lib_verdict;
  "lib/watchUrl": typeof lib_watchUrl;
  limits: typeof limits;
  mail: typeof mail;
  mailEvents: typeof mailEvents;
  mailPurge: typeof mailPurge;
  market: typeof market;
  migrations: typeof migrations;
  notify: typeof notify;
  offers: typeof offers;
  opportunities: typeof opportunities;
  ops: typeof ops;
  policies: typeof policies;
  priceWatch: typeof priceWatch;
  profiles: typeof profiles;
  purchases: typeof purchases;
  recovery: typeof recovery;
  replies: typeof replies;
  retention: typeof retention;
  testing: typeof testing;
  tracking: typeof tracking;
  transactions: typeof transactions;
  watches: typeof watches;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
