/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { setup, signedIn } from "../test.setup";
import { clearItemSchedule, clearMerchantItemSchedule } from "./schedule";

const DOMAIN = "acme.example";
const DAY = 86_400_000;

async function purchaseWithItems(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  count: number,
  o: { merchantDomain?: string; stamp?: number | undefined } = {},
): Promise<{ purchaseId: Id<"purchases">; itemIds: Id<"items">[] }> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: o.merchantDomain ?? DOMAIN,
      purchasedAt: Date.now() - 2 * DAY,
      currency: "USD",
      status: "active",
    });
    const itemIds: Id<"items">[] = [];
    for (let i = 0; i < count; i++) {
      itemIds.push(
        await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: `Item ${i}`,
          unitCents: 1_000,
          qty: 1,
          productUrl: `https://${o.merchantDomain ?? DOMAIN}/p/${i}`,
          returned: false,
          nextCheckAt: "stamp" in o ? o.stamp : Date.now() + 999_999,
        }),
      );
    }
    return { purchaseId, itemIds };
  });
}

async function nextCheckAtOf(t: ReturnType<typeof setup>, itemId: Id<"items">) {
  const row = await t.run((ctx) => ctx.db.get(itemId));
  return row?.nextCheckAt;
}

describe("clearItemSchedule", () => {
  it("clears nextCheckAt on every id passed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemIds } = await purchaseWithItems(t, userId, 3);

    await t.run((ctx) => clearItemSchedule(ctx, itemIds));

    for (const id of itemIds) {
      expect(await nextCheckAtOf(t, id)).toBeUndefined();
    }
  });

  it("is a no-op for an item already due (nextCheckAt undefined) -- no error, stays undefined", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemIds } = await purchaseWithItems(t, userId, 1, { stamp: undefined });

    await t.run((ctx) => clearItemSchedule(ctx, itemIds));
    expect(await nextCheckAtOf(t, itemIds[0])).toBeUndefined();
  });

  it("silently skips an id that no longer exists, and still clears the rest", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemIds } = await purchaseWithItems(t, userId, 2);
    const [deletedId, keptId] = itemIds;
    await t.run((ctx) => ctx.db.delete(deletedId));

    await expect(t.run((ctx) => clearItemSchedule(ctx, [deletedId, keptId]))).resolves.toBeNull();
    expect(await nextCheckAtOf(t, keptId)).toBeUndefined();
  });

  it("only touches the first 50 ids passed (bounded)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemIds } = await purchaseWithItems(t, userId, 55);

    await t.run((ctx) => clearItemSchedule(ctx, itemIds));

    const cleared = await Promise.all(itemIds.map((id) => nextCheckAtOf(t, id)));
    expect(cleared.filter((v) => v === undefined)).toHaveLength(50);
    expect(cleared.filter((v) => v !== undefined)).toHaveLength(5);
  });
});

