import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { applySendOutcome } from "./drafts";

/**
 * Drafts, the approved send and the D13 reconcile job. Nothing here talks to
 * the network: `generate` (OpenAI) is exercised live instead, and the
 * AgentMail delivery observations that `reconcileSend` reads are fed to the
 * exported `applySendOutcome` directly.
 */

const DOMAIN = "acme.example";
const CONTACT = "support@acme.example";

type Seeded = {
  purchaseId: Id<"purchases">;
  itemId: Id<"items">;
  claimId: Id<"claims">;
};

async function seed(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  opts: { status?: "detected" | "drafted" | "queued" | "sent" | "confirmed" | "dismissed" } = {},
): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: DOMAIN,
      orderRef: "AC-1",
      purchasedAt: Date.UTC(2026, 0, 2),
      currency: "USD",
      status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: "Scarf",
      unitCents: 4000,
      qty: 1,
      returned: true,
      returnedAt: Date.UTC(2026, 0, 9),
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId,
      itemId,
      userId,
      type: "return_credit",
      expectedCents: 4000,
      status: opts.status ?? "detected",
      token: "AB12CD",
      version: 1,
    });
    return { purchaseId, itemId, claimId };
  });
}

async function withInbox(t: ReturnType<typeof setup>, userId: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("profiles", {
      userId,
      inboxId: "inbox_1",
      inboxEmail: "user@agentmail.to",
    });
  });
}

async function confirmedPolicy(t: ReturnType<typeof setup>, userId: Id<"users">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("policies", {
      userId,
      merchantDomain: DOMAIN,
      kind: "returns",
      windowDays: 30,
      channel: "email",
      contactEmail: CONTACT,
      passage: "Return most items within 30 days.",
      sourceUrl: `https://${DOMAIN}/returns`,
      retrievedAt: Date.now(),
      confidence: 0.9,
      confirmedByUser: true,
    });
  });
}

async function newDraft(
  t: ReturnType<typeof setup>,
  claimId: Id<"claims">,
  userId: Id<"users">,
  to = CONTACT,
): Promise<Id<"drafts">> {
  return await t.mutation(internal.drafts.insert, {
    claimId,
    userId,
    to,
    subject: "Refund for order AC-1 [RC-AB12CD]",
    body: "Hello, could you confirm the credit for my returned scarf?",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("drafts.insert", () => {
  it("versions drafts, binds each to the claim version and moves detected to drafted", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await seed(t, userId);

    const first = await newDraft(t, claimId, userId);
    const second = await newDraft(t, claimId, userId);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("drafts")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(rows.map((r) => r.version).sort()).toEqual([1, 2]);
    expect(rows.every((r) => r.claimVersion === 1)).toBe(true);
    expect(first).not.toBe(second);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
  });

  it("refuses to write a draft onto another user's claim", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await seed(t, owner.userId);

    await expect(newDraft(t, claimId, other.userId)).rejects.toThrow(/Claim not found/);
  });
});

describe("drafts.approveAndSend guards", () => {
  it("refuses when the claim changed after the draft was written", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    await as.mutation(api.claims.adjustExpected, {
      claimId,
      expectedCents: 3300,
      reason: "restocking fee",
    });

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "Refund for order AC-1",
        body: "Hello",
        claimVersion: 2,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/claim changed/i);
  });

  it("refuses a stale draft version", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 7,
      }),
    ).rejects.toThrow(/draft changed/i);
  });

  it("refuses an empty recipient", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId, "");

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: "   ",
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/recipient/i);
  });

  it("refuses an unconfirmed recipient that is not a user-confirmed policy contact (D18)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId, "someone@elsewhere.example");

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: "someone@elsewhere.example",
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/Confirm this recipient/i);
  });

  it("refuses an unticked recipient when the policy contact was never confirmed (D18)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("policies", {
        userId,
        merchantDomain: DOMAIN,
        kind: "returns",
        channel: "email",
        contactEmail: CONTACT,
        passage: "",
        sourceUrl: `https://${DOMAIN}/returns`,
        retrievedAt: Date.now(),
        confidence: 0.5,
        confirmedByUser: false,
      });
    });
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/Confirm this recipient/i);
  });

  it("refuses a second click once outboundId is recorded", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, {
        outboundId: "already-enqueued" as never,
        approvedAt: Date.now(),
      });
    });

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/already sent/i);
  });

  it("refuses a second ask while one is queued, and any ask on a closed claim (review H6)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    for (const [status, message] of [
      ["queued", /already being sent/i],
      ["confirmed", /closed/i],
      ["dismissed", /closed/i],
    ] as const) {
      const { claimId } = await seed(t, userId, { status });
      const draftId = await newDraft(t, claimId, userId);
      await expect(
        as.mutation(api.drafts.approveAndSend, {
          draftId,
          to: CONTACT,
          subject: "s",
          body: "b",
          claimVersion: 1,
          draftVersion: 1,
          recipientConfirmed: true,
        }),
      ).rejects.toThrow(message);
    }
  });

  it("refuses to send before the user has an inbox", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/inbox/i);
  });

  it("refuses to send another user's draft", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    await withInbox(t, owner.userId);
    await confirmedPolicy(t, owner.userId);
    const { claimId } = await seed(t, owner.userId);
    const draftId = await newDraft(t, claimId, owner.userId);

    await expect(
      other.as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "s",
        body: "b",
        claimVersion: 1,
        draftVersion: 1,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/Draft not found/);
  });
});

