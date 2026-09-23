import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { exportPKCS8, generateKeyPair } from "jose";
import { ConvexError, type GenericId } from "convex/values";
import { api, internal, components } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { inboxTransport } from "./account";
import { EXPORT_EXEMPT, EXPORT_TABLE_NAMES, OUTSIDE_PURGE_STEPS, PURGE_STEPS } from "./account";
import { DELETION_QUEUED_CLAIM_SCAN, DELETION_UNRESOLVED_DRAFT_SCAN } from "./account";
import { chargeStoredBytes, storedBytes } from "./lib/blobRefs";
import { WRONG_CREDENTIALS_MESSAGE } from "./auth";
import { rateLimiter } from "./lib/rateLimits";
import { RETENTION_PAGE, PROCESSED_EVENTS_PAGE, STUCK_DELETION_AGE_MS, STUCK_DELETION_REDRIVE_PAGE } from "./limits";
import schema from "./schema";
import agentmail from "@agentmail/convex/test";
import workpool from "@convex-dev/workpool/test";
import rl from "@convex-dev/rate-limiter/test";
import bw from "@convex-dev/batch-worker/test";
import firecrawl from "@firecrawl/firecrawl-convex/test";

/**
 * Checkpoint 6b (D115) byte-budget tests need `transactionLimits: true` (to
 * actually enforce the 16 MiB read cap `convex-test` otherwise ignores),
 * which `test.setup.ts`'s own `setup()` does not pass. Duplicated locally
 * rather than changing that shared harness (out of this task's file
 * ownership) -- same helper shape the checkpoint 6b reviewer's own repro
 * file (`da6b.test.ts`) used.
 */
function setupWithLimits() {
  process.env.FIRECRAWL_API_KEY = "fc-test";
  process.env.AGENTMAIL_API_KEY = "am-test";
  process.env.AGENTMAIL_WEBHOOK_SECRET = "whsec_test";
  const modules = import.meta.glob("./**/*.*s");
  const agentmailModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", { exhaustive: true });
  const workpoolModules = import.meta.glob("../node_modules/@convex-dev/workpool/src/component/**/*.ts", { exhaustive: true });
  const rlModules = import.meta.glob("../node_modules/@convex-dev/rate-limiter/src/component/**/*.ts", { exhaustive: true });
  const bwModules = import.meta.glob("../node_modules/@convex-dev/batch-worker/src/component/**/*.ts", { exhaustive: true });
  const t = convexTest({ schema, modules, transactionLimits: true });
  t.registerComponent("agentmail", agentmail.schema, agentmailModules);
  t.registerComponent("agentmail/sendPool", workpool.schema, workpoolModules);
  t.registerComponent("agentmail/callbackPool", workpool.schema, workpoolModules);
  firecrawl.register(t);
  t.registerComponent("rateLimiter", rl.schema, rlModules);
  t.registerComponent("rateLimiter/batchWorker", bw.schema, bwModules);
  return t;
}

const T0 = Date.UTC(2026, 8, 21, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  process.env.AGENTMAIL_API_KEY = "am-test";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks(); // `inboxTransport` is a module-level singleton: an un-restored `vi.spyOn` from one test would otherwise leak its mock implementation and call history into the next.
  delete process.env.AGENTMAIL_API_KEY;
  delete process.env.AGENTMAIL_BASE_URL;
});

type T = ReturnType<typeof setup>;

// ---------------------------------------------------------------------------
// Seed helpers -- one small owned tree per user, covering every table
// `exportPage`/`purgeStep` touch (direct, via-parent, and status-iterated).
// ---------------------------------------------------------------------------

/**
 * T18.5 (D124 B1): `seedFullAccount`'s queued mailLog row below needs a
 * syntactically valid component `outboundMessages` id, not a placeholder
 * string like the pre-T18.5 `"ob-1" as never` -- `purgeStep`'s mailLog step
 * now calls `mailPurge.purgeOutbound` (a component mutation) for every
 * mailLog row carrying an `outboundId`, and the component's own
 * `v.id("outboundMessages")` argument validator rejects a malformed id
 * outright (`Validator error: Expected ID for table "outboundMessages"`).
 *
 * Minted ONCE, in a throwaway backend, via a real `enqueueSend` call (the
 * only way to obtain a genuinely valid id -- component tables are a separate
 * mock backend `t.run` cannot reach, per `mailPurge.test.ts`'s own
 * docstring). Reused as a plain string constant across every OTHER test's
 * OWN fresh `setup()` backend rather than calling `enqueueSend` inside each
 * one: id FORMAT validation is structural (table name + encoding), not "does
 * this row exist in THIS backend", so `ctx.db.get` on this id in a different
 * backend returns `null` (not a throw) and `purgeOutbound` cleanly no-ops on
 * it. This sidesteps a real gotcha: `enqueueSend` also schedules the actual
 * send pipeline (a workpool action that POSTs over HTTP), and workpool's own
 * periodic internal status report self-reschedules indefinitely once a job
 * exists -- several callers below drain every scheduled function to
 * completion (`finishAllScheduledFunctions`/`vi.runAllTimers`), which hit
 * convex-test's "too many iterations" guard the moment a real send was ever
 * enqueued in THAT SAME backend, even after `cancelSend` finalizes the row.
 * `mailPurge.test.ts` avoids the same trap by simply never draining scheduled
 * functions; this suite cannot avoid that, so it avoids the live send instead.
 */
let SAMPLE_OUTBOUND_ID: string;
beforeAll(async () => {
  const seedT = setup();
  // D247 (KX3): `enqueueSend`'s mutation itself schedules the real send pipeline, whose workpool component
  // self-reschedules its own periodic status report INDEFINITELY once a job exists (see the docstring above) --
  // this `beforeAll` runs before any test's `beforeEach` fakes timers, so without this, that first scheduling call
  // lands on a REAL timer and the report keeps firing on real timers for the rest of the process, contaminating
  // whichever test's `it()` happens to be running when a tick lands (the KX3 guard, widened for D247, now catches
  // exactly this). Faking timers around JUST this call routes the scheduling into vitest's fake clock instead;
  // switching back to real timers immediately after abandons it unflushed, so it never actually runs -- fine here,
  // since only the id's FORMAT is needed (per the docstring), never delivery.
  vi.useFakeTimers();
  SAMPLE_OUTBOUND_ID = await seedT.mutation(components.agentmail.lib.enqueueSend, {
    config: { retryAttempts: 1, initialBackoffMs: 10 },
    inboxId: "inbox-seed-sample",
    kind: "send" as const,
    payload: { to: "sample@example.com", subject: "sample", text: "sample" },
  });
  vi.useRealTimers();
});

async function seedFullAccount(t: T, userId: Id<"users">, email: string) {
  return await t.run(async (ctx) => {
    const profileId = await ctx.db.insert("profiles", { userId, inboxId: `inbox-${userId}`, inboxEmail: email });

    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: 8000, qty: 1, returned: false,
    });
    const priceCheckId = await ctx.db.insert("priceChecks", {
      itemId, userId, observedCents: 7500, observedAt: T0, sourceUrl: "https://acme.example/p/jacket",
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500,
      status: "detected", token: `tok-${userId}`, version: 1,
    });
    const ledgerId = await ctx.db.insert("ledgerEvents", {
      claimId, userId, kind: "promised_credit", cents: 500, evidence: "merchant email",
    });
    const noteId = await ctx.db.insert("claimNotes", { claimId, userId, kind: "note", text: "hello" });
    const draftId = await ctx.db.insert("drafts", {
      claimId, userId, version: 1, claimVersion: 1, to: "merchant@acme.example",
      subject: "Price match", body: "Please refund the difference.",
    });
    const replyId = await ctx.db.insert("replies", {
      claimId, userId, messageId: `msg-${userId}`, from: "merchant@acme.example",
      classification: "promise", summary: "will credit", senderMismatch: false, receivedAt: T0,
    });
    const scheduledFnId = await ctx.scheduler.runAfter(999_999_999, internal.account.purgeStep, { userId });
    const followUpId = await ctx.db.insert("followUps", {
      claimId, userId, scheduledFnId, fireAt: T0 + 999_999_999, claimVersion: 1, status: "pending",
    });

    const policyId = await ctx.db.insert("policies", {
      userId, merchantDomain: "acme.example", kind: "price_adjustment", channel: "email",
      passage: "30 days", sourceUrl: "https://acme.example/policy", retrievedAt: T0, confidence: 0.9, confirmedByUser: true,
    });

    const watchId = await ctx.db.insert("watches", {
      userId, name: "Down Jacket", productUrl: "https://acme.example/p/down", merchantDomain: "acme.example",
      status: "active", nextCheckAt: T0 + 3_600_000,
    });
    const watchCheckId = await ctx.db.insert("watchChecks", {
      watchId, userId, observedCents: 7000, observedAt: T0, sourceUrl: "https://acme.example/p/down",
    });
    const offerId = await ctx.db.insert("offers", {
      watchId, userId, storeDomain: "other.example", productUrl: "https://other.example/p/down", title: "Other Store", status: "candidate",
    });
    const offerCheckId = await ctx.db.insert("offerChecks", {
      offerId, watchId, userId, observedCents: 6900, observedAt: T0,
    });
    const marketPriceId = await ctx.db.insert("marketPrices", {
      watchId, userId, retailer: "Widget Co", cents: 6800, currency: "USD", observedAt: T0, marketKey: `widget:${T0}`,
    });

    const mailLogId = await ctx.db.insert("mailLog", {
      userId, dedupeKey: `watch:${watchId}:7000`, kind: "price_drop", to: email, subject: "Price drop!", status: "sent",
    });
    const queuedMailLogId = await ctx.db.insert("mailLog", {
      userId, dedupeKey: `watch:${watchId}:6900`, kind: "price_drop", to: email, subject: "Price drop!",
      status: "queued", outboundId: SAMPLE_OUTBOUND_ID as never, attempt: 0, nextCheckAt: T0 + 600_000,
    });

    const alertSettingsId = await ctx.db.insert("alertSettings", {
      userId, alertsEnabled: true, unsubscribeToken: `unsub-${userId}`, updatedAt: T0,
    });

    const processedEventId = await ctx.db.insert("processedEvents", {
      externalId: `evt-${userId}`, kind: "agentmail.message.received", status: "succeeded", attempts: 1, userId,
    });

    const usageId = await ctx.db.insert("usage", { userId, day: "2026-09-21", kind: "market_lookup", count: 1 });

    return {
      profileId, purchaseId, itemId, priceCheckId, claimId, ledgerId, noteId, draftId, replyId, followUpId,
      policyId, watchId, watchCheckId, offerId, offerCheckId, marketPriceId, mailLogId, queuedMailLogId,
      alertSettingsId, processedEventId, usageId, scheduledFnId,
    };
  });
}

/** Every table `purgeStep` is contractually responsible for, in its own order. */
const OWNED_TABLES = [
  "followUps", "claimNotes", "drafts", "replies", "ledgerEvents", "claims", "priceChecks", "items",
  "purchases", "policies", "offerChecks", "offers", "marketPrices", "watchChecks", "watches", "mailLog",
  "usage", "alertSettings", "processedEvents", "profiles",
] as const;

async function countAllOwned(t: T, userId: Id<"users">): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of OWNED_TABLES) {
      const rows = await ctx.db.query(table as any).collect();
      counts[table] = rows.filter((r: any) => r.userId === userId).length;
    }
    return counts;
  });
}

