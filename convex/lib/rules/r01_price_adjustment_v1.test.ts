/**
 * R01 v1 code pack against EVERY runnable case of docs/rules/fixtures/R01.json, loaded (hash-checked, unmodified)
 * through M08's loader. Expected values are the researcher's hand-written ones (M1C/M2E); nothing here is computed by
 * the evaluator under test.
 *
 * Fixture → evaluator input (README cross-pack rule 2): each fixture fact becomes resolution rows for M11's
 * `resolveCell` (user_confirmed → a confirmed row, observed → observed, derived → derived, extracted_candidate and the
 * R01-only `assumption` state → a candidate row, missing → no row, conflicting → one row per candidate in its
 * `conflict_kind`). An `observed` price is "a machine observation, e.g. an accepted price check" (rule 2), so its row
 * is price-check-sourced and carries the observation's D16 metadata — the only kind of observed price R01 v1 accepts
 * (contract §2.7, M18 item 1). `policy_snapshot` + `retail.window_days` are the parameter source. `context.price_claims_on_item`
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

/** Where a fixture row comes from: an observed price is a price check (README rule 2); anything else the user. */
const sourceFor = (key: string, state: string) =>
  key === "retail.observed_price" && state === "observed" ? { kind: "price_check", ref: "fixture" } as const : { kind: "user" } as const;

