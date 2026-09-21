/// <reference types="vite/client" />
/**
 * T09 — independent acceptance suite for P02 (outbound alert reliability,
 * T06's durable-delivery rewrite of `notify.ts`), written from the
 * acceptance bullets in `docs/prompts/recoup-opus-sonnet-agent-team.md`
 * (P02) and the state machine fixed by the contract
 * (`docs/team/contracts/2026-09-21-T01-T05-T06.md`, T06(c)), not from T06's
 * own `convex/notify.test.ts` or `convex/mailEvents.test.ts`.
 *
 * Crash points are simulated the way the task brief specifies: by directly
 * constructing `mailLog` rows in the state a crash would leave them in (a
 * `claimed` row with nothing ever enqueued, a `queued` row whose follow-up
 * schedule was lost) and then driving the recovery path
 * (`internal.notify.sweepStalled`, `internal.notify.sendDrop`,
 * `internal.notify.reconcileDrop`) directly with `t.mutation`, rather than
 * relying on the scheduler to have actually crashed. `_scheduled_functions`
 * is read with `t.run` to confirm what the code did and did not schedule.
 * `vi.spyOn(agentmail, "sendMessage" | "status")` replaces the network seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { claimDrop, applyDropOutcome, DROP_SUBJECT } from "./notify";
import { BACKOFF_MS } from "./drafts";
import { MAIL_RECONCILE_STALL_MS } from "./limits";
import { agentmail } from "./mail";

type T = ReturnType<typeof setup>;

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function verifiedUser(t: T, name: string) {
  const { userId, as } = await signedIn(t, name);
  const email = `${name.toLowerCase()}@example.com`;
  await t.run((ctx) => ctx.db.patch(userId, { email, emailVerificationTime: Date.now() }));
  return { userId, as, email };
}

async function inboxFor(t: T, userId: Id<"users">, name: string) {
  await t.run((ctx) =>
    ctx.db.insert("profiles", { userId, inboxId: `inbox-${name.toLowerCase()}`, inboxEmail: `${name.toLowerCase()}@inbox.example` }),
  );
}

async function activeWatch(t: T, userId: Id<"users">, targetCents = 5_000): Promise<Doc<"watches">> {
  return await t.run(async (ctx) => {
    const watchId = await ctx.db.insert("watches", {
      userId,
      name: "Widget",
      productUrl: "https://store.example/widget",
      merchantDomain: "store.example",
      currency: "USD",
      targetCents,
      status: "active",
      nextCheckAt: Date.now() + 3_600_000,
    });
    return (await ctx.db.get(watchId))!;
  });
}

/** A bare mailLog row, for fixtures that construct a specific crash state directly. */
async function mailLogRow(
  t: T,
  userId: Id<"users">,
  dedupeKey: string,
  over: Partial<Doc<"mailLog">>,
): Promise<Id<"mailLog">> {
  return await t.run((ctx) =>
    ctx.db.insert("mailLog", {
      userId,
      dedupeKey,
      kind: "price_drop",
      to: `${userId}@example.com`,
      subject: DROP_SUBJECT,
      status: "claimed",
      cents: 1_000,
      ...over,
    }),
  );
}

async function scheduledJobs(t: T) {
  return await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
}

async function scheduledFor(t: T, fnNameSubstring: string, mailLogId?: Id<"mailLog">) {
  const jobs = await scheduledJobs(t);
  return jobs.filter((j) => {
    if (!j.name.includes(fnNameSubstring)) return false;
    if (mailLogId === undefined) return true;
    const args = j.args[0] as { mailLogId?: Id<"mailLog"> } | undefined;
    return args?.mailLogId === mailLogId;
  });
}

const deliveredStatus = (agentmailMessageId: string, providerStatus = "delivered") => ({
  status: providerStatus,
  agentmailMessageId,
  threadId: null,
  errorMessage: null,
});

