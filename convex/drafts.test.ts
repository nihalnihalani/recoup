import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { applySendOutcome, BACKOFF_MS, subjectWithToken } from "./drafts";
import { agentmail } from "./mail";
import { DAILY_BUDGETS, MAX_SENDS_PER_CLAIM } from "./limits";

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
  opts: {
    status?: "detected" | "drafted" | "queued" | "sent" | "packet" | "confirmed" | "dismissed";
  } = {},
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
  vi.restoreAllMocks();
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

describe("subjectWithToken (D58)", () => {
  it("appends the token when there is none", () => {
    expect(subjectWithToken("Refund for order AC-1", "AB12CD")).toBe(
      "Refund for order AC-1 [RC-AB12CD]",
    );
  });

  it("strips a stale token before appending the current one", () => {
    expect(subjectWithToken("Re: Refund for order AC-1 [RC-ZZ99ZZ]", "AB12CD")).toBe(
      "Re: Refund for order AC-1 [RC-AB12CD]",
    );
  });

  it("strips every stale token, however many are present", () => {
    expect(subjectWithToken("Order [RC-111111] update [RC-222222]", "AB12CD")).toBe(
      "Order update [RC-AB12CD]",
    );
  });
});

describe("drafts.approveAndSend guards", () => {
  it("refuses when a newer draft exists for the claim (D58)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const olderDraftId = await newDraft(t, claimId, userId);
    await newDraft(t, claimId, userId); // a newer draft, version 2

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId: olderDraftId,
        to: CONTACT,
        subject: "Refund for order AC-1",
        body: "Hello",
        claimVersion: 1,
        draftVersion: 1,
      }),
    ).rejects.toThrow(/newer draft exists/i);
  });

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
   * Enqueuing through the real `agentmail` component now works under
   * convex-test: `test.setup.ts` restored the D51 exhaustive-glob
   * registration for the "agentmail" component and its two nested
   * "agentmail/sendPool"/"agentmail/callbackPool" workpools (T01), replacing
   * the empty module map an unrelated extglob-pattern bug in
   * `@agentmail/convex`'s own `/test` re-export previously produced (not, as
   * once believed, a dist/src split). This test now proves every D11/D18
   * guard passes for a confirmed policy contact AND that the send actually
   * reaches the component: a real `outboundId` comes back, the draft is
   * stamped with it, and the claim moves to `queued`.
   */
  it("passes every guard for a user-confirmed policy contact without an explicit tick, and reaches the component", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    await confirmedPolicy(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId);

    const outboundId = await as.mutation(api.drafts.approveAndSend, {
      draftId,
      to: CONTACT,
      subject: "Refund for order AC-1",
      body: "Hello, could you confirm the credit?",
      claimVersion: 1,
      draftVersion: 1,
    });
    expect(outboundId).toBeTypeOf("string");
    expect((outboundId as string).length).toBeGreaterThan(0);

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBe(outboundId);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
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
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "sent", agentmailMessageId: "msg-1", threadId: "thread-1", errorMessage: null },
        true,
      ),
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
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "bounced", agentmailMessageId: null, threadId: null, errorMessage: "mailbox does not exist" },
        true,
      ),
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
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "bounced", agentmailMessageId: "msg-bounced-1", threadId: "thread-1", errorMessage: "mailbox does not exist" },
        true,
      ),
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
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 1, pending, true))).toBe("retrying");
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 2, pending, true))).toBe("retrying");
    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 4, pending, true))).toBe("retrying");

    const claimMidway = await t.run((ctx) => ctx.db.get(claimId));
    expect(claimMidway?.status).toBe("queued");
    expect(claimMidway?.sendUnknown).toBeUndefined();

    expect(await t.run((ctx) => applySendOutcome(ctx, draftId, 5, null, true))).toBe("unknown");
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
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "sent", agentmailMessageId: "msg-2", threadId: "thread-2", errorMessage: null },
        true,
      ),
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

    await t.run((ctx) => applySendOutcome(ctx, draftId, 1, observation, true));
    await t.run((ctx) => applySendOutcome(ctx, draftId, 2, observation, true));

    const followUps = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(followUps).toHaveLength(1);
  });

  it("T06 durable-delivery review: exhausting the backoff also schedules a stall-interval recheck, not just sendUnknown", async () => {
    vi.useFakeTimers();
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);
    const pending = { status: "pending", agentmailMessageId: null, threadId: null, errorMessage: null };

    const outcome = await t.run((ctx) => applySendOutcome(ctx, draftId, 5, pending, true));
    expect(outcome).toBe("unknown");

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1); // the sibling stall-interval reconcile, since drafts has no nextCheckAt column to sweep off of

    // It eventually resolves once AgentMail catches up.
    const status = vi.spyOn(agentmail, "status").mockResolvedValue({
      status: "sent",
      agentmailMessageId: "msg-late",
      threadId: null,
      errorMessage: null,
    } as never);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(status).toHaveBeenCalled();
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
  });

  it("T06 durable-delivery review (D87): reconcileSend skips a tombstoned account without touching the draft/claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );

    await t.mutation(internal.drafts.reconcileSend, { draftId, attempt: 1 });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued"); // untouched: reconcileSend returned early
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBe("outbound-1"); // untouched
  });

  it("F9: the exhausted branch does not reschedule when the component no longer recognizes the outbound id (status() === null)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { draftId } = await sentDraft(t, userId);

    const outcome = await t.run((ctx) => applySendOutcome(ctx, draftId, BACKOFF_MS.length, null, true));
    expect(outcome).toBe("unknown");

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((j) => j.name.includes("reconcileSend"))).toHaveLength(0);
  });

  it("checkpoint-4 N2/N3: a genuinely SCHEDULED reconcileSend (not a direct call) still re-arms once exhausted", async () => {
    // The bug (N2, HIGH): the old guard scanned `_scheduled_functions` for an
    // already-pending `reconcileSend` for this draft to avoid `recheckSend`
    // piling up reschedules -- but when `reconcileSend` itself is the one
    // reaching the exhausted branch, ITS OWN row is "inProgress" in that same
    // table while it runs, so the scan always matched itself and concluded a
    // reconcile was already armed. A direct `applySendOutcome(...)` call (as
    // every other test in this file uses) never creates that row at all, so
    // it could never have caught this -- this test goes through the real
    // scheduler on purpose.
    vi.useFakeTimers();
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);
    vi.spyOn(agentmail, "status").mockResolvedValue({
      status: "pending",
      agentmailMessageId: null,
      threadId: null,
      errorMessage: null,
    } as never);

    await t.run((ctx) =>
      ctx.scheduler.runAfter(0, internal.drafts.reconcileSend, { draftId, attempt: BACKOFF_MS.length }),
    );
    // A bounded driver, not `vi.runAllTimers` (which fires every due timer
    // however far out, so it would cascade into the freshly re-armed
    // MAIL_RECONCILE_STALL_MS job too, and then the one after that, forever,
    // under a status that never resolves -- an accurate reflection of the
    // real "still durable" behaviour, but not what this assertion needs to
    // observe). One millisecond is enough to fire the immediately-due job;
    // `finishAllScheduledFunctions` then idles out gracefully (its own
    // maxIdleTurns) once nothing more becomes due within that budget, well
    // short of the stall interval.
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true); // unchanged from before the fix

    const pending = (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
      (j) => j.state.kind === "pending" || j.state.kind === "inProgress",
    );
    expect(pending).toHaveLength(1); // the re-armed stall-interval check -- 0 under the old bug
    expect(pending[0].name).toMatch(/reconcileSend/);
  });

  it("checkpoint-4 N6: a bounce webhook that beats the poll (arrives before the message id is known) is applied instead of silently marking the claim sent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);

    // The webhook beats the poll: neither a mailLog nor a drafts row recognizes this id yet, so
    // mailEvents.onEvent stashes it (F8).
    await t.mutation(internal.mailEvents.onEvent, {
      event: { type: "event", event_type: "message.bounced", event_id: "evt-fast-1", bounce: { message_id: "msg-fast-1" } },
    });

    const outcome = await t.run((ctx) =>
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "sent", agentmailMessageId: "msg-fast-1", threadId: "thread-x", errorMessage: null },
        true,
      ),
    );
    expect(outcome).toBe("failed"); // not "sent": the stashed bounce wins over this poll's own "sent" reading

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toMatch(/bounced/);
    expect(draft?.outboundId).toBeUndefined();
    expect(draft?.agentmailMessageId).toBeUndefined(); // same shape as an ordinary bounce (TERMINAL_FAILURES branch)

    const stash = await t.run((ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-fast-1")).unique(),
    );
    expect(stash).toBeNull(); // consumed, not left behind (N7)

    const followUps = await t.run((ctx) =>
      ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(followUps).toHaveLength(0); // no reminder for a send that never really succeeded
  });

  it("checkpoint-4 N6: a complaint webhook that beats the poll still leaves the claim sent (it was delivered), flagged with a claim note", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId, draftId } = await sentDraft(t, userId);

    await t.mutation(internal.mailEvents.onEvent, {
      event: { type: "event", event_type: "message.complained", event_id: "evt-fast-2", complaint: { message_id: "msg-fast-2" } },
    });

    const outcome = await t.run((ctx) =>
      applySendOutcome(
        ctx,
        draftId,
        1,
        { status: "sent", agentmailMessageId: "msg-fast-2", threadId: null, errorMessage: null },
        true,
      ),
    );
    expect(outcome).toBe("sent");

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.agentmailMessageId).toBe("msg-fast-2");
    expect(draft?.sendError).toMatch(/spam/i);
    const notes = await t.run((ctx) =>
      ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(notes).toHaveLength(1);
    const stash = await t.run((ctx) =>
      ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", "mailEvent:msg-fast-2")).unique(),
    );
    expect(stash).toBeNull();
  });

  it("F9/N2/N3: repeated recheckSend clicks on a still-pending draft leave at most one reconcileSend pending (now zero: recheckSend never schedules)", async () => {
    // Superseded expectation (checkpoint-4 N2/N3): the old F9 guard let the FIRST recheckSend
    // schedule a reconcile (nothing pending yet) and suppressed the 2nd/3rd via the (buggy)
    // `_scheduled_functions` scan. That scan is gone; `recheckSend` now passes `reschedule: false`
    // unconditionally, so it never schedules anything -- 0 pending after any number of clicks is
    // the correct "at most one" bound, achieved structurally rather than by a runtime scan.
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { draftId } = await sentDraft(t, userId);
    vi.spyOn(agentmail, "status").mockResolvedValue({
      status: "pending",
      agentmailMessageId: null,
      threadId: null,
      errorMessage: null,
    } as never);

    await as.mutation(api.drafts.recheckSend, { draftId });
    await as.mutation(api.drafts.recheckSend, { draftId });
    await as.mutation(api.drafts.recheckSend, { draftId });

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const pending = scheduled.filter(
      (j) => j.name.includes("reconcileSend") && (j.state.kind === "pending" || j.state.kind === "inProgress"),
    );
    expect(pending).toHaveLength(0);
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

  it("refuses a claim already queued, sent, packet, confirmed or dismissed (D52)", async () => {
    const t = setup();
    for (const status of ["queued", "sent", "packet", "confirmed", "dismissed"] as const) {
      const { userId, as } = await signedIn(t, `User-${status}`);
      const { claimId } = await seed(t, userId, { status });
      await expect(as.mutation(api.drafts.markPacketSent, { claimId, note: "x" })).rejects.toThrow(
        new RegExp(status),
      );
    }
  });
});

