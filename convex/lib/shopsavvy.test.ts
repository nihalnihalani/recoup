import { describe, it, expect } from "vitest";
import {
  isNewCondition,
  flattenHistory,
  hostOf,
  MARKET_PARSE_MAX_OFFERS,
  MARKET_PARSE_MAX_POINTS_PER_OFFER,
  MIN_OUTLIER_POINTS,
  parseEnvelope,
  parseSnapshot,
  toCents,
  withoutOutliers,
} from "./shopsavvy";

const NOW = Date.UTC(2026, 8, 20); // 2026-09-20, matches the day the live fixture was captured

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

  it("rounds a floating-point-imprecise dollar amount to the nearest cent (round-half-away-from-zero)", () => {
    // 19.99 * 100 === 1998.9999999999998 in IEEE-754; Math.round must still land on 1999.
    expect(toCents(19.99)).toBe(1_999);
    // Exactly on a half-cent boundary rounds up (price is always positive here, so "away from
    // zero" and "up" coincide).
    expect(toCents(0.005)).toBe(1);
  });

  it("rejects a value that would overflow a safe integer once converted to cents", () => {
    expect(toCents(Number.MAX_SAFE_INTEGER)).toBeNull();
    expect(toCents(Infinity)).toBeNull();
    expect(toCents(NaN)).toBeNull();
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
    const snap = parseSnapshot(LIVE, NOW)!;
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
    expect(parseSnapshot(null, NOW)).toBeNull();
    expect(parseSnapshot({ success: false }, NOW)).toBeNull();
    expect(parseSnapshot({ data: [] }, NOW)).toBeNull();
  });

  it("returns null on an explicit error envelope even if it also carries a data array", () => {
    // success:false is the provider's own signal that the call failed; stray data must not
    // be trusted over that flag.
    expect(
      parseSnapshot(
        { success: false, error: "rate limited", data: [{ offers: [{ retailer: "Shop", price: 10 }] }] },
        NOW,
      ),
    ).toBeNull();
  });

  it("drops a price it cannot use rather than inventing one", () => {
    const snap = parseSnapshot({
      data: [{ offers: [{ retailer: "Shop", URL: "https://shop.example/p", price: "free", currency: "USD" }] }],
    }, NOW)!;
    expect(snap.offers[0].cents).toBeNull();
  });

  it("caps offers at MARKET_PARSE_MAX_OFFERS and drops the rest", () => {
    expect(MARKET_PARSE_MAX_OFFERS).toBe(200);
    const offers = Array.from({ length: 50_000 }, (_, i) => ({
      retailer: `Store ${i}`,
      URL: `https://store${i}.example/p`,
      price: 10,
      currency: "USD",
    }));
    const snap = parseSnapshot({ data: [{ offers }] }, NOW)!;
    expect(snap.offers).toHaveLength(MARKET_PARSE_MAX_OFFERS);
  });

  it("caps a single offer's history at MARKET_PARSE_MAX_POINTS_PER_OFFER and drops the rest", () => {
    expect(MARKET_PARSE_MAX_POINTS_PER_OFFER).toBe(400);
    const history = Array.from({ length: 1_000 }, (_, i) => ({
      price: 10,
      currency: "USD",
      timestamp: new Date(NOW - i * 86_400_000).toISOString(),
    }));
    const snap = parseSnapshot({
      data: [{ offers: [{ retailer: "Shop", URL: "https://shop.example/p", price: 10, currency: "USD", history }] }],
    }, NOW)!;
    expect(snap.offers[0].history).toHaveLength(MARKET_PARSE_MAX_POINTS_PER_OFFER);
  });

  it("truncates a name longer than 200 characters instead of rejecting the whole offer", () => {
    const longRetailer = "A".repeat(200_000);
    const snap = parseSnapshot({
      data: [{ offers: [{ retailer: longRetailer, URL: "https://shop.example/p", price: 10, currency: "USD" }] }],
    }, NOW)!;
    expect(snap.offers[0].retailer).toHaveLength(200);
  });

  it("drops a future-dated offer timestamp (beyond a 24h tolerance) rather than trusting it", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            {
              retailer: "Shop",
              URL: "https://shop.example/p",
              price: 10,
              currency: "USD",
              timestamp: new Date(NOW + 2 * 86_400_000).toISOString(),
            },
          ],
        },
      ],
    }, NOW)!;
    expect(snap.offers[0].observedAt).toBeNull();
  });

  it("accepts a timestamp inside the future tolerance (clock skew) but rejects one just beyond it", () => {
    const withinTolerance = parseSnapshot({
      data: [
        {
          offers: [
            {
              retailer: "Shop",
              URL: "https://shop.example/p",
              price: 10,
              currency: "USD",
              timestamp: new Date(NOW + 60_000).toISOString(),
            },
          ],
        },
      ],
    }, NOW)!;
    expect(withinTolerance.offers[0].observedAt).not.toBeNull();
  });

  it("drops a pre-2010 offer timestamp as corrupted rather than ancient-but-real", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            {
              retailer: "Shop",
              URL: "https://shop.example/p",
              price: 10,
              currency: "USD",
              timestamp: "2005-01-01T00:00:00.000Z",
            },
          ],
        },
      ],
    }, NOW)!;
    expect(snap.offers[0].observedAt).toBeNull();
  });

  it("drops a future-dated or pre-2010 history point but keeps the valid ones", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            {
              retailer: "Shop",
              URL: "https://shop.example/p",
              price: 10,
              currency: "USD",
              history: [
                { price: 9, currency: "USD", timestamp: new Date(NOW + 5 * 86_400_000).toISOString() },
                { price: 8, currency: "USD", timestamp: "2001-06-01T00:00:00.000Z" },
                { price: 7, currency: "USD", timestamp: new Date(NOW - 86_400_000).toISOString() },
              ],
            },
          ],
        },
      ],
    }, NOW)!;
    expect(snap.offers[0].history).toHaveLength(1);
    expect(snap.offers[0].history[0].cents).toBe(700);
  });

  it("drops a point or offer with no currency at all rather than assuming one", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            { retailer: "NoCurrency", URL: "https://shop.example/p", price: 10 },
            {
              retailer: "PartialHistory",
              URL: "https://shop2.example/p",
              price: 10,
              currency: "USD",
              history: [{ price: 5, timestamp: new Date(NOW - 86_400_000).toISOString() }],
            },
          ],
        },
      ],
    }, NOW)!;
    expect(snap.offers[0].currency).toBeNull();
    // The history row has a price and date but no currency of its own, so it is dropped even
    // though its parent offer has one — a point never inherits a currency it did not state.
    expect(snap.offers[1].history).toHaveLength(0);
  });

  it("validates offer URLs by reusing convex/lib/watchUrl.ts instead of trusting the string", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            // Credentials embedded in the URL: parseProductUrl rejects this.
            { retailer: "Sketchy", URL: "https://user:pass@shop.example/p", price: 10, currency: "USD" },
            // A private/internal-only host: never a real shop.
            { retailer: "Internal", URL: "http://metadata.google.internal/p", price: 10, currency: "USD" },
            // A normal URL still validates and yields a clean store domain.
            { retailer: "Normal", URL: "https://www.shop.example/p?utm_source=x", price: 10, currency: "USD" },
          ],
        },
      ],
    }, NOW)!;
    expect(snap.offers[0].productUrl).toBeNull();
    expect(snap.offers[1].productUrl).toBeNull();
    expect(snap.offers[1].storeDomain).toBeNull();
    expect(snap.offers[2].productUrl).not.toBeNull();
    expect(snap.offers[2].storeDomain).toBe("shop.example");
  });
});

