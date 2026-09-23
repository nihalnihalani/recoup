/**
 * `deriveOutcome` precedence (contract rev 5.5 §4): every row, every adjacent pair, the DA-A-2 assumption-only row,
 * rule 4b `not_yet_due` (D147(6)), rules 5a/5b/5c (D152/D154/D158), and an exhaustive sweep over all 3^6 dimension
 * combinations × flag sets asserting the invariants the table implies. Expected outcomes are written by hand.
 */
import { describe, expect, it } from "vitest";
import {
  candidateCombinations,
  capAtLikelyEligible,
  decidingRule,
  deriveOutcome,
  leavesApprovableSet,
  notYetDueAction,
  resultHash,
  resultHashInput,
  sameAnswer,
  sourceStale,
  withSameAnswer,
} from "./outcome";
import { APPROVABLE_OUTCOMES, emptyFlags, type Assumption, type ConflictFlag, type Dimensions, type EvaluationResult, type Flags, type Tri } from "./types";

const ALL_PASS: Dimensions = { applies: "pass", factsKnown: "pass", evidenceSupports: "pass", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "pass" };
const d = (over: Partial<Dimensions> = {}): Dimensions => ({ ...ALL_PASS, ...over });
const f = (over: Partial<Flags> = {}): Flags => ({ ...emptyFlags(), ...over });
const A: Assumption = { id: "A-T1", text: "policy retrieved within a week", changesOutcomeIf: "the policy changed" };
const conflict = (kind: ConflictFlag["kind"], same: boolean, key = "k"): ConflictFlag => ({
  key, subjectKey: "txn", kind, sameAnswer: same, values: [{ value: "a", source: "email" }, { value: "b", source: "statement" }],
});

describe("deriveOutcome: each precedence row", () => {
  it.each([
    ["1 unsupported", d(), f({ unsupportedReason: "debit card" }), [], "unsupported"],
    ["2 stale source", d(), f({ sourceStale: true }), [], "source_unverified"],
    ["2 missing source (README rule 8)", d(), f({ sourceMissing: true }), [], "source_unverified"],
    ["2 effective-date mismatch", d(), f({ effectiveDateMismatch: true }), [], "source_unverified"],
    ["3 applies fail", d({ applies: "fail" }), f(), [], "not_eligible"],
    ["4 user window closed", d({ windowOpen: "fail" }), f(), [], "deadline_passed"],
    ["4b not yet due", d(), f({ notYetDue: { at: "2026-10-11" } }), [], "not_yet_due"],
    ["5a manual review reason", d(), f({ manualReviewReason: "renumbered only" }), [], "manual_review"],
    ["5a confirmed vs observed", d(), f({ conflicts: [conflict("confirmed_vs_observed", true)] }), [], "manual_review"],
    ["5a confirmed vs confirmed", d(), f({ conflicts: [conflict("confirmed_vs_confirmed", true)] }), [], "manual_review"],
    ["5b candidates disagree", d(), f({ conflicts: [conflict("candidates", false)] }), [], "needs_facts"],
    ["5c same-answer candidates → capped", d(), f({ conflicts: [conflict("candidates", true)] }), [], "likely_eligible"],
    ["6 applies unknown", d({ applies: "unknown" }), f(), [], "needs_facts"],
    ["6 required fact unknown", d({ factsKnown: "unknown" }), f(), [], "needs_facts"],
    ["6 factsKnown 'fail' fails closed (never eligible)", d({ factsKnown: "fail" }), f(), [], "needs_facts"],
    ["7 inexact contract coverage", d(), f({ contractCoverageInexact: true }), [], "possible_contract_benefit"],
    ["8 evidence not confirmed (D147(2))", d({ evidenceSupports: "unknown" }), f(), [], "likely_eligible"],
    ["8 DA-A-2: only assumption-class unknowns → likely_eligible", d(), f(), [A], "likely_eligible"],
    ["9 eligible", d(), f(), [], "eligible"],
  ] as const)("%s", (_name, dims, flags, assumptions, expected) => {
    expect(deriveOutcome(dims, flags, assumptions as readonly Assumption[])).toBe(expected);
  });
});

