/// <reference types="vite/client" />
/**
 * M29 — the deadline sweep (C50, D158, D212, SEC-CH-6), through M20's fake scenario pack (`testing/scenarioPack.kit`:
 * `test.outcome` sets the outcome, `test.due` a USER "notice" deadline). Real R03/R05 packs run in
 * deadlines.packs.test.ts. All timers are faked and scheduled work runs only through `finishAllScheduledFunctions`,
 * so no reminder races a test (D233). Expected values are hand-written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./testing/scenarioPack.kit"));
vi.mock("./lib/packets/index", async () => await import("./testing/scenarioPack.kit"));

import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { setup, signedIn } from "./test.setup";
import { evaluateTransaction, REEVALUATE_RETRY_MS } from "./opportunities";
import { setFakeActive, TXN } from "./testing/scenarioPack.kit";
import type { FactValue } from "./lib/rules/types";
import {
  ATTENTION_CLEAR_LOOKBACK_MS,
  attentionFor,
  DEADLINE_ATTENTION_LEAD_MS,
  DEADLINE_SWEEP_OPS_KEY,
  DEADLINE_SWEEP_PAGE,
  deadlineAttentionActive,
  needsReminder,
  parseSweepRecord,
} from "./deadlines";

type T = ReturnType<typeof setup>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 23, 14);
const RECIPIENT = "First Bank Billing Disputes\nPO Box 100\nWilmington, DE 19801";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setFakeActive(true);
});

const money = (amountMinor: number): FactValue => ({ kind: "money", amountMinor, currency: "USD" });
const text = (t: string): FactValue => ({ kind: "text", text: t });
const code = (c: string): FactValue => ({ kind: "code", code: c });
const instant = (epochMs: number): FactValue => ({ kind: "instant", epochMs });

/** A card_charge transaction with the fake pack's facts, evaluated at `at` (its opportunity exists afterwards). */
async function seed(t: T, userId: Id<"users">, o: { outcome?: string; due?: number; isExample?: boolean; at?: number } = {}) {
  const facts: Record<string, FactValue> = {
    "test.amount": money(40_000), "test.recipient": text(RECIPIENT), "test.ref": text("STMT-2026-0915"),
    ...(o.outcome ? { "test.outcome": code(o.outcome) } : {}),
    ...(o.due !== undefined ? { "test.due": instant(o.due) } : {}),
  };
  return await t.run(async (ctx) => {
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "card_charge", status: "active", counterpartyName: "First Bank", currency: "USD", liveFactCount: Object.keys(facts).length,
      ...(o.isExample ? { isExample: true } : {}),
    });
    for (const [key, value] of Object.entries(facts)) {
      await ctx.db.insert("facts", { userId, transactionId, subjectKey: TXN, key, state: "user_confirmed", value, source: { kind: "user" }, recordedAt: NOW - DAY });
    }
    await evaluateTransaction(ctx, transactionId, "user_request", o.at ?? NOW);
    const [opp] = await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect();
    return { transactionId, opportunityId: opp._id };
  });
}

const oppOf = (t: T, id: Id<"opportunities">) => t.run(async (ctx) => (await ctx.db.get(id))!);

/** One sweep cycle at `at`, then every reminder and continuation it scheduled (the clock stays at `at`). */
async function sweepAt(t: T, at: number) {
  vi.setSystemTime(at);
  const first = await t.mutation(internal.deadlines.sweep, { now: at });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.setSystemTime(at);
  return first;
}

async function openCaseOn(t: T, as: Awaited<ReturnType<typeof signedIn>>["as"], opportunityId: Id<"opportunities">) {
  const opened = await as.mutation(api.opportunities.openCase, { opportunityId });
  if (!opened.ok) throw new Error(opened.message);
  return opened.claimId;
}

