import { describe, it, expect, vi } from "vitest";
import { api } from "./_generated/api";
import { DAILY_BUDGETS } from "./limits";
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
    // D58: raw lastError is never exposed; a bare lastError falls back to a
    // sanitized generic summary.
    expect(board.attention.some((e) => e.errorSummary === "Processing failed")).toBe(true);
    expect(board.attention.every((e) => !("lastError" in e))).toBe(true);
  });
  it("rejects empty merchantDomain, empty items and far-future purchasedAt (D43)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.mutation(api.purchases.create, { ...basePurchase, merchantDomain: " " })).rejects.toThrow(/merchantDomain/);
    await expect(as.mutation(api.purchases.create, { ...basePurchase, items: [] })).rejects.toThrow(/at least one item/);
    await expect(
      as.mutation(api.purchases.create, { ...basePurchase, purchasedAt: Date.now() + 3 * 86_400_000 }),
    ).rejects.toThrow(/purchasedAt/);
    await expect(
      as.mutation(api.purchases.create, { ...basePurchase, purchasedAt: -5 }),
    ).rejects.toThrow(/purchasedAt/);
  });

  it("remove archives: hidden from board and get, ledger history kept (D47)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId });
    const itemId = got!.items[1]._id;
    await as.mutation(api.purchases.setReturned, { itemId, returned: true });
    const claimId = await as.mutation(api.claims.open, { itemId });
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1500, evidence: "stmt", idempotencyKey: "k1" });

    await as.mutation(api.purchases.remove, { purchaseId });

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(0);
    expect(board.totals).toEqual({ owed: 0, asked: 0, confirmed: 0 });
    await expect(as.query(api.purchases.get, { purchaseId })).rejects.toThrow(/not found/);
    const kept = await t.run(async (ctx) => ({
      purchase: await ctx.db.get(purchaseId),
      events: await ctx.db
        .query("ledgerEvents")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    }));
    expect(kept.purchase?.status).toBe("archived");
    expect(kept.events).toHaveLength(1);
  });

  it("board confirmed is net recovered and skips example claims (D39, D48)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, basePurchase);
    const got = await as.query(api.purchases.get, { purchaseId });
    const [sweater, scarf] = got!.items.map((i) => i._id);

    await as.mutation(api.purchases.setReturned, { itemId: scarf, returned: true });
    const claimId = await as.mutation(api.claims.open, { itemId: scarf });
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 5000, evidence: "stmt", idempotencyKey: "c1" });
    await as.mutation(api.claims.recordLaterDebit, { claimId, cents: 500, evidence: "clawback", idempotencyKey: "d1" });

    // An example claim sitting on a real purchase must not count.
    await as.mutation(api.purchases.setReturned, { itemId: sweater, returned: true });
    const exampleClaim = await as.mutation(api.claims.open, { itemId: sweater });
    await t.run((ctx) => ctx.db.patch(exampleClaim, { isExample: true }));

    const board = await as.query(api.purchases.board, {});
    // confirmed 5000 - debited 500 = 4500, clamped to expected 4000.
    expect(board.totals.confirmed).toBe(4000);
    expect(board.totals.owed).toBe(0);
  });
});

describe("merchant domain normalisation (review H7)", () => {
  it("stores the bare host so policies and purchases agree", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, {
      merchant: "Best Buy",
      merchantDomain: "https://WWW.BestBuy.com/orders",
      purchasedAt: Date.now() - 86_400_000,
      currency: "USD",
      items: [{ name: "Headphones", unitCents: 12000, qty: 1 }],
    });
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got!.purchase.merchantDomain).toBe("bestbuy.com");
  });
  it("gives every item a verdict from its accepted price checks only (W1b)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);
    const before = await as.query(api.purchases.get, { purchaseId: id });
    expect(before.items.map((i) => i.verdict.label)).toEqual(["unknown", "unknown"]);

    const itemId = before.items[0]._id;
    const now = Date.now();
    const DAY = 86_400_000;
    await t.run(async (ctx) => {
      const base = { itemId, userId, sourceUrl: "https://northwind.example/p/sweater" };
      for (const [daysAgo, cents] of [[9, 8000], [5, 8000], [1, 7000]]) {
        await ctx.db.insert("priceChecks", { ...base, observedAt: now - daysAgo * DAY, observedCents: cents, currency: "USD" });
      }
      // A rejected check (no cents) is not history.
      await ctx.db.insert("priceChecks", { ...base, observedAt: now, note: "Page shows a price range" });
    });

    const after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after.items[0].verdict.label).toBe("good_price");
    expect(after.items[0].verdict.reason).toContain("$70.00");
    expect(after.items[1].verdict.label).toBe("unknown");
  });
});

