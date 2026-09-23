/**
 * Opportunities and cases (contract rev 5.5 §2.8, §5; M12).
 *
 * An opportunity is the stable identity of "remedy × loss × transaction": `dedupeKey` =
 * `${transactionId}|${scenarioId}|${remedyKey}|${subjectKey}|${incidentId ?? "-"}` (never the rule version). Only a
 * pack the PRODUCTION registry returns (lead activation) ever evaluates here; tests reach unactivated packs through
 * the `vi.mock` registry seam (C3).
 *
 * `evaluateTransaction(ctx, transactionId, trigger, now, { subjects })` — a plain helper for mutations:
 *   1. supersede opportunities whose pack is no longer active (N3: material — the linked claim's version is bumped
 *      once and a note is written; the claim continues under the legacy send path);
 *   2. build the snapshot for the requested subjects only (DA-A-32: an observation re-evaluates only its item);
 *   3. evaluate each active pack (a throwing pack is recorded through `ops.recordRuleEvaluationFailure`, never
 *      rethrown — the caller's own writes survive);
 *   4. LINK MANDATORILY (DA-A-3): a non-closed legacy `price_adjustment` claim on the item (`by_item_type_status`) is
 *      linked to the opportunity (claim gets opportunityId/transactionId/currency/scenarioId/remedyKey/lossKeys;
 *      the opportunity gets activeClaimId + `case_open`) — never a second claim, so Potential counts 0 for it;
 *   5. upsert through `by_user_and_dedupe_key`; 6. append an evaluation only when `resultHash` changed;
 *   7. project onto the opportunity; 8. MATERIALITY for an already-open case: leaving the approvable set (except the
 *      acknowledgeable late window, C1), a rule/engine version change, a user deadline flipping to passed (except the
 *      acknowledgeable one), or a changed `boundFactsHash` bumps `claims.version` and writes a claimNote. Estimate
 *      drift is not material.
 *
 * `recordEvaluation` is the ONLY writer of `evaluations` (array bounds asserted before any write).
 */
import { ConvexError, v, type Infer } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { ownedOpportunity, ownedPurchase, ownedTransaction, requireUserId } from "./lib/access";
import { isTombstoned } from "./lib/accountState";
import { boundFactsHash, canonicalHash } from "./lib/canonical";
import { isClosedForAsk } from "./lib/claimState";
import { latestPolicy } from "./lib/latestPolicy";
import { assertUserAmount, claimCurrency } from "./lib/money";
import { amountExceedsEstimate } from "./lib/amountReview";
import { loadRetailSnapshot } from "./lib/facts/legacyRetail";
import { cellLookup } from "./lib/facts/resolve";
import { snapshotHash, type CellRow } from "./lib/facts/snapshot_retail";
import { readLiveFacts, toResolveRow } from "./lib/facts/write";
import { engineVersionFor } from "./lib/rules/engineVersion";
import { isLateAskAcknowledgeable, nextCounterpartyDueAt, nextUserDeadlineAt } from "./lib/deadlines/engine";
import { pathsNotChecked } from "./lib/rules/coverage";
import { leavesApprovableSet, resultHash } from "./lib/rules/outcome";
import { activePack, activePacksForCategory, isPackActive } from "./lib/rules/registry";
import {
  r01AutoOpen,
  R01_V1_WINDOW_ID,
  type R01CaseContext,
  type R01Snapshot,
} from "./lib/rules/r01_price_adjustment_v1";
import { VERIFICATION } from "./lib/rules/verification";
import { isApprovable, type AnyRulePack, type CaseContext, type EvaluationResult, type NextAction } from "./lib/rules/types";
import { MAX_BOUND_FACTS, MAX_ITEMS_PER_PURCHASE, MAX_LOSS_KEYS } from "./limits";
import { insertScenarioClaim, openClaim } from "./claims";
import { recordRuleEvaluationFailure } from "./ops";
import { ensurePurchaseTransaction } from "./transactions";
import { closurePatch } from "./lib/opportunityClosure";
import { rateLimiter } from "./lib/rateLimits";

export type EvaluationTrigger = Infer<typeof schema.tables.evaluations.validator.fields.trigger>;

/** Opportunities of one transaction read per evaluation (N3 supersede pass, query pages). */
const OPPORTUNITIES_PER_TRANSACTION = 100;
/** Price-adjustment claims read per item (the legacy flow keeps a handful per item over its life, D93). */
const CLAIMS_PER_ITEM = 100;
/** Claims read per transaction by the overlap guard. */
const OVERLAP_CLAIMS = 100;
/** Claims read per opportunity to find its open case and settled losses (a handful over a case's life). */
const CLAIMS_PER_OPPORTUNITY = 50;
/** Opportunities re-evaluated per `sweepReevaluateDue` call (M29 wires it to a cron; bounded page). */
const REEVALUATE_PAGE = 50;

// ---------------------------------------------------------------------------
// The single evaluation writer (DA-A-32 bounds)
// ---------------------------------------------------------------------------

const BOUNDS = {
  conditions: 64, missingFacts: 32, assumptions: 16, disqualifierIds: 16, deadlines: 8, sourceRefs: 8, overlap: 8,
  explanation: 12, boundFacts: MAX_BOUND_FACTS,
} as const;

/** Throws before any write when a result breaks the stored bounds (§2.4) or carries a malformed amount. */
export function assertEvaluationBounds(r: EvaluationResult): void {
  for (const [field, max] of Object.entries(BOUNDS)) {
    const n = (r as unknown as Record<string, unknown[]>)[field].length;
    if (n > max) throw new Error(`evaluation ${field} has ${n} entries (max ${max})`);
  }
  if (r.lossKeys.length > MAX_LOSS_KEYS) throw new Error(`evaluation lossKeys has ${r.lossKeys.length} entries (max ${MAX_LOSS_KEYS})`);
  if (r.amount && (!Number.isSafeInteger(r.amount.estimate.amountMinor) || r.amount.estimate.amountMinor < 0)) {
    throw new Error("evaluation amount must be non-negative integer minor units");
  }
  if ((r.outcome === "not_yet_due") !== (r.reevaluate !== undefined)) throw new Error("reevaluate is set iff not_yet_due");
}

/** The ONLY insert into `evaluations`. */
export async function recordEvaluation(
  ctx: MutationCtx,
  args: {
    userId: Id<"users">;
    opportunityId: Id<"opportunities">;
    result: EvaluationResult;
    trigger: EvaluationTrigger;
    now: number;
    factSnapshotHash: string;
    resultHash: string;
  },
): Promise<Id<"evaluations">> {
  const r = args.result;
  assertEvaluationBounds(r);
  return await ctx.db.insert("evaluations", {
    userId: args.userId,
    opportunityId: args.opportunityId,
    scenarioId: r.scenarioId,
    ruleId: r.ruleId,
    ruleVersion: r.ruleVersion,
    engineVersion: r.engineVersion,
    factSnapshotHash: args.factSnapshotHash,
    resultHash: args.resultHash,
    evaluatedAt: args.now,
    trigger: args.trigger,
    outcome: r.outcome,
    dimensions: r.dimensions,
    conditions: r.conditions,
    missingFacts: r.missingFacts,
    assumptions: r.assumptions,
    disqualifierIds: r.disqualifierIds,
    amount: r.amount,
    deadlines: r.deadlines,
    sourceRefs: r.sourceRefs,
    overlap: r.overlap.map((o) => ({ withScenario: o.withScenario, withRemedyKey: o.withRemedyKey, relation: o.relation })),
    nextAction: r.nextAction,
    explanation: r.explanation,
    boundFacts: r.boundFacts,
    ...(r.reevaluate !== undefined ? { reevaluate: r.reevaluate } : {}),
  });
}

