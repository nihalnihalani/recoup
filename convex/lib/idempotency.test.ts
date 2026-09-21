import { describe, expect, it } from "vitest";
import { internalKey } from "./idempotency";

describe("internalKey (D112 6a-1)", () => {
  it("is available: crypto.subtle exists under convex-test's edge-runtime environment", () => {
    expect(typeof crypto.subtle.digest).toBe("function");
  });

  it("the same parts always derive the same key", async () => {
    const a = await internalKey("claim1", "msg", "message-id-abc");
    const b = await internalKey("claim1", "msg", "message-id-abc");
    expect(a).toBe(b);
  });

  it("different parts derive different keys", async () => {
    const a = await internalKey("claim1", "msg", "message-id-abc");
    const b = await internalKey("claim1", "msg", "message-id-xyz");
    const c = await internalKey("claim2", "msg", "message-id-abc");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });

  it("parts that only differ in how they are split still derive different keys (join separator matters)", async () => {
    // "ab" + "c" vs "a" + "bc" would collide under naive concatenation with
    // no separator; the space-joined form must not.
    const a = await internalKey("ab", "c");
    const b = await internalKey("a", "bc");
    expect(a).not.toBe(b);
  });

  it("the key is always exactly 32 lowercase hex characters, regardless of input length", async () => {
    const short = await internalKey("x");
    const long = await internalKey("a".repeat(2_000), "b".repeat(2_000), "c".repeat(2_000));
    for (const key of [short, long]) {
      expect(key).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("a 200-char RFC Message-ID (the checkpoint 6a-1 repro shape) derives a fixed-length key without throwing", async () => {
    const longMessageId = `<${"a".repeat(190)}@mail.example.com>`;
    expect(longMessageId.length).toBeGreaterThan(190);
    const key = await internalKey("claimId123", "msg", longMessageId);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });
});
