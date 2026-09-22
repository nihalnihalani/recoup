// @vitest-environment happy-dom
/**
 * M15c (DA-B-9, DA-B-10): the claim page never says a claim is "owed" (the authority badge on the recovery-path
 * card carries the legal status; an open claim is what the user asked for), and "Credit landed" asks how the money
 * came back: to the card or original payment is a cash credit (`confirmCredit`); store credit, a gift card or points
 * go to the non-cash path (`recordNonCashRemedy`) and never count as money back.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import Claim from "./Claim";

const confirmCredit = vi.fn(async (_args: Record<string, unknown>) => ({ deduped: false }));
const recordNonCashRemedy = vi.fn(async (_args: Record<string, unknown>) => ({ deduped: false, remedyId: "r1" }));
let claimData: unknown;

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "claims:get") return claimData;
    if (name === "tracking:overview") return { items: [], totals: { byCurrency: {}, primaryCurrency: "USD" }, truncated: false };
    return undefined;
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "claims:confirmCredit") return confirmCredit;
    if (name === "claims:recordNonCashRemedy") return recordNonCashRemedy;
    return vi.fn(async () => null);
  },
  useAction: () => vi.fn(async () => null),
}));

const CLAIM_ID = "c1" as Id<"claims">;

function data(claim: Partial<Doc<"claims">> = {}, extra: Record<string, unknown> = {}) {
  return {
    claim: {
      _id: CLAIM_ID,
      _creationTime: 1,
      purchaseId: "p1",
      itemId: "i1",
      userId: "u1",
      type: "price_adjustment",
      expectedCents: 2_500,
      status: "detected",
      token: "tok",
      version: 1,
      ...claim,
    },
    item: { _id: "i1", _creationTime: 1, purchaseId: "p1", userId: "u1", name: "Kettle", unitCents: 12_500, qty: 1, returned: false },
    purchase: { _id: "p1", _creationTime: 1, userId: "u1", merchant: "Northwind", merchantDomain: "northwind.example", currency: "USD", status: "active" },
    events: [],
    drafts: [],
    replies: [],
    followUps: [],
    notes: [],
    policy: null,
    messages: [],
    balance: { expected: 2_500, promised: 0, confirmed: 0, debited: 0, unresolved: 2_500 },
    provisionalMinor: 0,
    nonCashRemedies: [],
    ...extra,
  };
}

function renderClaim() {
  render(
    <MemoryRouter initialEntries={[`/claims/${CLAIM_ID}`]}>
      <Routes>
        <Route path="/claims/:id" element={<Claim />} />
      </Routes>
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

function openCreditForm() {
  const summary = screen.getByText("Credit landed");
  fireEvent.click(summary);
  return summary.closest("details")!;
}

beforeEach(() => {
  confirmCredit.mockClear();
  recordNonCashRemedy.mockClear();
  claimData = data();
});

describe("claim headline (DA-B-9)", () => {
  it("an R01 claim linked to its opportunity says 'You asked for', never 'owed'", () => {
    claimData = data({ opportunityId: "o1" as Id<"opportunities">, scenarioId: "R01", remedyKey: "price_difference", currency: "USD" });
    const text = renderClaim();
    expect(screen.getByText("You asked for")).toBeDefined();
    expect(text).not.toMatch(/\bowed\b/i);
  });

  it("a legacy claim says 'You asked for' too", () => {
    claimData = data({ type: "return_credit" });
    const text = renderClaim();
    expect(screen.getByText("You asked for")).toBeDefined();
    expect(text).not.toMatch(/\bowed\b/i);
  });
});

describe("Credit landed asks how it came back (DA-B-10)", () => {
  it("requires a choice before anything is recorded", () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: "25.00" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirm credit" }));
    expect(within(form).getByRole("alert").textContent).toContain("Choose how it came back.");
    expect(confirmCredit).not.toHaveBeenCalled();
    expect(recordNonCashRemedy).not.toHaveBeenCalled();
  });

  it("to the card or original payment → a cash credit through confirmCredit", async () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.click(within(form).getByRole("radio", { name: /To my card or original payment/ }));
    fireEvent.change(within(form).getByLabelText(/^Amount/), { target: { value: "25.00" } });
    fireEvent.change(within(form).getByLabelText("Where you saw it"), { target: { value: "Card statement" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirm credit" }));
    await waitFor(() => expect(confirmCredit).toHaveBeenCalledTimes(1));
    expect(confirmCredit.mock.calls[0][0]).toMatchObject({ claimId: CLAIM_ID, cents: 2_500, evidence: "Card statement" });
    expect(recordNonCashRemedy).not.toHaveBeenCalled();
  });

  it("store credit or a gift card → a received non-cash remedy with its face value, never a cash credit", async () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.click(within(form).getByRole("radio", { name: /Store credit or a gift card/ }));
    fireEvent.change(within(form).getByLabelText(/^Value/), { target: { value: "25.00" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record store credit" }));
    await waitFor(() => expect(recordNonCashRemedy).toHaveBeenCalledTimes(1));
    expect(recordNonCashRemedy.mock.calls[0][0]).toMatchObject({
      claimId: CLAIM_ID,
      kind: "voucher",
      state: "received",
      faceValue: { amountMinor: 2_500, currency: "USD" },
    });
    expect(confirmCredit).not.toHaveBeenCalled();
    expect(within(form).getByRole("status").textContent).toContain("never counted as money back on your card");
  });

  it("points → a received non-cash remedy; the stated value is optional", async () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.click(within(form).getByRole("radio", { name: /Points/ }));
    fireEvent.change(within(form).getByLabelText("Where you saw it"), { target: { value: "500 points in the app" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record points" }));
    await waitFor(() => expect(recordNonCashRemedy).toHaveBeenCalledTimes(1));
    expect(recordNonCashRemedy.mock.calls[0][0]).toMatchObject({ kind: "points", state: "received", description: "500 points in the app" });
    expect(recordNonCashRemedy.mock.calls[0][0]).not.toHaveProperty("faceValue");
    expect(confirmCredit).not.toHaveBeenCalled();
  });

  it("a recorded non-cash remedy is listed apart from cash and never in 'Confirmed'", () => {
    claimData = data({}, {
      nonCashRemedies: [
        { _id: "r1", _creationTime: 2, userId: "u1", claimId: CLAIM_ID, kind: "voucher", description: "Gift card", faceValue: { amountMinor: 2_500, currency: "USD" }, state: "received", idempotencyKey: "k", recordedAt: 2 },
      ],
    });
    const text = renderClaim();
    expect(text).toContain("Non-cash, not counted as money back");
    expect(text).toContain("Store credit or gift card · received");
    const ledger = screen.getByText("Confirmed").closest("div")!;
    expect(ledger.textContent).toContain("$0.00");
  });
});
