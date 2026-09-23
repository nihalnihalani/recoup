/**
 * Tri-state condition trees and the DECISIVE-missing rule (contract §4, DA-A-24). Pure.
 *
 * `all` fails as soon as one child fails and passes only when every child passes; `any` passes as soon as one
 * child passes and fails only when every child fails; `not` swaps pass/fail. Anything else is `unknown`.
 *
 * A fact is listed as missing ONLY when it is decisive: flipping the leaf that reads it between pass and fail —
 * with every other leaf held where it is — changes the root result. So an `any` group that already passed lists
 * nothing, an `all` group that already failed lists nothing, and a sensitive key is asked only when its answer can
 * matter. The same test marks decisive facts that were used only as unconfirmed candidates (D147(2)): they are
 * listed with reason `candidate_unconfirmed` (the "capped" class, D161).
 *
 * An assumption-class fact leaf that cannot be read is ASSUMED to hold (DA-A-2): it never makes the tree unknown and
 * is returned in `assumed`, so the pack adds its Assumption instead of a missing fact.
 */
import {
  isUsable,
  type CellLookup,
  type ConditionLeaf,
  type ConditionNode,
  type ConditionResult,
  type FactCondition,
  type FactRef,
  type MissingFact,
  type MissingReason,
  type Tri,
  unresolvedReason,
} from "./types";

export interface ConditionEvaluation {
  result: Tri;
  /** One row per leaf, in tree order. */
  conditions: ConditionResult[];
  /** Decisive unresolved facts (reasons missing / user_unknown / conflicting). */
  decisiveMissing: MissingFact[];
  /** Decisive facts that were used only as unconfirmed candidates (reason candidate_unconfirmed). */
  decisiveUnconfirmed: MissingFact[];
  /** Assumption-class leaves whose fact could not be read and were assumed to hold. */
  assumed: FactCondition[];
}

interface LeafState {
  leaf: ConditionLeaf;
  /** The result the tree uses (an assumed leaf passes). */
  result: Tri;
  /** The result shown for the condition (an assumed leaf shows unknown). */
  shown: Tri;
  unresolved: { fact: FactRef; reason: MissingReason }[];
  candidates: FactRef[];
  assumed: boolean;
}

function leaves(node: ConditionNode, out: ConditionLeaf[] = []): ConditionLeaf[] {
  switch (node.op) {
    case "all":
    case "any":
      for (const c of node.children) leaves(c, out);
      return out;
    case "not":
      return leaves(node.child, out);
    default:
      out.push(node);
      return out;
  }
}

function leafState(leaf: ConditionLeaf, cells: CellLookup): LeafState {
  if (leaf.op === "computed") {
    return {
      leaf,
      result: leaf.result,
      shown: leaf.result,
      unresolved: leaf.result === "unknown" ? [...(leaf.unknownFacts ?? [])] : [],
      candidates: [...(leaf.candidateFacts ?? [])],
      assumed: false,
    };
  }
  const cell = cells(leaf.fact.subjectKey, leaf.fact.key);
  if (isUsable(cell)) {
    const result: Tri = leaf.test(cell.value!) ? "pass" : "fail";
    return {
      leaf, result, shown: result, unresolved: [],
      candidates: cell.status === "candidate" ? [leaf.fact] : [], assumed: false,
    };
  }
  if (leaf.class === "assumption") {
    return { leaf, result: "pass", shown: "unknown", unresolved: [], candidates: [], assumed: true };
  }
  return {
    leaf, result: "unknown", shown: "unknown",
    unresolved: [{ fact: leaf.fact, reason: unresolvedReason(cell) }], candidates: [], assumed: false,
  };
}

function combine(op: "all" | "any", results: Tri[]): Tri {
  if (op === "all") {
    if (results.includes("fail")) return "fail";
    return results.every((r) => r === "pass") ? "pass" : "unknown";
  }
  if (results.includes("pass")) return "pass";
  return results.every((r) => r === "fail") ? "fail" : "unknown";
}

