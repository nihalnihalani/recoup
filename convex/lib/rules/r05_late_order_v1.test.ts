/**
 * R05 v1 code pack against EVERY runnable case of docs/rules/fixtures/R05.json, loaded (hash-checked, unmodified)
 * through M08's loader. Expected values are the researcher's hand-written ones (M02/M2D/M2E); nothing here is computed
 * by the evaluator under test.
 *
 * Fixture → evaluator input (README cross-pack rule 2). Each fixture fact becomes resolution rows for M11's
 * `resolveCell` on subject `txn` (user_confirmed → a confirmed row, observed → observed, derived → derived,
 * extracted_candidate → a candidate row, missing → no row, conflicting → one row per candidate in its `conflict_kind`).
 * The spec's structured facts map onto the scalar keys of `lib/facts/keys_order.ts` (FIXTURE_KEYS below); the two
 * delivery facts the spec keeps apart from R05 (`delivery_representation`, `delivered_at`, §1/§5) are not read.
 * Calendar zone: the file's `conventions.calendar_zone` says fixtures use America/New_York unless a case states
 * `ship_to_timezone`, so that convention becomes a confirmed `order.ship_to_time_zone` row (asserted below).
 * Source state: no `source` → verified on the clock's date; `last_verified_on` → that date; `record: "missing"` → no
 * verification record (README rule 8).
 *
 * Assertion mapping (contract rev 5.5 §10, D158/D161), compared as SETS of fixture fact names:
 *   fixture `missing_facts`              ↔ missingFacts with reason missing | user_unknown | conflicting
 *   fixture `unconfirmed_decisive_facts` ↔ missingFacts with reason candidate_unconfirmed | conflict_capped
 * Other keys: `amount.refund_due`, `deadline` (the seller's prompt-refund deadline: `date` ↔ dueLocalDate, a null
 * date ↔ no dueAt with `status`; `deadline: null` ↔ no refund deadline), `applicable_time_end` (the timing
 * condition), `vesting_date` / `auto_cancellation_date` (explanation), `reevaluate_at` / `reevaluate_when` (1:1,
 * rev 5.2), `next_action`, `overlap`, `dedupe` (identical result hash), `explanation`, `reason`, `pointers`,
 * `forbidden_outputs`.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../_generated/dataModel";
import { loadRuleFixtureFile, type FixtureFact, type RuleFixtureCase } from "../../testing/ruleFixtures.loader";
import type { FactValue } from "../facts/catalog";
import type { CellSource, ResolveRow } from "../facts/resolve";
import { buildOrderSnapshot, R05_BOUND_KEYS, type OrderSnapshot } from "../facts/snapshot_order";
import type { CellRow } from "../facts/snapshot_retail";
import { computeSummary } from "../../recovery";
import * as prod from "./registry";
import { activePack, resetTestRegistry, setTestActivations } from "./testRegistry";
import { coverageRows } from "./coverage";
import { resultHash } from "./outcome";
import {
  evaluateR05V1,
  r05LateOrderV1,
  R05_R03_REMEDY_KEY,
  R05_REMEDY_KEY,
  R05_V1_PARAMS,
  R05_V1_PARAM_SOURCES,
  R05_V1_REFUND_DEADLINE_ID,
  R05_V1_SOURCES,
  R05_V1_TIMING_ID,
  type R05Params,
} from "./r05_late_order_v1";
import { ENGINE_VERSION, type CaseContext, type EvaluationResult, type MissingFact } from "./types";
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../testing/ruleFixtures.loader";

const FILE = loadRuleFixtureFile("R05");
const TXN_ID = "fixturetxn5" as Id<"transactions">;
const SPEC_TEXT = readFileSync(path.join(REPO_ROOT, "docs/rules/R05-mail-internet-order.md"), "utf8");

// ---------------------------------------------------------------------------
// Fixture fact → catalogue rows
// ---------------------------------------------------------------------------

type KV = [key: string, value: FactValue];
const code = (c: unknown): FactValue => ({ kind: "code", code: String(c) });
const text = (t: unknown): FactValue => ({ kind: "text", text: String(t) });
const bool = (b: unknown): FactValue => ({ kind: "bool", value: Boolean(b) });
const instant = (s: unknown): FactValue => ({ kind: "instant", epochMs: Date.parse(String(s)) });
const localDate = (s: unknown): FactValue => ({ kind: "local_date", date: String(s) });
const money = (m: unknown): FactValue => {
  const x = m as { amount_minor: number; currency: string };
  return { kind: "money", amountMinor: x.amount_minor, currency: x.currency };
};

type Notice = { received_at: string; revised_ship_date: string; offers_cancel_and_refund?: boolean };

/** Fixture fact name → the catalogue keys and values it stands for. */
const FIXTURE_KEYS: Record<string, (value: unknown) => KV[]> = {
  order_channel: (v) => [["order.channel", code(v)]],
  seller_identity: (v) => [["order.seller_name", text(v)]],
  buyer_country: (v) => [["order.buyer_country", code(v)]],
  ship_to_country: (v) => [["order.ship_to_country", code(v)]],
  seller_country: (v) => [["order.seller_country", code(v)]],
  merchandise_category: (v) => [["order.merchandise_category", code(v)]],
  payment_terms: (v) => [["order.payment_terms", code(v)]],
  payment_instrument_class: (v) => [["card.payment_instrument_class", code(v)]],
  properly_completed_order_at: (v) => [["order.properly_completed_at", instant(v)]],
  shipping_representation: (v) => {
    if (v === null) return [["order.ship_time_kind", code("none_stated")]];
    const r = v as { text?: string; unit: string; value: number | string };
    const txt: KV[] = r.text ? [["order.ship_time_text", text(r.text)]] : [];
    return r.unit === "date"
      ? [["order.ship_time_kind", code("date")], ["order.ship_by_date", localDate(r.value)], ...txt]
      : [["order.ship_time_kind", code(r.unit)], ["order.ship_time_days", { kind: "count", n: Number(r.value) }], ...txt];
  },
  shipped_at: (v) => (v === null ? [["order.shipped", bool(false)]] : [["order.shipped", bool(true)], ["order.shipped_at", instant(v)]]),
  shipment_status: (v) => {
    const s = v as { items_ordered: number; items_shipped: number };
    return [["order.partially_shipped", bool(s.items_shipped > 0 && s.items_shipped < s.items_ordered)]];
  },
  delay_notices: (v) => {
    const list = v as Notice[];
    if (list.length === 0) return [["order.delay_notice_received", bool(false)]];
    const n = list[0];
    return [
      ["order.delay_notice_received", bool(true)],
      ["order.delay_notice_received_at", instant(n.received_at)],
      ...(n.revised_ship_date === "indefinite"
        ? ([["order.delay_revised_ship_kind", code("indefinite")]] as KV[])
        : ([["order.delay_revised_ship_kind", code("date")], ["order.delay_revised_ship_date", localDate(n.revised_ship_date)]] as KV[])),
      ...(n.offers_cancel_and_refund !== undefined ? ([["order.delay_notice_offers_cancel", bool(n.offers_cancel_and_refund)]] as KV[]) : []),
    ];
  },
  delay_notice_offers_cancel_and_refund: (v) => [["order.delay_notice_offers_cancel", bool(v)]],
  buyer_response: (v) => [["order.buyer_response", code(v)]],
  amount_tendered: (v) => [["retail.order_total", money(v)]],
  ship_to_timezone: (v) => [["order.ship_to_time_zone", code(v)]],
};
/** Kept separate from R05 by the spec (§1, §5 `delivery_representation`: "not used for R05"). */
const NOT_READ = new Set(["delivery_representation", "delivered_at"]);

