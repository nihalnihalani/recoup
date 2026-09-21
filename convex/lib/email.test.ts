import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { normalizeEmail } from "./email";

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
