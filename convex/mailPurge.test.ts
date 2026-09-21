import { describe, expect, test } from "vitest";
import { components, internal } from "./_generated/api";
import { setup } from "./test.setup";

/**
 * T18.4 (D115 6b-5): regression tests for the AgentMail component's
 * inbox-scoped purge (`purgeInbox`, patched into `@agentmail/convex` --
 * see `patches/@agentmail+convex+0.1.0.patch`) and the app-level driver
 * (`purgeInboxData`) and daily-sweep wrapper (`cleanupFinalizedOutbound`)
 * in `convex/mailPurge.ts`.
 *
 * Seeding strategy: convex-test's `t.run` only reaches the ROOT app's own
 * schema/database -- a registered component's tables are a separate mock
 * backend, invisible to `ctx.db` there. Component rows are seeded (and read
 * back) the same way a real client would: by calling the component's own
 * public/internal functions directly as `FunctionReference`s via
 * `t.mutation(components.agentmail.lib.<fn>, ...)` /
 * `t.query(components.agentmail.lib.<fn>, ...)`, exactly like the app code
 * in `convex/mail.ts`/`convex/claims.ts` does via `ctx.runMutation`/
 * `ctx.runQuery`. `handleEvent` (webhook ingest) seeds both `inboundMessages`
 * and `events` in one call; `enqueueSend` seeds `outboundMessages` without
 * needing the real send pipeline (HTTP fetch) to run -- the row is inserted
 * synchronously before the workpool action is scheduled, and this suite
 * never drains scheduled functions, so no network call ever happens.
 */

type T = ReturnType<typeof setup>;

const RUNTIME_CONFIG = { retryAttempts: 1, initialBackoffMs: 10 };

/** Seeds `count` distinct `message.received` webhook events for `inboxId`, which (via the component's own `handleEvent`) inserts one `inboundMessages` row AND one `events` row per call. */
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

/** Seeds `count` `outboundMessages` rows for `inboxId` via the component's own `enqueueSend`. Returns the created outboundIds. */
async function seedOutbound(t: T, inboxId: string, count: number) {
  const ids: Array<Awaited<ReturnType<typeof enqueueOne>>> = [];
  for (let i = 0; i < count; i++) {
    ids.push(await enqueueOne(t, inboxId, i));
  }
  return ids;

  function enqueueOne(tt: T, box: string, i: number) {
    return tt.mutation(components.agentmail.lib.enqueueSend, {
      config: RUNTIME_CONFIG,
      inboxId: box,
      kind: "send" as const,
      payload: { to: "dest@example.com", subject: `out ${i}`, text: "hi" },
    });
  }
}

