import { describe, it, expect } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { MAX_BOUND_FACTS } from "../../limits";
import { boundFactsHash } from "../canonical";
import { boundFactValues, buildRetailSnapshot, snapshotHash, type CellRow, type RetailSnapshotInput } from "./snapshot_retail";
import { legacyRetailRows, type LegacyRetailInput } from "./legacyRetail";
import type { FactValue } from "./catalog";
import type { ResolveRow } from "./resolve";

// Hand-written fixtures: a legacy purchase with two items and one accepted price check. Every expected value
// below is written by hand, never produced by the code under test.
const P = "p1" as Id<"purchases">;
const T1 = "t1" as Id<"transactions">;
const I1 = "i1" as Id<"items">;
const I2 = "i2" as Id<"items">;
const PC = "pc1" as Id<"priceChecks">;
const CREATED = Date.UTC(2026, 8, 1);
const BOUGHT = Date.UTC(2026, 8, 10, 19);

function legacy(over: { status?: "needs_review" | "active" | "archived"; currency?: string; purchasedAt?: number; unitCents?: number } = {}): LegacyRetailInput {
  return {
    purchase: {
      _id: P, _creationTime: CREATED, userId: "u1" as Id<"users">, merchant: "Northwind Outfitters",
      merchantDomain: "northwind.example", orderRef: "NW-48377", purchasedAt: "purchasedAt" in over ? over.purchasedAt : BOUGHT,
      currency: over.currency ?? "USD", status: over.status ?? "active",
    },
    items: [
      { _id: I1, _creationTime: CREATED, purchaseId: P, userId: "u1" as Id<"users">, name: "Waxed jacket", unitCents: over.unitCents ?? 12000, qty: 2, returned: false },
      { _id: I2, _creationTime: CREATED, purchaseId: P, userId: "u1" as Id<"users">, name: "Gift card 4111 1111 1111 1111", unitCents: 5000, qty: 1, returned: true },
    ],
    latestAccepted: {
      [I1]: {
        _id: PC, _creationTime: BOUGHT + 5, itemId: I1, userId: "u1" as Id<"users">, observedCents: 9500, currency: "USD",
        confidence: 0.92, variantMatch: "exact", observedAt: BOUGHT + 86_400_000, sourceUrl: "https://northwind.example/p/j",
      },
    },
  };
}

function input(l: LegacyRetailInput, stored: CellRow[] = []): RetailSnapshotInput {
  return {
    transactionId: T1, purchaseId: P, purchaseStatus: l.purchase.status, merchantDomain: l.purchase.merchantDomain, isExample: false,
    items: l.items.map((i) => ({
      itemId: i._id, returned: i.returned,
      observation: l.latestAccepted[i._id]
        ? { priceCheckId: l.latestAccepted[i._id]!._id, observedAt: l.latestAccepted[i._id]!.observedAt, confidence: 0.92, variantMatch: "exact" as const }
        : null,
    })),
    rows: [...legacyRetailRows(l), ...stored],
  };
}

const stored = (subjectKey: string, key: string, state: ResolveRow["state"], value: FactValue, at: number): CellRow => ({
  subjectKey, key, row: { state, value, at, source: { kind: "user" } },
});