/** Catalogue key → fixture fact name (for the missing / unconfirmed assertions). */
const FIXTURE_NAME: Record<string, string> = {
  "order.channel": "order_channel", "order.seller_name": "seller_identity", "order.buyer_country": "buyer_country",
  "order.ship_to_country": "ship_to_country", "order.seller_country": "seller_country",
  "order.merchandise_category": "merchandise_category", "order.payment_terms": "payment_terms",
  "card.payment_instrument_class": "payment_instrument_class", "order.properly_completed_at": "properly_completed_order_at",
  "order.ship_time_kind": "shipping_representation", "order.ship_time_days": "shipping_representation",
  "order.ship_by_date": "shipping_representation", "order.ship_time_text": "shipping_representation",
  "order.shipped": "shipped_at", "order.shipped_at": "shipped_at", "order.partially_shipped": "shipment_status",
  "order.delay_notice_received": "delay_notices", "order.delay_notice_received_at": "delay_notices",
  "order.delay_revised_ship_kind": "delay_notices", "order.delay_revised_ship_date": "delay_notices",
  "order.delay_notice_offers_cancel": "delay_notice_offers_cancel_and_refund", "order.buyer_response": "buyer_response",
  "order.buyer_response_at": "buyer_response", "retail.order_total": "amount_tendered", "order.ship_to_time_zone": "ship_to_timezone",
};

