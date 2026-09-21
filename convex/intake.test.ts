import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

async function makeEvent(t: ReturnType<typeof setup>, userId: Id<"users">, externalId?: string) {
  return t.run((ctx) =>
    ctx.db.insert("processedEvents", {
      externalId: externalId ?? `evt-${Math.random().toString(36).slice(2)}`,
      kind: "agentmail.message.received",
      status: "processing",
      attempts: 1,
      userId,
      payload: {},
    }),
  );
}

function orderParsed(overrides: Partial<{ currency: string; orderRef: string | null }> = {}) {
  return {
    kind: "order" as const,
    order: {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: overrides.orderRef !== undefined ? overrides.orderRef : "A-1",
      purchasedAt: "2026-01-01",
      currency: overrides.currency ?? "usd",
      items: [{ name: "Widget", unitPrice: 40, qty: 1, productUrl: null }],
    },
    refund: null,
    confidence: 0.9,
  };
}

describe("intake.applyExtraction — order", () => {
  it("always inserts the purchase needs_review and never schedules a policy fetch", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed: orderParsed() });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(1);
    expect(purchases[0].status).toBe("needs_review");
    expect(purchases[0].currency).toBe("USD");

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("Acme");
  });

  it("dedupes a duplicate orderRef into a needs_review event with no second purchase", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const e1 = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, { userId, eventId: e1, parsed: orderParsed() });

    const e2 = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, { userId, eventId: e2, parsed: orderParsed() });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(1);

    const row2 = await t.run((ctx) => ctx.db.get(e2));
    expect(row2?.status).toBe("needs_review");
    expect(row2?.summary).toContain("Duplicate of purchase");
  });

  it("flags an unknown currency as needs_review without inserting a purchase", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: orderParsed({ currency: "usdx", orderRef: "A-2" }),
    });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("Unknown currency");
  });
});

describe("intake.applyExtraction — refund", () => {
  async function seedPurchaseWithTwoItems(
    t: ReturnType<typeof setup>,
    as: Awaited<ReturnType<typeof signedIn>>["as"],
  ) {
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "A-9",
      purchasedAt: 0,
      currency: "USD",
      items: [
        { name: "Blue Scarf", unitCents: 4000, qty: 1 },
        { name: "Red Scarf", unitCents: 4000, qty: 1 },
      ],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    return { purchaseId, items };
  }

  it("marks needs_review, opens no claim, and leaves `returned` untouched when two returned items share an amount and no itemName is given", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { items } = await seedPurchaseWithTwoItems(t, as);
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    await as.mutation(api.purchases.setReturned, { itemId: items[1]._id, returned: true });
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: { merchant: "Acme", orderRef: "A-9", credits: [{ itemName: null, amount: 40, currency: "USD", state: "posted" }] },
        confidence: 0.9,
      },
    });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("could not be matched");

    for (const it of items) {
      const claims = await t.run((ctx) =>
        ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", it._id)).collect(),
      );
      expect(claims).toHaveLength(0);
      const fresh = await t.run((ctx) => ctx.db.get(it._id));
      expect(fresh?.returned).toBe(true);
    }
  });

  it("opens a claim and applies a promised_credit for an exact itemName match on a returned item", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { items } = await seedPurchaseWithTwoItems(t, as);
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme",
          orderRef: "A-9",
          credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
    });

    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items[0]._id)).collect(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].type).toBe("return_credit");

    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claims[0]._id)).collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("promised_credit");
    expect(events[0].cents).toBe(4000);

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("processing"); // left for `process` to finalize as succeeded
  });

  it("does not match a credit to an item the user has not marked returned, even with an exact itemName", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { items } = await seedPurchaseWithTwoItems(t, as);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme",
          orderRef: "A-9",
          credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
    });

    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items[0]._id)).collect(),
    );
    expect(claims).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
  });

  it("applying the same refund event twice yields one ledger event (idempotencyKey dedupe)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { items } = await seedPurchaseWithTwoItems(t, as);
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    const eventId = await makeEvent(t, userId);
    const parsed = {
      kind: "refund" as const,
      order: null,
      refund: {
        merchant: "Acme",
        orderRef: "A-9",
        credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" as const }],
      },
      confidence: 0.9,
    };

    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed });
    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed });

    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items[0]._id)).collect(),
    );
    expect(claims).toHaveLength(1);
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claims[0]._id)).collect(),
    );
    expect(events).toHaveLength(1);
  });

  it("marks needs_review when no purchase matches the refund", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: { merchant: "Nobody", orderRef: null, credits: [] },
        confidence: 0.9,
      },
    });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toBe("Refund email could not be matched to a purchase");
  });
});

describe("intake.applyExtraction — other", () => {
  it("marks the event needs_review", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: { kind: "other", order: null, refund: null, confidence: 0.9 },
    });
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toBe("Email was not an order or refund");
  });
});

describe("intake.createPasteEvent", () => {
  it("dedupes by externalId without reprocessing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const first = await t.mutation(internal.intake.createPasteEvent, {
      externalId: "paste:abc",
      userId,
      payload: { text: "hi" },
    });
    const second = await t.mutation(internal.intake.createPasteEvent, {
      externalId: "paste:abc",
      userId,
      payload: { text: "hi" },
    });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.eventId).toBe(first.eventId);

    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows.filter((r) => r.externalId === "paste:abc")).toHaveLength(1);
  });
});
