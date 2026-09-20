import { ConvexError, v } from "convex/values";
import { FirecrawlClient } from "@firecrawl/firecrawl-convex";
import type { SearchResponse } from "@firecrawl/firecrawl-convex";
import { action, internalAction, internalMutation, mutation } from "./_generated/server";
import type { ActionCtx, QueryCtx } from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { extract } from "./lib/ai";
import { Policy } from "./lib/schemas";
import type { PolicyT } from "./lib/schemas";
import { verifyPassage } from "./lib/passage";
import { assertWindowDays } from "./lib/money";
import { channel, policyKind } from "./schema";
import { requireUserId, ownedPolicy } from "./lib/access";

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

/** Scheduler-driven: research both policy kinds for a merchant. Never throws (D17). */
export const fetchBoth = internalAction({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  handler: async (ctx, args) => {
    for (const kind of ["price_adjustment", "returns"] as const) {
      try {
        await researchPolicy(ctx, { ...args, kind });
      } catch (err) {
        console.error("policies.fetchBoth failed", { merchantDomain: args.merchantDomain, kind, err });
      }
    }
  },
});

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
  handler: async (ctx, args) => {
    return ctx.db.insert("policies", { ...args, retrievedAt: Date.now(), confirmedByUser: false });
  },
});

/** Newest snapshot for a merchant/kind, or null. Plain query helper (not a Convex `query`). */
export async function latest(ctx: QueryCtx, userId: Id<"users">, merchantDomain: string, kind: PolicyKind) {
  return ctx.db
    .query("policies")
    .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind))
    .order("desc")
    .first();
}

/** User-triggered re-research. Returns the id of the newly inserted snapshot. */
export const refresh = action({
  args: { merchantDomain: v.string(), kind: policyKind },
  handler: async (ctx, args): Promise<Id<"policies">> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Not signed in");
    return researchPolicy(ctx, { userId, merchantDomain: args.merchantDomain, kind: args.kind });
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
    return null;
  },
});
