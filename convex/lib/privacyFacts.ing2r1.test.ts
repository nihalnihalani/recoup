/**
 * ING2-R1 (Opus adversarial re-review of ing2's first fix, commit 70e06a0): `SENDER_MAILBOX_COPY.keptUntil` was
 * `"provider_retention_policy"` -- a name implying the PROVIDER controls the window, when nothing in this
 * codebase ever clears the copy on any schedule (Recoup's own component keeps it forever too). And
 * `mailComponentCopy`'s docstring claimed the statement "reads" `SENDER_MAILBOX_COPY` when it was still a
 * hand-typed clause -- and that hand-typed clause said deletion "does not purge that shared mailbox's copy of
 * those sends", which is false of the alert's own OUTBOUND send (purged by `deleteMailLogPage`, D129); only the
 * delivery record and a reply survive.
 *
 * These assertions FAIL against 70e06a0 (`SENDER_MAILBOX_COPY.keptUntil` was `"provider_retention_policy"`, and
 * `mailComponentCopy` did not contain the word "indefinitely" or interpolate the constant) and PASS after this
 * fix.
 */
import { describe, expect, it } from "vitest";
import { PRIVACY_STATEMENTS, SENDER_MAILBOX_COPY } from "./privacyFacts";

describe("ING2-R1: SENDER_MAILBOX_COPY.keptUntil is truthful, and mailComponentCopy actually reads it", () => {
  it("keptUntil says 'indefinitely', not a provider-policy name nothing in this codebase can point to", () => {
    expect(SENDER_MAILBOX_COPY.keptUntil).toBe("indefinitely");
  });

  it("mailComponentCopy renders SENDER_MAILBOX_COPY.keptUntil verbatim, not a separately hand-typed duration", () => {
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toContain(SENDER_MAILBOX_COPY.keptUntil);
  });

  it("no longer claims the alert's own outbound send is left unpurged by account deletion", () => {
    const lower = PRIVACY_STATEMENTS.mailComponentCopy.toLowerCase();
    expect(lower).toMatch(/outbound send is purged/);
  });

  it("still discloses the delivery-record and reply gap, and the original own-inbox promise, truthfully", () => {
    const lower = PRIVACY_STATEMENTS.mailComponentCopy.toLowerCase();
    expect(lower).toMatch(/sign-in/);
    expect(lower).toMatch(/reset/);
    expect(lower).toMatch(/does not purge/);
    expect(lower).toMatch(/repl(y|ies)/);
    expect(lower).toContain("cannot mask");
    expect(lower).toContain("kept until you delete your account");
  });
});