const ROW_STATE: Record<string, ResolveRow["state"]> = {
  user_confirmed: "user_confirmed", observed: "observed", derived: "derived", extracted_candidate: "extracted_candidate",
};

function sourceOf(state: string, evidence: unknown): CellSource {
  if (state === "user_confirmed") return { kind: "user" };
  if (state === "derived") return { kind: "derived", ref: "fixture" };
  return { kind: "evidence", ref: typeof evidence === "string" ? evidence : "fixture document" };
}

function rowsOf(name: string, fact: FixtureFact): CellRow[] {
  const convert = FIXTURE_KEYS[name];
  if (!convert) throw new Error(`R05 harness: no mapping for fixture fact "${name}"`);
  const rows = (kvs: KV[], state: ResolveRow["state"], at: number, source: CellSource): CellRow[] =>
    kvs.map(([key, value]) => ({ subjectKey: "txn", key, row: { state, value, at, source } }));
  if (fact.state === "missing") return [];
  if (fact.state === "conflicting") {
    const kind = (fact.conflict_kind as string | undefined) ?? "candidates";
    return (fact.candidates ?? []).flatMap((c, i) => {
      const state = kind === "candidates" ? "extracted_candidate" : ROW_STATE[String(c.state)];
      return rows(convert(c.value), state, i + 1, sourceOf(state, c.evidence ?? `candidate ${i + 1}`));
    });
  }
  return rows(convert(fact.value), ROW_STATE[fact.state], 1, sourceOf(fact.state, fact.evidence));
}

function snapshotOf(c: RuleFixtureCase, extra: CellRow[] = []): OrderSnapshot {
  const rows: CellRow[] = [];
  for (const [name, fact] of Object.entries(c.facts)) {
    if (NOT_READ.has(name)) continue;
    let r = rowsOf(name, fact);
    // The case's own adequacy fact (`delay_notice_offers_cancel_and_refund`) is the one read; the notice element's
    // flag only stands in when the case has none.
    if (name === "delay_notices" && c.facts.delay_notice_offers_cancel_and_refund) r = r.filter((x) => x.key !== "order.delay_notice_offers_cancel");
    rows.push(...r);
  }
  if (c.facts.ship_to_timezone === undefined) {
    rows.push({ subjectKey: "txn", key: "order.ship_to_time_zone", row: { state: "user_confirmed", value: code("America/New_York"), at: 1, source: { kind: "user" } } });
  }
  return buildOrderSnapshot({ transactionId: TXN_ID, rows: [...rows, ...extra] });
}

function verificationOf(c: RuleFixtureCase): Record<string, { lastVerifiedAt: string }> {
  const src = c.source;
  if (src === null) return { "ecfr-16cfr435": { lastVerifiedAt: c.clock.slice(0, 10) } };
  if ("record" in src) return {};
  expect(src.refresh_window_days).toBe(R05_V1_PARAMS.refreshWindowDays);
  return { "ecfr-16cfr435": { lastVerifiedAt: src.last_verified_on } };
}

function run(
  snapshot: OrderSnapshot, now: number,
  opts: { verification?: Record<string, { lastVerifiedAt: string }>; cc?: CaseContext; params?: R05Params } = {},
): EvaluationResult {
  return evaluateR05V1({
    snapshot, snapshotHash: "fixture", engineVersion: ENGINE_VERSION, remedyKey: R05_REMEDY_KEY, subjectKey: "txn",
    pack: { ruleId: r05LateOrderV1.ruleId, scenarioId: "R05", version: r05LateOrderV1.version, params: opts.params ?? R05_V1_PARAMS, sources: R05_V1_SOURCES },
    verification: opts.verification ?? { "ecfr-16cfr435": { lastVerifiedAt: new Date(now).toISOString().slice(0, 10) } },
    caseContext: opts.cc ?? { settledMinorByLossKey: {} },
    now,
  });
}
const runCase = (c: RuleFixtureCase, extra: CellRow[] = []) => run(snapshotOf(c, extra), c.now, { verification: verificationOf(c) });

const UNRESOLVED = new Set(["missing", "user_unknown", "conflicting"]);
const CAPPED = new Set(["candidate_unconfirmed", "conflict_capped"]);
const namesOf = (list: MissingFact[], cls: Set<string>) =>
  [...new Set(list.filter((m) => cls.has(m.reason)).map((m) => FIXTURE_NAME[m.key] ?? m.key))].sort();