describe("clearMerchantItemSchedule", () => {
  it("clears every item at the merchant, across purchases, for this user only", async () => {
    const t = setup();
    const { userId: userA } = await signedIn(t, "A");
    const { userId: userB } = await signedIn(t, "B");
    const p1 = await purchaseWithItems(t, userA, 2);
    const p2 = await purchaseWithItems(t, userA, 2);
    const other = await purchaseWithItems(t, userA, 1, { merchantDomain: "other.example" });
    const b = await purchaseWithItems(t, userB, 1);

    await t.run((ctx) => clearMerchantItemSchedule(ctx, userA, DOMAIN));

    for (const id of [...p1.itemIds, ...p2.itemIds]) {
      expect(await nextCheckAtOf(t, id)).toBeUndefined();
    }
    // A different merchant, and a different user's items at the same merchant, are untouched.
    expect(await nextCheckAtOf(t, other.itemIds[0])).toBeDefined();
    expect(await nextCheckAtOf(t, b.itemIds[0])).toBeDefined();
  });

  it("does nothing for a merchant the user has no purchases at", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await expect(t.run((ctx) => clearMerchantItemSchedule(ctx, userId, "nobody-here.example"))).resolves.toBeNull();
  });

  // 6a-6/D112 (Opus checkpoint 6a): the raw purchase scan used to be
  // ascending on `by_user_domain_order` with no status check at all, so the
  // "survivor" left out by the `MAX_MERCHANT_PURCHASES` cap was whichever
  // purchase happened to sort last by `orderRef` (most purchases never set
  // one, so in practice this was close to arbitrary), and an archived or
  // needs_review purchase could occupy a scan slot a real active one needed.
  // Fixed: `.order("desc")` (newest-first among purchases with no `orderRef`,
  // since ties then break on `_creationTime` descending -- see
  // `clearMerchantItemSchedule`'s doc comment for the caveat when `orderRef`
  // IS set) plus an in-memory `status === "active" && !isExample` filter.
  it("6a-6/D112: 51 active purchases at the merchant -- the oldest is the one left un-scanned", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const itemIds: Id<"items">[] = [];
    await t.run(async (ctx) => {
      for (let i = 0; i < 51; i++) {
        // No orderRef: ties on the index's real sort key break on
        // _creationTime alone, giving a clean, deterministic newest-first
        // order to assert against.
        const purchaseId = await ctx.db.insert("purchases", {
          userId,
          merchant: "Acme",
          merchantDomain: DOMAIN,
          currency: "USD",
          status: "active",
        });
        itemIds.push(
          await ctx.db.insert("items", {
            purchaseId,
            userId,
            name: `Item ${i}`,
            unitCents: 1_000,
            qty: 1,
            productUrl: `https://${DOMAIN}/p/${i}`,
            returned: false,
            nextCheckAt: Date.now() + 999_999,
          }),
        );
      }
    });

    await t.run((ctx) => clearMerchantItemSchedule(ctx, userId, DOMAIN));

    const stamps = await Promise.all(itemIds.map((id) => nextCheckAtOf(t, id)));
    // itemIds[0] is the OLDEST purchase's item (inserted first): left
    // un-scanned by the 50-purchase cap. Every newer one (indices 1..50) was
    // read within the cap and un-stamped.
    expect(stamps[0]).toBeDefined();
    for (let i = 1; i < 51; i++) {
      expect(stamps[i]).toBeUndefined();
    }
  });

  it("6a-6/D112: archived and example purchases are read but never have their items un-stamped", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const active = await purchaseWithItems(t, userId, 1);
    const archived = await purchaseWithItems(t, userId, 1);
    await t.run((ctx) => ctx.db.patch(archived.purchaseId, { status: "archived" }));
    const example = await purchaseWithItems(t, userId, 1);
    await t.run((ctx) => ctx.db.patch(example.purchaseId, { isExample: true }));

    await t.run((ctx) => clearMerchantItemSchedule(ctx, userId, DOMAIN));

    expect(await nextCheckAtOf(t, active.itemIds[0])).toBeUndefined();
    expect(await nextCheckAtOf(t, archived.itemIds[0])).toBeDefined();
    expect(await nextCheckAtOf(t, example.itemIds[0])).toBeDefined();
  });

  // 6a-6/D112 asked whether MAX_MERCHANT_PURCHASES (50) should be raised
  // toward MAX_PURCHASES_PER_USER (200). Measured, not guessed: real
  // ctx.meta.getTransactionMetrics() numbers (same mechanism T07's
  // readBudget.test.ts uses) for a representative fixture -- 50 active
  // purchases x 4 items, i.e. exactly MAX_MERCHANT_PURCHASES purchases and
  // MAX_MERCHANT_ITEMS items. Both land far under Convex's real
  // per-transaction ceilings (32,000 documents read, 4,096 index-range
  // queries), so raising the cap would stay safe there too -- but see
  // `clearMerchantItemSchedule`'s doc comment for why it is kept at 50
  // anyway (an extreme-outlier scenario, bounded by an existing next-tick
  // fallback, not worth quadrupling the typical cost of every price-
  // adjustment confirm/refresh/re-research for).
  it("6a-6/D112: read cost at 50 active purchases x 4 items stays a small fraction of Convex's per-transaction ceilings", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      for (let p = 0; p < 50; p++) {
        const purchaseId = await ctx.db.insert("purchases", {
          userId,
          merchant: "Acme",
          merchantDomain: DOMAIN,
          currency: "USD",
          status: "active",
        });
        for (let i = 0; i < 4; i++) {
          await ctx.db.insert("items", {
            purchaseId,
            userId,
            name: `Item ${p}-${i}`,
            unitCents: 1_000,
            qty: 1,
            productUrl: `https://${DOMAIN}/p/${p}-${i}`,
            returned: false,
            nextCheckAt: Date.now() + 999_999,
          });
        }
      }
    });

    const { documentsRead, databaseQueries, bytesRead } = await t.run(async (ctx) => {
      await clearMerchantItemSchedule(ctx, userId, DOMAIN);
      const m = await ctx.meta.getTransactionMetrics();
      return { documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used, bytesRead: m.bytesRead.used };
    });

    // eslint-disable-next-line no-console
    console.log(
      "[read-budget]",
      JSON.stringify({ name: "clearMerchantItemSchedule", fixture: "50 active purchases x 4 items", documentsRead, databaseQueries, bytesRead }),
    );
    expect(documentsRead).toBeLessThan(32_000);
    expect(databaseQueries).toBeLessThan(4_096);
  });
});
