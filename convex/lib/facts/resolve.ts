/**
 * Fact-cell resolution (contract §2.5 as fixed by DA-A-1, D147(2) and D152). Pure: no ctx, clock or randomness.
 *
 * A cell is (transactionId, subjectKey, key). Resolution runs over the cell's CURRENT rows (state ∉ {superseded,
 * rejected}); U is the newest current `user_confirmed` row.
 *
 *   1. U exists and says something (value ≠ user_unknown):
 *        another current confirmed value disagrees            → conflicting / confirmed_vs_confirmed
 *        the newest current observation disagrees and U does
 *        not carry `overridesObserved`                        → conflicting / confirmed_vs_observed
 *        otherwise                                            → confirmed
 *   2. a current observed row (newest wins)                   → observed
 *   3. a current derived row (newest wins)                    → derived
 *   4. U exists (it can only be "I don't know" here)          → user_unknown, hinting the newest LATER candidate
 *   5. candidates: all agree → candidate; otherwise           → conflicting / candidates
 *   6. nothing                                                → missing
 *
 * Only confirmed | observed | derived are KNOWN. A candidate is never known: it carries `capsOutcomeAt:
 * "likely_eligible"` (D147(2)) so an evaluator may use the value but can never reach `eligible` on it. `missing` and
 * `conflicting` are computed here and never stored. A known cell is built only through `knownCell`, which throws on a
 * `user_unknown` value, so "I don't know" can never be read as a value (DA-A-1).
 *
 * "Newest" = the largest `at`; equal `at` → the later row in the input (callers pass rows in creation order).
 */
import type { Infer } from "convex/values";
import type { cellStatus, factRowState } from "../../schema";
import { getFactSpec, type FactKey, type FactValue, type KnownValue, type ValueFor } from "./catalog";
import { sameFactValue } from "./values";

export type CellStatus = Infer<typeof cellStatus>;
export type FactRowState = Infer<typeof factRowState>;

/**
 * Where a row came from, for display and for the conflict explanation only. NEVER hashed (DA-A-15): `ref` is an
 * evidence / price-check id or a rule id.
 */
export interface CellSource {
  kind: "user" | "evidence" | "price_check" | "derived" | "legacy_purchase" | "legacy_price_check";
  ref?: string;
}

/** One row of a cell, as resolution sees it (a stored `facts` row, or a legacy adapter row). */
export interface ResolveRow {
  state: FactRowState;
  value: FactValue;
  /** Recency: `recordedAt` (an observation: `lastObservedAt ?? recordedAt`; a legacy row: the source row's time). */
  at: number;
  source: CellSource;
  overridesObserved?: boolean;
}

export type KnownStatus = "confirmed" | "observed" | "derived";
export type ConflictKind = "candidates" | "confirmed_vs_observed" | "confirmed_vs_confirmed";

interface CellBase {
  subjectKey: string;
  key: string;
}
export interface KnownCell<V extends KnownValue = KnownValue> extends CellBase {
  status: KnownStatus;
  known: true;
  value: V;
  source: CellSource;
  capsOutcomeAt: null;
}
export interface CandidateCell<V extends KnownValue = KnownValue> extends CellBase {
  status: "candidate";
  known: false;
  value: V;
  /** Every current candidate row's source, newest first. */
  sources: CellSource[];
  /** D147(2): extracted candidates cap the outcome at likely_eligible. */
  capsOutcomeAt: "likely_eligible";
}
export interface ConflictValue<V extends KnownValue = KnownValue> {
  value: V;
  /** The newest row carrying this value. */
  source: CellSource;
  /** Every current row carrying this value, newest first. */
  sources: CellSource[];
}
export interface ConflictingCell<V extends KnownValue = KnownValue> extends CellBase {
  status: "conflicting";
  known: false;
  /**
   * D152: who can settle it. `candidates` → the user answers (needs_facts); `confirmed_vs_*` → the user cannot settle
   * it by answering (manual_review). `values` are the competing values: confirmed_vs_observed lists [confirmed,
   * observed]; the other kinds list each distinct value, newest first.
   */
  conflict: { kind: ConflictKind; values: ConflictValue<V>[] };
  capsOutcomeAt: null;
}
export interface UserUnknownCell<V extends KnownValue = KnownValue> extends CellBase {
  status: "user_unknown";
  known: false;
  /** The newest candidate recorded AFTER the "I don't know" answer, shown as a hint; never used as a value. */
  hint?: { value: V; source: CellSource };
  capsOutcomeAt: null;
}
export interface MissingCell extends CellBase {
  status: "missing";
  known: false;
  capsOutcomeAt: null;
}

