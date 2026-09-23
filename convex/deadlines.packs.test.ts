/// <reference types="vite/client" />
/**
 * M29 contract tests through REAL rule packs (test registry: every implemented pack active) and the production
 * opportunities path (facts → adapter → evaluateTransaction → opportunities/evaluations), driven by `deadlines.sweep`:
 *   - rev 5.2: "R05-04c re-evaluated on 2026-10-11 → new outcome recorded";
 *   - rev 5.5 (D158): "R03 opportunity in manual_review with 10 days left on the received-by deadline → attention set;
 *     after the deadline passes → no attention" (fixture R03-13's facts: a confirmed non-delivery contradicted by an
 *     observed carrier delivery → 5a manual_review, the received-by deadline still running).
 * Facts are the fixtures' facts (docs/rules/fixtures R05-04 / R03-08 + R03-13), written as fact rows with the same
 * key mapping the pack harnesses use. `lib/rules/verification.ts` (lead data, empty today) is replaced by a record
 * dated 2026-09-23 for every implemented pack's sources, so no path is `source_unverified`. All timers are faked;
 * scheduled work runs only through `finishAllScheduledFunctions` (D233).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
const VER = vi.hoisted(() => ({
  VERIFICATION: {} as Record<string, { lastVerifiedAt: string; sha256: string }>,
  LIVE_VERIFICATIONS: [] as unknown[],
}));
vi.mock("./lib/rules/verification", () => VER);

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { evaluateTransaction } from "./opportunities";
import { IMPLEMENTED_PACKS } from "./lib/rules/applicable";
import { resetTestRegistry } from "./lib/rules/testRegistry";
import type { FactValue } from "./lib/rules/types";

type T = ReturnType<typeof setup>;
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  resetTestRegistry();
  for (const pack of IMPLEMENTED_PACKS) {
    for (const s of pack.sources) VER.VERIFICATION[s.sourceId] = { lastVerifiedAt: "2026-09-23", sha256: "0".repeat(64) };
  }
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of Object.keys(VER.VERIFICATION)) delete VER.VERIFICATION[k];
});

const code = (c: string): FactValue => ({ kind: "code", code: c });
const text = (t: string): FactValue => ({ kind: "text", text: t });
const bool = (b: boolean): FactValue => ({ kind: "bool", value: b });
const instant = (s: string): FactValue => ({ kind: "instant", epochMs: Date.parse(s) });
const localDate = (d: string): FactValue => ({ kind: "local_date", date: d });
const usd = (amountMinor: number): FactValue => ({ kind: "money", amountMinor, currency: "USD" });

type Row = { key: string; value: FactValue; state?: "user_confirmed" | "observed" | "derived" };

/** A transaction with fact rows on subject `txn`, evaluated once at `at`; returns its (single) opportunity. */
async function seed(t: T, userId: Id<"users">, category: "retail_order" | "card_charge", counterpartyName: string, rows: Row[], at: number) {
  vi.setSystemTime(at);
  return await t.run(async (ctx) => {
    const transactionId = await ctx.db.insert("transactions", {
      userId, category, status: "active", counterpartyName, currency: "USD", liveFactCount: rows.length,
    });
    for (const r of rows) {
      const state = r.state ?? "user_confirmed";
      await ctx.db.insert("facts", {
        userId, transactionId, subjectKey: "txn", key: r.key, state, value: r.value, recordedAt: at - DAY,
        source: state === "user_confirmed" ? { kind: "user" } : { kind: "derived", ruleId: "fixture", fromFactIds: [] },
      });
    }
    await evaluateTransaction(ctx, transactionId, "user_request", at);
    const opps = await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect();
    return { transactionId, opps };
  });
}

async function sweepAt(t: T, at: number) {
  vi.setSystemTime(at);
  const first = await t.mutation(internal.deadlines.sweep, { now: at });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(at);
  return first;
}

