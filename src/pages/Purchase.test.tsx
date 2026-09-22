// @vitest-environment happy-dom
/**
 * M15 (D164, DA-A-33, D167; contract §9): the purchase details form sends an explicit, user-visible currency to
 * `purchases.confirm`, parses prices without floating point, and doubles as the edit path for facts the purchase
 * record backs (`?edit=details`); each item carries its recovery-path cards from `opportunities.forPurchase`, and
 * the page lists the paths not checked.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import { view } from "../test/opportunityFixtures";
import Purchase from "./Purchase";

const confirm = vi.fn(async (_args: Record<string, unknown>) => null);
const reevaluate = vi.fn(async (_args: Record<string, unknown>) => ({ evaluated: 1 }));
const openCase = vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, claimId: "c1", created: true }));
const mutations: Record<string, unknown> = {
  "purchases:confirm": confirm,
  "opportunities:reevaluate": reevaluate,
  "opportunities:openCase": openCase,
};
let queryResults: Record<string, unknown> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) =>
    args === "skip" ? undefined : queryResults[getFunctionName(ref)],
  useMutation: (ref: FunctionReference<"mutation">) => mutations[getFunctionName(ref)] ?? vi.fn(),
  useAction: () => vi.fn(),
}));

const PURCHASE_ID = "p1" as Id<"purchases">;

function purchaseData(status: "needs_review" | "active", opts: { currency?: string; claims?: unknown[] } = {}) {
  return {
    purchase: {
      _id: PURCHASE_ID,
      _creationTime: 1,
      userId: "u1",
      merchant: "Northwind",
      merchantDomain: "northwind.example",
      orderRef: "A-1",
      purchasedAt: Date.UTC(2026, 8, 1, 12),
      currency: opts.currency ?? "GBP",
      status,
    },
    items: [
      {
        _id: "i1",
        _creationTime: 1,
        purchaseId: PURCHASE_ID,
        userId: "u1",
        name: "Kettle",
        productUrl: "https://northwind.example/kettle",
        unitCents: 4_999,
        qty: 1,
        returned: false,
        claims: opts.claims ?? [],
        priceChecks: [],
        verdict: { label: "no_data", reason: "", tone: "gray" },
      },
    ],
    policies: [],
  };
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/purchases/:id" element={<Purchase />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  confirm.mockClear();
  reevaluate.mockClear();
  openCase.mockClear();
  queryResults = {};
});

describe("purchase details form: currency (D164)", () => {
  it("shows the extracted currency, says confirming confirms it, and sends it explicitly", async () => {
    queryResults["purchases:get"] = purchaseData("needs_review");
    renderAt(`/purchases/${PURCHASE_ID}`);
    const field = screen.getByLabelText("Currency") as HTMLInputElement;
    expect(field.value).toBe("GBP");
    expect(screen.getByText(/Read from the order email as GBP\. Confirming the purchase confirms this currency/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({
      purchaseId: PURCHASE_ID,
      currency: "GBP",
      items: [{ itemId: "i1", unitCents: 4_999, qty: 1 }],
    });
  });

  it("sends the currency the user corrected, upper-cased", async () => {
    queryResults["purchases:get"] = purchaseData("needs_review");
    renderAt(`/purchases/${PURCHASE_ID}`);
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "eur" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({ currency: "EUR" });
  });

  it("refuses a code that is not a currency, without calling the server", () => {
    queryResults["purchases:get"] = purchaseData("needs_review");
    renderAt(`/purchases/${PURCHASE_ID}`);
    fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "ZZZ" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    expect(screen.getByRole("alert").textContent).toMatch(/3-letter code/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("parses prices by string arithmetic and refuses an ambiguous one", async () => {
    queryResults["purchases:get"] = purchaseData("needs_review");
    renderAt(`/purchases/${PURCHASE_ID}`);
    const price = screen.getByLabelText("Item 1 unit price") as HTMLInputElement;
    expect(price.value).toBe("49.99");

    fireEvent.change(price, { target: { value: "12,34" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    expect(screen.getByRole("alert").textContent).toMatch(/unit price/);
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.change(price, { target: { value: "1,234.05" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm purchase" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({ items: [{ unitCents: 123_405 }] });
  });
});

describe("editing an active purchase (the answerVia purchases.confirm path, D167)", () => {
  it("opens the same form at ?edit=details and saves through purchases.confirm", async () => {
    queryResults["purchases:get"] = purchaseData("active", { currency: "USD" });
    renderAt(`/purchases/${PURCHASE_ID}?edit=details`);
    expect(screen.getByRole("region", { name: "Edit this purchase" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatchObject({ currency: "USD" });
  });

  it("locks the currency once a claim exists on the purchase", () => {
    queryResults["purchases:get"] = purchaseData("active", { currency: "USD", claims: [{ _id: "c1" }] });
    renderAt(`/purchases/${PURCHASE_ID}?edit=details`);
    expect((screen.getByLabelText("Currency") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/A claim already uses this currency/)).toBeDefined();
  });
});

describe("recovery paths on the purchase page (M12 queries)", () => {
  it("shows the item's opportunity card beside it, the paths not checked, and wires its actions", async () => {
    queryResults["purchases:get"] = purchaseData("active", { currency: "USD" });
    queryResults["opportunities:forPurchase"] = {
      opportunities: [view()],
      pathsNotChecked: [{ scenarioId: "R06", title: "Card purchase protection", status: "not_checked", reason: "Needs the exact benefit guide." }],
      truncated: false,
    };
    renderAt(`/purchases/${PURCHASE_ID}`);
    const card = screen.getByRole("article", { name: "Retail price adjustment: recovery path" });
    expect(within(card).getByText("Merchant or carrier promise")).toBeDefined();
    expect(screen.getByText("Card purchase protection")).toBeDefined();

    fireEvent.click(within(card).getByRole("button", { name: "Start a claim" }));
    await waitFor(() => expect(openCase).toHaveBeenCalledWith({ opportunityId: "o1" }));
    fireEvent.click(within(card).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reevaluate).toHaveBeenCalledWith({ purchaseId: PURCHASE_ID }));
  });

  it("sends a purchase-record question to the details form (?edit=details)", () => {
    queryResults["purchases:get"] = purchaseData("active", { currency: "USD" });
    queryResults["opportunities:forPurchase"] = {
      opportunities: [
        view({
          outcome: "needs_facts",
          amount: null,
          missingFacts: [{ subjectKey: "txn", key: "retail.purchase_date", reason: "missing", class: "required", neededFor: ["outcome"] }],
          nextAction: { kind: "none", reason: "Confirm the purchase details on the purchase page: retail.purchase_date." },
        }),
      ],
      pathsNotChecked: [],
      truncated: false,
    };
    renderAt(`/purchases/${PURCHASE_ID}`);
    const link = screen.getByRole("link", { name: "Check it on the purchase details" });
    expect(link.getAttribute("href")).toBe(`/purchases/${PURCHASE_ID}?edit=details`);
  });
});