function totalOwned(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// exportPage
// ---------------------------------------------------------------------------

describe("account.exportPage", () => {
  it("returns only the caller's own rows for a direct table (purchases), never another user's", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await seedFullAccount(t, a.userId, "a@example.com");
    await seedFullAccount(t, b.userId, "b@example.com");

    const page = await a.as.query(api.account.exportPage, { table: "purchases" });
    expect(page.rows).toHaveLength(1);
    expect((page.rows[0] as any).userId).toBe(a.userId);
    expect(page.cursor).toBeNull();
  });

  it("returns only the caller's own rows for a via-parent table (ledgerEvents, claimNotes, drafts, replies, followUps)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const seededA = await seedFullAccount(t, a.userId, "a@example.com");
    await seedFullAccount(t, b.userId, "b@example.com");

    for (const table of ["ledgerEvents", "claimNotes", "drafts", "replies", "followUps"] as const) {
      const page = await a.as.query(api.account.exportPage, { table });
      expect(page.rows, `table ${table}`).toHaveLength(1);
      expect((page.rows[0] as any).userId).toBe(a.userId);
      expect((page.rows[0] as any).claimId).toBe(seededA.claimId);
    }
  });

  it("returns only the caller's own rows for a via-parent table rooted at items/watches/offers (priceChecks, watchChecks, offerChecks, marketPrices)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await seedFullAccount(t, a.userId, "a@example.com");
    await seedFullAccount(t, b.userId, "b@example.com");

    for (const table of ["priceChecks", "watchChecks", "offerChecks", "marketPrices"] as const) {
      const page = await a.as.query(api.account.exportPage, { table });
      expect(page.rows, `table ${table}`).toHaveLength(1);
      expect((page.rows[0] as any).userId).toBe(a.userId);
    }
  });

  it("returns only the caller's own rows for the status-iterated table (processedEvents)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await seedFullAccount(t, a.userId, "a@example.com");
    await seedFullAccount(t, b.userId, "b@example.com");

    // `processedEvents` has no plain `by_user` index (schema.ts), so it is
    // iterated one status at a time (`received`, `processing`, `succeeded`,
    // `failed`, `needs_review` -- Convex allows only one `.paginate()` call
    // per function execution, so one call advances at most one status).
    // Our seeded row is `succeeded` (the 3rd of 5), so it takes several
    // cursor pages to reach even though the account only has one row.
    const rows: any[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const page: { rows: any[]; cursor: string | null } = await a.as.query(api.account.exportPage, { table: "processedEvents", cursor: cursor ?? undefined });
      rows.push(...page.rows);
      cursor = page.cursor;
      pages++;
      expect(pages).toBeLessThan(10); // safety bound (5 statuses)
    } while (cursor !== null);

    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(a.userId);
  });

  it("pages a direct table across > 200 rows via cursor, covering every row exactly once", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const TOTAL = RETENTION_PAGE + 37;
    await t.run(async (ctx) => {
      for (let i = 0; i < TOTAL; i++) {
        await ctx.db.insert("watches", {
          userId: a.userId, name: `Watch ${i}`, productUrl: `https://acme.example/p/${i}`,
          merchantDomain: "acme.example", status: "active", nextCheckAt: T0,
        });
      }
    });

    const seen = new Set<string>();
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const page: { rows: any[]; cursor: string | null } = await a.as.query(api.account.exportPage, { table: "watches", cursor: cursor ?? undefined });
      for (const row of page.rows) seen.add(row._id);
      cursor = page.cursor;
      pages++;
      expect(pages).toBeLessThan(20); // safety bound
    } while (cursor !== null);

    expect(seen.size).toBe(TOTAL);
  });

  it("pages a via-parent table across > 200 rows spread over many parent claims", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const TOTAL = RETENTION_PAGE + 41;
    await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId: a.userId, name: "Jacket", unitCents: 1000, qty: 1, returned: false });
      // Many claims, each with one claimNote -- exercises the parent-scan loop across many parents, not just one deep parent.
      for (let i = 0; i < TOTAL; i++) {
        const claimId = await ctx.db.insert("claims", {
          purchaseId, itemId, userId: a.userId, type: "price_adjustment", expectedCents: 100,
          status: "detected", token: `tok-${i}`, version: 1,
        });
        await ctx.db.insert("claimNotes", { claimId, userId: a.userId, kind: "note", text: `note ${i}` });
      }
    });

    const seen = new Set<string>();
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    do {
      const page: { rows: any[]; cursor: string | null } = await a.as.query(api.account.exportPage, { table: "claimNotes", cursor: cursor ?? undefined });
      for (const row of page.rows) seen.add(row._id);
      cursor = page.cursor;
      pages++;
      expect(pages).toBeLessThan(400); // safety bound (parent-scan is bounded per call, so this can take several calls)
    } while (cursor !== null);

    expect(seen.size).toBe(TOTAL);
  });

  it("refuses while the account is deleting, and after it is deleted", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await expect(a.as.query(api.account.exportPage, { table: "purchases" })).rejects.toThrow();

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await expect(a.as.query(api.account.exportPage, { table: "purchases" })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// requestDeletion
// ---------------------------------------------------------------------------

describe("account.requestDeletion", () => {
  it("throws on the wrong confirmation phrase and writes nothing", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await expect(a.as.mutation(api.account.requestDeletion, { confirmation: "delete" })).rejects.toThrow();
    const row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(row).toBeNull();
  });

  it("tombstones immediately (visible to isTombstoned before purge runs), is idempotent on a second call", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(row?.status).toBe("deleting");
    expect(row?.attempts).toBe(0);

    // A second call is a no-op: does not reset attempts/requestedAt or schedule a second purge chain.
    vi.setSystemTime(T0 + 60_000);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    const rowAfter = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(rowAfter?._id).toBe(row?._id);
    expect(rowAfter?.requestedAt).toBe(row?.requestedAt);

    // 6b-8 (D115): idempotency asserted by ROW COUNT and PENDING-JOB COUNT,
    // not just field equality -- exactly one tombstone row, and exactly one
    // still-pending `account.purge` job, even after two `requestDeletion`
    // calls.
    const allTombstones = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect());
    expect(allTombstones).toHaveLength(1);
    const pending = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    // "purge" alone (not "purgeStep"/"purgeAuth") is the only scheduled job at
    // this point: `purgeStep`/`purgeAuth` are invoked via `ctx.runMutation`
    // from inside the `purge` action, never independently scheduled.
    const pendingPurgeJobs = pending.filter(
      (r) => (r.state.kind === "pending" || r.state.kind === "inProgress") && r.name.includes("purge") && !r.name.includes("purgeStep") && !r.name.includes("purgeAuth"),
    );
    expect(pendingPurgeJobs).toHaveLength(1);
    expect(rowAfter?.activePurgeJobId).toBe(pendingPurgeJobs[0]!._id);
  });

  it("revokes every session (and its refresh tokens) in the same transaction", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId: a.userId, expirationTime: T0 + 999_999 }));
    await t.run((ctx) => ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: T0 + 999_999 }));

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const sessions = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", a.userId)).collect());
    const tokens = await t.run((ctx) => ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", sessionId)).collect());
    expect(sessions).toHaveLength(0);
    expect(tokens).toHaveLength(0);
  });

  it("P02-OW-3: cancels a queued alert's pending component send and marks it suppressed/deleted before purge ever runs; a row whose send is not pending stays queued", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const seeded = await seedFullAccount(t, a.userId, "a@example.com");
    // A send still pending in THIS backend's component. Never driven, so its
    // workpool job never runs (see SAMPLE_OUTBOUND_ID's note above).
    const pendingOutboundId = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: { retryAttempts: 1, initialBackoffMs: 10 },
      inboxId: "inbox-alerts",
      kind: "send" as const,
      payload: { to: "a@example.com", subject: "Price drop!", text: "sample" },
    });
    const pendingRowId = await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:pending:6800", kind: "price_drop", to: "a@example.com", subject: "Price drop!",
        status: "queued", outboundId: pendingOutboundId as never, attempt: 0, nextCheckAt: T0 + 600_000,
      }),
    );

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const row = await t.run((ctx) => ctx.db.get(pendingRowId));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("deleted");
    expect(row?.error).toMatch(/asked for this alert to be cancelled, but it may already have gone out/);
    const component = await t.query(components.agentmail.lib.getOutboundStatus, { outboundId: pendingOutboundId });
    expect(component?.status).toBe("failed");
    expect(component?.errorMessage).toBe("Cancelled by user");

    // The seeded row's outboundId has no row in this backend: nothing was
    // cancelled, so it is not claimed as suppressed. Reconciliation (or the
    // purge) settles it.
    expect((await t.run((ctx) => ctx.db.get(seeded.queuedMailLogId)))?.status).toBe("queued");
  });

  it("another user's requestDeletion never tombstones the caller", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await b.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const rowA = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(rowA).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// purge (end to end)
// ---------------------------------------------------------------------------

describe("account.purge — end to end", () => {
  it("removes every owned row across every table, purges auth rows and the user row, and marks the tombstone deleted", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined); // not exercising the provider path here -- see the dedicated failure/retry tests below
    const accountId = await t.run((ctx) => ctx.db.insert("authAccounts", { userId: a.userId, provider: "password", providerAccountId: "a@example.com", secret: "hash" }));
    await t.run((ctx) => ctx.db.insert("authVerificationCodes", { accountId, provider: "password", code: "hashedcode", expirationTime: T0 + 900_000 }));

    const before = await countAllOwned(t, a.userId);
    expect(totalOwned(before)).toBeGreaterThan(0);

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await countAllOwned(t, a.userId);
    expect(totalOwned(after)).toBe(0);

    const user = await t.run((ctx) => ctx.db.get(a.userId));
    expect(user).toBeNull();
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").withIndex("userIdAndProvider", (q) => q.eq("userId", a.userId)).collect());
    expect(accounts).toHaveLength(0);
    const codes = await t.run((ctx) => ctx.db.query("authVerificationCodes").withIndex("accountId", (q) => q.eq("accountId", accountId)).collect());
    expect(codes).toHaveLength(0);

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
    expect(state?.inboxDeleted).toBe(true);
    expect(state?.completedAt).toBeDefined();
  });

  it("clears the mailEvent:<id> opsState stash for a mailLog row it purges", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const mailLogId = await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:x:1", kind: "price_drop", to: "a@example.com", subject: "s",
        status: "sent", agentmailMessageId: "msg-stash-1",
      }),
    );
    await t.run((ctx) => ctx.db.insert("opsState", { key: "mailEvent:msg-stash-1", cursor: JSON.stringify({ reason: "bounced", providerStatus: "bounced" }), updatedAt: T0 }));

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const mailRow = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(mailRow).toBeNull();
    const stash = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-stash-1")).unique());
    expect(stash).toBeNull();
  });

  it("clears the e2e:code:<email> opsState stash for the deleted user's email", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.patch(a.userId, { email: "a@example.com" }));
    await t.run((ctx) => ctx.db.insert("opsState", { key: "e2e:code:a@example.com", cursor: "12345678", updatedAt: T0 }));

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const stash = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "e2e:code:a@example.com")).unique());
    expect(stash).toBeNull();
  });

  it("is resumable: interrupting purgeStep partway through and re-running it later still completes", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const TOTAL = RETENTION_PAGE + 25;
    await t.run(async (ctx) => {
      for (let i = 0; i < TOTAL; i++) {
        await ctx.db.insert("watches", {
          userId: a.userId, name: `Watch ${i}`, productUrl: `https://acme.example/p/${i}`,
          merchantDomain: "acme.example", status: "active", nextCheckAt: T0,
        });
      }
    });

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    // Drive `purgeStep` directly (bypassing the scheduled `purge` action),
    // one bounded call at a time -- simulating a crash/redeploy mid-purge.
    // `watches` is only ONE of `PURGE_STEPS`' 20 tables (this account has no
    // data in the others), and each call advances at most one step, so it
    // takes several calls of `{ deleted: 0, done: false }` on empty
    // preceding tables before `watches` itself is even reached; stop as
    // soon as its row count first drops (proof this run was interrupted
    // mid-table, not merely mid-cycle) rather than hardcoding a call count
    // tied to `PURGE_STEPS`' exact position for `watches`.
    let result = { done: false };
    let remaining = TOTAL;
    for (let i = 0; i < 40 && remaining === TOTAL; i++) {
      result = await t.mutation(internal.account.purgeStep, { userId: a.userId });
      remaining = (await t.run((ctx) => ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).length;
    }
    expect(result.done).toBe(false);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(TOTAL);

    // Resume: re-running purgeStep (as a fresh `purge` invocation would)
    // picks up from the persisted cursor rather than restarting.
    while (!result.done) {
      result = await t.mutation(internal.account.purgeStep, { userId: a.userId });
    }
    const finalWatches = await t.run((ctx) => ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect());
    expect(finalWatches).toHaveLength(0);
  });

  it("provider failure on inbox deletion leaves the tombstone deleting with a truthful inboxDeleted:false, retries with backoff, and (6b-4b, D115) purges auth anyway once exhausted", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    const failing = vi.spyOn(inboxTransport, "deleteInbox").mockRejectedValue(new Error("network unreachable"));

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    // First attempt: the requestDeletion-scheduled `purge` (runAfter 0)
    // becomes due and runs to completion (convex-test's documented
    // step-at-a-time idiom: advance the fake clock past the due time, then
    // wait only for the now-in-progress job -- a freshly-scheduled RETRY
    // job, due further in the future, is left pending rather than also
    // drained, which is what lets this test inspect state between attempts).
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    let state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleting");
    expect(state?.inboxDeleted).toBe(false);
    expect(state?.attempts).toBe(1);
    expect(failing).toHaveBeenCalledTimes(1);

    // A retry must actually be scheduled (not silently dropped).
    const pending = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(pending.some((r) => r.state.kind === "pending" || r.state.kind === "inProgress")).toBe(true);

    // Run out the remaining 4 attempts, one at a time: each backoff step is
    // larger than the last, but advancing by a generous fixed window every
    // time is enough since only ONE retry is ever pending at once (the next
    // one is scheduled only once the current attempt's action finishes).
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25 * 3_600_000);
      await t.finishInProgressScheduledFunctions();
    }
    state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    // 6b-4b (D115): the retry chain is now exhausted -- `purgeAuth` ran
    // anyway (auth rows are not provider-dependent), so `status` is
    // `"deleted"`, but `inboxDeleted` STAYS `false`: truthful reporting,
    // never rounded up just because Recoup's own side finished. Before this
    // fix (checkpoint 6b's F2b), this row stayed `"deleting"` forever with
    // its auth rows intact -- a permanent zombie account, reachable by
    // sign-in with the correct password (closed separately by 6b-4a's
    // `beforeSessionCreation` gate, but the account was never actually
    // FINISHED being deleted either way until this fix).
    expect(state?.status).toBe("deleted");
    expect(state?.inboxDeleted).toBe(false);
    expect(state?.attempts).toBe(5);
    expect(state?.lastError).toBeDefined();
    expect(failing).toHaveBeenCalledTimes(5);
    expect(state?.activePurgeJobId).toBeUndefined(); // nothing left scheduled for this row.

    const user = await t.run((ctx) => ctx.db.get(a.userId));
    expect(user).toBeNull(); // purgeAuth DID run: the user row is gone despite the permanently-failing inbox delete.
    const accounts = await t.run((ctx) => ctx.db.query("authAccounts").collect());
    expect(accounts.filter((row) => row.userId === a.userId)).toHaveLength(0);
  });

  it("succeeds after a transient provider failure (retry recovers)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    const spy = vi
      .spyOn(inboxTransport, "deleteInbox")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(undefined);

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
    expect(state?.inboxDeleted).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("skips the inbox-delete call entirely when the user never provisioned one", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const spy = vi.spyOn(inboxTransport, "deleteInbox");

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(spy).not.toHaveBeenCalled();
    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
  });
});

