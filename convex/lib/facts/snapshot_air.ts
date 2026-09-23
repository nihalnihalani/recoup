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
 * The facts an approved R02 basis is bound to (rev 5 N6): identity (ticket, flight), the covered-flight inputs (scope,
 * service type — D253(3); the overdue letter states lateness only on a confirmed scheduled flight), the path (merchant
 * of record), the refund event and decision, the timer inputs, the amount inputs, and every significance input that can
 * decide the result — airports, connections and cabins (M27 R02-16). 32 cells, exactly `MAX_BOUND_FACTS`. The
 * marketing carrier decides nothing in v1 (D234 (2)) and is not bound.
 */
export const R02_BOUND_KEYS = [
  "air.ticket_number", "air.original_flight_number", "air.itinerary_scope", "air.operating_carrier",
  "air.service_type", "air.merchant_of_record", "air.ticket_refundability", "air.event_type", "air.offer_type",
  "air.consumer_response", "air.consumer_response_at", "air.flew_changed_or_alternative", "air.payment_method_class",
  "air.fare_paid", "air.taxes_paid", "air.ancillary_fees_total", "air.already_refunded", "air.partly_flown",
  "air.original_sched_departure_at", "air.original_sched_arrival_at", "air.changed_sched_departure_at",
  "air.changed_sched_arrival_at", "air.changed_or_alternative_departs_at", "air.cancellation_notice_at",
  "air.original_origin_airport", "air.original_destination_airport", "air.changed_origin_airport",
  "air.changed_destination_airport", "air.original_connections", "air.changed_connections", "air.original_cabin",
  "air.changed_cabin",
] as const satisfies readonly FactKey[];

export function r02BoundFacts(v: R02View): BoundFactValue[] {
  return boundFactValues(v, R02_BOUND_KEYS.map((key) => ({ subjectKey: v.subjectKey, key })));
}

// ---------------------------------------------------------------------------
// R04 bags, view + bound facts
// ---------------------------------------------------------------------------

/** Keys that may sit on a bag's incident (keys_air `subject` includes "incident"). */
export const R04_BAG_KEYS: ReadonlySet<string> = new Set(
  (AIR_FACT_SPECS as readonly { key: string; subject: readonly string[] }[]).filter((s) => s.subject.includes("incident")).map((s) => s.key),
);
/**
 * Trip-level facts among them: the same for every bag on the trip, so a bag's incident may inherit them from `txn`
 * (M27 R04-06). Every other bag key describes ONE bag and is never inherited.
 */
export const R04_TRIP_LEVEL_KEYS: ReadonlySet<string> = new Set(["air.deplane_opportunity_at", "air.incident_date"]);
/** Per-bag keys: they make a subject a bag (M27 R04-06/R04-15). */
export const R04_PER_BAG_KEYS: ReadonlySet<string> = new Set([...R04_BAG_KEYS].filter((k) => !R04_TRIP_LEVEL_KEYS.has(k)));

export interface R04Bag {
  /** `txn` (a bag recorded on the transaction itself) or the bag's `incident:<id>`. */
  subjectKey: string;
  /**
   * The bag's stable identity in loss keys (D234 (11); contract §3.3 `txn:<id>:bag_fee:<n>`): its KNOWN bag tag, else
   * the incident id, else `txn` — never a position, so adding or removing another bag never moves it.
   */
  lossId: string;
}

function bagLossId(lookup: CellLookup, subjectKey: string): string {
  const tag = lookup.get(subjectKey, "air.bag_tag_number");
  if (tag.known && tag.value.kind === "identifier") return tag.value.value;
  const parsed = parseSubjectKey(subjectKey);
  return parsed?.kind === "incident" ? parsed.id : AIR_TXN_SUBJECT;
}

/**
 * The bags of an air transaction (M27 R04-04/05/06/15): every `incident:<id>` holding a per-bag fact, plus `txn` when
 * the transaction itself holds one (a one-bag trip recorded without an incident). An air transaction with no bag fact
 * at all has no bags, so R04 asks nothing about bags on a flight whose bags were fine. Sorted by subject key.
 */
export function r04Bags(s: Pick<AirSnapshot, "lookup">): R04Bag[] {
  const subjects = new Set<string>();
  for (const c of s.lookup.cells()) {
    if (!R04_PER_BAG_KEYS.has(c.key)) continue;
    const kind = parseSubjectKey(c.subjectKey)?.kind;
    if (kind === "incident" || kind === "transaction") subjects.add(c.subjectKey);
  }
  return [...subjects].sort().map((subjectKey) => ({ subjectKey, lossId: bagLossId(s.lookup, subjectKey) }));
}

/** What R04 v1 evaluates: one bag (the run's subject), every bag of the trip (path b), the itinerary and the lines. */
export interface R04View {
  transactionId: Id<"transactions">;
  /** The run's bag: `txn` or `incident:<id>`. */
  bagSubjectKey: string;
  /** Its loss-key identity (`R04Bag.lossId`). */
  bagLossId: string;
  /** Every bag of the trip (path b's delay test passes if ANY bag qualifies). */
  bags: readonly R04Bag[];
  lookup: CellLookup;
  expenseLines: readonly number[];
  propertyItems: readonly number[];
}

