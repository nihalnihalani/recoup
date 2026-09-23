// @vitest-environment happy-dom
/**
 * F2 (D266 audit): `budget.status`'s `paused` was already true for both a durable operator pause (P12-W4) and an
 * ordinary daily/monthly cap, but the banner always said "paused until tomorrow -- today's shared limit was
 * reached," which is false for an operator pause (it does not lift at midnight; only `ops.resumeKind` does). This
 * ties the rendered copy to `pauseReason`.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "../test/dom";
import { BudgetBanner } from "./BudgetBanner";

type Kind = { kind: string; userUsed: number; userMax: number; globalUsed: number; globalMax: number; paused: boolean; pauseReason?: "operator" | "cap" };

let status: { day: string; kinds: Kind[] } | undefined;

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">) => {
    const name = getFunctionName(ref);
    if (name === "budget:status") return status;
    return undefined;
  },
}));

function kind(overrides: Partial<Kind> & { kind: string }): Kind {
  return { userUsed: 0, userMax: 10, globalUsed: 0, globalMax: 10, paused: false, ...overrides };
}

beforeEach(() => {
  status = undefined;
});

describe("BudgetBanner (F2)", () => {
  it("renders nothing while the query is loading or nothing is paused", () => {
    status = undefined;
    const { container: loading } = render(<BudgetBanner />);
    expect(loading.textContent).toBe("");

    status = { day: "2026-09-24", kinds: [kind({ kind: "paste" })] };
    const { container: none } = render(<BudgetBanner />);
    expect(none.textContent).toBe("");
  });

  it("a plain cap says 'tomorrow' and 'today's shared limit'", () => {
    status = { day: "2026-09-24", kinds: [kind({ kind: "market_lookup", paused: true, pauseReason: "cap" })] };
    render(<BudgetBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/tomorrow/i);
    expect(text).toMatch(/today's shared limit/i);
    expect(text).not.toMatch(/operator/i);
  });

  it("an operator pause (P12-W4) never says 'tomorrow' or 'midnight'", () => {
    status = { day: "2026-09-24", kinds: [kind({ kind: "draft_generate", paused: true, pauseReason: "operator" })] };
    render(<BudgetBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toContain("Writing drafts");
    expect(text).toMatch(/paused for now/i);
    expect(text).not.toMatch(/tomorrow/i);
    expect(text).not.toMatch(/midnight/i);
  });

  it("a mix of both reasons renders one clause per reason, each with its own kinds", () => {
    status = {
      day: "2026-09-24",
      kinds: [
        kind({ kind: "market_lookup", paused: true, pauseReason: "cap" }),
        kind({ kind: "draft_generate", paused: true, pauseReason: "operator" }),
        kind({ kind: "paste" }), // not paused: never mentioned
      ],
    };
    render(<BudgetBanner />);
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).toMatch(/market history look-ups.*tomorrow/i);
    expect(text).toMatch(/writing drafts.*paused for now/i);
    expect(text).not.toMatch(/reading pasted emails/i);
  });
});
