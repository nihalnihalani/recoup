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

/**
 * Pure delivery-state -> UI mapping for the claim Composer's send progress rail (D13/D68). Reads the server's
 * owner-safe `outcome` (S-M03-1, M13): "Sent" only when the provider confirmed a message id; an ambiguous outcome
 * is "we couldn't confirm it was sent", never a failure and never a success. Exported on its own (not a component)
 * so it stays testable without pulling in JSX.
 */
export function deliveryOf(sendStatus: SendStatus | undefined, sendUnknown: boolean): Delivery {
  if (sendStatus === undefined) return { reached: 1, tone: "moving", note: "Checking" };
  if (sendStatus === null) return sendUnknown ? UNKNOWN : SENDING;
  switch (sendStatus.outcome) {
    case "failed":
      return { reached: 2, tone: "failed", note: sendStatus.errorMessage ?? `Delivery ${sendStatus.status}` };
    case "sent":
      return sendStatus.status === "complained"
        ? { reached: 3, tone: "done", note: "Delivered, marked as spam" }
        : { reached: 3, tone: "done", note: "Sent" };
    case "unknown":
      return UNKNOWN;
    case "pending":
      return sendUnknown ? UNKNOWN : SENDING;
  }
}
