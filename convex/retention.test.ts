import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { convexTest } from "convex-test";
import schema from "./schema";
import { PROCESSED_EVENTS_PAGE } from "./limits";
import {
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAGE,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "./limits";
import { EVALUATION_PRUNE_PAGE, EVIDENCE_RETENTION_PAGE, ORPHAN_SWEEP_OPS_KEY, ORPHAN_SWEEP_PAGE, RECOVERY_RETENTION_OPS_KEY } from "./retention";
import { EVALUATION_RETENTION_DAYS, EVIDENCE_RETENTION_DAYS, ORPHAN_BLOB_MIN_AGE_HOURS } from "./lib/privacyFacts";
import { chargeStoredBytes, storedBytes } from "./lib/blobRefs";

/**
 * `_creationTime` is stamped by convex-test's mock backend off the REAL wall
 * clock, not vitest's faked `Date` (confirmed empirically: `vi.setSystemTime`
 * to an arbitrary/small value has no effect on a freshly-inserted row's
 * `_creationTime`). `Date.now()` calls INSIDE application code (this file's
 * `retention.sweep`'s own `now`, and this test file's own `updatedAt: Date
 * .now()` field values) DO respect the fake clock. So every test below
 * anchors on the fake clock's own starting point (real "now", set once by
 * `vi.useFakeTimers()`) and only ever moves it forward RELATIVELY with
 * `vi.advanceTimersByTime` -- never `vi.setSystemTime` to an absolute value
 * -- the same pattern intake.test.ts's stuck-processing tests already use.
 */
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const DAY_MS = 86_400_000;
type T = ReturnType<typeof setup>;

/** Repeatedly calls `retention.sweep` until a full cycle reports `done`. Safety-bounded so a design bug fails the test instead of hanging it. */
async function runFullCycle(t: T, maxCalls = 40) {
  const calls: Array<{ table: string; deleted: number; patched: number; done: boolean }> = [];
  for (let i = 0; i < maxCalls; i++) {
    const res = await t.mutation(internal.retention.sweep, {});
    calls.push(res);
    if (res.done) return calls;
  }
  throw new Error(`retention.sweep did not complete a full cycle within ${maxCalls} calls: ${JSON.stringify(calls)}`);
}

async function opsCursor(t: T) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", "retention"))
      .unique(),
  );
}

describe("retention.sweep — bounded and resumable", () => {
  // D163 (lead-authorized, M14b): this test pinned 200 rows per processedEvents call, the page size that
  // wedged the sweep on large multibyte payloads. It now asserts the byte-aware bound (PROCESSED_EVENTS_PAGE);
  // the resume-not-restart property it checks is unchanged.
  it("never writes more than PROCESSED_EVENTS_PAGE rows in one processedEvents call (D163), and resumes across calls instead of restarting (cursor persists)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const TOTAL = RETENTION_PAGE + 50; // spans many pages of the FIRST step (processedEvents)
    for (let i = 0; i < TOTAL; i++) {
      await t.run(async (ctx) =>
        ctx.db.insert("processedEvents", {
          externalId: `evt-${i}`,
          kind: "agentmail.message.received",
          status: "succeeded",
          attempts: 0,
          userId,
          payload: { subject: "s", text: "t", from: "f@x.example", messageId: null },
        }),
      );
    }
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS + 1) * DAY_MS);

    // Call 1: page 1 of the processedEvents step -- exactly PROCESSED_EVENTS_PAGE rows, not done with this step yet.
    const first = await t.mutation(internal.retention.sweep, {});
    expect(first.table).toBe("processedEvents");
    expect(first.patched).toBe(PROCESSED_EVENTS_PAGE);
    expect(first.patched + first.deleted).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
    expect(first.done).toBe(false);
    const midCursor = await opsCursor(t);
    expect(midCursor?.cursor).toBeTruthy();

    // Call 2: MUST resume from where call 1 left off, not restart at the
    // first page (already patched, a no-op) -- a restart would be observable
    // as this call reporting 0 "patched" instead of a full page, and as the
    // later rows never getting cleared below.
    const second = await t.mutation(internal.retention.sweep, {});
    expect(second.table).toBe("processedEvents");
    expect(second.patched).toBe(PROCESSED_EVENTS_PAGE);
    expect(second.patched + second.deleted).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);

    // The rest of the step, one bounded page per call, until the sweep moves on to the next step.
    let patched = first.patched + second.patched;
    for (let i = 0; i < 40; i++) {
      const next = await t.mutation(internal.retention.sweep, {});
      if (next.table !== "processedEvents") break;
      expect(next.patched).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
      patched += next.patched;
    }
    expect(patched).toBe(TOTAL);

    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows).toHaveLength(TOTAL);
    expect(rows.every((r) => r.payload === undefined)).toBe(true);
  });

  it("a full cycle finishes (done: true) and the next call starts a fresh cycle from the first step", async () => {
    const t = setup();
    const calls = await runFullCycle(t);
    expect(calls.at(-1)?.done).toBe(true);
    expect(calls.at(-1)?.table).toBe("users"); // the last step in STEPS
    for (const c of calls) expect(c.deleted + c.patched).toBeLessThanOrEqual(RETENTION_PAGE);

    const again = await t.mutation(internal.retention.sweep, {});
    expect(again.table).toBe("processedEvents"); // wrapped back to the first step
  });
});

describe("retention.sweep — processedEvents.payload (D75)", () => {
  it("clears payload only for terminal (succeeded/failed) rows older than RETENTION_PAYLOAD_DAYS; needs_review/received/processing are never touched", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const ids: Record<string, Id<"processedEvents">> = {};
    for (const [key, status] of [
      ["succeededOld", "succeeded"],
      ["failedOld", "failed"],
      ["needsReviewOld", "needs_review"],
      ["receivedOld", "received"],
      ["processingOld", "processing"],
    ] as const) {
      ids[key] = await t.run((ctx) =>
        ctx.db.insert("processedEvents", {
          externalId: key,
          kind: "agentmail.message.received",
          status,
          attempts: 0,
          userId,
          payload: { subject: "s", text: "t", from: "f@x.example", messageId: null },
        }),
      );
    }
    // A terminal row that will NOT yet be old enough (boundary: just under the threshold at sweep time).
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS - 1) * DAY_MS);
    ids.succeededYoung = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "succeededYoung",
        kind: "agentmail.message.received",
        status: "succeeded",
        attempts: 0,
        userId,
        payload: { subject: "s", text: "t", from: "f@x.example", messageId: null },
      }),
    );

    vi.advanceTimersByTime(2 * DAY_MS); // total elapsed since the first batch: RETENTION_PAYLOAD_DAYS + 1
    await runFullCycle(t);

    const row = async (id: Id<"processedEvents">) => (await t.run((ctx) => ctx.db.get(id)))!;
    expect((await row(ids.succeededOld)).payload).toBeUndefined();
    expect((await row(ids.failedOld)).payload).toBeUndefined();
    expect((await row(ids.needsReviewOld)).payload).toBeDefined();
    expect((await row(ids.receivedOld)).payload).toBeDefined();
    expect((await row(ids.processingOld)).payload).toBeDefined();
    // Only 2 days old relative to the swept "now": not old enough yet.
    expect((await row(ids.succeededYoung)).payload).toBeDefined();
    // The row itself is always kept, never deleted.
    expect(await t.run((ctx) => ctx.db.query("processedEvents").collect())).toHaveLength(6);
  });
});