describe("mailPurge", () => {
  test("purgeInbox drains one table per call, capped at 200 rows, and pages across a >200-row table", async () => {
    const t = setup();
    const inboxId = "inbox_solo";
    // 205 inbound messages also seeds 205 `events` rows (handleEvent logs both).
    await seedInboundAndEvents(t, inboxId, 205);

    const first = await t.mutation(components.agentmail.lib.purgeInbox, { inboxId });
    expect(first.deleted).toBeLessThanOrEqual(200);
    expect(first.deleted).toBe(200); // first page of the 205-row inboundMessages table
    expect(first.cursor).not.toBeNull(); // more inbound rows remain -> multi-page

    let cursor: string | null = first.cursor;
    let totalDeleted = first.deleted;
    let calls = 1;
    while (cursor !== null) {
      expect(calls).toBeLessThan(20); // safety bound: fail loudly instead of hanging on a design bug
      const page: { cursor: string | null; deleted: number } = await t.mutation(
        components.agentmail.lib.purgeInbox,
        { inboxId, cursor },
      );
      expect(page.deleted).toBeLessThanOrEqual(200);
      totalDeleted += page.deleted;
      cursor = page.cursor;
      calls++;
    }

    // 205 inboundMessages + 205 events (no outboundMessages seeded here).
    expect(totalDeleted).toBe(410);
    expect(calls).toBeGreaterThan(2); // proves this genuinely paged more than once

    const remaining = await t.query(components.agentmail.lib.listInboundMessages, { inboxId });
    expect(remaining).toHaveLength(0);

    // Re-running against an already-empty inbox is a no-op, not an error --
    // but note a *fresh* call (no `cursor`) always restarts the phase walk
    // at "inbound" (`decodePurgeCursor`'s documented behavior for an absent
    // cursor), so even an all-empty inbox still takes one call per phase
    // (inbound -> outbound -> events -> done) to confirm there is truly
    // nothing left; only `purgeInboxData`'s driving loop collapses that into
    // a single `{ complete: true, deleted: 0 }` (covered below). Every call
    // in this second pass must report zero deletions.
    let againCursor: string | null | undefined;
    let againCalls = 0;
    do {
      const page: { cursor: string | null; deleted: number } = await t.mutation(
        components.agentmail.lib.purgeInbox,
        { inboxId, cursor: againCursor ?? undefined },
      );
      expect(page.deleted).toBe(0);
      againCursor = page.cursor;
      againCalls++;
      expect(againCalls).toBeLessThan(10); // safety bound
    } while (againCursor !== null);
  });

  test("purgeInboxData purges inbox A across all three tables, leaves inbox B untouched, and is idempotent", async () => {
    const t = setup();
    const inboxA = "inbox_a";
    const inboxB = "inbox_b";

    await seedInboundAndEvents(t, inboxA, 205); // inboundMessages: 205, events: 205
    await seedOutbound(t, inboxA, 3); // outboundMessages: 3
    const totalA = 205 + 205 + 3;

    await seedInboundAndEvents(t, inboxB, 4); // inboundMessages: 4, events: 4
    await seedOutbound(t, inboxB, 2); // outboundMessages: 2
    const totalB = 4 + 4 + 2;

    const resultA = await t.action(internal.mailPurge.purgeInboxData, { inboxId: inboxA });
    expect(resultA).toEqual({ complete: true, deleted: totalA });

    // A's inbound rows are gone (direct read).
    const remainingA = await t.query(components.agentmail.lib.listInboundMessages, { inboxId: inboxA });
    expect(remainingA).toHaveLength(0);

    // B is untouched: its inbound rows are all still there...
    const remainingB = await t.query(components.agentmail.lib.listInboundMessages, { inboxId: inboxB });
    expect(remainingB).toHaveLength(4);

    // ...and purging B next still finds every row A's purge would have
    // deleted had it leaked across inboxes (outboundMessages/events have no
    // "list by inbox" query to read directly, so the exact deleted count is
    // the check: any cross-inbox deletion during A's purge would make this
    // total come up short).
    const resultB = await t.action(internal.mailPurge.purgeInboxData, { inboxId: inboxB });
    expect(resultB).toEqual({ complete: true, deleted: totalB });

    // Idempotent: purging already-empty inboxes reports nothing left to do,
    // both through the driving action and the raw component mutation.
    const resultAAgain = await t.action(internal.mailPurge.purgeInboxData, { inboxId: inboxA });
    expect(resultAAgain).toEqual({ complete: true, deleted: 0 });
    const resultBAgain = await t.action(internal.mailPurge.purgeInboxData, { inboxId: inboxB });
    expect(resultBAgain).toEqual({ complete: true, deleted: 0 });
  });

  test("cleanupFinalizedOutbound wrapper threads the cutoff through to the component's own sweep", async () => {
    const t = setup();
    const inboxId = "inbox_cleanup";
    const [outboundId] = await seedOutbound(t, inboxId, 1);

    // `cancelSend` finalizes a `pending` row to `failed` with
    // `finalizedAt: Date.now()` synchronously, without needing the real send
    // pipeline (workpool + HTTP fetch) to run.
    await t.mutation(components.agentmail.lib.cancelSend, { outboundId });
    const before = await t.query(components.agentmail.lib.getOutboundStatus, { outboundId });
    expect(before?.status).toBe("failed");

    // `olderThan: -1000` pushes the cutoff (`Date.now() - olderThan`) into
    // the future, so the row finalized "now" is older than the cutoff and
    // gets swept -- proving the wrapper actually forwards the cutoff instead
    // of only ever calling the component with its 7-day default.
    await t.mutation(internal.mailPurge.cleanupFinalizedOutbound, { olderThan: -1000 });

    const after = await t.query(components.agentmail.lib.getOutboundStatus, { outboundId });
    expect(after).toBeNull();
  });
});
