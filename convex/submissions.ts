/**
 * Recorded manual submissions (M20; contract §6 "Recording", DA-A-10, rev 5 N3).
 *
 * `submissions.record({ packetId, submittedAt, confirmationRef?, proofEvidenceId?, note? })` requires ONLY that this
 * packet version was approved (`approvedHash` stored) and was not superseded before its `approvedAt`. If the binding
 * drifted after approval — a ledger event, a material re-evaluation, a user deadline passing (each bumps the claim's
 * version) — recording STILL succeeds, with `staleAtRecord: true`, a claimNote and a review prompt (`attentionAt`).
 * The recorded `submittedAt` is returned against the bound evaluation's user deadline. Recording is the only way a
 * scenario claim reaches `packet` (§5). A second record of the same packet returns the first (idempotent).
 * N3: the call that finds the claim's pack withdrawn returns `rule_withdrawn` (the opportunity is superseded and the
 * claim version bumped once); a later call records under the legacy path (and is therefore flagged stale).
 *
 * Recoup never claims a manual submission was sent or delivered: `recordDelivery` stores the user's own record.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { mutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { assertSameTransaction, ownedClaim, ownedEvidence, ownedPacket, ownedSubmission, requireUserId } from "./lib/access";
import { cleanLine } from "./lib/text";
import { rateLimiter } from "./lib/rateLimits";
import { cancelPending, scheduleClaimReminder } from "./followUps";
import { liveLink, packetBinding, reevaluateForPacket } from "./packets";

const MAX_CONFIRMATION_REF_CHARS = 200;
const MAX_NOTE_CHARS = 1_000;
/** A client clock may run a little ahead; anything later is a future date. */
const FUTURE_SKEW_MS = 10 * 60_000;

/** Statuses a first recorded submission moves to `packet` (§5): nothing asked yet. Later statuses are kept. */
const BEFORE_ASKED: ReadonlySet<Doc<"claims">["status"]> = new Set(["detected", "drafted", "queued"]);

const deadlineView = v.union(
  v.null(),
  v.object({ id: v.string(), label: v.string(), dueAt: v.optional(v.number()), late: v.boolean() }),
);

/** The earliest user deadline of the bound evaluation with a due instant, and whether `submittedAt` came after it. */
function againstDeadline(evaluation: Doc<"evaluations"> | null, submittedAt: number): Infer<typeof deadlineView> {
  const user = (evaluation?.deadlines ?? []).filter((d) => d.obligor === "user" && d.dueAt !== undefined);
  if (user.length === 0) return null;
  const d = user.reduce((a, b) => (b.dueAt! < a.dueAt! ? b : a));
  return { id: d.id, label: d.label, dueAt: d.dueAt, late: submittedAt > d.dueAt! };
}

const recordResult = v.union(
  v.object({
    ok: v.literal(true),
    submissionId: v.id("submissions"),
    staleAtRecord: v.boolean(),
    deduped: v.boolean(),
    deadline: deadlineView,
  }),
  v.object({
    ok: v.literal(false),
    code: v.union(v.literal("example_claim"), v.literal("rate_limited"), v.literal("rule_withdrawn")),
    message: v.string(),
  }),
);
type RecordResult = Infer<typeof recordResult>;

