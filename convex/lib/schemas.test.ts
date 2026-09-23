import { describe, expect, it } from "vitest";
import { zodTextFormat } from "openai/helpers/zod";
import {
  InboundEmail,
  Policy,
  Price,
  ReplyClass,
  DraftOut,
} from "./schemas";

describe("InboundEmail", () => {
  it("parses a realistic order fixture", () => {
    const fixture = {
      kind: "order",
      order: {
        merchant: "Nordstrom",
        merchantDomain: "nordstrom.com",
        orderRef: "NS-12345",
        purchasedAt: "2026-09-01",
        currency: "USD",
        items: [
          { name: "Wool Coat", unitPrice: 249.99, qty: 1, productUrl: "https://nordstrom.com/p/wool-coat" },
        ],
      },
      refund: null,
      confidence: 0.92,
    };
    const parsed = InboundEmail.parse(fixture);
    expect(parsed.order?.merchantDomain).toBe("nordstrom.com");
  });

  it("parses with purchasedAt null", () => {
    const fixture = {
      kind: "order",
      order: {
        merchant: "Nordstrom",
        merchantDomain: "nordstrom.com",
        orderRef: null,
        purchasedAt: null,
        currency: "USD",
        items: [],
      },
      refund: null,
      confidence: 0.5,
    };
    expect(() => InboundEmail.parse(fixture)).not.toThrow();
  });

  it("parses a realistic refund fixture", () => {
    const fixture = {
      kind: "refund",
      order: null,
      refund: {
        merchant: "Nordstrom",
        orderRef: "NS-12345",
        credits: [
          { itemName: "Wool Coat", amount: 249.99, currency: "USD", state: "posted" },
        ],
      },
      confidence: 0.8,
    };
    expect(() => InboundEmail.parse(fixture)).not.toThrow();
  });

  it("rejects a wrong kind enum value", () => {
    const fixture = {
      kind: "invoice",
      order: null,
      refund: null,
      confidence: 0.5,
    };
    expect(() => InboundEmail.parse(fixture)).toThrow();
  });
});

describe("Policy", () => {
  it("parses a realistic fixture", () => {
    const fixture = {
      found: true,
      windowDays: 30,
      channel: "email",
      contactEmail: "returns@merchant.com",
      passage: "You may return items within 30 days of delivery.",
      confidence: 0.85,
    };
    expect(() => Policy.parse(fixture)).not.toThrow();
  });

  it("rejects a wrong channel enum value", () => {
    const fixture = {
      found: true,
      windowDays: 30,
      channel: "carrier_pigeon",
      contactEmail: null,
      passage: "",
      confidence: 0.1,
    };
    expect(() => Policy.parse(fixture)).toThrow();
  });
});

describe("Price", () => {
  it("parses the ambiguous 'from' price fixture", () => {
    const fixture = {
      price: null,
      currency: null,
      listPrice: null,
      productName: null,
      isRange: true,
      variantMatch: "unsure",
      note: "from $95",
      confidence: 0.4,
    };
    expect(() => Price.parse(fixture)).not.toThrow();
  });

  it("rejects a wrong variantMatch enum value", () => {
    const fixture = {
      price: 95,
      currency: "USD",
      listPrice: 120,
      productName: "Jacket",
      isRange: false,
      variantMatch: "maybe",
      note: null,
      confidence: 0.9,
    };
    expect(() => Price.parse(fixture)).toThrow();
  });
});

describe("ReplyClass", () => {
  it("parses a realistic fixture", () => {
    const fixture = {
      classification: "promise",
      summary: "Merchant promised a refund of $79.99 within 5 business days.",
      promised: { value: "79.99", currency: "$" },
    };
    expect(() => ReplyClass.parse(fixture)).not.toThrow();
  });

  it("rejects a wrong classification enum value", () => {
    const fixture = {
      classification: "denial",
      summary: "Merchant refused.",
      promised: null,
    };
    expect(() => ReplyClass.parse(fixture)).toThrow();
  });
});

describe("DraftOut", () => {
  it("parses a realistic fixture", () => {
    const fixture = {
      subject: "Return request for order NS-12345",
      body: "Hello, I would like to request a return for my recent order.",
    };
    expect(() => DraftOut.parse(fixture)).not.toThrow();
  });

  it("rejects a non-object fixture", () => {
    expect(() => DraftOut.parse("not an object")).toThrow();
  });
});

describe("strict-mode JSON schema guard", () => {
  const schemas: Array<[string, unknown]> = [
    ["InboundEmail", InboundEmail],
    ["Policy", Policy],
    ["Price", Price],
    ["ReplyClass", ReplyClass],
    ["DraftOut", DraftOut],
  ];

  for (const [name, schema] of schemas) {
    it(`${name} strict JSON schema has no minLength/maxLength and additionalProperties:false`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const format = zodTextFormat(schema as any, name);
      const json = JSON.stringify(format);
      expect(json).not.toContain('"maxLength"');
      expect(json).not.toContain('"minLength"');
      expect(json).toContain('"additionalProperties":false');
    });
  }
});