const refund = (r: EvaluationResult) => r.deadlines.find((d) => d.id === R05_V1_REFUND_DEADLINE_ID);
const byId = (id: string) => FILE.cases.find((c) => c.id === id)!;
/** A copy of a case with some fixture facts replaced (a user's newer confirmation supersedes the old one). */
const withFacts = (c: RuleFixtureCase, facts: Record<string, Partial<FixtureFact> | null>): RuleFixtureCase => {
  const next: Record<string, FixtureFact> = { ...c.facts };
  for (const [name, f] of Object.entries(facts)) {
    if (f === null) delete next[name];
    else next[name] = { ...(c.facts[name] ?? { type: "string", state: "user_confirmed" }), ...f } as FixtureFact;
  }
  return { ...c, facts: next };
};
const row = (key: string, value: FactValue, state: ResolveRow["state"] = "user_confirmed", at = 2): CellRow =>
  ({ subjectKey: "txn", key, row: { state, value, at, source: state === "user_confirmed" ? { kind: "user" } : { kind: "evidence", ref: "test" } } });

// ---------------------------------------------------------------------------
// Every fixture, unchanged
// ---------------------------------------------------------------------------

describe("R05 v1 code pack × docs/rules/fixtures/R05.json (unmodified, via M08's loader)", () => {
  it("loads the file (hash-checked) with every case runnable, and the harness reads the calendar-zone convention", () => {
    expect(FILE.ruleId).toBe(r05LateOrderV1.ruleId);
    expect(FILE.ruleVersion).toBe(r05LateOrderV1.version);
    expect(FILE.cases.length).toBe(24);
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/rules/fixtures/R05.json"), "utf8")) as { conventions: { calendar_zone: string } };
    expect(raw.conventions.calendar_zone).toContain("America/New_York");
  });

  describe.each(FILE.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = runCase(c);
    const e = c.expected as Record<string, unknown> & { outcome: string };

    it(`outcome ${e.outcome}`, () => {
      expect(r.outcome).toBe(e.outcome);
    });

    it("missing_facts ↔ unresolved class; unconfirmed_decisive_facts ↔ capped class (D158/D161)", () => {
      expect(namesOf(r.missingFacts, UNRESOLVED)).toEqual([...((e.missing_facts as string[] | undefined) ?? [])].sort());
      expect(namesOf(r.missingFacts, CAPPED)).toEqual([...((e.unconfirmed_decisive_facts as string[] | undefined) ?? [])].sort());
    });

    it("amount, refund deadline, applicable time, vesting date, re-evaluation (where the fixture states them)", () => {
      const amount = e.amount as { refund_due?: { amount_minor: number; currency: string } | null } | null | undefined;
      if (amount === null) expect(r.amount).toBeNull();
      if (amount?.refund_due) expect(r.amount?.estimate).toEqual({ amountMinor: amount.refund_due.amount_minor, currency: amount.refund_due.currency });
      if (amount && amount.refund_due === null) expect(r.amount).toBeNull();

      const deadline = e.deadline as { date: string | null; status?: string } | null | undefined;
      if (deadline === null) expect(refund(r)).toBeUndefined();
      if (deadline && typeof deadline.date === "string") {
        expect(refund(r)?.dueLocalDate).toBe(deadline.date);
        expect(refund(r)?.obligor).toBe("counterparty");
        expect(refund(r)?.mustBe).toBe("sent");
      }
      if (deadline && deadline.date === null) {
        expect(refund(r)?.dueAt).toBeUndefined();
        expect(refund(r)?.overdueSince).toBeUndefined();
        expect(refund(r)?.advisoryActBy).toBeUndefined(); // counterparty: no advisory date (D154 condition 2)
        expect(refund(r)?.status).toBe(deadline.status);
      }
      if (typeof e.applicable_time_end === "string") {
        expect(r.conditions.find((x) => x.id === R05_V1_TIMING_ID)?.note).toContain(`ends ${e.applicable_time_end}`);
      }
      if (typeof e.vesting_date === "string") expect(r.explanation.join(" ")).toContain(`vested on ${e.vesting_date}`);
      if (typeof e.auto_cancellation_date === "string") expect(r.explanation.join(" ")).toContain(e.auto_cancellation_date);
      if (typeof e.reevaluate_at === "string") expect(r.reevaluate?.at).toBe(e.reevaluate_at);
      if (typeof e.reevaluate_when === "string") expect(r.reevaluate?.when).toBe(e.reevaluate_when);
      if (r.outcome !== "not_yet_due") expect(r.reevaluate).toBeUndefined();
    });

    it("next action, overlap, explanation, dedupe, forbidden outputs", async () => {
      if (typeof e.next_action === "string") {
        if (e.next_action.startsWith("Ask the seller to cancel and refund")) expect(r.nextAction).toEqual({ kind: "open_case" });
        else {
          // R05-04b (D154): the awaited event is the user's own action — presented as something to do now.
          expect(r.nextAction).toEqual({ kind: "answer_questions", keys: [{ subjectKey: "txn", key: "order.buyer_response" }] });
          expect(r.explanation.join(" ")).toContain("cancel before shipment for a prompt refund");
        }
      }
      if (r.outcome === "not_yet_due" && typeof e.reevaluate_at === "string") {
        expect(r.nextAction).toEqual({ kind: "wait", reevaluate: { at: e.reevaluate_at } });
      }
      const overlap = e.overlap as { with: string } | undefined;
      if (overlap?.with === "R03") expect(r.overlap).toEqual([{ withScenario: "R03", withRemedyKey: R05_R03_REMEDY_KEY, relation: "alternative" }]);
      if (typeof e.explanation === "string") {
        // R05-13 (5a): the explanation names both sources and how to resolve it.
        const t = r.explanation.join(" ");
        expect(t).toContain("2026-09-03");
        expect(t).toContain("user");
        expect(t.toLowerCase()).toContain("upload proof");
        expect(t).toContain("not a shipping-time problem");
      }
      if (typeof e.reason === "string") {
        expect(r.nextAction.kind).toBe("manual_review");
        expect(r.flags.manualReviewReason).toContain("435.2(c)");
      }
      if (Array.isArray(e.pointers)) expect(r.explanation.join(" ")).toContain("R03");
      if (e.dedupe !== undefined) {
        const again = runCase(c);
        expect(await resultHash(again, "b")).toBe(await resultHash(r, "b"));
      }
      if (Array.isArray(e.forbidden_outputs) && c.facts.delivered_at) {
        // R05-02: the delivery date is never read as the shipping date.
        expect(JSON.stringify(r)).not.toContain("2026-09-12");
      }
      expect(r.boundFacts.length).toBeLessThanOrEqual(32);
      expect(r.lossKeys).toEqual([`txn:${TXN_ID}:paid`]);
    });
  });
});

