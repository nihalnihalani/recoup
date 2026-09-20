import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { openClaim } from "./claims";

type Signed = Awaited<ReturnType<typeof signedIn>>["as"];

const purchaseInput = {
  merchant: "Northwind",
  merchantDomain: "northwind.example",
  purchasedAt: Date.UTC(2026, 7, 25),
  currency: "USD",
  items: [
    { name: "Sweater", unitCents: 8000, qty: 1 },
    { name: "Scarf", unitCents: 4000, qty: 2 },
  ],
};

async function purchaseWithItems(as: Signed) {
  const purchaseId = await as.mutation(api.purchases.create, purchaseInput);
  const got = await as.query(api.purchases.get, { purchaseId });
  return { purchaseId, sweater: got.items[0]._id, scarf: got.items[1]._id };
}

describe("claims.open (D20)", () => {
  it("derives the expected credit server-side from unit price and quantity", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: scarf });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.status).toBe("detected");
    expect(c.claim.type).toBe("return_credit");
    expect(c.claim.expectedCents).toBe(8000); // 4000 x 2, not a client-supplied number
    expect(c.balance.unresolved).toBe(8000);
    expect(c.claim.token).toMatch(/^[A-Z0-9]{6}$/);
    expect(c.claim.version).toBe(1);
  });

  it("subtracts a validated fee and refuses a fee that swallows the item", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater, feeCents: 700 });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.expectedCents).toBe(7300);

    const { scarf } = await purchaseWithItems(as);
    await expect(
      as.mutation(api.claims.open, { itemId: scarf, feeCents: 8000 }),
    ).rejects.toThrow();
    await expect(as.mutation(api.claims.open, { itemId: scarf, feeCents: -5 })).rejects.toThrow();
    await expect(as.mutation(api.claims.open, { itemId: scarf, feeCents: 1.5 })).rejects.toThrow();
  });

  it("refuses a second open claim of the same type on the same item", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    await as.mutation(api.claims.open, { itemId: scarf });
    await expect(as.mutation(api.claims.open, { itemId: scarf })).rejects.toThrow();
  });

  it("allows a new claim once the old one is dismissed", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const first = await as.mutation(api.claims.open, { itemId: scarf });
    await as.mutation(api.claims.dismiss, { claimId: first });
    const second = await as.mutation(api.claims.open, { itemId: scarf });
    expect(second).not.toBe(first);
  });

  it("refuses another user's item and unauthenticated callers", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { scarf } = await purchaseWithItems(alice);
    await expect(bob.mutation(api.claims.open, { itemId: scarf })).rejects.toThrow();
    await expect(t.mutation(api.claims.open, { itemId: scarf })).rejects.toThrow();
  });

  it("gives every claim a distinct token (D23)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const tokens = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const { scarf } = await purchaseWithItems(as);
      const claimId = await as.mutation(api.claims.open, { itemId: scarf });
      const c = await as.query(api.claims.get, { claimId });
      tokens.add(c.claim.token);
    }
    expect(tokens.size).toBe(8);
  });
});

