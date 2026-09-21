/// <reference types="vite/client" />
/**
 * T21 — P09/P08 cross-user lifecycle tests (tester-owned files only).
 *
 * account.ts/account.test.ts (T18, e265bb9) already proves `exportPage`/
 * `requestDeletion`/`purgeStep`/`purgeAuth` in isolation, table by table.
 * This file instead exercises the SEAMS between account lifecycle (D77,
 * D87) and every other module that reads a user's rows on a schedule or
 * from a webhook: does a tombstoned-but-not-yet-purged account actually
 * stop everything D87 says it must, and does the system behave once the
 * account is gone for good? Reuses T18's `inboxTransport` spy-injection
 * seam (account.ts) and T09's `vi.spyOn(agentmail, ...)` seam
 * (notify.fault.test.ts) rather than inventing new ones.
 *
 * Every `it` builds its own `setup()` (this codebase's convention:
 * account.test.ts, notify.fault.test.ts, inbound.test.ts all do the same)
 * so tests never share mutable state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { claimDrop } from "./notify";
import { agentmail } from "./mail";
import { inboxTransport } from "./account";
import { INELIGIBLE_REST_MS, RETENTION_PAGE } from "./limits";

type T = ReturnType<typeof setup>;

const T0 = Date.UTC(2026, 8, 21, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

async function tombstone(as: Awaited<ReturnType<typeof signedIn>>["as"]) {
  await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
}

/** An active watch, priced or not, ready for claimDrop/market/sweep tests. */
async function activeWatch(t: T, userId: Id<"users">, over: Partial<{ targetCents: number; nextCheckAt: number }> = {}) {
  return await t.run(async (ctx) => {
    const watchId = await ctx.db.insert("watches", {
      userId,
      name: "Widget",
      productUrl: "https://store.example/widget",
      merchantDomain: "store.example",
      currency: "USD",
      targetCents: over.targetCents ?? 5_000,
      status: "active",
      nextCheckAt: over.nextCheckAt ?? T0,
    });
    return (await ctx.db.get(watchId))!;
  });
}

/** A minimal purchase+item+claim tree, for claim/draft/follow-up fixtures that don't need the full T18 seed. */
async function claimFixture(t: T, userId: Id<"users">, over: Partial<{ status: "detected" | "drafted" | "queued" }> = {}) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: 8_000, qty: 1, returned: false,
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 500,
      status: over.status ?? "drafted", token: `tok-${userId}`, version: 1,
    });
    return { purchaseId, itemId, claimId };
  });
}

/** An eligible-for-scraping item: active purchase, product link, a confirmed price-adjustment policy whose window is still open, no open claim -- everything `priceWatch.eligibleItems` requires besides not being tombstoned. */
async function eligibleItem(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const purchasedAt = T0 - 86_400_000;
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active", purchasedAt,
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Jacket", unitCents: 8_000, qty: 1, returned: false,
      productUrl: "https://acme.example/p/jacket", nextCheckAt: T0 - 1_000,
    });
    await ctx.db.insert("policies", {
      userId, merchantDomain: "acme.example", kind: "price_adjustment", channel: "email",
      windowDays: 30, passage: "30 days", sourceUrl: "https://acme.example/policy",
      retrievedAt: T0, confidence: 0.9, confirmedByUser: true,
    });
    return itemId;
  });
}

function inboundMessage(over: Record<string, unknown> = {}) {
  return {
    inbox_id: "inbox-a",
    message_id: "msg-1",
    subject: "Order confirmed",
    text: "1x Widget $40.00",
    from: "orders@store.example",
    ...over,
  };
}

async function processedEvents(t: T) {
  return await t.run(async (ctx) => await ctx.db.query("processedEvents").collect());
}

// ---------------------------------------------------------------------------
// Cross-user isolation (P08): exportPage/requestDeletion never cross accounts
// ---------------------------------------------------------------------------