export function r04View(
  s: Pick<AirSnapshot, "transactionId" | "lookup" | "expenseLines" | "propertyItems">,
  bagSubjectKey: string = AIR_TXN_SUBJECT,
): R04View {
  const kind = parseSubjectKey(bagSubjectKey)?.kind;
  if (kind !== "transaction" && kind !== "incident") throw new Error(`a bag lives on txn or an incident, not ${bagSubjectKey}`);
  const bags = r04Bags(s);
  return {
    transactionId: s.transactionId,
    bagSubjectKey,
    bagLossId: bagLossId(s.lookup, bagSubjectKey),
    bags: bags.some((b) => b.subjectKey === bagSubjectKey) ? bags : [...bags, { subjectKey: bagSubjectKey, lossId: bagLossId(s.lookup, bagSubjectKey) }],
    lookup: s.lookup,
    expenseLines: s.expenseLines,
    propertyItems: s.propertyItems,
  };
}

/**
 * The subject a bag's fact is read from: per-bag keys only on the bag itself; trip-level keys on the bag, else on
 * `txn` (M27 R04-06). Evaluators and bound facts use the same rule, so the cell read is the cell bound (R04-14).
 */
export function bagFactSubject(lookup: CellLookup, bagSubjectKey: string, key: string): string {
  if (bagSubjectKey === AIR_TXN_SUBJECT || !R04_TRIP_LEVEL_KEYS.has(key)) return bagSubjectKey;
  return lookup.get(bagSubjectKey, key).status === "missing" ? AIR_TXN_SUBJECT : bagSubjectKey;
}

/** Itinerary-level keys every R04 path binds. */
const R04_ITINERARY_KEYS = ["air.itinerary_scope"] as const satisfies readonly FactKey[];
const R04_A_BAG_KEYS = [
  "air.bag_tag_number", "air.bag_fee_paid", "air.deplane_opportunity_at", "air.bag_delivered_or_picked_up_at",
  "air.bag_status", "air.mbr_filed", "air.mbr_reference", "air.mbr_filed_at", "air.exemption_failed_recheck",
  "air.exemption_failed_pickup", "air.exemption_voluntary_separation", "air.exemption_documented_by_carrier",
  "air.incident_date",
] as const satisfies readonly FactKey[];
const R04_A_TXN_KEYS = ["air.longest_us_foreign_nonstop_segment_minutes", "air.operating_carrier_last_segment"] as const satisfies readonly FactKey[];
const R04_B_BAG_KEYS = [
  "air.deplane_opportunity_at", "air.bag_delivered_or_picked_up_at", "air.bag_status", "air.mbr_filed", "air.incident_date",
] as const satisfies readonly FactKey[];
const R04_BC_TXN_KEYS = ["air.large_aircraft_segment_on_ticket", "air.carrier_liability_limit"] as const satisfies readonly FactKey[];
const R04_B_TXN_KEYS = ["air.reimbursement_received"] as const satisfies readonly FactKey[];
const R04_C_BAG_KEYS = ["air.bag_tag_number", "air.bag_status", "air.incident_date", "air.deplane_opportunity_at"] as const satisfies readonly FactKey[];
export const R04_EXPENSE_LINE_KEYS = ["air.expense_amount", "air.expense_date", "air.expense_receipt", "air.expense_allocated_to"] as const satisfies readonly FactKey[];
export const R04_PROPERTY_KEYS = ["air.property_item", "air.property_claimed_value", "air.property_proof"] as const satisfies readonly FactKey[];

const B_BASE = R04_ITINERARY_KEYS.length + R04_B_BAG_KEYS.length + R04_BC_TXN_KEYS.length + R04_B_TXN_KEYS.length;
const C_BASE = R04_ITINERARY_KEYS.length + R04_C_BAG_KEYS.length + R04_BC_TXN_KEYS.length;
/**
 * The most expense lines (path b) / property items (path c) one evaluation binds: every line binds its cells and the
 * whole binding stays within `MAX_BOUND_FACTS` (rev 5 N6). An engineering bound, not a legal number: a bag with more
 * lines is prepared by a person (the pack returns `manual_review`).
 */
export const R04_MAX_EXPENSE_LINES = Math.floor((MAX_BOUND_FACTS - B_BASE) / R04_EXPENSE_LINE_KEYS.length);
export const R04_MAX_PROPERTY_ITEMS = Math.floor((MAX_BOUND_FACTS - C_BASE) / R04_PROPERTY_KEYS.length);

export type R04Path = "a" | "b" | "c";

export function r04BoundFacts(v: R04View, path: R04Path): BoundFactValue[] {
  const refs: FactRef[] = R04_ITINERARY_KEYS.map((key) => ({ subjectKey: AIR_TXN_SUBJECT, key }));
  const bag = (keys: readonly string[]) => keys.forEach((key) => refs.push({ subjectKey: bagFactSubject(v.lookup, v.bagSubjectKey, key), key }));
  const txn = (keys: readonly string[]) => keys.forEach((key) => refs.push({ subjectKey: AIR_TXN_SUBJECT, key }));
  if (path === "a") {
    bag(R04_A_BAG_KEYS);
    txn(R04_A_TXN_KEYS);
  } else if (path === "b") {
    bag(R04_B_BAG_KEYS);
    txn(R04_BC_TXN_KEYS);
    txn(R04_B_TXN_KEYS);
    for (const n of v.expenseLines.slice(0, R04_MAX_EXPENSE_LINES)) {
      for (const key of R04_EXPENSE_LINE_KEYS) refs.push({ subjectKey: lineSubject(n), key });
    }
  } else {
    bag(R04_C_BAG_KEYS);
    txn(R04_BC_TXN_KEYS);
    for (const n of v.propertyItems.slice(0, R04_MAX_PROPERTY_ITEMS)) {
      for (const key of R04_PROPERTY_KEYS) refs.push({ subjectKey: lineSubject(n), key });
    }
  }
  return boundFactValues(v, refs);
}
