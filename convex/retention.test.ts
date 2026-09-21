import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import {
  RETENTION_KEEP_NEWEST,
  RETENTION_MAILLOG_DAYS,
  RETENTION_OBSERVATION_DAYS,
  RETENTION_PAGE,
  RETENTION_PAYLOAD_DAYS,
  RETENTION_STASH_DAYS,
  RETENTION_UNVERIFIED_DAYS,
} from "./limits";

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
  it("never writes more than RETENTION_PAGE rows in one call, and resumes across calls instead of restarting (cursor persists)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const TOTAL = RETENTION_PAGE + 50; // spans two pages of the FIRST step (processedEvents)
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

    // Call 1: page 1 of the processedEvents step -- exactly RETENTION_PAGE rows, not done with this step yet.
    const first = await t.mutation(internal.retention.sweep, {});
    expect(first.table).toBe("processedEvents");
    expect(first.patched).toBe(RETENTION_PAGE);
    expect(first.patched + first.deleted).toBeLessThanOrEqual(RETENTION_PAGE);
    expect(first.done).toBe(false);
    const midCursor = await opsCursor(t);
    expect(midCursor?.cursor).toBeTruthy();

    // Call 2: MUST resume from where call 1 left off (the remaining 50), not
    // restart at the first RETENTION_PAGE rows (already patched, a no-op) and
    // never reach the rest -- that would be observable as this call also
    // reporting up to RETENTION_PAGE "patched" instead of exactly 50, and as
    // rows 201-250 never getting cleared below.
    const second = await t.mutation(internal.retention.sweep, {});
    expect(second.table).toBe("processedEvents");
    expect(second.patched).toBe(50);
    expect(second.patched + second.deleted).toBeLessThanOrEqual(RETENTION_PAGE);

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