// ---------------------------------------------------------------------------
// Scenario adapters: how a pack's subjects, snapshot and case context are read from the database
// ---------------------------------------------------------------------------

type Run = {
  subjectKey: string;
  snapshot: unknown;
  factSnapshotHash: string;
  caseContext: CaseContext;
  /** The non-closed case on this subject, which the opportunity must link to (DA-A-3). */
  openClaim: Doc<"claims"> | null;
  /** That case's own currency (`lib/money.claimCurrency`: its own, else its purchase's; null when unknown — no default). */
  openClaimCurrency: string | null;
  /** What case opening needs for a retail price claim. */
  retail?: {
    purchaseId: Id<"purchases">; itemId: Id<"items">; policyId?: Id<"policies">; priceCheckId?: Id<"priceChecks">; observedMinor?: number; unitMinor?: number;
    /** DA-A-22 (M2C, D241): the lowest opening observation of the item's denied price claims (`deniedObservedMinor`). */
    deniedObservedMinor?: number;
  };
};

/**
 * DA-A-22 (M2C, D241): the opening observation (`openedFromPriceCheckId.observedCents`) of the user's DENIED price
 * claims among `claims` — the LOWEST, so a denial at any price blocks an automatic re-ask at or above it. Undefined when
 * none. Every R01 claim is opened from a price check (legacy `recordCheck` and `insertR01Case` both pass it), so a
 * denied R01 claim always carries one. Shared with priceWatch's legacy fallback (parity, C3).
 */
export async function deniedObservedMinor(
  ctx: QueryCtx,
  userId: Id<"users">,
  claims: readonly Doc<"claims">[],
): Promise<number | undefined> {
  let lowest: number | undefined;
  for (const c of claims) {
    if (c.userId !== userId || c.type !== "price_adjustment" || c.status !== "denied" || !c.openedFromPriceCheckId) continue;
    const pc = await ctx.db.get(c.openedFromPriceCheckId);
    if (pc?.observedCents === undefined) continue;
    if (lowest === undefined || pc.observedCents < lowest) lowest = pc.observedCents;
  }
  return lowest;
}

const itemIdOf = (subjectKey: string): Id<"items"> | null =>
  subjectKey.startsWith("item:") ? (subjectKey.slice(5) as Id<"items">) : null;

/** Legacy loss-key synthesis (§3.3): `item:<id>:price_diff:<n>`, n = 1 + the confirmed price claims created before it. */
export function legacyLossKeys(claim: Doc<"claims">, siblings: readonly Doc<"claims">[]): string[] {
  if (claim.lossKeys && claim.lossKeys.length > 0) return [...claim.lossKeys];
  if (claim.itemId === undefined) return []; // an item-less (scenario) claim always records its own keys
  if (claim.type === "return_credit") return [`item:${claim.itemId}:return_credit`];
  const confirmedBefore = siblings.filter(
    (c) => c.type === "price_adjustment" && c.status === "confirmed" && c._creationTime < claim._creationTime,
  ).length;
  return [`item:${claim.itemId}:price_diff:${confirmedBefore + 1}`];
}

async function r01Runs(ctx: QueryCtx, txn: Doc<"transactions">, subjects: readonly string[] | undefined): Promise<Run[]> {
  if (txn.category !== "retail_order" || txn.purchaseId === undefined) return [];
  const purchase = await ctx.db.get(txn.purchaseId);
  if (!purchase) return [];
  const itemIds = subjects?.map(itemIdOf).filter((x): x is Id<"items"> => x !== null);
  const snapshot = await loadRetailSnapshot(ctx, txn, itemIds === undefined ? {} : { itemIds });
  const policy = await latestPolicy(ctx, txn.userId, purchase.merchantDomain, "price_adjustment");
  const runs: Run[] = [];
  for (const item of snapshot.items.slice(0, MAX_ITEMS_PER_PURCHASE)) {
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_item_type_status", (q) => q.eq("itemId", item.itemId).eq("type", "price_adjustment"))
      .take(CLAIMS_PER_ITEM);
    const open = claims.filter((c) => c.userId === txn.userId && !isClosedForAsk(c)).sort((a, b) => b._creationTime - a._creationTime)[0] ?? null;
    const settledMinorByLossKey: Record<string, number> = {};
    for (const c of claims) {
      if (c.userId === txn.userId && c.status === "confirmed") settledMinorByLossKey[legacyLossKeys(c, claims)[0]] = c.expectedCents;
    }
    let opening: { amountMinor: number; currency: string; observedAt: number } | undefined;
    if (open?.openedFromPriceCheckId) {
      const pc = await ctx.db.get(open.openedFromPriceCheckId);
      if (pc && pc.observedCents !== undefined) opening = { amountMinor: pc.observedCents, currency: pc.currency ?? purchase.currency, observedAt: pc.observedAt };
    }
    // DA-A-22 (M2C, D241): after a denial only a strictly lower observation re-asks, for the difference (R01-10).
    const denied = await deniedObservedMinor(ctx, txn.userId, claims);
    const caseContext: R01CaseContext = {
      settledMinorByLossKey,
      ...(denied !== undefined ? { deniedObservedMinor: denied } : {}),
      ...(open
        ? {
            activeClaimId: open._id,
            activeClaim: {
              claimId: open._id,
              expectedMinor: open.expectedCents,
              currency: claimCurrency(open, purchase) ?? purchase.currency,
              lossKeys: legacyLossKeys(open, claims),
              ...(opening ? { opening } : {}),
            },
          }
        : {}),
    };
    const r01: R01Snapshot = {
      subjectKey: item.subjectKey,
      itemReturned: item.returned,
      purchaseDate: snapshot.purchaseDate,
      currency: snapshot.currency,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      itemName: item.name,
      observedPrice: item.observedPrice,
      observation: item.observation
        ? {
            ...(item.observation.variantMatch !== undefined ? { variantMatch: item.observation.variantMatch } : {}),
            ...(item.observation.confidence !== undefined ? { confidence: item.observation.confidence } : {}),
            observedAt: item.observation.observedAt,
            priceCheckId: item.observation.priceCheckId,
          }
        : null,
      policy: policy
        ? {
            policyId: policy._id,
            ...(policy.windowDays !== undefined ? { windowDays: policy.windowDays } : {}),
            retrievedAt: policy.retrievedAt,
            confirmedByUser: policy.confirmedByUser,
            sourceUrl: policy.sourceUrl,
          }
        : null,
    };
    // Values only (DA-A-15): the subject's cells + the parameter source, never row ids.
    const cellsHash = await snapshotHash({
      lookup: cellLookup([snapshot.purchaseDate, snapshot.currency, item.unitPrice, item.quantity, item.name, item.observedPrice]),
    });
    const factSnapshotHash = await canonicalHash({
      cells: cellsHash,
      policy: r01.policy ? { windowDays: r01.policy.windowDays ?? null, retrievedAt: r01.policy.retrievedAt, confirmedByUser: r01.policy.confirmedByUser } : null,
    });
    const unit = item.unitPrice.status === "candidate" || item.unitPrice.known ? item.unitPrice.value : null;
    const obs = item.observedPrice.status === "candidate" || item.observedPrice.known ? item.observedPrice.value : null;
    runs.push({
      subjectKey: item.subjectKey,
      snapshot: r01,
      factSnapshotHash,
      caseContext,
      openClaim: open,
      openClaimCurrency: open ? claimCurrency(open, purchase) : null,
      retail: {
        purchaseId: purchase._id,
        itemId: item.itemId,
        ...(policy ? { policyId: policy._id } : {}),
        ...(item.observation ? { priceCheckId: item.observation.priceCheckId } : {}),
        ...(obs?.kind === "money" ? { observedMinor: obs.amountMinor } : {}),
        ...(unit?.kind === "money" ? { unitMinor: unit.amountMinor } : {}),
        ...(denied !== undefined ? { deniedObservedMinor: denied } : {}),
      },
    });
  }
  return runs;
}

