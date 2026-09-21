import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { clearItemSchedule } from "./lib/schedule";
import {
  DAILY_BUDGETS,
  GLOBAL_DAILY_BUDGETS,
  INELIGIBLE_REST_MS,
  PRICE_CHECK_PER_USER_PER_TICK,
  WATCH_CHECK_INTERVAL_MS,
  WATCH_SWEEP_BUMP_MS,
} from "./limits";

/**
 * Price watch (T09). These tests exercise `eligibleItems`, `recordCheck` and
 * `checkNow`. `checkItem` scrapes and calls OpenAI and is verified live
 * against the dev deployment instead, exactly as `policies.fetchOne` is.
 */

const DOMAIN = "acme.example";
const DAY = 86_400_000;
const URL = `https://${DOMAIN}/p/jacket`;

type World = {
  purchaseId: Id<"purchases">;
  itemId: Id<"items">;
  policyId: Id<"policies">;
};

type WorldOptions = {
  purchasedAt?: number | undefined;
  status?: "needs_review" | "active" | "archived";
  isExample?: boolean;
  currency?: string;
  unitCents?: number;
  qty?: number;
  productUrl?: string | undefined;
  returned?: boolean;
  windowDays?: number | undefined;
};

/**
 * Inserts a watchable purchase + item + price-adjustment policy directly.
 * `purchases.create` schedules real policy research, which these tests must
 * not trigger; the rows are the fixture, not the code under test.
 */
async function world(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  o: WorldOptions = {},
): Promise<World> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: DOMAIN,
      purchasedAt: "purchasedAt" in o ? o.purchasedAt : Date.now() - 2 * DAY,
      currency: o.currency ?? "USD",
      status: o.status ?? "active",
      isExample: o.isExample,
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: "Jacket",
      unitCents: o.unitCents ?? 12_000,
      qty: o.qty ?? 1,
      productUrl: "productUrl" in o ? o.productUrl : URL,
      returned: o.returned ?? false,
    });
    const policyId = await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "price_adjustment",
      windowDays: "windowDays" in o ? o.windowDays : 14,
      channel: "email",
      contactEmail: "help@acme.example",
      passage: "We adjust the price within 14 days of purchase.",
      sourceUrl: `https://${DOMAIN}/policy`,
      retrievedAt: Date.now(),
      confidence: 0.9,
      confirmedByUser: false,
    });
    return { purchaseId, itemId, policyId };
  });
}

/** A clean, D16-passing observation of `cents`. */
function good(itemId: Id<"items">, cents: number) {
  return {
    itemId,
    sourceUrl: URL,
    observedCents: cents,
    currency: "USD",
    confidence: 0.92,
    isRange: false,
    variantMatch: "exact" as const,
  };
}

async function claimsFor(t: ReturnType<typeof setup>, itemId: Id<"items">) {
  return await t.run((ctx) =>
    ctx.db
      .query("claims")
      .withIndex("by_item", (q) => q.eq("itemId", itemId))
      .collect(),
  );
}

async function checksFor(t: ReturnType<typeof setup>, itemId: Id<"items">) {
  return await t.run((ctx) =>
    ctx.db
      .query("priceChecks")
      .withIndex("by_item", (q) => q.eq("itemId", itemId))
      .collect(),
  );
}

