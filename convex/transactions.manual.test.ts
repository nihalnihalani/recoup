/**
 * `transactions.createManual` (contract §7 "Manual entry", wave 2; D220/D221). Written from the task, not from the
 * implementation: an owned active transaction of the chosen category; the entered values as `user_confirmed` facts
 * from the user ("your entry"), only under keys whose meaning matches exactly; every refusal before any write; the
 * other user sees nothing; and R02/R04 outcomes do not change because an `air.total_paid` fact is present.
 */
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn, twoUsers } from "./test.setup";
import { readLiveFacts } from "./lib/facts/write";
import { MAX_MERCHANT_CHARS, MAX_TRANSACTIONS_PER_USER, MAX_USER_AMOUNT_MINOR } from "./limits";
import type { FactValue } from "./lib/facts/catalog";
import { buildAirSnapshot, r02View, r04View, type CellRow } from "./lib/facts/snapshot_air";
import { evaluateR02V1, r02AirRefundV1, R02_SOURCES, R02_V1_PARAMS } from "./lib/rules/r02_air_refund_v1";
import { evaluateR04V1, R04_SOURCES, R04_V1_PACKS, R04_V1_PARAMS } from "./lib/rules/r04_baggage_v1";
import { ENGINE_VERSION } from "./lib/rules/types";

type T = ReturnType<typeof setup>;
const NOW = Date.UTC(2026, 8, 23, 15);
const DAY = 86_400_000;

const air = { category: "air_travel" as const, counterpartyName: "Example Air", currency: "USD", totalMinor: 44_880, transactedAt: NOW - 3 * DAY };
const card = { category: "card_charge" as const, counterpartyName: "ACME STORE 0042", currency: "USD", totalMinor: 12_999, transactedOn: "2026-09-02" };

async function rowsOf(t: T, transactionId: Id<"transactions">) {
  return t.run(async (ctx) => ({ txn: await ctx.db.get(transactionId), facts: await readLiveFacts(ctx, transactionId) }));
}
const counts = (t: T) => t.run(async (ctx) => ({ txns: (await ctx.db.query("transactions").collect()).length, facts: (await ctx.db.query("facts").collect()).length }));