/**
 * M20 (D208): the runs of a wave-2 pack from the transaction's live fact rows, through its pure `adapter`. The rows are
 * read once per `evaluateTransaction` call (bounded by `MAX_LIVE_FACTS_PER_TRANSACTION`, four index ranges) and shared
 * by every adapter pack. Requested subjects filter the runs exactly (DA-A-32: an item-level change never re-runs a
 * transaction-level pack). CaseContext comes from the opportunity's linked cases (`claims.by_opportunity`, bounded):
 * the newest open one (the mandatory link, DA-A-3 generalised) and the settled amount per loss key.
 */
async function adapterRuns(
  ctx: QueryCtx,
  pack: AnyRulePack,
  txn: Doc<"transactions">,
  rows: () => Promise<readonly CellRow[]>,
  subjects?: readonly string[],
): Promise<Run[]> {
  if (!pack.adapter) return [];
  let relatedTransactionId: Id<"transactions"> | undefined;
  if (txn.relatedTransactionId) {
    // DA-A-29: server-set; still passed only when it is the same user's transaction.
    const related = await ctx.db.get(txn.relatedTransactionId);
    if (related && related.userId === txn.userId) relatedTransactionId = related._id;
  }
  const produced = pack.adapter.runs({
    transactionId: txn._id,
    ...(relatedTransactionId ? { relatedTransactionId } : {}),
    isExample: txn.isExample === true,
    rows: await rows(),
  });
  const wanted = subjects === undefined ? null : new Set(subjects);
  const out: Run[] = [];
  for (const r of produced) {
    if (wanted && !wanted.has(r.subjectKey)) continue;
    const opp = await ctx.db
      .query("opportunities")
      .withIndex("by_user_and_dedupe_key", (q) => q.eq("userId", txn.userId).eq("dedupeKey", dedupeKeyOf(txn._id, pack, r.subjectKey)))
      .unique();
    let open: Doc<"claims"> | null = null;
    const settledMinorByLossKey: Record<string, number> = {};
    if (opp) {
      const claims = await ctx.db
        .query("claims")
        .withIndex("by_opportunity", (q) => q.eq("opportunityId", opp._id))
        .take(CLAIMS_PER_OPPORTUNITY);
      for (const c of claims) {
        if (c.userId !== txn.userId) continue;
        if (!isClosedForAsk(c) && (open === null || c._creationTime > open._creationTime)) open = c;
        if (c.status === "confirmed") for (const k of c.lossKeys ?? []) settledMinorByLossKey[k] = (settledMinorByLossKey[k] ?? 0) + c.expectedCents;
      }
    }
    out.push({
      subjectKey: r.subjectKey,
      snapshot: r.snapshot,
      factSnapshotHash: await snapshotHash({ lookup: r.lookup }),
      caseContext: { settledMinorByLossKey, ...(open ? { activeClaimId: open._id } : {}) },
      openClaim: open,
      openClaimCurrency: open ? claimCurrency(open, null) : null,
    });
  }
  return out;
}

/** The transaction's live fact rows as resolution rows (values only; the owner's rows only). */
async function liveCellRows(ctx: QueryCtx, txn: Doc<"transactions">): Promise<CellRow[]> {
  const facts = await readLiveFacts(ctx, txn._id);
  return facts.filter((f) => f.userId === txn.userId).map((f) => ({ subjectKey: f.subjectKey, key: f.key, row: toResolveRow(f) }));
}

/** Subjects and snapshots per scenario: R01's legacy adapter, else the pack's facts adapter (D208). */
async function runsFor(
  ctx: QueryCtx,
  pack: AnyRulePack,
  txn: Doc<"transactions">,
  rows: () => Promise<readonly CellRow[]>,
  subjects?: readonly string[],
): Promise<Run[]> {
  if (pack.scenarioId === "R01") return await r01Runs(ctx, txn, subjects);
  return await adapterRuns(ctx, pack, txn, rows, subjects);
}

export function dedupeKeyOf(txnId: Id<"transactions">, pack: Pick<AnyRulePack, "scenarioId" | "remedyKey">, subjectKey: string, incidentId?: Id<"incidents">): string {
  return `${txnId}|${pack.scenarioId}|${pack.remedyKey}|${subjectKey}|${incidentId ?? "-"}`;
}

// ---------------------------------------------------------------------------
// evaluateTransaction
// ---------------------------------------------------------------------------

export type Evaluated = {
  opportunityId: Id<"opportunities">;
  evaluationId: Id<"evaluations">;
  result: EvaluationResult;
  pack: AnyRulePack;
  /** The claim linked in this call (DA-A-3), if any. */
  linkedClaimId: Id<"claims"> | null;
  activeClaimId: Id<"claims"> | null;
  material: boolean;
  appended: boolean;
  retail?: Run["retail"];
};

async function bumpClaim(ctx: MutationCtx, claimId: Id<"claims">, text: string): Promise<void> {
  const claim = await ctx.db.get(claimId);
  if (!claim || isClosedForAsk(claim)) return;
  await ctx.db.patch(claimId, { version: claim.version + 1 });
  await ctx.db.insert("claimNotes", { claimId, userId: claim.userId, kind: "status", text });
}

