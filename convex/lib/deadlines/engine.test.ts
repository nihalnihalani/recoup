/**
 * Deadline engine (contract rev 5.5 §4; DA-A-5; D143.3; D154). Every expected instant below is computed by hand in
 * the comment next to it — never by calling the engine.
 */
import { describe, expect, it } from "vitest";
import { deriveOutcome } from "../rules/outcome";
import { emptyFlags, lookupFrom, type DeadlineSpec, type EngineCell, type FactValue } from "../rules/types";
import {
  computeDeadline,
  computeDeadlineDetailed,
  isLateAskAcknowledgeable,
  nextCounterpartyDueAt,
  nextUserDeadlineAt,
  overdueCounterpartyDeadlines,
  userWindowOpen,
} from "./engine";

const T = (iso: string) => Date.parse(iso);
const cell = (key: string, status: EngineCell["status"], value?: FactValue, subjectKey = "txn"): EngineCell => ({
  subjectKey, key, status, ...(value !== undefined ? { value } : {}),
});
const instant = (iso: string): FactValue => ({ kind: "instant", epochMs: T(iso) });
const localDate = (date: string): FactValue => ({ kind: "local_date", date });
const NY: FactValue = { kind: "code", code: "America/New_York" };

function spec(over: Partial<DeadlineSpec> = {}): DeadlineSpec {
  return {
    id: "test.deadline",
    label: "Test deadline",
    obligor: "user",
    anchor: { subjectPattern: "txn", factKey: "x.anchor" },
    anchorKind: "event_occurred",
    offset: { amount: 14, unit: "calendar_days" },
    boundary: { anchorDayCounts: false, endInclusive: true },
    endOfDay: "local_end_of_day",
    timeZone: { from: "fact", factKey: "x.tz" },
    holidays: "none",
    mustBe: "sent",
    sourcePassageId: "TEST-1",
    ...over,
  };
}

describe("elapsed 24-hour days (R01 v1 legacy window) across DST 2026-11-01", () => {
  // 2026-10-25T12:00-04:00 = 16:00Z; + 14 × 24 h = 2026-11-08T16:00Z = 11:00 EST (not 12:00: daylight time ended).
  const s = spec({ offset: { amount: 14, unit: "elapsed_24h_days" }, endOfDay: "exact_instant", timeZone: { fixed: "UTC" } });
  const cells = lookupFrom([cell("x.anchor", "confirmed", instant("2026-10-25T12:00:00-04:00"))]);

  it("dueAt is the instant, open at the instant, passed one minute later", () => {
    expect(computeDeadline(s, cells, T("2026-11-08T16:00:00Z"))).toMatchObject({ status: "open", dueAt: T("2026-11-08T16:00:00Z") });
    expect(computeDeadline(s, cells, T("2026-11-08T16:01:00Z")).status).toBe("passed");
  });
});

