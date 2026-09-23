import { describe, expect, it } from "vitest";
import { deliveryOf, type SendStatus } from "./delivery";

const status = (overrides: Partial<NonNullable<SendStatus>>): SendStatus => ({
  status: "pending",
  agentmailMessageId: null,
  threadId: null,
  errorMessage: null,
  outcome: "pending",
  ...overrides,
});

describe("deliveryOf (the Composer's rail, from sendStatus.outcome)", () => {
  it("says Sent only when the provider confirmed a message id", () => {
    expect(deliveryOf(status({ status: "sent", agentmailMessageId: "m1", outcome: "sent" }), false)).toEqual({ reached: 3, tone: "done", note: "Sent" });
  });

  it("an ambiguous outcome is 'we couldn't confirm it was sent', never failed and never sent", () => {
    const d = deliveryOf(status({ outcome: "unknown" }), false);
    expect(d).toEqual({ reached: 2, tone: "unknown", note: "We couldn't confirm it was sent" });
    expect(deliveryOf(status({ outcome: "pending" }), true).tone).toBe("unknown");
    expect(deliveryOf(null, true).tone).toBe("unknown");
  });

  it("a definite failure shows the owner-safe reason", () => {
    expect(deliveryOf(status({ status: "bounced", outcome: "failed", errorMessage: "The address bounced." }), false)).toEqual({
      reached: 2,
      tone: "failed",
      note: "The address bounced.",
    });
  });

  it("still in flight reads as sending", () => {
    expect(deliveryOf(status({ outcome: "pending" }), false)).toEqual({ reached: 2, tone: "moving", note: "Sending…" });
    expect(deliveryOf(undefined, false).note).toBe("Checking");
  });

  it("P02-SK-1: a draft recorded as sent never reads as sending, even with no component status", () => {
    expect(deliveryOf(null, false, true)).toEqual({ reached: 3, tone: "done", note: "Sent" });
    expect(deliveryOf(null, true, true).note).toBe("Sent");
    expect(deliveryOf(null, false).note).toBe("Sending…"); // no recorded send: unchanged
  });

  it("a complaint after delivery is still delivered", () => {
    expect(deliveryOf(status({ status: "complained", agentmailMessageId: "m1", outcome: "sent" }), false).note).toBe("Delivered, marked as spam");
  });
});
