/// <reference types="vite/client" />
/**
 * P07-W5 (P01–P12 re-audit): market price history is bounded per watch, and readers see the NEWEST points. Before:
 * every refresh added up to MARKET_MAX_POINTS new rows with no pruning, and `watches.get` read the OLDEST
 * MARKET_MAX_POINTS through the ascending `by_watch` index — so after a few refreshes the verdict and chart showed
 * stale prices and never today's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { MARKET_MAX_POINTS } from "./limits";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 23, 12);


beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedWatch(t: T, userId: Id<"users">): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId, name: "Acme Down Jacket", productUrl: "https://www.acme.example/p/jacket", merchantDomain: "acme.example",
      status: "active", nextCheckAt: T0 + 3_600_000, currency: "USD", marketState: "running",
    }),
  );
}

const point = (i: number, cents: number) => ({
  retailer: "Other Store", storeDomain: "other-store.example", cents, currency: "USD", observedAt: T0 - (400 - i) * 3_600_000,
  marketKey: `other-store.example:${i}`,
});

async function rows(t: T, watchId: Id<"watches">) {
  return await t.run((ctx) => ctx.db.query("marketPrices").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect());
}

describe("P07-W5: market price history per watch", () => {
  it(`keeps at most ${MARKET_MAX_POINTS} points per watch across refreshes — the newest ones`, async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    for (const batch of [0, 1, 2]) {
      await t.run((ctx) => ctx.db.patch(watchId, { marketState: "running" }));
      const points = Array.from({ length: 100 }, (_, k) => point(batch * 100 + k, 5_000 + batch));
      await t.mutation(internal.market.recordSnapshot, { watchId, outcome: "success", points, stores: [] });
    }
    const kept = await rows(t, watchId);
    expect(kept).toHaveLength(MARKET_MAX_POINTS);
    const keys = new Set(kept.map((r) => r.marketKey));
    for (let i = 300 - MARKET_MAX_POINTS; i < 300; i++) expect(keys.has(`other-store.example:${i}`)).toBe(true);
  });

  it("watches.get's market summary reads the newest points, not the oldest", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    // 30 old cheap points, then MARKET_MAX_POINTS newer ones at today's price (inserted directly: history written
    // before the retention fix).
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) await ctx.db.insert("marketPrices", { ...point(i, 1_000), watchId, userId });
      for (let i = 30; i < 30 + MARKET_MAX_POINTS; i++) await ctx.db.insert("marketPrices", { ...point(i, 5_000), watchId, userId });
    });
    const res = await as.query(api.watches.get, { watchId, now: T0 });
    expect(res?.watch.market?.lowestCents).toBe(5_000);
    expect(res?.watch.market?.points).toHaveLength(MARKET_MAX_POINTS);
    expect(res?.watch.market?.since).toBe(point(30, 5_000).observedAt);
    expect(res?.watch.market?.points.at(-1)?.observedAt).toBe(point(30 + MARKET_MAX_POINTS - 1, 5_000).observedAt);
  });

  it("the retention cycle trims history written before the bound (P07-W5): points 400 days old beyond the newest are deleted", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) await ctx.db.insert("marketPrices", { ...point(i, 1_000), observedAt: T0 - 400 * 86_400_000 + i, watchId, userId });
      for (let i = 30; i < 30 + MARKET_MAX_POINTS; i++) await ctx.db.insert("marketPrices", { ...point(i, 5_000), watchId, userId });
    });
    for (let i = 0; i < 20; i++) {
      const r = await t.mutation(internal.retention.sweepRecovery, {});
      if (r.table === "marketPrices" && r.done) break;
    }
    const kept = await rows(t, watchId);
    expect(kept).toHaveLength(MARKET_MAX_POINTS);
    expect(kept.every((r) => r.cents === 5_000)).toBe(true);
  });
});
