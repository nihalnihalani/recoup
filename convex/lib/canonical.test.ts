/**
 * lib/canonical (contract rev 5 §2.4 approvalBinding.contextHash, §2.5 snapshotHash/boundFactsHash, DA-A-15):
 * canonical JSON — sorted keys, undefined object fields dropped, integers only, no floats, arrays in order —
 * and SHA-256 hex over it. Binding hashes cover VALUES, never row ids.
 */
import { describe, expect, it } from "vitest";
import { boundFactsHash, canonicalHash, canonicalJson, sha256Hex, sortCanonical } from "./canonical";

describe("canonicalJson", () => {
  it("sorts object keys at every depth; key order never changes the output", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[3,2]},"b":1}');
    expect(canonicalJson({ a: { c: "x", d: [3, 2] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [3, 2], c: "x" } }));
  });

  it("drops undefined object fields (an optional field absent or undefined hashes the same)", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it("keeps array order (sets are sorted by the caller or with sortCanonical)", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(canonicalJson(sortCanonical([{ k: "b" }, { k: "a" }]))).toBe(canonicalJson(sortCanonical([{ k: "a" }, { k: "b" }])));
  });

  it("encodes scalars and strings unambiguously", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(-42)).toBe("-42");
    expect(canonicalJson('a"b\né')).toBe('"a\\"b\\né"');
    expect(canonicalJson(["a,b"])).not.toBe(canonicalJson(["a", "b"]));
    expect(canonicalJson({ "a.b": 1 })).not.toBe(canonicalJson({ a: { b: 1 } }));
  });

  it.each([
    ["a float", 1.5],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["-Infinity", -Infinity],
    ["an unsafe integer", 2 ** 53],
    ["a nested float", { amount: { amountMinor: 12.5 } }],
    ["undefined at the top", undefined],
    ["undefined inside an array", [1, undefined]],
    ["a bigint", 1n],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a function", () => 1],
    ["a symbol", Symbol("s")],
    ["a class instance", new (class X { a = 1 })()],
  ])("refuses %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow();
  });

  it("refuses a cycle instead of recursing forever", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/cycle/);
  });

  it("allows the same object twice when it is not a cycle", () => {
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});

describe("sha256Hex / canonicalHash", () => {
  it("sha256Hex is the standard lowercase hex digest", async () => {
    expect(await sha256Hex("hello")).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("canonicalHash is key-order independent, value sensitive, 64 lowercase hex", async () => {
    const h1 = await canonicalHash({ claimVersion: 3, amount: { currency: "USD", amountMinor: 5_000 } });
    const h2 = await canonicalHash({ amount: { amountMinor: 5_000, currency: "USD" }, claimVersion: 3 });
    const h3 = await canonicalHash({ amount: { amountMinor: 5_001, currency: "USD" }, claimVersion: 3 });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h3).not.toBe(h1);
  });
});

describe("boundFactsHash (DA-A-15: values, not row ids)", () => {
  const price = { subjectKey: "item:i1", key: "retail.unit_price", status: "confirmed" as const, value: { kind: "money" as const, amountMinor: 12_000, currency: "USD" } };
  const qty = { subjectKey: "item:i1", key: "retail.qty", status: "confirmed" as const, value: { kind: "count" as const, n: 2 } };

  it("the same value re-confirmed on a NEW row (new fact/evidence ids) → the same hash", async () => {
    const first = [{ ...price, factId: "f1", evidenceId: "e1" }, { ...qty, factId: "f2" }];
    const reconfirmed = [{ ...price, factId: "f9", evidenceId: "e7", recordedAt: 99 }, { ...qty, factId: "f10" }];
    expect(await boundFactsHash(reconfirmed)).toBe(await boundFactsHash(first));
    expect(await boundFactsHash(first)).toBe(await boundFactsHash([price, qty]));
  });

  it("is order-insensitive over the set", async () => {
    expect(await boundFactsHash([qty, price])).toBe(await boundFactsHash([price, qty]));
  });

  it("changes when a value, a status, a key or a subject changes, and for a missing cell", async () => {
    const base = await boundFactsHash([price, qty]);
    expect(await boundFactsHash([{ ...price, value: { ...price.value, amountMinor: 11_999 } }, qty])).not.toBe(base);
    expect(await boundFactsHash([{ ...price, status: "candidate" }, qty])).not.toBe(base);
    expect(await boundFactsHash([{ ...price, key: "retail.list_price" }, qty])).not.toBe(base);
    expect(await boundFactsHash([{ ...price, subjectKey: "item:i2" }, qty])).not.toBe(base);
    expect(await boundFactsHash([{ subjectKey: "item:i1", key: "retail.unit_price", status: "missing" }, qty])).not.toBe(base);
  });

  it("refuses more than 32 bound facts (rev 5 N6 bound)", async () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ subjectKey: `s${i}`, key: "k", status: "missing" as const }));
    await expect(boundFactsHash(many)).rejects.toThrow(/32/);
  });
});
