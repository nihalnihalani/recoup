/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as alerts from "../alerts.js";
import type * as auth from "../auth.js";
import type * as budget from "../budget.js";
import type * as claims from "../claims.js";
import type * as crons from "../crons.js";
import type * as drafts from "../drafts.js";
import type * as examples from "../examples.js";
import type * as followUps from "../followUps.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as insights from "../insights.js";
import type * as intake from "../intake.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_accountState from "../lib/accountState.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_balance from "../lib/balance.js";
import type * as lib_budget from "../lib/budget.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_imageUrl from "../lib/imageUrl.js";
import type * as lib_latestPolicy from "../lib/latestPolicy.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_offerMatch from "../lib/offerMatch.js";
import type * as lib_passage from "../lib/passage.js";
import type * as lib_policyText from "../lib/policyText.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_schemas from "../lib/schemas.js";
import type * as lib_shopsavvy from "../lib/shopsavvy.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_verdict from "../lib/verdict.js";
import type * as lib_watchUrl from "../lib/watchUrl.js";
import type * as limits from "../limits.js";
import type * as mail from "../mail.js";
import type * as market from "../market.js";
import type * as notify from "../notify.js";
import type * as offers from "../offers.js";
import type * as policies from "../policies.js";
import type * as priceWatch from "../priceWatch.js";
import type * as profiles from "../profiles.js";
import type * as purchases from "../purchases.js";
import type * as replies from "../replies.js";
import type * as tracking from "../tracking.js";
import type * as watches from "../watches.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  alerts: typeof alerts;
  auth: typeof auth;
  budget: typeof budget;
  claims: typeof claims;
  crons: typeof crons;
  drafts: typeof drafts;
  examples: typeof examples;
  followUps: typeof followUps;
  http: typeof http;
  inbound: typeof inbound;
  insights: typeof insights;
  intake: typeof intake;
  "lib/access": typeof lib_access;
  "lib/accountState": typeof lib_accountState;
  "lib/ai": typeof lib_ai;
  "lib/balance": typeof lib_balance;
  "lib/budget": typeof lib_budget;
  "lib/errors": typeof lib_errors;
  "lib/imageUrl": typeof lib_imageUrl;
  "lib/latestPolicy": typeof lib_latestPolicy;
  "lib/ledger": typeof lib_ledger;
  "lib/money": typeof lib_money;
  "lib/offerMatch": typeof lib_offerMatch;
  "lib/passage": typeof lib_passage;
  "lib/policyText": typeof lib_policyText;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/schemas": typeof lib_schemas;
  "lib/shopsavvy": typeof lib_shopsavvy;
  "lib/text": typeof lib_text;
  "lib/verdict": typeof lib_verdict;
  "lib/watchUrl": typeof lib_watchUrl;
  limits: typeof limits;
  mail: typeof mail;
  market: typeof market;
  notify: typeof notify;
  offers: typeof offers;
  policies: typeof policies;
  priceWatch: typeof priceWatch;
  profiles: typeof profiles;
  purchases: typeof purchases;
  replies: typeof replies;
  tracking: typeof tracking;
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
