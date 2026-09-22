/// <reference types="vite/client" />
/**
 * DA-B-4 (checkpoint B; DA-A-11, D145(c)): the PRODUCTION registry returns a pack only when `activation.ts` makes it
 * active. Since D186 every implemented pack is active, so `registry.test.ts`'s comparison with the real data passes
 * even if production ignored `activation.ts`. Here the activation data itself is mocked (the lead-owned file is never
 * edited): with no entry, or with the entry withdrawn, nothing evaluates — not the registry, not `evaluateTransaction`.
 * Proof recorded in the M12d report: with `activePacks = () => [...IMPLEMENTED_PACKS]` in registry.ts these tests fail.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Activation } from "./activation";

const ACTS: Activation[] = vi.hoisted(() => []);
vi.mock("./activation", () => ({ ACTIVATIONS: ACTS }));

import type { Id } from "../../_generated/dataModel";
import { setup, signedIn } from "../../test.setup";
import { evaluatePurchase } from "../../opportunities";
import { ensurePurchaseTransaction } from "../../transactions";
import { activationDecision, activePack, activePacks, activePacksForCategory, isPackActive, REGISTRY_KIND } from "./registry";

const R01_ACTIVE: Activation = { ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "D186" };
const R01_WITHDRAWN: Activation = { ...R01_ACTIVE, status: "withdrawn", decision: "D999" };

function setActivations(list: Activation[]) {
  ACTS.length = 0;
  ACTS.push(...list);
}
afterEach(() => setActivations([]));

function expectNothingActive() {
  expect(REGISTRY_KIND).toBe("production");
  expect(activePacks()).toEqual([]);
  expect(activePack("R01")).toBeNull();
  expect(activePacksForCategory("retail_order")).toEqual([]);
  expect(isPackActive(R01_ACTIVE.ruleId, 1)).toBe(false);
  expect(activationDecision(R01_ACTIVE.ruleId, 1)).toBeNull();
}

const NOW = Date.UTC(2026, 8, 20, 14);
async function evaluateOnePurchase() {
  const t = setup();
  const { userId } = await signedIn(t);
  const count = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 86_400_000, currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - 1_000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 86_400_000, confidence: 0.9, confirmedByUser: true });
    await ensurePurchaseTransaction(ctx, purchaseId);
    return (await evaluatePurchase(ctx, purchaseId, "user_request", NOW)).length;
  });
  const opportunities = await t.run((ctx) => ctx.db.query("opportunities").collect());
  const evaluations = await t.run((ctx) => ctx.db.query("evaluations").collect());
  return { count, opportunities: opportunities.length, evaluations: evaluations.length, userId: userId as Id<"users"> };
}

describe("DA-B-4: the production registry obeys activation.ts (activation data mocked)", () => {
  it("no activation entry → no active pack anywhere in the registry", () => {
    setActivations([]);
    expectNothingActive();
  });

  it("active, then withdrawn (the last entry wins) → nothing", () => {
    setActivations([R01_ACTIVE, R01_WITHDRAWN]);
    expectNothingActive();
  });

  it("an entry for another version or rule activates nothing", () => {
    setActivations([{ ...R01_ACTIVE, version: 2 }, { ...R01_ACTIVE, ruleId: "R01.other" }]);
    expectNothingActive();
  });

  it("control: the same seam with R01 v1 active does activate it (so the tests above are not vacuous)", () => {
    setActivations([R01_ACTIVE]);
    expect(activePack("R01")?.ruleId).toBe(R01_ACTIVE.ruleId);
    expect(activationDecision(R01_ACTIVE.ruleId, 1)).toBe("D186");
    setActivations([R01_WITHDRAWN, R01_ACTIVE]); // re-activation after a withdrawal: the last entry wins
    expect(activePack("R01")).not.toBeNull();
  });

  it("evaluateTransaction evaluates nothing and writes no opportunity or evaluation without an activation", async () => {
    setActivations([]);
    expect(await evaluateOnePurchase()).toMatchObject({ count: 0, opportunities: 0, evaluations: 0 });
    setActivations([R01_ACTIVE, R01_WITHDRAWN]);
    expect(await evaluateOnePurchase()).toMatchObject({ count: 0, opportunities: 0, evaluations: 0 });
  });

  it("control: with R01 v1 active the same purchase is evaluated", async () => {
    setActivations([R01_ACTIVE]);
    expect(await evaluateOnePurchase()).toMatchObject({ count: 1, opportunities: 1, evaluations: 1 });
  });
});
