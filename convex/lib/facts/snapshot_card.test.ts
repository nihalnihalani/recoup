/**
 * snapshot_card.ts + keys_card.ts (M21): one card statement line is one `card_charge` transaction (DA-A-30), every
 * R03 fact lives on it (subject `txn`), and R03's bound facts are canonical rows, sorted, ≤ 32 (rev 5 N6, DA-A-15).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { MAX_BOUND_FACTS } from "../../limits";
import { getFactSpec, isFactKey, type FactSpec } from "./catalog";
import { CARD_FACT_SPECS } from "./keys_card";
import { buildCardSnapshot, cardBoundFacts, R03_BOUND_KEYS } from "./snapshot_card";
import { txnCell } from "./snapshot_order";
import { validateFactValue } from "./values";

describe("keys_card (catalogue)", () => {
  it("every card key is a transaction-level card_charge fact in the card domain; the payment class serves retail orders too", () => {
    for (const s of CARD_FACT_SPECS as readonly FactSpec[]) {
      expect(s.domain, s.key).toBe("card");
      expect(s.subject, s.key).toEqual(["transaction"]);
      expect(s.key.startsWith("card."), s.key).toBe(true);
      expect(s.categories, s.key).toEqual(s.key === "card.payment_instrument_class" ? ["card_charge", "retail_order"] : ["card_charge"]);
    }
  });

  it("the spec's `unknown` members are not codes ('I don't know' is user_unknown); money is USD-only (new scenario)", () => {
    const cls = getFactSpec("card.payment_instrument_class")!;
    expect(() => validateFactValue(cls, { kind: "code", code: "unknown" }, { userSource: true })).toThrow();
    expect(validateFactValue(cls, { kind: "code", code: "debit_card" }, { userSource: true })).toEqual({ kind: "code", code: "debit_card" });
    const amount = getFactSpec("card.charge_amount")!;
    expect(() => validateFactValue(amount, { kind: "money", amountMinor: 100, currency: "GBP" }, { userSource: true })).toThrow();
    const received = getFactSpec("card.notice_received_on")!;
    expect(() => validateFactValue(received, { kind: "local_date", date: "2026-02-30" }, { userSource: true })).toThrow();
  });
});

describe("buildCardSnapshot / cardBoundFacts (R03 v1)", () => {
  const T = "cardline1" as Id<"transactions">;
  it("carries the related order only when given, and resolves the line's rows", () => {
    const rows = [{ subjectKey: "txn", key: "card.error_type", row: { state: "user_confirmed" as const, value: { kind: "code" as const, code: "duplicate_charge" }, at: 1, source: { kind: "user" as const } } }];
    expect(buildCardSnapshot({ transactionId: T, rows }).relatedTransactionId).toBeNull();
    const s = buildCardSnapshot({ transactionId: T, relatedTransactionId: "order1" as Id<"transactions">, rows });
    expect(s.relatedTransactionId).toBe("order1");
    expect(txnCell(s, "card.error_type")).toMatchObject({ status: "confirmed", value: { code: "duplicate_charge" } });
  });

  it("bound keys are catalogued, unique, ≤ MAX_BOUND_FACTS; rows are canonical and sorted", () => {
    expect(R03_BOUND_KEYS.length).toBeLessThanOrEqual(MAX_BOUND_FACTS);
    expect(new Set(R03_BOUND_KEYS).size).toBe(R03_BOUND_KEYS.length);
    for (const k of R03_BOUND_KEYS) expect(isFactKey(k), k).toBe(true);
    const b = cardBoundFacts(buildCardSnapshot({ transactionId: T, rows: [] }));
    expect(b.map((x) => x.key)).toEqual([...R03_BOUND_KEYS].sort());
    expect(b.every((x) => x.status === "missing" && x.value === undefined)).toBe(true);
  });
});