describe("T09 acceptance — outbound alert reliability / crash injection (P02)", () => {
  describe("crash injection at each boundary", () => {
    it("a claimed row with nothing ever enqueued is recovered by the sweep, and enqueued exactly once", async () => {
      const t = setup();
      const { userId } = await verifiedUser(t, "Carl");
      await inboxFor(t, userId, "Carl");
      const watch = await activeWatch(t, userId);
      const past = Date.now() - 1_000;
      const mailLogId = await mailLogRow(t, userId, "watch:crash-a:1", {
        status: "claimed",
        watchId: watch._id,
        claimedAt: past - 60_000,
        nextCheckAt: past,
        lastCheckedAt: past - 60_000,
      });

      // Simulate the crash: `claimDrop`'s own `scheduler.runAfter(sendDrop)`
      // never happened (the process died before it, or the schedule was lost).
      expect(await scheduledFor(t, "sendDrop", mailLogId)).toHaveLength(0);

      const swept = await t.mutation(internal.notify.sweepStalled, {});
      expect(swept).toBe(1);
      expect(await scheduledFor(t, "sendDrop", mailLogId)).toHaveLength(1);

      const sendSpy = vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-carl" as never);
      // Drive the recovered job directly, exactly as the scheduler would.
      await t.mutation(internal.notify.sendDrop, { mailLogId });

      expect(sendSpy).toHaveBeenCalledTimes(1); // exactly one enqueue
      const row = await t.run((ctx) => ctx.db.get(mailLogId));
      expect(row?.status).toBe("queued");
      expect(row?.outboundId).toBe("outbound-carl");
    });

    it("a queued row with an outbound id but no reconcile scheduled is recovered by the sweep", async () => {
      const t = setup();
      const { userId } = await verifiedUser(t, "Quinn");
      const past = Date.now() - 1_000;
      const mailLogId = await mailLogRow(t, userId, "watch:crash-b:1", {
        status: "queued",
        outboundId: "outbound-crash-b" as never,
        attempt: 0,
        claimedAt: past - 60_000,
        nextCheckAt: past,
        lastCheckedAt: past - 60_000,
      });

      // Simulate the crash: the follow-up `reconcileDrop` schedule was lost.
      expect(await scheduledFor(t, "reconcileDrop", mailLogId)).toHaveLength(0);

      const swept = await t.mutation(internal.notify.sweepStalled, {});
      expect(swept).toBe(1);
      expect(await scheduledFor(t, "reconcileDrop", mailLogId)).toHaveLength(1);

      vi.spyOn(agentmail, "status").mockResolvedValue(deliveredStatus("msg-b") as never);
      await t.mutation(internal.notify.reconcileDrop, { mailLogId, attempt: 1 });

      const row = await t.run((ctx) => ctx.db.get(mailLogId));
      expect(row?.status).toBe("sent");
      expect(row?.agentmailMessageId).toBe("msg-b");
    });
  });

  it("two concurrent sendDrop calls for the same claimed row enqueue exactly once", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Dana");
    await inboxFor(t, userId, "Dana");
    const watch = await activeWatch(t, userId);
    const sendSpy = vi.spyOn(agentmail, "sendMessage").mockImplementation(async () => "outbound-dana" as never);

    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("claimed");

    // Convex serializes top-level mutations, so this exercises the exact
    // invariant the code relies on (notify.ts's own docstring): the second
    // call always observes the first one's committed status change.
    await Promise.all([
      t.mutation(internal.notify.sendDrop, { mailLogId }),
      t.mutation(internal.notify.sendDrop, { mailLogId }),
    ]);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("queued");
  });

  it("a delayed provider success after 'unknown' resolves to sent via the manual recheck", async () => {
    const t = setup();
    const owner = await verifiedUser(t, "Erin");
    const mailLogId = await mailLogRow(t, owner.userId, "watch:crash-c:1", {
      status: "unknown",
      outboundId: "outbound-erin" as never,
      attempt: BACKOFF_MS.length,
      nextCheckAt: Date.now() + 1_000,
      lastCheckedAt: Date.now(),
    });

    vi.spyOn(agentmail, "status").mockResolvedValue(deliveredStatus("msg-erin") as never);
    await owner.as.mutation(api.notify.recheckDrop, { mailLogId });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    expect(row?.agentmailMessageId).toBe("msg-erin");
  });

  it("a terminal bounce marks the row failed and suppresses the address (polling path)", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Finn");
    const mailLogId = await mailLogRow(t, userId, "watch:crash-d:1", {
      status: "queued",
      outboundId: "outbound-finn" as never,
      attempt: 0,
      nextCheckAt: Date.now() + 1_000,
      lastCheckedAt: Date.now(),
    });

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 0, { status: "bounced", agentmailMessageId: "msg-finn", errorMessage: "hard bounce" }),
    );
    expect(outcome).toBe("failed");

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("send_failed");
    expect(row?.providerStatus).toBe("bounced");

    const settingsRow = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(settingsRow?.suppressedReason).toBe("bounced");
    expect(settingsRow?.suppressedAt).toBeDefined();
  });

  it("a LATE bounce (webhook, after the row already reads sent) also marks it failed and suppresses the address", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Gwen");
    const mailLogId = await mailLogRow(t, userId, "watch:crash-d2:1", {
      status: "sent",
      outboundId: "outbound-gwen" as never,
      agentmailMessageId: "msg-gwen",
      sentAt: Date.now(),
    });

    await t.mutation(internal.mailEvents.onEvent, {
      event: {
        type: "event",
        event_type: "message.bounced",
        event_id: "evt-late-bounce-1",
        bounce: { message_id: "msg-gwen" },
      } as never,
    });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    const settingsRow = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(settingsRow?.suppressedReason).toBe("bounced");
  });

  it("no message id after every attempt goes to 'unknown' with a next check, not perpetual queued", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Gale");
    const mailLogId = await mailLogRow(t, userId, "watch:crash-e:1", {
      status: "queued",
      outboundId: "outbound-gale" as never,
      attempt: BACKOFF_MS.length,
      nextCheckAt: Date.now() + 1_000,
      lastCheckedAt: Date.now(),
    });

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, BACKOFF_MS.length, { status: "pending", agentmailMessageId: null, errorMessage: null }),
    );
    expect(outcome).toBe("unknown");

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("unknown");
    // A next check exists (not perpetual): the sweep can find and recover it later.
    expect(row?.nextCheckAt).toBeDefined();
    expect(row!.nextCheckAt!).toBeGreaterThan(Date.now());

    await t.run((ctx) => ctx.db.patch(mailLogId, { nextCheckAt: Date.now() - 1 }));
    const swept = await t.mutation(internal.notify.sweepStalled, {});
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await scheduledFor(t, "reconcileDrop", mailLogId)).toHaveLength(1);
  });

  it("opting out while a row is queued records the truthful outcome (it really was delivered) and refuses new claims", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Hana");
    await inboxFor(t, userId, "Hana");
    const watch = await activeWatch(t, userId);
    vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-hana" as never);

    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    await t.mutation(internal.notify.sendDrop, { mailLogId });
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("queued");

    // The user opts out while the row is already in flight with the provider.
    await as.mutation(api.alerts.setAlerts, { enabled: false });

    // Delivery had already genuinely happened before the opt-out landed; the
    // reconcile must record what actually happened, not retroactively
    // invent a "suppressed" outcome for a message that was already sent.
    vi.spyOn(agentmail, "status").mockResolvedValue(deliveredStatus("msg-hana") as never);
    await t.mutation(internal.notify.reconcileDrop, { mailLogId, attempt: 1 });
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");

    // But a NEW drop for the same watch, claimed after the opt-out, is refused.
    const secondId = await t.run((ctx) => claimDrop(ctx, watch, 3_000, "USD"));
    expect(secondId).not.toBeNull();
    const secondRow = await t.run((ctx) => ctx.db.get(secondId!));
    expect(secondRow?.status).toBe("suppressed");
    expect(secondRow?.reason).toBe("opted_out");
  });

  it("scheduler outage: rows past nextCheckAt in every active status are recovered by a single sweep, and terminal rows are left alone", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Ivan");
    const past = Date.now() - 1_000;

    const claimedId = await mailLogRow(t, userId, "watch:outage:1", {
      status: "claimed",
      claimedAt: past,
      nextCheckAt: past,
      lastCheckedAt: past,
    });
    const queuedId = await mailLogRow(t, userId, "watch:outage:2", {
      status: "queued",
      outboundId: "outbound-outage-2" as never,
      attempt: 0,
      nextCheckAt: past,
      lastCheckedAt: past,
    });
    const unknownId = await mailLogRow(t, userId, "watch:outage:3", {
      status: "unknown",
      outboundId: "outbound-outage-3" as never,
      attempt: BACKOFF_MS.length,
      nextCheckAt: past,
      lastCheckedAt: past,
    });
    // A terminal row, also past due on a stale nextCheckAt, must NOT be swept.
    const sentId = await mailLogRow(t, userId, "watch:outage:4", {
      status: "sent",
      outboundId: "outbound-outage-4" as never,
      agentmailMessageId: "msg-outage-4",
      sentAt: past,
      nextCheckAt: past,
    });

    const swept = await t.mutation(internal.notify.sweepStalled, {});
    expect(swept).toBe(3);

    expect(await scheduledFor(t, "sendDrop", claimedId)).toHaveLength(1);
    expect(await scheduledFor(t, "reconcileDrop", queuedId)).toHaveLength(1);
    expect(await scheduledFor(t, "reconcileDrop", unknownId)).toHaveLength(1);
    expect(await scheduledFor(t, "sendDrop", sentId)).toHaveLength(0);
    expect(await scheduledFor(t, "reconcileDrop", sentId)).toHaveLength(0);

    // Every swept row's own nextCheckAt was bumped forward, so a second
    // sweep run right away does not re-schedule the same rows again.
    const sweptAgain = await t.mutation(internal.notify.sweepStalled, {});
    expect(sweptAgain).toBe(0);
    for (const id of [claimedId, queuedId, unknownId]) {
      const row = await t.run((ctx) => ctx.db.get(id));
      expect(row!.nextCheckAt!).toBeGreaterThan(past + MAIL_RECONCILE_STALL_MS - 1_000);
    }
  });

  it("accepted, sent, delivered and bounced are all distinguishable through the drops view", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Jo");

    // "accepted": the component has the send, no delivery confirmation yet.
    await mailLogRow(t, userId, "watch:distinct:1", {
      status: "queued",
      outboundId: "outbound-distinct-1" as never,
      attempt: 0,
      cents: 1_000,
    });
    // "sent": a definite message id, provider status "sent" (handed off, not yet confirmed delivered).
    await mailLogRow(t, userId, "watch:distinct:2", {
      status: "sent",
      outboundId: "outbound-distinct-2" as never,
      agentmailMessageId: "msg-distinct-2",
      providerStatus: "sent",
      sentAt: Date.now(),
      cents: 1_000,
    });
    // "delivered": same top-level status as above, but a distinct provider status.
    await mailLogRow(t, userId, "watch:distinct:3", {
      status: "sent",
      outboundId: "outbound-distinct-3" as never,
      agentmailMessageId: "msg-distinct-3",
      providerStatus: "delivered",
      sentAt: Date.now(),
      cents: 1_000,
    });
    // "bounced": terminal failure.
    await mailLogRow(t, userId, "watch:distinct:4", {
      status: "failed",
      outboundId: "outbound-distinct-4" as never,
      reason: "send_failed",
      providerStatus: "bounced",
      cents: 1_000,
    });

    const rows = await as.query(api.notify.drops, {});
    expect(rows).toHaveLength(4);

    const byKey = (status: string, providerStatus: string | null) =>
      rows.filter((r) => r.status === status && r.providerStatus === providerStatus);
    const accepted = byKey("queued", null);
    const sent = byKey("sent", "sent");
    const delivered = byKey("sent", "delivered");
    const bounced = byKey("failed", "bounced");
    expect(accepted).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(bounced).toHaveLength(1);

    // Four pairwise-distinct (status, providerStatus) combinations: none collapse into another.
    const signature = (r: (typeof rows)[number]) => `${r.status}:${r.providerStatus}`;
    expect(new Set(rows.map(signature)).size).toBe(4);

    // Only the still-in-flight "accepted" row can be manually rechecked.
    expect(accepted[0]!.canRecheck).toBe(true);
    expect(sent[0]!.canRecheck).toBe(false);
    expect(delivered[0]!.canRecheck).toBe(false);
    expect(bounced[0]!.canRecheck).toBe(false);
  });
});

