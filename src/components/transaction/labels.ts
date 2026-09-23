import type { Doc } from "../../../convex/_generated/dataModel";
import type { FactCell } from "../opportunity/model";

export type TransactionCategory = Doc<"transactions">["category"];

export const CATEGORY_LABELS: Readonly<Record<TransactionCategory, string>> = {
  retail_order: "Store order",
  air_travel: "Flight",
  card_charge: "Card charge",
};

export const TRANSACTION_STATUS_LABELS: Readonly<Record<Doc<"transactions">["status"], string>> = {
  needs_review: "Needs your review",
  active: "Active",
  archived: "Archived",
};

/**
 * How sure a fact is, in plain words (contract §2.5, §9 "confirmed facts / needs confirmation"). Only `confirmed`
 * is something the user stated or a record they confirmed; everything else is labelled for what it is. A `Record`
 * over the server's cell statuses, so a new status is a compile error until it has honest words.
 */
export const FACT_STATE_COPY: Readonly<Record<FactCell["status"], { label: string; dot: string; settled: boolean }>> = {
  confirmed: { label: "Confirmed", dot: "bg-moss", settled: true },
  observed: { label: "Observed by Recoup", dot: "bg-moss", settled: true },
  derived: { label: "Calculated from confirmed facts", dot: "bg-moss", settled: true },
  candidate: { label: "Read from a document, not confirmed", dot: "bg-gold", settled: false },
  conflicting: { label: "Sources disagree", dot: "bg-rust", settled: false },
  user_unknown: { label: "You said you don't know", dot: "bg-gray-300", settled: false },
  missing: { label: "Not known yet", dot: "bg-gray-300", settled: false },
};