describe("drafts.approveAndSend reaches the component", () => {
  /**
   * The enqueue itself cannot run under convex-test: `@agentmail/convex@0.1.0`
   * ships `dist/test.js` with `import.meta.glob("./component/**\/*.ts")`
   * resolved against `dist/`, which contains only compiled `.js`, so the
   * component's module map is empty and any dispatch into it fails with
   * "Could not find module". What this test can prove is that every D11/D18
   * guard passes for a confirmed policy contact and the failure is the
   * harness, not a refusal. The send itself is verified live.
   */
  it("passes every guard for a user-confirmed policy contact without an explicit tick", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: CONTACT,
        subject: "Refund for order AC-1",
        body: "Hello, could you confirm the credit?",
        claimVersion: 1,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/Could not find module/);

    // The mutation rolled back, so nothing was half-written.
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeUndefined();
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
  });
});

describe("drafts.reconcileSend transitions (D13)", () => {
  async function sentDraft(t: ReturnType<typeof setup>, userId: Id<"users">) {
    const { claimId } = await seed(t, userId, { status: "queued" });
    const draftId = await newDraft(t, claimId, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(draftId, {
        outboundId: "outbound-1" as never,
        approvedAt: Date.now(),
      });
    });
    return { claimId, draftId };
  }

  it("moves the claim to sent, captures the thread and schedules the reminder", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);

    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, {
        status: "sent",
        agentmailMessageId: "msg-1",
        threadId: "thread-1",
        errorMessage: null,
      }),
    );
    expect(outcome).toBe("sent");

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
    expect(claim?.threadId).toBe("thread-1");

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.agentmailMessageId).toBe("msg-1");

    const followUps = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(followUps).toHaveLength(1);
    expect(followUps[0].status).toBe("pending");
  });

  it("returns the claim to drafted with a sendError on a bounce, and schedules no reminder", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);

    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, {
        status: "bounced",
        agentmailMessageId: null,
        threadId: null,
        errorMessage: "mailbox does not exist",
      }),
    );
    expect(outcome).toBe("failed");

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toBe("mailbox does not exist");
    // Cleared so the user can correct the address and approve again.
    expect(draft?.outboundId).toBeUndefined();
    expect(draft?.approvedAt).toBeUndefined();

    const followUps = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(followUps).toHaveLength(0);
  });

  it("treats a bounce that still carries a message id as a failure, never as sent (review H3)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);

    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, {
        status: "bounced",
        agentmailMessageId: "msg-bounced-1",
        threadId: "thread-1",
        errorMessage: "mailbox does not exist",
      }),
    );
    expect(outcome).toBe("failed");
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
  });

  it("retries while attempts remain and ends at sendUnknown, never at sent", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);
    const pending = {
      status: "pending",
      agentmailMessageId: null,
      threadId: null,
      errorMessage: null,
    };

    // Five checks total: attempts 1-4 reschedule, the fifth gives up.
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 1, pending))).toBe("retrying");
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 2, pending))).toBe("retrying");
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 4, pending))).toBe("retrying");

    const claimMidway = await t.run((ctx) => ctx.db.get(claimId));
    expect(claimMidway?.status).toBe("queued");
    expect(claimMidway?.sendUnknown).toBeUndefined();

    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 5, null))).toBe("unknown");
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true);
  });

  it("is a no-op once the outbound binding is gone", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await seed(t, userId, { status: "queued" });
    const draftId = await newDraft(t, claimId, userId);

    const outcome = await t.run((ctx) =>
      applySendOutcome(ctx, draftId, 1, {
        status: "sent",
        agentmailMessageId: "msg-2",
        threadId: "thread-2",
        errorMessage: null,
      }),
    );
    expect(outcome).toBe("gone");
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
  });

  it("does not re-schedule a reminder when a later observation arrives for a sent claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);
    const observation = {
      status: "delivered",
      agentmailMessageId: "msg-3",
      threadId: "thread-3",
      errorMessage: null,
    };

    await t.run((ctx) => applySendOutcome(ctx, draftId, 1, observation));
    await t.run((ctx) => applySendOutcome(ctx, draftId, 2, observation));

    const followUps = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(followUps).toHaveLength(1);
  });
});

