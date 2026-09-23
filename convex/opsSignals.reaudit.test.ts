/// <reference types="vite/client" />
/**
 * P01–P12 re-audit, batch B (D244) — operator controls and signals:
 *   - P12-W4: a durable pause (it outlives UTC midnight until `resumeKind`); `offers.find` and `drafts.generate` draw
 *     on global switches, so they can be paused; the RUNBOOK's "stop everything" loop names every kind;
 *   - P12-W7: `backlog.budgets`; one `budget_exhausted` line per refused global charge; `notification_failed` /
 *     `notification_stalled` lines from the drop-alert send path;
 *   - P12-W2: `backlog.processedEventsFailed` reads a small page, so 300 failed max-size emails cannot make the
 *     diagnostic throw "Read too much data";
 *   - P09-SK-2: `backlog.deletions.deletedWithFailures`;
 *   - P12-S-4: `migrations.linkLegacyPurchases` writes one `migration_progress` line per page; backlog shows its cursor;
 *   - P03-SK-1: the market-lookup monthly cap bounds the plan's credits.
 * Every named test fails on 20a7c03 (before this change). Expected values are hand-written.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXTRACT = vi.hoisted(() => vi.fn());
vi.mock("./lib/ai", async (importOriginal) => ({ ...(await importOriginal<typeof import("./lib/ai")>()), extract: EXTRACT }));

import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { setup, signedIn } from "./test.setup";
import { tryConsumeGlobalBudget, takeGlobalBudget } from "./lib/budget";
import { GLOBAL_DAILY_BUDGETS, GLOBAL_MONTHLY_BUDGETS, MARKET_CREDITS_PER_LOOKUP, MARKET_PLAN_MONTHLY_CREDITS } from "./limits";
import { PAYLOAD_ROWS_SCAN_CAP } from "./ops";
import { applyDropOutcome, DROP_SUBJECT } from "./notify";
import { applySendOutcome, BACKOFF_MS } from "./drafts";
import { FIND_MARKER } from "./lib/offerMatch";
import { REPO_ROOT } from "./testing/ruleFixtures.loader";

const DAY = 86_400_000;

/** The `.message` of a promise's rejection (F2: avoids the union-type noise of `.catch((e) => e as Error)`). */
async function rejectionMessage(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected the promise to reject");
}

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  vi.useRealTimers();
  EXTRACT.mockReset();
});
/** The structured `logEvent` lines of one kind written so far. */
const lines = (kind: string) =>
  (logSpy.mock.calls as unknown[][])
    .map((c: unknown[]) => (typeof c[0] === "string" ? c[0] : ""))
    .filter((l: string) => l.startsWith("{"))
    .map((l: string) => JSON.parse(l) as Record<string, unknown>)
    .filter((l: Record<string, unknown>) => l.kind === kind);

