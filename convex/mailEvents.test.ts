import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

/**
 * `mailEvents.onEvent` (T06, D69, D85): the AgentMail component's webhook
 * callback for everything that is NOT inbound mail. No network and no
 * webhook signature here -- `convex/http.test.ts` already covers the
 * signed-delivery path into the component; this file drives the internal
 * mutation directly with `t.mutation(internal.mailEvents.onEvent, { event })`,
 * as the task's own test plan specifies, and owns the module's full
 * contract-mapped suite (mailLog side + drafts side, every relevant event
 * type, idempotency).
 */

type T = ReturnType<typeof setup>;

function bounceEvent(messageId: string, over: Record<string, unknown> = {}) {
  return {
    type: "event" as const,
    event_type: "message.bounced" as const,
    event_id: "evt-bounce-1",
    bounce: { message_id: messageId },
    ...over,
  };
}

function rejectEvent(messageId: string) {
  return {
    type: "event" as const,
    event_type: "message.rejected" as const,
    event_id: "evt-reject-1",
    reject: { message_id: messageId },
  };
}

function complaintEvent(messageId: string, over: Record<string, unknown> = {}) {
  return {
    type: "event" as const,
    event_type: "message.complained" as const,
    event_id: "evt-complaint-1",
    complaint: { message_id: messageId },
    ...over,
  };
}

function deliveredEvent(messageId: string) {
  return {
    type: "event" as const,
    event_type: "message.delivered" as const,
    event_id: "evt-delivered-1",
    delivery: { message_id: messageId },
  };
}

async function verifiedUser(t: T, name = "Tester") {
  const { userId, as } = await signedIn(t, name);
  await t.run((ctx) => ctx.db.patch(userId, { email: "sam@home.example", emailVerificationTime: Date.now() }));
  return { userId, as };
}

async function sentMailLog(t: T, userId: Id<"users">, messageId: string) {
  return await t.run((ctx) =>
    ctx.db.insert("mailLog", {
      userId,
      dedupeKey: `watch:seed:${messageId}`,
      kind: "price_drop",
      to: "sam@home.example",
      subject: "Recoup price alert: an item you are watching dropped",
      status: "sent",
      outboundId: "outbound-1" as never,
      agentmailMessageId: messageId,
      cents: 1_000,
      sentAt: Date.now(),
    }),
  );
}

async function alertSettingsRow(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("alertSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

/** A claim/draft pair standing in `sent`, with the draft carrying `messageId` as its confirmed AgentMail message id. */
async function sentClaimAndDraft(t: T, userId: Id<"users">, messageId: string) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: "acme.example", currency: "USD", status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId, userId, name: "Scarf", unitCents: 4_000, qty: 1, returned: true,
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "return_credit", expectedCents: 4_000,
      status: "sent", token: "AB12CD", version: 1,
    });
    const draftId = await ctx.db.insert("drafts", {
      claimId, userId, version: 1, claimVersion: 1, to: "support@acme.example",
      subject: "Re: refund [RC-AB12CD]", body: "body", outboundId: "outbound-1" as never,
      agentmailMessageId: messageId,
    });
    return { claimId, draftId };
  });
}

describe("mailEvents.onEvent: mailLog (price-drop alerts)", () => {
  it("bounce on a sent row -> failed, reason send_failed, providerStatus bounced, address suppressed", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-1");

    const result = await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-1") });
    expect(result).toBeNull();

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("send_failed");
    expect(row?.providerStatus).toBe("bounced");
    expect(row?.error).toMatch(/bounced/);
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("bounced");
    expect(settings?.suppressedAt).toBeDefined();
  });

  it("reject also maps to failed + suppressed bounced (schema has no distinct 'rejected' suppression reason)", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-2");

    await t.mutation(internal.mailEvents.onEvent, { event: rejectEvent("msg-2") });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    expect(row?.providerStatus).toBe("rejected");
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("bounced");
  });

  it("complaint on a sent row stays sent, records providerStatus complained, suppresses the address", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-3");

    await t.mutation(internal.mailEvents.onEvent, { event: complaintEvent("msg-3") });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent"); // it WAS delivered; the complaint is a flag, not an undelivery
    expect(row?.providerStatus).toBe("complained");
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("complained");
  });

  it("a bounce whose message id matches nothing is a no-op", async () => {
    const t = setup();
    await expect(t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("no-such-id") })).resolves.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("alertSettings").collect())).toHaveLength(0);
  });

  it("a bounce on a row that is not (yet) sent -- e.g. still queued -- is left for the polling path, not touched here", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    // Deliberately no agentmailMessageId yet (as a real queued row would be, per the contract's note that polling
    // is the first place most bounces are seen), but seed one anyway to prove onEvent still respects the status guard.
    const mailLogId = await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId, dedupeKey: "watch:seed:queued", kind: "price_drop", to: "sam@home.example", subject: "s",
        status: "queued", outboundId: "outbound-1" as never, agentmailMessageId: "msg-4", cents: 1,
      }),
    );
    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-4") });
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("queued"); // untouched
  });

  it("duplicate delivery of the same bounce event is idempotent", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-5");
    const e = bounceEvent("msg-5");

    await t.mutation(internal.mailEvents.onEvent, { event: e });
    await t.mutation(internal.mailEvents.onEvent, { event: e }); // at-least-once redelivery

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    const settingsRows = await t.run((ctx) => ctx.db.query("alertSettings").collect());
    expect(settingsRows).toHaveLength(1); // not double-suppressed / re-inserted
  });

  it("message.received and domain.verified never touch mailLog", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-6");
    await t.mutation(internal.mailEvents.onEvent, {
      event: { type: "event", event_type: "message.received", event_id: "e1", message: { message_id: "msg-6" } },
    });
    await t.mutation(internal.mailEvents.onEvent, {
      event: { type: "event", event_type: "domain.verified", event_id: "e2", domain: { message_id: "msg-6" } },
    });
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
  });

  it("a plain delivered event (no bounce/complaint) is a no-op here", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-7");
    await t.mutation(internal.mailEvents.onEvent, { event: deliveredEvent("msg-7") });
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    expect(row?.providerStatus).toBeUndefined();
  });
});

