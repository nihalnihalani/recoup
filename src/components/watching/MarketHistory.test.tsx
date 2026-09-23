// @vitest-environment happy-dom
/**
 * P03-A: a watch whose ShopSavvy lookup is stuck in empty_result or terminal_failure can be retried from the card
 * (`market.refresh`), queued and running read "Looking up…" with no button, a refusal reason has fixed words, and a
 * state with no note (not_configured) still says where the lookup stands.
 */
import axe from "axe-core";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { fireEvent, render, screen, waitFor } from "../../test/dom";
import { MarketHistory } from "./MarketHistory";

const refresh = vi.fn(async (_args: Record<string, unknown>): Promise<Record<string, unknown>> => ({ scheduled: true, state: "queued" }));
vi.mock("convex/react", () => ({
  useMutation: (ref: FunctionReference<"mutation">) => (getFunctionName(ref) === "market:refresh" ? refresh : vi.fn()),
}));

type Watch = Parameters<typeof MarketHistory>[0]["watch"];
const NOW = Date.now();

function watch(over: Partial<Watch>): Watch {
  return {
    _id: "w1" as Id<"watches">,
    name: "Down jacket",
    currency: "USD",
    lastCents: 10_000,
    market: null,
    marketState: null,
    marketRefreshableAt: null,
    ...over,
  } as Watch;
}

beforeEach(() => refresh.mockClear());

describe("MarketHistory lookup state (P03-A)", () => {
  it("terminal_failure shows 'Try again', and clicking it calls market.refresh once with the watch", async () => {
    render(<MarketHistory watch={watch({ marketState: "terminal_failure", marketRefreshableAt: NOW - 1_000 })} />);
    expect(document.body.textContent).toContain("The lookup of earlier prices failed.");
    const button = screen.getByRole("button", { name: "Try again" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh.mock.calls[0][0]).toEqual({ watchId: "w1" });
  });

  it("empty_result shows the reason from the server note and a 'Try again'", () => {
    render(
      <MarketHistory
        watch={watch({
          marketState: "empty_result",
          marketRefreshableAt: NOW - 1_000,
          market: { source: "shopsavvy", points: [], lowestCents: 0, highestCents: 0, since: 0, note: "No listings for this product." },
        })}
      />,
    );
    expect(document.body.textContent).toContain("No listings for this product.");
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
  });

  it.each(["queued", "running"] as const)("%s shows 'Looking up…' and no button", (state) => {
    render(<MarketHistory watch={watch({ marketState: state })} />);
    expect(screen.getByRole("status").textContent).toContain("Looking up earlier prices");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a refusal reason has fixed words (budget)", async () => {
    refresh.mockResolvedValueOnce({ scheduled: false, state: "terminal_failure", reason: "budget" });
    render(<MarketHistory watch={watch({ marketState: "terminal_failure", marketRefreshableAt: NOW - 1_000 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByText(/lookup budget is used up/)).textContent).toContain("Try again tomorrow");
  });

  it("not_configured with no note still renders a state line, with nothing to retry", () => {
    render(<MarketHistory watch={watch({ marketState: "not_configured" })} />);
    expect(document.body.textContent).toContain("aren't available on this deployment");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("a fresh success offers no retry; an old one offers 'Look up again'", () => {
    const market = { source: "shopsavvy" as const, points: [{ observedAt: NOW - 86_400_000, cents: 9_000, retailer: null }], lowestCents: 9_000, highestCents: 9_000, since: NOW - 86_400_000, note: null };
    render(<MarketHistory watch={watch({ marketState: "success", market, marketRefreshableAt: NOW + 86_400_000 })} />);
    expect(screen.queryByRole("button", { name: "Look up again" })).toBeNull();
    document.body.innerHTML = "";
    render(<MarketHistory watch={watch({ marketState: "success", market, marketRefreshableAt: NOW - 1 })} />);
    expect(screen.getByRole("button", { name: "Look up again" })).toBeDefined();
  });

  it("nothing yet → nothing rendered", () => {
    const { container } = render(<MarketHistory watch={watch({})} />);
    expect(container.textContent).toBe("");
  });

  it("passes axe (contrast is checked in the browser)", async () => {
    render(<MarketHistory watch={watch({ marketState: "terminal_failure", marketRefreshableAt: NOW - 1_000 })} />);
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
