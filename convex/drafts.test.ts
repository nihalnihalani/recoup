import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { reconcileSendImpl } from "./drafts";

async function seedClaim(
  t: ReturnType<typeof setup>,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
  userId: Id<"users">,
  opts: { confirmPolicy?: boolean; contactEmail?: string } = {},
) {
  await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "N",
    merchantDomain: "n.example",
    purchasedAt: 0,
    currency: "USD",
    items: [{ name: "Scarf", unitCents: 4000, qty: 1 }],
  });
  const { items } = (await as.query(api.purchases.get, { purchaseId }))!;
  await as.mutation(api.purchases.setReturned, { itemId: items[0]._id, returned: true });
  const claimId = await as.mutation(api.claims.open, { itemId: items[0]._id });

  if (opts.confirmPolicy) {
    const contactEmail = opts.contactEmail ?? "support@n.example";
    const policyId = await t.mutation(internal.policies.insertSnapshot, {
      userId,
      merchantDomain: "n.example",
      kind: "returns",
      channel: "email",
      contactEmail,
      passage: "You may return items within 30 days.",
      sourceUrl: "https://n.example/returns",
      confidence: 0.9,
    });
    await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail });
  }

  return { purchaseId, itemId: items[0]._id, claimId };
}

describe("drafts.approveAndSend", () => {
  it("refuses when the claim changed after the draft was made", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId);
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "Order",
      body: "Hello",
    });
    await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 3300, reason: "fee" });

    await expect(
      as.mutation(api.drafts.approveAndSend, {
        draftId,
        to: "support@n.example",
        subject: "Order",
        body: "Hello",
        recipientConfirmed: true,
      }),
    ).rejects.toThrow(/changed/);
  });

  it("refuses an empty recipient", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId);
    const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to: "", subject: "s", body: "b" });

    await expect(
      as.mutation(api.drafts.approveAndSend, { draftId, to: "", subject: "s", body: "b", recipientConfirmed: true }),
    ).rejects.toThrow(/recipient/i);
  });

  it("refuses an unconfirmed recipient when recipientConfirmed is not set (D18)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId);
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });

    await expect(
      as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" }),
    ).rejects.toThrow(/Confirm the recipient/);
  });

  it("allows a recipient matching a user-confirmed policy contact without recipientConfirmed", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });

    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

    const claim = (await as.query(api.claims.get, { claimId }))!.claim;
    expect(claim.status).toBe("queued");
    const followUps = await t.run((ctx) =>
      ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(followUps).toHaveLength(0);
  });

  it("refuses a second approval as already sent, leaving exactly one outboundId ever recorded", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });

    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });
    const firstStatus = await as.query(api.drafts.sendStatus, { draftId });
    expect(firstStatus).not.toBeNull();

    await expect(
      as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" }),
    ).rejects.toThrow(/already/);

    const secondStatus = await as.query(api.drafts.sendStatus, { draftId });
    expect(secondStatus).toEqual(firstStatus);
  });

  it("user B cannot read user A's draft send status", async () => {
    const t = setup();
    const { as: alice, userId } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { claimId } = await seedClaim(t, alice, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await alice.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

    await expect(bob.query(api.drafts.sendStatus, { draftId })).rejects.toThrow();
  });
});

describe("drafts.reconcileSend", () => {
  it("moves a queued claim to sent and schedules a reminder once a message id arrives", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

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
    expect(claim?.threadId).toBe("th-1");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.agentmailMessageId).toBe("am-1");
    const followUps = await t.run((ctx) =>
      ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(followUps.filter((f) => f.status === "pending")).toHaveLength(1);
  });

  it("returns a queued claim to drafted and records sendError on a terminal failure", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

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
  });

  it("reschedules while still pending, and flags sendUnknown after the 5th attempt", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

    const pending = async () => ({ status: "pending" as const, agentmailMessageId: null, threadId: null, errorMessage: null });
    await t.run((ctx) => reconcileSendImpl(ctx, { draftId, attempt: 5 }, pending));

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("queued");
    expect(claim?.sendUnknown).toBe(true);
  });

  it("D49: does not move a claim the user already confirmed, but still records the message id and thread", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId, { confirmPolicy: true });
    const draftId = await t.mutation(internal.drafts.insert, {
      claimId,
      userId,
      to: "support@n.example",
      subject: "s",
      body: "b",
    });
    await as.mutation(api.drafts.approveAndSend, { draftId, to: "support@n.example", subject: "s", body: "b" });

    // The user races ahead (e.g. saw the credit land on their card) and
    // confirms the claim before AgentMail reports a message id.
    await t.run((ctx) => ctx.db.patch(claimId, { status: "confirmed" }));

    await t.run((ctx) =>
      reconcileSendImpl(ctx, { draftId, attempt: 1 }, async () => ({
        status: "sent",
        agentmailMessageId: "am-2",
        threadId: "th-2",
        errorMessage: null,
      })),
    );

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("confirmed");
    expect(claim?.threadId).toBe("th-2");
    const draft = await t.run((ctx) => ctx.db.get(draftId));
    expect(draft?.agentmailMessageId).toBe("am-2");
  });
});

describe("drafts.markPacketSent", () => {
  it("adds a status note without a ledger event and schedules a reminder", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedClaim(t, as, userId);

    await as.mutation(api.drafts.markPacketSent, { claimId, note: "Called support, said 5-7 business days" });

    const claim = (await as.query(api.claims.get, { claimId }))!.claim;
    expect(claim.status).toBe("packet");
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(0);
    const followUps = await t.run((ctx) =>
      ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(followUps.filter((f) => f.status === "pending")).toHaveLength(1);
  });
});