describe("openClaim helper related-id checks (D19)", () => {
  async function seedPolicy(
    t: ReturnType<typeof setup>,
    userId: Id<"users">,
    merchantDomain: string,
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("policies", {
        userId,
        merchantDomain,
        kind: "returns",
        windowDays: 30,
        channel: "email",
        passage: "p",
        sourceUrl: `https://${merchantDomain}/returns`,
        retrievedAt: 1,
        confidence: 0.9,
        confirmedByUser: true,
      }),
    );
  }

  it("accepts a policy for the same merchant", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const policyId = await seedPolicy(t, userId, "northwind.example");
    const claimId = await as.run((ctx) =>
      openClaim(ctx, {
        userId,
        itemId: scarf,
        type: "price_adjustment",
        expectedCents: 500,
        policyId,
      }),
    );
    const c = await as.query(api.claims.get, { claimId });
    expect(c.policy?._id).toBe(policyId);
  });

  it("refuses a policy from a different merchant", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const policyId = await seedPolicy(t, userId, "elsewhere.example");
    await expect(
      as.run((ctx) =>
        openClaim(ctx, {
          userId,
          itemId: scarf,
          type: "price_adjustment",
          expectedCents: 500,
          policyId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses another user's policy", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t, "Alice");
    const { userId: bobId } = await signedIn(t, "Bob");
    const { scarf } = await purchaseWithItems(as);
    const policyId = await seedPolicy(t, bobId, "northwind.example");
    await expect(
      as.run((ctx) =>
        openClaim(ctx, {
          userId,
          itemId: scarf,
          type: "price_adjustment",
          expectedCents: 500,
          policyId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("refuses a price check that observed a different item", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf, sweater } = await purchaseWithItems(as);
    const checkId = await t.run(async (ctx) =>
      ctx.db.insert("priceChecks", {
        itemId: sweater,
        userId,
        observedCents: 7000,
        observedAt: 1,
        sourceUrl: "https://northwind.example/p/sweater",
      }),
    );
    await expect(
      as.run((ctx) =>
        openClaim(ctx, {
          userId,
          itemId: scarf,
          type: "price_adjustment",
          expectedCents: 1000,
          openedFromPriceCheckId: checkId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("inherits isExample from the purchase (D27)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      ...purchaseInput,
      isExample: true,
    });
    const got = await as.query(api.purchases.get, { purchaseId });
    const claimId = await as.run((ctx) =>
      openClaim(ctx, {
        userId,
        itemId: got.items[0]._id,
        type: "return_credit",
        expectedCents: 8000,
      }),
    );
    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.isExample).toBe(true);
  });
});

describe("claims ledger", () => {
  it("a promise does not settle a claim; user confirmation does", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });

    await t.mutation(internal.claims.applyEventInternal, {
      claimId,
      userId,
      kind: "promised_credit",
      cents: 8000,
      evidence: "merchant reply",
      idempotencyKey: "msg:1",
    });
    let c = await as.query(api.claims.get, { claimId });
    expect(c.claim.status).toBe("promised");
    expect(c.balance.promised).toBe(8000);
    expect(c.balance.unresolved).toBe(8000);

    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 8000,
      evidence: "statement 2026-09-20",
      idempotencyKey: "form:1",
    });
    c = await as.query(api.claims.get, { claimId });
    expect(c.claim.status).toBe("confirmed");
    expect(c.balance.unresolved).toBe(0);
  });

  it("drops duplicate events by idempotency key (D24)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    for (let i = 0; i < 3; i++) {
      const r = await t.mutation(internal.claims.applyEventInternal, {
        claimId,
        userId,
        kind: "promised_credit",
        cents: 8000,
        evidence: "x",
        idempotencyKey: "msg:dup",
      });
      expect(r.deduped).toBe(i > 0);
    }
    const c = await as.query(api.claims.get, { claimId });
    expect(c.events).toHaveLength(1);
    expect(c.claim.version).toBe(2);
  });

  it("a replayed confirmCredit submission never double-credits", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    const args = {
      claimId,
      cents: 4000,
      evidence: "statement",
      idempotencyKey: "form:abc",
    };
    await as.mutation(api.claims.confirmCredit, args);
    await as.mutation(api.claims.confirmCredit, args);
    const c = await as.query(api.claims.get, { claimId });
    expect(c.balance.confirmed).toBe(4000);
    expect(c.balance.unresolved).toBe(4000);
    expect(c.claim.status).toBe("detected");
  });

  it("the same client key on two claims is not a cross-claim dedupe", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater, scarf } = await purchaseWithItems(as);
    const a = await as.mutation(api.claims.open, { itemId: sweater });
    const b = await as.mutation(api.claims.open, { itemId: scarf });
    await as.mutation(api.claims.confirmCredit, {
      claimId: a,
      cents: 100,
      evidence: "s",
      idempotencyKey: "same",
    });
    await as.mutation(api.claims.confirmCredit, {
      claimId: b,
      cents: 200,
      evidence: "s",
      idempotencyKey: "same",
    });
    expect((await as.query(api.claims.get, { claimId: a })).balance.confirmed).toBe(100);
    expect((await as.query(api.claims.get, { claimId: b })).balance.confirmed).toBe(200);
  });

  it("a later charge reopens only that claim", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater, scarf } = await purchaseWithItems(as);
    const sweaterClaim = await as.mutation(api.claims.open, { itemId: sweater });
    const scarfClaim = await as.mutation(api.claims.open, { itemId: scarf });
    await as.mutation(api.claims.confirmCredit, {
      claimId: sweaterClaim,
      cents: 8000,
      evidence: "stmt",
      idempotencyKey: "k1",
    });
    await as.mutation(api.claims.confirmCredit, {
      claimId: scarfClaim,
      cents: 8000,
      evidence: "stmt",
      idempotencyKey: "k2",
    });
    await as.mutation(api.claims.recordLaterDebit, {
      claimId: sweaterClaim,
      cents: 8000,
      evidence: "stmt 2026-10-01",
      idempotencyKey: "k3",
    });
    const s = await as.query(api.claims.get, { claimId: sweaterClaim });
    const w = await as.query(api.claims.get, { claimId: scarfClaim });
    expect(s.claim.status).toBe("reopened");
    expect(s.balance.unresolved).toBe(8000);
    expect(w.claim.status).toBe("confirmed");
  });

  it("shows an over-credit as a negative unresolved balance (D24)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 9000,
      evidence: "stmt",
      idempotencyKey: "k",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.balance.unresolved).toBe(-1000);
    expect(c.claim.status).toBe("confirmed");
  });

  it("refuses ledger writes on another user's claim", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob, userId: bobId } = await signedIn(t, "Bob");
    const { sweater } = await purchaseWithItems(alice);
    const claimId = await alice.mutation(api.claims.open, { itemId: sweater });
    await expect(
      bob.mutation(api.claims.confirmCredit, {
        claimId,
        cents: 10,
        evidence: "x",
        idempotencyKey: "k",
      }),
    ).rejects.toThrow();
    await expect(bob.query(api.claims.get, { claimId })).rejects.toThrow();
    await expect(
      t.mutation(internal.claims.applyEventInternal, {
        claimId,
        userId: bobId,
        kind: "confirmed_credit",
        cents: 10,
        evidence: "x",
      }),
    ).rejects.toThrow();
  });

  it("rejects non-integer and non-positive money", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    for (const cents of [0, -100, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        as.mutation(api.claims.confirmCredit, {
          claimId,
          cents,
          evidence: "x",
          idempotencyKey: `k${cents}`,
        }),
      ).rejects.toThrow();
    }
  });

  it("clears attention and cancels reminders when a claim settles", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    const scheduledFnId = await t.run(async (ctx) =>
      ctx.scheduler.runAfter(60_000, internal.followUps.fire, { claimId }),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(claimId, { attentionAt: Date.now(), status: "sent" });
      await ctx.db.insert("followUps", {
        claimId,
        userId,
        scheduledFnId,
        fireAt: Date.now() + 60_000,
        claimVersion: 1,
        status: "pending",
      });
    });
    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 8000,
      evidence: "stmt",
      idempotencyKey: "k",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.status).toBe("confirmed");
    expect(c.claim.attentionAt).toBeUndefined();
    expect(c.followUps[0].status).toBe("cancelled");
  });
});

