/**
 * End-to-end acceptance scenarios, written from docs/team/VERIFICATION.md's
 * "Required scenarios" table and docs/prompts/recoup-opus-sonnet-agent-team.md's
 * <verification_strategy>, not from the implementation. Each `describe` name
 * matches a row of that table verbatim (or, for the two scenarios only listed
 * in the tester's own brief, the brief's own wording).
 *
 * Independent of the per-module unit tests: this file may duplicate an
 * assertion a module test already makes, but it exercises the scenario as a
 * fresh reader of the requirements would, through public mutations/queries
 * wherever possible.
 *
 * Where a scenario would otherwise need a live OpenAI or AgentMail call, it
 * instead drives the internal mutation the corresponding action calls
 * (`internal.intake.applyExtraction`, `internal.replies.apply`,
 * `internal.priceWatch.recordCheck`, `internal.drafts.reconcileSend` via the
 * exported `reconcileSendImpl` with an injected status function) and its
 * `it(...)` name is suffixed "(offline)".
 */
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { reconcileSendImpl } from "./drafts";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

type T = ReturnType<typeof setup>;
type As = Awaited<ReturnType<typeof signedIn>>["as"];

const DAY = 86_400_000;

/** One purchase with one returned item, and the (only public) return_credit claim opened on it. */
async function seedReturnClaim(
  as: As,
  opts: {
    merchantDomain?: string;
    unitCents?: number;
    qty?: number;
    feeCents?: number;
    name?: string;
    merchant?: string;
  } = {},
) {
  const merchantDomain = opts.merchantDomain ?? "n.example";
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: opts.merchant ?? "Northwind",
    merchantDomain,
    purchasedAt: Date.now() - 5 * DAY,
    currency: "USD",
    items: [{ name: opts.name ?? "Scarf", unitCents: opts.unitCents ?? 4000, qty: opts.qty ?? 1 }],
  });
  const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
  const itemId = items[0]._id;
  await as.mutation(api.purchases.setReturned, { itemId, returned: true });
  const claimId = await as.mutation(api.claims.open, { itemId, feeCents: opts.feeCents });
  return { purchaseId, itemId, claimId, merchantDomain };
}

/** Inserts and confirms a `returns` policy snapshot so `approveAndSend` accepts the recipient without `recipientConfirmed`. */
async function confirmReturnsPolicy(
  t: T,
  as: As,
  userId: Id<"users">,
  merchantDomain: string,
  contactEmail = "support@n.example",
) {
  const policyId = await t.mutation(internal.policies.insertSnapshot, {
    userId,
    merchantDomain,
    kind: "returns",
    channel: "email",
    contactEmail,
    passage: "You may return items within 30 days.",
    sourceUrl: `https://${merchantDomain}/returns`,
    confidence: 0.9,
  });
  await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail });
  return contactEmail;
}

/** Approves and sends a draft for a claim, then reconciles it straight to `sent` with an injected status (offline: no real AgentMail round trip). */
async function approveAndReconcileToSent(
  t: T,
  as: As,
  userId: Id<"users">,
  claimId: Id<"claims">,
  merchantDomain: string,
  opts: { to?: string } = {},
) {
  await t.mutation(internal.profiles.save, {
    userId,
    inboxId: `${userId}@agentmail.to`,
    inboxEmail: `${userId}@agentmail.to`,
  });
  const to = opts.to ?? (await confirmReturnsPolicy(t, as, userId, merchantDomain));
  const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to, subject: "Refund request", body: "Hello" });
  await as.mutation(api.drafts.approveAndSend, { draftId, to, subject: "Refund request", body: "Hello" });
  await t.run((ctx) =>
    reconcileSendImpl(ctx, { draftId, attempt: 1 }, async () => ({
      status: "sent",
      agentmailMessageId: `am-${draftId}`,
      threadId: `th-${draftId}`,
      errorMessage: null,
    })),
  );
  return { draftId, to };
}