async function seedWatchWithChecks(t: T, userId: Id<"users">, count: number, stepMs = 60_000) {
  const watchId = await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId, name: "Widget", productUrl: "https://shop.example/p", merchantDomain: "shop.example",
      status: "active", nextCheckAt: 0,
    }),
  );
  const ids: Id<"watchChecks">[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(
      await t.run((ctx) =>
        ctx.db.insert("watchChecks", {
          watchId, userId, observedCents: 1000 + i, currency: "USD", observedAt: Date.now(), sourceUrl: "https://shop.example/p",
        }),
      ),
    );
    if (stepMs > 0) vi.advanceTimersByTime(stepMs);
  }
  return { watchId, ids }; // ids[0] oldest .. ids[count-1] newest
}

describe("retention.sweep — watchChecks/offerChecks (D75)", () => {
  it("watchChecks: prunes older than RETENTION_OBSERVATION_DAYS but always keeps the newest RETENTION_KEEP_NEWEST per watch", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const extra = 5;
    const { watchId, ids } = await seedWatchWithChecks(t, userId, RETENTION_KEEP_NEWEST + extra);

    vi.advanceTimersByTime((RETENTION_OBSERVATION_DAYS + 1) * DAY_MS);
    await runFullCycle(t);

    const remaining = await t.run((ctx) =>
      ctx.db.query("watchChecks").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect(),
    );
    expect(remaining).toHaveLength(RETENTION_KEEP_NEWEST);
    const remainingIds = new Set(remaining.map((r) => r._id));
    // The oldest `extra` checks are gone...
    for (let i = 0; i < extra; i++) expect(remainingIds.has(ids[i])).toBe(false);
    // ...and every one of the newest RETENTION_KEEP_NEWEST survives.
    for (let i = extra; i < ids.length; i++) expect(remainingIds.has(ids[i])).toBe(true);
  });

  it("watchChecks: a check younger than RETENTION_OBSERVATION_DAYS is never pruned, even ranked far outside the newest 30", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    // 40 checks, all inserted "now" (too young to be pruned at all).
    const { watchId } = await seedWatchWithChecks(t, userId, RETENTION_KEEP_NEWEST + 10, 0);
    await runFullCycle(t);
    expect(
      await t.run((ctx) => ctx.db.query("watchChecks").withIndex("by_watch", (q) => q.eq("watchId", watchId)).collect()),
    ).toHaveLength(RETENTION_KEEP_NEWEST + 10);
  });

  it("offerChecks: same keep-newest-per-offer rule as watchChecks", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "Widget", productUrl: "https://shop.example/p", merchantDomain: "shop.example",
        status: "active", nextCheckAt: 0,
      }),
    );
    const offerId = await t.run((ctx) =>
      ctx.db.insert("offers", {
        watchId, userId, storeDomain: "other.example", productUrl: "https://other.example/p", title: "Other", status: "confirmed",
      }),
    );
    const extra = 3;
    const ids: Id<"offerChecks">[] = [];
    for (let i = 0; i < RETENTION_KEEP_NEWEST + extra; i++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("offerChecks", { offerId, watchId, userId, observedCents: 500 + i, currency: "USD", observedAt: Date.now() }),
        ),
      );
      vi.advanceTimersByTime(60_000);
    }
    vi.advanceTimersByTime((RETENTION_OBSERVATION_DAYS + 1) * DAY_MS);
    await runFullCycle(t);

    const remaining = await t.run((ctx) =>
      ctx.db.query("offerChecks").withIndex("by_offer", (q) => q.eq("offerId", offerId)).collect(),
    );
    expect(remaining).toHaveLength(RETENTION_KEEP_NEWEST);
    const remainingIds = new Set(remaining.map((r) => r._id));
    for (let i = 0; i < extra; i++) expect(remainingIds.has(ids[i])).toBe(false);
  });
});

describe("retention.sweep — priceChecks (D75, claim-referenced survives)", () => {
  it("prunes old checks beyond the newest 30 per item, EXCEPT one a claim still references via openedFromPriceCheckId", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", { userId, merchant: "Store", merchantDomain: "shop.example", currency: "USD", status: "active" }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 1000, qty: 1, returned: false }),
    );
    // 31 checks: index 0 is the oldest/only one outside the newest-30 window.
    const ids: Id<"priceChecks">[] = [];
    for (let i = 0; i < RETENTION_KEEP_NEWEST + 1; i++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("priceChecks", { itemId, userId, observedCents: 1000 + i, currency: "USD", observedAt: Date.now(), sourceUrl: "https://shop.example/p" }),
        ),
      );
      vi.advanceTimersByTime(60_000);
    }
    // An open price_adjustment claim opened from the OLDEST check (index 0).
    await t.run((ctx) =>
      ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500, status: "detected",
        token: "TOK1", version: 1, openedFromPriceCheckId: ids[0],
      }),
    );

    vi.advanceTimersByTime((RETENTION_OBSERVATION_DAYS + 1) * DAY_MS);
    await runFullCycle(t);

    const remaining = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    // Nothing was pruned: the newest 30 survive on rank alone, and index 0
    // (rank 31, otherwise prunable) survives because the claim references it.
    expect(remaining).toHaveLength(RETENTION_KEEP_NEWEST + 1);
    expect(remaining.some((r) => r._id === ids[0])).toBe(true);
  });

  it("without a referencing claim, the same rank-31 check IS pruned", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", { userId, merchant: "Store", merchantDomain: "shop.example", currency: "USD", status: "active" }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 1000, qty: 1, returned: false }),
    );
    const ids: Id<"priceChecks">[] = [];
    for (let i = 0; i < RETENTION_KEEP_NEWEST + 1; i++) {
      ids.push(
        await t.run((ctx) =>
          ctx.db.insert("priceChecks", { itemId, userId, observedCents: 1000 + i, currency: "USD", observedAt: Date.now(), sourceUrl: "https://shop.example/p" }),
        ),
      );
      vi.advanceTimersByTime(60_000);
    }
    vi.advanceTimersByTime((RETENTION_OBSERVATION_DAYS + 1) * DAY_MS);
    await runFullCycle(t);

    const remaining = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    expect(remaining).toHaveLength(RETENTION_KEEP_NEWEST);
    expect(remaining.some((r) => r._id === ids[0])).toBe(false);
  });
});

