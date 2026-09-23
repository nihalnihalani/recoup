/**
 * snapshot_order.ts (M21): the R05 snapshot resolves the order's rows into cells, and its bound facts are canonical
 * (subjectKey, key, status, value) rows — values, never ids — sorted and ≤ 32 (rev 5 N6, DA-A-15).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { MAX_BOUND_FACTS } from "../../limits";
import { isFactKey } from "./catalog";
import { buildOrderSnapshot, orderBoundFacts, R05_BOUND_KEYS, txnCell } from "./snapshot_order";
import { snapshotHash, type CellRow } from "./snapshot_retail";

const TXN = "ordertxn1" as Id<"transactions">;
const total = (n: number, at: number, state: "user_confirmed" | "extracted_candidate" = "user_confirmed", ref = "doc"): CellRow => ({
  subjectKey: "txn", key: "retail.order_total",
  row: { state, value: { kind: "money", amountMinor: n, currency: "USD" }, at, source: state === "user_confirmed" ? { kind: "user" } : { kind: "evidence", ref } },
});

describe("buildOrderSnapshot", () => {
  it("resolves the rows of each cell (a confirmation beats a candidate; two candidates conflict)", () => {
    const s = buildOrderSnapshot({ transactionId: TXN, rows: [total(64950, 2), total(60000, 1, "extracted_candidate")] });
    expect(txnCell(s, "retail.order_total")).toMatchObject({ status: "confirmed", value: { amountMinor: 64950 } });
    const c = buildOrderSnapshot({ transactionId: TXN, rows: [total(64950, 1, "extracted_candidate", "a"), total(60000, 2, "extracted_candidate", "b")] });
    expect(txnCell(c, "retail.order_total")).toMatchObject({ status: "conflicting", conflict: { kind: "candidates" } });
    expect(txnCell(c, "order.shipped").status).toBe("missing");
  });

  it("the snapshot hash sees values, not rows: a re-confirmed value keeps it, a changed value moves it (DA-A-15)", async () => {
    const a = await snapshotHash(buildOrderSnapshot({ transactionId: TXN, rows: [total(64950, 1)] }));
    const again = await snapshotHash(buildOrderSnapshot({ transactionId: TXN, rows: [total(64950, 1), total(64950, 5)] }));
    const changed = await snapshotHash(buildOrderSnapshot({ transactionId: TXN, rows: [total(64951, 1)] }));
    expect(again).toBe(a);
    expect(changed).not.toBe(a);
  });
});

describe("orderBoundFacts (R05 v1)", () => {
  it("every bound key is catalogued, unique, and within MAX_BOUND_FACTS", () => {
    expect(R05_BOUND_KEYS.length).toBeLessThanOrEqual(MAX_BOUND_FACTS);
    expect(new Set(R05_BOUND_KEYS).size).toBe(R05_BOUND_KEYS.length);
    for (const k of R05_BOUND_KEYS) expect(isFactKey(k), k).toBe(true);
  });

  it("rows are canonical (subjectKey, key, status, value), sorted, and a cell with no single value carries none", () => {
    const s = buildOrderSnapshot({ transactionId: TXN, rows: [total(64950, 1)] });
    const b = orderBoundFacts(s);
    expect(b).toHaveLength(R05_BOUND_KEYS.length);
    expect(b.map((x) => x.key)).toEqual([...R05_BOUND_KEYS].sort());
    expect(b.find((x) => x.key === "retail.order_total")).toEqual({ subjectKey: "txn", key: "retail.order_total", status: "confirmed", value: { kind: "money", amountMinor: 64950, currency: "USD" } });
    expect(b.find((x) => x.key === "order.shipped")).toEqual({ subjectKey: "txn", key: "order.shipped", status: "missing" });
    expect(JSON.stringify(b)).not.toMatch(/"(ref|source|at)"/);
  });
});
