import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

const INBOX = "inbox_user_a";

// Routing schedules `intake.processEvent` / `replies.classify`. Fake timers
// keep convex-test from running those actions in the background (D31), so no
// test here touches OpenAI.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A signed-in user with a provisioned inbox and one purchased item. */
async function fixture(t: ReturnType<typeof setup>, inboxId = INBOX) {
  const { as, userId } = await signedIn(t);
  await t.mutation(internal.profiles.save, {
    userId,
    inboxId,
    inboxEmail: `${inboxId}@agentmail.to`,
  });
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Nordstrom",
    merchantDomain: "nordstrom.com",
    orderRef: "ORD-1",
    purchasedAt: Date.parse("2026-09-01"),
    currency: "USD",
    // needs_review keeps `create` from scheduling the Firecrawl policy fetch.
    status: "needs_review",
    items: [{ name: "Wool scarf", unitCents: 4_000, qty: 1 }],
  });
  const detail = await as.query(api.purchases.get, { purchaseId });
  return { as, userId, purchaseId, itemId: detail.items[0]._id };
}

async function openClaimFor(
  t: ReturnType<typeof setup>,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
  itemId: Id<"items">,
) {
  // claims.open only accepts an item already marked returned (D20).
  await as.mutation(api.purchases.setReturned, { itemId, returned: true });
  const claimId = await as.mutation(api.claims.open, { itemId });
  const claim = await t.run(async (ctx) => await ctx.db.get(claimId));
  return claim!;
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    inbox_id: INBOX,
    message_id: "msg-1",
    thread_id: "thread-1",
    subject: "Your order",
    text: "Thanks for shopping with us.",
    from: "orders@nordstrom.com",
    ...overrides,
  };
}

async function events(t: ReturnType<typeof setup>): Promise<Doc<"processedEvents">[]> {
  return await t.run(async (ctx) => await ctx.db.query("processedEvents").collect());
}