describe("attentionFor (pure)", () => {
  const due = NOW + 10 * DAY;
  const base = { opportunity: { status: "open" as const, outcome: "manual_review" as const, nextDeadlineAt: due, isExample: undefined }, openCase: null, now: NOW };
  const running = [{ id: "notice", obligor: "user" as const, status: "open", dueAt: due }];

  it("a running user deadline inside the window on a manual_review path → attention (D158)", () => {
    expect(attentionFor({ ...base, deadlines: running })).toEqual({ dueAt: due, deadlineId: "notice" });
  });
  it("met (D212) or passed → none; a counterparty deadline never counts", () => {
    expect(attentionFor({ ...base, deadlines: [{ ...running[0], status: "met" }] })).toBeNull();
    expect(attentionFor({ ...base, deadlines: [{ ...running[0], status: "passed" }] })).toBeNull();
    expect(attentionFor({ ...base, deadlines: [{ ...running[0], obligor: "counterparty" }] })).toBeNull();
  });
  it("the window: exactly LEAD before is in, one ms more is out; at or after the due instant → none", () => {
    expect(attentionFor({ ...base, deadlines: running, now: due - DEADLINE_ATTENTION_LEAD_MS })).not.toBeNull();
    expect(attentionFor({ ...base, deadlines: running, now: due - DEADLINE_ATTENTION_LEAD_MS - 1 })).toBeNull();
    expect(attentionFor({ ...base, deadlines: running, now: due })).toBeNull();
  });
  it("outcomes: approvable, needs_facts and manual_review only; closed/dismissed/superseded and examples never", () => {
    for (const outcome of ["eligible", "likely_eligible", "possible_contract_benefit", "needs_facts", "manual_review"] as const) {
      expect(attentionFor({ ...base, opportunity: { ...base.opportunity, outcome }, deadlines: running }), outcome).not.toBeNull();
    }
    for (const outcome of ["not_eligible", "deadline_passed", "source_unverified", "unsupported", "not_yet_due"] as const) {
      expect(attentionFor({ ...base, opportunity: { ...base.opportunity, outcome }, deadlines: running }), outcome).toBeNull();
    }
    for (const status of ["closed", "dismissed", "superseded"] as const) {
      expect(attentionFor({ ...base, opportunity: { ...base.opportunity, status }, deadlines: running }), status).toBeNull();
    }
    expect(attentionFor({ ...base, opportunity: { ...base.opportunity, isExample: true }, deadlines: running })).toBeNull();
  });
  it("an open case: only while its claim is open for ask and not submitted on its channel", () => {
    const caseOpen = { ...base.opportunity, status: "case_open" as const };
    expect(attentionFor({ ...base, opportunity: caseOpen, deadlines: running, openCase: { closedForAsk: false, submitted: false } })).not.toBeNull();
    expect(attentionFor({ ...base, opportunity: caseOpen, deadlines: running, openCase: { closedForAsk: true, submitted: false } })).toBeNull();
    expect(attentionFor({ ...base, opportunity: caseOpen, deadlines: running, openCase: { closedForAsk: false, submitted: true } })).toBeNull();
    expect(attentionFor({ ...base, opportunity: caseOpen, deadlines: running, openCase: null })).toBeNull();
  });
});

