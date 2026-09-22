/**
 * `recovery.summary({ now })` — THE one server function behind every money number on the dashboard (contract rev 5.5
 * §3.4, SEC-MF-1; DA-A-4, DA-A-17, DA-A-34, D145, C4).
 *
 *   nodes(c)  = claims(currency c, not dismissed) ∪ opportunities(c, status open, outcome ∈ {eligible,
 *               likely_eligible}, estimate, cash, no activeClaimId, transaction not archived)
 *   K         = connected components over shared lossKeys (union-find); a legacy claim's keys are synthesized
 *   net       = max(0, confirmed − debited)
 *   lossAll   = max(claim expected, opportunity estimate) over K     lossOpen = the same over OPEN members
 *   recovered = min(Σ net, lossAll)                                   excess = Σ net − recovered (never erased)
 *   outstanding = K has an open member ? max(0, lossOpen − recovered) : 0
 *   tile(K)   = furthest state over open members: promised > asked > sending_or_unknown > ready > potential;
 *               `ready` is the CATCH-ALL for every open claim not in a higher tile (C4)
 *   provisional(K) = min(outstanding(K), Σ provisional) — shown "of which provisional" inside tile(K)
 *   per-transaction cap: Σ (recovered + outstanding) over the components anchored on a transaction ≤ its confirmed
 *               paid total (retail: a confirmed `retail.order_total`, else Σ unit × qty labelled partial); the
 *               excess comes off outstanding in the order potential → ready → sending → asked → promised
 *
 * Alternatives (components) count once across ALL tiles, including components with cases. Currencies are never
 * summed or converted. Examples are excluded (claims.isExample for ledger and non-cash rows, opportunities.isExample).
 * `not_yet_due` is never a money tile (only a count). Reads are bounded: claims `by_user` ≤ 200 and open opportunities
 * ≤ 200; a real cut reports `complete: false`. The query never reads the clock: `now` is a coarse client argument
 * used only for the "deadlines this week" strip. `purchases.board` totals are untouched (D145, D39).
 */
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserId } from "./lib/access";
import { ASKED_DELIVERIES, delivery, isClosedForAsk, SENDING_DELIVERIES, type Delivery } from "./lib/claimState";
import { balance, provisionalOutstanding, type LedgerEvent } from "./lib/ledger";
import { claimCurrency } from "./lib/money";
import { MAX_ITEMS_PER_PURCHASE, SUMMARY_MAX_CLAIMS, SUMMARY_MAX_OPEN_OPPORTUNITIES } from "./limits";
import { legacyLossKeys } from "./opportunities";

export const TILES = ["potential", "ready", "sendingOrUnknown", "asked", "promised"] as const;
export type Tile = (typeof TILES)[number];
/** Highest first: the furthest state wins (DA-A-17). */
const TILE_RANK: Record<Tile, number> = { potential: 0, ready: 1, sendingOrUnknown: 2, asked: 3, promised: 4 };

export interface SummaryClaim {
  id: string;
  currency: string;
  status: string;
  expectedMinor: number;
  lossKeys: readonly string[];
  confirmedMinor: number;
  debitedMinor: number;
  promisedMinor: number;
  provisionalMinor: number;
  delivery: Delivery;
  closedForAsk: boolean;
  /** The transaction the paid money sits on (`purchase:<id>` for retail, else `txn:<id>`). */
  anchor: string | null;
}

export interface SummaryOpportunity {
  id: string;
  currency: string;
  estimateMinor: number;
  lossKeys: readonly string[];
  anchor: string | null;
}

export interface PaidTotal {
  amountMinor: number;
  currency: string;
  /** Item totals only (tax and shipping unknown): "cap based on item prices only". */
  partial: boolean;
}

export interface Component {
  claims: SummaryClaim[];
  opportunities: SummaryOpportunity[];
  lossKeys: string[];
  anchor: string | null;
  recovered: number;
  excess: number;
  outstanding: number;
  provisional: number;
  /** Null when the component has no open member. */
  tile: Tile | null;
  userReportedOnly: boolean;
}

export interface CurrencySummary {
  currency: string;
  recoveredMinor: number;
  overCreditMinor: number;
  tiles: Record<Tile, { amountMinor: number; provisionalMinor: number; components: number }>;
  askedUserReportedMinor: number;
  cappedAtPaidTotal: boolean;
  paidTotalPartial: boolean;
}

const netOf = (c: SummaryClaim) => Math.max(0, c.confirmedMinor - c.debitedMinor);

