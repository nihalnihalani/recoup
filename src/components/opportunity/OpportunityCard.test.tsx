// @vitest-environment happy-dom
/**
 * M15 (contract §10 row M15; mission §14, §20): the opportunity card for every outcome, deadlines by obligor and
 * certainty, the cap as a limit, amounts only with an estimate, not_yet_due never owed, one next action.
 */
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { evaluationOutcome } from "../../../convex/schema";
import { formatMinor } from "../../lib/money";
import { fireEvent, render, screen, waitFor } from "../../test/dom";
import { NOW, view } from "../../test/opportunityFixtures";
import { formatLocalDate, OUTCOME_COPY, type OpportunityView } from "./model";
import { OpportunityCard } from "./OpportunityCard";

type Deadline = Doc<"evaluations">["deadlines"][number];
const DAY = 86_400_000;

function renderCard(v: OpportunityView, props: Partial<Parameters<typeof OpportunityCard>[0]> = {}) {
  render(
    <MemoryRouter>
      <OpportunityCard view={v} now={NOW} counterparty="Northwind" {...props} />
    </MemoryRouter>,
  );
  return document.body.textContent ?? "";
}

const userWindow = (overrides: Partial<Deadline> = {}): Deadline => ({
  id: "r01.window",
  label: "The store's price-adjustment window",
  obligor: "user",
  status: "open",
  dueAt: NOW + 3 * DAY + 4 * 3_600_000,
  mustBe: "n_a",
  basis: "30 × 24 hours from retail.purchase_date",
  ...overrides,
});

describe("OpportunityCard: every outcome", () => {
  const outcomes = evaluationOutcome.members.map((m) => m.value);

  it("covers every outcome the schema has", () => {
    expect(Object.keys(OUTCOME_COPY).sort()).toEqual([...outcomes].sort());
  });

  it.each(outcomes)("renders %s with its own label and no guarantee", (outcome) => {
    const text = renderCard(view({ outcome, nextAction: { kind: "none", reason: "Nothing to do." } }));
    expect(screen.getByText(OUTCOME_COPY[outcome].label)).toBeDefined();
    expect(text.toLowerCase()).not.toMatch(/guaranteed recovery|we guarantee|every right/);
  });

  it("shows an amount only for outcomes that stand behind an estimate", () => {
    for (const outcome of outcomes) {
      const text = renderCard(view({ outcome, nextAction: { kind: "none", reason: "x" } }));
      const shown = text.includes(formatMinor(2_500, "USD"));
      expect(shown, outcome).toBe(["eligible", "likely_eligible", "possible_contract_benefit", "deadline_passed"].includes(outcome));
      document.body.innerHTML = "";
    }
  });
});

describe("OpportunityCard: amounts", () => {
  it("no amount without an estimate", () => {
    const text = renderCard(view({ outcome: "eligible", amount: null }));
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toContain("Estimated recovery");
  });

  it("labels the amount an estimate, never a guarantee, and drops the duplicated estimate line", () => {
    const text = renderCard(view());
    expect(text).toContain("Estimated recovery");
    expect(text).toContain("An estimate, not a guarantee");
    expect(text).not.toContain("Estimated adjustment USD 25.00");
    expect(text).toContain("The price fell within the store's window.");
  });

  it("shows a cap as a limit, never as the expected amount", () => {
    const text = renderCard(
      view({
        amount: {
          estimate: { amountMinor: 2_500, currency: "USD" },
          basis: "exact_formula",
          formula: "x",
          inputs: [],
          cap: { amount: { amountMinor: 470_000, currency: "USD" }, sourcePassageId: "p", note: "Minimum liability limit a carrier may set — not a payout." },
        },
      }),
    );
    expect(text).toContain(`Limit: ${formatMinor(470_000, "USD")}`);
    expect(text).toContain("the most this path can pay, not what to expect");
    // The headline figure is the estimate, not the cap. (Matched on raw textContent: Intl may use a no-break space.)
    const headline = [...document.querySelectorAll("p.text-3xl")].map((el) => el.textContent);
    expect(headline).toEqual([formatMinor(2_500, "USD")]);
  });

  it("not_yet_due: never shown as owed, even when an estimate exists; says when to check again", () => {
    const text = renderCard(
      view({
        outcome: "not_yet_due",
        reevaluate: { at: "2026-10-11" },
        nextAction: { kind: "wait", reevaluate: { at: "2026-10-11" } },
      }),
    );
    expect(text).not.toContain(formatMinor(2_500, "USD"));
    expect(text).not.toContain("Estimated");
    expect(text).toContain("nothing is owed yet");
    expect(text).toContain(`Check again on ${formatLocalDate("2026-10-11")}.`);
  });

  it("not_yet_due waiting on an event says 'after <event>'", () => {
    const text = renderCard(view({ outcome: "not_yet_due", reevaluate: { when: "the delivery date passes" }, nextAction: { kind: "wait", reevaluate: { when: "the delivery date passes" } } }));
    expect(text).toContain("Check again after the delivery date passes.");
  });

  it("non-cash and provisional are labelled as such", () => {
    renderCard(view({}, { cashClass: "non_cash" }));
    expect(screen.getByText("Non-cash")).toBeDefined();
    document.body.innerHTML = "";
    renderCard(view({}, { cashClass: "provisional" }));
    expect(screen.getByText("Provisional credit")).toBeDefined();
  });
});