describe("priceWatch.recordCheck acceptance (D16)", () => {
  it("opens a price_adjustment claim when the drop clears the threshold", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId, policyId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    expect(res.accepted).toBe(true);
    expect(res.claimId).not.toBeNull();
    const claims = await claimsFor(t, itemId);
    expect(claims).toHaveLength(1);
    expect(claims[0].type).toBe("price_adjustment");
    expect(claims[0].expectedCents).toBe(2_500);
    expect(claims[0].status).toBe("detected");
    expect(claims[0].policyId).toBe(policyId);
    expect(claims[0].openedFromPriceCheckId).toBe(res.priceCheckId);
    expect(claims[0].windowEndsAt).toBeGreaterThan(Date.now());

    const checks = await checksFor(t, itemId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBe(9_500);
  });

  it("multiplies the drop by quantity", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, { qty: 3 });

    await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    const claims = await claimsFor(t, itemId);
    expect(claims[0].expectedCents).toBe(7_500);
  });

  it("records the observation but opens nothing when the drop is under threshold", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    // 2% of $120 is $2.40; a $1 drop is below both that and the $1 floor rule.
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 11_900));

    expect(res.accepted).toBe(true);
    expect(res.claimId).toBeNull();
    expect(await claimsFor(t, itemId)).toHaveLength(0);
    const checks = await checksFor(t, itemId);
    expect(checks[0].observedCents).toBe(11_900);
  });

  it("opens nothing when the price went up", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    await t.mutation(internal.priceWatch.recordCheck, good(itemId, 13_000));

    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("does not open a claim when the price-adjustment window has closed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, { purchasedAt: Date.now() - 30 * DAY });

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    expect(res.claimId).toBeNull();
    expect(res.note).toBe("No open price window");
    expect(await claimsFor(t, itemId)).toHaveLength(0);
    // The observation is still recorded: the price really was $95.
    const checks = await checksFor(t, itemId);
    expect(checks[0].observedCents).toBe(9_500);
  });

  it("rejects a currency mismatch with a note and no observedCents", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, { currency: "GBP" });

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    expect(res.accepted).toBe(false);
    expect(res.claimId).toBeNull();
    const checks = await checksFor(t, itemId);
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].note).toContain("USD");
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("rejects a missing currency", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      ...good(itemId, 9_500),
      currency: undefined,
    });

    expect(res.accepted).toBe(false);
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("rejects a low-confidence extraction", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      ...good(itemId, 9_500),
      confidence: 0.69,
    });

    expect(res.accepted).toBe(false);
    const checks = await checksFor(t, itemId);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].confidence).toBe(0.69);
    expect(checks[0].note).toContain("confidence");
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("accepts exactly at the confidence floor", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      ...good(itemId, 9_500),
      confidence: 0.7,
    });

    expect(res.accepted).toBe(true);
    expect(res.claimId).not.toBeNull();
  });

  it("rejects a range or 'from' price", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      ...good(itemId, 9_500),
      isRange: true,
    });

    expect(res.accepted).toBe(false);
    const checks = await checksFor(t, itemId);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].note).toContain("range");
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("rejects an ambiguous variant", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      ...good(itemId, 9_500),
      variantMatch: "unsure",
    });

    expect(res.accepted).toBe(false);
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("stores a failed scrape as a note-only row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      sourceUrl: URL,
      note: "The product page could not be read",
    });

    expect(res.accepted).toBe(false);
    const checks = await checksFor(t, itemId);
    expect(checks[0].observedCents).toBeUndefined();
    expect(checks[0].note).toBe("The product page could not be read");
  });

  it("opens at most one claim across repeated qualifying checks (D20 idempotency)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const first = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    const second = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_000));

    expect(first.claimId).not.toBeNull();
    expect(second.claimId).toBeNull();
    expect(second.note).toBe("Claim already open");
    expect(await claimsFor(t, itemId)).toHaveLength(1);
    // Both observations are still on the record.
    expect(await checksFor(t, itemId)).toHaveLength(2);
  });

  it("opens a fresh claim once the earlier one is dismissed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const first = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    await t.run((ctx) => ctx.db.patch(first.claimId!, { status: "dismissed" }));
    const second = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_000));

    expect(second.claimId).not.toBeNull();
    expect(await claimsFor(t, itemId)).toHaveLength(2);
  });

  it("never claims a settled drop twice, and claims only the new remainder if the price falls further", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const first = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    await t.run((ctx) => ctx.db.patch(first.claimId!, { status: "confirmed" }));

    // Same price again after the money came back: nothing new to ask for.
    const same = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    expect(same.claimId).toBeNull();
    expect(same.note).toBe("Drop already claimed");

    // A further fall is a fresh ask for the difference only.
    const further = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_000));
    expect(further.claimId).not.toBeNull();
    const second = await t.run((ctx) => ctx.db.get(further.claimId!));
    // Paid 120.00: 25.00 was settled at 95.00, so 90.00 leaves 5.00 new.
    expect(second!.expectedCents).toBe(500);
    expect(await claimsFor(t, itemId)).toHaveLength(2);
  });

  it("opens nothing for a purchase with no confirmed date (D25)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, {
      purchasedAt: undefined,
      status: "needs_review",
    });

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    expect(res.claimId).toBeNull();
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });
});