describe("retention.sweep — mailLog (D75)", () => {
  it("deletes terminal (sent/failed/suppressed) rows older than RETENTION_MAILLOG_DAYS; a non-terminal or younger row survives", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const insert = (dedupeKey: string, status: "sent" | "failed" | "suppressed" | "queued") =>
      t.run((ctx) => ctx.db.insert("mailLog", { userId, dedupeKey, kind: "price_drop", to: "u@example.com", subject: "Price drop", status }));
    const sentOld = await insert("d1", "sent");
    const failedOld = await insert("d2", "failed");
    const suppressedOld = await insert("d3", "suppressed");
    const queuedOld = await insert("d4", "queued"); // non-terminal: never pruned regardless of age

    vi.advanceTimersByTime((RETENTION_MAILLOG_DAYS - 1) * DAY_MS);
    const sentYoung = await insert("d5", "sent");

    vi.advanceTimersByTime(2 * DAY_MS); // total elapsed: RETENTION_MAILLOG_DAYS + 1
    await runFullCycle(t);

    const get = async (id: Id<"mailLog">) => await t.run((ctx) => ctx.db.get(id));
    expect(await get(sentOld)).toBeNull();
    expect(await get(failedOld)).toBeNull();
    expect(await get(suppressedOld)).toBeNull();
    expect(await get(queuedOld)).not.toBeNull();
    expect(await get(sentYoung)).not.toBeNull();
  });
});

describe("retention.sweep — opsState stash rows (D99 N7)", () => {
  it("prunes mailEvent:*/e2e:code:* rows older than RETENTION_STASH_DAYS by updatedAt; every other key is left alone", async () => {
    const t = setup();
    const insert = (key: string) => t.run((ctx) => ctx.db.insert("opsState", { key, cursor: "x", updatedAt: Date.now() }));
    const mailEventOld = await insert("mailEvent:msg-1");
    const e2eCodeOld = await insert("e2e:code:a@example.com");
    const otherOld = await insert("authMigrate"); // a durable control row, never a stash prefix

    vi.advanceTimersByTime((RETENTION_STASH_DAYS - 1) * DAY_MS);
    const mailEventYoung = await insert("mailEvent:msg-2");

    vi.advanceTimersByTime(2 * DAY_MS); // total elapsed: RETENTION_STASH_DAYS + 1
    await runFullCycle(t);

    const get = async (id: Id<"opsState">) => await t.run((ctx) => ctx.db.get(id));
    expect(await get(mailEventOld)).toBeNull();
    expect(await get(e2eCodeOld)).toBeNull();
    expect(await get(otherOld)).not.toBeNull();
    expect(await get(mailEventYoung)).not.toBeNull();
    // The sweep's own "retention" cursor row is never pruned by its own opsState step.
    expect(await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "retention")).unique())).not.toBeNull();
  });
});

describe("retention.sweep — never-verified accounts (D107 hygiene addendum)", () => {
  it("deletes a never-verified user and its auth rows once older than RETENTION_UNVERIFIED_DAYS", async () => {
    const t = setup();
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "Ghost", email: "ghost@example.com" }));
    const accountId = await t.run((ctx) =>
      ctx.db.insert("authAccounts", { userId, provider: "password", providerAccountId: "ghost@example.com", secret: "hash" }),
    );
    const codeId = await t.run((ctx) =>
      ctx.db.insert("authVerificationCodes", { accountId, provider: "recoup-verify", code: "12345678", expirationTime: Date.now() + 900_000 }),
    );
    const sessionId = await t.run((ctx) => ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 1_000 }));
    const tokenId = await t.run((ctx) => ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: Date.now() + 1_000 }));

    vi.advanceTimersByTime((RETENTION_UNVERIFIED_DAYS + 1) * DAY_MS);
    await runFullCycle(t);

    expect(await t.run((ctx) => ctx.db.get(userId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(accountId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(codeId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(sessionId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(tokenId))).toBeNull();
  });

  it("never deletes a verified user, a too-young unverified one, or an unverified one that somehow owns data", async () => {
    const t = setup();
    const verified = await t.run((ctx) => ctx.db.insert("users", { name: "Verified", email: "v@example.com", emailVerificationTime: Date.now() }));
    const ownsData = await t.run((ctx) => ctx.db.insert("users", { name: "OwnsData" }));
    await t.run((ctx) =>
      ctx.db.insert("purchases", { userId: ownsData, merchant: "Store", merchantDomain: "shop.example", currency: "USD", status: "active" }),
    );

    vi.advanceTimersByTime((RETENTION_UNVERIFIED_DAYS + 1) * DAY_MS);
    const tooYoung = await t.run((ctx) => ctx.db.insert("users", { name: "TooYoung" }));

    vi.advanceTimersByTime(DAY_MS); // tooYoung is only 1 day old relative to this "now"; verified/ownsData are older still
    await runFullCycle(t);

    expect(await t.run((ctx) => ctx.db.get(verified))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.get(ownsData))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", ownsData)).collect())).toHaveLength(1);
    expect(await t.run((ctx) => ctx.db.get(tooYoung))).not.toBeNull();
  });
});

