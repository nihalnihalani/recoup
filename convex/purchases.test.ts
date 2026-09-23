/// <reference types="vite/client" />
import { describe, it, expect, vi } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DAILY_BUDGETS } from "./limits";
import { setup, signedIn, fakeSchedulerTimersEach } from "./test.setup";

// D247 (KX3): a job this file's code schedules never runs on a real timer in the background; tests flush it.
fakeSchedulerTimersEach();

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

  it("F4: create rejects an item productUrl that is not a real product link", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    for (const productUrl of ["javascript:alert(1)", "ftp://acme.example/p", "http://10.0.0.1/p"]) {
      await expect(
        as.mutation(api.purchases.create, {
          ...basePurchase,
          items: [{ name: "Sweater", unitCents: 8000, qty: 1, productUrl }],
        }),
      ).rejects.toThrow();
    }
  });

  it("F4: confirm rejects an item productUrl that is not a real product link", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      status: "needs_review" as const,
      purchasedAt: undefined,
    });
    const got = await as.query(api.purchases.get, { purchaseId });
    await expect(
      as.mutation(api.purchases.confirm, {
        purchaseId,
        merchant: basePurchase.merchant,
        merchantDomain: basePurchase.merchantDomain,
        orderRef: basePurchase.orderRef,
        purchasedAt: basePurchase.purchasedAt,
        items: [
          {
            itemId: got!.items[0]._id,
            name: got!.items[0].name,
            unitCents: got!.items[0].unitCents,
            qty: got!.items[0].qty,
            productUrl: "javascript:alert(1)",
          },
        ],
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

  it("6a-4/D112: re-confirm with a partial item list still clears the omitted item's schedule stamp", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      status: "needs_review" as const,
      purchasedAt: undefined,
    });
    const got = await as.query(api.purchases.get, { purchaseId });
    const [includedItem, omittedItem] = got!.items;

    // Simulate both items already carrying a `priceWatch` schedule stamp
    // (e.g. from a tick before the purchase was ever confirmed).
    await t.run(async (ctx) => {
      await ctx.db.patch(includedItem._id, { nextCheckAt: Date.now() + 999_999 });
      await ctx.db.patch(omittedItem._id, { nextCheckAt: Date.now() + 999_999 });
    });

    // A normal partial re-confirm: the caller's form only resubmits one row.
    await as.mutation(api.purchases.confirm, {
      purchaseId,
      merchant: basePurchase.merchant,
      merchantDomain: basePurchase.merchantDomain,
      orderRef: basePurchase.orderRef,
      purchasedAt: basePurchase.purchasedAt,
      items: [
        {
          itemId: includedItem._id,
          name: includedItem.name,
          unitCents: includedItem.unitCents,
          qty: includedItem.qty,
          productUrl: includedItem.productUrl,
        },
      ],
    });

    const after = await as.query(api.purchases.get, { purchaseId });
    const includedAfter = after!.items.find((i) => i._id === includedItem._id)!;
    const omittedAfter = after!.items.find((i) => i._id === omittedItem._id)!;
    expect(includedAfter.nextCheckAt).toBeUndefined();
    // The bug this regresses: the old code only un-stamped `args.items`, so
    // an item the caller's form did not resubmit kept its stale stamp.
    expect(omittedAfter.nextCheckAt).toBeUndefined();
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

    // F-AUD-9: `purchases.create` no longer accepts a client `isExample` arg
    // (examples are seeded only by `examples.ts`'s direct `db.insert`) -- set
    // it directly in the DB here, the same way that loader does.
    const exampleId = await as.mutation(api.purchases.create, basePurchase);
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

  it("purchases.create refuses a client-supplied isExample (F-AUD-9)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    // Examples are seeded only by `examples.ts`'s direct `db.insert` (D04);
    // `isExample` is not a public argument on `create` any more, so a client
    // cannot mark its own purchase as an example to dodge its own money
    // totals/spend or block the example loader (register: F-AUD-9).
    await expect(
      as.mutation(api.purchases.create, { ...basePurchase, isExample: true } as unknown as typeof basePurchase),
    ).rejects.toThrow(/isExample/);
    // Nothing was written by the rejected call.
    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(0);
    const mine = await t.run((ctx) =>
      ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(mine).toHaveLength(0);
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

  it("D103: purchases.get takes an optional coarse `now` and never reads Date.now() directly (P06/D73)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.purchases.create, basePurchase);

    // A query must not read the wall clock itself: this is a source-level
    // invariant (watches.ts's `list`/`get`/`summarise` are checked the same
    // way), not something a black-box query call could otherwise prove.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./purchases.ts", import.meta.url), "utf8");
    const start = src.indexOf("export const get = query({");
    const end = src.indexOf("\nexport const board = query(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain("Date.now()");

    // The `now` arg is validated the same way as watches.list/get (D73's
    // assertCoarseNow): wildly out of bounds is refused, not silently used.
    await expect(as.query(api.purchases.get, { purchaseId: id, now: Date.now() + 5 * 86_400_000 })).rejects.toThrow();

    // A plausible `now` is accepted and does not change stored fields.
    const got = await as.query(api.purchases.get, { purchaseId: id, now: Date.now() });
    expect(got.purchase._id).toBe(id);
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
      // needs_review purchases never research anything (F-AUD-9: an example
      // purchase can no longer reach `create` at all -- `isExample` is not a
      // public argument any more, and `examples.ts`'s own loader inserts
      // directly, bypassing `schedulePolicyFetch` entirely -- so that half of
      // this invariant is now structural rather than something `create` must
      // refuse at runtime; see "purchases.create refuses a client-supplied
      // isExample" below for the regression on the removed argument itself).
      const other = await signedIn(t, "Other");
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

/**
 * F-AUD-1 (opus-auditor's 36-connection audit; D107 C1 pattern). Ported from
 * the auditor's repro at
 * `scratchpad/audit/repros/zz_audit_board.test.ts`, which only asserted "no
 * throw" -- this block additionally measures real transaction metrics
 * (`convex-test`'s `ctx.meta.getTransactionMetrics()`, the same mechanism
 * `readBudget.test.ts` uses) so the range/document numbers are reported, not
 * guessed.
 *
 * BEFORE the fix: `purchases.board` issued one `by_item` claims range read
 * PER ITEM (`claimsWithBalance`, called once per item across every
 * non-archived purchase) on top of one `by_purchase` items range per
 * purchase -- `1 + purchases + items` index ranges before a single claim was
 * even found. At 100 purchases x 50 items (half `MAX_PURCHASES_PER_USER`=200,
 * at `MAX_ITEMS_PER_PURCHASE`=50) that is 5,100 ranges, over Convex's
 * 4,096-per-transaction limit; the Board page rendered nothing but the error
 * boundary for that account (60x50 = 3,060 ranges still passed, which is why
 * the bug shipped unnoticed). This block's two size cases FAIL with that
 * platform error on the pre-fix `board` and PASS after (verified by running
 * this exact file against the unfixed handler before landing the fix).
 *
 * AFTER the fix: claims are read once per PURCHASE (`by_purchase_type`,
 * mirroring `tracking.ts`'s C1 fix) and both the purchase list and a shared
 * per-call item budget are capped (`MAX_BOARD_PURCHASES`,
 * `MAX_BOARD_ITEMS_TOTAL` in `purchases.ts`), so a heavy account degrades to
 * `truncated: true` instead of a platform error.
 */
describe("purchases.board bounded reads (F-AUD-1)", () => {
  const modules = import.meta.glob("./**/*.*s");
  const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
  const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
  const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
  const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

  /**
   * Inlined rather than imported from `test.setup.ts` (owned by another
   * lane): `setup()`'s positional `convexTest(schema, modules)` form
   * silently ignores `transactionLimits` -- only the options-object form
   * used here turns platform-limit enforcement on (same finding
   * `readBudget.test.ts`'s file docstring records).
   */
  function harness() {
    process.env.FIRECRAWL_API_KEY = "fc-test";
    process.env.AGENTMAIL_API_KEY = "am-test";
    process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
    const t = convexTest({ schema, modules, transactionLimits: true });
    t.registerComponent("agentmail", agentmail.schema, agentmailModules);
    t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
    t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
    firecrawl.register(t);
    t.registerComponent("rateLimiter", rl.schema, rlModules);
    t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
    return t;
  }
  type T = ReturnType<typeof harness>;

  async function heavySignedIn(t: T, name: string) {
    const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name }));
    return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
  }

  /** `purchases` purchases x `items` items each, active, no claims -- matches the auditor's repro fixture exactly. */
  async function heavyAccount(t: T, userId: Id<"users">, purchaseCount: number, itemCount: number) {
    for (let p = 0; p < purchaseCount; p++) {
      await t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId, merchant: "M", merchantDomain: `m${p}.example`, purchasedAt: Date.now() - 1000, currency: "USD", status: "active",
        });
        for (let i = 0; i < itemCount; i++) {
          await ctx.db.insert("items", { purchaseId, userId, name: `i${i}`, unitCents: 1000, qty: 1, returned: false });
        }
      });
    }
  }

  /** Runs `purchases.board` inside one transaction and reads convex-test's real metrics for it (mirrors `readBudget.test.ts`'s `measure`). */
  async function measureBoard(t: T, as: ReturnType<T["withIdentity"]>) {
    const { result, metrics } = await as.run(async (ctx) => {
      const result = await ctx.runQuery(api.purchases.board, {});
      const metrics = await ctx.meta.getTransactionMetrics();
      return { result, metrics };
    });
    return { result, documentsRead: metrics.documentsRead.used, databaseQueries: metrics.databaseQueries.used };
  }

  for (const [purchaseCount, itemCount] of [[100, 50], [200, 50]] as const) {
    it(
      `${purchaseCount} purchases x ${itemCount} items stays under the index-range and document limits (caps: 200 x 50)`,
      async () => {
        const t = harness();
        const { userId, as } = await heavySignedIn(t, "Heavy");
        await heavyAccount(t, userId, purchaseCount, itemCount);
        const { result, documentsRead, databaseQueries } = await measureBoard(t, as);
        // eslint-disable-next-line no-console
        console.log("[F-AUD-1]", JSON.stringify({ purchaseCount, itemCount, documentsRead, databaseQueries }));
        expect(databaseQueries).toBeLessThan(4096);
        expect(documentsRead).toBeLessThan(32_000);
        // The board's own per-status cap (MAX_BOARD_PURCHASES=60) is what
        // kept this under the limits, not a lucky fit -- confirm it actually
        // engaged rather than merely happening to stay small.
        expect(result.truncated).toBe(true);
      },
      60_000,
    );
  }

  it("renders every purchase when nowhere near the cap: 6 purchases x 1 item, truncated:false", async () => {
    const t = harness();
    const { userId, as } = await heavySignedIn(t, "Light");
    await heavyAccount(t, userId, 6, 1);
    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(6);
    expect(board.truncated).toBe(false);
  });
});

