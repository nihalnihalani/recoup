/**
 * The typed online-order snapshot (contract §2.5) R05 v1 reads: every cell of a retail transaction's stored fact rows
 * (and, when the caller includes them, the legacy adapter's rows) resolved by `resolveCell`. Pure: no ctx, clock or
 * ids in any hash.
 *
 * R05's facts all live on the order itself (subject `txn`, `keys_order.ts`). `snapshotHash` and `orderBoundFacts`
 * project each cell onto (subjectKey, key, status, value) — values, never fact or evidence ids — through the generic
 * helpers of `snapshot_retail.ts` (DA-A-15).
 */
import type { Id } from "../../_generated/dataModel";
import type { FactKey, ValueFor } from "./catalog";
import { cellLookup, resolveCell, typedCell, type Cell, type CellLookup, type ResolveRow } from "./resolve";
import { boundFactValues, type BoundFactValue, type CellRow } from "./snapshot_retail";
import { subjectKey as subject } from "./subject";

/** Resolves rows (any order; resolution orders by `at`) into a lookup of every non-missing cell. */
export function resolveRows(rows: readonly CellRow[]): CellLookup {
  const grouped = new Map<string, { subjectKey: string; key: string; rows: ResolveRow[] }>();
  for (const { subjectKey, key, row } of rows) {
    const id = `${subjectKey}\u0000${key}`;
    const g = grouped.get(id) ?? { subjectKey, key, rows: [] };
    g.rows.push(row);
    grouped.set(id, g);
  }
  const cells = [...grouped.values()].map((g) => resolveCell(g.subjectKey, g.key, g.rows));
  return cellLookup(cells.filter((c) => c.status !== "missing"));
}

export interface OrderSnapshotInput {
  transactionId: Id<"transactions">;
  /** Stored fact rows (and optionally legacy adapter rows) of the transaction. */
  rows: readonly CellRow[];
}

export interface OrderSnapshot {
  category: "retail_order";
  transactionId: Id<"transactions">;
  /** Every R05 fact is about the order itself. */
  subjectKey: "txn";
  lookup: CellLookup;
}

export function buildOrderSnapshot(input: OrderSnapshotInput): OrderSnapshot {
  return { category: "retail_order", transactionId: input.transactionId, subjectKey: "txn", lookup: resolveRows(input.rows) };
}

/** The resolved, typed cell of a transaction-level key (a `missing` cell when nothing is known). */
export function txnCell<K extends FactKey>(snapshot: { lookup: CellLookup }, key: K): Cell<ValueFor<K>> {
  return typedCell(key, snapshot.lookup.get(subject.txn(), key));
}

/**
 * R05 v1's bound facts (rev 5 N6, DA-A-15): every fact the evaluation decides on or a packet may interpolate — the
 * order, its shipping promise and shipment, the first delay notice and the buyer's answer, scope and the amount. 27
 * keys (≤ MAX_BOUND_FACTS = 32). The derived vesting date is not bound: it is a function of these.
 */
export const R05_BOUND_KEYS = [
  "retail.order_ref",
  "retail.order_total",
  "order.seller_name",
  "order.channel",
  "order.buyer_country",
  "order.ship_to_country",
  "order.seller_country",
  "order.merchandise_category",
  "order.payment_terms",
  "card.payment_instrument_class",
  "order.properly_completed_at",
  "order.ship_time_kind",
  "order.ship_time_days",
  "order.ship_by_date",
  "order.ship_time_text",
  "order.shipped",
  "order.shipped_at",
  "order.partially_shipped",
  "order.delay_notice_received",
  "order.delay_notice_received_at",
  "order.delay_revised_ship_kind",
  "order.delay_revised_ship_date",
  "order.delay_notice_offers_cancel",
  "order.buyer_response",
  "order.buyer_response_at",
  "order.ship_to_time_zone",
  "retail.merchant",
] as const satisfies readonly FactKey[];

/** Canonical (subjectKey, key, status, value) rows of R05's bound keys, sorted, ≤ 32. */
export function orderBoundFacts(snapshot: { lookup: CellLookup }): BoundFactValue[] {
  return boundFactValues(snapshot, R05_BOUND_KEYS.map((key) => ({ subjectKey: subject.txn(), key })));
}
