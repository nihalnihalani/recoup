/**
 * The typed card-charge snapshot (contract §2.5) R03 v1 reads: the stored fact rows of ONE card statement line — a
 * `card_charge` transaction (DA-A-30: the natural key carries a per-line identity, so two identical duplicate-charge
 * lines are two transactions) — resolved by `resolveCell`. Pure: no ctx, clock or ids in any hash.
 *
 * `relatedTransactionId` (server-set after `ownedTransaction`, DA-A-29) names the order the charge paid for, when
 * known: R03's loss key for a goods dispute is anchored there, so R05 and R03 claim the same money once (§3.3).
 */
import type { Id } from "../../_generated/dataModel";
import type { FactKey } from "./catalog";
import type { CellLookup } from "./resolve";
import { boundFactValues, type BoundFactValue, type CellRow } from "./snapshot_retail";
import { resolveRows } from "./snapshot_order";
import { subjectKey as subject } from "./subject";

export interface CardSnapshotInput {
  transactionId: Id<"transactions">;
  relatedTransactionId?: Id<"transactions">;
  rows: readonly CellRow[];
}

export interface CardSnapshot {
  category: "card_charge";
  transactionId: Id<"transactions">;
  relatedTransactionId: Id<"transactions"> | null;
  /** Every R03 fact is about the statement line itself. */
  subjectKey: "txn";
  lookup: CellLookup;
}

export function buildCardSnapshot(input: CardSnapshotInput): CardSnapshot {
  return {
    category: "card_charge",
    transactionId: input.transactionId,
    relatedTransactionId: input.relatedTransactionId ?? null,
    subjectKey: "txn",
    lookup: resolveRows(input.rows),
  };
}

/**
 * R03 v1's bound facts (rev 5 N6, DA-A-15): every fact the evaluation decides on or the notice letter may state — the
 * card class, the error, the charge line, the statement dates, the notice channel and address, the notice's receipt,
 * and the delivery record. 21 keys (≤ MAX_BOUND_FACTS = 32).
 */
export const R03_BOUND_KEYS = [
  "card.payment_instrument_class",
  "card.error_type",
  "card.charge_date",
  "card.merchant_descriptor",
  "card.charge_amount",
  "card.correct_amount",
  "card.first_statement_transmitted_on",
  "card.statement_closing_date",
  "card.posting_date",
  "card.credit_issue_date",
  "card.billing_error_address",
  "card.billing_address_time_zone",
  "card.electronic_notice_stipulated",
  "card.notice_channel_planned",
  "card.notice_received_on",
  "card.merchant_contacted",
  "card.delivery_promised_by",
  "card.delivery_status",
  "card.delivered_at",
  "card.delivery_tracking_summary",
  "card.existing_dispute_open",
] as const satisfies readonly FactKey[];

/** Canonical (subjectKey, key, status, value) rows of R03's bound keys, sorted, ≤ 32. */
export function cardBoundFacts(snapshot: { lookup: CellLookup }): BoundFactValue[] {
  return boundFactValues(snapshot, R03_BOUND_KEYS.map((key) => ({ subjectKey: subject.txn(), key })));
}
