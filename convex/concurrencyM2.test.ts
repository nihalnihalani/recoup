/// <reference types="vite/client" />
/**
 * M25 (contract §11.2 row M25; mission §17 "Concurrency and failure"): CT-8, CT-9 and CT-10, written by QA from the
 * contract and DECISIONS. CT-7 (extraction vs account deletion) follows the ingestion lane's M23 integration.
 *
 * convex-test runs one mutation at a time, so two "concurrent" calls here are two orders of execution. In production
 * Convex's optimistic concurrency control commits a transaction only if nothing it READ was written by a transaction
 * that committed after it started; otherwise it re-runs against the new state. Each case below therefore (a) names the
 * documents and index ranges both sides read and write — the READ-SET ARGUMENT that forces the second to re-run and
 * see the first — and (b) proves the re-run does the right thing in both serial orders, plus a `Promise.all`.
 *
 * CT-8 duplicate webhook + intake → one processedEvents row, one intake job, one purchase.
 *   (i) The same AgentMail event delivered twice (the provider retries; the component's callback retries):
 *   `inbound.onMessageReceived` reads the `processedEvents.by_external` range for the event id (`.first()`) and the
 *   winner inserts into exactly that range, so the loser's read set is invalidated → it re-runs, finds the row, and
 *   returns without scheduling. Over HTTP, `POST /agentmail/webhook` twice with the same event gives one row.
 *   (ii) The intake applying one email twice (a retry racing the first extraction): `intake.applyExtraction` reads the
 *   user's `purchases.by_user` range (the source-message dedupe, B5/H5) and the winner inserts a purchase into it →
 *   the loser re-runs, sees `sourceMessageId`, and records "already on your board" instead of a second purchase.
 *   (iii) A pasted email twice: `intake.paste` → `insertPasteEvent` reads the same `by_external` range (a per-user
 *   content hash) → one row, one job, one charge.
 * CT-9 concurrent `submissions.record` of one packet → one submission row.
 *   Both read the `submissions.by_packet` range for the packet (`.first()`); the winner inserts into it and patches
 *   the packet (`submission_recorded`) and the claim (`packet`) → the loser re-runs, finds the row and returns it
 *   (`deduped: true`, the same id), writing nothing: no second row, no second claim note.
 * CT-10 duplicate outbound send → one enqueued message.
 *   `drafts.approveAndSend` reads the claim (status, version) and the draft (outboundId); the winner enqueues the email
 *   and, in the same transaction, sets the draft's `outboundId` and the claim's status `queued` → the loser re-runs and
 *   is refused ("already being sent"). Two "Send again" clicks after an unknown outcome (`resendAfterUnknown`) read the
 *   claim's `sendUnknown`; the winner's enqueue clears it → the loser re-runs and is refused. One provider row either
 *   way (the component's `outboundMessages`), one draft carrying an outbound id per attempt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import agentmailTest from "@agentmail/convex/test";

vi.mock("./lib/rules/registry", async () => await import("./testing/qaCardPack.kit"));
vi.mock("./lib/packets/index", async () => await import("./testing/qaCardPack.kit"));

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { setQaPackActive } from "./testing/qaCardPack.kit";

const NOW = Date.UTC(2026, 8, 24, 15);
const DAY = 86_400_000;
const WEBHOOK_SECRET = "whsec_test"; // test.setup.ts's AGENTMAIL_WEBHOOK_SECRET
const agentmailSrcModules = import.meta.glob("../node_modules/@agentmail/convex/src/component/**/*.ts", {
  eager: false,
}) as Record<string, () => Promise<unknown>>;

type T = ReturnType<typeof setup>;
type User = Awaited<ReturnType<typeof signedIn>>;
type Order = "A then B" | "B then A" | "Promise.all";
const ORDERS: readonly Order[] = ["A then B", "B then A", "Promise.all"];

beforeEach(() => {
  vi.useFakeTimers(); // all timers (KX3): scheduled work runs only when a test flushes it
  vi.setSystemTime(NOW);
  setQaPackActive(true);
});
afterEach(() => {
  vi.useRealTimers();
  setQaPackActive(true);
});

