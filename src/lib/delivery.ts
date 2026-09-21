import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";

export type SendStatus = FunctionReturnType<typeof api.drafts.sendStatus>;

export type Delivery = {
  reached: 1 | 2 | 3;
  tone: "moving" | "done" | "failed" | "unknown";
  note: string;
};

// Mirrors convex/drafts.ts's TERMINAL_FAILURES: a bounced/rejected/failed
// AgentMail status can still carry a message id (the send did leave our
// outbox), so failure must be checked before the "has a message id -> Sent"
// branch, not after it.
const TERMINAL_STATUSES: readonly string[] = ["failed", "bounced", "rejected"];

/** Pure delivery-state -> UI mapping for the claim Composer's send progress
 * rail (D13/D68). Exported on its own (not a component) so it stays testable
 * without pulling in JSX. */
export function deliveryOf(sendStatus: SendStatus | undefined, sendUnknown: boolean): Delivery {
  if (sendStatus === undefined) return { reached: 1, tone: "moving", note: "Checking" };
  if (sendStatus === null) return { reached: 2, tone: "moving", note: "Sending…" };
  if (TERMINAL_STATUSES.includes(sendStatus.status) || sendStatus.errorMessage) {
    return {
      reached: 2,
      tone: "failed",
      note: sendStatus.errorMessage ?? `Delivery ${sendStatus.status}`,
    };
  }
  if (sendStatus.status === "complained") {
    return { reached: 3, tone: "done", note: "Delivered, marked as spam" };
  }
  if (sendStatus.agentmailMessageId) return { reached: 3, tone: "done", note: "Sent" };
  if (sendUnknown) return { reached: 2, tone: "unknown", note: "Delivery unknown — recheck" };
  return { reached: 2, tone: "moving", note: "Sending…" };
}
