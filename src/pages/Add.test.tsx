// @vitest-environment happy-dom
/**
 * M24 /add: paste (moved from Settings), upload with a REQUIRED doc type and a plain "stored, not read" notice
 * (DA-A-8, D145), and a hand-entered purchase through `purchases.create` (float-free prices, never a future date).
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import Add from "./Add";

const paste = vi.fn(async (_args: Record<string, unknown>) => "pe1");
const create = vi.fn(async (_args: Record<string, unknown>) => "p9");
const createManual = vi.fn(async (_args: Record<string, unknown>) => "t9");
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ evidenceId: "ev1", duplicate: false, extractionStatus: "store_only" }), { status: 200 }));
const evidenceRow = {
  _id: "ev1", transactionId: null, kind: "upload", docType: "receipt", docTypeDeclaredBy: "user", sourceChannel: "upload",
  provenance: "user_uploaded", contentHash: "a".repeat(64), mimeType: "image/png", sizeBytes: 12, fileName: "receipt.png",
  hasFile: true, text: null, headers: null, receivedAt: 1, pinnedAt: null, extractionStatus: "store_only",
  extractionSummary: "Automatic reading of uploaded documents is switched off, so this file is stored only.",
  retention: "active", isExample: false,
};

vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => "token-1" }));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: unknown) => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "profiles:me") return { email: "me@example.com", inboxEmail: "me@recoup.example" };
    if (name === "evidence:get") return evidenceRow;
    if (name === "evidence:listRecent") return [evidenceRow, { ...evidenceRow, _id: "ev0", fileName: "old.pdf", transactionId: "t1" }];
    return undefined;
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "purchases:create") return create;
    if (name === "transactions:createManual") return createManual;
    return vi.fn(async () => null);
  },
  useAction: (ref: FunctionReference<"action">) => (getFunctionName(ref) === "intake:paste" ? paste : vi.fn()),
}));

function renderAdd() {
  render(
    <MemoryRouter initialEntries={["/add"]}>
      <Routes>
        <Route path="/add" element={<Add />} />
        <Route path="/purchases/:id" element={<p>purchase page</p>} />
        <Route path="/transactions/:id" element={<p>transaction page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  paste.mockClear();
  create.mockClear();
  createManual.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("VITE_CONVEX_SITE_URL", "https://quiet-fox-1.convex.site");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/add", () => {
  it("pastes an email through intake.paste and says it waits for review", async () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Paste an email" });
    expect(card.textContent).toContain("me@recoup.example");
    fireEvent.change(within(card).getByLabelText("Email text"), { target: { value: "Your order #123 from Northwind" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add from this email" }));
    await waitFor(() => expect(paste).toHaveBeenCalledWith({ text: "Your order #123 from Northwind" }));
    expect(within(card).getByRole("status").textContent).toContain("review and confirm");
  });

  it("says plainly that an uploaded document is stored, not read", () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Upload a document" });
    expect(card.textContent).toMatch(/Recoup stores the file but does not read it\. You confirm the facts yourself\./);
  });

  it("lists recent uploads with where each stands", () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Upload a document" });
    expect(card.textContent).toContain("Recent uploads");
    expect(card.textContent).toContain("Not attached; cleared after 30 days");
    expect(card.textContent).toContain("Attached to a transaction");
  });

  it("requires the doc type before anything is uploaded, then sends it with the file", async () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Upload a document" });
    const upload = within(card).getByRole("button", { name: "Upload and store" }) as HTMLButtonElement;
    const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "receipt.png", { type: "image/png" });
    fireEvent.change(within(card).getByLabelText("File"), { target: { files: [pngFile] } });
    expect(upload.disabled).toBe(true);
    expect(card.textContent).toContain("Choose what the document is before uploading.");
    fireEvent.change(within(card).getByLabelText(/What is this document\?/), { target: { value: "receipt" } });
    expect(upload.disabled).toBe(false);
    fireEvent.click(upload);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://quiet-fox-1.convex.site/evidence/upload");
    expect(init.headers).toMatchObject({ "X-Doc-Type": "receipt", Authorization: "Bearer token-1" });
    expect(await within(card).findByText("Stored: receipt.png")).toBeDefined();
    expect(card.textContent).toContain("cleared 30 days after upload unless it is attached");
  });

  it("enters a purchase by hand through purchases.create, parsing prices without floats", async () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Enter it yourself" });
    fireEvent.change(within(card).getByLabelText("Store"), { target: { value: "Northwind" } });
    fireEvent.change(within(card).getByLabelText("Store website"), { target: { value: "northwind.example" } });
    fireEvent.change(within(card).getByLabelText("Item 1 name"), { target: { value: "Kettle" } });
    fireEvent.change(within(card).getByLabelText("Unit price"), { target: { value: "1,049.99" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add purchase" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({
      merchant: "Northwind",
      merchantDomain: "northwind.example",
      currency: "USD",
      status: "active",
      items: [{ name: "Kettle", unitCents: 104_999, qty: 1 }],
    });
    expect((create.mock.calls[0][0] as { purchasedAt: number }).purchasedAt).toBeLessThanOrEqual(Date.now());
    expect(await screen.findByText("purchase page")).toBeDefined();
  });

  it("enters a card charge through transactions.createManual: decimal parsed to minor units, the typed day as transactedOn", async () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Enter it yourself" });
    fireEvent.click(within(card).getByRole("radio", { name: "Card charge" }));
    fireEvent.change(within(card).getByLabelText("Merchant, as it appears on your statement"), { target: { value: "ACME*STORE" } });
    fireEvent.change(within(card).getByLabelText("Amount charged"), { target: { value: "1,234.56" } });
    fireEvent.change(within(card).getByLabelText("Date of the charge"), { target: { value: "2026-09-01" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add card charge" }));
    await waitFor(() => expect(createManual).toHaveBeenCalledTimes(1));
    expect(createManual.mock.calls[0][0]).toEqual({
      category: "card_charge", counterpartyName: "ACME*STORE", currency: "USD", totalMinor: 123_456, transactedOn: "2026-09-01",
      transactedAt: Date.UTC(2026, 8, 1, 12),
    });
    expect(await screen.findByText("transaction page")).toBeDefined();
  });

  it("a flight's total is optional, and a signed amount is refused before the server", async () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Enter it yourself" });
    fireEvent.click(within(card).getByRole("radio", { name: "Flight" }));
    fireEvent.change(within(card).getByLabelText("Airline or travel agency you paid"), { target: { value: "Acme Air" } });
    fireEvent.change(within(card).getByLabelText(/Total you paid/), { target: { value: "-480.00" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add flight" }));
    expect(within(card).getByRole("alert").textContent).toContain("without a minus sign");
    expect(createManual).not.toHaveBeenCalled();
    fireEvent.change(within(card).getByLabelText(/Total you paid/), { target: { value: "" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add flight" }));
    await waitFor(() => expect(createManual).toHaveBeenCalledTimes(1));
    expect(createManual.mock.calls[0][0]).not.toHaveProperty("totalMinor");
    expect(createManual.mock.calls[0][0]).toMatchObject({ category: "air_travel", counterpartyName: "Acme Air" });
  });

  it("refuses a future purchase date without calling the server", () => {
    renderAdd();
    const card = screen.getByRole("region", { name: "Enter it yourself" });
    fireEvent.change(within(card).getByLabelText("Store"), { target: { value: "Northwind" } });
    fireEvent.change(within(card).getByLabelText("Store website"), { target: { value: "northwind.example" } });
    fireEvent.change(within(card).getByLabelText("Purchase date"), { target: { value: "2999-01-01" } });
    fireEvent.click(within(card).getByRole("button", { name: "Add purchase" }));
    expect(within(card).getByRole("alert").textContent).toContain("can't be in the future");
    expect(create).not.toHaveBeenCalled();
  });

  it("is operable by keyboard: every control is a native, labelled, focusable element", () => {
    renderAdd();
    for (const control of screen.getAllByRole("button")) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
    for (const field of document.querySelectorAll<HTMLElement>("input, select, textarea")) {
      const labelled = field.closest("label") !== null || (field.id !== "" && document.querySelector(`label[for="${field.id}"]`) !== null);
      expect(labelled, field.outerHTML).toBe(true);
    }
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    renderAdd();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
