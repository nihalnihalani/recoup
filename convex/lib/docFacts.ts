/**
 * M23: from one extracted document (`lib/schemas_docs`) to candidate facts, each with its DA-A-6 quote status.
 *
 * Every value the model returned comes with the verbatim quote it came from. Here the quote is LOCATED in the
 * deterministic text layer (email/paste text, or a PDF text layer from `lib/pdfText`), turned into a `text_span`
 * locator, and checked by `lib/quote.verifyQuote`: `verified` only when the quote is really there AND the value parses
 * back out of it; `unverified` otherwise; `unverifiable` when there is no text layer at all. A quote that cannot be
 * found keeps a `whole_document` locator and is `unverified`.
 *
 * Only a few fields map to catalogued keys, and only onto a transaction of the right category. The values are built
 * conservatively: a currency must be a printed ISO code (a bare "$" is never assumed to be USD, HC-9), a date must
 * have exactly one reading, and an amount must parse with no sign marker. Anything else is left out, never guessed.
 * Every candidate is written as `extracted_candidate` (SEC-AI-2): it never satisfies a rule condition until the user
 * confirms it (SEC-AI-3), whatever its quote status. Pure: no ctx, clock, network or model.
 */
import { getFactSpec } from "./facts/catalog";
import { parseDecimalToMinor } from "./money";
import { datesInQuote, verifyQuote, type QuoteLocator, type QuoteStatus, type QuotedValue, type TextLayer } from "./quote";
import type { ExtractableDocType, OrderDocT, ShipmentDocT, TravelDocT } from "./schemas_docs";

type Quoted<T> = { value: T | null; quote: string | null };
export type TransactionCategory = "retail_order" | "air_travel" | "card_charge";

/** One candidate fact on the transaction (`subjectKey: "txn"`), ready for `putFact` as `extracted_candidate`. */
export type DocCandidate = {
  key: string;
  value: QuotedValue;
  locator: QuoteLocator;
  quoteStatus: QuoteStatus;
};

/** The longest quote kept on a locator (the doc schemas already cap quotes at this). */
const MAX_QUOTE = 300;

/**
 * Where `quote` sits in the text layer, as a `text_span` locator; `whole_document` when it cannot be found. An exact
 * match first, then one that tolerates different runs of whitespace (a PDF text layer often breaks lines).
 */
export function locateQuote(layer: TextLayer, quote: string | null): QuoteLocator {
  if (layer === null || quote === null) return { kind: "whole_document" };
  const q = quote.slice(0, MAX_QUOTE);
  const trimmed = q.trim();
  if (trimmed.length === 0) return { kind: "whole_document" };
  const exact = layer.text.indexOf(trimmed);
  if (exact >= 0) return { kind: "text_span", start: exact, end: exact + trimmed.length, quote: trimmed };
  const tokens = trimmed.split(/\s+/).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const m = new RegExp(tokens.join("\\s+")).exec(layer.text);
  if (m) return { kind: "text_span", start: m.index, end: m.index + m[0].length, quote: m[0] };
  return { kind: "whole_document" };
}

/** A printed ISO 4217 code ("usd" → "USD"); null for a symbol, a name or anything unclear. */
function isoCode(field: Quoted<string> | undefined): string | null {
  const raw = field?.value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(raw) ? raw : null;
}

/** The single ISO date a printed date can mean, or null (none, or an ambiguous day/month). */
function isoDate(printed: string | null): string | null {
  if (printed === null) return null;
  const dates = datesInQuote(printed);
  return dates.length === 1 ? dates[0] : null;
}

/** A printed amount in minor units of `currency`: currency marks stripped, no sign marker, the key's currency mode. */
function minorOf(printed: string | null, currency: string, key: string): number | null {
  if (printed === null) return null;
  const bare = printed.replace(/[$€£¥]/g, "").replace(new RegExp(`\\b${currency}\\b`, "gi"), "").trim();
  const parsed = parseDecimalToMinor(bare, currency, getFactSpec(key)?.currencyMode ?? "new_scenario");
  return parsed.ok && parsed.amountMinor > 0 ? parsed.amountMinor : null;
}

