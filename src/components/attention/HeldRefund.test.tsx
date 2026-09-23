// @vitest-environment happy-dom
/**
 * M15b (DA-B-3, SEC-AI-6): a refund email Recoup cannot authenticate waits for the user's one-tap confirmation.
 * The tap calls `intake.confirmRefundEmail` exactly once (a double tap included), the amount reads as a promise,
 * never as money back, the reason is stated plainly, and the markup passes axe.
 */
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { fmt } from "../../lib/money";
import { fireEvent, render, screen, waitFor } from "../../test/dom";
import { HeldRefund, type ConfirmRefundResult, type HeldRefundSummary } from "./HeldRefund";

const EVENT = "pe1" as Id<"processedEvents">;
const refund: HeldRefundSummary = {
  merchant: "Northwind",
  credits: [{ itemName: "Kettle", amountMinor: 2_500, currency: "USD" }],
  sender: { address: "refunds@northwind.example", display: "Northwind <refunds@northwind.example>" },
  receivedAt: Date.UTC(2026, 8, 23, 9),
};

let resolveConfirm: (value: ConfirmRefundResult) => void = () => {};
const onConfirm = vi.fn(
  (_id: Id<"processedEvents">) =>
    new Promise<ConfirmRefundResult>((resolve) => {
      resolveConfirm = resolve;
    }),
);

beforeEach(() => {
  onConfirm.mockClear();
});

describe("HeldRefund", () => {
  it("says plainly why it waits, and shows the amount as a promise, never as money back", () => {
    render(<HeldRefund eventId={EVENT} refund={refund} onConfirm={onConfirm} />);
    const text = document.body.textContent ?? "";
    expect(text).toContain("We can't verify who sent this email.");
    expect(text).toContain("Nothing has been recorded.");
    expect(text).toContain(`Promised, not received: ${fmt(2_500, "USD")} for Kettle`);
    expect(text).not.toMatch(/credited|refunded to your card|back on your card|received\b(?!:)/i);
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
  });

  it("one tap calls confirmRefundEmail once with this event", async () => {
    render(<HeldRefund eventId={EVENT} refund={refund} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm this refund" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(EVENT);
    resolveConfirm({ status: "succeeded", summary: "Refund promise recorded on your Kettle claim." });
    expect(await screen.findByRole("status")).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Refund promise recorded");
    expect(screen.queryByRole("button", { name: "Confirm this refund" })).toBeNull();
  });

  it("a double tap is idempotent: still exactly one call", async () => {
    render(<HeldRefund eventId={EVENT} refund={refund} onConfirm={onConfirm} />);
    const button = screen.getByRole("button", { name: "Confirm this refund" });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: "Confirming…" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    resolveConfirm({ status: "succeeded", summary: null });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Recorded as a promised refund."));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows the server's refusal (e.g. confirmed from another tab) and allows another try", async () => {
    const refusing = vi.fn(async () => {
      throw new Error("This email has no refund waiting for your confirmation");
    });
    render(<HeldRefund eventId={EVENT} refund={refund} onConfirm={refusing} />);
    fireEvent.click(screen.getByRole("button", { name: "Confirm this refund" }));
    expect((await screen.findByRole("alert")).textContent).toContain("no refund waiting");
    expect((screen.getByRole("button", { name: "Confirm this refund" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("passes axe (structure, names, roles; contrast is checked in the browser)", async () => {
    const { container } = render(
      <main>
        <h1>Needs attention</h1>
        <HeldRefund eventId={EVENT} refund={refund} onConfirm={onConfirm} />
      </main>,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
