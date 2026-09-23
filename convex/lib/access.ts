import { ConvexError } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isTombstoned } from "./accountState";

type Ctx = QueryCtx | MutationCtx;

/**
 * Resolves the signed-in user, refusing one being deleted or already deleted
 * (D77): the single choke point every query/mutation goes through, so a
 * tombstoned account cannot mint new sessions, claims, or mail through any
 * caller of this helper. One indexed read (`accountState.by_user`).
 */
export async function requireUserId(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Not signed in");
  if (await isTombstoned(ctx, userId)) throw new ConvexError("This account has been deleted");
  return userId;
}

export async function ownedPurchase(ctx: Ctx, purchaseId: Id<"purchases">, userId: Id<"users">) {
  const p = await ctx.db.get(purchaseId);
  if (!p || p.userId !== userId) throw new ConvexError("Purchase not found");
  return p;
}

export async function ownedItem(ctx: Ctx, itemId: Id<"items">, userId: Id<"users">) {
  const i = await ctx.db.get(itemId);
  if (!i || i.userId !== userId) throw new ConvexError("Item not found");
  return i;
}

export async function ownedClaim(ctx: Ctx, claimId: Id<"claims">, userId: Id<"users">) {
  const c = await ctx.db.get(claimId);
  if (!c || c.userId !== userId) throw new ConvexError("Claim not found");
  return c;
}

export async function ownedPolicy(ctx: Ctx, policyId: Id<"policies">, userId: Id<"users">) {
  const p = await ctx.db.get(policyId);
  if (!p || p.userId !== userId) throw new ConvexError("Policy not found");
  return p;
}

export async function ownedDraft(ctx: Ctx, draftId: Id<"drafts">, userId: Id<"users">) {
  const d = await ctx.db.get(draftId);
  if (!d || d.userId !== userId) throw new ConvexError("Draft not found");
  return d;
}

export async function ownedWatch(ctx: Ctx, watchId: Id<"watches">, userId: Id<"users">) {
  const w = await ctx.db.get(watchId);
  if (!w || w.userId !== userId) throw new ConvexError("Watch not found");
  return w;
}

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §11.1; mission §6 Ownership). One indexed-by-id read per
// helper (`ctx.db.get(table, id)`), no query. A missing row and another user's
// row throw the IDENTICAL `ConvexError("<X> not found")`, so a caller learns
// nothing about ids it does not own. A valid id is never authorization.
// ---------------------------------------------------------------------------

type OwnedTable =
  | "transactions" | "evidence" | "facts" | "incidents" | "opportunities" | "evaluations" | "nonCashRemedies"
  | "packets" | "submissions";

async function ownedRow<T extends OwnedTable>(
  ctx: Ctx,
  table: T,
  id: Id<T>,
  userId: Id<"users">,
  notFound: string,
): Promise<Doc<T>> {
  const row: Doc<T> | null = await ctx.db.get(table, id);
  // Every OwnedTable declares a required `userId` (schema.ts); the generic Doc<T> cannot express that.
  const owner = (row as unknown as { userId: Id<"users"> } | null)?.userId;
  if (!row || owner !== userId) throw new ConvexError(notFound);
  return row;
}

export async function ownedTransaction(ctx: Ctx, transactionId: Id<"transactions">, userId: Id<"users">) {
  return await ownedRow(ctx, "transactions", transactionId, userId, "Transaction not found");
}

/** Returns the row whatever its `retention`; download/preview paths add their own content_deleted check (§2.6). */
export async function ownedEvidence(ctx: Ctx, evidenceId: Id<"evidence">, userId: Id<"users">) {
  return await ownedRow(ctx, "evidence", evidenceId, userId, "Evidence not found");
}

export async function ownedFact(ctx: Ctx, factId: Id<"facts">, userId: Id<"users">) {
  return await ownedRow(ctx, "facts", factId, userId, "Fact not found");
}

export async function ownedIncident(ctx: Ctx, incidentId: Id<"incidents">, userId: Id<"users">) {
  return await ownedRow(ctx, "incidents", incidentId, userId, "Incident not found");
}

export async function ownedOpportunity(ctx: Ctx, opportunityId: Id<"opportunities">, userId: Id<"users">) {
  return await ownedRow(ctx, "opportunities", opportunityId, userId, "Opportunity not found");
}

export async function ownedEvaluation(ctx: Ctx, evaluationId: Id<"evaluations">, userId: Id<"users">) {
  return await ownedRow(ctx, "evaluations", evaluationId, userId, "Evaluation not found");
}

export async function ownedNonCashRemedy(ctx: Ctx, remedyId: Id<"nonCashRemedies">, userId: Id<"users">) {
  return await ownedRow(ctx, "nonCashRemedies", remedyId, userId, "Remedy not found");
}

/** M20 (wave 2, §6): a packet the caller owns, or the identical "Packet not found". */
export async function ownedPacket(ctx: Ctx, packetId: Id<"packets">, userId: Id<"users">) {
  return await ownedRow(ctx, "packets", packetId, userId, "Packet not found");
}

/** M20 (wave 2, DA-A-10): a recorded submission the caller owns, or the identical "Submission not found". */
export async function ownedSubmission(ctx: Ctx, submissionId: Id<"submissions">, userId: Id<"users">) {
  return await ownedRow(ctx, "submissions", submissionId, userId, "Submission not found");
}

/**
 * DA-A-29: a record cited for a transaction must belong to THAT transaction. Call it after the owned* check
 * (ownership is not re-read here). Returns `"same"`, or `"unlinked"` for a row with no `transactionId` when
 * `allowUnlinked` is set (evidence may be cited while unlinked and is then linked on cite, §2.5). Anything else —
 * another transaction's row, or an unlinked row where that is not allowed — throws
 * `ConvexError("<label> belongs to a different transaction")`. Pure: no reads.
 */
export function assertSameTransaction(
  transactionId: Id<"transactions">,
  row: { transactionId?: Id<"transactions"> },
  opts: { allowUnlinked?: boolean; label?: string } = {},
): "same" | "unlinked" {
  if (row.transactionId === transactionId) return "same";
  if (row.transactionId === undefined && opts.allowUnlinked) return "unlinked";
  throw new ConvexError(`${opts.label ?? "That record"} belongs to a different transaction`);
}