describe("retention.sweep — never touches financial/case history", () => {
  it("ledgerEvents, claims, claimNotes, drafts, replies, purchases, items and policies are byte-for-byte unchanged in row count", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const purchaseId = await t.run((ctx) =>
      ctx.db.insert("purchases", { userId, merchant: "Store", merchantDomain: "shop.example", currency: "USD", status: "active" }),
    );
    const itemId = await t.run((ctx) =>
      ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 1000, qty: 1, returned: true }),
    );
    const claimId = await t.run((ctx) =>
      ctx.db.insert("claims", { purchaseId, itemId, userId, type: "return_credit", expectedCents: 1000, status: "detected", token: "TOKFIN", version: 1 }),
    );
    await t.run((ctx) => ctx.db.insert("ledgerEvents", { claimId, userId, kind: "promised_credit", cents: 500, evidence: "e", idempotencyKey: "k1" }));
    await t.run((ctx) => ctx.db.insert("claimNotes", { claimId, userId, kind: "note", text: "n" }));
    await t.run((ctx) => ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "m@example.com", subject: "s", body: "b" }));
    await t.run((ctx) =>
      ctx.db.insert("replies", { claimId, userId, messageId: "m1", from: "m@example.com", classification: "promise", summary: "s", senderMismatch: false, receivedAt: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert("policies", {
        userId, merchantDomain: "shop.example", kind: "returns", channel: "email", passage: "x".repeat(50),
        sourceUrl: "https://shop.example/returns", retrievedAt: Date.now(), confidence: 0.9, confirmedByUser: true,
      }),
    );

    const before = await t.run(async (ctx) => ({
      ledgerEvents: (await ctx.db.query("ledgerEvents").collect()).length,
      claims: (await ctx.db.query("claims").collect()).length,
      claimNotes: (await ctx.db.query("claimNotes").collect()).length,
      drafts: (await ctx.db.query("drafts").collect()).length,
      replies: (await ctx.db.query("replies").collect()).length,
      purchases: (await ctx.db.query("purchases").collect()).length,
      items: (await ctx.db.query("items").collect()).length,
      policies: (await ctx.db.query("policies").collect()).length,
    }));

    // Push well past every retention threshold this file has.
    vi.advanceTimersByTime(400 * DAY_MS);
    await runFullCycle(t);

    const after = await t.run(async (ctx) => ({
      ledgerEvents: (await ctx.db.query("ledgerEvents").collect()).length,
      claims: (await ctx.db.query("claims").collect()).length,
      claimNotes: (await ctx.db.query("claimNotes").collect()).length,
      drafts: (await ctx.db.query("drafts").collect()).length,
      replies: (await ctx.db.query("replies").collect()).length,
      purchases: (await ctx.db.query("purchases").collect()).length,
      items: (await ctx.db.query("items").collect()).length,
      policies: (await ctx.db.query("policies").collect()).length,
    }));
    expect(after).toEqual(before);
  });
});

// ===========================================================================
// M14 (contract rev 5 §2.6, §8): transaction-recovery retention. A separate
// resumable sweep (`retention.sweepRecovery`, opsState key
// RECOVERY_RETENTION_OPS_KEY) clears evidence content (DA-A-7) and prunes old
// evaluations (DA-A-32); `retention.sweepOrphanBlobs` deletes unreferenced
// blobs (SEC-UP-7, DA-A-28(d)). Everything below is additive: no test above
// this line was changed, and `retention.sweep` itself is untouched.
// ===========================================================================

type RecoveryCall = { table: string; deleted: number; patched: number; done: boolean };

async function runRecoveryCycle(t: T, maxCalls = 60): Promise<RecoveryCall[]> {
  const calls: RecoveryCall[] = [];
  for (let i = 0; i < maxCalls; i++) {
    const res = await t.mutation(internal.retention.sweepRecovery, {});
    calls.push(res);
    if (res.done) return calls;
  }
  throw new Error(`retention.sweepRecovery did not complete a cycle within ${maxCalls} calls: ${JSON.stringify(calls)}`);
}

async function seedRetailTransaction(t: T, userId: Id<"users">, status: "active" | "archived" = "active") {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 12_000, qty: 1, returned: false });
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "retail_order", status, counterpartyName: "Acme", currency: "USD", purchaseId, liveFactCount: 0,
    });
    return { purchaseId, itemId, transactionId };
  });
}

type EvidenceSeed = {
  kind?: "email" | "paste" | "upload" | "manual_note" | "system_capture";
  transactionId?: Id<"transactions">;
  pinnedAt?: number;
  withBlob?: boolean;
  hash?: string;
};

let evidenceCounter = 0;
async function seedEvidence(t: T, userId: Id<"users">, seed: EvidenceSeed = {}) {
  const kind = seed.kind ?? "email";
  const hash = seed.hash ?? String(++evidenceCounter).padStart(64, "e");
  return await t.run(async (ctx) => {
    const storageId = seed.withBlob || kind === "upload" ? await ctx.storage.store(new Blob([`bytes ${hash}`])) : undefined;
    const evidenceId = await ctx.db.insert("evidence", {
      userId, transactionId: seed.transactionId, kind, docType: "order_confirmation",
      sourceChannel: kind === "email" ? "agentmail_forward" : kind === "upload" ? "upload" : kind === "paste" ? "paste" : "manual",
      provenance: kind === "email" ? "user_forwarded" : kind === "upload" ? "user_uploaded" : "user_pasted",
      storageId, contentHash: hash, fileName: kind === "upload" ? "receipt.pdf" : undefined,
      text: kind === "upload" ? undefined : "Order 112-0000000-0000000 total USD 120.00",
      headers: kind === "email" ? { from: "orders@acme.example", subject: "Your Acme order", date: "Mon, 21 Sep 2026 10:00:00 +0000" } : undefined,
      receivedAt: Date.now(), pinnedAt: seed.pinnedAt, extractionStatus: "succeeded", extractionAttempts: 1,
      extractionSummary: "Acme order, total USD 120.00", retention: "active",
    });
    return { evidenceId, storageId };
  });
}

async function blobExists(t: T, storageId: Id<"_storage">): Promise<boolean> {
  return (await t.run((ctx) => ctx.db.system.get("_storage", storageId))) !== null;
}

async function evidenceRow(t: T, id: Id<"evidence">) {
  return await t.run((ctx) => ctx.db.get(id));
}

const PAST_EVIDENCE_WINDOW_MS = (EVIDENCE_RETENTION_DAYS + 1) * DAY_MS;

