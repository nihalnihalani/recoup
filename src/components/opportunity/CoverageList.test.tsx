// @vitest-environment happy-dom
/** M15 (contract §9; mission §20): the paths Recoup did not check are listed honestly, with no amounts. */
import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/dom";
import { CoverageList } from "./CoverageList";

describe("CoverageList", () => {
  it("lists only the paths not checked, with the reason and no amount", () => {
    render(
      <CoverageList
        rows={[
          { scenarioId: "R01", title: "Retail price adjustment", status: "implemented_verified", reason: "Checked by R01 v1.", ruleId: "R01", version: 1 },
          { scenarioId: "R06", title: "Card purchase protection", status: "not_checked", reason: "Needs the exact benefit guide for your card." },
          { scenarioId: "R23", title: "Class-action settlement", status: "not_checked", reason: "A name match is not class membership." },
        ]}
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("Card purchase protection");
    expect(text).toContain("Needs the exact benefit guide for your card.");
    expect(text).not.toContain("Retail price adjustment");
    expect(text).toContain("2 paths");
    expect(text).toContain("Recoup checks supported recovery paths only");
    expect(text).not.toMatch(/[$€£]\s?\d|\d+\.\d{2}/);
    expect(text.toLowerCase()).not.toContain("every right");
    expect(screen.getByText(/Paths not checked/)).toBeDefined();
  });

  it("renders nothing when every path was checked", () => {
    render(<CoverageList rows={[{ scenarioId: "R01", title: "Retail price adjustment", status: "implemented_verified", reason: "x" }]} />);
    expect(document.body.textContent).toBe("");
  });
});
