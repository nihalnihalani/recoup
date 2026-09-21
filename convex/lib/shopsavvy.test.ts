import { describe, it, expect } from "vitest";
import { flattenHistory, hostOf, marketStats, parseSnapshot, toCents, withoutOutliers } from "./shopsavvy";

/**
 * The fixture is trimmed from a real response on 2026-09-20 for the Target
 * KitchenAid mixer: decimal dollars, mixed retailers, one marketplace seller,
 * one offer with dated history, and the Best Buy row that prices a different
 * variant at half the product's price.
 */
const LIVE = {
  success: true,
  data: [
    {
      title: "KitchenAid KSM150PSMH Artisan Stand Mixers, 5 quart, Milkshake",
      title_short: "KitchenAid Artisan Stand Mixer",
      brand: "KitchenAid",
      images: ["http://insecure.example/a.jpg", "https://images.example/a.jpg"],
      offers: [
        {
          id: "1",
          availability: "in",
          condition: "new",
          retailer: "Best Buy",
          currency: "USD",
          price: 250.99,
          seller: null,
          URL: "https://www.bestbuy.com/site/6133656.p?skuId=6133656",
          timestamp: "2026-09-11T13:25:31.934Z",
          history: [
            { availability: "in", price: 250.99, currency: "USD", timestamp: "2026-08-14T13:20:35.443Z" },
            { availability: "in", price: 250.99, currency: "USD", timestamp: "2026-06-30T18:11:28.550Z" },
          ],
        },
        {
          id: "2",
          availability: "in",
          condition: "new",
          retailer: "Amazon",
          currency: "USD",
          price: 489,
          seller: "Beach Camera Same Day Shipping",
          URL: "https://www.amazon.com/dp/B0769ZQWH7",
          timestamp: "2026-08-08T15:12:40.758Z",
          history: [],
        },
        {
          id: "3",
          availability: "in",
          condition: "new",
          retailer: "Target",
          currency: "USD",
          price: 499.99,
          seller: null,
          URL: "https://www.target.com/p/kitchenaid-artisan-series-5qt-tilt-head-stand-mixer/-/A-89535396",
          timestamp: "2026-06-06T07:41:56.467Z",
          history: [],
        },
        {
          id: "4",
          availability: "in",
          condition: "new",
          retailer: "Williams Sonoma",
          currency: "USD",
          price: 449.95,
          seller: null,
          URL: "https://www.williams-sonoma.com/products/kitchenaid-artisan-stand-mixer/",
          timestamp: "2026-09-02T10:00:00.000Z",
          history: [],
        },
        {
          id: "5",
          availability: "in",
          condition: "new",
          retailer: null,
          currency: "USD",
          price: 500,
          seller: null,
          URL: "https://www.birchlane.com/kitchenaid-artisan",
          timestamp: "2026-07-01T00:00:00.000Z",
          history: [],
        },
      ],
    },
  ],
};

describe("toCents", () => {
  it("turns decimal dollars into integer cents and rejects the rest", () => {
    expect(toCents(499.99)).toBe(49_999);
    expect(toCents(489)).toBe(48_900);
    expect(toCents(0)).toBeNull();
    expect(toCents(-5)).toBeNull();
    expect(toCents("499.99")).toBeNull();
    expect(toCents(undefined)).toBeNull();
  });
});

describe("hostOf", () => {
  it("returns the bare host, or null for anything unusable", () => {
    expect(hostOf("https://www.bestbuy.com/site/1.p")).toBe("bestbuy.com");
    expect(hostOf("https://shop.example.co.uk/p")).toBe("shop.example.co.uk");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("parseSnapshot", () => {
  it("reads the live envelope: title, https image, and every offer field", () => {
    const snap = parseSnapshot(LIVE)!;
    expect(snap.title).toBe("KitchenAid Artisan Stand Mixer");
    expect(snap.brand).toBe("KitchenAid");
    expect(snap.imageUrl).toBe("https://images.example/a.jpg");
    expect(snap.offers).toHaveLength(5);

    const bestBuy = snap.offers[0];
    expect(bestBuy.retailer).toBe("Best Buy");
    expect(bestBuy.storeDomain).toBe("bestbuy.com");
    expect(bestBuy.cents).toBe(25_099);
    expect(bestBuy.seller).toBeNull();
    expect(bestBuy.history).toHaveLength(2);
    // Oldest first, whatever order the API used.
    expect(bestBuy.history[0].observedAt).toBeLessThan(bestBuy.history[1].observedAt);

    // A row with no retailer name still counts: the host names the store.
    expect(snap.offers[4].retailer).toBe("birchlane.com");
  });

  it("returns null for anything that is not a product envelope", () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ success: false })).toBeNull();
    expect(parseSnapshot({ data: [] })).toBeNull();
  });

  it("drops a price it cannot use rather than inventing one", () => {
    const snap = parseSnapshot({
      data: [{ offers: [{ retailer: "Shop", URL: "https://shop.example/p", price: "free", currency: "USD" }] }],
    })!;
    expect(snap.offers[0].cents).toBeNull();
  });
});

describe("flattenHistory", () => {
  it("keeps one point per store per day and excludes marketplace sellers", () => {
    const snap = parseSnapshot(LIVE)!;
    const points = flattenHistory(snap, "USD");
    // Amazon's row has a seller, so it never becomes history.
    expect(points.every((p) => p.cents !== 48_900)).toBe(true);
    expect(points.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].observedAt).toBeGreaterThanOrEqual(points[i - 1].observedAt);
    }
  });

  it("ignores a price in another currency", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            { retailer: "EU Shop", URL: "https://shop.example/p", price: 400, currency: "EUR", timestamp: "2026-09-01T00:00:00Z" },
          ],
        },
      ],
    })!;
    expect(flattenHistory(snap, "USD")).toHaveLength(0);
  });
});

describe("withoutOutliers", () => {
  it("drops an accessory and a bundle but keeps a real sale", () => {
    const at = (day: number, cents: number) => ({ observedAt: day * 86_400_000, cents, currency: "USD" });
    const kept = withoutOutliers([at(1, 6_999), at(2, 44_995), at(3, 49_999), at(4, 45_999), at(5, 82_999)]);
    const prices = kept.map((p) => p.cents);
    expect(prices).toContain(44_995);
    expect(prices).not.toContain(6_999);
    expect(prices).not.toContain(82_999);
  });

  it("leaves a short series alone: three points are not a distribution", () => {
    const at = (cents: number) => ({ observedAt: cents, cents, currency: "USD" });
    expect(withoutOutliers([at(100), at(50_000), at(99_000)])).toHaveLength(3);
  });
});

describe("marketStats", () => {
  it("reports the range and the cheapest other store, never the watched one", () => {
    const snap = parseSnapshot(LIVE)!;
    const stats = marketStats(snap, "USD", "target.com")!;
    expect(stats.lowestCents).toBeLessThanOrEqual(stats.highestCents);
    expect(stats.points).toBeGreaterThan(0);
    expect(stats.best?.storeDomain).not.toBe("target.com");
    // The marketplace seller is not a store price, so Amazon is not the best offer.
    expect(stats.best?.storeDomain).not.toBe("amazon.com");
  });

  it("is null when nothing dated came back", () => {
    const snap = parseSnapshot({ data: [{ offers: [] }] })!;
    expect(marketStats(snap, "USD", "target.com")).toBeNull();
  });
});