describe("priceWatch.eligibleItems", () => {
  it("lists a watchable item", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([itemId]);
  });

  it("skips example purchases (D27)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await world(t, userId, { isExample: true });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("skips purchases that are not active or have no purchasedAt (D25)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await world(t, userId, { status: "needs_review", purchasedAt: undefined });
    await world(t, userId, { status: "archived" });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("skips items with no product URL and items the user returned", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await world(t, userId, { productUrl: undefined });
    await world(t, userId, { returned: true });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("skips a merchant whose policy states no price-adjustment window", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await world(t, userId, { windowDays: undefined });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("skips an item whose price-adjustment window has closed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await world(t, userId, { purchasedAt: Date.now() - 30 * DAY });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("skips an item that already has an open price claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);
    await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
  });

  it("uses the newest policy snapshot for the merchant (D17)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, { purchasedAt: Date.now() - 20 * DAY });
    // The original 14-day window is closed; a newer 60-day snapshot reopens it.
    await new Promise((r) => setTimeout(r, 3));
    await t.run((ctx) =>
      ctx.db.insert("policies", {
        userId,
        merchantDomain: DOMAIN,
        kind: "price_adjustment",
        windowDays: 60,
        channel: "email",
        passage: "60 days",
        sourceUrl: `https://${DOMAIN}/policy`,
        retrievedAt: Date.now(),
        confidence: 0.9,
        confirmedByUser: false,
      }),
    );

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([itemId]);
  });

  it("does not list another user's item as belonging to this sweep twice", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const one = await world(t, a.userId);
    const two = await world(t, b.userId);

    const ids = await t.mutation(internal.priceWatch.eligibleItems, {});
    expect(new Set(ids)).toEqual(new Set([one.itemId, two.itemId]));
  });

  it("D74: caps one user's eligible items at PRICE_CHECK_PER_USER_PER_TICK, but still lists another user's item", async () => {
    const t = setup();
    const heavy = await signedIn(t, "Heavy");
    const light = await signedIn(t, "Light");
    const heavyItems: Id<"items">[] = [];
    for (let i = 0; i < PRICE_CHECK_PER_USER_PER_TICK + 5; i++) {
      const { itemId } = await world(t, heavy.userId, { productUrl: `${URL}?v=${i}` });
      heavyItems.push(itemId);
    }
    const { itemId: lightItemId } = await world(t, light.userId);

    const before = Date.now();
    const ids = await t.mutation(internal.priceWatch.eligibleItems, {});
    const heavyCount = ids.filter((id) => heavyItems.includes(id)).length;
    expect(heavyCount).toBe(PRICE_CHECK_PER_USER_PER_TICK);
    expect(ids).toContain(lightItemId);

    // F1 (D103): the 5 over-cap items are rotated (bumped WATCH_CHECK_INTERVAL_MS,
    // like watches.sweep's per-user-capped bucket), not left untouched at the
    // head of the next tick's scan.
    const rotated = heavyItems.filter((id) => !ids.includes(id));
    expect(rotated).toHaveLength(5);
    for (const id of rotated) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row!.nextCheckAt).toBeGreaterThanOrEqual(before + WATCH_CHECK_INTERVAL_MS);
      expect(row!.nextCheckAt).toBeLessThan(before + WATCH_CHECK_INTERVAL_MS + INELIGIBLE_REST_MS);
    }
  });

  it("items.by_nextCheck ascending: never-stamped items (undefined) sort before a stamped future one", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId: stamped } = await world(t, userId, { productUrl: `${URL}?stamped` });
    await t.run((ctx) => ctx.db.patch(stamped, { nextCheckAt: Date.now() + 999_999 }));
    const { itemId: fresh } = await world(t, userId, { productUrl: `${URL}?fresh` });

    const ids = await t.mutation(internal.priceWatch.eligibleItems, {});
    expect(ids.indexOf(fresh)).toBeLessThan(ids.indexOf(stamped));
  });

  it("D87: skips a tombstoned owner's item", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    expect(await t.query(internal.priceWatch.itemForCheck, { itemId })).toBeNull();
  });
});