describe("M14 DA-A-7 — evidence retention (retention.sweepRecovery)", () => {
  it("forwarded order, no case → text cleared at 30 days, quotes and headers kept", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { transactionId } = await seedRetailTransaction(t, userId);
    const { evidenceId } = await seedEvidence(t, userId, { kind: "email", transactionId });
    const factId = await t.run((ctx) =>
      ctx.db.insert("facts", {
        userId, transactionId, subjectKey: "txn", key: "retail.total", state: "user_confirmed",
        value: { kind: "money", amountMinor: 12_000, currency: "USD" },
        source: { kind: "evidence", evidenceId, locator: { kind: "text_span", start: 29, end: 39, quote: "USD 120.00" }, quoteStatus: "verified", extractorVersion: "x1" },
        recordedAt: Date.now(),
      }),
    );
    const before = await evidenceRow(t, evidenceId);

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    const after = await evidenceRow(t, evidenceId);
    expect(after?.retention).toBe("content_deleted");
    expect(after?.text).toBeUndefined();
    expect(after?.extractionSummary).toBeUndefined();
    expect(after?.headers).toEqual(before?.headers);
    expect(after?.contentHash).toBe(before?.contentHash);
    const fact = await t.run((ctx) => ctx.db.get(factId));
    expect(fact?.source).toMatchObject({ kind: "evidence", locator: { quote: "USD 120.00" } });
  });

  it("with a claim → kept (a claim on the transaction, or for retail a claim on its purchase; a dismissed claim counts)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const linked = await seedRetailTransaction(t, userId);
    const retail = await seedRetailTransaction(t, userId);
    const dismissed = await seedRetailTransaction(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("claims", {
        purchaseId: linked.purchaseId, itemId: linked.itemId, userId, type: "price_adjustment", expectedCents: 500, status: "sent",
        token: "tok-linked", version: 1, transactionId: linked.transactionId,
      });
      // Legacy retail claim: no transactionId, found only through claims.by_purchase_type.
      await ctx.db.insert("claims", {
        purchaseId: retail.purchaseId, itemId: retail.itemId, userId, type: "price_adjustment", expectedCents: 500, status: "detected",
        token: "tok-retail", version: 1,
      });
      await ctx.db.insert("claims", {
        purchaseId: dismissed.purchaseId, itemId: dismissed.itemId, userId, type: "price_adjustment", expectedCents: 500, status: "dismissed",
        token: "tok-dismissed", version: 1, transactionId: dismissed.transactionId,
      });
    });
    const ids = [
      (await seedEvidence(t, userId, { kind: "email", transactionId: linked.transactionId })).evidenceId,
      (await seedEvidence(t, userId, { kind: "paste", transactionId: retail.transactionId })).evidenceId,
      (await seedEvidence(t, userId, { kind: "email", transactionId: dismissed.transactionId })).evidenceId,
    ];
    const upload = await seedEvidence(t, userId, { kind: "upload", transactionId: linked.transactionId });

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    for (const id of ids) {
      const row = await evidenceRow(t, id);
      expect(row?.retention, id).toBe("active");
      expect(row?.text, id).toBe("Order 112-0000000-0000000 total USD 120.00");
    }
    expect((await evidenceRow(t, upload.evidenceId))?.retention).toBe("active");
    expect(await blobExists(t, upload.storageId!)).toBe(true);
  });

  it("pinned → kept", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { transactionId } = await seedRetailTransaction(t, userId);
    const pinnedEmail = await seedEvidence(t, userId, { kind: "email", transactionId, pinnedAt: Date.now() });
    const pinnedUpload = await seedEvidence(t, userId, { kind: "upload", pinnedAt: Date.now() }); // unattached, but kept

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    expect((await evidenceRow(t, pinnedEmail.evidenceId))?.text).toBe("Order 112-0000000-0000000 total USD 120.00");
    expect((await evidenceRow(t, pinnedUpload.evidenceId))?.retention).toBe("active");
    expect(await blobExists(t, pinnedUpload.storageId!)).toBe(true);
  });

  it("younger than the window → untouched; manual_note and system_capture rows are never touched", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const note = await seedEvidence(t, userId, { kind: "manual_note" });
    const capture = await seedEvidence(t, userId, { kind: "system_capture" });
    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    const young = await seedEvidence(t, userId, { kind: "email" }); // received "today"
    vi.advanceTimersByTime((EVIDENCE_RETENTION_DAYS - 1) * DAY_MS);

    await runRecoveryCycle(t);

    for (const { evidenceId } of [note, capture, young]) {
      const row = await evidenceRow(t, evidenceId);
      expect(row?.retention, evidenceId).toBe("active");
      expect(row?.text, evidenceId).toBe("Order 112-0000000-0000000 total USD 120.00");
    }
  });

  it("paste text follows the same rule, and a blob attached to email or paste evidence is deleted with the text", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const paste = await seedEvidence(t, userId, { kind: "paste" });
    const emailWithBlob = await seedEvidence(t, userId, { kind: "email", withBlob: true });

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    expect(await evidenceRow(t, paste.evidenceId)).toMatchObject({ retention: "content_deleted" });
    expect((await evidenceRow(t, paste.evidenceId))?.text).toBeUndefined();
    const email = await evidenceRow(t, emailWithBlob.evidenceId);
    expect(email?.retention).toBe("content_deleted");
    expect(email?.storageId).toBeUndefined();
    expect(await blobExists(t, emailWithBlob.storageId!)).toBe(false);
  });

  it("uploads: kept while attached to a non-archived transaction; an unattached upload, or one on an archived transaction, is cleared at 30 days with its blob", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const open = await seedRetailTransaction(t, userId, "active");
    const archived = await seedRetailTransaction(t, userId, "archived");
    const attached = await seedEvidence(t, userId, { kind: "upload", transactionId: open.transactionId });
    const onArchived = await seedEvidence(t, userId, { kind: "upload", transactionId: archived.transactionId });
    const unattached = await seedEvidence(t, userId, { kind: "upload" });

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    expect((await evidenceRow(t, attached.evidenceId))?.retention).toBe("active");
    expect(await blobExists(t, attached.storageId!)).toBe(true);
    for (const cleared of [onArchived, unattached]) {
      const row = await evidenceRow(t, cleared.evidenceId);
      expect(row?.retention).toBe("content_deleted");
      expect(row?.storageId).toBeUndefined();
      expect(row?.fileName).toBe("receipt.pdf"); // metadata stays; content goes
      expect(await blobExists(t, cleared.storageId!)).toBe(false);
    }
  });

  it("DA-A-20 retention side: a cleared row keeps its contentHash and stays findable by (userId, contentHash), so a re-upload can revive it", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const hash = "ab".repeat(32);
    const { evidenceId } = await seedEvidence(t, userId, { kind: "upload", hash });

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    const match = await t.run((ctx) =>
      ctx.db.query("evidence").withIndex("by_user_and_content_hash", (q) => q.eq("userId", userId).eq("contentHash", hash)).unique(),
    );
    expect(match?._id).toBe(evidenceId);
    expect(match?.retention).toBe("content_deleted");
  });

  it("a cleared row is never processed again, and the sweep never writes the ledger, claims, drafts, replies, purchases or facts", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { transactionId, purchaseId, itemId } = await seedRetailTransaction(t, userId);
    await t.run(async (ctx) => {
      const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500, status: "confirmed", token: "tok-l", version: 1, transactionId });
      await ctx.db.insert("ledgerEvents", { claimId, userId, kind: "confirmed_credit", cents: 500, evidence: "stmt", currency: "USD" });
      await ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "s@acme.example", subject: "s", body: "b" });
      await ctx.db.insert("replies", { claimId, userId, messageId: "m1", from: "s@acme.example", classification: "credit_issued", summary: "done", senderMismatch: false, receivedAt: Date.now() });
    });
    const orphanEmail = await seedEvidence(t, userId, { kind: "email" });

    const snapshot = () =>
      t.run(async (ctx) => {
        const out: Record<string, unknown[]> = {};
        for (const table of ["ledgerEvents", "claims", "drafts", "replies", "purchases", "items", "facts", "transactions"] as const) {
          out[table] = await ctx.db.query(table).collect();
        }
        return out;
      });
    const before = await snapshot();

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    const first = await runRecoveryCycle(t);
    expect(first.reduce((n, c) => n + c.patched, 0)).toBe(1);
    const cleared = await evidenceRow(t, orphanEmail.evidenceId);

    vi.advanceTimersByTime(DAY_MS);
    const second = await runRecoveryCycle(t);
    expect(second.reduce((n, c) => n + c.patched + c.deleted, 0)).toBe(0);
    expect(await evidenceRow(t, orphanEmail.evidenceId)).toEqual(cleared);
    expect(await snapshot()).toEqual(before);
  });

  it("a row whose blob is already gone is cleared without throwing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const upload = await seedEvidence(t, userId, { kind: "upload" });
    await t.run((ctx) => ctx.storage.delete(upload.storageId!));

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);

    expect((await evidenceRow(t, upload.evidenceId))?.retention).toBe("content_deleted");
  });

  it("bounded (at most EVIDENCE_RETENTION_PAGE rows per call) and resumable (the cursor persists across calls)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const TOTAL = EVIDENCE_RETENTION_PAGE * 2 + 3;
    for (let i = 0; i < TOTAL; i++) await seedEvidence(t, userId, { kind: "paste" });

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    const first = await t.mutation(internal.retention.sweepRecovery, {});
    expect(first).toMatchObject({ table: "evidence", patched: EVIDENCE_RETENTION_PAGE, done: false });
    const cursor = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", RECOVERY_RETENTION_OPS_KEY)).unique());
    expect(cursor?.cursor).toBeTruthy();
    expect(cursor?.updatedAt).toBe(Date.now());

    const rest = await runRecoveryCycle(t);
    for (const c of rest) expect(c.patched + c.deleted).toBeLessThanOrEqual(EVIDENCE_RETENTION_PAGE);
    expect(first.patched + rest.reduce((n, c) => n + c.patched, 0)).toBe(TOTAL);
    const rows = await t.run((ctx) => ctx.db.query("evidence").collect());
    expect(rows.every((r) => r.retention === "content_deleted" && r.text === undefined)).toBe(true);
  });
});

