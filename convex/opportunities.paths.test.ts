/// <reference types="vite/client" />
/**
 * Engine paths R01 v1 itself never produces, driven by wrapping the pack's `evaluate` (test-only):
 *  - D147(6): a `not_yet_due` result → openCase refuses with nextAction wait; no auto-open; never a money tile.
 *  - a throwing pack → recorded through `ops.recordRuleEvaluationFailure`, never rethrown; the caller's writes survive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
const mode = vi.hoisted(() => ({ value: "normal" as "normal" | "not_yet_due" | "throw" }));
vi.mock("./lib/rules/r01_price_adjustment_v1", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/rules/r01_price_adjustment_v1")>();
  return {
    ...orig,
    r01PriceAdjustmentV1: {
      ...orig.r01PriceAdjustmentV1,
      evaluate: (input: Parameters<typeof orig.evaluateR01V1>[0]) => {
        if (mode.value === "throw") throw new Error("pack exploded");
        const r = orig.evaluateR01V1(input);
        if (mode.value !== "not_yet_due") return r;
        const reevaluate = { at: "2026-10-11" };
        return { ...r, outcome: "not_yet_due" as const, reevaluate, nextAction: { kind: "wait" as const, reevaluate } };
      },
    },
  };
});

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluatePurchase } from "./opportunities";
import { r01AutoOpen } from "./lib/rules/r01_price_adjustment_v1";
import { ensurePurchaseTransaction } from "./transactions";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);
type T = ReturnType<typeof setup>;

import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
// M20 (D208): R05 (wave 2) now evaluates retail transactions through its adapter; these R01 tests narrow the C3 seam to R01 v1.
beforeEach(() => setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]));
afterEach(() => resetTestRegistry());
afterEach(() => {
  mode.value = "normal";
});

async function world(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - 1000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * DAY, confidence: 0.9, confirmedByUser: true });
    const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
    return { purchaseId, itemId, transactionId };
  });
}

describe("rule 4b paths and failure isolation (pack wrapped for the test)", () => {
  pinClockEach(NOW);

  it("D147(6): not_yet_due → openCase refused with nextAction wait; no claim; never in a money tile", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    mode.value = "not_yet_due";
    await t.run(async (ctx) => {
      await evaluatePurchase(ctx, w.purchaseId, "user_request", NOW);
    });
    const [opp] = await t.run((ctx) => ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", w.transactionId)).collect());
    expect(opp.outcome).toBe("not_yet_due");
    expect(opp.estimate).toBeUndefined(); // never shown as owed
    const evaluation = (await t.run((ctx) => ctx.db.get(opp.currentEvaluationId!)))!;
    expect(evaluation.reevaluate).toEqual({ at: "2026-10-11" });
    const r = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(r).toMatchObject({ ok: false, code: "not_yet_due", nextAction: { kind: "wait", reevaluate: { at: "2026-10-11" } } });
    expect(await t.run((ctx) => ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", w.itemId)).collect())).toEqual([]);
    expect(r01AutoOpen({ ...evaluation, outcome: "not_yet_due", amount: evaluation.amount } as never, { openClaimExists: false }).opens).toBe(false);

    // Even with an estimate on the row, a not_yet_due opportunity is only counted, never a money tile.
    await t.run((ctx) => ctx.db.patch(opp._id, { estimate: { amountMinor: 2_500, currency: "USD" } }));
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.counts.notYetDue).toBe(1);
    for (const c of s.currencies) for (const tile of Object.values(c.tiles)) expect(tile.amountMinor).toBe(0);
  });

  it("a throwing pack is recorded (ops counter), never rethrown; the caller's own writes survive", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    mode.value = "throw";
    await t.run(async (ctx) => {
      await evaluatePurchase(ctx, w.purchaseId, "observation", NOW);
      await ctx.db.patch(w.itemId, { imageUrl: "https://acme.example/i.png" });
    });
    const item = (await t.run((ctx) => ctx.db.get(w.itemId)))!;
    expect(item.imageUrl).toBe("https://acme.example/i.png");
    const counters = await t.run((ctx) => ctx.db.query("opsState").collect());
    const failures = counters.filter((r) => r.key.startsWith("ruleEvalFailures:"));
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0].cursor!).byRule).toEqual({ "R01.retail_price_adjustment@1": 1 });
    expect(await t.run((ctx) => ctx.db.query("opportunities").collect())).toEqual([]);
  });
});