/** Fixture R05-04 (indefinite delay notice, no response, not shipped); R05-04c is the same facts on 2026-10-05. */
const R05_04: Row[] = [
  { key: "order.channel", value: code("internet") },
  { key: "order.seller_name", value: text("Example Electronics Direct") },
  { key: "order.merchandise_category", value: code("general_merchandise"), state: "derived" },
  { key: "card.payment_instrument_class", value: code("consumer_credit_card") },
  { key: "order.properly_completed_at", value: instant("2026-09-01T15:00:00-04:00") },
  { key: "order.ship_time_kind", value: code("date") },
  { key: "order.ship_by_date", value: localDate("2026-09-10") },
  { key: "order.ship_time_text", value: text("Ships by Sep 10") },
  { key: "order.delay_notice_received", value: bool(true) },
  { key: "order.delay_notice_received_at", value: instant("2026-09-08T09:00:00-04:00") },
  { key: "order.delay_revised_ship_kind", value: code("indefinite") },
  { key: "order.delay_notice_offers_cancel", value: bool(true) },
  { key: "order.buyer_response", value: code("no_response") },
  { key: "order.shipped", value: bool(false) },
  { key: "retail.order_total", value: usd(89_900) },
  { key: "order.buyer_country", value: code("US") },
  { key: "order.ship_to_country", value: code("US") },
  { key: "order.seller_country", value: code("US") },
  { key: "order.payment_terms", value: code("paid_at_order") },
  // The file's calendar-zone convention (the R05 harness adds the same confirmed row).
  { key: "order.ship_to_time_zone", value: code("America/New_York") },
];

describe("rev 5.2: R05-04c re-evaluated on 2026-10-11 → new outcome recorded", () => {
  it("not_yet_due (reevaluate.at 2026-10-11) on 2026-10-05; the sweep leaves it on 10-10 and re-evaluates it on 10-11", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { opps } = await seed(t, userId, "retail_order", "Example Electronics Direct", R05_04, Date.parse("2026-10-05T12:00:00-04:00"));
    const r05 = opps.find((o) => o.scenarioId === "R05")!;
    expect(r05).toMatchObject({ outcome: "not_yet_due", reevaluateAt: Date.UTC(2026, 9, 11) });
    const evaluationsOf = () =>
      t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", r05._id)).collect());
    expect((await evaluationsOf()).map((e) => [e.outcome, e.reevaluate?.at])).toEqual([["not_yet_due", "2026-10-11"]]);

    expect((await sweepAt(t, Date.parse("2026-10-10T12:00:00-04:00"))).reevaluated).toBe(0);
    expect(await evaluationsOf()).toHaveLength(1);

    // 2026-10-11, noon in New York: the order was deemed cancelled at the end of 10-10 (fixture R05-04: vesting 10-11).
    expect((await sweepAt(t, Date.parse("2026-10-11T12:00:00-04:00"))).reevaluated).toBe(1);
    const after = (await t.run((ctx) => ctx.db.get(r05._id)))!;
    expect(after.outcome).toBe("eligible");
    expect(after.reevaluateAt).toBeUndefined();
    const rows = await evaluationsOf();
    expect(rows.map((e) => e.outcome)).toEqual(["not_yet_due", "eligible"]);
    expect(rows[1].trigger).toBe("fact_change");
    expect(rows[1].amount?.estimate).toEqual({ amountMinor: 89_900, currency: "USD" });
  });
});

/** Fixture R03-08 with R03-13's override: confirmed "not delivered" vs an observed carrier delivery. */
const R03_13: Row[] = [
  { key: "card.payment_instrument_class", value: code("consumer_credit_card") },
  { key: "card.error_type", value: code("not_delivered_as_agreed") },
  { key: "card.charge_date", value: localDate("2026-08-12") },
  { key: "card.merchant_descriptor", value: text("PARTY RENTALS ONLINE") },
  { key: "card.charge_amount", value: usd(54_000) },
  { key: "card.delivery_status", value: code("not_delivered") },
  { key: "card.delivery_status", value: code("delivered"), state: "observed" },
  { key: "card.delivered_at", value: instant("2026-08-19T14:12:00-04:00"), state: "observed" },
  { key: "card.first_statement_transmitted_on", value: localDate("2026-08-28") },
  { key: "card.billing_error_address", value: text("PO Box 0000, Example City, ST 00000") },
  { key: "card.notice_channel_planned", value: code("mail_to_billing_error_address") },
  { key: "card.merchant_contacted", value: bool(false) },
];