export const record = mutation({
  args: {
    packetId: v.id("packets"),
    submittedAt: v.number(),
    confirmationRef: v.optional(v.string()),
    proofEvidenceId: v.optional(v.id("evidence")),
    note: v.optional(v.string()),
  },
  returns: recordResult,
  handler: async (ctx, args): Promise<RecordResult> => {
    const userId = await requireUserId(ctx);
    const packet = await ownedPacket(ctx, args.packetId, userId);
    const claim = await ownedClaim(ctx, packet.claimId, userId);
    if (claim.isExample) return { ok: false, code: "example_claim", message: "Examples never record real submissions." };
    // DA-A-10: the ONLY precondition — this version was approved, and not superseded before that approval.
    if (packet.approvedHash === undefined || packet.approvedAt === undefined) {
      throw new ConvexError("Approve this packet before recording that you sent it");
    }
    if (packet.supersededAt !== undefined && packet.supersededAt < packet.approvedAt) {
      throw new ConvexError("This packet version was replaced before it was approved");
    }
    const now = Date.now();
    if (!Number.isSafeInteger(args.submittedAt) || args.submittedAt <= 0) throw new ConvexError("submittedAt must be a time");
    if (args.submittedAt > now + FUTURE_SKEW_MS) throw new ConvexError("The submission date is in the future");
    const confirmationRef = args.confirmationRef !== undefined ? cleanLine(args.confirmationRef) : undefined;
    if (confirmationRef !== undefined && confirmationRef.length > MAX_CONFIRMATION_REF_CHARS) {
      throw new ConvexError(`The confirmation reference is longer than ${MAX_CONFIRMATION_REF_CHARS} characters`);
    }
    const note = args.note !== undefined ? args.note.trim() : undefined;
    if (note !== undefined && note.length > MAX_NOTE_CHARS) throw new ConvexError(`The note is longer than ${MAX_NOTE_CHARS} characters`);
    if (args.proofEvidenceId) {
      const ev = await ownedEvidence(ctx, args.proofEvidenceId, userId);
      if (claim.transactionId) assertSameTransaction(claim.transactionId, ev, { allowUnlinked: true, label: "The proof" });
    }

    const existing = await ctx.db.query("submissions").withIndex("by_packet", (q) => q.eq("packetId", packet._id)).first();
    if (existing && existing.userId === userId) {
      const link = await liveLink(ctx, claim);
      return {
        ok: true,
        submissionId: existing._id,
        staleAtRecord: existing.staleAtRecord === true,
        deduped: true,
        deadline: againstDeadline(link?.evaluation ?? null, existing.submittedAt),
      };
    }

    const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
    if (!limit.ok) return { ok: false, code: "rate_limited", message: "Too many checks in a short time. Try again in a minute." };
    if ((await reevaluateForPacket(ctx, claim, now)) === "rule_withdrawn") {
      return {
        ok: false,
        code: "rule_withdrawn",
        message: "Recoup's automatic checks for this kind of claim were withdrawn. Review the claim, then record the submission again.",
      };
    }
    const fresh = (await ctx.db.get(claim._id))!;
    const link = await liveLink(ctx, fresh);
    const current = await packetBinding(fresh, link, packet.evidenceIndex);
    const staleAtRecord = fresh.version !== packet.binding.claimVersion || current.contextHash !== packet.binding.contextHash;

    const submissionId = await ctx.db.insert("submissions", {
      userId,
      claimId: fresh._id,
      packetId: packet._id,
      approvedHash: packet.approvedHash,
      channel: packet.channel,
      submittedAt: args.submittedAt,
      ...(confirmationRef ? { confirmationRef } : {}),
      ...(args.proofEvidenceId ? { proofEvidenceId: args.proofEvidenceId } : {}),
      ...(staleAtRecord ? { staleAtRecord: true } : {}),
      ...(note ? { note } : {}),
    });
    await ctx.db.patch(packet._id, { status: "submission_recorded" });
    const patch: Partial<Doc<"claims">> = {};
    if (BEFORE_ASKED.has(fresh.status)) patch.status = "packet";
    if (staleAtRecord) patch.attentionAt = now; // the review prompt
    if (Object.keys(patch).length > 0) await ctx.db.patch(fresh._id, patch);
    const deadline = againstDeadline(link?.evaluation ?? null, args.submittedAt);
    const when = new Date(args.submittedAt).toISOString().slice(0, 10);
    await ctx.db.insert("claimNotes", {
      claimId: fresh._id,
      userId,
      kind: "status",
      text:
        `You recorded sending packet v${packet.version} (${packet.channel}) on ${when}.` +
        (deadline?.late ? ` That is after the deadline "${deadline.label}".` : "") +
        (staleAtRecord ? " The claim changed after you approved this packet; review it." : ""),
    });
    const reminded = (await ctx.db.get(fresh._id))!;
    if (reminded.status !== "confirmed" && reminded.status !== "dismissed") {
      await cancelPending(ctx, reminded._id);
      await scheduleClaimReminder(ctx, reminded);
    }
    return { ok: true, submissionId, staleAtRecord, deduped: false, deadline };
  },
});

/**
 * The user's own record that the counterparty received the submission (e.g. a delivery confirmation), with optional
 * evidence they own. Never inferred by Recoup. A correction overwrites the earlier record and is noted.
 */
export const recordDelivery = mutation({
  args: { submissionId: v.id("submissions"), deliveredAt: v.number(), evidenceId: v.optional(v.id("evidence")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const submission = await ownedSubmission(ctx, args.submissionId, userId);
    const claim = await ownedClaim(ctx, submission.claimId, userId);
    if (!Number.isSafeInteger(args.deliveredAt) || args.deliveredAt < submission.submittedAt) {
      throw new ConvexError("The delivery date must be on or after the submission date");
    }
    if (args.deliveredAt > Date.now() + FUTURE_SKEW_MS) throw new ConvexError("The delivery date is in the future");
    if (args.evidenceId) {
      const ev = await ownedEvidence(ctx, args.evidenceId, userId);
      if (claim.transactionId) assertSameTransaction(claim.transactionId, ev, { allowUnlinked: true, label: "The proof" });
    }
    const correction = submission.deliveryRecordedAt !== undefined;
    await ctx.db.patch(submission._id, { deliveryRecordedAt: args.deliveredAt, deliveryEvidenceId: args.evidenceId });
    await ctx.db.insert("claimNotes", {
      claimId: claim._id,
      userId,
      kind: "status",
      text: `${correction ? "Corrected: y" : "Y"}ou recorded that the ${submission.channel} submission arrived on ${new Date(args.deliveredAt).toISOString().slice(0, 10)}.`,
    });
    return null;
  },
});
