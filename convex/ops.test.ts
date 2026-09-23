/**
 * Operator controls and diagnostics (P12, T22): `pauseKind`/`resumeKind`
 * (D79 kill switch) and `backlog` (P12 "no service targets or smoke
 * checks").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { GLOBAL_DAILY_BUDGETS, MARKET_CLAIM_STALE_MS, STUCK_DELETION_AGE_MS } from "./limits";
import { tryConsumeGlobalBudget } from "./lib/budget";
import { FLAG_NAMES, isFlagOn } from "./lib/flags";
import * as opsModule from "./ops";
import { recordRuleEvaluationFailure, staleSourcePacks } from "./ops";

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
    expect(result.retention).toEqual({ rule: "processedEvents", cursorAgeMs: 0, stalled: false });
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

  it("F-T22-2: the stale threshold is exactly limits.ts's shared MARKET_CLAIM_STALE_MS (also market.ts's own reclaim threshold), not a private copy that could drift", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertWatch(t, userId, { marketState: "running", marketClaimedAt: NOW - MARKET_CLAIM_STALE_MS }); // exactly at the threshold: stale (>=)
    await insertWatch(t, userId, { marketState: "running", marketClaimedAt: NOW - MARKET_CLAIM_STALE_MS + 1 }); // 1ms inside it: still fresh

    const result = await t.query(internal.ops.backlog, {});
    expect(result.staleMarketRunning).toEqual({ count: 1, truncated: false });
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

// ---------------------------------------------------------------------------
// retention cursor diagnostic (D112)
// ---------------------------------------------------------------------------

async function insertRetentionRow(t: T, cursor: { step: number; page: string | null }, updatedAt: number) {
  await t.run((ctx) => ctx.db.insert("opsState", { key: "retention", cursor: JSON.stringify(cursor), updatedAt }));
}

describe("ops.backlog: retention cursor diagnostic (D112)", () => {
  it("reports the default 'processedEvents'/age-0/not-stalled shape when retention has never run", async () => {
    const t = setup();
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "processedEvents", cursorAgeMs: 0, stalled: false });
  });

  it("names the step/table the cursor is currently on and reports its age", async () => {
    const t = setup();
    await insertRetentionRow(t, { step: 2, page: "some-continuation-cursor" }, NOW - HOUR);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "priceChecks", cursorAgeMs: HOUR, stalled: false });
  });

  it("is not stalled just because it is idle between cycles (cursor reset to the start), however old", async () => {
    const t = setup();
    // {step:0, page:null} is both "never started" and "just finished a full cycle" -- either way,
    // this is the expected resting state between one day's cron firing and the next, so age alone
    // (even well past RETENTION_STALL_MS) must never flag it.
    await insertRetentionRow(t, { step: 0, page: null }, NOW - 10 * DAY);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "processedEvents", cursorAgeMs: 10 * DAY, stalled: false });
  });

  it("is not stalled mid-cycle when the cursor is merely within the normal daily cadence", async () => {
    const t = setup();
    await insertRetentionRow(t, { step: 4, page: "cursor" }, NOW - 6 * HOUR);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "mailLog", cursorAgeMs: 6 * HOUR, stalled: false });
  });

  it("is stalled when mid-cycle (a page cursor set) and untouched for over 48h -- a likely poison page", async () => {
    const t = setup();
    await insertRetentionRow(t, { step: 5, page: "cursor" }, NOW - 49 * HOUR);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "opsState", cursorAgeMs: 49 * HOUR, stalled: true });
  });

  it("is stalled when mid-cycle at a non-zero step even with no page cursor (just moved to a new step and then froze)", async () => {
    const t = setup();
    await insertRetentionRow(t, { step: 6, page: null }, NOW - 49 * HOUR);
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "users", cursorAgeMs: 49 * HOUR, stalled: true });
  });

  it("falls back to the default cursor (not a crash) when the stored cursor JSON is malformed", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("opsState", { key: "retention", cursor: "not json", updatedAt: NOW - 49 * HOUR }));
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention).toEqual({ rule: "processedEvents", cursorAgeMs: 49 * HOUR, stalled: false });
  });
});

describe("T18.5 (D124 B6): ops.backlog wires in account.stuckDeletions as `deletions`", () => {
  it("before/after: backlog reports a stuck deleting row that stuckDeletions itself also reports [FAILS pre-T18.5 (no `deletions` field)]", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", {
        userId, status: "deleting", requestedAt: NOW - STUCK_DELETION_AGE_MS - 1, attempts: 0,
      }),
    );

    const result = await t.query(internal.ops.backlog, {});
    expect((result as any).deletions).toEqual({ stuck: 1, deletingTotal: 1 });

    const direct = await t.query(internal.account.stuckDeletions, {});
    expect((result as any).deletions).toEqual({ stuck: direct.stuck, deletingTotal: direct.deleting });
  });

  it("a live (non-stuck) deleting row counts toward deletingTotal but not stuck", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 }),
    );
    const result = await t.query(internal.ops.backlog, {});
    expect((result as any).deletions).toEqual({ stuck: 0, deletingTotal: 1 });
  });

  it("reports all zeros on an empty deployment", async () => {
    const t = setup();
    const result = await t.query(internal.ops.backlog, {});
    expect((result as any).deletions).toEqual({ stuck: 0, deletingTotal: 0 });
  });
});

describe("T18.5 addendum (F-T23-3): ops.resetRetentionCursor", () => {
  const RETENTION_KEY = "retention";

  it("with no args, resets an existing cursor to step 0 and returns the previous value", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("opsState", { key: RETENTION_KEY, cursor: JSON.stringify({ step: 3, page: "abc" }), updatedAt: NOW - HOUR }));

    const previous = await t.mutation(internal.ops.resetRetentionCursor, {});
    expect(previous).toEqual({ step: 3, page: "abc" });

    const row = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", RETENTION_KEY)).unique());
    expect(row?.cursor).toBe(JSON.stringify({ step: 0, page: null }));
    expect(row?.updatedAt).toBe(NOW);
  });

  it("with {step: N}, skips only that step (cursor becomes {step:N, page:null}); returns null when no row existed yet", async () => {
    const t = setup();
    expect(await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", RETENTION_KEY)).unique())).toBeNull();

    const previous = await t.mutation(internal.ops.resetRetentionCursor, { step: 2 });
    expect(previous).toBeNull();

    const row = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", RETENTION_KEY)).unique());
    expect(row?.cursor).toBe(JSON.stringify({ step: 2, page: null }));

    // The cycle now resumes from the requested step, confirmed via backlog's own read of the same row.
    const result = await t.query(internal.ops.backlog, {});
    expect(result.retention.rule).toBe("priceChecks"); // RETENTION_STEPS[2]
  });

  it("refuses an out-of-range step", async () => {
    const t = setup();
    await expect(t.mutation(internal.ops.resetRetentionCursor, { step: 999 })).rejects.toThrow(ConvexError);
    await expect(t.mutation(internal.ops.resetRetentionCursor, { step: -1 })).rejects.toThrow(ConvexError);
  });
});

// ===========================================================================
// M1B (contract rev 5 §2.6, §11.1; mission §15 P12, §18 C58)
// ===========================================================================

type LoggedLine = Record<string, unknown>;

function loggedLines(spy: ReturnType<typeof vi.spyOn>, kind: string): LoggedLine[] {
  return (spy.mock.calls as unknown[][])
    .map((call): LoggedLine | null => {
      try {
        return JSON.parse(String(call[0])) as LoggedLine;
      } catch {
        return null;
      }
    })
    .filter((line): line is LoggedLine => line !== null && line.kind === kind);
}

async function flagRows(t: T): Promise<string[]> {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("opsState").take(500);
    return rows.map((r) => r.key).filter((k) => k.startsWith("flag")).sort();
  });
}

describe("M1B: the public API cannot set flags", () => {
  it("every registered function in ops.ts is internal -- setFlag, getFlag and flagAudit included", () => {
    const registered = Object.entries(opsModule).filter(
      ([, fn]) => typeof fn === "function" && ("isQuery" in fn || "isMutation" in fn || "isAction" in fn),
    );
    expect(registered.map(([name]) => name)).toEqual(expect.arrayContaining(["setFlag", "getFlag", "flagAudit", "backlog"]));
    for (const [name, fn] of registered) {
      expect((fn as { isInternal?: boolean }).isInternal, name).toBe(true);
      expect((fn as { isPublic?: boolean }).isPublic, name).toBeUndefined();
    }
  });

  it("setFlag is absent from the generated public api type", () => {
    // Compile-time assertion (checked by `npm run typecheck`): `api.ops.setFlag`
    // does not exist on the public api, so this line must be a type error.
    // @ts-expect-error -- ops.setFlag is internal-only.
    const ref = () => api.ops.setFlag;
    expect(typeof ref).toBe("function");
  });
});

describe("M1B: ops.setFlag", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  it("every flag is OFF by default (getFlag and isFlagOn agree)", async () => {
    const t = setup();
    for (const name of FLAG_NAMES) {
      expect(await t.query(internal.ops.getFlag, { name })).toEqual({ name, on: false, approvalRef: null, updatedAt: null, invalid: false });
      expect(await t.run((ctx) => isFlagOn(ctx, name))).toBe(false);
    }
  });

  it("refuses to enable live_document_extraction without an approvalRef naming a DECISIONS entry: nothing written, refusal logged", async () => {
    const t = setup();
    const attempts: Array<string | undefined> = [undefined, "", "   ", "yes", "approved by the user"];
    for (const approvalRef of attempts) {
      await expect(
        t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef }),
        String(approvalRef),
      ).rejects.toThrow(/approvalRef/);
    }
    expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction"))).toBe(false);
    expect(await flagRows(t)).toEqual([]);

    const refused = loggedLines(spy, "flag_changed");
    expect(refused).toHaveLength(attempts.length);
    for (const line of refused) {
      expect(line).toMatchObject({ flag: "live_document_extraction", from: false, to: true, outcome: "refused", refusal: "approval_ref_required" });
    }
  });

  it("with a DECISIONS approvalRef: ON, the ref stored, one audit row, one applied log line", async () => {
    const t = setup();
    const result = await t.mutation(internal.ops.setFlag, {
      name: "live_document_extraction",
      on: true,
      approvalRef: "  D9001: user approved document processing  ",
      reason: "user data-flow approval recorded",
    });
    expect(result).toEqual({
      name: "live_document_extraction",
      from: false,
      to: true,
      approvalRef: "D9001: user approved document processing",
      auditSeq: 1,
      changed: true,
    });

    expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction"))).toBe(true);
    expect(await t.query(internal.ops.getFlag, { name: "live_document_extraction" })).toEqual({
      name: "live_document_extraction",
      on: true,
      approvalRef: "D9001: user approved document processing",
      updatedAt: NOW,
      invalid: false,
    });
    // Other flags are untouched.
    expect(await t.run((ctx) => isFlagOn(ctx, "live_statement_extraction"))).toBe(false);

    expect(await t.query(internal.ops.flagAudit, { name: "live_document_extraction" })).toEqual([
      {
        seq: 1,
        from: false,
        to: true,
        approvalRef: "D9001: user approved document processing",
        reason: "user data-flow approval recorded",
        at: NOW,
      },
    ]);

    const applied = loggedLines(spy, "flag_changed");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      flag: "live_document_extraction",
      from: false,
      to: true,
      outcome: "applied",
      approvalRef: "D9001: user approved document processing",
      auditSeq: 1,
    });
  });

  it("disabling never needs an approvalRef, clears it, and is audited as the next row", async () => {
    const t = setup();
    await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D9001" });
    vi.setSystemTime(NOW + HOUR);
    const off = await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: false });
    expect(off).toEqual({ name: "live_document_extraction", from: true, to: false, approvalRef: null, auditSeq: 2, changed: true });
    expect(await t.run((ctx) => isFlagOn(ctx, "live_document_extraction"))).toBe(false);
    expect(await t.query(internal.ops.getFlag, { name: "live_document_extraction" })).toMatchObject({ on: false, approvalRef: null, updatedAt: NOW + HOUR });

    const audit = await t.query(internal.ops.flagAudit, { name: "live_document_extraction" });
    expect(audit.map((a) => [a.seq, a.from, a.to, a.approvalRef, a.at])).toEqual([
      [2, true, false, null, NOW + HOUR],
      [1, false, true, "D9001", NOW],
    ]);
  });

  it("every accepted call is audited, a no-op included; flagAudit is newest first and bounded by limit", async () => {
    const t = setup();
    await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D9001" });
    const again = await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D9002" });
    expect(again).toMatchObject({ from: true, to: true, changed: false, auditSeq: 2, approvalRef: "D9002" });
    await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: false });
    // A different flag keeps its own sequence.
    await t.mutation(internal.ops.setFlag, { name: "medical_document_intake", on: false });

    const two = await t.query(internal.ops.flagAudit, { name: "live_document_extraction", limit: 2 });
    expect(two.map((a) => a.seq)).toEqual([3, 2]);
    const medical = await t.query(internal.ops.flagAudit, { name: "medical_document_intake" });
    expect(medical.map((a) => a.seq)).toEqual([1]);
  });

  it("an approval-gated flag stays OFF when its row is hand-edited ON without setFlag (defence in depth)", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("opsState", { key: "flag:live_document_extraction", cursor: JSON.stringify({ on: true }), updatedAt: NOW }));
    expect(await t.query(internal.ops.getFlag, { name: "live_document_extraction" })).toMatchObject({ on: false, invalid: true });
    // setFlag still works on top of the invalid row, and treats it as OFF.
    const result = await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D9001" });
    expect(result).toMatchObject({ from: false, to: true, changed: true });
  });

  it("bounds the reason and strips control characters from it", async () => {
    const t = setup();
    await t.mutation(internal.ops.setFlag, { name: "medical_document_intake", on: false, reason: `line one\nline two ${"x".repeat(2_000)}` });
    const [row] = await t.query(internal.ops.flagAudit, { name: "medical_document_intake" });
    expect(row.reason).not.toContain("\n");
    expect(row.reason!.length).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// Rule-evaluation failure counters (the API M12's recordEvaluation catch path calls)
// ---------------------------------------------------------------------------

describe("M1B: recordRuleEvaluationFailure + backlog.ruleEvaluationFailures", () => {
  let spy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => spy.mockRestore());

  const R02 = { scenarioId: "R02", ruleId: "R02.airline_fare_refund.us_dot", ruleVersion: 1 };
  const R05 = { scenarioId: "R05", ruleId: "R05.mitor_shipment.us_ftc", ruleVersion: 1 };

  it("reports zero failures on an empty deployment", async () => {
    const t = setup();
    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.ruleEvaluationFailures).toEqual({
      windowDays: 7,
      total: 0,
      days: [
        { day: "2026-09-21", count: 0 },
        { day: "2026-09-20", count: 0 },
        { day: "2026-09-19", count: 0 },
        { day: "2026-09-18", count: 0 },
        { day: "2026-09-17", count: 0 },
        { day: "2026-09-16", count: 0 },
        { day: "2026-09-15", count: 0 },
      ],
      byRule: [],
      lastAt: null,
    });
  });

  it("increments today's UTC counter per rule and writes one redacted rule_evaluation_failed line per failure", async () => {
    const t = setup();
    await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R02, now: NOW, error: new Error("boom for ops@example.com sk-abcdefghij1234567890") }));
    await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R02, now: NOW + 1, error: "second" }));
    await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R05, now: NOW + 2, error: new Error("third") }));

    const result = await t.query(internal.ops.backlog, { now: NOW + 3 });
    expect(result.ruleEvaluationFailures.total).toBe(3);
    expect(result.ruleEvaluationFailures.days[0]).toEqual({ day: "2026-09-21", count: 3 });
    expect(result.ruleEvaluationFailures.byRule).toEqual([
      { rule: "R02.airline_fare_refund.us_dot@1", count: 2 },
      { rule: "R05.mitor_shipment.us_ftc@1", count: 1 },
    ]);
    expect(result.ruleEvaluationFailures.lastAt).toBe(NOW + 2);

    const lines = loggedLines(spy, "rule_evaluation_failed");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ scenarioId: "R02", ruleId: "R02.airline_fare_refund.us_dot", ruleVersion: 1, day: "2026-09-21" });
    expect(lines[0].error).toEqual({ name: "Error", message: "boom for example.com sk-***" });
  });

  it("keeps one row per UTC day and reports only the 7 days ending at `now` (never the wall clock)", async () => {
    const t = setup();
    for (const at of [NOW, NOW - DAY, NOW - 6 * DAY, NOW - 7 * DAY]) {
      await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R02, now: at, error: new Error("x") }));
    }
    const rows = await t.run(async (ctx) => (await ctx.db.query("opsState").take(100)).map((r) => r.key).filter((k) => k.startsWith("ruleEvalFailures:")).sort());
    expect(rows).toEqual(["ruleEvalFailures:2026-09-14", "ruleEvalFailures:2026-09-15", "ruleEvalFailures:2026-09-20", "ruleEvalFailures:2026-09-21"]);

    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.ruleEvaluationFailures.total).toBe(3); // 09-14 is outside the window
    expect(result.ruleEvaluationFailures.days.find((d) => d.day === "2026-09-15")).toEqual({ day: "2026-09-15", count: 1 });

    // Asking about a week later: the argument decides, while the wall clock stays at NOW.
    const later = await t.query(internal.ops.backlog, { now: NOW + 7 * DAY });
    expect(later.ruleEvaluationFailures.total).toBe(0);
  });

  it("never throws from a catch path, whatever it is handed, and still counts the failure", async () => {
    const t = setup();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const hostile = [
      { scenarioId: "R02", ruleId: `R02\n${"x".repeat(5_000)}`, ruleVersion: Number.NaN, error: circular },
      { scenarioId: "", ruleId: "", ruleVersion: -1, error: undefined },
      { scenarioId: "R02", ruleId: "R02.x", ruleVersion: 1.5, error: 42 },
    ];
    for (const input of hostile) {
      // Resolves (convex-test maps the helper's void return to null) -- it never rejects.
      await expect(t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...input, now: NOW }))).resolves.toBeNull();
    }
    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.ruleEvaluationFailures.total).toBe(3);
    for (const { rule } of result.ruleEvaluationFailures.byRule) {
      expect(rule.length).toBeLessThanOrEqual(130);
      expect(rule).not.toContain("\n");
    }
  });

  it("an invalid `now` falls back to the mutation clock instead of throwing", async () => {
    const t = setup();
    await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R02, now: Number.NaN, error: "x" }));
    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.ruleEvaluationFailures.days[0]).toEqual({ day: "2026-09-21", count: 1 });
  });

  it("bounds the per-rule breakdown: past 32 distinct rules in one day the rest fold into `other`", async () => {
    const t = setup();
    for (let i = 0; i < 40; i++) {
      await t.run((ctx) => recordRuleEvaluationFailure(ctx, { scenarioId: "R02", ruleId: `R02.rule_${i}`, ruleVersion: 1, now: NOW, error: "x" }));
    }
    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.ruleEvaluationFailures.total).toBe(40);
    expect(result.ruleEvaluationFailures.byRule.length).toBeLessThanOrEqual(33);
    expect(result.ruleEvaluationFailures.byRule.find((r) => r.rule === "other")).toEqual({ rule: "other", count: 8 });
  });

  it("a malformed counter row is treated as zero (read and increment), never a crash", async () => {
    const t = setup();
    await t.run((ctx) => ctx.db.insert("opsState", { key: "ruleEvalFailures:2026-09-21", cursor: "not json", updatedAt: NOW }));
    expect((await t.query(internal.ops.backlog, { now: NOW })).ruleEvaluationFailures.total).toBe(0);
    await t.run((ctx) => recordRuleEvaluationFailure(ctx, { ...R02, now: NOW, error: "x" }));
    expect((await t.query(internal.ops.backlog, { now: NOW })).ruleEvaluationFailures.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Stale-source packs (verification vs refresh windows)
// ---------------------------------------------------------------------------

describe("M1B: staleSourcePacks (pure)", () => {
  // The manifest's R02 shape: refreshDays 30, date-only lastVerifiedAt.
  const R02 = { ruleId: "R02.airline_fare_refund.us_dot", version: 1, refreshDays: 30, sourceIds: ["ecfr-14cfr260", "usc-49-42305"] };
  const VERIFIED = Date.UTC(2026, 8, 23); // "2026-09-23" as UTC midnight
  const WINDOW_END = VERIFIED + 30 * DAY;
  const bothVerified = { "ecfr-14cfr260": { lastVerifiedAt: "2026-09-23" }, "usc-49-42305": { lastVerifiedAt: "2026-09-23" } };

  it("a pack inside its refresh window is not listed", () => {
    expect(staleSourcePacks([R02], bothVerified, VERIFIED + 10 * DAY)).toEqual([]);
  });

  it("within the last 7 days of the window: due_soon (re-verify before it lapses)", () => {
    expect(staleSourcePacks([R02], bothVerified, WINDOW_END - 3 * DAY)).toEqual([
      { ruleId: R02.ruleId, version: 1, refreshDays: 30, status: "due_soon", windowEndsAt: WINDOW_END, sourceIds: ["ecfr-14cfr260", "usc-49-42305"] },
    ]);
  });

  it("exactly at the window end it is still due_soon; one ms later it is stale", () => {
    expect(staleSourcePacks([R02], bothVerified, WINDOW_END)[0].status).toBe("due_soon");
    expect(staleSourcePacks([R02], bothVerified, WINDOW_END + 1)[0]).toMatchObject({ status: "stale", windowEndsAt: WINDOW_END });
  });

  it("the oldest source governs, and only the lapsed sources are named", () => {
    const mixed = { "ecfr-14cfr260": { lastVerifiedAt: "2026-08-01" }, "usc-49-42305": { lastVerifiedAt: Date.UTC(2026, 8, 20) } };
    const [pack] = staleSourcePacks([R02], mixed, Date.UTC(2026, 8, 21, 12));
    expect(pack).toEqual({
      ruleId: R02.ruleId, version: 1, refreshDays: 30, status: "stale",
      windowEndsAt: Date.UTC(2026, 7, 1) + 30 * DAY, sourceIds: ["ecfr-14cfr260"],
    });
  });

  it("a source with no verification record, or an unparsable date, is never_verified (README rule 8)", () => {
    const [missing] = staleSourcePacks([R02], { "ecfr-14cfr260": { lastVerifiedAt: "2026-09-23" } }, VERIFIED + DAY);
    expect(missing).toMatchObject({ status: "never_verified", sourceIds: ["usc-49-42305"] });
    const [garbled] = staleSourcePacks([R02], { ...bothVerified, "usc-49-42305": { lastVerifiedAt: "last tuesday" } }, VERIFIED + DAY);
    expect(garbled).toMatchObject({ status: "never_verified", sourceIds: ["usc-49-42305"] });
  });

  it("a pack with no usable refresh window cannot be shown fresh: stale", () => {
    for (const refreshDays of [0, -5, Number.NaN]) {
      expect(staleSourcePacks([{ ...R02, refreshDays }], bothVerified, VERIFIED + DAY)[0]?.status, String(refreshDays)).toBe("stale");
    }
  });

  it("orders the most urgent first: never_verified, stale, due_soon", () => {
    const packs = [
      { ruleId: "A", version: 1, refreshDays: 30, sourceIds: ["fresh-ish"] },
      { ruleId: "B", version: 1, refreshDays: 30, sourceIds: ["old"] },
      { ruleId: "C", version: 1, refreshDays: 30, sourceIds: ["missing"] },
    ];
    const verification = { "fresh-ish": { lastVerifiedAt: VERIFIED - 25 * DAY }, old: { lastVerifiedAt: VERIFIED - 60 * DAY } };
    expect(staleSourcePacks(packs, verification, VERIFIED).map((p) => [p.ruleId, p.status])).toEqual([
      ["C", "never_verified"],
      ["B", "stale"],
      ["A", "due_soon"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// backlog: coarse `now`, flags, stale sources, extraction, orphan sweep
// ---------------------------------------------------------------------------

async function insertEvidence(t: T, userId: Id<"users">, extractionStatus: Doc<"evidence">["extractionStatus"], n = 1) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("evidence", {
        userId, kind: "upload", docType: "unknown", sourceChannel: "upload", provenance: "user_uploaded",
        contentHash: `${extractionStatus}-${i}`, receivedAt: NOW, extractionStatus, extractionAttempts: 0, retention: "active",
      });
    }
  });
}

describe("M1B: ops.backlog additions", () => {
  it("takes `now` as an argument: it wins over the wall clock, and asOf is that instant floored to the hour", async () => {
    const t = setup();
    const asked = NOW - 3 * DAY + 17 * 60_000 + 5_000;
    const result = await t.query(internal.ops.backlog, { now: asked });
    expect(result.now).toBe(asked);
    expect(result.asOf).toBe(NOW - 3 * DAY);
  });

  it("refuses a non-finite `now`", async () => {
    const t = setup();
    await expect(t.query(internal.ops.backlog, { now: Number.NaN })).rejects.toThrow(ConvexError);
    await expect(t.query(internal.ops.backlog, { now: Number.POSITIVE_INFINITY })).rejects.toThrow(ConvexError);
  });

  it("reports every flag's effective state and approvalRef: all OFF by default, then the enabled one with its reference", async () => {
    const t = setup();
    const before = await t.query(internal.ops.backlog, { now: NOW });
    expect(before.flags).toEqual(FLAG_NAMES.map((name) => ({ name, on: false, approvalRef: null, updatedAt: null, invalid: false })));

    await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D9001" });
    const after = await t.query(internal.ops.backlog, { now: NOW });
    expect(after.flags.find((f) => f.name === "live_document_extraction")).toEqual({
      name: "live_document_extraction", on: true, approvalRef: "D9001", updatedAt: NOW, invalid: false,
    });
  });

  it("stale sources (M29): wired to the production registry + verification.ts; R01 v1 has no refresh window, so nothing is checked and it says so", async () => {
    const t = setup();
    const result = await t.query(internal.ops.backlog, { now: NOW + 42 * 60_000 });
    expect(result.staleSources).toEqual({
      asOf: NOW, inputsWired: true, checkedPacks: 0, packs: [], withoutRefreshWindow: ["R01.retail_price_adjustment@v1"],
    });
  });

  it("counts awaiting_doc_type and pending/failed extraction, bounded by scanLimit", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await insertEvidence(t, userId, "awaiting_doc_type", 3);
    await insertEvidence(t, userId, "queued", 2);
    await insertEvidence(t, userId, "running", 1);
    await insertEvidence(t, userId, "failed", 1);
    await insertEvidence(t, userId, "succeeded", 4);
    await insertEvidence(t, userId, "store_only", 2);

    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.extraction).toEqual({
      awaitingDocType: { count: 3, truncated: false },
      queued: { count: 2, truncated: false },
      running: { count: 1, truncated: false },
      failed: { count: 1, truncated: false },
    });
    const capped = await t.query(internal.ops.backlog, { now: NOW, scanLimit: 2 });
    expect(capped.extraction.awaitingDocType).toEqual({ count: 2, truncated: true });
  });

  it("reports the orphan sweep's cursor age: null before its first run, then the age of its opsState row", async () => {
    const t = setup();
    expect((await t.query(internal.ops.backlog, { now: NOW })).orphanSweep).toEqual({ ageMs: null });
    await t.run((ctx) => ctx.db.insert("opsState", { key: "orphanSweep", cursor: "anything", updatedAt: NOW - 5 * HOUR }));
    expect((await t.query(internal.ops.backlog, { now: NOW })).orphanSweep).toEqual({ ageMs: 5 * HOUR });
  });

  it("reports the evidence/evaluation retention sweep's cursor age the same way (M14 key `retentionRecovery`)", async () => {
    const t = setup();
    expect((await t.query(internal.ops.backlog, { now: NOW })).recoveryRetention).toEqual({ ageMs: null });
    await t.run((ctx) =>
      ctx.db.insert("opsState", { key: "retentionRecovery", cursor: JSON.stringify({ step: 1, page: "p", startedAt: NOW - DAY }), updatedAt: NOW - 30 * 60_000 }),
    );
    const result = await t.query(internal.ops.backlog, { now: NOW });
    expect(result.recoveryRetention).toEqual({ ageMs: 30 * 60_000 });
    expect(result.orphanSweep).toEqual({ ageMs: null }); // independent rows
  });
});
