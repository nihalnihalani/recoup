import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

type PolicyKind = Doc<"policies">["kind"];

/** How many recent snapshots to look through for a user-confirmed one. */
const LATEST_SCAN = 20;

/**
 * The policy to show and act on for a merchant: the newest snapshot the user
 * confirmed, else the newest snapshot. A later failed or unconfirmed re-fetch
 * must not shadow a rule the user already vouched for (review M1).
 */
export async function latestPolicy(
  ctx: QueryCtx,
  userId: Id<"users">,
  merchantDomain: string,
  kind: PolicyKind,
): Promise<Doc<"policies"> | null> {
  const recent = await ctx.db
    .query("policies")
    .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", merchantDomain).eq("kind", kind))
    .order("desc")
    .take(LATEST_SCAN);
  return recent.find((p) => p.confirmedByUser) ?? recent[0] ?? null;
}