describe("deadline attention through the sweep (fake pack; C50)", () => {
  it("manual_review with 10 days left → attention set; after the deadline passes → no attention", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const due = NOW + 10 * DAY;
    const { opportunityId } = await seed(t, userId, { outcome: "manual_review", due });
    expect(await oppOf(t, opportunityId)).toMatchObject({ outcome: "manual_review", nextDeadlineAt: due });

    await sweepAt(t, NOW);
    const set = await oppOf(t, opportunityId);
    expect(set.deadlineAttention).toEqual({ setAt: NOW, dueAt: due, deadlineId: "fake.notice" });
    expect(deadlineAttentionActive(set, NOW)).toBe(true);

    // An hour later nothing changes and nothing is rescheduled for an open path whose attention is already set.
    const again = await sweepAt(t, NOW + 3_600_000);
    expect(again.scheduled).toBe(0);

    await sweepAt(t, due + DAY);
    const after = await oppOf(t, opportunityId);
    expect(after.deadlineAttention).toBeUndefined();
    expect(deadlineAttentionActive(after, due + DAY)).toBe(false);
  });

  it("outside the window (20 days left) → nothing yet; the tick 6 days later sets it", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const due = NOW + 20 * DAY;
    const { opportunityId } = await seed(t, userId, { outcome: "eligible", due });
    expect((await sweepAt(t, NOW)).scheduled).toBe(0);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toBeUndefined();
    await sweepAt(t, NOW + 6 * DAY);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toMatchObject({ dueAt: due });
  });

  it("a reminder for a case closed after scheduling is a no-op (SEC-CH-6): nothing written", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const due = NOW + 10 * DAY;
    const { opportunityId } = await seed(t, userId, { due });
    const claimId = await openCaseOn(t, as, opportunityId);
    // The sweep schedules the reminder for the open case...
    expect(await t.mutation(internal.deadlines.sweep, { now: NOW })).toMatchObject({ scanned: 0, continued: true }); // `open` page: none
    await t.mutation(internal.deadlines.sweep, { now: NOW, phase: "case_open", cursor: null });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((f) => f.name === "deadlines:remind" && f.state.kind === "pending")).toHaveLength(1);
    // ...then the case closes before it runs: the credit is confirmed in full.
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 40_000, evidence: "statement", idempotencyKey: "full" });
    const before = await oppOf(t, opportunityId);
    expect(before.status).toBe("closed");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await oppOf(t, opportunityId);
    expect(after).toEqual(before); // the reminder wrote nothing
    expect(after.deadlineAttention).toBeUndefined();
  });

  it("the same for an opportunity dismissed after scheduling, and for a tombstoned account", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const a = await seed(t, userId, { outcome: "manual_review", due: NOW + 5 * DAY });
    await t.mutation(internal.deadlines.sweep, { now: NOW });
    await as.mutation(api.opportunities.dismiss, { opportunityId: a.opportunityId });
    const dismissed = await oppOf(t, a.opportunityId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await oppOf(t, a.opportunityId)).toEqual(dismissed);

    const u2 = await signedIn(t, "Leaving");
    const b = await seed(t, u2.userId, { outcome: "manual_review", due: NOW + 5 * DAY });
    await t.mutation(internal.deadlines.sweep, { now: NOW });
    await t.run((ctx) => ctx.db.insert("accountState", { userId: u2.userId, status: "deleting", requestedAt: NOW, attempts: 0 }));
    const leaving = await oppOf(t, b.opportunityId);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await oppOf(t, b.opportunityId)).toEqual(leaving);
    expect(await t.mutation(internal.deadlines.remind, { opportunityId: b.opportunityId })).toBe("skipped");
  });

  it("an open case: attention while the packet is unsent; recording the submission clears it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const due = NOW + 9 * DAY;
    const { opportunityId } = await seed(t, userId, { due });
    const claimId = await openCaseOn(t, as, opportunityId);
    await sweepAt(t, NOW);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toMatchObject({ dueAt: due, deadlineId: "fake.notice" });

    const prepared = await as.mutation(api.packets.prepare, { claimId });
    if (!prepared.ok) throw new Error(prepared.message);
    const view = await as.query(api.packets.get, { packetId: prepared.packetId });
    expect(await as.mutation(api.packets.approve, { packetId: prepared.packetId, approvedHash: view.renderedHash })).toEqual({ ok: true });
    await as.mutation(api.submissions.record, { packetId: prepared.packetId, submittedAt: NOW });
    await sweepAt(t, NOW + 3_600_000);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toBeUndefined();
  });

  it("a `met` user deadline never needs attention (D212)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const due = NOW + 7 * DAY;
    const { opportunityId } = await seed(t, userId, { outcome: "manual_review", due });
    const opp = await oppOf(t, opportunityId);
    // The current evaluation says the notice deadline was met (only the engine's markMet writes it; stored here).
    await t.run(async (ctx) => {
      const ev = (await ctx.db.get(opp.currentEvaluationId!))!;
      await ctx.db.patch(ev._id, { deadlines: ev.deadlines.map((d) => ({ ...d, status: "met" as const })) });
    });
    await sweepAt(t, NOW);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toBeUndefined();
  });

  it("not for examples, not_eligible or not_yet_due paths", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const ids = [
      (await seed(t, userId, { due: NOW + 5 * DAY, isExample: true })).opportunityId,
      (await seed(t, userId, { outcome: "not_eligible", due: NOW + 5 * DAY })).opportunityId,
      (await seed(t, userId, { outcome: "not_yet_due", due: NOW + 5 * DAY })).opportunityId,
    ];
    await sweepAt(t, NOW);
    for (const id of ids) expect((await oppOf(t, id)).deadlineAttention, id).toBeUndefined();
  });

  it("D241: a re-evaluation that moves the user deadline clears attention (evaluateRun clears, never sets)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { opportunityId, transactionId } = await seed(t, userId, { outcome: "manual_review", due: NOW + 10 * DAY });
    await sweepAt(t, NOW);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toBeDefined();
    await t.run(async (ctx) => {
      const [old] = await ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId).eq("subjectKey", TXN).eq("key", "test.due")).collect();
      await ctx.db.patch(old._id, { state: "superseded" });
      await ctx.db.insert("facts", { userId, transactionId, subjectKey: TXN, key: "test.due", state: "user_confirmed", value: instant(NOW + 12 * DAY), source: { kind: "user" }, recordedAt: NOW });
      await evaluateTransaction(ctx, transactionId, "fact_change", NOW);
    });
    const moved = await oppOf(t, opportunityId);
    expect(moved.nextDeadlineAt).toBe(NOW + 12 * DAY);
    expect(moved.deadlineAttention).toBeUndefined();
    // The next tick sets it again, for the new deadline.
    await sweepAt(t, NOW + 3_600_000);
    expect((await oppOf(t, opportunityId)).deadlineAttention).toMatchObject({ dueAt: NOW + 12 * DAY });
  });

  it("needsReminder: set-once for open paths, re-checked for open cases, cleared when passed", () => {
    const o = { status: "open", outcome: "manual_review", nextDeadlineAt: NOW + DAY } as Doc<"opportunities">;
    expect(needsReminder(o, NOW)).toBe(true);
    expect(needsReminder({ ...o, deadlineAttention: { setAt: NOW, dueAt: NOW + DAY, deadlineId: "x" } }, NOW)).toBe(false);
    expect(needsReminder({ ...o, status: "case_open", deadlineAttention: { setAt: NOW, dueAt: NOW + DAY, deadlineId: "x" } }, NOW)).toBe(true);
    expect(needsReminder({ ...o, deadlineAttention: { setAt: NOW, dueAt: NOW + DAY, deadlineId: "x" } }, NOW + DAY)).toBe(true);
    expect(needsReminder(o, NOW + DAY)).toBe(false);
  });
});