/** N3: an open or case_open opportunity whose pack is no longer active is superseded (material, once). */
async function supersedeWithdrawn(ctx: MutationCtx, txn: Doc<"transactions">, now: number): Promise<void> {
  const opps = await ctx.db
    .query("opportunities")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .take(OPPORTUNITIES_PER_TRANSACTION);
  for (const opp of opps) {
    if (opp.userId !== txn.userId || (opp.status !== "open" && opp.status !== "case_open")) continue;
    if (activePack(opp.scenarioId) !== null) continue;
    await ctx.db.patch(opp._id, { status: "superseded", activeClaimId: undefined, lastEvaluatedAt: now });
    if (opp.activeClaimId) {
      await bumpClaim(ctx, opp.activeClaimId, `${opp.scenarioId} checks were withdrawn; review and approve again.`);
    }
  }
}

/** D247: an unconfirmed candidate is decisive for this result (it was used, or it caps the outcome). */
const UNCONFIRMED_REASONS: ReadonlySet<string> = new Set(["candidate_unconfirmed", "conflict_capped"]);
export function hasUnconfirmedDecisive(result: Pick<EvaluationResult, "missingFacts">): boolean {
  return result.missingFacts.some((m) => UNCONFIRMED_REASONS.has(m.reason));
}

/**
 * D247 (DA note): the stored missing facts are unique per (subject, key, reason), `neededFor` merged — a pack may list
 * the same fact from two of its lists (R01 v1 lists a candidate purchase date from both the window's unknowns and the
 * decisive candidates). Applied before hashing, so the stored evaluation is what the card shows.
 */
function withUniqueMissingFacts(result: EvaluationResult): EvaluationResult {
  const out: EvaluationResult["missingFacts"] = [];
  for (const m of result.missingFacts) {
    const hit = out.find((x) => x.subjectKey === m.subjectKey && x.key === m.key && x.reason === m.reason);
    if (!hit) out.push({ ...m, neededFor: [...m.neededFor] });
    else for (const n of m.neededFor) if (!hit.neededFor.includes(n)) hit.neededFor.push(n);
  }
  return out.length === result.missingFacts.length ? result : { ...result, missingFacts: out };
}

/**
 * M20 (rev 5.2, D147(6)): `opportunities.reevaluateAt` for M29's sweep — for a `not_yet_due` result with
 * `reevaluate.at` ("YYYY-MM-DD"), the start of that date in UTC, which is no later than its start in any US zone (the
 * sweep may run a few hours early; a still-not-due result is simply recorded again). Undefined otherwise.
 */
