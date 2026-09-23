// @vitest-environment happy-dom
/**
 * M24 /opportunities: recovery paths grouped by transaction, each linking to its purchase or transaction page, and
 * never added into one "money found" number (alternatives are not additive, D145).
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { formatMinor } from "../lib/money";
import { render, screen, within } from "../test/dom";
import { view } from "../test/opportunityFixtures";
import Opportunities from "./Opportunities";

let transactions: unknown[] = [];
let byTransaction: Record<string, unknown> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: { transactionId?: string } | "skip") => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "transactions:list") return { transactions, truncated: false };
    if (name === "opportunities:forTransaction") return byTransaction[args.transactionId!];
    return undefined;
  },
}));

const txn = (id: string, extra: Record<string, unknown> = {}) => ({
  _id: id, _creationTime: 1, userId: "u1", category: "air_travel", status: "active", counterpartyName: `Carrier ${id}`,
  currency: "USD", liveFactCount: 0, ...extra,
});

function renderPage() {
  render(
    <MemoryRouter>
      <Opportunities />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

beforeEach(() => {
  transactions = [txn("t1"), txn("t2", { category: "retail_order", purchaseId: "p2", counterpartyName: "Northwind" }), txn("t3")];
  byTransaction = {
    // Two alternative paths for one loss on t1, 2,500 and 3,000: they must never show as 5,500.
    t1: {
      opportunities: [
        view({ amount: { estimate: { amountMinor: 2_500, currency: "USD" }, basis: "exact_formula", formula: "", inputs: [] } }, { _id: "o1" as Id<"opportunities">, scenarioId: "R02", lossKeys: ["txn:t1:paid"] }),
        view({ amount: { estimate: { amountMinor: 3_000, currency: "USD" }, basis: "exact_formula", formula: "", inputs: [] } }, { _id: "o2" as Id<"opportunities">, scenarioId: "R03", lossKeys: ["txn:t1:paid"] }),
      ],
      pathsNotChecked: [],
      truncated: false,
    },
    t2: { opportunities: [view({}, { _id: "o3" as Id<"opportunities"> })], pathsNotChecked: [], truncated: false },
    t3: { opportunities: [], pathsNotChecked: [], truncated: false },
  };
});

describe("/opportunities", () => {
  it("groups paths by transaction and links each group to its page", () => {
    renderPage();
    const air = screen.getByRole("region", { name: "Carrier t1" });
    expect(within(air).getAllByRole("listitem")).toHaveLength(2);
    expect(within(air).getByRole("link", { name: "Carrier t1" }).getAttribute("href")).toBe("/transactions/t1");
    const retail = screen.getByRole("region", { name: "Northwind" });
    expect(within(retail).getByRole("link", { name: "Northwind" }).getAttribute("href")).toBe("/purchases/p2");
    // A transaction with no path is not listed.
    expect(screen.queryByRole("region", { name: "Carrier t3" })).toBeNull();
  });

  it("never adds alternative paths into one money figure", () => {
    const text = renderPage();
    expect(text).toContain(formatMinor(2_500, "USD"));
    expect(text).toContain(formatMinor(3_000, "USD"));
    expect(text).not.toContain(formatMinor(5_500, "USD"));
    expect(text).not.toContain(formatMinor(8_000, "USD"));
    expect(text).toContain("never added together");
  });

  it("an empty account gets a way to add something, not a zero", () => {
    transactions = [];
    const text = renderPage();
    expect(text).toContain("Nothing to check yet");
    expect(screen.getByRole("link", { name: "Add something" }).getAttribute("href")).toBe("/add");
    expect(text).not.toMatch(/\$0/);
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    renderPage();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