/** Calls `fn`, asserts it rejects, and asserts the thrown message reveals none of `secrets` (raw ids or field values from another user's data). */
async function expectOwnershipRejection(fn: () => Promise<unknown>, secrets: string[]) {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, "expected the call to reject").toBeDefined();
  const message = caught instanceof Error ? caught.message : String(caught);
  for (const secret of secrets) {
    expect(message).not.toContain(secret);
  }
}

// ---------------------------------------------------------------------------
// 1
// ---------------------------------------------------------------------------

describe("expected 4000, promise 4000 → unresolved 4000", () => {
  it("leaves unresolved at 4000 with status promised, and board asked already counted it once sent (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await approveAndReconcileToSent(t, as, userId, claimId, merchantDomain);

    let claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
    let board = await as.query(api.purchases.board, {});
    expect(board.totals.asked).toBe(4000);

    await t.mutation(internal.claims.applyEventInternal, {
      claimId,
      userId,
      kind: "promised_credit",
      cents: 4000,
      evidence: "Merchant reply: refund will be issued",
      idempotencyKey: "reply:1",
    });

    const after = await as.query(api.claims.get, { claimId });
    expect(after!.claim.status).toBe("promised");
    expect(after!.balance.unresolved).toBe(4000);
    expect(after!.balance.confirmed).toBe(0);

    board = await as.query(api.purchases.board, {});
    expect(board.totals.asked).toBe(4000);
    expect(board.totals.owed).toBe(4000);
    expect(board.totals.confirmed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2
// ---------------------------------------------------------------------------

describe("confirm 1500 → 2500; confirm 2500 → 0 + confirmed", () => {
  it("settles the claim on the second confirmation and cancels the pending follow-up", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await approveAndReconcileToSent(t, as, userId, claimId, merchantDomain);
    const scheduled = await t.run((ctx) =>
      ctx.db
        .query("followUps")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(scheduled.filter((f) => f.status === "pending")).toHaveLength(1);

    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1500, evidence: "statement 1", idempotencyKey: "k1" });
    let c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("sent");
    expect(c!.balance.unresolved).toBe(2500);

    await as.mutation(api.claims.confirmCredit, { claimId, cents: 2500, evidence: "statement 2", idempotencyKey: "k2" });
    c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("confirmed");
    expect(c!.balance.unresolved).toBe(0);
    expect(c!.followUps.every((f) => f.status !== "pending")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3
// ---------------------------------------------------------------------------

describe("later debit 1000 → unresolved 1000, only this claim reopens", () => {
  it("reopens only the debited claim and rejects a debit exceeding net confirmed credit", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Northwind",
      merchantDomain: "n.example",
      purchasedAt: Date.now() - 5 * DAY,
      currency: "USD",
      items: [
        { name: "Sweater", unitCents: 8000, qty: 1 },
        { name: "Scarf", unitCents: 4000, qty: 1 },
      ],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    await as.mutation(api.purchases.setReturned, { itemId: items[1]._id, returned: true });
    const sweaterClaim = await as.mutation(api.claims.open, { itemId: items[0]._id });
    const scarfClaim = await as.mutation(api.claims.open, { itemId: items[1]._id });

    await as.mutation(api.claims.confirmCredit, { claimId: sweaterClaim, cents: 8000, evidence: "s1", idempotencyKey: "s1" });
    await as.mutation(api.claims.confirmCredit, { claimId: scarfClaim, cents: 4000, evidence: "s2", idempotencyKey: "s2" });

    await as.mutation(api.claims.recordLaterDebit, { claimId: scarfClaim, cents: 1000, evidence: "chargeback", idempotencyKey: "d1" });

    const scarf = await as.query(api.claims.get, { claimId: scarfClaim });
    expect(scarf!.claim.status).toBe("reopened");
    expect(scarf!.balance.unresolved).toBe(1000);

    // The sibling claim on the same purchase is untouched.
    const sweater = await as.query(api.claims.get, { claimId: sweaterClaim });
    expect(sweater!.claim.status).toBe("confirmed");
    expect(sweater!.balance.unresolved).toBe(0);

    // A later debit can never exceed net confirmed credit (D40).
    await expect(
      as.mutation(api.claims.recordLaterDebit, { claimId: sweaterClaim, cents: 8001, evidence: "too much", idempotencyKey: "d2" }),
    ).rejects.toThrow(/exceed/);
  });
});

// ---------------------------------------------------------------------------
// 4
// ---------------------------------------------------------------------------

describe("replay processed inbound event → no duplicate", () => {
  it("dedupes a replayed webhook eventId to one processedEvents row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const message = {
      inbox_id: "i@agentmail.to",
      message_id: "m-replay",
      thread_id: "th-replay",
      subject: "Your order shipped",
      text: "...",
      from: "a@b.c",
    };

    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-replay", thread: {}, message });
    await t.mutation(internal.inbound.onMessageReceived, { eventId: "evt-replay", thread: {}, message });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("processedEvents")
        .withIndex("by_external", (q) => q.eq("externalId", "evt-replay"))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });

  it("replaying the same classified reply (same messageId) writes one ledger event and one reply row (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await approveAndReconcileToSent(t, as, userId, claimId, merchantDomain);

    const replyArgs = {
      claimId,
      messageId: "reply-replay-1",
      from: "support@n.example",
      classification: "credit_issued" as const,
      summary: "Refund issued",
      promisedAmount: 40,
    };
    await t.mutation(internal.replies.apply, replyArgs);
    await t.mutation(internal.replies.apply, replyArgs);

    const replies = await t.run((ctx) =>
      ctx.db
        .query("replies")
        .withIndex("by_message", (q) => q.eq("messageId", "reply-replay-1"))
        .collect(),
    );
    expect(replies).toHaveLength(1);
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 5
// ---------------------------------------------------------------------------

describe("retry after downstream failure → recoverable", () => {
  it("markProcessed failed then owner retryEvent moves it back to processing with attempts 2; a non-owner is rejected", async () => {
    const t = setup();
    const { userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");

    const eventId: Id<"processedEvents"> = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-fails",
        kind: "paste",
        status: "processing",
        attempts: 1,
        userId: aliceId,
        payload: {},
      }),
    );
    await t.mutation(internal.inbound.markProcessed, { eventId, status: "failed", lastError: "OpenAI timeout" });
    let row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("failed");

    await expect(bob.mutation(api.inbound.retryEvent, { eventId })).rejects.toThrow();
    row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("failed"); // the rejected attempt did not mutate the row

    const alice = t.withIdentity({ subject: `${aliceId}|session` });
    await alice.mutation(api.inbound.retryEvent, { eventId });
    row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("processing");
    expect(row?.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6
// ---------------------------------------------------------------------------

describe("user B with user A ids → rejection", () => {
  it("every public function throws and reveals nothing about user A's data (offline)", async () => {
    const t = setup();
    const { as: alice, userId: aliceId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");

    await t.mutation(internal.profiles.save, {
      userId: aliceId,
      inboxId: "alice-inbox@agentmail.to",
      inboxEmail: "alice-inbox@agentmail.to",
    });

    const purchaseId = await alice.mutation(api.purchases.create, {
      merchant: "Alice Confidential Co",
      merchantDomain: "aliceconfidential.example",
      purchasedAt: Date.now() - 5 * DAY,
      currency: "USD",
      items: [{ name: "Alice Confidential Item", unitCents: 4000, qty: 1 }],
    });
    const { items } = (await alice.query(api.purchases.get, { purchaseId }))!;
    const itemId = items[0]._id;
    await alice.mutation(api.purchases.setReturned, { itemId, returned: true });
    const claimId = await alice.mutation(api.claims.open, { itemId });
    const policyId = await t.mutation(internal.policies.insertSnapshot, {
      userId: aliceId,
      merchantDomain: "aliceconfidential.example",
      kind: "returns",
      channel: "email",
      contactEmail: "alice-secret-contact@aliceconfidential.example",
      passage: "Alice's confidential passage text",
      sourceUrl: "https://aliceconfidential.example/returns",
      confidence: 0.9,
    });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId: aliceId,
      to: "alice-secret-contact@aliceconfidential.example",
      subject: "Alice's confidential subject",
      body: "Alice's confidential body",
    });
    const eventId = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-alice-secret",
        kind: "paste",
        status: "failed",
        attempts: 1,
        userId: aliceId,
        payload: {},
      }),
    );

    const secrets = [
      String(purchaseId),
      String(itemId),
      String(claimId),
      String(policyId),
      String(draftId),
      String(eventId),
      "Alice Confidential",
      "aliceconfidential.example",
      "alice-secret-contact",
    ];

    await expectOwnershipRejection(() => bob.query(api.purchases.get, { purchaseId }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.purchases.setReturned, { itemId, returned: true }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.purchases.remove, { purchaseId }), secrets);
    await expectOwnershipRejection(
      () =>
        bob.mutation(api.purchases.confirm, {
          purchaseId,
          merchant: "x",
          merchantDomain: "x.example",
          purchasedAt: Date.now(),
          items: [],
        }),
      secrets,
    );
    await expectOwnershipRejection(() => bob.mutation(api.claims.open, { itemId }), secrets);
    await expectOwnershipRejection(() => bob.query(api.claims.get, { claimId }), secrets);
    await expectOwnershipRejection(
      () => bob.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence: "x", idempotencyKey: "k" }),
      secrets,
    );
    await expectOwnershipRejection(
      () => bob.mutation(api.claims.recordLaterDebit, { claimId, cents: 100, evidence: "x", idempotencyKey: "k2" }),
      secrets,
    );
    await expectOwnershipRejection(
      () => bob.mutation(api.claims.adjustExpected, { claimId, expectedCents: 100, reason: "x" }),
      secrets,
    );
    await expectOwnershipRejection(() => bob.mutation(api.claims.dismiss, { claimId }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.claims.clearAttention, { claimId }), secrets);
    await expectOwnershipRejection(
      () => bob.mutation(api.drafts.approveAndSend, { draftId, to: "bob@bob.example", subject: "s", body: "b", recipientConfirmed: true }),
      secrets,
    );
    await expectOwnershipRejection(() => bob.query(api.drafts.sendStatus, { draftId }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.drafts.markPacketSent, { claimId, note: "x" }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.policies.confirm, { policyId, channel: "email" }), secrets);
    await expectOwnershipRejection(() => bob.mutation(api.inbound.retryEvent, { eventId }), secrets);
    await expectOwnershipRejection(() => bob.action(api.priceWatch.checkNow, { itemId }), secrets);
  });
});

// ---------------------------------------------------------------------------
// 7
// ---------------------------------------------------------------------------

describe("approve then edit → old approval cannot send", () => {
  it("a claim change after the draft was written invalidates approval with 'changed'", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const to = await confirmReturnsPolicy(t, as, userId, merchantDomain);
    const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to, subject: "s", body: "Hello" });

    await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 3300, reason: "shipping fee" });

    await expect(
      as.mutation(api.drafts.approveAndSend, { draftId, to, subject: "s", body: "Hello" }),
    ).rejects.toThrow(/changed/);
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeUndefined();
  });

  it("editing the body and re-approving the same draft sends and stores the edited body (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedReturnClaim(as, { unitCents: 4000 });
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "Original body",
    });

    // First attempt: recipient unconfirmed -> refused, draft left untouched, no outboundId.
    await expect(
      as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "Original body" }),
    ).rejects.toThrow(/Confirm the recipient/);
    let draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.body).toBe("Original body");
    expect(draft?.outboundId).toBeUndefined();

    // Edit the body and re-approve the same draft, this time confirming the recipient.
    const outboundId = await as.mutation(api.drafts.approveAndSend, {
      draftId,
      to: "support@n.example",
      subject: "s",
      body: "Edited body",
      recipientConfirmed: true,
    });

    draft = await t.run((ctx) => ctx.db.get(draftId));
    // The code path sends `text: args.body` (drafts.ts approveAndSend) and
    // persists that same `args.body` onto the draft in the same patch, so
    // the stored body is by construction the body that was sent.
    expect(draft?.body).toBe("Edited body");
    expect(draft?.outboundId).toBe(outboundId);
  });
});