describe("mailEvents.onEvent: drafts (merchant mail)", () => {
  it("late bounce on a sent draft sets sendError and records a claim note, without touching claim status or scheduling a resend", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const { claimId, draftId } = await sentClaimAndDraft(t, userId, "msg-draft-1");

    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-draft-1") });

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toMatch(/bounced/);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent"); // no auto-resend / no auto-revert, per this task's narrower instruction
    const notes = await t.run((ctx) =>
      ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("status");
    expect(notes[0].text).toMatch(/bounced/);

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0); // no auto-resend
  });

  it("late complaint on a sent draft sets sendError and records a claim note the same way", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const { claimId, draftId } = await sentClaimAndDraft(t, userId, "msg-draft-2");

    await t.mutation(internal.mailEvents.onEvent, { event: complaintEvent("msg-draft-2") });

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toMatch(/spam/i);
    const notes = await t.run((ctx) =>
      ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(notes).toHaveLength(1);
  });

  it("does nothing when the claim has already moved on from sent (e.g. confirmed)", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const { claimId, draftId } = await sentClaimAndDraft(t, userId, "msg-draft-3");
    await t.run((ctx) => ctx.db.patch(claimId, { status: "confirmed" }));

    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-draft-3") });

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toBeUndefined();
    const notes = await t.run((ctx) =>
      ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(notes).toHaveLength(0);
  });

  it("duplicate delivery on a draft is idempotent (one note, not two)", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const { claimId, draftId } = await sentClaimAndDraft(t, userId, "msg-draft-4");
    const e = bounceEvent("msg-draft-4");

    await t.mutation(internal.mailEvents.onEvent, { event: e });
    await t.mutation(internal.mailEvents.onEvent, { event: e }); // at-least-once redelivery

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toMatch(/bounced/);
    const notes = await t.run((ctx) =>
      ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    // Guarded on `!draft.sendError` (this handler never changes claim.status
    // the way the mailLog branch's status guard does), so the second
    // delivery finds sendError already set and does not add a second note.
    expect(notes).toHaveLength(1);
  });
});

describe("mailEvents.onEvent: F10 isTombstoned guard around suppressAddress", () => {
  it("a tombstoned user's late bounce still updates the sent mailLog row, but creates no alertSettings row", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
    const mailLogId = await sentMailLog(t, userId, "msg-tomb-1");

    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-tomb-1") });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed"); // the row's own status is still recorded
    const settings = await alertSettingsRow(t, userId);
    expect(settings).toBeNull(); // ...but no alertSettings row was created for the tombstoned user
  });
});

describe("mailEvents.onEvent: F8 stashes an unmapped bounce/complaint for a later reconcile", () => {
  it("an id that matches neither a mailLog nor a drafts row is stashed in opsState under mailEvent:<id>, not silently dropped", async () => {
    const t = setup();
    await t.mutation(internal.mailEvents.onEvent, { event: complaintEvent("msg-unmapped-1") });

    const row = await t.run((ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-unmapped-1")).unique(),
    );
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.cursor!)).toMatchObject({ reason: "complained", providerStatus: "complained" });
  });
});

describe("mailEvents.onEvent: N7 (checkpoint-4 recheck) stash cleanup for an id that is already resolved", () => {
  it("does not re-stash a redelivered bounce once the mailLog row it maps to has already gone terminal", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    const mailLogId = await sentMailLog(t, userId, "msg-redeliver-1");

    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-redeliver-1") }); // -> failed
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("failed");

    // At-least-once redelivery of the SAME event, now that the row is terminal: under the old
    // logic this fell to `else if (!draftRow)` (true, since no draft is involved here) and stashed
    // the id anyway, even though nothing will ever consume it again (N7).
    await t.mutation(internal.mailEvents.onEvent, { event: bounceEvent("msg-redeliver-1") });

    const stash = await t.run((ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-redeliver-1")).unique(),
    );
    expect(stash).toBeNull();
  });

  it("clears a pre-existing stash entry once a row is found for that id, even on the same event that resolves it", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t);
    // Simulates a stash left behind by an earlier race; nothing under normal operation should be
    // able to produce this, but a defensive cleanup keeps it from lingering forever either way.
    await t.run((ctx) =>
      ctx.db.insert("opsState", {
        key: "mailEvent:msg-orphan-1",
        cursor: JSON.stringify({ reason: "bounced", providerStatus: "bounced" }),
        updatedAt: Date.now(),
      }),
    );
    await sentMailLog(t, userId, "msg-orphan-1");

    await t.mutation(internal.mailEvents.onEvent, { event: complaintEvent("msg-orphan-1") });

    const stash = await t.run((ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-orphan-1")).unique(),
    );
    expect(stash).toBeNull();
  });
});
