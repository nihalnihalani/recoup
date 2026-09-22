/**
 * R01 v1 code pack against EVERY runnable case of docs/rules/fixtures/R01.json, loaded (hash-checked, unmodified)
 * through M08's loader. Expected values are the researcher's hand-written ones (M1C/M2E); nothing here is computed by
 * the evaluator under test.
 *
 * Fixture → evaluator input (README cross-pack rule 2): each fixture fact becomes resolution rows for M11's
 * `resolveCell` (user_confirmed → a confirmed row, observed → observed, derived → derived, extracted_candidate and the
 * R01-only `assumption` state → a candidate row, missing → no row, conflicting → one row per candidate in its
 * `conflict_kind`). `policy_snapshot` + `retail.window_days` are the parameter source. `context.price_claims_on_item`
 * becomes the case context: confirmed → a settled loss key, denied → the denied observation (DA-A-22), anything else →
 * the open claim.
 *
 * Assertion mapping (contract rev 5.5 §10, D158/D161), compared as SETS of (key, reason-class):
 *   fixture `missing_facts`              ↔ missingFacts with reason missing | user_unknown | conflicting
 *   fixture `unconfirmed_decisive_facts` ↔ missingFacts with reason candidate_unconfirmed | conflict_capped
 * Other keys: `assumptions` (set of ids), `amount` (null, estimate, formula, thresholds), `deadline.instant`,
 * `claim` (through the pure auto-open decision `r01AutoOpen`), `next_action` ("refresh policy" → add_evidence
 * policy_page, D160), `send` (the acknowledgeable late ask, C1), `observation_accepted`, `explanation` (both values
 * named), `dedupe` (identical result hash), `forbidden_outputs` (never eligible).
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { loadRuleFixtureFile, type FixtureFact, type RuleFixtureCase } from "../../testing/ruleFixtures.loader";
import { resolveCell, type Cell, type ResolveRow } from "../facts/resolve";
import type { FactValue } from "../facts/catalog";
import { resultHash } from "./outcome";
import {
  evaluateR01V1,
  r01AutoOpen,
  r01LateAskAcknowledgeable,
  r01PriceAdjustmentV1,
  R01_V1_PARAMS,
  R01_V1_WINDOW_ID,
  type R01CaseContext,
  type R01ObservationMeta,
  type R01Policy,
  type R01Snapshot,
} from "./r01_price_adjustment_v1";
import { ENGINE_VERSION, type EvaluationResult, type MissingFact } from "./types";

const FILE = loadRuleFixtureFile("R01");
const ITEM = "item:fixtureitem1";
const CLAIM = "fixtureclaim1" as Id<"claims">;

type Obs = { amount_minor: number; currency: string; variantMatch?: "exact" | "unsure" | "none"; confidence?: number; isRange?: boolean };

function toValue(type: string, raw: unknown): FactValue {
  switch (type) {
    case "datetime":
      return { kind: "instant", epochMs: Date.parse(raw as string) };
    case "money":
    case "observation": {
      const m = raw as Obs;
      return { kind: "money", amountMinor: m.amount_minor, currency: m.currency };
    }
    case "integer":
      return { kind: "count", n: raw as number };
    case "string":
      return { kind: "code", code: raw as string };
    case "boolean":
      return { kind: "bool", value: raw as boolean };
    default:
      throw new Error(`unsupported fixture type ${type}`);
  }
}

const ROW_STATE: Record<string, ResolveRow["state"]> = {
  user_confirmed: "user_confirmed", observed: "observed", derived: "derived",
  extracted_candidate: "extracted_candidate", assumption: "extracted_candidate",
};

function cellOf(subjectKey: string, key: string, fact: FixtureFact | undefined): Cell {
  if (!fact || fact.state === "missing") return resolveCell(subjectKey, key, []);
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    const rows: ResolveRow[] = (fact.candidates ?? []).map((c, i) => ({
      state: kind === "candidates" ? "extracted_candidate" : ROW_STATE[(c.state as string) ?? "extracted_candidate"],
      value: toValue(fact.type, c.value),
      at: i + 1,
      source: { kind: "evidence", ref: String(c.evidence ?? `candidate ${i + 1}`) },
    }));
    return resolveCell(subjectKey, key, rows);
  }
  return resolveCell(subjectKey, key, [{ state: ROW_STATE[fact.state], value: toValue(fact.type, fact.value), at: 1, source: { kind: "user" } }]);
}

type Claim = { status: string; expectedCents?: number; currency?: string; ["openedFromPriceCheckId.observedCents"]?: number };

function build(c: RuleFixtureCase): { snapshot: R01Snapshot; cc: R01CaseContext; openClaimExists: boolean } {
  const f = c.facts;
  const obsFact = f["retail.observed_price"];
  const obsRaw = obsFact && obsFact.state !== "missing" && obsFact.state !== "conflicting" ? (obsFact.value as Obs) : null;
  const observation: R01ObservationMeta | null = obsRaw
    ? { variantMatch: obsRaw.variantMatch, confidence: obsRaw.confidence, isRange: obsRaw.isRange }
    : null;
  const snap = f["policy_snapshot"];
  const window = f["retail.window_days"];
  const policy: R01Policy | null =
    snap && snap.state !== "missing" && snap.value
      ? {
          policyId: "fixturepolicy",
          retrievedAt: Date.parse((snap.value as { retrievedAt: string }).retrievedAt),
          confirmedByUser: (snap.value as { confirmedByUser: boolean }).confirmedByUser,
          ...(window && window.state !== "missing" && window.value !== null ? { windowDays: window.value as number } : {}),
          sourceUrl: "https://example-electronics.com/policy",
        }
      : null;
  const snapshot: R01Snapshot = {
    subjectKey: ITEM,
    itemReturned: false,
    purchaseDate: cellOf("txn", "retail.purchase_date", f["retail.purchase_date"]),
    currency: cellOf("txn", "retail.currency", f["retail.currency"]),
    unitPrice: cellOf(ITEM, "retail.unit_price", f["retail.unit_price"]),
    quantity: cellOf(ITEM, "retail.quantity", f["retail.quantity"]),
    itemName: cellOf(ITEM, "retail.item_name", undefined),
    observedPrice: cellOf(ITEM, "retail.observed_price", obsFact),
    observation,
    policy,
  };
  const claims = ((c.context.price_claims_on_item as Claim[] | undefined) ?? []);
  const cc: R01CaseContext = { settledMinorByLossKey: {} };
  let openClaimExists = false;
  claims.forEach((cl, i) => {
    if (cl.status === "confirmed") cc.settledMinorByLossKey[`${ITEM}:price_diff:${i + 1}`] = cl.expectedCents ?? 0;
    else if (cl.status === "denied") cc.deniedObservedMinor = cl["openedFromPriceCheckId.observedCents"];
    else if (cl.status !== "dismissed") {
      openClaimExists = true;
      cc.activeClaimId = CLAIM;
      cc.activeClaim = { claimId: CLAIM, expectedMinor: cl.expectedCents ?? 0, currency: cl.currency ?? "USD" };
    }
  });
  return { snapshot, cc, openClaimExists };
}

function run(c: RuleFixtureCase, snapshot: R01Snapshot, cc: R01CaseContext): EvaluationResult {
  return evaluateR01V1({
    snapshot, snapshotHash: "fixture", engineVersion: ENGINE_VERSION, remedyKey: "price_difference", subjectKey: ITEM,
    pack: { ruleId: r01PriceAdjustmentV1.ruleId, scenarioId: "R01", version: r01PriceAdjustmentV1.version, params: R01_V1_PARAMS, sources: [] },
    verification: {}, caseContext: cc, now: c.now,
  });
}

const UNRESOLVED = new Set(["missing", "user_unknown", "conflicting"]);
const CAPPED = new Set(["candidate_unconfirmed", "conflict_capped"]);
const keysOf = (list: MissingFact[], cls: Set<string>) => list.filter((m) => cls.has(m.reason)).map((m) => m.key).sort();

describe("R01 v1 code pack × docs/rules/fixtures/R01.json (unmodified, via M08's loader)", () => {
  it("loads the file (hash-checked) with every case runnable", () => {
    expect(FILE.ruleId).toBe(r01PriceAdjustmentV1.ruleId);
    expect(FILE.ruleVersion).toBe(r01PriceAdjustmentV1.version);
    expect(FILE.cases.length).toBeGreaterThanOrEqual(30);
  });

  describe.each(FILE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const { snapshot, cc, openClaimExists } = build(c);
    const r = run(c, snapshot, cc);
    const e = c.expected as Record<string, unknown> & { outcome: string };

    it(`outcome ${e.outcome}`, () => {
      expect(r.outcome).toBe(e.outcome);
    });

    it("missing_facts ↔ unresolved class; unconfirmed_decisive_facts ↔ capped class (D158/D161)", () => {
      expect(keysOf(r.missingFacts, UNRESOLVED)).toEqual([...((e.missing_facts as string[] | undefined) ?? [])].sort());
      expect(keysOf(r.missingFacts, CAPPED)).toEqual([...((e.unconfirmed_decisive_facts as string[] | undefined) ?? [])].sort());
    });

    it("assumptions, amount, deadline, next action, observation (where the fixture states them)", () => {
      if (e.assumptions !== undefined) expect(r.assumptions.map((a) => a.id).sort()).toEqual([...(e.assumptions as string[])].sort());
      if (e.amount === null) expect(r.amount).toBeNull();
      const amount = e.amount as { estimate?: { amount_minor: number; currency: string }; formula?: string; threshold_minor?: number; threshold_minor_per_unit?: number; remainder_threshold_minor?: number } | null | undefined;
      if (amount?.estimate) {
        expect(r.amount?.estimate).toEqual({ amountMinor: amount.estimate.amount_minor, currency: amount.estimate.currency });
      }
      if (amount?.formula) expect(r.amount?.formula).toBe(amount.formula);
      const input = (label: string) => r.amount?.inputs.find((i) => i.label === label)?.value;
      if (amount?.threshold_minor !== undefined) expect(input("threshold per unit")).toBe(String(amount.threshold_minor));
      if (amount?.threshold_minor_per_unit !== undefined) expect(input("threshold per unit")).toBe(String(amount.threshold_minor_per_unit));
      if (amount?.remainder_threshold_minor !== undefined) expect(input("threshold after a paid claim")).toBe(String(amount.remainder_threshold_minor));
      const deadline = e.deadline as { instant?: string } | undefined;
      if (deadline?.instant) expect(r.deadlines.find((d) => d.id === R01_V1_WINDOW_ID)?.dueAt).toBe(Date.parse(deadline.instant));
      if (e.next_action === "refresh policy") expect(r.nextAction).toEqual({ kind: "add_evidence", docTypes: ["policy_page"] });
      if (e.observation_accepted === false) {
        expect(r.conditions.find((x) => x.id === "r01.v1.observation_accepted")?.result).not.toBe("pass");
      }
    });

    it("claim: the auto-open decision (parity with today's recordCheck)", () => {
      const claim = e.claim as { opens: boolean; count?: number; amount?: { amount_minor: number; currency: string }; windowEndsAt?: string } | undefined;
      if (claim === undefined) return;
      const obs = snapshot.observedPrice.status === "candidate" || snapshot.observedPrice.known ? snapshot.observedPrice.value : null;
      const unit = snapshot.unitPrice.status === "candidate" || snapshot.unitPrice.known ? snapshot.unitPrice.value : null;
      const decision = r01AutoOpen(r, {
        openClaimExists,
        deniedObservedMinor: cc.deniedObservedMinor,
        observedMinor: obs?.kind === "money" ? obs.amountMinor : undefined,
        unitMinor: unit?.kind === "money" ? unit.amountMinor : undefined,
      });
      expect(decision.opens).toBe(claim.opens);
      if (claim.count !== undefined) expect(decision.opens ? 1 : 0).toBe(claim.count);
      if (claim.amount) expect({ amountMinor: decision.amountMinor, currency: decision.currency }).toEqual({ amountMinor: claim.amount.amount_minor, currency: claim.amount.currency });
      if (claim.windowEndsAt) expect(decision.windowEndsAt).toBe(Date.parse(claim.windowEndsAt));
    });

    it("send, explanation, dedupe, forbidden outputs", async () => {
      const send = e.send as { refused: boolean; requires_acknowledgment?: string } | undefined;
      if (send) {
        expect(send.refused).toBe(false);
        expect(send.requires_acknowledgment).toBe("window_may_have_passed");
        expect(r01LateAskAcknowledgeable(r)).toBe(true);
        expect(r.nextAction.kind).toBe("continue_case");
      }
      if (typeof e.explanation === "string") {
        // R01-16: the explanation names both values and how to resolve it (5a).
        const text = r.explanation.join(" ");
        expect(text).toContain("USD 420.00");
        expect(text).toContain("USD 449.99");
        expect(text.toLowerCase()).toContain("upload");
      }
      if (e.dedupe !== undefined) {
        const again = run(c, build(c).snapshot, build(c).cc);
        expect(await resultHash(again, "b")).toBe(await resultHash(r, "b"));
      }
      // R01 v1's best outcome is likely_eligible (every fixture forbids eligible, directly or via the conventions).
      expect(r.outcome).not.toBe("eligible");
    });
  });
});

describe("R01 v1 pack invariants beyond the fixtures", () => {
  const base = FILE.cases.find((c) => c.id === "R01-08")!;

  it("the live observed price is never a bound fact (C2); the claim amount and opening observation are", () => {
    const { snapshot, cc } = build(base);
    const withClaim: R01CaseContext = {
      ...cc, activeClaimId: CLAIM,
      activeClaim: { claimId: CLAIM, expectedMinor: 5000, currency: "USD", opening: { amountMinor: 9500, currency: "USD", observedAt: base.now } },
    };
    const keys = run(base, snapshot, withClaim).boundFacts.map((b) => b.key);
    expect(keys).not.toContain("retail.observed_price");
    expect(keys).toEqual(expect.arrayContaining(["retail.unit_price", "retail.quantity", "retail.item_name", "retail.purchase_date", "retail.claim_amount", "retail.opening_price", "retail.opening_observed_at"]));
    expect(keys.length).toBeLessThanOrEqual(32);
  });

  it("C2/KM3: on an open case, 12 different live prices give 12 identical results (the opening observation is read)", async () => {
    const { snapshot, cc } = build(base);
    const open: R01CaseContext = {
      ...cc, activeClaimId: CLAIM,
      activeClaim: { claimId: CLAIM, expectedMinor: 5000, currency: "USD", opening: { amountMinor: 9500, currency: "USD", observedAt: base.now } },
    };
    const hashes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const price = 9000 + i * 350; // 9,000 … 12,850 — above AND below the paid price
      const s2: R01Snapshot = {
        ...snapshot,
        observedPrice: resolveCell(ITEM, "retail.observed_price", [{ state: "observed", value: { kind: "money", amountMinor: price, currency: "USD" }, at: 2, source: { kind: "price_check" } }]),
      };
      hashes.add(await resultHash(run(base, s2, open), "bound"));
    }
    expect(hashes.size).toBe(1);
  });

  it("D160: a JPY purchase is unsupported (no mis-scaled claim)", () => {
    const { snapshot, cc } = build(base);
    const yen = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "JPY" });
    const s2: R01Snapshot = {
      ...snapshot,
      unitPrice: resolveCell(ITEM, "retail.unit_price", [{ state: "user_confirmed", value: yen(12000), at: 1, source: { kind: "user" } }]),
      observedPrice: resolveCell(ITEM, "retail.observed_price", [{ state: "observed", value: yen(9500), at: 1, source: { kind: "price_check" } }]),
      currency: resolveCell("txn", "retail.currency", [{ state: "user_confirmed", value: { kind: "code", code: "JPY" }, at: 1, source: { kind: "user" } }]),
    };
    const r = run(base, s2, cc);
    expect(r.outcome).toBe("unsupported");
    expect(r.amount).toBeNull();
    expect(r01AutoOpen(r, { openClaimExists: false }).opens).toBe(false);
  });

  it("a returned item is not eligible (legacy: no open price window for returned items)", () => {
    const { snapshot, cc } = build(base);
    const r = run(base, { ...snapshot, itemReturned: true }, cc);
    expect(r.outcome).toBe("not_eligible");
    expect(r.disqualifierIds).toContain("r01.v1.item_not_returned");
  });

  it("a legacy (unconfirmed) currency is an assumption, never a missing fact (DA-A-33, DA-A-2)", () => {
    const { snapshot, cc } = build(base);
    const r = run(base, { ...snapshot, currency: resolveCell("txn", "retail.currency", [{ state: "extracted_candidate", value: { kind: "code", code: "USD" }, at: 1, source: { kind: "legacy_purchase" } }]) }, cc);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.assumptions.map((a) => a.id)).toContain("retail.currency");
    expect(r.missingFacts).toEqual([]);
  });

  it("an extracted-candidate unit price caps at likely_eligible and is listed as unconfirmed (D147(2))", () => {
    const { snapshot, cc } = build(base);
    const r = run(base, { ...snapshot, unitPrice: resolveCell(ITEM, "retail.unit_price", [{ state: "extracted_candidate", value: { kind: "money", amountMinor: 12000, currency: "USD" }, at: 1, source: { kind: "evidence" } }]) }, cc);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.dimensions.evidenceSupports).toBe("unknown");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["retail.unit_price", "candidate_unconfirmed"]]);
  });

  it("the window is a lateAskAcknowledgeable user deadline (C1)", () => {
    const five = FILE.cases.find((c) => c.id === "R01-05c")!;
    const { snapshot, cc } = build(five);
    const r = run(five, snapshot, cc);
    expect(r.outcome).toBe("deadline_passed");
    expect(r01LateAskAcknowledgeable(r)).toBe(true);
    expect(r01AutoOpen(r, { openClaimExists: false })).toEqual({ opens: false, note: "No open price window" });
  });
});