async function seedOpportunity(t: T, userId: Id<"users">) {
  const { transactionId, itemId } = await seedRetailTransaction(t, userId);
  return await t.run((ctx) =>
    ctx.db.insert("opportunities", {
      userId, transactionId, scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${itemId}`,
      dedupeKey: `${transactionId}|R01|price_difference|item:${itemId}|-`, status: "open", ruleId: "r01", ruleVersion: 1,
      outcome: "needs_facts", authorityClass: "merchant_promise", remedyType: "price_difference", cashClass: "cash",
      lossKeys: [], lastEvaluatedAt: Date.now(),
    }),
  );
}

async function seedEvaluation(t: T, userId: Id<"users">, opportunityId: Id<"opportunities">, tag: string) {
  return await t.run((ctx) =>
    ctx.db.insert("evaluations", {
      userId, opportunityId, scenarioId: "R01", ruleId: "r01", ruleVersion: 1, factSnapshotHash: tag.padEnd(64, "f"), resultHash: tag.padEnd(64, "r"),
      evaluatedAt: Date.now(), trigger: "observation", outcome: "needs_facts",
      dimensions: { applies: "pass", factsKnown: "unknown", evidenceSupports: "unknown", windowOpen: "pass", amountCalculable: "unknown", readyForApproval: "fail" },
      conditions: [], missingFacts: [], assumptions: [], disqualifierIds: [], amount: null, deadlines: [], sourceRefs: [], overlap: [],
      nextAction: { kind: "none", reason: "test" }, explanation: [],
    }),
  );
}

const PAST_EVALUATION_WINDOW_MS = (EVALUATION_RETENTION_DAYS + 1) * DAY_MS;

describe("M14 DA-A-32 — evaluation pruning (retention.sweepRecovery)", () => {
  it("prunes evaluations older than the window that are not current and whose opportunity has no claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const opportunityId = await seedOpportunity(t, userId);
    const old1 = await seedEvaluation(t, userId, opportunityId, "a");
    const old2 = await seedEvaluation(t, userId, opportunityId, "b");
    const current = await seedEvaluation(t, userId, opportunityId, "c");
    await t.run((ctx) => ctx.db.patch(opportunityId, { currentEvaluationId: current }));

    vi.advanceTimersByTime(PAST_EVALUATION_WINDOW_MS);
    const calls = await runRecoveryCycle(t);

    expect(calls.reduce((n, c) => n + c.deleted, 0)).toBe(2);
    expect(await t.run((ctx) => ctx.db.get(old1))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(old2))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(current))).not.toBeNull();
  });

  it("never prunes the current evaluation, one referenced by an approval binding, or one of a case-linked opportunity; a younger one is kept too", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    // Case-linked through claims.by_opportunity, with an approved draft binding an OLD, non-current evaluation.
    const linkedOpp = await seedOpportunity(t, userId);
    const bound = await seedEvaluation(t, userId, linkedOpp, "bound");
    const linkedOther = await seedEvaluation(t, userId, linkedOpp, "linked");
    const linkedCurrent = await seedEvaluation(t, userId, linkedOpp, "lcur");
    await t.run(async (ctx) => {
      const opp = (await ctx.db.get(linkedOpp))!;
      const txn = (await ctx.db.get(opp.transactionId))!;
      const itemId = (await ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", txn.purchaseId!)).first())!._id;
      const claimId = await ctx.db.insert("claims", {
        purchaseId: txn.purchaseId!, itemId, userId, type: "price_adjustment", expectedCents: 500, status: "drafted", token: "tok-b", version: 1,
        transactionId: txn._id, opportunityId: linkedOpp,
      });
      await ctx.db.patch(linkedOpp, { currentEvaluationId: linkedCurrent });
      await ctx.db.insert("drafts", {
        claimId, userId, version: 1, claimVersion: 1, to: "s@acme.example", subject: "s", body: "b", approvedAt: Date.now(), approvedHash: "h".repeat(64),
        binding: { contextHash: "c".repeat(64), claimVersion: 1, amount: { amountMinor: 500, currency: "USD" }, opportunityId: linkedOpp, evaluationId: bound, attachments: [] },
      });
    });
    // activeClaimId alone (defense in depth, e.g. a claim row not yet linked back).
    const activeOpp = await seedOpportunity(t, userId);
    const activeOld = await seedEvaluation(t, userId, activeOpp, "act");
    await t.run(async (ctx) => {
      const anyClaim = (await ctx.db.query("claims").first())!;
      await ctx.db.patch(activeOpp, { activeClaimId: anyClaim._id });
    });
    // A lone opportunity: old current kept, a younger non-current kept.
    const loneOpp = await seedOpportunity(t, userId);
    const loneCurrent = await seedEvaluation(t, userId, loneOpp, "cur");
    await t.run((ctx) => ctx.db.patch(loneOpp, { currentEvaluationId: loneCurrent }));

    vi.advanceTimersByTime(PAST_EVALUATION_WINDOW_MS);
    const young = await seedEvaluation(t, userId, loneOpp, "young");
    await runRecoveryCycle(t);

    for (const id of [bound, linkedOther, linkedCurrent, activeOld, loneCurrent, young]) {
      expect(await t.run((ctx) => ctx.db.get(id)), id).not.toBeNull();
    }
  });

  it("bounded (at most EVALUATION_PRUNE_PAGE rows per call) and resumable", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const opportunityId = await seedOpportunity(t, userId);
    const TOTAL = EVALUATION_PRUNE_PAGE + 7;
    for (let i = 0; i < TOTAL; i++) await seedEvaluation(t, userId, opportunityId, `p${i}`);

    vi.advanceTimersByTime(PAST_EVALUATION_WINDOW_MS);
    const calls = await runRecoveryCycle(t);
    for (const c of calls) expect(c.deleted + c.patched).toBeLessThanOrEqual(Math.max(EVALUATION_PRUNE_PAGE, EVIDENCE_RETENTION_PAGE));
    expect(calls.filter((c) => c.table === "evaluations" && c.deleted > 0).length).toBeGreaterThan(1);
    expect(await t.run((ctx) => ctx.db.query("evaluations").collect())).toHaveLength(0);
  });
});

async function runOrphanCycle(t: T, maxCalls = 60) {
  const calls: Array<{ scanned: number; deleted: number; done: boolean }> = [];
  for (let i = 0; i < maxCalls; i++) {
    const res = await t.mutation(internal.retention.sweepOrphanBlobs, {});
    calls.push(res);
    if (res.done) return calls;
  }
  throw new Error(`retention.sweepOrphanBlobs did not complete a cycle within ${maxCalls} calls`);
}

describe("M14 SEC-UP-7 / DA-A-28(d) — orphan blob sweep (retention.sweepOrphanBlobs)", () => {
  it("deletes an unreferenced blob older than 24 h; keeps a referenced blob however old, and an unreferenced blob younger than 24 h", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const orphan = await t.run((ctx) => ctx.storage.store(new Blob(["abandoned upload"])));
    const referenced = await seedEvidence(t, userId, { kind: "upload" });
    vi.advanceTimersByTime(ORPHAN_BLOB_MIN_AGE_HOURS * 3_600_000 + 60_000);
    const young = await t.run((ctx) => ctx.storage.store(new Blob(["upload in flight"])));
    vi.advanceTimersByTime(60_000);

    await runOrphanCycle(t);

    expect(await blobExists(t, orphan)).toBe(false);
    expect(await blobExists(t, referenced.storageId!)).toBe(true);
    expect(await blobExists(t, young)).toBe(true);
    const ops = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", ORPHAN_SWEEP_OPS_KEY)).unique());
    expect(ops?.updatedAt).toBe(Date.now()); // M1B's ops.backlog reads the age of this row
  });

  it("a referenced blob is never deleted: 200 days and many cycles later it is still there", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const referenced = await seedEvidence(t, userId, { kind: "upload" });
    for (let day = 0; day < 4; day++) {
      vi.advanceTimersByTime(50 * DAY_MS);
      await runOrphanCycle(t);
    }
    expect(await blobExists(t, referenced.storageId!)).toBe(true);
  });

  it("bounded (at most ORPHAN_SWEEP_PAGE blobs per call) and resumable across calls", async () => {
    const t = setup();
    const TOTAL = ORPHAN_SWEEP_PAGE * 2 + 5;
    const ids = await t.run(async (ctx) => {
      const out: Id<"_storage">[] = [];
      for (let i = 0; i < TOTAL; i++) out.push(await ctx.storage.store(new Blob([`orphan ${i}`])));
      return out;
    });
    vi.advanceTimersByTime(ORPHAN_BLOB_MIN_AGE_HOURS * 3_600_000 + 60_000);

    const calls = await runOrphanCycle(t);
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c.scanned).toBeLessThanOrEqual(ORPHAN_SWEEP_PAGE);
    expect(calls.reduce((n, c) => n + c.deleted, 0)).toBe(TOTAL);
    for (const id of ids) expect(await blobExists(t, id)).toBe(false);
  });
});

// ===========================================================================
// M14b (D163): `retention.sweep`'s processedEvents step read 200 rows per
// page. A row's `payload` holds up to 60,000 chars (`inbound.ts`
// MAX_TEXT_CHARS); at 3 bytes/char (CJK) 100 such rows are ~18 MB, over
// Convex's 16 MiB per-transaction read limit, so the call threw -- and every
// daily run re-read the same cursor, wedging the D75 sweep for good. The
// step now pages PROCESSED_EVENTS_PAGE rows (the 6b-6 budget account.ts
// already uses for this table).
// ===========================================================================

/** convex-test only enforces the 16 MiB read limit with `transactionLimits: true` (same harness as account.test.ts's `setupWithLimits`). */
function setupWithReadLimits() {
  return convexTest({ schema, modules: import.meta.glob("./**/*.*s"), transactionLimits: true });
}

async function seedCjkEvents(t: ReturnType<typeof setupWithReadLimits>, userId: Id<"users">, count: number, status: "succeeded" | "received" = "succeeded") {
  const text = "語".repeat(60_000);
  for (let start = 0; start < count; start += 20) {
    await t.run(async (ctx) => {
      for (let i = start; i < Math.min(count, start + 20); i++) {
        await ctx.db.insert("processedEvents", {
          externalId: `cjk-${status}-${i}`, kind: "agentmail.message.received", status, attempts: 1, userId,
          payload: { subject: "s", from: "f@x.example", text },
        });
      }
    });
  }
}

describe("M14b (D163) — retention.sweep's processedEvents step is byte-aware", () => {
  it("100 rows of 60,000 CJK chars no longer exceed the 16 MiB read limit: the cycle completes and every old terminal payload is cleared", async () => {
    const t = setupWithReadLimits();
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "cjk" }));
    await seedCjkEvents(t, userId, 100);
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS + 1) * DAY_MS);

    const calls = await runFullCycle(t as unknown as T);

    const eventCalls = calls.filter((c) => c.table === "processedEvents");
    for (const c of eventCalls) expect(c.patched).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
    expect(eventCalls.reduce((n, c) => n + c.patched, 0)).toBe(100);
    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows.every((r) => r.payload === undefined)).toBe(true);
  }, 60_000);

  it("the same page stays under the limit when the payloads are NOT yet clearable (young or non-terminal rows are still read)", async () => {
    const t = setupWithReadLimits();
    const userId = await t.run((ctx) => ctx.db.insert("users", { name: "cjk" }));
    await seedCjkEvents(t, userId, 100, "received");
    const calls = await runFullCycle(t as unknown as T);
    expect(calls.at(-1)?.done).toBe(true);
    expect(calls.reduce((n, c) => n + c.patched, 0)).toBe(0);
  }, 60_000);

  it("resumable: a large backlog interrupted mid-step completes across later calls, each row cleared exactly once", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const TOTAL = PROCESSED_EVENTS_PAGE * 8 + 11; // many pages of the first step
    await t.run(async (ctx) => {
      for (let i = 0; i < TOTAL; i++) {
        await ctx.db.insert("processedEvents", {
          externalId: `bk-${i}`, kind: "agentmail.message.received", status: i % 2 ? "succeeded" : "failed", attempts: 1, userId,
          payload: { subject: "s", text: "t", from: "f@x.example", messageId: null },
        });
      }
    });
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS + 1) * DAY_MS);

    // Three pages, then the chain "dies" (no scheduled continuation is run here, as after a crash or redeploy).
    const early: Array<{ patched: number }> = [];
    for (let i = 0; i < 3; i++) early.push(await t.mutation(internal.retention.sweep, {}));
    expect(early.map((c) => c.patched)).toEqual([PROCESSED_EVENTS_PAGE, PROCESSED_EVENTS_PAGE, PROCESSED_EVENTS_PAGE]);
    const midCursor = await opsCursor(t);
    expect(JSON.parse(midCursor!.cursor!)).toMatchObject({ step: 0 });
    expect(JSON.parse(midCursor!.cursor!).page).toBeTruthy();

    const clearedCount = async () => (await t.run((ctx) => ctx.db.query("processedEvents").collect())).filter((r) => r.payload === undefined).length;
    expect(await clearedCount()).toBe(3 * PROCESSED_EVENTS_PAGE);

    // A later run resumes from the persisted cursor. (The clock is NOT advanced: under fake timers that would
    // run the three self-scheduled continuations and hide what a fresh call does.) A restart would re-read the
    // already-cleared first pages and patch 0 here; resuming clears the next full page.
    const resumed = await t.mutation(internal.retention.sweep, {});
    expect(resumed).toMatchObject({ table: "processedEvents", patched: PROCESSED_EVENTS_PAGE });
    const rest = await runFullCycle(t);
    for (const c of rest) expect(c.patched + c.deleted).toBeLessThanOrEqual(RETENTION_PAGE);
    for (const c of rest.filter((r) => r.table === "processedEvents")) expect(c.patched).toBeLessThanOrEqual(PROCESSED_EVENTS_PAGE);
    const total = [...early, resumed, ...rest].reduce((n, c) => n + c.patched, 0);
    expect(total).toBe(TOTAL); // each row cleared exactly once, across the interruption
    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows.every((r) => r.payload === undefined)).toBe(true);
  });
});

// ===========================================================================
// M14c (D173): retention releases a cleared upload's bytes from the lifetime
// stored-bytes counter (`lib/blobRefs`) in the same mutation, keyed on the row
// losing its storageId, so a retried page never releases twice.
// ===========================================================================

async function seedSizedUpload(t: T, userId: Id<"users">, sizeBytes: number, transactionId?: Id<"transactions">) {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["x".repeat(16)]));
    return await ctx.db.insert("evidence", {
      userId, transactionId, kind: "upload", docType: "receipt", sourceChannel: "upload", provenance: "user_uploaded", storageId,
      contentHash: String(++evidenceCounter).padStart(64, "s"), sizeBytes, receivedAt: Date.now(),
      extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
    });
  });
}

describe("M14c (D173) — retention releases cleared uploads from the lifetime stored-bytes counter", () => {
  it("clearing an unattached upload releases its sizeBytes; a kept upload and text-only evidence release nothing; a retried page releases nothing twice", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { transactionId } = await seedRetailTransaction(t, userId);
    const cleared = await seedSizedUpload(t, userId, 1_000);
    await seedSizedUpload(t, userId, 400, transactionId); // attached to an open transaction: kept
    await seedEvidence(t, userId, { kind: "email" }); // text only, no blob: cleared, releases nothing
    await t.run((ctx) => chargeStoredBytes(ctx, userId, 1_400));

    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    const first = await t.mutation(internal.retention.sweepRecovery, {}); // the evidence page
    expect(first).toMatchObject({ table: "evidence", patched: 2 });
    expect(await t.run((ctx) => storedBytes(ctx, userId))).toBe(400);
    expect((await t.run((ctx) => ctx.db.get(cleared)))?.storageId).toBeUndefined();

    // Retry the same page: put the cursor back where it was before that call, as a re-run after a lost ack would.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", RECOVERY_RETENTION_OPS_KEY)).unique();
      if (row) await ctx.db.delete(row._id);
    });
    const retried = await t.mutation(internal.retention.sweepRecovery, {});
    expect(retried).toMatchObject({ table: "evidence", patched: 0 });
    await runRecoveryCycle(t);
    expect(await t.run((ctx) => storedBytes(ctx, userId))).toBe(400);
  });

  it("never goes negative: releasing more than was counted clamps at 0", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await seedSizedUpload(t, userId, 1_000);
    await t.run((ctx) => chargeStoredBytes(ctx, userId, 300));
    vi.advanceTimersByTime(PAST_EVIDENCE_WINDOW_MS);
    await runRecoveryCycle(t);
    expect(await t.run((ctx) => storedBytes(ctx, userId))).toBe(0);
  });

  it("the orphan sweep releases nothing: an orphan was never bound, so never charged", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) => chargeStoredBytes(ctx, userId, 5_000));
    await t.run((ctx) => ctx.storage.store(new Blob(["abandoned"])));
    vi.advanceTimersByTime(ORPHAN_BLOB_MIN_AGE_HOURS * 3_600_000 + 60_000);
    await runOrphanCycle(t);
    expect(await t.run((ctx) => storedBytes(ctx, userId))).toBe(5_000);
  });
});
