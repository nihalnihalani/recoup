import { describe, expect, it } from "vitest";
import { dropChip } from "./drops";

describe("dropChip", () => {
  it("shows a busy state while claimed or queued", () => {
    expect(dropChip({ status: "claimed", error: null, providerStatus: null })).toEqual({ label: "Sending…", tone: "busy" });
    expect(dropChip({ status: "queued", error: null, providerStatus: null })).toEqual({ label: "Sending…", tone: "busy" });
  });

  it("shows Emailed for a sent row, unless the provider later marked it complained", () => {
    expect(dropChip({ status: "sent", error: null, providerStatus: null })).toEqual({ label: "Emailed", tone: "good" });
    expect(dropChip({ status: "sent", error: null, providerStatus: "complained" })).toEqual({
      label: "Marked as spam",
      tone: "wait",
    });
  });

  it("never labels an unknown row as sent (Invariant 8)", () => {
    const chip = dropChip({ status: "unknown", error: null, providerStatus: null });
    expect(chip).toEqual({ label: "Delivery unknown", tone: "wait" });
    expect(chip.label.toLowerCase()).not.toContain("emailed");
  });

  it("renders the server's own reason for a suppressed row, falling back to a generic label", () => {
    expect(dropChip({ status: "suppressed", error: "Alerts are off for this address", providerStatus: null })).toEqual({
      label: "Alerts are off for this address",
      tone: "muted",
    });
    expect(dropChip({ status: "suppressed", error: null, providerStatus: null })).toEqual({
      label: "Not emailed",
      tone: "muted",
    });
  });

  it("renders the server's own reason for a failed row, falling back to a generic label", () => {
    expect(dropChip({ status: "failed", error: "Mailbox full", providerStatus: null })).toEqual({
      label: "Mailbox full",
      tone: "bad",
    });
    expect(dropChip({ status: "failed", error: null, providerStatus: null })).toEqual({
      label: "Delivery failed",
      tone: "bad",
    });
  });
});
