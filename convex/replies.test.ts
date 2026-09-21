import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

/**
 * Reply classification (D21). The OpenAI call in `classify` is verified
 * live; these tests drive `apply`, which is where every invariant lives:
 * dedupe by message id, a ledger event only when an amount was stated,
 * never a `confirmed_credit`, and a promise that never reduces what is
 * still unresolved.
 */

const DOMAIN = "acme.example";
const CONTACT = "support@acme.example";

async function seedSentClaim(
  t: ReturnType<typeof setup>,
  userId: Id<"users">,
  opts: { draftTo?: string; status?: "sent" | "confirmed" | "dismissed" } = {},
): Promise<Id<"claims">> {
  const claimId = await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: "Acme",
      merchantDomain: DOMAIN,
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
    });
    return await ctx.db.insert("claims", {
      purchaseId,
      itemId,
      userId,
      type: "return_credit",
      expectedCents: 4000,
      status: opts.status ?? "sent",
      token: "AB12CD",
      version: 1,
    });
  });
  const draftId = await t.mutation(internal.drafts.insert, {
    claimId,
    userId,
    to: opts.draftTo ?? CONTACT,
    subject: "Refund for order AC-1 [RC-AB12CD]",
    body: "Hello",
  });
  await t.run((ctx) => ctx.db.patch(draftId, { approvedAt: Date.now() }));
  return claimId;
}

async function ledger(t: ReturnType<typeof setup>, claimId: Id<"claims">) {
  return await t.run((ctx) =>
    ctx.db
      .query("ledgerEvents")
      .withIndex("by_claim", (q) => q.eq("claimId", claimId))
      .collect(),
  );
}

describe("replies.apply dedupe", () => {
  it("writes one reply per inbound message id and reports the duplicate", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    const args = {
      claimId,
      messageId: "msg-1",
      from: CONTACT,
      classification: "question" as const,
      summary: "They ask for the order number.",
    };
    const first = await t.mutation(internal.replies.apply, args);
    const second = await t.mutation(internal.replies.apply, args);

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.replyId).toBe(first.replyId);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("replies")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("replies.apply money rules (D21)", () => {
  it("writes no ledger event when a promise states no amount, but still promises the claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    const result = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-2",
      from: CONTACT,
      classification: "promise",
      summary: "They will refund the scarf.",
    });

    expect(result.ledgerWritten).toBe(false);
    expect(await ledger(t, claimId)).toHaveLength(0);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("promised");

    const reply = await t.run((ctx) => ctx.db.get(result.replyId!));
    expect(reply?.promisedCents).toBeUndefined();
  });

  it("writes exactly one promised_credit when an amount is stated, keyed by message id", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-3",
      from: CONTACT,
      classification: "promise",
      summary: "A credit of $40 is on the way.",
      promisedAmount: 40,
    });

    const events = await ledger(t, claimId);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("promised_credit");
    expect(events[0].cents).toBe(4000);
    expect(events[0].idempotencyKey).toBe(`${claimId}:msg:msg-3`);
  });

  it("a promise never reduces what is still unresolved", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    const before = (await as.query(api.claims.get, { claimId })).balance;
    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-4",
      from: CONTACT,
      classification: "promise",
      summary: "We will refund $40.",
      promisedAmount: 40,
    });
    const after = (await as.query(api.claims.get, { claimId })).balance;

    expect(before.unresolved).toBe(4000);
    expect(after.unresolved).toBe(4000);
    expect(after.promised).toBe(4000);
    expect(after.confirmed).toBe(0);
  });

  it("never writes a confirmed_credit, even when the merchant says the credit was issued", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-5",
      from: CONTACT,
      classification: "credit_issued",
      summary: "The $40 credit has been issued.",
      promisedAmount: 40,
    });

    const events = await ledger(t, claimId);
    expect(events.every((e) => e.kind !== "confirmed_credit")).toBe(true);
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("promised");
  });

  it("treats a zero or nonsense amount as no amount stated", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    const result = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-6",
      from: CONTACT,
      classification: "promise",
      summary: "Refund incoming.",
      promisedAmount: 0,
    });

    expect(result.ledgerWritten).toBe(false);
    expect(await ledger(t, claimId)).toHaveLength(0);
  });

  it("does not drag a confirmed claim backwards", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId, { status: "confirmed" });

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-7",
      from: CONTACT,
      classification: "promise",
      summary: "One more refund note.",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("confirmed");
  });

  it("still inserts the reply row for a dismissed claim, but never throws or writes a ledger event (D53)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId, { status: "dismissed" });

    const result = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-dismissed-1",
      from: CONTACT,
      classification: "promise",
      summary: "We'll refund $10.",
      promisedAmount: 10,
    });

    expect(result.deduped).toBe(false);
    expect(result.replyId).not.toBeNull();
    expect(result.ledgerWritten).toBe(false);
    expect(await ledger(t, claimId)).toHaveLength(0);

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("dismissed");

    const rows = await t.run((ctx) =>
      ctx.db
        .query("replies")
        .withIndex("by_claim", (q) => q.eq("claimId", claimId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
  });
});

