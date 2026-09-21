import { describe, expect, it } from "vitest";
import { defaultWatchName, parseProductUrl } from "./watchUrl";

describe("parseProductUrl", () => {
  it("accepts an https product link and derives the bare domain", () => {
    expect(parseProductUrl("  https://www.Acme.example/p/jacket?color=red#reviews ")).toEqual({
      productUrl: "https://www.acme.example/p/jacket?color=red",
      merchantDomain: "acme.example",
    });
  });

  it("accepts plain http", () => {
    expect(parseProductUrl("http://shop.acme.example/x")?.merchantDomain).toBe("shop.acme.example");
  });

  it.each([
    "",
    "jacket",
    "acme.example/p/jacket",
    "ftp://acme.example/p",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://user:pw@acme.example/p",
    "http://localhost:3000/p",
    "http://127.0.0.1/p",
    "http://[::1]/p",
    `https://acme.example/${"a".repeat(2_000)}`,
  ])("rejects %s", (input) => {
    expect(parseProductUrl(input)).toBeNull();
  });
});

describe("defaultWatchName", () => {
  it("uses the host and a readable path tail", () => {
    expect(defaultWatchName("https://www.acme.example/p/mens-down_jacket.html?x=1")).toBe(
      "acme.example: mens down jacket",
    );
  });

  it("falls back to the host alone", () => {
    expect(defaultWatchName("https://acme.example/")).toBe("acme.example");
  });

  it("is bounded", () => {
    expect(defaultWatchName(`https://acme.example/${"a".repeat(500)}`).length).toBeLessThanOrEqual(80);
  });
});