describe("legacyRetailRows (contract §2.5 legacy adapter)", () => {
  it("an active purchase: merchant, date, order ref, items and qty are confirmed; the price check is observed", () => {
    const s = buildRetailSnapshot(input(legacy()));
    expect(s.merchant).toMatchObject({ status: "confirmed", value: { kind: "text", text: "Northwind Outfitters" }, source: { kind: "legacy_purchase" } });
    expect(s.purchaseDate).toMatchObject({ status: "confirmed", value: { kind: "instant", epochMs: BOUGHT } });
    expect(s.orderRef).toMatchObject({ status: "confirmed", value: { kind: "identifier", scheme: "order_ref", value: "NW-48377" } });
    expect(s.items[0]).toMatchObject({
      itemId: I1, subjectKey: "item:i1", returned: false,
      name: { status: "confirmed", value: { kind: "text", text: "Waxed jacket" } },
      quantity: { status: "confirmed", value: { kind: "count", n: 2 } },
      unitPrice: { status: "confirmed", value: { kind: "money", amountMinor: 12000, currency: "USD" } },
      observedPrice: { status: "observed", value: { kind: "money", amountMinor: 9500, currency: "USD" }, source: { kind: "legacy_price_check", ref: "pc1" } },
      observation: { priceCheckId: PC, observedAt: BOUGHT + 86_400_000, confidence: 0.92, variantMatch: "exact" },
    });
    expect(s.items[1]).toMatchObject({ returned: true, observedPrice: { status: "missing" } });
  });

  it("D142: a legacy free-text value is masked in the cell", () => {
    expect(buildRetailSnapshot(input(legacy())).items[1].name).toMatchObject({ value: { kind: "text", text: "Gift card •••• 1111" } });
  });

  it("DA-A-33: a legacy (assumed) currency is an assumption-class candidate, never confirmed", () => {
    const s = buildRetailSnapshot(input(legacy()));
    expect(s.currency).toMatchObject({ status: "candidate", known: false, value: { kind: "code", code: "USD" }, capsOutcomeAt: "likely_eligible" });
  });

  it("DA-A-33: a retail.currency confirmation written after wave 1 makes it confirmed", () => {
    const s = buildRetailSnapshot(input(legacy(), [stored("txn", "retail.currency", "user_confirmed", { kind: "code", code: "USD" }, CREATED + 10)]));
    expect(s.currency).toMatchObject({ status: "confirmed", known: true, value: { kind: "code", code: "USD" } });
  });

  it("a needs_review purchase yields candidate cells", () => {
    const s = buildRetailSnapshot(input(legacy({ status: "needs_review", purchasedAt: undefined })));
    expect(s.merchant.status).toBe("candidate");
    expect(s.items[0].unitPrice.status).toBe("candidate");
    expect(s.purchaseDate.status).toBe("missing");
  });

  it("stored facts overlay the adapter: an answer confirms a missing date; a contradicting answer is confirmed_vs_confirmed", () => {
    const answered = buildRetailSnapshot(input(legacy({ status: "needs_review", purchasedAt: undefined }), [
      stored("txn", "retail.purchase_date", "user_confirmed", { kind: "instant", epochMs: BOUGHT }, CREATED + 10),
    ]));
    expect(answered.purchaseDate).toMatchObject({ status: "confirmed", value: { kind: "instant", epochMs: BOUGHT } });
    const contradicted = buildRetailSnapshot(input(legacy(), [
      stored("item:i1", "retail.unit_price", "user_confirmed", { kind: "money", amountMinor: 11000, currency: "USD" }, CREATED + 10),
    ]));
    expect(contradicted.items[0].unitPrice).toMatchObject({ status: "conflicting", conflict: { kind: "confirmed_vs_confirmed" } });
  });

  it("a newer stored observation wins over an older legacy check", () => {
    const s = buildRetailSnapshot(input(legacy(), [
      { subjectKey: "item:i1", key: "retail.observed_price", row: { state: "observed", value: { kind: "money", amountMinor: 9000, currency: "USD" }, at: BOUGHT + 2 * 86_400_000, source: { kind: "price_check", ref: "pc2" } } },
    ]));
    expect(s.items[0].observedPrice).toMatchObject({ status: "observed", value: { kind: "money", amountMinor: 9000, currency: "USD" } });
  });

  it("the lookup answers every cell, missing for unknown ones", () => {
    const s = buildRetailSnapshot(input(legacy()));
    expect(s.lookup.get("item:i1", "retail.quantity")).toBe(s.items[0].quantity);
    expect(s.lookup.get("txn", "retail.window_days").status).toBe("missing");
  });
});