class Builder {
  readonly out: DocCandidate[] = [];
  private readonly layer: TextLayer;
  constructor(layer: TextLayer) {
    this.layer = layer;
  }

  add(key: string, value: QuotedValue | null, quote: string | null): void {
    if (value === null || getFactSpec(key) === null) return;
    const locator = locateQuote(this.layer, quote);
    const quoteStatus = verifyQuote({ layer: this.layer, locator, value, currencyMode: getFactSpec(key)?.currencyMode });
    this.out.push({ key, value, locator, quoteStatus });
  }

  text(key: string, field: Quoted<string> | undefined, max: number): void {
    const t = field?.value?.trim();
    if (t) this.add(key, { kind: "text", text: t.slice(0, max) }, field?.quote ?? null);
  }

  identifier(key: string, scheme: string, field: Quoted<string> | undefined): void {
    const t = field?.value?.trim();
    if (t) this.add(key, { kind: "identifier", scheme, value: t }, field?.quote ?? null);
  }

  /** An instant at noon UTC of the printed date (the date is what the document states; intake does the same). */
  instant(key: string, field: Quoted<string> | undefined): void {
    const d = isoDate(field?.value ?? null);
    if (d === null) return;
    const [y, m, day] = d.split("-").map(Number);
    this.add(key, { kind: "instant", epochMs: Date.UTC(y, m - 1, day, 12) }, field?.quote ?? null);
  }

  money(key: string, field: Quoted<string> | undefined, currency: string | null): void {
    if (currency === null) return;
    const minor = minorOf(field?.value ?? null, currency, key);
    if (minor !== null) this.add(key, { kind: "money", amountMinor: minor, currency }, field?.quote ?? null);
  }
}

function orderCandidates(b: Builder, doc: OrderDocT): void {
  b.text("retail.merchant", doc.merchant, 120);
  b.identifier("retail.order_ref", "order_ref", doc.orderRef);
  b.instant("retail.purchase_date", doc.orderDate);
  const currency = isoCode(doc.currency);
  if (currency !== null) b.add("retail.currency", { kind: "code", code: currency }, doc.currency.quote);
  b.money("retail.order_total", doc.total, currency);
}

function shipmentCandidates(b: Builder, doc: ShipmentDocT): void {
  b.instant("order.shipped_at", doc.shippedDate);
}

function travelCandidates(b: Builder, doc: TravelDocT): void {
  b.identifier("air.ticket_number", "eticket", doc.ticketNumber);
  const first = doc.segments[0];
  if (first !== undefined) {
    b.text("air.operating_carrier", first.operatingCarrier, 120);
    b.identifier("air.original_flight_number", "flight_number", first.flightNumber);
    b.text("air.original_origin_airport", first.from, 8);
    b.text("air.original_destination_airport", first.to, 8);
  }
  b.money("air.total_paid", doc.fareTotal, isoCode(doc.currency));
}

/**
 * The candidate facts one extracted document offers a transaction of `category`. A document type with no mapping for
 * that category (a refund notice, a baggage report, a statement, a submission proof) offers none: it is still stored
 * and read, and the user answers the questions themselves.
 */
export function candidatesFromDoc(docType: ExtractableDocType, doc: unknown, category: TransactionCategory, layer: TextLayer): DocCandidate[] {
  const b = new Builder(layer);
  switch (docType) {
    case "order_confirmation":
    case "receipt":
      if (category === "retail_order") orderCandidates(b, doc as OrderDocT);
      break;
    case "shipping_notice":
    case "delivery_notice":
    case "delay_notice":
      if (category === "retail_order") shipmentCandidates(b, doc as ShipmentDocT);
      break;
    case "e_ticket":
    case "itinerary_change_notice":
    case "cancellation_notice":
      if (category === "air_travel") travelCandidates(b, doc as TravelDocT);
      break;
    default:
      break;
  }
  return b.out;
}
