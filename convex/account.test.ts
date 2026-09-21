import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { inboxTransport } from "./account";
import { RETENTION_PAGE } from "./limits";

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
      status: "queued", outboundId: "ob-1" as never, attempt: 0, nextCheckAt: T0 + 600_000,
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

  it("suppresses queued mailLog rows immediately, with a deleted reason, before purge ever runs", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const seeded = await seedFullAccount(t, a.userId, "a@example.com");

    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const row = await t.run((ctx) => ctx.db.get(seeded.queuedMailLogId));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("deleted");
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

  it("provider failure on inbox deletion leaves the tombstone deleting with a truthful inboxDeleted:false, retries with backoff, and never reaches deleted", async () => {
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
    expect(state?.status).toBe("deleting"); // never "deleted"
    expect(state?.inboxDeleted).toBe(false);
    expect(state?.attempts).toBe(5);
    expect(failing).toHaveBeenCalledTimes(5);

    const user = await t.run((ctx) => ctx.db.get(a.userId));
    expect(user).not.toBeNull(); // purgeAuth never ran -- the user row survives a permanently-failing inbox delete.
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
