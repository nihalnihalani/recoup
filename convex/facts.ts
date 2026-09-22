import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { cellStatus, factValue } from "./schema";
import { ownedTransaction, requireUserId } from "./lib/access";
import { getFactSpec, type FactSpec } from "./lib/facts/catalog";
import { loadRetailSnapshot } from "./lib/facts/legacyRetail";
import { resolveCell, type Cell, type CellSource, type ResolveRow } from "./lib/facts/resolve";
import { evaluationScope } from "./lib/facts/subject";
import { putFact, readLiveFacts, toResolveRow } from "./lib/facts/write";
import { rateLimiter } from "./lib/rateLimits";
import { evaluateTransaction } from "./opportunities";

const sourceView = v.object({
  kind: v.union(
    v.literal("user"), v.literal("evidence"), v.literal("price_check"), v.literal("derived"),
    v.literal("legacy_purchase"), v.literal("legacy_price_check"),
  ),
  ref: v.optional(v.string()),
});

/** One resolved fact cell as the transaction page shows it (contract §2.5, §9 "confirmed facts / needs confirmation"). */
export const cellView = v.object({
  subjectKey: v.string(),
  key: v.string(),
  status: cellStatus,
  /** Known cells and candidates only. A candidate's value is never known (D147(2), `capsOutcomeAt`). */
  value: v.optional(factValue),
  source: v.optional(sourceView),
  /** Candidates: every source that proposed the value, newest first. */
  sources: v.optional(v.array(sourceView)),
  /** "I don't know" answered, then a later candidate arrived: shown as a hint, never used. */
  hint: v.optional(v.object({ value: factValue, source: sourceView })),
  /** D152: the competing values and who can settle them. */
  conflict: v.optional(
    v.object({
      kind: v.union(v.literal("candidates"), v.literal("confirmed_vs_observed"), v.literal("confirmed_vs_confirmed")),
      values: v.array(v.object({ value: factValue, source: sourceView })),
    }),
  ),
  capsOutcomeAt: v.union(v.literal("likely_eligible"), v.null()),
  /** Whether the user may state this key (a question is shown only then). */
  userAssertable: v.boolean(),
  /**
   * M11b: where the user states it — `purchases.confirm` for a key the purchase record backs (edit the purchase),
   * `facts.answer` otherwise. Absent when the user cannot state it.
   */
  answerVia: v.optional(v.union(v.literal("facts.answer"), v.literal("purchases.confirm"))),
  question: v.optional(v.object({ prompt: v.string(), why: v.string(), sensitive: v.optional(v.boolean()) })),
});

const src = (s: CellSource) => (s.ref === undefined ? { kind: s.kind } : { kind: s.kind, ref: s.ref });

/** M11b: on a purchase-backed transaction, a `purchase_record` key is edited on the purchase, not answered here. */
function backedByPurchase(txn: Doc<"transactions">, spec: FactSpec): boolean {
  return txn.purchaseId !== undefined && spec.sourceOfTruth === "purchase_record";
}

function toView(txn: Doc<"transactions">, c: Cell) {
  const spec = getFactSpec(c.key);
  const common = {
    subjectKey: c.subjectKey,
    key: c.key,
    status: c.status,
    capsOutcomeAt: c.capsOutcomeAt,
    userAssertable: spec?.userAssertable ?? false,
    ...(spec?.userAssertable
      ? { question: spec.question, answerVia: backedByPurchase(txn, spec) ? ("purchases.confirm" as const) : ("facts.answer" as const) }
      : {}),
  };
  switch (c.status) {
    case "confirmed":
    case "observed":
    case "derived":
      return { ...common, value: c.value, source: src(c.source) };
    case "candidate":
      return { ...common, value: c.value, sources: c.sources.map(src) };
    case "conflicting":
      return { ...common, conflict: { kind: c.conflict.kind, values: c.conflict.values.map((x) => ({ value: x.value, source: src(x.source) })) } };
    case "user_unknown":
      return { ...common, ...(c.hint ? { hint: { value: c.hint.value, source: src(c.hint.source) } } : {}) };
    case "missing":
      return common;
  }
}

