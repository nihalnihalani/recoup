/// <reference types="vite/client" />
/**
 * R01 dual-mode parity (contract rev 5 C3, D148): every R01 behaviour runs in BOTH modes and must open the same claims
 * as today's code (the parity reference is `5cc326d`'s recordCheck):
 *   - "legacy"  — no active R01 pack (the production state until the lead's activation commit): the legacy fallback;
 *   - "v1"      — R01 v1 forced active through the test-registry seam (`vi.mock` of lib/rules/registry).
 * Each scenario is run once per mode on a fresh deployment and the claim projections are compared field by field.
 * The ONE intentional difference (D160): a 0-decimal currency (JPY) — legacy opens a claim mis-scaled by 100,
 * v1 returns `unsupported` and opens nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { r01ObservationRejection, R01_V1_PARAMS } from "./lib/rules/r01_price_adjustment_v1";
import { implausiblyCheap, rejectionReason } from "./priceWatch";

type Mode = "legacy" | "v1";
const MODES: Mode[] = ["legacy", "v1"];
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);
const DOMAIN = "acme.example";
type T = ReturnType<typeof setup>;

function selectMode(mode: Mode) {
  if (mode === "legacy") setTestActivations([]); // nothing active → recordCheck's legacy fallback
  else resetTestRegistry(); // every implemented pack active → R01 v1
}
afterEach(() => resetTestRegistry());

type WorldOptions = {
  purchasedAt?: number; currency?: string; unitCents?: number; qty?: number; status?: "active" | "needs_review" | "archived";
  isExample?: boolean; returned?: boolean; productUrl?: string | null; windowDays?: number | null; confirmedByUser?: boolean;
  retrievedAt?: number;
};

async function world(t: T, userId: Id<"users">, o: WorldOptions = {}) {
  return await t.run(async (ctx) => {
    const purchasedAt = o.purchasedAt ?? NOW - 2 * DAY;
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: DOMAIN, purchasedAt, currency: o.currency ?? "USD",
      status: o.status ?? "active", ...(o.isExample ? { isExample: true } : {}),
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: o.unitCents ?? 12_000, qty: o.qty ?? 1,
      ...(o.productUrl === null ? {} : { productUrl: o.productUrl ?? `https://${DOMAIN}/p/jacket` }), returned: o.returned ?? false,
    });
    if (o.windowDays !== null) {
      await ctx.db.insert("policies", {
        userId, merchantDomain: DOMAIN, kind: "price_adjustment", ...(o.windowDays === undefined ? { windowDays: 14 } : { windowDays: o.windowDays }),
        channel: "email", contactEmail: "help@acme.example", passage: "We adjust the price within 14 days of purchase.",
        sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: o.retrievedAt ?? purchasedAt + 60_000, confidence: 0.9,
        confirmedByUser: o.confirmedByUser ?? false,
      });
    }
    return { purchaseId, itemId };
  });
}

const check = (itemId: Id<"items">, cents: number, over: Record<string, unknown> = {}) => ({
  itemId, sourceUrl: `https://${DOMAIN}/p/jacket`, observedCents: cents, currency: "USD", confidence: 0.92,
  isRange: false, variantMatch: "exact" as const, ...over,
});

/** What parity compares: the claims recordCheck left behind (ids replaced by relations) and its return value. */
async function projection(t: T, itemId: Id<"items">, results: { accepted: boolean; claimId: unknown; note?: string }[]) {
  const claims = await t.run((ctx) => ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
  const checks = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
  return {
    results: results.map((r) => ({ accepted: r.accepted, opened: r.claimId !== null, note: r.note ?? null })),
    claims: claims.map((c) => ({
      type: c.type, expectedCents: c.expectedCents, status: c.status, windowEndsAt: c.windowEndsAt ?? null,
      hasPolicy: c.policyId !== undefined, openedFromCheck: checks.findIndex((pc) => pc._id === c.openedFromPriceCheckId),
    })),
    acceptedCents: checks.map((c) => c.observedCents ?? null),
  };
}

type Scenario = {
  name: string;
  world?: WorldOptions;
  seed?: (t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> }) => Promise<void>;
  checks: (itemId: Id<"items">) => Parameters<typeof check>[] | ReturnType<typeof check>[];
  at?: number;
};

