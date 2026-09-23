import { z } from "zod";

const OrderItem = z.object({
  name: z.string(),
  unitPrice: z.number().describe("per-unit price in major units before tax, e.g. 79.99"),
  qty: z.number().int().min(1),
  productUrl: z.string().nullable().describe("absolute product page URL if the email links one, else null"),
});

export const InboundEmail = z.object({
  kind: z.enum(["order", "refund", "other"]),
  order: z.object({
    merchant: z.string(),
    merchantDomain: z.string().describe("bare registrable domain like nordstrom.com, derived from sender or links; never invented"),
    orderRef: z.string().nullable(),
    purchasedAt: z.string().nullable().describe("ISO date YYYY-MM-DD, or null if the email does not state an unambiguous date"),
    currency: z.string().describe("ISO 4217 code"),
    items: z.array(OrderItem),
  }).nullable(),
  refund: z.object({
    merchant: z.string().nullable(),
    orderRef: z.string().nullable(),
    credits: z.array(z.object({
      itemName: z.string().nullable(),
      amount: z.number(),
      currency: z.string(),
      state: z.enum(["posted", "promised"]).describe("posted only if the email says the refund was issued to the payment method"),
    })),
  }).nullable(),
  confidence: z.number().min(0).max(1),
});

export const Policy = z.object({
  found: z.boolean(),
  windowDays: z.number().int().nullable(),
  channel: z.enum(["email", "form", "chat", "phone", "unknown"]),
  contactEmail: z.string().nullable(),
  passage: z.string().describe("verbatim passage copied from the page, at most 600 characters; empty string if none"),
  confidence: z.number().min(0).max(1),
});

export const Price = z.object({
  price: z.number().nullable().describe("single current selling price in major units; null if not a single unambiguous number"),
  currency: z.string().nullable().describe("ISO 4217 code shown on the page, else null"),
  listPrice: z.number().nullable().describe("the struck-through / was / list price shown on the page in major units, else null"),
  productName: z.string().nullable().describe("the product's name as the page titles it, a short plain name; null if the page is not a product page"),
  isRange: z.boolean().describe("true if the page shows a price range or 'from' price"),
  variantMatch: z.enum(["exact", "unsure", "none"]).describe("whether the price is for the exact named product/variant"),
  note: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/**
 * DA-A-19 (M28): the stated amount comes back as printed, WITH its currency, never as a bare number: the server parses
 * it (`parseDecimalToMinor`) and records it only when the currency is the claim's own (`replies.apply`).
 */
export const ReplyClass = z.object({
  classification: z.enum(["promise", "credit_issued", "refusal", "question", "other"]),
  summary: z.string().describe("one sentence, at most 240 characters"),
  promised: z
    .object({
      value: z.string().describe('the amount exactly as printed, e.g. "40.00" or "1,234.50"; at most 40 characters'),
      currency: z.string().describe("the currency as the reply states it: an ISO code like USD or EUR, or a symbol like $, € or £"),
    })
    .nullable()
    .describe("the refund or credit amount the reply says will be or was issued; null when it states no amount"),
});

export const DraftOut = z.object({
  subject: z.string().describe("at most 80 characters, no square brackets"),
  body: z.string().describe("at most 1200 characters"),
});

export type InboundEmailT = z.infer<typeof InboundEmail>;
export type PolicyT = z.infer<typeof Policy>;
export type PriceT = z.infer<typeof Price>;
export type ReplyClassT = z.infer<typeof ReplyClass>;
export type DraftOutT = z.infer<typeof DraftOut>;