/** Inserts a purchase and its price-adjustment policy, without an item. Cheap bulk fixture for the F1 tests below. */
async function purchaseAndPolicy(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  o: { purchasedAt?: number } = {},
): Promise<Id<"purchases">> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: DOMAIN,
      purchasedAt: "purchasedAt" in o ? o.purchasedAt : Date.now() - 2 * DAY,
      currency: "USD",
      status: "active",
    });
    await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      contactEmail: "help@acme.example",
      passage: "We adjust the price within 14 days of purchase.",
      sourceUrl: `https://${DOMAIN}/policy`,
      retrievedAt: Date.now(),
      confidence: 0.9,
      confirmedByUser: false,
    });
    return purchaseId;
  });
}

describe("priceWatch.eligibleItems — F1 starvation regressions (D103)", () => {
  it("500 no-productUrl items, older than one eligible item, never permanently block it: it is found once the backlog is stamped out of the way", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId);
    const noUrlIds: Id<"items">[] = await t.run(async (ctx) => {
      const ids: Id<"items">[] = [];
      for (let i = 0; i < 500; i++) {
        ids.push(
          await ctx.db.insert("items", {
            purchaseId,
            userId,
            name: `No URL ${i}`,
            unitCents: 1_000,
            qty: 1,
            returned: false,
          }),
        );
      }
      return ids;
    });
    // Created after the backlog, so it is newer in `by_nextCheck`'s tied
    // (all-undefined) ordering and sorts behind all 500 of them.
    const { itemId: eligibleId } = await world(t, userId, { productUrl: `${URL}?eligible` });

    // The whole SCAN_LIMIT (500) page is the backlog on this call; before
    // this fix, none of it was ever stamped, so it would occupy the exact
    // same page on every subsequent tick forever, and the eligible item
    // (positioned 501st) would never be reached. Now every scanned item is
    // stamped, whether or not it was eligible.
    const before = Date.now();
    const firstPage = await t.mutation(internal.priceWatch.eligibleItems, {});
    expect(firstPage).not.toContain(eligibleId);
    for (const id of noUrlIds) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);
    }

    // The backlog has left the head of the index; the eligible item is found.
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([eligibleId]);
  }, 30_000);

  it("500 items whose price-adjustment window has closed, older than one eligible item, are recovered the same way", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId, { purchasedAt: Date.now() - 30 * DAY });
    const closedIds: Id<"items">[] = await t.run(async (ctx) => {
      const ids: Id<"items">[] = [];
      for (let i = 0; i < 500; i++) {
        ids.push(
          await ctx.db.insert("items", {
            purchaseId,
            userId,
            name: `Closed window ${i}`,
            unitCents: 1_000,
            qty: 1,
            productUrl: `${URL}?closed=${i}`,
            returned: false,
          }),
        );
      }
      return ids;
    });
    const { itemId: eligibleId } = await world(t, userId, { productUrl: `${URL}?eligible-closed` });

    const before = Date.now();
    const firstPage = await t.mutation(internal.priceWatch.eligibleItems, {});
    expect(firstPage).not.toContain(eligibleId);
    for (const id of closedIds) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);
    }

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([eligibleId]);
  }, 30_000);
});

/**
 * C3/D107 (Opus checkpoint-5 recheck, F1 resurrection). Each test reproduces
 * the DA scenario: exactly SCAN_LIMIT (500) items -- 499 permanently-
 * ineligible fillers plus one target that also starts permanently
 * ineligible -- so tick 1 stamps everything (including the target) a year
 * out, then a resurrection event happens, then tick 2 must find the target:
 * proof that the resurrection path actually un-stamps the item rather than
 * leaving it to rest behind the year-long bump for up to `INELIGIBLE_REST_MS`.
 */
