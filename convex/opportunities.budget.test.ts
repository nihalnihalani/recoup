/// <reference types="vite/client" />
/**
 * Read budgets under REAL convex-test transaction limits (`transactionLimits: true`, options-object form — the
 * positional `setup()` ignores it, see readBudget.test.ts). Measured with `ctx.meta.getTransactionMetrics()`.
 *  - DA-A-32: evaluating a 50-item purchase fits one transaction; an observation re-evaluates ONE item and reads a
 *    small constant, not items².
 *  - §3.4 / KM5: `recovery.summary` over 200 claims + 200 open opportunities fits one query and stays complete.
 * R01 v1 is forced active through the test-registry seam (C3).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { evaluatePurchase, evaluateTransaction } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";
import { MAX_LIVE_FACTS_PER_TRANSACTION, SUMMARY_MAX_CLAIMS, SUMMARY_MAX_OPEN_OPPORTUNITIES } from "./limits";

const modules = import.meta.glob("./**/*.*s");
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });

function harness() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest({ schema, modules, transactionLimits: true });
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}
type T = ReturnType<typeof harness>;
const NOW = Date.now();
const DAY = 86_400_000;

async function user(t: T) {
  const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Budget" }));
  return { userId, as: t.withIdentity({ subject: `${userId}|session` }) };
}

async function purchaseWithItems(t: T, userId: Id<"users">, items: number) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency: "USD", status: "active" });
    const itemIds: Id<"items">[] = [];
    for (let i = 0; i < items; i++) {
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: `Item ${i}`, unitCents: 12_000, qty: 1, productUrl: `https://acme.example/p/${i}`, returned: false });
      itemIds.push(itemId);
      for (let k = 0; k < 3; k++) {
        await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500 - k, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - k * 1000, sourceUrl: `https://acme.example/p/${i}` });
      }
    }
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * DAY, confidence: 0.9, confirmedByUser: true });
    await ensurePurchaseTransaction(ctx, purchaseId);
    return { purchaseId, itemIds };
  });
}

async function measure(t: Pick<T, "run">, fn: (ctx: Parameters<Parameters<T["run"]>[0]>[0]) => Promise<void>) {
  return await t.run(async (ctx) => {
    await fn(ctx);
    const m = await ctx.meta.getTransactionMetrics();
    return { documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used, documentsWritten: m.documentsWritten.used };
  });
}

