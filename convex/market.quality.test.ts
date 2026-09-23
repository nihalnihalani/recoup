/// <reference types="vite/client" />
/**
 * P01–P12 re-audit, batch 1 (market data quality; D244):
 *  - P04-OW1: a ShopSavvy store candidate whose condition is not "new" is written unpriced with CONDITION_NOTE, so a
 *    used, refurbished, open-box, bundle or pre-owned listing can never become `best` or "Cheapest".
 *  - P04-OW2: the market series is banded around Recoup's own current price when it has one, so a majority of
 *    another variant's listings cannot take over the "has been this cheap" history.
 *  - P03-C: a 401, 402 or 403 from ShopSavvy is a deployment key or plan state, not this product's terminal failure:
 *    the watch goes back to `not_configured` (no timestamp, attempts unchanged), lookups pause for an hour without a
 *    charge, and once the key or plan is fixed the next accepted check looks up again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { CONDITION_NOTE, MARKET_AUTH_COOLDOWN_MS } from "./market";
import { CONDITION_NOTE as CONDITION_NOTE_UI } from "../src/lib/offerNotes";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 20, 12);
const URL = "https://www.acme.example/p/down-jacket";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  process.env.SHOPSAVVY_API_KEY = "test-key";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.SHOPSAVVY_API_KEY;
});

async function seedWatch(t: T, userId: Id<"users">, extra: { lastCents?: number; slug?: string } = { lastCents: 10_000 }): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId, name: "Acme Down Jacket", productUrl: extra.slug ? `https://www.acme.example/p/${extra.slug}` : URL, merchantDomain: "acme.example",
      status: "active", nextCheckAt: T0 + 3_600_000, currency: "USD", ...(extra.lastCents !== undefined ? { lastCents: extra.lastCents } : {}),
    }),
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const offer = (store: string, price: number, condition: string | null, day = 1) => ({
  URL: `https://${store}.example/p/down-jacket`, retailer: store, price, currency: "USD", availability: "in", condition, seller: null,
  timestamp: new Date(T0 - day * 86_400_000).toISOString(), history: [],
});

async function lookup(t: T, watchId: Id<"watches">, offers: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: true, data: [{ title_short: "Down Jacket", offers }] })));
  await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
  await t.action(internal.market.lookup, { watchId });
}

const offerRows = (t: T, watchId: Id<"watches">) =>
  t.run((ctx) => ctx.db.query("offers").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect());

describe("P04-OW1: a store candidate that is not new is never priced", () => {
  it("Used, Refurbished, Open-Box, Bundle and Pre-Owned stores are written unpriced with CONDITION_NOTE; best stays null after confirm", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await lookup(t, watchId, [
      offer("used-store", 60, "Used - Good"), offer("refurb-store", 61, "Refurbished"), offer("openbox-store", 62, "Open-Box"),
      offer("bundle-store", 63, "Bundle"), offer("preowned-store", 64, "Pre-Owned"),
    ]);
    const rows = await offerRows(t, watchId);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.lastCents, row.storeDomain).toBeUndefined();
      expect(row.currency, row.storeDomain).toBeUndefined();
      expect(row.note, row.storeDomain).toBe(CONDITION_NOTE);
    }
    for (const row of rows) await as.mutation(api.offers.confirm, { offerId: row._id });
    expect((await as.query(api.offers.listForWatch, { watchId, now: T0 })).best).toBeNull();
  });

  it("a new store beside them keeps its price and is the one ranked best", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    await lookup(t, watchId, [offer("used-store", 60, "Used - Good"), offer("new-store", 80, "New")]);
    const rows = await offerRows(t, watchId);
    for (const row of rows) await as.mutation(api.offers.confirm, { offerId: row._id });
    const best = (await as.query(api.offers.listForWatch, { watchId, now: T0 })).best;
    expect(best?.storeDomain).toBe("new-store.example");
  });

  it("CONDITION_NOTE stays literally equal to the UI copy in src/lib/offerNotes.ts", () => {
    expect(CONDITION_NOTE).toBe(CONDITION_NOTE_UI);
  });
});

describe("P04-OW2: the market series is banded around Recoup's own price", () => {
  it("a majority of another variant's listings no longer becomes the watched product's history", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId, { lastCents: 45_000 });
    await lookup(t, watchId, [
      offer("a", 119, "new", 1), offer("b", 121, "new", 2), offer("c", 125, "new", 3), offer("d", 118, "new", 4),
      offer("e", 449, "new", 5), offer("f", 455, "new", 6),
    ]);
    const cents = (await t.run((ctx) => ctx.db.query("marketPrices").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect()))
      .map((r) => r.cents)
      .sort((a, b) => a - b);
    expect(cents).toEqual([44_900, 45_500]);
  });
});

describe("P03-C: a key or plan failure is a deployment state, not this product's terminal failure", () => {
  it.each([401, 402, 403])("HTTP %i → not_configured, no marketFetchedAt, attempts unchanged, cooldown recorded", async (status) => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await seedWatch(t, userId);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, status)));
    await t.mutation(internal.market.requestLookup, { watchId, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId });
    const row = (await t.run((ctx) => ctx.db.get(watchId)))!;
    expect(row.marketState).toBe("not_configured");
    expect(row.marketFetchedAt).toBeUndefined();
    expect(row.marketAttempts ?? 0).toBe(0);
    const blocked = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "market.authBlockedUntil")).unique());
    expect(Number(blocked?.cursor)).toBe(T0 + MARKET_AUTH_COOLDOWN_MS);
  });

  it("inside the cooldown, accepted checks on 3 watches make 0 fetches and charge nothing; after it, with the key fixed, exactly 1 fetch lands success", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const first = await seedWatch(t, userId, { slug: "one" });
    const fetchSpy = vi.fn(async () => jsonResponse({}, 402));
    vi.stubGlobal("fetch", fetchSpy);
    await t.mutation(internal.market.requestLookup, { watchId: first, trigger: "manual" });
    await t.action(internal.market.lookup, { watchId: first });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers); // the manual claim's own scheduled job: a no-op now

    const others = [await seedWatch(t, userId, { slug: "two" }), await seedWatch(t, userId, { slug: "three" }), first];
    for (const watchId of others) {
      expect(await t.mutation(internal.market.requestLookup, { watchId, trigger: "auto" })).toMatchObject({ scheduled: false, reason: "not_configured" });
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const charged = async () => (await t.run((ctx) => ctx.db.query("usage").collect())).filter((u) => u.kind === "market_lookup" && u.userId === userId).reduce((n, u) => n + u.count, 0);
    expect(await charged()).toBe(1); // only the first, manual call

    vi.setSystemTime(T0 + MARKET_AUTH_COOLDOWN_MS + 1);
    const okSpy = vi.fn(async () => jsonResponse({ success: true, data: [{ title_short: "Down Jacket", offers: [offer("other", 80, "new")] }] }));
    vi.stubGlobal("fetch", okSpy);
    expect(await t.mutation(internal.market.requestLookup, { watchId: first, trigger: "auto" })).toMatchObject({ scheduled: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(okSpy).toHaveBeenCalledTimes(1);
    expect((await t.run((ctx) => ctx.db.get(first)))?.marketState).toBe("success");
  });
});
