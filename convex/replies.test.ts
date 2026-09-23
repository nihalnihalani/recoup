import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { internalKey } from "./lib/idempotency";
import { PAYLOAD_CLEARED_MESSAGE } from "./intake";

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
  // T18.5 (D124 B5): `drafts.insert` can now return `null` for a
  // tombstoned owner; this fixture's userId is always active.
  const draftId = await t.mutation(internal.drafts.insert, {
    claimId,
    userId,
    to: opts.draftTo ?? CONTACT,
    subject: "Refund for order AC-1 [RC-AB12CD]",
    body: "Hello",
  });
  if (draftId === null) throw new Error("insert refused unexpectedly");
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
    // D112 6a-1: no longer the raw `${claimId}:msg:${messageId}` string
    // (unbounded by an external Message-ID) -- a fixed-length hash derived
    // through `lib/idempotency.ts`'s `internalKey`.
    expect(events[0].idempotencyKey).toBe(await internalKey(claimId, "msg", "msg-3"));
    expect(events[0].idempotencyKey).toMatch(/^[0-9a-f]{32}$/);
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

describe("replies.apply — D112 6a-1 long Message-ID idempotency keys", () => {
  it("records and is idempotent for a reply whose messageId is 200 chars (the checkpoint repro shape)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);
    const longMessageId = `<${"a".repeat(181)}@mail.example.com>`;
    expect(longMessageId.length).toBeGreaterThanOrEqual(200);

    const args = {
      claimId,
      messageId: longMessageId,
      from: CONTACT,
      classification: "promise" as const,
      summary: "A credit of $40 is on the way.",
      promisedAmount: 40,
    };

    const first = await t.mutation(internal.replies.apply, args);
    expect(first.deduped).toBe(false);
    expect(first.ledgerWritten).toBe(true);

    const events = await ledger(t, claimId);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toMatch(/^[0-9a-f]{32}$/);

    // Idempotent on replay: `replies.apply` itself dedupes on `messageId`
    // (the `replies.by_message` index) before it ever reaches the ledger,
    // so a second call with the same args is a no-op rather than a second
    // credit.
    const second = await t.mutation(internal.replies.apply, args);
    expect(second.deduped).toBe(true);
    expect(await ledger(t, claimId)).toHaveLength(1);
  });

  it("dedupes against a ledger row written under the OLD raw key format (pre-migration), never double-applying", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);
    const messageId = "msg-legacy-format";

    // Simulate a row this claim wrote before D112 6a-1, under the old raw
    // `${claimId}:msg:${messageId}` key -- as if `replies.apply` had run
    // pre-migration. The reply row itself is not simulated: only the
    // ledger side of the migration hazard is under test here (D112's own
    // wording: "a claim with an old-format key for the same message would
    // be double-applied by the new key").
    await t.run((ctx) =>
      ctx.db.insert("ledgerEvents", {
        claimId,
        userId,
        kind: "promised_credit",
        cents: 4_000,
        evidence: "legacy reply",
        idempotencyKey: `${claimId}:msg:${messageId}`,
      }),
    );

    await t.mutation(internal.replies.apply, {
      claimId,
      messageId,
      from: CONTACT,
      classification: "promise",
      summary: "A credit of $40 is on the way.",
      promisedAmount: 40,
    });

    // The dual lookup found the legacy-keyed row and deduped against it --
    // no second, hash-keyed ledger event for the same message.
    const events = await ledger(t, claimId);
    expect(events).toHaveLength(1);
    expect(events[0].idempotencyKey).toBe(`${claimId}:msg:${messageId}`);
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

// F1 (D266 audit): retention clears a TERMINAL (failed) row's whole payload once it is RETENTION_PAYLOAD_DAYS old
// (`retention.ts` sweepProcessedEvents), which can happen while a reply-route row is still under MAX_ATTEMPTS and
// waiting for `intake.retryFailed`'s hourly pass. Without a guard, that pass would reschedule `replies.classify` on
// an empty `payload.text` -- a real, charged OpenAI call over nothing -- because `messageId` alone (kept) was enough
// to pass the old branch condition.
describe("intake.retryFailed pass 2: a failed reply row whose payload was already cleared (F1)", () => {
  it("is never rescheduled, and spends no budget", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);
    const id = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: "evt-cleared-reply", kind: "agentmail.message.received", status: "failed", attempts: 1, userId, route: "reply", claimId,
        payload: { messageId: "msg-cleared" }, // retention already cleared `text`/`subject`/`from`
      }),
    );
    expect(await t.mutation(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row!.status).toBe("needs_review"); // never "processing" -- replies.classify was never scheduled
    expect(row!.summary).toBe(PAYLOAD_CLEARED_MESSAGE);
    expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
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

// ---------------------------------------------------------------------------
// D115 6b-3 (checkpoint 6b F4b, ported from the reviewer's scratchpad
// da6b.test.ts): a reply that lands for a tombstoned owner -- e.g. one in
// flight when `requestDeletion` ran, mid-purge past the `ledgerEvents` step
// but before `claims` -- must write nothing at all. Fails against the
// pre-T18.2 code (which wrote both a `replies` row and a `promised_credit`
// ledgerEvents row for a deleted account, orphaned and unreachable by any
// later purge pass) and passes once `apply` checks `isTombstoned` before
// writing anything.
// ---------------------------------------------------------------------------
describe("replies.apply tombstone gate (D115 6b-3, checkpoint 6b F4b)", () => {
  it("writes no reply row and no ledger event for a tombstoned owner's claim", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const claimId = await seedSentClaim(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );

    const result = await t.mutation(internal.replies.apply, {
      claimId,
      messageId: "msg-mid-purge",
      from: CONTACT,
      classification: "promise",
      summary: "We will credit $5.",
      promisedAmount: 5,
    });

    expect(result.deduped).toBe(false);
    expect(result.replyId).toBeNull();
    expect(result.ledgerWritten).toBe(false);
    expect(await ledger(t, claimId)).toHaveLength(0);
    const replies = await t.run((ctx) =>
      ctx.db.query("replies").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    );
    expect(replies).toHaveLength(0);
    // The claim itself is untouched: still `sent`, never bumped to `promised`.
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim?.status).toBe("sent");
  });
});