// ---------------------------------------------------------------------------
// deletionStatus
// ---------------------------------------------------------------------------

describe("account.deletionStatus", () => {
  it("is null when signed out and null for an active (never-tombstoned) account", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    expect(await t.query(api.account.deletionStatus, {})).toBeNull();
    expect(await a.as.query(api.account.deletionStatus, {})).toBeNull();
  });

  it("reports status while deleting (readable on a still-authenticated tab) and after deleted, without throwing", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const mid = await a.as.query(api.account.deletionStatus, {});
    expect(mid?.status).toBe("deleting");

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const done = await a.as.query(api.account.deletionStatus, {});
    expect(done?.status).toBe("deleted");
    expect(done?.inboxDeleted).toBe(true);
  });
});

// =============================================================================
// Checkpoint 6b (D115) regressions, ported from the reviewer's repro file
// (`da6b.test.ts`) per the task contract. Each block names which finding and
// which repro it ports, and states explicitly whether it was confirmed to
// FAIL against the pre-fix code (via `git stash` on the implementation
// files only, tests kept in place) and PASS after.
// =============================================================================

/** Seeds one user's full claim/ledger/draft tree, exactly like the reviewer's `seedClaimTree` helper, for the IDOR tests below. */
async function seedClaimTree(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 8000, qty: 1, returned: false });
    const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500, status: "sent", token: `tok-${userId}`, version: 1 });
    const ledgerId = await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 500, evidence: "SECRET merchant email for this user" });
    const draftId = await ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "merchant@acme.example", subject: "Price match", body: "SECRET draft body" });
    return { purchaseId, itemId, claimId, ledgerId, draftId };
  });
}

describe("checkpoint 6b (D115) 6b-1 HIGH IDOR — exportPage via-parent cursor trust (F1)", () => {
  it("user A cannot export user B's ledgerEvents/drafts by placing B's claim id in a forged cursor's `queue` or `pid`", async () => {
    // Ported from da6b.test.ts's F1 ("user A exports user B's ledgerEvents
    // and drafts by placing B's claim id in the cursor queue"). CONFIRMED
    // (git stash on convex/account.ts only, this test kept in place): before
    // the fix, `ledger.rows` had length 1 and carried B's SECRET evidence
    // string, and the `drafts` page carried B's SECRET draft body -- this
    // test's assertions (zero rows, no leak) FAILED. After the fix (the
    // `isOwnedParent` check in `readParentTable`), it PASSES.
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const bTree = await seedClaimTree(t, b.userId);

    const forged = JSON.stringify({ p: null, parentsDone: true, queue: [bTree.claimId], pid: null, skip: 0 });
    const ledger = await a.as.query(api.account.exportPage, { table: "ledgerEvents", cursor: forged });
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.cursor).toBeNull();

    const drafts = await a.as.query(api.account.exportPage, { table: "drafts", cursor: forged });
    expect(drafts.rows).toHaveLength(0);

    // Same via `pid` (the resume-a-parent path) -- also forged.
    const forgedPid = JSON.stringify({ p: null, parentsDone: true, queue: [], pid: bTree.claimId, skip: 0 });
    const viaPid = await a.as.query(api.account.exportPage, { table: "ledgerEvents", cursor: forgedPid });
    expect(viaPid.rows).toHaveLength(0);
    expect(viaPid.cursor).toBeNull();

    // No oracle: a forged id naming a row that does not exist at all behaves
    // identically (also zero rows, also a null cursor) to one naming B's
    // real, unowned claim -- the response shape never distinguishes them.
    const nonexistentId = bTree.claimId.slice(0, -1) + (bTree.claimId.endsWith("0") ? "1" : "0");
    const forgedNonexistent = JSON.stringify({ p: null, parentsDone: true, queue: [nonexistentId], pid: null, skip: 0 });
    const viaNonexistent = await a.as.query(api.account.exportPage, { table: "ledgerEvents", cursor: forgedNonexistent });
    expect(viaNonexistent.rows).toHaveLength(0);
    expect(viaNonexistent.cursor).toBeNull();

    // A's own real claim tree is completely unaffected by any of the above.
    const aTree = await seedClaimTree(t, a.userId);
    const ownPage = await a.as.query(api.account.exportPage, { table: "ledgerEvents" });
    expect(ownPage.rows).toHaveLength(1);
    expect((ownPage.rows[0] as { _id: unknown })._id).toBe(aTree.ledgerId);
  });

  it("the same forged-parent-id protection applies to purgeStep's delete-side twin (drainParentTable), even though its cursor is server-controlled", async () => {
    // Not itself exploitable (purgeStep's cursor is never client-supplied),
    // but the fix is shared code (`isOwnedParent`) -- this proves B's rows
    // truly survive even if a malicious/foreign id ever ended up in A's
    // progress cursor (defense in depth, documented in account.ts's module
    // docstring).
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const bTree = await seedClaimTree(t, b.userId);

    // Directly seed a tombstone for A whose progress cursor (server-only in
    // real life; hand-crafted here to prove the ownership check, not the
    // trust boundary, is what protects B) names B's claim in the `queue`.
    await t.run((ctx) =>
      ctx.db.insert("accountState", {
        userId: a.userId, status: "deleting", requestedAt: T0, attempts: 0,
        progress: { table: "ledgerEvents", cursor: JSON.stringify({ p: null, parentsDone: true, queue: [bTree.claimId], pid: null }) },
      }),
    );
    await t.mutation(internal.account.purgeStep, { userId: a.userId });

    // B's ledgerEvents/draft rows are untouched.
    const bLedger = await t.run((ctx) => ctx.db.get(bTree.ledgerId));
    expect(bLedger).not.toBeNull();
    const bDraft = await t.run((ctx) => ctx.db.get(bTree.draftId));
    expect(bDraft).not.toBeNull();
  });
});

describe("checkpoint 6b (D115) 6b-2 HIGH — via-parent queue always advances past an exhausted parent (F7)", () => {
  it("1 watch x 250 watchChecks: exportPage completes with exactly 250 unique rows and a null cursor within <= 3 pages", async () => {
    // Ported from da6b.test.ts's F7 first repro. CONFIRMED (git stash on
    // convex/account.ts only): before the fix, this loop hit its own 30-page
    // safety bound with MORE than 250 rows returned (duplicates) and a
    // cursor that never reached `null` -- `pages` was 30, `seen.size` was
    // 250 but `rowsReturned` exceeded it. After the fix, it converges in 2
    // pages (200 + 50).
    const t = setup();
    const a = await signedIn(t, "A");
    const TOTAL = 250;
    await t.run(async (ctx) => {
      const watchId = await ctx.db.insert("watches", { userId: a.userId, name: "W", productUrl: "https://acme.example/p", merchantDomain: "acme.example", status: "active", nextCheckAt: T0 });
      for (let i = 0; i < TOTAL; i++) {
        await ctx.db.insert("watchChecks", { watchId, userId: a.userId, observedCents: 100 + i, observedAt: T0 + i, sourceUrl: "https://acme.example/p" });
      }
    });

    const seen = new Set<string>();
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    let rowsReturned = 0;
    do {
      const page: { rows: any[]; cursor: string | null } = await a.as.query(api.account.exportPage, { table: "watchChecks", cursor: cursor ?? undefined });
      for (const row of page.rows) seen.add(row._id);
      rowsReturned += page.rows.length;
      cursor = page.cursor;
      pages++;
      expect(pages).toBeLessThanOrEqual(3);
    } while (cursor !== null);

    expect(pages).toBeLessThanOrEqual(3);
    expect(cursor).toBeNull();
    expect(seen.size).toBe(TOTAL);
    expect(rowsReturned).toBe(TOTAL); // no duplicates
  });

  it("purgeStep on the same shape still converges (unaffected by the fix -- a deleted row never comes back)", async () => {
    // Ported from da6b.test.ts's F7 second repro. This one ALREADY PASSED
    // before the fix (the module docstring calls out the read/delete
    // asymmetry explicitly) -- included as a no-regression check on the
    // shared `isOwnedParent`/pop-before-read refactor applied to
    // `drainParentTable` too.
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run(async (ctx) => {
      const watchId = await ctx.db.insert("watches", { userId: a.userId, name: "W", productUrl: "https://acme.example/p", merchantDomain: "acme.example", status: "active", nextCheckAt: T0 });
      for (let i = 0; i < 250; i++) {
        await ctx.db.insert("watchChecks", { watchId, userId: a.userId, observedCents: 100 + i, observedAt: T0 + i, sourceUrl: "https://acme.example/p" });
      }
    });
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    let done = false;
    let calls = 0;
    while (!done && calls < 100) {
      done = (await t.mutation(internal.account.purgeStep, { userId: a.userId })).done;
      calls++;
    }
    expect(done).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("watchChecks").collect())).toHaveLength(0);
  });
});