function evalNode(node: ConditionNode, resultOf: (leaf: ConditionLeaf) => Tri): Tri {
  switch (node.op) {
    case "all":
    case "any":
      return combine(node.op, node.children.map((c) => evalNode(c, resultOf)));
    case "not": {
      const r = evalNode(node.child, resultOf);
      return r === "pass" ? "fail" : r === "fail" ? "pass" : "unknown";
    }
    default:
      return resultOf(node);
  }
}

/** True when forcing `leaf` to pass vs to fail gives different root results. */
function isDecisive(tree: ConditionNode, states: Map<ConditionLeaf, LeafState>, leaf: ConditionLeaf): boolean {
  const forced = (value: Tri) => evalNode(tree, (l) => (l === leaf ? value : states.get(l)!.result));
  return forced("pass") !== forced("fail");
}

function factFacts(leaf: ConditionLeaf): FactRef[] {
  return leaf.op === "fact" ? [leaf.fact] : [...leaf.facts];
}

/** Adds a missing fact, de-duplicated by (subjectKey, key); `neededFor` is merged. */
export function addMissing(list: MissingFact[], entry: MissingFact): void {
  const hit = list.find((m) => m.subjectKey === entry.subjectKey && m.key === entry.key);
  if (!hit) {
    list.push({ ...entry, neededFor: [...entry.neededFor] });
    return;
  }
  for (const n of entry.neededFor) if (!hit.neededFor.includes(n)) hit.neededFor.push(n);
}

export function evaluateConditions(tree: ConditionNode, cells: CellLookup): ConditionEvaluation {
  const all = leaves(tree);
  const states = new Map<ConditionLeaf, LeafState>();
  for (const leaf of all) states.set(leaf, leafState(leaf, cells));
  let result = evalNode(tree, (l) => states.get(l)!.result);
  // E3 (D234(1), D243): a negative result never rests on an unconfirmed candidate. When treating every
  // candidate-resting leaf as unknown would no longer give "fail", the answer is "unknown" — the candidates are then
  // decisive and listed as `candidate_unconfirmed`, so the user confirms them before any "not eligible".
  if (result === "fail" && all.some((l) => states.get(l)!.candidates.length > 0)) {
    const withoutCandidates = evalNode(tree, (l) => (states.get(l)!.candidates.length > 0 ? "unknown" : states.get(l)!.result));
    if (withoutCandidates !== "fail") result = "unknown";
  }

  const decisiveMissing: MissingFact[] = [];
  const decisiveUnconfirmed: MissingFact[] = [];
  for (const leaf of all) {
    const s = states.get(leaf)!;
    const needsTest = s.unresolved.length > 0 || s.candidates.length > 0;
    if (!needsTest || !isDecisive(tree, states, leaf)) continue;
    const neededFor = [...(leaf.neededFor ?? [leaf.id])];
    for (const u of s.unresolved) {
      addMissing(decisiveMissing, { subjectKey: u.fact.subjectKey, key: u.fact.key, reason: u.reason, class: "required", neededFor });
    }
    for (const f of s.candidates) {
      addMissing(decisiveUnconfirmed, {
        subjectKey: f.subjectKey, key: f.key, reason: "candidate_unconfirmed", class: "required", neededFor,
      });
    }
  }

  const conditions: ConditionResult[] = all.map((leaf) => {
    const s = states.get(leaf)!;
    const note = s.assumed ? `assumed (${leaf.label})` : leaf.note;
    return {
      id: leaf.id,
      label: leaf.label,
      result: s.shown,
      kind: leaf.kind,
      facts: factFacts(leaf),
      ...(leaf.sourcePassageId !== undefined ? { sourcePassageId: leaf.sourcePassageId } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  });

  const assumed = all.filter((l): l is FactCondition => l.op === "fact" && states.get(l)!.assumed);
  return { result, conditions, decisiveMissing, decisiveUnconfirmed, assumed };
}
