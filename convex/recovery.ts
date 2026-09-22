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
 *   excess split (D195/D196, DA-B-8): RED `possibleDoubleCredit` when ≥ 2 claims in K have net > 0; otherwise
 *               NEUTRAL `extraCredited` ("more than you asked — often tax or shipping"). A single refund that
 *               includes tax or shipping is recovered money, never a suspected double credit.
 *   outstanding = K has an open member ? max(0, lossOpen − recovered) : 0
 *   tile(K)   = furthest state over open members: promised > refused > asked > sending_or_unknown > ready > potential;
 *               `ready` is the CATCH-ALL for every open claim not in a higher tile (C4). `refused` (DA-B-13, D196,
 *               display only): an open claim whose newest classified reply is a refusal with no later promise or
 *               credit — "the merchant said no; no money yet" (wave 2 moves `denied` to closed-for-ask)
 *   provisional(K) = min(outstanding(K), Σ provisional) — shown "of which provisional" inside tile(K)
 *   per-transaction cap (D145, D188), per transaction per currency, against its confirmed paid total P (retail: a
 *               confirmed `retail.order_total`, else Σ unit × qty labelled `paidTotalPartial`):
 *               1. Recovered: Σ recovered ≤ P — confirmed money above what was paid moves off Recovered (visible,
 *                  never dropped; mission §6). It is RED when P is a confirmed order total, or when ≥ 2 credited
 *                  claims on the transaction exceed an item-only P; otherwise (one credited claim over an item-only
 *                  total, which is known to be low) it is NEUTRAL extra credit (D196). The ledger is untouched.
 *               2. Outstanding: Σ (recovered + outstanding) ≤ P — the rest comes off outstanding in the order
 *                  potential → ready → sending → asked → promised (an unpaid ask is trimmed, never an over-credit)
 *
 * Invariants per currency: I2 recovered + overCredit = Σ net; I2b extraCredited + possibleDoubleCredit = overCredit.
 * Alternatives (components) count once across ALL tiles, including components with cases. Currencies are never
 * summed or converted. Legacy `…Cents` fields are hundredths of the major unit for EVERY currency (HC-8), so a claim
 * in a currency whose minor unit is not two decimals (JPY, KWD…) is never shown or summed as ISO minor units: it is
 * left out of every money figure and reported under `unsupportedCurrencies` (D160 family, M15 finding). Examples are excluded (claims.isExample for ledger and non-cash rows, opportunities.isExample).
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
import { claimCurrency, isTwoDecimalCurrency } from "./lib/money";
import { MAX_ITEMS_PER_PURCHASE, SUMMARY_MAX_CLAIMS, SUMMARY_MAX_OPEN_OPPORTUNITIES } from "./limits";
import { legacyLossKeys } from "./opportunities";

export const TILES = ["potential", "ready", "sendingOrUnknown", "asked", "refused", "promised"] as const;
export type Tile = (typeof TILES)[number];
/** Highest first: the furthest state wins (DA-A-17; `refused` between asked and promised, D196). */
const TILE_RANK: Record<Tile, number> = { potential: 0, ready: 1, sendingOrUnknown: 2, asked: 3, refused: 4, promised: 5 };

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
  /** DA-B-13: the newest classified reply is a refusal and no promise or credit was recorded after it. */
  refused: boolean;
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
  /** Confirmed money above the loss or the paid cap, NEUTRAL: one credited claim got more than it asked (D196). */
  extraCredited: number;
  /** Confirmed money above the loss or the paid cap, RED: ≥ 2 credits on one loss, or above a confirmed paid total. */
  possibleDoubleCredit: number;
  /** Claims in the component with net > 0. */
  credited: number;
  outstanding: number;
  provisional: number;
  /** Null when the component has no open member. */
  tile: Tile | null;
  userReportedOnly: boolean;
}

