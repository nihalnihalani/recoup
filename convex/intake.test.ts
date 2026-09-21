import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { DAILY_BUDGETS } from "./limits";

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
    status: "active",
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

  it("drops just the one unusable item out of several, and says so in the summary (D58)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-partial-items");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({
        items: [
          { name: "Wool scarf", unitPrice: 79.99, qty: 1, productUrl: null },
          { name: "Phantom hat", unitPrice: Infinity, qty: 1, productUrl: null },
        ],
      }),
    });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(1);
    expect(board.purchases[0].items).toHaveLength(1);
    expect(board.purchases[0].items[0].name).toBe("Wool scarf");

    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("Phantom hat");
  });

  it("F4: drops a productUrl that does not parse as a real product link, but keeps the item", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-bad-url");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({
        items: [
          { name: "Wool scarf", unitPrice: 79.99, qty: 1, productUrl: "javascript:alert(1)" },
          { name: "Wool hat", unitPrice: 19.99, qty: 1, productUrl: "https://nordstrom.com/s/2" },
        ],
      }),
    });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(1);
    const items = board.purchases[0].items;
    expect(items.find((i) => i.name === "Wool scarf")?.productUrl).toBeUndefined();
    expect(items.find((i) => i.name === "Wool hat")?.productUrl).toBe("https://nordstrom.com/s/2");

    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
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

  it("flags a non-positive credit amount as needs_review rather than throwing (D58)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true });

    const id = await queueEvent(t, userId, "evt-bad-credit");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: "wool scarf", amount: 0, currency: "USD", state: "promised" }]),
    });

    expect(await claimsOn(t, itemId)).toHaveLength(0);
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("unreadable amount");
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

  it("skips a purchase that is not active (D55)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    // needs_review, never confirmed to active -- not eligible for refund matching.
    await as.mutation(api.purchases.create, {
      merchant: "Nordstrom",
      merchantDomain: "nordstrom.com",
      orderRef: "ORD-1",
      currency: "USD",
      status: "needs_review",
      items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
    });

    const id = await queueEvent(t, userId, "evt-inactive");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" }]),
    });
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("could not be matched to one of your purchases");
  });

  it("skips an isExample purchase unless the refund's own merchant says (example) (D55)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Nordstrom",
      merchantDomain: "nordstrom.com",
      orderRef: "ORD-1",
      purchasedAt: Date.parse("2026-09-01"),
      currency: "USD",
      status: "active",
      isExample: true,
      items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
    });
    const detail = await as.query(api.purchases.get, { purchaseId });
    await as.mutation(api.purchases.setReturned, { itemId: detail.items[0]._id, returned: true });

    const idNoLabel = await queueEvent(t, userId, "evt-example-unlabeled");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: idNoLabel,
      parsed: refundEmail([{ itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" }]),
    });
    expect((await eventRow(t, idNoLabel)).status).toBe("needs_review");
    expect(await claimsOn(t, detail.items[0]._id)).toHaveLength(0);

    const idLabeled = await queueEvent(t, userId, "evt-example-labeled");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: idLabeled,
      parsed: refundEmail(
        [{ itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" }],
        { merchant: "Nordstrom (example)" },
      ),
    });
    expect((await eventRow(t, idLabeled)).status).toBe("succeeded");
    const claims = await claimsOn(t, detail.items[0]._id);
    expect(claims).toHaveLength(1);
    expect(claims[0].isExample).toBe(true);
  });

  it("prefers an exact merchant match over inclusion when both are otherwise ambiguous (D55)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const exact = await as.mutation(api.purchases.create, {
      merchant: "Nordstrom",
      merchantDomain: "nordstrom.com",
      purchasedAt: Date.parse("2026-09-01"),
      currency: "USD",
      status: "active",
      items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
    });
    await as.mutation(api.purchases.create, {
      merchant: "Nordstrom Rack",
      merchantDomain: "nordstromrack.com",
      purchasedAt: Date.parse("2026-09-01"),
      currency: "USD",
      status: "active",
      items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
    });
    const exactDetail = await as.query(api.purchases.get, { purchaseId: exact });
    const exactItemId = exactDetail.items[0]._id;
    await as.mutation(api.purchases.setReturned, { itemId: exactItemId, returned: true });

    const id = await queueEvent(t, userId, "evt-exact-merchant");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      // No orderRef, so matching falls to merchant name; "Nordstrom" is an
      // exact hit on one purchase and a substring hit on both.
      parsed: refundEmail(
        [{ itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" }],
        { orderRef: null },
      ),
    });
    expect((await eventRow(t, id)).status).toBe("succeeded");
    expect(await claimsOn(t, exactItemId)).toHaveLength(1);
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

  it("marks only the conflicting credit needs_review and does not fail or roll back the event (D54)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithItem(t, as, { returned: true });
    const id = await queueEvent(t, userId, "evt-conflict");

    // First pass records the promised credit normally.
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: "wool scarf", amount: 40, currency: "USD", state: "promised" }]),
    });
    expect((await eventRow(t, id)).status).toBe("succeeded");

    // A retry of the *same* event (same external message id) now proposes a
    // different amount for the same credit position -- a genuine
    // idempotency conflict, not a harmless re-apply.
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "received" }));
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: refundEmail([{ itemName: "wool scarf", amount: 50, currency: "USD", state: "promised" }]),
    });

    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toContain("needs review");

    // The original ledger event is untouched -- no rollback, no double-write.
    const claims = await claimsOn(t, itemId);
    expect(claims).toHaveLength(1);
    const detail = await as.query(api.claims.get, { claimId: claims[0]._id });
    expect(detail.events).toHaveLength(1);
    expect(detail.balance.promised).toBe(4_000);
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

  it("scopes the paste action's externalId per user, so two users pasting identical text don't collide (D54)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const text = "Order confirmation… ".repeat(5);

    const idA = await a.as.action(api.intake.paste, { text });
    const idB = await b.as.action(api.intake.paste, { text });
    expect(idA).not.toBe(idB);

    const rowA = await eventRow(t, idA);
    const rowB = await eventRow(t, idB);
    // The digest hashes `${userId}\n${body}`, so two different users pasting the
    // identical text get different externalIds and are never handed each other's row.
    expect(rowA.externalId).not.toBe(rowB.externalId);
    expect(rowA.userId).toBe(a.userId);
    expect(rowB.userId).toBe(b.userId);
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

  it(`F2: caps a user at ${DAILY_BUDGETS.paste.max} NEW pastes a day; a repeat of one on file is still free`, async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const paste = (i: number | string) => `Order confirmation email body padding text ${i}`;
    for (let i = 0; i < DAILY_BUDGETS.paste.max; i++) {
      await expect(as.action(api.intake.paste, { text: paste(i) })).resolves.toBeTruthy();
    }
    // A repeat of an already-processed paste is served from cache, not a new spend.
    await expect(as.action(api.intake.paste, { text: paste(0) })).resolves.toBeTruthy();

    await expect(as.action(api.intake.paste, { text: paste("brand new") })).rejects.toThrow(ConvexError);
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
    const gaveUp = await eventRow(t, id);
    expect(gaveUp.status).toBe("failed");
    // D58: a sanitized, user-safe summary is written alongside the raw error.
    expect(gaveUp.errorSummary).toBe("Something went wrong");
  });

  it("records a processing failure without losing the event, and sanitizes it for the board (D58)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-fail");
    await t.mutation(internal.intake.failEvent, { processedEventId: id, lastError: "openai: 500" });
    const row = await eventRow(t, id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("openai: 500");
    expect(row.errorSummary).toBe("Provider error");
  });
});

