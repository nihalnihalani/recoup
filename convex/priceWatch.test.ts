import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { fetchBothImpl } from "./policies";
import { MIN_PLAUSIBLE_FRACTION, implausiblyCheap } from "./priceWatch";
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
 * C3/D107 (Opus checkpoint-5 recheck, F1 resurrection) -- rewritten per
 * checkpoint 6a's 6a-3/D112 finding.
 *
 * The original fixture (499 PERMANENTLY-ineligible fillers + 1 target,
 * exactly SCAN_LIMIT (500) items total in the whole account) was vacuous:
 * `eligibleItems` has no `nextCheckAt <= now` filter at all -- `by_nextCheck`
 * is a rotation key, not a due-queue -- so `take(SCAN_LIMIT)` simply reads
 * whatever `SCAN_LIMIT` items sort first. With only 500 items in the entire
 * account, `take(500)` always reads every one of them, every tick, whether
 * or not the target's own stamp was ever reset. The tests "passed" even when
 * `clearItemSchedule`/`clearMerchantItemSchedule` did nothing, because each
 * resurrection call site *also* unconditionally patches the underlying field
 * (`item.returned`, `item.productUrl`, the policy's `windowDays`) in the
 * SAME mutation -- so the item became genuinely eligible on the very next
 * scan regardless of whether its schedule stamp was actually cleared.
 *
 * Fixed by giving the account 500 TRANSIENT fillers -- items on a
 * `needs_review` purchase, so `watchWindow` returns `{permanent: false}` for
 * them (the purchase-status branch) and `eligibleItems` restamps each one
 * `+WATCH_CHECK_INTERVAL_MS` (2h) *every tick it scans them* -- plus the
 * target, on its own separate, real purchase. `SCAN_LIMIT` fillers with a
 * stamp that keeps refreshing to a low value is exactly the condition the
 * finding names: "a +1y stamp hides an item only while >= SCAN_LIMIT items
 * with LOWER stamps exist and those must be transient". The target is
 * inserted FIRST (before the fillers), so on tick 1 -- when every stamp is
 * still `undefined` and ties break on ascending `_creationTime` -- it is
 * read before (at least some of) the 500 fillers and gets its own
 * `INELIGIBLE_REST_MS` stamp that tick, same as before. If a resurrection
 * call site's un-stamp step is neutered, the target's stale, high stamp
 * always sorts after the 500 fillers' freshly-refreshed low ones on every
 * later tick, so it is never read again -- `eligibleItems` returns `[]`
 * forever, not `[targetId]`, and the test genuinely fails.
 *
 * Proof this is no longer vacuous (done once, locally, per D112's
 * instruction, then reverted -- not part of this commit): with
 * `clearItemSchedule` and `clearMerchantItemSchedule` in `lib/schedule.ts`
 * both edited to return immediately (`export async function
 * clearItemSchedule() {}` / `export async function
 * clearMerchantItemSchedule() {}`), all four tests below FAIL (the tick-2
 * assertion gets `[]` instead of `[targetId]`); with the real helpers
 * restored, all four PASS. See this task's final report for the exact
 * command and output.
 */
describe("priceWatch — C3/D107 resurrection paths", () => {
  /** Matches SCAN_LIMIT; see the describe-block comment above for why. */
  const FILLER_COUNT = 500;

  /**
   * 500 transient fillers (on their own separate `needs_review` purchase, a
   * different merchant so they never interact with the target's own
   * merchant/policy) plus one target item on `targetPurchaseId`, inserted
   * FIRST so it is read on tick 1 (see the describe-block comment).
   */
  async function fillerAndTarget(
    t: ReturnType<typeof setup>,
    userId: Id<"users">,
    targetPurchaseId: Id<"purchases">,
    targetOverrides: Partial<{ productUrl: string; returned: boolean }>,
  ): Promise<Id<"items">> {
    return await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("items", {
        purchaseId: targetPurchaseId,
        userId,
        name: "Target",
        unitCents: 1_000,
        qty: 1,
        productUrl: "productUrl" in targetOverrides ? targetOverrides.productUrl : undefined,
        returned: targetOverrides.returned ?? false,
      });
      const fillerPurchaseId = await ctx.db.insert("purchases", {
        userId,
        merchant: "Filler Co",
        merchantDomain: "filler.example",
        status: "needs_review",
        currency: "USD",
      });
      for (let i = 0; i < FILLER_COUNT; i++) {
        await ctx.db.insert("items", {
          purchaseId: fillerPurchaseId,
          userId,
          name: `Filler ${i}`,
          unitCents: 1_000,
          qty: 1,
          returned: false, // needs_review purchase: transient, not permanent (C3a)
        });
      }
      return targetId;
    });
  }

  it("(i) a no-URL item gets a productUrl via purchases.confirm: scheduled within 2 ticks", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId);
    const targetId = await fillerAndTarget(t, userId, purchaseId, {});

    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const stamped = await t.run((ctx) => ctx.db.get(targetId));
    expect(stamped!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);

    // The real, wired call site (6a-4/D112): purchases.confirm, which now
    // un-stamps every item on the purchase via items.by_purchase, not only
    // ones the caller resubmits in args.items.
    const purchase = (await t.run((ctx) => ctx.db.get(purchaseId)))!;
    await as.mutation(api.purchases.confirm, {
      purchaseId,
      merchant: purchase.merchant,
      merchantDomain: purchase.merchantDomain,
      purchasedAt: purchase.purchasedAt!,
      items: [{ itemId: targetId, name: "Target", unitCents: 1_000, qty: 1, productUrl: URL }],
    });

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

  it("(iv) a closed price-adjustment window reopened via the automatic re-research (fetchBothImpl, 6a-5/D112): scheduled within 2 ticks", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId, { purchasedAt: Date.now() - 30 * DAY });
    const targetId = await fillerAndTarget(t, userId, purchaseId, { productUrl: URL });

    const before = Date.now();
    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([]);
    const stamped = await t.run((ctx) => ctx.db.get(targetId));
    expect(stamped!.nextCheckAt).toBeGreaterThanOrEqual(before + INELIGIBLE_REST_MS);

    // Make the existing snapshot stale enough that fetchBothImpl actually
    // re-researches it instead of skipping (M1/POLICY_REFETCH_MIN_AGE_MS).
    await t.run(async (ctx) => {
      const policy = await ctx.db
        .query("policies")
        .withIndex("by_user_domain_kind", (q) => q.eq("userId", userId).eq("merchantDomain", DOMAIN).eq("kind", "price_adjustment"))
        .unique();
      await ctx.db.patch(policy!._id, { retrievedAt: Date.now() - 25 * 3_600_000 });
    });

    // The real, wired call site (6a-5/D112): fetchBothImpl -- what the
    // scheduler's internalAction `fetchBoth` calls -- lands a widened
    // snapshot through the existing mocked-deps seam and un-stamps this
    // merchant's items via clearMerchantSchedule -> clearMerchantItemSchedule.
    const markdown = "# Price Match\n\nWe match a lower price within 60 days of purchase.\n" + " ".repeat(150);
    const passage = "We match a lower price within 60 days of purchase.";
    await fetchBothImpl(
      { runMutation: (ref: any, a: any) => t.mutation(ref, a), runQuery: (ref: any, a: any) => t.query(ref, a) },
      { userId, merchantDomain: DOMAIN },
      {
        search: async () => ({ web: [{ url: `https://${DOMAIN}/policy`, markdown }] }),
        extract: async () => ({
          found: true,
          windowDays: 60,
          channel: "email",
          contactEmail: `help@${DOMAIN}`,
          passage,
          confidence: 0.9,
        }),
      },
    );

    expect(await t.mutation(internal.priceWatch.eligibleItems, {})).toEqual([targetId]);
  }, 30_000);

  // 6a-3/D112 asked that each rewritten test stay under Convex's real
  // per-transaction ceilings (32,000 documents read, 4,096 index-range
  // queries) and that the numbers be reported. Measured once here, directly
  // (same ctx.meta.getTransactionMetrics() mechanism T07's
  // readBudget.test.ts and 6a-6's lib/schedule.test.ts measurement use),
  // against the fixture shared by tests (i)-(iv): 500 transient fillers on a
  // needs_review purchase plus one target, i.e. exactly SCAN_LIMIT+1 items --
  // the heaviest single `eligibleItems` tick any of the four tests runs.
  it("read cost: one eligibleItems tick over 500 transient fillers + 1 target stays a small fraction of Convex's per-transaction ceilings", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await purchaseAndPolicy(t, userId);
    await fillerAndTarget(t, userId, purchaseId, {});

    const { documentsRead, databaseQueries, bytesRead } = await t.run(async (ctx) => {
      await ctx.runMutation(internal.priceWatch.eligibleItems, {});
      const m = await ctx.meta.getTransactionMetrics();
      return { documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used, bytesRead: m.bytesRead.used };
    });

    // eslint-disable-next-line no-console
    console.log(
      "[read-budget]",
      JSON.stringify({ name: "priceWatch.eligibleItems", fixture: "500 transient fillers + 1 target", documentsRead, databaseQueries, bytesRead }),
    );
    expect(documentsRead).toBeLessThan(32_000);
    expect(databaseQueries).toBeLessThan(4_096);
  }, 30_000);
});

