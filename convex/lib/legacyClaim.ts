/**
 * M20 (wave 2, D206): `claims.purchaseId` / `claims.itemId` became optional — a `scenario` claim on a non-retail
 * transaction has neither. Every legacy retail reader goes through one of these, so no path silently treats an
 * item-less claim as a retail one:
 *
 * - `legacyIds(claim)` — single-claim, user-initiated paths: an item-less claim THROWS a clear ConvexError.
 * - `hasLegacyIds(claim)` — batch and cron readers (overviews, sweeps, insights, dashboards): item-less claims are
 *   SKIPPED, never thrown on, so one scenario claim cannot break a sweep or a page of many claims.
 *
 * Every claim stored before wave 2 has both ids, so neither changes any existing path. The owners of the retail
 * readers (M28: drafts/replies/followUps; M2C: tracking/insights/purchases) replace these guards with real
 * item-less handling in their own files.
 */
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";

export const ITEMLESS_CLAIM_MESSAGE = "This claim has no purchase or item";

type MaybeLegacy = { purchaseId?: Id<"purchases">; itemId?: Id<"items"> };
export type WithLegacyIds<T extends MaybeLegacy> = T & { purchaseId: Id<"purchases">; itemId: Id<"items"> };

/** Batch/cron readers: true for a retail claim with both ids; filter item-less claims OUT with it (skip, never throw). */
export function hasLegacyIds<T extends MaybeLegacy>(claim: T): claim is WithLegacyIds<T> {
  return claim.purchaseId !== undefined && claim.itemId !== undefined;
}

/** Single-claim, user-initiated paths: the claim's purchase and item ids, or a ConvexError for an item-less claim. */
export function legacyIds(claim: MaybeLegacy): { purchaseId: Id<"purchases">; itemId: Id<"items"> } {
  if (!hasLegacyIds(claim)) throw new ConvexError(ITEMLESS_CLAIM_MESSAGE);
  return { purchaseId: claim.purchaseId, itemId: claim.itemId };
}