describe("intake.retryFailed (hourly safety net)", () => {
  it("re-queues a failed intake row that has attempts left and parks an exhausted one for review (H4)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const retryable = await queueEvent(t, userId, "evt-retry");
    const exhausted = await queueEvent(t, userId, "evt-done");
    await t.run(async (ctx) => {
      await ctx.db.patch(retryable, { status: "failed", attempts: 1, lastError: "OpenAI 429" });
      await ctx.db.patch(exhausted, { status: "failed", attempts: 5, lastError: "Gave up after 5 attempts" });
    });

    const res = await t.mutation(internal.intake.retryFailed, {});
    expect(res).toEqual({ unstuck: 0, retried: 1 });

    const again = await eventRow(t, retryable);
    expect(again.status).toBe("received");
    expect(again.lastError).toBeUndefined();
    // H4: an exhausted row leaves the `failed` page, stays on the owner's list, and is not re-run.
    const parked = await eventRow(t, exhausted);
    expect(parked.status).toBe("needs_review");
    expect(parked.summary).toContain("5 attempts");
    expect(parked.attempts).toBe(5);
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
  });

  it("dead rows do not block newer failures behind them (H4)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    // 50 rows nobody can re-run automatically fill the whole page the job reads...
    for (let i = 0; i < 50; i++) {
      const id = await queueEvent(t, userId, `evt-dead-${i}`);
      await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed", attempts: 5 }));
    }
    // ...and a retryable failure arrives after them.
    const live = await queueEvent(t, userId, "evt-live");
    await t.run(async (ctx) => await ctx.db.patch(live, { status: "failed", attempts: 1 }));

    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    expect((await eventRow(t, live)).status).toBe("failed");
    // The first tick cleared the page, so the second one reaches the live row.
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 1 });
    expect((await eventRow(t, live)).status).toBe("received");
  });

  it("parks a failed row that has an owner but nothing to re-run", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await t.run(
      async (ctx) =>
        await ctx.db.insert("processedEvents", {
          externalId: "evt-unrouted", kind: "agentmail.message.received", status: "failed", attempts: 0, userId,
        }),
    );
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    expect((await eventRow(t, id)).status).toBe("needs_review");
  });

  it("does not fail or double-schedule an OLD row that re-entered processing a moment ago (H5)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const old = await queueEvent(t, userId, "evt-old");
    // The row is a day old...
    vi.advanceTimersByTime(24 * 3_600_000);
    // ...and a retry has just put it back to work.
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: old })).not.toBeNull();
    const started = (await eventRow(t, old)).processingStartedAt;
    expect(started).toBe(Date.now());

    vi.advanceTimersByTime(60_000);
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    expect((await eventRow(t, old)).status).toBe("processing");

    // Only once THIS run has been going for 15 minutes is it stuck.
    vi.advanceTimersByTime(15 * 60_000);
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 1, retried: 1 });
  });

  it("falls back to the creation time for a processing row written before processingStartedAt existed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const legacy = await queueEvent(t, userId, "evt-legacy");
    await t.run(async (ctx) => await ctx.db.patch(legacy, { status: "processing", attempts: 1 }));
    vi.advanceTimersByTime(16 * 60_000);
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 1, retried: 1 });
  });

  it("marks a row stuck in processing as failed so it becomes visible and retryable", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId } = await signedIn(t);
    const fresh = await queueEvent(t, userId, "evt-fresh");
    await t.run(async (ctx) => await ctx.db.patch(fresh, { status: "processing", attempts: 1 }));

    // Inside the grace period nothing happens.
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });

    vi.advanceTimersByTime(16 * 60_000);
    const res = await t.mutation(internal.intake.retryFailed, {});
    // Unstuck and, having attempts left, re-queued in the same tick.
    expect(res).toEqual({ unstuck: 1, retried: 1 });
    const row = await eventRow(t, fresh);
    expect(row.status).toBe("received");
  });

  it("never re-runs a row that belongs to nobody, and closes it as ignored after a day (H4)", async () => {
    const t = setup();
    const orphan = await t.run(
      async (ctx) =>
        await ctx.db.insert("processedEvents", {
          externalId: "evt-orphan",
          kind: "agentmail.message.received",
          status: "failed",
          attempts: 0,
        }),
    );
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    expect((await eventRow(t, orphan)).status).toBe("failed");

    vi.advanceTimersByTime(25 * 3_600_000);
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    const closed = await eventRow(t, orphan);
    expect(closed.status).toBe("succeeded");
    expect(closed.summary).toBe("Ignored: no matching inbox");
  });
});