describe("OpportunityCard: authority", () => {
  it("a merchant promise is never called the law", () => {
    const text = renderCard(view({}, { authorityClass: "merchant_promise" }));
    expect(screen.getByText("Merchant or carrier promise")).toBeDefined();
    expect(text).not.toMatch(/\blaw\b|legal entitlement/i);
    expect(screen.getByText("Merchant or carrier promise").closest("[title]")?.getAttribute("title")).toMatch(/not a law/);
  });

  it("a legal entitlement says so", () => {
    renderCard(view({}, { authorityClass: "legal_entitlement" }));
    expect(screen.getByText("Legal entitlement")).toBeDefined();
  });
});

describe("OpportunityCard: deadlines", () => {
  it("a user deadline shows the date and a countdown on the client clock", () => {
    const text = renderCard(view({ deadlines: [userWindow()] }));
    expect(text).toContain("3 days 4 hours left");
    expect(text).toContain("30 × 24 hours from purchase date");
  });

  it("an unknown start date gives no firm date, only a labelled conservative act-by", () => {
    const text = renderCard(
      view({
        outcome: "needs_facts",
        deadlines: [userWindow({ status: "unknown_anchor", dueAt: undefined, advisoryActBy: "2026-10-20", basis: "The start date is not known yet." })],
        nextAction: { kind: "none", reason: "x" },
      }),
    );
    expect(text).toContain("Deadline not known yet");
    expect(text).toContain(`Conservative act-by (not the legal deadline): ${formatLocalDate("2026-10-20")}`);
    expect(text).not.toContain("left");
  });

  it("a disputed start date is unclear, not a deadline", () => {
    const text = renderCard(view({ deadlines: [userWindow({ status: "disputed_anchor", dueAt: undefined, advisoryActBy: "2026-10-01" })] }));
    expect(text).toContain("the start date is disputed");
    expect(text).toContain("Conservative act-by (not the legal deadline)");
  });

  it("a counterparty deadline is what they owe, and 'overdue', never 'passed'", () => {
    const text = renderCard(
      view({
        deadlines: [
          { id: "refund", label: "Refund due from the carrier", obligor: "counterparty", status: "overdue", dueAt: NOW - 2 * DAY, overdueSince: NOW - 2 * DAY, mustBe: "paid", basis: "7 business days" },
        ],
      }),
    );
    expect(text).toMatch(/Northwind is overdue since/);
    expect(text).not.toMatch(/passed/i);
  });

  it("an open counterparty deadline reads as what they owe by when", () => {
    const text = renderCard(
      view({ deadlines: [{ id: "refund", label: "Refund due", obligor: "counterparty", status: "open", dueAt: NOW + DAY, mustBe: "paid", basis: "7 business days" }] }),
    );
    expect(text).toMatch(/Northwind owes this by/);
  });

  it("a passed user deadline says so", () => {
    const text = renderCard(view({ outcome: "deadline_passed", deadlines: [userWindow({ status: "passed", dueAt: NOW - DAY })] }));
    expect(text).toMatch(/Passed on/);
  });

  it("beyond the verified calendar is said plainly", () => {
    const text = renderCard(view({ deadlines: [userWindow({ status: "beyond_calendar", dueAt: undefined })] }));
    expect(text).toContain("past the calendar Recoup has verified");
  });
});

