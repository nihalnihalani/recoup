/**
 * The typed air-travel snapshot (contract §2.5) that R02 v1 and R04 v1 evaluate: every stored fact row of one
 * `air_travel` transaction resolved into cells (`lib/facts/resolve.ts`), plus the per-pack views and bound-fact
 * functions. Pure: no ctx, clock or ids in any hash.
 *
 * Hashing follows the retail snapshot exactly (`snapshot_retail.snapshotHash` / `boundFactValues`, DA-A-15): a cell
 * projects to (subjectKey, key, status, value) — never fact, evidence or row ids — so re-confirming an unchanged value
 * changes nothing while a changed value or status always does.
 *
 * Subjects (lib/facts/subject.ts): itinerary and ticket facts live on `txn`; a bag's facts on `txn` (one bag) or on
 * its `incident:<id>` (one incident per bag); R04's expense lines and property items on `line:<n>`.
 */
import type { Id } from "../../_generated/dataModel";
import { MAX_BOUND_FACTS } from "../../limits";
import type { FactKey, ValueFor } from "./catalog";
import { AIR_FACT_SPECS } from "./keys_air";
import { cellLookup, resolveCell, typedCell, type Cell, type CellLookup, type ResolveRow } from "./resolve";
import { boundFactValues, snapshotHash, type BoundFactValue, type CellRow, type FactRef } from "./snapshot_retail";
import { parseSubjectKey } from "./subject";

export { snapshotHash };
export type { BoundFactValue, CellRow, FactRef };

export const AIR_TXN_SUBJECT = "txn";

export interface AirSnapshotInput {
  transactionId: Id<"transactions">;
  isExample?: boolean;
  /** Stored fact rows, in any order (resolution orders by `at`). */
  rows: readonly CellRow[];
}

export interface AirSnapshot {
  category: "air_travel";
  transactionId: Id<"transactions">;
  isExample: boolean;
  /** Every resolved (non-missing) cell. */
  lookup: CellLookup;
  /** Ordinals of the `line:<n>` subjects holding an R04 expense key, ascending. */
  expenseLines: number[];
  /** Ordinals of the `line:<n>` subjects holding an R04 property key, ascending. */
  propertyItems: number[];
}

const cellId = (subjectKey: string, key: string) => `${subjectKey}\u0000${key}`;

export function buildAirSnapshot(input: AirSnapshotInput): AirSnapshot {
  const grouped = new Map<string, { subjectKey: string; key: string; rows: ResolveRow[] }>();
  for (const { subjectKey, key, row } of input.rows) {
    const id = cellId(subjectKey, key);
    const g = grouped.get(id) ?? { subjectKey, key, rows: [] };
    g.rows.push(row);
    grouped.set(id, g);
  }
  const cells = [...grouped.values()].map((g) => resolveCell(g.subjectKey, g.key, g.rows));
  const expense = new Set<number>();
  const property = new Set<number>();
  for (const c of cells) {
    const s = parseSubjectKey(c.subjectKey);
    if (s?.kind !== "line" || c.status === "missing") continue;
    if (c.key.startsWith("air.expense_")) expense.add(s.ordinal);
    if (c.key.startsWith("air.property_")) property.add(s.ordinal);
  }
  return {
    category: "air_travel",
    transactionId: input.transactionId,
    isExample: input.isExample ?? false,
    lookup: cellLookup(cells.filter((c) => c.status !== "missing")),
    expenseLines: [...expense].sort((a, b) => a - b),
    propertyItems: [...property].sort((a, b) => a - b),
  };
}

/** The cell of a catalogued key, typed to the key's value (throws on a stored value of the wrong kind). */
export function airCell<K extends FactKey>(lookup: CellLookup, subjectKey: string, key: K): Cell<ValueFor<K>> {
  return typedCell(key, lookup.get(subjectKey, key));
}

export const lineSubject = (ordinal: number): string => `line:${ordinal}`;

// ---------------------------------------------------------------------------
// R02 view + bound facts
// ---------------------------------------------------------------------------

/** What R02 v1 evaluates: the ticket's cells (subject `txn`). */
export interface R02View {
  transactionId: Id<"transactions">;
  subjectKey: typeof AIR_TXN_SUBJECT;
  lookup: CellLookup;
}

