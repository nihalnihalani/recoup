/// <reference types="vite/client" />
/**
 * `recovery.summary` (contract rev 5.5 §3.4; DA-A-4, DA-A-17, DA-A-34, D145, C4). Expected amounts are computed by
 * hand in each test; the invariants I1–I5 are checked over a seeded generator covering every claim status × delivery
 * × promised ≶ net × provisional 0/>0 × linked opportunity or not.
 */
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { Delivery } from "./lib/claimState";
import { components, computeSummary, type PaidTotal, type SummaryClaim, type SummaryOpportunity, TILES } from "./recovery";
import { pinClockEach, setup, signedIn } from "./test.setup";

const claim = (o: Partial<SummaryClaim> & Pick<SummaryClaim, "id" | "expectedMinor" | "lossKeys">): SummaryClaim => ({
  currency: "USD", status: "detected", confirmedMinor: 0, debitedMinor: 0, promisedMinor: 0, provisionalMinor: 0,
  delivery: "none", closedForAsk: false, anchor: "purchase:p1", ...o,
});
const opp = (o: Partial<SummaryOpportunity> & Pick<SummaryOpportunity, "id" | "estimateMinor" | "lossKeys">): SummaryOpportunity => ({
  currency: "USD", anchor: "purchase:p1", ...o,
});
const usd = (claims: SummaryClaim[], opps: SummaryOpportunity[] = [], paid = new Map<string, PaidTotal>()) =>
  computeSummary(claims, opps, paid).find((c) => c.currency === "USD")!;

describe("DA-A-4 (D145): alternatives count once across ALL tiles; per-transaction paid cap; over-credit visible", () => {
  it("SEC-MF-2: one 120 receipt under two remedies counts 120 once", () => {
    const s = usd([
      claim({ id: "baggage", expectedMinor: 12_000, lossKeys: ["txn:t1:exp:1"], anchor: "txn:t1" }),
      claim({ id: "card", expectedMinor: 12_000, lossKeys: ["txn:t1:exp:1"], anchor: "txn:t1", delivery: "sent" }),
    ]);
    expect(s.tiles.asked.amountMinor + s.tiles.ready.amountMinor).toBe(12_000);
    expect(s.tiles.asked.amountMinor).toBe(12_000); // the furthest state holds the one loss
  });

  it("an open case and a Potential alternative on one loss count once (the max), not twice", () => {
    const s = usd([claim({ id: "r05", expectedMinor: 60_000, lossKeys: ["txn:t1:paid"], delivery: "sent" })], [opp({ id: "r03", estimateMinor: 60_000, lossKeys: ["txn:t1:paid"] })]);
    expect(s.tiles.asked.amountMinor).toBe(60_000);
    expect(s.tiles.potential.amountMinor).toBe(0);
  });

  it("R01 + order-level loss on one order → Σ ≤ paid (capped from Potential first; flagged)", () => {
    const paid = new Map([["purchase:p1", { amountMinor: 60_000, currency: "USD", partial: true }]]);
    const s = usd(
      [claim({ id: "r05", expectedMinor: 60_000, lossKeys: ["txn:t1:paid"], delivery: "sent" })],
      [opp({ id: "r01", estimateMinor: 5_000, lossKeys: ["item:i1:price_diff:1"] })],
      paid,
    );
    const total = TILES.reduce((a, t) => a + s.tiles[t].amountMinor, 0) + s.recoveredMinor;
    expect(total).toBe(60_000);
    expect(s.tiles.potential.amountMinor).toBe(0);
    expect(s.tiles.asked.amountMinor).toBe(60_000);
    expect(s.cappedAtPaidTotal).toBe(true);
    expect(s.paidTotalPartial).toBe(true); // "cap based on item prices only"
  });

  it("wave-2 note: a confirmed order total (tax + shipping) caps instead of item totals, not partial", () => {
    const paid = new Map([["purchase:p1", { amountMinor: 64_950, currency: "USD", partial: false }]]);
    const s = usd([claim({ id: "r05", expectedMinor: 64_950, lossKeys: ["txn:t1:paid"] })], [], paid);
    expect(s.tiles.ready.amountMinor).toBe(64_950);
    expect(s.cappedAtPaidTotal).toBe(false);
  });

  it("two credits for one loss → Recovered = the loss, the excess on the over-credit line (never erased)", () => {
    const s = usd([
      claim({ id: "a", expectedMinor: 4_000, lossKeys: ["k"], status: "confirmed", closedForAsk: true, confirmedMinor: 4_000 }),
      claim({ id: "b", expectedMinor: 4_000, lossKeys: ["k"], status: "confirmed", closedForAsk: true, confirmedMinor: 4_000 }),
    ]);
    expect(s.recoveredMinor).toBe(4_000);
    expect(s.overCreditMinor).toBe(4_000);
    expect(TILES.every((t) => s.tiles[t].amountMinor === 0)).toBe(true);
  });

  it("a denied 5,000 claim + a new 2,000 difference-only claim on the same key → outstanding 2,000", () => {
    const s = usd([
      claim({ id: "denied", expectedMinor: 5_000, lossKeys: ["k"], status: "denied", closedForAsk: true }),
      claim({ id: "diff", expectedMinor: 2_000, lossKeys: ["k"] }),
    ]);
    expect(s.tiles.ready.amountMinor).toBe(2_000);
  });
});

