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

    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed: orderParsed(), key: "k-order" });

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
    await t.mutation(internal.intake.applyExtraction, { userId, eventId: e1, parsed: orderParsed(), key: "k-order-1" });

    const e2 = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, { userId, eventId: e2, parsed: orderParsed(), key: "k-order-2" });

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
      key: "k-order-3",
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
      key: "k-refund-1",
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
      key: "k-refund-2",
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
      key: "k-refund-3",
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

    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed, key: "k-refund-dedupe" });
    await t.mutation(internal.intake.applyExtraction, { userId, eventId, parsed, key: "k-refund-dedupe" });

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
      key: "k-refund-4",
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
      key: "k-other",
    });
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toBe("Email was not an order or refund");
  });
});

describe("intake — D58 boundary validation on order/refund extraction (S9)", () => {
  it("routes a negative unitPrice to needs_review without inserting a purchase", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "order",
        order: {
          merchant: "Acme",
          merchantDomain: "acme.example",
          orderRef: "A-neg",
          purchasedAt: "2026-01-01",
          currency: "usd",
          items: [{ name: "Widget", unitPrice: -5, qty: 1, productUrl: null }],
        },
        refund: null,
        confidence: 0.9,
      },
      key: "k-s9-a",
    });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("Invalid price or quantity");
  });

  it("routes an out-of-bounds purchasedAt to needs_review without inserting a purchase", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "order",
        order: {
          merchant: "Acme",
          merchantDomain: "acme.example",
          orderRef: "A-future",
          purchasedAt: "2099-01-01",
          currency: "usd",
          items: [{ name: "Widget", unitPrice: 40, qty: 1, productUrl: null }],
        },
        refund: null,
        confidence: 0.9,
      },
      key: "k-s9-b",
    });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("Invalid purchase date");
  });

  it("routes a non-positive refund credit amount to needs_review for that credit, without throwing or opening a claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "A-9",
      purchasedAt: 0,
      currency: "USD",
      items: [{ name: "Blue Scarf", unitCents: 4000, qty: 1 }],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
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
          credits: [{ itemName: "Blue Scarf", amount: -5, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
      key: "k-s9-c",
    });

    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items[0]._id)).collect(),
    );
    expect(claims).toHaveLength(0);
    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("not a valid positive amount");
  });
});

describe("intake.applyExtraction — D55 refund purchase matching (S4)", () => {
  it("ignores a non-active purchase even with an exact orderRef match", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "A-9",
      purchasedAt: 0,
      currency: "USD",
      status: "needs_review",
      items: [{ name: "Widget", unitCents: 4000, qty: 1 }],
    });
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
      key: "k-d55-a",
    });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toBe("Refund email could not be matched to a purchase");
  });

  it("prefers an exact merchant name match over a broader inclusion match on a different purchase", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.purchases.create, {
      merchant: "Acme Outlet",
      merchantDomain: "acme-outlet.example",
      purchasedAt: 0,
      currency: "USD",
      items: [{ name: "Widget", unitCents: 4000, qty: 1 }],
    });
    const p2 = await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      purchasedAt: 0,
      currency: "USD",
      items: [{ name: "Blue Scarf", unitCents: 4000, qty: 1 }],
    });
    const { items: items2 } = (await as.query(api.purchases.get, { purchaseId: p2 }))!;
    await as.mutation(api.purchases.setReturned, { itemId: items2[0]._id, returned: true });
    const eventId = await makeEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme",
          orderRef: null,
          credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
      key: "k-d55-b",
    });

    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items2[0]._id)).collect(),
    );
    expect(claims).toHaveLength(1);
  });

  it("skips an example purchase unless the refund's own merchant text is also marked (example); passes isExample into openClaim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Acme (example)",
      merchantDomain: "acme.example",
      purchasedAt: 0,
      currency: "USD",
      isExample: true,
      items: [{ name: "Blue Scarf", unitCents: 4000, qty: 1 }],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });

    const eventId1 = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId: eventId1,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme",
          orderRef: null,
          credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
      key: "k-d55-c1",
    });
    const row1 = await t.run((ctx) => ctx.db.get(eventId1));
    expect(row1?.status).toBe("needs_review");
    expect(row1?.summary).toBe("Refund email could not be matched to a purchase");

    const eventId2 = await makeEvent(t, userId);
    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId: eventId2,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme (example)",
          orderRef: null,
          credits: [{ itemName: "Blue Scarf", amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
      key: "k-d55-c2",
    });
    const claims = await t.run((ctx) =>
      ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", items[0]._id)).collect(),
    );
    expect(claims).toHaveLength(1);
    expect(claims[0].isExample).toBe(true);
  });
});

describe("intake.applyExtraction — D54 refund credit idempotency (S5)", () => {
  it("a credit whose idempotency key conflicts with a differently-keyed ledger event is marked needs_review; the event still succeeds", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "A-9",
      purchasedAt: 0,
      currency: "USD",
      items: [{ name: "Blue Scarf", unitCents: 4000, qty: 1 }],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    const claimId = await as.mutation(api.claims.open, { itemId: items[0]._id });

    // Pre-seed a ledger event under the exact key `applyExtraction` will
    // compute (`${key}:${itemId}:${creditIndex}`) but with a conflicting
    // kind/amount, to force the idempotency-conflict path (D38) that
    // `applyEvent` would otherwise throw.
    const key = "k-conflict";
    const idempotencyKey = `${key}:${items[0]._id}:0`;
    await t.run((ctx) =>
      ctx.db.insert("ledgerEvents", {
        claimId,
        userId,
        kind: "later_debit",
        cents: 999,
        evidence: "unrelated event",
        idempotencyKey,
      }),
    );

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
      key,
    });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("conflicts with a previously recorded credit");

    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(1); // only the pre-seeded event; no promised_credit was written
  });
});

describe("intake — D54 paste key is scoped per user (S3)", () => {
  it("two users pasting content that hashes the same do not dedupe against each other", async () => {
    const t = setup();
    const { userId: aliceId } = await signedIn(t, "Alice");
    const { userId: bobId } = await signedIn(t, "Bob");

    // `intake.paste` builds its externalId as `paste:${userId}:${sha256}`
    // (D54); exercised here at the `createPasteEvent` layer (which is what
    // actually dedupes) with that exact key shape, since `paste` itself
    // calls the OpenAI-backed `extractInbound` and is not exercised
    // end-to-end in this suite (see convex/lib/ai.test.ts).
    const sameHash = "deadbeef";
    const alice = await t.mutation(internal.intake.createPasteEvent, {
      externalId: `paste:${aliceId}:${sameHash}`,
      userId: aliceId,
      payload: { text: "hi" },
    });
    const bob = await t.mutation(internal.intake.createPasteEvent, {
      externalId: `paste:${bobId}:${sameHash}`,
      userId: bobId,
      payload: { text: "hi" },
    });

    expect(alice.isNew).toBe(true);
    expect(bob.isNew).toBe(true);
    expect(alice.eventId).not.toBe(bob.eventId);

    // Re-pasting the same content as the same user is still a no-op.
    const aliceAgain = await t.mutation(internal.intake.createPasteEvent, {
      externalId: `paste:${aliceId}:${sameHash}`,
      userId: aliceId,
      payload: { text: "hi" },
    });
    expect(aliceAgain.isNew).toBe(false);
    expect(aliceAgain.eventId).toBe(alice.eventId);
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
