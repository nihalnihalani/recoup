import { describe, expect, it } from "vitest";
import { SCENARIO_TITLES as SERVER_TITLES } from "../../../convex/lib/rules/coverage";
import { authorityClass } from "../../../convex/schema";
import { deadlineAttentionActive as serverAttentionActive } from "../../../convex/deadlines";
import {
  AUTHORITY_COPY,
  amountHeading,
  deadlineAttentionActive,
  explanationLines,
  humanizeKeys,
  passedUserDeadline,
  remainingCopy,
  SCENARIO_TITLES,
  sharedLossViews,
} from "./model";
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

describe("deadline attention and a passed window (M29 D241; P06-OW-1 display)", () => {
  const DUE = Date.UTC(2026, 9, 1, 12);
  const base = { status: "open" as const, nextDeadlineAt: DUE, deadlineAttention: { setAt: DUE - 5 * 86_400_000, dueAt: DUE, deadlineId: "d" } };
  const cases = [
    { name: "active before the deadline", o: base, now: DUE - 1 },
    { name: "not active at the deadline", o: base, now: DUE },
    { name: "not active once the next deadline moved", o: { ...base, nextDeadlineAt: DUE + 1 }, now: DUE - 1 },
    { name: "active on an open case", o: { ...base, status: "case_open" as const }, now: DUE - 1 },
    { name: "not active on a closed path", o: { ...base, status: "closed" as const }, now: DUE - 1 },
    { name: "not active with no attention", o: { status: "open" as const, nextDeadlineAt: DUE }, now: DUE - 1 },
  ];
  for (const c of cases) {
    it(`matches the server rule: ${c.name}`, () => {
      expect(deadlineAttentionActive(c.o, c.now)).toBe(serverAttentionActive(c.o, c.now));
    });
  }
  it("the server rule is really exercised both ways", () => {
    expect(cases.map((c) => serverAttentionActive(c.o, c.now))).toEqual([true, false, false, true, false, false]);
  });

  it("a running user deadline at or before now is passed; a counterparty one, a met one or a future one is not", () => {
    const d = (over: Record<string, unknown>) => ({ id: "w", label: "Window", obligor: "user", status: "open", dueAt: DUE, mustBe: "filed", basis: "x", ...over });
    const ev = (deadlines: unknown[]) => ({ deadlines }) as never;
    expect(passedUserDeadline(ev([d({})]), DUE)?.id).toBe("w");
    expect(passedUserDeadline(ev([d({})]), DUE - 1)).toBeNull();
    expect(passedUserDeadline(ev([d({ obligor: "counterparty" })]), DUE + 1)).toBeNull();
    expect(passedUserDeadline(ev([d({ status: "met" })]), DUE + 1)).toBeNull();
    expect(passedUserDeadline(null, DUE + 1)).toBeNull();
  });

  it("F1 regression: a passed user deadline is not flagged once the case is open, only while it is still 'open'", () => {
    const d = (over: Record<string, unknown>) => ({ id: "w", label: "Window", obligor: "user", status: "open", dueAt: DUE, mustBe: "filed", basis: "x", ...over });
    const ev = (deadlines: unknown[]) => ({ deadlines }) as never;
    expect(passedUserDeadline(ev([d({})]), DUE, { status: "open" })?.id).toBe("w");
    expect(passedUserDeadline(ev([d({})]), DUE, { status: "case_open" })).toBeNull();
    expect(passedUserDeadline(ev([d({})]), DUE, { status: "open", activeClaimId: "c1" as never })).toBeNull();
  });
});