describe("DA-A-17 / C4: disjoint, exhaustive tiles by furthest state; provisional as 'of which'", () => {
  it("an unknown send appears in Sending or unknown", () => {
    const s = usd([claim({ id: "a", expectedMinor: 4_000, lossKeys: ["k"], status: "queued", delivery: "unknown" })]);
    expect(s.tiles.sendingOrUnknown.amountMinor).toBe(4_000);
  });

  it("return claim 4,000 + promise 1,500 + confirmed 1,500 → 2,500 in Ready (promised ≤ net falls to the catch-all)", () => {
    const s = usd([claim({ id: "r", expectedMinor: 4_000, lossKeys: ["item:i:return_credit"], status: "promised", promisedMinor: 1_500, confirmedMinor: 1_500 })]);
    expect(s.tiles.ready.amountMinor).toBe(2_500);
    expect(s.tiles.promised.amountMinor).toBe(0);
    expect(s.recoveredMinor).toBe(1_500);
  });

  it("expected 4,000, sent, promised 4,000 → only in Promised (not Asked too)", () => {
    const s = usd([claim({ id: "a", expectedMinor: 4_000, lossKeys: ["k"], status: "promised", promisedMinor: 4_000, delivery: "sent" })]);
    expect(s.tiles.promised.amountMinor).toBe(4_000);
    expect(s.tiles.asked.amountMinor).toBe(0);
  });

  it("provisional 2,000 → 'of which provisional' inside its tile; Recovered unchanged", () => {
    const s = usd([claim({ id: "a", expectedMinor: 4_000, lossKeys: ["k"], delivery: "sent", provisionalMinor: 2_000 })]);
    expect(s.tiles.asked).toEqual({ amountMinor: 4_000, provisionalMinor: 2_000, components: 1 });
    expect(s.recoveredMinor).toBe(0);
  });

  it("the legacy note-only packet is the askedUserReported sub-figure", () => {
    const s = usd([claim({ id: "a", expectedMinor: 3_000, lossKeys: ["k"], status: "packet", delivery: "user_reported" })]);
    expect(s.tiles.asked.amountMinor).toBe(3_000);
    expect(s.askedUserReportedMinor).toBe(3_000);
  });

  it("core fixtures: alternatives of 3,000 and 2,500 on one loss → Potential 3,000; USD and EUR stay separate", () => {
    const s = usd([], [opp({ id: "a", estimateMinor: 3_000, lossKeys: ["k"] }), opp({ id: "b", estimateMinor: 2_500, lossKeys: ["k"] })]);
    expect(s.tiles.potential.amountMinor).toBe(3_000);
    const both = computeSummary([claim({ id: "u", expectedMinor: 100, lossKeys: ["a"] }), claim({ id: "e", expectedMinor: 200, lossKeys: ["b"], currency: "EUR" })], [], new Map());
    expect(both.map((c) => [c.currency, c.tiles.ready.amountMinor])).toEqual([["EUR", 200], ["USD", 100]]);
  });

  it("core fixtures: expected 4,000 / promise 4,000 → 4,000 → confirm 1,500 → 2,500 → confirm 2,500 → 0 → debit 1,000 → 1,000", () => {
    const base = { id: "c", expectedMinor: 4_000, lossKeys: ["k"] };
    expect(usd([claim({ ...base, status: "promised", promisedMinor: 4_000 })]).tiles.promised.amountMinor).toBe(4_000);
    expect(usd([claim({ ...base, status: "promised", promisedMinor: 4_000, confirmedMinor: 1_500 })]).tiles.promised.amountMinor).toBe(2_500);
    const settled = usd([claim({ ...base, status: "confirmed", closedForAsk: true, promisedMinor: 4_000, confirmedMinor: 4_000 })]);
    expect(TILES.every((t) => settled.tiles[t].amountMinor === 0)).toBe(true);
    expect(settled.recoveredMinor).toBe(4_000);
    const reopened = usd([claim({ ...base, status: "reopened", promisedMinor: 4_000, confirmedMinor: 4_000, debitedMinor: 1_000 })]);
    expect(reopened.tiles.ready.amountMinor).toBe(1_000);
    expect(reopened.recoveredMinor).toBe(3_000);
  });
});

