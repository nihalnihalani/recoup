import { ConvexError, v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import type { SearchResponse } from "@firecrawl/firecrawl-convex";
import { action, internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { extract } from "./lib/ai";
import { Policy } from "./lib/schemas";
import type { PolicyT } from "./lib/schemas";
import { verifyPassage } from "./lib/passage";
import { latestPolicy } from "./lib/latestPolicy";
import { assertWindowDays } from "./lib/money";
import { channel, policyKind } from "./schema";
import { requireUserId, ownedPolicy } from "./lib/access";
import { MAX_WATCHES_PER_USER, POLICY_REFETCH_MIN_AGE_MS } from "./limits";
import { normalizeDomain } from "./lib/policyText";
import { charge, tryCharge } from "./lib/budget";
import { clearMerchantItemSchedule } from "./lib/schedule";


const firecrawl = new FirecrawlClient(components.firecrawl);

type PolicyKind = "price_adjustment" | "returns";

const QUERIES: Record<PolicyKind, (d: string) => string> = {
  price_adjustment: (d) => `${d} price adjustment policy price match after purchase`,
  returns: (d) => `${d} return refund policy how long refund takes contact`,
};

const SYSTEM = (kind: PolicyKind) =>
  kind === "price_adjustment"
    ? `You read a retailer's policy page. Determine whether the retailer adjusts the price of an item already purchased when its own price drops. Report the window in days, how to request it (email, form, chat, phone, unknown), a contact email if the page publishes one, and the verbatim passage. Set found=false if the page does not cover price adjustments.`
    : `You read a retailer's returns page. Report how many days after receipt the retailer says a refund is processed or when to contact support (windowDays), the documented channel for refund questions, a published support email if any, and the verbatim passage.`;

/** Injectable dependencies so `researchPolicy` can be unit-tested without a real Firecrawl/OpenAI call. */
export type ResearchDeps = {
  search: (ctx: ActionCtx, query: string, options?: Parameters<FirecrawlClient["search"]>[2]) => Promise<SearchResponse>;
  extract: typeof extract;
};

const defaultDeps: ResearchDeps = {
  search: firecrawl.search.bind(firecrawl),
  extract,
};

/**
 * Plain async helper (no action-in-action, D17): search the merchant's
 * domain for its policy page, extract structured facts, verify the quoted
 * passage against the scraped markdown, and insert an immutable snapshot.
 * Used by both `fetchBoth` (internalAction, scheduler-driven) and `refresh`
 * (public action, user-driven). Never throws: any Firecrawl error or empty
 * result set is itself recorded as a snapshot.
 */
export async function researchPolicy(
  ctx: { runMutation: ActionCtx["runMutation"] },
  args: { userId: Id<"users">; merchantDomain: string; kind: PolicyKind },
  deps: ResearchDeps = defaultDeps,
): Promise<Id<"policies">> {
  const { userId, merchantDomain, kind } = args;

  let hits: Array<{ markdown: string; url?: string; metadata?: { sourceURL?: string } }>;
  try {
    const res = await deps.search(ctx as ActionCtx, QUERIES[kind](merchantDomain), {
      limit: 3,
      includeDomains: [merchantDomain],
      scrapeOptions: { formats: ["markdown"], onlyMainContent: true, maxAge: 86_400_000 },
    });
    hits = (res.web ?? []).filter(
      (h): h is { markdown: string; url?: string; metadata?: { sourceURL?: string } } =>
        typeof (h as { markdown?: unknown }).markdown === "string" && (h as { markdown: string }).markdown.length > 200,
    );
  } catch (err) {
    const detail =
      err instanceof ConvexError
        ? `Firecrawl error (status ${(err.data as { status?: unknown })?.status ?? "unknown"}): ${JSON.stringify(err.data)}`
        : `Firecrawl error: ${err instanceof Error ? err.message : String(err)}`;
    return ctx.runMutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain,
      kind,
      channel: "unknown",
      passage: "",
      sourceUrl: `https://${merchantDomain}`,
      confidence: 0,
      note: detail.slice(0, 300),
    });
  }

  if (hits.length === 0) {
    return ctx.runMutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain,
      kind,
      channel: "unknown",
      passage: "",
      sourceUrl: `https://${merchantDomain}`,
      confidence: 0,
      note: "No policy page found on the merchant's domain",
    });
  }

  let best: { parsed: PolicyT; url: string; markdown: string } | null = null;
  for (const hit of hits) {
    const parsed = await deps.extract("policy", Policy, SYSTEM(kind), hit.markdown);
    const url = hit.url ?? hit.metadata?.sourceURL ?? `https://${merchantDomain}`;
    if (!best || parsed.confidence > best.parsed.confidence) best = { parsed, url, markdown: hit.markdown };
    if (parsed.found && parsed.confidence >= 0.8) break;
  }
  const { parsed: p, url, markdown } = best!;

  const shared = {
    userId,
    merchantDomain,
    kind,
    windowDays: p.windowDays ?? undefined,
    channel: p.channel,
    contactEmail: p.contactEmail ?? undefined,
    sourceUrl: url,
  };

  if (!p.found) {
    // The page loaded but says nothing about this rule (bot wall, region splash, unrelated article).
    return ctx.runMutation(internal.policies.insertSnapshot, {
      ...shared,
      windowDays: undefined,
      channel: "unknown",
      contactEmail: undefined,
      passage: "",
      confidence: 0,
      note: "The pages found do not state this policy. Paste the rule or its link below.",
    });
  }

  const passageStart = verifyPassage(markdown, p.passage);
  if (passageStart === null) {
    return ctx.runMutation(internal.policies.insertSnapshot, {
      ...shared,
      passage: "",
      confidence: 0,
      note: "passage not found verbatim in source",
    });
  }

  return ctx.runMutation(internal.policies.insertSnapshot, {
    ...shared,
    passage: p.passage.slice(0, 600),
    passageStart,
    confidence: p.confidence,
  });
}