export function reevaluateAtOf(result: Pick<EvaluationResult, "outcome" | "reevaluate">): number | undefined {
  const at = result.outcome === "not_yet_due" ? result.reevaluate?.at : undefined;
  if (at === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(at)) return undefined;
  const ms = Date.parse(`${at}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Materiality (§2.8 step 8) between the previous evaluation of an open case and the new result. */
export async function materialChange(
  prev: Pick<Doc<"evaluations">, "outcome" | "ruleVersion" | "engineVersion" | "deadlines" | "boundFacts">,
  next: EvaluationResult,
  nextBoundFactsHash: string,
  lateAskDeadlineIds: ReadonlySet<string>,
): Promise<string | null> {
  if (prev.ruleVersion !== next.ruleVersion) return `rule version ${prev.ruleVersion} → ${next.ruleVersion}`;
  if ((prev.engineVersion ?? null) !== next.engineVersion) return "evaluation engine changed";
  if (leavesApprovableSet(prev.outcome, next.outcome) && !isLateAskAcknowledgeable(next, lateAskDeadlineIds)) {
    return `result changed to ${next.outcome}`;
  }
  for (const d of next.deadlines) {
    if (d.obligor !== "user" || d.status !== "passed" || lateAskDeadlineIds.has(d.id)) continue;
    const before = prev.deadlines.find((x) => x.id === d.id);
    if (before && before.status !== "passed") return `deadline passed: ${d.label}`;
  }
  const prevHash = await boundFactsHash(prev.boundFacts ?? []);
  if (prevHash !== nextBoundFactsHash) return "the facts the claim relies on changed";
  return null;
}

export async function evaluateTransaction(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  trigger: EvaluationTrigger,
  now: number,
  opts: { subjects?: readonly string[]; freshCaseId?: Id<"claims"> } = {},
): Promise<Evaluated[]> {
  const txn = await ctx.db.get(transactionId);
  if (!txn) throw new ConvexError("Transaction not found");
  if (await isTombstoned(ctx, txn.userId)) return [];
  await supersedeWithdrawn(ctx, txn, now);
  if (txn.status === "archived") return [];

  const out: Evaluated[] = [];
  let rowsCache: Promise<CellRow[]> | null = null;
  const rows = () => (rowsCache ??= liveCellRows(ctx, txn));
  for (const pack of activePacksForCategory(txn.category)) {
    let runs: Run[];
    try {
      runs = await runsFor(ctx, pack, txn, rows, opts.subjects);
    } catch (error) {
      await recordRuleEvaluationFailure(ctx, { now, scenarioId: pack.scenarioId, ruleId: pack.ruleId, ruleVersion: pack.version, error, trigger, transactionId });
      continue;
    }
    for (const run of runs) {
      try {
        const e = await evaluateRun(ctx, txn, pack, run, trigger, now, opts.freshCaseId);
        if (e) out.push(e);
      } catch (error) {
        await recordRuleEvaluationFailure(ctx, { now, scenarioId: pack.scenarioId, ruleId: pack.ruleId, ruleVersion: pack.version, error, trigger, transactionId });
      }
    }
  }
  return out;
}

/**
 * DA-B-2 (D193): when the linked claim asks more than the re-evaluated `exact_formula` estimate, the pack's
 * `continue_case` becomes `review_amount` (adjust or acknowledge before sending). The comparison is M13b's one shared
 * predicate, called exactly as `drafts` calls it on the linked claim's current evaluation, so the card and the send
 * gate never disagree; it is never true across currencies. Applied before hashing, so the stored evaluation (and its
 * result hash) is what the card shows; `materialChange` ignores next actions, so adjusting the ask bumps nothing.
 */
function withAmountReview(run: Run, result: EvaluationResult): EvaluationResult {
  const next = result.nextAction;
  const claim = run.openClaim;
  if (next.kind !== "continue_case" || claim === null || claim._id !== next.claimId) return result;
  const review = amountExceedsEstimate({ expectedCents: claim.expectedCents, currency: run.openClaimCurrency }, result.amount);
  if (!review.exceeds) return result;
  return {
    ...result,
    nextAction: {
      kind: "review_amount",
      claimId: next.claimId,
      claimedMinor: review.claimed.amountMinor,
      estimateMinor: review.estimate.amountMinor,
      currency: review.claimed.currency,
    },
  };
}

async function evaluateRun(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  pack: AnyRulePack,
  run: Run,
  trigger: EvaluationTrigger,
  now: number,
  freshCaseId?: Id<"claims">,
): Promise<Evaluated | null> {
  const dedupeKey = dedupeKeyOf(txn._id, pack, run.subjectKey);
  const existing = await ctx.db
    .query("opportunities")
    .withIndex("by_user_and_dedupe_key", (q) => q.eq("userId", txn.userId).eq("dedupeKey", dedupeKey))
    .unique();

  // Case-state sync before evaluating: closures (§2.8), then the mandatory link (DA-A-3).
  const closure = existing ? await closurePatch(ctx, existing) : {};
  const priorActive = existing && !("activeClaimId" in closure) ? existing.activeClaimId ?? null : null;
  const linking = run.openClaim !== null && run.openClaim._id !== priorActive;
  const activeClaimId: Id<"claims"> | null = run.openClaim?._id ?? null;

  const result: EvaluationResult = withUniqueMissingFacts(withAmountReview(run, pack.evaluate({
    snapshot: run.snapshot,
    snapshotHash: run.factSnapshotHash,
    pack: { ruleId: pack.ruleId, scenarioId: pack.scenarioId, version: pack.version, params: pack.params, sources: pack.sources },
    verification: VERIFICATION,
    engineVersion: engineVersionFor(pack.ruleId, pack.version),
    remedyKey: pack.remedyKey,
    subjectKey: run.subjectKey,
    caseContext: run.caseContext,
    now,
  })));
  assertEvaluationBounds(result);
  const bfh = await boundFactsHash(result.boundFacts);
  const rh = await resultHash(result, bfh);

  const lossKeys = result.lossKeys.slice(0, MAX_LOSS_KEYS);
  const showsEstimate = result.amount !== null && isApprovable(result.outcome);
  const projection = {
    ruleId: pack.ruleId,
    ruleVersion: pack.version,
    outcome: result.outcome,
    authorityClass: pack.authority.class,
    remedyType: pack.remedyType,
    cashClass: pack.cashClass,
    estimate: showsEstimate ? result.amount!.estimate : undefined,
    nextDeadlineAt: nextUserDeadlineAt(result.deadlines),
    nextCounterpartyDueAt: nextCounterpartyDueAt(result.deadlines),
    lossKeys,
    lastEvaluatedAt: now,
    reevaluateAt: reevaluateAtOf(result),
    decisiveUnconfirmed: hasUnconfirmedDecisive(result) ? true : undefined,
  };

  let opp: Doc<"opportunities">;
  if (!existing) {
    const id = await ctx.db.insert("opportunities", {
      userId: txn.userId,
      transactionId: txn._id,
      scenarioId: pack.scenarioId,
      remedyKey: pack.remedyKey,
      subjectKey: run.subjectKey,
      dedupeKey,
      status: activeClaimId ? "case_open" : "open",
      ...projection,
      ...(activeClaimId ? { activeClaimId } : {}),
      ...(txn.isExample ? { isExample: true } : {}),
    });
    opp = (await ctx.db.get(id))!;
  } else {
    opp = { ...existing, ...closure } as Doc<"opportunities">;
    let status = opp.status;
    if (activeClaimId) status = "case_open";
    else if (status === "case_open") status = "open";
    else if (status === "superseded") status = "open"; // the pack is active again
    else if (status === "closed" && lossKeys.join("|") !== existing.lossKeys.join("|") && isApprovable(result.outcome)) {
      status = "open"; // a further loss on the same subject (R01: price_diff:n+1)
    }
    // D226: the first evaluation of a denied loss without its case records the denied basis (its resultHash).
    const denialBasis = existing.deniedAt !== undefined && existing.deniedResultHash === undefined && activeClaimId === null;
    await ctx.db.patch(existing._id, {
      ...projection,
      status,
      activeClaimId: activeClaimId ?? undefined,
      ...(denialBasis ? { deniedResultHash: rh } : {}),
    });
    opp = { ...opp, ...projection, status, activeClaimId: activeClaimId ?? undefined };
  }

  // DA-A-3: link the legacy (or re-opened) case to this opportunity.
  if (linking && run.openClaim) {
    const c = run.openClaim;
    await ctx.db.patch(c._id, {
      opportunityId: opp._id,
      transactionId: txn._id,
      scenarioId: pack.scenarioId,
      remedyKey: pack.remedyKey,
      lossKeys: c.lossKeys && c.lossKeys.length > 0 ? c.lossKeys : lossKeys,
      ...(c.currency === undefined && txn.currency ? { currency: txn.currency } : {}),
    });
  }

  // Append only on a changed result (DA-A-32).
  const prev = existing?.currentEvaluationId ? await ctx.db.get(existing.currentEvaluationId) : null;
  let evaluationId = prev?._id ?? null;
  let appended = false;
  if (!prev || prev.resultHash !== rh) {
    evaluationId = await recordEvaluation(ctx, {
      userId: txn.userId, opportunityId: opp._id, result, trigger: linking ? "link" : trigger, now,
      factSnapshotHash: run.factSnapshotHash, resultHash: rh,
    });
    appended = true;
    await ctx.db.patch(opp._id, { currentEvaluationId: evaluationId });
  }

  // Materiality: only for a case that was already open (and evaluated as such) before this call — never for the
  // link run, nor for the baseline run right after `openCase` created the claim (its bound facts appear first there).
  let material = false;
  if (prev && priorActive !== null && !linking && activeClaimId === priorActive && appended && priorActive !== freshCaseId) {
    const reason = await materialChange(prev, result, bfh, new Set(pack.lateAskDeadlineIds));
    if (reason) {
      material = true;
      await bumpClaim(ctx, priorActive, `Recoup's ${pack.scenarioId} check changed (${reason}); review and approve again.`);
    }
  }

  return {
    opportunityId: opp._id,
    evaluationId: evaluationId!,
    result,
    pack,
    linkedClaimId: linking ? run.openClaim!._id : null,
    activeClaimId,
    material,
    appended,
    ...(run.retail ? { retail: run.retail } : {}),
  };
}

/** Every evaluation entry point for a purchase: the transaction first (M11, DA-A-35), then evaluate. */
export async function evaluatePurchase(
  ctx: MutationCtx,
  purchaseId: Id<"purchases">,
  trigger: EvaluationTrigger,
  now: number,
  opts: { subjects?: readonly string[] } = {},
): Promise<Evaluated[]> {
  const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
  return await evaluateTransaction(ctx, transactionId, trigger, now, opts);
}

// ---------------------------------------------------------------------------
// Case opening (§2.8 openCase) and the R01 auto-open guard (§2.8 recordCheck order)
// ---------------------------------------------------------------------------

export type OpenCaseResult =
  | { ok: true; claimId: Id<"claims">; created: boolean; notice?: string }
  | { ok: false; code: "not_approvable" | "not_yet_due" | "overlap" | "unsupported_scenario" | "closed" | "no_amount" | "example" | "unconfirmed_facts"; message: string; nextAction?: NextAction };

/**
 * DA-A-4 / DA-A-29 overlap guard: the user's own active claims on this transaction and on its server-set related
 * transaction. An intersection with no declared relation is `alternative` → refused; `coordinated` only with a source
 * passage → allowed with a notice; `primary_secondary` → refused until the primary is closed.
 */