describe("cross-user isolation", () => {
  it("user B's exportPage never returns user A's rows, for a direct and a via-parent table", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const seededA = await claimFixture(t, a.userId);
    await t.run((ctx) => ctx.db.insert("purchases", { userId: b.userId, merchant: "Boutique", merchantDomain: "boutique.example", currency: "USD", status: "active" }));
    await t.run((ctx) => ctx.db.insert("claimNotes", { claimId: seededA.claimId, userId: a.userId, kind: "note", text: "A's own note" }));

    const purchasePage = await b.as.query(api.account.exportPage, { table: "purchases" });
    expect(purchasePage.rows).toHaveLength(1);
    expect((purchasePage.rows[0] as any).userId).toBe(b.userId);

    // claimNotes is a via-parent table (rooted at `claims`, D18's TABLE_SPECS):
    // B owns no claims at all, so the parent scan finds nothing of A's.
    const notesPage = await b.as.query(api.account.exportPage, { table: "claimNotes" });
    expect(notesPage.rows).toHaveLength(0);
  });

  it("user B's requestDeletion never tombstones or otherwise touches A", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await activeWatch(t, a.userId);

    await tombstone(b.as);

    const stateA = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(stateA).toBeNull();

    // A is still a live account: exportPage (which throws for a tombstoned caller) still works for A.
    const watches = await a.as.query(api.account.exportPage, { table: "watches" });
    expect(watches.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A tombstoned (accountState "deleting"), before purge has finished: every
// reader D87 names must skip A's rows.
// ---------------------------------------------------------------------------

describe("tombstoned account: scheduled/webhook readers skip it (D87)", () => {
  it("notify.claimDrop for a tombstoned owner's watch never enqueues or sends: the bookkeeping row it writes is immediately suppressed, reason deleted", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.patch(a.userId, { email: "a@example.com", emailVerificationTime: T0 }));
    const watch = await activeWatch(t, a.userId, { targetCents: 5_000 });

    await tombstone(a.as);

    const sendSpy = vi.spyOn(agentmail, "sendMessage");
    const mailLogId = await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));
    expect(mailLogId).not.toBeNull();
    const row = await t.run((ctx) => ctx.db.get(mailLogId!));
    // `claimDrop` always leaves a bookkeeping row (T06's claim-before-send
    // design keeps one even when suppressed, as the in-app backstop for a
    // live account) -- "does nothing" is verified as "no live send, ever
    // suppressed, never queued/claimed", not literally zero writes.
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("deleted");
    expect(row?.outboundId).toBeUndefined();
    expect(row?.nextCheckAt).toBeUndefined(); // never eligible for sweepStalled to pick up
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("watches.sweep skips a tombstoned owner's due watch: rested far out, never scheduled for a check", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const watch = await activeWatch(t, a.userId, { nextCheckAt: T0 - 1_000 }); // already due

    await tombstone(a.as);

    const scheduledCount = await t.mutation(internal.watches.sweep, {});
    expect(scheduledCount).toBe(0);

    const after = await t.run((ctx) => ctx.db.get(watch._id));
    expect(after?.nextCheckAt).toBe(T0 + INELIGIBLE_REST_MS);
    expect(after?.lastCheckedAt).toBeUndefined(); // never actually checked
  });

  it("priceWatch.eligibleItems skips a tombstoned owner's otherwise-eligible item and rests it, while a live user's identical item is still returned", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const itemA = await eligibleItem(t, a.userId);
    const itemB = await eligibleItem(t, b.userId);

    await tombstone(a.as);

    const eligible = await t.mutation(internal.priceWatch.eligibleItems, {});
    expect(eligible).not.toContain(itemA);
    expect(eligible).toContain(itemB); // sanity: the fixture really was otherwise-eligible

    const after = await t.run((ctx) => ctx.db.get(itemA));
    expect(after?.nextCheckAt).toBe(T0 + INELIGIBLE_REST_MS);
  });

  it("market.requestLookup and the public market.refresh both refuse for a tombstoned owner's watch", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const watch = await activeWatch(t, a.userId);

    await tombstone(a.as);

    const result = await t.mutation(internal.market.requestLookup, { watchId: watch._id, trigger: "manual" });
    expect(result.scheduled).toBe(false);
    expect(result.reason).toBe("deleted");

    await expect(a.as.mutation(api.market.refresh, { watchId: watch._id })).rejects.toThrow();

    const after = await t.run((ctx) => ctx.db.get(watch._id));
    expect(after?.marketState).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("marketPrices").collect())).toHaveLength(0);
  });

  it("drafts.approveAndSend is refused for a tombstoned caller (requireUserId), before the draft is ever touched", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { draftId } = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId: a.userId, name: "Jacket", unitCents: 8_000, qty: 1, returned: true });
      const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId: a.userId, type: "price_adjustment", expectedCents: 500, status: "drafted", token: "tok-a", version: 1 });
      const draftId = await ctx.db.insert("drafts", { claimId, userId: a.userId, version: 1, claimVersion: 1, to: "merchant@acme.example", subject: "Price match", body: "Please refund the difference." });
      return { draftId };
    });

    await tombstone(a.as);

    await expect(
      a.as.mutation(api.drafts.approveAndSend, {
        draftId, to: "merchant@acme.example", subject: "Price match", body: "Please refund the difference.",
        claimVersion: 1, draftVersion: 1,
      }),
    ).rejects.toThrow();

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeUndefined();
  });

  it("followUps.fire treats a tombstoned owner's due reminder like a closed claim: cancelled, never surfaced on a board", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const { claimId } = await claimFixture(t, a.userId, { status: "drafted" });
    const followUpId = await t.run(async (ctx) => {
      const scheduledFnId = await ctx.scheduler.runAfter(999_999_999, internal.account.purgeStep, { userId: a.userId });
      return await ctx.db.insert("followUps", { claimId, userId: a.userId, scheduledFnId, fireAt: T0 - 1_000, claimVersion: 1, status: "pending" });
    });

    await tombstone(a.as);

    await t.mutation(internal.followUps.fire, { claimId });

    const followUp = await t.run((ctx) => ctx.db.get(followUpId));
    expect(followUp?.status).toBe("cancelled");
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.attentionAt).toBeUndefined();
  });

  it("intake.retryFailed does not resurrect a tombstoned owner's failed processedEvents row", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const rowId = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-a-1", kind: "agentmail.message.received", status: "failed", attempts: 1,
        userId: a.userId, route: "intake",
        payload: { inboxId: "inbox-a", messageId: "msg-1", subject: "Order confirmed", text: "1x Widget $40.00", from: "orders@store.example" },
      }),
    );

    await tombstone(a.as);

    const result = await t.mutation(internal.intake.retryFailed, {});
    expect(result.retried).toBe(0);

    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row?.status).toBe("succeeded");
    expect(row?.summary).toBe("Ignored: account deleted");
  });
});