describe("calendar days vs business days, inclusive vs exclusive, DST", () => {
  const anchorOct25 = [cell("x.anchor", "confirmed", instant("2026-10-25T12:00:00-04:00")), cell("x.tz", "confirmed", NY)];

  it("calendar days, exact instant: same wall-clock time 14 days later (12:00 EST = 17:00Z), one hour after the 24h reading", () => {
    const r = computeDeadline(spec({ endOfDay: "exact_instant" }), lookupFrom(anchorOct25), T("2026-10-26T00:00:00Z"));
    expect(r.dueAt).toBe(T("2026-11-08T17:00:00Z"));
    expect(r.dueLocalDate).toBe("2026-11-08");
    expect(r.timeZone).toBe("America/New_York");
  });

  it("calendar days, local end of day, inclusive: last day 11-08 → 2026-11-09T05:00Z − 1 ms", () => {
    const r = computeDeadline(spec(), lookupFrom(anchorOct25), T("2026-10-26T00:00:00Z"));
    expect(r).toMatchObject({ status: "open", dueLocalDate: "2026-11-08", dueAt: T("2026-11-09T05:00:00Z") - 1 });
  });

  it("exclusive end: last day 11-07 → 2026-11-08T05:00Z − 1 ms (EST after 11-01)", () => {
    const r = computeDeadline(spec({ boundary: { anchorDayCounts: false, endInclusive: false } }), lookupFrom(anchorOct25), 0);
    expect(r).toMatchObject({ dueLocalDate: "2026-11-07", dueAt: T("2026-11-08T05:00:00Z") - 1 });
  });

  it("anchor day counts: day 14 is 11-07", () => {
    const r = computeDeadline(spec({ boundary: { anchorDayCounts: true, endInclusive: true } }), lookupFrom(anchorOct25), 0);
    expect(r.dueLocalDate).toBe("2026-11-07");
  });

  it("DST start 2026-03-08: 7 calendar days from 03-01 12:00 EST → 03-08 12:00 EDT (16:00Z) vs 7 × 24 h → 17:00Z", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", instant("2026-03-01T12:00:00-05:00")), cell("x.tz", "confirmed", NY)]);
    const cal = computeDeadline(spec({ offset: { amount: 7, unit: "calendar_days" }, endOfDay: "exact_instant" }), c, 0);
    const h24 = computeDeadline(spec({ offset: { amount: 7, unit: "elapsed_24h_days" }, endOfDay: "exact_instant" }), c, 0);
    expect(cal.dueAt).toBe(T("2026-03-08T16:00:00Z"));
    expect(h24.dueAt).toBe(T("2026-03-08T17:00:00Z"));
    // End of the 23-hour local day 03-08: next local midnight is 04:00Z.
    const eod = computeDeadline(spec({ offset: { amount: 7, unit: "calendar_days" } }), c, 0);
    expect(eod.dueAt).toBe(T("2026-03-09T04:00:00Z") - 1);
  });

  it("business days skip Thanksgiving; without holidays they do not", () => {
    // From Tue 11-24: Wed 25 = 1, Thu 26 holiday, Fri 27 = 2, Mon 30 = 3 → end of 11-30 EST = 12-01T05:00Z − 1 ms.
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-11-24")), cell("x.tz", "confirmed", NY)]);
    const fed = computeDeadline(spec({ offset: { amount: 3, unit: "business_days" }, holidays: "us_federal" }), c, 0);
    expect(fed).toMatchObject({ dueLocalDate: "2026-11-30", dueAt: T("2026-12-01T05:00:00Z") - 1 });
    const plain = computeDeadline(spec({ offset: { amount: 3, unit: "business_days" }, holidays: "none" }), c, 0);
    expect(plain.dueLocalDate).toBe("2026-11-27");
    const calendar = computeDeadline(spec({ offset: { amount: 3, unit: "calendar_days" } }), c, 0);
    expect(calendar.dueLocalDate).toBe("2026-11-27");
  });

  it("7 business days from Tue 2026-06-30 skip Friday 07-03 (Independence Day observed) → 07-10", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-06-30")), cell("x.tz", "confirmed", NY)]);
    expect(computeDeadline(spec({ offset: { amount: 7, unit: "business_days" }, holidays: "us_federal" }), c, 0).dueLocalDate).toBe("2026-07-10");
  });

  it("business days past the committed holiday table (2030) → beyond_calendar, no dueAt", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2030-12-20")), cell("x.tz", "confirmed", NY)]);
    const far = computeDeadline(spec({ offset: { amount: 10, unit: "business_days" }, holidays: "us_federal" }), c, 0);
    expect(far.status).toBe("beyond_calendar");
    expect(far.dueAt).toBeUndefined();
    const near = computeDeadline(spec({ offset: { amount: 2, unit: "business_days" }, holidays: "us_federal" }), c, 0);
    expect(near.dueLocalDate).toBe("2030-12-24");
  });

  it("a date before the committed 2007 DST rule → beyond_calendar", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2005-06-01")), cell("x.tz", "confirmed", NY)]);
    expect(computeDeadline(spec(), c, 0).status).toBe("beyond_calendar");
  });
});

describe("time zone unknown: earliest-ending US zone + assumption", () => {
  it("uses Guam (UTC+10, the first US zone to end 09-15) and says so", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-09-10"))]);
    const { result, assumptions } = computeDeadlineDetailed(spec({ offset: { amount: 5, unit: "calendar_days" } }), c, 0);
    // End of 2026-09-15 in Guam = 2026-09-15T14:00Z − 1 ms.
    expect(result).toMatchObject({ dueLocalDate: "2026-09-15", dueAt: T("2026-09-15T14:00:00Z") - 1, timeZone: "Pacific/Guam" });
    expect(assumptions.map((a) => a.id)).toEqual(["test.deadline.time_zone"]);
  });

  it("a known zone fact replaces the fallback (Chicago: 2026-09-16T05:00Z − 1 ms) and adds no assumption", () => {
    const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-09-10")), cell("x.tz", "confirmed", { kind: "code", code: "America/Chicago" })]);
    const { result, assumptions } = computeDeadlineDetailed(spec({ offset: { amount: 5, unit: "calendar_days" } }), c, 0);
    expect(result.dueAt).toBe(T("2026-09-16T05:00:00Z") - 1);
    expect(assumptions).toEqual([]);
  });
});