export async function overlapCheck(
  ctx: QueryCtx,
  userId: Id<"users">,
  txn: Doc<"transactions">,
  pack: AnyRulePack,
  lossKeys: readonly string[],
  ignoreClaimId: Id<"claims"> | null,
): Promise<{ refused: string | null; notice: string | null }> {
  const txnIds: Id<"transactions">[] = [txn._id];
  if (txn.relatedTransactionId) {
    // DA-A-29: a related transaction counts only if it is the caller's own (it is server-set, never client input).
    const related = await ctx.db.get(txn.relatedTransactionId);
    if (related && related.userId === userId) txnIds.push(related._id);
  }
  const keys = new Set(lossKeys);
  let notice: string | null = null;
  for (const tid of txnIds) {
    const claims = await ctx.db
      .query("claims")
      .withIndex("by_transaction_and_status", (q) => q.eq("transactionId", tid))
      .take(OVERLAP_CLAIMS);
    for (const c of claims) {
      if (c.userId !== userId || c._id === ignoreClaimId || isClosedForAsk(c)) continue;
      if (!(c.lossKeys ?? []).some((k) => keys.has(k))) continue;
      const decl = pack.overlap.find((o) => o.withScenario === c.scenarioId && o.withRemedyKey === c.remedyKey);
      const via = `${c.scenarioId ?? c.type} (${c.remedyKey ?? c.type})`;
      if (decl?.relation === "coordinated" && decl.sourcePassageId) {
        notice = `This loss is also claimed via ${via}; the rules coordinate the two (${decl.sourcePassageId}).`;
        continue;
      }
      if (decl?.relation === "primary_secondary") return { refused: `Close your claim via ${via} first; this path is secondary to it.`, notice: null };
      return { refused: `You already have an active claim for this loss via ${via}.`, notice: null };
    }
  }
  return { refused: null, notice };
}

/**
 * Opens the R01 claim for an evaluated opportunity: `claims.openClaim` (the legacy writer, ownership + D44 checks),
 * then the link fields, then `activeClaimId` — all in the caller's mutation.
 */
async function insertR01Case(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  e: Evaluated,
  amountMinor: number,
): Promise<Id<"claims">> {
  const retail = e.retail;
  if (!retail) throw new ConvexError("This opportunity cannot open a claim");
  const window = e.result.deadlines.find((d) => d.id === R01_V1_WINDOW_ID);
  const windowEndsAt = window?.dueAt ?? (window?.advisoryActBy ? Date.parse(window.advisoryActBy) : undefined);
  const claimId = await openClaim(ctx, {
    userId: txn.userId,
    purchaseId: retail.purchaseId,
    itemId: retail.itemId,
    type: "price_adjustment",
    expectedCents: amountMinor,
    ...(windowEndsAt !== undefined && Number.isFinite(windowEndsAt) ? { windowEndsAt } : {}),
    ...(retail.policyId ? { policyId: retail.policyId } : {}),
    ...(retail.priceCheckId ? { openedFromPriceCheckId: retail.priceCheckId } : {}),
    ...(txn.isExample ? { isExample: true } : {}),
  });
  await ctx.db.patch(claimId, {
    transactionId: txn._id,
    opportunityId: e.opportunityId,
    scenarioId: e.pack.scenarioId,
    remedyKey: e.pack.remedyKey,
    currency: e.result.amount?.estimate.currency ?? txn.currency,
    lossKeys: e.result.lossKeys.slice(0, MAX_LOSS_KEYS),
  });
  await ctx.db.patch(e.opportunityId, { activeClaimId: claimId, status: "case_open" });
  return claimId;
}

/**
 * The shared case-opening core: approvability, the overlap guard, the amount, the insert, and a re-evaluation with
 * the new case (trigger case_open; not material — the claim was just created at this version).
 */
async function openFromEvaluation(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  e: Evaluated,
  now: number,
  claimedAmount: number | undefined,
): Promise<OpenCaseResult> {
  if (e.activeClaimId) return { ok: true, claimId: e.activeClaimId, created: false };
  if (e.result.outcome === "not_yet_due") {
    return { ok: false, code: "not_yet_due", message: "This path is not ripe yet.", nextAction: e.result.nextAction };
  }
  if (!isApprovable(e.result.outcome)) {
    return { ok: false, code: "not_approvable", message: `A claim cannot be opened while the result is ${e.result.outcome}.`, nextAction: e.result.nextAction };
  }
  if (e.pack.scenarioId !== "R01" && !e.pack.adapter) {
    return { ok: false, code: "unsupported_scenario", message: "This kind of case cannot be opened yet." };
  }
  // D247: never a claim on facts the user has not confirmed (the legacy D25 invariant, for every pack): a decisive
  // unconfirmed candidate refuses, and an R01 case also needs a confirmed (active) purchase.
  if (hasUnconfirmedDecisive(e.result)) {
    const keys = [...new Set(e.result.missingFacts.filter((m) => UNCONFIRMED_REASONS.has(m.reason)).map((m) => m.key))];
    return { ok: false, code: "unconfirmed_facts", message: `Confirm these details first: ${keys.join(", ")}.`, nextAction: e.result.nextAction };
  }
  if (e.retail) {
    const purchase = await ctx.db.get(e.retail.purchaseId);
    if (!purchase || purchase.status !== "active") {
      return { ok: false, code: "unconfirmed_facts", message: "Confirm the purchase first; a claim is opened only on a purchase you have reviewed." };
    }
  }
  let amount: number;
  if (e.result.amount?.basis === "user_claimed") {
    if (claimedAmount === undefined) return { ok: false, code: "no_amount", message: "Enter the amount you are claiming." };
    amount = assertUserAmount(claimedAmount, "claimed amount");
  } else {
    if (claimedAmount !== undefined) throw new ConvexError("This claim's amount is calculated by the rule; it cannot be entered");
    if (!e.result.amount || e.result.amount.estimate.amountMinor <= 0) return { ok: false, code: "no_amount", message: "There is no amount to claim." };
    amount = e.result.amount.estimate.amountMinor;
  }
  const overlap = await overlapCheck(ctx, txn.userId, txn, e.pack, e.result.lossKeys, null);
  if (overlap.refused) return { ok: false, code: "overlap", message: overlap.refused };
  const claimId =
    e.pack.scenarioId === "R01"
      ? await insertR01Case(ctx, txn, e, amount)
      : await insertScenarioClaim(ctx, {
          userId: txn.userId,
          transactionId: txn._id,
          opportunityId: e.opportunityId,
          ruleId: e.pack.ruleId,
          ruleVersion: e.pack.version,
          scenarioId: e.pack.scenarioId,
          remedyKey: e.pack.remedyKey,
          expectedMinor: amount,
          currency: e.result.amount?.estimate.currency ?? txn.currency,
          lossKeys: e.result.lossKeys.slice(0, MAX_LOSS_KEYS),
          requiredChannel: e.pack.requiredChannel?.(e.result) ?? "email",
          caseMode: e.pack.caseMode?.(e.result) ?? "request",
          ...(txn.isExample ? { isExample: true } : {}),
        });
  await evaluateTransaction(ctx, txn._id, "case_open", now, { subjects: [e.result.subjectKey], freshCaseId: claimId });
  return { ok: true, claimId, created: true, ...(overlap.notice ? { notice: overlap.notice } : {}) };
}

