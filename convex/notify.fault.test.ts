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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { claimDrop, applyDropOutcome, DROP_SUBJECT } from "./notify";
import { BACKOFF_MS } from "./drafts";
import { MAIL_RECONCILE_STALL_MS } from "./limits";
import { agentmail } from "./mail";
import { suppressAddress, tokenFor } from "./alerts";

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

// ---------------------------------------------------------------------------
// P02-OW-3 / P01-2 / P09-F8 (D244): closing the gate cancels a pending send.
//
// The re-audit's R1/R2/R3/R4a/R4b repros, inverted. Unlike the suite above,
// these drive the REAL AgentMail component (no `sendMessage` mock) with
// `fetch` stubbed at the provider boundary, so a provider POST is counted,
// not assumed. The scheduler is driven in bounded steps, never
// `finishAllScheduledFunctions`: the component's workpool reschedules its own
// status loop forever once a job exists.
// ---------------------------------------------------------------------------

describe("P02-OW-3: opt-out, unsubscribe, suppression and deletion cancel a send still pending in the component", () => {
  const T0 = Date.UTC(2026, 8, 23, 12);
  const CONTACT = "support@acme.example";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Stubs the provider; returns a POST counter for /messages/send. Every other call answers `{}`. */
  function stubProvider() {
    let posts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        if (String(url).includes("/messages/send")) {
          posts++;
          return new Response(JSON.stringify({ message_id: `mid-${posts}`, thread_id: `th-${posts}` }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return () => posts;
  }

  async function drive(t: T, steps: number, stepMs = 5_000) {
    for (let i = 0; i < steps; i++) {
      vi.advanceTimersByTime(stepMs);
      await t.finishInProgressScheduledFunctions();
    }
  }

  async function componentStatus(t: T, outboundId: NonNullable<Doc<"mailLog">["outboundId"]>) {
    return await t.run((ctx) => agentmail.status(ctx as never, outboundId));
  }

  /** A verified user with an inbox, and one alert handed to the component (`queued`, component row `pending`, not yet POSTed). */
  async function queuedAlert(t: T, name: string) {
    const user = await verifiedUser(t, name);
    await inboxFor(t, user.userId, name);
    const watch = await activeWatch(t, user.userId);
    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    await t.mutation(internal.notify.sendDrop, { mailLogId });
    const row = (await t.run((ctx) => ctx.db.get(mailLogId)))!;
    expect(row.status).toBe("queued");
    expect((await componentStatus(t, row.outboundId!))?.status).toBe("pending");
    return { ...user, mailLogId, outboundId: row.outboundId! };
  }

  async function expectCancelled(t: T, mailLogId: Id<"mailLog">, reason: string) {
    const row = (await t.run((ctx) => ctx.db.get(mailLogId)))!;
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe(reason);
    // P02-SK-3: a cancel can land while the POST is in flight, so the copy never claims nothing was sent.
    expect(row.error).toMatch(/cancelled, but it may already have gone out/);
    const component = await componentStatus(t, row.outboundId!);
    expect(component?.status).toBe("failed");
    expect(component?.errorMessage).toBe("Cancelled by user");
  }

  it("R4a inverted: setAlerts(false) before the workpool runs → 0 provider POSTs, the row ends suppressed/opted_out", async () => {
    const t = setup();
    const posts = stubProvider();
    const { as, mailLogId } = await queuedAlert(t, "Opal");

    await as.mutation(api.alerts.setAlerts, { enabled: false });
    await drive(t, 60);

    expect(posts()).toBe(0); // before: 1
    await expectCancelled(t, mailLogId, "opted_out");
  });

  it("R4b inverted: one-click unsubscribe before the workpool runs → 0 provider POSTs, the row ends suppressed/opted_out", async () => {
    const t = setup();
    const posts = stubProvider();
    const { userId, mailLogId } = await queuedAlert(t, "Uma");
    const token = await t.run((ctx) => tokenFor(ctx, userId));

    expect(await t.mutation(internal.alerts.unsubscribeByToken, { token })).toBe(true);
    await drive(t, 60);

    expect(posts()).toBe(0); // before: 1
    await expectCancelled(t, mailLogId, "opted_out");
  });

  it("a bounce/complaint suppression of the address cancels another alert still pending to it", async () => {
    const t = setup();
    const posts = stubProvider();
    const { userId, mailLogId } = await queuedAlert(t, "Bea");

    await t.run((ctx) => suppressAddress(ctx, userId, "complained"));
    await drive(t, 60);

    expect(posts()).toBe(0);
    await expectCancelled(t, mailLogId, "address_suppressed");
  });

  it("control: when the POST already completed before the opt-out, nothing is cancelled and the row ends sent, never suppressed", async () => {
    const t = setup();
    const posts = stubProvider();
    const { as, mailLogId, outboundId } = await queuedAlert(t, "Cora");

    // Up to five 1 s steps: the workpool POSTs and the component records `sent`, while the
    // first reconcile (BACKOFF_MS[0] = 30 s) has not run yet, so the row is still `queued`.
    for (let i = 0; i < 5 && (await componentStatus(t, outboundId))?.status !== "sent"; i++) await drive(t, 1, 1_000);
    expect(posts()).toBe(1);
    expect((await componentStatus(t, outboundId))?.status).toBe("sent");
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("queued");

    await as.mutation(api.alerts.setAlerts, { enabled: false });
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("queued"); // left for reconciliation
    await drive(t, 60);

    expect(posts()).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    expect(row?.agentmailMessageId).toBe("mid-1");
  });

  /** A queued claim email for this user: approved through the real `drafts.approveAndSend`, component row `pending`. */
  async function queuedClaimEmail(t: T, userId: Id<"users">, as: Awaited<ReturnType<typeof signedIn>>["as"]) {
    const { claimId, draftId } = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", orderRef: "AC-1",
        purchasedAt: Date.UTC(2026, 0, 2), currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: "Scarf", unitCents: 4000, qty: 1, returned: true, returnedAt: Date.UTC(2026, 0, 9),
      });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "return_credit", expectedCents: 4000, status: "drafted", token: "AB12CD", version: 1,
      });
      const draftId = await ctx.db.insert("drafts", {
        claimId, userId, version: 1, claimVersion: 1, to: CONTACT, subject: "Refund [RC-AB12CD]", body: "Please confirm the credit.",
      });
      return { claimId, draftId };
    });
    const outboundId = await as.mutation(api.drafts.approveAndSend, {
      draftId, to: CONTACT, subject: "Refund", body: "Please confirm the credit.", claimVersion: 1, draftVersion: 1,
      recipientConfirmed: true,
    });
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("queued");
    expect((await t.run((ctx) => agentmail.status(ctx as never, outboundId)))?.status).toBe("pending");
    return { claimId, outboundId };
  }

  async function requestDeletion(t: T, as: Awaited<ReturnType<typeof signedIn>>["as"], userId: Id<"users">) {
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    return (await t.run((ctx) => ctx.db.query("accountState").withIndex("by_user", (q) => q.eq("userId", userId)).first()))!;
  }

  it("R2/R3 inverted: requestDeletion with the purge held (the workpool runs first) → 0 POSTs for a queued alert and a queued claim email", async () => {
    const t = setup();
    const posts = stubProvider();
    const { userId, as, mailLogId } = await queuedAlert(t, "Dana");
    const claim = await queuedClaimEmail(t, userId, as);

    const state = await requestDeletion(t, as, userId);
    await t.run((ctx) => ctx.scheduler.cancel(state.activePurgeJobId!)); // hold the purge
    await drive(t, 60);

    expect(posts()).toBe(0); // before: 2 (the alert and the claim email)
    await expectCancelled(t, mailLogId, "deleted");
    const claimSend = await t.run((ctx) => agentmail.status(ctx as never, claim.outboundId));
    expect(claimSend?.status).toBe("failed");
    expect(claimSend?.errorMessage).toBe("Cancelled by user");
  });

  it("D261 LOW-2: an alert reconciliation already moved to `unknown` while its send is still pending is cancelled too", async () => {
    const t = setup();
    const posts = stubProvider();
    const { as, mailLogId } = await queuedAlert(t, "Lou");
    // A workpool backlog: the backoff is spent while the component row is still pending.
    await t.run((ctx) => applyDropOutcome(ctx, mailLogId, BACKOFF_MS.length, { status: "pending", agentmailMessageId: null, errorMessage: null }));
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("unknown");

    await as.mutation(api.alerts.setAlerts, { enabled: false });
    await drive(t, 60);

    expect(posts()).toBe(0); // before: 1
    await expectCancelled(t, mailLogId, "opted_out");
  });

  it("D261 INFO-1: pausing or archiving the watch cancels its pending alert (watch_inactive)", async () => {
    for (const stop of ["pause", "archive"] as const) {
      const t = setup();
      const posts = stubProvider();
      const { as, mailLogId } = await queuedAlert(t, `Wes${stop}`);
      const watchId = (await t.run((ctx) => ctx.db.get(mailLogId)))!.watchId!;
      if (stop === "pause") await as.mutation(api.watches.setStatus, { watchId, status: "paused" });
      else await as.mutation(api.watches.archive, { watchId });
      await drive(t, 60);
      expect(posts(), stop).toBe(0);
      const row = (await t.run((ctx) => ctx.db.get(mailLogId)))!;
      expect(row.status, stop).toBe("suppressed");
      expect(row.reason, stop).toBe("watch_inactive");
      expect(row.error, stop).toMatch(/cancelled, but it may already have gone out/);
    }
  });

  it("D261 INFO-1: marking the watched item bought cancels its pending alert", async () => {
    const t = setup();
    const posts = stubProvider();
    const { as, mailLogId } = await queuedAlert(t, "Bo");
    const watchId = (await t.run((ctx) => ctx.db.get(mailLogId)))!.watchId!;
    await as.mutation(api.watches.markBought, { watchId, paidCents: 4_000, purchasedAt: T0 - 86_400_000 });
    await drive(t, 60);
    expect(posts()).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.reason).toBe("watch_inactive");
  });

  it("D258: an informal claim email (it never moves the claim to queued) approved just before deletion is cancelled → 0 POSTs", async () => {
    const t = setup();
    const posts = stubProvider();
    const { userId, as } = await verifiedUser(t, "Ivy");
    await inboxFor(t, userId, "Ivy");
    const { claimId, draftId } = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", orderRef: "AC-2",
        purchasedAt: Date.UTC(2026, 0, 2), currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: "Lamp", unitCents: 4000, qty: 1, returned: true, returnedAt: Date.UTC(2026, 0, 9),
      });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "return_credit", expectedCents: 4000, status: "drafted", token: "IV12CD", version: 1,
        requiredChannel: "web_form",
      });
      const draftId = await ctx.db.insert("drafts", {
        claimId, userId, version: 1, claimVersion: 1, to: CONTACT, subject: "About my return [RC-IV12CD]", body: "Just checking in.",
        purpose: "informal",
      });
      return { claimId, draftId };
    });
    const outboundId = await as.mutation(api.drafts.approveAndSend, {
      draftId, to: CONTACT, subject: "About my return", body: "Just checking in.", claimVersion: 1, draftVersion: 1,
      recipientConfirmed: true,
    });
    expect((await t.run((ctx) => ctx.db.get(claimId)))?.status).toBe("drafted"); // informal: the claim never queues
    expect((await componentStatus(t, outboundId))?.status).toBe("pending");

    const state = await requestDeletion(t, as, userId);
    await t.run((ctx) => ctx.scheduler.cancel(state.activePurgeJobId!)); // hold the purge
    await drive(t, 60);

    expect(posts()).toBe(0);
    const send = await componentStatus(t, outboundId);
    expect(send?.status).toBe("failed");
    expect(send?.errorMessage).toBe("Cancelled by user");
  });

  it("requestDeletion with the purge left to run → still 0 POSTs, whichever of purge and workpool runs first", async () => {
    const t = setup();
    const posts = stubProvider();
    const { userId, as } = await queuedAlert(t, "Eli");
    await queuedClaimEmail(t, userId, as);

    await requestDeletion(t, as, userId);
    await drive(t, 60);

    expect(posts()).toBe(0);
  });
});