describe("P12-W4: a durable pause, and every paid path can be paused", () => {
  it("claim_email paused at 23:50 UTC stays refused at 00:01 the next day, until resumeKind", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 23, 23, 50));
    const t = setup();
    await t.mutation(internal.ops.pauseKind, { kind: "claim_email" });
    vi.setSystemTime(Date.UTC(2026, 8, 24, 0, 1));
    const max = GLOBAL_DAILY_BUDGETS.claim_email.max;
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "claim_email", max, 1, Date.now()))).toBe(false);
    expect(await t.run((ctx) => takeGlobalBudget(ctx, "claim_email", 5, Date.now()))).toBe(0);
    await t.mutation(internal.ops.resumeKind, { kind: "claim_email" });
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "claim_email", max, 1, Date.now()))).toBe(true);
  });

  it("offers.find is refused while offer_search is paused: no search scheduled, no marker written", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const watchId = await t.run((ctx) => ctx.db.insert("watches", {
      userId, name: "Acme Down Jacket", productUrl: "https://www.acme.example/p/down-jacket", merchantDomain: "acme.example",
      status: "active", nextCheckAt: Date.now() + 3_600_000, currency: "USD", lastCents: 9_900,
    }));
    await t.mutation(internal.ops.pauseKind, { kind: "offer_search" });
    const offerMessage = await rejectionMessage(as.mutation(api.offers.find, { watchId }));
    expect(offerMessage).toMatch(/searches for other stores/);
    // F2 (D266 audit): an operator pause is durable -- it does not lift at midnight -- so the copy must not claim it does.
    expect(offerMessage).not.toMatch(/tomorrow/i);
    expect(offerMessage).not.toMatch(/midnight/i);
    const offers = await t.run((ctx) => ctx.db.query("offers").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect());
    expect(offers.filter((o) => o.storeDomain === FIND_MARKER)).toEqual([]);
    expect((await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((f) => f.name.includes("offers"))).toEqual([]);
  });

  it("drafts.generate is refused while draft_generate is paused, before the model is called (F2: never says tomorrow/midnight)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: Date.now() - DAY, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
      return await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "detected", token: "PAUSE1", version: 1 });
    });
    await t.mutation(internal.ops.pauseKind, { kind: "draft_generate" });
    const draftMessage = await rejectionMessage(as.action(api.drafts.generate, { claimId }));
    expect(draftMessage).toMatch(/writing drafts/);
    // F2 (D266 audit): a durable operator pause (P12-W4) does not reset at midnight UTC -- only `ops.resumeKind`
    // lifts it -- so the copy `consumeGlobalBudget` throws must not promise a reset time nobody controls.
    expect(draftMessage).not.toMatch(/tomorrow/i);
    expect(draftMessage).not.toMatch(/midnight/i);
    expect(EXTRACT).not.toHaveBeenCalled();
    expect(await t.run((ctx) => ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect())).toEqual([]);

    // The status query the frontend banner reads reports the same reason.
    const status = await as.query(api.budget.status, { now: Date.now() });
    const kind = status.kinds.find((k) => k.kind === "draft_generate");
    expect(kind).toMatchObject({ paused: true, pauseReason: "operator" });
  });

  it("F2: an ordinary cap (not an operator pause) still reports pauseReason 'cap', not 'operator'", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    vi.setSystemTime(Date.UTC(2026, 8, 24, 12));
    await t.run((ctx) =>
      ctx.db.insert("usage", { userId: undefined, day: "2026-09-24", kind: "market_lookup", count: GLOBAL_DAILY_BUDGETS.market_lookup.max }),
    );
    const status = await as.query(api.budget.status, { now: Date.now() });
    const kind = status.kinds.find((k) => k.kind === "market_lookup");
    expect(kind).toMatchObject({ paused: true, pauseReason: "cap" });
  });

  it("the RUNBOOK §1 'stop everything' loop names exactly the GLOBAL_DAILY_BUDGETS kinds, and its table lists each", () => {
    const runbook = readFileSync(path.join(REPO_ROOT, "docs/ops/RUNBOOK.md"), "utf8");
    const loop = /for k in ([a-z_ ]+); do\s+npx convex run ops:pauseKind/.exec(runbook);
    expect(loop).not.toBeNull();
    expect(new Set(loop![1].trim().split(/\s+/))).toEqual(new Set(Object.keys(GLOBAL_DAILY_BUDGETS)));
    for (const kind of Object.keys(GLOBAL_DAILY_BUDGETS)) expect(runbook, kind).toContain(`| \`${kind}\` |`);
  });
});

