/// <reference types="vite/client" />
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { setup, signedIn } from "../test.setup";
import { requireUserId } from "./access";

describe("requireUserId", () => {
  it("resolves the signed-in user's id", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    expect(await as.run(async (ctx) => await requireUserId(ctx))).toBe(userId);
  });

  it("throws when nobody is signed in", async () => {
    const t = setup();
    await expect(t.run(async (ctx) => await requireUserId(ctx))).rejects.toThrow(ConvexError);
  });

  it("refuses a tombstoned (deleting/deleted) account (D77 single choke point)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
    await expect(as.run(async (ctx) => await requireUserId(ctx))).rejects.toThrow(ConvexError);
  });
});

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §11.1, mission §6 Ownership): owned* helpers for the
// wave-1 tables + assertSameTransaction (DA-A-29). Each helper is proven with
// two users: the owner's row resolves; a FOREIGN id and a MISSING (deleted) id
// throw the IDENTICAL message (no existence disclosure); and it costs exactly
// one document read and no index query.
// ---------------------------------------------------------------------------
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  assertSameTransaction,
  ownedEvaluation,
  ownedEvidence,
  ownedFact,
  ownedIncident,
  ownedNonCashRemedy,
  ownedOpportunity,
  ownedTransaction,
} from "./access";

type Seeded = {
  transactionId: Id<"transactions">;
  otherTransactionId: Id<"transactions">;
  evidenceId: Id<"evidence">;
  unlinkedEvidenceId: Id<"evidence">;
  factId: Id<"facts">;
  incidentId: Id<"incidents">;
  opportunityId: Id<"opportunities">;
  evaluationId: Id<"evaluations">;
  nonCashId: Id<"nonCashRemedies">;
};

/** One owned row in every wave-1 table (plus a second transaction and an unlinked evidence row). */
async function seedOwned(ctx: MutationCtx, userId: Id<"users">): Promise<Seeded> {
  const txn = (name: string) =>
    ctx.db.insert("transactions", {
      userId, category: "retail_order", status: "active", counterpartyName: name, currency: "USD", liveFactCount: 0,
    });
  const transactionId = await txn("Acme");
  const otherTransactionId = await txn("Globex");
  const ev = (transactionId?: Id<"transactions">) =>
    ctx.db.insert("evidence", {
      userId, transactionId, kind: "paste", docType: "receipt", sourceChannel: "paste", provenance: "user_pasted",
      contentHash: "b".repeat(64), receivedAt: 1, extractionStatus: "not_requested", extractionAttempts: 0, retention: "active",
    });
  const evidenceId = await ev(transactionId);
  const unlinkedEvidenceId = await ev(undefined);
  const factId = await ctx.db.insert("facts", {
    userId, transactionId, subjectKey: "txn", key: "retail.total", state: "user_confirmed",
    value: { kind: "money", amountMinor: 100, currency: "USD" }, source: { kind: "user" }, recordedAt: 1,
  });
  const incidentId = await ctx.db.insert("incidents", {
    userId, transactionId, kind: "item_damaged", status: "confirmed", reportedBy: "user",
  });
  const purchaseId = await ctx.db.insert("purchases", {
    userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active",
  });
  const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "W", unitCents: 100, qty: 1, returned: false });
  const claimId = await ctx.db.insert("claims", {
    purchaseId, itemId, userId, type: "return_credit", expectedCents: 100, status: "detected", token: "CCCCCC", version: 1,
  });
  const opportunityId = await ctx.db.insert("opportunities", {
    userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: "txn", dedupeKey: `${transactionId}|R01|p|txn|-`,
    status: "open", ruleId: "r01", ruleVersion: 1, outcome: "needs_facts", authorityClass: "merchant_promise",
    remedyType: "price_difference", cashClass: "cash", lossKeys: [], lastEvaluatedAt: 1,
  });
  const evaluationId = await ctx.db.insert("evaluations", {
    userId, opportunityId, scenarioId: "R01", ruleId: "r01", ruleVersion: 1, factSnapshotHash: "s", resultHash: "r",
    evaluatedAt: 1, trigger: "user_request", outcome: "needs_facts",
    dimensions: { applies: "unknown", factsKnown: "unknown", evidenceSupports: "unknown", windowOpen: "unknown", amountCalculable: "unknown", readyForApproval: "fail" },
    conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null, deadlines: [], sourceRefs: [],
    overlap: [], nextAction: { kind: "none", reason: "test" }, explanation: [],
  });
  const nonCashId = await ctx.db.insert("nonCashRemedies", {
    userId, claimId, kind: "voucher", description: "v", state: "promised", idempotencyKey: "k", recordedAt: 1,
  });
  return { transactionId, otherTransactionId, evidenceId, unlinkedEvidenceId, factId, incidentId, opportunityId, evaluationId, nonCashId };
}