/**
 * QA-1 (P03, M1A): `parseSnapshot` folds three different provider answers into one `null`, and
 * `market.lookup` used to read that `null` as "the key is unset" (`not_configured`), which the D71
 * gate lets through, so every accepted price check paid for the same lookup again. `parseEnvelope`
 * keeps them apart: the provider answering "no such product" is a legitimate empty result, and a
 * body that is not an envelope at all is malformed (a terminal failure, like invalid JSON).
 */
describe("parseEnvelope (QA-1)", () => {
  it("returns the snapshot for a real product envelope", () => {
    const envelope = parseEnvelope(LIVE, NOW);
    expect(envelope.kind).toBe("snapshot");
    if (envelope.kind !== "snapshot") return;
    expect(envelope.snapshot).toEqual(parseSnapshot(LIVE, NOW));
  });

  it("keeps a product with no offers as a snapshot (market.lookup turns zero points into empty_result)", () => {
    const envelope = parseEnvelope({ success: true, data: [{ title_short: "x", offers: [] }] }, NOW);
    expect(envelope.kind).toBe("snapshot");
  });

  it.each([
    ["success:false", { success: false }],
    ["success:false with an error message", { success: false, error: "Product not found" }],
    ["success:false even when it also carries data", { success: false, data: [{ offers: [{ retailer: "Shop", price: 10 }] }] }],
    ["data:[]", { success: true, data: [] }],
    ["data:[] without a success flag", { data: [] }],
    ["data:null", { success: true, data: null }],
    ["no data field", { success: true }],
  ])("reads %s as the provider's own empty answer", (_label, body) => {
    expect(parseEnvelope(body, NOW)).toEqual({ kind: "empty" });
  });

  it.each([
    ["null", null],
    ["a string", "not an envelope"],
    ["a number", 42],
    ["a top-level array", [{ offers: [] }]],
    ["data as a string", { success: true, data: "nope" }],
    ["data as a number", { success: true, data: 7 }],
    ["data[0] not an object", { success: true, data: ["nope"] }],
  ])("reads %s as malformed, never as empty or as not configured", (_label, body) => {
    expect(parseEnvelope(body, NOW)).toEqual({ kind: "malformed" });
  });
});