// ---------------------------------------------------------------------------
// Property sweep (I1–I5) over the C4 generator
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const STATUSES = ["detected", "drafted", "queued", "sent", "packet", "promised", "reopened", "confirmed", "dismissed"] as const;
const DELIVERIES: Delivery[] = ["none", "draft", "approved", "queued", "accepted", "sent", "delivered", "failed", "bounced", "unknown", "stalled", "packet_prepared", "submission_recorded", "user_reported"];

describe("I1–I5 per currency over the C4 generator (every status × delivery × promised ≶ net × provisional × linked opp)", () => {
  it("holds on 3,000 generated ledgers", () => {
    const rnd = mulberry32(20260923);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
    let componentsWithOpen = 0;
    for (let run = 0; run < 3_000; run++) {
      const claims: SummaryClaim[] = [];
      const opps: SummaryOpportunity[] = [];
      const keyPool = ["k1", "k2", "k3", "k4"];
      const nClaims = Math.floor(rnd() * 5);
      for (let i = 0; i < nClaims; i++) {
        const status = pick(STATUSES);
        if (status === "dismissed") continue; // the query excludes dismissed claims from the nodes
        const expected = 100 * (1 + Math.floor(rnd() * 50));
        const confirmed = pick([0, Math.floor(expected / 2), expected, expected + 500]);
        const debited = pick([0, 0, 300]);
        const net = Math.max(0, confirmed - debited);
        const promised = pick([0, Math.max(0, net - 100), net, net + 700]);
        claims.push(claim({
          id: `c${i}`, currency: pick(["USD", "EUR"]), status, expectedMinor: expected, lossKeys: [pick(keyPool)],
          confirmedMinor: confirmed, debitedMinor: debited, promisedMinor: promised, provisionalMinor: pick([0, 0, 800]),
          delivery: pick(DELIVERIES), closedForAsk: status === "confirmed", anchor: pick(["purchase:p1", "purchase:p2"]),
        }));
      }
      const nOpps = Math.floor(rnd() * 3); // an unlinked opportunity sharing a claim's key, or its own loss
      for (let i = 0; i < nOpps; i++) {
        opps.push(opp({ id: `o${i}`, currency: pick(["USD", "EUR"]), estimateMinor: 100 * (1 + Math.floor(rnd() * 50)), lossKeys: [pick([...keyPool, "k9"])], anchor: pick(["purchase:p1", "purchase:p2"]) }));
      }
      const paid = new Map<string, PaidTotal>();
      if (rnd() < 0.5) paid.set("purchase:p1", { amountMinor: 100 * Math.floor(rnd() * 60), currency: "USD", partial: rnd() < 0.5 });
      const result = computeSummary(claims, opps, paid);
      for (const cur of result) {
        const cs = claims.filter((c) => c.currency === cur.currency);
        const os = opps.filter((o) => o.currency === cur.currency);
        const comps = components(cs, os);
        const tileSum = TILES.reduce((a, t) => a + cur.tiles[t].amountMinor, 0);
        const tileCount = TILES.reduce((a, t) => a + cur.tiles[t].components, 0);
        const withOpen = comps.filter((k) => k.claims.some((c) => !c.closedForAsk) || k.opportunities.length > 0);
        componentsWithOpen += withOpen.length;
        // I3: disjoint AND exhaustive — each component with an open member is in exactly one tile.
        expect(tileCount).toBe(withOpen.length);
        expect(withOpen.every((k) => k.tile !== null)).toBe(true);
        // I2: Recovered + Over-credit = Σ net.
        expect(cur.recoveredMinor + cur.overCreditMinor).toBe(cs.reduce((a, c) => a + Math.max(0, c.confirmedMinor - c.debitedMinor), 0));
        // I1: Σ tiles = Σ outstanding (uncapped outstanding is an upper bound; capping only lowers it).
        const uncapped = comps.reduce((a, k) => a + k.outstanding, 0);
        expect(tileSum).toBeLessThanOrEqual(uncapped);
        if (!cur.cappedAtPaidTotal) expect(tileSum).toBe(uncapped);
        // I4: a capped transaction's Σ (recovered + outstanding) never exceeds its paid total unless recovered does.
        const p = paid.get("purchase:p1");
        if (cur.cappedAtPaidTotal && p && p.currency === cur.currency) {
          const anchored = comps.filter((k) => k.anchor === "purchase:p1");
          const rec = anchored.reduce((a, k) => a + k.recovered, 0);
          const before = anchored.reduce((a, k) => a + k.recovered + k.outstanding, 0);
          expect(before).toBeGreaterThan(0);
          expect(rec).toBeLessThanOrEqual(Math.max(rec, p.amountMinor));
        }
        // I5: no cap value or face value enters a sum: every figure is bounded by the members' own amounts.
        const lossBound = comps.reduce((a, k) => a + Math.max(0, ...k.claims.map((c) => c.expectedMinor), ...k.opportunities.map((o) => o.estimateMinor)), 0);
        expect(tileSum + cur.recoveredMinor).toBeLessThanOrEqual(lossBound);
        for (const t of TILES) expect(cur.tiles[t].provisionalMinor).toBeLessThanOrEqual(cur.tiles[t].amountMinor);
      }
    }
    expect(componentsWithOpen).toBeGreaterThan(1_000); // the generator really exercises open components
  });

  it("I4 exactly: after the cap, Σ (recovered + outstanding) on a capped transaction ≤ its paid total", () => {
    const paid = new Map([["purchase:p1", { amountMinor: 10_000, currency: "USD", partial: false }]]);
    const cs = [claim({ id: "a", expectedMinor: 8_000, lossKeys: ["a"], delivery: "sent" }), claim({ id: "b", expectedMinor: 6_000, lossKeys: ["b"] })];
    const os = [opp({ id: "o", estimateMinor: 3_000, lossKeys: ["o"] })];
    const s = usd(cs, os, paid);
    expect(TILES.reduce((a, t) => a + s.tiles[t].amountMinor, 0)).toBe(10_000);
    expect(s.tiles.potential.amountMinor).toBe(0); // cut first
    expect(s.tiles.ready.amountMinor).toBe(2_000); // then ready (6,000 − 4,000)
    expect(s.tiles.asked.amountMinor).toBe(8_000); // untouched
  });
});

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

