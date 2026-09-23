/// <reference types="vite/client" />
/**
 * P01–P12 re-audit, batch A (D244, D254) — money truth and opportunity state, through the production registry
 * (R01 v1 active, D186) and the public mutations:
 *   - P05-OW1: `recovery.summary` reads newest first and skips rows that can never count inside the bounded read, so
 *     old, dead rows never push live money out; `complete: false` only when a row was really left unread;
 *   - P05-OW8 (D244a): dismissing a claim never erases its confirmed money;
 *   - P05-OW2 (D244b, D254): archiving closes the transaction's open opportunities (out of Potential), reversibly;
 *     an opportunity closed by its claim is never reopened by that path; `case_open` keeps its case.
 * Every named test fails on 659de05 (before this change). Expected values are hand-written.
 */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { evaluateTransaction } from "./opportunities";
import { ensurePurchaseTransaction } from "./transactions";

const NOW = Date.UTC(2026, 8, 20, 14);
const DAY = 86_400_000;
type T = ReturnType<typeof setup>;
type Ctx = Parameters<Parameters<T["run"]>[0]>[0];
const R01 = { ruleId: "R01.retail_price_adjustment", ruleVersion: 1 };

async function purchaseWithItem(ctx: Ctx, userId: Id<"users">, n = 0) {
  const purchaseId = await ctx.db.insert("purchases", {
    userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 2 * DAY, currency: "USD", status: "active",
  });
  const itemId = await ctx.db.insert("items", {
    purchaseId, userId, name: `Jacket ${n}`, unitCents: 12_000, qty: 1, productUrl: `https://acme.example/p/${n}`, returned: false,
  });
  return { purchaseId, itemId };
}

let seq = 0;
async function claimRow(ctx: Ctx, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> }, o: { expected: number; status?: Doc<"claims">["status"]; confirmed?: number; isExample?: boolean }) {
  const claimId = await ctx.db.insert("claims", {
    purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: o.expected, status: o.status ?? "detected",
    token: `RA${String(++seq).padStart(5, "0")}`, version: 1, ...(o.isExample ? { isExample: true } : {}),
  });
  if (o.confirmed) await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "confirmed_credit", cents: o.confirmed, evidence: "stmt" });
  return claimId;
}