describe("flattenHistory", () => {
  it("keeps one point per store per day and excludes marketplace sellers", () => {
    const snap = parseSnapshot(LIVE, NOW)!;
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
    }, NOW)!;
    expect(flattenHistory(snap, "USD")).toHaveLength(0);
  });

  it("drops an offer with no currency at all from history, never defaulting to the caller's currency", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            { retailer: "NoCurrency", URL: "https://shop.example/p", price: 400, timestamp: "2026-09-01T00:00:00Z" },
          ],
        },
      ],
    }, NOW)!;
    expect(flattenHistory(snap, "USD")).toHaveLength(0);
  });

  it("excludes a used/refurbished/open-box/bundle offer from history entirely", () => {
    const conditions = ["Used - Like New", "Manufacturer Refurbished", "Open-Box", "Renewed", "Bundle", "Accessory"];
    for (const condition of conditions) {
      const snap = parseSnapshot({
        data: [
          {
            offers: [
              {
                retailer: "Shop",
                URL: "https://shop.example/p",
                price: 400,
                currency: "USD",
                condition,
                timestamp: "2026-09-01T00:00:00Z",
              },
            ],
          },
        ],
      }, NOW)!;
      expect(flattenHistory(snap, "USD"), `condition=${condition}`).toHaveLength(0);
    }
  });

  it("keeps a new-condition offer's history and flags an out-of-stock point as inStock:false", () => {
    const snap = parseSnapshot({
      data: [
        {
          offers: [
            {
              retailer: "Shop",
              URL: "https://shop.example/p",
              price: 400,
              currency: "USD",
              condition: "new",
              availability: "out",
              timestamp: "2026-09-01T00:00:00Z",
            },
          ],
        },
      ],
    }, NOW)!;
    const points = flattenHistory(snap, "USD");
    expect(points).toHaveLength(1);
    expect(points[0].inStock).toBe(false);
  });
});