describe("P12-W7: budgets and mail state are visible to the operator", () => {
  it("backlog.budgets lists every switch with used/max/paused; pausing price_check shows paused, durably", async () => {
    const t = setup();
    const now = Date.UTC(2026, 8, 23, 12);
    await t.run((ctx) => tryConsumeGlobalBudget(ctx, "policy_fetch", GLOBAL_DAILY_BUDGETS.policy_fetch.max, 3, now));
    let b = (await t.query(internal.ops.backlog, { now })).budgets;
    expect(b.map((x) => x.kind)).toEqual(Object.keys(GLOBAL_DAILY_BUDGETS));
    expect(b.find((x) => x.kind === "policy_fetch")).toEqual({ kind: "policy_fetch", used: 3, max: GLOBAL_DAILY_BUDGETS.policy_fetch.max, paused: false });
    expect(b.find((x) => x.kind === "market_lookup")).toMatchObject({ monthUsed: 0, monthMax: GLOBAL_MONTHLY_BUDGETS.market_lookup!.max });
    await t.mutation(internal.ops.pauseKind, { kind: "price_check" });
    b = (await t.query(internal.ops.backlog, { now: now + 2 * DAY })).budgets;
    expect(b.find((x) => x.kind === "price_check")).toMatchObject({ paused: true });
  });

  it("a refused global charge writes exactly one budget_exhausted line (paused and spent)", async () => {
    const t = setup();
    const now = Date.UTC(2026, 8, 23, 12);
    await t.mutation(internal.ops.pauseKind, { kind: "drop_email" });
    logSpy.mockClear();
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "drop_email", GLOBAL_DAILY_BUDGETS.drop_email.max, 1, now))).toBe(false);
    expect(lines("budget_exhausted")).toMatchObject([{ kind: "budget_exhausted", reason: "paused" }]);
    logSpy.mockClear();
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "claim_email", 1, 2, now))).toBe(false);
    expect(lines("budget_exhausted")).toMatchObject([{ reason: "spent" }]);
    logSpy.mockClear();
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "claim_email", 5, 1, now))).toBe(true);
    expect(lines("budget_exhausted")).toEqual([]);
  });

  it("a bounced drop alert writes one notification_failed line; an exhausted reconcile one notification_stalled", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const row = (over: Record<string, unknown>) => t.run((ctx) => ctx.db.insert("mailLog", {
      userId, dedupeKey: `d:${Math.random()}`, kind: "price_drop", to: "x@example.com", subject: DROP_SUBJECT, status: "queued",
      cents: 1_000, outboundId: "outbound-x" as never, attempt: 0, nextCheckAt: Date.now() + 1_000, lastCheckedAt: Date.now(), ...over,
    }));
    const bounced = await row({});
    logSpy.mockClear();
    await t.run((ctx) => applyDropOutcome(ctx, bounced, 0, { status: "bounced", agentmailMessageId: "msg-1", errorMessage: "hard bounce" }));
    expect(lines("notification_failed")).toMatchObject([{ channel: "drop_alert", stage: "delivery", providerStatus: "bounced" }]);
    const stuck = await row({ attempt: BACKOFF_MS.length });
    logSpy.mockClear();
    await t.run((ctx) => applyDropOutcome(ctx, stuck, BACKOFF_MS.length, { status: "pending", agentmailMessageId: null, errorMessage: null }));
    expect(lines("notification_stalled")).toMatchObject([{ channel: "drop_alert", stage: "reconcile_exhausted" }]);
  });
});

describe("P12-W7: claim emails too", () => {
  it("a bounced claim email writes one notification_failed line; an exhausted reconcile one notification_stalled, once", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const draftFor = async (token: string) => t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: Date.now() - DAY, currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
      const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "queued", token, version: 1 });
      return await ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "help@acme.example", subject: "s", body: "b", approvedAt: Date.now(), outboundId: `ob-${token}` as never });
    });
    const bounced = await draftFor("CLMA01");
    logSpy.mockClear();
    await t.run((ctx) => applySendOutcome(ctx, bounced, 0, { status: "bounced", agentmailMessageId: "m-1", threadId: null, errorMessage: "hard bounce" }, false));
    expect(lines("notification_failed")).toMatchObject([{ channel: "claim_email", stage: "delivery", providerStatus: "bounced" }]);
    const stuck = await draftFor("CLMA02");
    logSpy.mockClear();
    const pending = { status: "pending", agentmailMessageId: null, threadId: null, errorMessage: null };
    await t.run((ctx) => applySendOutcome(ctx, stuck, BACKOFF_MS.length, pending, false));
    await t.run((ctx) => applySendOutcome(ctx, stuck, BACKOFF_MS.length, pending, false));
    expect(lines("notification_stalled")).toMatchObject([{ channel: "claim_email", stage: "reconcile_exhausted" }]);
  });
});

describe("P09-SK-2: the final deletion outcome reaches the operator", () => {
  it("backlog.deletions.deletedWithFailures counts deleted tombstones with inboxDeleted:false or mailDataPurged:false", async () => {
    const t = setup();
    const now = Date.UTC(2026, 8, 23, 12);
    await t.run(async (ctx) => {
      const u = async (name: string) => ctx.db.insert("users", { name });
      await ctx.db.insert("accountState", { userId: await u("a"), status: "deleted", requestedAt: now - DAY, attempts: 0, inboxDeleted: false, mailDataPurged: true });
      await ctx.db.insert("accountState", { userId: await u("b"), status: "deleted", requestedAt: now - DAY, attempts: 0, inboxDeleted: true, mailDataPurged: false });
      await ctx.db.insert("accountState", { userId: await u("c"), status: "deleted", requestedAt: now - DAY, attempts: 0, inboxDeleted: true, mailDataPurged: true });
    });
    expect((await t.query(internal.ops.backlog, { now })).deletions.deletedWithFailures).toEqual({ count: 2, truncated: false });
  });
});

