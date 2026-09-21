import { describe, expect, it } from "vitest";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "./accountDeletion";

describe("DELETION_WHAT_REMAINS (D115 6b-5)", () => {
  it("never claims the tombstone is the only thing left behind", () => {
    expect(DELETION_WHAT_REMAINS.toLowerCase()).not.toContain("tombstone only");
    expect(DELETION_WHAT_REMAINS.toLowerCase()).not.toMatch(/^what remains: an anonymous account tombstone\.$/);
  });

  it("discloses the AgentMail component's retained email content", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toContain("email content");
    expect(lower).toContain("not yet purge");
  });
});

describe("DELETION_REMOVED_NOW (D115)", () => {
  it("lists every table category the lead named", () => {
    for (const word of [
      "purchases",
      "items",
      "claims",
      "ledger",
      "drafts",
      "replies",
      "watches",
      "mail log",
      "alert settings",
      "profile",
    ]) {
      expect(DELETION_REMOVED_NOW.toLowerCase()).toContain(word);
    }
  });

  it("says sessions are revoked and the inbox deletion is retried", () => {
    const lower = DELETION_REMOVED_NOW.toLowerCase();
    expect(lower).toContain("signed out");
    expect(lower).toContain("retried");
  });
});