/**
 * True when any snapshot for this user+domain+kind was retrieved inside the
 * re-fetch window. Unauthenticated on purpose: the only caller is `fetchBoth`,
 * which the scheduler runs with a `userId` a mutation resolved from `ctx.auth`.
 */
export const hasFreshSnapshot = internalQuery({
  args: { userId: v.id("users"), merchantDomain: v.string(), kind: policyKind },
  returns: v.boolean(),
  handler: async (ctx, { userId, merchantDomain, kind }) => {
    const newest = await ctx.db
      .query("policies")
      .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind))
      .order("desc")
      .first();
    return newest !== null && Date.now() - newest.retrievedAt < POLICY_REFETCH_MIN_AGE_MS;
  },
});

/** The subset of `ActionCtx` `fetchBothImpl` needs -- same shape `researchPolicy` already takes, plus `runQuery`. */
type FetchBothCtx = { runMutation: ActionCtx["runMutation"]; runQuery: ActionCtx["runQuery"] };

/**
 * Scheduler-driven: research both policy kinds for a merchant. Never throws (D17).
 * A kind researched in the last 24h is skipped (review M1): confirming a
 * purchase must not bury the policy the user just confirmed under a failed
 * re-fetch, nor pay for the same search twice. `refresh` is the user's way to force one.
 *
 * 6a-5/D112: unlike `policies.confirm` and `refresh` (both call
 * `clearMerchantItemSchedule`/`clearMerchantSchedule` themselves right after
 * they land a fresh price-adjustment snapshot), this scheduler-driven path
 * used to never un-stamp anything -- an automatic re-research that widens (or
 * newly opens) a merchant's price-adjustment window left every item at that
 * merchant resting behind whatever stamp `priceWatch.eligibleItems` last gave
 * it, for up to `INELIGIBLE_REST_MS`. Fixed the same way: after a
 * `price_adjustment` kind is actually researched (not skipped for being
 * fresh), call `clearMerchantSchedule`. Unconditional on the outcome -- even
 * a failed/unknown snapshot landing is still a snapshot landing, and
 * un-stamping is idempotent and cheap, so there is no reason to parse the
 * result first.
 *
 * Plain, exported, deps-injectable `fetchBothImpl` (mirroring
 * `researchPolicy`'s own `ResearchDeps` seam) so a test can exercise this
 * exact wiring with mocked search/extract instead of live HTTP -- the
 * `internalAction` below is a thin wrapper.
 */
