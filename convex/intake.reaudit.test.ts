/// <reference types="vite/client" />
/**
 * P01–P12 re-audit, batch 2 (intake; D244):
 *  - P07-W1: the hourly `intake.retryFailed` used to read up to 400 whole `processedEvents` rows (payload included)
 *    in ONE mutation. About 93 maximum-size CJK rows pass the 16 MiB read limit, so the cron threw every hour and
 *    stopped retrying for every user. Each pass now reads byte-safe pages of `PROCESSED_EVENTS_PAGE` rows, one page per
 *    mutation.
 *  - P07-SK-1: the budget-paused pass read the newest 300 `needs_review` rows of EVERY kind and filtered for pauses
 *    afterwards, so 300 newer ordinary rows starved a paused row forever. It now reads only paused rows, through an
 *    index, oldest pause first, and re-stamps rows skipped for the per-user cap so every user rotates to the front.
 *  - P07-W4 (the intake half of P12-W2): `needsAttention` read 50 + 50 whole rows and threw on maximum-size CJK rows.
 *
 * Fixtures are synthetic. `'語'` is 3 bytes in UTF-8, so one payload of `'語'.repeat(60_000)` is about 180 KB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { BUDGET_PAUSED_SUMMARY, PER_USER_BUDGET_PAUSED_SUMMARY } from "./intake";

const modules = import.meta.glob("./**/*.*s");

// `retryFailed` schedules `processEvent`, which would call OpenAI. Fake timers keep convex-test from running it (D31).
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Real Convex transaction limits (the options-object form; see readBudget.test.ts for why `setup()` cannot do this). */
function limited() {
  return convexTest({ schema, modules, transactionLimits: true });
}
type T = ReturnType<typeof limited>;

const BIG = "語".repeat(60_000);
/** Seeding stays under the write limit too: this many maximum-size rows per `t.run`. */
const SEED_BATCH = 20;

async function user(t: T, name: string): Promise<Id<"users">> {
  return await t.run((ctx) => ctx.db.insert("users", { name, email: `${name.toLowerCase()}@x.example` }));
}

type Seed = Partial<Pick<Doc<"processedEvents">, "status" | "summary" | "attempts" | "processingStartedAt">>;

/** Inserts `count` intake rows for `userId`, oldest first, each carrying a maximum-size payload unless `small`. */
async function seedRows(t: T, userId: Id<"users">, prefix: string, count: number, seed: Seed, small = false): Promise<Id<"processedEvents">[]> {
  const ids: Id<"processedEvents">[] = [];
  for (let start = 0; start < count; start += SEED_BATCH) {
    const batch = await t.run(async (ctx) => {
      const out: Id<"processedEvents">[] = [];
      for (let i = start; i < Math.min(count, start + SEED_BATCH); i++) {
        out.push(
          await ctx.db.insert("processedEvents", {
            externalId: `${prefix}-${i}`,
            kind: "agentmail.message.received",
            status: "needs_review",
            attempts: 0,
            userId,
            route: "intake",
            payload: { messageId: `${prefix}-msg-${i}`, subject: "Your order", text: small ? "t" : BIG, from: "f@x.example" },
            ...seed,
          }),
        );
      }
      return out;
    });
    ids.push(...batch);
  }
  return ids;
}