describe("withoutOutliers", () => {
  it("drops an accessory and a bundle but keeps a real sale", () => {
    const at = (day: number, cents: number) => ({ observedAt: day * 86_400_000, cents, currency: "USD", inStock: true });
    const kept = withoutOutliers([at(1, 6_999), at(2, 44_995), at(3, 49_999), at(4, 45_999), at(5, 82_999)]);
    const prices = kept.map((p) => p.cents);
    expect(prices).toContain(44_995);
    expect(prices).not.toContain(6_999);
    expect(prices).not.toContain(82_999);
  });

  it(`leaves a short series alone: fewer than MIN_OUTLIER_POINTS (${MIN_OUTLIER_POINTS}) points are not a distribution`, () => {
    expect(MIN_OUTLIER_POINTS).toBe(4);
    const at = (cents: number) => ({ observedAt: cents, cents, currency: "USD", inStock: true });
    expect(withoutOutliers([at(100), at(50_000), at(99_000)])).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// P04-MW1 / P04-OW2 (P01–P12 re-audit)
// ---------------------------------------------------------------------------

const oneOffer = (condition: string | null, price = 400) =>
  parseSnapshot({
    data: [
      {
        offers: [
          { retailer: "Shop", URL: "https://shop.example/p", price, currency: "USD", ...(condition !== null ? { condition } : {}), timestamp: "2026-09-01T00:00:00Z" },
        ],
      },
    ],
  }, NOW)!;

describe("P04-MW1: the condition filter is an allowlist (new only)", () => {
  it.each([
    "Pre-Owned", "Certified Pre-Owned", "Remanufactured", "Reconditioned", "Like New", "Damaged", "For parts", "Second-hand",
    "Grade B", "Scratch and dent",
  ])("%s → excluded from history", (condition) => {
    expect(flattenHistory(oneOffer(condition), "USD")).toEqual([]);
    expect(isNewCondition(condition)).toBe(false);
  });

  it("keeps an offer whose condition is new (any case) or not stated", () => {
    for (const condition of ["new", "New", "NEW", null]) {
      expect(flattenHistory(oneOffer(condition), "USD"), String(condition)).toHaveLength(1);
      expect(isNewCondition(condition)).toBe(true);
    }
  });
});

describe("P04-OW2: outlier filtering is pinned, and the band is anchored on Recoup's own price", () => {
  const offers = (prices: number[]) =>
    parseSnapshot({
      data: [
        {
          offers: prices.map((price, i) => ({
            retailer: `S${i}`, URL: `https://s${i}.example/p`, price, currency: "USD", condition: "new", timestamp: `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
          })),
        },
      ],
    }, NOW)!;

  it("flattenHistory applies withoutOutliers: an accessory at 0.15x the median never becomes history", () => {
    const prices = flattenHistory(offers([450, 460, 440, 455, 67.5]), "USD").map((p) => p.cents);
    expect(prices).not.toContain(6_750);
    expect(prices).toHaveLength(4);
  });

  it("with Recoup's own current price, a majority of another variant can no longer take over the band", () => {
    // Most matched listings are a cheaper variant (~$120); the watched product is ~$450 (Recoup's own price).
    const all = offers([119, 121, 125, 118, 449, 455]);
    const medianOnly = flattenHistory(all, "USD").map((p) => p.cents).sort((a, b) => a - b);
    expect(medianOnly).toEqual([11_800, 11_900, 12_100, 12_500]); // the other variant drove the band; the product was cut
    const anchored = flattenHistory(all, "USD", 45_000).map((p) => p.cents).sort((a, b) => a - b);
    expect(anchored).toEqual([44_900, 45_500]);
  });

  it("the anchor also applies to a short series (a trusted reference needs no distribution)", () => {
    expect(flattenHistory(offers([100, 450]), "USD", 45_000).map((p) => p.cents)).toEqual([45_000]);
  });
});