export async function fetchBothImpl(
  ctx: FetchBothCtx,
  args: { userId: Id<"users">; merchantDomain: string },
  deps: ResearchDeps = defaultDeps,
): Promise<void> {
  for (const kind of ["price_adjustment", "returns"] as const) {
    try {
      if (await ctx.runQuery(internal.policies.hasFreshSnapshot, { ...args, kind })) continue;
      await researchPolicy(ctx, { ...args, kind }, deps);
      if (kind === "price_adjustment") {
        await ctx.runMutation(internal.policies.clearMerchantSchedule, args);
      }
    } catch (err) {
      console.error("policies.fetchBoth failed", { merchantDomain: args.merchantDomain, kind, err });
    }
  }
}

export const fetchBoth = internalAction({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await fetchBothImpl(ctx, args);
    return null;
  },
});

/**
 * Schedules `fetchBoth` for a store the caller just added, inside the caller's transaction (review B4). Charged
 * to the shared `policy_fetch` budget and the global policy switch. Over either one the research is skipped
 * rather than the write refused: the purchase is the user's own data, the policy is a paid extra they can still
 * ask for with `refresh` tomorrow. Returns whether the fetch was scheduled.
 */
export async function schedulePolicyFetch(
  ctx: MutationCtx,
  userId: Id<"users">,
  merchantDomain: string,
): Promise<boolean> {
  if (!(await tryCharge(ctx, userId, "policy_fetch"))) return false;
  await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, { userId, merchantDomain });
  return true;
}

/** Always inserts a new immutable snapshot row; never patches (D17). Renamed from the plan's `upsert`. */
export const insertSnapshot = internalMutation({
  args: {
    userId: v.id("users"),
    merchantDomain: v.string(),
    kind: policyKind,
    windowDays: v.optional(v.number()),
    channel,
    contactEmail: v.optional(v.string()),
    passage: v.string(),
    passageStart: v.optional(v.number()),
    sourceUrl: v.string(),
    confidence: v.number(),
    note: v.optional(v.string()),
  },
  returns: v.id("policies"),
  handler: async (ctx, args) => {
    return await ctx.db.insert("policies", { ...args, retrievedAt: Date.now(), confirmedByUser: false });
  },
});

/**
 * The snapshot to act on for a merchant/kind, or null: the newest one the user
 * confirmed, else the newest of any. A confirmed snapshot is the user's own
 * fact, so a newer unconfirmed (possibly failed) fetch never shadows it
 * (review M1). Snapshots stay immutable (D17); this only changes which is read.
 * Plain query helper (not a Convex `query`). Bounded; see lib/latestPolicy.ts.
 */
export async function latest(ctx: QueryCtx, userId: Id<"users">, merchantDomain: string, kind: PolicyKind) {
  return latestPolicy(ctx, userId, merchantDomain, kind);
}

const LIVE_WATCH_STATUSES = ["active", "paused", "bought"] as const;

/**
 * The gate in front of `refresh` (review B3), one transaction: the domain must be a store the caller actually has
 * a real purchase or a live watch at, and the call is charged to `policy_refresh` and the global policy switch.
 * Throws on either, so a refused refresh has spent nothing.
 * Unauthenticated on purpose: the only caller is `refresh`, which resolved `userId` from `ctx.auth`.
 */
