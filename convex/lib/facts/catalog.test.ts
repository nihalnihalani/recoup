import { describe, it, expect, expectTypeOf } from "vitest";
import { FACT_SPECS, getFactSpec, isFactKey, type FactKey, type FactSpec, type ValueFor } from "./catalog";
import { RETAIL_FACT_SPECS } from "./keys_retail";
import { ORDER_FACT_SPECS } from "./keys_order";
import { AIR_FACT_SPECS } from "./keys_air";
import { CARD_FACT_SPECS } from "./keys_card";

describe("lib/facts/catalog (closed catalogue, contract §2.5)", () => {
  it("merges every domain file, each spec tagged with its file's domain", () => {
    expect(FACT_SPECS).toHaveLength(RETAIL_FACT_SPECS.length + ORDER_FACT_SPECS.length + AIR_FACT_SPECS.length + CARD_FACT_SPECS.length);
    const files: [readonly FactSpec[], FactSpec["domain"]][] = [
      [RETAIL_FACT_SPECS, "retail"], [ORDER_FACT_SPECS, "order"], [AIR_FACT_SPECS, "air"], [CARD_FACT_SPECS, "card"],
    ];
    for (const [specs, domain] of files) for (const s of specs) expect(s.domain, s.key).toBe(domain);
  });

  it("holds exactly the retail keys R01 v1 and the legacy adapter use", () => {
    expect((FACT_SPECS as readonly FactSpec[]).filter((s) => s.domain === "retail").map((s) => s.key).sort()).toEqual([
      "retail.currency",
      "retail.item_name",
      "retail.merchant",
      "retail.observed_price",
      "retail.order_ref",
      "retail.policy_confirmed",
      "retail.policy_temporal",
      "retail.purchase_date",
      "retail.quantity",
      "retail.unit_price",
      "retail.window_days",
    ]);
  });

  it("every spec is well formed", () => {
    const seen = new Set<string>();
    for (const s of FACT_SPECS as readonly FactSpec[]) {
      expect(seen.has(s.key), `duplicate ${s.key}`).toBe(false);
      seen.add(s.key);
      expect(s.key).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
      expect(s.categories.length).toBeGreaterThan(0);
      expect(s.subject.length).toBeGreaterThan(0);
      expect(s.value === "code", `${s.key}: codes iff code`).toBe(s.codes !== undefined);
      if (Array.isArray(s.codes)) expect(s.codes.length).toBeGreaterThan(0);
      expect(s.value === "identifier", `${s.key}: scheme iff identifier`).toBe(s.identifierScheme !== undefined);
      expect(s.value === "money" || s.currencyMode === undefined, `${s.key}: currencyMode only on money`).toBe(true);
      expect(s.question.prompt.length).toBeGreaterThan(0);
      expect(s.question.why.length).toBeGreaterThan(0);
    }
  });

  it("the policy-derived and observed keys cannot be asserted by the user", () => {
    for (const key of ["retail.observed_price", "retail.window_days", "retail.policy_confirmed", "retail.policy_temporal"]) {
      expect(getFactSpec(key)?.userAssertable, key).toBe(false);
    }
    for (const key of ["retail.currency", "retail.unit_price", "retail.quantity", "retail.purchase_date"]) {
      expect(getFactSpec(key)?.userAssertable, key).toBe(true);
    }
  });

  it("retail money keys admit the R01 two-decimal carve-out (DA-A-13)", () => {
    expect(getFactSpec("retail.unit_price")?.currencyMode).toBe("legacy_r01");
    expect(getFactSpec("retail.observed_price")?.currencyMode).toBe("legacy_r01");
  });

  it("refuses off-catalogue keys", () => {
    expect(getFactSpec("retail.nope")).toBeNull();
    expect(getFactSpec("__proto__")).toBeNull();
    expect(getFactSpec("constructor")).toBeNull();
    expect(isFactKey("retail.unit_price")).toBe(true);
    expect(isFactKey("retail.order_total")).toBe(true); // wave 2, keys_order.ts (M21): the confirmed order total
    expect(getFactSpec("retail.order_total")).toMatchObject({ domain: "order", value: "money", subject: ["transaction"], categories: ["retail_order"] });
  });

  it("types each key's value (compile-time)", () => {
    expectTypeOf<"retail.unit_price">().toMatchTypeOf<FactKey>();
    expectTypeOf<ValueFor<"retail.unit_price">>().toEqualTypeOf<{ kind: "money"; amountMinor: number; currency: string }>();
    expectTypeOf<ValueFor<"retail.quantity">>().toEqualTypeOf<{ kind: "count"; n: number }>();
  });
});