describe("OpportunityCard: sources, overlaps, assumptions", () => {
  it("shows the source with an unknown effective date, and the rule version", () => {
    const text = renderCard(view());
    expect(screen.getByRole("link", { name: /northwind\.example/ }).getAttribute("href")).toBe("https://www.northwind.example/price-match");
    expect(text).toContain("effective date unknown");
    expect(text).toContain("Rule R01-price-adjustment version 1");
  });

  it("lists assumptions with what would change the answer", () => {
    const text = renderCard(
      view({ outcome: "likely_eligible", assumptions: [{ id: "A-T2", text: "The policy text was retrieved 40 days after your purchase.", changesOutcomeIf: "the policy changed" }] }),
    );
    expect(text).toContain("Changes the answer if the policy changed.");
  });

  it("names another path on the same loss as an alternative, never additive", () => {
    const a = view();
    const b = view({}, { _id: "o2" as Id<"opportunities">, scenarioId: "R03" });
    renderCard(a, { related: [a, b] });
    expect(screen.getByText(/Alternative for the same loss: only one of them is recovered Credit-card billing error/)).toBeDefined();
  });
});

describe("OpportunityCard: the next action", () => {
  it("open_case → 'Start a claim' calls openCase and shows a refusal", async () => {
    const onOpenCase = vi.fn(async () => ({ ok: false as const, code: "overlap" as const, message: "You already have an active claim for this loss via R03" }));
    renderCard(view(), { onOpenCase });
    fireEvent.click(screen.getByRole("button", { name: "Start a claim" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("already have an active claim"));
    expect(onOpenCase).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/nothing is sent until you approve it/)).toBeDefined();
  });

  it("an open case links to the claim instead", () => {
    renderCard(view({ nextAction: { kind: "continue_case", claimId: "c9" as Id<"claims"> } }, { status: "case_open", activeClaimId: "c9" as Id<"claims"> }));
    expect(screen.getByRole("link", { name: "Open the claim" }).getAttribute("href")).toBe("/claims/c9");
    expect(screen.queryByRole("button", { name: "Start a claim" })).toBeNull();
  });

  it("a user action while not yet due is the next step (D154)", () => {
    const text = renderCard(view({ outcome: "not_yet_due", nextAction: { kind: "add_evidence", docTypes: ["baggage_report"] } }));
    expect(text).toContain("Next: add a baggage report.");
  });

  it("'Check again' reports a refusal instead of failing silently", async () => {
    const onCheckAgain = vi.fn(async () => {
      throw new Error("Too many checks in a short time. Try again in a minute.");
    });
    renderCard(view(), { onCheckAgain });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many checks"));
  });

  it("an unevaluated opportunity says it has not been checked", () => {
    const text = renderCard(view(null));
    expect(text).toContain("has not been checked yet");
  });

  it("raw fact keys never reach the user", () => {
    const text = renderCard(view({ outcome: "needs_facts", amount: null, nextAction: { kind: "none", reason: "Confirm the purchase details on the purchase page: retail.unit_price, retail.purchase_date." } }));
    expect(text).not.toMatch(/retail\.[a-z_]+/);
  });
});

describe("OpportunityCard: review_amount (DA-B-2)", () => {
  it("says the open claim asks more than the estimate and links to the claim to adjust it", () => {
    const text = renderCard(
      view(
        {
          amount: { estimate: { amountMinor: 2_500, currency: "USD" }, basis: "exact_formula", formula: "(5,000 - 2,500) x 1", inputs: [] },
          nextAction: { kind: "review_amount", claimId: "c7" as Id<"claims">, claimedMinor: 5_000, estimateMinor: 2_500, currency: "USD" },
        },
        { status: "case_open", activeClaimId: "c7" as Id<"claims"> },
      ),
    );
    expect(text).toContain(
      `Your open claim asks for ${formatMinor(5_000, "USD")}, more than the current estimate of ${formatMinor(2_500, "USD")}.`,
    );
    expect(screen.getByRole("link", { name: "Review the claim amount" }).getAttribute("href")).toBe("/claims/c7");
    // One next action: the review replaces the plain "Open the claim".
    expect(screen.queryByRole("link", { name: "Open the claim" })).toBeNull();
  });
});

