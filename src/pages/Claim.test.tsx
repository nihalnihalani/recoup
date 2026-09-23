// @vitest-environment happy-dom
/**
 * M15c (DA-B-9, DA-B-10): the claim page never says a claim is "owed" (the authority badge on the recovery-path
 * card carries the legal status; an open claim is what the user asked for), and "Credit landed" asks how the money
 * came back: to the card or original payment is a cash credit (`confirmCredit`); store credit, a gift card or points
 * RESOLVE the claim with a non-cash remedy (DA-B-16: `recordNonCashResolution`) and never count as money back.
 * M24 part 2: a recorded denial and a non-cash resolution are states, not money tiles; an item-less scenario claim
 * is titled by its counterparty; a manual-channel claim gets the packet section instead of the email composer.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import Claim from "./Claim";

const confirmCredit = vi.fn(async (_args: Record<string, unknown>) => ({ deduped: false }));
const recordNonCashResolution = vi.fn(async (_args: Record<string, unknown>) => ({ deduped: false, remedyId: "r1" }));
const recordDenial = vi.fn(async (_args: Record<string, unknown>) => null);
const confirmHeldPromise = vi.fn(async (_args: Record<string, unknown>) => ({ ledgerWritten: true }));
let claimData: unknown;
let overviewItems: unknown[] = [];

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "claims:get") return claimData;
    if (name === "tracking:overview") return { items: overviewItems, totals: { byCurrency: {}, primaryCurrency: "USD" }, truncated: false };
    if (name === "packets:listForClaim") return { packets: [], submissions: [] };
    return undefined;
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "claims:confirmCredit") return confirmCredit;
    if (name === "claims:recordNonCashResolution") return recordNonCashResolution;
    if (name === "claims:recordDenial") return recordDenial;
    if (name === "replies:confirmHeldPromise") return confirmHeldPromise;
    return vi.fn(async () => null);
  },
  useAction: () => vi.fn(async () => null),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => "token" }));

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
    transaction: null,
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
  recordNonCashResolution.mockClear();
  recordDenial.mockClear();
  confirmHeldPromise.mockClear();
  overviewItems = [];
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
    expect(recordNonCashResolution).not.toHaveBeenCalled();
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
    expect(recordNonCashResolution).not.toHaveBeenCalled();
  });

  it("store credit or a gift card → resolves the claim with a non-cash remedy (DA-B-16), never a cash credit", async () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.click(within(form).getByRole("radio", { name: /Store credit or a gift card/ }));
    fireEvent.change(within(form).getByLabelText(/^Value/), { target: { value: "25.00" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record store credit" }));
    await waitFor(() => expect(recordNonCashResolution).toHaveBeenCalledTimes(1));
    expect(recordNonCashResolution.mock.calls[0][0]).toMatchObject({
      claimId: CLAIM_ID,
      kind: "voucher",
      faceValue: { amountMinor: 2_500, currency: "USD" },
    });
    expect(recordNonCashResolution.mock.calls[0][0]).not.toHaveProperty("state");
    expect(confirmCredit).not.toHaveBeenCalled();
    const status = within(form).getByRole("status").textContent ?? "";
    expect(status).toContain("This claim is now closed with a non-cash remedy");
    expect(status).toContain("never counted as money back on your card");
  });

  it("points → a non-cash resolution; the stated value is optional", async () => {
    renderClaim();
    const form = openCreditForm();
    fireEvent.click(within(form).getByRole("radio", { name: /Points/ }));
    fireEvent.change(within(form).getByLabelText("Where you saw it"), { target: { value: "500 points in the app" } });
    fireEvent.click(within(form).getByRole("button", { name: "Record points" }));
    await waitFor(() => expect(recordNonCashResolution).toHaveBeenCalledTimes(1));
    expect(recordNonCashResolution.mock.calls[0][0]).toMatchObject({ kind: "points", description: "500 points in the app" });
    expect(recordNonCashResolution.mock.calls[0][0]).not.toHaveProperty("faceValue");
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

describe("closed states are states, not money tiles", () => {
  it("a recorded denial shows as Denied with the user's words; no ask figure, no denial or dismiss action", () => {
    claimData = data(
      { status: "denied" },
      { notes: [{ _id: "n1", _creationTime: 3, claimId: CLAIM_ID, userId: "u1", kind: "status", text: "Denied: Outside the 14-day window" }] },
    );
    const text = renderClaim();
    expect(screen.getByText("Where this claim stands")).toBeDefined();
    expect(screen.getAllByText("Denied").length).toBeGreaterThan(0);
    expect(text).toContain("Outside the 14-day window");
    expect(screen.queryByText("You asked for")).toBeNull();
    expect(screen.queryByText("They said no")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss this claim" })).toBeNull();
    expect(text).not.toMatch(/\bowed\b/i);
    // Nothing is drawn as still open on a closed claim.
    expect(text).not.toContain("Still open");
    expect(text).not.toContain("Unresolved");
    expect(text).toContain("Nothing is open on this claim (denied)");
  });

  it("a non-cash resolution shows as resolved, not as money asked or back", () => {
    claimData = data({ status: "sent", nonCashResolvedAt: Date.UTC(2026, 8, 20) });
    const text = renderClaim();
    expect(screen.getByText("Resolved with a non-cash remedy")).toBeDefined();
    expect(text).toContain("never as money asked for or back on your card");
    expect(text).not.toMatch(/\bowed\b/i);
    expect(text).not.toContain("Still open");
    expect(screen.queryByText("You asked for")).toBeNull();
    expect(screen.queryByText("Back to your card or account")).toBeNull();
    expect(screen.queryByText("They said no")).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss this claim" })).toBeNull();
  });
});

describe("recording a denial (recordDenial)", () => {
  function openDenial() {
    const summary = screen.getByText("They said no");
    fireEvent.click(summary);
    return summary.closest("details")!;
  }

  it("is offered once the claim was asked, and records the user's own words", async () => {
    claimData = data({ status: "sent" });
    renderClaim();
    const form = openDenial();
    fireEvent.change(within(form).getByLabelText("What did they answer?"), { target: { value: "  Not eligible for adjustment  " } });
    fireEvent.click(within(form).getByRole("button", { name: "Record the refusal" }));
    await waitFor(() => expect(recordDenial).toHaveBeenCalledTimes(1));
    expect(recordDenial.mock.calls[0][0]).toEqual({ claimId: CLAIM_ID, reason: "Not eligible for adjustment" });
  });

  it("needs a reason", () => {
    claimData = data({ status: "packet" });
    renderClaim();
    const form = openDenial();
    fireEvent.click(within(form).getByRole("button", { name: "Record the refusal" }));
    expect(within(form).getByRole("alert").textContent).toContain("Say briefly what they answered.");
    expect(recordDenial).not.toHaveBeenCalled();
  });

  it("is not offered before anything was asked", () => {
    claimData = data({ status: "drafted" });
    renderClaim();
    expect(screen.queryByText("They said no")).toBeNull();
  });
});

describe("item-less and manual-channel claims (M20)", () => {
  const TXN = { _id: "t1", _creationTime: 1, userId: "u1", category: "air_travel", status: "active", counterpartyName: "Example Air", currency: "EUR", liveFactCount: 3 };

  it("an item-less scenario claim is titled by its scenario and links to its counterparty's transaction", () => {
    claimData = data(
      { itemId: undefined, purchaseId: undefined, transactionId: "t1" as Id<"transactions">, scenarioId: "R02", currency: "EUR" },
      { item: null, purchase: null, transaction: TXN },
    );
    const text = renderClaim();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Airline cancellation or significant-change refund");
    expect(screen.getByRole("link", { name: "Example Air" }).getAttribute("href")).toBe("/transactions/t1");
    expect(text).not.toContain("Purchase missing");
    expect(text).toContain("(EUR)");
    // Price history, the price window and Paid/Now/Lowest belong to a purchased item.
    expect(text).not.toContain("No price history");
    expect(text).not.toContain("Claim window");
    expect(screen.queryByText("Lowest")).toBeNull();
  });

  it("a claim filed by post gets the packet section, not the email composer", () => {
    claimData = data(
      { itemId: undefined, purchaseId: undefined, transactionId: "t1" as Id<"transactions">, requiredChannel: "postal_mail", currency: "EUR" },
      { item: null, purchase: null, transaction: TXN },
    );
    renderClaim();
    expect(screen.getByText("Packet you file yourself")).toBeDefined();
    expect(screen.queryByText("Message to the store")).toBeNull();
    expect(screen.queryByRole("button", { name: "Write the message" })).toBeNull();
    expect(screen.getByRole("button", { name: "Prepare the packet" })).toBeDefined();
  });

  it("an email claim keeps the composer", () => {
    claimData = data({ requiredChannel: "email" });
    renderClaim();
    expect(screen.getByText("Message to the store")).toBeDefined();
    expect(screen.queryByText("Packet you file yourself")).toBeNull();
  });
});

describe("held promises from a sender Recoup can't verify (D21/D178, M28)", () => {
  const held = {
    _id: "r1",
    _creationTime: 5,
    claimId: CLAIM_ID,
    userId: "u1",
    messageId: "m1",
    from: "refunds@northwind-support.example",
    classification: "promise",
    summary: "We will refund the difference.",
    promisedCents: 2_000,
    senderMismatch: true,
    receivedAt: 5,
    heldForConfirmation: true,
  };

  it("is held and never money until the owner confirms it once", async () => {
    claimData = data({ status: "sent" }, { replies: [held] });
    renderClaim();
    const panel = screen.getByRole("region", { name: "Held: we can't verify the sender" });
    expect(panel.textContent).toContain("refunds@northwind-support.example");
    expect(panel.textContent).toContain("not counted anywhere until you confirm");
    // The timeline names the hold and shows no amount beside it.
    const timelineEntry = screen.getAllByText("Held: we can't verify the sender").find((el) => el.closest("ol"));
    expect(timelineEntry).toBeDefined();
    expect(timelineEntry!.closest("li")!.textContent).not.toContain("$20.00");
    expect(timelineEntry!.closest("li")!.textContent).toContain("Not counted until you confirm it");
    // Nothing promised on the ledger.
    expect(screen.getByText("You asked for")).toBeDefined();
    const button = within(panel).getByRole("button", { name: "It's genuine: record the promise" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(confirmHeldPromise).toHaveBeenCalledTimes(1));
    expect(confirmHeldPromise.mock.calls[0][0]).toEqual({ replyId: "r1" });
    expect((await within(panel).findByRole("status")).textContent).toContain("Recorded as a promise of $20.00");
  });

  it("a confirmed reply is an ordinary promise, marked as confirmed by you", () => {
    claimData = data({ status: "promised" }, { replies: [{ ...held, heldForConfirmation: false, confirmedByUserAt: 6 }] });
    const text = renderClaim();
    expect(screen.queryByRole("region", { name: "Held: we can't verify the sender" })).toBeNull();
    expect(text).toContain("confirmed by you");
  });

  it("F3 regression: a held promise on a DISMISSED claim offers no confirm action and never claims a promise was recorded", async () => {
    // replies.recordPromise (convex/replies.ts) skips both the ledger write and the status change for a dismissed
    // claim (D53), so confirmHeldPromise always resolves {ledgerWritten:false} here -- the old unconditional copy
    // ("Recorded as a promise…") would have told the user something was recorded when nothing was.
    claimData = data({ status: "dismissed" }, { replies: [held] });
    confirmHeldPromise.mockResolvedValueOnce({ ledgerWritten: false });
    renderClaim();
    const panel = screen.getByRole("region", { name: "Held: we can't verify the sender" });
    expect(within(panel).queryByRole("button", { name: "It's genuine: record the promise" })).toBeNull();
    expect(panel.textContent).toContain("This claim is dismissed, so confirming it would record nothing.");
    expect(confirmHeldPromise).not.toHaveBeenCalled();
  });
});

describe("P06-OW-2: the claim page never presents an out-of-date price as today's", () => {
  const tracked = (over: Record<string, unknown>) => ({
    itemId: "i1", purchaseId: "p1", name: "Kettle", merchant: "Northwind", merchantDomain: "northwind.example", currency: "USD", qty: 1,
    paidCents: 12_500, isExample: false, points: [{ at: 1, cents: 10_000 }], checks: 1, lastCheckedAt: 1, lastObservedAt: 1,
    priceStale: false, latestCents: 10_000, lowestCents: 10_000, dropCents: 2_500, ...over,
  });

  it("a stale price is 'Last price read', flagged out of date, with no drop badge", () => {
    overviewItems = [tracked({ priceStale: true })];
    const text = renderClaim();
    expect(screen.queryByText("Now")).toBeNull();
    expect(screen.getByText("Last price read")).toBeDefined();
    expect(text).toContain("Out of date: price read");
  });

  it("a fresh price is 'Now' with its age", () => {
    overviewItems = [tracked({})];
    const text = renderClaim();
    expect(screen.getByText("Now")).toBeDefined();
    expect(text).toMatch(/Price read .* ago/);
    expect(text).not.toContain("Out of date");
  });
});
