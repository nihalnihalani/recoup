import { describe, expect, it } from "vitest";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "./accountDeletion";

describe("DELETION_REMOVED_NOW (D119/D121, T24d)", () => {
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

  it("says sessions are revoked, sign-in is blocked, and mail is purged and retried", () => {
    const lower = DELETION_REMOVED_NOW.toLowerCase();
    expect(lower).toContain("signed out");
    expect(lower).toContain("blocked");
    expect(lower).toContain("stored copies");
    expect(lower).toContain("retried");
  });
});

describe("DELETION_WHAT_REMAINS (D119/D121, T24d)", () => {
  it("says only the tombstone remains", () => {
    expect(DELETION_WHAT_REMAINS.toLowerCase()).toContain("tombstone");
  });

  it("no longer claims the mail purge is an unfinished, in-progress gap (D119/D121 closed it)", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).not.toContain("not yet purge");
    expect(lower).not.toContain("fix in progress");
    expect(lower).not.toContain("known gap");
    expect(lower).not.toContain("continue to live");
  });

  it("discloses the truthful remote-inbox-failure and already-sent-email caveats", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toContain("remote-inbox failure");
    expect(lower).toContain("cannot be recalled");
  });
});
