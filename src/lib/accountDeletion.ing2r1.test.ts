/**
 * ING2-R1 (Opus adversarial re-review of ing2's first fix, commit 70e06a0): `DELETION_WHAT_REMAINS` closed the
 * literal "nothing else" claim (see `accountDeletion.reaudit.test.ts`) but replaced it with two other untruths:
 *
 *  1. It still said the tombstone records "only that an account existed and was deleted" -- false, `accountState`
 *     keeps the account id, the Recoup inbox id (`inboxId`) and the last error (`lastError`) too, exactly as
 *     `zz_ing2review_privacy.test.ts` (the reviewer's probe, kept under
 *     recoup-wt-ing2-evidence/review/) demonstrated: after a completed deletion the tombstone still has
 *     `inboxId: "inbox_a"` and a `lastError` containing "inbox_a".
 *  2. It attributed every surviving shared-mailbox copy to "Recoup's mail provider ... outside Recoup's
 *     control" -- false of the sign-in/reset delivery record and the alert-reply copy specifically, both of
 *     which live in Recoup's OWN AgentMail component tables (`SENDER_MAILBOX_COPY`, `purgedOnAccountDeletion:
 *     false`), not only with the provider.
 *  3. It said deletion "does not remove that mailbox's copy of those sends" -- false of the alert's own
 *     OUTBOUND send, which `deleteMailLogPage` (`convex/account.ts`) already purges via
 *     `mailPurge.purgeOutbound` as part of this same deletion (D129, checkpoint 6d).
 *
 * These assertions FAIL against 70e06a0 (verified: `recording only that an account existed and was deleted`
 * and the "outside Recoup's control"-only attribution were both present verbatim) and PASS after this fix.
 */
import { describe, expect, it } from "vitest";
import { DELETION_WHAT_REMAINS } from "./accountDeletion";

describe("ING2-R1: DELETION_WHAT_REMAINS is truthful about what the tombstone and Recoup's own backend keep", () => {
  it("never claims the tombstone records only that an account existed", () => {
    expect(DELETION_WHAT_REMAINS.toLowerCase()).not.toContain("recording only");
  });

  it("names what the tombstone actually keeps: the account id, the Recoup inbox id, and the last error", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toMatch(/account id/);
    expect(lower).toMatch(/inbox id/);
    expect(lower).toMatch(/last error/);
  });

  it("attributes the shared mailbox's surviving copies to Recoup's own mail system, not only the provider", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toMatch(/recoup's own mail system/);
    // The provider's separate, uncontrolled retention is still disclosed too -- just not as the ONLY holder.
    expect(lower).toMatch(/mail provider separately keeps/);
  });

  it("no longer claims deletion leaves the alert's own outbound send unpurged (D129 already purges it)", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toMatch(/outbound send is different/);
    expect(lower).toMatch(/purged when your account is/);
  });

  it("still discloses the delivery-record and reply gap truthfully (kept indefinitely, no expiry)", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toContain("indefinitely");
    expect(lower).toMatch(/no expiry/);
  });

  it("keeps every hard-rule caveat from the earlier fixes (tombstone, remote-inbox failure, cannot be recalled, sign-in/reset/shared-mailbox/reply)", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toContain("tombstone");
    expect(lower).toContain("remote-inbox failure");
    expect(lower).toContain("cannot be recalled");
    expect(lower).not.toContain("nothing else");
    expect(lower).toMatch(/sign-in/);
    expect(lower).toMatch(/reset/);
    expect(lower).toMatch(/shared mailbox|shared sender mailbox/);
    expect(lower).toMatch(/does not (remove|purge)/);
    expect(lower).toMatch(/repl(y|ies)/);
  });
});

describe("D273: the remote-inbox failure promise matches what a signed-out user can see (P09-SK-2 × ING2-R1)", () => {
  it("never promises the failure is shown to the user; says who sees it and that a signed-out page cannot", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).not.toContain("shown rather than hidden");
    expect(lower).toContain("reported to recoup's operator");
    expect(lower).toContain("once you are signed out recoup cannot show it to you");
  });
});
