/**
 * The legacy retail read adapter (contract §2.5). Legacy purchases, items and price checks enter evaluation as
 * resolution rows; nothing is written or rewritten.
 *
 *   - An ACTIVE purchase: merchant, purchase date, order ref, item names, quantities and unit prices are
 *     `user_confirmed` rows (source `legacy_purchase`) — the user entered or confirmed them (D25).
 *   - A needs_review (or archived) purchase: the same values as `extracted_candidate` rows.
 *   - CURRENCY is always a candidate here (DA-A-33): `purchases.confirm` had no currency argument before wave 1 and
 *     intake assumed USD when unclear, so a legacy currency is an assumption. Only a stored `retail.currency`
 *     `user_confirmed` fact (written by `purchases.confirm` from wave 1 on) makes the cell confirmed.
 *   - The newest ACCEPTED price check of an item (`observedCents` set, D16) is its `observed` price row.
 *   - The policy snapshot is a rule-pack parameter source (§2.7), not a fact: it is not read here.
 *
 * Stored fact rows overlay these rows cell by cell (`buildRetailSnapshot`): purchase-derived rows sort as the oldest
 * layer, so any stored answer is newer; an accepted price check competes with stored observations by `observedAt`.
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { MAX_ITEMS_PER_PURCHASE } from "../../limits";
import { maskPans } from "../pan";
import type { FactValue } from "./catalog";
import type { FactRowState } from "./resolve";
import { buildRetailSnapshot, type CellRow, type RetailSnapshot } from "./snapshot_retail";
import { subjectKey } from "./subject";
import { readLiveFacts, toResolveRow } from "./write";

export interface LegacyRetailInput {
  purchase: Doc<"purchases">;
  items: Doc<"items">[];
  /** The newest accepted price check per item id (absent when the item has none in the scanned window). */
  latestAccepted: Partial<Record<Id<"items">, Doc<"priceChecks">>>;
}

/** Newest price-check rows scanned per item for an accepted one: 50 rejected checks in a row (~4 days of 2-hourly checks) means the latest price is unknown, not old. */
export const LEGACY_CHECK_SCAN = 50;

/** Pure: the legacy rows of one purchase. Free text is masked (D142); identifiers are not. */
export function legacyRetailRows(input: LegacyRetailInput): CellRow[] {
  const { purchase, items, latestAccepted } = input;
  const state: FactRowState = purchase.status === "active" ? "user_confirmed" : "extracted_candidate";
  // The purchase layer is always the OLDEST layer: every stored fact overlays it, whatever the clocks say (a stored
  // answer recorded in the purchase's own creation millisecond must not sort before it; `_creationTime` carries a
  // sub-millisecond fraction, `recordedAt` does not). Observations keep their real `observedAt`.
  const at = 0;
  const source = { kind: "legacy_purchase" as const };
  const rows: CellRow[] = [];
  const add = (s: string, key: string, value: FactValue, rowState: FactRowState = state) =>
    rows.push({ subjectKey: s, key, row: { state: rowState, value, at, source } });

  const txn = subjectKey.txn();
  add(txn, "retail.merchant", { kind: "text", text: maskPans(purchase.merchant) });
  if (purchase.orderRef !== undefined) add(txn, "retail.order_ref", { kind: "identifier", scheme: "order_ref", value: purchase.orderRef });
  if (purchase.purchasedAt !== undefined) add(txn, "retail.purchase_date", { kind: "instant", epochMs: purchase.purchasedAt });
  add(txn, "retail.currency", { kind: "code", code: purchase.currency }, "extracted_candidate");

  for (const item of items) {
    const s = subjectKey.item(item._id);
    add(s, "retail.item_name", { kind: "text", text: maskPans(item.name) });
    add(s, "retail.quantity", { kind: "count", n: item.qty });
    add(s, "retail.unit_price", { kind: "money", amountMinor: item.unitCents, currency: purchase.currency });
    const pc = latestAccepted[item._id];
    if (pc?.observedCents !== undefined) {
      rows.push({
        subjectKey: s,
        key: "retail.observed_price",
        row: {
          state: "observed",
          value: { kind: "money", amountMinor: pc.observedCents, currency: pc.currency ?? purchase.currency },
          at: pc.observedAt,
          source: { kind: "legacy_price_check", ref: pc._id },
        },
      });
    }
  }
  return rows;
}

