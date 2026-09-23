/**
 * Derived claim state (contract rev 5 §5). Pure: no ctx, no clock (callers pass `now`).
 *
 * - `isClosedForAsk` is THE closed-for-ask rule, replacing the scattered status lists (each file's owner
 *   switches its own call site: claims.ts and followUps.ts in M10; priceWatch.ts M12; drafts.ts M13;
 *   purchases.ts M11; tracking.ts M2C).
 * - `delivery` projects a claim's delivery state from its artifacts. When `claim.requiredChannel` is set
 *   (DA-A-9), ONLY artifacts on that channel count: non-informal drafts for `email`; submissions and packets
 *   whose `channel === requiredChannel` for a manual channel. Informal outreach (an email to the merchant on an
 *   R03 claim) is correspondence only. A legacy claim without `requiredChannel` keeps today's projection, which
 *   also reads the claim status (`sent`, `queued`, and the note-only `packet` → `user_reported`).
 * - `isSubmitted` / `isExpired` are display truths built on it; neither is ever stored.
 */
import type { Infer } from "convex/values";
import type { manualChannel, requiredChannel } from "../schema";

export type RequiredChannel = Infer<typeof requiredChannel>;
export type ManualChannel = Infer<typeof manualChannel>;

export type Delivery =
  | "none" | "draft" | "approved" | "queued" | "accepted" | "sent" | "delivered" | "failed" | "bounced"
  | "unknown" | "stalled" | "packet_prepared" | "submission_recorded" | "user_reported";

/** The claim fields the projection reads. `nonCashResolvedAt` arrives in wave 2 (M20). */
export type ClaimStateInput = {
  status: string;
  requiredChannel?: RequiredChannel;
  sendUnknown?: boolean;
  nonCashResolvedAt?: number;
};
/** A `drafts` row as the projection sees it. `purpose` (wave 2, M20) absent = formal. */
export type DraftArtifact = {
  version: number;
  approvedAt?: number;
  outboundId?: string;
  agentmailMessageId?: string;
  sendError?: string;
  purpose?: "formal" | "informal";
};
/** A `packets` row (wave 2, M20). */
export type PacketArtifact = {
  version: number;
  channel: ManualChannel;
  status: "draft" | "approved" | "superseded" | "submission_recorded";
};
/** A `submissions` row (wave 2, M20): user-recorded, never "sent by Recoup". */
export type SubmissionArtifact = { channel: ManualChannel; submittedAt: number; deliveryRecordedAt?: number };
export type ClaimArtifacts = {
  drafts?: readonly DraftArtifact[];
  packets?: readonly PacketArtifact[];
  submissions?: readonly SubmissionArtifact[];
};
export type DeadlineLike = { obligor: "user" | "counterparty"; dueAt?: number; status?: string };

/** §3.4 "asked": the claim reached its counterparty on its channel (or, legacy only, the user said so). */
export const ASKED_DELIVERIES: ReadonlySet<Delivery> = new Set<Delivery>(["sent", "delivered", "submission_recorded", "user_reported"]);
/** §3.4 "sending or unknown": handed to a provider, outcome not yet known. */
export const SENDING_DELIVERIES: ReadonlySet<Delivery> = new Set<Delivery>(["queued", "accepted", "unknown", "stalled"]);

const CLOSED_STATUSES: ReadonlySet<string> = new Set(["confirmed", "dismissed", "denied"]);

/** closed-for-ask(claim) = status ∈ {confirmed, dismissed, denied} or `nonCashResolvedAt` set (§3.4). */
export function isClosedForAsk(claim: { status: string; nonCashResolvedAt?: number }): boolean {
  return CLOSED_STATUSES.has(claim.status) || claim.nonCashResolvedAt !== undefined;
}