describe("the same cron re-evaluates due not_yet_due paths (rev 5.2, M20's sweepReevaluateDue)", () => {
  it("before its date → nothing; on it → re-evaluated, a new outcome recorded; the record says so", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { opportunityId, transactionId } = await seed(t, userId, { outcome: "not_yet_due" });
    expect(await oppOf(t, opportunityId)).toMatchObject({ outcome: "not_yet_due", reevaluateAt: Date.UTC(2026, 9, 11) });
    // The path ripens (the fake pack reads the outcome from a fact).
    await t.run(async (ctx) => {
      const [old] = await ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId).eq("subjectKey", TXN).eq("key", "test.outcome")).collect();
      await ctx.db.patch(old._id, { state: "superseded" });
      await ctx.db.insert("facts", { userId, transactionId, subjectKey: TXN, key: "test.outcome", state: "user_confirmed", value: code("eligible"), source: { kind: "user" }, recordedAt: NOW });
    });
    expect((await sweepAt(t, Date.UTC(2026, 9, 10))).reevaluated).toBe(0);
    expect((await oppOf(t, opportunityId)).outcome).toBe("not_yet_due");
    expect((await sweepAt(t, Date.UTC(2026, 9, 11))).reevaluated).toBe(1);
    const after = await oppOf(t, opportunityId);
    expect(after.outcome).toBe("eligible");
    expect(after.reevaluateAt).toBeUndefined();
    const rows = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", opportunityId)).collect());
    expect(rows.map((r) => r.outcome)).toEqual(["not_yet_due", "eligible"]);
    const record = await t.run(async (ctx) => (await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", DEADLINE_SWEEP_OPS_KEY)).first())!);
    expect(parseSweepRecord(record.cursor)).toMatchObject({ cycleNow: Date.UTC(2026, 9, 11), phase: "reconcile", reevaluated: 1, reevaluateFailed: false, done: true });
  });
});