describe("T09 acceptance — merchant drafts still hold after T06 (P02)", () => {
  async function seedClaim(t: T, userId: Id<"users">) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId,
        merchant: "Acme",
        merchantDomain: "acme.example",
        orderRef: "AC-1",
        purchasedAt: Date.now(),
        currency: "USD",
        status: "active",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Widget", unitCents: 2_000, qty: 1, returned: false });
      const claimId = await ctx.db.insert("claims", {
        purchaseId,
        itemId,
        userId,
        type: "price_adjustment",
        expectedCents: 500,
        status: "drafted",
        token: "ZZ99YY",
        version: 1,
      });
      return { purchaseId, itemId, claimId };
    });
  }

  async function newDraft(t: T, claimId: Id<"claims">, userId: Id<"users">, claimVersion: number) {
    return await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("drafts")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect();
      return await ctx.db.insert("drafts", {
        claimId,
        userId,
        version: existing.length + 1,
        claimVersion,
        to: "support@acme.example",
        subject: "Price match request",
        body: "Please match the current price.",
      });
    });
  }

  it("refuses to send an older draft once a newer one exists on the same claim (newest-draft check)", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Jill");
    const { claimId } = await seedClaim(t, userId);
    await inboxFor(t, userId, "Jill");
    const oldDraftId = await newDraft(t, claimId, userId, 1);
    await newDraft(t, claimId, userId, 1); // v2, newer

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId: oldDraftId,
        to: "support@acme.example",
        subject: "Price match request",
        body: "Please match the current price.",
        claimVersion: 1,
        draftVersion: 1,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/newer draft/);
  });

  it("refuses to send when the approval's draftVersion no longer matches (approval binding)", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Jack");
    const { claimId } = await seedClaim(t, userId);
    await inboxFor(t, userId, "Jack");
    const draftId = await newDraft(t, claimId, userId, 1);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: "support@acme.example",
        subject: "Price match request",
        body: "Please match the current price.",
        claimVersion: 1,
        draftVersion: 99, // stale binding: does not match the draft's real version
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/changed since you reviewed it/);
  });

  it("refuses to send when the approval's claimVersion no longer matches (approval binding, claim side)", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Jean");
    const { claimId } = await seedClaim(t, userId);
    await inboxFor(t, userId, "Jean");
    const draftId = await newDraft(t, claimId, userId, 1);

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: "support@acme.example",
        subject: "Price match request",
        body: "Please match the current price.",
        claimVersion: 42, // stale binding: does not match the claim's real version
        draftVersion: 1,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/changed since/);
  });

  it("dismissing a claim with a send in flight best-effort cancels it with the provider (dismiss-cancels-send)", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "June");
    const { claimId } = await seedClaim(t, userId);
    await inboxFor(t, userId, "June");
    const draftId = await newDraft(t, claimId, userId, 1);

    vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-june" as never);
    await as.mutation(api.drafts.approveAndSend, {
      draftId,
      to: "support@acme.example",
      subject: "Price match request",
      body: "Please match the current price.",
      claimVersion: 1,
      draftVersion: 1,
      recipientConfirmed: true,
    });
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("queued");

    const cancelSpy = vi.spyOn(agentmail, "cancel").mockResolvedValue(undefined);
    await as.mutation(api.claims.dismiss, { claimId });

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("dismissed");

    const notes = await t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    expect(notes.some((n) => n.text.toLowerCase().includes("cancelled"))).toBe(true);

    // The claim is now closed: any further send attempt is refused.
    const anotherDraft = await newDraft(t, claimId, userId, claim!.version);
    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId: anotherDraft,
        to: "support@acme.example",
        subject: "x",
        body: "y",
        claimVersion: claim!.version,
        draftVersion: 2,
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/closed/);
  });
});