/** Furthest-progress order, used only to combine legacy status evidence with draft evidence. */
const RANK: Record<Delivery, number> = {
  none: 0, draft: 1, approved: 2, packet_prepared: 2, failed: 3, bounced: 3, queued: 4, stalled: 4, unknown: 5,
  accepted: 6, user_reported: 7, submission_recorded: 7, sent: 8, delivered: 9,
};
const furthest = (a: Delivery, b: Delivery): Delivery => (RANK[b] > RANK[a] ? b : a);

/** One draft's state from today's fields (drafts.ts `applySendOutcome`): a message id wins over a complaint note. */
function draftState(d: DraftArtifact, sendUnknown: boolean): Delivery {
  if (d.agentmailMessageId) return "sent";
  if (d.sendError) return "failed";
  if (d.outboundId) return sendUnknown ? "unknown" : "queued";
  if (d.approvedAt !== undefined) return "approved";
  return "draft";
}

/** Email projection: `sent` once any counted draft was sent; otherwise the newest counted draft's state. */
function emailDelivery(drafts: readonly DraftArtifact[], sendUnknown: boolean): Delivery {
  if (drafts.length === 0) return "none";
  if (drafts.some((d) => d.agentmailMessageId)) return "sent";
  const newest = drafts.reduce((a, b) => (b.version > a.version ? b : a));
  return draftState(newest, sendUnknown);
}

/** Manual-channel projection: recorded delivery > recorded submission > approved packet > draft packet. */
function manualDelivery(channel: ManualChannel, artifacts: ClaimArtifacts): Delivery {
  const subs = (artifacts.submissions ?? []).filter((s) => s.channel === channel);
  if (subs.some((s) => s.deliveryRecordedAt !== undefined)) return "delivered";
  if (subs.length > 0) return "submission_recorded";
  const packets = (artifacts.packets ?? []).filter((p) => p.channel === channel && p.status !== "superseded");
  if (packets.some((p) => p.status === "approved" || p.status === "submission_recorded")) return "packet_prepared";
  return packets.length > 0 ? "draft" : "none";
}

/** Today's status-only evidence for a legacy claim (no drafts needed): the board's asked/queued meaning. */
function legacyStatusDelivery(claim: ClaimStateInput): Delivery {
  switch (claim.status) {
    case "sent":
      return "sent";
    case "queued":
      return claim.sendUnknown ? "unknown" : "queued";
    case "packet":
      return "user_reported";
    default:
      return "none";
  }
}

/** The claim's delivery state (DA-A-9). Derived; never stored. */
export function delivery(claim: ClaimStateInput, artifacts: ClaimArtifacts): Delivery {
  const sendUnknown = claim.sendUnknown === true;
  const drafts = artifacts.drafts ?? [];
  if (claim.requiredChannel === undefined) {
    return furthest(emailDelivery(drafts, sendUnknown), legacyStatusDelivery(claim));
  }
  if (claim.requiredChannel === "email") {
    return emailDelivery(drafts.filter((d) => d.purpose !== "informal"), sendUnknown);
  }
  return manualDelivery(claim.requiredChannel, artifacts);
}

/** Submitted on the claim's required channel (legacy: today's meaning). Drives "submitted" and the Asked tile. */
export function isSubmitted(claim: ClaimStateInput, artifacts: ClaimArtifacts): boolean {
  return ASKED_DELIVERIES.has(delivery(claim, artifacts));
}

/**
 * Display-only "expired" (§5): an open claim NOT submitted on its required channel, one of whose USER-obligor
 * deadlines has passed (`now > dueAt`; the due instant itself is still in time). Counterparty deadlines and
 * deadlines with no computed `dueAt` never expire a claim.
 */
export function isExpired(
  claim: ClaimStateInput,
  artifacts: ClaimArtifacts,
  deadlines: readonly DeadlineLike[],
  now: number,
): boolean {
  if (isClosedForAsk(claim) || isSubmitted(claim, artifacts)) return false;
  // D212: a `met` user deadline was satisfied in time; it never expires the claim.
  return deadlines.some((d) => d.obligor === "user" && d.status !== "met" && d.dueAt !== undefined && now > d.dueAt);
}
