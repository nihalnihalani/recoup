/// <reference types="vite/client" />
/**
 * M11d (C43, mission §14 "re-evaluate deterministically after changes"): `purchases.confirm` and `facts.answer`
 * re-evaluate the transaction in the SAME mutation, scoped to the changed subjects, so the opportunity card shows the
 * new outcome reactively. R01 v1 is forced active through the test-registry seam (C3).
 *
 * `evaluateTransaction` is wrapped in a spy (same behaviour) so the facts.answer wiring can be observed: after M11b no
 * key R01 reads is answerable through facts.answer on a purchase-backed transaction, so an answer can only change an
 * outcome for the wave-2 packs; what it must do today is call the evaluator for the changed subject.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
vi.mock("./opportunities", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./opportunities")>();
  return { ...actual, evaluateTransaction: vi.fn(actual.evaluateTransaction) };
});

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluateTransaction } from "./opportunities";
import { resetTestRegistry } from "./lib/rules/testRegistry";
import { ensurePurchaseTransaction } from "./transactions";
import schema from "./schema";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);
const PURCHASED = NOW - 2 * DAY;
const DOMAIN = "acme.example";
type T = ReturnType<typeof setup>;

const spy = vi.mocked(evaluateTransaction);
beforeEach(() => {
  spy.mockClear();
});
afterEach(() => resetTestRegistry());

async function world(t: T, userId: Id<"users">, o: { items?: number; status?: "active" | "needs_review"; purchasedAt?: number | null } = {}) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: DOMAIN, orderRef: "A-1", currency: "USD", status: o.status ?? "active",
      ...(o.purchasedAt === null ? {} : { purchasedAt: o.purchasedAt ?? PURCHASED }),
    });
    const itemIds: Id<"items">[] = [];
    for (let i = 0; i < (o.items ?? 1); i++) {
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: `Jacket ${i + 1}`, unitCents: 12_000, qty: 1, productUrl: `https://${DOMAIN}/p/${i}`, returned: false,
      });
      itemIds.push(itemId);
      await ctx.db.insert("priceChecks", {
        itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.92, variantMatch: "exact",
        observedAt: NOW - 60_000, sourceUrl: `https://${DOMAIN}/p/${i}`,
      });
    }
    await ctx.db.insert("policies", {
      userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: 14, channel: "email",
      contactEmail: "help@acme.example", passage: "We adjust the price within 14 days of purchase.",
      sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: PURCHASED + 60_000, confidence: 0.9, confirmedByUser: false,
    });
    const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
    return { purchaseId, itemIds, transactionId };
  });
}

/** The baseline evaluation a price check would have produced. */
async function baseline(t: T, transactionId: Id<"transactions">) {
  await t.run(async (ctx) => {
    await evaluateTransaction(ctx, transactionId, "user_request", NOW);
  });
  spy.mockClear();
}

const oppFor = async (t: T, transactionId: Id<"transactions">, itemId: Id<"items">) =>
  (await t.run((ctx) => ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect()))
    .find((o) => o.subjectKey === `item:${itemId}`)!;
const evalsOf = (t: T, opportunityId: Id<"opportunities">) =>
  t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", opportunityId)).collect());
const allEvals = (t: T) => t.run(async (ctx) => (await ctx.db.query("evaluations").collect()).length);

function confirmArgs(w: { purchaseId: Id<"purchases">; itemIds: Id<"items">[] }, over: { unitCents?: (i: number) => number; orderRef?: string; purchasedAt?: number } = {}) {
  return {
    purchaseId: w.purchaseId, merchant: "Acme", merchantDomain: DOMAIN, orderRef: over.orderRef ?? "A-1", purchasedAt: over.purchasedAt ?? PURCHASED,
    items: w.itemIds.map((itemId, i) => ({ itemId, name: `Jacket ${i + 1}`, unitCents: over.unitCents?.(i) ?? 12_000, qty: 1, productUrl: `https://${DOMAIN}/p/${i}` })),
  };
}

