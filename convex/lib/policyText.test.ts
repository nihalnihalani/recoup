import { describe, expect, it } from "vitest";
import {
  chooseBestResult,
  hitUrl,
  hostMatchesDomain,
  isEmail,
  locatePassage,
  MAX_PASSAGE_CHARS,
  normalizeDomain,
  normalizeWhitespace,
  sanitizeWindowDays,
  scoreHit,
} from "./policyText";

describe("normalizeWhitespace", () => {
  it("collapses runs of whitespace and trims", () => {
    expect(normalizeWhitespace("  a\n\n b\t\tc  ")).toBe("a b c");
  });

  it("is a no-op on already-normal text", () => {
    expect(normalizeWhitespace("a b c")).toBe("a b c");
  });
});

describe("locatePassage", () => {
  const page = "## Returns\n\nYou may return  most items\nwithin 30 days of delivery.\n\nSee exclusions.";

  it("finds a passage that differs only in whitespace and reports its offset", () => {
    const found = locatePassage(page, "You may return most items within 30 days of delivery.");
    expect(found).not.toBeNull();
    expect(found!.passageStart).toBe(page.indexOf("You may return"));
    expect(page.slice(found!.passageStart)).toContain("You may return");
    // The stored passage is the original text, not the model's re-spacing.
    expect(found!.passage).toBe("You may return  most items\nwithin 30 days of delivery.");
  });

  it("finds a passage that matches exactly", () => {
    const found = locatePassage(page, "within 30 days of delivery.");
    expect(found?.passageStart).toBe(page.indexOf("within 30 days"));
  });

  it("returns null when the model paraphrased rather than copied", () => {
    expect(locatePassage(page, "Returns are accepted for thirty days.")).toBeNull();
  });

  it("returns null for a passage too short to be evidence", () => {
    expect(locatePassage(page, "Returns")).toBeNull();
  });

  it("returns null for an empty passage", () => {
    expect(locatePassage(page, "")).toBeNull();
  });

  it("truncates a very long passage to a prefix that is still verbatim at passageStart", () => {
    const long = `intro ${"policy text ".repeat(200)}end`;
    const found = locatePassage(long, "policy text ".repeat(200));
    expect(found).not.toBeNull();
    expect(found!.passage.length).toBe(MAX_PASSAGE_CHARS);
    expect(long.slice(found!.passageStart, found!.passageStart + found!.passage.length)).toBe(
      found!.passage,
    );
  });
});

describe("normalizeDomain", () => {
  it("strips scheme, www, path and case", () => {
    expect(normalizeDomain("https://WWW.BestBuy.com/site/returns?x=1")).toBe("bestbuy.com");
  });

  it("keeps a meaningful subdomain", () => {
    expect(normalizeDomain("us.boden.com")).toBe("us.boden.com");
  });

  it("rejects junk", () => {
    expect(normalizeDomain("")).toBeNull();
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain("localhost")).toBeNull();
    expect(normalizeDomain("-bad.com")).toBeNull();
  });
});

describe("hostMatchesDomain", () => {
  it("accepts the domain and its subdomains", () => {
    expect(hostMatchesDomain("https://bestbuy.com/x", "bestbuy.com")).toBe(true);
    expect(hostMatchesDomain("https://help.bestbuy.com/x", "bestbuy.com")).toBe(true);
  });

  it("rejects look-alike and third-party hosts", () => {
    expect(hostMatchesDomain("https://notbestbuy.com/x", "bestbuy.com")).toBe(false);
    expect(hostMatchesDomain("https://reddit.com/r/bestbuy", "bestbuy.com")).toBe(false);
    expect(hostMatchesDomain("not a url", "bestbuy.com")).toBe(false);
  });
});

describe("isEmail / sanitizeWindowDays", () => {
  it("accepts a plain address and rejects noise", () => {
    expect(isEmail("support@bestbuy.com")).toBe(true);
    expect(isEmail("contact us at support@bestbuy.com")).toBe(false);
    expect(isEmail("support@")).toBe(false);
  });

  it("bounds the window", () => {
    expect(sanitizeWindowDays(30)).toBe(30);
    expect(sanitizeWindowDays(null)).toBeUndefined();
    expect(sanitizeWindowDays(0)).toBeUndefined();
    expect(sanitizeWindowDays(-5)).toBeUndefined();
    expect(sanitizeWindowDays(10_000)).toBeUndefined();
    expect(sanitizeWindowDays(14.5)).toBeUndefined();
    expect(sanitizeWindowDays(Number.NaN)).toBeUndefined();
  });
});

describe("hitUrl", () => {
  it("reads a bare search result or a scraped document", () => {
    expect(hitUrl({ url: "https://a.com/x" })).toBe("https://a.com/x");
    expect(hitUrl({ metadata: { sourceURL: "https://a.com/y" } })).toBe("https://a.com/y");
    expect(hitUrl({})).toBeNull();
  });
});

describe("chooseBestResult", () => {
  const domain = "bestbuy.com";

  it("returns null with no hits", () => {
    expect(chooseBestResult([], { domain, kind: "returns" })).toBeNull();
  });

  it("discards every off-domain hit", () => {
    const hits = [
      { url: "https://reddit.com/r/bestbuy/returns", markdown: "x".repeat(2000) },
      { url: "https://slickdeals.net/bestbuy-return-policy", markdown: "x".repeat(2000) },
    ];
    expect(chooseBestResult(hits, { domain, kind: "returns" })).toBeNull();
    expect(scoreHit(hits[0], { domain, kind: "returns", position: 0 })).toBeNull();
  });

  it("prefers the on-domain page whose URL names the policy kind", () => {
    const hits = [
      { url: "https://bestbuy.com/site/help-topics/store-hours", markdown: "x".repeat(2000) },
      { url: "https://bestbuy.com/site/returns-exchanges", markdown: "x".repeat(2000) },
    ];
    const best = chooseBestResult(hits, { domain, kind: "returns" });
    expect(best?.url).toBe("https://bestbuy.com/site/returns-exchanges");
  });

  it("distinguishes the two kinds on the same result set", () => {
    const hits = [
      { url: "https://bestbuy.com/site/returns-exchanges", markdown: "x".repeat(2000) },
      { url: "https://bestbuy.com/site/price-match-guarantee", markdown: "x".repeat(2000) },
    ];
    expect(chooseBestResult(hits, { domain, kind: "returns" })?.url).toBe(
      "https://bestbuy.com/site/returns-exchanges",
    );
    expect(chooseBestResult(hits, { domain, kind: "price_adjustment" })?.url).toBe(
      "https://bestbuy.com/site/price-match-guarantee",
    );
  });

  it("falls back to search position when nothing else separates the hits", () => {
    const hits = [{ url: "https://bestbuy.com/a" }, { url: "https://bestbuy.com/b" }];
    expect(chooseBestResult(hits, { domain, kind: "returns" })?.url).toBe("https://bestbuy.com/a");
  });

  it("reports a null markdown when the chosen hit was not scraped", () => {
    const best = chooseBestResult([{ url: "https://bestbuy.com/site/returns" }], {
      domain,
      kind: "returns",
    });
    expect(best).toEqual({ url: "https://bestbuy.com/site/returns", markdown: null });
  });

  it("uses a subdomain help centre page", () => {
    const best = chooseBestResult(
      [{ metadata: { sourceURL: "https://help.bestbuy.com/refunds" }, markdown: "x".repeat(900) }],
      { domain, kind: "returns" },
    );
    expect(best?.url).toBe("https://help.bestbuy.com/refunds");
    expect(best?.markdown).toHaveLength(900);
  });
});
