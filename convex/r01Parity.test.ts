/// <reference types="vite/client" />
/**
 * M16 — R01 parity against the PRE-MISSION behaviour at `5cc326d` (contract §10 R01 "claim-opening is identical to
 * `5cc326d` for the legacy tier"; rev 5 C3; D160; DA-A-2, DA-A-3, DA-A-13, N7), written by QA independently of M12.
 *
 * How the expected table was built (not by the code under test):
 *   1. The scenario block between the `<scenarios>` markers below is self-contained: it seeds rows exactly as the
 *      old code stored them (users, purchases, items, policies, earlier claims) and drives the cron's write path,
 *      `priceWatch.recordCheck`, through a timed sequence of observations. Its only dependencies are `t.run`,
 *      `t.mutation` and the `recordCheck` reference, which exist unchanged at `5cc326d`.
 *   2. A throwaway worktree at `5cc326d` (Mission 2 start, D134) ran that same block, extracted verbatim from this
 *      file, and printed each scenario's projection (2026-09-23; recorder: `docs/reviews/2026-09-23-wave1-qa.md`
 *      §2). Those projections are `EXPECTED_5CC326D` below, pasted unchanged.
 *   3. This file runs every scenario in BOTH modes (C3): `legacy` (no active pack: the production state until the
 *      lead's activation commit) and `v1` (R01 v1 forced active through the test-registry seam), and compares each
 *      projection with the 5cc326d one.
 * The projection is what "claim-opening" means for a user: per observation, accepted or rejected and whether it
 * opened a claim; per claim, type, status, expected amount, window end (relative to the purchase), the policy it
 * cites and the observation it was opened from. Note wording is not compared (v1 may explain differently).
 *
 * The ONLY allowed difference is D160: a 0-decimal currency (JPY). The legacy flow mis-scales it by 100 (HC-8) and
 * opens a claim; v1 returns `unsupported` and opens nothing. `ALLOWED_V1_DIFFERENCES` names exactly that scenario,
 * and the test also asserts the difference is really there (so the allowance cannot hide a regression elsewhere).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";

// <scenarios> — shared verbatim with the 5cc326d recorder; keep it free of imports and of post-5cc326d APIs.
const P_DAY = 86_400_000;
const P_MIN = 60_000;
const P_BASE = Date.UTC(2026, 8, 20, 14);

type PCheck = { atMs: number; observedCents?: number; currency?: string; confidence?: number; isRange?: boolean; variantMatch?: "exact" | "unsure" | "none" };
type PPolicy = { windowDays: number | null; confirmedByUser?: boolean; retrievedAtMs: number; kind?: "price_adjustment" | "returns" };
type PScenario = {
  id: string;
  currency?: string;
  status?: "active" | "needs_review" | "archived";
  isExample?: boolean;
  purchasedAtMs?: number;
  unitCents?: number;
  qty?: number;
  returned?: boolean;
  productUrl?: string | null;
  policies?: PPolicy[];
  priorPriceClaims?: Array<{ status: "confirmed" | "detected" | "dismissed" | "sent"; expectedCents: number }>;
  checks: PCheck[];
};

const exact = (atMs: number, observedCents: number, extra: Partial<PCheck> = {}): PCheck => ({ atMs, observedCents, currency: "USD", confidence: 0.92, variantMatch: "exact", ...extra });
const std = (extra: Partial<PPolicy> = {}): PPolicy => ({ windowDays: 14, confirmedByUser: true, retrievedAtMs: P_BASE - 2 * P_DAY + 10 * P_MIN, ...extra });
const T1 = P_BASE; // two days after the default purchase

const SCENARIOS: PScenario[] = [
  { id: "basic-drop", policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "threshold-2pct-below", unitCents: 20_000, policies: [std()], checks: [exact(T1, 19_601)] },
  { id: "threshold-2pct-equal", unitCents: 20_000, policies: [std()], checks: [exact(T1, 19_600)] },
  { id: "threshold-floor-below", unitCents: 3_000, policies: [std()], checks: [exact(T1, 2_901)] },
  { id: "threshold-floor-equal", unitCents: 3_000, policies: [std()], checks: [exact(T1, 2_900)] },
  { id: "two-units", unitCents: 12_000, qty: 2, policies: [std()], checks: [exact(T1, 9_500)] },
  { id: "variant-unsure", policies: [std()], checks: [exact(T1, 9_000, { variantMatch: "unsure" })] },
  { id: "variant-none", policies: [std()], checks: [exact(T1, 9_000, { variantMatch: "none" })] },
  { id: "currency-mismatch", policies: [std()], checks: [exact(T1, 9_000, { currency: "EUR" })] },
  { id: "gbp-gbp", currency: "GBP", policies: [std()], checks: [exact(T1, 9_000, { currency: "GBP" })] },
  { id: "gbp-usd", currency: "GBP", policies: [std()], checks: [exact(T1, 9_000, { currency: "USD" })] },
  { id: "jpy-zero-decimal", currency: "JPY", unitCents: 1_200_000, policies: [std()], checks: [exact(T1, 900_000, { currency: "JPY" })] },
  { id: "range", policies: [std()], checks: [exact(T1, 9_000, { isRange: true })] },
  { id: "low-confidence", policies: [std()], checks: [exact(T1, 9_000, { confidence: 0.5 })] },
  { id: "implausibly-cheap", policies: [std()], checks: [exact(T1, 1_000)] },
  { id: "no-price", policies: [std()], checks: [{ atMs: T1, currency: "USD", confidence: 0.92, variantMatch: "exact" }] },
  { id: "zero-price", policies: [std()], checks: [exact(T1, 0)] },
  { id: "no-policy", checks: [exact(T1, 9_000)] },
  { id: "policy-without-window", policies: [std({ windowDays: null })], checks: [exact(T1, 9_000)] },
  { id: "returns-policy-only", policies: [std({ kind: "returns", windowDays: 30 })], checks: [exact(T1, 9_000)] },
  { id: "window-closed", purchasedAtMs: P_BASE - 20 * P_DAY, policies: [std({ retrievedAtMs: P_BASE - 20 * P_DAY + 10 * P_MIN })], checks: [exact(T1, 9_000)] },
  { id: "window-end-minus-1min", purchasedAtMs: P_BASE - 14 * P_DAY + P_MIN, policies: [std({ retrievedAtMs: P_BASE - 14 * P_DAY + 10 * P_MIN })], checks: [exact(T1, 9_000)] },
  { id: "window-end-plus-1min", purchasedAtMs: P_BASE - 14 * P_DAY - P_MIN, policies: [std({ retrievedAtMs: P_BASE - 14 * P_DAY + 10 * P_MIN })], checks: [exact(T1, 9_000)] },
  { id: "unconfirmed-policy", policies: [std({ confirmedByUser: false })], checks: [exact(T1, 9_000)] },
  { id: "repeat-same-price", policies: [std()], checks: [exact(T1, 9_000), exact(T1 + 30 * P_MIN, 9_000)] },
  { id: "deeper-drop-while-open", policies: [std()], checks: [exact(T1, 9_000), exact(T1 + P_DAY, 7_000)] },
  { id: "settled-then-deeper", policies: [std()], priorPriceClaims: [{ status: "confirmed", expectedCents: 3_000 }], checks: [exact(T1, 7_000)] },
  { id: "settled-then-tiny", policies: [std()], priorPriceClaims: [{ status: "confirmed", expectedCents: 3_000 }], checks: [exact(T1, 8_900)] },
  { id: "dismissed-prior", policies: [std()], priorPriceClaims: [{ status: "dismissed", expectedCents: 3_000 }], checks: [exact(T1, 9_000)] },
  { id: "open-legacy-claim", policies: [std()], priorPriceClaims: [{ status: "detected", expectedCents: 2_000 }], checks: [exact(T1, 9_000)] },
  { id: "sent-legacy-claim", policies: [std()], priorPriceClaims: [{ status: "sent", expectedCents: 2_000 }], checks: [exact(T1, 9_000)] },
  {
    id: "n7-newer-confirmed-window",
    purchasedAtMs: P_BASE - 20 * P_DAY,
    policies: [std({ retrievedAtMs: P_BASE - 20 * P_DAY + 10 * P_MIN }), std({ windowDays: 30, retrievedAtMs: P_BASE - 5 * P_DAY })],
    checks: [exact(T1, 9_000)],
  },
  {
    id: "n7-newer-unconfirmed-window",
    purchasedAtMs: P_BASE - 20 * P_DAY,
    policies: [std({ retrievedAtMs: P_BASE - 20 * P_DAY + 10 * P_MIN }), std({ windowDays: 30, confirmedByUser: false, retrievedAtMs: P_BASE - 5 * P_DAY })],
    checks: [exact(T1, 9_000)],
  },
  { id: "needs-review-purchase", status: "needs_review", policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "archived-purchase", status: "archived", policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "example-purchase", isExample: true, policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "returned-item", returned: true, policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "no-product-url", productUrl: null, policies: [std()], checks: [exact(T1, 9_000)] },
  { id: "price-rises-then-drops", policies: [std()], checks: [exact(T1, 12_500), exact(T1 + P_DAY, 9_000)] },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyT = { run: (fn: (ctx: any) => Promise<any>) => Promise<any>; mutation: (ref: any, args: any) => Promise<any> };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runScenario(t: AnyT, s: PScenario, recordCheck: any, setTime: (ms: number) => void) {
  const purchasedAt = s.purchasedAtMs ?? P_BASE - 2 * P_DAY;
  setTime(purchasedAt);
  const ids = await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { name: `parity ${s.id}` });
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt, currency: s.currency ?? "USD",
      status: s.status ?? "active", ...(s.isExample ? { isExample: true } : {}),
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: s.unitCents ?? 12_000, qty: s.qty ?? 1, returned: s.returned ?? false,
      ...(s.productUrl === null ? {} : { productUrl: s.productUrl ?? "https://acme.example/p/jacket" }),
    });
    const policyIds: unknown[] = [];
    for (const p of s.policies ?? []) {
      policyIds.push(await ctx.db.insert("policies", {
        userId, merchantDomain: "acme.example", kind: p.kind ?? "price_adjustment", ...(p.windowDays === null ? {} : { windowDays: p.windowDays }),
        channel: "email", contactEmail: "help@acme.example", passage: "We adjust prices within the window.", sourceUrl: "https://acme.example/policy",
        retrievedAt: p.retrievedAtMs, confidence: 0.9, confirmedByUser: p.confirmedByUser ?? true,
      }));
    }
    const priorClaimIds: unknown[] = [];
    let n = 0;
    for (const c of s.priorPriceClaims ?? []) {
      n += 1;
      priorClaimIds.push(await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "price_adjustment", expectedCents: c.expectedCents, status: c.status,
        token: `PRIOR${n}${s.id.length}`.slice(0, 12).toUpperCase(), version: 1,
        ...(policyIds[0] ? { policyId: policyIds[0] } : {}), windowEndsAt: purchasedAt + 14 * P_DAY,
      }));
    }
    return { userId, purchaseId, itemId, policyIds, priorClaimIds };
  });

  const checks: Array<{ accepted: boolean; opened: boolean }> = [];
  const checkIds: unknown[] = [];
  for (const c of s.checks) {
    setTime(c.atMs);
    const r = await t.mutation(recordCheck, {
      itemId: ids.itemId, sourceUrl: "https://acme.example/p/jacket",
      ...(c.observedCents === undefined ? {} : { observedCents: c.observedCents }),
      ...(c.currency === undefined ? {} : { currency: c.currency }),
      ...(c.confidence === undefined ? {} : { confidence: c.confidence }),
      ...(c.isRange === undefined ? {} : { isRange: c.isRange }),
      ...(c.variantMatch === undefined ? {} : { variantMatch: c.variantMatch }),
    });
    checkIds.push(r.priceCheckId);
    checks.push({ accepted: r.accepted, opened: r.claimId !== null });
  }

  const rows = await t.run(async (ctx) => ({
    claims: await ctx.db.query("claims").withIndex("by_item", (q: any) => q.eq("itemId", ids.itemId)).collect(),
    priceChecks: await ctx.db.query("priceChecks").withIndex("by_item", (q: any) => q.eq("itemId", ids.itemId)).collect(),
  }));
  const claims = rows.claims
    .filter((c: any) => !ids.priorClaimIds.includes(c._id))
    .map((c: any) => ({
      type: c.type,
      status: c.status,
      expectedCents: c.expectedCents,
      windowEndsAtFromPurchase: c.windowEndsAt === undefined ? null : c.windowEndsAt - purchasedAt,
      policyIndex: c.policyId === undefined ? null : ids.policyIds.indexOf(c.policyId),
      openedFromCheck: c.openedFromPriceCheckId === undefined ? null : checkIds.indexOf(c.openedFromPriceCheckId),
    }));
  const priceChecks = rows.priceChecks.map((p: any) => ({ observedStored: p.observedCents !== undefined }));
  return { projection: { checks, claims, priceChecks }, ids };
}
// </scenarios>

/** Recorded at 5cc326d by running the block above in a throwaway worktree (see header). Pasted unchanged. */
const EXPECTED_5CC326D: Record<string, unknown> = {
  "basic-drop": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "threshold-2pct-below": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "threshold-2pct-equal": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 400, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "threshold-floor-below": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "threshold-floor-equal": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 100, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "two-units": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 5000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "variant-unsure": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "variant-none": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "currency-mismatch": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "gbp-gbp": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "gbp-usd": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "jpy-zero-decimal": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 300000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "range": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "low-confidence": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "implausibly-cheap": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "no-price": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "zero-price": {"checks": [{"accepted": false, "opened": false}], "claims": [], "priceChecks": [{"observedStored": false}]},
  "no-policy": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "policy-without-window": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "returns-policy-only": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "window-closed": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "window-end-minus-1min": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "window-end-plus-1min": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "unconfirmed-policy": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "repeat-same-price": {"checks": [{"accepted": true, "opened": true}, {"accepted": true, "opened": false}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}, {"observedStored": true}]},
  "deeper-drop-while-open": {"checks": [{"accepted": true, "opened": true}, {"accepted": true, "opened": false}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}, {"observedStored": true}]},
  "settled-then-deeper": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 2000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "settled-then-tiny": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "dismissed-prior": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "open-legacy-claim": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "sent-legacy-claim": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "n7-newer-confirmed-window": {"checks": [{"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 2592000000, "policyIndex": 1, "openedFromCheck": 0}], "priceChecks": [{"observedStored": true}]},
  "n7-newer-unconfirmed-window": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "needs-review-purchase": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "archived-purchase": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "example-purchase": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "returned-item": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "no-product-url": {"checks": [{"accepted": true, "opened": false}], "claims": [], "priceChecks": [{"observedStored": true}]},
  "price-rises-then-drops": {"checks": [{"accepted": true, "opened": false}, {"accepted": true, "opened": true}], "claims": [{"type": "price_adjustment", "status": "detected", "expectedCents": 3000, "windowEndsAtFromPurchase": 1209600000, "policyIndex": 0, "openedFromCheck": 1}], "priceChecks": [{"observedStored": true}, {"observedStored": true}]},
};

/** D160: the one intended difference between legacy (5cc326d) and R01 v1. */
const ALLOWED_V1_DIFFERENCES: Record<string, { checks: Array<{ accepted: boolean; opened: boolean }>; claims: unknown[] }> = {
  "jpy-zero-decimal": { checks: [{ accepted: true, opened: false }], claims: [] },
};

type Mode = "legacy" | "v1";
function selectMode(mode: Mode) {
  if (mode === "legacy") setTestActivations([]);
  else setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetTestRegistry();
});

describe.each(["legacy", "v1"] as const)("R01 claim-opening parity with 5cc326d — mode %s", (mode) => {
  it("every scenario has a recorded 5cc326d projection", () => {
    expect(Object.keys(EXPECTED_5CC326D).sort()).toEqual(SCENARIOS.map((s) => s.id).sort());
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", async (id, s) => {
    selectMode(mode);
    const t = setup();
    const { projection } = await runScenario(t, s, internal.priceWatch.recordCheck, (ms) => vi.setSystemTime(ms));
    const expected = EXPECTED_5CC326D[id] as { checks: unknown[]; claims: unknown[]; priceChecks: unknown[] };
    if (mode === "v1" && ALLOWED_V1_DIFFERENCES[id]) {
      const allowed = ALLOWED_V1_DIFFERENCES[id];
      expect(projection.checks).toEqual(allowed.checks);
      expect(projection.claims).toEqual(allowed.claims);
      // The allowance is real: 5cc326d opened a claim here (mis-scaled), v1 does not.
      expect((expected.claims as unknown[]).length).toBeGreaterThan(0);
      return;
    }
    expect(projection).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// v1-only properties the parity table cannot show (C3 names them for both modes; the claims are compared above).
// ---------------------------------------------------------------------------

describe("R01 v1 (forced active): what the card says for the parity scenarios", () => {
  async function v1Run(id: string) {
    selectMode("v1");
    const t = setup();
    const s = SCENARIOS.find((x) => x.id === id)!;
    const { ids } = await runScenario(t, s, internal.priceWatch.recordCheck, (ms) => vi.setSystemTime(ms));
    const view = await t.run(async (ctx) => {
      const opps = (await ctx.db.query("opportunities").collect()).filter((o: Doc<"opportunities">) => o.userId === ids.userId);
      const evaluations = await Promise.all(opps.map(async (o: Doc<"opportunities">) => (o.currentEvaluationId ? await ctx.db.get(o.currentEvaluationId) : null)));
      const claims = await ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", ids.itemId as Id<"items">)).collect();
      return { opps, evaluations, claims };
    });
    return { t, ids, ...view };
  }

  it("DA-A-2: an unconfirmed policy with a qualifying drop → likely_eligible with the assumption, and exactly one claim", async () => {
    const r = await v1Run("unconfirmed-policy");
    expect(r.claims).toHaveLength(1);
    expect(r.opps).toHaveLength(1);
    expect(r.opps[0].outcome).toBe("likely_eligible");
    const assumptionText = JSON.stringify(r.evaluations[0]?.assumptions ?? []);
    expect(assumptionText).toMatch(/policy_confirmed|confirm/i);
  });

  it("DA-A-3: a legacy open claim + a new evaluation → the claim is linked, no second claim, Potential 0", async () => {
    const r = await v1Run("open-legacy-claim");
    expect(r.claims).toHaveLength(1);
    const legacy = r.claims[0] as Doc<"claims">;
    expect(legacy.opportunityId).toBeDefined();
    expect(r.opps[0].activeClaimId).toBe(legacy._id);
    const summary = await r.t.withIdentity({ subject: `${r.ids.userId}|session` }).query(api.recovery.summary, { now: Date.UTC(2026, 8, 20, 14) });
    const usd = summary.currencies.find((c: { currency: string }) => c.currency === "USD");
    expect(usd?.tiles.potential.amountMinor ?? 0).toBe(0);
  });

  it("N7: the later confirmed snapshot's window is used (as legacy), with the A-T2 'retrieved after purchase' assumption", async () => {
    const r = await v1Run("n7-newer-confirmed-window");
    expect(r.claims).toHaveLength(1);
    expect(JSON.stringify(r.evaluations[0]?.assumptions ?? [])).toMatch(/A-T2|after (your )?purchase|may have changed/i);
  });

  it("D160: JPY → unsupported, no claim, no money", async () => {
    const r = await v1Run("jpy-zero-decimal");
    expect(r.claims).toHaveLength(0);
    for (const o of r.opps) expect(o.outcome).toBe("unsupported");
  });
});