/** Minimal real-auth env, matching the reviewer's `realAuthEnv()` and `authFlow.test.ts`'s `beforeAll` (SITE_URL/CONVEX_SITE_URL/JWT_PRIVATE_KEY/ALERTS_INBOX_ID/E2E_SEED_ENABLED, so `internal.testing.seedUser` and a real `auth.signIn` action both work end to end). */
async function realAuthEnv() {
  process.env.SITE_URL = "https://recoup.example";
  process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
  process.env.E2E_SEED_ENABLED = "true";
  process.env.ALERTS_INBOX_ID = "inbox_test";
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
}

describe("checkpoint 6b (D115) 6b-4 HIGH — sign-in is gated on the tombstone (F2a/F2b)", () => {
  afterEach(() => {
    delete process.env.E2E_SEED_ENABLED;
  });

  it("F2a: a user who just called requestDeletion cannot sign in again -- same ConvexError a wrong password gets", async () => {
    // Ported from da6b.test.ts's F2, first repro ("a tombstoned (deleting)
    // user signs in again with the password and gets a brand-new session").
    // CONFIRMED (git-history-baseline swap on convex/auth.ts + convex/account.ts
    // only, tests kept in place -- see the task report for the exact method
    // used after a `git stash` collision with a concurrent teammate's own
    // stash operation on this shared working tree made that tool unsafe to
    // use again this session): before the fix, `result.tokens` was
    // non-null and a brand-new `authSessions` row existed, so this test's
    // assertions FAILED. After 6b-4a's `beforeSessionCreation` gate, it PASSES.
    await realAuthEnv();
    const t = setup();
    const email = "victim@example.com";
    const password = "E2ePassword123!";
    const { userId } = await t.action(internal.testing.seedUser, { email, password });
    const as = t.withIdentity({ subject: `${userId}|session` });

    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    expect((await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", userId)).first()))?.status).toBe("deleting");

    let caught: unknown;
    try {
      await t.action(api.auth.signIn, { provider: "password", params: { flow: "signIn", email, password } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<string>).data).toBe(WRONG_CREDENTIALS_MESSAGE);

    // No new session was minted (the pre-fix repro asserted exactly one,
    // proving a fresh sign-in succeeded THROUGH the revoke).
    const sessions = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect());
    expect(sessions).toHaveLength(0);
  });

  it("F2b: after the inbox-delete retry chain is exhausted, the account is fully gone (not a sign-in-forever zombie) -- old creds fail, the SAME email can sign up fresh", async () => {
    // Ported from da6b.test.ts's F2, second repro ("after 5 failed inbox
    // deletes the auth rows stay forever: sign-in still works, sign-up with
    // the same email is refused"). CONFIRMED (same swap method as F2a):
    // before either fix, `signIn.tokens` was non-null (sign-in still
    // worked) and the sign-up attempt threw `ACCOUNT_EXISTS_MESSAGE` (the
    // stale account blocked a fresh one forever) -- both assertions below
    // FAILED. After 6b-4a (sign-in gated) AND 6b-4b (`purgeAuth` runs once
    // the retry chain exhausts, not just on success), sign-in fails the
    // ORDINARY way (no such account -- `purgeAuth` really did delete it,
    // not merely "sign-in refused for a tombstoned row that still exists")
    // and a fresh sign-up at the same address succeeds.
    await realAuthEnv();
    const t = setup();
    const email = "stuck@example.com";
    const password = "E2ePassword123!";
    const { userId } = await t.action(internal.testing.seedUser, { email, password });
    await t.run((ctx) => ctx.db.insert("profiles", { userId, inboxId: "inbox-stuck", inboxEmail: "x@agentmail.to" }));
    vi.spyOn(inboxTransport, "deleteInbox").mockRejectedValue(new Error("502"));
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(25 * 3_600_000);
      await t.finishInProgressScheduledFunctions();
    }

    const row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", userId)).first());
    expect(row?.attempts).toBe(5);
    // 6b-4b: "deleted", not "deleting" -- the retry chain is dead, but
    // Recoup's own side (auth rows included) is fully wound down anyway.
    expect(row?.status).toBe("deleted");
    expect(row?.inboxDeleted).toBe(false); // never silently rounded up.

    expect(await t.run((ctx) => ctx.db.get(userId))).toBeNull(); // purgeAuth really ran.

    let signInErr: unknown;
    try {
      await t.action(api.auth.signIn, { provider: "password", params: { flow: "signIn", email, password } });
    } catch (err) {
      signInErr = err;
    }
    expect(signInErr).toBeInstanceOf(ConvexError);
    expect((signInErr as ConvexError<string>).data).toBe(WRONG_CREDENTIALS_MESSAGE);

    const signUp = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signUp", email, password } });
    expect(signUp.tokens).toBeNull(); // verification flow started, not an ACCOUNT_EXISTS_MESSAGE throw.
    const users = await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).collect());
    expect(users).toHaveLength(1);
    expect(users[0]!._id).not.toBe(userId); // a genuinely new account, not a resurrection of the old one.
  }, 20_000);

  it("a non-tombstoned user's sign-in is unaffected by the gate", async () => {
    await realAuthEnv();
    const t = setup();
    const email = "fine@example.com";
    const password = "E2ePassword123!";
    await t.action(internal.testing.seedUser, { email, password });
    const result = await t.action(api.auth.signIn, { provider: "password", params: { flow: "signIn", email, password } });
    expect(result.tokens).not.toBeNull();
  });
});

describe("checkpoint 6b (D115) 6b-6 MEDIUM — byte-aware paging for processedEvents (F6b/F6c)", () => {
  /** 3-byte-per-char CJK payloads at `inbound.ts`'s `MAX_TEXT_CHARS` (60,000), matching da6b.test.ts's `seedEvents`. */
  async function seedCjkEvents(t: ReturnType<typeof setupWithLimits>, userId: Id<"users">, count: number) {
    const text = "語".repeat(60_000);
    for (let batch = 0; batch * 25 < count; batch++) {
      await t.run(async (ctx) => {
        for (let i = batch * 25; i < Math.min(count, batch * 25 + 25); i++) {
          await ctx.db.insert("processedEvents", { externalId: `e-${i}`, kind: "agentmail.message.received", status: "succeeded", attempts: 1, userId, payload: { subject: "s", from: "f", text } });
        }
      });
    }
  }

  it("F6b: a 3-byte UTF-8 (CJK) processedEvents page no longer exceeds the 16 MiB transaction read limit for exportPage", async () => {
    // Ported from da6b.test.ts's F6, second repro ("3-byte UTF-8 text (CJK):
    // the same page exceeds the 16 MiB transaction read limit"). CONFIRMED
    // (git-history-baseline swap on convex/account.ts + convex/limits.ts
    // only): before the fix (`EXPORT_PAGE` = 200 used for this table too),
    // this call THREW with a message matching /bytes|limit|16/i -- this
    // test's `expect(...).resolves` below FAILED (it threw). After the fix
    // (`PROCESSED_EVENTS_PAGE` = 25), it resolves normally.
    const t = setupWithLimits();
    const a = await signedIn(t, "A");
    await seedCjkEvents(t, a.userId, 200);

    const page = await a.as.query(api.account.exportPage, { table: "processedEvents", cursor: JSON.stringify({ s: 2, c: null }) });
    expect(page.rows.length).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
    expect(page.rows.length).toBeGreaterThan(0);

    // Walk every remaining page for this status; must converge (no throw) and collect every seeded row.
    const seen = new Set<string>();
    for (const row of page.rows) seen.add((row as { _id: string })._id);
    let cursor = page.cursor;
    let pages = 1;
    while (cursor !== null) {
      const next: { rows: any[]; cursor: string | null } = await a.as.query(api.account.exportPage, { table: "processedEvents", cursor });
      for (const row of next.rows) seen.add(row._id);
      expect(next.rows.length).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
      cursor = next.cursor;
      pages++;
      expect(pages).toBeLessThan(30); // safety bound
    }
    expect(seen.size).toBe(200);
  });

  it("F6c: purgeStep on the same CJK shape also stays under the read limit and converges (purge no longer stalls on this table)", async () => {
    // Ported from da6b.test.ts's F6, third repro ("purgeStep on the same CJK
    // shape also exceeds the read limit (purge stalls on this table
    // forever)"). CONFIRMED (same swap method): before the fix, the
    // `t.mutation(internal.account.purgeStep, ...)` call below THREW
    // matching /bytes|limit|16/i -- this test's success-path assertions
    // FAILED. After the fix, it converges.
    const t = setupWithLimits();
    const a = await signedIn(t, "A");
    await seedCjkEvents(t, a.userId, 200);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first();
      await ctx.db.patch(row!._id, { progress: { table: "processedEvents", cursor: JSON.stringify({ s: 2, c: null }) } });
    });

    let done = false;
    let calls = 0;
    while (!done && calls < 30) {
      done = (await t.mutation(internal.account.purgeStep, { userId: a.userId })).done;
      calls++;
    }
    expect(done).toBe(true);
    expect(calls).toBeGreaterThan(1); // proves it genuinely paged (200 rows / 25-per-page)
    const remaining = await t.run((ctx) => ctx.db.query("processedEvents").withIndex("by_user_status", (q) => q.eq("userId", a.userId).eq("status", "succeeded")).collect());
    expect(remaining).toHaveLength(0);
  });
});

describe("checkpoint 6b (D115) 6b-4c — reDriveStuckDeletions cron re-drive", () => {
  it("a `deleting` row older than STUCK_DELETION_AGE_MS with no live scheduled purge job gets re-driven and finishes", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);

    // Simulate a chain that died: a tombstone with no scheduled job at all
    // (e.g. a crash between `recordPurgeFailure` and its own retry's
    // `ctx.scheduler.runAfter` call) -- `activePurgeJobId` absent, `inboxId`
    // persisted (as `requestDeletion` would have left it), `requestedAt` well
    // past the age threshold.
    await t.run((ctx) =>
      ctx.db.insert("accountState", {
        userId: a.userId, status: "deleting", requestedAt: T0 - STUCK_DELETION_AGE_MS - 1, attempts: 0, inboxId: `inbox-${a.userId}`,
      }),
    );

    const before = await t.query(internal.account.stuckDeletions, {});
    expect(before).toEqual({ stuck: 1, deleting: 1 });

    const result = await t.mutation(internal.account.reDriveStuckDeletions, {});
    expect(result.rescheduled).toBe(1);

    const row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(row?.activePurgeJobId).toBeDefined();

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const finished = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(finished?.status).toBe("deleted");
    expect(await t.run((ctx) => ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).toHaveLength(0);

    const after = await t.query(internal.account.stuckDeletions, {});
    expect(after).toEqual({ stuck: 0, deleting: 0 });
  });

  it("a live chain (a genuinely pending purge job) is not double-scheduled", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    // Force the row old enough to be a re-drive CANDIDATE by age, but its
    // `activePurgeJobId` (set by `requestDeletion` itself) still points at
    // the genuinely-pending `purge` job requestDeletion just scheduled.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first();
      await ctx.db.patch(row!._id, { requestedAt: T0 - STUCK_DELETION_AGE_MS - 1 });
    });

    const result = await t.mutation(internal.account.reDriveStuckDeletions, {});
    expect(result.rescheduled).toBe(0); // the live chain is left alone.

    const pending = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const pendingPurgeJobs = pending.filter(
      (r) => (r.state.kind === "pending" || r.state.kind === "inProgress") && r.name.includes("purge") && !r.name.includes("purgeStep") && !r.name.includes("purgeAuth"),
    );
    expect(pendingPurgeJobs).toHaveLength(1); // still exactly one -- not doubled.
  });

  it("reschedules at most STUCK_DELETION_REDRIVE_PAGE stuck rows per run", async () => {
    const t = setup();
    const count = STUCK_DELETION_REDRIVE_PAGE + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        const userId = await ctx.db.insert("users", { name: `Stuck ${i}` });
        await ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0 - STUCK_DELETION_AGE_MS - 1, attempts: 0 });
      }
    });

    const result = await t.mutation(internal.account.reDriveStuckDeletions, {});
    expect(result.rescheduled).toBe(STUCK_DELETION_REDRIVE_PAGE);
  });
});

