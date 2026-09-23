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
import { applyPaidCap, components, computeSummary, type PaidTotal, type SummaryClaim, type SummaryOpportunity, TILES } from "./recovery";
import { pinClockEach, setup, signedIn } from "./test.setup";

const claim = (o: Partial<SummaryClaim> & Pick<SummaryClaim, "id" | "expectedMinor" | "lossKeys">): SummaryClaim => ({
  currency: "USD", status: "detected", confirmedMinor: 0, debitedMinor: 0, promisedMinor: 0, provisionalMinor: 0,
  delivery: "none", closedForAsk: false, refused: false, anchor: "purchase:p1", ...o,
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
    expect([s.extraCreditedMinor, s.possibleDoubleCreditMinor]).toEqual([0, 4_000]); // D196: ≥ 2 credits on one loss → red
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

describe("D188 (QA-M16-1): confirmed money per transaction per currency never exceeds the paid total; excess → over-credit", () => {
  const paid = (amountMinor: number, currency = "USD", partial = true) => new Map([["purchase:p1", { amountMinor, currency, partial }]]);
  const confirmed = (id: string, key: string, amount: number, currency = "USD") =>
    claim({ id, expectedMinor: amount, lossKeys: [key], status: "confirmed", closedForAsk: true, confirmedMinor: amount, currency });

  it("a confirmed 2,000 price adjustment + a confirmed 4,000 refund on a 4,000 item → Recovered 4,000, over-credit 2,000", () => {
    const s = usd([confirmed("pa", "item:i:price_diff:1", 2_000), confirmed("rf", "item:i:return_credit", 4_000)], [], paid(4_000));
    expect(s.recoveredMinor).toBe(4_000);
    expect(s.overCreditMinor).toBe(2_000); // visible, never dropped (mission §6)
    expect([s.extraCreditedMinor, s.possibleDoubleCreditMinor]).toEqual([0, 2_000]); // two credited claims exceed it → red
    expect(s.cappedAtPaidTotal).toBe(true);
    expect(s.paidTotalPartial).toBe(true); // item totals only: "cap based on item prices only"
    expect(TILES.every((t) => s.tiles[t].amountMinor === 0)).toBe(true);
  });

  it("a confirmed order total (not partial) caps the same way, without the partial label", () => {
    const s = usd([confirmed("pa", "a", 2_000), confirmed("rf", "b", 4_000)], [], paid(4_500, "USD", false));
    expect([s.recoveredMinor, s.overCreditMinor, s.cappedAtPaidTotal, s.paidTotalPartial]).toEqual([4_500, 1_500, true, false]);
    expect([s.extraCreditedMinor, s.possibleDoubleCreditMinor]).toEqual([0, 1_500]); // above a CONFIRMED total → red
  });

  it("with no excess nothing changes: 2,000 + 1,000 confirmed on a 4,000 purchase", () => {
    const s = usd([confirmed("pa", "a", 2_000), confirmed("pa2", "b", 1_000)], [], paid(4_000));
    expect([s.recoveredMinor, s.overCreditMinor, s.cappedAtPaidTotal]).toEqual([3_000, 0, false]);
  });

  it("confirmed money at the cap leaves no outstanding on that transaction (Σ recovered + outstanding ≤ paid)", () => {
    const s = usd([confirmed("rf", "b", 4_000), claim({ id: "open", expectedMinor: 1_500, lossKeys: ["c"], delivery: "sent" })], [], paid(4_000));
    expect(s.recoveredMinor).toBe(4_000);
    expect(TILES.reduce((a, t) => a + s.tiles[t].amountMinor, 0)).toBe(0);
    expect(s.overCreditMinor).toBe(0); // an unpaid ask is trimmed, not an over-credit
  });

  it("mixed currencies stay separate: a USD paid total never caps EUR money on the same anchor", () => {
    const rows = computeSummary(
      [confirmed("u1", "a", 3_000), confirmed("u2", "b", 3_000), confirmed("e1", "c", 3_000, "EUR"), confirmed("e2", "d", 3_000, "EUR")],
      [],
      paid(4_000),
    );
    const byCur = Object.fromEntries(rows.map((r) => [r.currency, [r.recoveredMinor, r.overCreditMinor, r.cappedAtPaidTotal]]));
    expect(byCur).toEqual({ USD: [4_000, 2_000, true], EUR: [6_000, 0, false] });
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

describe("DA-B-8 (D195/D196): the excess splits into neutral extra credit and red possible double credit", () => {
  const itemOnly = (amountMinor: number) => new Map([["purchase:p1", { amountMinor, currency: "USD", partial: true }]]);
  const orderTotal = (amountMinor: number) => new Map([["purchase:p1", { amountMinor, currency: "USD", partial: false }]]);
  const credited = (id: string, key: string, expected: number, got: number, currency = "USD") =>
    claim({ id, expectedMinor: expected, lossKeys: [key], status: "confirmed", closedForAsk: true, confirmedMinor: got, currency });
  const parts = (s: ReturnType<typeof usd>) => [s.recoveredMinor, s.extraCreditedMinor, s.possibleDoubleCreditMinor, s.overCreditMinor];

  it("S1: a 25.00 price adjustment refunded as 27.00 (tax too) → Recovered 25.00, neutral 2.00, nothing red", () => {
    expect(parts(usd([credited("pa", "item:i:price_diff:1", 2_500, 2_700)], [], itemOnly(12_000)))).toEqual([2_500, 200, 0, 200]);
  });

  it("S2: a 120.00 return refunded as 129.60 over an item-only 120.00 total → Recovered 120.00, neutral 9.60, nothing red", () => {
    expect(parts(usd([credited("rf", "item:i:return_credit", 12_000, 12_960)], [], itemOnly(12_000)))).toEqual([12_000, 960, 0, 960]);
  });

  it("a price adjustment plus a full return on one item → the excess over the item total is red", () => {
    const s = usd([credited("pa", "item:i:price_diff:1", 2_500, 2_500), credited("rf", "item:i:return_credit", 12_000, 12_000)], [], itemOnly(12_000));
    expect(parts(s)).toEqual([12_000, 0, 2_500, 2_500]);
  });

  it("an item-only total never turns ONE claim's credit red: 5,000 asked and credited over a 4,000 item-only total → neutral", () => {
    expect(parts(usd([credited("rf", "item:i:return_credit", 5_000, 5_000)], [], itemOnly(4_000)))).toEqual([4_000, 1_000, 0, 1_000]);
  });

  it("above a CONFIRMED order total even one claim's credit is red", () => {
    expect(parts(usd([credited("rf", "item:i:return_credit", 5_000, 5_000)], [], orderTotal(4_000)))).toEqual([4_000, 0, 1_000, 1_000]);
  });

  it("one claim's extra within a confirmed order total stays neutral (tax refunded inside what was paid)", () => {
    expect(parts(usd([credited("rf", "item:i:return_credit", 12_000, 12_960)], [], orderTotal(12_960)))).toEqual([12_000, 960, 0, 960]);
  });

  it("two credited claims on one loss → red even with no paid total", () => {
    expect(parts(usd([credited("a", "k", 4_000, 4_000), credited("b", "k", 4_000, 1_000)]))).toEqual([4_000, 0, 1_000, 1_000]);
  });

  describe("D222: with ≥ 2 credited claims only the excess no single claim explains is red", () => {
    // Same item, one loss of 120.00: A asked 25.00 and got 27.00 (the extra 2.00 is tax); B asked 120.00.
    const a = credited("a", "item:i", 2_500, 2_700);
    const b = (got: number) => credited("b", "item:i", 12_000, got);

    it("A credited 27.00 + B credited 120.00 → Recovered 120.00, neutral 2.00 (A's own extra), red 25.00", () => {
      expect(parts(usd([a, b(12_000)]))).toEqual([12_000, 200, 2_500, 2_700]);
    });

    it("B only partly credited (100.00) → neutral 2.00, red 5.00", () => {
      expect(parts(usd([a, b(10_000)]))).toEqual([12_000, 200, 500, 700]);
    });

    it("Σ net within the loss (27.00 + 90.00 ≤ 120.00) → no excess, nothing neutral, nothing red", () => {
      expect(parts(usd([a, b(9_000)]))).toEqual([11_700, 0, 0, 0]);
    });

    it("the neutral part never exceeds the excess: two claims each credited above their asks, excess smaller than both extras", () => {
      // loss 120.00; A 100.00 → 110.00 (+10.00), B 120.00 → 125.00 (+5.00); Σ net 235.00, excess 115.00 → neutral 15.00, red 100.00.
      expect(parts(usd([credited("a", "k", 10_000, 11_000), credited("b", "k", 12_000, 12_500)]))).toEqual([12_000, 1_500, 10_000, 11_500]);
      // A 50.00 → 60.00, B 60.00 → 65.00; loss 60.00, Σ net 125.00, excess 65.00 → neutral 15.00, red 50.00.
      expect(parts(usd([credited("a", "k", 5_000, 6_000), credited("b", "k", 6_000, 6_500)]))).toEqual([6_000, 1_500, 5_000, 6_500]);
    });

    it("one credited claim stays all neutral, as before (D196), even beside an uncredited claim on the same loss", () => {
      // loss 25.00 (A's ask; B asked 20.00 and got nothing): A's 27.00 → Recovered 25.00, neutral 2.00, nothing red.
      expect(parts(usd([a, credited("b", "item:i", 2_000, 0)]))).toEqual([2_500, 200, 0, 200]);
    });

    it("the paid cap still applies after the split, and I2/I2b hold: a confirmed 100.00 order total moves 20.00 more to red", () => {
      const s = usd([a, b(12_000)], [], orderTotal(10_000));
      expect(parts(s)).toEqual([10_000, 200, 4_500, 4_700]);
      expect(s.recoveredMinor + s.overCreditMinor).toBe(2_700 + 12_000); // I2
      expect(s.extraCreditedMinor + s.possibleDoubleCreditMinor).toBe(s.overCreditMinor); // I2b
      // An item-only 120.00 total is not exceeded by the 120.00 recovered: nothing moves.
      expect(parts(usd([a, b(12_000)], [], itemOnly(12_000)))).toEqual([12_000, 200, 2_500, 2_700]);
    });

    it("mixed currencies: the USD split and a EUR split are computed and reported separately, never summed", () => {
      const rows = computeSummary(
        [a, b(12_000), credited("e1", "item:j", 2_500, 2_700, "EUR"), credited("e2", "item:j", 12_000, 10_000, "EUR")],
        [],
        new Map(),
      );
      const byCur = Object.fromEntries(rows.map((r) => [r.currency, parts(r as ReturnType<typeof usd>)]));
      expect(byCur).toEqual({ USD: [12_000, 200, 2_500, 2_700], EUR: [12_000, 200, 500, 700] });
    });
  });

  it("mixed currencies stay separate: USD red and EUR neutral never mix, never sum", () => {
    const rows = computeSummary(
      [credited("u1", "a", 3_000, 3_000), credited("u2", "b", 3_000, 3_000), credited("e1", "c", 2_500, 2_700, "EUR")],
      [],
      itemOnly(4_000),
    );
    const byCur = Object.fromEntries(rows.map((r) => [r.currency, [r.recoveredMinor, r.extraCreditedMinor, r.possibleDoubleCreditMinor]]));
    expect(byCur).toEqual({ EUR: [2_500, 200, 0], USD: [4_000, 0, 2_000] });
  });
});

describe("DA-B-13 (D196): refused — the merchant said no, no money yet — inside the disjoint tile set", () => {
  const sent = (o: Partial<SummaryClaim> & Pick<SummaryClaim, "id">) => claim({ expectedMinor: 4_000, lossKeys: ["k"], status: "sent", delivery: "sent", ...o });

  it("a sent claim whose newest classified reply is a refusal → refused, not asked", () => {
    const s = usd([sent({ id: "a", refused: true })]);
    expect(s.tiles.refused).toEqual({ amountMinor: 4_000, provisionalMinor: 0, components: 1 });
    expect(s.tiles.asked.amountMinor).toBe(0);
  });

  it("precedence promised > refused > asked on one loss", () => {
    expect(usd([sent({ id: "a", refused: true }), sent({ id: "b" })]).tiles.refused.amountMinor).toBe(4_000);
    const p = usd([sent({ id: "a", refused: true }), sent({ id: "b", status: "promised", promisedMinor: 4_000 })]);
    expect([p.tiles.promised.amountMinor, p.tiles.refused.amountMinor]).toEqual([4_000, 0]);
  });

  it("D223: a promise followed by a refusal → refused, not promised (the refusal is the newest answer)", () => {
    // `refused` is true only when no promise or credit was recorded after the refusal (refusedState).
    const s = usd([sent({ id: "a", expectedMinor: 2_500, status: "promised", promisedMinor: 2_500, refused: true })]);
    expect([s.tiles.promised.amountMinor, s.tiles.refused.amountMinor]).toEqual([0, 2_500]);
  });

  it("D223: a refusal followed by a promise → promised (the promise undid the refusal)", () => {
    const s = usd([sent({ id: "a", expectedMinor: 2_500, status: "promised", promisedMinor: 2_500, refused: false })]);
    expect([s.tiles.promised.amountMinor, s.tiles.refused.amountMinor]).toEqual([2_500, 0]);
  });

  it("D223: precedence across claims is unchanged — another claim's live promise still wins the component", () => {
    const s = usd([
      sent({ id: "a", status: "promised", promisedMinor: 4_000, refused: true }),
      sent({ id: "b", status: "promised", promisedMinor: 4_000 }),
    ]);
    expect([s.tiles.promised.amountMinor, s.tiles.refused.amountMinor]).toEqual([4_000, 0]);
  });

  it("a refused claim that is closed for asking sits in no tile", () => {
    const s = usd([sent({ id: "a", refused: true, status: "dismissed", closedForAsk: true })]);
    expect(TILES.every((t) => s.tiles[t].components === 0)).toBe(true);
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
    let refusedComponents = 0;
    let mixedComponents = 0; // D222: components with both a neutral and a red part
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
          delivery: pick(DELIVERIES), closedForAsk: status === "confirmed", refused: rnd() < 0.25, anchor: pick(["purchase:p1", "purchase:p2"]),
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
        // C4 precedence (D196): promised > refused > asked > sendingOrUnknown > ready > potential.
        for (const k of withOpen) {
          const open = k.claims.filter((c) => !c.closedForAsk);
          // D223: a claim refused after its promise is refused, not promised.
          const promised = open.some((c) => !c.refused && c.status === "promised" && c.promisedMinor > Math.max(0, c.confirmedMinor - c.debitedMinor));
          if (promised) expect(k.tile).toBe("promised");
          if (!promised && open.some((c) => c.refused)) expect(k.tile).toBe("refused");
          if (k.tile === "refused") expect(open.some((c) => c.refused) && !promised).toBe(true);
        }
        refusedComponents += withOpen.filter((k) => k.tile === "refused").length;
        // I2: Recovered + Over-credit = Σ net.
        expect(cur.recoveredMinor + cur.overCreditMinor).toBe(cs.reduce((a, c) => a + Math.max(0, c.confirmedMinor - c.debitedMinor), 0));
        // I2b (D196): extra credit + possible double credit = over-credit, neither negative.
        expect(cur.extraCreditedMinor + cur.possibleDoubleCreditMinor).toBe(cur.overCreditMinor);
        expect(Math.min(cur.extraCreditedMinor, cur.possibleDoubleCreditMinor)).toBeGreaterThanOrEqual(0);
        // D222, per component before the cap: neutral = min(excess, Σ each claim's credit above its own ask); red = the
        // rest; with one credited claim the whole excess is neutral.
        for (const k of comps) {
          const nets = k.claims.map((c) => Math.max(0, c.confirmedMinor - c.debitedMinor));
          const excess = nets.reduce((x, y) => x + y, 0) - k.recovered;
          const ownExtra = k.claims.reduce((x, c, i) => x + Math.max(0, nets[i] - c.expectedMinor), 0);
          const creditedCount = nets.filter((n) => n > 0).length;
          const neutral = creditedCount >= 2 ? Math.min(excess, ownExtra) : excess;
          expect([k.extraCredited, k.possibleDoubleCredit]).toEqual([neutral, excess - neutral]);
          if (k.extraCredited > 0 && k.possibleDoubleCredit > 0) mixedComponents += 1;
        }
        // D196 red rule: red only with ≥ 2 credited claims in one component, or a paid total that applies and is
        // confirmed, or item-only with ≥ 2 credited claims on the transaction.
        if (cur.possibleDoubleCreditMinor > 0) {
          const pp = paid.get("purchase:p1");
          const credited = (c: SummaryClaim) => c.confirmedMinor - c.debitedMinor > 0;
          const twoInOne = comps.some((k) => k.claims.filter(credited).length >= 2);
          const onP1 = comps.filter((k) => k.anchor === "purchase:p1").reduce((a, k) => a + k.claims.filter(credited).length, 0);
          const byCap = pp !== undefined && pp.currency === cur.currency && (!pp.partial || onP1 >= 2);
          expect(twoInOne || byCap).toBe(true);
        }
        // I1: Σ tiles = Σ outstanding (uncapped outstanding is an upper bound; capping only lowers it).
        const uncapped = comps.reduce((a, k) => a + k.outstanding, 0);
        expect(tileSum).toBeLessThanOrEqual(uncapped);
        if (!cur.cappedAtPaidTotal) expect(tileSum).toBe(uncapped);
        // I4 (D188, D196): per transaction per currency, Σ (recovered + outstanding) ≤ the paid total after the cap —
        // confirmed money included; anything above it sits on the extra-credit or possible-double-credit line.
        const p = paid.get("purchase:p1");
        if (p && p.currency === cur.currency) {
          const capped = components(cs, os);
          applyPaidCap(capped, paid, cur.currency);
          const anchored = capped.filter((k) => k.anchor === "purchase:p1");
          expect(anchored.reduce((a, k) => a + k.recovered + k.outstanding, 0)).toBeLessThanOrEqual(p.amountMinor);
        }
        // I5: no cap value or face value enters a sum: every figure is bounded by the members' own amounts.
        const lossBound = comps.reduce((a, k) => a + Math.max(0, ...k.claims.map((c) => c.expectedMinor), ...k.opportunities.map((o) => o.estimateMinor)), 0);
        expect(tileSum + cur.recoveredMinor).toBeLessThanOrEqual(lossBound);
        for (const t of TILES) expect(cur.tiles[t].provisionalMinor).toBeLessThanOrEqual(cur.tiles[t].amountMinor);
      }
    }
    expect(componentsWithOpen).toBeGreaterThan(1_000); // the generator really exercises open components
    expect(refusedComponents).toBeGreaterThan(100); // …and the refused tile
    expect(mixedComponents).toBeGreaterThan(20); // …and the D222 neutral + red mix
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
  async function claimRow(t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> }, o: { expected: number; status?: "detected" | "confirmed" | "sent" | "promised"; confirmed?: number; isExample?: boolean; type?: "price_adjustment" | "return_credit" }) {
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

  it("D188: a confirmed 2,000 price adjustment + a confirmed 4,000 return refund on a 4,000 item → Recovered 4,000, over-credit 2,000", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Summit", merchantDomain: "summit.example", purchasedAt: NOW - 86_400_000, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Fleece", unitCents: 4_000, qty: 1, returned: true });
      return { purchaseId, itemId };
    });
    await claimRow(t, userId, w, { expected: 2_000, status: "confirmed", confirmed: 2_000 });
    await claimRow(t, userId, w, { expected: 4_000, status: "confirmed", confirmed: 4_000, type: "return_credit" });
    const usdRow = (await as.query(api.recovery.summary, { now: NOW })).currencies.find((c) => c.currency === "USD")!;
    expect([usdRow.recoveredMinor, usdRow.overCreditMinor, usdRow.cappedAtPaidTotal, usdRow.paidTotalPartial]).toEqual([4_000, 2_000, true, true]);
    expect([usdRow.extraCreditedMinor, usdRow.possibleDoubleCreditMinor]).toEqual([0, 2_000]); // D196: two credits over the item → red
  });

  it("DA-B-8 S1 end to end: one 25.00 price adjustment refunded as 27.00 → Recovered 25.00, neutral 2.00, nothing red", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await seedItem(t, userId);
    await claimRow(t, userId, w, { expected: 2_500, status: "confirmed", confirmed: 2_700 });
    const usdRow = (await as.query(api.recovery.summary, { now: NOW })).currencies.find((c) => c.currency === "USD")!;
    expect([usdRow.recoveredMinor, usdRow.extraCreditedMinor, usdRow.possibleDoubleCreditMinor, usdRow.overCreditMinor]).toEqual([2_500, 200, 0, 200]);
  });

  async function sentClaim(t: T, userId: Id<"users">) {
    const w = await seedItem(t, userId);
    const claimId = await claimRow(t, userId, w, { expected: 4_000, status: "sent" });
    await t.run((ctx) => ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "help@acme.example", subject: "s", body: "b", agentmailMessageId: `m-${claimId}` }));
    const reply = (classification: "refusal" | "other" | "question") =>
      t.run((ctx) => ctx.db.insert("replies", { claimId, userId, messageId: `r-${classification}-${Math.random()}`, from: "help@acme.example", classification, summary: "s", senderMismatch: false, receivedAt: NOW }));
    const event = (kind: "promised_credit" | "confirmed_credit", cents: number) =>
      t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind, cents, evidence: "test" }));
    return { claimId, reply, event };
  }

  it("DA-B-13: newest classified reply a refusal → `refused`; an auto-reply after it changes nothing; a later credit undoes it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { reply, event } = await sentClaim(t, userId);
    const tiles = async () => (await as.query(api.recovery.summary, { now: NOW })).currencies[0].tiles;
    expect(await tiles()).toMatchObject({ asked: { amountMinor: 4_000 }, refused: { amountMinor: 0 } });
    await reply("refusal");
    expect(await tiles()).toMatchObject({ asked: { amountMinor: 0 }, refused: { amountMinor: 4_000, components: 1 } });
    await reply("other"); // auto-replies, receipts, marketing are not a classified answer
    expect(await tiles()).toMatchObject({ refused: { amountMinor: 4_000 } });
    await event("confirmed_credit", 1_000); // money after the refusal: no longer "said no"
    expect(await tiles()).toMatchObject({ refused: { amountMinor: 0 }, asked: { amountMinor: 3_000 } });
  });

  it("DA-B-13: a promise recorded BEFORE the refusal does not undo it; a newer question does", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { reply, event } = await sentClaim(t, userId);
    const tiles = async () => (await as.query(api.recovery.summary, { now: NOW })).currencies[0].tiles;
    await event("promised_credit", 4_000);
    await reply("refusal");
    expect(await tiles()).toMatchObject({ refused: { amountMinor: 4_000 }, asked: { amountMinor: 0 } });
    await reply("question");
    expect(await tiles()).toMatchObject({ refused: { amountMinor: 0 }, asked: { amountMinor: 4_000 } });
  });

  it("D223 end to end: promise, then refusal → refused; then a credit of the promised amount → out of both tiles", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await seedItem(t, userId);
    const claimId = await claimRow(t, userId, w, { expected: 2_500, status: "promised" });
    const tiles = async () => (await as.query(api.recovery.summary, { now: NOW })).currencies[0].tiles;
    await t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 2_500, evidence: "test" }));
    expect(await tiles()).toMatchObject({ promised: { amountMinor: 2_500 }, refused: { amountMinor: 0 } });
    await t.run((ctx) => ctx.db.insert("replies", { claimId, userId, messageId: "r-refusal", from: "help@acme.example", classification: "refusal", summary: "s", senderMismatch: false, receivedAt: NOW }));
    expect(await tiles()).toMatchObject({ promised: { amountMinor: 0 }, refused: { amountMinor: 2_500, components: 1 } });
    await t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind: "confirmed_credit", cents: 2_500, evidence: "test" }));
    const after = await tiles();
    expect([after.promised.amountMinor, after.refused.amountMinor]).toEqual([0, 0]);
    expect([after.promised.components, after.refused.components]).toEqual([0, 0]);
  });

  it("D223 end to end: refusal, then a promise → promised", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await seedItem(t, userId);
    const claimId = await claimRow(t, userId, w, { expected: 2_500, status: "promised" });
    await t.run((ctx) => ctx.db.insert("replies", { claimId, userId, messageId: "r-refusal", from: "help@acme.example", classification: "refusal", summary: "s", senderMismatch: false, receivedAt: NOW }));
    await t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 2_500, evidence: "test" }));
    const tiles = (await as.query(api.recovery.summary, { now: NOW })).currencies[0].tiles;
    expect([tiles.promised.amountMinor, tiles.refused.amountMinor]).toEqual([2_500, 0]);
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
