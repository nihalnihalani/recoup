import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { DAILY_BUDGETS, GLOBAL_DAILY_BUDGETS } from "./limits";
import { BUDGET_PAUSED_SUMMARY, PER_USER_BUDGET_PAUSED_SUMMARY } from "./intake";

// `createPasteEvent` and `retryEvent` schedule `processEvent`, which would
// call OpenAI. Fake timers keep convex-test from running it (D31).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type T = ReturnType<typeof setup>;

/** A queued intake event, as `inbound.onMessageReceived` would have left it. */
async function queueEvent(t: T, userId: Id<"users">, externalId = "evt-1") {
  // D174 (lead-approved fixture change, M13 / SEC-AI-6): the fixture models the account holder forwarding their own
  // mail, so the queued user's account email is the fixture's `from` address.
  await t.run(async (ctx) => await ctx.db.patch(userId, { email: "f@x.example" }));
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

  it("anchors a date-only order date at noon UTC, so it reads as the same day west of Greenwich", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-tz");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({ purchasedAt: "2026-09-01" }),
    });
    const board = await as.query(api.purchases.board, {});
    const stored = board.purchases[0].purchase.purchasedAt as number;

    // Midnight UTC would be Aug 31 in the Americas, which is what this fixes.
    expect(new Date(stored).toISOString()).toBe("2026-09-01T12:00:00.000Z");
    // Noon UTC holds the calendar day from UTC-12 to UTC+11, which covers every American and
    // European zone. It still rolls a day forward at UTC+12 and beyond (New Zealand, Kiribati);
    // no single instant can represent a bare date everywhere, and erring east of Greenwich is
    // the right trade when the orders we read are overwhelmingly American.
    for (const offsetHours of [-12, -11, -7, 0, 5.5, 11]) {
      const local = new Date(stored + offsetHours * 3_600_000);
      expect(local.toISOString().slice(0, 10)).toBe("2026-09-01");
    }
  });

  it("trusts an order date that already states a time", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-tz-exact");
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: id,
      parsed: orderEmail({ purchasedAt: "2026-09-01T03:30:00.000Z" }),
    });
    const board = await as.query(api.purchases.board, {});
    expect(new Date(board.purchases[0].purchase.purchasedAt as number).toISOString()).toBe(
      "2026-09-01T03:30:00.000Z",
    );
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
      items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
    });
    // F-AUD-9: `purchases.create` no longer accepts a client `isExample` arg
    // (examples are seeded only by `examples.ts`'s direct `db.insert`) -- set
    // it directly in the DB here, the same way that loader does.
    await t.run((ctx) => ctx.db.patch(purchaseId, { isExample: true }));
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

