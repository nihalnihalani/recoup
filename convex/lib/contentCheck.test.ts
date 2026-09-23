/**
 * M28 (D214 logged false positive): a year followed by a currency code is not an amount. "…September 2, 2026, USD
 * 129.99" used to list "amount 2026, USD" (the digit run swallowed the comma), so a correct letter needed an
 * acknowledgment for an amount it never stated.
 */
import { describe, expect, it } from "vitest";
import { unverifiedContent } from "./contentCheck";

const allowed = { emails: new Set<string>(), urls: new Set<string>(), hosts: new Set<string>(), amountsMinor: new Set([12_999]) };

describe("contentCheck: dates before an amount are not amounts", () => {
  it.each([
    "I ordered it on September 2, 2026, USD 129.99 was charged.",
    "Ordered September 2, 2026 USD 129.99 paid.",
    "On 2 September 2026, USD 129.99 left my account.",
  ])("%s → no finding", (body) => {
    expect(unverifiedContent(body, allowed)).toEqual([]);
  });

  it("an amount that really is unknown is still listed, in every form", () => {
    expect(unverifiedContent("Please refund 2026 USD.", allowed)).toEqual(["amount 2026 USD"]);
    expect(unverifiedContent("Please refund USD 450.", allowed)).toEqual(["amount USD 450"]);
    expect(unverifiedContent("Please refund 1,450 dollars.", allowed)).toEqual(["amount 1,450 dollars"]);
    expect(unverifiedContent("I paid USD 129.99 on September 2, 2026, and want USD 99.", allowed)).toEqual(["amount USD 99"]);
  });
});