function cellOf(subjectKey: string, key: string, fact: FixtureFact | undefined): Cell {
  if (!fact || fact.state === "missing") return resolveCell(subjectKey, key, []);
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    const rows: ResolveRow[] = (fact.candidates ?? []).map((c, i) => ({
      state: kind === "candidates" ? "extracted_candidate" : ROW_STATE[(c.state as string) ?? "extracted_candidate"],
      value: toValue(fact.type, c.value),
      at: i + 1,
      source: kind === "candidates" ? { kind: "evidence", ref: String(c.evidence ?? `candidate ${i + 1}`) } : { ...sourceFor(key, String(c.state)), ref: String(c.evidence ?? `candidate ${i + 1}`) },
    }));
    return resolveCell(subjectKey, key, rows);
  }
  return resolveCell(subjectKey, key, [{ state: ROW_STATE[fact.state], value: toValue(fact.type, fact.value), at: 1, source: sourceFor(key, fact.state) }]);
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

  describe("M18 item 1: only a vetted price check is an accepted observation (contract §2.7)", () => {
    // M18's repro: a USD 499.99 purchase with a confirmed policy (R01-01's facts).
    const r01 = FILE.cases.find((c) => c.id === "R01-01")!;
    const priced = (rows: Parameters<typeof resolveCell>[2], observation: R01ObservationMeta | null) => {
      const { snapshot, cc } = build(r01);
      return { r: run(r01, { ...snapshot, observedPrice: resolveCell(ITEM, "retail.observed_price", rows), observation }, cc), snapshot };
    };
    const money = (n: number, currency = "USD"): FactValue => ({ kind: "money", amountMinor: n, currency });
    const meta: R01ObservationMeta = { variantMatch: "exact", confidence: 0.95, isRange: false };
    const expectNoAmount = (r: EvaluationResult) => {
      expect(r.outcome).toBe("needs_facts");
      expect(r.amount).toBeNull();
      expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["retail.observed_price", "missing"]]);
      expect(r01AutoOpen(r, { openClaimExists: false }).opens).toBe(false);
    };

    it("repro 1: an unconfirmed EUR 300.00 on a USD 499.99 purchase → no estimate (no cross-currency subtraction), no auto-open", () => {
      const { r } = priced([{ state: "extracted_candidate", value: money(30_000, "EUR"), at: 1, source: { kind: "evidence", ref: "email" } }], null);
      expectNoAmount(r);
      expect(JSON.stringify(r)).not.toContain("19999");
    });

    it("repro 2: an unconfirmed USD 9.99 (implausibly cheap) → no estimate, no auto-open", () => {
      const { r } = priced([{ state: "extracted_candidate", value: money(999), at: 1, source: { kind: "evidence", ref: "email" } }], meta);
      expectNoAmount(r);
      expect(JSON.stringify(r)).not.toContain("49000");
    });

    it("an evidence-sourced observed value without metadata → not accepted", () => {
      expectNoAmount(priced([{ state: "observed", value: money(44_999), at: 1, source: { kind: "evidence", ref: "screenshot" } }], null).r);
    });

    it("a price-check-sourced value WITHOUT its acceptance metadata → not accepted", () => {
      expectNoAmount(priced([{ state: "observed", value: money(44_999), at: 1, source: { kind: "legacy_price_check" } }], null).r);
    });

    it("a user-confirmed current price (not a price check) → not accepted", () => {
      expectNoAmount(priced([{ state: "user_confirmed", value: money(44_999), at: 1, source: { kind: "user" } }], meta).r);
    });

    it("a candidates-only conflict on the observed price → not accepted (never candidate-tested into an amount)", () => {
      expectNoAmount(priced([
        { state: "extracted_candidate", value: money(44_999), at: 1, source: { kind: "evidence", ref: "a" } },
        { state: "extracted_candidate", value: money(43_000), at: 2, source: { kind: "evidence", ref: "b" } },
      ], meta).r);
    });

    it("the same value from a vetted price check with its metadata → accepted (5,000 estimate)", () => {
      const { r } = priced([{ state: "observed", value: money(44_999), at: 1, source: { kind: "legacy_price_check", ref: "pc1" } }], meta);
      expect(r.outcome).toBe("likely_eligible");
      expect(r.amount?.estimate).toEqual({ amountMinor: 5_000, currency: "USD" });
    });

    it("a vetted check with an undefined variantMatch is rejected like legacy ('Could not tell which variant…')", () => {
      const { r } = priced([{ state: "observed", value: money(44_999), at: 1, source: { kind: "price_check" } }], { confidence: 0.95 });
      expectNoAmount(r);
      expect(r.conditions.find((c) => c.id === "r01.v1.observation_accepted")?.note).toBe("Could not tell which variant the price is for");
    });
  });

  it("D160 / M18 N3: a KWD (three-decimal) purchase is unsupported too", () => {
    const { snapshot, cc } = build(base);
    const kwd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "KWD" });
    const r = run(base, {
      ...snapshot,
      unitPrice: resolveCell(ITEM, "retail.unit_price", [{ state: "user_confirmed", value: kwd(12000), at: 1, source: { kind: "user" } }]),
      observedPrice: resolveCell(ITEM, "retail.observed_price", [{ state: "observed", value: kwd(9500), at: 1, source: { kind: "price_check" } }]),
      currency: resolveCell("txn", "retail.currency", [{ state: "user_confirmed", value: { kind: "code", code: "KWD" }, at: 1, source: { kind: "user" } }]),
    }, cc);
    expect(r.outcome).toBe("unsupported");
    expect(r.amount).toBeNull();
    expect(r01AutoOpen(r, { openClaimExists: false }).opens).toBe(false);
  });

  describe("M18 N2: a paid claim AND a denied claim on one item → the smaller ask (conservative; spec silent)", () => {
    const withObs = (unit: number, qty: number, obs: number) => {
      const { snapshot } = build(base);
      return {
        ...snapshot,
        unitPrice: resolveCell(ITEM, "retail.unit_price", [{ state: "user_confirmed", value: { kind: "money", amountMinor: unit, currency: "USD" }, at: 1, source: { kind: "user" } }]),
        quantity: resolveCell(ITEM, "retail.quantity", [{ state: "user_confirmed", value: { kind: "count", n: qty }, at: 1, source: { kind: "user" } }]),
        observedPrice: resolveCell(ITEM, "retail.observed_price", [{ state: "observed", value: { kind: "money", amountMinor: obs, currency: "USD" }, at: 1, source: { kind: "price_check" } }]),
      };
    };

    it("paid 3,000 + denied at 11,000 + a new 8,500 on a 12,000 item → 500 (the paid remainder), never the 2,500 denial difference", () => {
      const r = run(base, withObs(12_000, 1, 8_500), { settledMinorByLossKey: { [`${ITEM}:price_diff:1`]: 3_000 }, deniedObservedMinor: 11_000 });
      expect(r.amount?.estimate).toEqual({ amountMinor: 500, currency: "USD" });
      expect(r.amount?.formula).toBe("(12,000 - 8,500) x 1 - 3,000 settled (less than the denied-claim difference)");
      expect(r01AutoOpen(r, { openClaimExists: false, deniedObservedMinor: 11_000, observedMinor: 8_500, unitMinor: 12_000 })).toMatchObject({ opens: true, amountMinor: 500 });
    });

    it("paid 5,000 (qty 2) + denied at 9,000 + a new 8,500 → 1,000 (the denial difference is the smaller)", () => {
      const r = run(base, withObs(12_000, 2, 8_500), { settledMinorByLossKey: { [`${ITEM}:price_diff:1`]: 5_000 }, deniedObservedMinor: 9_000 });
      expect(r.amount?.estimate).toEqual({ amountMinor: 1_000, currency: "USD" });
      expect(r.amount?.formula).toBe("(9,000 denied observation - 8,500) x 2");
    });

    it("a paid remainder below its threshold stays not_eligible even with a denial on record", () => {
      const r = run(base, withObs(12_000, 2, 9_400), { settledMinorByLossKey: { [`${ITEM}:price_diff:1`]: 5_000 }, deniedObservedMinor: 11_000 });
      expect(r.outcome).toBe("not_eligible");
      expect(r.amount).toBeNull();
    });
  });

  it("M18 N4: a returned item is labelled 'No open price window', not 'Drop below threshold'", () => {
    const { snapshot, cc } = build(base);
    const r = run(base, { ...snapshot, itemReturned: true }, cc);
    expect(r01AutoOpen(r, { openClaimExists: false })).toEqual({ opens: false, note: "No open price window" });
  });

  it("M18 N5/N6: the pack declares itself researched (status is the lead's) and records the credit-vs-cash limitation", () => {
    expect(r01PriceAdjustmentV1.lifecycle).toBe("researched");
    expect(r01PriceAdjustmentV1.knownLimitations.join(" ")).toContain("credit rather than cash");
    expect(r01PriceAdjustmentV1.knownLimitations.join(" ")).not.toContain("(D147)");
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