describe("priceWatch.eligibleItems — needs_review linkless item is not stamped a year out (C3a/D107)", () => {
  it("a needs_review item with no link gets the transient bump, never the permanent one (no resurrection needed)", async () => {
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

describe("T24c (D109): checkItem's scrape-failure line is structured and redacted", () => {
  it("logs one price_check_failed JSON line via logEvent, never a raw provider body, on a scrape failure", async () => {
    // Same technique policies.test.ts uses for researchPolicy's own scrape-failure path: no real
    // network, only the Firecrawl component's own real (short) retry/backoff timers elapse for real.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await t.action(internal.priceWatch.checkItem, { itemId });

    expect(spy).toHaveBeenCalled();
    const line = JSON.parse(spy.mock.calls.at(-1)![0] as string) as Record<string, unknown>;
    spy.mockRestore();
    expect(line.kind).toBe("price_check_failed");
    expect(line.itemId).toBe(String(itemId));
    expect(typeof line.error).toBe("string");
    // correlationId/at are excluded before the leak check below: correlationId is a random UUID
    // (crypto.randomUUID()) whose hex/hyphen characters can incidentally match the sk-/fc- shape
    // (~1% per run) -- not a leak, just a coincidental substring of a random id.
    delete line.correlationId;
    delete line.at;
    const raw = JSON.stringify(line);
    // sanitizeError collapses the raw provider message down to one of a small set of fixed,
    // user-safe categories (convex/lib/errors.ts) -- never the provider's own body verbatim.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/fc-[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  }, 20_000);
});

describe("T18.5 (D124 B4): priceWatch.recordCheck is tombstone-gated, like every sibling recorder", () => {
  // Real timers elsewhere in this file would let `requestDeletion`'s
  // scheduled `purge` actually run in the background between the two
  // `await`s below (convex-test's scheduler is driven by real setTimeout
  // when fake timers are not active), racily deleting the item itself
  // before `recordCheck` runs and masking the very gate this test checks.
  // Fake timers keep that scheduled call frozen, so only the tombstone row
  // exists -- exactly the "mid-purge" moment (`accountState` written,
  // `purgeStep` not yet run) this test means to exercise.
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("before/after: a scrape finishing mid-purge (after requestDeletion) writes no priceChecks row and opens no claim [FAILS pre-T18.5]", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { itemId } = await world(t, userId);

    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    expect(res).toEqual({ priceCheckId: null, claimId: null, accepted: false, note: "Account deleted" });

    expect(await checksFor(t, itemId)).toHaveLength(0);
    expect(await claimsFor(t, itemId)).toHaveLength(0);
  });

  it("an active (non-tombstoned) owner's recordCheck is unaffected by the new gate", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { itemId } = await world(t, userId);

    const res = await t.mutation(internal.priceWatch.recordCheck, good(itemId, 9_500));
    expect(res.accepted).toBe(true);
    expect(res.priceCheckId).not.toBeNull();
    expect(await checksFor(t, itemId)).toHaveLength(1);
  });
});

describe("implausiblyCheap (live 2026-09-20: a $449.99 mixer read as $1.00)", () => {
  it("rejects a reading far below what was paid", () => {
    expect(implausiblyCheap(100, 44_999)).toMatch(/too far below/);
    expect(implausiblyCheap(1, 44_999)).not.toBeNull();
  });

  it("allows a deep but real clearance, which must stay claimable", () => {
    expect(implausiblyCheap(9_000, 44_999)).toBeNull();
    expect(implausiblyCheap(4_500, 44_999)).toBeNull();
  });

  it("allows anything at or above the floor", () => {
    expect(implausiblyCheap(Math.round(44_999 * MIN_PLAUSIBLE_FRACTION), 44_999)).toBeNull();
  });

  it("is quiet when there is nothing to judge", () => {
    expect(implausiblyCheap(undefined, 44_999)).toBeNull();
    expect(implausiblyCheap(100, 0)).toBeNull();
  });
});
