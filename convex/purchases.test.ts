import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

/**
 * Seeds a claim directly. `purchases` must keep compiling and testing without
 * the claims module, so these tests never call `api.claims.*`.
 */
async function seedClaim(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  itemId: Id<"items">,
  opts: {
    expectedCents: number;
    status?: "detected" | "sent" | "queued" | "confirmed" | "dismissed";
    isExample?: boolean;
    confirmedCents?: number;
  },
) {
  return await t.run(async (ctx) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("item missing");
    const claimId = await ctx.db.insert("claims", {
      purchaseId: item.purchaseId,
      itemId,
      userId,
      type: "return_credit",
      expectedCents: opts.expectedCents,
      status: opts.status ?? "detected",
      token: Math.random().toString(36).slice(2, 8).toUpperCase(),
      version: 1,
      isExample: opts.isExample,
    });
    if (opts.confirmedCents) {
      await ctx.db.insert("ledgerEvents", {
        claimId,
        userId,
        kind: "confirmed_credit",
        cents: opts.confirmedCents,
        evidence: "statement",
      });
    }
    return claimId;
  });
}

async function scheduledPolicyFetches(t: ReturnType<typeof setup>) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("policies"));
  });
}

describe("purchases.create / get", () => {
  it("creates a purchase with items owned by the caller", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got.purchase.userId).toBe(userId);
    expect(got.items).toHaveLength(2);
    expect(got.items[1].unitCents).toBe(4000);
    expect(got.items[0].returned).toBe(false);
  });

  it("rejects unauthenticated calls", async () => {
    const t = setup();
    await expect(t.mutation(api.purchases.create, basePurchase)).rejects.toThrow();
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

  // D20: money is validated at the public boundary, not deep in the ledger.
  it("rejects bad money at the boundary (D20)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, { ...basePurchase, currency: "usd" }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.purchases.create, {
        ...basePurchase,
        items: [{ name: "x", unitCents: -1, qty: 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.purchases.create, {
        ...basePurchase,
        items: [{ name: "x", unitCents: 10.5, qty: 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.purchases.create, {
        ...basePurchase,
        items: [{ name: "x", unitCents: 100, qty: 0 }],
      }),
    ).rejects.toThrow();
  });

  // D17: policies are immutable snapshots; get returns the latest per kind.
  it("returns only the latest policy snapshot per kind (D17)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    await t.run(async (ctx) => {
      const base = {
        userId,
        merchantDomain: "northwind.example",
        channel: "email" as const,
        passage: "p",
        sourceUrl: "https://northwind.example/returns",
        confidence: 0.9,
        confirmedByUser: false,
      };
      await ctx.db.insert("policies", { ...base, kind: "returns", windowDays: 14, retrievedAt: 1 });
      await ctx.db.insert("policies", { ...base, kind: "returns", windowDays: 30, retrievedAt: 2 });
      await ctx.db.insert("policies", { ...base, kind: "price_adjustment", windowDays: 7, retrievedAt: 1 });
    });
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got.policies).toHaveLength(2);
    const returns = got.policies.find((p) => p.kind === "returns");
    expect(returns?.windowDays).toBe(30);
  });
});

describe("purchases.confirm (D25, D19)", () => {
  it("moves needs_review to active and schedules the policy fetch", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, {
      ...basePurchase,
      purchasedAt: undefined,
      status: "needs_review" as const,
    });
    const before = await as.query(api.purchases.get, { purchaseId: id });
    expect(before.purchase.status).toBe("needs_review");
    expect(before.purchase.purchasedAt).toBeUndefined();
    expect(await scheduledPolicyFetches(t)).toHaveLength(0);

    await as.mutation(api.purchases.confirm, {
      purchaseId: id,
      merchant: "Northwind Outfitters",
      merchantDomain: "northwind.example",
      orderRef: "NW-1001",
      purchasedAt: Date.UTC(2026, 7, 25),
      currency: "USD",
      items: before.items.map((i) => ({
        itemId: i._id,
        name: i.name,
        unitCents: i.unitCents,
        qty: i.qty,
      })),
    });

    const after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after.purchase.status).toBe("active");
    expect(after.purchase.purchasedAt).toBe(Date.UTC(2026, 7, 25));
    expect(await scheduledPolicyFetches(t)).toHaveLength(1);
  });

  it("refuses an item that belongs to another purchase (D19)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const a = await as.mutation(api.purchases.create, {
      ...basePurchase,
      status: "needs_review" as const,
    });
    const b = await as.mutation(api.purchases.create, {
      ...basePurchase,
      orderRef: "NW-2002",
      status: "needs_review" as const,
    });
    const bItems = await as.query(api.purchases.get, { purchaseId: b });
    await expect(
      as.mutation(api.purchases.confirm, {
        purchaseId: a,
        merchant: "Northwind Outfitters",
        merchantDomain: "northwind.example",
        purchasedAt: Date.UTC(2026, 7, 25),
        items: [
          { itemId: bItems.items[0]._id, name: "hijacked", unitCents: 1, qty: 1 },
        ],
      }),
    ).rejects.toThrow();
    const stillB = await as.query(api.purchases.get, { purchaseId: b });
    expect(stillB.items[0].name).toBe("Merino sweater");
  });

  it("refuses another user's purchase", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const id = await alice.mutation(api.purchases.create, basePurchase);
    await expect(
      bob.mutation(api.purchases.confirm, {
        purchaseId: id,
        merchant: "Evil",
        merchantDomain: "evil.example",
        purchasedAt: Date.UTC(2026, 7, 25),
        items: [],
      }),
    ).rejects.toThrow();
  });
});