// ---------------------------------------------------------------------------
// FINDING F-T21-1 (MEDIUM): the live inbound-webhook path is not gated on
// isTombstoned, unlike every scheduled sweep above.
//
// `inbound.onMessageReceived` routes purely on whether a `profiles` row
// still maps the inbox to a user; `intake.beginEvent` (the next hop for a
// fresh order/refund) checks only the per-user/global `inbound_extract`
// budget. Neither calls `isTombstoned`. `profiles` is the LAST table
// `account.purgeStep` drains (account.ts's `PURGE_STEPS`), so for the
// entire span between `requestDeletion` (tombstone `deleting`) and the
// moment a real purge finally reaches the `profiles` step, an inbound
// webhook for that inbox is routed exactly as if the account were still
// active: a fresh order/refund is routed "intake" and
// `intake.processEvent` is scheduled (an OpenAI extraction charged to the
// deployment's shared `inbound_extract` budget, followed by a write to
// `purchases`/`items` if it parses); a reply is routed "reply" and
// `replies.classify` is scheduled the same way.
//
// Compare D87's own routing list, which named `intake.retryFailed` (the
// hourly retry pass, proven skipping A above) as needing an `isTombstoned`
// guard and got one (intake.ts:947, 1012) -- but never named the live
// webhook path itself, which has none.
//
// Severity MEDIUM, not just wasted spend: if the scheduled extraction
// resolves AFTER `purgeStep` has already finished its `purchases`/`claims`
// steps for that purge pass, the row(s) it writes are never swept by that
// pass and can survive purge outright -- a direct violation of D87's
// invariant ("No scheduled job resurrects records: all readers check
// accountState") and D83(4)'s privacy-first deletion promise, even though
// `accountState.status` already reads "deleted". Bounded blast radius (the
// window is normally short, and a later purge run would still catch a
// straggling row on its NEXT pass through `purchases`/`claims`), which is
// why this is MEDIUM rather than HIGH.
//
// Repro below is deterministic and needs no OpenAI call: the routing
// decision this asserts is made synchronously inside
// `inbound.onMessageReceived`, before any scheduled work ever runs.
// Production fix belongs to sonnet-backend (convex/inbound.ts and/or
// convex/intake.ts); not fixed here per this task's tester-files-only
// scope.
// ---------------------------------------------------------------------------

describe("F-T21-1 (MEDIUM): inbound webhook mid-deletion is not gated on isTombstoned", () => {
  // T18.2/D115 6b-3: `inbound.onMessageReceived` now checks `isTombstoned`
  // right after resolving the profile, so this flips from `it.fails` to a
  // normal passing assertion (was failing against the pre-fix code: the
  // event used to route to "intake"/"reply", never "ignored").
  it(
    "routes an inbound webhook for a tombstoned-but-not-yet-purged inbox to ignored",
    async () => {
      const t = setup();
      const a = await signedIn(t, "A");
      await t.run((ctx) => ctx.db.insert("profiles", { userId: a.userId, inboxId: "inbox-a", inboxEmail: "a@example.com" }));

      await tombstone(a.as);
      // Deliberately not running any scheduled function: this is exactly the
      // window `requestDeletion` leaves between tombstoning and `profiles`
      // actually being drained, which a real purge also passes through.

      await t.mutation(internal.inbound.onMessageReceived, {
        eventId: "evt-mid-deletion",
        thread: {},
        message: inboundMessage(),
      });

      const [row] = await processedEvents(t);
      expect(row.route).toBe("ignored");
    },
  );
});

