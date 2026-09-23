import { describe, expect, it } from "vitest";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS, deletionHeadline } from "./accountDeletion";

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
      // M15 (D163): the wave-1 tables `account.purge` also removes (M14).
      "transactions",
      "recorded facts",
      "evidence",
      "uploaded files",
      "recovery opportunities",
      "rule-check history",
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

/**
 * P09-SK-2 regression: on origin/main, `Settings.tsx`'s `DeletionInProgress` headline is unconditional —
 * "Account deleted" whenever `status.status === "deleted"`, no matter what `inboxDeleted`/`mailDataPurged` say.
 * `deletionHeadline` does not exist there at all (this whole module is new for the still-signed-in tab), so this
 * suite fails to even import on base and passes once the conditional headline lands.
 */
describe("deletionHeadline (P09-SK-2)", () => {
  it("says the deletion is in progress while status is 'deleting', regardless of the mail fields", () => {
    const headline = deletionHeadline({ status: "deleting", inboxDeleted: false, mailDataPurged: false });
    expect(headline.title).toBe("Deletion in progress");
    expect(headline.body.toLowerCase()).toContain("being removed");
  });

  it("claims a clean removal only when both the inbox delete and the mail purge succeeded", () => {
    const headline = deletionHeadline({ status: "deleted", inboxDeleted: true, mailDataPurged: true });
    expect(headline.title).toBe("Account deleted");
    expect(headline.body.toLowerCase()).toContain("removed");
  });

  it("never claims a clean 'Account deleted' when the remote inbox delete failed", () => {
    const headline = deletionHeadline({ status: "deleted", inboxDeleted: false, mailDataPurged: true });
    expect(headline.title).not.toBe("Account deleted");
    expect(headline.title.toLowerCase()).toContain("incomplete");
    expect(headline.body.toLowerCase()).toContain("mail provider failed");
  });

  it("never claims a clean 'Account deleted' when the stored-mail-copies purge did not finish", () => {
    const headline = deletionHeadline({ status: "deleted", inboxDeleted: true, mailDataPurged: false });
    expect(headline.title).not.toBe("Account deleted");
    expect(headline.body.toLowerCase()).toContain("did not finish");
  });

  it("names both failures together when the inbox delete and the mail purge both failed", () => {
    const headline = deletionHeadline({ status: "deleted", inboxDeleted: false, mailDataPurged: false });
    expect(headline.body.toLowerCase()).toContain("mail provider failed");
    expect(headline.body.toLowerCase()).toContain("did not finish");
  });

  it("treats a missing (undefined) inboxDeleted/mailDataPurged defensively as not a claimed success", () => {
    const headline = deletionHeadline({ status: "deleted" });
    expect(headline.title).toBe("Account deleted");
  });
});