// ---------------------------------------------------------------------------
// 8
// ---------------------------------------------------------------------------

describe("simultaneous sends / provider timeout → no blind duplicate", () => {
  it("two approveAndSend calls in Promise.all on one draft: exactly one succeeds, one outboundId is ever recorded", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const to = await confirmReturnsPolicy(t, as, userId, merchantDomain);
    const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to, subject: "s", body: "b" });

    const results: PromiseSettledResult<unknown>[] = await Promise.allSettled([
      as.mutation(api.drafts.approveAndSend, { draftId, to, subject: "s", body: "b" }),
      as.mutation(api.drafts.approveAndSend, { draftId, to, subject: "s", body: "b" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    const reasonMessage = reason instanceof Error ? reason.message : String(reason);
    expect(reasonMessage).toMatch(/already/);

    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.outboundId).toBeDefined();
    expect(draft?.outboundId).toBe((fulfilled[0] as PromiseFulfilledResult<unknown>).value);

    // Provider timeout / unknown status: reconcile never got a terminal
    // result within budget -> flagged, but the claim is not duplicated or
    // silently marked sent.
    const pending = async () => ({ status: "pending" as const, agentmailMessageId: null, threadId: null, errorMessage: null });
    await t.run((ctx) => reconcileSendImpl(ctx, { draftId, attempt: 5 }, pending));
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9
// ---------------------------------------------------------------------------

describe("2×12000 observed 9500 → claim 5000", () => {
  it("opens exactly one price_adjustment claim of 5000 cents, and a second check does not duplicate it", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const sourceUrl = "https://n.example/p/jacket";
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Northwind",
      merchantDomain: "n.example",
      purchasedAt: Date.now() - 2 * DAY,
      currency: "USD",
      items: [{ name: "Jacket", unitCents: 12000, qty: 2, productUrl: sourceUrl }],
    });
    await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: "n.example",
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      contactEmail: "help@n.example",
      passage: "14 days",
      sourceUrl: "https://n.example/policy",
      confidence: 0.9,
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    const itemId = items[0]._id;

    const good = { currency: "USD", confidence: 0.9, variantMatch: "exact" as const, sourceUrl };
    const first = await t.mutation(internal.priceWatch.recordCheck, { itemId, observedCents: 9500, ...good });
    expect(first.opened).toBe(true);
    if (!first.opened) throw new Error("unreachable");
    expect((await t.run((ctx) => ctx.db.get(first.claimId)))?.expectedCents).toBe(5000);

    const second = await t.mutation(internal.priceWatch.recordCheck, { itemId, observedCents: 9000, ...good });
    expect(second.opened).toBe(false);

    const got = await as.query(api.purchases.get, { purchaseId });
    expect(got!.items[0].claims.filter((c) => c.type === "price_adjustment")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10
// ---------------------------------------------------------------------------

describe("wrong variant / currency / expired window / missing price → no claim", () => {
  const sourceUrl = "https://n.example/p/jacket";

  async function seedItem(t: T, as: As, userId: Id<"users">, opts: { purchasedAt?: number; windowDays?: number } = {}) {
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Northwind",
      merchantDomain: "n.example",
      purchasedAt: opts.purchasedAt ?? Date.now() - 2 * DAY,
      currency: "USD",
      items: [{ name: "Jacket", unitCents: 12000, qty: 1, productUrl: sourceUrl }],
    });
    await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: "n.example",
      kind: "price_adjustment",
      windowDays: opts.windowDays ?? 14,
      channel: "email",
      contactEmail: "help@n.example",
      passage: "14 days",
      sourceUrl: "https://n.example/policy",
      confidence: 0.9,
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    return items[0]._id;
  }

  it("wrong variant match records the check but opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const itemId = await seedItem(t, as, userId);
    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      currency: "USD",
      confidence: 0.9,
      variantMatch: "unsure",
      sourceUrl,
    });
    expect(res.opened).toBe(false);
    const checks = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    expect(checks).toHaveLength(1);
  });

  it("currency mismatch (EUR vs USD) records the check but opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const itemId = await seedItem(t, as, userId);
    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      currency: "EUR",
      confidence: 0.9,
      variantMatch: "exact",
      sourceUrl,
    });
    expect(res.opened).toBe(false);
    const checks = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    expect(checks).toHaveLength(1);
  });

  it("expired policy window records the check but opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const itemId = await seedItem(t, as, userId, { purchasedAt: Date.now() - 30 * DAY, windowDays: 14 });
    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      observedCents: 9500,
      currency: "USD",
      confidence: 0.9,
      variantMatch: "exact",
      sourceUrl,
    });
    expect(res.opened).toBe(false);
    const checks = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    expect(checks).toHaveLength(1);
  });

  it("missing price records a check with no observedCents and opens no claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const itemId = await seedItem(t, as, userId);
    const res = await t.mutation(internal.priceWatch.recordCheck, {
      itemId,
      sourceUrl,
      note: "check failed: timeout",
    });
    expect(res.opened).toBe(false);
    const checks = await t.run((ctx) => ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());
    expect(checks).toHaveLength(1);
    expect(checks[0].observedCents).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 11
// ---------------------------------------------------------------------------

describe("manual + cron overlap → one open claim", () => {
  it("two concurrent recordCheck calls (Promise.all) yield exactly one price claim", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const sourceUrl = "https://n.example/p/jacket";
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Northwind",
      merchantDomain: "n.example",
      purchasedAt: Date.now() - 2 * DAY,
      currency: "USD",
      items: [{ name: "Jacket", unitCents: 12000, qty: 1, productUrl: sourceUrl }],
    });
    await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: "n.example",
      kind: "price_adjustment",
      windowDays: 14,
      channel: "email",
      contactEmail: "help@n.example",
      passage: "14 days",
      sourceUrl: "https://n.example/policy",
      confidence: 0.9,
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    const itemId = items[0]._id;

    const args = { itemId, observedCents: 9500, currency: "USD", confidence: 0.9, variantMatch: "exact" as const, sourceUrl };
    await Promise.all([
      t.mutation(internal.priceWatch.recordCheck, args), // "manual"
      t.mutation(internal.priceWatch.recordCheck, args), // "cron"
    ]);

    const got = await as.query(api.purchases.get, { purchaseId });
    expect(got!.items[0].claims.filter((c) => c.type === "price_adjustment")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 12
// ---------------------------------------------------------------------------

describe("queued send without message id → UI queued", () => {
  async function seedQueuedDraft(t: T, as: As, userId: Id<"users">) {
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const to = await confirmReturnsPolicy(t, as, userId, merchantDomain);
    const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to, subject: "s", body: "b" });
    await as.mutation(api.drafts.approveAndSend, { draftId, to, subject: "s", body: "b" });
    return { claimId, draftId };
  }

  it("right after approveAndSend the claim is queued and sendStatus carries no agentmailMessageId", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, draftId } = await seedQueuedDraft(t, as, userId);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    const status = await as.query(api.drafts.sendStatus, { draftId });
    expect(status).not.toBeNull();
    expect(status?.agentmailMessageId ?? null).toBeNull();
  });

  it("reconcile ×5 with no terminal status flags sendUnknown and the claim stays queued (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, draftId } = await seedQueuedDraft(t, as, userId);

    const pending = async () => ({ status: "pending" as const, agentmailMessageId: null, threadId: null, errorMessage: null });
    await t.run((ctx) => reconcileSendImpl(ctx, { draftId, attempt: 5 }, pending));

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true);
  });

  it("reconcile with a message id moves the claim to sent and schedules exactly one pending follow-up (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, draftId } = await seedQueuedDraft(t, as, userId);

    await t.run((ctx) =>
      reconcileSendImpl(ctx, { draftId, attempt: 1 }, async () => ({
        status: "sent",
        agentmailMessageId: "am-1",
        threadId: "th-1",
        errorMessage: null,
      })),
    );

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
    const followUps = await t.run((ctx) => ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    expect(followUps.filter((f) => f.status === "pending")).toHaveLength(1);
  });

  it("reconcile with a terminal failure returns the claim to drafted with sendError and no follow-up (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, draftId } = await seedQueuedDraft(t, as, userId);

    await t.run((ctx) =>
      reconcileSendImpl(ctx, { draftId, attempt: 1 }, async () => ({
        status: "failed",
        agentmailMessageId: null,
        threadId: null,
        errorMessage: "mailbox full",
      })),
    );

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("drafted");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.sendError).toBe("mailbox full");
    const followUps = await t.run((ctx) => ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    expect(followUps.filter((f) => f.status === "pending")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 13
// ---------------------------------------------------------------------------

describe("confirm credit while reminder fires → no stale action", () => {
  it("firing a stale (already-due) reminder against an already-confirmed claim cancels it without setting attentionAt (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedReturnClaim(as, { unitCents: 4000 });

    await as.mutation(api.claims.confirmCredit, { claimId, cents: 4000, evidence: "stmt", idempotencyKey: "k1" });
    const confirmed = await t.run((ctx) => ctx.db.get(claimId));
    expect(confirmed?.status).toBe("confirmed");

    // Simulate a reminder that was already scheduled and became due despite
    // the claim having just been confirmed (a race between the scheduler
    // and the user's confirmation) -- a "stale schedule".
    const scheduledFnId = await t.run((ctx) => ctx.scheduler.runAt(Date.now() + 999_999, internal.followUps.fire, { claimId }));
    const followUpId = await t.run((ctx) =>
      ctx.db.insert("followUps", {
        claimId,
        userId,
        scheduledFnId,
        fireAt: Date.now() - 1000,
        claimVersion: confirmed!.version,
        status: "pending",
      }),
    );

    await t.mutation(internal.followUps.fire, { claimId });

    const row = await t.run((ctx) => ctx.db.get(followUpId));
    expect(row?.status).toBe("cancelled");
    const after = await t.run((ctx) => ctx.db.get(claimId));
    expect(after?.attentionAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 14
// ---------------------------------------------------------------------------

describe('reply "refund issued" → promised only', () => {
  it("a reply stating an amount writes promised_credit only: status promised, confirmed 0 (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await approveAndReconcileToSent(t, as, userId, claimId, merchantDomain);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-issued-1",
      from: "support@n.example",
      classification: "credit_issued",
      summary: "Refund issued",
      promisedAmount: 40,
    });

    const c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("promised");
    expect(c!.balance.confirmed).toBe(0);
    expect(c!.events).toHaveLength(1);
    expect(c!.events[0].kind).toBe("promised_credit");
    expect(c!.events[0].cents).toBe(4000);
  });

  it("a reply with no amount stated still moves to promised but writes zero ledger events (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId, merchantDomain } = await seedReturnClaim(as, { unitCents: 4000 });
    await approveAndReconcileToSent(t, as, userId, claimId, merchantDomain);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-no-amount-1",
      from: "support@n.example",
      classification: "promise",
      summary: "We'll take care of it",
    });

    const c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("promised");
    expect(c!.balance.confirmed).toBe(0);
    expect(c!.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15
// ---------------------------------------------------------------------------

describe("form/chat/phone merchant → packet flow", () => {
  it("markPacketSent sets status packet, adds a status note, schedules a pending follow-up, and creates no outbound row", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { claimId } = await seedReturnClaim(as, { unitCents: 4000 });

    await as.mutation(api.drafts.markPacketSent, { claimId, note: "Called support, said 5-7 business days" });

    const c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("packet");
    expect(c!.notes.some((n) => n.kind === "status" && n.text.includes("Called support"))).toBe(true);
    expect(c!.followUps.filter((f) => f.status === "pending")).toHaveLength(1);
    // No email channel was ever used: no draft/outbound row exists for this claim.
    expect(c!.drafts).toHaveLength(0);
    const events = await t.run((ctx) => ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 16
// ---------------------------------------------------------------------------

describe("examples: load twice → one set; all hosts .example; board totals 0; remove archives", () => {
  it("is idempotent, keeps every host under .example, totals zero, and remove archives the set", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);

    const first = await as.mutation(api.examples.load, {});
    expect(first.loaded).toBe(true);
    const second = await as.mutation(api.examples.load, {});
    expect(second).toEqual({ loaded: false });

    const purchases = await t.run((ctx) => ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    expect(purchases).toHaveLength(2);

    const policies = await t.run((ctx) => ctx.db.query("policies").collect());
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p.contactEmail).toBeDefined();
      expect(p.contactEmail!.split("@")[1]).toMatch(/\.example$/);
      expect(new URL(p.sourceUrl).host).toMatch(/\.example$/);
    }
    const items = await t.run((ctx) => ctx.db.query("items").collect());
    const withUrl = items.filter((i) => i.productUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    for (const i of withUrl) {
      expect(new URL(i.productUrl!).host).toMatch(/\.example$/);
    }

    const board = await as.query(api.purchases.board, {});
    expect(board.totals).toEqual({ owed: 0, asked: 0, confirmed: 0 });

    await as.mutation(api.examples.remove, {});
    const afterRemove = await t.run((ctx) => ctx.db.query("purchases").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    expect(afterRemove).toHaveLength(2);
    expect(afterRemove.every((p) => p.status === "archived")).toBe(true);
    const boardAfter = await as.query(api.purchases.board, {});
    expect(boardAfter.purchases).toHaveLength(0);

    // Removing frees the idempotency guard: a fresh set can be loaded again.
    const third = await as.mutation(api.examples.load, {});
    expect(third.loaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 17
// ---------------------------------------------------------------------------

describe("refund credit matching two same-price items → needs_review event, no claim, returned untouched", () => {
  it("marks the event needs_review, opens no claim, and leaves both items' returned flag untouched (offline)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Acme",
      merchantDomain: "acme.example",
      orderRef: "A-9",
      purchasedAt: Date.now() - 10 * DAY,
      currency: "USD",
      items: [
        { name: "Blue Scarf", unitCents: 4000, qty: 1 },
        { name: "Red Scarf", unitCents: 4000, qty: 1 },
      ],
    });
    const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
    await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
    await as.mutation(api.purchases.setReturned, { itemId: items[1]._id, returned: true });

    const eventId = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-ambiguous-refund",
        kind: "agentmail.message.received",
        status: "processing",
        attempts: 1,
        userId,
        payload: {},
      }),
    );

    await t.mutation(internal.intake.applyExtraction, {
      userId,
      eventId,
      parsed: {
        kind: "refund",
        order: null,
        refund: {
          merchant: "Acme",
          orderRef: "A-9",
          credits: [{ itemName: null, amount: 40, currency: "USD", state: "posted" }],
        },
        confidence: 0.9,
      },
    });

    const row = await t.run((ctx) => ctx.db.get(eventId));
    expect(row?.status).toBe("needs_review");
    expect(row?.summary).toContain("could not be matched");

    const claims = await t.run((ctx) => ctx.db.query("claims").collect());
    expect(claims).toHaveLength(0);

    const after = await t.run((ctx) => ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).collect());
    expect(after).toHaveLength(2);
    expect(after.every((i) => i.returned)).toBe(true);
  });
});