describe("deriveOutcome: adjacent rows (the higher row wins)", () => {
  it("1 > 2 > 3 > 4", () => {
    expect(deriveOutcome(d({ applies: "fail", windowOpen: "fail" }), f({ unsupportedReason: "x", sourceStale: true }), [])).toBe("unsupported");
    expect(deriveOutcome(d({ applies: "fail", windowOpen: "fail" }), f({ sourceStale: true }), [])).toBe("source_unverified");
    expect(deriveOutcome(d({ applies: "fail", windowOpen: "fail" }), f(), [])).toBe("not_eligible");
  });

  it("D147(6): flags.notYetDue → not_yet_due; never not_eligible", () => {
    const o = deriveOutcome(d(), f({ notYetDue: { when: "MBR filed" } }), []);
    expect(o).toBe("not_yet_due");
    expect(o).not.toBe("not_eligible");
  });

  it("D147(6): applies fail + notYetDue → not_eligible (rule 3 wins)", () => {
    expect(deriveOutcome(d({ applies: "fail" }), f({ notYetDue: { at: "2026-10-11" } }), [])).toBe("not_eligible");
  });

  it("D147(6): user deadline passed + notYetDue → deadline_passed (rule 4 wins)", () => {
    expect(deriveOutcome(d({ windowOpen: "fail" }), f({ notYetDue: { at: "2026-10-11" } }), [])).toBe("deadline_passed");
  });

  it("D147(6): notYetDue + conflicting/missing facts → not_yet_due (4b above 5 and 6)", () => {
    expect(deriveOutcome(d({ factsKnown: "unknown" }), f({ notYetDue: { at: "2026-10-11" }, conflicts: [conflict("candidates", false)] }), [])).toBe("not_yet_due");
    expect(deriveOutcome(d(), f({ notYetDue: { at: "2026-10-11" }, conflicts: [conflict("confirmed_vs_observed", false)] }), [])).toBe("not_yet_due");
  });

  it("D147(6): an unknown ripeness fact → needs_facts, not not_yet_due (no flag is set from an unknown fact)", () => {
    expect(deriveOutcome(d({ factsKnown: "unknown" }), f(), [])).toBe("needs_facts");
  });

  it("D158: a candidates conflict plus a confirmed_vs_observed conflict → manual_review (5a wins)", () => {
    expect(deriveOutcome(d(), f({ conflicts: [conflict("candidates", false, "a"), conflict("confirmed_vs_observed", true, "b")] }), [])).toBe("manual_review");
  });

  it("5b beats 6: a diverging conflict is needs_facts even when every other fact is known", () => {
    expect(deriveOutcome(d(), f({ conflicts: [conflict("candidates", false)] }), [])).toBe("needs_facts");
  });

  it("5c caps only an eligible answer; a lower answer stands", () => {
    expect(deriveOutcome(d(), f({ conflicts: [conflict("candidates", true)] }), [])).toBe("likely_eligible");
    expect(deriveOutcome(d({ factsKnown: "unknown" }), f({ conflicts: [conflict("candidates", true)] }), [])).toBe("needs_facts");
    expect(deriveOutcome(d(), f({ contractCoverageInexact: true, conflicts: [conflict("candidates", true)] }), [])).toBe("possible_contract_benefit");
    expect(capAtLikelyEligible("eligible")).toBe("likely_eligible");
    expect(capAtLikelyEligible("manual_review")).toBe("manual_review");
  });

  it("D154 (3): confirming the value lifts the cap (no conflict left → eligible)", () => {
    expect(deriveOutcome(d(), f({ conflicts: [conflict("candidates", true)] }), [])).toBe("likely_eligible");
    expect(deriveOutcome(d(), f({ conflicts: [] }), [])).toBe("eligible");
  });

  it("6 > 7 > 8", () => {
    expect(deriveOutcome(d({ factsKnown: "unknown", evidenceSupports: "unknown" }), f({ contractCoverageInexact: true }), [A])).toBe("needs_facts");
    expect(deriveOutcome(d({ evidenceSupports: "unknown" }), f({ contractCoverageInexact: true }), [A])).toBe("possible_contract_benefit");
  });

  it("windowOpen unknown (e.g. beyond_calendar) is not needs_facts by itself, and never eligible → likely_eligible", () => {
    expect(deriveOutcome(d({ windowOpen: "unknown" }), f(), [])).toBe("likely_eligible");
  });

  it("decidingRule names the row", () => {
    expect(decidingRule(d(), f({ notYetDue: { at: "x" } }), [])).toBe("4b");
    expect(decidingRule(d(), f({ conflicts: [conflict("candidates", true)] }), [A])).toBe("5c/8");
    expect(decidingRule(d(), f(), [])).toBe("9");
  });
});

