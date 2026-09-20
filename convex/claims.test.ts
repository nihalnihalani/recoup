import { describe, it, expect } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { openClaim } from "./claims";
import { scheduleReminder } from "./followUps";
import type { Id } from "./_generated/dataModel";

async function purchaseWithItems(as: any) {
  const purchaseId = await as.mutation(api.purchases.create, {
    merchant: "Northwind",
    merchantDomain: "northwind.example",
    purchasedAt: Date.UTC(2026, 7, 25),
    currency: "USD",
    items: [
      { name: "Sweater", unitCents: 8000, qty: 1 },
      { name: "Scarf", unitCents: 4000, qty: 1 },
    ],
  });
  const got = await as.query(api.purchases.get, { purchaseId });
  return { purchaseId, sweater: got!.items[0]._id, scarf: got!.items[1]._id };
}

/** Marks an item returned, then opens the (only public) return_credit claim on it. */
async function openReturnClaim(
  as: any,
  itemId: Id<"items">,
  feeCents?: number,
): Promise<Id<"claims">> {
  await as.mutation(api.purchases.setReturned, { itemId, returned: true });
  return as.mutation(api.claims.open, { itemId, feeCents });
}

describe("claims", () => {
  it("promise 4000 on expected 4000 leaves unresolved 4000 and status promised", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await t.mutation(internal.claims.applyEventInternal, {
      claimId,
      userId,
      kind: "promised_credit",
      cents: 4000,
      evidence: "merchant reply",
      idempotencyKey: "msg:1",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("promised");
    expect(c!.balance.unresolved).toBe(4000);
  });

  it("confirm 1500 then 2500 settles and cancels the reminder", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await t.run(async (ctx) => {
      const claim = (await ctx.db.get(claimId))!;
      await scheduleReminder(ctx, claim, Date.now() + 7 * 86_400_000);
    });

    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 1500,
      evidence: "statement 1",
      idempotencyKey: "k1",
    });
    let c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("detected");
    expect(c!.balance.unresolved).toBe(2500);

    await as.mutation(api.claims.confirmCredit, {
      claimId,
      cents: 2500,
      evidence: "statement 2",
      idempotencyKey: "k2",
    });
    c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.status).toBe("confirmed");
    expect(c!.balance.unresolved).toBe(0);
    expect(c!.followUps.every((f) => f.status === "cancelled")).toBe(true);
  });

  it("later debit 1000 reopens only this claim", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf, sweater } = await purchaseWithItems(as);
    const scarfClaim = await openReturnClaim(as, scarf);
    const sweaterClaim = await openReturnClaim(as, sweater);
    await as.mutation(api.claims.confirmCredit, {
      claimId: scarfClaim,
      cents: 4000,
      evidence: "stmt",
      idempotencyKey: "s1",
    });
    await as.mutation(api.claims.confirmCredit, {
      claimId: sweaterClaim,
      cents: 8000,
      evidence: "stmt",
      idempotencyKey: "s2",
    });
    await as.mutation(api.claims.recordLaterDebit, {
      claimId: scarfClaim,
      cents: 1000,
      evidence: "stmt 2026-10-01",
      idempotencyKey: "d1",
    });
    const s = await as.query(api.claims.get, { claimId: scarfClaim });
    const w = await as.query(api.claims.get, { claimId: sweaterClaim });
    expect(s!.claim.status).toBe("reopened");
    expect(s!.balance.unresolved).toBe(1000);
    expect(w!.claim.status).toBe("confirmed");
    expect(w!.balance.unresolved).toBe(0);
  });

  it("duplicate idempotency key writes one event", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    for (let i = 0; i < 3; i++) {
      await as.mutation(api.claims.confirmCredit, {
        claimId,
        cents: 4000,
        evidence: "x",
        idempotencyKey: "dup",
      });
    }
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.events).toHaveLength(1);
  });

  it("open derives expected server-side and rejects unreturned item", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    await expect(as.mutation(api.claims.open, { itemId: scarf })).rejects.toThrow();
    await as.mutation(api.purchases.setReturned, { itemId: scarf, returned: true });
    const claimId = await as.mutation(api.claims.open, { itemId: scarf });
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.balance.expected).toBe(4000);
  });

  it("open with fee writes expected_change note", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf, 700);
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.balance.expected).toBe(3300);
    const note = c!.notes.find((n: any) => n.kind === "expected_change");
    expect(note?.text).toBe("Fee deducted per policy");
    expect(note?.oldCents).toBe(4000);
    expect(note?.newCents).toBe(3300);
  });

  it("open rejects foreign policyId and mismatched priceCheck", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { userId: otherUserId } = await signedIn(t, "Other");
    const { purchaseId, sweater, scarf } = await purchaseWithItems(as);

    const foreignPolicyId = await t.run(async (ctx) =>
      ctx.db.insert("policies", {
        userId: otherUserId,
        merchantDomain: "northwind.example",
        kind: "returns",
        channel: "email",
        passage: "returns within 30 days",
        sourceUrl: "https://northwind.example/returns",
        retrievedAt: Date.now(),
        confidence: 1,
        confirmedByUser: true,
      }),
    );
    await expect(
      t.run((ctx) =>
        openClaim(ctx, {
          userId,
          purchaseId,
          itemId: scarf,
          type: "return_credit",
          expectedCents: 4000,
          policyId: foreignPolicyId,
        }),
      ),
    ).rejects.toThrow();

    const sweaterPriceCheckId = await t.run(async (ctx) =>
      ctx.db.insert("priceChecks", {
        itemId: sweater,
        userId,
        observedAt: Date.now(),
        sourceUrl: "https://northwind.example/p/sweater",
      }),
    );
    await expect(
      t.run((ctx) =>
        openClaim(ctx, {
          userId,
          purchaseId,
          itemId: scarf,
          type: "return_credit",
          expectedCents: 4000,
          openedFromPriceCheckId: sweaterPriceCheckId,
        }),
      ),
    ).rejects.toThrow();
  });

  it("adjustExpected bumps version, unapproves drafts, writes a note, no ledger event", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await t.run(async (ctx) => {
      await ctx.db.insert("drafts", {
        claimId,
        userId,
        version: 1,
        claimVersion: 1,
        to: "a@b.c",
        subject: "s",
        body: "b",
        approvedAt: Date.now(),
      });
    });
    const before = await as.query(api.claims.get, { claimId });
    await as.mutation(api.claims.adjustExpected, {
      claimId,
      expectedCents: 3300,
      reason: "$7 label fee per policy",
    });
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.claim.version).toBe(2);
    expect(c!.balance.expected).toBe(3300);
    expect(c!.drafts[0].approvedAt).toBeUndefined();
    expect(c!.events).toHaveLength(before!.events.length);
    const note = c!.notes.find((n: any) => n.kind === "expected_change" && n.newCents === 3300);
    expect(note?.oldCents).toBe(4000);
    expect(note?.text).toBe("$7 label fee per policy");
  });

  it("user B cannot read or mutate user A's claim", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { scarf } = await purchaseWithItems(alice);
    const claimId = await openReturnClaim(alice, scarf);
    await expect(bob.query(api.claims.get, { claimId })).rejects.toThrow();
    await expect(
      bob.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence: "x", idempotencyKey: "k" }),
    ).rejects.toThrow();
    await expect(bob.mutation(api.claims.dismiss, { claimId })).rejects.toThrow();
  });

  it("token is unique across claims", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const items = Array.from({ length: 50 }, (_, i) => ({ name: `Item ${i}`, unitCents: 1000, qty: 1 }));
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "Northwind",
      merchantDomain: "northwind.example",
      purchasedAt: Date.UTC(2026, 7, 25),
      currency: "USD",
      items,
    });
    const got = await as.query(api.purchases.get, { purchaseId });
    const claimIds = [];
    for (const it of got!.items) {
      claimIds.push(await openReturnClaim(as, it._id));
    }
    const tokens = await Promise.all(
      claimIds.map(async (id) => (await as.query(api.claims.get, { claimId: id }))!.claim.token),
    );
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});