describe("priceWatch — C3/D107 resurrection paths", () => {
  async function fillerAndTarget(
    t: ReturnType<typeof setup>,
    userId: Id<"users">,
    purchaseId: Id<"purchases">,
    targetOverrides: Partial<{ productUrl: string; returned: boolean }>,
  ): Promise<Id<"items">> {
    return await t.run(async (ctx) => {
      for (let i = 0; i < 499; i++) {
        await ctx.db.insert("items", {
          purchaseId,
          userId,
          name: `Filler ${i}`,
          unitCents: 1_000,
          qty: 1,
          returned: false, // no productUrl: permanently ineligible on this active purchase
        });
      }
      return await ctx.db.insert("items", {
        purchaseId,
        userId,
        name: "Target",
        unitCents: 1_000,
        qty: 1,
        productUrl: "productUrl" in targetOverrides ? targetOverrides.productUrl : undefined,
        returned: targetOverrides.returned ?? false,
      });
    });
  }

  it("(i) a no-URL item gets a productUrl via a direct patch + clearItemSchedule: scheduled within 2 ticks", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId);
    const targetId = await fillerAndTarget(t, userId, purchaseId, {});

    // Tick 1: the whole SCAN_LIMIT page is the 499 fillers + the target
    // (also linkless) -- every one of them, including the target, gets
    // stamped INELIGIBLE_REST_MS.
    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const stamped = await t.run((ctx) => ctx.db.get(targetId));
    expect(stamped!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);

    // Resurrection: the item gains a link outside any wired mutation (e.g. a
    // direct data fix); the caller is responsible for clearing the schedule
    // itself, exactly like `purchases.confirm` does.
    await t.run(async (ctx) => {
      await ctx.db.patch(targetId, { productUrl: URL });
      await clearItemSchedule(ctx, [targetId]);
    });

    // Tick 2: the 499 fillers are now stamped a year out; the target (its
    // stamp cleared) sorts back to the head and is found.
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([targetId]);
  }, 30_000);

  it("(ii) a returned item un-returned via purchases.setReturned: scheduled within 2 ticks", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId);
    const targetId = await fillerAndTarget(t, userId, purchaseId, { productUrl: URL, returned: true });

    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const stamped = await t.run((ctx) => ctx.db.get(targetId));
    expect(stamped!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);

    // The real, wired call site (C3d): purchases.setReturned(false).
    await as.mutation(api.purchases.setReturned, { itemId: targetId, returned: false });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([targetId]);
  }, 30_000);

  it("(iii) a closed price-adjustment window reopened via policies.confirm: scheduled within 2 ticks", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    // A purchase old enough that the original 14-day window is closed.
    const purchaseId = await purchaseAndPolicy(t, userId, { purchasedAt: Date.now() - 30 * DAY });
    const policy = await t.run((ctx) =>
      ctx.db
        .query("policies")
        .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", DOMAIN).eq("kind", "price_adjustment"))
        .unique(),
    );
    const targetId = await fillerAndTarget(t, userId, purchaseId, { productUrl: URL });

    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const stamped = await t.run((ctx) => ctx.db.get(targetId));
    expect(stamped!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);

    // The real, wired call site (C3c): policies.confirm reopens the window.
    await as.mutation(api.policies.confirm, {
      policyId: policy!._id,
      windowDays: 60,
      channel: policy!.channel,
    });

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([targetId]);
  }, 30_000);

  it("(iv) a needs_review item with no link is NOT stamped a year out (only C3a, no resurrection needed)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId, {
      status: "needs_review",
      purchasedAt: undefined,
      productUrl: undefined,
    });

    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const row = await t.run((ctx) => ctx.db.get(itemId));
    // Transient (WATCH_CHECK_INTERVAL_MS-scale), never the year-long
    // INELIGIBLE_REST_MS bump a `needs_review` purchase's linkless item used
    // to get before the purchase-status check ran at all.
    expect(row!.nextCheckAt).toBeGreaterThanOrEqual(before + WATCH_CHECK_INTERVAL_MS);
    expect(row!.nextCheckAt).toBeLessThan(before + INELIGIBLE_REST_MS);
  });
});