describe("checkpoint 6b (D115) 6b-8 MEDIUM (tests) — guards previously untested", () => {
  it("purgeAuth re-revokes a session minted between requestDeletion and purge (through some path other than the guarded signIn)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    // A session inserted directly bypasses `beforeSessionCreation` entirely
    // -- exactly the "some other route this app does not control" case
    // `purgeAuth`'s defensive re-sweep exists for.
    const lateSessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId: a.userId, expirationTime: T0 + 999_999 }));
    await t.run((ctx) => ctx.db.insert("authRefreshTokens", { sessionId: lateSessionId, expirationTime: T0 + 999_999 }));

    await t.mutation(internal.account.purgeAuth, { userId: a.userId });

    const sessions = await t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", a.userId)).collect());
    expect(sessions).toHaveLength(0);
    const tokens = await t.run((ctx) => ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", lateSessionId)).collect());
    expect(tokens).toHaveLength(0);
  });

  it("purgeAuth deletes authRateLimits rows keyed by both the authAccounts id and the raw email", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.patch(a.userId, { email: "rl@example.com" }));
    const accountId = await t.run((ctx) => ctx.db.insert("authAccounts", { userId: a.userId, provider: "password", providerAccountId: "rl@example.com", secret: "hash" }));
    const byAccountId = await t.run((ctx) => ctx.db.insert("authRateLimits", { identifier: accountId, attemptsLeft: 0, lastAttemptTime: T0 }));
    const byEmailId = await t.run((ctx) => ctx.db.insert("authRateLimits", { identifier: "rl@example.com", attemptsLeft: 0, lastAttemptTime: T0 }));

    await t.mutation(internal.account.purgeAuth, { userId: a.userId });

    expect(await t.run((ctx) => ctx.db.get(byAccountId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(byEmailId))).toBeNull();
  });

  it("inbox-delete backoff timings match the contract exactly (1m, 10m, 1h, 6h, 24h), asserted from each retry's own _scheduled_functions.scheduledTime", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    vi.spyOn(inboxTransport, "deleteInbox").mockRejectedValue(new Error("network unreachable"));
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const expectedDeltas = [60_000, 600_000, 3_600_000, 21_600_000, 86_400_000];

    function findPurgeJob(jobs: Awaited<ReturnType<typeof t.run<any>>>) {
      return (jobs as any[]).find(
        (r) => (r.state.kind === "pending" || r.state.kind === "inProgress") && r.name.includes("purge") && !r.name.includes("purgeStep") && !r.name.includes("purgeAuth"),
      );
    }

    // Attempt 1: the initial `requestDeletion`-scheduled job (runAfter 0) fires; its OWN failure schedules the first retry at T0 + 1 + 60,000.
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    let jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    let retry = findPurgeJob(jobs);
    expect(retry, "retry 1").toBeDefined();
    expect(retry.scheduledTime).toBe(T0 + 1 + expectedDeltas[0]!);

    // Attempts 2-5: each retry, once it fires (and fails again), schedules the NEXT one at its own firing time + the next backoff step.
    let firedAt = T0 + 1 + expectedDeltas[0]!;
    for (let i = 1; i < 5; i++) {
      vi.advanceTimersByTime(expectedDeltas[i - 1]!);
      await t.finishInProgressScheduledFunctions();
      if (i < 4) {
        jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
        retry = findPurgeJob(jobs);
        expect(retry, `retry ${i + 1}`).toBeDefined();
        expect(retry.scheduledTime).toBe(firedAt + expectedDeltas[i]!);
      }
      firedAt += expectedDeltas[i]!;
    }

    // After the 5th attempt, no retry is scheduled -- the chain is exhausted and purgeAuth/finishPurge already ran.
    const finalJobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(findPurgeJob(finalJobs)).toBeUndefined();
    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.attempts).toBe(5);
    expect(state?.status).toBe("deleted");
  }, 20_000);
});

// =============================================================================
// T18.4 (D115 6b-5) wiring: `purge` also drains the AgentMail component's own
// per-inbox rows via `mailPurge.purgeInboxData`, wired here per that module's
// own "Call site" instruction. Seeding reuses `mailPurge.test.ts`'s approach
// (component rows are seeded through the component's own public/internal
// functions, not `t.run`, since a registered component's tables are a
// separate mock backend invisible to `ctx.db` here).
// =============================================================================

describe("T18.4 (D115 6b-5) wiring — purge drains the AgentMail component's mail data too", () => {
  const RUNTIME_CONFIG = { retryAttempts: 1, initialBackoffMs: 10 };

  async function seedInboundAndEvents(t: T, inboxId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await t.mutation(components.agentmail.lib.handleEvent, {
        config: RUNTIME_CONFIG,
        event: {
          type: "event",
          event_type: "message.received",
          event_id: `${inboxId}-evt-${i}`,
          message: {
            inbox_id: inboxId,
            thread_id: `${inboxId}-thread-${i}`,
            message_id: `${inboxId}-msg-${i}`,
            from: "sender@example.com",
            to: ["recipient@example.com"],
            subject: `Test ${i}`,
            text: "hello",
            timestamp: new Date().toISOString(),
          },
        },
      });
    }
  }

  async function seedOutbound(t: T, inboxId: string, count: number) {
    for (let i = 0; i < count; i++) {
      await t.mutation(components.agentmail.lib.enqueueSend, {
        config: RUNTIME_CONFIG,
        inboxId,
        kind: "send" as const,
        payload: { to: "dest@example.com", subject: `out ${i}`, text: "hi" },
      });
    }
  }

  it("a purged user's AgentMail component rows (inboundMessages/outboundMessages/events) are gone, and mailDataPurged is reported true", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const inboxId = `inbox-${a.userId}`;
    await t.run((ctx) => ctx.db.insert("profiles", { userId: a.userId, inboxId, inboxEmail: "a@example.com" }));
    await seedInboundAndEvents(t, inboxId, 5); // 5 inboundMessages + 5 events
    await seedOutbound(t, inboxId, 2); // 2 outboundMessages

    // A second, unrelated inbox must be left untouched.
    const otherInboxId = "inbox-other";
    await seedInboundAndEvents(t, otherInboxId, 3);

    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const remainingA = await t.query(components.agentmail.lib.listInboundMessages, { inboxId });
    expect(remainingA).toHaveLength(0);
    const remainingOther = await t.query(components.agentmail.lib.listInboundMessages, { inboxId: otherInboxId });
    expect(remainingOther).toHaveLength(3); // untouched.

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
    expect(state?.mailDataPurged).toBe(true);
    // `deletionStatus` (still-open-tab path, `getAuthUserId` not `requireUserId`) surfaces the same field.
    const status = await a.as.query(api.account.deletionStatus, {});
    expect(status?.status).toBe("deleted");
    expect(status?.mailDataPurged).toBe(true);
  });

  it("skips the component purge entirely when the user never provisioned an inbox (no inboxId)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
    expect(state?.mailDataPurged).toBeUndefined(); // never set -- there was nothing to purge, and nothing claims otherwise.
  });

  it("a purge run's mail-data result is reported truthfully, not hidden, when complete:false (recordMailDataPurged wiring, tested directly)", async () => {
    // Directly exercises the wiring's own recording step (`complete: false`)
    // without needing to actually exhaust `mailPurge.purgeInboxData`'s
    // internal MAX_ITERATIONS bound (tens of thousands of rows -- impractical
    // for a unit test): the wiring in `account.ts`'s `purge` calls
    // `internal.account.recordMailDataPurged` with exactly whatever
    // `purgeInboxData` returned, so testing that recording step in isolation
    // proves the "not hidden" contract for both outcomes.
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.insert("accountState", { userId: a.userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    await t.mutation(internal.account.recordMailDataPurged, { userId: a.userId, complete: false });
    let row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(row?.mailDataPurged).toBe(false); // not coerced to true, not left undefined.

    await t.mutation(internal.account.recordMailDataPurged, { userId: a.userId, complete: true });
    row = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(row?.mailDataPurged).toBe(true);
  });
});