/**
 * The R01 auto-open (recordCheck, §2.8): after `evaluateTransaction` (which linked any legacy claim), open through
 * the openCase guard — approvable (so never past the window, R01-05c, and never not_yet_due), an amount, no open
 * claim on the item. The caller has already applied the legacy eligibility gates (active, non-example purchase;
 * open window at write time).
 */
export async function autoOpenR01(
  ctx: MutationCtx,
  e: Evaluated,
  now: number,
): Promise<{ claimId: Id<"claims"> | null; note?: string }> {
  const decision = r01AutoOpen(e.result, {
    openClaimExists: e.activeClaimId !== null,
    ...(e.retail?.observedMinor !== undefined ? { observedMinor: e.retail.observedMinor } : {}),
    ...(e.retail?.unitMinor !== undefined ? { unitMinor: e.retail.unitMinor } : {}),
    ...(e.retail?.deniedObservedMinor !== undefined ? { deniedObservedMinor: e.retail.deniedObservedMinor } : {}),
  });
  if (!decision.opens) return { claimId: null, ...(decision.note ? { note: decision.note } : {}) };
  const opp = await ctx.db.get(e.opportunityId);
  const txn = opp ? await ctx.db.get(opp.transactionId) : null;
  if (!txn) return { claimId: null };
  const opened = await openFromEvaluation(ctx, txn, e, now, undefined);
  return opened.ok ? { claimId: opened.claimId } : { claimId: null, note: opened.message };
}

// ---------------------------------------------------------------------------
// Internal triggers (M20): scheduled re-evaluation, and the reevaluateAt sweep M29 wires to a cron
// ---------------------------------------------------------------------------

const evaluationTrigger = schema.tables.evaluations.validator.fields.trigger;

/**
 * Re-evaluates one transaction in its own transaction — scheduled by writers that must not import this module (e.g.
 * `claims.recordNonCashResolution` after writing a pack's acceptance fact). Tombstone and archive checks are
 * `evaluateTransaction`'s.
 */
export const evaluateInternal = internalMutation({
  args: { transactionId: v.id("transactions"), trigger: evaluationTrigger, subjects: v.optional(v.array(v.string())) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const txn = await ctx.db.get(args.transactionId);
    if (!txn) return null;
    await evaluateTransaction(ctx, txn._id, args.trigger, Date.now(), args.subjects ? { subjects: args.subjects } : {});
    return null;
  },
});

/**
 * rev 5.2 (D147(6)) — a STUB of the sweep's evaluation half for M29's cron (M29 owns crons.ts and may replace it):
 * open opportunities whose `reevaluateAt` ≤ now, one bounded page on `by_status_and_reevaluate_at`, each opportunity's
 * subject evaluated once per transaction, recorded with trigger `fact_change` (the trigger a `reevaluate.when` event
 * uses). Returns how many transactions it evaluated.
 */
