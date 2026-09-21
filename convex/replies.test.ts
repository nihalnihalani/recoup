import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

async function seedSentClaim(
  t: ReturnType<typeof setup>,
  as: Awaited<ReturnType<typeof signedIn>>["as"],
  userId: Id<"users">,
  opts: { draftTo?: string } = {},
) {
  const draftTo = opts.draftTo ?? "support@n.example";
  await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
  const policyId = await t.mutation(internal.policies.insertSnapshot, {
    userId,
    merchantDomain: "n.example",
    kind: "returns",
    channel: "email",
    contactEmail: draftTo,
    passage: "You may return items within 30 days.",
    sourceUrl: "https://n.example/returns",
    confidence: 0.9,
  });
  await as.mutation(api.policies.confirm, { policyId, channel: "email", contactEmail: draftTo });

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

  const draftId = await t.mutation(internal.drafts.insert, { claimId, userId, to: draftTo, subject: "s", body: "b" });
  await as.mutation(api.drafts.approveAndSend, { draftId, to: draftTo, subject: "s", body: "b" });
  // Simulate reconcileSend having already confirmed delivery.
  await t.run((ctx) => ctx.db.patch(claimId, { status: "sent" }));

  return { claimId, draftId };
}

describe("replies.apply", () => {
  it("a stated amount writes a promised_credit and moves the claim to promised, never confirmed", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-1",
      from: "support@n.example",
      classification: "credit_issued",
      summary: "Refund issued",
      promisedAmount: 40,
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("promised");
    expect(claim?.status).not.toBe("confirmed");

    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("promised_credit");
    expect(events[0].cents).toBe(4000);
  });

  it("a reply with no stated amount still moves the claim to promised with zero ledger events", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-2",
      from: "support@n.example",
      classification: "promise",
      summary: "We'll process this soon",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("promised");
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(0);
  });

  it("a stated amount of zero writes no ledger event (D48: applyEvent rejects 0-cent events)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-zero",
      from: "support@n.example",
      classification: "credit_issued",
      summary: "Refund issued",
      promisedAmount: 0,
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("promised");
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(0);
  });

  it("dedupes by messageId", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);

    const args = {
      claimId,
      messageId: "reply-3",
      from: "support@n.example",
      classification: "credit_issued" as const,
      summary: "x",
      promisedAmount: 40,
    };
    await t.mutation(internal.replies.apply, args);
    await t.mutation(internal.replies.apply, args);

    const replies = await t.run((ctx) =>
      ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(replies).toHaveLength(1);
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(1);
  });

  it("flags senderMismatch when the reply's sender domain differs from the sent draft's recipient domain", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId, { draftTo: "support@n.example" });

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-4",
      from: "someone@totally-different.example",
      classification: "question",
      summary: "Can you confirm your order number?",
    });

    const replies = await t.run((ctx) =>
      ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(replies).toHaveLength(1);
    expect(replies[0].senderMismatch).toBe(true);
  });

  it("does not flag senderMismatch when the sender matches the draft recipient domain", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId, { draftTo: "support@n.example" });

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-4b",
      from: "support@n.example",
      classification: "question",
      summary: "Can you confirm your order number?",
    });

    const replies = await t.run((ctx) =>
      ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(replies[0].senderMismatch).toBe(false);
  });

  it("S2 (D53): a stated amount on a dismissed claim is still recorded as a reply, writes no ledger event, and never throws", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);
    await as.mutation(api.claims.dismiss, { claimId });

    await expect(
      t.mutation(internal.replies.apply, {
        claimId,
        messageId: "reply-dismissed",
        from: "support@n.example",
        classification: "credit_issued",
        summary: "Refund issued",
        promisedAmount: 40,
      }),
    ).resolves.not.toThrow();

    const replies = await t.run((ctx) =>
      ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(replies).toHaveLength(1);
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(0);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("dismissed");
  });

  it("S12 (D58): a no-amount reply promotes a claim from `detected`, but not from `queued`", async () => {
    const t = setup();
    const { as } = await signedIn(t);
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
    const detected = (await t.run((ctx) => ctx.db.get(claimId)))!;
    expect(detected.status).toBe("detected");

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-detected",
      from: "someone@n.example",
      classification: "promise",
      summary: "Will process soon",
    });
    const afterDetected = await t.run((ctx) => ctx.db.get(claimId));
    expect(afterDetected?.status).toBe("promised");

    // Force the claim into `queued` (as if a draft is mid-send) and confirm
    // a second, no-amount reply does NOT promote it from there.
    await t.run((ctx) => ctx.db.patch(claimId, { status: "queued" }));
    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-queued",
      from: "someone@n.example",
      classification: "promise",
      summary: "Will process soon, take two",
    });
    const afterQueued = await t.run((ctx) => ctx.db.get(claimId));
    expect(afterQueued?.status).toBe("queued");
  });

  it("refusal/question sets attentionAt without touching the ledger", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await seedSentClaim(t, as, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "reply-5",
      from: "support@n.example",
      classification: "refusal",
      summary: "Not eligible",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.attentionAt).toBeDefined();
    expect(claim?.status).toBe("sent");
    const events = await t.run((ctx) =>
      ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(events).toHaveLength(0);
  });
});