describe("inbound.onMessageReceived", () => {
  it("records an unroutable inbox as ignored rather than failing", async () => {
    const t = setup();
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-unknown",
      thread: {},
      message: message({ inbox_id: "inbox_nobody" }),
    });
    const [row] = await events(t);
    expect(row.route).toBe("ignored");
    expect(row.status).toBe("succeeded");
    expect(row.userId).toBeUndefined();
  });

  it("dedupes a redelivered event id", async () => {
    const t = setup();
    await fixture(t);
    const msg = message();
    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-dup", thread: {}, message: msg });
    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-dup", thread: {}, message: msg });
    expect(await events(t)).toHaveLength(1);
  });

  it("routes an unrecognised message to intake with the payload needed to retry", async () => {
    const t = setup();
    const { userId } = await fixture(t);
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-intake",
      thread: {},
      message: message({ subject: "Order confirmed", text: "1x Wool scarf $40.00" }),
    });
    const [row] = await events(t);
    expect(row.route).toBe("intake");
    expect(row.status).toBe("received");
    expect(row.userId).toBe(userId);
    expect(row.payload).toMatchObject({
      inboxId: INBOX,
      messageId: "msg-1",
      threadId: "thread-1",
      subject: "Order confirmed",
      from: "orders@nordstrom.com",
    });
  });

  it("routes by In-Reply-To against a draft we sent (D23 step 1)", async () => {
    const t = setup();
    const { as, userId, itemId } = await fixture(t);
    const claim = await openClaimFor(t, as, itemId);
    await t.run(async (ctx) => {
      await ctx.db.insert("drafts", {
        claimId: claim._id,
        userId,
        version: 1,
        claimVersion: claim.version,
        to: "help@nordstrom.com",
        subject: "Return credit",
        body: "…",
        agentmailMessageId: "sent-1",
      });
    });

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reply-header",
      thread: {},
      // No token in the subject and no thread on the claim: only the header can match.
      message: message({ subject: "Re: Return credit", in_reply_to: "sent-1", thread_id: "thread-9" }),
    });

    const [row] = await events(t);
    expect(row.route).toBe("reply");
    // Not `succeeded` until the reply is classified and applied (review H2).
    expect(row.status).toBe("processing");
    expect(row.claimId).toBe(claim._id);
    const after = await t.run(async (ctx) => await ctx.db.get(claim._id));
    expect(after?.threadId).toBe("thread-9");
  });

  it("routes by thread id when the claim already has a thread (D23 step 2)", async () => {
    const t = setup();
    const { as, itemId } = await fixture(t);
    const claim = await openClaimFor(t, as, itemId);
    await t.run(async (ctx) => await ctx.db.patch(claim._id, { threadId: "thread-live" }));

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reply-thread",
      thread: {},
      message: message({ subject: "Re: your request", thread_id: "thread-live" }),
    });
    const [row] = await events(t);
    expect(row.route).toBe("reply");
    expect(row.claimId).toBe(claim._id);
  });

  it("falls back to the subject token (D23 step 3)", async () => {
    const t = setup();
    const { as, itemId } = await fixture(t);
    const claim = await openClaimFor(t, as, itemId);

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reply-token",
      thread: {},
      message: message({ subject: `Re: Order [RC-${claim.token}]`, thread_id: "thread-token" }),
    });
    const [row] = await events(t);
    expect(row.route).toBe("reply");
    expect(row.claimId).toBe(claim._id);
    const after = await t.run(async (ctx) => await ctx.db.get(claim._id));
    expect(after?.threadId).toBe("thread-token");
  });

  it("never attaches a reply to another user's claim, even with a valid token", async () => {
    const t = setup();
    const a = await fixture(t, "inbox_a");
    const claim = await openClaimFor(t, a.as, a.itemId);
    const b = await fixture(t, "inbox_b");
    expect(b.userId).not.toBe(a.userId);

    // The token is real, but it arrives in the other user's inbox.
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-cross-user",
      thread: {},
      message: message({ inbox_id: "inbox_b", subject: `Re: [RC-${claim.token}]` }),
    });
    const row = (await events(t)).find((e) => e.externalId === "evt-cross-user")!;
    expect(row.route).toBe("intake");
    expect(row.claimId).toBeUndefined();
    expect(row.userId).toBe(b.userId);
  });

  it("does not throw on a malformed webhook payload (D33)", async () => {
    const t = setup();
    await expect(
      t.mutation(internal.inbound.onMessageReceived, {
        eventId: "evt-garbage",
        thread: null,
        message: "not an object",
      }),
    ).resolves.toBeNull();
    const [row] = await events(t);
    expect(row.route).toBe("ignored");
  });
});

describe("inbound.onMessageReceived — D112 6a-2 per-inbox rate limit", () => {
  it("the 61st message in an hour for one inbox is ignored with a rate_limited reason", async () => {
    const t = setup();
    await fixture(t);
    for (let i = 0; i < 60; i++) {
      await t.mutation(internal.inbound.onMessageReceived, {
        eventId: `evt-rl-${i}`,
        thread: {},
        message: message({ message_id: `m-rl-${i}` }),
      });
    }
    const sixty = (await events(t)).filter((e) => e.externalId.startsWith("evt-rl-"));
    expect(sixty).toHaveLength(60);
    expect(sixty.every((e) => e.route !== "ignored")).toBe(true);

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-rl-61",
      thread: {},
      message: message({ message_id: "m-rl-61" }),
    });
    const row61 = (await events(t)).find((e) => e.externalId === "evt-rl-61")!;
    expect(row61.route).toBe("ignored");
    expect(row61.status).toBe("succeeded");
    expect(row61.summary).toMatch(/rate limited/i);
  });

  it("a different inbox is unaffected by another inbox's exhausted window", async () => {
    const t = setup();
    await fixture(t, "inbox_a");
    for (let i = 0; i < 60; i++) {
      await t.mutation(internal.inbound.onMessageReceived, {
        eventId: `evt-a-${i}`,
        thread: {},
        message: message({ inbox_id: "inbox_a", message_id: `m-a-${i}` }),
      });
    }
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-a-61",
      thread: {},
      message: message({ inbox_id: "inbox_a", message_id: "m-a-61" }),
    });
    expect((await events(t)).find((e) => e.externalId === "evt-a-61")!.route).toBe("ignored");

    await fixture(t, "inbox_b");
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-b-1",
      thread: {},
      message: message({ inbox_id: "inbox_b", message_id: "m-b-1" }),
    });
    const rowB = (await events(t)).find((e) => e.externalId === "evt-b-1")!;
    expect(rowB.route).toBe("intake");
  });

  it("the window resets after an hour", async () => {
    const t = setup();
    await fixture(t);
    for (let i = 0; i < 60; i++) {
      await t.mutation(internal.inbound.onMessageReceived, {
        eventId: `evt-reset-${i}`,
        thread: {},
        message: message({ message_id: `m-reset-${i}` }),
      });
    }
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reset-over",
      thread: {},
      message: message({ message_id: "m-reset-over" }),
    });
    expect((await events(t)).find((e) => e.externalId === "evt-reset-over")!.route).toBe("ignored");

    vi.advanceTimersByTime(3_600_000 + 1);

    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-reset-after",
      thread: {},
      message: message({ message_id: "m-reset-after" }),
    });
    expect((await events(t)).find((e) => e.externalId === "evt-reset-after")!.route).toBe("intake");
  });
});