export const sweepReevaluateDue = internalMutation({
  args: { now: v.number() },
  returns: v.object({ transactions: v.number() }),
  handler: async (ctx, { now }) => {
    const due = await ctx.db
      .query("opportunities")
      .withIndex("by_status_and_reevaluate_at", (q) => q.eq("status", "open").gt("reevaluateAt", 0).lte("reevaluateAt", now))
      .take(REEVALUATE_PAGE);
    const seen = new Set<string>();
    for (const opp of due) {
      if (seen.has(opp.transactionId)) continue;
      seen.add(opp.transactionId);
      await evaluateTransaction(ctx, opp.transactionId, "fact_change", now, { subjects: [opp.subjectKey] });
    }
    return { transactions: seen.size };
  },
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const openCaseResult = v.union(
  v.object({ ok: v.literal(true), claimId: v.id("claims"), created: v.boolean(), notice: v.optional(v.string()) }),
  v.object({
    ok: v.literal(false),
    code: v.union(
      v.literal("not_approvable"), v.literal("not_yet_due"), v.literal("overlap"), v.literal("unsupported_scenario"),
      v.literal("closed"), v.literal("no_amount"), v.literal("example"), v.literal("unconfirmed_facts"),
    ),
    message: v.string(),
    nextAction: v.optional(schema.tables.evaluations.validator.fields.nextAction),
  }),
);

/**
 * Opens (or returns) the case for one of the caller's opportunities (§2.8 openCase). Ownership, tombstone and example
 * checks come first, then the per-user `evaluate` rate limit, then a re-evaluation that is COMMITTED; a policy refusal
 * is returned, never thrown, so the evaluation survives (DA-A-14 pattern). A foreign or missing id → the identical
 * "Opportunity not found", before the limiter is charged.
 */
export const openCase = mutation({
  args: { opportunityId: v.id("opportunities"), claimedAmount: v.optional(v.number()) },
  returns: openCaseResult,
  handler: async (ctx, args): Promise<OpenCaseResult> => {
    const userId = await requireUserId(ctx);
    const opp = await ownedOpportunity(ctx, args.opportunityId, userId);
    if (opp.isExample) return { ok: false, code: "example", message: "Examples never open real claims." };
    // M03 §3.7: every public re-evaluation is limited per user (M13's `evaluate` bucket, 60/min).
    const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
    if (!limit.ok) throw new ConvexError("Too many checks in a short time. Try again in a minute.");
    if (opp.status === "dismissed" || opp.status === "superseded") {
      return { ok: false, code: "closed", message: "This opportunity is no longer open." };
    }
    const now = Date.now();
    const txn = await ownedTransaction(ctx, opp.transactionId, userId);
    const evaluated = await evaluateTransaction(ctx, txn._id, "case_open", now, { subjects: [opp.subjectKey] });
    const e = evaluated.find((x) => x.opportunityId === opp._id);
    if (!e) return { ok: false, code: "closed", message: "This opportunity is no longer evaluated." };
    return await openFromEvaluation(ctx, txn, e, now, args.claimedAmount);
  },
});

/**
 * The UI's explicit "check again" (trigger `user_request`) for one of the caller's purchases or transactions:
 * ownership and tombstone first (identical not-found for foreign or missing ids), then the per-user `evaluate` bucket,
 * then `ensurePurchaseTransaction` (a legacy purchase gets its transaction here) and an evaluation. Nothing opens:
 * case opening is `openCase`.
 */
export const reevaluate = mutation({
  args: { purchaseId: v.optional(v.id("purchases")), transactionId: v.optional(v.id("transactions")) },
  returns: v.object({ evaluated: v.number() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    if ((args.purchaseId === undefined) === (args.transactionId === undefined)) {
      throw new ConvexError("Give exactly one of purchaseId or transactionId");
    }
    let transactionId: Id<"transactions">;
    if (args.purchaseId !== undefined) {
      await ownedPurchase(ctx, args.purchaseId, userId);
      const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
      if (!limit.ok) throw new ConvexError("Too many checks in a short time. Try again in a minute.");
      transactionId = await ensurePurchaseTransaction(ctx, args.purchaseId);
    } else {
      await ownedTransaction(ctx, args.transactionId!, userId);
      const limit = await rateLimiter.limit(ctx, "evaluate", { key: userId });
      if (!limit.ok) throw new ConvexError("Too many checks in a short time. Try again in a minute.");
      transactionId = args.transactionId!;
    }
    const evaluated = await evaluateTransaction(ctx, transactionId, "user_request", Date.now());
    return { evaluated: evaluated.length };
  },
});

/** The caller dismisses an opportunity with no open case; it stays dismissed (§2.8 Closing). */
export const dismiss = mutation({
  args: { opportunityId: v.id("opportunities") },
  returns: v.null(),
  handler: async (ctx, { opportunityId }) => {
    const userId = await requireUserId(ctx);
    const opp = await ownedOpportunity(ctx, opportunityId, userId);
    if (opp.activeClaimId) {
      const claim = await ctx.db.get(opp.activeClaimId);
      if (claim && !isClosedForAsk(claim)) throw new ConvexError("Dismiss the open claim instead");
    }
    await ctx.db.patch(opportunityId, { status: "dismissed", activeClaimId: undefined });
    return null;
  },
});

const coverageRow = v.object({
  scenarioId: schema.tables.opportunities.validator.fields.scenarioId,
  title: v.string(),
  status: v.union(v.literal("implemented_verified"), v.literal("implemented_live_unverified"), v.literal("not_checked")),
  reason: v.string(),
  ruleId: v.optional(v.string()),
  version: v.optional(v.number()),
});
const opportunityView = v.object({
  opportunity: schema.doc("opportunities"),
  evaluation: v.union(schema.doc("evaluations"), v.null()),
});
const transactionView = v.object({
  opportunities: v.array(opportunityView),
  pathsNotChecked: v.array(coverageRow),
  truncated: v.boolean(),
});

async function viewFor(ctx: QueryCtx, txn: Doc<"transactions">) {
  const opps = await ctx.db
    .query("opportunities")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .take(OPPORTUNITIES_PER_TRANSACTION + 1);
  const shown: Infer<typeof opportunityView>[] = [];
  for (const o of opps.slice(0, OPPORTUNITIES_PER_TRANSACTION)) {
    // No card without an active pack (§2.7); superseded/dismissed rows are history, not cards.
    if (o.userId !== txn.userId || o.status === "superseded" || o.status === "dismissed" || !isPackActive(o.ruleId, o.ruleVersion)) continue;
    shown.push({ opportunity: o, evaluation: o.currentEvaluationId ? await ctx.db.get(o.currentEvaluationId) : null });
  }
  return { opportunities: shown, pathsNotChecked: pathsNotChecked(txn.category), truncated: opps.length > OPPORTUNITIES_PER_TRANSACTION };
}

/** Opportunity cards (active packs only) + "Paths not checked" (no amounts) for one of the caller's transactions. */
/** D220: rows `listMine` returns at most (the dashboard's open-opportunity cap). */
export const LIST_MINE_MAX = 200;

const listMineItem = v.object({
  opportunity: schema.doc("opportunities"),
  evaluation: v.union(schema.doc("evaluations"), v.null()),
  transactionId: v.id("transactions"),
  category: schema.tables.transactions.validator.fields.category,
  counterpartyName: v.string(),
});

/**
 * D220 (M24's /opportunities page): the caller's `open` and `case_open` opportunities (or the requested subset), each
 * with its current evaluation, transaction id, category and counterparty. Owner-scoped (`by_user_and_status`, no ids
 * taken); no card without an active pack (§2.7) and none on an archived transaction; newest evaluation first;
 * at most `LIST_MINE_MAX` rows with `truncated` on a real cut.
 */
export const listMine = query({
  args: { statuses: v.optional(v.array(v.union(v.literal("open"), v.literal("case_open")))) },
  returns: v.object({ items: v.array(listMineItem), truncated: v.boolean() }),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const statuses: ("open" | "case_open")[] = [...new Set(args.statuses ?? (["open", "case_open"] as const))];
    let truncated = false;
    const rows: Doc<"opportunities">[] = [];
    for (const status of statuses) {
      const page = await ctx.db
        .query("opportunities")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", status))
        .order("desc")
        .take(LIST_MINE_MAX + 1);
      if (page.length > LIST_MINE_MAX) truncated = true;
      rows.push(...page.slice(0, LIST_MINE_MAX));
    }
    const live = rows.filter((o) => isPackActive(o.ruleId, o.ruleVersion)).sort((a, b) => b.lastEvaluatedAt - a.lastEvaluatedAt);
    if (live.length > LIST_MINE_MAX) truncated = true;
    const txns = new Map<Id<"transactions">, Doc<"transactions"> | null>();
    const items = [];
    for (const opportunity of live.slice(0, LIST_MINE_MAX)) {
      if (!txns.has(opportunity.transactionId)) txns.set(opportunity.transactionId, await ctx.db.get(opportunity.transactionId));
      const txn = txns.get(opportunity.transactionId)!;
      if (!txn || txn.userId !== userId || txn.status === "archived") continue;
      const ev = opportunity.currentEvaluationId ? await ctx.db.get(opportunity.currentEvaluationId) : null;
      items.push({
        opportunity,
        evaluation: ev && ev.userId === userId ? ev : null,
        transactionId: txn._id,
        category: txn.category,
        counterpartyName: txn.counterpartyName,
      });
    }
    return { items, truncated };
  },
});

export const forTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: transactionView,
  handler: async (ctx, { transactionId }) => {
    const userId = await requireUserId(ctx);
    const txn = await ownedTransaction(ctx, transactionId, userId);
    return await viewFor(ctx, txn);
  },
});

/** The same for a purchase (its mirrored transaction; none yet → an empty card list and the not-checked paths). */
export const forPurchase = query({
  args: { purchaseId: v.id("purchases") },
  returns: transactionView,
  handler: async (ctx, { purchaseId }) => {
    const userId = await requireUserId(ctx);
    await ownedPurchase(ctx, purchaseId, userId);
    const txn = await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).first();
    if (!txn || txn.userId !== userId) return { opportunities: [], pathsNotChecked: pathsNotChecked("retail_order"), truncated: false };
    return await viewFor(ctx, txn);
  },
});

/** One of the caller's opportunities with its current evaluation. */
export const get = query({
  args: { opportunityId: v.id("opportunities") },
  returns: opportunityView,
  handler: async (ctx, { opportunityId }) => {
    const userId = await requireUserId(ctx);
    const opportunity = await ownedOpportunity(ctx, opportunityId, userId);
    return { opportunity, evaluation: opportunity.currentEvaluationId ? await ctx.db.get(opportunity.currentEvaluationId) : null };
  },
});