describe("deriveOutcome: exhaustive sweep over every dimension combination", () => {
  const tris: Tri[] = ["pass", "fail", "unknown"];
  const dimsAll: Dimensions[] = [];
  for (const a of tris) for (const k of tris) for (const e of tris) for (const w of tris) for (const m of tris) for (const r of tris) {
    dimsAll.push({ applies: a, factsKnown: k, evidenceSupports: e, windowOpen: w, amountCalculable: m, readyForApproval: r });
  }
  const flagSets: Flags[] = [
    f(), f({ unsupportedReason: "x" }), f({ sourceStale: true }), f({ sourceMissing: true }), f({ notYetDue: { at: "2026-10-11" } }),
    f({ manualReviewReason: "x" }), f({ conflicts: [conflict("candidates", false)] }), f({ conflicts: [conflict("candidates", true)] }),
    f({ conflicts: [conflict("confirmed_vs_observed", true)] }), f({ contractCoverageInexact: true }),
  ];

  it("holds the table's invariants for 729 × 10 × 2 inputs", () => {
    let n = 0;
    for (const dims of dimsAll) for (const flags of flagSets) for (const as of [[], [A]] as Assumption[][]) {
      const o = deriveOutcome(dims, flags, as);
      n++;
      if (flags.unsupportedReason) { expect(o).toBe("unsupported"); continue; }
      if (flags.sourceStale || flags.sourceMissing) { expect(o).toBe("source_unverified"); continue; }
      if (dims.applies === "fail") { expect(o).toBe("not_eligible"); continue; }
      expect(o).not.toBe("not_eligible"); // not_eligible only from a failed applicability (known facts)
      if (dims.windowOpen === "fail") { expect(o).toBe("deadline_passed"); continue; }
      if (flags.notYetDue) { expect(o).toBe("not_yet_due"); continue; }
      expect(o).not.toBe("not_yet_due");
      // eligible needs every gate green, no assumption, no conflict, no inexact coverage.
      if (o === "eligible") {
        expect(dims.applies).toBe("pass");
        expect(dims.factsKnown).toBe("pass");
        expect(dims.evidenceSupports).toBe("pass");
        expect(dims.windowOpen).toBe("pass");
        expect(as).toHaveLength(0);
        expect(flags.conflicts).toHaveLength(0);
        expect(flags.contractCoverageInexact).toBeFalsy();
      }
      // A capped (5c) or diverging (5b) conflict never yields eligible.
      if (flags.conflicts.length > 0) expect(o).not.toBe("eligible");
      // needs_facts only from an unknown required fact or a diverging candidates conflict.
      if (o === "needs_facts") {
        expect(dims.applies === "unknown" || dims.factsKnown !== "pass" || flags.conflicts.some((c) => !c.sameAnswer)).toBe(true);
      }
      // Only amountCalculable/readyForApproval never decide the outcome.
      const same = deriveOutcome({ ...dims, amountCalculable: "fail", readyForApproval: "fail" }, flags, as);
      expect(same).toBe(o);
    }
    expect(n).toBe(729 * 10 * 2);
  });
});