async function race<A, B>(order: Order, a: () => Promise<A>, b: () => Promise<B>): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> {
  const settle = async <R,>(f: () => Promise<R>): Promise<PromiseSettledResult<R>> => {
    try {
      return { status: "fulfilled", value: await f() };
    } catch (reason) {
      return { status: "rejected", reason };
    }
  };
  if (order === "A then B") {
    const ra = await settle(a);
    return [ra, await settle(b)];
  }
  if (order === "B then A") {
    const rb = await settle(b);
    return [await settle(a), rb];
  }
  return (await Promise.all([settle(a), settle(b)])) as [PromiseSettledResult<A>, PromiseSettledResult<B>];
}

const scheduledNamed = (t: T, fragment: string) =>
  t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.name.includes(fragment)).length);

// ---------------------------------------------------------------------------
// CT-8
// ---------------------------------------------------------------------------

async function userWithInbox(t: T, inboxId: string) {
  const u = await signedIn(t, "Inbox Owner");
  await t.run(async (ctx) => {
    await ctx.db.patch(u.userId, { email: "owner@example.com" });
    await ctx.db.insert("profiles", { userId: u.userId, inboxId, inboxEmail: `${inboxId}@inbox.e2e.example` });
  });
  return u;
}

const inboundMessage = (inboxId: string, messageId: string) => ({
  inbox_id: inboxId,
  message_id: messageId,
  thread_id: `thread-${messageId}`,
  from: "Northwind <orders@northwind.example>",
  to: `${inboxId}@inbox.e2e.example`,
  subject: "Your Northwind order NW-1001",
  text: "Thanks for your order NW-1001. Trail runner, 1 x $120.00.",
});

