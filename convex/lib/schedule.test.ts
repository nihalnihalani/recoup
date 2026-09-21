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
});
