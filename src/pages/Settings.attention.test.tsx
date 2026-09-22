// @vitest-environment happy-dom
/**
 * M15b (DA-B-3): in Settings' needs-attention list, a refund email Recoup cannot authenticate carries a
 * "Confirm this refund" action wired to `intake.confirmRefundEmail`, reads as a promise, and is never offered
 * `retryEvent` (a retry would pay for a new extraction). Other rows are unchanged.
 */
import { getFunctionName, type FunctionReference } from "convex/server";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fmt } from "../lib/money";
import { fireEvent, render, screen, waitFor, within } from "../test/dom";
import Settings from "./Settings";

const confirmRefundEmail = vi.fn(async (_args: Record<string, unknown>) => ({ status: "succeeded", summary: "Refund promise recorded." }));
const retryEvent = vi.fn(async (_args: Record<string, unknown>) => null);
let attention: unknown[] = [];

vi.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: vi.fn() }) }));
vi.mock("convex/react", () => ({
  useQuery: (ref: FunctionReference<"query">) => {
    switch (getFunctionName(ref)) {
      case "account:deletionStatus":
        return null;
      case "intake:needsAttention":
        return attention;
      case "profiles:me":
        return { email: "me@example.com", inboxEmail: "me@recoup.example" };
      case "alerts:settings":
        return { enabled: true, verified: true };
      default:
        return undefined;
    }
  },
  useMutation: (ref: FunctionReference<"mutation">) => {
    const name = getFunctionName(ref);
    if (name === "intake:confirmRefundEmail") return confirmRefundEmail;
    if (name === "intake:retryEvent") return retryEvent;
    return vi.fn(async () => null);
  },
  useAction: () => vi.fn(async () => null),
  useConvex: () => ({ query: vi.fn() }),
}));

const heldRefund = {
  _id: "pe1",
  _creationTime: Date.UTC(2026, 8, 23, 12),
  externalId: "msg-1",
  kind: "email",
  status: "needs_review",
  attempts: 1,
  route: "intake",
  summary: "A refund email about your Northwind order was held for review.",
  refundAwaitingConfirmation: true,
  pendingRefund: { merchant: "Northwind", credits: [{ itemName: "Kettle", amountMinor: 2_500, currency: "USD" }] },
};
const failedOrder = {
  _id: "pe2",
  _creationTime: Date.UTC(2026, 8, 23, 11),
  externalId: "msg-2",
  kind: "email",
  status: "failed",
  attempts: 3,
  route: "intake",
  errorSummary: "The order email could not be read.",
};

function renderSettings() {
  render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
  return screen.getAllByRole("row");
}

beforeEach(() => {
  confirmRefundEmail.mockClear();
  retryEvent.mockClear();
  attention = [heldRefund, failedOrder];
});

describe("Settings: a held refund email (DA-B-3)", () => {
  it("offers 'Confirm this refund' with the reason and the amount as a promise, and no retry", () => {
    const rows = renderSettings();
    const row = rows.find((r) => r.textContent?.includes("held for review"))!;
    expect(within(row).getByText("Needs your confirmation")).toBeDefined();
    expect(within(row).getByText("We can't verify who sent this email.")).toBeDefined();
    expect(row.textContent).toContain(`Promised, not received: ${fmt(2_500, "USD")} for Kettle`);
    expect(within(row).getByRole("button", { name: "Confirm this refund" })).toBeDefined();
    expect(within(row).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("still offers a retry on an ordinary failed row", () => {
    const rows = renderSettings();
    const row = rows.find((r) => r.textContent?.includes("could not be read"))!;
    expect(within(row).getByRole("button", { name: "Try again" })).toBeDefined();
    expect(within(row).queryByRole("button", { name: "Confirm this refund" })).toBeNull();
  });

  it("the tap calls confirmRefundEmail once with the row's event, even on a double tap", async () => {
    const rows = renderSettings();
    const row = rows.find((r) => r.textContent?.includes("held for review"))!;
    const button = within(row).getByRole("button", { name: "Confirm this refund" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(within(row).getByRole("status").textContent).toContain("Refund promise recorded."));
    expect(confirmRefundEmail).toHaveBeenCalledTimes(1);
    expect(confirmRefundEmail).toHaveBeenCalledWith({ processedEventId: "pe1" });
    expect(retryEvent).not.toHaveBeenCalled();
  });

  it("a held refund that is also marked failed is still never retried", () => {
    attention = [{ ...heldRefund, status: "failed" }];
    renderSettings();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Confirm this refund" })).toBeDefined();
  });
});