describe("checkpoint 6b (D115) 6b-8 — inboxTransport.deleteInbox (full unit coverage, real fetch stubbed)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENTMAIL_API_KEY;
    delete process.env.AGENTMAIL_BASE_URL;
  });

  it("a 404 response is treated as success (already gone)", async () => {
    process.env.AGENTMAIL_API_KEY = "am-test";
    const fetchSpy = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(inboxTransport.deleteInbox("inbox-1")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a 5xx response throws (failure), and the response body never appears in the thrown message", async () => {
    process.env.AGENTMAIL_API_KEY = "am-test";
    const fetchSpy = vi.fn(async () => new Response("SECRET body: leaked-detail", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);
    let caught: unknown;
    try {
      await inboxTransport.deleteInbox("inbox-1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).not.toContain("SECRET");
    expect(message).not.toContain("leaked-detail");
    expect(message).toContain("502");
  });

  it("sends an Authorization header (checked by NAME only -- the value is never asserted/printed)", async () => {
    process.env.AGENTMAIL_API_KEY = "am-super-secret-key";
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.has("Authorization")).toBe(true);
      return new Response("", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    await expect(inboxTransport.deleteInbox("inbox-1")).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("missing AGENTMAIL_API_KEY fails WITHOUT making any network call", async () => {
    delete process.env.AGENTMAIL_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(inboxTransport.deleteInbox("inbox-1")).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a permanent (non-404) failure's sanitized lastError on the accountState row never echoes the raw response body", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await seedFullAccount(t, a.userId, "a@example.com");
    process.env.AGENTMAIL_API_KEY = "am-test";
    const fetchSpy = vi.fn(async () => new Response("SECRET body: leaked-detail, auth-header-abc123", { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);
    vi.spyOn(inboxTransport, "deleteInbox"); // keep the real implementation but track calls (fetch itself is stubbed above).

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.lastError).toBeDefined();
    expect(state?.lastError).not.toContain("SECRET");
    expect(state?.lastError).not.toContain("leaked-detail");
    expect(state?.lastError).not.toContain("auth-header-abc123");
  });
});

describe("checkpoint 6b (D115) LOW — purgeAuth resets the deleted email's named rate limits", () => {
  it("authAttempt/authSignUp/authMailPerEmail are all back at full capacity for the deleted email after purgeAuth", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const email = "ratelimited@example.com";
    await t.run((ctx) => ctx.db.patch(a.userId, { email }));

    await t.run(async (ctx) => {
      for (let i = 0; i < 10; i++) await rateLimiter.limit(ctx, "authAttempt", { key: email });
      for (let i = 0; i < 20; i++) await rateLimiter.limit(ctx, "authSignUp", { key: email });
      for (let i = 0; i < 3; i++) await rateLimiter.limit(ctx, "authMailPerEmail", { key: email });
    });
    const before = await t.run(async (ctx) => ({
      authAttempt: await rateLimiter.check(ctx, "authAttempt", { key: email }),
      authSignUp: await rateLimiter.check(ctx, "authSignUp", { key: email }),
      authMailPerEmail: await rateLimiter.check(ctx, "authMailPerEmail", { key: email }),
    }));
    expect(before.authAttempt.ok).toBe(false);
    expect(before.authSignUp.ok).toBe(false);
    expect(before.authMailPerEmail.ok).toBe(false);

    await t.mutation(internal.account.purgeAuth, { userId: a.userId });

    const after = await t.run(async (ctx) => ({
      authAttempt: await rateLimiter.check(ctx, "authAttempt", { key: email }),
      authSignUp: await rateLimiter.check(ctx, "authSignUp", { key: email }),
      authMailPerEmail: await rateLimiter.check(ctx, "authMailPerEmail", { key: email }),
    }));
    expect(after.authAttempt.ok).toBe(true);
    expect(after.authSignUp.ok).toBe(true);
    expect(after.authMailPerEmail.ok).toBe(true);
  });
});

describe("T18.5 (D124 B1): purgeStep's mailLog step purges the shared alerts inbox's per-message component rows", () => {
  const RUNTIME_CONFIG = { retryAttempts: 1, initialBackoffMs: 10 };

  /** Manual bounded drive of `purgeStep`, mirroring the checkpoint-6c reviewer's own `purgeToCompletion` helper -- deliberately NOT `finishAllScheduledFunctions`/`vi.runAllTimers`, which would also run `enqueueSend`'s real send pipeline for every OTHER already-`sent` seed in this file's `SAMPLE_OUTBOUND_ID` and spin through workpool's self-rescheduling status report forever under fake timers. `purgeStep` is a plain mutation; calling it directly never touches the scheduler at all. */
  async function purgeToCompletion(t: T, userId: Id<"users">) {
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      done = (await t.mutation(internal.account.purgeStep, { userId })).done;
    }
    expect(done).toBe(true);
  }

  /**
   * Drives one `enqueueSend`'d outbound message to a real terminal status
   * (`agentmailMessageId` set, exactly like production's `onSendComplete`)
   * without `vi.runAllTimers`/`finishAllScheduledFunctions` -- a bounded
   * `advance + finishInProgressScheduledFunctions` loop instead, which
   * drains only what is ALREADY due rather than following workpool's own
   * self-rescheduling status-report timer forever. Requires `global.fetch`
   * stubbed by the caller (a 2xx JSON response with `message_id`/`thread_id`
   * and an `application/json` content-type -- `agentmailFetch` returns
   * `null` for a response with no matching content-type).
   */
  async function driveSend(t: T, outboundId: GenericId<"outboundMessages">) {
    let status: { status: string; agentmailMessageId: string | null } | null = null;
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(50);
      await t.finishInProgressScheduledFunctions();
      status = await t.query(components.agentmail.lib.getOutboundStatus, { outboundId });
      if (status && status.status !== "pending") return status;
    }
    throw new Error(`driveSend: outbound ${outboundId} never left pending (last: ${JSON.stringify(status)})`);
  }

  function stubSuccessfulSend(messageId: string, threadId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message_id: messageId, thread_id: threadId }), { status: 200, headers: { "content-type": "application/json" } })),
    );
  }

  it("before: an alerts-inbox outboundMessages row for the user's price-drop alert (plus its delivery event) survives purgeStep untouched [FAILS on pre-T18.5 account.ts]", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const alertsInbox = "inbox_alerts_shared";
    stubSuccessfulSend("mid-alert-1", "th-alert-1");

    // The exact shape `notify.sendDrop` produces: a send from the SHARED
    // alerts inbox to the user's own personal address.
    const outboundId = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG, inboxId: alertsInbox, kind: "send" as const,
      payload: { to: "victim.personal@gmail.example", subject: "Price drop: Jacket", text: "now $70" },
    });
    await driveSend(t, outboundId);
    // The delivery webhook that follows a real send, keyed to the same message id `onSendComplete` just stamped.
    await t.mutation(components.agentmail.lib.handleEvent, {
      config: RUNTIME_CONFIG,
      event: { type: "event", event_type: "message.delivered", event_id: "deliv-alert-1", delivery: { inbox_id: alertsInbox, message_id: "mid-alert-1", thread_id: "th-alert-1", to: ["victim.personal@gmail.example"] } },
    });

    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:w1:7000", kind: "price_drop", to: "victim.personal@gmail.example",
        subject: "Price drop: Jacket", status: "queued", outboundId, attempt: 0, nextCheckAt: T0 + 600_000,
      }),
    );

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, a.userId);

    // Drain the shared alerts inbox's OWN wholesale purge to see what, if
    // anything, is left attributable to this user (the reviewer's own
    // check, da6c.test.ts "A2 mailPurge probes" -- ported here as the
    // regression assertion instead of the original defect-confirming one).
    let alertsDeleted = 0;
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r: { cursor: string | null; deleted: number } = await t.mutation(components.agentmail.lib.purgeInbox, { inboxId: alertsInbox, cursor });
      alertsDeleted += r.deleted;
      if (r.cursor === null) break;
      cursor = r.cursor;
    }
    expect(alertsDeleted).toBe(0);
  });

  it("after: purgeStep's mailLog step deletes the outbound row and its events by id, and never touches another user's alert in the same shared inbox", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const alertsInbox = "inbox_alerts_shared";

    stubSuccessfulSend("mid-a", "th-a");
    const outboundIdA = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG, inboxId: alertsInbox, kind: "send" as const,
      payload: { to: "a.personal@gmail.example", subject: "Price drop: Jacket", text: "now $70" },
    });
    await driveSend(t, outboundIdA);
    await t.mutation(components.agentmail.lib.handleEvent, {
      config: RUNTIME_CONFIG,
      event: { type: "event", event_type: "message.delivered", event_id: "deliv-a", delivery: { inbox_id: alertsInbox, message_id: "mid-a", thread_id: "th-a", to: ["a.personal@gmail.example"] } },
    });
    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:wa:7000", kind: "price_drop", to: "a.personal@gmail.example",
        subject: "Price drop: Jacket", status: "queued", outboundId: outboundIdA, attempt: 0, nextCheckAt: T0 + 600_000,
      }),
    );

    // B's own alert in the SAME shared inbox must survive A's deletion.
    stubSuccessfulSend("mid-b", "th-b");
    const outboundIdB = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG, inboxId: alertsInbox, kind: "send" as const,
      payload: { to: "b.personal@gmail.example", subject: "Price drop: Boots", text: "now $40" },
    });
    await driveSend(t, outboundIdB);
    await t.mutation(components.agentmail.lib.handleEvent, {
      config: RUNTIME_CONFIG,
      event: { type: "event", event_type: "message.delivered", event_id: "deliv-b", delivery: { inbox_id: alertsInbox, message_id: "mid-b", thread_id: "th-b", to: ["b.personal@gmail.example"] } },
    });
    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: b.userId, dedupeKey: "watch:wb:4000", kind: "price_drop", to: "b.personal@gmail.example",
        subject: "Price drop: Boots", status: "queued", outboundId: outboundIdB, attempt: 0, nextCheckAt: T0 + 600_000,
      }),
    );

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, a.userId);

    // A's mailLog row itself is gone (ordinary table purge).
    expect(await t.run((ctx) => ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).toHaveLength(0);

    // A's component row is gone...
    expect(await t.query(components.agentmail.lib.getOutboundStatus, { outboundId: outboundIdA })).toBeNull();
    // ...B's own row is untouched by A's purge (checked BEFORE the
    // destructive drain below, which would otherwise delete it too as part
    // of counting what remains -- `purgeInbox` deletes what it reads).
    expect(await t.query(components.agentmail.lib.getOutboundStatus, { outboundId: outboundIdB })).not.toBeNull();
    // B's own mailLog row (Recoup's own bookkeeping) is untouched either way.
    expect(await t.run((ctx) => ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", b.userId)).collect())).toHaveLength(1);

    // Finally, drain the shared alerts inbox's OWN wholesale purge (destructive)
    // to confirm A's event is really gone via the same `by_message` route
    // `purgeOutbound` uses, and that exactly B's 2 rows (its own outbound
    // message + its own delivery event) are what is left -- proves A's purge
    // never touched B's alert.
    let alertsDeleted = 0;
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r: { cursor: string | null; deleted: number } = await t.mutation(components.agentmail.lib.purgeInbox, { inboxId: alertsInbox, cursor });
      alertsDeleted += r.deleted;
      if (r.cursor === null) break;
      cursor = r.cursor;
    }
    expect(alertsDeleted).toBe(2);
  });

  it("bounded: a mailLog row whose outboundId no longer resolves to a component row (already purged, or never a real one) is still deleted cleanly, no throw", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:wg:1", kind: "price_drop", to: "gone@example.com",
        subject: "Price drop", status: "queued", outboundId: SAMPLE_OUTBOUND_ID as never, attempt: 0, nextCheckAt: T0 + 600_000,
      }),
    );
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, a.userId);
    expect(await t.run((ctx) => ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).toHaveLength(0);
  });
});

describe("T18.6 (D129 B-9/B-7): checkpoint 6d remainder -- the component's own daily cleanupFinalizedOutbound sweep must not orphan events, and deleteMailLogPage must not delete a row purgeOutbound still reports remaining:true for", () => {
  const RUNTIME_CONFIG = { retryAttempts: 1, initialBackoffMs: 10 };

  async function purgeToCompletion(t: T, userId: Id<"users">) {
    let done = false;
    for (let i = 0; i < 100 && !done; i++) {
      done = (await t.mutation(internal.account.purgeStep, { userId })).done;
    }
    expect(done).toBe(true);
  }

  async function driveSend(t: T, outboundId: GenericId<"outboundMessages">) {
    let status: { status: string; agentmailMessageId: string | null } | null = null;
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(50);
      await t.finishInProgressScheduledFunctions();
      status = await t.query(components.agentmail.lib.getOutboundStatus, { outboundId });
      if (status && status.status !== "pending") return status;
    }
    throw new Error(`driveSend: outbound ${outboundId} never left pending (last: ${JSON.stringify(status)})`);
  }

  function stubSuccessfulSend(messageId: string, threadId: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message_id: messageId, thread_id: threadId }), { status: 200, headers: { "content-type": "application/json" } })),
    );
  }

  /** Drains the shared alerts inbox wholesale (destructive) via the component's own purgeInbox and reports how many rows were still there. */
  async function alertsResidue(t: T, inboxId: string): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const r: { cursor: string | null; deleted: number } = await t.mutation(components.agentmail.lib.purgeInbox, { inboxId, cursor });
      deleted += r.deleted;
      if (r.cursor === null) break;
      cursor = r.cursor;
    }
    return deleted;
  }

  it("B-9: an alert older than the component's own 7-day finalized-outbound retention is reclaimed by cleanupFinalizedOutbound at day 8 without orphaning its delivery event; account deletion at day 30 leaves nothing in the shared inbox", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const alertsInbox = "inbox_alerts_shared";
    stubSuccessfulSend("mid-old", "th-old");

    const outboundId = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG, inboxId: alertsInbox, kind: "send" as const,
      payload: { to: "victim.personal@gmail.example", subject: "Price drop: Jacket", text: "now $70" },
    });
    await driveSend(t, outboundId);
    await t.mutation(components.agentmail.lib.handleEvent, {
      config: RUNTIME_CONFIG,
      event: { type: "event", event_type: "message.delivered", event_id: "deliv-old", delivery: { inbox_id: alertsInbox, message_id: "mid-old", thread_id: "th-old", to: ["victim.personal@gmail.example"] } },
    });
    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "watch:w1:7000", kind: "price_drop", to: "victim.personal@gmail.example",
        subject: "Price drop: Jacket", status: "sent", outboundId, agentmailMessageId: "mid-old", providerStatus: "delivered", sentAt: T0, attempt: 0,
      }),
    );

    // Day 8: the component's own daily sweep reclaims the finalized row (crons.ts "agentmail outbound cleanup").
    vi.setSystemTime(T0 + 8 * 86_400_000);
    await t.mutation(internal.mailPurge.cleanupFinalizedOutbound, {});
    expect(await t.query(components.agentmail.lib.getOutboundStatus, { outboundId })).toBeNull();

    // Day 30: the user deletes their account -- well inside mailLog's own 90-day retention.
    vi.setSystemTime(T0 + 30 * 86_400_000);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, a.userId);

    const residue = await alertsResidue(t, alertsInbox);
    console.log("[T18.6 B-9] shared-inbox rows left for the deleted user's >7-day-old alert:", residue);
    expect(residue).toBe(0);
  });

  it("B-7: a mailLog row whose outbound has more events than one purgeStep call's attempt budget can clear is left in place, not silently deleted", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const alertsInbox = "inbox_alerts_shared";
    stubSuccessfulSend("mid-flood", "th-flood");

    const outboundId = await t.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG, inboxId: alertsInbox, kind: "send" as const,
      payload: { to: "a@x.example", subject: "Price drop", text: "t" },
    });
    await driveSend(t, outboundId);
    for (let i = 0; i < 1001; i++) {
      await t.mutation(components.agentmail.lib.handleEvent, {
        config: RUNTIME_CONFIG,
        event: { type: "event", event_type: "message.delivered", event_id: `fl-${i}`, delivery: { inbox_id: alertsInbox, message_id: "mid-flood", thread_id: "th-flood" } },
      });
    }
    await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId: a.userId, dedupeKey: "k-flood", kind: "price_drop", to: "a@x.example", subject: "Price drop",
        status: "sent", outboundId, agentmailMessageId: "mid-flood", attempt: 0, nextCheckAt: T0,
      }),
    );

    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await purgeToCompletion(t, a.userId);

    const mailLogLeft = await t.run((ctx) => ctx.db.query("mailLog").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect());
    console.log("[T18.6 B-7] mailLog rows left after an outbound with 1001 events:", mailLogLeft.length);
    expect(mailLogLeft).toHaveLength(1);
  }, 60_000);
});