describe("claims.adjustExpected (D24)", () => {
  it("writes a note, bumps the version, un-approves drafts and cancels reminders", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    const scheduledFnId = await t.run(async (ctx) =>
      ctx.scheduler.runAfter(60_000, internal.followUps.fire, { claimId }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("drafts", {
        claimId,
        userId,
        version: 1,
        claimVersion: 1,
        to: "help@northwind.example",
        subject: "s",
        body: "b",
        approvedAt: Date.now(),
      });
      await ctx.db.insert("followUps", {
        claimId,
        userId,
        scheduledFnId,
        fireAt: Date.now() + 60_000,
        claimVersion: 1,
        status: "pending",
      });
    });

    await as.mutation(api.claims.adjustExpected, {
      claimId,
      expectedCents: 7300,
      reason: "$7 label fee per policy",
    });

    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.version).toBe(2);
    expect(c.balance.expected).toBe(7300);
    expect(c.drafts[0].approvedAt).toBeUndefined();
    expect(c.followUps[0].status).toBe("cancelled");
    expect(c.events).toHaveLength(0); // bookkeeping is never a ledger event
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0].kind).toBe("expected_change");
    expect(c.notes[0].oldCents).toBe(8000);
    expect(c.notes[0].newCents).toBe(7300);
  });

  it("leaves an already-sent draft alone", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    const approvedAt = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("drafts", {
        claimId,
        userId,
        version: 1,
        claimVersion: 1,
        to: "help@northwind.example",
        subject: "s",
        body: "b",
        approvedAt,
        outboundId: "outbound-1" as never,
      });
    });
    await as.mutation(api.claims.adjustExpected, {
      claimId,
      expectedCents: 100,
      reason: "correction",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.drafts[0].approvedAt).toBe(approvedAt);
  });

  it("refuses zero, negative and another user's claim", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { sweater } = await purchaseWithItems(alice);
    const claimId = await alice.mutation(api.claims.open, { itemId: sweater });
    await expect(
      alice.mutation(api.claims.adjustExpected, { claimId, expectedCents: 0, reason: "r" }),
    ).rejects.toThrow();
    await expect(
      bob.mutation(api.claims.adjustExpected, { claimId, expectedCents: 100, reason: "r" }),
    ).rejects.toThrow();
  });
});

describe("claims.dismiss / clearAttention / needsAttention", () => {
  it("dismiss is terminal for the ledger status machine", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await as.mutation(api.claims.open, { itemId: sweater });
    await as.mutation(api.claims.dismiss, { claimId, reason: "bought on sale knowingly" });
    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 8000,
      evidence: "stmt",
      idempotencyKey: "k",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c.claim.status).toBe("dismissed");
    expect(c.notes[0].text).toBe("bought on sale knowingly");
  });

  it("surfaces only the caller's flagged claims and clears the flag", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { sweater } = await purchaseWithItems(alice);
    const claimId = await alice.mutation(api.claims.open, { itemId: sweater });
    await t.mutation(internal.followUps.fire, { claimId });

    expect(await alice.query(api.claims.needsAttention, {})).toHaveLength(1);
    expect(await bob.query(api.claims.needsAttention, {})).toHaveLength(0);

    await alice.mutation(api.claims.clearAttention, { claimId });
    expect(await alice.query(api.claims.needsAttention, {})).toHaveLength(0);
  });
});