/** Read-only: a purchase's items (all, or the requested subset) and each one's newest accepted price check. */
export async function readLegacyRetail(
  ctx: QueryCtx,
  purchaseId: Id<"purchases">,
  opts: { itemIds?: readonly Id<"items">[] } = {},
): Promise<LegacyRetailInput | null> {
  const purchase = await ctx.db.get(purchaseId);
  if (!purchase) return null;
  let items: Doc<"items">[];
  if (opts.itemIds === undefined) {
    items = await ctx.db
      .query("items")
      .withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId))
      .take(MAX_ITEMS_PER_PURCHASE);
  } else {
    // Subject-scoped (DA-A-32, M11d): read only the requested items by id — a constant, not the whole purchase. An id
    // that is missing, of another purchase or of another user is dropped, never read into the snapshot.
    const wanted = [...new Set(opts.itemIds)].slice(0, MAX_ITEMS_PER_PURCHASE);
    const got = await Promise.all(wanted.map((id) => ctx.db.get(id)));
    items = got
      .filter((i): i is Doc<"items"> => i !== null && i.purchaseId === purchaseId && i.userId === purchase.userId)
      .sort((a, b) => a._creationTime - b._creationTime);
  }
  const latestAccepted: LegacyRetailInput["latestAccepted"] = {};
  for (const item of items) {
    const newest = await ctx.db
      .query("priceChecks")
      .withIndex("by_item", (q) => q.eq("itemId", item._id))
      .order("desc")
      .take(LEGACY_CHECK_SCAN);
    const accepted = newest.find((c) => c.observedCents !== undefined);
    if (accepted) latestAccepted[item._id] = accepted;
  }
  return { purchase, items, latestAccepted };
}

/**
 * Read-only: the retail snapshot of a transaction — legacy rows (when it mirrors a purchase) overlaid with its live
 * stored facts. `itemIds` scopes the item subjects read (DA-A-32: an observation re-evaluates only its item);
 * transaction-level cells are always included. The caller has already authorised the transaction.
 */
export async function loadRetailSnapshot(
  ctx: QueryCtx,
  transaction: Doc<"transactions">,
  opts: { itemIds?: readonly Id<"items">[] } = {},
): Promise<RetailSnapshot> {
  const legacy = transaction.purchaseId === undefined ? null : await readLegacyRetail(ctx, transaction.purchaseId, opts);
  const scoped = opts.itemIds === undefined ? null : new Set(opts.itemIds.map((id) => subjectKey.item(id)));
  const stored = (await readLiveFacts(ctx, transaction._id))
    .filter((f) => scoped === null || !f.subjectKey.startsWith("item:") || scoped.has(f.subjectKey))
    .map((f): CellRow => ({ subjectKey: f.subjectKey, key: f.key, row: toResolveRow(f) }));
  return buildRetailSnapshot({
    transactionId: transaction._id,
    purchaseId: legacy?.purchase._id ?? null,
    purchaseStatus: legacy?.purchase.status ?? null,
    merchantDomain: legacy?.purchase.merchantDomain ?? transaction.counterpartyDomain ?? null,
    isExample: transaction.isExample === true,
    items: (legacy?.items ?? []).map((i) => {
      const pc = legacy?.latestAccepted[i._id];
      return {
        itemId: i._id,
        returned: i.returned,
        observation: pc
          ? {
              priceCheckId: pc._id,
              observedAt: pc.observedAt,
              ...(pc.confidence !== undefined ? { confidence: pc.confidence } : {}),
              ...(pc.variantMatch !== undefined ? { variantMatch: pc.variantMatch } : {}),
            }
          : null,
      };
    }),
    rows: [...(legacy ? legacyRetailRows(legacy) : []), ...stored],
  });
}