export const beginRefresh = internalMutation({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, merchantDomain }) => {
    const purchase = await ctx.db
      .query("purchases")
      .withIndex("by_user_domain_order", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain))
      // Example stores are not real sites (D27); a handful of rows at most share one store.
      .take(50);
    let owns = purchase.some((p) => !p.isExample);
    for (const status of LIVE_WATCH_STATUSES) {
      if (owns) break;
      const watches = await ctx.db
        .query("watches")
        .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", status))
        .take(MAX_WATCHES_PER_USER);
      owns = watches.some((w) => w.merchantDomain === merchantDomain);
    }
    if (!owns) throw new ConvexError("You can only look up policies for stores you have bought from or are watching");
    await charge(ctx, userId, "policy_refresh");
    return null;
  },
});

/**
 * C3(c)/D107: wraps `clearMerchantItemSchedule` for `refresh` (an action,
 * with no `ctx.db` of its own) to call after a fresh price-adjustment
 * snapshot lands. Unauthenticated on purpose: the only caller is `refresh`,
 * which already resolved and owns `userId`.
 */
export const clearMerchantSchedule = internalMutation({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  returns: v.null(),
  handler: async (ctx, { userId, merchantDomain }) => {
    await clearMerchantItemSchedule(ctx, userId, merchantDomain);
    return null;
  },
});

/** User-triggered re-research. Returns the id of the newly inserted snapshot. */
export const refresh = action({
  args: { merchantDomain: v.string(), kind: policyKind },
  returns: v.id("policies"),
  handler: async (ctx, args): Promise<Id<"policies">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!merchantDomain) throw new ConvexError("merchantDomain must be a domain like example.com");
    // Before anything paid: ownership and budget, in one transaction.
    await ctx.runMutation(internal.policies.beginRefresh, { userId, merchantDomain });
    const policyId = await researchPolicy(ctx, { userId, merchantDomain, kind: args.kind });
    // C3(c)/D107: a refreshed price-adjustment snapshot may have just reopened
    // (or newly opened) this merchant's watch window -- see `confirm`'s
    // matching call for why this is scoped to that one kind.
    if (args.kind === "price_adjustment") {
      await ctx.runMutation(internal.policies.clearMerchantSchedule, { userId, merchantDomain });
    }
    return policyId;
  },
});

/** The only mutation that edits a snapshot, and only by its owner (user edits are their own facts, D17). */
export const confirm = mutation({
  args: {
    policyId: v.id("policies"),
    windowDays: v.optional(v.number()),
    channel,
    contactEmail: v.optional(v.string()),
    passage: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, { policyId, ...edits }) => {
    const userId = await requireUserId(ctx);
    const policy = await ownedPolicy(ctx, policyId, userId);
    if (edits.windowDays !== undefined) assertWindowDays(edits.windowDays);
    // D45: a passage or source the user typed is no longer the verified
    // scrape, so the evidence markers are cleared.
    const edited =
      (edits.passage !== undefined && edits.passage !== policy.passage) ||
      (edits.sourceUrl !== undefined && edits.sourceUrl !== policy.sourceUrl);
    await ctx.db.patch(policyId, {
      ...edits,
      confirmedByUser: true,
      ...(edited ? { passageStart: undefined, confidence: 0, userEdited: true } : {}),
    });
    // C3(c)/D107: confirming a price-adjustment snapshot (a fresh windowDays,
    // or one the user just typed in themselves) can reopen this merchant's
    // watch window; un-stamp its items so the next tick reconsiders them
    // instead of resting behind whatever `eligibleItems` last gave them.
    // Confirming a `returns` snapshot never affects price-watch eligibility
    // (see `priceWatch.watchWindow`), so it is not worth the extra reads.
    if (policy.kind === "price_adjustment") {
      await clearMerchantItemSchedule(ctx, userId, policy.merchantDomain);
    }
    return null;
  },
});