/** The resolved cells of one transaction: the retail snapshot (legacy rows + stored facts) or, for other categories, stored facts only. */
async function transactionCells(ctx: QueryCtx, txn: Doc<"transactions">): Promise<readonly Cell[]> {
  if (txn.category === "retail_order") return (await loadRetailSnapshot(ctx, txn)).lookup.cells();
  const grouped = new Map<string, { subjectKey: string; key: string; rows: ResolveRow[] }>();
  for (const f of await readLiveFacts(ctx, txn._id)) {
    const id = `${f.subjectKey}\u0000${f.key}`;
    const g = grouped.get(id) ?? { subjectKey: f.subjectKey, key: f.key, rows: [] };
    g.rows.push(toResolveRow(f));
    grouped.set(id, g);
  }
  return [...grouped.values()].map((g) => resolveCell(g.subjectKey, g.key, g.rows));
}

/**
 * Every fact cell known about one of the caller's transactions, resolved (contract §2.5): confirmed / observed /
 * derived values, candidates awaiting confirmation, conflicts, and "I don't know" answers. Missing cells are not
 * listed (which facts matter is the evaluator's call). Bounded: live facts are capped per transaction, a retail
 * snapshot reads ≤ 50 items and ≤ 50 checks per item. A foreign or missing id → the same "Transaction not found".
 */
export const list = query({
  args: { transactionId: v.id("transactions") },
  returns: v.array(cellView),
  handler: async (ctx, { transactionId }) => {
    const userId = await requireUserId(ctx);
    const txn = await ownedTransaction(ctx, transactionId, userId);
    return (await transactionCells(ctx, txn)).map((c) => toView(txn, c));
  },
});

/**
 * The user answers a question about a fact (the Questions UI, §9): a `user_confirmed` row through the single writer
 * `putFact`, which enforces the catalogue, subject ownership, value domain, masking (D142), the supersede rules and
 * the live cap. `{ kind: "user_unknown" }` records "I don't know" (never read as a value, DA-A-1).
 * `overridesObserved` deliberately replaces what the system observed; without it a disagreement shows as a conflict.
 * Re-sending an identical answer writes nothing.
 *
 * M11b: rate-limited per user (`factsAnswer`) before any write; and a key the purchase record backs
 * (`sourceOfTruth: "purchase_record"`) is refused on a purchase-backed transaction — the user edits the purchase
 * (`purchases.confirm`) instead, so their own correction never contradicts their own purchase record.
 */
export const answer = mutation({
  args: {
    transactionId: v.id("transactions"),
    subjectKey: v.string(),
    key: v.string(),
    value: factValue,
    overridesObserved: v.optional(v.boolean()),
  },
  returns: v.object({
    factId: v.id("facts"),
    outcome: v.union(v.literal("inserted"), v.literal("patched"), v.literal("unchanged")),
  }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const limit = await rateLimiter.limit(ctx, "factsAnswer", { key: userId });
    if (!limit.ok) throw new ConvexError("You sent too many answers in a short time. Try again in a minute.");
    const txn = await ownedTransaction(ctx, args.transactionId, userId);
    const spec = getFactSpec(args.key);
    if (spec !== null && backedByPurchase(txn, spec)) {
      throw new ConvexError(`This comes from your purchase record: edit the purchase to change it (${spec.key}).`);
    }
    const written = await putFact(ctx, userId, {
      transactionId: args.transactionId,
      subjectKey: args.subjectKey,
      key: args.key,
      state: "user_confirmed",
      value: args.value,
      source: { kind: "user" },
      ...(args.overridesObserved ? { overridesObserved: true } : {}),
    });
    // C43 (M11d): re-evaluate in this same mutation so the opportunity card shows the new outcome reactively — scoped
    // to the answered item, or the whole transaction for a transaction-level fact. Nothing written → nothing to do.
    if (written.outcome !== "unchanged") {
      await evaluateTransaction(ctx, txn._id, "fact_change", Date.now(), evaluationScope([args.subjectKey]));
    }
    return written;
  },
});