describe("M29 residual: the re-evaluation page cannot starve (stuck rows are deferred; a full page continues)", () => {
  it("50 due rows that stay not_yet_due (older) + 1 that ripened (newest) → the ripened one is re-evaluated in the same tick", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const stuck: Id<"opportunities">[] = [];
    for (let i = 0; i < 50; i++) stuck.push((await seed(t, userId, { outcome: "not_yet_due" })).opportunityId);
    const ripe = await seed(t, userId, { outcome: "not_yet_due" });
    await t.run(async (ctx) => {
      const [old] = await ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", ripe.transactionId).eq("subjectKey", TXN).eq("key", "test.outcome")).collect();
      await ctx.db.patch(old._id, { state: "superseded" });
      await ctx.db.insert("facts", { userId, transactionId: ripe.transactionId, subjectKey: TXN, key: "test.outcome", state: "user_confirmed", value: code("eligible"), source: { kind: "user" }, recordedAt: NOW });
    });
    // The fake pack keeps saying "check again on 2026-10-11" for the 50 (like a date begun in UTC, not yet locally).
    const at = Date.UTC(2026, 9, 11, 2);
    await sweepAt(t, at);
    expect((await oppOf(t, ripe.opportunityId)).outcome).toBe("eligible");
    for (const id of stuck.slice(0, 3)) {
      const o = await oppOf(t, id);
      expect([o.outcome, o.reevaluateAt]).toEqual(["not_yet_due", at + REEVALUATE_RETRY_MS]); // retried in an hour, behind the rest
    }
  });
});

describe("the re-evaluation is tombstone-gated", () => {
  it("a due not_yet_due path of an account being deleted is not re-evaluated (no evaluation row); it only waits behind the rest", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { opportunityId } = await seed(t, userId, { outcome: "not_yet_due" });
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 }));
    const before = await oppOf(t, opportunityId);
    const at = Date.UTC(2026, 9, 11);
    await sweepAt(t, at);
    const after = await oppOf(t, opportunityId);
    expect({ ...after, reevaluateAt: undefined }).toEqual({ ...before, reevaluateAt: undefined }); // nothing else changed
    expect(after.reevaluateAt).toBe(at + REEVALUATE_RETRY_MS); // the starvation guard defers it behind every other due row
    const rows = await t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", opportunityId)).collect());
    expect(rows).toHaveLength(1);
  });
});

