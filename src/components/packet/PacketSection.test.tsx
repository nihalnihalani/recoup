// @vitest-environment happy-dom
/**
 * M24 part 2: the manual-channel packet (contract §6 "Manual approval", §9 "Packet review"; DA-A-10; N3; N6), driven
 * against seeded `packets.*` / `submissions.*` results (no pack but R01 is active, so there is no live manual claim):
 * prepare → review/edit → approve exactly the rendered hash → the user files it → the user records the submission
 * (with proof) and later its delivery. Prepared ≠ submitted ≠ delivered; the bound facts are shown; a late filing is
 * flagged against its deadline; a withdrawn rule is refused once and the retry goes through. Keyboard-only approval
 * and axe (contrast is checked in the browser).
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { fromDateInput } from "../../lib/ui";
import { fireEvent, render, screen, waitFor, within } from "../../test/dom";
import { PacketSection } from "./PacketSection";

const uploadEvidence = vi.fn(async (_input: Record<string, unknown>) => ({
  ok: true as boolean,
  evidenceId: "e1",
  duplicate: false,
  extractionStatus: "not_requested",
  message: "",
}));
vi.mock("../../lib/evidenceFetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/evidenceFetch")>()),
  uploadEvidence: (input: Record<string, unknown>) => uploadEvidence(input),
}));
vi.mock("@convex-dev/auth/react", () => ({ useAuthToken: () => "token" }));

type Result = Record<string, unknown>;
const prepare = vi.fn(async (_args: Result): Promise<Result> => ({ ok: true, packetId: "k2", findings: [] }));
const update = vi.fn(async (_args: Result): Promise<unknown> => "k2");
const approve = vi.fn(async (_args: Result): Promise<Result> => ({ ok: true }));
const record = vi.fn(async (_args: Result): Promise<Result> => ({
  ok: true,
  submissionId: "s1",
  staleAtRecord: false,
  deduped: false,
  deadline: null,
}));
const recordDelivery = vi.fn(async (_args: Result): Promise<unknown> => null);

let list: { packets: unknown[]; submissions: unknown[] } | undefined;
let views: Record<string, unknown> = {};

vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">, args: { packetId?: string } | "skip") => {
    if (args === "skip") return undefined;
    const name = getFunctionName(ref);
    if (name === "packets:listForClaim") return list;
    if (name === "packets:get") return views[args.packetId!];
    return undefined;
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "packets:prepare") return prepare;
    if (name === "packets:update") return update;
    if (name === "packets:approve") return approve;
    if (name === "submissions:record") return record;
    if (name === "submissions:recordDelivery") return recordDelivery;
    return vi.fn(async () => null);
  },
}));

const DUE = Date.UTC(2026, 0, 31, 23, 0);
const CLAIM = {
  _id: "c1" as Id<"claims">,
  _creationTime: 1,
  userId: "u1" as Id<"users">,
  type: "scenario",
  expectedCents: 60_000,
  status: "drafted",
  token: "tok",
  version: 3,
  transactionId: "t1" as Id<"transactions">,
  scenarioId: "R02",
  currency: "EUR",
  requiredChannel: "postal_mail",
} as unknown as Doc<"claims">;

function packet(overrides: Record<string, unknown> = {}) {
  return {
    _id: "k1",
    _creationTime: 2,
    userId: "u1",
    claimId: "c1",
    version: 1,
    channel: "postal_mail",
    recipient: { text: "Example Air Customer Relations\n1 Runway Road", source: "rule_pack" },
    body: "Dear Sir or Madam,\n\nFlight EX123 arrived 4 hours late. I ask for compensation.",
    requestedRemedy: "Compensation of EUR 600.00",
    evidenceIndex: [],
    binding: { contextHash: "ctx", claimVersion: 3, amount: { amountMinor: 60_000, currency: "EUR" } },
    status: "draft",
    templateId: "R02.letter",
    ...overrides,
  };
}

function submission(overrides: Record<string, unknown> = {}) {
  return {
    _id: "s1",
    _creationTime: 5,
    userId: "u1",
    claimId: "c1",
    packetId: "k1",
    approvedHash: "hash-v1",
    channel: "postal_mail",
    submittedAt: Date.UTC(2026, 1, 3, 12),
    confirmationRef: "RR123456789GB",
    ...overrides,
  };
}

function seed(p: ReturnType<typeof packet>, extra: Record<string, unknown> = {}, submissions: unknown[] = []) {
  list = { packets: [p], submissions };
  views = {
    [p._id]: {
      packet: p,
      boundFacts: [
        { subjectKey: "txn", key: "air.original_flight_number", status: "confirmed", value: { kind: "identifier", value: "EX123" } },
        { subjectKey: "leg:1", key: "air.actual_arrival_at", status: "observed", value: { kind: "text", text: "4 hours after schedule" } },
      ],
      outcome: "eligible",
      deadlines: [
        { id: "file_by", label: "File your claim", obligor: "user", status: "open", dueAt: DUE, mustBe: "sent", basis: "rule" },
        { id: "answer_by", label: "Airline answers", obligor: "counterparty", status: "open", dueAt: DUE - 1, mustBe: "n_a", basis: "rule" },
      ],
      renderedHash: "hash-v1",
      submissions,
      ...extra,
    },
  };
}

function renderSection(closed = false) {
  render(
    <MemoryRouter>
      <PacketSection claim={CLAIM} closed={closed} />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

function stage(label: string) {
  return within(screen.getByRole("list", { name: "Packet progress" })).getByText(label).closest("li")!;
}

beforeEach(() => {
  for (const fn of [prepare, update, approve, record, recordDelivery, uploadEvidence]) fn.mockClear();
  list = { packets: [], submissions: [] };
  views = {};
});

describe("preparing (packets.prepare)", () => {
  it("starts with nothing sent and a way to prepare", async () => {
    const text = renderSection();
    expect(text).toContain("filed by postal mail, not by email");
    expect(text).toContain("never sends it");
    expect(stage("Prepared").textContent).toContain("(not yet)");
    fireEvent.click(screen.getByRole("button", { name: "Prepare the packet" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledWith({ claimId: "c1" }));
  });

  it("the prepared version takes focus once it renders", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <PacketSection claim={CLAIM} closed={false} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Prepare the packet" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    seed(packet({ _id: "k2" }));
    rerender(
      <MemoryRouter>
        <PacketSection claim={CLAIM} closed={false} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Packet version 1 · Postal mail" })));
  });

  it("a withdrawn rule is refused once, with a focused notice, and the retry goes through (N3)", async () => {
    prepare.mockResolvedValueOnce({ ok: false, code: "rule_withdrawn", message: "withdrawn" });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Prepare the packet" }));
    const heading = await screen.findByRole("heading", { name: "Recoup's automatic check for this claim was withdrawn" });
    expect(document.activeElement).toBe(heading);
    expect(document.body.textContent).toContain("Prepare it again to continue without that check");
    fireEvent.click(screen.getByRole("button", { name: "Prepare the packet" }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("heading", { name: /withdrawn/ })).toBeNull());
  });

  it("confirm_facts names the fact in words and links to where it is answered", async () => {
    prepare.mockResolvedValueOnce({
      ok: false,
      code: "confirm_facts",
      message: "Confirm air.actual_arrival_at before Recoup can write this packet.",
      keys: [{ subjectKey: "leg:1", key: "air.actual_arrival_at" }],
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Prepare the packet" }));
    await screen.findByRole("heading", { name: "Confirm a fact first" });
    expect(document.body.textContent).toContain("confirm the actual arrival at before");
    expect(document.body.textContent).not.toContain("air.actual_arrival_at");
    expect(screen.getByRole("link", { name: "Answer it on the transaction page" }).getAttribute("href")).toBe("/transactions/t1");
  });
});

describe("reviewing and approving a draft (packets.update / packets.approve)", () => {
  beforeEach(() => seed(packet()));

  it("says what it is and is not, and shows the facts it is written from (N6)", () => {
    const text = renderSection();
    expect(text).toContain("Prepared by Recoup. Not approved and not sent.");
    expect(stage("Prepared").textContent).toContain("(yes)");
    expect(stage("Approved").textContent).toContain("(not yet)");
    expect(stage("Submitted").textContent).toContain("(not yet)");
    expect(stage("Delivered").textContent).toContain("(not yet)");
    expect(screen.getByRole("heading", { name: "Packet version 1 · Postal mail" })).toBeDefined();
    expect(text).toContain("(from the published rule)");
    expect(text).toContain("The facts this packet is written from (2)");
    expect(text).toContain("EX123");
    expect(text).toContain("4 hours after schedule");
    expect(text).toContain("(Observed by Recoup)");
    // Only the user-side deadline is the filing deadline.
    expect(text).toContain("Your deadline, File your claim: it must be sent by");
    expect(text).toContain("It has passed; the company may refuse a late claim.");
    expect(text).not.toContain("Airline answers");
  });

  it("approves exactly the rendered hash; flagged content needs the user to acknowledge the findings shown", async () => {
    approve.mockResolvedValueOnce({
      ok: false,
      code: "unverified_content",
      message: "The packet states details Recoup did not supply. Check them, then confirm.",
      findings: ["claims@elsewhere.example"],
      findingsHash: "fh1",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Approve this packet" }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith({ packetId: "k1", approvedHash: "hash-v1" }));
    await screen.findByRole("heading", { name: "Check these details before approving" });
    expect(document.body.textContent).toContain("claims@elsewhere.example");
    fireEvent.click(screen.getByRole("button", { name: "I checked these details. Approve it." }));
    await waitFor(() =>
      expect(approve).toHaveBeenLastCalledWith({
        packetId: "k1",
        approvedHash: "hash-v1",
        acknowledgeUnverifiedContent: true,
        acknowledgedFindingsHash: "fh1",
      }),
    );
    const done = await screen.findByRole("heading", { name: "Approved. Nothing was sent." });
    expect(document.activeElement).toBe(done);
  });

  it("an edit is saved as a new version before anything can be approved", async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText("Letter"), { target: { value: "My own words." } });
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: "Claims Dept, PO Box 7" } });
    expect(screen.queryByRole("button", { name: "Approve this packet" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        packetId: "k1",
        body: "My own words.",
        recipient: { text: "Claims Dept, PO Box 7", source: "user_entered" },
      }),
    );
    expect(approve).not.toHaveBeenCalled();
  });

  it("a refusal is shown in the server's words", async () => {
    approve.mockResolvedValueOnce({ ok: false, code: "binding_changed", message: "The claim changed since this packet was written; prepare it again." });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Approve this packet" }));
    await screen.findByRole("heading", { name: "Not approved" });
    expect(document.body.textContent).toContain("prepare it again");
    expect(screen.getByRole("button", { name: "Prepare a new version from the latest facts" })).toBeDefined();
  });

  it("keyboard only: native controls in reading order, and approving moves focus to the result", async () => {
    renderSection();
    const tabbable = [...document.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, summary, [tabindex]")].filter(
      (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled,
    );
    const names = tabbable.map((el) => el.getAttribute("aria-label") ?? el.id ?? "");
    const order = [screen.getByLabelText(/^To/), screen.getByLabelText("Letter"), screen.getByLabelText("What you ask for")];
    const approveButton = screen.getByRole("button", { name: "Approve this packet" });
    const positions = [...order, approveButton].map((el) => tabbable.indexOf(el));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(names.length).toBeGreaterThan(4);
    expect(approveButton.tagName).toBe("BUTTON");
    approveButton.focus();
    expect(document.activeElement).toBe(approveButton);
    // Enter/Space on a focused native button dispatches click.
    (document.activeElement as HTMLButtonElement).click();
    const done = await screen.findByRole("heading", { name: "Approved. Nothing was sent." });
    expect(document.activeElement).toBe(done);
  });

  it("passes axe (contrast is checked in the browser)", async () => {
    renderSection();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("recording the user's own submission (submissions.record)", () => {
  beforeEach(() => seed(packet({ status: "approved", approvedAt: Date.UTC(2026, 1, 1), approvedHash: "hash-v1" })));

  it("an approved packet is not sent: the user files it and records that they did", async () => {
    const text = renderSection();
    expect(text).toContain("Approved by you. Recoup does not send it");
    expect(stage("Approved").textContent).toContain("(yes)");
    expect(stage("Submitted").textContent).toContain("(not yet)");
    expect(text).toContain("The facts you approved this packet on (2)");
    expect(screen.getByRole("button", { name: "Copy the packet text" })).toBeDefined();
    expect(screen.queryByLabelText("Letter")).toBeNull();
    fireEvent.change(screen.getByLabelText("Day you filed it"), { target: { value: "2026-02-03" } });
    fireEvent.change(screen.getByLabelText(/Confirmation or tracking number/), { target: { value: " RR123456789GB " } });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(record.mock.calls[0][0]).toEqual({ packetId: "k1", submittedAt: fromDateInput("2026-02-03"), confirmationRef: "RR123456789GB" });
    const heading = await screen.findByRole("heading", { name: "Submission recorded" });
    expect(document.activeElement).toBe(heading);
    expect(document.body.textContent).toContain("That is not proof it arrived.");
    expect(uploadEvidence).not.toHaveBeenCalled();
  });

  it("a late filing is flagged against its deadline", async () => {
    record.mockResolvedValueOnce({
      ok: true,
      submissionId: "s1",
      staleAtRecord: true,
      deduped: false,
      deadline: { id: "file_by", label: "File your claim", dueAt: DUE, late: true },
    });
    renderSection();
    fireEvent.change(screen.getByLabelText("Day you filed it"), { target: { value: "2026-02-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await screen.findByRole("heading", { name: "Submission recorded, after the deadline" });
    const text = document.body.textContent ?? "";
    expect(text).toContain('after the deadline "File your claim"');
    expect(text).toContain("may refuse it as late");
    expect(text).toContain("The claim changed after you approved this packet; review it.");
  });

  it("a withdrawn rule is refused once and the second record goes through", async () => {
    record.mockResolvedValueOnce({
      ok: false,
      code: "rule_withdrawn",
      message: "Recoup's automatic checks for this kind of claim were withdrawn. Review the claim, then record the submission again.",
    });
    renderSection();
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await screen.findByRole("heading", { name: "Recoup's automatic check for this claim was withdrawn" });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await screen.findByRole("heading", { name: "Submission recorded" });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("proof is uploaded first as submission proof and attached to the record", async () => {
    renderSection();
    const file = new File([new Uint8Array([37, 80, 68, 70])], "receipt.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/Proof you filed it/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await waitFor(() => expect(record).toHaveBeenCalledTimes(1));
    expect(uploadEvidence.mock.calls[0][0]).toMatchObject({ file, docType: "submission_proof" });
    expect(record.mock.calls[0][0]).toMatchObject({ proofEvidenceId: "e1" });
  });

  it("a failed proof upload records nothing", async () => {
    uploadEvidence.mockResolvedValueOnce({ ok: false, evidenceId: "", duplicate: false, extractionStatus: "", message: "The upload didn't reach Recoup. Nothing was stored; try again." });
    renderSection();
    const file = new File([new Uint8Array([1])], "slip.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText(/Proof you filed it/), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await screen.findByRole("heading", { name: "Not recorded" });
    expect(document.body.textContent).toContain("The submission was not recorded either.");
    expect(record).not.toHaveBeenCalled();
  });

  it("a future day is refused before anything is sent", async () => {
    renderSection();
    fireEvent.change(screen.getByLabelText("Day you filed it"), { target: { value: "2999-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Record that I submitted it" }));
    await screen.findByRole("heading", { name: "Not recorded" });
    expect(record).not.toHaveBeenCalled();
  });

  it("passes axe (contrast is checked in the browser)", async () => {
    renderSection();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("after recording (prepared ≠ submitted ≠ delivered)", () => {
  it("a recorded submission is not a delivery; a late filing stays flagged; delivery is the user's own record", async () => {
    const s = submission();
    seed(packet({ status: "submission_recorded", approvedAt: Date.UTC(2026, 1, 1), approvedHash: "hash-v1" }), {}, [s]);
    const text = renderSection();
    expect(text).toContain("You recorded submitting it. That is not proof it arrived.");
    expect(stage("Submitted").textContent).toContain("(yes)");
    expect(stage("Delivered").textContent).toContain("(not yet)");
    expect(text).toContain("You recorded filing it on");
    expect(text).toContain("reference RR123456789GB");
    expect(text).toContain("Filed after the deadline.");
    expect(text).toContain("Recoup can't know whether it arrived.");
    expect(screen.queryByRole("button", { name: "Prepare a new version from the latest facts" })).toBeNull();

    fireEvent.change(screen.getByLabelText("Day it arrived"), { target: { value: "2026-02-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Record that it arrived" }));
    expect((await screen.findByRole("alert")).textContent).toContain("before the day you filed it");
    expect(recordDelivery).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Day it arrived"), { target: { value: "2026-02-03" } });
    fireEvent.click(screen.getByRole("button", { name: "Record that it arrived" }));
    await waitFor(() => expect(recordDelivery).toHaveBeenCalledTimes(1));
    const args = recordDelivery.mock.calls[0][0] as { submissionId: string; deliveredAt: number };
    expect(args.submissionId).toBe("s1");
    expect(args.deliveredAt).toBeGreaterThanOrEqual(s.submittedAt);
  });

  it("an on-time filing is not flagged, and a recorded delivery reaches the last stage", () => {
    const s = submission({ submittedAt: DUE - 86_400_000, deliveryRecordedAt: DUE });
    seed(packet({ status: "submission_recorded", approvedAt: Date.UTC(2026, 0, 1), approvedHash: "hash-v1" }), {}, [s]);
    const text = renderSection();
    expect(text).not.toContain("Filed after the deadline.");
    expect(text).toContain("You recorded that it arrived on");
    expect(stage("Delivered").textContent).toContain("(yes)");
    expect(screen.queryByRole("button", { name: "Record that it arrived" })).toBeNull();
  });

  it("passes axe (contrast is checked in the browser)", async () => {
    seed(packet({ status: "submission_recorded", approvedAt: Date.UTC(2026, 1, 1), approvedHash: "hash-v1" }), {}, [submission()]);
    renderSection();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe("resilience and edge states", () => {
  it("loading shows a status, not a blank", () => {
    list = undefined;
    renderSection();
    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
  });

  it("a packet still loading its detail shows a status", () => {
    list = { packets: [packet()], submissions: [] };
    views = {};
    renderSection();
    expect(screen.getByRole("status", { name: "Loading" })).toBeDefined();
  });

  it("a closed claim shows the packet read-only, with no way to prepare, approve or record", () => {
    seed(packet());
    renderSection(true);
    expect(screen.queryByRole("button", { name: "Approve this packet" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Prepare/ })).toBeNull();
    expect(screen.queryByLabelText("Letter")).toBeNull();
    expect(document.body.textContent).toContain("Dear Sir or Madam");
  });

  it("an unbound (legacy) packet says there are no checked facts to show", () => {
    seed(packet(), { boundFacts: null });
    expect(renderSection()).toContain("not tied to one of Recoup's rule checks");
  });

  it("earlier versions are listed apart from the newest", () => {
    seed(packet({ _id: "k2", version: 2 }));
    list = { packets: [packet({ _id: "k2", version: 2 }), packet({ status: "superseded", supersededAt: 3 })], submissions: [] };
    renderSection();
    expect(screen.getByRole("heading", { name: "Packet version 2 · Postal mail" })).toBeDefined();
    expect(screen.getByText("Earlier versions (1)")).toBeDefined();
    expect(document.body.textContent).toContain("Replaced by a newer version.");
  });
});
