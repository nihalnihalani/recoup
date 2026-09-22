import { describe, it, expect } from "vitest";
import { parseSubjectKey, subjectKey, subjectMatches, MAX_SUBJECT_ORDINAL } from "./subject";

describe("lib/facts/subject", () => {
  it("builds and parses each subject kind", () => {
    expect(subjectKey.txn()).toBe("txn");
    expect(parseSubjectKey("txn")).toEqual({ kind: "transaction" });
    expect(subjectKey.item("abc123")).toBe("item:abc123");
    expect(parseSubjectKey("item:abc123")).toEqual({ kind: "item", id: "abc123" });
    expect(subjectKey.incident("xyz")).toBe("incident:xyz");
    expect(parseSubjectKey("incident:xyz")).toEqual({ kind: "incident", id: "xyz" });
    expect(subjectKey.segment(2)).toBe("segment:2");
    expect(parseSubjectKey("segment:2")).toEqual({ kind: "segment", ordinal: 2 });
    expect(subjectKey.line(15)).toBe("line:15");
    expect(parseSubjectKey("line:15")).toEqual({ kind: "line", ordinal: 15 });
  });

  it("refuses anything outside the closed grammar", () => {
    for (const bad of [
      "", "TXN", "txn:1", "item:", "item", "item:a b", "item:a:b", "incident:", "order:1", "segment:0",
      `segment:${MAX_SUBJECT_ORDINAL + 1}`, "segment:01", "segment:-1", "segment:1.5", "line:x", " txn", "txn ",
      `item:${"a".repeat(65)}`,
    ]) {
      expect(parseSubjectKey(bad), bad).toBeNull();
    }
  });

  it("builders refuse values the parser would refuse", () => {
    expect(() => subjectKey.segment(0)).toThrow();
    expect(() => subjectKey.line(MAX_SUBJECT_ORDINAL + 1)).toThrow();
    expect(() => subjectKey.item("a:b")).toThrow();
  });

  it("matches the FactRequirement subject patterns (§4)", () => {
    expect(subjectMatches("item:*", "item:abc")).toBe(true);
    expect(subjectMatches("item:*", "txn")).toBe(false);
    expect(subjectMatches("txn", "txn")).toBe(true);
    expect(subjectMatches("item:abc", "item:abc")).toBe(true);
    expect(subjectMatches("item:abc", "item:abd")).toBe(false);
    expect(subjectMatches("segment:*", "segment:3")).toBe(true);
    expect(subjectMatches("*", "incident:q")).toBe(true);
  });
});
