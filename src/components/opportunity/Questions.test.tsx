// @vitest-environment happy-dom
/**
 * M15 (mission §14 "Questions", contract §9, DA-A-1, DA-A-24, D164/D167): only the decisive missing facts, why
 * each is asked (sensitive ones say so), "I don't know", confirming or correcting what Recoup read, and
 * purchase-record facts routed to the purchase edit form instead of an answer box.
 *
 * Wave 1's catalogue has no facts answered through `facts.answer` (every R01 key is purchase-backed), so the
 * answerable keys below come from a test catalogue; the purchase-backed rows use the real one.
 */
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactSpec } from "../../../convex/lib/facts/catalog";
import { fireEvent, render, screen, waitFor } from "../../test/dom";
import type { FactCell, MissingFact } from "./model";
import { Questions, type FactAnswer } from "./Questions";

const TEST_SPECS: Record<string, FactSpec> = {
  "test.delivered": {
    key: "test.delivered", domain: "order", categories: ["retail_order"], subject: ["transaction"], value: "bool",
    question: { prompt: "Did the order arrive?", why: "A late order is owed a refund only if it did not arrive." }, userAssertable: true,
  },
  "test.disability": {
    key: "test.disability", domain: "air", categories: ["air_travel"], subject: ["transaction"], value: "bool",
    question: { prompt: "Do you have a disability that affected the trip?", why: "It changes which rule applies.", sensitive: true }, userAssertable: true,
  },
  "test.fee": {
    key: "test.fee", domain: "air", categories: ["air_travel"], subject: ["transaction"], value: "money", currencyMode: "new_scenario",
    question: { prompt: "How much was the bag fee?", why: "The refund is the fee you paid." }, userAssertable: true,
  },
  "test.ship_date": {
    key: "test.ship_date", domain: "order", categories: ["retail_order"], subject: ["transaction"], value: "local_date",
    question: { prompt: "When did the store promise to ship?", why: "The deadline counts from it." }, userAssertable: true,
  },
};

vi.mock("../../../convex/lib/facts/catalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../convex/lib/facts/catalog")>();
  return { ...real, getFactSpec: (key: string) => TEST_SPECS[key] ?? real.getFactSpec(key) };
});

const onAnswer = vi.fn(async (_answer: FactAnswer) => {});
beforeEach(() => onAnswer.mockClear());

const missing = (key: string, reason: MissingFact["reason"] = "missing", cls: MissingFact["class"] = "required"): MissingFact => ({
  subjectKey: "txn",
  key,
  reason,
  class: cls,
  neededFor: ["outcome"],
});