// ===========================================================================
// M14 (contract rev 5 §2.6, §8; SEC-DEL-1/2/3): the transaction-recovery
// tables in export and purge. Everything below is additive: no test above
// this line was changed.
// ===========================================================================

type AnyValidator = {
  kind: string;
  tableName?: string;
  fields?: Record<string, AnyValidator>;
  element?: AnyValidator;
  members?: AnyValidator[];
  key?: AnyValidator;
  value?: AnyValidator;
};
type SchemaTables = Record<string, { validator: AnyValidator; " indexes"(): { indexDescriptor: string; fields: string[] }[] }>;
const TABLES = schema.tables as unknown as SchemaTables;

/** Every `v.id(<table>)` reachable from `validator`, with a readable path (`binding.attachments[].evidenceId`). */
function idFields(validator: AnyValidator, path = ""): Array<{ path: string; target: string }> {
  switch (validator.kind) {
    case "id":
      return [{ path, target: validator.tableName! }];
    case "object":
      return Object.entries(validator.fields ?? {}).flatMap(([k, f]) => idFields(f, path ? `${path}.${k}` : k));
    case "array":
      return idFields(validator.element!, `${path}[]`);
    case "union":
      return (validator.members ?? []).flatMap((m) => idFields(m, path));
    case "record":
      return [...idFields(validator.key!, `${path}{key}`), ...idFields(validator.value!, `${path}{}`)];
    default:
      return [];
  }
}

function hasUserIdField(validator: AnyValidator): boolean {
  if (validator.kind === "union") return (validator.members ?? []).some(hasUserIdField);
  return validator.kind === "object" && validator.fields?.userId !== undefined;
}

describe("M14 SEC-DEL-1 — export and purge cover every user-owned table (reflective over schema.tables)", () => {
  it("every schema table with a userId field is in PURGE_STEPS and in the export list (usage is the one documented export exemption)", () => {
    const withUserId = Object.keys(TABLES).filter((t) => hasUserIdField(TABLES[t].validator));
    const purged = new Set<string>(PURGE_STEPS);
    const exported = new Set<string>(EXPORT_TABLE_NAMES);

    // The exemption lists are pinned HERE, not only in account.ts: widening either one means editing this test.
    expect(Object.keys(EXPORT_EXEMPT).sort()).toEqual(["usage"]);
    expect(Object.keys(OUTSIDE_PURGE_STEPS).sort()).toEqual(["accountState", "authAccounts", "authSessions"]);

    const missingFromPurge = withUserId.filter((t) => !purged.has(t) && !(t in OUTSIDE_PURGE_STEPS));
    const missingFromExport = withUserId.filter((t) => !exported.has(t) && !(t in EXPORT_EXEMPT) && !(t in OUTSIDE_PURGE_STEPS));
    expect(missingFromPurge).toEqual([]);
    expect(missingFromExport).toEqual([]);

    // Every exempt name is a real userId table (a stale exemption would hide nothing but reads as coverage).
    for (const t of [...Object.keys(EXPORT_EXEMPT), ...Object.keys(OUTSIDE_PURGE_STEPS)]) expect(withUserId).toContain(t);
    // Nothing is listed twice.
    expect(new Set(PURGE_STEPS).size).toBe(PURGE_STEPS.length);
    expect(new Set(EXPORT_TABLE_NAMES).size).toBe(EXPORT_TABLE_NAMES.length);
  });

  it("PURGE_STEPS deletes children before parents: every id edge between two purged tables points forward, except the documented back-edges", () => {
    const position = new Map<string, number>(PURGE_STEPS.map((t, i) => [t, i]));
    const backEdges: string[] = [];
    for (const table of PURGE_STEPS) {
      for (const { path, target } of idFields(TABLES[table].validator)) {
        if (target === table || !position.has(target)) continue; // self-links and tables purged elsewhere (users, _storage, _scheduled_functions)
        if (position.get(target)! < position.get(table)!) backEdges.push(`${table}.${path} -> ${target}`);
      }
    }
    // Each back-edge is a cycle or a Mission-1 ordering choice. Either way the dangling
    // pointer lives only while the account is tombstoned, when no reader runs (requireUserId
    // refuses every caller; scheduled readers check isTombstoned).
    expect(backEdges.sort()).toEqual([
      "claims.opportunityId -> opportunities", // cycle with opportunities.activeClaimId; contract §8 purges opportunities first
      "mailLog.watchId -> watches", // Mission-1 order (T18 contract, verbatim)
      "opportunities.currentEvaluationId -> evaluations", // cycle with evaluations.opportunityId; evaluations are the child
      "processedEvents.claimId -> claims", // Mission-1 order
      "transactions.sourceEvidenceId -> evidence", // cycle with evidence.transactionId; evidence (and its blob) first
      "watches.purchaseId -> purchases", // Mission-1 order
    ]);
  });
});

