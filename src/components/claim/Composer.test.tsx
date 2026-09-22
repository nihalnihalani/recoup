// @vitest-environment happy-dom
/**
 * M15 (contract §6; C1/D148, DA-A-14/21/31, SEC-AI-4, S-M03-1): the Composer always runs `drafts.prepareSend`
 * before `approveAndSend`, sends only the returned `preparedHash`, turns the acknowledgeable refusals into an
 * explicit "send anyway" (never a hard block), explains the others, and offers `resendAfterUnknown` with an
 * acknowledgment when the earlier outcome is unknown.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { fireEvent, render, screen, waitFor, within } from "../../test/dom";
import { Composer } from "./Composer";

type Call = Record<string, unknown>;
const calls: string[] = [];
const prepareSend = vi.fn(async (_args: Call): Promise<unknown> => ({ ok: true, preparedHash: "hash-1", findings: [] }));
const approveAndSend = vi.fn(async (_args: Call): Promise<unknown> => "outbound-1");
const resendAfterUnknown = vi.fn(async (_args: Call): Promise<unknown> => ({ ok: true, outboundId: "outbound-2", draftId: "d2" }));
const adjustExpected = vi.fn(async (_args: Call): Promise<unknown> => null);
const ensureInbox = vi.fn(async () => null);
let sendStatus: unknown = null;

function tracked(name: string, fn: (args: Call) => Promise<unknown>) {
  return async (args: Call) => {
    calls.push(name);
    return await fn(args);
  };
}

vi.mock("convex/react", () => ({
  useQuery: () => sendStatus,
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "drafts:prepareSend") return tracked("prepareSend", prepareSend);
    if (name === "drafts:approveAndSend") return tracked("approveAndSend", approveAndSend);
    if (name === "drafts:resendAfterUnknown") return tracked("resendAfterUnknown", resendAfterUnknown);
    if (name === "claims:adjustExpected") return tracked("adjustExpected", adjustExpected);
    return vi.fn(async () => null);
  },
  useAction: () => ensureInbox,
}));

const claim = (overrides: Partial<Doc<"claims">> = {}): Doc<"claims"> =>
  ({
    _id: "c1" as Id<"claims">,
    _creationTime: 1,
    purchaseId: "p1" as Id<"purchases">,
    itemId: "i1" as Id<"items">,
    userId: "u1" as Id<"users">,
    type: "price_adjustment",
    expectedCents: 2_500,
    status: "drafted",
    token: "tok",
    version: 3,
    ...overrides,
  }) as Doc<"claims">;

const draft = (overrides: Partial<Doc<"drafts">> = {}): Doc<"drafts"> =>
  ({
    _id: "d1" as Id<"drafts">,
    _creationTime: 1,
    claimId: "c1" as Id<"claims">,
    userId: "u1" as Id<"users">,
    version: 2,
    claimVersion: 3,
    to: "support@northwind.example",
    subject: "Price adjustment request",
    body: "Hello, the price dropped by $25.00.",
    ...overrides,
  }) as Doc<"drafts">;

function renderComposer(d = draft(), c = claim()) {
  render(<Composer draft={d} claim={c} merchantDomain="northwind.example" closed={false} />);
}

beforeEach(() => {
  calls.length = 0;
  sendStatus = null;
  prepareSend.mockReset();
  prepareSend.mockImplementation(async () => ({ ok: true, preparedHash: "hash-1", findings: [] }));
  approveAndSend.mockReset();
  approveAndSend.mockImplementation(async () => "outbound-1");
  resendAfterUnknown.mockReset();
  resendAfterUnknown.mockImplementation(async () => ({ ok: true, outboundId: "outbound-2", draftId: "d2" }));
  adjustExpected.mockReset();
  adjustExpected.mockImplementation(async () => null);
});

const approve = () => fireEvent.click(screen.getByRole("button", { name: "Approve & send" }));

describe("Composer: prepareSend before every send", () => {
  it("prepares, then sends exactly the prepared hash with the versions the user saw", async () => {
    renderComposer();
    fireEvent.click(screen.getByRole("checkbox", { name: "This is the right recipient" }));
    approve();
    await waitFor(() => expect(approveAndSend).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(["prepareSend", "approveAndSend"]);
    expect(prepareSend.mock.calls[0][0]).toEqual({
      draftId: "d1",
      to: "support@northwind.example",
      subject: "Price adjustment request",
      body: "Hello, the price dropped by $25.00.",
    });
    expect(approveAndSend.mock.calls[0][0]).toMatchObject({
      draftId: "d1",
      claimVersion: 3,
      draftVersion: 2,
      recipientConfirmed: true,
      preparedHash: "hash-1",
    });
    expect(approveAndSend.mock.calls[0][0]).not.toHaveProperty("acknowledgeWindowRisk");
  });

  it("window_may_have_passed is an acknowledgment, never a hard block (C1)", async () => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "window_may_have_passed", message: "The store's price-adjustment window may have passed." }));
    renderComposer();
    approve();
    const ack = await screen.findByRole("button", { name: "Send anyway — the store's price-adjustment window may have passed" });
    expect(approveAndSend).not.toHaveBeenCalled();
    fireEvent.click(ack);
    await waitFor(() => expect(approveAndSend).toHaveBeenCalledTimes(1));
    expect(prepareSend.mock.calls[1][0]).toMatchObject({ acknowledgeWindowRisk: true });
    expect(approveAndSend.mock.calls[0][0]).toMatchObject({ acknowledgeWindowRisk: true, preparedHash: "hash-1" });
  });

  it("unverified_content lists the findings and needs an explicit acknowledgment (SEC-AI-4)", async () => {
    prepareSend.mockImplementationOnce(async () => ({
      ok: false,
      code: "unverified_content",
      message: "The message mentions details Recoup did not supply.",
      findings: ["refunds@elsewhere.example", "$250.00"],
    }));
    renderComposer();
    approve();
    expect(await screen.findByText("refunds@elsewhere.example")).toBeDefined();
    expect(screen.getByText("$250.00")).toBeDefined();
    expect(approveAndSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "I checked these details — send anyway" }));
    await waitFor(() => expect(approveAndSend).toHaveBeenCalledTimes(1));
    expect(prepareSend.mock.calls[1][0]).toMatchObject({ acknowledgeUnverifiedContent: true });
    expect(approveAndSend.mock.calls[0][0]).toMatchObject({ acknowledgeUnverifiedContent: true });
  });

  it("editing the text clears an earlier content acknowledgment", async () => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "unverified_content", message: "Check these.", findings: ["x@y.example"] }));
    renderComposer();
    approve();
    await screen.findByRole("button", { name: "I checked these details — send anyway" });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello again." } });
    expect(screen.queryByRole("button", { name: "I checked these details — send anyway" })).toBeNull();
    approve();
    await waitFor(() => expect(prepareSend).toHaveBeenCalledTimes(2));
    expect(prepareSend.mock.calls[1][0]).not.toHaveProperty("acknowledgeUnverifiedContent");
  });

  it("outcome_not_approvable explains and disables sending", async () => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "outcome_not_approvable", message: "Recoup's check no longer supports this claim (not eligible)." }));
    renderComposer();
    approve();
    expect((await screen.findByRole("region", { name: "Not sent" })).textContent).toContain("no longer supports this claim");
    expect((screen.getByRole("button", { name: "Approve & send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(approveAndSend).not.toHaveBeenCalled();
  });

  it.each(["binding_changed", "rule_withdrawn"] as const)("%s asks the user to review the claim again and sends nothing", async (code) => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code, message: "Something changed." }));
    renderComposer();
    approve();
    expect((await screen.findByRole("region", { name: "Nothing was sent: review the claim again" })).textContent).toContain("Something changed.");
    expect(approveAndSend).not.toHaveBeenCalled();
  });

  it("rate_limited says to try again later", async () => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "rate_limited", message: "Too many checks in a minute. Wait a moment and try again." }));
    renderComposer();
    approve();
    expect((await screen.findByRole("region", { name: "Not sent yet" })).textContent).toContain("Wait a moment");
    expect(approveAndSend).not.toHaveBeenCalled();
  });

  it("a thrown refusal from the send itself is shown, not swallowed", async () => {
    approveAndSend.mockImplementationOnce(async () => {
      throw new Error("Confirm this recipient before sending");
    });
    renderComposer();
    approve();
    expect((await screen.findByRole("alert")).textContent).toContain("Confirm this recipient before sending");
  });
});

describe("Composer: refusals are reachable by keyboard (DA-B-12) and acknowledgments are per refusal (DA-B-11)", () => {
  it("moves focus to the refusal's heading, describes the send button, and puts the safe action before 'Send anyway'", async () => {
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "window_may_have_passed", message: "The store's price-adjustment window may have passed." }));
    renderComposer();
    const approveButton = screen.getByRole("button", { name: "Approve & send" });
    approveButton.focus();
    fireEvent.click(approveButton);
    const heading = await screen.findByRole("heading", { name: "The store's window may have passed" });
    await waitFor(() => expect(document.activeElement).toBe(heading));

    const panel = screen.getByRole("region", { name: "The store's window may have passed" });
    const buttons = within(panel).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Keep editing", "Send anyway — the store's price-adjustment window may have passed"]);
    const description = approveButton.getAttribute("aria-describedby");
    expect(description && document.getElementById(description)?.textContent).toContain("may have passed");

    // The safe action closes the refusal and puts the user back in the message, sending nothing.
    fireEvent.click(within(panel).getByRole("button", { name: "Keep editing" }));
    expect(document.activeElement).toBe(screen.getByLabelText("Message"));
    expect(screen.queryByRole("region", { name: "The store's window may have passed" })).toBeNull();
    expect(approveAndSend).not.toHaveBeenCalled();
  });

  it("a content acknowledgment does not carry over to findings the user has not seen", async () => {
    prepareSend
      .mockImplementationOnce(async () => ({ ok: false, code: "unverified_content", message: "Check these.", findings: ["a@x.example"] }))
      .mockImplementationOnce(async () => ({ ok: false, code: "rate_limited", message: "Too many checks in a minute." }))
      .mockImplementationOnce(async () => ({ ok: false, code: "unverified_content", message: "Check these.", findings: ["b@y.example"] }));
    renderComposer();
    approve();
    fireEvent.click(await screen.findByRole("button", { name: "I checked these details — send anyway" }));
    await screen.findByRole("region", { name: "Not sent yet" });
    approve();
    expect(await screen.findByText("b@y.example")).toBeDefined();
    // The third prepare was asked WITHOUT the earlier acknowledgment, so finding B had to be shown.
    expect(prepareSend.mock.calls[2][0]).not.toHaveProperty("acknowledgeUnverifiedContent");
    expect(approveAndSend).not.toHaveBeenCalled();
  });
});

describe("Composer: after an unknown outcome (S-M03-1, DA-A-31)", () => {
  const unknownDraft = () => draft({ outboundId: "outbound-1" as Doc<"drafts">["outboundId"], approvedAt: Date.UTC(2026, 8, 22, 15) });
  const unknownClaim = () => claim({ status: "queued", sendUnknown: true });

  it("says the earlier attempt may have arrived and resends only after an acknowledgment", async () => {
    sendStatus = { status: "pending", agentmailMessageId: null, threadId: null, errorMessage: null, outcome: "unknown" };
    renderComposer(unknownDraft(), unknownClaim());
    expect(screen.getAllByText(/couldn't confirm/).length).toBeGreaterThan(0);
    const resend = screen.getByRole("button", { name: "Send again" }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the earlier message may already have arrived" }));
    fireEvent.click(resend);
    await waitFor(() => expect(resendAfterUnknown).toHaveBeenCalledTimes(1));
    expect(resendAfterUnknown.mock.calls[0][0]).toMatchObject({ acknowledgedOutboundId: "outbound-1", claimVersion: 3, draftVersion: 2 });
    expect(approveAndSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Approve & send" })).toBeNull();
  });

  it("an outcome that became known is reported, and nothing is sent", async () => {
    resendAfterUnknown.mockImplementationOnce(async () => ({ ok: false, code: "outcome_known", message: "The earlier attempt was sent after all, so nothing was sent again." }));
    renderComposer(unknownDraft(), unknownClaim());
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the earlier message may already have arrived" }));
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect((await screen.findByRole("region", { name: "Nothing was sent: review the claim again" })).textContent).toContain("was sent after all");
  });

  it("a resend can need the window acknowledgment too", async () => {
    resendAfterUnknown.mockImplementationOnce(async () => ({ ok: false, code: "window_may_have_passed", message: "The window may have passed." }));
    renderComposer(unknownDraft(), unknownClaim());
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the earlier message may already have arrived" }));
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send anyway — the store's price-adjustment window may have passed" }));
    await waitFor(() => expect(resendAfterUnknown).toHaveBeenCalledTimes(2));
    expect(resendAfterUnknown.mock.calls[1][0]).toMatchObject({ acknowledgeWindowRisk: true });
  });
});

// M13b (D190/D194, DA-B-2): a claim asking more than Recoup's exact estimate — adjust, or send the full amount
// knowingly; nothing is sent until the user picks one.
describe("Composer: amount_exceeds_estimate (DA-B-2)", () => {
  const exceeds = async () => ({
    ok: false,
    code: "amount_exceeds_estimate",
    message: "This claim asks USD 50.00; Recoup's current estimate is USD 25.00.",
    estimate: { amountMinor: 2_500, currency: "USD" },
  });
  const usd = (minor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);

  it("shows both amounts and sends nothing until the user chooses", async () => {
    prepareSend.mockImplementationOnce(exceeds);
    renderComposer(draft(), claim({ expectedCents: 5_000 }));
    approve();
    const panel = await screen.findByRole("region", { name: "This claim asks more than Recoup's estimate" });
    expect(panel.textContent).toContain(`This claim asks ${usd(5_000)}; Recoup's current estimate is ${usd(2_500)}.`);
    // DA-B-12: the safe action (adjust) comes first in DOM and tab order, then the explicit acknowledgment.
    expect(within(panel).getAllByRole("button").map((b) => b.textContent)).toEqual([`Adjust to ${usd(2_500)}`, `Send ${usd(5_000)} anyway`]);
    await waitFor(() => expect(document.activeElement).toBe(within(panel).getByRole("heading")));
    expect(approveAndSend).not.toHaveBeenCalled();
    expect(adjustExpected).not.toHaveBeenCalled();
  });

  it('"Send … anyway" re-prepares and sends with the amount acknowledgment', async () => {
    prepareSend.mockImplementationOnce(exceeds);
    renderComposer(draft(), claim({ expectedCents: 5_000 }));
    approve();
    fireEvent.click(await screen.findByRole("button", { name: `Send ${usd(5_000)} anyway` }));
    await waitFor(() => expect(approveAndSend).toHaveBeenCalledTimes(1));
    expect(prepareSend.mock.calls[1][0]).toMatchObject({ acknowledgeAmountAboveEstimate: true });
    expect(approveAndSend.mock.calls[0][0]).toMatchObject({ acknowledgeAmountAboveEstimate: true, preparedHash: "hash-1" });
    expect(adjustExpected).not.toHaveBeenCalled();
  });

  it('"Adjust to …" calls adjustExpected with the estimate, then re-prepares without acknowledging the old amount', async () => {
    prepareSend.mockImplementationOnce(exceeds);
    // After the adjustment the draft's claim version is stale, so the review asks for a new draft; nothing is sent.
    prepareSend.mockImplementationOnce(async () => ({ ok: false, code: "binding_changed", message: "The claim changed since this draft was written." }));
    renderComposer(draft(), claim({ expectedCents: 5_000 }));
    approve();
    fireEvent.click(await screen.findByRole("button", { name: `Adjust to ${usd(2_500)}` }));
    await waitFor(() => expect(prepareSend).toHaveBeenCalledTimes(2));
    expect(adjustExpected.mock.calls[0][0]).toMatchObject({ claimId: "c1", expectedCents: 2_500 });
    expect(calls).toEqual(["prepareSend", "adjustExpected", "prepareSend"]);
    expect(prepareSend.mock.calls[1][0]).not.toHaveProperty("acknowledgeAmountAboveEstimate");
    expect((await screen.findByRole("region", { name: "Nothing was sent: review the claim again" })).textContent).toContain("The claim changed");
    expect(approveAndSend).not.toHaveBeenCalled();
  });
});