export interface CurrencySummary {
  currency: string;
  recoveredMinor: number;
  /** @deprecated display only the two parts (`extraCreditedMinor`, `possibleDoubleCreditMinor`); D196. Their sum. */
  overCreditMinor: number;
  /** Neutral: more came back than was asked on a single credited claim (often tax or shipping). */
  extraCreditedMinor: number;
  /** Red: ≥ 2 credited claims on one loss, or confirmed money above what was paid. */
  possibleDoubleCreditMinor: number;
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
    const credited = cs.filter((c) => netOf(c) > 0).length;
    const excess = sumNet - recovered;
    const hasOpen = openClaims.length > 0 || os.length > 0;
    const outstanding = hasOpen ? Math.max(0, lossOpen - recovered) : 0;
    let tile: Tile | null = null;
    if (hasOpen) {
      if (openClaims.some((c) => c.status === "promised" && c.promisedMinor > netOf(c))) tile = "promised";
      else if (openClaims.some((c) => c.refused)) tile = "refused";
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
      // D196: red only when ≥ 2 claims in the component were credited; one claim's extra is neutral.
      extraCredited: credited >= 2 ? 0 : excess,
      possibleDoubleCredit: credited >= 2 ? excess : 0,
      credited,
      outstanding,
      provisional: Math.min(outstanding, provisionalSum),
      tile,
      userReportedOnly,
    };
  });
}

/**
 * Applies the per-transaction paid-total cap (D145, D188). Mutates the components; returns flags. First confirmed
 * money: Σ recovered on the transaction is capped at P and the rest moves off Recovered — to `possibleDoubleCredit`
 * when P is a confirmed order total or ≥ 2 credited claims on the transaction exceed an item-only P, else to
 * `extraCredited` (D196) — so I2 and I2b still hold. Then outstanding, lowest tile first, until Σ (recovered +
 * outstanding) ≤ P (I4).
 */
export function applyPaidCap(comps: Component[], paid: ReadonlyMap<string, PaidTotal>, currency: string): { capped: boolean; partial: boolean } {
  let capped = false;
  let partial = false;
  const byAnchor = new Map<string, Component[]>();
  for (const k of comps) if (k.anchor !== null) byAnchor.set(k.anchor, [...(byAnchor.get(k.anchor) ?? []), k]);
  for (const [anchor, ks] of byAnchor) {
    const p = paid.get(anchor);
    if (!p || p.currency !== currency) continue;
    const mark = () => {
      capped = true;
      if (p.partial) partial = true;
    };
    // 1. Confirmed money never shows above what was paid; the excess stays visible (D188). Red only above a confirmed
    // total, or when ≥ 2 credited claims on the transaction exceed an item-only total (D196).
    let overRecovered = ks.reduce((a, k) => a + k.recovered, 0) - p.amountMinor;
    const red = !p.partial || ks.reduce((a, k) => a + k.credited, 0) >= 2;
    if (overRecovered > 0) {
      const byKey = [...ks].sort((a, b) => (a.lossKeys.join("|") < b.lossKeys.join("|") ? -1 : 1));
      for (const k of byKey) {
        if (overRecovered <= 0) break;
        const cut = Math.min(k.recovered, overRecovered);
        if (cut > 0) {
          k.recovered -= cut;
          if (red) k.possibleDoubleCredit += cut;
          else k.extraCredited += cut;
          overRecovered -= cut;
          mark();
        }
      }
    }
    // 2. Then what is still being asked, lowest tile first.
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
        mark();
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
    const extraCreditedMinor = comps.reduce((a, k) => a + k.extraCredited, 0);
    const possibleDoubleCreditMinor = comps.reduce((a, k) => a + k.possibleDoubleCredit, 0);
    return {
      currency,
      recoveredMinor: comps.reduce((a, k) => a + k.recovered, 0),
      overCreditMinor: extraCreditedMinor + possibleDoubleCreditMinor,
      extraCreditedMinor,
      possibleDoubleCreditMinor,
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
    /** Deprecated for display: the sum of the two parts below (D196). */
    overCreditMinor: v.number(),
    extraCreditedMinor: v.number(),
    possibleDoubleCreditMinor: v.number(),
    tiles: v.object({ potential: tileShape, ready: tileShape, sendingOrUnknown: tileShape, asked: tileShape, refused: tileShape, promised: tileShape }),
    askedUserReportedMinor: v.number(),
    cappedAtPaidTotal: v.boolean(),
    paidTotalPartial: v.boolean(),
  })),
  nonCash: v.array(v.object({ kind: v.string(), count: v.number() })),
  /** Claims left out of every money figure because their currency is not two-decimal (legacy hundredths, HC-8). */
  unsupportedCurrencies: v.array(v.object({ currency: v.string(), claims: v.number() })),
  counts: v.object({ notYetDue: v.number(), needsAnswers: v.number(), deadlinesThisWeek: v.number() }),
});