function renderQuestions(facts: MissingFact[], cells: FactCell[] = [], purchaseEditHref?: string) {
  render(
    <MemoryRouter>
      <Questions missing={facts} cells={cells} purchaseEditHref={purchaseEditHref} onAnswer={onAnswer} defaultCurrency="USD" />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

describe("Questions", () => {
  it("routes a purchase-record fact to the purchase edit form, with no answer box (answerVia, D167)", () => {
    const cell: FactCell = {
      subjectKey: "item:i1",
      key: "retail.unit_price",
      status: "candidate",
      value: { kind: "money", amountMinor: 4_999, currency: "USD" },
      sources: [{ kind: "legacy_purchase" }],
      capsOutcomeAt: "likely_eligible",
      userAssertable: true,
      answerVia: "purchases.confirm",
      question: { prompt: "What did you pay for one unit, before tax?", why: "The adjustment is the difference." },
    };
    const text = renderQuestions([{ ...missing("retail.unit_price", "candidate_unconfirmed"), subjectKey: "item:i1" }], [cell], "?edit=details");
    expect(screen.getByRole("link", { name: "Check it on the purchase details" }).getAttribute("href")).toBe("/?edit=details");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "I don't know" })).toBeNull();
    expect(text).toContain("Read from the purchase record");
    expect(text).toContain("Why we ask: The adjustment is the difference.");
  });

  it("routes a purchase-backed key to the form even when facts.list has no cell for it (missing)", () => {
    renderQuestions([missing("retail.purchase_date")], [], "?edit=details");
    expect(screen.getByRole("heading", { name: "When did you buy it?" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Check it on the purchase details" })).toBeDefined();
  });

  it("answers a yes/no fact and records 'I don't know' as unknown, never as a value (DA-A-1)", async () => {
    renderQuestions([missing("test.delivered")]);
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ subjectKey: "txn", key: "test.delivered", value: { kind: "bool", value: false } }));
    fireEvent.click(screen.getByRole("button", { name: "I don't know" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith({ subjectKey: "txn", key: "test.delivered", value: { kind: "user_unknown" } }));
    expect(screen.getByRole("status").textContent).toContain("Saved");
  });

  it("explains why a sensitive fact is asked before asking it", () => {
    const text = renderQuestions([missing("test.disability")]);
    expect(text).toContain("Sensitive: Recoup asks only because the answer decides this path.");
    expect(text).toContain("Why we ask: It changes which rule applies.");
  });

  it("confirms a value Recoup read, or lets the user correct it", async () => {
    const cell: FactCell = {
      subjectKey: "txn", key: "test.ship_date", status: "candidate",
      value: { kind: "local_date", date: "2026-09-01" }, sources: [{ kind: "evidence" }],
      capsOutcomeAt: "likely_eligible", userAssertable: true, answerVia: "facts.answer",
    };
    const text = renderQuestions([missing("test.ship_date", "candidate_unconfirmed")], [cell]);
    expect(text).toContain("Read from your email or document");
    fireEvent.click(screen.getByRole("button", { name: /is right$/ }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ subjectKey: "txn", key: "test.ship_date", value: { kind: "local_date", date: "2026-09-01" } }));
    fireEvent.change(screen.getByLabelText("Or enter the right value"), { target: { value: "2026-09-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith({ subjectKey: "txn", key: "test.ship_date", value: { kind: "local_date", date: "2026-09-03" } }));
  });

  it("shows disagreeing values with their sources and lets the user pick one", async () => {
    const cell: FactCell = {
      subjectKey: "txn", key: "test.delivered", status: "conflicting",
      conflict: { kind: "candidates", values: [{ value: { kind: "bool", value: true }, source: { kind: "evidence" } }, { value: { kind: "bool", value: false }, source: { kind: "price_check" } }] },
      capsOutcomeAt: null, userAssertable: true, answerVia: "facts.answer",
    };
    const text = renderQuestions([missing("test.delivered", "conflicting")], [cell]);
    expect(text).toContain("Your documents disagree: Yes (your email or document) vs No (a price check).");
    fireEvent.click(screen.getByRole("button", { name: "Use Yes" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ subjectKey: "txn", key: "test.delivered", value: { kind: "bool", value: true } }));
  });

  it("parses a money answer in the currency's exponent and refuses a signed amount", async () => {
    renderQuestions([missing("test.fee")]);
    const amount = screen.getByLabelText("Your answer");
    fireEvent.change(amount, { target: { value: "-35.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    expect(screen.getByRole("alert").textContent).toContain("without a minus sign");
    expect(onAnswer).not.toHaveBeenCalled();
    fireEvent.change(amount, { target: { value: "35.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save answer" }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ subjectKey: "txn", key: "test.fee", value: { kind: "money", amountMinor: 3_500, currency: "USD" } }));
  });

  it("asks each fact once, and only what the evaluation listed as decisive", () => {
    renderQuestions([missing("test.delivered"), missing("test.delivered"), missing("test.ship_date")]);
    expect(screen.getAllByRole("heading")).toHaveLength(2);
  });

  it("says when Recoup reads a fact itself instead of asking", () => {
    const text = renderQuestions([{ ...missing("retail.observed_price"), subjectKey: "item:i1" }], [], "?edit=details");
    expect(text).toContain("Recoup reads this itself");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("a previous 'I don't know' can be answered now", () => {
    const text = renderQuestions([missing("test.delivered", "user_unknown")]);
    expect(text).toContain("You said you don't know.");
    expect(screen.getByRole("button", { name: "Yes" })).toBeDefined();
  });
});
