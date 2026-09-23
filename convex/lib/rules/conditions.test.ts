/** Decisive-missing combinator (DA-A-24): only facts whose value could flip the result are listed. */
import { describe, expect, it } from "vitest";
import { evaluateConditions } from "./conditions";
import { lookupFrom, type ConditionNode, type EngineCell, type FactCondition, type FactValue } from "./types";

const yes: FactValue = { kind: "bool", value: true };
const no: FactValue = { kind: "bool", value: false };
const c = (key: string, status: EngineCell["status"], value?: FactValue): EngineCell => ({
  subjectKey: "txn", key, status, ...(value !== undefined ? { value } : {}),
});
const leaf = (key: string, extra: Partial<FactCondition> = {}): FactCondition => ({
  op: "fact", id: key, label: key, kind: "applicability", fact: { subjectKey: "txn", key },
  test: (v) => v.kind === "bool" && v.value, ...extra,
});

describe("evaluateConditions", () => {
  it("an `any` group already passed lists nothing (a confirmed 4-hour change needs no disability question)", () => {
    const tree: ConditionNode = {
      op: "any",
      children: [leaf("air.change_over_3h"), leaf("air.disability_relevant", { sensitive: true })],
    };
    const r = evaluateConditions(tree, lookupFrom([c("air.change_over_3h", "confirmed", yes)]));
    expect(r.result).toBe("pass");
    expect(r.decisiveMissing).toEqual([]);
  });

  it("an `any` group still open lists the unknowns (a sensitive key only when decisive)", () => {
    const tree: ConditionNode = {
      op: "any",
      children: [leaf("air.change_over_3h"), leaf("air.disability_relevant", { sensitive: true })],
    };
    const r = evaluateConditions(tree, lookupFrom([c("air.change_over_3h", "confirmed", no)]));
    expect(r.result).toBe("unknown");
    expect(r.decisiveMissing.map((m) => [m.key, m.reason])).toEqual([["air.disability_relevant", "missing"]]);
  });

  it("an `all` group that already failed lists nothing", () => {
    const tree: ConditionNode = { op: "all", children: [leaf("a"), leaf("b"), leaf("c")] };
    const r = evaluateConditions(tree, lookupFrom([c("a", "confirmed", no)]));
    expect(r.result).toBe("fail");
    expect(r.decisiveMissing).toEqual([]);
  });

  it("an open `all` group lists every unknown child with its own reason (DA-A-1: user_unknown stays user_unknown)", () => {
    const tree: ConditionNode = { op: "all", children: [leaf("a"), leaf("b"), leaf("c")] };
    const r = evaluateConditions(tree, lookupFrom([c("a", "confirmed", yes), c("b", "user_unknown"), { ...c("c", "conflicting"), conflict: { kind: "candidates", values: [] } }]));
    expect(r.result).toBe("unknown");
    expect(r.decisiveMissing.map((m) => [m.key, m.reason])).toEqual([["b", "user_unknown"], ["c", "conflicting"]]);
  });

  it("`not` swaps pass and fail; nested groups use the same flip test", () => {
    const tree: ConditionNode = {
      op: "all",
      children: [{ op: "not", child: leaf("excluded") }, { op: "any", children: [leaf("x"), leaf("y")] }],
    };
    const r = evaluateConditions(tree, lookupFrom([c("excluded", "confirmed", no), c("x", "confirmed", yes)]));
    expect(r.result).toBe("pass");
    const r2 = evaluateConditions(tree, lookupFrom([c("x", "confirmed", yes)]));
    expect(r2.result).toBe("unknown");
    expect(r2.decisiveMissing.map((m) => m.key)).toEqual(["excluded"]);
  });

  it("a decisive candidate is usable but listed as candidate_unconfirmed (D147(2)); a non-decisive one is not", () => {
    const tree: ConditionNode = { op: "all", children: [leaf("a"), leaf("b")] };
    const r = evaluateConditions(tree, lookupFrom([c("a", "candidate", yes), c("b", "confirmed", yes)]));
    expect(r.result).toBe("pass");
    expect(r.decisiveUnconfirmed.map((m) => [m.key, m.reason])).toEqual([["a", "candidate_unconfirmed"]]);
    const anyTree: ConditionNode = { op: "any", children: [leaf("a"), leaf("b")] };
    expect(evaluateConditions(anyTree, lookupFrom([c("a", "candidate", yes), c("b", "confirmed", yes)])).decisiveUnconfirmed).toEqual([]);
  });

  it("E3 (D243): a fail that rests only on a candidate is unknown (candidate_unconfirmed); a fail on confirmed facts stays", () => {
    const tree: ConditionNode = { op: "all", children: [leaf("a"), leaf("b")] };
    const r = evaluateConditions(tree, lookupFrom([c("a", "candidate", no), c("b", "confirmed", yes)]));
    expect(r.result).toBe("unknown");
    expect(r.decisiveUnconfirmed.map((m) => [m.key, m.reason])).toEqual([["a", "candidate_unconfirmed"]]);
    // A confirmed fail decides regardless of a candidate elsewhere.
    expect(evaluateConditions(tree, lookupFrom([c("a", "candidate", yes), c("b", "confirmed", no)])).result).toBe("fail");
    // Under `not`, a candidate pass that makes the tree fail is caught the same way.
    const notTree: ConditionNode = { op: "not", child: leaf("a") };
    expect(evaluateConditions(notTree, lookupFrom([c("a", "candidate", yes)])).result).toBe("unknown");
    expect(evaluateConditions(notTree, lookupFrom([c("a", "confirmed", yes)])).result).toBe("fail");
  });

  it("an assumption-class leaf that cannot be read is assumed (DA-A-2): the tree passes, nothing is missing", () => {
    const tree: ConditionNode = { op: "all", children: [leaf("a"), leaf("policy_ok", { class: "assumption" })] };
    const r = evaluateConditions(tree, lookupFrom([c("a", "confirmed", yes)]));
    expect(r.result).toBe("pass");
    expect(r.decisiveMissing).toEqual([]);
    expect(r.assumed.map((l) => l.id)).toEqual(["policy_ok"]);
    expect(r.conditions.find((x) => x.id === "policy_ok")?.result).toBe("unknown");
  });

  it("computed leaves carry their own unknown facts and de-duplicate by (subject, key)", () => {
    const tree: ConditionNode = {
      op: "all",
      children: [
        { op: "computed", id: "drop", label: "drop", kind: "requirement", result: "unknown", facts: [{ subjectKey: "item:1", key: "retail.unit_price" }], unknownFacts: [{ fact: { subjectKey: "item:1", key: "retail.unit_price" }, reason: "missing" }], neededFor: ["amount"] },
        { op: "computed", id: "claimed", label: "claimed", kind: "requirement", result: "unknown", facts: [], unknownFacts: [{ fact: { subjectKey: "item:1", key: "retail.unit_price" }, reason: "missing" }], neededFor: ["threshold"] },
      ],
    };
    const r = evaluateConditions(tree, lookupFrom([]));
    expect(r.decisiveMissing).toEqual([
      { subjectKey: "item:1", key: "retail.unit_price", reason: "missing", class: "required", neededFor: ["amount", "threshold"] },
    ]);
  });
});
