// @vitest-environment happy-dom
/**
 * §3.2 / D156: a provisional credit gets its own feed entry, labelled "not final", in the waiting tone; it is never
 * "Back on card" and never folded into credit or charged-again.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Id } from "../../../convex/_generated/dataModel";
import { fmt } from "../../lib/money";
import { render, screen } from "../../test/dom";
import { ActivityTimeline } from "./ActivityTimeline";
import type { ActivityEvent } from "./model";

const at = Date.UTC(2026, 8, 20, 12);
const event = (kind: ActivityEvent["kind"], id: string): ActivityEvent => ({
  id,
  at,
  kind,
  subject: "Kettle",
  currency: "USD",
  cents: 2_000,
  claimId: "c1" as Id<"claims">,
});

describe("provisional credits in the activity feed", () => {
  it("names a provisional credit as not final and its resolution as resolved, with the amount, never as money back", () => {
    render(
      <MemoryRouter>
        <ActivityTimeline events={[event("credit_provisional", "a"), event("provisional_resolved", "b")]} truncated={false} windowNote="" />
      </MemoryRouter>,
    );
    expect(screen.getByText("Provisional credit (not final)")).toBeDefined();
    expect(screen.getByText("Provisional credit resolved")).toBeDefined();
    const text = document.body.textContent ?? "";
    expect(text).toContain(fmt(2_000, "USD"));
    expect(text).not.toContain("Back on card");
  });
});