// ---------------------------------------------------------------------------
// Contract §10 rows naming M21 (R05) and pack invariants
// ---------------------------------------------------------------------------

describe("contract §10 R05 rows (M21)", () => {
  it("D147(6) packs: R05-04b/04c/05a/05b/07 are not_yet_due with the fixture's reevaluate values, never not_eligible", () => {
    const expected: Record<string, { at?: string; when?: string }> = {
      "R05-04b": { when: "buyer cancels before shipment (continuing right to cancel, 435.2(b)(1)(iii)(B))" },
      "R05-04c": { at: "2026-10-11" },
      "R05-05a": { at: "2026-09-01" },
      "R05-05b": { at: "2026-09-01" },
      "R05-07": { at: "2026-09-21" },
    };
    for (const [id, re] of Object.entries(expected)) {
      const r = runCase(byId(id));
      expect(r.outcome, id).toBe("not_yet_due");
      expect(r.reevaluate, id).toEqual(re);
      expect(r.amount, id).toBeNull();
      expect(r.deadlines, id).toEqual([]);
    }
  });

  it("promised ship-by missed with no consent → eligible; the estimate is the order total paid", () => {
    const r = runCase(byId("R05-01"));
    expect(r.outcome).toBe("eligible");
    expect(r.amount).toMatchObject({ estimate: { amountMinor: 15000, currency: "USD" }, basis: "documented_total" });
    expect(r.dimensions.readyForApproval).toBe("pass");
  });

  it("wave-2 note: an R05 estimate of 64,950 on an order total of 64,950 with items of 60,000 is not capped by the items", () => {
    const itemRows = [
      { subjectKey: "item:fixtureitema", key: "retail.unit_price", row: { state: "user_confirmed" as const, value: { kind: "money" as const, amountMinor: 30000, currency: "USD" }, at: 1, source: { kind: "legacy_purchase" as const } } },
      { subjectKey: "item:fixtureitema", key: "retail.quantity", row: { state: "user_confirmed" as const, value: { kind: "count" as const, n: 2 }, at: 1, source: { kind: "legacy_purchase" as const } } },
    ];
    const r = runCase(withFacts(byId("R05-01"), { amount_tendered: { value: { amount_minor: 64950, currency: "USD" } } }), itemRows);
    expect(r.amount?.estimate).toEqual({ amountMinor: 64950, currency: "USD" });
    expect(r.amount?.cap).toBeUndefined();
    // …and the dashboard's per-transaction cap (§3.4), given the confirmed order total, leaves it whole.
    const s = computeSummary([], [{ id: "r05", currency: "USD", estimateMinor: 64950, lossKeys: r.lossKeys, anchor: "purchase:p1" }],
      new Map([["purchase:p1", { amountMinor: 64950, currency: "USD", partial: false }]])).find((x) => x.currency === "USD")!;
    expect(s.tiles.potential.amountMinor).toBe(64950);
    expect(s.cappedAtPaidTotal).toBe(false);
  });

  it("no stated time → the 30-day default, 50 days with a seller credit application — params citing the spec's passages", () => {
    expect(R05_V1_PARAMS.defaultShipDays).toBe(30);
    expect(R05_V1_PARAMS.creditApplicationShipDays).toBe(50);
    expect(runCase(byId("R05-05c")).conditions.find((x) => x.id === R05_V1_TIMING_ID)?.note).toContain("30 days after the properly completed order");
    expect(runCase(byId("R05-07")).conditions.find((x) => x.id === R05_V1_TIMING_ID)?.note).toContain("50 days after the properly completed order");
    for (const [param, ids] of Object.entries(R05_V1_PARAM_SOURCES)) {
      expect(ids.length, param).toBeGreaterThan(0);
      for (const id of ids) expect(SPEC_TEXT, `${param} cites ${id}`).toContain(id);
    }
    expect(Object.keys(R05_V1_PARAM_SOURCES).sort()).toEqual(Object.keys(R05_V1_PARAMS).sort());
    expect(Object.isFrozen(R05_V1_PARAMS)).toBe(true);
    for (const src of R05_V1_SOURCES) expect(SPEC_TEXT + FIXTURE_EXCERPTS, src.passageId).toContain(src.passageId);
  });

  it("shipment date and delivery date are separate keys, and swapping them changes the outcome", () => {
    const c = byId("R05-02");
    expect(runCase(c).outcome).toBe("not_eligible");
    // Reading the delivery date (2026-09-12) as the shipment date turns an on-time shipment into a late one.
    const swapped = runCase(withFacts(c, { shipped_at: { value: c.facts.delivered_at.value } }));
    expect(swapped.outcome).not.toBe("not_eligible");
    expect(R05_BOUND_KEYS).toContain("order.shipped_at");
    expect(R05_BOUND_KEYS.some((k) => k.includes("deliver"))).toBe(false);
  });

  it("consent → not eligible only until the consented date: not_yet_due before it, a refund after it", () => {
    const c = byId("R05-03"); // deemed consent to 2026-09-05
    const notShipped = withFacts(c, { shipped_at: { value: null } });
    const before = run(snapshotOf(notShipped), Date.parse("2026-09-05T20:00:00-04:00"));
    expect(before.outcome).toBe("not_yet_due");
    expect(before.reevaluate).toEqual({ at: "2026-09-06" });
    const after = run(snapshotOf(notShipped), Date.parse("2026-09-06T09:00:00-04:00"));
    expect(["eligible", "likely_eligible", "needs_facts"]).toContain(after.outcome);
    expect(after.outcome).not.toBe("not_eligible");
    expect(after.explanation.join(" ")).toContain("vested on 2026-09-06");
  });

  it("post-shipment non-delivery is not the MITOR remedy: shipped on time, never delivered → not_eligible", () => {
    const c = byId("R05-01");
    const r = runCase(withFacts(c, { shipped_at: { value: "2026-09-03T15:00:00-04:00" } }));
    expect(r.outcome).toBe("not_eligible");
    expect(r.amount).toBeNull();
    expect(r.deadlines).toEqual([]);
  });

  it("the production registry never returns R05; the test registry does only through setTestActivations", () => {
    expect(prod.IMPLEMENTED_PACKS).toContain(r05LateOrderV1);
    expect(prod.activePack("R05")).toBeNull();
    expect(prod.isPackActive(r05LateOrderV1.ruleId, 1)).toBe(false);
    expect(coverageRows().find((x) => x.scenarioId === "R05")?.status).toBe("not_checked");
    try {
      setTestActivations([]);
      expect(activePack("R05")).toBeNull();
      setTestActivations([{ ruleId: r05LateOrderV1.ruleId, version: 1, status: "active", decision: "TEST" }]);
      expect(activePack("R05")).toBe(r05LateOrderV1);
      setTestActivations([
        { ruleId: r05LateOrderV1.ruleId, version: 1, status: "active", decision: "TEST" },
        { ruleId: r05LateOrderV1.ruleId, version: 1, status: "withdrawn", decision: "TEST2" },
      ]);
      expect(activePack("R05")).toBeNull();
    } finally {
      resetTestRegistry();
    }
  });
});

