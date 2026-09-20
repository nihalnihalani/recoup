/**
 * Merchant policy research (T08).
 *
 * `policies` rows are immutable snapshots (D17): every refresh INSERTS a new
 * row and readers take the latest per kind. Nothing in this file patches a
 * previous snapshot except `confirm`, which flips `confirmedByUser` on the one
 * snapshot the user is looking at.
 *
 * The research path is Firecrawl search (restricted to the merchant's own
 * domain) → scrape → OpenAI structured extraction → verbatim passage check.
 * Every failure mode ends as a stored snapshot with `channel: "unknown"`,
 * `confidence: 0` and a human-readable `note`, never an unhandled throw
 * (ARCHITECTURE_PATTERNS §Actions calling external APIs).
 */
import { ConvexError, v } from "convex/values";
import { FirecrawlClient, type ScrapeOptions } from "@firecrawl/firecrawl-convex";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { components, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { channel, policyKind } from "./schema";
import { Policy } from "./lib/schemas";
import { extract } from "./lib/ai";
import {
  chooseBestResult,
  hitMarkdown,
  isEmail,
  locatePassage,
  normalizeDomain,
  sanitizeWindowDays,
  type PolicyKind,
  type SearchHit,
} from "./lib/policyText";

const firecrawl = new FirecrawlClient(components.firecrawl);

const KINDS = ["price_adjustment", "returns"] as const;

/**
 * Scrape settings tuned against real retailer help centres (verified live
 * against bestbuy.com on 2026-09-20):
 *  - `location` routes through a US IP. Without it big retailers serve a
 *    "choose a country" interstitial to the datacenter, and the extractor
 *    correctly reports `found: false` on a page that never had the policy.
 *  - `onlyMainContent: false` + `waitFor`: these pages render the policy body
 *    client-side and sit outside the main-content heuristic. With
 *    `onlyMainContent: true` BestBuy's returns page yields 54 characters;
 *    with these settings, 26k. `extract()` caps the model input anyway.
 *  - `maxAge` reuses Firecrawl's cache for a day; policy pages do not move
 *    hourly, and a snapshot records its own `retrievedAt`.
 */
function scrapeOptions(): ScrapeOptions {
  return {
    formats: ["markdown"],
    onlyMainContent: false,
    waitFor: 3_000,
    maxAge: 86_400_000,
    location: { country: "us", languages: ["en-US"] },
    proxy: "auto",
  };
}
/** Below this a "page" is a cookie banner or an error page, not a policy. */
const MIN_PAGE_CHARS = 200;
const MAX_NOTE_CHARS = 500;

const SEARCH_QUERY: Record<PolicyKind, (domain: string) => string> = {
  price_adjustment: (d) => `${d} price adjustment policy price match after purchase`,
  returns: (d) => `${d} return refund policy how long refund takes contact`,
};

const SYSTEM: Record<PolicyKind, string> = {
  price_adjustment:
    "You read a retailer's policy page. Determine whether the retailer adjusts the price of an item already purchased when its own price drops. Report the window in days, how to request it (email, form, chat, phone, unknown), a contact email if the page publishes one, and a passage copied VERBATIM from the page. Set found=false if the page does not cover price adjustments. Never paraphrase the passage: copy it character for character.",
  returns:
    "You read a retailer's returns page. Report how many days after purchase or receipt the retailer accepts returns or processes a refund (windowDays), the documented channel for refund questions (email, form, chat, phone, unknown), a published support email if any, and a passage copied VERBATIM from the page. Set found=false if the page does not cover returns or refunds. Never paraphrase the passage: copy it character for character.",
};

/** The shape every reader of a policy snapshot gets back. */
export const policySnapshot = v.object({
  _id: v.id("policies"),
  _creationTime: v.number(),
  userId: v.id("users"),
  merchantDomain: v.string(),
  kind: policyKind,
  windowDays: v.optional(v.number()),
  channel,
  contactEmail: v.optional(v.string()),
  passage: v.string(),
  passageStart: v.optional(v.number()),
  sourceUrl: v.string(),
  retrievedAt: v.number(),
  confidence: v.number(),
  confirmedByUser: v.boolean(),
  note: v.optional(v.string()),
  isExample: v.optional(v.boolean()),
});

function requireDomain(input: string): string {
  const domain = normalizeDomain(input);
  if (!domain) throw new ConvexError("Not a valid merchant domain");
  return domain;
}

function errorNote(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${message}`.slice(0, MAX_NOTE_CHARS);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Inserts one immutable snapshot (D17). Unauthenticated on purpose: called
 * only by `fetchOne`/`fetchBoth`, which take the userId from the mutation that
 * scheduled them, and by tests.
 */
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
    confirmedByUser: v.optional(v.boolean()),
    note: v.optional(v.string()),
    isExample: v.optional(v.boolean()),
  },
  returns: v.id("policies"),
  handler: async (ctx, args) => {
    const { confirmedByUser, ...rest } = args;
    return await ctx.db.insert("policies", {
      ...rest,
      retrievedAt: Date.now(),
      confirmedByUser: confirmedByUser ?? false,
    });
  },
});

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

type Snapshot = {
  windowDays?: number;
  channel: "email" | "form" | "chat" | "phone" | "unknown";
  contactEmail?: string;
  passage: string;
  passageStart?: number;
  sourceUrl: string;
  confidence: number;
  note?: string;
};

/**
 * Searches, scrapes and extracts one policy, then stores the result. Returns
 * the id of the snapshot it wrote. Never throws: an unreachable merchant, a
 * dead API key or a paraphrasing model all become a `confidence: 0` snapshot
 * with a note, so the UI always has something to show and a card to refresh.
 */
async function researchOne(
  ctx: ActionCtx,
  args: { userId: Id<"users">; merchantDomain: string; kind: PolicyKind },
): Promise<Id<"policies">> {
  const { userId, merchantDomain, kind } = args;
  const fallbackUrl = `https://${merchantDomain}`;
  let snapshot: Snapshot;
  try {
    snapshot = await gatherPolicy(ctx, merchantDomain, kind);
  } catch (err) {
    console.error(`policies.researchOne failed for ${merchantDomain} (${kind})`, err);
    snapshot = {
      channel: "unknown",
      passage: "",
      sourceUrl: fallbackUrl,
      confidence: 0,
      note: errorNote("Policy research failed", err),
    };
  }
  return await ctx.runMutation(internal.policies.insertSnapshot, {
    userId,
    merchantDomain,
    kind,
    ...snapshot,
  });
}

async function gatherPolicy(
  ctx: ActionCtx,
  merchantDomain: string,
  kind: PolicyKind,
): Promise<Snapshot> {
  const fallbackUrl = `https://${merchantDomain}`;
  const response = await firecrawl.search(ctx, SEARCH_QUERY[kind](merchantDomain), {
    limit: 5,
    sources: ["web"],
    includeDomains: [merchantDomain],
    scrapeOptions: scrapeOptions(),
  });
  const hits = (response.web ?? []) as SearchHit[];
  const best = chooseBestResult(hits, { domain: merchantDomain, kind });
  if (!best) {
    return {
      channel: "unknown",
      passage: "",
      sourceUrl: fallbackUrl,
      confidence: 0,
      note: "No policy page found on the merchant's own domain.",
    };
  }

  // Search usually scrapes inline; fall back to an explicit scrape when it did not.
  let markdown = best.markdown;
  if (!markdown || markdown.length < MIN_PAGE_CHARS) {
    const page = await firecrawl.scrape(ctx, best.url, scrapeOptions());
    markdown = hitMarkdown(page as SearchHit);
  }
  if (!markdown || markdown.length < MIN_PAGE_CHARS) {
    return {
      channel: "unknown",
      passage: "",
      sourceUrl: best.url,
      confidence: 0,
      note: "The policy page could not be read.",
    };
  }

  const parsed = await extract("policy", Policy, SYSTEM[kind], markdown);
  if (!parsed.found) {
    return {
      channel: "unknown",
      passage: "",
      sourceUrl: best.url,
      confidence: 0,
      note: "The page does not state this policy.",
    };
  }

  // D17: a passage is evidence only if the model copied it off the page.
  const located = locatePassage(markdown, parsed.passage);
  if (!located) {
    return {
      channel: "unknown",
      passage: "",
      sourceUrl: best.url,
      confidence: 0,
      note: "passage not found verbatim",
    };
  }

  const contactEmail = parsed.contactEmail && isEmail(parsed.contactEmail)
    ? parsed.contactEmail.trim()
    : undefined;
  return {
    windowDays: sanitizeWindowDays(parsed.windowDays),
    channel: parsed.channel,
    contactEmail,
    passage: located.passage,
    passageStart: located.passageStart,
    sourceUrl: best.url,
    confidence: Math.min(1, Math.max(0, parsed.confidence)),
  };
}

/** Researches one policy kind for one merchant. Scheduled, or called by `fetchBoth`. */
export const fetchOne = internalAction({
  args: { userId: v.id("users"), merchantDomain: v.string(), kind: policyKind },
  returns: v.id("policies"),
  handler: async (ctx, args) =>
    await researchOne(ctx, {
      userId: args.userId,
      merchantDomain: normalizeDomain(args.merchantDomain) ?? args.merchantDomain,
      kind: args.kind,
    }),
});

/**
 * Researches both policy kinds for a merchant. `purchases` schedules this by
 * name on confirmation, so the name and args are a contract with that lane.
 */
export const fetchBoth = internalAction({
  args: { userId: v.id("users"), merchantDomain: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!merchantDomain) {
      console.error(`policies.fetchBoth: not a valid domain: ${args.merchantDomain}`);
      return null;
    }
    for (const kind of KINDS) {
      await researchOne(ctx, { userId: args.userId, merchantDomain, kind });
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Public surface (identity always from ctx.auth, never from an argument)
// ---------------------------------------------------------------------------

async function requireUserId(ctx: QueryCtx | MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  return userId;
}

/** Kicks off a fresh research pass for the signed-in user's view of a merchant. */
export const refresh = mutation({
  args: { merchantDomain: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const merchantDomain = requireDomain(args.merchantDomain);
    await ctx.scheduler.runAfter(0, internal.policies.fetchBoth, { userId, merchantDomain });
    return null;
  },
});

/** Marks one snapshot as confirmed by its owner (D18 gates recipients on this). */
export const confirm = mutation({
  args: { policyId: v.id("policies") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const policy = await ctx.db.get(args.policyId);
    if (!policy || policy.userId !== userId) throw new ConvexError("Policy not found");
    await ctx.db.patch(args.policyId, { confirmedByUser: true });
    return null;
  },
});

/**
 * The user pastes the policy themselves. Creates a new, user-confirmed
 * snapshot — it never edits a researched one, so the research trail survives.
 */
export const setManual = mutation({
  args: {
    merchantDomain: v.string(),
    kind: policyKind,
    windowDays: v.optional(v.number()),
    channel: v.optional(channel),
    contactEmail: v.optional(v.string()),
    passage: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
  },
  returns: v.id("policies"),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const merchantDomain = requireDomain(args.merchantDomain);
    const passage = (args.passage ?? "").trim().slice(0, 600);
    const windowDays = sanitizeWindowDays(args.windowDays);
    if (args.windowDays !== undefined && windowDays === undefined) {
      throw new ConvexError("Window must be a whole number of days between 1 and 3650");
    }
    const contactEmail = args.contactEmail?.trim();
    if (contactEmail !== undefined && contactEmail.length > 0 && !isEmail(contactEmail)) {
      throw new ConvexError("Not a valid contact email");
    }
    let sourceUrl = `https://${merchantDomain}`;
    if (args.sourceUrl !== undefined && args.sourceUrl.trim().length > 0) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(args.sourceUrl.trim());
      } catch {
        throw new ConvexError("Not a valid policy URL");
      }
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new ConvexError("Not a valid policy URL");
      }
      sourceUrl = parsedUrl.toString();
    }
    if (
      passage.length === 0 &&
      windowDays === undefined &&
      !contactEmail &&
      args.sourceUrl === undefined
    ) {
      throw new ConvexError("Enter a policy URL, a window, a contact or a passage");
    }
    return await ctx.db.insert("policies", {
      userId,
      merchantDomain,
      kind: args.kind,
      windowDays,
      channel: args.channel ?? "unknown",
      contactEmail: contactEmail && contactEmail.length > 0 ? contactEmail : undefined,
      // A pasted passage was not located in a scrape, so it carries no offset.
      passage,
      sourceUrl,
      retrievedAt: Date.now(),
      confidence: 1,
      confirmedByUser: true,
      note: "Entered by you",
    });
  },
});

/**
 * The latest snapshot per kind for one merchant, for the signed-in user.
 * Returns nulls (never throws) so the UI can branch on a signed-out caller.
 */
export const latestForDomain = query({
  args: { merchantDomain: v.string() },
  returns: v.object({
    price_adjustment: v.union(policySnapshot, v.null()),
    returns: v.union(policySnapshot, v.null()),
  }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const merchantDomain = normalizeDomain(args.merchantDomain);
    if (!userId || !merchantDomain) return { price_adjustment: null, returns: null };
    const [priceAdjustment, returns] = await Promise.all(
      KINDS.map((kind) =>
        ctx.db
          .query("policies")
          .withIndex("by_user_domain_kind", (q) =>
            q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind),
          )
          .order("desc")
          .first(),
      ),
    );
    return { price_adjustment: priceAdjustment ?? null, returns: returns ?? null };
  },
});
