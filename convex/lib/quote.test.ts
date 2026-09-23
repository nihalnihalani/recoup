import { describe, expect, it } from "vitest";
import { countsTowardEvidence, datesInQuote, evidenceSupportsFrom, valueParsesFromQuote, verifyQuote, type TextLayer } from "./quote";

/** A synthetic receipt as its text layer (email/paste text, or a PDF text layer). */
const RECEIPT = [
  "Northwind Outfitters",
  "Order #112-3456789-1234562   Placed September 1, 2026",
  "Wool scarf          Qty 2",
  "Unit price $39.99",
  "Total: USD 79.98",
].join("\n");
const layer: TextLayer = { text: RECEIPT };
const span = (quote: string) => {
  const start = RECEIPT.indexOf(quote);
  if (start < 0) throw new Error(`fixture: ${quote} not in receipt`);
  return { kind: "text_span" as const, start, end: start + quote.length, quote };
};

describe("DA-A-6: quote verification", () => {
  it("a correct short quote → verified (no 40-character minimum)", () => {
    expect(verifyQuote({ layer, locator: span("$39.99"), value: { kind: "money", amountMinor: 3_999, currency: "USD" } })).toBe("verified");
    expect(verifyQuote({ layer, locator: span("Qty 2"), value: { kind: "count", n: 2 } })).toBe("verified");
    expect(verifyQuote({ layer, locator: span("USD 79.98"), value: { kind: "money", amountMinor: 7_998, currency: "USD" } })).toBe("verified");
  });

  it("a digit-swapped value → unverified, though the quote itself is really there", () => {
    expect(verifyQuote({ layer, locator: span("$39.99"), value: { kind: "money", amountMinor: 3_399, currency: "USD" } })).toBe("unverified");
    expect(verifyQuote({ layer, locator: span("$39.99"), value: { kind: "money", amountMinor: 9_399, currency: "USD" } })).toBe("unverified");
    expect(verifyQuote({ layer, locator: span("Qty 2"), value: { kind: "count", n: 20 } })).toBe("unverified");
  });

  it("image-only → unverifiable, whatever the model quoted, and never counts toward evidenceSupports", () => {
    const status = verifyQuote({ layer: null, locator: span("$39.99"), value: { kind: "money", amountMinor: 3_999, currency: "USD" } });
    expect(status).toBe("unverifiable");
    expect(countsTowardEvidence(status)).toBe(false);
    expect(evidenceSupportsFrom([status])).toBe("unknown");
    expect(evidenceSupportsFrom(["verified", status])).toBe("unknown");
    expect(evidenceSupportsFrom(["verified", "verified"])).toBe("pass");
    expect(evidenceSupportsFrom(["verified", "unverified"])).toBe("unknown");
    expect(evidenceSupportsFrom([])).toBe("unknown");
  });

  it("the quote must be AT its locator: an offset pointing elsewhere, a paraphrase or an empty quote is unverified", () => {
    const wrong = { ...span("$39.99"), start: 0, end: 6 };
    expect(verifyQuote({ layer, locator: wrong, value: { kind: "money", amountMinor: 3_999, currency: "USD" } })).toBe("unverified");
    const paraphrase = { kind: "text_span" as const, start: 0, end: 10, quote: "39.99 dollars" };
    expect(verifyQuote({ layer, locator: paraphrase, value: { kind: "money", amountMinor: 3_999, currency: "USD" } })).toBe("unverified");
    expect(verifyQuote({ layer, locator: { kind: "text_span", start: 0, end: 0, quote: "" }, value: { kind: "count", n: 2 } })).toBe("unverified");
    expect(verifyQuote({ layer, locator: { ...span("$39.99"), end: RECEIPT.length + 5 }, value: { kind: "money", amountMinor: 3_999, currency: "USD" } })).toBe(
      "unverified",
    );
    expect(verifyQuote({ layer, locator: { kind: "whole_document" }, value: { kind: "count", n: 2 } })).toBe("unverified");
  });

  it("whitespace and typography differences at the locator still match (normalizeForMatch on both sides)", () => {
    const text = "Delivered on\n  September   3, 2026 — left at front door";
    const quote = "Delivered on September 3, 2026 - left";
    const start = 0;
    const end = text.indexOf(" at front");
    expect(verifyQuote({ layer: { text }, locator: { kind: "text_span", start, end, quote }, value: { kind: "local_date", date: "2026-09-03" } })).toBe(
      "verified",
    );
  });

  it("money: one amount only, no sign marker, and no contradicting currency", () => {
    const m = (q: string, amountMinor: number, currency = "USD") => valueParsesFromQuote({ kind: "money", amountMinor, currency }, q);
    expect(m("Total 1,234.50", 123_450)).toBe(true);
    expect(m("2 x 39.99", 3_999)).toBe(false); // two numbers: which is the value?
    expect(m("(39.99)", 3_999)).toBe(false); // a credit/negative is never read as a positive amount
    expect(m("39.99 CR", 3_999)).toBe(false);
    expect(m("€39.99", 3_999)).toBe(false); // the quote says EUR
    expect(m("EUR 39.99", 3_999, "EUR")).toBe(false); // new scenarios admit USD only (O6) ...
    expect(valueParsesFromQuote({ kind: "money", amountMinor: 3_999, currency: "EUR" }, "EUR 39.99", "legacy_r01")).toBe(true);
    expect(m("£39.99", 3_999, "GBP")).toBe(false); // GBP is not a new-scenario currency ...
    expect(valueParsesFromQuote({ kind: "money", amountMinor: 3_999, currency: "GBP" }, "£39.99", "legacy_r01")).toBe(true); // ... but R01's carve-out is
    expect(m("39.999", 3_999)).toBe(false);
  });

  it("dates: one unambiguous date only", () => {
    expect(datesInQuote("Placed September 1, 2026")).toEqual(["2026-09-01"]);
    expect(datesInQuote("on 1st Sept. 2026")).toEqual(["2026-09-01"]);
    expect(datesInQuote("09/01/2026").sort()).toEqual(["2026-01-09", "2026-09-01"]);
    expect(datesInQuote("12/12/26")).toEqual(["2026-12-12"]);
    expect(datesInQuote("02/30/2026")).toEqual([]);
    const at = (q: string, iso: string) => valueParsesFromQuote({ kind: "instant", epochMs: Date.parse(`${iso}T12:00:00Z`) }, q);
    expect(at("Placed September 1, 2026", "2026-09-01")).toBe(true);
    expect(at("Placed September 1, 2026", "2026-09-10")).toBe(false);
    expect(at("09/01/2026", "2026-09-01")).toBe(false); // ambiguous: month/day or day/month
    expect(at("09/13/2026", "2026-09-13")).toBe(true);
    expect(valueParsesFromQuote({ kind: "local_datetime", dateTime: "2026-09-03T14:05" }, "Sep 3, 2026 at 2:05 pm")).toBe(true);
    expect(valueParsesFromQuote({ kind: "local_datetime", dateTime: "2026-09-03T14:05" }, "Sep 3, 2026 at 2:50 pm")).toBe(false);
  });

  it("identifiers and codes exactly; text by its words; minutes by their units", () => {
    const id = (value: string) => valueParsesFromQuote({ kind: "identifier", scheme: "order_ref", value }, "Order #112-3456789-1234562");
    expect(id("112-3456789-1234562")).toBe(true);
    expect(id("112-3456789-1234526")).toBe(false); // swapped digits
    expect(id("112-3456789")).toBe(false); // part of a longer identifier
    expect(valueParsesFromQuote({ kind: "code", code: "USD" }, "Total: usd 79.98")).toBe(true);
    expect(valueParsesFromQuote({ kind: "text", text: "Northwind Outfitters" }, "Sold by NORTHWIND  Outfitters LLC")).toBe(true);
    expect(valueParsesFromQuote({ kind: "text", text: "Southwind" }, "Sold by Northwind")).toBe(false);
    expect(valueParsesFromQuote({ kind: "minutes", minutes: 150 }, "delayed 2 h 30 min")).toBe(true);
    expect(valueParsesFromQuote({ kind: "minutes", minutes: 150 }, "delayed 2 hours")).toBe(false);
    expect(valueParsesFromQuote({ kind: "bool", value: true }, "Delivered: yes")).toBe(false);
  });

  it("a PDF page locator is checked against that page's text, an email header against the header", () => {
    const pdf: TextLayer = { text: "Page one\nPage two says $12.50", pages: ["Page one", "Page two says $12.50"] };
    const money = { kind: "money" as const, amountMinor: 1_250, currency: "USD" };
    expect(verifyQuote({ layer: pdf, locator: { kind: "pdf_page", page: 2, quote: "$12.50" }, value: money })).toBe("verified");
    expect(verifyQuote({ layer: pdf, locator: { kind: "pdf_page", page: 1, quote: "$12.50" }, value: money })).toBe("unverified");
    expect(verifyQuote({ layer: pdf, locator: { kind: "pdf_page", page: 3, quote: "$12.50" }, value: money })).toBe("unverified");
    const email: TextLayer = { text: "body", headers: { date: "Tue, 1 Sep 2026 10:00:00 +0000" } };
    expect(verifyQuote({ layer: email, locator: { kind: "email_header", header: "date" }, value: { kind: "local_date", date: "2026-09-01" } })).toBe(
      "verified",
    );
    expect(verifyQuote({ layer: email, locator: { kind: "email_header", header: "from" }, value: { kind: "text", text: "x" } })).toBe("unverified");
  });
});