/** Wraps `ctx.db` so a test can count document reads and index queries made through it. */
function counting(ctx: MutationCtx) {
  const counts = { get: 0, query: 0 };
  const db = new Proxy(ctx.db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === "get" || prop === "query") {
        return (...args: unknown[]) => {
          counts[prop] += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ctx: { ...ctx, db } as MutationCtx, counts };
}

type Case = {
  name: string;
  table: "transactions" | "evidence" | "facts" | "incidents" | "opportunities" | "evaluations" | "nonCashRemedies";
  id: (s: Seeded) => Id<Case["table"]>;
  call: (ctx: MutationCtx, id: never, userId: Id<"users">) => Promise<{ _id: string; userId: Id<"users"> }>;
  message: string;
};
const CASES: Case[] = [
  { name: "ownedTransaction", table: "transactions", id: (s) => s.transactionId, call: ownedTransaction, message: "Transaction not found" },
  { name: "ownedEvidence", table: "evidence", id: (s) => s.evidenceId, call: ownedEvidence, message: "Evidence not found" },
  { name: "ownedFact", table: "facts", id: (s) => s.factId, call: ownedFact, message: "Fact not found" },
  { name: "ownedIncident", table: "incidents", id: (s) => s.incidentId, call: ownedIncident, message: "Incident not found" },
  { name: "ownedOpportunity", table: "opportunities", id: (s) => s.opportunityId, call: ownedOpportunity, message: "Opportunity not found" },
  { name: "ownedEvaluation", table: "evaluations", id: (s) => s.evaluationId, call: ownedEvaluation, message: "Evaluation not found" },
  { name: "ownedNonCashRemedy", table: "nonCashRemedies", id: (s) => s.nonCashId, call: ownedNonCashRemedy, message: "Remedy not found" },
];

describe("owned* helpers for the wave-1 tables (two users)", () => {
  for (const c of CASES) {
    it(`${c.name}: owner resolves in one read; foreign and missing ids get the identical not-found`, async () => {
      const t = setup();
      const { userId: alice } = await signedIn(t, "Alice");
      const { userId: bob } = await signedIn(t, "Bob");
      await t.run(async (raw) => {
        const s = await seedOwned(raw, alice);
        const id = c.id(s) as never;

        const { ctx, counts } = counting(raw);
        const row = await c.call(ctx, id, alice);
        expect(row._id).toBe(id);
        expect(row.userId).toBe(alice);
        expect(counts).toEqual({ get: 1, query: 0 });

        const foreign = await c.call(raw, id, bob).then(
          () => null,
          (e: unknown) => e,
        );
        await raw.db.delete(id);
        const missing = await c.call(raw, id, alice).then(
          () => null,
          (e: unknown) => e,
        );
        expect(foreign).toBeInstanceOf(ConvexError);
        expect(missing).toBeInstanceOf(ConvexError);
        expect((foreign as ConvexError<string>).data).toBe(c.message);
        expect((missing as ConvexError<string>).data).toBe((foreign as ConvexError<string>).data);
      });
    });
  }
});

describe("assertSameTransaction (DA-A-29)", () => {
  it("a row on the same transaction passes; another transaction's row is refused; unlinked only when allowed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      const s = await seedOwned(ctx, userId);
      const linked = (await ctx.db.get(s.evidenceId)) as Doc<"evidence">;
      const unlinked = (await ctx.db.get(s.unlinkedEvidenceId)) as Doc<"evidence">;
      const fact = (await ctx.db.get(s.factId)) as Doc<"facts">;

      expect(assertSameTransaction(s.transactionId, linked)).toBe("same");
      expect(assertSameTransaction(s.transactionId, fact)).toBe("same");
      expect(() => assertSameTransaction(s.otherTransactionId, linked, { label: "Evidence" })).toThrow(
        /Evidence belongs to a different transaction/,
      );
      expect(() => assertSameTransaction(s.otherTransactionId, fact)).toThrow(ConvexError);
      // Unlinked evidence may be cited (and linked on cite) only where the caller allows it.
      expect(assertSameTransaction(s.transactionId, unlinked, { allowUnlinked: true })).toBe("unlinked");
      expect(() => assertSameTransaction(s.transactionId, unlinked)).toThrow(ConvexError);
    });
  });
});