describe("candidate testing helpers (D154/D158: same outcome AND same amount)", () => {
  const amt = (n: number, c = "USD") => ({ estimate: { amountMinor: n, currency: c } });
  it("same outcome and amount → same answer; a different amount or currency → not", () => {
    expect(sameAnswer([{ outcome: "likely_eligible", amount: amt(5000) }, { outcome: "likely_eligible", amount: amt(5000) }])).toBe(true);
    expect(sameAnswer([{ outcome: "likely_eligible", amount: amt(5000) }, { outcome: "likely_eligible", amount: amt(4000) }])).toBe(false);
    expect(sameAnswer([{ outcome: "likely_eligible", amount: amt(5000) }, { outcome: "likely_eligible", amount: amt(5000, "GBP") }])).toBe(false);
    expect(sameAnswer([{ outcome: "not_eligible", amount: null }, { outcome: "not_eligible", amount: null }])).toBe(true);
    expect(sameAnswer([{ outcome: "not_eligible", amount: null }, { outcome: "likely_eligible", amount: null }])).toBe(false);
  });

  it("same outcome, different amount → needs_facts (5b)", () => {
    const same = sameAnswer([{ outcome: "likely_eligible", amount: amt(5000) }, { outcome: "likely_eligible", amount: amt(7999) }]);
    const flags = f({ conflicts: withSameAnswer([{ key: "k", subjectKey: "txn", kind: "candidates", values: [] }], same) });
    expect(deriveOutcome(d(), flags, [A])).toBe("needs_facts");
  });

  it("withSameAnswer never marks a confirmed conflict as same-answer", () => {
    expect(withSameAnswer([{ key: "k", subjectKey: "txn", kind: "confirmed_vs_observed", values: [] }], true)[0].sameAnswer).toBe(false);
  });

  it("combinations are the cartesian product, bounded at 16", () => {
    expect(candidateCombinations<number | string>([[1, 2], ["a", "b"]])).toEqual([[1, "a"], [1, "b"], [2, "a"], [2, "b"]]);
    expect(candidateCombinations([[1, 2, 3, 4, 5], [1, 2, 3, 4]])).toBeNull();
  });
});

describe("next action for not_yet_due (D154)", () => {
  it("notYetDue with a userAction → nextAction is that action (R04-03b → add_evidence baggage_report)", () => {
    expect(notYetDueAction({ when: "MBR filed", userAction: { kind: "add_evidence", docTypes: ["baggage_report"] } }))
      .toEqual({ kind: "add_evidence", docTypes: ["baggage_report"] });
  });
  it("notYetDue without one → nextAction wait (R05-04c)", () => {
    expect(notYetDueAction({ at: "2026-10-11" })).toEqual({ kind: "wait", reevaluate: { at: "2026-10-11" } });
  });
});

describe("source freshness (README rule 3)", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");
  const src = { sourceId: "ecfr-260", passageId: "P-1", url: "https://example.gov", effective: "2024-10-28", refreshWindowDays: 30 };
  it("within the window → fresh; past it or never verified → stale; no window → never stale", () => {
    expect(sourceStale([src], { "ecfr-260": { lastVerifiedAt: "2026-09-01" } }, now).stale).toBe(false);
    expect(sourceStale([src], { "ecfr-260": { lastVerifiedAt: "2026-08-01" } }, now)).toEqual({ stale: true, staleSourceIds: ["ecfr-260"] });
    expect(sourceStale([src], {}, now).stale).toBe(true);
    expect(sourceStale([{ ...src, refreshWindowDays: undefined }], {}, now).stale).toBe(false);
  });

  it("D234 E5: from the manifest's mandatoryReviewBy date on, stale until a verification dated on or after it", () => {
    const pause = { ...src, mandatoryReviewBy: "2027-07-07" };
    const fresh = { "ecfr-260": { lastVerifiedAt: "2027-07-01" } };
    expect(sourceStale([pause], fresh, Date.parse("2027-07-06T23:59:59Z")).stale).toBe(false);
    expect(sourceStale([pause], fresh, Date.parse("2027-07-07T00:00:00Z"))).toEqual({ stale: true, staleSourceIds: ["ecfr-260"] });
    expect(sourceStale([pause], { "ecfr-260": { lastVerifiedAt: "2027-07-07" } }, Date.parse("2027-07-10T00:00:00Z")).stale).toBe(false);
    // With no refresh window the review date still applies; an unreadable date is stale (fails closed).
    expect(sourceStale([{ ...pause, refreshWindowDays: undefined }], {}, Date.parse("2027-08-01T00:00:00Z")).stale).toBe(true);
    expect(sourceStale([{ ...pause, mandatoryReviewBy: "July 2027" }], fresh, Date.parse("2027-07-02T00:00:00Z")).stale).toBe(true);
  });
});