export type Cell<V extends KnownValue = KnownValue> =
  | KnownCell<V>
  | CandidateCell<V>
  | ConflictingCell<V>
  | UserUnknownCell<V>
  | MissingCell;

/** The value an evaluator may compute with: known cells, and candidates (capped). Everything else → null. */
export function usableValue<V extends KnownValue>(cell: Cell<V>): V | null {
  return cell.status === "candidate" || cell.known ? cell.value : null;
}

function asKnown(value: FactValue): KnownValue | null {
  return value.kind === "user_unknown" ? null : value;
}

/**
 * The ONLY constructor of a known cell. Throws when the value is `user_unknown`: a known status never carries
 * "I don't know" (DA-A-1). Unreachable through `resolveCell` by construction; `resolve.test.ts` asserts the throw.
 */
export function knownCell(
  subjectKey: string,
  key: string,
  status: KnownStatus,
  value: FactValue,
  source: CellSource,
): KnownCell {
  const v = asKnown(value);
  if (v === null) throw new Error(`a ${status} cell cannot carry user_unknown (${subjectKey} ${key})`);
  return { subjectKey, key, status, known: true, value: v, source, capsOutcomeAt: null };
}

export function missingCell(subjectKey: string, key: string): MissingCell {
  return { subjectKey, key, status: "missing", known: false, capsOutcomeAt: null };
}

interface Ordered extends ResolveRow {
  seq: number;
}

/** Groups rows by value (first-seen order = newest first when `rows` is newest first). */
function distinctValues(rows: Ordered[]): ConflictValue[] {
  const out: ConflictValue[] = [];
  for (const r of rows) {
    const v = asKnown(r.value);
    if (v === null) continue;
    const hit = out.find((e) => sameFactValue(e.value, v));
    if (hit) hit.sources.push(r.source);
    else out.push({ value: v, source: r.source, sources: [r.source] });
  }
  return out;
}

export function resolveCell(subjectKey: string, key: string, rows: readonly ResolveRow[]): Cell {
  // Newest first: larger `at`, then later input position.
  const live: Ordered[] = rows
    .map((r, seq) => ({ ...r, seq }))
    .filter((r) => r.state !== "superseded" && r.state !== "rejected")
    .sort((a, b) => b.at - a.at || b.seq - a.seq);
  const of = (state: FactRowState) => live.filter((r) => r.state === state);
  const confirmedRows = of("user_confirmed");
  const observedRows = of("observed");
  const derivedRows = of("derived");
  const candidateRows = of("extracted_candidate");
  const U = confirmedRows[0];
  const conflicting = (kind: ConflictKind, values: ConflictValue[]): ConflictingCell => ({
    subjectKey, key, status: "conflicting", known: false, conflict: { kind, values }, capsOutcomeAt: null,
  });

  // 1. The newest confirmation says something.
  if (U !== undefined && U.value.kind !== "user_unknown") {
    const confirmedValues = distinctValues(confirmedRows);
    if (confirmedValues.length > 1) return conflicting("confirmed_vs_confirmed", confirmedValues);
    const obs = observedRows[0];
    if (obs !== undefined && !U.overridesObserved && !sameFactValue(U.value, obs.value)) {
      return conflicting("confirmed_vs_observed", [...distinctValues([U]), ...distinctValues([obs])]);
    }
    return knownCell(subjectKey, key, "confirmed", U.value, U.source);
  }
  // 2–3. System knowledge beats "I don't know" and candidates.
  if (observedRows[0] !== undefined) return knownCell(subjectKey, key, "observed", observedRows[0].value, observedRows[0].source);
  if (derivedRows[0] !== undefined) return knownCell(subjectKey, key, "derived", derivedRows[0].value, derivedRows[0].source);
  // 4. "I don't know" (DA-A-1: before any candidate can make the cell look answered).
  if (U !== undefined) {
    const later = candidateRows.find((c) => c.at > U.at || (c.at === U.at && c.seq > U.seq));
    const hint = later === undefined ? undefined : asKnown(later.value);
    return {
      subjectKey, key, status: "user_unknown", known: false, capsOutcomeAt: null,
      ...(hint ? { hint: { value: hint, source: later!.source } } : {}),
    };
  }
  // 5. Candidates.
  const candidates = distinctValues(candidateRows);
  if (candidates.length > 1) return conflicting("candidates", candidates);
  if (candidates.length === 1) {
    return {
      subjectKey, key, status: "candidate", known: false, value: candidates[0].value,
      sources: candidates[0].sources, capsOutcomeAt: "likely_eligible",
    };
  }
  // 6.
  return missingCell(subjectKey, key);
}