describe("unknown and disputed anchors (D143.3, D154): never a firm dueAt", () => {
  const r03 = spec({
    id: "r03.notice",
    offset: { amount: 60, unit: "calendar_days" },
    mustBe: "received",
    advisoryWhenAnchorUnknown: { fromFactKey: "card.posting_date", offsetDays: 60, label: "conservative act-by (not the legal deadline)" },
  });

  it("missing anchor → unknown_anchor; the advisory act-by is posting date + 60, never dueAt", () => {
    const c = lookupFrom([cell("card.posting_date", "confirmed", localDate("2026-09-10")), cell("x.tz", "confirmed", NY)]);
    const r = computeDeadline(r03, c, 0);
    expect(r.status).toBe("unknown_anchor");
    expect(r.dueAt).toBeUndefined();
    expect(r.advisoryActBy).toBe("2026-11-09");
    expect(r.basis).toContain("conservative act-by");
  });

  it("\"I don't know\" is an unknown anchor too; no advisory when the fallback fact is unknown", () => {
    const r = computeDeadline(r03, lookupFrom([cell("x.anchor", "user_unknown")]), 0);
    expect(r).toMatchObject({ status: "unknown_anchor" });
    expect(r.advisoryActBy).toBeUndefined();
  });

  it("user deadline, single unconfirmed candidate anchor → unknown_anchor, no dueAt, advisory from the candidate, labelled", () => {
    const c = lookupFrom([cell("x.anchor", "candidate", localDate("2026-09-01")), cell("x.tz", "confirmed", NY)]);
    const r = computeDeadline(spec({ offset: { amount: 30, unit: "calendar_days" } }), c, 0);
    expect(r.status).toBe("unknown_anchor");
    expect(r.dueAt).toBeUndefined();
    expect(r.advisoryActBy).toBe("2026-10-01"); // 09-01 + 30 days
    expect(r.basis).toContain("unconfirmed");
  });

  it("user deadline, conflicting anchor candidates → disputed_anchor, advisory = the EARLIEST candidate's due date", () => {
    const conflicting: EngineCell = {
      subjectKey: "txn", key: "x.anchor", status: "conflicting",
      conflict: { kind: "candidates", values: [
        { value: localDate("2026-09-08"), source: { kind: "evidence", ref: "order email" } },
        { value: localDate("2026-08-20"), source: { kind: "evidence", ref: "card statement" } },
      ] },
    };
    const r = computeDeadline(spec({ offset: { amount: 30, unit: "calendar_days" } }), lookupFrom([conflicting, cell("x.tz", "confirmed", NY)]), 0);
    expect(r.status).toBe("disputed_anchor");
    expect(r.dueAt).toBeUndefined();
    expect(r.advisoryActBy).toBe("2026-09-19"); // 08-20 + 30
    expect(r.basis).toContain("2026-09-08");
    expect(r.basis).toContain("card statement");
  });

  it("counterparty deadline, disputed anchor with every candidate past → no overdueSince, no escalate", () => {
    const conflicting: EngineCell = {
      subjectKey: "txn", key: "x.anchor", status: "conflicting",
      conflict: { kind: "candidates", values: [
        { value: localDate("2026-01-05"), source: { kind: "evidence" } },
        { value: localDate("2026-01-09"), source: { kind: "evidence" } },
      ] },
    };
    const r = computeDeadline(spec({ obligor: "counterparty" }), lookupFrom([conflicting, cell("x.tz", "confirmed", NY)]), T("2026-09-23T00:00:00Z"));
    expect(r.status).toBe("disputed_anchor");
    expect(r.overdueSince).toBeUndefined();
    expect(r.advisoryActBy).toBeUndefined();
    expect(overdueCounterpartyDeadlines([r])).toEqual([]);
  });
});