async function run(mode: Mode, s: Scenario) {
  selectMode(mode);
  const t = setup();
  const { userId } = await signedIn(t);
  const w = await world(t, userId, s.world);
  if (s.seed) await s.seed(t, userId, w);
  const results = [];
  for (const c of s.checks(w.itemId) as ReturnType<typeof check>[]) {
    results.push(await t.mutation(internal.priceWatch.recordCheck, c));
  }
  return { ...(await projection(t, w.itemId, results)), t, userId, w };
}

const SCENARIOS: Scenario[] = [
  { name: "qualifying drop on an unconfirmed policy → exactly one claim (DA-A-2)", checks: (i) => [check(i, 9_500)] },
  { name: "two units at 12,000, eligible 9,500 → 5,000 (mission §17)", world: { qty: 2 }, checks: (i) => [check(i, 9_500)] },
  { name: "GBP purchase + GBP observation → claim (DA-A-13)", world: { currency: "GBP" }, checks: (i) => [check(i, 9_500, { currency: "GBP" })] },
  { name: "GBP purchase + USD observation → rejected (DA-A-13)", world: { currency: "GBP" }, checks: (i) => [check(i, 9_500)] },
  { name: "below threshold → no claim", checks: (i) => [check(i, 11_900)] },
  { name: "threshold boundary: exactly 2% (240) opens, 239 does not", checks: (i) => [check(i, 11_761), check(i, 11_760)] },
  { name: "price went up → no claim", checks: (i) => [check(i, 13_000)] },
  { name: "window closed → no claim, observation still stored", world: { purchasedAt: NOW - 30 * DAY }, checks: (i) => [check(i, 9_500)] },
  { name: "duplicate checks a minute apart → one claim (Claim already open)", checks: (i) => [check(i, 9_500), check(i, 9_400)] },
  { name: "open claim then a sub-threshold check → still one claim", checks: (i) => [check(i, 9_500), check(i, 11_950)] },
  { name: "variant unsure / none / low confidence / range / implausibly cheap / no currency → no claim", checks: (i) => [
    check(i, 9_500, { variantMatch: "unsure" }), check(i, 9_500, { variantMatch: "none" }), check(i, 9_500, { confidence: 0.69 }),
    check(i, 9_500, { isRange: true }), check(i, 1_199), check(i, 9_500, { currency: undefined }), check(i, 0),
  ] },
  { name: "needs_review purchase → no claim", world: { status: "needs_review" }, checks: (i) => [check(i, 9_500)] },
  { name: "archived purchase → no claim", world: { status: "archived" }, checks: (i) => [check(i, 9_500)] },
  { name: "example purchase → no claim", world: { isExample: true }, checks: (i) => [check(i, 9_500)] },
  { name: "returned item → no claim", world: { returned: true }, checks: (i) => [check(i, 9_500)] },
  { name: "no policy → no claim (source_unverified)", world: { windowDays: null }, checks: (i) => [check(i, 9_500)] },
  { name: "policy without windowDays → no claim", world: { windowDays: undefined, confirmedByUser: true }, seed: async (t, userId) => {
    await t.run((ctx) => ctx.db.insert("policies", { userId, merchantDomain: DOMAIN, kind: "price_adjustment", channel: "email", passage: "p", sourceUrl: `https://${DOMAIN}/p2`, retrievedAt: NOW, confidence: 0.9, confirmedByUser: true }));
  }, checks: (i) => [check(i, 9_500)] },
  { name: "a settled 5,000 then a deeper drop → only the difference (new loss)", world: { qty: 2 }, seed: async (t, userId, w) => {
    await t.run((ctx) => ctx.db.insert("claims", { purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: 5_000, status: "confirmed", token: "PAID01", version: 1 }));
  }, checks: (i) => [check(i, 9_500), check(i, 9_000)] },
  { name: "a dismissed claim does not block a new one", seed: async (t, userId, w) => {
    await t.run((ctx) => ctx.db.insert("claims", { purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "dismissed", token: "DISM01", version: 1 }));
  }, checks: (i) => [check(i, 9_500)] },
  { name: "N7: a later CONFIRMED snapshot with a different window wins (A-T2 in v1)", world: { windowDays: 1, confirmedByUser: false, purchasedAt: NOW - 12 * DAY }, seed: async (t, userId) => {
    await t.run((ctx) => ctx.db.insert("policies", { userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: 30, channel: "email", passage: "30 days", sourceUrl: `https://${DOMAIN}/policy-v2`, retrievedAt: NOW, confidence: 0.9, confirmedByUser: true }));
  }, checks: (i) => [check(i, 9_500)] },
  { name: "legacy window by 24-hour multiples across DST (R01-05): open at the instant, closed one minute after", world: { purchasedAt: Date.parse("2026-10-25T12:00:00-04:00") }, checks: (i) => [check(i, 9_500)], at: Date.parse("2026-11-08T11:00:00-05:00") },
  { name: "…and one minute past the window no claim auto-opens (R01-05c)", world: { purchasedAt: Date.parse("2026-10-25T12:00:00-04:00") }, checks: (i) => [check(i, 9_500)], at: Date.parse("2026-11-08T11:01:00-05:00") },
];