describe("priceWatch.runAll rotation (D74)", () => {
  const T0 = Date.UTC(2026, 8, 20, 12);
  afterEach(() => vi.useRealTimers());

  it("bumps nextCheckAt WATCH_CHECK_INTERVAL_MS for scheduled items and WATCH_SWEEP_BUMP_MS for budget-skipped ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId: a } = await world(t, userId, { productUrl: `${URL}?a` });
    const { itemId: b } = await world(t, userId, { productUrl: `${URL}?b` });
    await t.run((ctx) =>
      ctx.db.insert("usage", { day: "2026-09-20", kind: "price_check", count: GLOBAL_DAILY_BUDGETS.price_check.max - 1 }),
    );

    expect(await t.action(internal.priceWatch.runAll, {})).toBe(1);
    const rowA = await t.run((ctx) => ctx.db.get(a));
    const rowB = await t.run((ctx) => ctx.db.get(b));
    // One of the two got the single remaining budget unit and a full-interval bump; the other was
    // only rotated a short way forward so it is near the front of the next tick's scan.
    const scheduledRow = rowA!.nextCheckAt === T0 + WATCH_CHECK_INTERVAL_MS ? rowA! : rowB!;
    const skippedRow = scheduledRow === rowA ? rowB! : rowA!;
    expect(scheduledRow.nextCheckAt).toBe(T0 + WATCH_CHECK_INTERVAL_MS);
    expect(skippedRow.nextCheckAt).toBe(T0 + WATCH_SWEEP_BUMP_MS);
  });
});

describe("priceWatch.itemForCheck (F4)", () => {
  it("returns null when the stored productUrl no longer parses as a real product link", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);
    // Not reachable through `purchases.create`/`confirm` any more (both now
    // validate), but a legacy row or a direct DB write could still carry one.
    await t.run((ctx) => ctx.db.patch(itemId, { productUrl: "javascript:alert(1)" }));

    expect(await t.query(internal.priceWatch.itemForCheck, { itemId })).toBeNull();
  });

  it("returns the item for a real product link", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const result = await t.query(internal.priceWatch.itemForCheck, { itemId });
    expect(result).toMatchObject({ productUrl: URL, currency: "USD" });
  });
});

describe("priceWatch.checkNow", () => {
  it("schedules a check for an item the caller owns", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId);

    await expect(as.mutation(api.priceWatch.checkNow, { itemId })).resolves.toBeNull();

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].name).toContain("priceWatch");
  });

  it("refuses an item belonging to another user", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { itemId } = await world(t, owner.userId);

    await expect(other.as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(
      ConvexError,
    );
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled).toHaveLength(0);
  });

  it("refuses a signed-out caller", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    await expect(t.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(ConvexError);
  });

  it("refuses an item with no product page", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId, { productUrl: undefined });

    await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(ConvexError);
  });

  it("refuses a second check inside the cooldown, and allows one after it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId);
    await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      sourceUrl: URL,
      note: "nothing found",
    });

    await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(ConvexError);

    // Age the observation past the cooldown.
    const checks = await checksFor(t, itemId);
    await t.run((ctx) =>
      ctx.db.patch(checks[0]._id, { observedAt: Date.now() - 120_000 }),
    );
    await expect(as.mutation(api.priceWatch.checkNow, { itemId })).resolves.toBeNull();
  });
});

describe("item images", () => {
  it("stores the page image on the item only when it is an absolute https URL", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { itemId } = await world(t, userId);
    const item = () => t.run((ctx) => ctx.db.get(itemId));
    for (const imageUrl of ["http://cdn.acme.example/i.jpg", "/i/jacket.jpg", "javascript:alert(1)"]) {
      await t.mutation(internal.priceWatch.recordCheck, { ...good(itemId, 11_900), imageUrl });
      expect((await item())?.imageUrl).toBeUndefined();
    }
    const overviewBefore = await as.query(api.tracking.overview, {});
    expect(overviewBefore.items[0].imageUrl).toBeUndefined();

    await t.mutation(internal.priceWatch.recordCheck, { ...good(itemId, 11_900), imageUrl: "https://cdn.acme.example/i/jacket.jpg" });
    expect((await item())?.imageUrl).toBe("https://cdn.acme.example/i/jacket.jpg");
    await t.mutation(internal.priceWatch.recordCheck, good(itemId, 11_900)); // no image this time: kept
    expect((await item())?.imageUrl).toBe("https://cdn.acme.example/i/jacket.jpg");
    const overview = await as.query(api.tracking.overview, {});
    expect(overview.items[0].imageUrl).toBe("https://cdn.acme.example/i/jacket.jpg");

    await t.mutation(internal.priceWatch.recordCheck, { ...good(itemId, 11_900), variantMatch: "none", imageUrl: "https://cdn.acme.example/other.jpg" });
    expect((await item())?.imageUrl).toBe("https://cdn.acme.example/i/jacket.jpg");
  });
});