/** Union-find over shared loss keys, within one currency. */
export function components(claims: readonly SummaryClaim[], opps: readonly SummaryOpportunity[]): Component[] {
  type Node = { kind: "claim"; c: SummaryClaim } | { kind: "opp"; o: SummaryOpportunity };
  const nodes: Node[] = [...claims.map((c) => ({ kind: "claim" as const, c })), ...opps.map((o) => ({ kind: "opp" as const, o }))];
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byKey = new Map<string, number>();
  nodes.forEach((n, i) => {
    const keys = n.kind === "claim" ? n.c.lossKeys : n.o.lossKeys;
    // A node with no loss key is its own loss.
    for (const k of keys) {
      const j = byKey.get(k);
      if (j === undefined) byKey.set(k, i);
      else parent[find(i)] = find(j);
    }
  });
  const groups = new Map<number, Node[]>();
  nodes.forEach((n, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), n]);
  });
  return [...groups.values()].map((members) => {
    const cs = members.filter((m): m is Extract<Node, { kind: "claim" }> => m.kind === "claim").map((m) => m.c);
    const os = members.filter((m): m is Extract<Node, { kind: "opp" }> => m.kind === "opp").map((m) => m.o);
    const openClaims = cs.filter((c) => !c.closedForAsk);
    const lossAll = Math.max(0, ...cs.map((c) => c.expectedMinor), ...os.map((o) => o.estimateMinor));
    const lossOpen = Math.max(0, ...openClaims.map((c) => c.expectedMinor), ...os.map((o) => o.estimateMinor));
    const sumNet = cs.reduce((a, c) => a + netOf(c), 0);
    const recovered = Math.min(sumNet, lossAll);
    const hasOpen = openClaims.length > 0 || os.length > 0;
    const outstanding = hasOpen ? Math.max(0, lossOpen - recovered) : 0;
    let tile: Tile | null = null;
    if (hasOpen) {
      if (openClaims.some((c) => c.status === "promised" && c.promisedMinor > netOf(c))) tile = "promised";
      else if (openClaims.some((c) => ASKED_DELIVERIES.has(c.delivery))) tile = "asked";
      else if (openClaims.some((c) => SENDING_DELIVERIES.has(c.delivery))) tile = "sendingOrUnknown";
      else if (openClaims.length > 0) tile = "ready"; // C4: the catch-all for any open claim
      else tile = "potential";
    }
    const userReportedOnly =
      tile === "asked" && openClaims.every((c) => !ASKED_DELIVERIES.has(c.delivery) || c.delivery === "user_reported");
    const provisionalSum = cs.reduce((a, c) => a + c.provisionalMinor, 0);
    const anchors = [...new Set([...cs.map((c) => c.anchor), ...os.map((o) => o.anchor)].filter((a): a is string => a !== null))];
    return {
      claims: cs,
      opportunities: os,
      lossKeys: [...new Set(members.flatMap((m) => (m.kind === "claim" ? m.c.lossKeys : m.o.lossKeys)))],
      anchor: anchors[0] ?? null,
      recovered,
      excess: sumNet - recovered,
      outstanding,
      provisional: Math.min(outstanding, provisionalSum),
      tile,
      userReportedOnly,
    };
  });
}

/** Applies the per-transaction paid-total cap (D145), lowest tile first. Mutates the components; returns flags. */
export function applyPaidCap(comps: Component[], paid: ReadonlyMap<string, PaidTotal>, currency: string): { capped: boolean; partial: boolean } {
  let capped = false;
  let partial = false;
  const byAnchor = new Map<string, Component[]>();
  for (const k of comps) if (k.anchor !== null) byAnchor.set(k.anchor, [...(byAnchor.get(k.anchor) ?? []), k]);
  for (const [anchor, ks] of byAnchor) {
    const p = paid.get(anchor);
    if (!p || p.currency !== currency) continue;
    let over = ks.reduce((a, k) => a + k.recovered + k.outstanding, 0) - p.amountMinor;
    if (over <= 0) continue;
    const ordered = [...ks].filter((k) => k.tile !== null).sort((a, b) => TILE_RANK[a.tile!] - TILE_RANK[b.tile!]);
    for (const k of ordered) {
      if (over <= 0) break;
      const cut = Math.min(k.outstanding, over);
      if (cut > 0) {
        k.outstanding -= cut;
        k.provisional = Math.min(k.provisional, k.outstanding);
        over -= cut;
        capped = true;
        if (p.partial) partial = true;
      }
    }
  }
  return { capped, partial };
}

