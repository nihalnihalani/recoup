/**
 * Operator controls and diagnostics (P12, T22): `pauseKind`/`resumeKind`
 * (D79 kill switch) and `backlog` (P12 "no service targets or smoke
 * checks").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { GLOBAL_DAILY_BUDGETS } from "./limits";
import { tryConsumeGlobalBudget } from "./lib/budget";

type T = ReturnType<typeof setup>;

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 21, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function globalUsageCount(t: T, kind: string): Promise<number | null> {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("usage")
      .withIndex("by_user_day_kind", (q) => q.eq("userId", undefined).eq("day", "2026-09-21").eq("kind", kind))
      .first();
    return row?.count ?? null;
  });
}

// ---------------------------------------------------------------------------
// pauseKind / resumeKind (D79)
// ---------------------------------------------------------------------------

describe("ops.pauseKind (D79 kill switch)", () => {
  it("writes today's global usage row to the kind's max", async () => {
    const t = setup();
    const result = await t.mutation(internal.ops.pauseKind, { kind: "market_lookup" });
    expect(result).toEqual({ day: "2026-09-21", kind: "market_lookup", count: GLOBAL_DAILY_BUDGETS.market_lookup.max, max: GLOBAL_DAILY_BUDGETS.market_lookup.max });
    expect(await globalUsageCount(t, "market_lookup")).toBe(GLOBAL_DAILY_BUDGETS.market_lookup.max);
  });

  it("actually blocks further spend through the real budget helper", async () => {
    const t = setup();
    await t.mutation(internal.ops.pauseKind, { kind: "price_check" });
    const granted = await t.run((ctx) => tryConsumeGlobalBudget(ctx, "price_check", GLOBAL_DAILY_BUDGETS.price_check.max, 1, NOW));
    expect(granted).toBe(false);
  });

  it("is idempotent: calling it twice does not double-count", async () => {
    const t = setup();
    await t.mutation(internal.ops.pauseKind, { kind: "drop_email" });
    await t.mutation(internal.ops.pauseKind, { kind: "drop_email" });
    expect(await globalUsageCount(t, "drop_email")).toBe(GLOBAL_DAILY_BUDGETS.drop_email.max);
  });

  it("never lowers usage that is already at or above max", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("usage", { userId: undefined, day: "2026-09-21", kind: "claim_email", count: GLOBAL_DAILY_BUDGETS.claim_email.max }));
    const result = await t.mutation(internal.ops.pauseKind, { kind: "claim_email" });
    expect(result.count).toBe(GLOBAL_DAILY_BUDGETS.claim_email.max);
    expect(await globalUsageCount(t, "claim_email")).toBe(GLOBAL_DAILY_BUDGETS.claim_email.max);
  });

  it("throws ConvexError for a kind that is not a global budget", async () => {
    const t = setup();
    await expect(t.mutation(internal.ops.pauseKind, { kind: "not_a_real_kind" })).rejects.toThrow(ConvexError);
    await expect(t.mutation(internal.ops.pauseKind, { kind: "draft_generate" })).rejects.toThrow(ConvexError); // a per-user-only kind, not global
  });
});

describe("ops.resumeKind (D79)", () => {
  it("clears a paused kind back to zero and restores spend", async () => {
    const t = setup();
    await t.mutation(internal.ops.pauseKind, { kind: "policy_fetch" });
    expect(await globalUsageCount(t, "policy_fetch")).toBe(GLOBAL_DAILY_BUDGETS.policy_fetch.max);

    const result = await t.mutation(internal.ops.resumeKind, { kind: "policy_fetch" });
    expect(result).toEqual({ day: "2026-09-21", kind: "policy_fetch", cleared: true });
    expect(await globalUsageCount(t, "policy_fetch")).toBeNull();

    const granted = await t.run((ctx) => tryConsumeGlobalBudget(ctx, "policy_fetch", GLOBAL_DAILY_BUDGETS.policy_fetch.max, 1, NOW));
    expect(granted).toBe(true);
  });

  it("is a no-op, not an error, when there is nothing to clear", async () => {
    const t = setup();
    const result = await t.mutation(internal.ops.resumeKind, { kind: "inbound_extract" });
    expect(result).toEqual({ day: "2026-09-21", kind: "inbound_extract", cleared: false });
  });

  it("throws ConvexError for an unknown kind", async () => {
    const t = setup();
    await expect(t.mutation(internal.ops.resumeKind, { kind: "bogus" })).rejects.toThrow(ConvexError);
  });
});

// ---------------------------------------------------------------------------
// backlog
// ---------------------------------------------------------------------------

async function insertWatch(
  t: T,
  userId: Id<"users">,
  over: Partial<{
    status: "active" | "paused" | "archived" | "bought";
    nextCheckAt: number;
    marketState: "not_configured" | "queued" | "running" | "success" | "empty_result" | "retryable_failure" | "terminal_failure";
    marketClaimedAt: number;
  }> = {},
): Promise<Id<"watches">> {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "Backlog fixture watch",
      productUrl: `https://backlog.example/p/${Math.random()}`,
      merchantDomain: "backlog.example",
      status: over.status ?? "active",
      nextCheckAt: over.nextCheckAt ?? NOW,
      marketState: over.marketState,
      marketClaimedAt: over.marketClaimedAt,
    }),
  );
}

async function insertItem(t: T, userId: Id<"users">, nextCheckAt: number | undefined): Promise<Id<"items">> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Backlog Store",
      merchantDomain: "backlog.example",
      currency: "USD",
      status: "active",
    });
    return await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: "Backlog fixture item",
      unitCents: 1000,
      qty: 1,
      returned: false,
      nextCheckAt,
    });
  });
}

async function insertProcessedEvent(t: T, status: "received" | "processing" | "succeeded" | "failed" | "needs_review", externalId: string) {
  return await t.run((ctx) => ctx.db.insert("processedEvents", { externalId, kind: "paste", status, attempts: 1 }));
}

async function insertMailLog(t: T, userId: Id<"users">, status: "claimed" | "queued" | "sent" | "failed" | "unknown" | "suppressed", dedupeKey: string) {
  return await t.run((ctx) =>
    ctx.db.insert("mailLog", { userId, dedupeKey, kind: "price_drop", to: "sam@home.example", subject: "x", status }),
  );
}

describe("ops.backlog", () => {
  it("reports all zeros with no truncation on an empty deployment", async () => {
    const t = setup();
    const result = await t.query(internal.ops.backlog, {});
    expect(result.now).toBe(NOW);
    expect(result.dueWatches).toEqual({ count: 0, truncated: false });
    expect(result.dueItems).toEqual({ count: 0, truncated: false });
    expect(result.processedEventsFailed).toEqual({ count: 0, truncated: false });
    expect(result.mailLogQueued).toEqual({ count: 0, truncated: false });
    expect(result.mailLogUnknown).toEqual({ count: 0, truncated: false });
    expect(result.staleMarketRunning).toEqual({ count: 0, truncated: false });
  });

  it("counts only active watches due now or earlier, not paused or not-yet-due ones", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertWatch(t, userId, { status: "active", nextCheckAt: NOW - HOUR }); // due
    await insertWatch(t, userId, { status: "active", nextCheckAt: NOW + HOUR }); // not due yet
    await insertWatch(t, userId, { status: "paused", nextCheckAt: NOW - HOUR }); // paused: never swept

    const result = await t.query(internal.ops.backlog, {});
    expect(result.dueWatches).toEqual({ count: 1, truncated: false });
  });

  it("counts items with no nextCheckAt yet (never checked) as due, alongside overdue ones", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertItem(t, userId, undefined); // never scheduled -> eligible now
    await insertItem(t, userId, NOW - HOUR); // overdue
    await insertItem(t, userId, NOW + HOUR); // not due yet

    const result = await t.query(internal.ops.backlog, {});
    expect(result.dueItems).toEqual({ count: 2, truncated: false });
  });

  it("counts failed processedEvents rows but not other statuses", async () => {
    const t = setup();
    await insertProcessedEvent(t, "failed", "evt-1");
    await insertProcessedEvent(t, "failed", "evt-2");
    await insertProcessedEvent(t, "succeeded", "evt-3");
    await insertProcessedEvent(t, "needs_review", "evt-4");

    const result = await t.query(internal.ops.backlog, {});
    expect(result.processedEventsFailed).toEqual({ count: 2, truncated: false });
  });

  it("counts queued and unknown mailLog rows separately from sent/claimed/failed/suppressed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertMailLog(t, userId, "queued", "dedupe-1");
    await insertMailLog(t, userId, "unknown", "dedupe-2");
    await insertMailLog(t, userId, "sent", "dedupe-3");
    await insertMailLog(t, userId, "claimed", "dedupe-4");
    await insertMailLog(t, userId, "failed", "dedupe-5");
    await insertMailLog(t, userId, "suppressed", "dedupe-6");

    const result = await t.query(internal.ops.backlog, {});
    expect(result.mailLogQueued).toEqual({ count: 1, truncated: false });
    expect(result.mailLogUnknown).toEqual({ count: 1, truncated: false });
  });

  it("counts a watch stuck `running` past the stale threshold, but not a fresh one or a missing claim timestamp is treated as stale", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertWatch(t, userId, { marketState: "running", marketClaimedAt: NOW - 20 * 60_000 }); // stale
    await insertWatch(t, userId, { marketState: "running", marketClaimedAt: NOW - 5 * 60_000 }); // fresh, not stale
    await insertWatch(t, userId, { marketState: "running", marketClaimedAt: undefined }); // no claim timestamp: fail open, count it
    await insertWatch(t, userId, { marketState: "success", marketClaimedAt: NOW - 20 * 60_000 }); // not running at all

    const result = await t.query(internal.ops.backlog, {});
    expect(result.staleMarketRunning).toEqual({ count: 2, truncated: false });
  });

  it("caps every count at scanLimit and reports truncated", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertWatch(t, userId, { status: "active", nextCheckAt: NOW - HOUR });
    await insertWatch(t, userId, { status: "active", nextCheckAt: NOW - HOUR });
    await insertWatch(t, userId, { status: "active", nextCheckAt: NOW - HOUR });

    const result = await t.query(internal.ops.backlog, { scanLimit: 2 });
    expect(result.dueWatches).toEqual({ count: 2, truncated: true });
  });

  it("day boundary: 'day' math aside, backlog always reflects the current wall clock at call time", async () => {
    const t = setup();
    vi.setSystemTime(NOW + DAY);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.now).toBe(NOW + DAY);
  });
});