/**
 * B-6 (D129, checkpoint 6d): F-AUD-1 bounded the PURCHASE-list and ITEM
 * reads, but left the per-purchase claims list (`by_purchase_type`) and, far
 * more expensively, `claimBalance`'s own `ledgerEvents` range read -- called
 * once per claim actually returned -- completely unbounded. At 60 active
 * purchases x 50 items x 2 claims each (6,000 claims, every number still
 * inside `MAX_BOARD_PURCHASES`/`MAX_ITEMS_PER_PURCHASE`/
 * `MAX_PURCHASES_PER_USER`), that is 6,000 EXTRA index ranges from
 * `claimBalance` alone, over Convex's 4,096-per-transaction limit -- the
 * Board page threw the platform error for any real account with two open
 * claim types (price adjustment + return credit) on every returned item.
 *
 * Fixed the same shape items already use: a shared `MAX_BOARD_CLAIMS_TOTAL`
 * budget, spent as claims are actually read (not allotted per purchase up
 * front), with a `take(cap + 1)` probe read per purchase so `truncated`
 * reflects a REAL cut rather than a merely tight budget.
 */
describe("purchases.board claims budget (B-6, D129)", () => {
  const modules = import.meta.glob("./**/*.*s");
  const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
  const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
  const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
  const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

  function harness() {
    process.env.FIRECRAWL_API_KEY = "fc-test";
    process.env.AGENTMAIL_API_KEY = "am-test";
    process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
    const t = convexTest({ schema, modules, transactionLimits: true });
    t.registerComponent("agentmail", agentmail.schema, agentmailModules);
    t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
    t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
    firecrawl.register(t);
    t.registerComponent("rateLimiter", rl.schema, rlModules);
    t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
    return t;
  }
  type T = ReturnType<typeof harness>;

  async function heavySignedIn(t: T, name: string) {
    const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name }));
    return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
  }

  /** `purchaseCount` active purchases x `itemCount` returned items each, `claimsPerItem` claims (alternating type) on every item. */
  async function heavyAccountWithClaims(t: T, userId: Id<"users">, purchaseCount: number, itemCount: number, claimsPerItem: number) {
    for (let p = 0; p < purchaseCount; p++) {
      await t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId, merchant: `M${p}`, merchantDomain: `m${p}.example`, purchasedAt: Date.now() - 1000, currency: "USD", status: "active",
        });
        for (let i = 0; i < itemCount; i++) {
          const itemId = await ctx.db.insert("items", { purchaseId, userId, name: `i${i}`, unitCents: 1000, qty: 1, returned: true });
          for (let c = 0; c < claimsPerItem; c++) {
            await ctx.db.insert("claims", {
              purchaseId, itemId, userId, type: c % 2 === 0 ? "price_adjustment" : "return_credit",
              expectedCents: 100, status: c % 2 === 0 ? "sent" : "confirmed", token: `p${p}-i${i}-c${c}`, version: 1,
            });
          }
        }
      });
    }
  }

  async function measureBoard(t: T, as: ReturnType<T["withIdentity"]>) {
    const { result, metrics } = await as.run(async (ctx) => {
      const result = await ctx.runQuery(api.purchases.board, {});
      const metrics = await ctx.meta.getTransactionMetrics();
      return { result, metrics };
    });
    return { result, documentsRead: metrics.documentsRead.used, databaseQueries: metrics.databaseQueries.used };
  }

  it("60 purchases x 50 items x 2 claims each (6,000 claims) -- board does not throw, stays under 4,096 ranges, and truncates", async () => {
    const t = harness();
    const { userId, as } = await heavySignedIn(t, "Heavy claims");
    await heavyAccountWithClaims(t, userId, 60, 50, 2);
    const { result, documentsRead, databaseQueries } = await measureBoard(t, as);
    // eslint-disable-next-line no-console
    console.log("[B-6] 60x50x2 claims:", JSON.stringify({ documentsRead, databaseQueries, purchasesReturned: result.purchases.length, truncated: result.truncated }));
    expect(databaseQueries).toBeLessThan(4096);
    expect(result.truncated).toBe(true);
  }, 120_000);

  it("60 purchases x 50 items x 1 claim each (3,000 claims) -- stays under the budget without truncating", async () => {
    const t = harness();
    const { userId, as } = await heavySignedIn(t, "Heavy one-claim");
    await heavyAccountWithClaims(t, userId, 60, 50, 1);
    const { result, documentsRead, databaseQueries } = await measureBoard(t, as);
    // eslint-disable-next-line no-console
    console.log("[B-6 control] 60x50x1 claims:", JSON.stringify({ documentsRead, databaseQueries, purchasesReturned: result.purchases.length, truncated: result.truncated }));
    expect(databaseQueries).toBeLessThan(4096);
    expect(result.purchases).toHaveLength(60);
    expect(result.truncated).toBe(false);
  }, 120_000);

  it("light account (2 purchases x 3 items x 2 claims) renders every claim, untruncated, with correct totals", async () => {
    const t = harness();
    const { userId, as } = await heavySignedIn(t, "Light claims");
    await heavyAccountWithClaims(t, userId, 2, 3, 2);
    const board = await as.query(api.purchases.board, {});
    expect(board.truncated).toBe(false);
    const totalClaims = board.purchases.reduce((n, r) => n + r.claims.length, 0);
    expect(totalClaims).toBe(2 * 3 * 2);
  });
});