describe("read budgets (transactionLimits: true)", () => {
  it("DA-A-32: a 50-item purchase evaluates in one transaction; an observation evaluates ONE item", async () => {
    const t = harness();
    const { userId } = await user(t);
    const p = await purchaseWithItems(t, userId, 50);
    const full = await measure(t, async (ctx) => {
      // 50 R01 item runs + 1 R05 transaction run (M20, D208: R05 evaluates through its facts adapter; both active here).
      const all = await evaluatePurchase(ctx, p.purchaseId, "migration", NOW);
      expect(all.filter((e) => e.pack.scenarioId === "R01")).toHaveLength(50);
      expect(all.filter((e) => e.pack.scenarioId === "R05")).toHaveLength(1);
    });
    const one = await measure(t, async (ctx) => {
      const r = await evaluatePurchase(ctx, p.purchaseId, "observation", NOW, { subjects: [`item:${p.itemIds[7]}`] });
      expect(r).toHaveLength(1); // the item subject only: R05's transaction-level run is filtered out (DA-A-32)
    });
    // eslint-disable-next-line no-console
    console.log("[m12-read-budget]", JSON.stringify({ fiftyItems: full, oneSubject: one }));
    expect(full.databaseQueries).toBeLessThan(4_096);
    expect(full.documentsRead).toBeLessThan(32_000);
    // Subject-scoped: the one-item re-evaluation runs a small constant number of index ranges (no per-item claim,
    // price-check or evaluation reads for the other 49 items; items² is gone). Its documents are bounded by the
    // purchase's item rows (≤ MAX_ITEMS_PER_PURCHASE, read by lib/facts/legacyRetail) plus one item's own rows.
    expect(one.databaseQueries).toBeLessThan(40);
    expect(one.documentsRead).toBeLessThan(full.documentsRead / 2);
    expect(one.documentsWritten).toBeLessThanOrEqual(3);
  });

  it("D208: a facts-adapter pack (R05) at the 1,000-live-fact cap — the three triggers' budgets", async () => {
    const t = harness();
    const { userId } = await user(t);
    // A retail order transaction (no legacy purchase) at the live-fact cap: R05 reads it through its adapter.
    const transactionId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("transactions", {
        userId, category: "retail_order", status: "active", counterpartyName: "Summit", currency: "USD", liveFactCount: MAX_LIVE_FACTS_PER_TRANSACTION,
      });
      for (let i = 0; i < MAX_LIVE_FACTS_PER_TRANSACTION; i++) {
        await ctx.db.insert("facts", {
          userId, transactionId: id, subjectKey: i < 10 ? "txn" : `line:${i}`, key: `order.note_${i % 50}`, state: "user_confirmed",
          value: { kind: "text", text: `note ${i}` }, source: { kind: "user" }, recordedAt: NOW - DAY,
        });
      }
      return id;
    });
    const r05 = (es: { pack: { scenarioId: string } }[]) => es.filter((e) => e.pack.scenarioId === "R05").length;
    // Manual re-evaluate / first evaluation (user_request, whole transaction).
    const full = await measure(t, async (ctx) => {
      expect(r05(await evaluateTransaction(ctx, transactionId, "user_request", NOW))).toBe(1);
    });
    // A transaction-level fact write or correction (facts.answer → evaluationScope(["txn"]) = whole transaction).
    const factWrite = await measure(t, async (ctx) => {
      expect(r05(await evaluateTransaction(ctx, transactionId, "fact_change", NOW))).toBe(1);
    });
    // The M29 reevaluateAt sweep evaluates one opportunity's subject ("txn").
    const sweep = await measure(t, async (ctx) => {
      expect(r05(await evaluateTransaction(ctx, transactionId, "fact_change", NOW, { subjects: ["txn"] }))).toBe(1);
    });
    // An item-scoped trigger never re-runs a transaction-level pack (DA-A-32).
    const itemScoped = await measure(t, async (ctx) => {
      expect(r05(await evaluateTransaction(ctx, transactionId, "observation", NOW, { subjects: ["item:x"] }))).toBe(0);
    });
    // eslint-disable-next-line no-console
    console.log("[m20-adapter-budget]", JSON.stringify({ full, factWrite, sweep, itemScoped }));
    for (const m of [full, factWrite, sweep]) {
      // The live rows are read ONCE per evaluation (4 index ranges, ≤ 1,000 rows) and shared by every adapter pack.
      expect(m.documentsRead).toBeLessThan(MAX_LIVE_FACTS_PER_TRANSACTION + 50);
      expect(m.databaseQueries).toBeLessThan(40);
    }
    expect(factWrite.documentsWritten).toBeLessThanOrEqual(2); // an unchanged result appends nothing (DA-A-32)
    // An item-scoped trigger still reads the live rows once (the adapter decides its subjects), but runs and writes nothing.
    expect(itemScoped.documentsWritten).toBe(0);
  });

  it("D220: opportunities.listMine at its cap (201 open R01 opportunities, each with an evaluation) fits one query", async () => {
    const t = harness();
    const { userId, as } = await user(t);
    const p = await purchaseWithItems(t, userId, 1);
    await t.run(async (ctx) => {
      await evaluatePurchase(ctx, p.purchaseId, "migration", NOW);
      const [opp] = await ctx.db.query("opportunities").collect();
      const ev = (await ctx.db.get(opp.currentEvaluationId!))!;
      const { _id: _o, _creationTime: _oc, ...oppFields } = opp;
      const { _id: _e, _creationTime: _ec, ...evFields } = ev;
      for (let i = 0; i < 200; i++) {
        const id = await ctx.db.insert("opportunities", { ...oppFields, dedupeKey: `${opp.dedupeKey}#${i}`, lastEvaluatedAt: NOW - i });
        const evaluationId = await ctx.db.insert("evaluations", { ...evFields, opportunityId: id });
        await ctx.db.patch(id, { currentEvaluationId: evaluationId });
      }
    });
    const m = await measure(as, async (ctx) => {
      const r = await ctx.runQuery(api.opportunities.listMine, {});
      expect([r.items.length, r.truncated]).toEqual([200, true]);
    }).catch((e: unknown) => ({ error: String(e) }));
    // eslint-disable-next-line no-console
    console.log("[m20-listMine-budget]", JSON.stringify(m));
    expect("error" in m).toBe(false);
    const listed = await as.query(api.opportunities.listMine, {});
    expect(listed.items[0].opportunity.lastEvaluatedAt).toBeGreaterThanOrEqual(listed.items[199].opportunity.lastEvaluatedAt);
  });

  it("recovery.summary over 200 claims + 200 open opportunities fits one query and is complete", async () => {
    const t = harness();
    const { userId, as } = await user(t);
    await t.run(async (ctx) => {
      for (let p = 0; p < 100; p++) {
        const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - DAY, currency: "USD", status: "active" });
        const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
        for (let i = 0; i < 2; i++) {
          const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Item", unitCents: 10_000, qty: 1, returned: false });
          const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 1_000, status: "sent", token: `B${p}_${i}`, version: 1 });
          await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 1_000, evidence: "reply" });
          await ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "help@acme.example", subject: "s", body: "b", agentmailMessageId: `m${p}_${i}` });
          // DA-B-13: the refused check reads replies per open claim (an auto-reply, then a question: still asked).
          for (const classification of ["other", "question"] as const) {
            await ctx.db.insert("replies", { claimId, userId, messageId: `r${p}_${i}_${classification}`, from: "help@acme.example", classification, summary: "s", senderMismatch: false, receivedAt: NOW });
          }
          await ctx.db.insert("opportunities", {
            userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${itemId}`,
            dedupeKey: `${transactionId}|R01|price_difference|item:${itemId}|-`, status: "open", ruleId: "R01.retail_price_adjustment",
            ruleVersion: 1, outcome: "likely_eligible", authorityClass: "merchant_promise", remedyType: "price_difference", cashClass: "cash",
            estimate: { amountMinor: 500, currency: "USD" }, lossKeys: [`item:${itemId}:price_diff:2`], lastEvaluatedAt: NOW,
          });
        }
      }
    });
    const m = await measure(as, async (ctx) => {
      await ctx.runQuery(api.recovery.summary, { now: NOW });
    }).catch((e: unknown) => ({ error: String(e) }));
    // eslint-disable-next-line no-console
    console.log("[m12-read-budget]", JSON.stringify({ summary200x200: m }));
    expect("error" in m).toBe(false);
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.complete).toBe(true);
    const usd = s.currencies.find((c) => c.currency === "USD")!;
    expect(usd.tiles.asked.amountMinor).toBe(SUMMARY_MAX_CLAIMS * 1_000);
    expect(usd.tiles.potential.amountMinor).toBe(SUMMARY_MAX_OPEN_OPPORTUNITIES * 500);
  });
});