export function r02View(s: Pick<AirSnapshot, "transactionId" | "lookup">): R02View {
  return { transactionId: s.transactionId, subjectKey: AIR_TXN_SUBJECT, lookup: s.lookup };
}

/**
 * The facts an approved R02 basis is bound to (rev 5 N6): identity (ticket, flight), the path (merchant of record),
 * the refund event and decision, the timer inputs and the amount inputs. 24 cells.
 */
export const R02_BOUND_KEYS = [
  "air.ticket_number", "air.original_flight_number", "air.itinerary_scope", "air.operating_carrier",
  "air.marketing_carrier", "air.merchant_of_record", "air.ticket_refundability", "air.event_type", "air.offer_type",
  "air.consumer_response", "air.consumer_response_at", "air.flew_changed_or_alternative", "air.payment_method_class",
  "air.fare_paid", "air.taxes_paid", "air.ancillary_fees_total", "air.already_refunded", "air.partly_flown",
  "air.original_sched_departure_at", "air.original_sched_arrival_at", "air.changed_sched_departure_at",
  "air.changed_sched_arrival_at", "air.changed_or_alternative_departs_at", "air.cancellation_notice_at",
] as const satisfies readonly FactKey[];

export function r02BoundFacts(v: R02View): BoundFactValue[] {
  return boundFactValues(v, R02_BOUND_KEYS.map((key) => ({ subjectKey: v.subjectKey, key })));
}

// ---------------------------------------------------------------------------
// R04 view + bound facts
// ---------------------------------------------------------------------------

/** What R04 v1 evaluates: one bag (its subject), the itinerary (`txn`), and the transaction's lines. */
export interface R04View {
  transactionId: Id<"transactions">;
  /** `txn` or the bag's `incident:<id>`. */
  bagSubjectKey: string;
  /** 1-based bag number on the transaction (loss key `txn:<id>:bag_fee:<n>`, contract §3.3). */
  bagOrdinal: number;
  lookup: CellLookup;
  expenseLines: readonly number[];
  propertyItems: readonly number[];
}

export function r04View(
  s: Pick<AirSnapshot, "transactionId" | "lookup" | "expenseLines" | "propertyItems">,
  bag: { subjectKey: string; ordinal: number } = { subjectKey: AIR_TXN_SUBJECT, ordinal: 1 },
): R04View {
  const kind = parseSubjectKey(bag.subjectKey)?.kind;
  if (kind !== "transaction" && kind !== "incident") throw new Error(`a bag lives on txn or an incident, not ${bag.subjectKey}`);
  if (!Number.isSafeInteger(bag.ordinal) || bag.ordinal < 1) throw new Error("bag ordinal must be ≥ 1");
  return {
    transactionId: s.transactionId,
    bagSubjectKey: bag.subjectKey,
    bagOrdinal: bag.ordinal,
    lookup: s.lookup,
    expenseLines: s.expenseLines,
    propertyItems: s.propertyItems,
  };
}

/** Keys that describe one bag (keys_air `subject` includes "incident"): they sit on the bag's incident, or on `txn`. */
export const R04_BAG_KEYS: ReadonlySet<string> = new Set(
  (AIR_FACT_SPECS as readonly { key: string; subject: readonly string[] }[]).filter((s) => s.subject.includes("incident")).map((s) => s.key),
);

/**
 * The bags of an air transaction: every `incident:<id>` subject holding a bag key, in subject-key order (ordinal 1, 2,
 * …); with none, the transaction itself is the one bag. Pure and deterministic, so ordinals (and the loss keys
 * `txn:<id>:bag_fee:<n>`) are stable across evaluations.
 */
export function r04BagSubjects(s: Pick<AirSnapshot, "lookup">): { subjectKey: string; ordinal: number }[] {
  const incidents = new Set<string>();
  for (const c of s.lookup.cells()) {
    if (R04_BAG_KEYS.has(c.key) && parseSubjectKey(c.subjectKey)?.kind === "incident") incidents.add(c.subjectKey);
  }
  const keys = [...incidents].sort();
  return keys.length === 0 ? [{ subjectKey: AIR_TXN_SUBJECT, ordinal: 1 }] : keys.map((subjectKey, i) => ({ subjectKey, ordinal: i + 1 }));
}