/**
 * D152 rule 5c hook: each competing value of a conflicting cell as a cell of its own row state (confirmed /
 * observed / candidate). M12 evaluates once per alternative (`withOverride`) and sets `sameAnswer` when every
 * alternative gives the same outcome. [] for a cell that is not conflicting.
 */
export function alternatives(cell: Cell): Cell[] {
  if (cell.status !== "conflicting") return [];
  const { kind, values } = cell.conflict;
  return values.map((alt, i) => {
    if (kind === "candidates") {
      return {
        subjectKey: cell.subjectKey, key: cell.key, status: "candidate", known: false, value: alt.value,
        sources: alt.sources, capsOutcomeAt: "likely_eligible",
      } satisfies CandidateCell;
    }
    const status: KnownStatus = kind === "confirmed_vs_observed" && i === 1 ? "observed" : "confirmed";
    return knownCell(cell.subjectKey, cell.key, status, alt.value, alt.source);
  });
}

/**
 * A stored value as the spec's typed value (contract §2.5 `typedValue`): null for `user_unknown`, the value when it
 * is the spec's kind, and a throw for any other kind (a row of the wrong kind is corrupt data, never guessed at).
 */
export function typedValue<K extends FactKey>(key: K, value: FactValue): ValueFor<K> | null {
  if (value.kind === "user_unknown") return null;
  const spec = getFactSpec(key);
  if (spec === null || value.kind !== spec.value) {
    throw new Error(`${key} holds a ${value.kind} value; the catalogue says ${spec?.value ?? "no such key"}`);
  }
  return value as ValueFor<K>;
}

/**
 * Narrows a resolved cell to its key's value type, checking every value it carries (value, hint, conflict values).
 * A known cell whose value would type to null throws — unreachable by construction (`knownCell`), asserted in tests.
 */
export function typedCell<K extends FactKey>(key: K, cell: Cell): Cell<ValueFor<K>> {
  const check = (v: FactValue) => {
    if (typedValue(key, v) === null) throw new Error(`${key}: a ${cell.status} cell cannot carry user_unknown`);
  };
  if (cell.status === "candidate" || cell.known) check(cell.value);
  if (cell.status === "user_unknown" && cell.hint) check(cell.hint.value);
  if (cell.status === "conflicting") for (const c of cell.conflict.values) check(c.value);
  return cell as Cell<ValueFor<K>>;
}

/** What an evaluator reads cells through (`lib/rules/conditions.ts`, `lib/deadlines/engine.ts`). */
export interface CellLookup {
  /** The cell for (subjectKey, key); a `missing` cell when nothing is known about it. */
  get(subjectKey: string, key: string): Cell;
  /** Every non-missing cell, in insertion order. */
  cells(): readonly Cell[];
}

const cellId = (subjectKey: string, key: string) => `${subjectKey}\u0000${key}`;

export function cellLookup(cells: readonly Cell[]): CellLookup {
  const map = new Map<string, Cell>();
  for (const c of cells) map.set(cellId(c.subjectKey, c.key), c);
  const list = [...map.values()];
  return {
    get: (subjectKey, key) => map.get(cellId(subjectKey, key)) ?? missingCell(subjectKey, key),
    cells: () => list,
  };
}

/** A lookup identical to `base` except that `cell`'s coordinates resolve to `cell` (D152 candidate testing). */
export function withOverride(base: CellLookup, cell: Cell): CellLookup {
  const id = cellId(cell.subjectKey, cell.key);
  return {
    get: (subjectKey, key) => (cellId(subjectKey, key) === id ? cell : base.get(subjectKey, key)),
    cells: () => {
      const rest = base.cells().filter((c) => cellId(c.subjectKey, c.key) !== id);
      return cell.status === "missing" ? rest : [...rest, cell];
    },
  };
}