describe("drafts.update", () => {
  it("edits an unsent draft and clears the prior approval", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);
    await t.run((ctx) => ctx.db.patch(draftId, { approvedAt: Date.now() }));

    await as.mutation(api.drafts.update, {
      draftId,
      to: "help@acme.example",
      subject: "New subject",
      body: "New body",
    });

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.to).toBe("help@acme.example");
    expect(draft?.approvedAt).toBeUndefined();
  });

  it("refuses to edit a draft that already left the outbox", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);
    await t.run((ctx) => ctx.db.patch(draftId, { outboundId: "outbound-9" as never }));

    await expect(
      as.mutation(api.drafts.update, { draftId, to: CONTACT, subject: "s", body: "b" }),
    ).rejects.toThrow(/already sent/i);
  });
});

describe("drafts.markPacketSent (D24)", () => {
  it("moves the claim to packet, writes a note and no ledger event, and reminds", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { claimId } = await seed(t, userId, { status: "drafted" });

    await as.mutation(api.drafts.markPacketSent, {
      claimId,
      note: "Submitted the web form, case #4471",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("packet");

    const notes = await t.run((ctx) =>
      ctx.db
        .query("claimNotes")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe("status");
    expect(notes[0].text).toContain("case #4471");

    const events = await t.run((ctx) =>
      ctx.db
        .query("ledgerEvents")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(events).toHaveLength(0);

    const followUps = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(followUps).toHaveLength(1);
  });

  it("refuses on another user's claim", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await seed(t, owner.userId);

    await expect(
      other.as.mutation(api.drafts.markPacketSent, { claimId, note: "x" }),
    ).rejects.toThrow(/Claim not found/);
  });
});

describe("drafts.sendStatus + listForClaim (D29)", () => {
  it("returns null for a draft that has not been sent and refuses another user's draft", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await seed(t, owner.userId);
    const draftId = await newDraft(t, claimId, owner.userId);

    expect(await owner.as.query(api.drafts.sendStatus, { draftId })).toBeNull();
    await expect(other.as.query(api.drafts.sendStatus, { draftId })).rejects.toThrow(
      /Draft not found/,
    );
  });

  it("lists a claim's draft versions newest first for the owner only", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await seed(t, owner.userId);
    await newDraft(t, claimId, owner.userId);
    await newDraft(t, claimId, owner.userId);

    const rows = await owner.as.query(api.drafts.listForClaim, { claimId });
    expect(rows.map((r) => r.version)).toEqual([2, 1]);
    await expect(other.as.query(api.drafts.listForClaim, { claimId })).rejects.toThrow(
      /Claim not found/,
    );
  });
});

describe("emailDomain (review H4)", () => {
  it("reads the domain out of a display-name From header", async () => {
    const { emailDomain } = await import("./drafts");
    expect(emailDomain("Acme Support <Help@Acme.com>")).toBe("acme.com");
    expect(emailDomain("help@acme.com")).toBe("acme.com");
    expect(emailDomain("no address here")).toBeNull();
  });
});
