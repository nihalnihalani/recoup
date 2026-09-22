import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { cellStatus, factValue } from "./schema";
import { ownedTransaction, requireUserId } from "./lib/access";
import { getFactSpec } from "./lib/facts/catalog";
import { loadRetailSnapshot } from "./lib/facts/legacyRetail";
import { resolveCell, type Cell, type CellSource, type ResolveRow } from "./lib/facts/resolve";
import { putFact, readLiveFacts, toResolveRow } from "./lib/facts/write";

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
  /** Whether the user may answer this key (a question is shown only then). */
  userAssertable: v.boolean(),
  question: v.optional(v.object({ prompt: v.string(), why: v.string(), sensitive: v.optional(v.boolean()) })),
});

const src = (s: CellSource) => (s.ref === undefined ? { kind: s.kind } : { kind: s.kind, ref: s.ref });

function toView(c: Cell) {
  const spec = getFactSpec(c.key);
  const common = {
    subjectKey: c.subjectKey,
    key: c.key,
    status: c.status,
    capsOutcomeAt: c.capsOutcomeAt,
    userAssertable: spec?.userAssertable ?? false,
    ...(spec?.userAssertable ? { question: spec.question } : {}),
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
    return (await transactionCells(ctx, txn)).map(toView);
  },
});

/**
 * The user answers a question about a fact (the Questions UI, §9): a `user_confirmed` row through the single writer
 * `putFact`, which enforces the catalogue, subject ownership, value domain, masking (D142), the supersede rules and
 * the live cap. `{ kind: "user_unknown" }` records "I don't know" (never read as a value, DA-A-1).
 * `overridesObserved` deliberately replaces what the system observed; without it a disagreement shows as a conflict.
 * Re-sending an identical answer writes nothing.
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
    return await putFact(ctx, userId, {
      transactionId: args.transactionId,
      subjectKey: args.subjectKey,
      key: args.key,
      state: "user_confirmed",
      value: args.value,
      source: { kind: "user" },
      ...(args.overridesObserved ? { overridesObserved: true } : {}),
    });
  },
});