// ---------------------------------------------------------------------------
// D115 6b-3 (checkpoint 6b F3a, ported from the reviewer's scratchpad
// da6b.test.ts): every intake writer refuses for a tombstoned owner instead
// of resurrecting purchases/items for a deleted account. Each case here
// fails against the pre-T18.2 code (the public `paste` used to succeed and
// `beginEvent`/`applyExtraction` used to process the row normally -- the
// repro's own `expect(purchases).toHaveLength(1)` documented that a deleted
// account could own a purchase again) and passes once the gates land.
// ---------------------------------------------------------------------------
describe("intake tombstone gate (D115 6b-3, checkpoint 6b F3a)", () => {
  async function tombstone(t: T, userId: Id<"users">) {
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
  }

  it("paste for a tombstoned account throws and writes no processedEvents row", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await tombstone(t, userId);

    const text = "Order confirmation from Acme.\n" + "1x Jacket $80.00\n".repeat(20);
    await expect(as.action(api.intake.paste, { text })).rejects.toThrow(ConvexError);

    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows).toHaveLength(0);
  });

  it("createPasteEvent refuses directly for a tombstoned account (defense in depth): nothing is written", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await tombstone(t, userId);

    await expect(
      t.mutation(internal.intake.createPasteEvent, { userId, externalId: "paste:deadbeef", text: "Order confirmation…" }),
    ).rejects.toThrow(ConvexError);
    expect(await t.run((ctx) => ctx.db.query("processedEvents").collect())).toHaveLength(0);
  });

  it("beginEvent closes a tombstoned owner's row as succeeded/'Ignored: account deleted' instead of processing it", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-tombstoned");
    await tombstone(t, userId);

    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    const row = await eventRow(t, id);
    expect(row.status).toBe("succeeded");
    expect(row.summary).toBe("Ignored: account deleted");
  });

  it("applyExtraction refuses directly for a tombstoned owner's row: no purchases/items are created", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-tombstoned-2");
    await tombstone(t, userId);

    await t.mutation(internal.intake.applyExtraction, { processedEventId: id, parsed: orderEmail() });

    const purchases = await t.run((ctx) =>
      ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(purchases).toHaveLength(0);
    const row = await eventRow(t, id);
    expect(row.status).toBe("succeeded");
    expect(row.summary).toBe("Ignored: account deleted");
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

/** Exhausts the deployment-wide `inbound_extract` switch (D76) for "today," however the current test's clock reads it. */
async function exhaustInboundExtractBudget(t: T) {
  await t.run(async (ctx) => {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    await ctx.db.insert("usage", { day, kind: "inbound_extract", count: GLOBAL_DAILY_BUDGETS.inbound_extract.max });
  });
}

describe("intake.beginEvent — D76 global inbound_extract budget (Invariant 10)", () => {
  it("a refused global budget parks the row needs_review, never failed, and spends no attempt", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-budget");
    await exhaustInboundExtractBudget(t);

    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toBe(BUDGET_PAUSED_SUMMARY);
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeUndefined();
  });

  it("does not touch the budget-paused row's own board-facing errorSummary or lastError", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-budget-board");
    await exhaustInboundExtractBudget(t);
    await t.mutation(internal.intake.beginEvent, { processedEventId: id });

    const [row] = await as.query(api.intake.needsAttention, {});
    expect(row.summary).toBe(BUDGET_PAUSED_SUMMARY);
    expect(row.errorSummary).toBeUndefined();
  });
});

/** Exhausts one user's own `inbound_extract` cap for "today" (D112 6a-2), without touching the global switch. */
async function exhaustPerUserInboundExtractBudget(t: T, userId: Id<"users">) {
  await t.run(async (ctx) => {
    const day = new Date(Date.now()).toISOString().slice(0, 10);
    await ctx.db.insert("usage", { userId, day, kind: "inbound_extract", count: DAILY_BUDGETS.inbound_extract.max });
  });
}