describe("R01 dual-mode parity: legacy fallback vs R01 v1 open the same claims", () => {
  pinClockEach(NOW);

  it.each(SCENARIOS.map((s) => [s.name, s] as const))("%s", async (_name, s) => {
    const out: Record<Mode, Awaited<ReturnType<typeof run>>> = {} as never;
    for (const mode of MODES) {
      if (s.at !== undefined) vi.setSystemTime(s.at);
      out[mode] = await run(mode, s);
    }
    const strip = (x: Awaited<ReturnType<typeof run>>) => ({ results: x.results, claims: x.claims, acceptedCents: x.acceptedCents });
    expect(strip(out.v1)).toEqual(strip(out.legacy));
  });

  it("spot values: DA-A-2 opens 2,500; qty 2 → 5,000; GBP → a GBP claim; settled + deeper drop → 1,000 (hand-written)", async () => {
    for (const mode of MODES) {
      expect((await run(mode, SCENARIOS[0])).claims.map((c) => c.expectedCents)).toEqual([2_500]);
      expect((await run(mode, SCENARIOS[1])).claims.map((c) => c.expectedCents)).toEqual([5_000]);
      expect((await run(mode, SCENARIOS[2])).claims.map((c) => c.expectedCents)).toEqual([2_500]);
      expect((await run(mode, SCENARIOS[3])).claims).toEqual([]);
      const settled = await run(mode, SCENARIOS.find((s) => s.name.startsWith("a settled"))!);
      expect(settled.claims.filter((c) => c.status === "detected").map((c) => c.expectedCents)).toEqual([1_000]);
      // N7: the newest CONFIRMED snapshot (30 days, retrieved 12 days after purchase) is the one used in both modes.
      const n7 = await run(mode, SCENARIOS.find((s) => s.name.startsWith("N7"))!);
      expect(n7.claims.map((c) => c.windowEndsAt)).toEqual([NOW - 12 * DAY + 30 * DAY]);
      if (mode === "v1") {
        const [opp] = await n7.t.run((ctx) => ctx.db.query("opportunities").collect());
        const evaluation = (await n7.t.run((ctx) => ctx.db.get(opp.currentEvaluationId!)))!;
        expect(evaluation.assumptions.map((a) => a.id)).toContain("A-T2");
      }
    }
  });

  it("D160 (the one intentional divergence): a JPY purchase — legacy opens a claim mis-scaled by 100; v1 is unsupported, no claim", async () => {
    const s: Scenario = { name: "jpy", world: { currency: "JPY" }, checks: (i) => [check(i, 9_500, { currency: "JPY" })] };
    const legacy = await run("legacy", s);
    expect(legacy.claims.map((c) => c.expectedCents)).toEqual([2_500]); // "2,500" JPY minor units: ×100 wrong (HC-8)
    const v1 = await run("v1", s);
    expect(v1.claims).toEqual([]);
    const [opp] = await v1.t.run((ctx) => ctx.db.query("opportunities").collect());
    expect(opp.outcome).toBe("unsupported");
  });

  it("the v1 acceptance bars equal the legacy ones (priceWatch.rejectionReason + implausiblyCheap) over a grid", () => {
    const grid = [];
    for (const variantMatch of ["exact", "unsure", "none"] as const)
      for (const confidence of [0.69, 0.7, 0.95])
        for (const isRange of [false, true])
          for (const cents of [0, 1, 1_199, 1_200, 9_500])
            for (const currency of ["USD", "GBP"]) grid.push({ variantMatch, confidence, isRange, cents, currency });
    for (const g of grid) {
      const legacy = rejectionReason({ observedCents: g.cents, currency: g.currency, confidence: g.confidence, isRange: g.isRange, variantMatch: g.variantMatch }, "USD", "the purchase was")
        ?? implausiblyCheap(g.cents, 12_000);
      const v1 = r01ObservationRejection({ amountMinor: g.cents, currency: g.currency }, { variantMatch: g.variantMatch, confidence: g.confidence, isRange: g.isRange }, "USD", 12_000, R01_V1_PARAMS);
      expect(v1, JSON.stringify(g)).toBe(legacy);
    }
  });
});

