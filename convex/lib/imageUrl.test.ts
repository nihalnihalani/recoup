import { describe, expect, it } from "vitest";
import { cleanImageUrl, imageUrlChange, pageImageUrl, MAX_IMAGE_URL_CHARS } from "./imageUrl";

describe("cleanImageUrl", () => {
  it("keeps an absolute https URL", () => {
    expect(cleanImageUrl(" https://cdn.acme.example/i/jacket.jpg?w=800 ")).toBe("https://cdn.acme.example/i/jacket.jpg?w=800");
  });

  it.each([
    ["http", "http://cdn.acme.example/i.jpg"],
    ["protocol-relative", "//cdn.acme.example/i.jpg"],
    ["relative", "/i/jacket.jpg"],
    ["data", "data:image/png;base64,AAAA"],
    ["javascript", "javascript:alert(1)"],
    ["empty", ""],
    ["no host", "https://"],
    ["too long", `https://cdn.acme.example/${"x".repeat(MAX_IMAGE_URL_CHARS)}`],
  ])("drops a %s URL", (_label, raw) => {
    expect(cleanImageUrl(raw)).toBeUndefined();
  });

  it("drops anything that is not a string", () => {
    for (const raw of [undefined, null, 42, {}, ["https://a.example/i.jpg"]]) expect(cleanImageUrl(raw)).toBeUndefined();
  });
});

describe("pageImageUrl", () => {
  it("reads ogImage, then og:image, then image", () => {
    expect(pageImageUrl({ ogImage: "https://a.example/1.jpg", "og:image": "https://a.example/2.jpg" })).toBe("https://a.example/1.jpg");
    expect(pageImageUrl({ "og:image": "https://a.example/2.jpg", image: "https://a.example/3.jpg" })).toBe("https://a.example/2.jpg");
    expect(pageImageUrl({ image: "https://a.example/3.jpg" })).toBe("https://a.example/3.jpg");
  });

  it("takes the first usable entry of an array and skips an unusable key", () => {
    expect(pageImageUrl({ ogImage: ["/relative.jpg", "https://a.example/ok.jpg"] })).toBe("https://a.example/ok.jpg");
    expect(pageImageUrl({ ogImage: "http://a.example/insecure.jpg", "og:image": "https://a.example/ok.jpg" })).toBe("https://a.example/ok.jpg");
  });

  it("is undefined for missing or malformed metadata", () => {
    for (const m of [undefined, null, "x", 3, {}, { ogImage: 7 }]) expect(pageImageUrl(m)).toBeUndefined();
  });
});

describe("imageUrlChange", () => {
  it("is the clean URL only when the row has none or it changed", () => {
    expect(imageUrlChange(undefined, "https://a.example/1.jpg")).toBe("https://a.example/1.jpg");
    expect(imageUrlChange("https://a.example/1.jpg", "https://a.example/1.jpg")).toBeUndefined();
    expect(imageUrlChange("https://a.example/1.jpg", "https://a.example/2.jpg")).toBe("https://a.example/2.jpg");
    expect(imageUrlChange("https://a.example/1.jpg", "http://a.example/2.jpg")).toBeUndefined();
    expect(imageUrlChange("https://a.example/1.jpg", undefined)).toBeUndefined();
  });
});
