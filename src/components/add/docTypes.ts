import type { Doc } from "../../../convex/_generated/dataModel";

export type EvidenceDocType = Doc<"evidence">["docType"];

/**
 * Every declarable document type, in picker order, with the words a person uses (DA-A-8: nothing is read from an
 * upload until its type is declared). A `Record` over the schema's union, so a type added to the schema without a
 * label here is a compile error. `unknown` is never offered: "I'm not sure" is `other`, which stays unread.
 */
export const DOC_TYPE_LABELS: Readonly<Record<EvidenceDocType, string>> = {
  order_confirmation: "Order confirmation",
  receipt: "Receipt",
  refund_notice: "Refund notice",
  shipping_notice: "Shipping notice",
  delivery_notice: "Delivery notice",
  delay_notice: "Delay notice",
  e_ticket: "E-ticket or booking confirmation",
  itinerary_change_notice: "Flight change notice",
  cancellation_notice: "Cancellation notice",
  baggage_report: "Baggage report",
  expense_receipt: "Receipt for an expense (hotel, meals, essentials)",
  card_statement: "Card statement",
  merchant_correspondence: "Message from the store or airline",
  submission_proof: "Proof that you sent a claim",
  damage_photo: "Photo of damage",
  policy_page: "Store policy page",
  other: "Something else (stored, not read)",
  unknown: "Not sure",
};

export const PICKABLE_DOC_TYPES: readonly EvidenceDocType[] = (Object.keys(DOC_TYPE_LABELS) as EvidenceDocType[]).filter(
  (type) => type !== "unknown",
);
