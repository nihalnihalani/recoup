/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import schema from "./schema";

/**
 * A second, isolated harness with strict transaction limits enforced (the
 * options-object form is required — the positional `convexTest(schema,
 * modules)` form silently ignores `transactionLimits`, per
 * node_modules/convex-test/dist/index.js). `setup()` in test.setup.ts does not
 * take options, so heavy-account safety is verified with its own instance
 * here rather than by editing that shared file (owned by another lane).
 */
const heavyModules = import.meta.glob("./**/*.*s");
function heavySetup() {
  return convexTest({ schema, modules: heavyModules, transactionLimits: true });
}

describe("insights.activity", () => {
  it("is empty for a signed-out caller", async () => {
    const t = setup();
    expect(await t.query(api.insights.activity, {})).toEqual({ events: [], truncated: false, windowNote: expect.any(String) });
    expect(await t.query(api.insights.sources, {})).toEqual({ rows: [], truncated: false, windowNote: expect.any(String) });
  });

  it("renders an empty signed-in account as all-zero, not an error", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    expect(await as.query(api.insights.activity, {})).toEqual({ events: [], truncated: false, windowNote: expect.any(String) });
    expect(await as.query(api.insights.sources, {})).toEqual({ rows: [], truncated: false, windowNote: expect.any(String) });
  });

  it("lists the example's price moves newest first, with signed deltas and no unchanged prices", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const { events: feed, truncated } = await as.query(api.insights.activity, {});
    expect(truncated).toBe(false);
    expect(feed.length).toBeGreaterThan(3);
    const times = feed.map((e) => e.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const drops = feed.filter((e) => e.kind === "price_drop");
    expect(drops.length).toBeGreaterThan(0);
    for (const e of drops) expect(e.deltaCents!).toBeLessThan(0);
    for (const e of feed.filter((x) => x.kind === "price_rise")) expect(e.deltaCents!).toBeGreaterThan(0);
    expect(feed.some((e) => e.deltaCents === 0)).toBe(false);
    expect(feed.some((e) => e.kind === "claim_opened")).toBe(true);
  });

  it("never leaks one user's activity or sources to another", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    await alice.mutation(api.examples.load, {});
    expect(await bob.query(api.insights.activity, {})).toEqual({ events: [], truncated: false, windowNote: expect.any(String) });
    expect(await bob.query(api.insights.sources, {})).toEqual({ rows: [], truncated: false, windowNote: expect.any(String) });
  });
});

describe("insights.sources", () => {
  it("counts a watched store and keeps example purchases out", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    await t.run(async (ctx) => {
      const watchId = await ctx.db.insert("watches", {
        userId,
        name: "Desk lamp",
        productUrl: "https://shop.example/p/lamp",
        merchantDomain: "shop.example",
        currency: "USD",
        status: "active",
        nextCheckAt: Date.now() + 3_600_000,
      });
      const at = Date.now();
      for (const [ago, cents] of [[3, 5000], [2, 4500], [1, undefined]] as const) {
        await ctx.db.insert("watchChecks", {
          watchId,
          userId,
          observedCents: cents,
          currency: "USD",
          observedAt: at - ago * 3_600_000,
          sourceUrl: "https://shop.example/p/lamp",
        });
      }
    });
    const { rows, truncated } = await as.query(api.insights.sources, {});
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.domain)).toEqual(["shop.example"]);
    expect(rows[0]).toMatchObject({
      watching: 1,
      checks: 3,
      priced: 2,
      drops: 1,
      bests: { USD: { cents: 4500, subject: "Desk lamp" } },
    });
  });
});

// ---------------------------------------------------------------------------
// P05 reproduction fixes: status-indexed reads, canonical counting,
// confirmed-offer-behind-candidates, per-currency bests, transaction safety.
// ---------------------------------------------------------------------------