/** Ledger events read per claim (a claim collects a promise, a few credits and debits). */
const EVENTS_PER_CLAIM = 200;
/** Drafts read per claim for the delivery projection. */
const DRAFTS_PER_CLAIM = 20;
/** Replies read per open claim, newest first, to find the newest classified one (DA-B-13). */
const REPLIES_PER_CLAIM = 20;
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

/** Money arriving after a refusal undoes it (DA-B-13): a promise, a confirmed credit or a provisional credit. */
const UNDOES_REFUSAL: ReadonlySet<Doc<"ledgerEvents">["kind"]> = new Set(["promised_credit", "confirmed_credit", "provisional_credit"]);

/**
 * DA-B-13 (D196): the claim's newest CLASSIFIED reply ("other" is auto-replies, receipts, marketing) is a refusal and
 * no promise or credit was recorded after it. Newest by insertion order on `replies.by_claim`, compared with the
 * ledger's insertion times. `cut` when the bounded read found no classified reply but may have missed one.
 */
async function refusedState(
  ctx: QueryCtx,
  claimId: Id<"claims">,
  events: readonly Doc<"ledgerEvents">[],
): Promise<{ refused: boolean; cut: boolean }> {
  const replies = await ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).order("desc").take(REPLIES_PER_CLAIM);
  const newest = replies.find((r) => r.classification !== "other");
  if (!newest) return { refused: false, cut: replies.length === REPLIES_PER_CLAIM };
  if (newest.classification !== "refusal") return { refused: false, cut: false };
  return { refused: !events.some((e) => UNDOES_REFUSAL.has(e.kind) && e._creationTime > newest._creationTime), cut: false };
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
    const unsupported = new Map<string, number>();
    for (const c of realClaims) {
      const purchase = await purchaseOf(c.purchaseId);
      if (purchase?.isExample) continue;
      const currency = claimCurrency(c, purchase);
      if (currency === null) continue;
      if (!isTwoDecimalCurrency(currency)) {
        unsupported.set(currency, (unsupported.get(currency) ?? 0) + 1);
        continue;
      }
      const events = await ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", c._id)).take(EVENTS_PER_CLAIM);
      if (events.length === EVENTS_PER_CLAIM) complete = false;
      const ledger: LedgerEvent[] = events.map((e) => ({ kind: e.kind, cents: e.cents }));
      const b = balance(c.expectedCents, ledger);
      const drafts = await ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", c._id)).order("desc").take(DRAFTS_PER_CLAIM);
      const closedForAsk = isClosedForAsk(c);
      let refused = false;
      if (!closedForAsk) {
        const r = await refusedState(ctx, c._id, events);
        refused = r.refused;
        if (r.cut) complete = false;
      }
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
        closedForAsk,
        refused,
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
      if (!isTwoDecimalCurrency(o.estimate.currency)) continue; // never produced by an active pack; defence in depth
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
      unsupportedCurrencies: [...unsupported.entries()].sort().map(([currency, claims]) => ({ currency, claims })),
      counts: { notYetDue, needsAnswers, deadlinesThisWeek },
    };
  },
});