/** An open R01 opportunity row (the active pack) on its own purchase's transaction. */
async function oppRow(ctx: Ctx, userId: Id<"users">, n: number, o: { outcome: Doc<"opportunities">["outcome"]; estimate?: number; isExample?: boolean }) {
  const w = await purchaseWithItem(ctx, userId, n);
  const transactionId = await ensurePurchaseTransaction(ctx, w.purchaseId);
  return await ctx.db.insert("opportunities", {
    userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${w.itemId}`,
    dedupeKey: `${transactionId}|R01|price_difference|item:${w.itemId}|-`, status: "open", ...R01, outcome: o.outcome,
    authorityClass: "merchant_promise", remedyType: "price_difference", cashClass: "cash",
    ...(o.estimate !== undefined ? { estimate: { amountMinor: o.estimate, currency: "USD" } } : {}),
    lossKeys: [`item:${w.itemId}:price_diff:1`], lastEvaluatedAt: NOW, ...(o.isExample ? { isExample: true } : {}),
  });
}

const usdOf = async (as: Awaited<ReturnType<typeof signedIn>>["as"]) => {
  const s = await as.query(api.recovery.summary, { now: NOW });
  return { s, usd: s.currencies.find((c) => c.currency === "USD") };
};

describe("P05-OW1: newest first, dead rows skipped inside the bounded read, honest `complete`", () => {
  pinClockEach(NOW);

  it("(a) 200 older money-less dismissed claims + 1 newer detected 1,000 → Ready 1,000, complete (nothing live unread)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId);
      for (let i = 0; i < 200; i++) await claimRow(ctx, userId, w, { expected: 500, status: "dismissed" });
      const w2 = await purchaseWithItem(ctx, userId, 1);
      await claimRow(ctx, userId, w2, { expected: 1_000 });
    });
    const { s, usd } = await usdOf(as);
    expect(usd?.tiles.ready.amountMinor).toBe(1_000);
    expect(s.complete).toBe(true);
  });

  it("(a') 450 older dismissed claims (past the 400-row scan) + 1 newer detected 1,000 → the newest is still counted; complete: false", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId);
      for (let i = 0; i < 450; i++) await claimRow(ctx, userId, w, { expected: 500, status: "dismissed" });
      const w2 = await purchaseWithItem(ctx, userId, 1);
      await claimRow(ctx, userId, w2, { expected: 1_000 });
    });
    const { s, usd } = await usdOf(as);
    expect(usd?.tiles.ready.amountMinor).toBe(1_000);
    expect(s.complete).toBe(false);
  });

  it("(b) 200 older open deadline_passed opportunities + a newer eligible 1,500 + a newer needs_facts → Potential 1,500, needsAnswers 1", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) await oppRow(ctx, userId, i, { outcome: "deadline_passed", estimate: 700 });
      await oppRow(ctx, userId, 1000, { outcome: "eligible", estimate: 1_500 });
      await oppRow(ctx, userId, 1001, { outcome: "needs_facts" });
    });
    const { s, usd } = await usdOf(as);
    expect(usd?.tiles.potential.amountMinor).toBe(1_500);
    expect(s.counts.needsAnswers).toBe(1);
    expect(s.complete).toBe(false); // 202 counted rows, the 200-row cap: two old ones unread
  });

  it("(c) the newest of 201 detected claims is counted (the OLDEST is the one left out)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        const w = await purchaseWithItem(ctx, userId, i);
        await claimRow(ctx, userId, w, { expected: i === 0 ? 7 : i === 200 ? 777 : 100 });
      }
    });
    const { s, usd } = await usdOf(as);
    expect(usd?.tiles.ready.amountMinor).toBe(199 * 100 + 777);
    expect(s.complete).toBe(false);
  });

  it("250 newer EXAMPLE claims never push an older live claim out (skipped inside the read); complete", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId);
      await claimRow(ctx, userId, w, { expected: 1_234 });
      for (let i = 0; i < 250; i++) await claimRow(ctx, userId, w, { expected: 999, isExample: true });
    });
    const { s, usd } = await usdOf(as);
    expect(usd?.tiles.ready.amountMinor).toBe(1_234);
    expect(s.complete).toBe(true);
  });

  it("a legacy keyless price claim's loss-key ordinal does not depend on the read order (an older confirmed sibling still counts)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId);
      await claimRow(ctx, userId, w, { expected: 2_000, status: "confirmed", confirmed: 2_000 }); // price_diff:1
      await claimRow(ctx, userId, w, { expected: 1_000 }); // price_diff:2 — a distinct loss, not the same one
    });
    const { usd } = await usdOf(as);
    expect([usd?.recoveredMinor, usd?.tiles.ready.amountMinor]).toEqual([2_000, 1_000]);
  });
});

describe("P05-OW8 (D244a): dismissing a claim never erases confirmed money", () => {
  pinClockEach(NOW);

  it("a 1,000 claim with 500 confirmed, then claims.dismiss → Recovered still 500; nothing left to ask", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await t.run(async (ctx) => claimRow(ctx, userId, await purchaseWithItem(ctx, userId), { expected: 1_000, status: "sent", confirmed: 500 }));
    let { usd } = await usdOf(as);
    expect([usd?.recoveredMinor, usd?.tiles.asked.amountMinor]).toEqual([500, 500]);
    await as.mutation(api.claims.dismiss, { claimId });
    ({ usd } = await usdOf(as));
    expect(usd?.recoveredMinor).toBe(500);
    for (const tile of ["potential", "ready", "sendingOrUnknown", "asked", "refused", "promised"] as const) expect(usd?.tiles[tile].amountMinor, tile).toBe(0);
  });

  it("a later debit on the dismissed claim still reduces it (net), and a money-less dismissed claim still counts for nothing", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId);
      const c = await claimRow(ctx, userId, w, { expected: 1_000, status: "dismissed", confirmed: 800 });
      await ctx.db.insert("ledgerEvents", { claimId: c, userId, kind: "later_debit", cents: 300, evidence: "clawback" });
      await claimRow(ctx, userId, await purchaseWithItem(ctx, userId, 1), { expected: 900, status: "dismissed" });
    });
    const { usd } = await usdOf(as);
    expect(usd?.recoveredMinor).toBe(500);
  });

  it("claims.dismiss still refuses a confirmed claim (D48)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await t.run(async (ctx) => claimRow(ctx, userId, await purchaseWithItem(ctx, userId), { expected: 1_000, status: "confirmed", confirmed: 1_000 }));
    await expect(as.mutation(api.claims.dismiss, { claimId })).rejects.toThrow(/confirmed claim cannot be dismissed/);
  });
});

describe("P05-OW2 (D244b, D254): archiving closes open opportunities, reversibly", () => {
  pinClockEach(NOW);

  /** A live R01 path through the real pipeline: a 9,500 check on 12,000 opens a 2,500 claim; dismissing it reopens the opportunity. */
  async function openR01(t: T, as: Awaited<ReturnType<typeof signedIn>>["as"], userId: Id<"users">, n: number) {
    const w = await t.run(async (ctx) => {
      const w = await purchaseWithItem(ctx, userId, n);
      await ctx.db.insert("policies", {
        userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", contactEmail: "help@acme.example",
        passage: "We adjust within 14 days.", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 2 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      });
      return w;
    });
    const r = await t.mutation(internal.priceWatch.recordCheck, {
      itemId: w.itemId, sourceUrl: `https://acme.example/p/${n}`, observedCents: 9_500, currency: "USD", confidence: 0.92, isRange: false, variantMatch: "exact",
    });
    return { ...w, claimId: r.claimId! };
  }
  const oppsOf = (t: T, purchaseId: Id<"purchases">) =>
    t.run(async (ctx) => {
      const txn = (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).first())!;
      return { txn, opps: await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", txn._id)).collect() };
    });

  it("purchases.remove closes the open opportunity (marked) → Potential drops; unarchived + re-evaluated → reopened, marker cleared", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await openR01(t, as, userId, 1);
    await as.mutation(api.claims.dismiss, { claimId: w.claimId });
    expect((await usdOf(as)).usd?.tiles.potential.amountMinor).toBe(2_500);

    await as.mutation(api.purchases.remove, { purchaseId: w.purchaseId });
    let { txn, opps } = await oppsOf(t, w.purchaseId);
    expect(txn.status).toBe("archived");
    expect(opps.map((o) => [o.status, o.closedByArchiveAt])).toEqual([["closed", NOW]]);
    expect((await usdOf(as)).usd?.tiles.potential.amountMinor ?? 0).toBe(0);

    // Unarchive (no public path yet, D47): the purchase is live again and its transaction re-syncs and re-evaluates.
    await t.run(async (ctx) => {
      await ctx.db.patch(w.purchaseId, { status: "active" });
      const id = await ensurePurchaseTransaction(ctx, w.purchaseId);
      await evaluateTransaction(ctx, id, "fact_change", NOW);
    });
    ({ opps } = await oppsOf(t, w.purchaseId));
    expect(opps.map((o) => [o.status, o.closedByArchiveAt])).toEqual([["open", undefined]]);
    expect((await usdOf(as)).usd?.tiles.potential.amountMinor).toBe(2_500);
  });

  it("an opportunity with a case keeps it (case_open); the claim and its money are untouched", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await openR01(t, as, userId, 2);
    await as.mutation(api.purchases.remove, { purchaseId: w.purchaseId });
    const { opps } = await oppsOf(t, w.purchaseId);
    expect(opps.map((o) => [o.status, o.activeClaimId, o.closedByArchiveAt])).toEqual([["case_open", w.claimId, undefined]]);
    expect((await t.run((ctx) => ctx.db.get(w.claimId)))!.status).toBe("detected");
  });

  it("an opportunity closed by its CLAIM (confirmed, no marker) is never reopened by archive + unarchive", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await openR01(t, as, userId, 3);
    await as.mutation(api.claims.confirmCredit, { claimId: w.claimId, cents: 2_500, evidence: "statement", idempotencyKey: "paid" });
    expect((await oppsOf(t, w.purchaseId)).opps.map((o) => o.status)).toEqual(["closed"]);
    await as.mutation(api.purchases.remove, { purchaseId: w.purchaseId });
    await t.run(async (ctx) => {
      await ctx.db.patch(w.purchaseId, { status: "active" });
      await evaluateTransaction(ctx, await ensurePurchaseTransaction(ctx, w.purchaseId), "fact_change", NOW);
    });
    const { opps } = await oppsOf(t, w.purchaseId);
    expect(opps.map((o) => [o.status, o.closedByArchiveAt])).toEqual([["closed", undefined]]);
    expect((await usdOf(as)).usd?.recoveredMinor).toBe(2_500);
  });

  it("a transaction archived BEFORE this fix is closed lazily by its next evaluation", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await openR01(t, as, userId, 4);
    await as.mutation(api.claims.dismiss, { claimId: w.claimId });
    // The old archive path: the purchase and its transaction archived, the opportunity left open.
    await t.run(async (ctx) => {
      await ctx.db.patch(w.purchaseId, { status: "archived" });
      const id = await ensurePurchaseTransaction(ctx, w.purchaseId);
      expect((await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", id)).collect()).map((o) => o.status)).toEqual(["open"]);
      await evaluateTransaction(ctx, id, "fact_change", NOW);
    });
    expect((await oppsOf(t, w.purchaseId)).opps.map((o) => [o.status, o.closedByArchiveAt])).toEqual([["closed", NOW]]);
  });
});