describe("paging: more than one page is finished by continuations with the same `now`", () => {
  it(`${DEADLINE_SWEEP_PAGE + 5} open paths in the window → all get attention over two pages; the record totals the cycle`, async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const due = NOW + 3 * DAY;
    await t.run(async (ctx) => {
      for (let i = 0; i < DEADLINE_SWEEP_PAGE + 5; i++) await insertOpportunity(ctx, userId, { dueAt: due, outcome: "manual_review", n: i });
    });
    const first = await t.mutation(internal.deadlines.sweep, { now: NOW });
    expect(first).toMatchObject({ scanned: DEADLINE_SWEEP_PAGE, scheduled: DEADLINE_SWEEP_PAGE, continued: true });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const opps = await t.run((ctx) => ctx.db.query("opportunities").collect());
    expect(opps.filter((o) => o.deadlineAttention?.dueAt === due)).toHaveLength(DEADLINE_SWEEP_PAGE + 5);
    const record = await t.run(async (ctx) => (await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", DEADLINE_SWEEP_OPS_KEY)).first())!);
    expect(parseSweepRecord(record.cursor)).toMatchObject({ cycleNow: NOW, scanned: DEADLINE_SWEEP_PAGE + 5, scheduled: DEADLINE_SWEEP_PAGE + 5, done: true });
  });

  it("the scan range: a deadline passed more than the look-back ago, or beyond the window, is never read", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      await insertOpportunity(ctx, userId, { dueAt: NOW - ATTENTION_CLEAR_LOOKBACK_MS - 1, outcome: "manual_review", n: 1 });
      await insertOpportunity(ctx, userId, { dueAt: NOW + DEADLINE_ATTENTION_LEAD_MS + 1, outcome: "manual_review", n: 2 });
      await insertOpportunity(ctx, userId, { dueAt: NOW - ATTENTION_CLEAR_LOOKBACK_MS, outcome: "manual_review", n: 3 });
      await insertOpportunity(ctx, userId, { dueAt: NOW + DEADLINE_ATTENTION_LEAD_MS, outcome: "manual_review", n: 4 });
    });
    expect(await t.mutation(internal.deadlines.sweep, { now: NOW })).toMatchObject({ scanned: 2, scheduled: 1 });
  });
});

/**
 * An opportunity + its current evaluation written directly (the fixture, not the code under test): a USER deadline
 * `notice` due at `dueAt`, on a card_charge transaction.
 */
async function insertOpportunity(
  ctx: Parameters<Parameters<T["run"]>[0]>[0],
  userId: Id<"users">,
  o: { dueAt: number; outcome: Doc<"opportunities">["outcome"]; n: number; status?: "open" | "case_open" },
) {
  const transactionId = await ctx.db.insert("transactions", { userId, category: "card_charge", status: "active", counterpartyName: `Bank ${o.n}`, currency: "USD", liveFactCount: 0 });
  const dedupeKey = `${transactionId}|R13|billing_correction|txn|-`;
  const opportunityId = await ctx.db.insert("opportunities", {
    userId, transactionId, scenarioId: "R13", remedyKey: "billing_correction", subjectKey: TXN, dedupeKey, status: o.status ?? "open",
    ruleId: "TEST.R13.fake_billing", ruleVersion: 1, outcome: o.outcome, authorityClass: "legal_entitlement", remedyType: "billing_correction",
    cashClass: "cash", nextDeadlineAt: o.dueAt, lossKeys: [`txn:${transactionId}:paid`], lastEvaluatedAt: NOW,
  });
  const evaluationId = await ctx.db.insert("evaluations", {
    userId, opportunityId, scenarioId: "R13", ruleId: "TEST.R13.fake_billing", ruleVersion: 1, factSnapshotHash: "f", resultHash: `r${o.n}`,
    evaluatedAt: NOW, trigger: "user_request", outcome: o.outcome,
    dimensions: { applies: "pass", factsKnown: "pass", evidenceSupports: "pass", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "fail" },
    conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null,
    deadlines: [{ id: "notice", label: "Notice received by", obligor: "user", status: "open", dueAt: o.dueAt, mustBe: "received", basis: "test" }],
    sourceRefs: [], overlap: [], nextAction: { kind: "manual_review", reason: "test" }, explanation: [],
  });
  await ctx.db.patch(opportunityId, { currentEvaluationId: evaluationId });
  return { transactionId, opportunityId };
}

// ---------------------------------------------------------------------------
// Bounds and read budgets, measured at the caps under enforced transaction limits.
// ---------------------------------------------------------------------------