describe("drafts.recheckSend (D56)", () => {
  it("refuses a draft that has not been sent, and another user's draft", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await seed(t, owner.userId);
    const draftId = await newDraft(t, claimId, owner.userId);

    await expect(
      owner.as.mutation(api.drafts.recheckSend, { draftId }),
    ).rejects.toThrow(/has not been sent/);
    await expect(other.as.mutation(api.drafts.recheckSend, { draftId })).rejects.toThrow(
      /Draft not found/,
    );
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

describe("the send path is not a mail relay (pre-launch review B1)", () => {
  type T = ReturnType<typeof setup>;
  const VICTIM = "victim@elsewhere.example";

  /** The one seam to the network, replaced with a spy (same approach as notify.test.ts). */
  function spySend() {
    let n = 0;
    return vi.spyOn(agentmail, "sendMessage").mockImplementation(async () => `outbound-${++n}` as never);
  }

  async function claimFor(t: T, userId: Id<"users">, token: string, flags: { claim?: boolean; purchase?: boolean } = {}) {
    const seeded = await seed(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(seeded.claimId, { token, isExample: flags.claim });
      if (flags.purchase) await ctx.db.patch(seeded.purchaseId, { isExample: true });
    });
    return seeded;
  }

  function sendArgs(draftId: Id<"drafts">, over: Record<string, unknown> = {}) {
    return {
      draftId, to: VICTIM, subject: "Refund for order AC-1", body: "Hello, could you confirm the credit?",
      claimVersion: 1, draftVersion: 1, recipientConfirmed: true, ...over,
    };
  }

  it("never sends for an example claim or an example purchase, even with the recipient ticked", async () => {
    vi.useFakeTimers();
    const send = spySend();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    for (const flags of [{ claim: true }, { purchase: true }]) {
      const { claimId } = await claimFor(t, userId, "EX0001", flags);
      const draftId = await newDraft(t, claimId, userId, "");
      await expect(as.mutation(api.drafts.approveAndSend, sendArgs(draftId))).rejects.toThrow("Example claims cannot be sent");
    }
    expect(send).not.toHaveBeenCalled();
    expect(await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length)).toBe(0);
  });

  // Drafting an example claim is allowed (budgeted like any draft); only sending one is refused, above.
  it("generate refuses closed claims before charging or calling the model", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      for (const status of ["confirmed", "dismissed"] as const) {
        const closed = await seed(t, userId, { status });
        await expect(as.action(api.drafts.generate, { claimId: closed.claimId })).rejects.toThrow("This claim is closed");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length)).toBe(0);
      expect(await t.run(async (ctx) => (await ctx.db.query("drafts").collect()).length)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it(`generate is charged before the model is called and stops at ${DAILY_BUDGETS.draft_generate.max} a day`, async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const { claimId } = await seed(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("usage", {
        userId, day: new Date().toISOString().slice(0, 10), kind: "draft_generate", count: DAILY_BUDGETS.draft_generate.max,
      });
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(as.action(api.drafts.generate, { claimId })).rejects.toThrow(/today's limit for writing drafts/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("strips CR/LF and control characters from the subject and recipient, and caps the body", async () => {
    vi.useFakeTimers();
    const send = spySend();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId, "");
    await as.mutation(
      api.drafts.approveAndSend,
      sendArgs(draftId, {
        to: " Victim@Elsewhere.example\u0000 ",
        subject: "Refund\r\nBcc: everyone@elsewhere.example\u001b",
        body: "x".repeat(5_000),
      }),
    );
    const message = send.mock.calls[0][2] as { to: string; subject: string; text: string };
    expect(message.to).toBe(VICTIM);
    expect(message.subject).toBe("RefundBcc: everyone@elsewhere.example [RC-AB12CD]");
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.text).toHaveLength(1_200);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.body).toHaveLength(1_200);
    expect(draft?.subject).toBe(message.subject);

    const second = await newDraft(t, claimId, userId, "");
    await t.run((ctx) => ctx.db.patch(claimId, { status: "sent" }));
    await expect(
      as.mutation(api.drafts.approveAndSend, sendArgs(second, { draftVersion: 2, to: "a@b.example\r\nBcc: c@d.example" })),
    ).rejects.toThrow(/valid recipient/);
  });

  it(`sends at most ${MAX_SENDS_PER_CLAIM} times per claim, ever; a bounced send does not count`, async () => {
    vi.useFakeTimers();
    const send = spySend();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await seed(t, userId);

    const sendNext = async (version: number) => {
      const draftId = await newDraft(t, claimId, userId, "");
      const result = as.mutation(api.drafts.approveAndSend, sendArgs(draftId, { draftVersion: version }));
      return { draftId, result };
    };
    const delivered = async () => await t.run((ctx) => ctx.db.patch(claimId, { status: "sent" }));

    const first = await sendNext(1);
    await first.result;
    // It bounced: the binding is cleared, the claim is back to drafted, and the send is not held against the claim.
    await t.run((ctx) =>
      applySendOutcome(
        ctx,
        first.draftId,
        1,
        { status: "bounced", agentmailMessageId: null, threadId: null, errorMessage: "no such user" },
        true,
      ),
    );
    for (let v = 2; v <= MAX_SENDS_PER_CLAIM + 1; v++) {
      await (await sendNext(v)).result;
      await delivered();
    }
    expect(send).toHaveBeenCalledTimes(MAX_SENDS_PER_CLAIM + 1);

    const over = await sendNext(MAX_SENDS_PER_CLAIM + 2);
    await expect(over.result).rejects.toThrow(/at most 3 times/);
    expect(send).toHaveBeenCalledTimes(MAX_SENDS_PER_CLAIM + 1);
  });

  it(`sends at most ${DAILY_BUDGETS.claim_email.max} claim emails a day per user, across claims, and another user is unaffected`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 20, 12));
    const send = spySend();
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await withInbox(t, a.userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("profiles", { userId: b.userId, inboxId: "inbox_b", inboxEmail: "b@agentmail.to" });
    });

    const sendOne = async (who: typeof a, i: number) => {
      const { claimId } = await claimFor(t, who.userId, `T${String(i).padStart(5, "0")}`);
      const draftId = await newDraft(t, claimId, who.userId, "");
      return who.as.mutation(api.drafts.approveAndSend, sendArgs(draftId));
    };
    for (let i = 0; i < DAILY_BUDGETS.claim_email.max; i++) await sendOne(a, i);
    await expect(sendOne(a, 99)).rejects.toThrow(/today's limit for sending claim emails/);
    expect(send).toHaveBeenCalledTimes(DAILY_BUDGETS.claim_email.max);

    await sendOne(b, 100);
    vi.setSystemTime(Date.UTC(2026, 8, 21, 0, 0, 1));
    await sendOne(a, 101);
    expect(send).toHaveBeenCalledTimes(DAILY_BUDGETS.claim_email.max + 2);
  });

  it("a refused send (unconfirmed recipient) does not use up the day's budget", async () => {
    vi.useFakeTimers();
    spySend();
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await seed(t, userId);
    const draftId = await newDraft(t, claimId, userId, "");
    await expect(
      as.mutation(api.drafts.approveAndSend, sendArgs(draftId, { recipientConfirmed: undefined })),
    ).rejects.toThrow("Confirm this recipient before sending");
    expect(await t.run(async (ctx) => (await ctx.db.query("usage").collect()).length)).toBe(0);
  });
});