describe("replies.apply attention and sender checks", () => {
  it("flags a refusal for the user's attention without touching the ledger", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-8",
      from: CONTACT,
      classification: "refusal",
      summary: "Outside the return window.",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.attentionAt).toBeDefined();
    expect(claim?.status).toBe("sent");
    expect(await ledger(t, claimId)).toHaveLength(0);
  });

  it("flags a question for attention too", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-9",
      from: CONTACT,
      classification: "question",
      summary: "Which order is this?",
    });

    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.attentionAt).toBeDefined();
  });

  it("marks senderMismatch when the reply comes from a different party (D21)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);

    const matching = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-10",
      from: "agent@mail.acme.example",
      classification: "other",
      summary: "Auto-acknowledgement.",
    });
    const foreign = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-11",
      from: "billing@someone-else.example",
      classification: "other",
      summary: "Unrelated.",
    });

    const a = await t.run((ctx) => ctx.db.get(matching.replyId!));
    const b = await t.run((ctx) => ctx.db.get(foreign.replyId!));
    expect(a?.senderMismatch).toBe(false);
    expect(b?.senderMismatch).toBe(true);
  });

  it("does nothing for a claim that no longer exists", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);
    await t.run((ctx) => ctx.db.delete(claimId));

    const result = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-12",
      from: CONTACT,
      classification: "promise",
      summary: "Gone.",
      promisedAmount: 40,
    });
    expect(result.replyId).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("replies").collect())).toHaveLength(0);
  });
});

describe("replies.listForClaim", () => {
  it("returns the owner's replies and refuses another user's claim", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const claimId = await seedSentClaim(t, owner.userId);
    await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-13",
      from: CONTACT,
      classification: "question",
      summary: "Which order?",
    });

    const rows = await owner.as.query(api.replies.listForClaim, { claimId });
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("msg-13");

    await expect(other.as.query(api.replies.listForClaim, { claimId })).rejects.toThrow(
      /Claim not found/,
    );
  });
});

describe("replies.finishEvent status guard (pre-launch review LOW)", () => {
  it("closes a row that is still being read, and leaves any other row alone", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const insert = (externalId: string, status: "processing" | "failed" | "received") =>
      t.run((ctx) =>
        ctx.db.insert("processedEvents", { externalId, kind: "agentmail.message.received", status, attempts: 1, userId, route: "reply" }),
      );
    const reading = await insert("evt-reading", "processing");
    const timedOut = await insert("evt-timed-out", "failed");
    const requeued = await insert("evt-requeued", "received");
    for (const processedEventId of [reading, timedOut, requeued]) {
      await t.mutation(internal.replies.finishEvent, { processedEventId });
    }
    const status = async (id: Id<"processedEvents">) => (await t.run((ctx) => ctx.db.get(id)))?.status;
    expect(await status(reading)).toBe("succeeded");
    expect(await status(timedOut)).toBe("failed");
    expect(await status(requeued)).toBe("received");
  });
});