describe("approvable set and resultHash (DA-A-32, N6)", () => {
  it("APPROVABLE_OUTCOMES is exactly eligible, likely_eligible, possible_contract_benefit (not_yet_due excluded)", () => {
    expect([...APPROVABLE_OUTCOMES].sort()).toEqual(["eligible", "likely_eligible", "possible_contract_benefit"]);
    expect(leavesApprovableSet("likely_eligible", "not_yet_due")).toBe(true);
    expect(leavesApprovableSet("likely_eligible", "eligible")).toBe(false);
  });

  const base: EvaluationResult = {
    scenarioId: "R01", ruleId: "R01.retail_price_adjustment", ruleVersion: 1, engineVersion: "engine-w1", remedyKey: "price_difference",
    subjectKey: "item:1", snapshotHash: "s1", outcome: "likely_eligible", dimensions: ALL_PASS,
    conditions: [{ id: "drop", label: "drop", result: "pass", kind: "requirement", facts: [] }], missingFacts: [], assumptions: [A],
    disqualifierIds: [], amount: { estimate: { amountMinor: 5000, currency: "USD" }, basis: "exact_formula", formula: "x", inputs: [] },
    deadlines: [], sourceRefs: [], lossKeys: ["item:1:price_diff:1"], overlap: [], nextAction: { kind: "open_case" },
    explanation: ["one"], flags: emptyFlags(), boundFacts: [],
  };

  it("ignores the snapshot hash, labels and explanations; changes with the amount and the bound-facts hash", async () => {
    const h = await resultHash(base, "b1");
    expect(await resultHash({ ...base, snapshotHash: "s2", explanation: ["two"], conditions: [{ ...base.conditions[0], label: "other" }] }, "b1")).toBe(h);
    expect(await resultHash({ ...base, amount: { ...base.amount!, estimate: { amountMinor: 4000, currency: "USD" } } }, "b1")).not.toBe(h);
    expect(await resultHash(base, "b2")).not.toBe(h);
  });

  it("D234 E2: amount.cap joins the hash only when present — no cap keeps today's hash; a cap or a changed cap changes it", async () => {
    const { canonicalHash } = await import("../canonical");
    // Today's hash (the pre-E2 projection, computed by hand) is unchanged for every capless result.
    const input = resultHashInput(base, "b1");
    expect(input.amount).toEqual({ estimate: base.amount!.estimate, basis: "exact_formula" });
    expect(await resultHash(base, "b1")).toBe(await canonicalHash(input));
    const capped = { ...base, amount: { ...base.amount!, cap: { amount: { amountMinor: 470_000, currency: "USD" }, sourcePassageId: "P-254.4", note: "limit" } } };
    const h = await resultHash(capped, "b1");
    expect(h).not.toBe(await resultHash(base, "b1"));
    expect(await resultHash({ ...capped, amount: { ...capped.amount, cap: { ...capped.amount.cap, note: "other words" } } }, "b1")).toBe(h);
    expect(await resultHash({ ...capped, amount: { ...capped.amount, cap: { ...capped.amount.cap, amount: { amountMinor: 380_000, currency: "USD" } } } }, "b1")).not.toBe(h);
  });
});