/** Itinerary-level keys every R04 path binds. */
const R04_ITINERARY_KEYS = ["air.itinerary_scope"] as const satisfies readonly FactKey[];
const R04_A_BAG_KEYS = [
  "air.bag_tag_number", "air.bag_fee_paid", "air.deplane_opportunity_at", "air.bag_delivered_or_picked_up_at",
  "air.bag_status", "air.mbr_filed", "air.mbr_reference", "air.mbr_filed_at", "air.exemption_failed_recheck",
  "air.exemption_failed_pickup", "air.exemption_voluntary_separation", "air.exemption_documented_by_carrier",
] as const satisfies readonly FactKey[];
const R04_A_TXN_KEYS = ["air.longest_us_foreign_nonstop_segment_minutes", "air.operating_carrier_last_segment"] as const satisfies readonly FactKey[];
const R04_B_BAG_KEYS = ["air.bag_tag_number", "air.deplane_opportunity_at", "air.bag_delivered_or_picked_up_at", "air.bag_status"] as const satisfies readonly FactKey[];
const R04_BC_TXN_KEYS = ["air.large_aircraft_segment_on_ticket"] as const satisfies readonly FactKey[];
const R04_C_BAG_KEYS = ["air.bag_tag_number", "air.bag_status", "air.incident_date"] as const satisfies readonly FactKey[];
const R04_C_TXN_KEYS = ["air.carrier_liability_limit"] as const satisfies readonly FactKey[];
export const R04_EXPENSE_LINE_KEYS = ["air.expense_amount", "air.expense_receipt", "air.expense_allocated_to"] as const satisfies readonly FactKey[];
export const R04_PROPERTY_KEYS = ["air.property_item", "air.property_claimed_value", "air.property_proof"] as const satisfies readonly FactKey[];

const B_BASE = R04_ITINERARY_KEYS.length + R04_B_BAG_KEYS.length + R04_BC_TXN_KEYS.length;
const C_BASE = R04_ITINERARY_KEYS.length + R04_C_BAG_KEYS.length + R04_BC_TXN_KEYS.length + R04_C_TXN_KEYS.length;
/**
 * The most expense lines (path b) / property items (path c) one evaluation binds: every line binds its three cells and
 * the whole binding stays within `MAX_BOUND_FACTS` (rev 5 N6). An engineering bound, not a legal number: a bag with
 * more lines is prepared by a person (the pack returns `manual_review`).
 */
export const R04_MAX_EXPENSE_LINES = Math.floor((MAX_BOUND_FACTS - B_BASE) / R04_EXPENSE_LINE_KEYS.length);
export const R04_MAX_PROPERTY_ITEMS = Math.floor((MAX_BOUND_FACTS - C_BASE) / R04_PROPERTY_KEYS.length);

export type R04Path = "a" | "b" | "c";

export function r04BoundFacts(v: R04View, path: R04Path): BoundFactValue[] {
  const refs: FactRef[] = R04_ITINERARY_KEYS.map((key) => ({ subjectKey: AIR_TXN_SUBJECT, key }));
  const bag = (keys: readonly string[]) => keys.forEach((key) => refs.push({ subjectKey: v.bagSubjectKey, key }));
  const txn = (keys: readonly string[]) => keys.forEach((key) => refs.push({ subjectKey: AIR_TXN_SUBJECT, key }));
  if (path === "a") {
    bag(R04_A_BAG_KEYS);
    txn(R04_A_TXN_KEYS);
  } else if (path === "b") {
    bag(R04_B_BAG_KEYS);
    txn(R04_BC_TXN_KEYS);
    for (const n of v.expenseLines.slice(0, R04_MAX_EXPENSE_LINES)) {
      for (const key of R04_EXPENSE_LINE_KEYS) refs.push({ subjectKey: lineSubject(n), key });
    }
  } else {
    bag(R04_C_BAG_KEYS);
    txn(R04_BC_TXN_KEYS);
    txn(R04_C_TXN_KEYS);
    for (const n of v.propertyItems.slice(0, R04_MAX_PROPERTY_ITEMS)) {
      for (const key of R04_PROPERTY_KEYS) refs.push({ subjectKey: lineSubject(n), key });
    }
  }
  return boundFactValues(v, refs);
}