describe("rev 5.5 (D158): R03 manual_review with the received-by deadline running", () => {
  it("10 days left → attention set; after the deadline passes → no attention", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { opps } = await seed(t, userId, "card_charge", "First Bank", R03_13, Date.parse("2026-09-23T12:00:00-04:00"));
    const r03 = opps.find((o) => o.scenarioId === "R03")!;
    expect(r03.outcome).toBe("manual_review");
    const evaluation = (await t.run((ctx) => ctx.db.get(r03.currentEvaluationId!)))!;
    const notice = evaluation.deadlines.find((d) => d.obligor === "user" && d.dueAt === r03.nextDeadlineAt)!;
    expect(notice).toMatchObject({ status: "open", dueLocalDate: "2026-10-27", mustBe: "received" });
    const due = r03.nextDeadlineAt!;

    // 30 days out: not yet.
    await sweepAt(t, due - 30 * DAY);
    expect((await t.run((ctx) => ctx.db.get(r03._id)))!.deadlineAttention).toBeUndefined();

    // 10 days left: set, bound to the received-by deadline.
    await sweepAt(t, due - 10 * DAY);
    expect((await t.run((ctx) => ctx.db.get(r03._id)))!.deadlineAttention).toEqual({ setAt: due - 10 * DAY, dueAt: due, deadlineId: notice.id });

    // One day after the deadline passed: cleared.
    await sweepAt(t, due + DAY);
    expect((await t.run((ctx) => ctx.db.get(r03._id)))!.deadlineAttention).toBeUndefined();
  });
});

describe("P06-OW-1 (re-audit): the sweep reconciles a stored R01 verdict whose window has passed", () => {
  it("in window: likely_eligible, open_case, 2,500 Potential; one day after the window + a sweep → deadline_passed, nothing in Potential", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const IN = Date.UTC(2026, 8, 20, 14);
    vi.setSystemTime(IN);
    const w = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: IN - 2 * DAY, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p/jacket", returned: false });
      await ctx.db.insert("policies", {
        userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", contactEmail: "help@acme.example",
        passage: "We adjust within 14 days.", sourceUrl: "https://acme.example/policy", retrievedAt: IN - 2 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      });
      return { purchaseId, itemId };
    });
    const r = await t.mutation(internal.priceWatch.recordCheck, {
      itemId: w.itemId, sourceUrl: "https://acme.example/p/jacket", observedCents: 9_500, currency: "USD", confidence: 0.92, isRange: false, variantMatch: "exact",
    });
    // The user dismisses the auto-opened claim and re-checks: the opportunity is a card again ("Start a claim").
    await as.mutation(api.claims.dismiss, { claimId: r.claimId! });
    await as.mutation(api.opportunities.reevaluate, { purchaseId: w.purchaseId });
    const card = async () => (await as.query(api.opportunities.forPurchase, { purchaseId: w.purchaseId })).opportunities.find((o) => o.opportunity.scenarioId === "R01")!;
    const inWindow = await card();
    expect(inWindow.opportunity).toMatchObject({ status: "open", outcome: "likely_eligible" });
    expect(inWindow.evaluation?.nextAction).toEqual({ kind: "open_case" });
    const windowEnd = inWindow.opportunity.nextDeadlineAt!;
    expect(windowEnd).toBe(IN - 2 * DAY + 14 * DAY);
    const potential = async (now: number) => (await as.query(api.recovery.summary, { now })).currencies.find((c) => c.currency === "USD")?.tiles.potential;
    expect((await potential(IN))?.amountMinor).toBe(2_500);

    const after = windowEnd + DAY;
    const res = await sweepAt(t, after);
    expect(res.reconciled ?? 0).toBe(0); // the first page is attention; reconciliation is the cycle's last phase
    const passed = await card();
    expect(passed.opportunity.outcome).toBe("deadline_passed");
    expect(passed.evaluation?.nextAction.kind).not.toBe("open_case");
    expect(passed.opportunity.nextDeadlineAt).toBeUndefined();
    expect((await potential(after))?.components ?? 0).toBe(0);

    // Reconciled once: the next tick sends nothing back.
    await sweepAt(t, after + 3_600_000);
    const evaluations = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", passed.opportunity._id)).collect());
    expect(evaluations.filter((e) => e.outcome === "deadline_passed")).toHaveLength(1);
  });
});