describe("purchases.setReturned", () => {
  it("marks an item returned and clears returnedAt when un-returned", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    await as.mutation(api.purchases.setReturned, {
      itemId: got.items[0]._id,
      returned: true,
      returnedAt: Date.UTC(2026, 7, 28),
    });
    let after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after.items[0].returned).toBe(true);
    expect(after.items[0].returnedAt).toBe(Date.UTC(2026, 7, 28));

    await as.mutation(api.purchases.setReturned, { itemId: got.items[0]._id, returned: false });
    after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after.items[0].returned).toBe(false);
    expect(after.items[0].returnedAt).toBeUndefined();
  });

  it("refuses another user's item", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const id = await alice.mutation(api.purchases.create, basePurchase);
    const got = await alice.query(api.purchases.get, { purchaseId: id });
    await expect(
      bob.mutation(api.purchases.setReturned, { itemId: got.items[0]._id, returned: true }),
    ).rejects.toThrow();
  });
});

describe("purchases.remove", () => {
  it("deletes items, claims and their children", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    const itemId = got.items[0]._id;
    const claimId = await seedClaim(t, userId, itemId, { expectedCents: 8000 });
    await t.run(async (ctx) => {
      await ctx.db.insert("claimNotes", { claimId, userId, kind: "note", text: "n" });
      await ctx.db.insert("priceChecks", {
        itemId,
        userId,
        observedAt: 1,
        sourceUrl: "https://northwind.example/p/sweater",
      });
    });

    await as.mutation(api.purchases.remove, { purchaseId: id });

    const leftovers = await t.run(async (ctx) => ({
      purchases: await ctx.db.query("purchases").collect(),
      items: await ctx.db.query("items").collect(),
      claims: await ctx.db.query("claims").collect(),
      notes: await ctx.db.query("claimNotes").collect(),
      priceChecks: await ctx.db.query("priceChecks").collect(),
    }));
    expect(leftovers.purchases).toHaveLength(0);
    expect(leftovers.items).toHaveLength(0);
    expect(leftovers.claims).toHaveLength(0);
    expect(leftovers.notes).toHaveLength(0);
    expect(leftovers.priceChecks).toHaveLength(0);
  });

  it("refuses another user's purchase", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const id = await alice.mutation(api.purchases.create, basePurchase);
    await expect(bob.mutation(api.purchases.remove, { purchaseId: id })).rejects.toThrow();
  });
});

describe("purchases.board totals", () => {
  // D24: owed sums max(0, unresolved); an over-credit never subtracts from owed.
  it("never lets an over-credited claim reduce owed (D24)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    await seedClaim(t, userId, got.items[0]._id, { expectedCents: 8000 });
    await seedClaim(t, userId, got.items[1]._id, { expectedCents: 4000, confirmedCents: 5000 });

    const board = await as.query(api.purchases.board, {});
    expect(board.totals.owed).toBe(8000);
    expect(board.totals.confirmed).toBe(5000);
  });

  // D13: asked counts only sent | packet | promised.
  it("counts asked only for sent, packet and promised (D13)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    await seedClaim(t, userId, got.items[0]._id, { expectedCents: 8000, status: "queued" });
    await seedClaim(t, userId, got.items[1]._id, { expectedCents: 4000, status: "sent" });

    const board = await as.query(api.purchases.board, {});
    expect(board.totals.owed).toBe(12000);
    expect(board.totals.asked).toBe(4000);
  });

  // D27: example money never lands in the headline totals.
  it("excludes example money from totals but still lists the rows (D27)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const real = await as.mutation(api.purchases.create, basePurchase);
    const example = await as.mutation(api.purchases.create, {
      ...basePurchase,
      orderRef: "EX-1",
      isExample: true,
    });
    const realItems = await as.query(api.purchases.get, { purchaseId: real });
    const exampleItems = await as.query(api.purchases.get, { purchaseId: example });
    await seedClaim(t, userId, realItems.items[1]._id, { expectedCents: 4000 });
    await seedClaim(t, userId, exampleItems.items[1]._id, {
      expectedCents: 4000,
      isExample: true,
    });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(2);
    expect(board.totals.owed).toBe(4000);
  });

  it("ignores dismissed claims and names the item on each row", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId: id });
    await seedClaim(t, userId, got.items[1]._id, { expectedCents: 4000, status: "dismissed" });

    const board = await as.query(api.purchases.board, {});
    expect(board.totals.owed).toBe(0);
    expect(board.purchases[0].claims[0].itemName).toBe("Wool scarf");
  });
});