// ---------------------------------------------------------------------------
// D201 read budget re-measured at the new caps (enforced limits): the newest-first streams scan up to 400 rows each.
// ---------------------------------------------------------------------------

const modules = import.meta.glob("./**/*.*s");
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });
function limitedHarness() {
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

describe("recovery.summary read budget at the scan caps (P05-OW1 re-measure of D201)", () => {
  pinClockEach(NOW);

  it(
    "400 claims scanned (200 money-less dismissed with a debit row + 200 live with drafts/replies/events, half on a manual channel) + 400 open opportunities scanned (200 examples) → bounded",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy summary" }));
      const as = t.withIdentity({ subject: `${userId}|session` });
      for (let p = 0; p < 20; p++) {
        await t.run(async (ctx) => {
          for (let i = 0; i < 10; i++) {
            const w = await purchaseWithItem(ctx, userId, p * 10 + i);
            const live = await claimRow(ctx, userId, w, { expected: 1_000, status: "sent" });
            // Half on a manual channel: their packets and submissions are read too (DA-A-9), the costlier projection.
            if (i % 2 === 0) {
              await ctx.db.patch(live, { requiredChannel: "postal_mail" });
              await ctx.db.insert("submissions", {
                userId, claimId: live, packetId: (await ctx.db.insert("packets", {
                  userId, claimId: live, version: 1, channel: "postal_mail", recipient: { text: "PO Box 1", source: "user_entered" }, body: "b", requestedRemedy: "r",
                  evidenceIndex: [], binding: { contextHash: "c", claimVersion: 1, amount: { amountMinor: 1_000, currency: "USD" }, attachments: [] },
                  status: "submission_recorded",
                })), approvedHash: "h", channel: "postal_mail", submittedAt: NOW,
              });
            }
            await ctx.db.insert("ledgerEvents", { claimId: live, userId, kind: "promised_credit", cents: 500, evidence: "e" });
            await ctx.db.insert("drafts", { claimId: live, userId, version: 1, claimVersion: 1, to: "help@acme.example", subject: "s", body: "b", agentmailMessageId: `m${p}-${i}` });
            await ctx.db.insert("replies", { claimId: live, userId, messageId: `r${p}-${i}`, from: "help@acme.example", classification: "other", summary: "s", senderMismatch: false, receivedAt: NOW });
            const dead = await claimRow(ctx, userId, w, { expected: 700, status: "dismissed" });
            await ctx.db.insert("ledgerEvents", { claimId: dead, userId, kind: "later_debit", cents: 1, evidence: "e" });
          }
        });
      }
      for (let p = 0; p < 20; p++) {
        await t.run(async (ctx) => {
          for (let i = 0; i < 10; i++) {
            await oppRow(ctx, userId, 10_000 + p * 10 + i, { outcome: "eligible", estimate: 300 });
            await oppRow(ctx, userId, 20_000 + p * 10 + i, { outcome: "eligible", estimate: 300, isExample: true });
          }
        });
      }
      const { result, errorMessage, metrics } = await as.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof api.recovery.summary>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(api.recovery.summary, { now: NOW });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const m = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics: { databaseQueries: m.databaseQueries.used, documentsRead: m.documentsRead.used, bytesRead: m.bytesRead.used } };
      });
      // eslint-disable-next-line no-console
      console.log("[read-budget] recovery.summary at the P05-OW1 scan caps", JSON.stringify({ ...metrics, errorMessage }));
      expect(errorMessage).toBeNull();
      expect(result!.complete).toBe(true); // every live row was read
      const usd = result!.currencies.find((c) => c.currency === "USD")!;
      expect(usd.tiles.asked.amountMinor).toBe(200 * 1_000);
      expect(usd.tiles.potential.amountMinor).toBe(200 * 300);
      expect(metrics.databaseQueries).toBeLessThan(4_096);
      expect(metrics.documentsRead).toBeLessThan(32_000);
      expect(metrics.bytesRead).toBeLessThan(16 * 1024 * 1024);
    },
    150_000,
  );
});