describe("CT-8 duplicate webhook + intake", () => {
  it.each(ORDERS)("(i) the same event delivered twice to the callback (%s) → one processedEvents row, one intake job", async (order) => {
    const t = setup();
    await userWithInbox(t, "inbox-ct8");
    const deliver = () => t.mutation(internal.inbound.onMessageReceived, { message: inboundMessage("inbox-ct8", "m-1"), thread: null, eventId: "evt-ct8" });
    const [a, b] = await race(order, deliver, deliver);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    const rows = await t.run(async (ctx) => await ctx.db.query("processedEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ externalId: "evt-ct8", route: "intake" });
    expect(await scheduledNamed(t, "processEvent")).toBe(1);
  });

  it("(i) over HTTP: POST /agentmail/webhook twice with the same signed event → one row", async () => {
    const t = setup();
    t.registerComponent("agentmail", agentmailTest.schema, agentmailSrcModules);
    await userWithInbox(t, "inbox-ct8-http");
    const body = JSON.stringify({ type: "event", event_type: "message.received", event_id: "evt-ct8-http", message: inboundMessage("inbox-ct8-http", "m-http"), thread: null });
    const post = async () => {
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "content-type": "application/json",
        "svix-id": "msg-ct8-http",
        "svix-timestamp": String(ts),
        "svix-signature": new Webhook(WEBHOOK_SECRET).sign("msg-ct8-http", new Date(ts * 1000), body),
      };
      return (await t.fetch("/agentmail/webhook", { method: "POST", body, headers })).status;
    };
    expect(await post()).toBeLessThan(300);
    expect(await post()).toBeLessThan(300);
    // Drain the component's callback dispatch (it schedules onMessageReceived), but not the intake job itself.
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1_000);
      await t.finishInProgressScheduledFunctions();
    }
    const rows = await t.run(async (ctx) => (await ctx.db.query("processedEvents").collect()).filter((r) => r.externalId === "evt-ct8-http"));
    expect(rows).toHaveLength(1);
  });

  it.each(ORDERS)("(ii) one email's extraction applied twice (%s) → one purchase; the other run records the duplicate", async (order) => {
    const t = setup();
    const u = await userWithInbox(t, "inbox-ct8-apply");
    await t.mutation(internal.inbound.onMessageReceived, { message: inboundMessage("inbox-ct8-apply", "m-apply"), thread: null, eventId: "evt-apply" });
    const row = (await t.run(async (ctx) => await ctx.db.query("processedEvents").first()))!;
    const parsed = {
      kind: "order",
      order: {
        merchant: "Northwind", merchantDomain: "northwind.example", orderRef: "NW-1001", purchasedAt: "2026-09-20", currency: "USD",
        items: [{ name: "Trail runner", unitPrice: 120, qty: 1, productUrl: null }],
      },
      refund: null,
      confidence: 0.95,
    };
    const apply = () => t.mutation(internal.intake.applyExtraction, { processedEventId: row._id, parsed });
    const [a, b] = await race(order, apply, apply);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    const state = await t.run(async (ctx) => ({
      purchases: (await ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", u.userId)).collect()).length,
      items: (await ctx.db.query("items").withIndex("by_user", (q) => q.eq("userId", u.userId)).collect()).length,
      transactions: (await ctx.db.query("transactions").withIndex("by_user_and_status", (q) => q.eq("userId", u.userId)).collect()).length,
    }));
    expect(state).toEqual({ purchases: 1, items: 1, transactions: 1 });
  });

  it.each(ORDERS)("(iii) the same email pasted twice (%s) → one row, one intake job, one charge", async (order) => {
    const t = setup();
    const u = await signedIn(t, "Paster");
    const text = "Order NW-2002 confirmed. Rain jacket 1 x $89.00. Northwind Outfitters.";
    const paste = () => u.as.action(api.intake.paste, { text });
    const [a, b] = await race(order, paste, paste);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    if (a.status === "fulfilled" && b.status === "fulfilled") expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    const rows = await t.run(async (ctx) => (await ctx.db.query("processedEvents").collect()).filter((r) => r.userId === u.userId));
    expect(rows).toHaveLength(1);
    expect(await scheduledNamed(t, "processEvent")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CT-9
// ---------------------------------------------------------------------------

async function approvedPacket(u: User) {
  const transactionId = await u.as.mutation(api.transactions.createManual, {
    category: "card_charge", counterpartyName: "NORTHWIND STORE", currency: "USD", totalMinor: 12_345, transactedOn: "2026-09-10",
  });
  await u.as.mutation(api.facts.answer, { transactionId, subjectKey: "txn", key: "card.billing_error_address", value: { kind: "text", text: "Billing Errors, PO Box 100, Wilmington DE 19801" } });
  const view = await u.as.query(api.opportunities.forTransaction, { transactionId });
  const opened = await u.as.mutation(api.opportunities.openCase, { opportunityId: view.opportunities[0].opportunity._id });
  if (!opened.ok) throw new Error(opened.code);
  const prepared = await u.as.mutation(api.packets.prepare, { claimId: opened.claimId });
  if (!prepared.ok) throw new Error(prepared.code);
  const pv = await u.as.query(api.packets.get, { packetId: prepared.packetId });
  expect(await u.as.mutation(api.packets.approve, { packetId: prepared.packetId, approvedHash: pv.renderedHash })).toEqual({ ok: true });
  return { claimId: opened.claimId as Id<"claims">, packetId: prepared.packetId as Id<"packets"> };
}

describe("CT-9 concurrent submissions.record of one packet", () => {
  it.each(ORDERS)("%s → one submission row, the same id to both callers, one recording note", async (order) => {
    const t = setup();
    const u = await signedIn(t, "Recorder");
    const { claimId, packetId } = await approvedPacket(u);
    const recordA = () => u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 120_000, confirmationRef: "first click" });
    const recordB = () => u.as.mutation(api.submissions.record, { packetId, submittedAt: NOW - 60_000, confirmationRef: "second click" });
    const [a, b] = await race(order, recordA, recordB);
    expect(a.status === "fulfilled" && b.status === "fulfilled").toBe(true);
    if (a.status !== "fulfilled" || b.status !== "fulfilled" || !a.value.ok || !b.value.ok) throw new Error("record refused");
    expect(a.value.submissionId).toBe(b.value.submissionId);
    expect([a.value.deduped, b.value.deduped].sort()).toEqual([false, true]);
    const rows = await t.run(async (ctx) => ({
      submissions: await ctx.db.query("submissions").withIndex("by_packet", (q) => q.eq("packetId", packetId)).collect(),
      notes: (await ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect()).filter((n) => n.text.startsWith("You recorded sending")),
      claim: (await ctx.db.get(claimId))!,
      packet: (await ctx.db.get(packetId))!,
    }));
    expect(rows.submissions).toHaveLength(1);
    expect(rows.notes).toHaveLength(1);
    expect(rows.claim.status).toBe("packet");
    expect(rows.packet.status).toBe("submission_recorded");
    // The kept row is the winner's: its submittedAt is one of the two, never a blend.
    expect([NOW - 120_000, NOW - 60_000]).toContain(rows.submissions[0].submittedAt);
  });
});

// ---------------------------------------------------------------------------
// CT-10
// ---------------------------------------------------------------------------

/** A legacy return claim with a draft and the user's Recoup inbox, prepared for sending (email path). */
async function preparedEmail(t: T) {
  const u = await signedIn(t, "Sender");
  await t.run(async (ctx) => {
    await ctx.db.insert("profiles", { userId: u.userId, inboxId: "inbox-ct10", inboxEmail: "recoup-ct10@inbox.e2e.example" });
  });
  const purchaseId = await u.as.mutation(api.purchases.create, {
    merchant: "Northwind", merchantDomain: "northwind.example", orderRef: "NW-3003", purchasedAt: NOW - 5 * DAY, currency: "USD", status: "active",
    items: [{ name: "Tent", unitCents: 20_000, qty: 1 }],
  });
  const itemId = (await u.as.query(api.purchases.get, { purchaseId })).items[0]._id as Id<"items">;
  await u.as.mutation(api.purchases.setReturned, { itemId, returned: true });
  const claimId = await u.as.mutation(api.claims.open, { itemId });
  const draftId = (await t.mutation(internal.drafts.insert, {
    claimId, userId: u.userId, to: "returns@northwind.example", subject: "Return refund", body: "Hello, I returned the tent. Please refund it. Thank you.",
  }))!;
  const draft = (await t.run(async (ctx) => await ctx.db.get(draftId)))!;
  const claim = (await t.run(async (ctx) => await ctx.db.get(claimId)))!;
  const text = { draftId, to: draft.to, subject: draft.subject, body: draft.body };
  const prepared = await u.as.mutation(api.drafts.prepareSend, text);
  if (!prepared.ok) throw new Error(`prepare refused: ${prepared.code}`);
  const approval = { ...text, claimVersion: claim.version, draftVersion: draft.version, recipientConfirmed: true, preparedHash: prepared.preparedHash };
  return { u, claimId, draftId, approval };
}

async function sendState(t: T, claimId: Id<"claims">) {
  return await t.run(async (ctx) => {
    const drafts = await ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect();
    return {
      claim: (await ctx.db.get(claimId))!,
      withOutbound: drafts.filter((d: Doc<"drafts">) => d.outboundId !== undefined),
    };
  });
}

describe("CT-10 duplicate outbound send", () => {
  it.each(ORDERS)("approveAndSend twice with the same approval (%s) → one enqueued message; the other click is refused", async (order) => {
    const t = setup();
    const { u, claimId, approval } = await preparedEmail(t);
    const send = () => u.as.mutation(api.drafts.approveAndSend, approval);
    const [a, b] = await race(order, send, send);
    const outcomes = [a, b].map((r) => r.status);
    expect(outcomes.filter((s) => s === "fulfilled")).toHaveLength(1);
    const refused = [a, b].find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/already (being )?sent/i);
    const s = await sendState(t, claimId);
    expect(s.withOutbound).toHaveLength(1);
    expect(s.claim.status).toBe("queued");
    const winner = [a, b].find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>;
    expect(s.withOutbound[0].outboundId).toBe(winner.value);
  });

  it.each(ORDERS)("two 'Send again' clicks after an unknown outcome (%s) → one new attempt", async (order) => {
    const t = setup();
    const { u, claimId, draftId, approval } = await preparedEmail(t);
    const firstOutbound = await u.as.mutation(api.drafts.approveAndSend, approval);
    // The provider's answer never came (D13 unknown): the reconcile marked the claim sendUnknown.
    await t.run(async (ctx) => await ctx.db.patch(claimId, { sendUnknown: true }));
    const claim = (await t.run(async (ctx) => await ctx.db.get(claimId)))!;
    const draft = (await t.run(async (ctx) => await ctx.db.get(draftId)))!;
    const again = () =>
      u.as.mutation(api.drafts.resendAfterUnknown, { ...approval, claimVersion: claim.version, draftVersion: draft.version, acknowledgedOutboundId: firstOutbound });
    const [a, b] = await race(order, again, again);
    const ok = [a, b].filter((r) => r.status === "fulfilled" && (r.value as { ok: boolean }).ok);
    expect(ok).toHaveLength(1);
    const s = await sendState(t, claimId);
    expect(s.withOutbound).toHaveLength(2); // the earlier attempt keeps its id; exactly one new attempt
    expect(s.claim.sendUnknown).toBeUndefined();
  });
});
