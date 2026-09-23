/// <reference types="vite/client" />
/**
 * M10 commit 1: the wave-1 schema block (contract rev 4 §2.4). Proves the new
 * tables exist with HC-19 index names, the shared validators accept and refuse
 * the right shapes, and the existing tables only WIDENED (a legacy row with none
 * of the new fields still validates).
 */
import { describe, expect, it } from "vitest";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import schema, {
  approvalBinding,
  boundFactValue,
  cellStatus,
  evaluationOutcome,
  factValue,
  missingFact,
  money,
  nextAction,
  reevaluate,
  requiredChannel,
  scenarioId,
} from "./schema";

type TableName = keyof typeof schema.tables;

function indexesOf(table: TableName): { indexDescriptor: string; fields: string[] }[] {
  const def = schema.tables[table] as unknown as { " indexes"(): { indexDescriptor: string; fields: string[] }[] };
  return def[" indexes"]();
}

/** HC-19: `by_<f1>_and_<f2>…`, each field's trailing `Id` dropped, camelCase → snake_case, every field listed. */
function hc19Name(fields: string[]): string {
  return (
    "by_" +
    fields
      .map((f) => f.replace(/Id$/, "").replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
      .join("_and_")
  );
}

const NEW_TABLES: Record<string, string[]> = {
  transactions: ["by_user_and_status", "by_user_and_natural_key", "by_purchase"],
  facts: ["by_transaction_and_subject_key_and_key", "by_transaction_and_state_and_subject_key_and_key", "by_user"],
  incidents: ["by_transaction", "by_user"],
  evidence: [
    "by_user_and_content_hash",
    "by_transaction",
    "by_storage",
    "by_extraction_status_and_extraction_started_at",
    "by_retention_and_received_at",
    "by_user_and_kind_and_received_at",
  ],
  opportunities: [
    "by_user_and_dedupe_key",
    "by_transaction",
    "by_user_and_status",
    "by_status_and_next_deadline_at",
    "by_scenario_and_rule_version",
  ],
  evaluations: ["by_opportunity", "by_user"],
  nonCashRemedies: ["by_claim_and_idempotency_key", "by_user"],
};

describe("wave-1 schema block (contract §2.4)", () => {
  it("every new table exists with exactly the contract's indexes, each named per HC-19", () => {
    for (const [table, expected] of Object.entries(NEW_TABLES)) {
      expect(Object.keys(schema.tables), table).toContain(table);
      const idx = indexesOf(table as TableName);
      expect(idx.map((i) => i.indexDescriptor).sort(), table).toEqual([...expected].sort());
      for (const i of idx) expect(i.indexDescriptor, `${table}.${i.indexDescriptor}`).toBe(hc19Name(i.fields));
    }
  });

  it("claims gains exactly two HC-19 indexes; existing index names are untouched", () => {
    const names = indexesOf("claims").map((i) => i.indexDescriptor);
    for (const kept of ["by_user", "by_item", "by_token", "by_thread", "by_item_type_status", "by_purchase_type"]) {
      expect(names).toContain(kept);
    }
    const added = indexesOf("claims").filter((i) => ["by_opportunity", "by_transaction_and_status"].includes(i.indexDescriptor));
    expect(added.map((i) => i.fields)).toEqual([["opportunityId"], ["transactionId", "status"]]);
    for (const i of added) expect(i.indexDescriptor).toBe(hc19Name(i.fields));
  });

  it("exports the shared validators with their closed literal sets", () => {
    expect(scenarioId.members).toHaveLength(25);
    expect(scenarioId.members.map((m) => m.value)).toEqual(Array.from({ length: 25 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`));
    expect(evaluationOutcome.members.map((m) => m.value)).toContain("likely_eligible");
    // DA-A-9: the formal channel is one flat union of email + every manual channel.
    expect(requiredChannel.members.map((m) => m.value).sort()).toEqual(
      ["chat", "email", "in_person", "phone", "portal", "postal_mail", "web_form"].sort(),
    );
    expect(money.kind).toBe("object");
    expect(approvalBinding.fields.contextHash.kind).toBe("string");
    expect(factValue.members.map((m) => m.fields.kind.value)).toContain("user_unknown");
    // rev 5 (N6): the resolved cell status and the stored bound-fact value.
    expect(cellStatus.members.map((m) => m.value).sort()).toEqual(
      ["candidate", "confirmed", "conflicting", "derived", "missing", "observed", "user_unknown"],
    );
    expect(Object.keys(boundFactValue.fields).sort()).toEqual(["key", "status", "subjectKey", "value"]);
    expect(boundFactValue.fields.value.isOptional).toBe("optional");
  });

  it("rev 5.2 (M06d, D147(6)): not_yet_due outcome, the reevaluate validator and the wait next action", async () => {
    expect(evaluationOutcome.members.map((m) => m.value)).toContain("not_yet_due");
    expect(Object.keys(reevaluate.fields).sort()).toEqual(["at", "when"]);
    expect(reevaluate.fields.at.isOptional).toBe("optional");
    expect(reevaluate.fields.when.isOptional).toBe("optional");
    expect(nextAction.members.map((m) => m.fields.kind.value)).toContain("wait");
    // M06g (D161): a decisive fact whose candidates conflict caps the outcome instead of blocking it.
    expect(missingFact.fields.reason.members.map((m) => m.value).sort()).toEqual(
      ["candidate_unconfirmed", "conflict_capped", "conflicting", "missing", "user_unknown"],
    );

    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      const transactionId = await ctx.db.insert("transactions", {
        userId, category: "retail_order", status: "active", counterpartyName: "Acme", currency: "USD", liveFactCount: 0,
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        userId, transactionId, scenarioId: "R05", remedyKey: "cash_refund", subjectKey: "txn", dedupeKey: `${transactionId}|R05|cash_refund|txn|-`,
        status: "open", ruleId: "r05", ruleVersion: 1, outcome: "not_yet_due", authorityClass: "legal_entitlement",
        remedyType: "cash_refund", cashClass: "cash", lossKeys: [`txn:${transactionId}:paid`], lastEvaluatedAt: 1,
      });
      const evaluationId = await ctx.db.insert("evaluations", {
        userId, opportunityId, scenarioId: "R05", ruleId: "r05", ruleVersion: 1, factSnapshotHash: "s", resultHash: "r",
        evaluatedAt: 1, trigger: "fact_change", outcome: "not_yet_due",
        dimensions: { applies: "pass", factsKnown: "pass", evidenceSupports: "pass", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "fail" },
        conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null, deadlines: [], sourceRefs: [],
        overlap: [], nextAction: { kind: "wait", reevaluate: { at: "2026-10-11" } }, explanation: ["ship-by date not reached"],
        reevaluate: { at: "2026-10-11" },
      });
      const row = await ctx.db.get(evaluationId);
      expect(row?.reevaluate).toEqual({ at: "2026-10-11" });
      expect(row?.nextAction).toEqual({ kind: "wait", reevaluate: { at: "2026-10-11" } });
    });
  });

  it("round-trips one row per new table, all owned by one user and linked by id", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const ids = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: "Widget", unitCents: 12_000, qty: 2, returned: false,
      });
      const transactionId = await ctx.db.insert("transactions", {
        userId, category: "retail_order", status: "active", counterpartyName: "Acme",
        counterpartyDomain: "acme.example", currency: "USD", totalMinor: 24_000, purchaseId, liveFactCount: 0,
      });
      const evidenceId = await ctx.db.insert("evidence", {
        userId, transactionId, kind: "paste", docType: "order_confirmation", sourceChannel: "paste",
        provenance: "user_pasted", contentHash: "a".repeat(64), receivedAt: 1, extractionStatus: "not_requested",
        extractionAttempts: 0, retention: "active", text: "Order total USD 240.00",
      });
      const factId = await ctx.db.insert("facts", {
        userId, transactionId, subjectKey: `item:${itemId}`, key: "retail.unit_price", state: "user_confirmed",
        value: { kind: "money", amountMinor: 12_000, currency: "USD" }, source: { kind: "user" }, recordedAt: 1,
      });
      await ctx.db.insert("facts", {
        userId, transactionId, subjectKey: "txn", key: "retail.total", state: "extracted_candidate",
        value: { kind: "money", amountMinor: 24_000, currency: "USD" },
        source: {
          kind: "evidence", evidenceId, locator: { kind: "text_span", start: 0, end: 22, quote: "Order total USD 240.00" },
          quoteStatus: "unverified", extractorVersion: "x1",
        },
        recordedAt: 2,
      });
      const incidentId = await ctx.db.insert("incidents", {
        userId, transactionId, kind: "item_damaged", status: "candidate", reportedBy: "user",
      });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 5_000, status: "detected",
        token: "AAAAAA", version: 1, transactionId, scenarioId: "R01", remedyKey: "price_difference",
        currency: "USD", lossKeys: [`item:${itemId}:price_diff:1`], requiredChannel: "email",
      });
      const opportunityId = await ctx.db.insert("opportunities", {
        userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${itemId}`,
        dedupeKey: `${transactionId}|R01|price_difference|item:${itemId}|-`, status: "case_open",
        ruleId: "r01_price_adjustment", ruleVersion: 1, outcome: "likely_eligible", authorityClass: "merchant_promise",
        remedyType: "price_difference", cashClass: "cash", estimate: { amountMinor: 5_000, currency: "USD" },
        lossKeys: [`item:${itemId}:price_diff:1`], activeClaimId: claimId, lastEvaluatedAt: 3,
      });
      const evaluationId = await ctx.db.insert("evaluations", {
        userId, opportunityId, scenarioId: "R01", ruleId: "r01_price_adjustment", ruleVersion: 1,
        factSnapshotHash: "f".repeat(64), resultHash: "r".repeat(64), evaluatedAt: 3, trigger: "observation",
        outcome: "likely_eligible",
        dimensions: { applies: "pass", factsKnown: "pass", evidenceSupports: "unknown", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "pass" },
        conditions: [{ id: "c1", label: "drop", result: "pass", kind: "requirement", facts: [{ subjectKey: `item:${itemId}`, key: "retail.unit_price" }] }],
        missingFacts: [{ subjectKey: "txn", key: "retail.currency", reason: "candidate_unconfirmed", class: "assumption", neededFor: ["c1"] }],
        assumptions: [{ id: "A-T2", text: "policy may have changed", changesOutcomeIf: "policy differed" }],
        disqualifierIds: [],
        amount: {
          estimate: { amountMinor: 5_000, currency: "USD" }, basis: "exact_formula", formula: "(12,000 − 9,500) × 2",
          inputs: [{ label: "unit", value: "12,000", fact: { subjectKey: `item:${itemId}`, key: "retail.unit_price" } }],
        },
        deadlines: [{ id: "window", label: "Price window", obligor: "user", status: "open", mustBe: "n_a", basis: "14 days" }],
        sourceRefs: [{ sourceId: "policy", passageId: "p1", url: "https://acme.example/policy", effective: "unknown" }],
        overlap: [], nextAction: { kind: "continue_case", claimId }, explanation: ["drop of 2,500 per unit"],
        boundFacts: [
          { subjectKey: `item:${itemId}`, key: "retail.unit_price", status: "confirmed", value: { kind: "money", amountMinor: 12_000, currency: "USD" } },
          { subjectKey: "txn", key: "retail.currency", status: "missing" },
        ],
      });
      await ctx.db.patch(opportunityId, { currentEvaluationId: evaluationId });
      await ctx.db.patch(claimId, { opportunityId });
      const nonCashId = await ctx.db.insert("nonCashRemedies", {
        userId, claimId, kind: "voucher", description: "Store voucher", faceValue: { amountMinor: 1_000, currency: "USD" },
        state: "promised", idempotencyKey: "nc1", recordedAt: 4,
      });
      await ctx.db.insert("ledgerEvents", {
        claimId, userId, kind: "confirmed_credit", cents: 1_000, evidence: "stmt", idempotencyKey: "k1", currency: "USD",
      });
      await ctx.db.insert("drafts", {
        claimId, userId, version: 1, claimVersion: 1, to: "support@acme.example", subject: "s", body: "b",
        approvedHash: "h".repeat(64),
        binding: {
          contextHash: "c".repeat(64), claimVersion: 1, amount: { amountMinor: 5_000, currency: "USD" },
          opportunityId, evaluationId, ruleId: "r01_price_adjustment", ruleVersion: 1, attachments: [{ evidenceId, contentHash: "a".repeat(64) }],
        },
      });
      return { transactionId, evidenceId, factId, incidentId, claimId, opportunityId, evaluationId, nonCashId };
    });

    await t.run(async (ctx) => {
      const byPurchase = await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", undefined)).take(5);
      expect(byPurchase).toHaveLength(0);
      const cell = await ctx.db
        .query("facts")
        .withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", ids.transactionId).eq("subjectKey", "txn"))
        .take(5);
      expect(cell).toHaveLength(1);
      const linked = await ctx.db.query("claims").withIndex("by_opportunity", (q) => q.eq("opportunityId", ids.opportunityId)).take(2);
      expect(linked.map((c) => c._id)).toEqual([ids.claimId]);
      const active = await ctx.db
        .query("claims")
        .withIndex("by_transaction_and_status", (q) => q.eq("transactionId", ids.transactionId).eq("status", "detected"))
        .take(2);
      expect(active).toHaveLength(1);
      const nc = await ctx.db
        .query("nonCashRemedies")
        .withIndex("by_claim_and_idempotency_key", (q) => q.eq("claimId", ids.claimId).eq("idempotencyKey", "nc1"))
        .unique();
      expect(nc?._id).toBe(ids.nonCashId);
    });
  });

  it("refuses shapes outside the closed validators", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const txnId = await t.run((ctx) =>
      ctx.db.insert("transactions", {
        userId, category: "air_travel", status: "needs_review", counterpartyName: "Air", currency: "USD", liveFactCount: 0,
      }),
    );
    // An unknown category, an unknown fact-value kind and an unknown evidence doc type are all refused.
    await expect(
      t.run((ctx) =>
        ctx.db.insert("transactions", {
          userId, category: "crypto" as never, status: "active", counterpartyName: "X", currency: "USD", liveFactCount: 0,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      t.run((ctx) =>
        ctx.db.insert("facts", {
          userId, transactionId: txnId, subjectKey: "txn", key: "air.total_paid", state: "user_confirmed",
          value: { kind: "float", value: 1.5 } as never, source: { kind: "user" }, recordedAt: 1,
        }),
      ),
    ).rejects.toThrow();
    await expect(
      t.run((ctx) =>
        ctx.db.insert("evidence", {
          userId, kind: "upload", docType: "passport" as never, sourceChannel: "upload", provenance: "user_uploaded",
          contentHash: "0".repeat(64), receivedAt: 1, extractionStatus: "awaiting_doc_type", extractionAttempts: 0, retention: "active",
        }),
      ),
    ).rejects.toThrow();
  });

  it("widens only: a legacy claim, ledger event and draft with none of the new fields still validate", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", currency: "EUR", status: "active",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "W", unitCents: 100, qty: 1, returned: false });
      const claimId: Id<"claims"> = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "return_credit", expectedCents: 100, status: "sent", token: "BBBBBB", version: 1,
      });
      await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 100, evidence: "e" });
      await ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "a@b.example", subject: "s", body: "b" });
      const doc = await ctx.db.get(claimId);
      expect(doc?.requiredChannel).toBeUndefined();
      expect(doc?.transactionId).toBeUndefined();
    });
  });

  it("a local validator built from the shared one composes (money.extend)", () => {
    const withNote = money.extend({ note: v.string() });
    expect(Object.keys(withNote.fields).sort()).toEqual(["amountMinor", "currency", "note"]);
  });
});