/** One owned transaction-recovery tree: a retail transaction with an uploaded file (blob) and a forwarded email, a fact, an incident, a claim, an opportunity with its evaluation, and a non-cash remedy. */
async function seedRecoveryTree(t: T, userId: Id<"users">, tag: string) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([`receipt bytes ${tag}`], { type: "application/pdf" }));
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 12_000, qty: 1, returned: false });
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "retail_order", status: "active", counterpartyName: "Acme", currency: "USD", purchaseId, liveFactCount: 1,
    });
    const uploadId = await ctx.db.insert("evidence", {
      userId, transactionId, kind: "upload", docType: "receipt", docTypeDeclaredBy: "user", sourceChannel: "upload",
      provenance: "user_uploaded", storageId, contentHash: tag.padEnd(64, "0"), mimeType: "application/pdf", sizeBytes: 20,
      fileName: `receipt-${tag}.pdf`, receivedAt: T0, extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
    });
    const emailId = await ctx.db.insert("evidence", {
      userId, transactionId, kind: "email", docType: "order_confirmation", sourceChannel: "agentmail_forward",
      provenance: "user_forwarded", contentHash: tag.padEnd(64, "1"), text: `Order ${tag}: total USD 120.00`,
      headers: { from: "orders@acme.example", subject: `Your order ${tag}` }, receivedAt: T0,
      extractionStatus: "succeeded", extractionAttempts: 1, retention: "active",
    });
    await ctx.db.patch(transactionId, { sourceEvidenceId: emailId });
    const factId = await ctx.db.insert("facts", {
      userId, transactionId, subjectKey: "txn", key: "retail.total", state: "user_confirmed",
      value: { kind: "money", amountMinor: 12_000, currency: "USD" },
      source: { kind: "evidence", evidenceId: emailId, locator: { kind: "text_span", start: 0, end: 10, quote: "USD 120.00" }, quoteStatus: "verified", extractorVersion: "x1" },
      recordedAt: T0,
    });
    const incidentId = await ctx.db.insert("incidents", { userId, transactionId, kind: "item_damaged", status: "confirmed", reportedBy: "user", sourceEvidenceId: uploadId });
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500, status: "detected", token: `tok-${tag}`, version: 1, transactionId,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${itemId}`,
      dedupeKey: `${transactionId}|R01|price_difference|item:${itemId}|-`, status: "case_open", ruleId: "r01", ruleVersion: 1,
      outcome: "likely_eligible", authorityClass: "merchant_promise", remedyType: "price_difference", cashClass: "cash",
      lossKeys: [], activeClaimId: claimId, lastEvaluatedAt: T0,
    });
    const evaluationId = await ctx.db.insert("evaluations", {
      userId, opportunityId, scenarioId: "R01", ruleId: "r01", ruleVersion: 1, factSnapshotHash: "f".repeat(64), resultHash: "r".repeat(64),
      evaluatedAt: T0, trigger: "observation", outcome: "likely_eligible",
      dimensions: { applies: "pass", factsKnown: "pass", evidenceSupports: "unknown", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "pass" },
      conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null, deadlines: [], sourceRefs: [], overlap: [],
      nextAction: { kind: "continue_case", claimId }, explanation: [],
    });
    await ctx.db.patch(opportunityId, { currentEvaluationId: evaluationId });
    await ctx.db.patch(claimId, { opportunityId });
    const nonCashId = await ctx.db.insert("nonCashRemedies", {
      userId, claimId, kind: "voucher", description: "Store voucher", state: "promised", idempotencyKey: `nc-${tag}`, recordedAt: T0,
    });
    return { storageId, transactionId, uploadId, emailId, factId, incidentId, claimId, opportunityId, evaluationId, nonCashId };
  });
}

const RECOVERY_TABLES = ["transactions", "facts", "incidents", "evidence", "opportunities", "evaluations", "nonCashRemedies"] as const;

async function recoveryRowsOf(t: T, userId: Id<"users">): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const counts: Record<string, number> = {};
    for (const table of RECOVERY_TABLES) {
      counts[table] = (await ctx.db.query(table).collect()).filter((r) => r.userId === userId).length;
    }
    return counts;
  });
}

async function exportAll(as: Awaited<ReturnType<typeof signedIn>>["as"], table: (typeof EXPORT_TABLE_NAMES)[number]): Promise<any[]> {
  const rows: any[] = [];
  let cursor: string | null | undefined = undefined;
  for (let pages = 0; pages < 50; pages++) {
    const page: { rows: any[]; cursor: string | null } = await as.query(api.account.exportPage, { table, cursor: cursor ?? undefined });
    rows.push(...page.rows);
    cursor = page.cursor;
    if (cursor === null) return rows;
  }
  throw new Error(`exportPage(${table}) did not finish within 50 pages`);
}

describe("M14 — exportPage serves the transaction-recovery tables", () => {
  it("each of the seven new tables exports exactly the caller's own rows, never another user's", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await seedRecoveryTree(t, a.userId, "aaaa");
    await seedRecoveryTree(t, b.userId, "bbbb");

    const expected = await recoveryRowsOf(t, a.userId);
    for (const table of RECOVERY_TABLES) {
      const rows = await exportAll(a.as, table);
      expect(rows.length, table).toBe(expected[table]);
      expect(rows.length, table).toBeGreaterThan(0);
      expect(rows.every((r) => r.userId === a.userId), table).toBe(true);
    }
  });

  it("SEC-DEL-3: an evidence export row lists the file by id, contentHash and fileName, and carries no storage URL or storage id", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const seeded = await seedRecoveryTree(t, a.userId, "cccc");

    const rows = await exportAll(a.as, "evidence");
    const upload = rows.find((r) => r._id === seeded.uploadId);
    expect(upload).toMatchObject({ _id: seeded.uploadId, contentHash: "cccc".padEnd(64, "0"), fileName: "receipt-cccc.pdf", hasFile: true });
    expect(upload).not.toHaveProperty("storageId");
    const email = rows.find((r) => r._id === seeded.emailId);
    expect(email).toMatchObject({ hasFile: false, text: "Order cccc: total USD 120.00" });

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(seeded.storageId);
    expect(serialized).not.toMatch(/\/api\/storage|https?:\/\/[^"]*convex\.(cloud|site)/);
  });

  it("evidence export is byte-aware: 100 rows of 60,000 CJK chars export without hitting the 16 MiB read limit", async () => {
    const t = setupWithLimits();
    const a = await signedIn(t, "A");
    await seedCjkEvidence(t, a.userId, 100);
    const rows = await exportAll(a.as, "evidence");
    expect(rows).toHaveLength(100);
  }, 60_000);
});

/** 3-byte UTF-8 text at the contract's 60,000-char evidence cap (§2.6), the same worst case 6b-6 sized `PROCESSED_EVENTS_PAGE` for. */
async function seedCjkEvidence(t: ReturnType<typeof setupWithLimits>, userId: Id<"users">, count: number) {
  const text = "語".repeat(60_000);
  for (let start = 0; start < count; start += 20) {
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(count, start + 20); i++) {
        await ctx.db.insert("evidence", {
          userId, kind: "paste", docType: "order_confirmation", sourceChannel: "paste", provenance: "user_pasted",
          contentHash: String(i).padStart(64, "0"), text, receivedAt: T0, extractionStatus: "not_requested", extractionAttempts: 0, retention: "active",
        });
      }
    });
  }
}

async function blobExists(t: T, storageId: Id<"_storage">): Promise<boolean> {
  return (await t.run((ctx) => ctx.db.system.get("_storage", storageId))) !== null;
}

describe("M14 SEC-DEL-2 — purge removes the transaction-recovery tables and their blobs", () => {
  it("after purge, none of A's rows in the seven new tables and none of A's blobs remain; B's rows and blobs are untouched", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const seededA = await seedRecoveryTree(t, a.userId, "dddd");
    const seededB = await seedRecoveryTree(t, b.userId, "eeee");
    const bBefore = await recoveryRowsOf(t, b.userId);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const aAfter = await recoveryRowsOf(t, a.userId);
    expect(Object.values(aAfter).reduce((x, y) => x + y, 0)).toBe(0);
    expect(await blobExists(t, seededA.storageId)).toBe(false);

    expect(await recoveryRowsOf(t, b.userId)).toEqual(bBefore);
    expect(await blobExists(t, seededB.storageId)).toBe(true);
    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
  });

  it("deletes each evidence blob in the same purgeStep call as its row: after every call, A's remaining evidence rows and A's remaining blobs are the same set", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const storageIds = await t.run(async (ctx) => {
      const ids: Id<"_storage">[] = [];
      for (let i = 0; i < 40; i++) {
        const storageId = await ctx.storage.store(new Blob([`file ${i}`]));
        ids.push(storageId);
        await ctx.db.insert("evidence", {
          userId: a.userId, kind: "upload", docType: "receipt", sourceChannel: "upload", provenance: "user_uploaded", storageId,
          contentHash: String(i).padStart(64, "a"), receivedAt: T0, extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
        });
      }
      return ids;
    });
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    let done = false;
    let evidenceCalls = 0;
    for (let calls = 0; !done && calls < 100; calls++) {
      const before = (await t.run((ctx) => ctx.db.query("evidence").collect())).length;
      done = (await t.mutation(internal.account.purgeStep, { userId: a.userId })).done;
      const rows = await t.run((ctx) => ctx.db.query("evidence").collect());
      if (rows.length !== before) evidenceCalls++;
      const rowBlobs = new Set(rows.map((r) => r.storageId));
      for (const id of storageIds) expect(await blobExists(t, id)).toBe(rowBlobs.has(id));
    }
    expect(done).toBe(true);
    expect(evidenceCalls).toBeGreaterThan(1); // 40 rows span more than one byte-aware page
    for (const id of storageIds) expect(await blobExists(t, id)).toBe(false);
  });

  it("resumes cleanly when a crash already removed an evidence row's blob: no throw, the row is deleted, the purge finishes", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const seeded = await seedRecoveryTree(t, a.userId, "ffff");
    await t.run((ctx) => ctx.storage.delete(seeded.storageId)); // the blob is gone, its row is not
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.get(seeded.uploadId))).toBeNull();
    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
  });

  it("evidence purge is byte-aware: 100 rows of 60,000 CJK chars purge without hitting the 16 MiB read limit", async () => {
    const t = setupWithLimits();
    const a = await signedIn(t, "A");
    await seedCjkEvidence(t, a.userId, 100);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    let done = false;
    for (let calls = 0; !done && calls < 80; calls++) done = (await t.mutation(internal.account.purgeStep, { userId: a.userId })).done;
    expect(done).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("evidence").collect())).toHaveLength(0);
  }, 60_000);
});

// ===========================================================================
// M14c (D173): the purge releases each evidence blob's bytes from the lifetime
// stored-bytes counter with its row; a retried page releases nothing twice;
// the counter row itself is purged with every other `usage` row.
// ===========================================================================

describe("M14c (D173) — purge and the lifetime stored-bytes counter", () => {
  it("the evidence step releases each row's sizeBytes with its blob, a retried evidence page releases nothing twice, and no counter row survives the purge", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        const storageId = await ctx.storage.store(new Blob([`file ${i}`]));
        await ctx.db.insert("evidence", {
          userId: a.userId, kind: "upload", docType: "receipt", sourceChannel: "upload", provenance: "user_uploaded", storageId,
          contentHash: String(i).padStart(64, "c"), sizeBytes: 1_000, receivedAt: T0, extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
        });
      }
      // 500 more than A's three rows: bytes the purge's evidence step must NOT release.
      await chargeStoredBytes(ctx, a.userId, 3_500);
      await chargeStoredBytes(ctx, b.userId, 2_000);
    });
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const progressTable = async () =>
      (await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first()))?.progress?.table;
    for (let calls = 0; calls < 60 && (await progressTable()) !== "transactions"; calls++) {
      await t.mutation(internal.account.purgeStep, { userId: a.userId });
    }
    expect(await progressTable()).toBe("transactions"); // the evidence step is done
    expect(await t.run((ctx) => storedBytes(ctx, a.userId))).toBe(500);

    // Retry the evidence step from its start, as a re-run after a lost ack would: the rows are gone, nothing is released again.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first())!;
      await ctx.db.patch(row._id, { progress: { table: "evidence" } });
    });
    await t.mutation(internal.account.purgeStep, { userId: a.userId });
    expect(await t.run((ctx) => storedBytes(ctx, a.userId))).toBe(500);

    let done = false;
    for (let calls = 0; !done && calls < 80; calls++) done = (await t.mutation(internal.account.purgeStep, { userId: a.userId })).done;
    expect(done).toBe(true);
    const usageRows = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(usageRows.filter((r) => r.userId === a.userId)).toEqual([]);
    expect(await t.run((ctx) => storedBytes(ctx, b.userId))).toBe(2_000);
  });
});

// ---------------------------------------------------------------------------
// D258 (P02-OW-3 residual closed): deletion cancels every unresolved claim
// email through two index ranges -- `drafts.by_user_nextCheck` (every
// unresolved send, formal or informal) and `claims.by_user_status` (queued
// claims, for attempts enqueued before `drafts.nextCheckAt` existed). The
// informal-email case is driven end to end, with provider POSTs counted, in
// notify.fault.test.ts. None of these drive the scheduler: a real component
// send here only needs to exist, `pending`, for the cancel to act on.
// ---------------------------------------------------------------------------

describe("D258: requestDeletion cancels every unresolved claim email", () => {
  async function pendingSend(t: T, n: number) {
    return (await t.mutation(components.agentmail.lib.enqueueSend, {
      config: { retryAttempts: 1, initialBackoffMs: 10 },
      inboxId: "inbox-user",
      kind: "send" as const,
      payload: { to: "support@acme.example", subject: `Refund ${n}`, text: "Please confirm the credit." },
    })) as string;
  }

  async function sendState(t: T, outboundId: string) {
    return await t.query(components.agentmail.lib.getOutboundStatus, { outboundId: outboundId as never });
  }

  /** A claim of `status` with one draft; `outboundId`/`nextCheckAt` make that draft an attempt. */
  async function claimWithDraft(
    t: T,
    userId: Id<"users">,
    status: "queued" | "sent" | "drafted",
    over: { outboundId?: string; nextCheckAt?: number; requiredChannel?: "web_form" } = {},
  ) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: T0 - 86_400_000, currency: "USD", status: "active",
      });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, userId, type: "return_credit", expectedCents: 4000, status, token: `T${Math.random().toString(36).slice(2, 10)}`, version: 1,
        ...(over.requiredChannel ? { requiredChannel: over.requiredChannel } : {}),
      });
      const draftId = await ctx.db.insert("drafts", {
        claimId, userId, version: 1, claimVersion: 1, to: "support@acme.example", subject: "Refund", body: "Please confirm the credit.",
        ...(over.outboundId ? { outboundId: over.outboundId as never, approvedAt: T0 } : {}),
        ...(over.nextCheckAt !== undefined ? { nextCheckAt: over.nextCheckAt } : {}),
      });
      return { claimId, draftId };
    });
  }

  it("a pre-deploy formal attempt (no nextCheckAt) on a queued claim is cancelled through the claims index", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const outboundId = await pendingSend(t, 1);
    await claimWithDraft(t, a.userId, "queued", { outboundId });

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const state = await sendState(t, outboundId);
    expect(state?.status).toBe("failed");
    expect(state?.errorMessage).toBe("Cancelled by user");
  });

  it("a queued claim older than 200 newer claims is still covered, by both ranges", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const legacy = await pendingSend(t, 1);
    const current = await pendingSend(t, 2);
    const informal = await pendingSend(t, 3);
    // The oldest claims: one legacy attempt, one current attempt, one informal (never-queued) attempt.
    await claimWithDraft(t, a.userId, "queued", { outboundId: legacy });
    await claimWithDraft(t, a.userId, "queued", { outboundId: current, nextCheckAt: T0 + 60_000 });
    await claimWithDraft(t, a.userId, "drafted", { outboundId: informal, nextCheckAt: T0 + 60_000, requiredChannel: "web_form" });
    // 200 newer claims: before D258, deletion read only the newest 200 claims and missed all three above.
    await t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        const purchaseId = await ctx.db.insert("purchases", {
          userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: T0 - 86_400_000, currency: "USD", status: "active",
        });
        await ctx.db.insert("claims", {
          purchaseId, userId: a.userId, type: "return_credit", expectedCents: 100, status: "sent", token: `N${i}`, version: 1,
        });
      }
    });

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    for (const outboundId of [legacy, current, informal]) {
      expect((await sendState(t, outboundId))?.errorMessage, outboundId).toBe("Cancelled by user");
    }
  });

  it(`read budget: both ranges at their bounds (${DELETION_QUEUED_CLAIM_SCAN} queued claims x 10 drafts, ${DELETION_UNRESOLVED_DRAFT_SCAN} unresolved drafts) fit one requestDeletion`, async () => {
    const t = setupWithLimits();
    const a = await signedIn(t, "A");
    const body = "x".repeat(1_200); // MAX_BODY_CHARS: the largest draft body a user can save
    const real = await pendingSend(t, 1);
    // Queued claims at the bound, each with 10 drafts of which 3 are attempts (MAX_SENDS_PER_CLAIM).
    for (let batch = 0; batch < DELETION_QUEUED_CLAIM_SCAN / 20; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          const n = batch * 20 + i;
          const purchaseId = await ctx.db.insert("purchases", {
            userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: T0 - 86_400_000, currency: "USD", status: "active",
          });
          const claimId = await ctx.db.insert("claims", {
            purchaseId, userId: a.userId, type: "return_credit", expectedCents: 4000, status: "queued", token: `Q${n}`, version: 1,
          });
          for (let v = 1; v <= 10; v++) {
            const attempt = v > 7;
            await ctx.db.insert("drafts", {
              claimId, userId: a.userId, version: v, claimVersion: 1, to: "support@acme.example", subject: "Refund", body,
              ...(attempt ? { outboundId: (n === 0 && v === 10 ? real : `ob-legacy-${n}-${v}`) as never, approvedAt: T0 } : {}),
            });
          }
        }
      });
    }
    // Unresolved drafts at the bound.
    for (let batch = 0; batch < DELETION_UNRESOLVED_DRAFT_SCAN / 50; batch++) {
      await t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: T0 - 86_400_000, currency: "USD", status: "active",
        });
        const claimId = await ctx.db.insert("claims", {
          purchaseId, userId: a.userId, type: "return_credit", expectedCents: 4000, status: "drafted", token: `U${batch}`, version: 1,
          requiredChannel: "web_form",
        });
        for (let i = 0; i < 50; i++) {
          await ctx.db.insert("drafts", {
            claimId, userId: a.userId, version: i + 1, claimVersion: 1, to: "support@acme.example", subject: "Hello", body,
            outboundId: `ob-open-${batch}-${i}` as never, approvedAt: T0, nextCheckAt: T0 + 60_000,
          });
        }
      });
    }

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    expect(await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first())).not.toBeNull();
    expect((await sendState(t, real))?.errorMessage).toBe("Cancelled by user");
  });
});