// ---------------------------------------------------------------------------
// Purge resumability, driven directly, then finished via the real action
// ---------------------------------------------------------------------------

describe("account.purge resumability", () => {
  it("interrupting purgeStep mid-way through a bulk table, then running the purge ACTION, still finishes the job", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const TOTAL = RETENTION_PAGE + 40;
    const inboxId = `inbox-${a.userId}`;
    const seeded = await t.run(async (ctx) => {
      const profileId = await ctx.db.insert("profiles", { userId: a.userId, inboxId, inboxEmail: "a@example.com" });
      const purchaseId = await ctx.db.insert("purchases", { userId: a.userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId: a.userId, name: "Jacket", unitCents: 8_000, qty: 1, returned: false });
      const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId: a.userId, type: "price_adjustment", expectedCents: 500, status: "detected", token: "tok-a", version: 1 });
      for (let i = 0; i < TOTAL; i++) {
        await ctx.db.insert("watches", { userId: a.userId, name: `Watch ${i}`, productUrl: `https://acme.example/p/${i}`, merchantDomain: "acme.example", status: "active", nextCheckAt: T0 });
      }
      return { profileId, purchaseId, itemId, claimId };
    });

    await tombstone(a.as);

    // Drive purgeStep directly, one bounded call at a time (simulating a
    // crash/redeploy mid-purge), until the bulk `watches` table first starts
    // shrinking (proof every earlier, empty step is behind us), then a few
    // calls further so the interruption lands mid-table, not at its first page.
    let remaining = TOTAL;
    let result = { done: false };
    for (let i = 0; i < 40 && remaining === TOTAL; i++) {
      result = await t.mutation(internal.account.purgeStep, { userId: a.userId });
      remaining = (await t.run((ctx) => ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).length;
    }
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(TOTAL); // the bulk table has started draining
    expect(result.done).toBe(false);

    // Resume with the real `purge` ACTION (not another manual purgeStep loop
    // -- T18's own resumability test already covers that shape): it must
    // read the persisted `accountState.progress` cursor and drive every
    // remaining step, the AgentMail inbox delete, `purgeAuth` and
    // `finishPurge` through to completion on its own.
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await t.action(internal.account.purge, { userId: a.userId, inboxId });

    expect(await t.run((ctx) => ctx.db.query("watches").withIndex("by_user", (q) => q.eq("userId", a.userId)).collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.get(seeded.purchaseId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(seeded.itemId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(seeded.claimId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(seeded.profileId))).toBeNull();

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted");
    expect(state?.inboxDeleted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Webhook after a FULL purge (distinct from the mid-deletion window above:
// here `profiles` really is gone, so the D33 "unroutable inbox" branch is
// the one that applies).
// ---------------------------------------------------------------------------

describe("webhook after a completed purge", () => {
  it("an inbound webhook for A's inbox after full purge is ignored, throws nothing, and writes only the processedEvents row", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const inboxId = `inbox-${a.userId}`;
    await t.run((ctx) => ctx.db.insert("profiles", { userId: a.userId, inboxId, inboxEmail: "a@example.com" }));
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);

    await tombstone(a.as);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", a.userId)).first());
    expect(state?.status).toBe("deleted"); // sanity: purge really completed before the webhook arrives

    await expect(
      t.mutation(internal.inbound.onMessageReceived, {
        eventId: "evt-after-purge",
        thread: {},
        message: inboundMessage({ message_id: "msg-after-purge" }),
      }),
    ).resolves.not.toThrow();

    const rows = await processedEvents(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe("ignored");
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].userId).toBeUndefined();

    // No writes beyond that one processedEvents row for this (now nonexistent) account.
    expect(await t.run((ctx) => ctx.db.query("purchases").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("claims").collect())).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A queued outbound mailLog row, produced by the real claimDrop/sendDrop
// flow (not hand-inserted), is suppressed the instant requestDeletion runs
// -- before purge ever reaches `mailLog` in PURGE_STEPS.
// ---------------------------------------------------------------------------

describe("a queued outbound mailLog row is suppressed immediately on deletion", () => {
  it("a drop alert already queued with the provider flips to suppressed/deleted the moment requestDeletion commits", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.patch(a.userId, { email: "a@example.com", emailVerificationTime: T0 }));
    await t.run((ctx) => ctx.db.insert("profiles", { userId: a.userId, inboxId: `inbox-${a.userId}`, inboxEmail: "a@example.com" }));
    const watch = await activeWatch(t, a.userId, { targetCents: 5_000 });

    vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-a" as never);
    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    await t.mutation(internal.notify.sendDrop, { mailLogId });
    const queued = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(queued?.status).toBe("queued"); // sanity: the fixture really reached "queued" before deletion

    await tombstone(a.as);

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("deleted");
  });
});