describe("input bounds and the policy-research budget (pre-launch review B4, M1)", () => {
  type T = ReturnType<typeof setup>;
  /** Pending `policies.fetchBoth` jobs; fake timers keep convex-test from running them. */
  async function scheduledFetches(t: T) {
    const jobs = await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    return jobs.filter((j) => j.name.includes("fetchBoth")).length;
  }
  const item = (over: Record<string, unknown> = {}) => ({ name: "Thing", unitCents: 1000, qty: 1, ...over });

  it("refuses more than 50 items, an over-long name, merchant or orderRef", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const bad = [
      { items: Array.from({ length: 51 }, () => item()) },
      { items: [item({ name: "x".repeat(201) })] },
      { items: [item({ name: "  \n " })] },
      { merchant: "m".repeat(121) },
      { orderRef: "r".repeat(101) },
    ];
    for (const over of bad) {
      await expect(as.mutation(api.purchases.create, { ...basePurchase, ...over })).rejects.toThrow();
    }
    await as.mutation(api.purchases.create, { ...basePurchase, items: Array.from({ length: 50 }, () => item()) });
  });

  it("stores names as one clean line", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, {
      ...basePurchase, merchant: " North\r\nwind ", orderRef: " NW\u0000-7 ", items: [item({ name: "Wool\tscarf\n" })],
    });
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got.purchase.merchant).toBe("Northwind");
    expect(got.purchase.orderRef).toBe("NW-7");
    expect(got.items[0].name).toBe("Woolscarf");
  });

  it("runs every product link through parseProductUrl, on create and on confirm", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    for (const productUrl of [
      "http://169.254.169.254/latest/meta-data",
      "http://metadata.google.internal/",
      "https://northwind.example:8443/p",
      "javascript:alert(1)",
      "https://user:pw@northwind.example/p",
    ]) {
      await expect(
        as.mutation(api.purchases.create, { ...basePurchase, items: [item({ productUrl })] }),
      ).rejects.toThrow(/Product link/);
    }
    const id = await as.mutation(api.purchases.create, {
      ...basePurchase, items: [item({ productUrl: " https://WWW.northwind.example/p/1#top " }), item({ productUrl: "" })],
    });
    const got = await as.query(api.purchases.get, { purchaseId: id });
    expect(got.items[0].productUrl).toBe("https://www.northwind.example/p/1");
    expect(got.items[1].productUrl).toBeUndefined();

    const confirmArgs = (productUrl: string) => ({
      purchaseId: id, merchant: "Northwind", merchantDomain: "northwind.example", purchasedAt: basePurchase.purchasedAt,
      items: [{ itemId: got.items[0]._id, name: "Thing", unitCents: 1000, qty: 1, productUrl }],
    });
    await expect(as.mutation(api.purchases.confirm, confirmArgs("http://10.0.0.1/admin"))).rejects.toThrow(/Product link/);
    expect(await as.mutation(api.purchases.confirm, confirmArgs("https://northwind.example/p/2"))).toBeNull();
    const after = await as.query(api.purchases.get, { purchaseId: id });
    expect(after.items[0].productUrl).toBe("https://northwind.example/p/2");
  });

  it("caps purchases per user at 200, archived ones included", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        await ctx.db.insert("purchases", {
          userId, merchant: "M", merchantDomain: "m.example", currency: "USD", status: i % 2 ? "archived" : "active",
        });
      }
    });
    await expect(as.mutation(api.purchases.create, basePurchase)).rejects.toThrow(/up to 200 purchases/);
    const other = await signedIn(t, "Other");
    await other.as.mutation(api.purchases.create, basePurchase);
  });

  it(`schedules policy research for at most ${DAILY_BUDGETS.policy_fetch.max} new purchases a day; later ones are still saved`, async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { as } = await signedIn(t);
      for (let i = 0; i < DAILY_BUDGETS.policy_fetch.max + 3; i++) {
        await as.mutation(api.purchases.create, { ...basePurchase, merchantDomain: `store-${i}.example`, orderRef: `R-${i}` });
      }
      expect(await scheduledFetches(t)).toBe(DAILY_BUDGETS.policy_fetch.max);
      const board = await as.query(api.purchases.board, {});
      expect(board.purchases).toHaveLength(DAILY_BUDGETS.policy_fetch.max + 3);
      // Example purchases and needs_review purchases never research anything.
      const other = await signedIn(t, "Other");
      await other.as.mutation(api.purchases.create, { ...basePurchase, isExample: true });
      await other.as.mutation(api.purchases.create, { ...basePurchase, status: "needs_review" });
      expect(await scheduledFetches(t)).toBe(DAILY_BUDGETS.policy_fetch.max);
    } finally {
      vi.useRealTimers();
    }
  });

  it("confirm researches only a purchase that just became active or changed store", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      const { as } = await signedIn(t);
      const id = await as.mutation(api.purchases.create, { ...basePurchase, status: "needs_review" });
      const got = await as.query(api.purchases.get, { purchaseId: id });
      const args = (merchantDomain: string) => ({
        purchaseId: id, merchant: "Northwind", merchantDomain, purchasedAt: basePurchase.purchasedAt,
        items: got.items.map((i) => ({ itemId: i._id, name: i.name, unitCents: i.unitCents, qty: i.qty })),
      });
      expect(await scheduledFetches(t)).toBe(0);
      await as.mutation(api.purchases.confirm, args("northwind.example")); // became active
      expect(await scheduledFetches(t)).toBe(1);
      await as.mutation(api.purchases.confirm, args("northwind.example")); // nothing changed
      await as.mutation(api.purchases.confirm, args("https://www.northwind.example/")); // same store, other spelling
      expect(await scheduledFetches(t)).toBe(1);
      await as.mutation(api.purchases.confirm, args("southwind.example")); // store changed
      expect(await scheduledFetches(t)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
