/// <reference types="vite/client" />
/**
 * keys_order.ts (M21): the online-order keys R05 v1 reads and `retail.order_total`, the confirmed order total that is
 * both R05's refund amount and the retail paid-total cap of `recovery.summary` (contract §3.4, D148 wave-2 note).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Potential counts only a pack ACTIVE in the registry in use (mission §12); R05 is activated through the C3 seam.
vi.mock("../rules/registry", async () => await import("../rules/testRegistry"));

import { api } from "../../_generated/api";
import { resetTestRegistry, setTestActivations } from "../rules/testRegistry";
import { setup, signedIn } from "../../test.setup";
import { US_ZONES } from "../deadlines/usZones";
import { getFactSpec, type FactSpec } from "./catalog";
import { ISO_3166_ALPHA2, ORDER_FACT_SPECS, US_TIME_ZONE_IDS } from "./keys_order";
import { validateFactValue } from "./values";

describe("keys_order (catalogue)", () => {
  it("every order key is a transaction-level retail_order fact in the order domain", () => {
    for (const s of ORDER_FACT_SPECS as readonly FactSpec[]) {
      expect(s.domain, s.key).toBe("order");
      expect(s.subject, s.key).toEqual(["transaction"]);
      expect(s.categories, s.key).toEqual(["retail_order"]);
      expect(s.key.startsWith("order.") || s.key === "retail.order_total", s.key).toBe(true);
    }
  });

  it("retail.order_total is user-asserted money in the R01 two-decimal set (it caps every retail purchase)", () => {
    expect(getFactSpec("retail.order_total")).toMatchObject({ value: "money", currencyMode: "legacy_r01", userAssertable: true });
    expect(getFactSpec("retail.order_total")?.sourceOfTruth).toBeUndefined(); // no purchase field backs it
  });

  it("the derived vesting date is never asserted by the user", () => {
    expect(getFactSpec("order.refund_vests_on")?.userAssertable).toBe(false);
  });

  it("country codes are the 249 ISO 3166-1 alpha-2 codes; time zones are exactly the committed US zone table", () => {
    expect(ISO_3166_ALPHA2).toHaveLength(249);
    expect(new Set(ISO_3166_ALPHA2).size).toBe(249);
    for (const c of ISO_3166_ALPHA2) expect(c).toMatch(/^[A-Z]{2}$/);
    expect(ISO_3166_ALPHA2).toEqual(expect.arrayContaining(["US", "CA", "GB", "PR", "GU"]));
    expect([...US_TIME_ZONE_IDS].sort()).toEqual(US_ZONES.map((z) => z.id).sort());
  });

  it("values are validated against their domain (the writer runs this before any insert)", () => {
    const zone = getFactSpec("order.ship_to_time_zone")!;
    expect(validateFactValue(zone, { kind: "code", code: "America/New_York" }, { userSource: true })).toEqual({ kind: "code", code: "America/New_York" });
    expect(() => validateFactValue(zone, { kind: "code", code: "Europe/Paris" }, { userSource: true })).toThrow();
    const country = getFactSpec("order.seller_country")!;
    expect(() => validateFactValue(country, { kind: "code", code: "XX" }, { userSource: true })).toThrow();
    const total = getFactSpec("retail.order_total")!;
    expect(validateFactValue(total, { kind: "money", amountMinor: 64950, currency: "USD" }, { userSource: true })).toEqual({ kind: "money", amountMinor: 64950, currency: "USD" });
    expect(() => validateFactValue(total, { kind: "money", amountMinor: 1000, currency: "JPY" }, { userSource: true })).toThrow();
    expect(() => validateFactValue(getFactSpec("order.ship_time_days")!, { kind: "count", n: 400 }, { userSource: true })).toThrow();
  });
});

describe("retail.order_total as the paid-total cap through the public mutations (contract §3.4 wave-2 note)", () => {
  beforeEach(() => setTestActivations([{ ruleId: "R05.mitor_shipment.us_ftc", version: 1, status: "active", decision: "TEST" }]));
  afterEach(() => resetTestRegistry());
  async function order(withTotal: boolean) {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Example Outfitters", merchantDomain: "outfitters.example", orderRef: "EO-1", purchasedAt: Date.UTC(2026, 8, 1), currency: "USD",
      items: [{ name: "Tent", unitCents: 30000, qty: 2 }], // items 60,000
    });
    const transactionId = await t.run(async (ctx) =>
      (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).unique())!._id);
    if (withTotal) {
      await as.mutation(api.facts.answer, { transactionId, subjectKey: "txn", key: "retail.order_total", value: { kind: "money", amountMinor: 64950, currency: "USD" } });
    }
    // An R05 opportunity for the whole order (the pack is not wired into evaluateTransaction yet, M20).
    await t.run((ctx) =>
      ctx.db.insert("opportunities", {
        userId, transactionId, scenarioId: "R05", remedyKey: "order_refund", subjectKey: "txn",
        dedupeKey: `${transactionId}|R05|order_refund|txn|-`, status: "open", ruleId: "R05.mitor_shipment.us_ftc", ruleVersion: 1,
        outcome: "eligible", authorityClass: "legal_entitlement", remedyType: "cash_refund", cashClass: "cash",
        estimate: { amountMinor: 64950, currency: "USD" }, lossKeys: [`txn:${transactionId}:paid`], lastEvaluatedAt: Date.now(),
      }));
    const s = await as.query(api.recovery.summary, { now: Date.now() });
    return s.currencies.find((c) => c.currency === "USD")!;
  }

  it("an R05 estimate of 64,950 on a confirmed order total of 64,950 with items of 60,000 → not capped", async () => {
    const usd = await order(true);
    expect(usd.tiles.potential.amountMinor).toBe(64950);
    expect(usd.cappedAtPaidTotal).toBe(false);
    expect(usd.paidTotalPartial).toBe(false);
  });

  it("control: without the order total the item prices cap it at 60,000, labelled partial", async () => {
    const usd = await order(false);
    expect(usd.tiles.potential.amountMinor).toBe(60000);
    expect(usd.cappedAtPaidTotal).toBe(true);
    expect(usd.paidTotalPartial).toBe(true);
  });
});