describe("snapshotHash (DA-A-15: values, never row ids)", () => {
  it("same value re-confirmed → same hash", async () => {
    const once = [stored("txn", "retail.currency", "user_confirmed", { kind: "code", code: "USD" }, CREATED + 10)];
    const twice = [
      { ...once[0], row: { ...once[0].row, state: "superseded" as const } },
      stored("txn", "retail.currency", "user_confirmed", { kind: "code", code: "USD" }, CREATED + 99),
    ];
    const a = await snapshotHash(buildRetailSnapshot(input(legacy(), once)));
    const b = await snapshotHash(buildRetailSnapshot(input(legacy(), twice)));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("a different price check row with the same observed value → same hash", async () => {
    const l = legacy();
    const other: LegacyRetailInput = { ...l, latestAccepted: { [I1]: { ...l.latestAccepted[I1]!, _id: "pc9" as Id<"priceChecks">, observedAt: BOUGHT + 3 } } };
    expect(await snapshotHash(buildRetailSnapshot(input(other)))).toBe(await snapshotHash(buildRetailSnapshot(input(l))));
  });

  it("anchor changed → bump", async () => {
    const a = await snapshotHash(buildRetailSnapshot(input(legacy())));
    const b = await snapshotHash(buildRetailSnapshot(input(legacy({ purchasedAt: BOUGHT - 86_400_000 }))));
    expect(b).not.toBe(a);
  });

  it("a corrected unit price → bump; a confirmed currency (status change) → bump", async () => {
    const base = await snapshotHash(buildRetailSnapshot(input(legacy())));
    expect(await snapshotHash(buildRetailSnapshot(input(legacy({ unitCents: 11999 }))))).not.toBe(base);
    const confirmed = await snapshotHash(buildRetailSnapshot(input(legacy(), [
      stored("txn", "retail.currency", "user_confirmed", { kind: "code", code: "USD" }, CREATED + 10),
    ])));
    expect(confirmed).not.toBe(base);
  });
});

describe("boundFactValues (rev 5 N6)", () => {
  const refs = [
    { subjectKey: "item:i1", key: "retail.unit_price" },
    { subjectKey: "txn", key: "retail.purchase_date" },
    { subjectKey: "item:i1", key: "retail.quantity" },
    { subjectKey: "txn", key: "retail.window_days" },
    { subjectKey: "txn", key: "retail.currency" },
  ];

  it("boundFactValues are canonical and bounded ≤ 32", () => {
    const s = buildRetailSnapshot(input(legacy()));
    expect(boundFactValues(s, refs)).toEqual([
      { subjectKey: "item:i1", key: "retail.quantity", status: "confirmed", value: { kind: "count", n: 2 } },
      { subjectKey: "item:i1", key: "retail.unit_price", status: "confirmed", value: { kind: "money", amountMinor: 12000, currency: "USD" } },
      { subjectKey: "txn", key: "retail.currency", status: "candidate", value: { kind: "code", code: "USD" } },
      { subjectKey: "txn", key: "retail.purchase_date", status: "confirmed", value: { kind: "instant", epochMs: BOUGHT } },
      { subjectKey: "txn", key: "retail.window_days", status: "missing" },
    ]);
    // Order and duplicates of the requested refs do not matter.
    expect(boundFactValues(s, [...refs].reverse().concat(refs))).toEqual(boundFactValues(s, refs));
    const tooMany = Array.from({ length: MAX_BOUND_FACTS + 1 }, (_, i) => ({ subjectKey: "txn", key: `retail.k${i}` }));
    expect(() => boundFactValues(s, tooMany)).toThrow(/32/);
  });

  it("no value for user_unknown or conflicting cells; hashing them with M10's boundFactsHash is stable", async () => {
    const s = buildRetailSnapshot(input(legacy(), [
      stored("item:i1", "retail.quantity", "user_confirmed", { kind: "user_unknown" }, CREATED + 10),
      stored("item:i1", "retail.unit_price", "user_confirmed", { kind: "money", amountMinor: 11000, currency: "USD" }, CREATED + 10),
    ]));
    const rows = boundFactValues(s, refs.slice(0, 3));
    expect(rows.find((r) => r.key === "retail.quantity")).toEqual({ subjectKey: "item:i1", key: "retail.quantity", status: "user_unknown" });
    expect(rows.find((r) => r.key === "retail.unit_price")).toEqual({ subjectKey: "item:i1", key: "retail.unit_price", status: "conflicting" });
    expect(await boundFactsHash(rows)).toBe(await boundFactsHash([...rows].reverse()));
  });
});
