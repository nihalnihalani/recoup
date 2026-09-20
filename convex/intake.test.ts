import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

// `createPasteEvent` and `retryEvent` schedule `processEvent`, which would
// call OpenAI. Fake timers keep convex-test from running it (D31).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof setup>;

/** A queued intake event, as `inbound.onMessageReceived` would have left it. */
async function queueEvent(t: T, userId: Id<"users">, externalId = "evt-1") {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("processedEvents", {
        externalId,
        kind: "agentmail.message.received",
        status: "received",
        attempts: 0,
        userId,
        route: "intake",
        payload: { messageId: "msg-1", subject: "s", text: "t", from: "f@x.example" },
      }),
  );
}

function orderEmail(over: Record<string, unknown> = {}) {
  return {
    kind: "order",
    order: {
      merchant: "Nordstrom",
      merchantDomain: "www.nordstrom.com",
      orderRef: "ORD-1",
      purchasedAt: "2026-09-01",
      currency: "usd",
      items: [
        { name: "Wool scarf", unitPrice: 79.99, qty: 1, productUrl: "https://nordstrom.com/s/1" },
      ],
      ...over,
    },
    refund: null,
    confidence: 0.9,
  };
}

function refundEmail(credits: unknown[], over: Record<string, unknown> = {}) {
  return {
    kind: "refund",
    order: null,
    refund: { merchant: "Nordstrom", orderRef: "ORD-1", credits, ...over },
    confidence: 0.9,
  };
}

async function eventRow(t: T, id: Id<"processedEvents">) {
  return (await t.run(async (ctx) => await ctx.db.get(id)))!;
}

/** A confirmed purchase with one line item, optionally marked returned. */
async function purchaseWithItem(
  t: T,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
  opts: { returned?: boolean; unitCents?: number; orderRef?: string } = {},
) {
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Nordstrom",
    merchantDomain: "nordstrom.com",
    orderRef: opts.orderRef ?? "ORD-1",
    purchasedAt: Date.parse("2026-09-01"),
    currency: "USD",
    status: "needs_review",
    items: [{ name: "Wool scarf", unitCents: opts.unitCents ?? 4_000, qty: 1 }],
  });
  const detail = await as.query(api.purchases.get, { purchaseId });
  const itemId = detail.items[0]._id;
  if (opts.returned) await as.mutation(api.purchases.setReturned, { itemId, returned: true });
  return { purchaseId, itemId };
}

async function claimsOn(t: T, itemId: Id<"items">): Promise<Doc<"claims">[]> {
  return await t.run(
    async (ctx) =>
      await ctx.db
        .query("claims")
        .withIndex("by_item", (q) => q.eq("itemId", itemId))
        .collect(),
  );
}

describe("intake.applyExtraction — orders", () => {
  it("creates a needs_review purchase with normalised domain, currency and items (D25)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId);

    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed: orderEmail() });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(1);
    const { purchase, items } = board.purchases[0];
    expect(purchase.status).toBe("needs_review");
    expect(purchase.merchantDomain).toBe("nordstrom.com");
    expect(purchase.currency).toBe("USD");
    expect(purchase.sourceMessageId).toBe("msg-1");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Wool scarf", unitCents: 7_999, qty: 1, returned: false });

    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("Nordstrom");
  });

  it("refuses an order it already holds instead of inserting a twin (D22)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await purchaseWithItem(t, as, { orderRef: "ORD-1" });

    const id = await queueEvent(t, userId, "evt-dupe");
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed: orderEmail() });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(1);
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("Duplicate of purchase");
  });

  it("does not treat another user's order ref as a duplicate", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await purchaseWithItem(t, a.as, { orderRef: "ORD-1" });

    const id = await queueEvent(t, b.userId, "evt-b");
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed: orderEmail() });

    expect((await b.as.query(api.purchases.board, {})).purchases).toHaveLength(1);
    expect((await eventRow(t, id)).summary).not.toContain("Duplicate");
  });

  it("rejects an unusable merchant domain and an item-less order", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);

    const bad = await queueEvent(t, userId, "evt-domain");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: bad,
      parsed: orderEmail({ merchantDomain: "not a domain" }),
    });
    expect((await eventRow(t, bad)).status).toBe("needs_review");

    const empty = await queueEvent(t, userId, "evt-empty");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: empty,
      parsed: orderEmail({ items: [{ name: "x", unitPrice: Infinity, qty: 1, productUrl: null }] }),
    });
    expect((await eventRow(t, empty)).status).toBe("needs_review");
    expect((await as.query(api.purchases.board, {})).purchases).toHaveLength(0);
  });

  it("drops a hallucinated purchase date rather than storing it", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-date");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({ purchasedAt: "1879-01-01" }),
    });
    const board = await as.query(api.purchases.board, {});
    expect(board.purchases[0].purchase.purchasedAt).toBeUndefined();
  });
});

