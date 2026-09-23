// @vitest-environment happy-dom
/**
 * M24 /opportunities (D220): recovery paths from ONE `opportunities.listMine` read, grouped by transaction, each
 * group linking to its transaction page (a retail one forwards to its purchase), and never added into one "money
 * found" number (alternatives are not additive, D145).
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { formatMinor } from "../lib/money";
import { render, screen, within } from "../test/dom";
import { NOW, view } from "../test/opportunityFixtures";
import Opportunities from "./Opportunities";

let listMine: { items: unknown[]; truncated: boolean } | undefined;
const queried: string[] = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    queried.push(name);
    if (name === "opportunities:listMine") return listMine;
    return undefined;
  },
}));

function item(transactionId: string, category: string, counterpartyName: string, v: ReturnType<typeof view>) {
  return { ...v, transactionId, category, counterpartyName };
}

function renderPage() {
  render(
    <MemoryRouter>
      <Opportunities />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

const estimate = (amountMinor: number) => ({
  amount: { estimate: { amountMinor, currency: "USD" }, basis: "exact_formula" as const, formula: "", inputs: [] },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  queried.length = 0;
  listMine = {
    items: [
      // Two alternative paths for one loss on t1, 2,500 and 3,000: they must never show as 5,500.
      item("t1", "air_travel", "Carrier t1", view(estimate(2_500), { _id: "o1" as Id<"opportunities">, scenarioId: "R02", lossKeys: ["txn:t1:paid"] })),
      item("t2", "retail_order", "Northwind", view({}, { _id: "o3" as Id<"opportunities"> })),
      item("t1", "air_travel", "Carrier t1", view(estimate(3_000), { _id: "o2" as Id<"opportunities">, scenarioId: "R03", lossKeys: ["txn:t1:paid"] })),
    ],
    truncated: false,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/opportunities", () => {
  it("reads listMine once and groups paths by transaction, each linking to its transaction page", () => {
    renderPage();
    expect(new Set(queried)).toEqual(new Set(["opportunities:listMine"]));
    const air = screen.getByRole("region", { name: "Carrier t1" });
    expect(within(air).getAllByRole("listitem")).toHaveLength(2);
    expect(within(air).getByRole("link", { name: "Carrier t1" }).getAttribute("href")).toBe("/transactions/t1");
    const retail = screen.getByRole("region", { name: "Northwind" });
    expect(within(retail).getByRole("link", { name: "Northwind" }).getAttribute("href")).toBe("/transactions/t2");
    // Groups keep the server's order (newest evaluation first).
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"))).toEqual(["group-t1", "group-t2"]);
  });

  it("never adds alternative paths into one money figure", () => {
    const text = renderPage();
    expect(text).toContain(formatMinor(2_500, "USD"));
    expect(text).toContain(formatMinor(3_000, "USD"));
    expect(text).not.toContain(formatMinor(5_500, "USD"));
    expect(text).not.toContain(formatMinor(8_000, "USD"));
    expect(text).toContain("never added together");
  });

  it("says when the list is cut", () => {
    listMine = { ...listMine!, truncated: true };
    expect(renderPage()).toContain("Showing your most recently checked paths only");
  });

  it("marks an example path and a path with a claim open", () => {
    listMine = {
      items: [item("t9", "air_travel", "Example Air", view({}, { _id: "o9" as Id<"opportunities">, isExample: true, status: "case_open" }))],
      truncated: false,
    };
    const text = renderPage();
    expect(text).toContain("Example");
    expect(text).toContain("Claim open");
  });

  it("shows a loading state while the read is in flight", () => {
    listMine = undefined;
    renderPage();
    expect(screen.queryByRole("heading", { name: "Recovery paths" })).toBeNull();
  });

  it("an empty account gets a way to add something, not a zero", () => {
    listMine = { items: [], truncated: false };
    const text = renderPage();
    expect(text).toContain("No recovery paths yet");
    expect(screen.getByRole("link", { name: "Add something" }).getAttribute("href")).toBe("/add");
    expect(text).not.toMatch(/\$0/);
  });

  it("P06-OW-1: a row past its user deadline shows no outcome chip and no estimate", () => {
    const dueAt = NOW - 3_600_000;
    listMine = {
      items: [
        item(
          "t5",
          "retail_order",
          "Northwind",
          view(
            { outcome: "likely_eligible", ...estimate(2_500), deadlines: [{ id: "w", label: "Window", obligor: "user", status: "open", dueAt, mustBe: "n_a", basis: "x" }] },
            { _id: "o5" as Id<"opportunities">, outcome: "likely_eligible", nextDeadlineAt: dueAt },
          ),
        ),
      ],
      truncated: false,
    };
    const text = renderPage();
    expect(text).toContain("Window may have passed");
    expect(text).not.toContain("Likely eligible");
    expect(text).not.toContain(formatMinor(2_500, "USD"));
    expect(text).toContain("Your deadline passed");
  });

  it("M29: current deadline attention is counted at the top and marked on its row", () => {
    const due = NOW + 3 * 86_400_000;
    listMine = {
      items: [
        item("t6", "air_travel", "Example Air", view({}, { _id: "o6" as Id<"opportunities">, nextDeadlineAt: due, deadlineAttention: { setAt: NOW, dueAt: due, deadlineId: "d" } })),
        item("t6", "air_travel", "Example Air", view({}, { _id: "o7" as Id<"opportunities"> })),
      ],
      truncated: false,
    };
    const text = renderPage();
    expect(text).toContain("1 path has a deadline of yours coming up.");
    expect(screen.getAllByText("Deadline soon")).toHaveLength(1);
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    renderPage();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
