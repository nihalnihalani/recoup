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

describe("parseProductUrl: internal names and ports (pre-launch review M2)", () => {
  it.each([
    "http://metadata.google.internal/computeMetadata/v1/",
    "https://printer.local/status",
    "https://nas.lan/",
    "https://wiki.corp/page",
    "https://intranet.ACME.CORP/page",
    "https://router.home.arpa/",
    "https://app.localhost/x",
    "https://db.internal./x",
    "https://acme.example:8080/p",
    "https://acme.example:22/p",
    "http://acme.example:8443/p",
    "http://169.254.169.254/latest/meta-data",
    "http://2130706433/p",
    "http://0x7f.1/p",
  ])("rejects %s", (input) => {
    expect(parseProductUrl(input)).toBeNull();
  });

  it.each([
    ["https://acme.example:443/p", "https://acme.example/p"],
    ["http://acme.example:80/p", "http://acme.example/p"],
    ["https://acme.example:80/p", "https://acme.example:80/p"],
    ["http://acme.example:443/p", "http://acme.example:443/p"],
  ])("allows the web ports: %s", (input, stored) => {
    expect(parseProductUrl(input)?.productUrl).toBe(stored);
  });

  it("does not mistake a public name that merely contains a private word", () => {
    expect(parseProductUrl("https://local.acme.example/p")?.merchantDomain).toBe("local.acme.example");
    expect(parseProductUrl("https://thelocal.com/p")?.merchantDomain).toBe("thelocal.com");
    expect(parseProductUrl("https://internal-shop.com/p")?.merchantDomain).toBe("internal-shop.com");
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