describe("insights P05 accounting", () => {
  it("archive churn beyond the cap hides nothing active (watches and purchases)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const keeper = await seedWatch(t, userId, { name: "Keeper", slug: "keeper", checks: [[1, 1_000]] });
    for (let i = 0; i < 45; i++) {
      await seedWatch(t, userId, { name: `Gone ${i}`, slug: `gone${i}`, status: "archived", checks: [[1, 1]] });
    }
    await t.run(async (ctx) => {
      await ctx.db.insert("purchases", {
        userId, merchant: "Keeper store", merchantDomain: "keptstore.example", currency: "USD", status: "active",
      });
      for (let i = 0; i < 45; i++) {
        await ctx.db.insert("purchases", {
          userId, merchant: "Gone store", merchantDomain: `gonestore${i}.example`, currency: "USD", status: "archived",
        });
      }
    });

    const { rows, truncated } = await as.query(api.insights.sources, {});
    expect(truncated).toBe(false);
    expect(rows.map((r) => r.domain).sort()).toEqual(["acme.example", "keptstore.example"]);
    const keeperRow = rows.find((r) => r.domain === "acme.example")!;
    expect(keeperRow.watching).toBe(1);

    const { events } = await as.query(api.insights.activity, {});
    expect(events.some((e) => e.watchId === keeper)).toBe(true);
    expect(events.some((e) => e.subject === "Keeper store")).toBe(true);
  });

  it("45 active watches at one store are capped at MAX_WATCHES and flagged truncated", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    for (let i = 0; i < 45; i++) {
      await seedWatch(t, userId, { name: `Lamp ${i}`, slug: `lamp${i}`, checks: [[1, 1_000]] });
    }
    const { rows, truncated } = await as.query(api.insights.sources, {});
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].watching).toBe(40);
  });

  it("a bought watch's checks and count are carried by the purchase item exactly once", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { checks: [[1, 5_000], [2, 4_500], [3, 4_000]] });

    const purchaseId = await as.mutation(api.watches.markBought, {
      watchId,
      paidCents: 4_000,
      purchasedAt: BASE + 10 * HOUR,
      qty: 1,
    });
    expect(purchaseId).toBeTruthy();

    const { rows } = await as.query(api.insights.sources, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      domain: "acme.example",
      watching: 0,
      bought: 1,
      checks: 3,
      priced: 3,
      drops: 2,
      bests: { USD: { cents: 4_000, subject: "Desk lamp" } },
    });

    const { events } = await as.query(api.insights.activity, {});
    const drops = events.filter((e) => e.kind === "price_drop");
    expect(drops).toHaveLength(2);
    expect(events.some((e) => e.kind === "watch_added" && e.watchId === watchId)).toBe(false);
    expect(events.some((e) => e.kind === "purchase_added")).toBe(true);
  });

  it("a confirmed offer behind 25 unconfirmed candidates still appears", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { checks: [[1, 5_000]] });
    for (let i = 0; i < 25; i++) {
      await seedOffer(t, userId, watchId, { store: `noise${i}.example`, status: "candidate", lastCents: 1 });
    }
    await seedOffer(t, userId, watchId, { store: "cheap.example", status: "confirmed", lastCents: 999, lastCheckedAt: BASE + 1 * HOUR });

    const { rows } = await as.query(api.insights.sources, {});
    const store = rows.find((r) => r.domain === "cheap.example");
    expect(store).toBeDefined();
    expect(store).toMatchObject({ offers: 1, bests: { USD: { cents: 999, subject: "Desk lamp" } } });
  });

  it("reports USD and EUR bests separately at the same store, never a cross-currency min", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await seedWatch(t, userId, { name: "Dollar lamp", slug: "dollar", currency: "USD", checks: [[1, 5_000]] });
    await seedWatch(t, userId, { name: "Euro lamp", slug: "euro", currency: "EUR", checks: [[1, 4_000]] });

    const { rows } = await as.query(api.insights.sources, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].bests).toEqual({
      USD: { cents: 5_000, subject: "Dollar lamp" },
      EUR: { cents: 4_000, subject: "Euro lamp" },
    });
  });

  it("never leaks another user's watches, purchases or offers into sources/activity", async () => {
    const t = setup();
    const { as: alice, userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const watchId = await seedWatch(t, aliceId, { name: "Alice lamp", checks: [[1, 5_000]] });
    await seedOffer(t, aliceId, watchId, { store: "rei.example", status: "confirmed", lastCents: 4_000 });
    expect(await bob.query(api.insights.sources, {})).toEqual({ rows: [], truncated: false, windowNote: expect.any(String) });
    expect(await bob.query(api.insights.activity, {})).toEqual({ events: [], truncated: false, windowNote: expect.any(String) });
    const aliceSources = await alice.query(api.insights.sources, {});
    expect(aliceSources.rows.map((r) => r.domain).sort()).toEqual(["acme.example", "rei.example"]);
  });

  it("does not throw on a heavy account under strict transaction limits", async () => {
    const t = heavySetup();
    const { as, userId } = await signedIn(t);

    for (let i = 0; i < 45; i++) {
      const watchId = await seedWatch(t, userId, { name: `Heavy ${i}`, slug: `heavy${i}`, checks: [[1, 5_000], [2, 4_800]] });
      await seedOffer(t, userId, watchId, { store: `store${i}.example`, status: "confirmed", lastCents: 4_700, checks: [[1, 4_700]] });
    }
    await t.run(async (ctx) => {
      for (let i = 0; i < 45; i++) {
        const purchaseId = await ctx.db.insert("purchases", {
          userId, merchant: "Store", merchantDomain: `shop${i}.example`, currency: "USD", status: "active",
        });
        for (let j = 0; j < 5; j++) {
          const itemId = await ctx.db.insert("items", {
            purchaseId, userId, name: `Item ${j}`, unitCents: 1_000, qty: 1, returned: false,
          });
          for (let k = 0; k < 3; k++) {
            await ctx.db.insert("priceChecks", {
              itemId, userId, observedCents: 900 + k, currency: "USD", observedAt: BASE + k * HOUR, sourceUrl: "https://shopx.example/p",
            });
          }
        }
      }
    });

    const sources = await as.query(api.insights.sources, {});
    expect(sources.truncated).toBe(true);
    expect(sources.rows.length).toBeGreaterThan(0);
    const activity = await as.query(api.insights.activity, {});
    expect(activity.events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// priceHistory + trackedTable
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 8, 1, 12);
type T = ReturnType<typeof setup>;

async function seedWatch(
  t: T,
  userId: Id<"users">,
  o: { name?: string; slug?: string; status?: "active" | "paused" | "archived" | "bought"; imageUrl?: string; targetCents?: number; currency?: string; checks?: Array<[number, number | undefined]> } = {},
) {
  return await t.run(async (ctx) => {
    const productUrl = `https://www.acme.example/p/${o.slug ?? "lamp"}`;
    const priced = (o.checks ?? []).filter(([, c]) => c !== undefined);
    const currency = o.currency ?? "USD";
    const watchId = await ctx.db.insert("watches", {
      userId,
      name: o.name ?? "Desk lamp",
      productUrl,
      merchantDomain: "acme.example",
      currency,
      status: o.status ?? "active",
      nextCheckAt: BASE + 100 * HOUR,
      lastCents: priced.length > 0 ? priced[priced.length - 1][1] : undefined,
      lastCheckedAt: o.checks && o.checks.length > 0 ? BASE + o.checks[o.checks.length - 1][0] * HOUR : undefined,
      imageUrl: o.imageUrl,
      targetCents: o.targetCents,
    });
    for (const [hour, cents] of o.checks ?? []) {
      await ctx.db.insert("watchChecks", {
        watchId, userId, observedCents: cents, currency, observedAt: BASE + hour * HOUR, sourceUrl: productUrl,
        note: cents === undefined ? "The page does not show a single price" : undefined,
      });
    }
    return watchId;
  });
}

async function seedOffer(
  t: T,
  userId: Id<"users">,
  watchId: Id<"watches">,
  o: { store: string; status: "candidate" | "confirmed" | "rejected"; lastCents?: number; lastCheckedAt?: number; checks?: Array<[number, number]> },
) {
  return await t.run(async (ctx) => {
    const offerId = await ctx.db.insert("offers", {
      watchId, userId, storeDomain: o.store, productUrl: `https://${o.store}/p/1`, title: "Desk lamp", status: o.status,
      lastCents: o.lastCents, currency: "USD", lastCheckedAt: o.lastCheckedAt,
    });
    for (const [hour, cents] of o.checks ?? []) {
      await ctx.db.insert("offerChecks", { offerId, watchId, userId, observedCents: cents, currency: "USD", observedAt: BASE + hour * HOUR });
    }
    return offerId;
  });
}

describe("insights.priceHistory", () => {
  it("is null for a signed-out caller and for a caller with no watches", async () => {
    const t = setup();
    expect(await t.query(api.insights.priceHistory, {})).toBeNull();
    const { as } = await signedIn(t);
    expect(await as.query(api.insights.priceHistory, {})).toBeNull();
  });

  it("returns the primary series oldest first plus confirmed offers only, with changePct and lowest", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, {
      imageUrl: "https://cdn.acme.example/lamp.jpg",
      targetCents: 4_000,
      checks: [[1, 5_000], [2, undefined], [3, 4_500], [4, 4_800]],
    });
    await seedOffer(t, userId, watchId, { store: "rei.example", status: "confirmed", lastCents: 4_200, lastCheckedAt: BASE + 5 * HOUR, checks: [[2, 4_400], [3, 3_900], [5, 4_200]] });
    await seedOffer(t, userId, watchId, { store: "cand.example", status: "candidate", lastCents: 1_000, checks: [[2, 1_000]] });
    await seedOffer(t, userId, watchId, { store: "nope.example", status: "rejected", lastCents: 900, checks: [[2, 900]] });
    // The find marker is a rejected row too; it must never surface as a store.
    await seedOffer(t, userId, watchId, { store: "~find", status: "rejected" });

    const out = await as.query(api.insights.priceHistory, { watchId });
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ watchId, name: "Desk lamp", imageUrl: "https://cdn.acme.example/lamp.jpg", currency: "USD", status: "active", targetCents: 4_000 });
    expect(out!.stores.map((s) => [s.domain, s.isPrimary])).toEqual([["acme.example", true], ["rei.example", false]]);

    const [primary, rei] = out!.stores;
    expect(primary.points).toEqual([
      { at: BASE + 1 * HOUR, cents: 5_000 },
      { at: BASE + 3 * HOUR, cents: 4_500 },
      { at: BASE + 4 * HOUR, cents: 4_800 },
    ]);
    expect(primary).toMatchObject({ productUrl: "https://www.acme.example/p/lamp", firstCents: 5_000, lastCents: 4_800, changePct: -4, lastCheckedAt: BASE + 4 * HOUR });
    expect(rei.points.map((p) => p.cents)).toEqual([4_400, 3_900, 4_200]);
    // (4200 - 4400) / 4400 = -4.545...% -> one decimal
    expect(rei).toMatchObject({ productUrl: "https://rei.example/p/1", firstCents: 4_400, lastCents: 4_200, changePct: -4.5, lastCheckedAt: BASE + 5 * HOUR });
    expect(out!.lowest).toEqual({ cents: 3_900, at: BASE + 3 * HOUR, domain: "rei.example" });
    expect(out!.options).toEqual([{ watchId, name: "Desk lamp", stores: 2 }]);
  });

  it("gives a confirmed offer with a price but no offerChecks rows a single point, and no changePct", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { checks: [[1, 5_000]] });
    await seedOffer(t, userId, watchId, { store: "old.example", status: "confirmed", lastCents: 4_000, lastCheckedAt: BASE + 9 * HOUR });
    await seedOffer(t, userId, watchId, { store: "unread.example", status: "confirmed" });
    const out = await as.query(api.insights.priceHistory, { watchId });
    const old = out!.stores.find((s) => s.domain === "old.example")!;
    expect(old.points).toEqual([{ at: BASE + 9 * HOUR, cents: 4_000 }]);
    expect(old.changePct).toBeNull();
    expect(out!.stores[0].changePct).toBeNull(); // one primary point
    const unread = out!.stores.find((s) => s.domain === "unread.example")!;
    expect(unread).toMatchObject({ points: [], lastCents: null, firstCents: null, changePct: null, lastCheckedAt: null });
    expect(out!.lowest).toEqual({ cents: 4_000, at: BASE + 9 * HOUR, domain: "old.example" });
  });

  it("caps each series at the newest 120 points", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const checks: Array<[number, number]> = Array.from({ length: 130 }, (_, i) => [i, 10_000 + i]);
    const watchId = await seedWatch(t, userId, { checks });
    const out = await as.query(api.insights.priceHistory, { watchId });
    const points = out!.stores[0].points;
    expect(points).toHaveLength(120);
    expect(points[0].cents).toBe(10_010);
    expect(points[119].cents).toBe(10_129);
  });

  it("without a watchId picks most confirmed stores, then most observations, then newest; archived never", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const few = await seedWatch(t, userId, { name: "Few", slug: "few", checks: [[1, 100]] });
    const many = await seedWatch(t, userId, { name: "Many", slug: "many", checks: [[1, 100], [2, 110], [3, 120]] });
    const newest = await seedWatch(t, userId, { name: "Newest", slug: "newest", checks: [[1, 100]] });
    const archived = await seedWatch(t, userId, { name: "Gone", slug: "gone", status: "archived", checks: [[1, 1], [2, 2], [3, 3], [4, 4]] });
    await seedOffer(t, userId, archived, { store: "a.example", status: "confirmed", lastCents: 1 });
    await seedOffer(t, userId, archived, { store: "b.example", status: "confirmed", lastCents: 1 });

    // No offers anywhere live: most observations wins.
    expect((await as.query(api.insights.priceHistory, {}))!.watchId).toBe(many);

    // A confirmed store outranks observations; a candidate does not count.
    await seedOffer(t, userId, few, { store: "rei.example", status: "confirmed", lastCents: 90 });
    await seedOffer(t, userId, many, { store: "cand.example", status: "candidate", lastCents: 90 });
    const picked = await as.query(api.insights.priceHistory, {});
    expect(picked!.watchId).toBe(few);
    expect(picked!.options.map((o) => [o.name, o.stores])).toEqual([["Newest", 1], ["Many", 1], ["Few", 2]]);

    // Equal stores and equal observations: the newer watch.
    await seedOffer(t, userId, newest, { store: "rei.example", status: "confirmed", lastCents: 95 });
    expect((await as.query(api.insights.priceHistory, {}))!.watchId).toBe(newest);

    expect(await as.query(api.insights.priceHistory, { watchId: archived })).toBeNull();
  });

  it("is null for another user's watch, and never lists it as an option", async () => {
    const t = setup();
    const { as: alice, userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const watchId = await seedWatch(t, aliceId, { checks: [[1, 5_000]] });
    await seedOffer(t, aliceId, watchId, { store: "rei.example", status: "confirmed", lastCents: 4_000, checks: [[1, 4_000]] });
    expect(await alice.query(api.insights.priceHistory, { watchId })).not.toBeNull();
    expect(await bob.query(api.insights.priceHistory, { watchId })).toBeNull();
    expect(await bob.query(api.insights.priceHistory, {})).toBeNull();
    expect(await t.query(api.insights.priceHistory, { watchId })).toBeNull();
  });
});

