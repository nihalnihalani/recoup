import { describe, expect, it } from "vitest";
import { SCENARIO_TITLES as SERVER_TITLES } from "../../../convex/lib/rules/coverage";
import { authorityClass } from "../../../convex/schema";
import { AUTHORITY_COPY, amountHeading, explanationLines, humanizeKeys, remainingCopy, SCENARIO_TITLES, sharedLossViews } from "./model";
import { view } from "../../test/opportunityFixtures";
import type { Id } from "../../../convex/_generated/dataModel";

describe("opportunity copy", () => {
  it("scenario titles match convex/lib/rules/coverage.ts exactly", () => {
    expect(SCENARIO_TITLES).toEqual(SERVER_TITLES);
  });

  it("has a label for every authority class, and only legal_entitlement claims a legal right", () => {
    expect(Object.keys(AUTHORITY_COPY).sort()).toEqual(authorityClass.members.map((m) => m.value).sort());
    for (const [cls, copy] of Object.entries(AUTHORITY_COPY)) {
      if (cls === "legal_entitlement") continue;
      expect(`${copy.label} ${copy.description}`, cls).not.toMatch(/gives you this right|required by law|the law requires/i);
    }
  });

  it("never heads an amount for not_yet_due, needs_facts or an ineligible path", () => {
    const amount = view().evaluation!.amount;
    for (const outcome of ["not_yet_due", "needs_facts", "manual_review", "not_eligible", "unsupported", "source_unverified"] as const) {
      expect(amountHeading(outcome, amount), outcome).toBeNull();
    }
    expect(amountHeading("eligible", null)).toBeNull();
    expect(amountHeading("eligible", amount)).toBe("Estimated recovery");
  });

  it("turns fact keys into words", () => {
    expect(humanizeKeys("30 × 24 hours from retail.purchase_date")).toBe("30 × 24 hours from purchase date");
    expect(humanizeKeys("Confirm: retail.unit_price, retail.quantity.")).toBe("Confirm: unit price, quantity.");
    expect(humanizeKeys("Visit www.example.com")).toBe("Visit www.example.com");
  });

  it("drops the line that repeats the estimate", () => {
    expect(explanationLines({ explanation: ["Estimated adjustment USD 25.00: x", "Other."] })).toEqual(["Other."]);
  });

  it("words a countdown without deciding anything", () => {
    expect(remainingCopy(3 * 86_400_000 + 4 * 3_600_000)).toBe("3 days 4 hours left");
    expect(remainingCopy(90 * 60_000)).toBe("1 hour 30 minutes left");
    expect(remainingCopy(30_000)).toBe("less than a minute left");
    expect(remainingCopy(-1)).toBe("time is up by this device's clock");
  });

  it("finds other paths that share a loss key", () => {
    const a = view();
    const b = view({}, { _id: "o2" as Id<"opportunities"> });
    const c = view({}, { _id: "o3" as Id<"opportunities">, lossKeys: ["other"] });
    expect(sharedLossViews(a, [a, b, c]).map((v) => v.opportunity._id)).toEqual(["o2"]);
  });
});