describe("intake spend caps (pre-launch review B5, M1, M5)", () => {
  const email = (n: number) => `Order confirmation number ${n} from Acme, thank you for your purchase of one jacket.`;

  it(`allows ${30} new pastes a day, refuses the next with nothing written, and resets at midnight UTC`, async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < 30; i++) {
      await t.mutation(internal.intake.createPasteEvent, { userId, externalId: `paste:${i}`, text: email(i) });
    }
    await expect(
      t.mutation(internal.intake.createPasteEvent, { userId, externalId: "paste:31", text: email(31) }),
    ).rejects.toThrow(/today's limit for reading pasted emails/);
    expect(await t.run(async (ctx) => (await ctx.db.query("processedEvents").collect()).length)).toBe(30);

    // A repeat of an earlier paste is not new work and is still answered.
    await t.mutation(internal.intake.createPasteEvent, { userId, externalId: "paste:0", text: email(0) });
    // Another user is unaffected.
    const other = await signedIn(t, "Other");
    await t.mutation(internal.intake.createPasteEvent, { userId: other.userId, externalId: "paste:o", text: email(0) });

    vi.advanceTimersByTime(24 * 3_600_000);
    await t.mutation(internal.intake.createPasteEvent, { userId, externalId: "paste:next-day", text: email(99) });
  });

  it("the same text pasted by two users is two separate events (userId is in the digest)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const text = email(1);
    const first = await a.as.action(api.intake.paste, { text });
    const second = await b.as.action(api.intake.paste, { text });
    expect(second).not.toBe(first);
    expect(await a.as.action(api.intake.paste, { text })).toBe(first);
    const rows = await t.run(async (ctx) => await ctx.db.query("processedEvents").collect());
    expect(new Set(rows.map((r) => r.externalId)).size).toBe(2);
  });

  it("retryEvent is budgeted at 20 a day and never resets attempts", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-r");
    for (let i = 0; i < 20; i++) {
      await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed", attempts: 3 }));
      await as.mutation(api.intake.retryEvent, { processedEventId: id });
      expect((await eventRow(t, id)).attempts).toBe(3);
    }
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed" }));
    await expect(as.mutation(api.intake.retryEvent, { processedEventId: id })).rejects.toThrow(
      /today's limit for re-reading emails/,
    );
    expect((await eventRow(t, id)).status).toBe("failed");
  });

  it("a manual retry of an exhausted row grants exactly one more attempt", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-x");
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "needs_review", attempts: 5 }));
    await as.mutation(api.intake.retryEvent, { processedEventId: id });
    expect((await eventRow(t, id)).attempts).toBe(4);
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).not.toBeNull();
    expect((await eventRow(t, id)).attempts).toBe(5);
  });

  it("refuses to re-run an order email that already became a purchase, and charges nothing", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-order");
    await t.mutation(internal.intake.beginEvent, { processedEventId: id });
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed: orderEmail({ orderRef: null }) });
    expect((await eventRow(t, id)).status).toBe("needs_review");

    await expect(as.mutation(api.intake.retryEvent, { processedEventId: id })).rejects.toThrow(/already on your board/);
    expect(await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length)).toBe(0);
  });

  it("applying the same order email twice inserts one purchase even with no orderRef (H5 race)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-twice");
    const parsed = orderEmail({ orderRef: null });
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });
    expect(await t.run(async (ctx) => (await ctx.db.query("purchases").collect()).length)).toBe(1);
    expect((await eventRow(t, id)).summary).toContain("already on your board");
  });

  it("a pasted order re-applied is recognised by its content hash", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await t.mutation(internal.intake.createPasteEvent, { userId, externalId: "paste:abc", text: email(1) });
    const parsed = orderEmail({ orderRef: null });
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });
    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed });
    const purchases = await t.run(async (ctx) => await ctx.db.query("purchases").collect());
    expect(purchases).toHaveLength(1);
    expect(purchases[0].sourceMessageId).toBe("paste:abc");
  });

  it("drops an extracted product link the scraper must never see, keeps a good one, and caps the items (M1)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-urls");
    const item = (name: string, productUrl: string | null) => ({ name, unitPrice: 10, qty: 1, productUrl });
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({
        items: [
          item("internal", "http://metadata.google.internal/computeMetadata/v1/"),
          item("ip", "http://169.254.169.254/latest/meta-data"),
          item("port", "https://shop.acme.example:8443/p/1"),
          item("good", "https://www.acme.example/p/jacket#reviews"),
          ...Array.from({ length: 60 }, (_, i) => item(`filler ${i}`, null)),
        ],
      }),
    });
    const items = await t.run(async (ctx) => await ctx.db.query("items").collect());
    expect(items).toHaveLength(50);
    const url = (name: string) => items.find((i) => i.name === name)?.productUrl;
    expect(url("internal")).toBeUndefined();
    expect(url("ip")).toBeUndefined();
    expect(url("port")).toBeUndefined();
    expect(url("good")).toBe("https://www.acme.example/p/jacket");
  });

  it("needsAttention never returns the stored email (M5)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-big");
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed", lastError: "boom", processingStartedAt: 1 }));
    const [row] = await as.query(api.intake.needsAttention, {});
    expect(row._id).toBe(id);
    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("processingStartedAt");
    expect(Object.keys(row).sort()).toEqual(
      ["_creationTime", "_id", "attempts", "externalId", "kind", "lastError", "route", "status", "userId"].sort(),
    );
  });
});