describe("intake.beginEvent — D112 6a-2 per-user inbound_extract budget", () => {
  it("a refused per-user budget parks the row needs_review with a distinct summary, no global marker, and spends no attempt", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-user-budget");
    await exhaustPerUserInboundExtractBudget(t, userId);

    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    const row = await eventRow(t, id);
    expect(row.status).toBe("needs_review");
    expect(row.summary).toBe(PER_USER_BUDGET_PAUSED_SUMMARY);
    expect(row.summary).not.toBe(BUDGET_PAUSED_SUMMARY);
    expect(row.attempts).toBe(0);
    expect(row.lastError).toBeUndefined();

    // The global switch is untouched: a fresh usage row for it does not exist yet.
    const globalRow = await t.run(async (ctx) => {
      const day = new Date(Date.now()).toISOString().slice(0, 10);
      return await ctx.db
        .query("usage")
        .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", day).eq("kind", "inbound_extract"))
        .first();
    });
    expect(globalRow?.count ?? 0).toBe(0);
  });

  it("one user's exhausted per-user cap does not pause another user's intake (one known inbox cannot pause everyone, D112 6a-2)", async () => {
    const t = setup();
    const { userId: capped } = await signedIn(t, "Capped");
    const { userId: other } = await signedIn(t, "Other");
    await exhaustPerUserInboundExtractBudget(t, capped);

    const cappedId = await queueEvent(t, capped, "evt-capped");
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: cappedId })).toBeNull();
    expect((await eventRow(t, cappedId)).summary).toBe(PER_USER_BUDGET_PAUSED_SUMMARY);

    const otherId = await queueEvent(t, other, "evt-other");
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: otherId })).not.toBeNull();
    expect((await eventRow(t, otherId)).status).toBe("processing");
  });

  it("the per-user cap is checked before the global one: a per-user refusal never touches the global switch even when it too is exhausted", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await exhaustPerUserInboundExtractBudget(t, userId);
    await exhaustInboundExtractBudget(t);
    const id = await queueEvent(t, userId, "evt-both-capped");

    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    // The per-user summary wins: it is checked first, so this row's cause is
    // its own cap, not the (also exhausted) global one.
    expect((await eventRow(t, id)).summary).toBe(PER_USER_BUDGET_PAUSED_SUMMARY);
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

  it("D76: picks up a budget-paused needs_review row hourly, without spending one of its attempts", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-budget-retry");
    await exhaustInboundExtractBudget(t);
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: id })).toBeNull();
    expect((await eventRow(t, id)).status).toBe("needs_review");

    const res = await t.mutation(internal.intake.retryFailed, {});
    expect(res.retried).toBe(1);
    const row = await eventRow(t, id);
    expect(row.status).toBe("received");
    expect(row.attempts).toBe(0); // a budget refusal is never counted as a failed attempt (Invariant 10)
    expect(row.summary).toBeUndefined();
  });

  it("D76: a needs_review row from an ordinary (non-budget) reason is left alone", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-ordinary-review");
    await t.run(async (ctx) => await ctx.db.patch(id, { status: "needs_review", summary: "Duplicate of an existing purchase." }));
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    expect((await eventRow(t, id)).status).toBe("needs_review");
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

  it("D87 (D103): a tombstoned owner's failed row is closed, not retried, and does not block a live row behind it", async () => {
    const t = setup();
    const { userId: gone } = await signedIn(t, "Gone");
    const { userId: live } = await signedIn(t, "Live");
    // A full page of a tombstoned user's failed rows, older than the live one.
    for (let i = 0; i < 50; i++) {
      const id = await queueEvent(t, gone, `evt-gone-${i}`);
      await t.run(async (ctx) => await ctx.db.patch(id, { status: "failed", attempts: 1 }));
    }
    await t.run((ctx) => ctx.db.insert("accountState", { userId: gone, status: "deleting", requestedAt: Date.now(), attempts: 0 }));
    const liveId = await queueEvent(t, live, "evt-live");
    await t.run(async (ctx) => await ctx.db.patch(liveId, { status: "failed", attempts: 1 }));

    // Tick 1: the tombstoned backlog fills the page and is closed out (never
    // scheduled a retry) -- unlike before this fix, where it would have been
    // left untouched and re-read on every subsequent tick, the same
    // starvation shape F1/F2 fixed for the price/watch sweeps.
    const first = await t.mutation(internal.intake.retryFailed, {});
    expect(first.retried).toBe(0);
    const oneOfGone = await eventRow(t, await t.run(async (ctx) => {
      const row = await ctx.db
        .query("processedEvents")
        .withIndex("by_user_status", (q) => q.eq("userId", gone).eq("status", "succeeded"))
        .first();
      if (!row) throw new Error("expected a closed row for the tombstoned user");
      return row._id;
    }));
    expect(oneOfGone.summary).toBe("Ignored: account deleted");
    expect((await eventRow(t, liveId)).status).toBe("failed"); // not yet reached

    // Tick 2: the backlog has left the `failed` page; the live row is retried.
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 1 });
    expect((await eventRow(t, liveId)).status).toBe("received");
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

  describe("D112 6a-2: the budget-paused pass is per-user round-robin, not first-come", () => {
    /** Seeds one `needs_review` row already paused by a budget refusal, oldest-created-first like the real writers leave them. */
    async function pausedRow(t: T, userId: Id<"users">, externalId: string, summary: string) {
      const id = await queueEvent(t, userId, externalId);
      await t.run((ctx) => ctx.db.patch(id, { status: "needs_review", summary }));
      return id;
    }

    it("DA repro: a 60-row flood from one user does not starve a single older row from a different user in the first pass", async () => {
      const t = setup();
      const { userId: victim } = await signedIn(t, "Victim");
      const { userId: flooder } = await signedIn(t, "Flooder");

      // The victim's row is created (and thus paused) FIRST, so it is the
      // OLDEST row and would be the LAST one reached by a naive "newest N"
      // page once the flooder's 60 newer rows are in front of it.
      const victimId = await pausedRow(t, victim, "evt-victim", BUDGET_PAUSED_SUMMARY);
      for (let i = 0; i < 60; i++) {
        await pausedRow(t, flooder, `evt-flood-${i}`, BUDGET_PAUSED_SUMMARY);
      }

      const res = await t.mutation(internal.intake.retryFailed, {});
      // Bounded at 50 total, but the victim's single row is still among them.
      expect(res.retried).toBeLessThanOrEqual(50);
      expect((await eventRow(t, victimId)).status).toBe("received");
    });

    it("caps any one user's share of the pass at 5, leaving room for other users' rows in the same pass", async () => {
      const t = setup();
      const { userId: hog } = await signedIn(t, "Hog");
      const { userId: other } = await signedIn(t, "Other");
      const hogIds = [];
      for (let i = 0; i < 10; i++) {
        hogIds.push(await pausedRow(t, hog, `evt-hog-${i}`, PER_USER_BUDGET_PAUSED_SUMMARY));
      }
      const otherId = await pausedRow(t, other, "evt-other", PER_USER_BUDGET_PAUSED_SUMMARY);

      await t.mutation(internal.intake.retryFailed, {});

      const hogRetried = (
        await Promise.all(hogIds.map((id) => eventRow(t, id)))
      ).filter((r) => r.status === "received").length;
      expect(hogRetried).toBe(5);
      expect((await eventRow(t, otherId)).status).toBe("received");
    });

    it("a mix of the global and per-user summaries are both retried by the same round-robin pass", async () => {
      const t = setup();
      const { userId: a } = await signedIn(t, "A");
      const { userId: b } = await signedIn(t, "B");
      const globalId = await pausedRow(t, a, "evt-global", BUDGET_PAUSED_SUMMARY);
      const perUserId = await pausedRow(t, b, "evt-per-user", PER_USER_BUDGET_PAUSED_SUMMARY);

      await t.mutation(internal.intake.retryFailed, {});

      expect((await eventRow(t, globalId)).status).toBe("received");
      expect((await eventRow(t, perUserId)).status).toBe("received");
    });
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

    // T16: `beginEvent` above already drew one unit of the global
    // `inbound_extract` switch (D76) for the extraction that ran -- that is
    // the correct, expected charge for real work done, not what this test
    // guards. What matters here is that the REJECTED retry below charges
    // nothing ON TOP of that.
    const before = await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length);
    await expect(as.mutation(api.intake.retryEvent, { processedEventId: id })).rejects.toThrow(/already on your board/);
    expect(await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length)).toBe(before);
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
      ["_creationTime", "_id", "attempts", "errorSummary", "externalId", "kind", "route", "status", "userId"].sort(),
    );
  });

  /**
   * T16 (docs/reviews/2026-09-21-phase0-reproduction.md's phase-0 finding,
   * convex/intake.ts:847/877): `needsAttention` used to spread the raw
   * `lastError` straight through the wire -- the payload-only redaction
   * never actually stripped it. It is now never present in the response
   * (kept `v.optional` only so unrelated frontend code that reads it as a
   * fallback keeps typechecking), and a row with a raw `lastError` but no
   * `errorSummary` yet (e.g. one written directly, bypassing `failEvent`'s
   * own D58 sanitization) is sanitized here instead of ever going out raw.
   */
  it("needsAttention never exposes the raw lastError, even for a row missing errorSummary (T16)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await queueEvent(t, userId, "evt-raw-error");
    await t.run(
      async (ctx) => await ctx.db.patch(id, { status: "failed", lastError: "openai: 500 something exploded" }),
    );
    const [row] = await as.query(api.intake.needsAttention, {});
    expect(row._id).toBe(id);
    expect(row.lastError).toBeUndefined();
    expect(row.errorSummary).toBe("Provider error");
  });
});
