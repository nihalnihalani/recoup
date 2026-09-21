/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as claims from "../claims.js";
import type * as crons from "../crons.js";
import type * as drafts from "../drafts.js";
import type * as examples from "../examples.js";
import type * as followUps from "../followUps.js";
import type * as http from "../http.js";
import type * as inbound from "../inbound.js";
import type * as intake from "../intake.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_ai from "../lib/ai.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_passage from "../lib/passage.js";
import type * as lib_schemas from "../lib/schemas.js";
import type * as mail from "../mail.js";
import type * as policies from "../policies.js";
import type * as priceWatch from "../priceWatch.js";
import type * as profiles from "../profiles.js";
import type * as purchases from "../purchases.js";
import type * as replies from "../replies.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  claims: typeof claims;
  crons: typeof crons;
  drafts: typeof drafts;
  examples: typeof examples;
  followUps: typeof followUps;
  http: typeof http;
  inbound: typeof inbound;
  intake: typeof intake;
  "lib/access": typeof lib_access;
  "lib/ai": typeof lib_ai;
  "lib/ledger": typeof lib_ledger;
  "lib/money": typeof lib_money;
  "lib/passage": typeof lib_passage;
  "lib/schemas": typeof lib_schemas;
  mail: typeof mail;
  policies: typeof policies;
  priceWatch: typeof priceWatch;
  profiles: typeof profiles;
  purchases: typeof purchases;
  replies: typeof replies;
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
};