describe("transactions.createManual", () => {
  pinClockEach(NOW);

  it("air_travel: an owned active transaction, and the total as a user_confirmed air.total_paid from the user", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const id = await as.mutation(api.transactions.createManual, air);
    const { txn, facts } = await rowsOf(t, id);
    expect(txn).toMatchObject({
      userId, category: "air_travel", status: "active", counterpartyName: "Example Air", currency: "USD", totalMinor: 44_880,
      transactedAt: NOW - 3 * DAY, liveFactCount: 1,
    });
    expect(txn?.purchaseId).toBeUndefined();
    expect(facts.map((f) => [f.subjectKey, f.key, f.state, f.source, f.value])).toEqual([
      ["txn", "air.total_paid", "user_confirmed", { kind: "user" }, { kind: "money", amountMinor: 44_880, currency: "USD" }],
    ]);
    expect(facts[0].userId).toBe(userId);
    // The counterparty stays on the row: airline or travel agency is a separate question (D221).
    expect(facts.map((f) => f.key)).not.toContain("air.operating_carrier");
    expect(facts.map((f) => f.key)).not.toContain("air.merchant_of_record");
  });

  it("card_charge: merchant descriptor, charge amount and charge date (from transactedOn only), all user_confirmed", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.transactions.createManual, card);
    const { txn, facts } = await rowsOf(t, id);
    expect(txn).toMatchObject({ category: "card_charge", status: "active", counterpartyName: "ACME STORE 0042", totalMinor: 12_999, liveFactCount: 3 });
    expect(txn?.transactedAt).toBeUndefined();
    expect(Object.fromEntries(facts.map((f) => [f.key, f.value]))).toEqual({
      "card.merchant_descriptor": { kind: "text", text: "ACME STORE 0042" },
      "card.charge_amount": { kind: "money", amountMinor: 12_999, currency: "USD" },
      "card.charge_date": { kind: "local_date", date: "2026-09-02" },
    });
    for (const f of facts) expect([f.state, f.source, f.subjectKey]).toEqual(["user_confirmed", { kind: "user" }, "txn"]);
  });

  it("a card charge date is never derived from an instant: transactedAt alone writes no card.charge_date", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.transactions.createManual, { category: "card_charge", counterpartyName: "ACME", currency: "USD", transactedAt: NOW - DAY });
    const { txn, facts } = await rowsOf(t, id);
    expect(txn?.transactedAt).toBe(NOW - DAY);
    expect(facts.map((f) => f.key)).toEqual(["card.merchant_descriptor"]);
  });

  it("optional fields: no total → no amount fact; an air entry with nothing but a name writes no fact", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const a = await as.mutation(api.transactions.createManual, { category: "air_travel", counterpartyName: "Example Air", currency: "USD" });
    expect((await rowsOf(t, a)).facts).toEqual([]);
    const c = await as.mutation(api.transactions.createManual, { category: "card_charge", counterpartyName: "ACME", currency: "USD" });
    expect((await rowsOf(t, c)).facts.map((f) => f.key)).toEqual(["card.merchant_descriptor"]);
  });

  it("transactedAt is capped at now (a device clock a few minutes fast is clamped, more than a day ahead is refused)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.transactions.createManual, { ...air, transactedAt: NOW + 5 * 60_000 });
    expect((await rowsOf(t, id)).txn?.transactedAt).toBe(NOW);
    await expect(as.mutation(api.transactions.createManual, { ...air, transactedAt: NOW + 2 * DAY })).rejects.toThrow(/not in the future/);
  });

  it("card numbers in the counterparty name are masked, never refused (D142)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const id = await as.mutation(api.transactions.createManual, { ...card, counterpartyName: "ACME 4111 1111 1111 1111" });
    const { txn, facts } = await rowsOf(t, id);
    expect(txn?.counterpartyName).not.toContain("4111 1111 1111 1111");
    expect(JSON.stringify(facts)).not.toContain("4111 1111 1111 1111");
  });

  describe("refusals: each before any write", () => {
    it.each([
      ["a negative total", { ...card, totalMinor: -1 }, /non-negative/],
      ["a fractional total (not minor units)", { ...card, totalMinor: 12.5 }, /whole number of minor units/],
      ["an unsafe total", { ...card, totalMinor: Number.MAX_SAFE_INTEGER + 2 }, /whole number of minor units/],
      ["a total above the typed-amount cap", { ...card, totalMinor: MAX_USER_AMOUNT_MINOR + 1 }, /larger than Recoup accepts/],
      ["a non-ISO currency", { ...card, currency: "usd" }, /USD only/],
      ["a currency new scenarios do not admit yet", { ...card, currency: "EUR" }, /USD only/],
      ["an empty counterparty", { ...card, counterpartyName: "   " }, /counterpartyName/],
      ["a counterparty with no letter or digit", { ...card, counterpartyName: "—" }, /counterpartyName/],
      ["a counterparty that is too long", { ...card, counterpartyName: "x".repeat(MAX_MERCHANT_CHARS + 1) }, /at most/],
      ["a transactedOn that is not a date", { ...card, transactedOn: "2026-02-30" }, /calendar date/],
      ["a transactedOn in the future everywhere", { ...card, transactedOn: "2026-09-25" }, /future/],
      ["a transactedAt that is not a time", { ...air, transactedAt: Number.NaN }, /valid time/],
    ] as const)("%s", async (_name, args, message) => {
      const t = setup();
      const { as } = await signedIn(t);
      await expect(as.mutation(api.transactions.createManual, args)).rejects.toThrow(message);
      expect(await counts(t)).toEqual({ txns: 0, facts: 0 });
    });

    it("signed out → refused, nothing written", async () => {
      const t = setup();
      await expect(t.mutation(api.transactions.createManual, card)).rejects.toThrow();
      expect(await counts(t)).toEqual({ txns: 0, facts: 0 });
    });

    it("a deleted (tombstoned) account → refused, nothing written", async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      await t.run(async (ctx) => {
        await ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 });
      });
      await expect(as.mutation(api.transactions.createManual, card)).rejects.toThrow(/deleted/);
      expect((await counts(t)).txns).toBe(0);
    });

    it(`the per-user cap (${MAX_TRANSACTIONS_PER_USER}, archived included) → refused`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      await t.run(async (ctx) => {
        for (let i = 0; i < MAX_TRANSACTIONS_PER_USER; i++) {
          await ctx.db.insert("transactions", { userId, category: "card_charge", status: i % 2 ? "archived" : "active", counterpartyName: `M${i}`, currency: "USD", liveFactCount: 0 });
        }
      });
      await expect(as.mutation(api.transactions.createManual, card)).rejects.toThrow(/up to 500/);
      expect((await counts(t)).facts).toBe(0);
    });
  });

  it("two users: each entry belongs to its creator; the other user can neither read it nor its facts", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    const id = await owner.as.mutation(api.transactions.createManual, card);
    const mine = await other.as.mutation(api.transactions.createManual, { ...card, counterpartyName: "OTHER SHOP" });
    const foreign = await other.as.query(api.transactions.get, { transactionId: id }).catch((e: Error) => e.message);
    expect(foreign).toMatch(/Transaction not found/);
    await expect(other.as.query(api.facts.list, { transactionId: id })).rejects.toThrow(/Transaction not found/);
    const lists = await Promise.all([owner.as.query(api.transactions.list, {}), other.as.query(api.transactions.list, {})]);
    expect(lists.map((l) => l.transactions.map((x) => x._id))).toEqual([[id], [mine]]);
    const { facts } = await rowsOf(t, id);
    for (const f of facts) expect(f.userId).toBe(owner.userId);
  });
});