describe("P12-S-4: the Mission-2 backfill is observable", () => {
  it("linkLegacyPurchases writes one migration_progress line per page; backlog shows its cursor", async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 8, 23, 12);
    vi.setSystemTime(now);
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 21; i++) {
        await ctx.db.insert("purchases", { userId, merchant: `S${i}`, merchantDomain: `s${i}.example`, purchasedAt: now - DAY, currency: "USD", status: "active" });
      }
    });
    expect((await t.query(internal.ops.backlog, { now })).migrations.linkLegacyPurchases).toEqual({ ageMs: null, inProgress: false });
    logSpy.mockClear();
    expect(await t.mutation(internal.migrations.linkLegacyPurchases, { chain: false })).toMatchObject({ done: false });
    expect(lines("migration_progress")).toMatchObject([{ migration: "linkLegacyPurchases", pageRows: 20, done: false }]);
    expect((await t.query(internal.ops.backlog, { now: now + 60_000 })).migrations.linkLegacyPurchases).toEqual({ ageMs: 60_000, inProgress: true });
    expect(await t.mutation(internal.migrations.linkLegacyPurchases, { chain: false })).toMatchObject({ done: true });
    expect(lines("migration_progress")).toHaveLength(2);
    expect((await t.query(internal.ops.backlog, { now })).migrations.linkLegacyPurchases.inProgress).toBe(false);
  });
});

describe("P03-SK-1: the market-lookup budget bounds the plan's MONTHLY credits", () => {
  it("monthly cap × credits per lookup ≤ the plan; the literal in limits.ts equals floor(plan / credits per lookup)", () => {
    const monthly = GLOBAL_MONTHLY_BUDGETS.market_lookup!.max;
    expect(monthly * MARKET_CREDITS_PER_LOOKUP).toBeLessThanOrEqual(MARKET_PLAN_MONTHLY_CREDITS);
    expect(monthly).toBe(Math.floor(MARKET_PLAN_MONTHLY_CREDITS / MARKET_CREDITS_PER_LOOKUP));
  });

  it("the (N+1)th lookup in a calendar month is refused on a fresh day; the next month starts again", async () => {
    const t = setup();
    const monthly = GLOBAL_MONTHLY_BUDGETS.market_lookup!.max;
    const daily = GLOBAL_DAILY_BUDGETS.market_lookup.max;
    let granted = 0;
    for (let d = 0; granted < monthly; d++) {
      const at = Date.UTC(2026, 9, 1 + d, 12);
      granted += await t.run((ctx) => takeGlobalBudget(ctx, "market_lookup", daily, at));
    }
    expect(granted).toBe(monthly);
    const late = Date.UTC(2026, 9, 28, 12); // a day with nothing spent: only the month is full
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "market_lookup", daily, 1, late))).toBe(false);
    expect(await t.run((ctx) => tryConsumeGlobalBudget(ctx, "market_lookup", daily, 1, Date.UTC(2026, 10, 1, 12)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P12-W2 at its size: 300 failed max-size inbound emails (enforced transaction limits).
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

describe("P12-W2: the backlog survives the incident it exists for", () => {
  it(
    "300 failed processedEvents with a 60,000-char payload each → processedEventsFailed truncated, no read-limit error",
    async () => {
      const t = limitedHarness();
      const text = "x".repeat(60_000);
      for (let b = 0; b < 6; b++) {
        await t.run(async (ctx) => {
          for (let i = 0; i < 50; i++) {
            await ctx.db.insert("processedEvents", { externalId: `e${b}-${i}`, kind: "message.received", status: "failed", attempts: 3, payload: { text } });
          }
        });
      }
      const { result, errorMessage, metrics } = await t.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof internal.ops.backlog>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(internal.ops.backlog, { now: Date.UTC(2026, 8, 23, 12) });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const m = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics: { bytesRead: m.bytesRead.used, documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used } };
      });
      // eslint-disable-next-line no-console
      console.info("[read-budget] ops.backlog with 300 failed 60 KB inbound emails", JSON.stringify({ ...metrics, errorMessage }));
      expect(errorMessage).toBeNull();
      expect(result!.processedEventsFailed).toEqual({ count: PAYLOAD_ROWS_SCAN_CAP, truncated: true });
      expect(metrics.bytesRead).toBeLessThan(16 * 1024 * 1024);
    },
    150_000,
  );
});