describe("DA-A-22 (wave 2, M2C in priceWatch — stub prepared by M12)", () => {
  // The pure rule is in the R01 v1 pack and passes fixture R01-10 (caseContext.deniedObservedMinor + r01AutoOpen).
  // The wave-1 schema has no `denied` claim status; M2C wires `recordDenial`'s claims into r01Runs' case context
  // (deniedObservedMinor = the denied claim's opening observation) and turns these into real tests.
  it.todo("a denied claim at the same price → no claim (only a user-initiated 'ask again' reopens it)");
  it.todo("a lower price after a denial → one claim for (deniedObserved − new) × qty only, subject to the per-unit threshold");
});

describe("R01 v1 only: what the retrofit adds (DA-A-3, S-M03-3 unaffected)", () => {
  pinClockEach(NOW);

  it("DA-A-3 through recordCheck: a legacy open claim is linked, never duplicated; Potential 0; recordCheck returns normally", async () => {
    selectMode("v1");
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    const legacyClaimId = await t.run((ctx) => ctx.db.insert("claims", {
      purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "sent", token: "LEGACY", version: 1,
    }));
    const r = await t.mutation(internal.priceWatch.recordCheck, check(w.itemId, 9_400));
    expect(r).toMatchObject({ accepted: true, claimId: null, note: "Claim already open" });
    const claims = await t.run((ctx) => ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", w.itemId)).collect());
    expect(claims).toHaveLength(1);
    const [opp] = await t.run((ctx) => ctx.db.query("opportunities").collect());
    expect(opp).toMatchObject({ activeClaimId: legacyClaimId, status: "case_open" });
    expect(claims[0].opportunityId).toBe(opp._id);
    const s = await as.query(api.recovery.summary, { now: NOW });
    expect(s.currencies[0].tiles.potential.amountMinor).toBe(0);
    expect(s.currencies[0].tiles.asked.amountMinor).toBe(2_500);
  });

  it("an auto-opened v1 claim is linked to its opportunity and carries the link fields", async () => {
    selectMode("v1");
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    const r = await t.mutation(internal.priceWatch.recordCheck, check(w.itemId, 9_500));
    const claim = (await t.run((ctx) => ctx.db.get(r.claimId!)))!;
    const [opp] = await t.run((ctx) => ctx.db.query("opportunities").collect());
    expect(claim).toMatchObject({ opportunityId: opp._id, scenarioId: "R01", remedyKey: "price_difference", currency: "USD", lossKeys: [`item:${w.itemId}:price_diff:1`] });
    expect(opp).toMatchObject({ activeClaimId: r.claimId, status: "case_open" });
  });

  it("legacy mode writes no opportunity rows (the fallback is today's code)", async () => {
    selectMode("legacy");
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    await t.mutation(internal.priceWatch.recordCheck, check(w.itemId, 9_500));
    expect(await t.run((ctx) => ctx.db.query("opportunities").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("transactions").collect())).toEqual([]);
  });
});
