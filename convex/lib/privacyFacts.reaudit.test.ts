/**
 * P01-P12 re-audit, batch 2 (P09-F1 / S-M03-2, +P07-SK-6; D244): the Privacy page's mail-component disclosure
 * (`mailComponentCopy`) covered only the user's OWN Recoup inbox (`MAIL_COMPONENT_RAW_COPY`, D119/D121, closed).
 * It said nothing about the SEPARATE, shared mailbox Recoup sends from as itself (`ALERTS_INBOX_ID`: sign-in/
 * reset codes via `convex/lib/authMail.ts`, price-drop alerts via `convex/notify.ts`) -- nothing purges that
 * shared mailbox's copy of those sends, or of a reply a user sent to one, on account deletion or ever. This adds
 * `SENDER_MAILBOX_COPY` (the backend fact, `purgedOnAccountDeletion: false`) and extends `mailComponentCopy` to
 * disclose it, matching `src/lib/accountDeletion.ts`'s `DELETION_WHAT_REMAINS` (see
 * `accountDeletion.reaudit.test.ts`) instead of contradicting it.
 */
import { describe, expect, it } from "vitest";
import { MAIL_COMPONENT_RAW_COPY, PRIVACY_STATEMENTS, SENDER_MAILBOX_COPY } from "./privacyFacts";

describe("P09-F1 (+P07-SK-6): the shared sender mailbox is disclosed as a separate, unpurged copy", () => {
  it("SENDER_MAILBOX_COPY is distinct from MAIL_COMPONENT_RAW_COPY and honestly says it is not purged on deletion", () => {
    expect(SENDER_MAILBOX_COPY.purgedOnAccountDeletion).toBe(false);
    expect(SENDER_MAILBOX_COPY.maskedByRecoup).toBe(false);
    // Distinct constants: the user's own inbox purge landing must never be read as covering the shared one too.
    expect(SENDER_MAILBOX_COPY).not.toEqual(MAIL_COMPONENT_RAW_COPY);
    expect(MAIL_COMPONENT_RAW_COPY.purgedOnAccountDeletion).toBe(true); // unchanged: D119/D121 is still closed for the user's own inbox.
  });

  it("mailComponentCopy discloses sign-in/reset codes and alert replies are not purged by account deletion", () => {
    const lower = PRIVACY_STATEMENTS.mailComponentCopy.toLowerCase();
    expect(lower).toMatch(/sign-in/);
    expect(lower).toMatch(/reset/);
    expect(lower).toMatch(/does not purge/);
    expect(lower).toMatch(/repl(y|ies)/);
    // The original D142/D119 promise for the user's OWN inbox must survive unchanged alongside the new disclosure.
    expect(lower).toContain("cannot mask");
    expect(lower).toContain("kept until you delete your account");
  });
});
