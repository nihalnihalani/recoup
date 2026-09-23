import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";

export type SendStatus = FunctionReturnType<typeof api.drafts.sendStatus>;

export type Delivery = {
  reached: 1 | 2 | 3;
  tone: "moving" | "done" | "failed" | "unknown";
  note: string;
};

const UNKNOWN: Delivery = { reached: 2, tone: "unknown", note: "We couldn't confirm it was sent" };
const SENDING: Delivery = { reached: 2, tone: "moving", note: "Sending…" };

const SENT: Delivery = { reached: 3, tone: "done", note: "Sent" };

/**
 * Pure delivery-state -> UI mapping for the claim Composer's send progress rail (D13/D68). Reads the server's
 * owner-safe `outcome` (S-M03-1, M13): "Sent" only when the provider confirmed a message id; an ambiguous outcome
 * is "we couldn't confirm it was sent", never a failure and never a success. Exported on its own (not a component)
 * so it stays testable without pulling in JSX.
 *
 * `confirmedSent` is the draft's own record (`agentmailMessageId` set by reconciliation). P02-SK-1: the server no
 * longer returns `null` for an old send, but a draft that is recorded as sent never reads "Sending…" here either.
 */
export function deliveryOf(sendStatus: SendStatus | undefined, sendUnknown: boolean, confirmedSent = false): Delivery {
  if (sendStatus === undefined) return { reached: 1, tone: "moving", note: "Checking" };
  if (sendStatus === null) return confirmedSent ? SENT : sendUnknown ? UNKNOWN : SENDING;
  switch (sendStatus.outcome) {
    case "failed":
      return { reached: 2, tone: "failed", note: sendStatus.errorMessage ?? `Delivery ${sendStatus.status}` };
    case "sent":
      return sendStatus.status === "complained"
        ? { reached: 3, tone: "done", note: "Delivered, marked as spam" }
        : SENT;
    case "unknown":
      return UNKNOWN;
    case "pending":
      return sendUnknown ? UNKNOWN : SENDING;
  }
}
