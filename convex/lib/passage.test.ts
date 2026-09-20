import { describe, it, expect } from "vitest";
import { verifyPassage, normalizeWhitespace } from "./passage";

describe("normalizeWhitespace", () => {
  it("collapses whitespace runs and trims", () => {
    expect(normalizeWhitespace("Hello   world\n\nfoo\tbar  ")).toBe("Hello world foo bar");
  });
});

describe("verifyPassage", () => {
  it("finds a passage despite whitespace differences and returns its start", () => {
    const markdown = "# Returns\n\nYou may   return items\nwithin 30 days of delivery for a full refund.";
    const passage = "You may return items within 30 days of delivery";
    const normMarkdown = normalizeWhitespace(markdown);
    const expectedStart = normMarkdown.indexOf(normalizeWhitespace(passage));
    expect(expectedStart).toBeGreaterThanOrEqual(0);
    expect(verifyPassage(markdown, passage)).toBe(expectedStart);
  });

  it("returns null for a passage absent from the markdown", () => {
    const markdown = "# Returns\n\nWe do not accept returns after 14 days.";
    const passage = "You may return items within 30 days of delivery";
    expect(verifyPassage(markdown, passage)).toBeNull();
  });

  it("returns null for an empty passage", () => {
    const markdown = "# Returns\n\nWe do not accept returns after 14 days.";
    expect(verifyPassage(markdown, "")).toBeNull();
    expect(verifyPassage(markdown, "   \n\t  ")).toBeNull();
  });
  it("requires at least 40 normalized characters (D45)", () => {
    const markdown = "Returns are accepted within 30 days of delivery for a full refund.";
    expect(verifyPassage(markdown, "within 30 days")).toBeNull();
    expect(verifyPassage(markdown, "Returns are accepted within 30 days of delivery")).toBe(0);
  });
});
