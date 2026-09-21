import { describe, it, expect } from "vitest";
import { cleanLine, meaningfulName, stripControl } from "./text";

const NUL = String.fromCharCode(0);
const ESC = String.fromCharCode(27);

describe("stripControl", () => {
  it("removes the newlines that could forge a mail header", () => {
    expect(stripControl("Subject\r\nBcc: victim@example.com")).toBe("SubjectBcc: victim@example.com");
  });

  it("removes other control characters", () => {
    expect(stripControl(`a${NUL}b${ESC}c`)).toBe("abc");
  });
});

describe("meaningfulName", () => {
  it("keeps a real product name", () => {
    expect(meaningfulName("  KitchenAid Artisan 5qt  ")).toBe("KitchenAid Artisan 5qt");
  });

  it("keeps a name that is only digits, such as a model number", () => {
    expect(meaningfulName("B0D1XD1ZV3")).toBe("B0D1XD1ZV3");
    expect(meaningfulName("94259066")).toBe("94259066");
  });

  it("rejects a name with no letters or digits, so a readable default survives", () => {
    for (const junk of [".", " - ", "|", "()", "···", "", NUL]) {
      expect(meaningfulName(junk)).toBeNull();
    }
  });

  it("returns null for a missing name", () => {
    expect(meaningfulName(undefined)).toBeNull();
  });

  it("keeps a name in any script", () => {
    expect(meaningfulName("ノートパソコン")).toBe("ノートパソコン");
  });
});

describe("cleanLine", () => {
  it("is unchanged by the new guard: it still returns punctuation-only input", () => {
    expect(cleanLine(" . ")).toBe(".");
  });
});