const modules = import.meta.glob("./**/*.*s");
const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });
function limitedHarness() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const t = convexTest({ schema, modules, transactionLimits: true });
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}

async function measured<R>(t: ReturnType<typeof limitedHarness>, fn: (ctx: Parameters<Parameters<ReturnType<typeof limitedHarness>["run"]>[0]>[0]) => Promise<R>) {
  return await t.run(async (ctx) => {
    let result: R | undefined;
    let errorMessage: string | null = null;
    try {
      result = await fn(ctx);
    } catch (e) {
      errorMessage = e instanceof Error ? e.message : String(e);
    }
    const m = await ctx.meta.getTransactionMetrics();
    return { result, errorMessage, metrics: { documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used, bytesRead: m.bytesRead.used, documentsWritten: m.documentsWritten.used, functionsScheduled: m.functionsScheduled.used } };
  });
}

describe("M29 bounds at the caps (enforced transaction limits)", () => {
  it(
    "one attention page at the cap (100 in range, 101 present) + M20's re-evaluation page at its cap (50 due transactions) in ONE sweep call",
    async () => {
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy deadlines" }));
      const at = Date.UTC(2026, 9, 11, 12);
      await t.run(async (ctx) => {
        for (let i = 0; i < DEADLINE_SWEEP_PAGE + 1; i++) await insertOpportunity(ctx, userId, { dueAt: at + 3 * DAY, outcome: "manual_review", n: i });
      });
      // 51 not-yet-due fake-pack transactions (the stub's page is 50), each fully evaluated by the re-evaluation page.
      for (let i = 0; i < 51; i++) await seed(t as unknown as T, userId, { outcome: "not_yet_due" });
      vi.setSystemTime(at);
      const { result, errorMessage, metrics } = await measured(t, (ctx) => ctx.runMutation(internal.deadlines.sweep, { now: at }));
      // eslint-disable-next-line no-console
      console.log("[read-budget] deadlines.sweep (attention page 100 + re-evaluation page 50)", JSON.stringify({ ...metrics, errorMessage }));
      expect(errorMessage).toBeNull();
      expect(result).toMatchObject({ scanned: DEADLINE_SWEEP_PAGE, scheduled: DEADLINE_SWEEP_PAGE, reevaluated: 50, continued: true });
      expect(metrics.databaseQueries).toBeLessThan(4_096);
      expect(metrics.documentsRead).toBeLessThan(32_000);
      expect(metrics.bytesRead).toBeLessThan(16 * 1024 * 1024);
      // 100 reminders + the attention page's continuation + the re-evaluation page's continuation (its page was full).
      expect(metrics.functionsScheduled).toBeLessThanOrEqual(DEADLINE_SWEEP_PAGE + 2);
    },
    150_000,
  );

  it(
    "one reminder on an open case with 50 drafts (the per-claim artifact read cap)",
    async () => {
      const t = limitedHarness();
      const { userId, as } = await signedIn(t as unknown as T);
      const { opportunityId } = await seed(t as unknown as T, userId, { due: NOW + 9 * DAY });
      const claimId = await openCaseOn(t as unknown as T, as, opportunityId);
      await t.run(async (ctx) => {
        for (let i = 0; i < 50; i++) {
          await ctx.db.insert("drafts", { claimId, userId, version: i + 1, claimVersion: 1, to: "billing@bank.example", subject: `s${i}`, body: "b" });
        }
      });
      const { result, errorMessage, metrics } = await measured(t, (ctx) => ctx.runMutation(internal.deadlines.remind, { opportunityId }));
      // eslint-disable-next-line no-console
      console.log("[read-budget] deadlines.remind (open case, artifact caps)", JSON.stringify({ ...metrics, errorMessage }));
      expect(errorMessage).toBeNull();
      expect(result).toBe("set");
      expect(metrics.databaseQueries).toBeLessThan(20);
      expect(metrics.documentsRead).toBeLessThan(200);
    },
    60_000,
  );
});
