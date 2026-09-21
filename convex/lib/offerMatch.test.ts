import { describe, expect, it } from "vitest";
import {
  cleanStoreUrl,
  matchConfidence,
  registrableHost,
  sameStore,
  selectStorePages,
  titleSimilarity,
  TITLE_DRIFT_THRESHOLD,
} from "./offerMatch";

describe("registrableHost", () => {
  it("reduces a hostname to the store's registrable host", () => {
    expect(registrableHost("www.nike.com")).toBe("nike.com");
    expect(registrableHost("shop.m.nike.com")).toBe("nike.com");
    expect(registrableHost("WWW.JohnLewis.co.uk.")).toBe("johnlewis.co.uk");
    expect(registrableHost("store.example.com.au")).toBe("example.com.au");
    expect(registrableHost("rei.com")).toBe("rei.com");
  });

  it("refuses bare IPs and single labels", () => {
    expect(registrableHost("127.0.0.1")).toBeNull();
    expect(registrableHost("localhost")).toBeNull();
    expect(registrableHost("bad_host.com")).toBeNull();
  });
});

describe("cleanStoreUrl", () => {
  it("strips tracking parameters and the fragment, and keeps everything else as found", () => {
    const cleaned = cleanStoreUrl(
      "https://www.rei.com/product/123/jacket?color=blue&utm_source=google&UTM_Medium=cpc&gclid=a&fbclid=b&ref=c&tag=d-20&affid=e&irclickid=f&size=M#reviews",
    );
    expect(cleaned).toEqual({
      productUrl: "https://www.rei.com/product/123/jacket?color=blue&size=M",
      storeDomain: "rei.com",
    });
  });

  it("adds nothing to a clean URL", () => {
    expect(cleanStoreUrl("https://backcountry.com/p/jacket")?.productUrl).toBe("https://backcountry.com/p/jacket");
  });

  it("refuses what we would never scrape", () => {
    expect(cleanStoreUrl("ftp://rei.com/x")).toBeNull();
    expect(cleanStoreUrl("https://user:pw@rei.com/x")).toBeNull();
    expect(cleanStoreUrl("http://10.0.0.1/x")).toBeNull();
    expect(cleanStoreUrl("not a url")).toBeNull();
  });
});

describe("selectStorePages", () => {
  const hits = [
    { url: "https://www.acme.example/p/down-jacket", title: "Own store" },
    { url: "https://outlet.acme.example/p/down-jacket", title: "Own store, subdomain" },
    { url: "https://www.facebook.com/marketplace/item/1", title: "FB" },
    { url: "https://sfbay.craigslist.org/abc", title: "CL" },
    { url: "https://www.reddit.com/r/deals/1", title: "Reddit" },
    { url: "https://www.pinterest.com/pin/1" },
    { url: "https://m.youtube.com/watch?v=1" },
    { url: "https://www.instagram.com/p/1" },
    { url: "https://www.tiktok.com/@a/video/1" },
    { url: "https://www.rei.example/p/1?utm_campaign=x", title: "  REI jacket  " },
    { url: "https://outlet.rei.example/p/2", title: "REI outlet (same store)" },
    { url: "not a url" },
    { url: "https://backcountry.example/p/3" },
  ];

  it("drops the own store and excluded hosts, keeps the first page per store", () => {
    expect(selectStorePages(hits, "acme.example", 5)).toEqual([
      { storeDomain: "rei.example", productUrl: "https://www.rei.example/p/1", title: "REI jacket" },
      { storeDomain: "backcountry.example", productUrl: "https://backcountry.example/p/3", title: "backcountry.example" },
    ]);
  });

  it("treats a watch on a subdomain as the same own store", () => {
    expect(selectStorePages(hits, "outlet.acme.example", 5).map((p) => p.storeDomain)).toEqual([
      "rei.example",
      "backcountry.example",
    ]);
  });

  it("stops at max", () => {
    expect(selectStorePages(hits, "acme.example", 1)).toHaveLength(1);
  });
});

describe("sameStore", () => {
  it("is true for a subdomain of the same registrable host, in either direction", () => {
    expect(sameStore("shop.acme.example", "acme.example")).toBe(true);
    expect(sameStore("acme.example", "outlet.acme.example")).toBe(true);
    expect(sameStore("www.johnlewis.co.uk", "outlet.johnlewis.co.uk")).toBe(true);
  });

  it("is false for a different store, even a similarly named one", () => {
    expect(sameStore("acme.example", "acme-outlet.example")).toBe(false);
    expect(sameStore("rei.example", "backcountry.example")).toBe(false);
  });

  it("falls back to a plain compare for a host registrableHost cannot parse", () => {
    expect(sameStore("localhost", "localhost")).toBe(true);
    expect(sameStore("localhost", "acme.example")).toBe(false);
  });
});

describe("titleSimilarity", () => {
  it("is 1 for identical titles and high for a reordered/re-punctuated one", () => {
    expect(titleSimilarity("Acme Down Jacket, Blue, M", "Acme Down Jacket, Blue, M")).toBe(1);
    expect(titleSimilarity("Acme Down Jacket, Blue, M", "Acme Down Jacket - Blue (M)")).toBeGreaterThan(
      TITLE_DRIFT_THRESHOLD,
    );
  });

  it("is low for an unrelated product, and 0 for an empty title", () => {
    expect(titleSimilarity("Acme Down Jacket, Blue, M", "Sony WH-1000XM5 Headphones")).toBeLessThan(
      TITLE_DRIFT_THRESHOLD,
    );
    expect(titleSimilarity("Acme Down Jacket", "")).toBe(0);
    expect(titleSimilarity("", "")).toBe(0);
  });
});

describe("matchConfidence", () => {
  it("is the confidence for exact, half for unsure, zero for none", () => {
    expect(matchConfidence("exact", 0.9)).toBe(0.9);
    expect(matchConfidence("unsure", 0.9)).toBe(0.45);
    expect(matchConfidence("none", 0.9)).toBe(0);
  });

  it("clamps and survives a missing or broken confidence", () => {
    expect(matchConfidence("exact", undefined)).toBe(0);
    expect(matchConfidence("exact", Number.NaN)).toBe(0);
    expect(matchConfidence("exact", 7)).toBe(1);
    expect(matchConfidence("unsure", -1)).toBe(0);
  });
});