describe("obligor (DA-A-5): only user deadlines gate the path", () => {
  const carrier = spec({ id: "r02.refund_due", obligor: "counterparty", offset: { amount: 7, unit: "business_days" }, holidays: "us_federal" });
  // Anchor Mon 2026-09-14 → 7 business days: 15,16,17,18,21,22,23 → end of Wed 09-23 EDT = 09-24T04:00Z − 1 ms.
  const c = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-09-14")), cell("x.tz", "confirmed", NY)]);

  it("counterparty deadline + 1 day → overdue (overdueSince = dueAt), never passed; outcome unchanged; escalate", () => {
    const due = T("2026-09-24T04:00:00Z") - 1;
    const r = computeDeadline(carrier, c, due + 86_400_000);
    expect(r).toMatchObject({ status: "overdue", dueAt: due, overdueSince: due });
    // The user's path is untouched: the window dimension ignores counterparty deadlines…
    expect(userWindowOpen([r])).toBe("pass");
    const dims = { applies: "pass", factsKnown: "pass", evidenceSupports: "pass", windowOpen: userWindowOpen([r]), amountCalculable: "pass", readyForApproval: "pass" } as const;
    expect(deriveOutcome(dims, emptyFlags(), [])).toBe("eligible");
    // …and the escalation signal is the overdue counterparty deadline.
    expect(overdueCounterpartyDeadlines([r]).map((d) => d.id)).toEqual(["r02.refund_due"]);
    expect(nextUserDeadlineAt([r])).toBeUndefined();
    expect(nextCounterpartyDueAt([r])).toBe(due);
  });

  it("counterparty deadline with a confirmed anchor, before the due date → open", () => {
    expect(computeDeadline(carrier, c, T("2026-09-20T00:00:00Z")).status).toBe("open");
  });

  it("a user deadline that passed fails the window; an open one sets nextDeadlineAt", () => {
    const user = spec({ offset: { amount: 7, unit: "business_days" }, holidays: "us_federal" });
    const passed = computeDeadline(user, c, T("2026-09-25T00:00:00Z"));
    expect(passed.status).toBe("passed");
    expect(userWindowOpen([passed])).toBe("fail");
    const open = computeDeadline(user, c, T("2026-09-20T00:00:00Z"));
    expect(userWindowOpen([open])).toBe("pass");
    expect(nextUserDeadlineAt([open])).toBe(T("2026-09-24T04:00:00Z") - 1);
  });

  it("unknown payment class selects no timer and does not produce needs_facts (appliesWhen unknown)", () => {
    const creditCardTimer = spec({
      obligor: "counterparty",
      appliesWhen: {
        op: "fact", id: "paid_by_credit_card", label: "Paid by credit card", kind: "applicability",
        fact: { subjectKey: "txn", key: "air.payment_class" },
        test: (v) => v.kind === "code" && v.code === "credit_card",
      },
    });
    const r = computeDeadline(creditCardTimer, c, 0);
    expect(r.status).toBe("unknown_anchor");
    expect(r.dueAt).toBeUndefined();
    // The deadline engine returns no missing fact, and the counterparty timer never touches the window.
    expect(userWindowOpen([r])).toBe("pass");
    const paidDebit = lookupFrom([cell("x.anchor", "confirmed", localDate("2026-09-14")), cell("x.tz", "confirmed", NY), cell("air.payment_class", "confirmed", { kind: "code", code: "debit_card" })]);
    expect(computeDeadline(creditCardTimer, paidDebit, 0).status).toBe("not_applicable");
  });
});

describe("late ask acknowledgeable (rev 5 C1)", () => {
  const ack = new Set(["r01.v1.window"]);
  const passedWindow = { id: "r01.v1.window", obligor: "user" as const, status: "passed" as const };

  it("deadline_passed whose only failing item is the acknowledgeable window → true", () => {
    expect(isLateAskAcknowledgeable({
      outcome: "deadline_passed", deadlines: [passedWindow],
      conditions: [{ id: "r01.v1.window", result: "fail", kind: "timing" }, { id: "drop", result: "pass", kind: "applicability" }],
    }, ack)).toBe(true);
  });

  it("any other failing condition or passed deadline → false", () => {
    expect(isLateAskAcknowledgeable({
      outcome: "deadline_passed", deadlines: [passedWindow, { id: "other", obligor: "user", status: "passed" }],
      conditions: [],
    }, ack)).toBe(false);
    expect(isLateAskAcknowledgeable({
      outcome: "deadline_passed", deadlines: [passedWindow],
      conditions: [{ id: "drop", result: "fail", kind: "applicability" }],
    }, ack)).toBe(false);
    expect(isLateAskAcknowledgeable({ outcome: "not_eligible", deadlines: [passedWindow], conditions: [] }, ack)).toBe(false);
  });
});
