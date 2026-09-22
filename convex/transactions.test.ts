/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { ensurePurchaseTransaction } from "./transactions";

type T = ReturnType<typeof setup>;

const basePurchase = {
  merchant: "Northwind Outfitters",
  merchantDomain: "northwind.example",
  orderRef: "NW-1001",
  purchasedAt: Date.UTC(2026, 7, 25),
  currency: "USD",
  items: [{ name: "Merino sweater", unitCents: 8000, qty: 1 }],
};

async function txnsFor(t: T, purchaseId: Id<"purchases">) {
  return t.run((ctx) =>
    ctx.db
      .query("transactions")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .collect(),
  );
}

/** Every non-test, non-generated module under convex/, as raw source. */
const SOURCES = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * DA-A-35: purchase insert sites that are not yet migrated, each named with the task that owns the file. The owner
 * deletes its entry in the same commit that adds the call; the test below fails while an entry is stale.
 */
const PENDING_ENSURE: Record<string, string> = {
  "./intake.ts": "M13 — intake.applyOrder creates the needs_review purchase (contract §7)",
  "./testing.ts": "M16 — e2e seeders (contract §11.1 M16)",
};

/** `const X = await ctx.db.insert("purchases", …)` → the ids that must reach `ensurePurchaseTransaction`. */
function purchaseInsertSites(src: string) {
  const all = [...src.matchAll(/\.insert\(\s*["']purchases["']/g)].length;
  const captured = [...src.matchAll(/const\s+(\w+)\s*=\s*await\s+ctx\.db\.insert\(\s*["']purchases["']/g)].map((m) => ({
    name: m[1],
    at: m.index,
  }));
  return { all, captured };
}

function ensured(src: string, site: { name: string; at: number }) {
  const call = new RegExp(`ensurePurchaseTransaction\\(\\s*ctx\\s*,\\s*${site.name}\\s*\\)`);
  return call.test(src.slice(site.at));
}

describe("DA-A-35: every insert(\"purchases\") site calls ensurePurchaseTransaction", () => {
  it("finds the known insert sites (the scan is not vacuous)", () => {
    const files = Object.entries(SOURCES).filter(([, src]) => purchaseInsertSites(src).all > 0).map(([f]) => f);
    expect(files).toEqual(expect.arrayContaining(["./purchases.ts", "./watches.ts", "./examples.ts"]));
    expect(purchaseInsertSites(SOURCES["./examples.ts"]).captured).toHaveLength(2);
  });

  it("every site captures the new id and passes it to ensurePurchaseTransaction", () => {
    const offenders: string[] = [];
    for (const [file, src] of Object.entries(SOURCES)) {
      if (file in PENDING_ENSURE) continue;
      const { all, captured } = purchaseInsertSites(src);
      if (all !== captured.length) offenders.push(`${file}: an insert("purchases") whose id is not captured`);
      for (const site of captured) {
        if (!ensured(src, site)) offenders.push(`${file}: ${site.name} never reaches ensurePurchaseTransaction`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the pending list names only files that still have an unmigrated site", () => {
    const stale = Object.keys(PENDING_ENSURE).filter((file) => {
      const src = SOURCES[file];
      if (src === undefined) return true;
      const { all, captured } = purchaseInsertSites(src);
      return all === captured.length && captured.every((s) => ensured(src, s));
    });
    expect(stale).toEqual([]);
  });
});

describe("ensurePurchaseTransaction (contract §2.2, DA-A-35)", () => {
  it("purchases.create gives the purchase exactly one retail_order transaction mirroring it", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, basePurchase);
    const rows = await txnsFor(t, purchaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      category: "retail_order",
      status: "active",
      counterpartyName: "Northwind Outfitters",
      counterpartyDomain: "northwind.example",
      currency: "USD",
      transactedAt: Date.UTC(2026, 7, 25),
      purchaseId,
      liveFactCount: 0,
    });
    expect(rows[0].isExample).toBeUndefined();
    expect(rows[0].relatedTransactionId).toBeUndefined();
  });

  it("is idempotent: a second call returns the same id and inserts nothing", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, basePurchase);
    const [first] = await txnsFor(t, purchaseId);
    const again = await t.run(async (ctx) => [
      await ensurePurchaseTransaction(ctx, purchaseId),
      await ensurePurchaseTransaction(ctx, purchaseId),
    ]);
    expect(again).toEqual([first._id, first._id]);
    expect(await txnsFor(t, purchaseId)).toHaveLength(1);
  });

  it("a needs_review purchase gets a needs_review transaction; confirm moves both to active and syncs the merchant", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      ...basePurchase,
      purchasedAt: undefined,
      status: "needs_review",
    });
    const [before] = await txnsFor(t, purchaseId);
    expect(before.status).toBe("needs_review");
    expect(before.transactedAt).toBeUndefined();

    const itemId = await t.run(async (ctx) => (await ctx.db.query("items").first())!._id);
    await as.mutation(api.purchases.confirm, {
      purchaseId,
      merchant: "Northwind Co",
      merchantDomain: "shop.northwind.example",
      purchasedAt: Date.UTC(2026, 7, 26),
      items: [{ itemId, name: "Merino sweater", unitCents: 8000, qty: 1 }],
    });
    const after = await txnsFor(t, purchaseId);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(before._id);
    expect(after[0]).toMatchObject({
      status: "active",
      counterpartyName: "Northwind Co",
      counterpartyDomain: "shop.northwind.example",
      transactedAt: Date.UTC(2026, 7, 26),
    });
  });

  it("confirm on a legacy purchase that has no transaction yet creates one (lazy ensure)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId, itemId } = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Old", merchantDomain: "old.example", currency: "USD", status: "needs_review",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Lamp", unitCents: 5000, qty: 1, returned: false });
      return { purchaseId, itemId };
    });
    expect(await txnsFor(t, purchaseId)).toHaveLength(0);
    await as.mutation(api.purchases.confirm, {
      purchaseId, merchant: "Old", merchantDomain: "old.example", purchasedAt: Date.UTC(2026, 7, 26),
      items: [{ itemId, name: "Lamp", unitCents: 5000, qty: 1 }],
    });
    const rows = await txnsFor(t, purchaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  it("remove archives the transaction with the purchase", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, basePurchase);
    await as.mutation(api.purchases.remove, { purchaseId });
    const [row] = await txnsFor(t, purchaseId);
    expect(row.status).toBe("archived");
  });

  it("watches.markBought → the new purchase has a transaction (DA-A-35)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "Trail shoes", productUrl: "https://northwind.example/p/shoes",
        merchantDomain: "northwind.example", currency: "USD", status: "active", nextCheckAt: Date.now() + 3_600_000,
      }),
    );
    const purchaseId = await as.mutation(api.watches.markBought, {
      watchId, paidCents: 9900, purchasedAt: Date.now() - 60_000,
    });
    const rows = await txnsFor(t, purchaseId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, category: "retail_order", status: "active", currency: "USD" });
    expect(rows[0].isExample).toBeUndefined();
  });

  it("examples.load → each example purchase has a transaction that copies isExample (DA-A-35)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const res = await as.mutation(api.examples.load, {});
    expect(res.purchaseIds).toHaveLength(2);
    for (const purchaseId of res.purchaseIds) {
      const rows = await txnsFor(t, purchaseId);
      expect(rows).toHaveLength(1);
      expect(rows[0].isExample).toBe(true);
      expect(rows[0].status).toBe("active");
    }
  });

  it("examples.load on an account holding pre-wave-1 example purchases backfills their transactions", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const legacy = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId, merchant: "Northwind Outfitters", merchantDomain: "northwind.example", currency: "USD",
        status: "active", purchasedAt: Date.now() - 86_400_000, isExample: true,
      }),
    );
    const res = await as.mutation(api.examples.load, {});
    expect(res).toEqual({ loaded: false, purchaseIds: [legacy] });
    const rows = await txnsFor(t, legacy);
    expect(rows).toHaveLength(1);
    expect(rows[0].isExample).toBe(true);
  });

  it("copies isExample from any example purchase, and never marks a real one", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const [exampleTxn, realTxn] = await t.run(async (ctx) => {
      const ex = await ctx.db.insert("purchases", {
        userId, merchant: "Ex", merchantDomain: "ex.example", currency: "USD", status: "active", isExample: true,
      });
      const real = await ctx.db.insert("purchases", {
        userId, merchant: "Real", merchantDomain: "real.example", currency: "EUR", status: "active", isExample: false,
      });
      const a = await ctx.db.get(await ensurePurchaseTransaction(ctx, ex));
      const b = await ctx.db.get(await ensurePurchaseTransaction(ctx, real));
      return [a!, b!];
    });
    expect(exampleTxn.isExample).toBe(true);
    expect(realTxn.isExample).toBeUndefined();
    expect(realTxn.currency).toBe("EUR");
  });

  it("refuses a purchase id that does not exist", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("purchases", {
        userId, merchant: "Gone", merchantDomain: "gone.example", currency: "USD", status: "active",
      });
      await ctx.db.delete(id);
      return id;
    });
    await expect(t.run((ctx) => ensurePurchaseTransaction(ctx, purchaseId))).rejects.toThrow(/Purchase not found/);
  });
});
