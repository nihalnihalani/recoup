import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { normalizeEmail, parseSingleEmail } from "./email";

describe("normalizeEmail (D67)", () => {
  it("trims, lowercases, and leaves an already-clean address alone", () => {
    expect(normalizeEmail("  Foo@Example.COM ")).toBe("foo@example.com");
    expect(normalizeEmail("bar@baz.com")).toBe("bar@baz.com");
  });

  it("does not fold plus/dot addressing (documented limitation, D67)", () => {
    expect(normalizeEmail("Foo+alerts@Example.com")).toBe("foo+alerts@example.com");
    expect(normalizeEmail("f.o.o@example.com")).toBe("f.o.o@example.com");
  });

  it("rejects a value with no @", () => {
    expect(() => normalizeEmail("not-an-email")).toThrow(ConvexError);
    expect(() => normalizeEmail("not-an-email")).toThrow("Enter a valid email address");
  });

  it("rejects a value with no domain dot", () => {
    expect(() => normalizeEmail("foo@localhost")).toThrow(ConvexError);
  });

  it("rejects whitespace-only input", () => {
    expect(() => normalizeEmail("   ")).toThrow(ConvexError);
  });

  it("rejects addresses over 254 characters", () => {
    const long = `${"a".repeat(250)}@b.com`; // > 254 chars total
    expect(long.length).toBeGreaterThan(254);
    expect(() => normalizeEmail(long)).toThrow(ConvexError);
  });

  it("accepts an address right at the 254-char cap", () => {
    const local = "a".repeat(254 - "@b.com".length);
    const atCap = `${local}@b.com`;
    expect(atCap.length).toBe(254);
    expect(normalizeEmail(atCap)).toBe(atCap);
  });

  it("rejects non-string input", () => {
    expect(() => normalizeEmail(undefined)).toThrow(ConvexError);
    expect(() => normalizeEmail(42)).toThrow(ConvexError);
    expect(() => normalizeEmail(null)).toThrow(ConvexError);
  });
});

describe("parseSingleEmail (D116)", () => {
  it("trims but keeps casing, unlike normalizeEmail", () => {
    expect(parseSingleEmail("  Help@Acme.Example  ", 320)).toBe("Help@Acme.Example");
  });

  it("accepts an address right at the caller-supplied cap", () => {
    const local = "a".repeat(320 - "@b.com".length);
    const atCap = `${local}@b.com`;
    expect(atCap.length).toBe(320);
    expect(parseSingleEmail(atCap, 320)).toBe(atCap);
  });

  it("rejects an address over the caller-supplied cap", () => {
    const local = "a".repeat(321 - "@b.com".length);
    const overCap = `${local}@b.com`;
    expect(overCap.length).toBe(321);
    expect(() => parseSingleEmail(overCap, 320)).toThrow(ConvexError);
  });

  it("rejects more than one address, even without a second @", () => {
    expect(() => parseSingleEmail("one@x.com, two@x.com", 320)).toThrow(ConvexError);
    expect(() => parseSingleEmail("one@x.com; two@x.com", 320)).toThrow(ConvexError);
  });

  it("rejects a malformed or empty address", () => {
    expect(() => parseSingleEmail("not-an-email", 320)).toThrow(ConvexError);
    expect(() => parseSingleEmail("", 320)).toThrow(ConvexError);
    expect(() => parseSingleEmail("   ", 320)).toThrow(ConvexError);
    expect(() => parseSingleEmail(undefined, 320)).toThrow(ConvexError);
  });
});