describe("P06-OW-1 display: a stored path past its user deadline is never shown as claimable", () => {
  const passed = () =>
    view(
      { outcome: "likely_eligible", nextAction: { kind: "open_case" }, deadlines: [userWindow({ dueAt: NOW - 3_600_000 })] },
      { outcome: "likely_eligible", nextDeadlineAt: NOW - 3_600_000 },
    );

  it("replaces the outcome, the estimate and 'Start a claim' with a check-again state", () => {
    const text = renderCard(passed(), { onOpenCase: vi.fn(), onCheckAgain: vi.fn(async () => {}) });
    expect(screen.queryByText(OUTCOME_COPY.likely_eligible.label)).toBeNull();
    expect(text).not.toContain(formatMinor(2_500, "USD"));
    expect(screen.queryByRole("button", { name: "Start a claim" })).toBeNull();
    expect(screen.getByText("Window may have passed")).toBeDefined();
    expect(text).toContain("The window may have passed. Check again so Recoup can confirm.");
    expect(screen.getByRole("button", { name: "Check again" })).toBeDefined();
  });

  it("the same path before its deadline is unchanged", () => {
    const text = renderCard(
      view({ outcome: "likely_eligible", nextAction: { kind: "open_case" }, deadlines: [userWindow()] }, { outcome: "likely_eligible" }),
      { onOpenCase: vi.fn() },
    );
    expect(screen.getByText(OUTCOME_COPY.likely_eligible.label)).toBeDefined();
    expect(text).toContain(formatMinor(2_500, "USD"));
    expect(screen.getByRole("button", { name: "Start a claim" })).toBeDefined();
    expect(screen.queryByText("Window may have passed")).toBeNull();
  });
});

describe("F1 regression: a case asked in time (case_open, active claim) after the window end", () => {
  // An R01 claim sent on day 28 of a 30-day window: the stored evaluation's deadlines[0] stays {obligor:"user",
  // status:"open", dueAt: day 30} because only R03 ever calls markMet. Without gating on case_open/activeClaimId,
  // passedUserDeadline would keep flagging this claimed-in-time path as "Window may have passed" for the whole life
  // of the open case, even though the server's own isExpired (convex/lib/claimState.ts) never expires it.
  const caseOpen = () =>
    view(
      { outcome: "likely_eligible", nextAction: { kind: "continue_case", claimId: "c1" as Id<"claims"> }, deadlines: [userWindow({ dueAt: NOW - 3_600_000 })] },
      { outcome: "likely_eligible", status: "case_open", activeClaimId: "c1" as Id<"claims">, nextDeadlineAt: NOW - 3_600_000 },
    );

  it("does not show 'Window may have passed' or hide the estimate once a claim is open", () => {
    const text = renderCard(caseOpen());
    expect(screen.queryByText("Window may have passed")).toBeNull();
    expect(text).not.toContain("not shown as claimable");
  });
});

describe("M29 deadline attention (D241)", () => {
  const due = NOW + 5 * DAY;
  it("shows 'Deadline soon' while the stored attention is current", () => {
    const text = renderCard(
      view(
        { deadlines: [userWindow({ dueAt: due })] },
        { nextDeadlineAt: due, deadlineAttention: { setAt: NOW - DAY, dueAt: due, deadlineId: "r01.window" } },
      ),
    );
    expect(screen.getByText("Deadline soon")).toBeDefined();
    expect(text).toContain("Your deadline is coming up");
  });

  it("stale attention (the next deadline moved) is not shown", () => {
    renderCard(
      view(
        { deadlines: [userWindow({ dueAt: due + DAY })] },
        { nextDeadlineAt: due + DAY, deadlineAttention: { setAt: NOW - DAY, dueAt: due, deadlineId: "r01.window" } },
      ),
    );
    expect(screen.queryByText("Deadline soon")).toBeNull();
  });
});
