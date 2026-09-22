/**
 * The typed retail snapshot (contract §2.5) an evaluator reads: every cell of a retail transaction resolved from the
 * legacy adapter's rows (`lib/facts/legacyRetail.ts`) overlaid with stored fact rows. Pure: no ctx, clock or ids in
 * any hash.
 *
 * `snapshotHash` and `boundFactValues` project each cell onto (subjectKey, key, status, value) — values, never fact,
 * evidence or price-check ids — so re-confirming an unchanged value, or a new price-check row observing the same
 * price, never changes a hash, while a changed value or status always does (DA-A-15).
 */
import type { Infer } from "convex/values";
import type { Id } from "../../_generated/dataModel";
import type { boundFactValue, factRef, variantMatch } from "../../schema";
import { MAX_BOUND_FACTS } from "../../limits";
import { canonicalHash, sortCanonical } from "../canonical";
import type { FactKey, FactValue, ValueFor } from "./catalog";
import { subjectKey as subject } from "./subject";
import { cellLookup, resolveCell, typedCell, type Cell, type CellLookup, type ResolveRow } from "./resolve";

export type BoundFactValue = Infer<typeof boundFactValue>;
export type FactRef = Infer<typeof factRef>;

/** One row of one cell (a legacy adapter row or a stored fact row). */
export interface CellRow {
  subjectKey: string;
  key: string;
  row: ResolveRow;
}

/** The accepted observation behind an item's observed-price cell (display and R01 acceptance bars; never hashed). */
export interface RetailObservation {
  priceCheckId: Id<"priceChecks">;
  observedAt: number;
  confidence?: number;
  variantMatch?: Infer<typeof variantMatch>;
}

export interface RetailItemMeta {
  itemId: Id<"items">;
  /** `items.returned` (user-set, D15). */
  returned: boolean;
  observation: RetailObservation | null;
}

export interface RetailSnapshotInput {
  transactionId: Id<"transactions">;
  purchaseId: Id<"purchases"> | null;
  purchaseStatus: "needs_review" | "active" | "archived" | null;
  merchantDomain: string | null;
  isExample: boolean;
  items: RetailItemMeta[];
  /** Legacy rows and stored rows, in any order (resolution orders by `at`). */
  rows: CellRow[];
}

export interface RetailItemSnapshot extends RetailItemMeta {
  subjectKey: string;
  name: Cell<ValueFor<"retail.item_name">>;
  quantity: Cell<ValueFor<"retail.quantity">>;
  unitPrice: Cell<ValueFor<"retail.unit_price">>;
  observedPrice: Cell<ValueFor<"retail.observed_price">>;
}

export interface RetailSnapshot {
  category: "retail_order";
  transactionId: Id<"transactions">;
  purchaseId: Id<"purchases"> | null;
  purchaseStatus: RetailSnapshotInput["purchaseStatus"];
  merchantDomain: string | null;
  isExample: boolean;
  merchant: Cell<ValueFor<"retail.merchant">>;
  orderRef: Cell<ValueFor<"retail.order_ref">>;
  purchaseDate: Cell<ValueFor<"retail.purchase_date">>;
  /** DA-A-33: a candidate (assumption) unless a `retail.currency` confirmation exists. */
  currency: Cell<ValueFor<"retail.currency">>;
  items: RetailItemSnapshot[];
  /** Every resolved cell, including stored keys the typed fields above do not name (e.g. `retail.window_days`). */
  lookup: CellLookup;
}

const cellId = (subjectKey: string, key: string) => `${subjectKey}\u0000${key}`;

export function buildRetailSnapshot(input: RetailSnapshotInput): RetailSnapshot {
  const grouped = new Map<string, { subjectKey: string; key: string; rows: ResolveRow[] }>();
  for (const { subjectKey, key, row } of input.rows) {
    const id = cellId(subjectKey, key);
    const g = grouped.get(id) ?? { subjectKey, key, rows: [] };
    g.rows.push(row);
    grouped.set(id, g);
  }
  const cells = [...grouped.values()].map((g) => resolveCell(g.subjectKey, g.key, g.rows));
  const lookup = cellLookup(cells.filter((c) => c.status !== "missing"));
  const cell = <K extends FactKey>(subjectKey: string, key: K) => typedCell(key, lookup.get(subjectKey, key));
  const txn = subject.txn();
  return {
    category: "retail_order",
    transactionId: input.transactionId,
    purchaseId: input.purchaseId,
    purchaseStatus: input.purchaseStatus,
    merchantDomain: input.merchantDomain,
    isExample: input.isExample,
    merchant: cell(txn, "retail.merchant"),
    orderRef: cell(txn, "retail.order_ref"),
    purchaseDate: cell(txn, "retail.purchase_date"),
    currency: cell(txn, "retail.currency"),
    items: input.items.map((meta) => {
      const s = subject.item(meta.itemId);
      return {
        ...meta,
        subjectKey: s,
        name: cell(s, "retail.item_name"),
        quantity: cell(s, "retail.quantity"),
        unitPrice: cell(s, "retail.unit_price"),
        observedPrice: cell(s, "retail.observed_price"),
      };
    }),
    lookup,
  };
}

/** A cell's hashable projection: (subjectKey, key, status, value); a conflict hashes its competing values instead. */
function projection(c: Cell): { subjectKey: string; key: string; status: string; value?: FactValue; values?: FactValue[] } {
  const base = { subjectKey: c.subjectKey, key: c.key, status: c.status };
  if (c.status === "candidate" || c.known) return { ...base, value: c.value };
  if (c.status === "conflicting") return { ...base, values: sortCanonical(c.conflict.values.map((v) => v.value)) };
  return base;
}

/** SHA-256 over the canonical, sorted projections of every non-missing cell (DA-A-15). */
export async function snapshotHash(snapshot: { lookup: CellLookup }): Promise<string> {
  return await canonicalHash(sortCanonical(snapshot.lookup.cells().map(projection)));
}

/**
 * The canonical (subjectKey, key, status, value) rows of the requested cells (rev 5 N6), stored on evaluations and
 * hashed into `boundFactsHash`. Sorted and de-duplicated, so the order of `refs` never matters; at most
 * `MAX_BOUND_FACTS`. A cell with no single value (missing, user_unknown, conflicting) is stored without one.
 */
export function boundFactValues(snapshot: { lookup: CellLookup }, refs: readonly FactRef[]): BoundFactValue[] {
  const unique = new Map<string, FactRef>();
  for (const r of refs) unique.set(cellId(r.subjectKey, r.key), { subjectKey: r.subjectKey, key: r.key });
  if (unique.size > MAX_BOUND_FACTS) throw new Error(`at most ${MAX_BOUND_FACTS} bound facts`);
  const rows = [...unique.values()].map(({ subjectKey, key }): BoundFactValue => {
    const c = snapshot.lookup.get(subjectKey, key);
    return c.status === "candidate" || c.known
      ? { subjectKey, key, status: c.status, value: c.value }
      : { subjectKey, key, status: c.status };
  });
  return rows.sort((a, b) => (a.subjectKey + "\u0000" + a.key < b.subjectKey + "\u0000" + b.key ? -1 : 1));
}
