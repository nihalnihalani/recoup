// @vitest-environment happy-dom
/**
 * P02-OW-4: a queued claim whose send outcome is unknown is "Delivery unknown" with a still dot, on the dashboard chip
 * and on the stepper; no queued claim is shown as "Asked". P06-OW-2: the dashboard's price cells show the price's
 * own age and never present an out-of-date price as current.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { render, screen, within } from "../test/dom";
import { StatusSteps } from "./charts/StatusSteps";
import type { Item } from "./dashboard/model";
import { VerdictChip } from "./dashboard/parts";
import { PurchasesTable } from "./dashboard/PurchasesTable";
import { StatusPill } from "./StatusPill";

const NOW = Date.UTC(2026, 8, 23, 12);
const DAY = 86_400_000;

function item(over: Partial<Item> = {}): Item {
  return {
    itemId: "i1" as Id<"items">,
    purchaseId: "p1" as Id<"purchases">,
    name: "Kettle",
    merchant: "Northwind",
    merchantDomain: "northwind.example",
    currency: "USD",
    qty: 1,
    paidCents: 10_000,
    isExample: false,
    points: [{ at: NOW - DAY, cents: 8_000 }],
    checks: 1,
    lastCheckedAt: NOW - DAY,
    lastObservedAt: NOW - DAY,
    priceStale: false,
    latestCents: 8_000,
    lowestCents: 8_000,
    dropCents: 2_000,
    windowEndsAt: NOW + 10 * DAY,
    ...over,
  } as Item;
}

const claim = (status: NonNullable<Item["claim"]>["status"], sendUnknown?: boolean): Item["claim"] => ({
  claimId: "c1" as Id<"claims">,
  type: "price_adjustment",
  status,
  expectedCents: 2_000,
  unresolvedCents: 2_000,
  confirmedCents: 0,
  ...(sendUnknown ? { sendUnknown } : {}),
});

describe("P02-OW-4: no forever-pulsing 'Sending…'", () => {
  it("StatusPill: queued + sendUnknown reads 'Delivery unknown' and does not pulse", () => {
    const { container } = render(<StatusPill status="queued" sendUnknown />);
    expect(container.textContent).toBe("Delivery unknown");
    expect(container.querySelector(".animate-pulse")).toBeNull();
  });

  it("StatusPill: a plain queued send still reads 'Sending…'", () => {
    const { container } = render(<StatusPill status="queued" />);
    expect(container.textContent).toBe("Sending…");
  });

  it("VerdictChip on the dashboard passes sendUnknown through", () => {
    render(
      <MemoryRouter>
        <VerdictChip item={item({ claim: claim("queued", true) })} now={NOW} />
      </MemoryRouter>,
    );
    expect(document.body.textContent).toContain("Delivery unknown");
    expect(document.body.textContent).not.toContain("Sending…");
  });

  it("StatusSteps: a queued claim has not reached 'Asked'; the note says the send is unconfirmed", () => {
    render(<StatusSteps status="queued" sendUnknown />);
    const steps = screen.getByRole("list", { name: "Claim progress" });
    expect(within(steps).getByText("Asked").textContent).toContain("(not yet)");
    expect(document.body.textContent).toContain("Delivery unknown");
    document.body.innerHTML = "";
    render(<StatusSteps status="sent" />);
    expect(within(screen.getByRole("list", { name: "Claim progress" })).getByText("Asked").textContent).toContain("(current)");
  });
});

describe("P06-OW-2: the dashboard shows the price's own age", () => {
  function renderTable(items: Item[]) {
    render(
      <MemoryRouter>
        <PurchasesTable items={items} now={NOW} truncated={false} />
      </MemoryRouter>,
    );
    return document.body.textContent ?? "";
  }

  it("a fresh price says when it was read", () => {
    const text = renderTable([item()]);
    expect(text).toContain("read 1d 0h ago");
    expect(text).not.toContain("Out of date");
    expect(text).toContain("20%");
  });

  it("a 20-day-old price is flagged, not compared with what was paid, and its verdict is not 'Claim now'", () => {
    const text = renderTable([
      item({ lastObservedAt: NOW - 20 * DAY, lastCheckedAt: NOW - 3_600_000, priceStale: true, points: [{ at: NOW - 20 * DAY, cents: 8_000 }] }),
    ]);
    expect(text).toContain("Out of date");
    expect(text).toContain("read 20d 0h ago");
    // A failed read an hour ago never makes the price look fresh.
    expect(text).not.toContain("1h 0m ago");
    expect(text).not.toContain("Claim now");
    expect(text).not.toContain("20%");
  });

  it("F2 regression: the price and the 'Out of date' badge stack, not a non-wrapping inline-flex row", () => {
    // happy-dom has no layout engine, so this cannot measure pixel overflow directly (that was checked with a real
    // Chromium render of this exact markup at 375px and 800px, see recoup-wt-fe2-evidence/mobile2). This locks in
    // the structural fix: the badge is a block sibling of the price inside a `flex-col` container, never inside the
    // old `inline-flex items-center` row that forced both onto one non-wrapping line and let the badge overflow the
    // fixed-width "Now" column into the Change/Window content next to it.
    renderTable([
      item({ lastObservedAt: NOW - 20 * DAY, lastCheckedAt: NOW - 3_600_000, priceStale: true, points: [{ at: NOW - 20 * DAY, cents: 8_000 }] }),
    ]);
    const badge = screen.getAllByText("Out of date")[0];
    const stack = badge.parentElement!;
    expect(stack.className).toContain("flex-col");
    expect(stack.className).not.toContain("inline-flex");
  });
});