describe("intake.applyExtraction — refunds (D15)", () => {
  it("records a promised credit on a returned item and never a confirmed one", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true });

    const id = await queueEvent(t, userId, "evt-refund");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      // "posted" is the merchant's word for it; only the user can confirm.
      parsed: refundEmail([
        { itemName: "wool scarf", amount: 40, currency: "USD", state: "posted" },
      ]),
    });

    const claims = await claimsOn(t, itemId);
    expect(claims).toHaveLength(1);
    const detail = await as.query(api.claims.get, { claimId: claims[0]._id });
    expect(detail.events.map((e) => e.kind)).toEqual(["promised_credit"]);
    expect(detail.balance).toMatchObject({ promised: 4_000, confirmed: 0, unresolved: 4_000 });
    expect(detail.claim.status).toBe("promised");
    expect((await eventRow(t, id)).status).toBe("succeeded");
  });

  it("is idempotent: the same event applied twice credits once", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true });
    const id = await queueEvent(t, userId, "evt-twice");
    const parsed = refundEmail([
      { itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" },
    ]);

    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "received" }));
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });

    const claims = await claimsOn(t, itemId);
    expect(claims).toHaveLength(1);
    const detail = await as.query(api.claims.get, { claimId: claims[0]._id });
    expect(detail.events).toHaveLength(1);
  });

  it("never marks an item returned and opens no claim for one the user has not (D15)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: false });

    const id = await queueEvent(t, userId, "evt-notreturned");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([
        { itemName: "wool scarf", amount: 40, currency: "USD", state: "posted" },
      ]),
    });

    const item = await t.run(async (ctx) => await ctx.db.get(itemId));
    expect(item?.returned).toBe(false);
    expect(await claimsOn(t, itemId)).toHaveLength(0);
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("not marked returned");
  });

  it("refuses to guess when an unnamed credit matches no single returned item", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true, unitCents: 4_000 });

    const id = await queueEvent(t, userId, "evt-ambiguous");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      // No item name, and 12.50 matches nothing we hold.
      parsed: refundEmail([{ itemName: null, amount: 12.5, currency: "USD", state: "promised" }]),
    });

    expect(await claimsOn(t, itemId)).toHaveLength(0);
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("could not be matched");
  });

  it("attributes an unnamed credit to the one returned item whose total matches", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true, unitCents: 4_000 });

    const id = await queueEvent(t, userId, "evt-byamount");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: null, amount: 40, currency: "USD", state: "promised" }]),
    });

    expect(await claimsOn(t, itemId)).toHaveLength(1);
    expect((await eventRow(t, id)).status).toBe("succeeded");
  });

  it("flags a refund that matches none of the caller's purchases", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-nopurchase");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: "scarf", amount: 40, currency: "USD", state: "promised" }]),
    });
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("could not be matched to one of your purchases");
  });

  it("never reaches another user's purchase", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const { itemId } = await purchaseWithItem(t, a.as, { returned: true });

    const id = await queueEvent(t, b.userId, "evt-cross");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([
        { itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" },
      ]),
    });
    expect(await claimsOn(t, itemId)).toHaveLength(0);
    expect((await eventRow(t, id)).status).toBe("needs_review");
  });

  it("sends an email that is neither an order nor a refund to review", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-other");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: { kind: "other", order: null, refund: null, confidence: 0.4 },
    });
    expect((await eventRow(t, id)).status).toBe("needs_review");
  });
});

describe("intake — paste, retry and the attention list", () => {
  it("dedupes a repeated paste by content hash (D14)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const args = { userId, externalId: "paste:deadbeef", text: "Order confirmation…" };
    const first = await t.mutation(internal.intake.createPasteEvent, args);
    const second = await t.mutation(internal.intake.createPasteEvent, args);
    expect(second).toBe(first);
    const rows = await t.run(async (ctx) => await ctx.db.query("processedEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("paste");
  });

  it("refuses to hand one user the row another user's identical paste created", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const args = { externalId: "paste:deadbeef", text: "Order confirmation…" };
    await t.mutation(internal.intake.createPasteEvent, { ...args, userId: a.userId });
    await expect(
      t.mutation(internal.intake.createPasteEvent, { ...args, userId: b.userId }),
    ).rejects.toThrow(ConvexError);
  });

  it("rejects a paste that is too short to be an email", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.action(api.intake.paste, { text: "refund pls" })).rejects.toThrow(ConvexError);
  });

  it("requires a signed-in caller to paste", async () => {
    const t = setup();
    await expect(
      t.action(api.intake.paste, { text: "x".repeat(200) }),
    ).rejects.toThrow(ConvexError);
  });

  it("lists only the caller's unfinished events and re-queues one on retry", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");

    const mine = await queueEvent(t, a.userId, "evt-mine");
    await t.run(async (ctx) => await ctx.db.patch(mine, { status: "failed", lastError: "boom" }));
    const done = await queueEvent(t, a.userId, "evt-done");
    await t.run(async (ctx) => await ctx.db.patch(done, { status: "succeeded" }));
    const theirs = await queueEvent(t, b.userId, "evt-theirs");
    await t.run(async (ctx) => await ctx.db.patch(theirs, { status: "failed" }));

    const list = await a.as.query(api.intake.needsAttention, {});
    expect(list.map((r) => r.externalId)).toEqual(["evt-mine"]);

    await a.as.mutation(api.intake.retryEvent, { processedEventId: mine });
    const row = await eventRow(t, mine);
    expect(row.status).toBe("received");
    expect(row.lastError).toBeUndefined();
    expect(row.attempts).toBe(0);
    expect(await a.as.query(api.intake.needsAttention, {})).toHaveLength(0);
  });

  it("will not let one user retry another user's event", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const id = await queueEvent(t, a.userId, "evt-owned");
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed" }));
    await expect(
      b.as.mutation(api.intake.retryEvent, { processedEventId: id }),
    ).rejects.toThrow(ConvexError);
  });
});

describe("intake.beginEvent", () => {
  it("claims a received row once and stops after too many attempts", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-begin");

    const first = await t.mutation(internal.intake.beginEvent, { processedEventId: id });
    expect(first).toMatchObject({ userId, from: "f@x.example" });
    // Already `processing`: a second worker gets nothing.
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();

    await t.run(async (ctx) => await ctx.db.patch(id, { status: "received", attempts: 5 }));
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    expect((await eventRow(t, id)).status).toBe("failed");
  });

  it("records a processing failure without losing the event", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-fail");
    await t.mutation(internal.intake.failEvent, { processedEventId: id, lastError: "openai: 500" });
    const row = await eventRow(t, id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("openai: 500");
  });
});