const FIXTURE_EXCERPTS = readFileSync(path.join(REPO_ROOT, "docs/rules/sources/federal-web-pages-excerpts.md"), "utf8");

describe("R05 v1 pack invariants beyond the fixtures", () => {
  const base = byId("R05-01");

  it("the pack declares itself researched, cites no activation, and names R03 as the alternative", () => {
    expect(r05LateOrderV1.lifecycle).toBe("researched");
    expect(r05LateOrderV1.remedyKey).toBe(R05_REMEDY_KEY);
    expect(r05LateOrderV1.overlap).toEqual([{ withScenario: "R03", withRemedyKey: R05_R03_REMEDY_KEY, relation: "alternative" }]);
    expect(r05LateOrderV1.fixturesPath).toBe(FILE.relPath);
  });

  it("an unknown time zone: every US zone agrees far from a boundary → the same answer, no zone question", () => {
    const c = byId("R05-01");
    const snap = buildOrderSnapshot({ transactionId: TXN_ID, rows: Object.entries(c.facts).flatMap(([n, f]) => rowsOf(n, f)) });
    const r = run(snap, c.now);
    expect(r.outcome).toBe("eligible");
    expect(r.missingFacts).toEqual([]);
    expect(r.explanation.join(" ")).toContain("Your time zone is not known");
  });

  it("an unknown time zone on the boundary (R05-05: 01:00 New York on day 31, still day 30 further west) asks for the zone", () => {
    const c = byId("R05-05b");
    const facts = Object.entries(c.facts).filter(([n]) => n !== "ship_to_timezone");
    const snap = buildOrderSnapshot({ transactionId: TXN_ID, rows: facts.flatMap(([n, f]) => rowsOf(n, f)) });
    expect(run(snap, c.now).outcome).toBe("not_yet_due"); // 23:00 New York: day 30 has not ended anywhere in the US
    const r = run(snap, Date.parse("2026-09-01T01:00:00-04:00"));
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["order.ship_to_time_zone", "missing"]]);
    expect(r.deadlines).toEqual([]);
  });

  it("an extracted shipped-on-time date never makes the path not_eligible: it is asked instead (rule 3, known facts only)", () => {
    const r = runCase(base, [row("order.shipped", bool(true), "extracted_candidate", 3), row("order.shipped_at", instant("2026-09-03T15:00:00-04:00"), "extracted_candidate", 3)]);
    // The candidate rows sit under the user's confirmed "not shipped", so resolution keeps the confirmation.
    expect(r.outcome).toBe("eligible");
    const onlyCandidate = runCase(byId("R05-02"), [row("order.shipped_at", instant("2026-09-03T16:20:00-04:00"), "extracted_candidate", 3)]);
    expect(onlyCandidate.outcome).toBe("not_eligible");
    const c = byId("R05-02");
    const snap = buildOrderSnapshot({
      transactionId: TXN_ID,
      rows: [
        ...Object.entries(c.facts).filter(([n]) => n !== "shipped_at" && !NOT_READ.has(n)).flatMap(([n, f]) => rowsOf(n, f)),
        row("order.shipped", bool(true), "extracted_candidate", 1), row("order.shipped_at", instant("2026-09-03T16:20:00-04:00"), "extracted_candidate", 1),
        row("order.ship_to_time_zone", code("America/New_York")),
      ],
    });
    const r2 = run(snap, c.now);
    expect(r2.outcome).toBe("needs_facts");
    expect(r2.missingFacts.map((m) => [m.key, m.reason]).sort()).toEqual([["order.shipped", "candidate_unconfirmed"], ["order.shipped_at", "candidate_unconfirmed"]]);
  });

  it("an extracted order total caps the outcome at likely_eligible and is listed as unconfirmed (README cross-pack rule 1)", () => {
    const c = byId("R05-01");
    const r = run(snapshotOf(withFacts(c, { amount_tendered: { state: "extracted_candidate" } })), c.now);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["retail.order_total", "candidate_unconfirmed"]]);
    expect(r.amount?.estimate.amountMinor).toBe(15000);
  });

  it("a vested refund with no order total asks for it (needs_facts), and no amount is invented", () => {
    const c = byId("R05-01");
    const r = run(snapshotOf(withFacts(c, { amount_tendered: null })), c.now);
    expect(r.outcome).toBe("needs_facts");
    expect(r.missingFacts.map((m) => [m.key, m.reason])).toEqual([["retail.order_total", "missing"]]);
    expect(r.amount).toBeNull();
  });

  it("unknown country / category / payment terms are assumptions (US order, ordinary merchandise, paid at order) → likely_eligible", () => {
    const c = byId("R05-01");
    const keep = ["order_channel", "seller_identity", "properly_completed_order_at", "shipping_representation", "shipped_at", "delay_notices", "amount_tendered"];
    const drop = Object.fromEntries(Object.keys(c.facts).filter((n) => !keep.includes(n)).map((n) => [n, null]));
    const r = run(snapshotOf(withFacts(c, drop)), c.now);
    expect(r.outcome).toBe("likely_eligible");
    expect(r.missingFacts).toEqual([]);
    expect(r.assumptions.map((a) => a.id).sort()).toEqual(["R05.A-category", "R05.A-not-cod", "R05.A-us"]);
  });

  it("a buyer cancellation under an early delay notice vests at once, even before T", () => {
    const c = byId("R05-04c"); // T = 2026-09-10; notice 2026-09-08 (indefinite)
    const r = run(snapshotOf(withFacts(c, { buyer_response: { value: "cancelled" } }), [row("order.buyer_response_at", instant("2026-09-09T10:00:00-04:00"))]), Date.parse("2026-09-09T18:00:00-04:00"));
    expect(r.outcome).toBe("eligible");
    expect(r.explanation.join(" ")).toContain("vested on 2026-09-09");
    expect(refund(r)?.dueLocalDate).toBe("2026-09-18");
  });

  it("a seller's refund deadline passed on an open case → escalate; without a case → open_case", () => {
    const c = byId("R05-01");
    const late = Date.parse("2026-09-17T09:00:00-04:00");
    const open = run(snapshotOf(c), late, { cc: { settledMinorByLossKey: {}, activeClaimId: "fixtureclaim5" as Id<"claims"> } });
    expect(refund(open)?.status).toBe("overdue");
    expect(open.nextAction.kind).toBe("escalate");
    expect(run(snapshotOf(c), late).nextAction).toEqual({ kind: "open_case" });
  });

  it("a partial shipment keeps the path eligible but leaves the amount to review (FTC-MITOR-G7)", () => {
    const r = runCase(byId("R05-01c"));
    expect(r.outcome).toBe("eligible");
    expect(r.amount).toBeNull();
    expect(r.dimensions.readyForApproval).toBe("fail");
    expect(r.explanation.join(" ")).toContain("FTC-MITOR-G7");
  });

  it("an order before the rule's effective date (2014-12-08) is source_unverified (README rule 5)", () => {
    const c = byId("R05-01");
    const r = runCase(withFacts(c, { properly_completed_order_at: { value: "2013-03-01T10:00:00-05:00" } }));
    expect(r.outcome).toBe("source_unverified");
    expect(r.flags.effectiveDateMismatch).toBe(true);
  });

  it("bound facts are canonical (subject, key, status, value) rows, sorted, ≤ 32, and ignore the live evaluation", () => {
    const r = runCase(base);
    expect(R05_BOUND_KEYS.length).toBeLessThanOrEqual(32);
    expect(r.boundFacts.map((b) => b.key)).toEqual([...R05_BOUND_KEYS].sort());
    const again = runCase(base);
    expect(again.boundFacts).toEqual(r.boundFacts);
    expect(r.boundFacts.find((b) => b.key === "retail.order_total")).toEqual({ subjectKey: "txn", key: "retail.order_total", status: "confirmed", value: { kind: "money", amountMinor: 15000, currency: "USD" } });
  });

  it("the evaluation is deterministic: the same input twice gives the same result hash (evaluating twice → one row)", async () => {
    for (const c of FILE.cases) {
      expect(await resultHash(runCase(c), "b"), c.id).toBe(await resultHash(runCase(c), "b"));
    }
  });

  it("no explicit undefined anywhere in a result (results are stored)", () => {
    const hasUndefined = (v: unknown): boolean =>
      v === undefined || (typeof v === "object" && v !== null && Object.values(v as Record<string, unknown>).some(hasUndefined));
    for (const c of FILE.cases) expect(hasUndefined(runCase(c)), c.id).toBe(false);
  });
});