describe("D221: an air.total_paid fact changes no R02/R04 outcome", () => {
  const TXN = "fixturetxnm24" as Id<"transactions">;
  const row = (key: string, value: FactValue, state: "user_confirmed" | "derived" = "user_confirmed"): CellRow =>
    ({ subjectKey: "txn", key, row: { state, value, at: 1, source: { kind: "user" } } });
  const at = (iso: string): FactValue => ({ kind: "instant", epochMs: Date.parse(iso) });
  const code = (c: string): FactValue => ({ kind: "code", code: c });
  const usd = (n: number): FactValue => ({ kind: "money", amountMinor: n, currency: "USD" });
  const no = (): FactValue => ({ kind: "bool", value: false });
  const total = row("air.total_paid", usd(99_999));
  // R02-01's confirmed facts (cancellation, rejected, credit card) and R04-01's (domestic bag 13h15m late, MBR filed).
  const R02_ROWS: CellRow[] = [
    row("air.itinerary_scope", code("domestic"), "derived"), row("air.operating_carrier", { kind: "text", text: "XA" }),
    row("air.merchant_of_record", code("carrier")), row("air.ticket_refundability", code("nonrefundable")), row("air.event_type", code("cancellation")),
    row("air.original_sched_departure_at", at("2026-10-05T07:00:00-04:00")), row("air.offer_type", code("rebooking")),
    row("air.consumer_response", code("rejected")), row("air.consumer_response_at", at("2026-10-01T15:20:00-04:00")),
    row("air.flew_changed_or_alternative", no()), row("air.payment_method_class", code("credit_card")), row("air.fare_paid", usd(38_000)),
    row("air.taxes_paid", usd(4_380)), row("air.ancillary_fees_total", usd(2_500)), row("air.already_refunded", usd(0)),
  ];
  const R04_ROWS: CellRow[] = [
    row("air.itinerary_scope", code("domestic"), "derived"), row("air.bag_fee_paid", usd(4_000)), row("air.large_aircraft_segment_on_ticket", { kind: "bool", value: true }),
    row("air.deplane_opportunity_at", at("2026-09-12T21:40:00-07:00")), row("air.bag_delivered_or_picked_up_at", at("2026-09-13T10:55:00-07:00")),
    row("air.mbr_filed", { kind: "bool", value: true }), row("air.exemption_failed_recheck", no()), row("air.exemption_failed_pickup", no()),
    row("air.exemption_voluntary_separation", no()),
    { subjectKey: "line:1", key: "air.expense_amount", row: { state: "user_confirmed", value: usd(3_000), at: 1, source: { kind: "user" } } },
    { subjectKey: "line:1", key: "air.expense_receipt", row: { state: "user_confirmed", value: { kind: "text", text: "r1" }, at: 1, source: { kind: "user" } } },
  ];

  it("R02 (eligible) and R04 paths a/b/c give identical results with and without air.total_paid", () => {
    const r02Now = Date.parse("2026-10-02T12:00:00-04:00");
    const evalR02 = (extra: CellRow[]) => evaluateR02V1({
      snapshot: r02View(buildAirSnapshot({ transactionId: TXN, rows: [...R02_ROWS, ...extra] })), snapshotHash: "x", engineVersion: ENGINE_VERSION,
      remedyKey: r02AirRefundV1.remedyKey, subjectKey: "txn",
      pack: { ruleId: r02AirRefundV1.ruleId, scenarioId: "R02", version: 1, params: R02_V1_PARAMS, sources: R02_SOURCES },
      verification: Object.fromEntries(R02_SOURCES.map((s) => [s.sourceId, { lastVerifiedAt: "2026-10-02" }])),
      caseContext: { settledMinorByLossKey: {} }, now: r02Now,
    });
    const r04Now = Date.parse("2026-09-23T12:00:00-07:00");
    const evalR04 = (path: "a" | "b" | "c", extra: CellRow[]) => {
      const pack = R04_V1_PACKS[{ a: 0, b: 1, c: 2 }[path]];
      return evaluateR04V1(path, {
        snapshot: r04View(buildAirSnapshot({ transactionId: TXN, rows: [...R04_ROWS, ...extra] })), snapshotHash: "x", engineVersion: ENGINE_VERSION,
        remedyKey: pack.remedyKey, subjectKey: "txn",
        pack: { ruleId: pack.ruleId, scenarioId: "R04", version: 1, params: R04_V1_PARAMS, sources: pack.sources },
        verification: Object.fromEntries(R04_SOURCES[path].map((s) => [s.sourceId, { lastVerifiedAt: "2026-09-23" }])),
        caseContext: { settledMinorByLossKey: {} }, now: r04Now,
      });
    };
    const base = evalR02([]);
    expect([base.outcome, base.amount?.estimate.amountMinor]).toEqual(["eligible", 44_880]);
    expect(evalR02([total])).toEqual(base);
    expect([evalR04("a", []).outcome, evalR04("b", []).outcome]).toEqual(["eligible", "likely_eligible"]);
    for (const p of ["a", "b", "c"] as const) expect(evalR04(p, [total])).toEqual(evalR04(p, []));
  });
});
