import { describe, it, expect } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import type { Id } from "./_generated/dataModel";

const SOURCE_URL = "https://n.example/p/jacket";

async function purchaseWithPolicyAndItem(
  t: ReturnType<typeof setup>,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
  userId: Id<"users">,
  opts: {
    unitCents: number;
    qty?: number;
    currency?: string;
    purchasedAt?: number;
    windowDays?: number;
    policyConfidence?: number;
  },
) {
  const purchasedAt = opts.purchasedAt ?? Date.now() - 2 * 86_400_000;
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Northwind",
    merchantDomain: "n.example",
    purchasedAt,
    currency: opts.currency ?? "USD",
    items: [{ name: "Jacket", unitCents: opts.unitCents, qty: opts.qty ?? 1, productUrl: SOURCE_URL }],
  });
  await t.mutation(internal.policies.insertSnapshot, {
    userId,
    merchantDomain: "n.example",
    kind: "price_adjustment",
    windowDays: opts.windowDays ?? 14,
    channel: "email",
    contactEmail: "help@n.example",
    passage: "14 days",
    sourceUrl: "https://n.example/policy",
    confidence: opts.policyConfidence ?? 0.9,
  });
  const got = await as.query(api.purchases.get, { purchaseId });
  return { purchaseId, itemId: got!.items[0]._id };
}

const GOOD = { currency: "USD", confidence: 0.9, variantMatch: "exact" as const, sourceUrl: SOURCE_URL };

describe("priceWatch.recordCheck", () => {
  it("2 x 12000 observed 9500 opens one claim of 5000 and a second check does not duplicate", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId, itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000, qty: 2 });

    const first = await t.mutation(internal.priceWatch.recordCheck, { itemId, observedCents: 9500, ...GOOD });
    expect(first.opened).toBe(true);

    const second = await t.mutation(internal.priceWatch.recordCheck, { itemId, observedCents: 9000, ...GOOD });
    expect(second.opened).toBe(false);

    const got = await as.query(api.purchases.get, { purchaseId });
    const claims = got!.items[0].claims.filter((c: any) => c.type === "price_adjustment");
    expect(claims).toHaveLength(1);
    expect(claims[0].expectedCents).toBe(5000);
    expect(got!.items[0].priceChecks).toHaveLength(2);
  });

  it("currency EUR on a USD purchase records a check and opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId, itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      ...GOOD,
      currency: "EUR",
    });
    expect(res.opened).toBe(false);

    const got = await as.query(api.purchases.get, { purchaseId });
    expect(got!.items[0].priceChecks).toHaveLength(1);
    expect(got!.items[0].claims.filter((c: any) => c.type === "price_adjustment")).toHaveLength(0);
  });

  it("confidence 0.5 opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      ...GOOD,
      confidence: 0.5,
    });
    expect(res.opened).toBe(false);
  });

  it("variantMatch unsure opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      ...GOOD,
      variantMatch: "unsure",
    });
    expect(res.opened).toBe(false);
  });

  it("isRange opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      ...GOOD,
      isRange: true,
    });
    expect(res.opened).toBe(false);
  });

  it("expired window opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await purchaseWithPolicyAndItem(t, as, userId, {
      unitCents: 12000,
      purchasedAt: Date.now() - 30 * 86_400_000,
      windowDays: 14,
    });

    const res = await t.mutation(internal.priceWatch.recordCheck, { itemId, observedCents: 9500, ...GOOD });
    expect(res.opened).toBe(false);
  });

  it("missing observedCents opens no claim but still records the check", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId, itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      sourceUrl: SOURCE_URL,
      note: "check failed: timeout",
    });
    expect(res.opened).toBe(false);

    const got = await as.query(api.purchases.get, { purchaseId });
    expect(got!.items[0].priceChecks).toHaveLength(1);
    expect(got!.items[0].priceChecks[0].observedCents).toBeUndefined();
    expect(got!.items[0].priceChecks[0].note).toBe("check failed: timeout");
  });

  it("manual and cron overlap: two concurrent recordCheck calls (Promise.all) yield one claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseId, itemId } = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });

    const args = { itemId, observedCents: 9500, ...GOOD };
    await Promise.all([
      t.mutation(internal.priceWatch.recordCheck, args),
      t.mutation(internal.priceWatch.recordCheck, args),
    ]);

    const got = await as.query(api.purchases.get, { purchaseId });
    const claims = got!.items[0].claims.filter((c: any) => c.type === "price_adjustment");
    expect(claims).toHaveLength(1);
  });
});

describe("priceWatch.eligibleItems", () => {
  it("example purchase is not eligible, but an otherwise-identical real purchase is", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const real = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });
    const example = await purchaseWithPolicyAndItem(t, as, userId, { unitCents: 12000 });
    await t.run(async (ctx) => {
      const item = (await ctx.db.get(example.itemId))!;
      await ctx.db.patch(item.purchaseId, { isExample: true });
    });

    const eligible = await t.query(internal.priceWatch.eligibleItems, {});
    const ids = eligible.map((e) => e.itemId);
    expect(ids).toContain(real.itemId);
    expect(ids).not.toContain(example.itemId);
  });

  it("purchase without purchasedAt is not eligible", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", {
        userId,
        merchant: "N",
        merchantDomain: "n.example",
        currency: "USD",
        status: "active",
      }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", {
        purchaseId,
        userId,
        name: "Jacket",
        unitCents: 12000,
        qty: 1,
        productUrl: SOURCE_URL,
        returned: false,
      }),
    );
    await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: "n.example",
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      passage: "14 days",
      sourceUrl: "https://n.example/policy",
      confidence: 0.9,
    });

    const eligible = await t.query(internal.priceWatch.eligibleItems, {});
    expect(eligible.some((e) => e.itemId === itemId)).toBe(false);
  });
});