/** The per-currency figures from bounded, already-read rows. Pure. */
export function computeSummary(
  claims: readonly SummaryClaim[],
  opps: readonly SummaryOpportunity[],
  paid: ReadonlyMap<string, PaidTotal>,
): CurrencySummary[] {
  const currencies = [...new Set([...claims.map((c) => c.currency), ...opps.map((o) => o.currency)])].sort();
  return currencies.map((currency) => {
    const comps = components(claims.filter((c) => c.currency === currency), opps.filter((o) => o.currency === currency));
    const { capped, partial } = applyPaidCap(comps, paid, currency);
    const tiles = Object.fromEntries(TILES.map((t) => [t, { amountMinor: 0, provisionalMinor: 0, components: 0 }])) as CurrencySummary["tiles"];
    let askedUserReportedMinor = 0;
    for (const k of comps) {
      if (k.tile === null) continue;
      tiles[k.tile].amountMinor += k.outstanding;
      tiles[k.tile].provisionalMinor += k.provisional;
      tiles[k.tile].components += 1;
      if (k.userReportedOnly) askedUserReportedMinor += k.outstanding;
    }
    return {
      currency,
      recoveredMinor: comps.reduce((a, k) => a + k.recovered, 0),
      overCreditMinor: comps.reduce((a, k) => a + k.excess, 0),
      tiles,
      askedUserReportedMinor,
      cappedAtPaidTotal: capped,
      paidTotalPartial: partial,
    };
  });
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

const tileShape = v.object({ amountMinor: v.number(), provisionalMinor: v.number(), components: v.number() });
const summaryShape = v.object({
  asOf: v.number(),
  complete: v.boolean(),
  currencies: v.array(v.object({
    currency: v.string(),
    recoveredMinor: v.number(),
    overCreditMinor: v.number(),
    tiles: v.object({ potential: tileShape, ready: tileShape, sendingOrUnknown: tileShape, asked: tileShape, promised: tileShape }),
    askedUserReportedMinor: v.number(),
    cappedAtPaidTotal: v.boolean(),
    paidTotalPartial: v.boolean(),
  })),
  nonCash: v.array(v.object({ kind: v.string(), count: v.number() })),
  counts: v.object({ notYetDue: v.number(), needsAnswers: v.number(), deadlinesThisWeek: v.number() }),
});

/** Ledger events read per claim (a claim collects a promise, a few credits and debits). */
const EVENTS_PER_CLAIM = 200;
/** Drafts read per claim for the delivery projection. */
const DRAFTS_PER_CLAIM = 20;
const WEEK_MS = 7 * 86_400_000;
const COARSE_MS = 300_000;

/** The confirmed paid total of a purchase-backed transaction (§3.4 retail rule) or null. */
async function retailPaidTotal(ctx: QueryCtx, purchase: Doc<"purchases">): Promise<PaidTotal | null> {
  const txn = await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id)).first();
  if (txn) {
    for (const state of ["user_confirmed", "derived"] as const) {
      const fact = await ctx.db
        .query("facts")
        .withIndex("by_transaction_and_state_and_subject_key_and_key", (q) =>
          q.eq("transactionId", txn._id).eq("state", state).eq("subjectKey", "txn").eq("key", "retail.order_total"))
        .order("desc")
        .first();
      if (fact && fact.value.kind === "money" && fact.value.currency === purchase.currency) {
        return { amountMinor: fact.value.amountMinor, currency: fact.value.currency, partial: false };
      }
    }
  }
  const items = await ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchase._id)).take(MAX_ITEMS_PER_PURCHASE);
  if (items.length === 0) return null;
  return { amountMinor: items.reduce((a, i) => a + i.unitCents * i.qty, 0), currency: purchase.currency, partial: true };
}