describe("insights.trackedTable", () => {
  it("is empty for a signed-out caller", async () => {
    const t = setup();
    expect(await t.query(api.insights.trackedTable, {})).toEqual([]);
  });

  it("lists each live watch with its primary store and confirmed offers, newest first", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const lamp = await seedWatch(t, userId, { name: "Lamp", slug: "lamp", targetCents: 4_000, imageUrl: "https://cdn.acme.example/lamp.jpg", checks: [[1, 5_000], [2, 4_000]] });
    await seedOffer(t, userId, lamp, { store: "rei.example", status: "confirmed", lastCents: 3_800, checks: [[1, 4_000], [2, 3_800]] });
    await seedOffer(t, userId, lamp, { store: "cand.example", status: "candidate", lastCents: 100, checks: [[1, 100]] });
    await seedOffer(t, userId, lamp, { store: "nope.example", status: "rejected", lastCents: 50 });
    const chair = await seedWatch(t, userId, { name: "Chair", slug: "chair", status: "paused" });
    await seedWatch(t, userId, { name: "Gone", slug: "gone", status: "archived", checks: [[1, 1]] });

    const table = await as.query(api.insights.trackedTable, {});
    expect(table).toEqual([
      {
        watchId: chair, name: "Chair", imageUrl: null, status: "paused", currency: "USD", targetCents: null,
        stores: [{ domain: "acme.example", isPrimary: true, lastCents: null, changePct: null }],
        lowestCents: null, lowestDomain: null,
      },
      {
        watchId: lamp, name: "Lamp", imageUrl: "https://cdn.acme.example/lamp.jpg", status: "active", currency: "USD", targetCents: 4_000,
        stores: [
          { domain: "acme.example", isPrimary: true, lastCents: 4_000, changePct: -20 },
          { domain: "rei.example", isPrimary: false, lastCents: 3_800, changePct: -5 },
        ],
        lowestCents: 3_800, lowestDomain: "rei.example",
      },
    ]);
  });

  it("never shows one user's watches to another", async () => {
    const t = setup();
    const { as: alice, userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob, userId: bobId } = await signedIn(t, "Bob");
    const aliceWatch = await seedWatch(t, aliceId, { name: "Alice lamp", checks: [[1, 5_000]] });
    await seedOffer(t, aliceId, aliceWatch, { store: "rei.example", status: "confirmed", lastCents: 4_000 });
    const bobWatch = await seedWatch(t, bobId, { name: "Bob lamp", slug: "bob", checks: [[1, 6_000]] });
    expect((await alice.query(api.insights.trackedTable, {})).map((r) => r.watchId)).toEqual([aliceWatch]);
    const bobs = await bob.query(api.insights.trackedTable, {});
    expect(bobs.map((r) => r.watchId)).toEqual([bobWatch]);
    expect(JSON.stringify(bobs)).not.toContain("rei.example");
  });
});
