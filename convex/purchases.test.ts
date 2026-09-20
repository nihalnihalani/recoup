import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

const basePurchase = {
  merchant: "Northwind Outfitters",
  merchantDomain: "northwind.example",
  orderRef: "NW-1001",
  purchasedAt: Date.UTC(2026, 7, 25),
  currency: "USD",
  items: [
    { name: "Merino sweater", unitCents: 8000, qty: 1, productUrl: "https://northwind.example/p/sweater" },
    { name: "Wool scarf", unitCents: 4000, qty: 1 },
  ],
};

describe("purchases", () => {
  it("creates a purchase with items owned by the caller", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got?.purchase.userId).toBe(userId);
    expect(got?.items).toHaveLength(2);
    expect(got?.items[1].unitCents).toBe(4000);
  });

  it("hides another user's purchase", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const id = await alice.mutation(api.purchases.create, basePurchase);
    await expect(bob.query(api.purchases.get, { purchaseId: id })).rejects.toThrow();
    const bobsBoard = await bob.query(api.purchases.board, {});
    expect(bobsBoard.purchases).toHaveLength(0);
  });

  it("marks an item returned", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    await as.mutation(api.purchases.setReturned, {
      itemId: got!.items[0]._id,
      returned: true,
      returnedAt: Date.UTC(2026, 7, 28),
    });
    const after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after!.items[0].returned).toBe(true);
  });

  it("rejects unauthenticated calls", async () => {
    const t = setup();
    await expect(t.mutation(api.purchases.create, basePurchase)).rejects.toThrow();
  });

  it("rejects non-integer unitCents", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        ...basePurchase,
        items: [{ name: "Sweater", unitCents: 80.5, qty: 1 }],
      }),
    ).rejects.toThrow();
  });

  it("rejects qty 0", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        ...basePurchase,
        items: [{ name: "Sweater", unitCents: 8000, qty: 0 }],
      }),
    ).rejects.toThrow();
  });

  it('rejects currency "usd"', async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, { ...basePurchase, currency: "usd" }),
    ).rejects.toThrow();
  });

  it("active purchase without purchasedAt is rejected", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { purchasedAt: _purchasedAt, ...rest } = basePurchase;
    await expect(as.mutation(api.purchases.create, { ...rest })).rejects.toThrow();
    await expect(
      as.mutation(api.purchases.create, { ...rest, status: "active" as const }),
    ).rejects.toThrow();
    // needs_review does not require purchasedAt.
    const id = await as.mutation(api.purchases.create, {
      ...rest,
      status: "needs_review" as const,
    });
    expect(id).toBeTruthy();
  });

  it("confirm rejects an item from another purchase", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseAId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      status: "needs_review" as const,
      purchasedAt: undefined,
    });
    const purchaseBId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      status: "needs_review" as const,
      purchasedAt: undefined,
    });
    const gotB = await as.query(api.purchases.get, { purchaseId: purchaseBId });
    await expect(
      as.mutation(api.purchases.confirm, {
        purchaseId: purchaseAId,
        merchant: basePurchase.merchant,
        merchantDomain: basePurchase.merchantDomain,
        orderRef: basePurchase.orderRef,
        purchasedAt: basePurchase.purchasedAt,
        items: [
          {
            itemId: gotB!.items[0]._id,
            name: gotB!.items[0].name,
            unitCents: gotB!.items[0].unitCents,
            qty: gotB!.items[0].qty,
          },
        ],
      }),
    ).rejects.toThrow();
  });

  it("board totals exclude example purchases", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const realId = await as.mutation(api.purchases.create, basePurchase);
    const realGot = await as.query(api.purchases.get, { purchaseId: realId });
    await t.run(async (ctx) => {
      await ctx.db.insert("claims", {
        purchaseId: realId,
        itemId: realGot!.items[0]._id,
        userId,
        type: "return_credit",
        expectedCents: 1000,
        status: "sent",
        token: "AAA111",
        version: 1,
      });
    });

    const exampleId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      isExample: true,
    });
    const exampleGot = await as.query(api.purchases.get, { purchaseId: exampleId });
    await t.run(async (ctx) => {
      await ctx.db.patch(exampleId, { isExample: true });
      await ctx.db.insert("claims", {
        purchaseId: exampleId,
        itemId: exampleGot!.items[0]._id,
        userId,
        type: "return_credit",
        expectedCents: 5000,
        status: "sent",
        token: "BBB222",
        version: 1,
        isExample: true,
      });
    });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(2);
    expect(board.totals.owed).toBe(1000);
    expect(board.totals.asked).toBe(1000);
    expect(board.totals.confirmed).toBe(0);
    const exampleRow = board.purchases.find((r) => r.purchase._id === exampleId);
    expect(exampleRow?.purchase.isExample).toBe(true);
  });

  it("board attention lists failed and needs_review events for the caller only", async () => {
    const t = setup();
    const { as: alice, userId: aliceId } = await signedIn(t, "Alice");
    const { userId: bobId } = await signedIn(t, "Bob");
    await t.run(async (ctx) => {
      await ctx.db.insert("processedEvents", {
        externalId: "a-failed",
        kind: "order",
        status: "failed",
        attempts: 1,
        lastError: "boom",
        userId: aliceId,
      });
      await ctx.db.insert("processedEvents", {
        externalId: "a-needs-review",
        kind: "refund",
        status: "needs_review",
        attempts: 1,
        summary: "could not match",
        userId: aliceId,
      });
      await ctx.db.insert("processedEvents", {
        externalId: "a-succeeded",
        kind: "order",
        status: "succeeded",
        attempts: 1,
        userId: aliceId,
      });
      await ctx.db.insert("processedEvents", {
        externalId: "b-failed",
        kind: "order",
        status: "failed",
        attempts: 1,
        userId: bobId,
      });
    });
    const board = await alice.query(api.purchases.board, {});
    expect(board.attention).toHaveLength(2);
    expect(board.attention.every((e) => ["failed", "needs_review"].includes(e.status))).toBe(true);
    expect(board.attention.some((e) => e.summary === "could not match")).toBe(true);
    expect(board.attention.some((e) => e.lastError === "boom")).toBe(true);
  });
});