describe("purchases.confirm re-evaluates in the same mutation (C43)", () => {
  pinClockEach(NOW);

  it("a corrected unit price re-evaluates that item: new estimate and one new evaluation, before the call returns", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await world(t, userId, { items: 2 });
    await baseline(t, w.transactionId);
    const before = await oppFor(t, w.transactionId, w.itemIds[1]);
    expect(before.estimate).toEqual({ amountMinor: 2_500, currency: "USD" });
    const untouched = await oppFor(t, w.transactionId, w.itemIds[0]);

    await as.mutation(api.purchases.confirm, confirmArgs(w, { unitCents: (i) => (i === 1 ? 11_000 : 12_000) }));

    const after = await oppFor(t, w.transactionId, w.itemIds[1]);
    expect(after.estimate).toEqual({ amountMinor: 1_500, currency: "USD" });
    const evals = await evalsOf(t, after._id);
    expect(evals.map((e) => e.trigger)).toEqual(["user_request", "fact_change"]);
    // Scoped to the changed subject: the other item was not re-evaluated.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(1)).toEqual([w.transactionId, "fact_change", NOW, { subjects: [`item:${w.itemIds[1]}`] }]);
    expect(await evalsOf(t, untouched._id)).toHaveLength(1);
  });

  it("confirming a needs_review purchase with its missing purchase date changes the outcome in the same call", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await world(t, userId, { status: "needs_review", purchasedAt: null });
    await baseline(t, w.transactionId);
    const before = await oppFor(t, w.transactionId, w.itemIds[0]);
    expect(before.outcome).not.toBe("likely_eligible");

    await as.mutation(api.purchases.confirm, confirmArgs(w));

    const after = await oppFor(t, w.transactionId, w.itemIds[0]);
    expect(after.outcome).toBe("likely_eligible");
    expect(after.estimate).toEqual({ amountMinor: 2_500, currency: "USD" });
    // A transaction-level change (date, status) re-evaluates every subject.
    expect(spy.mock.calls[0].slice(1)).toEqual([w.transactionId, "fact_change", NOW, {}]);
  });

  it("no evaluation row is written when the result hash is unchanged (order ref edit, identical re-confirm)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await world(t, userId, { items: 2 });
    await baseline(t, w.transactionId);
    const count = await allEvals(t);
    await as.mutation(api.purchases.confirm, confirmArgs(w, { orderRef: "A-2" }));
    expect(spy).toHaveBeenCalledTimes(1); // re-evaluated (transaction-level change) …
    expect(await allEvals(t)).toBe(count); // … but R01's result did not change, so nothing was appended
    spy.mockClear();
    await as.mutation(api.purchases.confirm, confirmArgs(w, { orderRef: "A-2" }));
    expect(spy).not.toHaveBeenCalled(); // nothing changed at all: no evaluation work
    expect(await allEvals(t)).toBe(count);
  });

  it("a deleted account's confirm is refused and evaluates nothing", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const w = await world(t, userId);
    await baseline(t, w.transactionId);
    const count = await allEvals(t);
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 }));
    await expect(as.mutation(api.purchases.confirm, confirmArgs(w, { unitCents: () => 11_000 }))).rejects.toThrow(/deleted/);
    expect(spy).not.toHaveBeenCalled();
    expect(await allEvals(t)).toBe(count);
  });
});

describe("facts.answer re-evaluates in the same mutation (C43)", () => {
  pinClockEach(NOW);

  async function standalone(t: T, userId: Id<"users">) {
    return t.run((ctx) =>
      ctx.db.insert("transactions", { userId, category: "retail_order", status: "active", counterpartyName: "Shop", currency: "USD", liveFactCount: 0 }),
    );
  }

  it("a written answer calls the evaluator for its transaction with trigger fact_change", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const txn = await standalone(t, userId);
    await as.mutation(api.facts.answer, { transactionId: txn, subjectKey: "txn", key: "retail.merchant", value: { kind: "text", text: "Shop" } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0].slice(1)).toEqual([txn, "fact_change", NOW, {}]);
  });

  it("an identical re-answer, a refused answer and a deleted account evaluate nothing", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const txn = await standalone(t, userId);
    const args = { transactionId: txn, subjectKey: "txn", key: "retail.merchant", value: { kind: "text" as const, text: "Shop" } };
    await as.mutation(api.facts.answer, args);
    spy.mockClear();
    expect((await as.mutation(api.facts.answer, args)).outcome).toBe("unchanged");
    await expect(as.mutation(api.facts.answer, { ...args, key: "retail.window_days", value: { kind: "count", n: 3 } })).rejects.toThrow();
    const w = await world(t, userId);
    await expect(as.mutation(api.facts.answer, { transactionId: w.transactionId, subjectKey: `item:${w.itemIds[0]}`, key: "retail.unit_price", value: { kind: "money", amountMinor: 1, currency: "USD" } })).rejects.toThrow(/edit the purchase/);
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 }));
    await expect(as.mutation(api.facts.answer, { ...args, value: { kind: "text", text: "Other" } })).rejects.toThrow(/deleted/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("budget: confirm + a full 50-item re-evaluation fits one transaction (so it is not scheduled)", () => {
  pinClockEach(NOW);

  it("purchase-level change on a 50-item purchase: every item re-evaluated inside confirm, under real limits", async () => {
    // Enforcing harness (transactionLimits: true); confirm needs no mounted component.
    const t = convexTest({ schema, modules: import.meta.glob("./**/*.*s"), transactionLimits: true });
    const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Fifty" }));
    const as = t.withIdentity({ subject: `${userId}|session` });
    const w = await world(t as unknown as T, userId, { items: 50 });
    const m = await as.run(async (ctx) => {
      await ctx.runMutation(api.purchases.confirm, confirmArgs(w, { purchasedAt: PURCHASED + 60_000 }));
      const metrics = await ctx.meta.getTransactionMetrics();
      return { docs: metrics.documentsRead.used, queries: metrics.databaseQueries.used, written: metrics.documentsWritten.used };
    });
    const opps = await t.run((ctx) => ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", w.transactionId)).collect());
    expect(opps).toHaveLength(50);
    expect(opps.every((o) => o.outcome === "likely_eligible")).toBe(true);
    // Half of every platform limit (32,000 documents read, 4,096 queries, 16,000 documents written) as headroom.
    expect(m.docs).toBeLessThan(16_000);
    expect(m.queries).toBeLessThan(2_048);
    expect(m.written).toBeLessThan(8_000);
  }, 30_000);
});
