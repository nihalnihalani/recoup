/**
 * P01-P12 re-audit, batch 2 (P09-F1 / S-M03-2, +P07-SK-6; D244): `DELETION_WHAT_REMAINS` claimed "nothing else"
 * remains after account deletion besides the tombstone. False: the shared mailbox Recoup itself sends from
 * (`ALERTS_INBOX_ID` -- sign-in/reset codes via `convex/lib/authMail.ts`, price-drop alerts via
 * `convex/notify.ts`) keeps its own copy of those sends, and of any reply a user sent to one, forever -- nothing
 * in this codebase purges it, on account deletion or ever. This is the copy-truth half of the fix (owned by this
 * lane per its brief); the sweep/purge mechanism itself is `convex/lib/privacyFacts.ts`'s new
 * `SENDER_MAILBOX_COPY` fact (`purgedOnAccountDeletion: false`) and remains future work, tracked there and in
 * this session's structured report -- reaching the live provider to change that retention is P09-X1 (D83, D136,
 * not authorized in this mission).
 */
import { describe, expect, it } from "vitest";
import { DELETION_WHAT_REMAINS } from "./accountDeletion";

describe("P09-F1 (+P07-SK-6): DELETION_WHAT_REMAINS no longer claims nothing else remains", () => {
  it("never claims nothing else remains", () => {
    expect(DELETION_WHAT_REMAINS.toLowerCase()).not.toContain("nothing else");
  });

  it("discloses the shared sender mailbox (sign-in/reset codes and alerts) is not purged by account deletion", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toMatch(/sign-in/);
    expect(lower).toMatch(/reset/);
    expect(lower).toMatch(/shared mailbox|shared sender mailbox/);
    expect(lower).toMatch(/does not (remove|purge)/);
    expect(lower).toMatch(/repl(y|ies)/);
  });

  it("still keeps the required remote-inbox-failure and already-sent-email caveats (hard rule: do not drop these)", () => {
    const lower = DELETION_WHAT_REMAINS.toLowerCase();
    expect(lower).toContain("remote-inbox failure");
    expect(lower).toContain("cannot be recalled");
  });

  it("still says the tombstone remains", () => {
    expect(DELETION_WHAT_REMAINS.toLowerCase()).toContain("tombstone");
  });
});
