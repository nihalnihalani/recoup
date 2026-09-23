// @vitest-environment happy-dom
/**
 * F1 regression (fe2 review, P06-OW-1 display): the /opportunities row must not tell the user a case asked in time
 * has "passed" once it is case_open with an active claim. Mirrors the OpportunityCard.test.tsx F1 case.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { render, screen } from "../../test/dom";
import { NOW, view } from "../../test/opportunityFixtures";
import { OpportunityRow } from "./OpportunityRow";

type Deadline = Doc<"evaluations">["deadlines"][number];
const window_: Deadline = {
  id: "r01.window",
  label: "The store's price-adjustment window",
  obligor: "user",
  status: "open",
  dueAt: NOW - 3_600_000,
  mustBe: "n_a",
  basis: "30 × 24 hours from retail.purchase_date",
};

function renderRow(v: ReturnType<typeof view>) {
  render(
    <MemoryRouter>
      <ul>
        <OpportunityRow view={v} href="/x" now={NOW} />
      </ul>
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

describe("F1 regression: a case asked in time (case_open, active claim) after the window end", () => {
  const caseOpen = () =>
    view(
      { outcome: "likely_eligible", nextAction: { kind: "continue_case", claimId: "c1" as Id<"claims"> }, deadlines: [window_] },
      { outcome: "likely_eligible", status: "case_open", activeClaimId: "c1" as Id<"claims">, nextDeadlineAt: NOW - 3_600_000 },
    );

  it("does not show 'Window may have passed' or 'Your deadline passed' for an open case", () => {
    const text = renderRow(caseOpen());
    expect(screen.queryByText("Window may have passed")).toBeNull();
    expect(text).not.toContain("Your deadline passed");
  });

  it("a case still open (not asked in time, no deadlines stored past due) is unaffected by the gate", () => {
    const text = renderRow(
      view({ outcome: "likely_eligible", nextAction: { kind: "open_case" }, deadlines: [{ ...window_, dueAt: NOW + 3_600_000 }] }, { outcome: "likely_eligible" }),
    );
    expect(screen.queryByText("Window may have passed")).toBeNull();
    expect(text).not.toContain("Your deadline passed");
  });
});
