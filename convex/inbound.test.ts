import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

async function openReturnClaim(
  t: ReturnType<typeof setup>,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
) {
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Northwind",
    merchantDomain: "n.example",
    purchasedAt: 0,
    currency: "USD",
    items: [{ name: "Scarf", unitCents: 4000, qty: 1 }],
  });
  const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
  await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
  const claimId = await as.mutation(api.claims.open, { itemId: items[0]._id });
  const { claim } = (await as.query(api.claims.get, { claimId }))!;
  return { purchaseId, itemId: items[0]._id, claimId, claim };
}

async function eventByExternal(t: ReturnType<typeof setup>, externalId: string) {
  return t.run((ctx) =>
    ctx.db.query("processedEvents").withIndex("by_external", (q) => q.eq("externalId", externalId)).first(),
  );
}

describe("inbound.onMessageReceived routing", () => {
  it("routes by the claim token embedded in the subject and captures the thread", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "recoup-x@agentmail.to", inboxEmail: "recoup-x@agentmail.to" });
    const { claimId, claim } = await openReturnClaim(t, as);

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-token",
      thread: {},
      message: {
        inbox_id: "recoup-x@agentmail.to",
        message_id: "m1",
        thread_id: "th-token",
        subject: `Re: Order [RC-${claim.token}]`,
        text: "Refund is processing",
        from: "support@n.example",
      },
    });

    const row = await eventByExternal(t, "evt-token");
    expect(row?.route).toBe("reply");
    expect(row?.claimId).toBe(claimId);
    expect(row?.status).toBe("processing");

    // Read the claim directly rather than through `api.claims.get`: that
    // query also fetches `components.agentmail.lib.listInboundMessages`
    // once `threadId` is set, which is an existing, untested code path in
    // claims.ts (not owned by this task) that convex-test's component
    // module resolution currently can't reach from a nested query call.
    const after = await t.run((ctx) => ctx.db.get(claimId));
    expect(after?.threadId).toBe("th-token");
  });

  it("routes by an existing AgentMail thread id when the subject carries no token", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const { claimId } = await openReturnClaim(t, as);
    await t.run((ctx) => ctx.db.patch(claimId, { threadId: "th-existing" }));

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-thread",
      thread: {},
      message: {
        inbox_id: "i@agentmail.to",
        message_id: "m2",
        thread_id: "th-existing",
        subject: "no token here",
        text: "x",
        from: "a@b.c",
      },
    });

    const row = await eventByExternal(t, "evt-thread");
    expect(row?.route).toBe("reply");
    expect(row?.claimId).toBe(claimId);
  });

  it("routes by In-Reply-To against a draft's recorded agentmailMessageId", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const { claimId } = await openReturnClaim(t, as);
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await t.run((ctx) => ctx.db.patch(draftId, { agentmailMessageId: "am-msg-1" }));

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reply",
      thread: {},
      message: {
        inbox_id: "i@agentmail.to",
        message_id: "m3",
        thread_id: "th-new",
        subject: "Re: s",
        text: "ok",
        from: "support@n.example",
        in_reply_to: "am-msg-1",
      },
    });

    const row = await eventByExternal(t, "evt-reply");
    expect(row?.route).toBe("reply");
    expect(row?.claimId).toBe(claimId);
  });

  it("routes anything unmatched to intake", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i2@agentmail.to", inboxEmail: "i2@agentmail.to" });

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-intake",
      thread: {},
      message: {
        inbox_id: "i2@agentmail.to",
        message_id: "m4",
        thread_id: "th4",
        subject: "Your order shipped",
        text: "...",
        from: "a@b.c",
      },
    });

    const row = await eventByExternal(t, "evt-intake");
    expect(row?.route).toBe("intake");
    expect(row?.userId).toBe(userId);
    expect(row?.status).toBe("processing");
  });

  it("marks an unknown inbox ignored and succeeded without needing a user", async () => {
    const t = setup();

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-unknown",
      thread: {},
      message: {
        inbox_id: "nope@agentmail.to",
        message_id: "m5",
        thread_id: "th5",
        subject: "x",
        text: "y",
        from: "a@b.c",
      },
    });

    const row = await eventByExternal(t, "evt-unknown");
    expect(row?.route).toBe("ignored");
    expect(row?.status).toBe("succeeded");
    expect(row?.summary).toBe("Unknown inbox");
  });

  it("dedupes a replayed event id to a single processedEvents row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i3@agentmail.to", inboxEmail: "i3@agentmail.to" });
    const msg = {
      inbox_id: "i3@agentmail.to",
      message_id: "m6",
      thread_id: "th6",
      subject: "Order",
      text: "x",
      from: "a@b.c",
    };
    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-dup", thread: {}, message: msg });
    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-dup", thread: {}, message: msg });

    const rows = await t.run((ctx) => ctx.db.query("processedEvents").collect());
    expect(rows.filter((r) => r.externalId === "evt-dup")).toHaveLength(1);
  });
});

describe("inbound.retryEvent", () => {
  it("moves a failed event back to processing and bumps attempts, owner-gated", async () => {
    const t = setup();
    const { userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");

    const eventId: Id<"processedEvents"> = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-retry",
        kind: "paste",
        status: "processing",
        attempts: 1,
        userId: aliceId,
        payload: {},
      }),
    );
    await t.mutation(internal.inbound.markProcessed, { eventId, status: "failed", lastError: "boom" });

    await expect(bob.mutation(api.inbound.retryEvent, { eventId })).rejects.toThrow();

    // Re-sign-in as Alice via a fresh identity bound to her own userId.
    const alice = t.withIdentity({ subject: `${aliceId}|session` });
    await alice.mutation(api.inbound.retryEvent, { eventId });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("processing");
    expect(row?.attempts).toBe(2);
  });

  it("refuses to retry a non-failed event", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const eventId: Id<"processedEvents"> = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-not-failed",
        kind: "paste",
        status: "succeeded",
        attempts: 1,
        userId,
        payload: {},
      }),
    );
    await expect(as.mutation(api.inbound.retryEvent, { eventId })).rejects.toThrow();
  });
});