export const summary = query({
  args: { now: v.number() },
  returns: summaryShape,
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.now) || args.now < 0) throw new ConvexError("now must be a valid time");
    const now = Math.floor(args.now / COARSE_MS) * COARSE_MS;
    const userId = await requireUserId(ctx);

    const claimRows = await ctx.db.query("claims").withIndex("by_user", (q) => q.eq("userId", userId)).take(SUMMARY_MAX_CLAIMS + 1);
    const oppRows = await ctx.db
      .query("opportunities")
      .withIndex("by_user_and_status", (q) => q.eq("userId", userId).eq("status", "open"))
      .take(SUMMARY_MAX_OPEN_OPPORTUNITIES + 1);
    let complete = claimRows.length <= SUMMARY_MAX_CLAIMS && oppRows.length <= SUMMARY_MAX_OPEN_OPPORTUNITIES;

    const purchases = new Map<Id<"purchases">, Doc<"purchases"> | null>();
    const purchaseOf = async (id: Id<"purchases">) => {
      if (!purchases.has(id)) purchases.set(id, await ctx.db.get(id));
      return purchases.get(id)!;
    };

    const realClaims = claimRows.slice(0, SUMMARY_MAX_CLAIMS).filter((c) => c.isExample !== true && c.status !== "dismissed");
    const byItem = new Map<Id<"items">, Doc<"claims">[]>();
    for (const c of claimRows) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c]);

    const claims: SummaryClaim[] = [];
    for (const c of realClaims) {
      const purchase = await purchaseOf(c.purchaseId);
      if (purchase?.isExample) continue;
      const currency = claimCurrency(c, purchase);
      if (currency === null) continue;
      const events = await ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", c._id)).take(EVENTS_PER_CLAIM);
      if (events.length === EVENTS_PER_CLAIM) complete = false;
      const ledger: LedgerEvent[] = events.map((e) => ({ kind: e.kind, cents: e.cents }));
      const b = balance(c.expectedCents, ledger);
      const drafts = await ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", c._id)).order("desc").take(DRAFTS_PER_CLAIM);
      claims.push({
        id: c._id,
        currency,
        status: c.status,
        expectedMinor: c.expectedCents,
        lossKeys: legacyLossKeys(c, byItem.get(c.itemId) ?? [c]),
        confirmedMinor: b.confirmed,
        debitedMinor: b.debited,
        promisedMinor: b.promised,
        provisionalMinor: provisionalOutstanding(ledger),
        delivery: delivery(c, { drafts }),
        closedForAsk: isClosedForAsk(c),
        anchor: `purchase:${c.purchaseId}`,
      });
    }

    const txns = new Map<Id<"transactions">, Doc<"transactions"> | null>();
    const opps: SummaryOpportunity[] = [];
    let notYetDue = 0;
    let needsAnswers = 0;
    let deadlinesThisWeek = 0;
    for (const o of oppRows.slice(0, SUMMARY_MAX_OPEN_OPPORTUNITIES)) {
      if (o.isExample) continue;
      if (!txns.has(o.transactionId)) txns.set(o.transactionId, await ctx.db.get(o.transactionId));
      const txn = txns.get(o.transactionId)!;
      if (!txn || txn.status === "archived" || txn.userId !== userId) continue;
      if (o.outcome === "not_yet_due") notYetDue += 1; // a count, never a money tile (rev 5.2)
      if (o.outcome === "needs_facts") needsAnswers += 1;
      if (o.nextDeadlineAt !== undefined && o.nextDeadlineAt >= now && o.nextDeadlineAt <= now + WEEK_MS) deadlinesThisWeek += 1;
      if (o.activeClaimId !== undefined || o.cashClass !== "cash" || o.estimate === undefined) continue;
      if (o.outcome !== "eligible" && o.outcome !== "likely_eligible") continue;
      opps.push({
        id: o._id,
        currency: o.estimate.currency,
        estimateMinor: o.estimate.amountMinor,
        lossKeys: o.lossKeys,
        anchor: txn.purchaseId ? `purchase:${txn.purchaseId}` : `txn:${txn._id}`,
      });
    }

    // Paid totals only for anchors that carry money in some component.
    const paid = new Map<string, PaidTotal>();
    const anchors = new Set([...claims.map((c) => c.anchor), ...opps.map((o) => o.anchor)].filter((a): a is string => a !== null));
    for (const anchor of anchors) {
      if (!anchor.startsWith("purchase:")) continue; // wave 2: air.total_paid / card.charge_amount
      const purchase = await purchaseOf(anchor.slice("purchase:".length) as Id<"purchases">);
      if (!purchase) continue;
      const p = await retailPaidTotal(ctx, purchase);
      if (p) paid.set(anchor, p);
    }

    const claimIds = new Set(realClaims.map((c) => c._id as string));
    const remedies = await ctx.db.query("nonCashRemedies").withIndex("by_user", (q) => q.eq("userId", userId)).take(SUMMARY_MAX_CLAIMS + 1);
    if (remedies.length > SUMMARY_MAX_CLAIMS) complete = false;
    const nonCashCounts = new Map<string, number>();
    for (const r of remedies.slice(0, SUMMARY_MAX_CLAIMS)) {
      if (!claimIds.has(r.claimId)) continue; // example claims (and claims past the cut) never count
      nonCashCounts.set(r.kind, (nonCashCounts.get(r.kind) ?? 0) + 1);
    }

    return {
      asOf: now,
      complete,
      currencies: computeSummary(claims, opps, paid),
      nonCash: [...nonCashCounts.entries()].sort().map(([kind, count]) => ({ kind, count })),
      counts: { notYetDue, needsAnswers, deadlinesThisWeek },
    };
  },
});