// ---------------------------------------------------------------------------
// D115 6b-3 / D116: checkpoint 6b's devil's-advocate repros F4a and F5
// (reviewer's scratchpad da6b.test.ts, ported here as regression tests).
// Both fail against the pre-T18.2 code (no tombstone gate in
// `onMessageReceived`, and `userId` was only ever patched on the reply/
// intake branches) and pass once the fix lands.
// ---------------------------------------------------------------------------

describe("inbound.onMessageReceived — D115 6b-3 tombstone gate (checkpoint 6b F4a)", () => {
  it("a webhook for a tombstoned-but-not-yet-purged account's inbox is routed to ignored, never reply/intake", async () => {
    const t = setup();
    const { userId } = await fixture(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );

    // Deliberately no scheduled purge is run: this is exactly the window
    // between `requestDeletion` and the moment a real purge reaches
    // `profiles`, which a real purge run also passes through.
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-mid-purge",
      thread: {},
      message: message({ message_id: "m-mid-purge" }),
    });

    const row = (await events(t)).find((e) => e.externalId === "evt-mid-purge")!;
    // Before the fix this routed to "intake" (findReplyClaim finds nothing
    // for an unrecognised message, same as the "routes an unrecognised
    // message to intake" case above) and scheduled `intake.processEvent`.
    expect(row.route).toBe("ignored");
    expect(row.status).toBe("succeeded");
    expect(row.summary).toBe("Ignored: account deleted");
    expect(row.userId).toBe(userId); // 6b-7: still owned, even on the ignored branch.
  });
});

describe("inbound.onMessageReceived — D115 6b-7 owned rows (checkpoint 6b F5)", () => {
  it("a rate-limited inbound row still carries userId, so an account-deletion purge can find it", async () => {
    const t = setup();
    const { userId } = await fixture(t);
    for (let i = 0; i < 60; i++) {
      await t.mutation(internal.inbound.onMessageReceived, {
        eventId: `evt-owned-${i}`,
        thread: {},
        message: message({ message_id: `m-owned-${i}` }),
      });
    }
    await t.mutation(internal.inbound.onMessageReceived, {
      eventId: "evt-owned-61",
      thread: {},
      message: message({ message_id: "m-owned-61" }),
    });

    const ignored = (await events(t)).find((e) => e.externalId === "evt-owned-61")!;
    expect(ignored.route).toBe("ignored");
    expect(ignored.summary).toMatch(/rate limited/i);
    // Before the fix this row's `userId` was never set: a rate-limited row
    // for a REAL, resolved inbox kept the mail text forever with no owner
    // for the account-deletion purge to ever find.
    expect(ignored.userId).toBe(userId);
  });
});
