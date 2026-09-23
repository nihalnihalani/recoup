/// <reference types="vite/client" />
/**
 * M29 (C58) — `ops` diagnostics:
 *   - `ruleSourceInputs()` is wired (D237 acceptance flagged `inputsWired: false`): the registry's active packs, their
 *     sources' refresh windows and mandatory review dates (mirroring the manifest — checked below), against
 *     `lib/rules/verification.ts`, at the backlog's coarse `asOf`. Every implemented pack is made active through the
 *     test registry and `verification.ts` is replaced by records this file controls.
 *   - backlog additions `deadlineSweep`, `reevaluateDue`, `userDeadlinesSoon`, bounded and measured at their caps.
 * Expected values are hand-written.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));
const VER = vi.hoisted(() => ({
  VERIFICATION: {} as Record<string, { lastVerifiedAt: string; sha256: string }>,
  LIVE_VERIFICATIONS: [] as unknown[],
}));
vi.mock("./lib/rules/verification", () => VER);

import { convexTest } from "convex-test";
import agentmail from "@agentmail/convex/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { setup } from "./test.setup";
import { OPPORTUNITY_SCAN_CAP, ruleSourceWindows, staleSourcePacks } from "./ops";
import { IMPLEMENTED_PACKS } from "./lib/rules/applicable";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { REPO_ROOT } from "./testing/ruleFixtures.loader";
import { DEADLINE_ATTENTION_LEAD_MS, DEADLINE_SWEEP_OPS_KEY } from "./deadlines";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 1, 12); // 2026-10-01T12:00Z
type T = ReturnType<typeof setup>;

function verifyAll(date: string) {
  for (const pack of IMPLEMENTED_PACKS) for (const s of pack.sources) VER.VERIFICATION[s.sourceId] = { lastVerifiedAt: date, sha256: "0".repeat(64) };
}
beforeEach(() => resetTestRegistry());
afterEach(() => {
  resetTestRegistry();
  for (const k of Object.keys(VER.VERIFICATION)) delete VER.VERIFICATION[k];
});

type ManifestPack = { ruleId: string; version: number | null; refreshDays?: number; mandatoryReviewBy?: string };
const MANIFEST = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/rules/manifest.json"), "utf8")) as { packs: ManifestPack[] };

describe("ruleSourceInputs reads the manifest's refresh windows (mirrored in every pack's sources)", () => {
  it("every implemented pack's windowed sources carry the manifest's refreshDays and mandatoryReviewBy", () => {
    for (const pack of IMPLEMENTED_PACKS) {
      const entry = MANIFEST.packs.find((p) => p.ruleId === pack.ruleId && p.version === pack.version);
      expect(entry, pack.ruleId).toBeDefined();
      const windowed = pack.sources.filter((s) => s.refreshWindowDays !== undefined);
      if (entry!.refreshDays === undefined) {
        expect(windowed, `${pack.ruleId}: no manifest refresh window, so no windowed source`).toEqual([]);
        continue;
      }
      for (const s of windowed) expect(s.refreshWindowDays, `${pack.ruleId} ${s.sourceId}`).toBe(entry!.refreshDays);
      for (const s of pack.sources) expect(s.mandatoryReviewBy, `${pack.ruleId} ${s.sourceId}`).toBe(entry!.mandatoryReviewBy);
      // A mandatory review date on a source without a refresh window would be invisible to the diagnostic.
      for (const s of pack.sources) if (s.mandatoryReviewBy !== undefined) expect(s.refreshWindowDays, s.sourceId).toBeDefined();
    }
  });

  it("ruleSourceWindows: R01 v1 has no window (listed apart); R02 is one 30-day window with its mandatory review date", () => {
    const { windows, withoutWindow } = ruleSourceWindows(IMPLEMENTED_PACKS);
    expect(withoutWindow).toEqual(["R01.retail_price_adjustment@v1"]);
    const r02 = windows.filter((w) => w.ruleId === "R02.airline_fare_refund.us_dot");
    expect(r02).toHaveLength(1);
    expect(r02[0].refreshDays).toBe(30);
    expect(Object.values(r02[0].mandatoryReviewBy ?? {})).toSatisfy((dates: string[]) => dates.length > 0 && dates.every((d) => d === "2027-07-07"));
    expect(windows.find((w) => w.ruleId === "R05.mitor_shipment.us_ftc")).toMatchObject({ refreshDays: 180 });
  });
});

describe("staleSourcePacks honours mandatoryReviewBy (D234 E5, as lib/rules/outcome.sourceStale)", () => {
  const W = { ruleId: "R02.airline_fare_refund.us_dot", version: 1, refreshDays: 30, sourceIds: ["a"], mandatoryReviewBy: { a: "2027-07-07" } };
  const REVIEW = Date.UTC(2027, 6, 7);
  it("verified before the review date: fresh well before it, due_soon in the last 7 days, stale from it; windowEndsAt = the review date", () => {
    const v = { a: { lastVerifiedAt: "2027-06-20" } };
    expect(staleSourcePacks([W], v, Date.UTC(2027, 5, 21))).toEqual([]);
    expect(staleSourcePacks([W], v, REVIEW - 3 * DAY)).toEqual([{ ruleId: W.ruleId, version: 1, refreshDays: 30, status: "due_soon", windowEndsAt: REVIEW, sourceIds: ["a"] }]);
    expect(staleSourcePacks([W], v, REVIEW)[0]).toMatchObject({ status: "stale", windowEndsAt: REVIEW });
  });
  it("a verification dated on or after the review date clears it; an unreadable review date fails closed", () => {
    expect(staleSourcePacks([W], { a: { lastVerifiedAt: "2027-07-07" } }, REVIEW + DAY)).toEqual([]);
    expect(staleSourcePacks([{ ...W, mandatoryReviewBy: { a: "next summer" } }], { a: { lastVerifiedAt: "2027-06-20" } }, Date.UTC(2027, 5, 21))[0]?.status).toBe("stale");
  });
});

describe("ops.backlog staleSources, wired (M29, C58)", () => {
  it("every implemented pack active, all verified 2026-09-23 → all fresh on 10-01 (8 days into 30/90/180-day windows); R01 v1 listed without a window", async () => {
    verifyAll("2026-09-23");
    const t = setup();
    const r = await t.query(internal.ops.backlog, { now: NOW + 17 * 60_000 });
    expect(r.staleSources.inputsWired).toBe(true);
    expect(r.staleSources.asOf).toBe(NOW);
    expect(r.staleSources.withoutRefreshWindow).toEqual(["R01.retail_price_adjustment@v1"]);
    expect(r.staleSources.checkedPacks).toBeGreaterThanOrEqual(5); // R02, R03, R04 ×3 paths, R05 (R01 has no window)
    expect(r.staleSources.packs).toEqual([]); // 8 days into 30/90/180-day windows: all fresh
  });

  it("R05 verified 2026-03-01 (180 days → stale from 2026-08-28), R03's sources never verified → both reported, most urgent first", async () => {
    verifyAll("2026-09-23");
    for (const s of IMPLEMENTED_PACKS.find((p) => p.ruleId === "R05.mitor_shipment.us_ftc")!.sources.filter((x) => x.refreshWindowDays !== undefined)) {
      VER.VERIFICATION[s.sourceId] = { lastVerifiedAt: "2026-03-01", sha256: "0".repeat(64) };
    }
    for (const s of IMPLEMENTED_PACKS.find((p) => p.ruleId === "R03.credit_billing_error.us_fcba")!.sources) delete VER.VERIFICATION[s.sourceId];
    const t = setup();
    const r = await t.query(internal.ops.backlog, { now: NOW });
    expect(r.staleSources.packs.map((p) => [p.ruleId, p.status])).toEqual([
      ["R03.credit_billing_error.us_fcba", "never_verified"],
      ["R05.mitor_shipment.us_ftc", "stale"],
    ]);
    expect(r.staleSources.packs[1].windowEndsAt).toBe(Date.UTC(2026, 2, 1) + 180 * DAY);
  });

  it("only ACTIVE packs are checked: with R01 v1 alone active, nothing is checked and R01 is listed without a window", async () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const t = setup();
    const r = await t.query(internal.ops.backlog, { now: NOW });
    expect(r.staleSources).toEqual({ asOf: NOW, inputsWired: true, checkedPacks: 0, packs: [], withoutRefreshWindow: ["R01.retail_price_adjustment@v1"] });
  });
});

async function insertOpp(
  ctx: Parameters<Parameters<T["run"]>[0]>[0],
  userId: Id<"users">,
  n: number,
  o: { status?: "open" | "case_open"; nextDeadlineAt?: number; reevaluateAt?: number; outcome?: Doc<"opportunities">["outcome"] },
) {
  const transactionId = await ctx.db.insert("transactions", { userId, category: "card_charge", status: "active", counterpartyName: `B${n}`, currency: "USD", liveFactCount: 0 });
  await ctx.db.insert("opportunities", {
    userId, transactionId, scenarioId: "R03", remedyKey: "billing_error_credit", subjectKey: "txn", dedupeKey: `${transactionId}|R03|x|txn|-`,
    status: o.status ?? "open", ruleId: "R03.credit_billing_error.us_fcba", ruleVersion: 1, outcome: o.outcome ?? "manual_review",
    authorityClass: "legal_entitlement", remedyType: "billing_correction", cashClass: "cash", lossKeys: [`txn:${transactionId}:paid`], lastEvaluatedAt: NOW,
    ...(o.nextDeadlineAt !== undefined ? { nextDeadlineAt: o.nextDeadlineAt } : {}),
    ...(o.reevaluateAt !== undefined ? { reevaluateAt: o.reevaluateAt } : {}),
  });
}

describe("ops.backlog M29 additions", () => {
  it("deadlineSweep is null before the first run; then its age and the cycle's totals", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const t = setup();
      expect((await t.query(internal.ops.backlog, { now: NOW })).deadlineSweep).toEqual({ ageMs: null, lastCycle: null });
      await t.mutation(internal.deadlines.sweep, { now: NOW });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const r = await t.query(internal.ops.backlog, { now: NOW + 2 * HOUR });
      expect(r.deadlineSweep).toEqual({
        ageMs: 2 * HOUR,
        lastCycle: { cycleNow: NOW, status: "case_open", scanned: 0, scheduled: 0, reevaluated: 0, reevaluateFailed: false, done: true },
      });
      const row = await t.run(async (ctx) => (await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", DEADLINE_SWEEP_OPS_KEY)).first())!);
      expect(row.updatedAt).toBe(NOW);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reevaluateDue counts open not_yet_due paths at or past their date; userDeadlinesSoon counts running user deadlines in the window; both bounded", async () => {
    const t = setup();
    const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Ops" }));
    await t.run(async (ctx) => {
      await insertOpp(ctx, userId, 1, { reevaluateAt: NOW - DAY, outcome: "not_yet_due" });
      await insertOpp(ctx, userId, 2, { reevaluateAt: NOW, outcome: "not_yet_due" });
      await insertOpp(ctx, userId, 3, { reevaluateAt: NOW + 1, outcome: "not_yet_due" }); // not yet
      await insertOpp(ctx, userId, 4, { nextDeadlineAt: NOW + DAY });
      await insertOpp(ctx, userId, 5, { nextDeadlineAt: NOW + DEADLINE_ATTENTION_LEAD_MS, status: "case_open" });
      await insertOpp(ctx, userId, 6, { nextDeadlineAt: NOW + DEADLINE_ATTENTION_LEAD_MS + 1 }); // beyond the window
      await insertOpp(ctx, userId, 7, { nextDeadlineAt: NOW }); // passed at `now`
    });
    const r = await t.query(internal.ops.backlog, { now: NOW });
    expect(r.reevaluateDue).toEqual({ count: 2, truncated: false });
    expect(r.userDeadlinesSoon).toEqual({ count: 2, truncated: false });
    const capped = await t.query(internal.ops.backlog, { now: NOW, scanLimit: 1 });
    expect(capped.reevaluateDue).toEqual({ count: 1, truncated: true });
    expect(capped.userDeadlinesSoon).toEqual({ count: 2, truncated: false }); // one per status, each within its cap
  });
});

// ---------------------------------------------------------------------------
// Read budget at the caps (enforced transaction limits).
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

describe("ops.backlog M29 additions at their caps", () => {
  it(
    `${OPPORTUNITY_SCAN_CAP + 1} rows in each of the three opportunity ranges → capped counts, truncated, bounded reads`,
    async () => {
      verifyAll("2026-09-23");
      const t = limitedHarness();
      const userId: Id<"users"> = await t.run((ctx) => ctx.db.insert("users", { name: "Heavy ops" }));
      for (const kind of ["reevaluate", "open", "case_open"] as const) {
        await t.run(async (ctx) => {
          for (let i = 0; i < OPPORTUNITY_SCAN_CAP + 1; i++) {
            await insertOpp(ctx, userId, i, kind === "reevaluate"
              ? { reevaluateAt: NOW - HOUR, outcome: "not_yet_due" }
              : { nextDeadlineAt: NOW + DAY, status: kind });
          }
        });
      }
      const { result, errorMessage, metrics } = await t.run(async (ctx) => {
        let result: Awaited<ReturnType<typeof ctx.runQuery<typeof internal.ops.backlog>>> | undefined;
        let errorMessage: string | null = null;
        try {
          result = await ctx.runQuery(internal.ops.backlog, { now: NOW });
        } catch (e) {
          errorMessage = e instanceof Error ? e.message : String(e);
        }
        const m = await ctx.meta.getTransactionMetrics();
        return { result, errorMessage, metrics: { documentsRead: m.documentsRead.used, databaseQueries: m.databaseQueries.used, bytesRead: m.bytesRead.used } };
      });
      // eslint-disable-next-line no-console
      console.log("[read-budget] ops.backlog with M29 ranges at their caps", JSON.stringify({ ...metrics, errorMessage }));
      expect(errorMessage).toBeNull();
      expect(result!.reevaluateDue).toEqual({ count: OPPORTUNITY_SCAN_CAP, truncated: true });
      expect(result!.userDeadlinesSoon).toEqual({ count: 2 * OPPORTUNITY_SCAN_CAP, truncated: true });
      expect(metrics.documentsRead).toBeLessThan(32_000);
      expect(metrics.databaseQueries).toBeLessThan(4_096);
      expect(metrics.bytesRead).toBeLessThan(16 * 1024 * 1024);
    },
    150_000,
  );
});
