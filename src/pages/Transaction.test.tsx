// @vitest-environment happy-dom
/**
 * M24 /transactions/:id: facts labelled by how sure they are (a candidate is never "Confirmed"), recovery paths with
 * their questions answered through facts.answer, the paths not checked, an honest "not available yet" for the
 * document list, a redirect for retail orders, and the shared not-found for a foreign or unknown id.
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import { view } from "../test/opportunityFixtures";
import Transaction from "./Transaction";

const answer = vi.fn(async (_args: Record<string, unknown>) => ({ factId: "f1", outcome: "inserted" }));
const reevaluate = vi.fn(async (_args: Record<string, unknown>) => ({ evaluated: 1 }));
const attach = vi.fn(async (_args: Record<string, unknown>) => ({ changed: true }));
let results: Record<string, unknown> = {};
let throwing: string | null = null;

vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => "token-1" }));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (throwing === name) throw new ConvexError("Transaction not found");
    return results[name];
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "facts:answer") return answer;
    if (name === "opportunities:reevaluate") return reevaluate;
    if (name === "evidence:attachToTransaction") return attach;
    return vi.fn(async () => null);
  },
}));

const TXN = {
  _id: "t1", _creationTime: 1, userId: "u1", category: "air_travel", status: "active", counterpartyName: "Acme Air",
  currency: "USD", totalMinor: 48_000, transactedAt: Date.UTC(2026, 8, 1, 12), liveFactCount: 3,
};

function renderAt(path = "/transactions/t1") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/transactions/:id" element={<ErrorBoundary><Transaction /></ErrorBoundary>} />
        <Route path="/purchases/:id" element={<p>purchase page</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

beforeEach(() => {
  answer.mockClear();
  reevaluate.mockClear();
  attach.mockClear();
  throwing = null;
  results = {
    "transactions:get": TXN,
    "facts:list": [
      { subjectKey: "txn", key: "air.total_paid", status: "confirmed", value: { kind: "money", amountMinor: 48_000, currency: "USD" }, source: { kind: "user" }, capsOutcomeAt: null, userAssertable: true },
      { subjectKey: "txn", key: "air.cancellation_notice_at", status: "candidate", value: { kind: "instant", epochMs: Date.UTC(2026, 8, 2, 9) }, sources: [{ kind: "evidence" }], capsOutcomeAt: "likely_eligible", userAssertable: true },
      {
        subjectKey: "txn", key: "air.actual_arrival_at", status: "conflicting", capsOutcomeAt: null, userAssertable: true,
        conflict: { kind: "candidates", values: [{ value: { kind: "text", text: "10:05" }, source: { kind: "evidence" } }, { value: { kind: "text", text: "11:40" }, source: { kind: "user" } }] },
      },
    ],
    "opportunities:forTransaction": {
      opportunities: [
        view(
          { outcome: "needs_facts", amount: null, nextAction: { kind: "none", reason: "x" }, missingFacts: [{ subjectKey: "txn", key: "air.cancellation_notice_at", reason: "candidate_unconfirmed", class: "required", neededFor: ["outcome"] }] },
          { scenarioId: "R02", authorityClass: "legal_entitlement", transactionId: "t1" as never },
        ),
      ],
      pathsNotChecked: [{ scenarioId: "R09", title: "Involuntary denied boarding", status: "not_checked", reason: "Not checked yet." }],
      truncated: false,
    },
    "evidence:listForTransaction": {
      evidence: [
        evidence("ev1", { fileName: "boarding-pass.png", docType: "e_ticket", hasFile: true }),
        evidence("ev2", { kind: "email", fileName: null, docType: "cancellation_notice", hasFile: false, retention: "content_deleted", headers: { subject: "Your flight was cancelled" }, extractionSummary: null }),
      ],
      truncated: false,
    },
    "evidence:listRecent": [evidence("ev9", { transactionId: null, fileName: "hotel-receipt.pdf", docType: "expense_receipt" }), evidence("ev8", { fileName: "elsewhere.pdf" })],
  };
});

function evidence(id: string, extra: Record<string, unknown> = {}) {
  return {
    _id: id, transactionId: "t1", kind: "upload", docType: "receipt", docTypeDeclaredBy: "user", sourceChannel: "upload",
    provenance: "user_uploaded", contentHash: "a".repeat(64), mimeType: "image/png", sizeBytes: 10, fileName: "x.png", hasFile: true,
    text: null, headers: null, receivedAt: Date.UTC(2026, 8, 2, 9), pinnedAt: null, extractionStatus: "store_only",
    extractionSummary: "Automatic reading of uploaded documents is switched off, so this file is stored only.", retention: "active",
    isExample: false, ...extra,
  };
}

describe("/transactions/:id", () => {
  it("labels every fact by how sure it is, and never calls a candidate confirmed", () => {
    renderAt();
    const facts = screen.getByRole("region", { name: "What Recoup knows" });
    const needs = within(facts).getByText("Needs your confirmation").parentElement!;
    expect(needs.textContent).toContain("Read from a document, not confirmed");
    expect(needs.textContent).toContain("Sources disagree");
    expect(needs.textContent).toContain("10:05 (a document) vs 11:40 (your entry)");
    const settled = within(facts).getByText("Confirmed and observed").parentElement!;
    expect(settled.textContent).toContain("Confirmed");
    expect(settled.textContent).not.toContain("not confirmed");
  });

  it("shows its recovery paths with questions answered through facts.answer on this transaction", async () => {
    renderAt();
    const paths = screen.getByRole("region", { name: "Recovery paths" });
    expect(within(paths).getByText("Airline cancellation or significant-change refund")).toBeDefined();
    expect(within(paths).getByText("Involuntary denied boarding")).toBeDefined();
    fireEvent.click(within(paths).getByRole("button", { name: "I don't know" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ transactionId: "t1", subjectKey: "txn", key: "air.cancellation_notice_at", value: { kind: "user_unknown" } }));
    fireEvent.click(within(paths).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(reevaluate).toHaveBeenCalledWith({ transactionId: "t1" }));
  });

  it("says plainly when no path applies, and still lists the paths not checked", () => {
    results["opportunities:forTransaction"] = { opportunities: [], pathsNotChecked: [{ scenarioId: "R09", title: "Involuntary denied boarding", status: "not_checked", reason: "Not checked yet." }], truncated: false };
    const text = renderAt();
    expect(text).toContain("No recovery path applies to this transaction on what Recoup knows now.");
    expect(text).toContain("Involuntary denied boarding");
    expect(text).not.toMatch(/every right/i);
  });

  it("lists the documents with where each stands, a preview on request, and a keep choice", () => {
    renderAt();
    const docs = screen.getByRole("region", { name: "Documents" });
    expect(docs.textContent).toContain("boarding-pass.png");
    expect(docs.textContent).toContain("so this file is stored only");
    expect(within(docs).getByRole("button", { name: "Show file" })).toBeDefined();
    expect(docs.textContent).toContain("Your flight was cancelled");
    expect(docs.textContent).toContain("Its content was cleared after the retention period");
    expect(within(docs).getAllByRole("button", { name: "Keep this document" })).toHaveLength(1);
  });

  it("attaches one of the user's unattached recent uploads to this transaction", async () => {
    renderAt();
    const docs = screen.getByRole("region", { name: "Documents" });
    const select = within(docs).getByLabelText("Or attach one of your recent uploads") as HTMLSelectElement;
    // Only the unattached upload is offered; one already on a transaction is not.
    expect([...select.options].map((o) => o.value)).toEqual(["", "ev9"]);
    fireEvent.change(select, { target: { value: "ev9" } });
    fireEvent.click(within(docs).getByRole("button", { name: "Attach" }));
    await waitFor(() => expect(attach).toHaveBeenCalledWith({ evidenceId: "ev9", transactionId: "t1" }));
  });

  it("redirects a retail order to its purchase page", async () => {
    results["transactions:get"] = { ...TXN, category: "retail_order", purchaseId: "p7" };
    renderAt();
    expect(await screen.findByText("purchase page")).toBeDefined();
  });

  it("a foreign or unknown id shows the shared not-found message", () => {
    throwing = "transactions:get";
    vi.spyOn(console, "error").mockImplementation(() => {});
    const text = renderAt();
    expect(text).toContain("This item does not exist or belongs to another account.");
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    renderAt();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
