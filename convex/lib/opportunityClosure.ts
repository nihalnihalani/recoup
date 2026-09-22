/**
 * The opportunity side of a case closing (contract §2.8 "Closing"; DA-B-7). One step, shared by
 * `opportunities.evaluateTransaction` (lazy sync) and `claims.ts` (at once, in the same mutation as the dismissal or
 * the confirmed credit), so a card never shows "case open" for a closed claim:
 *   - the linked claim is confirmed (or, from wave 2, resolved with a non-cash remedy) → the opportunity is `closed`;
 *   - it is dismissed (or, from wave 2, denied) → the opportunity reopens (`open`);
 *   - either way `activeClaimId` is cleared. A dismissed opportunity stays dismissed (only its own claim is synced).
 * Lives outside `claims.ts` / `opportunities.ts` so each can import it without an import cycle.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isClosedForAsk } from "./claimState";

/** The patch that reflects a closed case on its opportunity; `{}` while the case is still open. */
export async function closurePatch(ctx: MutationCtx, opp: Doc<"opportunities">): Promise<Partial<Doc<"opportunities">>> {
  if (!opp.activeClaimId) return {};
  const claim = await ctx.db.get(opp.activeClaimId);
  if (claim && !isClosedForAsk(claim)) return {};
  // `nonCashResolvedAt` arrives with the wave-2 schema (M20, DA-A-18); read structurally until then.
  if (claim && (claim.status === "confirmed" || (claim as { nonCashResolvedAt?: number }).nonCashResolvedAt !== undefined)) {
    return { status: "closed", activeClaimId: undefined };
  }
  return { status: "open", activeClaimId: undefined };
}

/** DA-B-7: runs the closure step for the claim's linked opportunity now. A no-op for unlinked claims. */
export async function syncOpportunityClosure(ctx: MutationCtx, claimId: Id<"claims">): Promise<void> {
  const claim = await ctx.db.get(claimId);
  if (!claim?.opportunityId) return;
  const opp = await ctx.db.get(claim.opportunityId);
  if (!opp || opp.userId !== claim.userId || opp.activeClaimId !== claim._id) return;
  const patch = await closurePatch(ctx, opp);
  if (Object.keys(patch).length > 0) await ctx.db.patch(opp._id, patch);
}