describe("priceWatch.checkNow spend caps (pre-launch review H1, M1)", () => {
  afterEach(() => vi.useRealTimers());
  const T0 = Date.UTC(2026, 8, 20, 12);
  type T = ReturnType<typeof setup>;
  const pending = async (t: T) =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((j) => j.name.includes("checkItem")).length;
  const usage = async (t: T) => await t.run((ctx) => ctx.db.query("usage").collect());

  it("a second click before the first check has recorded anything is refused (the racy cooldown)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId);

    await as.mutation(api.priceWatch.checkNow, { itemId });
    expect((await t.run((ctx) => ctx.db.get(itemId)))?.checkRequestedAt).toBe(T0);
    // Nothing has been recorded yet; the old guard let every one of these through.
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T0 + (i + 1) * 5_000);
      await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(/just checked/);
    }
    expect(await pending(t)).toBe(1);
    expect((await usage(t)).find((r) => r.userId === userId)?.count).toBe(1);

    vi.setSystemTime(T0 + 61_000);
    await as.mutation(api.priceWatch.checkNow, { itemId });
    expect(await pending(t)).toBe(2);
  });

  it(`stops at ${DAILY_BUDGETS.item_check.max} manual checks a day per user, across items, and draws from the global switch`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = setup();
    const { userId, as } = await signedIn(t);
    const max = DAILY_BUDGETS.item_check.max;
    const items: Id<"items">[] = [];
    for (let i = 0; i <= max; i++) items.push((await world(t, userId)).itemId);

    for (let i = 0; i < max; i++) await as.mutation(api.priceWatch.checkNow, { itemId: items[i] });
    await expect(as.mutation(api.priceWatch.checkNow, { itemId: items[max] })).rejects.toThrow(
      /today's limit for checking prices on your purchases/,
    );
    expect(await pending(t)).toBe(max);
    const rows = await usage(t);
    expect(rows.find((r) => r.userId === undefined)).toMatchObject({ kind: "price_check", count: max });

    const other = await signedIn(t, "Other");
    const theirs = await world(t, other.userId);
    await other.as.mutation(api.priceWatch.checkNow, { itemId: theirs.itemId });
  });

  it("a spent global switch refuses a manual check and charges the user nothing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("usage", { day: "2026-09-20", kind: "price_check", count: GLOBAL_DAILY_BUDGETS.price_check.max }),
    );
    await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(/Recoup has reached today's limit for price checks/);
    expect(await pending(t)).toBe(0);
    expect((await usage(t)).filter((r) => r.userId === userId)).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(itemId)))?.checkRequestedAt).toBeUndefined();
  });

  it("never scrapes an example purchase, an archived one, or a stored link the validator refuses", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId, as } = await signedIn(t);
    const example = await world(t, userId, { isExample: true });
    const archived = await world(t, userId, { status: "archived" });
    const legacy = await world(t, userId, { productUrl: "http://metadata.google.internal/computeMetadata/v1/" });
    for (const { itemId } of [example, archived, legacy]) {
      await expect(as.mutation(api.priceWatch.checkNow, { itemId })).rejects.toThrow(ConvexError);
    }
    // The cron's last stop before the scraper refuses the legacy link too.
    expect(await t.query(internal.priceWatch.itemForCheck, { itemId: legacy.itemId })).toBeNull();
    expect(await pending(t)).toBe(0);
    expect(await usage(t)).toHaveLength(0);
  });

  it("the cron fans out only what the global switch still allows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < 5; i++) await world(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("usage", { day: "2026-09-20", kind: "price_check", count: GLOBAL_DAILY_BUDGETS.price_check.max - 2 }),
    );
    expect(await t.action(internal.priceWatch.runAll, {})).toBe(2);
    expect(await pending(t)).toBe(2);
    expect(await t.action(internal.priceWatch.runAll, {})).toBe(0);
    expect(await pending(t)).toBe(2);
  });
});