describe("recovery.summary (query)", () => {
  const NOW = Date.UTC(2026, 8, 20, 14);
  pinClockEach(NOW);
  type T = ReturnType<typeof setup>;

  async function seedItem(t: T, userId: Id<"users">, currency = "USD", isExample = false) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 86_400_000, currency, status: "active", ...(isExample ? { isExample: true } : {}) });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
      return { purchaseId, itemId };
    });
  }
  async function claimRow(t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> }, o: { expected: number; status?: "detected" | "confirmed" | "sent"; confirmed?: number; isExample?: boolean; type?: "price_adjustment" | "return_credit" }) {
    return await t.run(async (ctx) => {
      const claimId = await ctx.db.insert("claims", {
        purchaseId: w.purchaseId, itemId: w.itemId, userId, type: o.type ?? "price_adjustment", expectedCents: o.expected,
        status: o.status ?? "detected", token: `T${Math.random().toString(36).slice(2, 8)}`, version: 1, ...(o.isExample ? { isExample: true } : {}),
      });
      if (o.confirmed) await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "confirmed_credit", cents: o.confirmed, evidence: "user" });
      return claimId;
    });
  }

  it("DA-A-34 (A.7 inverted): an earlier confirmed claim's 2,000 is counted alongside a newer open claim on the same item", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await seedItem(t, userId);
    await claimRow(t, userId, w, { expected: 2_000, status: "confirmed", confirmed: 2_000 });
    await claimRow(t, userId, w, { expected: 1_000 });
    const s = await as.query(api.recovery.summary, { now: NOW });
    const usdRow = s.currencies.find((c) => c.currency === "USD")!;
    expect(usdRow.recoveredMinor).toBe(2_000);
    expect(usdRow.tiles.ready.amountMinor).toBe(1_000);
    expect(s.complete).toBe(true);
  });

  it("examples are excluded (claims, their ledger and non-cash rows, and example opportunities)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const ex = await seedItem(t, userId, "USD", true);
    const exClaim = await claimRow(t, userId, ex, { expected: 5_000, confirmed: 1_000, isExample: true });
    await t.run((ctx) => ctx.db.insert("nonCashRemedies", { userId, claimId: exClaim, kind: "voucher", description: "example", state: "received", idempotencyKey: "k", recordedAt: NOW }));
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.currencies).toEqual([]);
    expect(s.nonCash).toEqual([]);
  });

  it("a non-cash voucher is a count only (its face value is in no sum); currencies are separate rows", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const a = await seedItem(t, userId, "USD");
    const b = await seedItem(t, userId, "EUR");
    const c1 = await claimRow(t, userId, a, { expected: 4_000, type: "return_credit" });
    await claimRow(t, userId, b, { expected: 3_000 });
    await t.run((ctx) => ctx.db.insert("nonCashRemedies", { userId, claimId: c1, kind: "voucher", description: "store credit", faceValue: { amountMinor: 50_000, currency: "USD" }, state: "received", idempotencyKey: "v1", recordedAt: NOW }));
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.nonCash).toEqual([{ kind: "voucher", count: 1 }]);
    expect(s.currencies.map((c) => [c.currency, c.tiles.ready.amountMinor, c.recoveredMinor])).toEqual([["EUR", 3_000, 0], ["USD", 4_000, 0]]);
  });

  it("a legacy JPY claim (expectedCents 120000 = ¥1,200 in hundredths) is never shown or summed as ¥120,000", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const yen = await seedItem(t, userId, "JPY");
    await claimRow(t, userId, yen, { expected: 120_000, confirmed: 20_000 });
    const usdItem = await seedItem(t, userId, "USD");
    await claimRow(t, userId, usdItem, { expected: 1_000 });
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.currencies.map((c) => c.currency)).toEqual(["USD"]);
    expect(JSON.stringify(s)).not.toMatch(/120000|20000/);
    expect(s.unsupportedCurrencies).toEqual([{ currency: "JPY", claims: 1 }]);
  });

  it("a real cut past 200 claims reports complete: false; a foreign user sees nothing", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const other = await signedIn(t, "Other");
    const w = await seedItem(t, userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("claims", { purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "return_credit", expectedCents: 100, status: "dismissed", token: `D${i}`, version: 1 });
      }
    });
    expect((await as.query(api.recovery.summary, { now: NOW })).complete).toBe(false);
    const theirs = await other.as.query(api.recovery.summary, { now: NOW });
    expect(theirs.currencies).toEqual([]);
    await expect(as.query(api.recovery.summary, { now: Number.NaN })).rejects.toThrow("now must be a valid time");
  });
});