async function statusOf(t: T, id: Id<"processedEvents">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

describe("P07-W1: retryFailed stays under the 16 MiB read limit", () => {
  it("300 needs_review + 50 failed + 50 processing maximum-size CJK rows: the tick completes and the failed rows are retried", async () => {
    const t = limited();
    const a = await user(t, "A");
    const failed = await seedRows(t, a, "failed", 50, { status: "failed", attempts: 1 });
    // Stuck for a day: the processing pass turns them `failed` and the failed pass sees them on a later tick.
    await seedRows(t, a, "stuck", 50, { status: "processing", attempts: 1, processingStartedAt: Date.now() - 86_400_000 });
    await seedRows(t, a, "order", 300, { status: "needs_review", summary: "Order from Acme recorded." });

    const res = await t.action(internal.intake.retryFailed, {});
    expect(res).toEqual({ unstuck: 50, retried: 50 });
    for (const id of failed) expect((await statusOf(t, id)).status).toBe("received");

    // The next tick reaches the 50 rows the first one unstuck.
    expect(await t.action(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 50 });
  });
});

describe("P07-SK-1: budget-paused rows cannot starve behind ordinary needs_review rows", () => {
  /** Pauses rows the way the real writers do: `replies.classify`'s global or per-user refusal on a `processing` row. */
  async function pause(t: T, ids: Id<"processedEvents">[], perUser: boolean) {
    for (const processedEventId of ids) {
      await t.mutation(perUser ? internal.intake.pauseForUserBudget : internal.intake.pauseForBudget, { processedEventId });
    }
  }

  it("1 paused row for A, then 300 newer ordinary needs_review rows for B: one tick moves A's row to received and schedules processEvent", async () => {
    const t = limited();
    const a = await user(t, "A");
    const b = await user(t, "B");
    const [paused] = await seedRows(t, a, "paused", 1, { status: "processing" }, true);
    await pause(t, [paused], false);
    vi.advanceTimersByTime(60_000);
    await seedRows(t, b, "order", 300, { status: "needs_review", summary: "Order from Acme recorded." }, true);
    vi.advanceTimersByTime(60_000);

    const res = await t.action(internal.intake.retryFailed, {});
    expect(res.retried).toBe(1);
    const row = await statusOf(t, paused);
    expect(row.status).toBe("received");
    expect(row.summary).toBeUndefined();
    expect(row.attempts).toBe(0); // Invariant 10: a budget refusal never costs an attempt
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.includes("processEvent")).map((s) => s.args[0])).toEqual([{ processedEventId: paused }]);
  });

  it("legacy: a paused row written before pausedAt existed is still found behind 300 newer ordinary rows", async () => {
    const t = limited();
    const a = await user(t, "A");
    const [legacy] = await seedRows(t, a, "legacy", 1, { status: "needs_review", summary: BUDGET_PAUSED_SUMMARY }, true);
    await seedRows(t, a, "order", 300, { status: "needs_review", summary: "Order from Acme recorded." }, true);
    expect((await t.action(internal.intake.retryFailed, {})).retried).toBe(1);
    expect((await statusOf(t, legacy)).status).toBe("received");
  });

  it("B has 400 older paused rows, A has 1 newer one: A is retried within 2 ticks (rotation), and B keeps its share of 5 a tick", async () => {
    const t = limited();
    const a = await user(t, "A");
    const b = await user(t, "B");
    const flood = await seedRows(t, b, "flood", 400, { status: "processing" }, true);
    await pause(t, flood, true);
    vi.advanceTimersByTime(60_000);
    const [victim] = await seedRows(t, a, "victim", 1, { status: "processing" }, true);
    await pause(t, [victim], true);
    vi.advanceTimersByTime(60_000);

    const retriedB = async () => (await Promise.all(flood.map((id) => statusOf(t, id)))).filter((r) => r.status === "received").length;
    let ticks = 0;
    while ((await statusOf(t, victim)).status !== "received" && ticks < 2) {
      await t.action(internal.intake.retryFailed, {});
      ticks++;
      // `vi.setSystemTime` (not `vi.advanceTimersByTime`): the retried rows above just scheduled
      // `processEvent` at delay 0, and `advanceTimersByTime` would run the fake-timer queue and fire it for
      // real (hitting OpenAI, unset in this test env, which would flip the row back to `failed` and corrupt
      // `retriedB` below). Moving the mocked clock directly changes what the next tick's `Date.now()`/`before`
      // reads without touching the scheduler queue, matching D31's "fake timers keep convex-test from running
      // it" as long as nothing explicitly advances the timer queue itself.
      vi.setSystemTime(Date.now() + 3_600_000);
    }
    expect((await statusOf(t, victim)).status).toBe("received");
    expect(ticks).toBeLessThanOrEqual(2); // 400 rows > one tick's 300-row scan: rotation is what reaches A
    expect(await retriedB()).toBe(5 * ticks);
  });

  it("every pause writer stamps pausedAt: beginEvent, pauseForBudget and pauseForUserBudget; a retry clears it", async () => {
    const t = limited();
    const a = await user(t, "A");
    const [x, y] = await seedRows(t, a, "p", 2, { status: "processing" }, true);
    await pause(t, [x], false);
    await pause(t, [y], true);
    expect((await statusOf(t, x)).pausedAt).toBe(Date.now());
    expect((await statusOf(t, y)).pausedAt).toBe(Date.now());

    const [z] = await seedRows(t, a, "q", 1, { status: "received" }, true);
    const today = new Date().toISOString().slice(0, 10);
    await t.run((ctx) => ctx.db.insert("usage", { userId: a, day: today, kind: "inbound_extract", count: 1_000_000 }));
    expect(await t.mutation(internal.intake.beginEvent, { processedEventId: z })).toBeNull();
    const paused = await statusOf(t, z);
    expect(paused.summary).toBe(PER_USER_BUDGET_PAUSED_SUMMARY);
    expect(paused.pausedAt).toBe(Date.now());

    // Same instant as the tick's own `before` cutoff on purpose (millisecond-granular `Date.now()`, no time
    // advanced between the pauses above and the tick below): `retryPausedPage`'s `lte` comparison must still
    // read a row paused in the same millisecond the tick starts, not strand it a whole hour.
    await t.action(internal.intake.retryFailed, {});
    for (const id of [x, y, z]) expect((await statusOf(t, id)).pausedAt).toBeUndefined();
  });
});

describe("P07-W4: needsAttention stays under the 16 MiB read limit", () => {
  it("50 failed + 50 needs_review maximum-size CJK rows: the list returns (newest 25 of each) without throwing", async () => {
    const t = limited();
    const a = await user(t, "A");
    await seedRows(t, a, "failed", 50, { status: "failed", attempts: 5 });
    await seedRows(t, a, "review", 50, { status: "needs_review", summary: "Order from Acme recorded." });
    const as = t.withIdentity({ subject: `${a}|session` });
    const rows = await as.query(api.intake.needsAttention, {});
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(25);
    expect(rows.every((r) => !("payload" in r) && !("pausedAt" in r))).toBe(true);
  });
});
