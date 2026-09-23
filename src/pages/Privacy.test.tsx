// @vitest-environment happy-dom
/**
 * M15 (DA-A-7, D146, D142, D163): the Privacy page publishes the backend's own
 * retention statements. The expected text is read from
 * `convex/lib/privacyFacts.ts` itself, so a statement M14 adds or rewords is
 * covered without editing this file, and a statement the page forgets to
 * render fails here.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EVIDENCE_RETENTION_DAYS, PRIVACY_STATEMENTS } from "../../convex/lib/privacyFacts";
import { DELETION_REMOVED_NOW, DELETION_WHAT_REMAINS } from "../lib/accountDeletion";
import { render, screen } from "../test/dom";
import Privacy from "./Privacy";

function renderPage(): string {
  render(
    <MemoryRouter>
      <Privacy />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("Privacy page copy (DA-A-7)", () => {
  it("renders every privacyFacts statement verbatim, exactly once", () => {
    const text = renderPage();
    const statements = Object.entries(PRIVACY_STATEMENTS);
    expect(statements.length).toBeGreaterThan(0);
    for (const [key, statement] of statements) {
      expect(occurrences(text, statement), `PRIVACY_STATEMENTS.${key}`).toBe(1);
    }
  });

  it("states the D146 30-day rule with both user-initiated exceptions", () => {
    const text = renderPage();
    expect(EVIDENCE_RETENTION_DAYS).toBe(30);
    expect(text).toContain(
      "Raw email content is cleared 30 days after Recoup finishes handling it, unless you start a claim with it or choose to keep it.",
    );
  });

  it("discloses the mail component's own unmasked copy (D142), and that a purge can be left unfinished (P09-F2)", () => {
    const text = renderPage();
    expect(text).toContain(PRIVACY_STATEMENTS.mailComponentCopy);
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/cannot mask that copy/);
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/kept until you delete your account/);
    // P09-F2 (X2/X5): the statement promises the purge starts, not that it always finishes — account.ts's
    // `inboxDeleted`/`mailDataPurged` are reported literally (never coerced to true), so a stalled purge is
    // recorded on the tombstone for the operator (ops.backlog.deletions.deletedWithFailures), not silently true.
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/starts a purge of it/);
    expect(PRIVACY_STATEMENTS.mailComponentCopy).toMatch(/recorded on the account's deletion record/);
  });

  it("shows each window's number from the imported constant, not a hand-typed copy", () => {
    renderPage();
    expect(screen.getAllByText(`EVIDENCE_RETENTION_DAYS = ${EVIDENCE_RETENTION_DAYS}`).length).toBeGreaterThan(0);
  });

  it("keeps the shared deletion copy, which now names the recovery tables", () => {
    const text = renderPage();
    expect(text).toContain(DELETION_REMOVED_NOW);
    expect(text).toContain(DELETION_WHAT_REMAINS);
  });

  it("makes no guarantee or certification claim", () => {
    const text = renderPage().toLowerCase();
    expect(text).not.toMatch(/guarantee/);
    expect(text).not.toMatch(/every right/);
    expect(text).toContain("not a legally binding privacy policy");
  });
});
