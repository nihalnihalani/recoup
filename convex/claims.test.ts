import { describe, it, expect } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn, fakeSchedulerTimersEach } from "./test.setup";
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

  describe("review hardening (D38-D48)", () => {
    const credit = (as: any, claimId: Id<"claims">, cents: number, idempotencyKey: string) =>
      as.mutation(api.claims.confirmCredit, { claimId, cents, evidence: "statement", idempotencyKey });
    const debit = (as: any, claimId: Id<"claims">, cents: number, idempotencyKey: string) =>
      as.mutation(api.claims.recordLaterDebit, { claimId, cents, evidence: "chargeback", idempotencyKey });

    it("D38: idempotency keys are per claim; differing facts conflict; empty key rejected", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf, sweater } = await purchaseWithItems(as);
      const a = await openReturnClaim(as, scarf);
      const b = await openReturnClaim(as, sweater);

      expect((await credit(as, a, 1000, "k1")).deduped).toBe(false);
      // Same key on another claim is a different event, not a dedupe.
      expect((await credit(as, b, 1000, "k1")).deduped).toBe(false);
      expect((await as.query(api.claims.get, { claimId: b }))!.balance.confirmed).toBe(1000);
      // Same key, same facts: no-op.
      expect((await credit(as, a, 1000, "k1")).deduped).toBe(true);
      expect((await as.query(api.claims.get, { claimId: a }))!.balance.confirmed).toBe(1000);
      // Same key, different cents or kind: conflict.
      await expect(credit(as, a, 2000, "k1")).rejects.toThrow(/idempotency conflict/);
      await expect(debit(as, a, 1000, "k1")).rejects.toThrow(/idempotency conflict/);
      await expect(credit(as, a, 500, "  ")).rejects.toThrow(/idempotencyKey/);
      // Asserts run before the dedupe lookup; zero is never a ledger event (D48).
      await expect(credit(as, a, 0, "k1")).rejects.toThrow(/positive/);
    });

    describe("D112 6a-1: MAX_IDEMPOTENCY_KEY_CHARS bounds only the public, client-supplied key", () => {
      it("confirmCredit and recordLaterDebit refuse a 129-char idempotencyKey", async () => {
        const t = setup();
        const { as } = await signedIn(t);
        const { scarf } = await purchaseWithItems(as);
        const claimId = await openReturnClaim(as, scarf);
        const tooLong = "k".repeat(129);
        await expect(credit(as, claimId, 500, tooLong)).rejects.toThrow(/idempotencyKey/);
        await expect(debit(as, claimId, 100, tooLong)).rejects.toThrow(/idempotencyKey/);
      });

      it("a 128-char idempotencyKey (the boundary itself) is accepted", async () => {
        const t = setup();
        const { as } = await signedIn(t);
        const { scarf } = await purchaseWithItems(as);
        const claimId = await openReturnClaim(as, scarf);
        const exact = "k".repeat(128);
        expect((await credit(as, claimId, 500, exact)).deduped).toBe(false);
      });

      it("the internal path (applyEventInternal -> applyEvent) accepts a key far longer than 128 chars -- the bound moved to the public mutations only", async () => {
        const t = setup();
        const { as, userId } = await signedIn(t);
        const { scarf } = await purchaseWithItems(as);
        const claimId = await openReturnClaim(as, scarf);
        const longKey = "m".repeat(500);
        const result = await t.mutation(internal.claims.applyEventInternal, {
          claimId,
          userId,
          kind: "promised_credit",
          cents: 500,
          evidence: "long internal key",
          idempotencyKey: longKey,
        });
        expect(result.deduped).toBe(false);
        const detail = await as.query(api.claims.get, { claimId });
        expect(detail!.events.some((e) => e.idempotencyKey === longKey)).toBe(true);
      });
    });

    it("D40: a later debit cannot exceed net confirmed credit", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf } = await purchaseWithItems(as);
      const claimId = await openReturnClaim(as, scarf);
      await expect(debit(as, claimId, 100, "d0")).rejects.toThrow(/cannot exceed/);
      await credit(as, claimId, 4000, "c1");
      await debit(as, claimId, 3000, "d1");
      await expect(debit(as, claimId, 1001, "d2")).rejects.toThrow(/cannot exceed/);
      await debit(as, claimId, 1000, "d3");
      const c = await as.query(api.claims.get, { claimId });
      expect(c!.balance.debited).toBe(4000);
      expect(c!.claim.status).toBe("reopened");
    });

    it("D41: adjustExpected re-derives status and refuses dismissed", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf, sweater } = await purchaseWithItems(as);
      const claimId = await openReturnClaim(as, scarf);
      await credit(as, claimId, 3000, "c1");
      expect((await as.query(api.claims.get, { claimId }))!.claim.status).toBe("detected");

      await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 3000, reason: "fee" });
      expect((await as.query(api.claims.get, { claimId }))!.claim.status).toBe("confirmed");

      await as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 4000, reason: "no fee" });
      expect((await as.query(api.claims.get, { claimId }))!.claim.status).toBe("reopened");

      const other = await openReturnClaim(as, sweater);
      await as.mutation(api.claims.dismiss, { claimId: other });
      await expect(
        as.mutation(api.claims.adjustExpected, { claimId: other, expectedCents: 100, reason: "x" }),
      ).rejects.toThrow(/dismissed/);
    });

    it("D44: one return_credit claim per item unless the previous one is dismissed", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf } = await purchaseWithItems(as);
      const first = await openReturnClaim(as, scarf);
      await credit(as, first, 4000, "c1");
      expect((await as.query(api.claims.get, { claimId: first }))!.claim.status).toBe("confirmed");
      await expect(as.mutation(api.claims.open, { itemId: scarf })).rejects.toThrow(/already exists/);
    });

    it("D44: a dismissed return claim can be replaced", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf } = await purchaseWithItems(as);
      const first = await openReturnClaim(as, scarf);
      await as.mutation(api.claims.dismiss, { claimId: first });
      const second = await as.mutation(api.claims.open, { itemId: scarf });
      expect(second).not.toBe(first);
    });

    it("D46: openClaim re-checks item, purchase and price-check relationships", async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const { as: bob, userId: bobId } = await signedIn(t, "Bob");
      const mine = await purchaseWithItems(as);
      const other = await purchaseWithItems(as);
      const bobs = await purchaseWithItems(bob);
      const base = { userId, type: "price_adjustment" as const, expectedCents: 500 };

      await expect(
        t.run((ctx) => openClaim(ctx, { ...base, purchaseId: other.purchaseId, itemId: mine.scarf })),
      ).rejects.toThrow(/does not belong/);
      await expect(
        t.run((ctx) => openClaim(ctx, { ...base, purchaseId: bobs.purchaseId, itemId: bobs.scarf })),
      ).rejects.toThrow(/Item not found/);

      const foreignCheck = await t.run((ctx) =>
        ctx.db.insert("priceChecks", {
          itemId: mine.scarf,
          userId: bobId,
          observedAt: Date.now(),
          sourceUrl: "https://northwind.example/p/scarf",
        }),
      );
      await expect(
        t.run((ctx) =>
          openClaim(ctx, {
            ...base,
            purchaseId: mine.purchaseId,
            itemId: mine.scarf,
            openedFromPriceCheckId: foreignCheck,
          }),
        ),
      ).rejects.toThrow(/Price check/);
    });

    it("D48: dismiss refuses a confirmed claim", async () => {
      const t = setup();
      const { as } = await signedIn(t);
      const { scarf } = await purchaseWithItems(as);
      const claimId = await openReturnClaim(as, scarf);
      await credit(as, claimId, 4000, "c1");
      await expect(as.mutation(api.claims.dismiss, { claimId })).rejects.toThrow(/confirmed/);
    });

    it("D57: dismissing a queued claim best-effort cancels the pending send and notes the outcome", async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const { scarf } = await purchaseWithItems(as);
      const claimId = await openReturnClaim(as, scarf);
      // T18.5 (D124 B5): `drafts.insert` can now return `null` for a
      // tombstoned owner; this fixture's userId is always active.
      const draftId = await t.mutation(internal.drafts.insert, {
        claimId,
        userId,
        to: "support@northwind.example",
        subject: "Refund please",
        body: "Hello",
      });
      if (draftId === null) throw new Error("insert refused unexpectedly");
      await t.run(async (ctx) => {
        await ctx.db.patch(draftId, { outboundId: "outbound-1" as never, approvedAt: Date.now() });
        await ctx.db.patch(claimId, { status: "queued" });
      });

      await as.mutation(api.claims.dismiss, { claimId });

      const claim = await t.run((ctx) => ctx.db.get(claimId));
      expect(claim?.status).toBe("dismissed");

      const notes = await t.run((ctx) =>
        ctx.db
          .query("claimNotes")
          .withIndex("by_claim", (q) => q.eq("claimId", claimId))
          .collect(),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0].text).toMatch(/Dismissed; (pending send cancelled|send could not be cancelled)/);
    });
  });
});

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §3.2; D156): the widened ledger kinds are never
// misread by an existing reader. A provisional credit is not recovery and is
// never "charged again".
// ---------------------------------------------------------------------------
describe("provisional ledger kinds and existing readers (D156)", () => {
  it("a provisional_credit / provisional_released row produces no charged_again (or credit) item in insights.activity, only its own not-final kinds", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await t.run(async (ctx) => {
      await ctx.db.insert("ledgerEvents", {
        claimId, userId, kind: "provisional_credit", cents: 2000, evidence: "issuer provisional credit", idempotencyKey: "p1", currency: "USD",
      });
      await ctx.db.insert("ledgerEvents", {
        claimId, userId, kind: "provisional_released", cents: 2000, evidence: "reversed", idempotencyKey: "p2", currency: "USD",
      });
    });
    const { events } = await as.query(api.insights.activity, {});
    const mine = events.filter((e) => e.claimId === claimId);
    expect(mine.some((e) => e.kind === "claim_opened")).toBe(true);
    expect(mine.filter((e) => ["charged_again", "credit_confirmed", "credit_promised"].includes(e.kind))).toEqual([]);
    // They have their own feed kinds, which the dashboard labels "not final" (never money back).
    expect(mine.filter((e) => e.kind === "credit_provisional").map((e) => e.cents)).toEqual([2000]);
    expect(mine.filter((e) => e.kind === "provisional_resolved").map((e) => e.cents)).toEqual([2000]);
    // And the claim's money is untouched by provisional rows.
    const c = await as.query(api.claims.get, { claimId });
    expect(c!.balance).toMatchObject({ confirmed: 0, debited: 0, unresolved: 4000 });
  });
});

// ---------------------------------------------------------------------------
// M10 (contract rev 5 §3.2; DA-A-16; D148 N5; SEC-MF-5 as amended by D145):
// provisional credits, finalize with derived sub-keys through the ONE
// confirmed-credit writer, the finalize-vs-separate choice, non-cash remedies.
// ---------------------------------------------------------------------------
import { ConvexError } from "convex/values";
import { applyEvent } from "./claims";
import { MAX_USER_AMOUNT_MINOR } from "./limits";

// D247 (KX3): a job this file's code schedules never runs on a real timer in the background; tests flush it.
fakeSchedulerTimersEach();

describe("M10 provisional credits (DA-A-16, D148 N5)", () => {
  const recordProvisional = (as: any, claimId: Id<"claims">, amountMinor: number, idempotencyKey: string, currency = "USD") =>
    as.mutation(api.claims.recordProvisionalCredit, { claimId, amount: { amountMinor, currency }, evidence: "issuer letter", idempotencyKey });
  const finalize = (as: any, claimId: Id<"claims">, cents: number, idempotencyKey: string) =>
    as.mutation(api.claims.finalizeProvisionalCredit, { claimId, cents, evidence: "statement: provisional made final", idempotencyKey });
  const reverse = (as: any, claimId: Id<"claims">, cents: number, idempotencyKey: string) =>
    as.mutation(api.claims.reverseProvisionalCredit, { claimId, cents, evidence: "statement: provisional reversed", idempotencyKey });
  const detail = async (as: any, claimId: Id<"claims">) => (await as.query(api.claims.get, { claimId }))!;

  it("a provisional credit is labelled separately: provisional 2,000, unresolved/status/confirmed unchanged, currency stamped", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    const r = await recordProvisional(as, claimId, 2000, "p1");
    expect(r).toEqual({ deduped: false, status: "detected" });
    const c = await detail(as, claimId);
    expect(c.provisionalMinor).toBe(2000);
    expect(c.balance).toMatchObject({ expected: 4000, confirmed: 0, debited: 0, unresolved: 4000 });
    expect(c.events.map((e: any) => [e.kind, e.cents, e.currency])).toEqual([["provisional_credit", 2000, "USD"]]);
  });

  it("the rev-3 design (one client key for both finalize events) conflicts and rolls back — repro A.2", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await recordProvisional(as, claimId, 2000, "p1");
    await expect(
      t.run(async (ctx) => {
        const claim = (await ctx.db.get(claimId))!;
        await applyEvent(ctx, claim, "provisional_released", 2000, "x", "K1");
        await applyEvent(ctx, (await ctx.db.get(claimId))!, "later_debit", 2000, "x", "K1");
      }),
    ).rejects.toThrow(/idempotency conflict/);
  });

  it("finalize writes provisional_released (key:release) + confirmed_credit (key:confirm); a retry dedupes both", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await recordProvisional(as, claimId, 2000, "p1");
    const first = await finalize(as, claimId, 2000, "F1");
    expect(first.deduped).toBe(false);
    const again = await finalize(as, claimId, 2000, "F1");
    expect(again.deduped).toBe(true);
    const c = await detail(as, claimId);
    expect(c.events.map((e: any) => [e.kind, e.cents, e.idempotencyKey]).sort()).toEqual(
      [["confirmed_credit", 2000, "F1:confirm"], ["provisional_credit", 2000, "p1"], ["provisional_released", 2000, "F1:release"]].sort(),
    );
    expect(c.provisionalMinor).toBe(0);
    expect(c.balance).toMatchObject({ confirmed: 2000, unresolved: 2000 });
  });

  it("finalize beyond the outstanding provisional credit, or with none, is refused and writes nothing", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await expect(finalize(as, claimId, 100, "F0")).rejects.toThrow(/provisional/);
    await recordProvisional(as, claimId, 2000, "p1");
    const before = await detail(as, claimId);
    await expect(finalize(as, claimId, 2001, "F1")).rejects.toThrow(/provisional/);
    const after = await detail(as, claimId);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.claim.version).toBe(before.claim.version);
  });

  it("a reversal releases the provisional credit without any confirmed money", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await recordProvisional(as, claimId, 2000, "p1");
    await reverse(as, claimId, 2000, "R1");
    const c = await detail(as, claimId);
    expect(c.provisionalMinor).toBe(0);
    expect(c.balance).toMatchObject({ confirmed: 0, unresolved: 4000 });
    await expect(reverse(as, claimId, 1, "R2")).rejects.toThrow(/provisional/);
  });

  it("N5: provisional 4,000 outstanding + confirmCredit 1,000 without the flag → ProvisionalOutstanding, nothing written", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, sweater); // expected 8,000
    await recordProvisional(as, claimId, 4000, "p1");
    const before = await detail(as, claimId);
    const err = await as
      .mutation(api.claims.confirmCredit, { claimId, cents: 1000, evidence: "merchant refund", idempotencyKey: "c1" })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ConvexError);
    expect((err as ConvexError<{ kind: string; provisionalMinor: number }>).data).toEqual({ kind: "ProvisionalOutstanding", provisionalMinor: 4000 });
    const after = await detail(as, claimId);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.claim.version).toBe(before.claim.version);
  });

  it("N5: with separateFromProvisional → recorded through the one writer, provisional still 4,000; finalize path unchanged", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { sweater } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, sweater);
    await recordProvisional(as, claimId, 4000, "p1");
    await as.mutation(api.claims.confirmCredit, {
      claimId, cents: 1000, evidence: "separate merchant refund", idempotencyKey: "c1", separateFromProvisional: true,
    });
    let c = await detail(as, claimId);
    expect(c.provisionalMinor).toBe(4000);
    expect(c.balance).toMatchObject({ confirmed: 1000, unresolved: 7000 });
    expect(c.events.find((e: any) => e.kind === "confirmed_credit")?.currency).toBe("USD");
    await finalize(as, claimId, 4000, "F1");
    c = await detail(as, claimId);
    expect(c.provisionalMinor).toBe(0);
    expect(c.balance).toMatchObject({ confirmed: 5000, unresolved: 3000 });
  });

  it("idempotency: same key + same amount dedupes; same key + different amount conflicts", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await recordProvisional(as, claimId, 2000, "p1");
    expect((await recordProvisional(as, claimId, 2000, "p1")).deduped).toBe(true);
    await expect(recordProvisional(as, claimId, 2500, "p1")).rejects.toThrow(/idempotency conflict/);
    expect((await detail(as, claimId)).provisionalMinor).toBe(2000);
  });

  it("refuses a currency mismatch, a dismissed claim and an amount above the typed-amount cap", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf, sweater } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await expect(recordProvisional(as, claimId, 2000, "p1", "EUR")).rejects.toThrow(/currency/);
    await expect(recordProvisional(as, claimId, 10 ** 12, "p2")).rejects.toThrow(/larger than Recoup accepts/);
    await expect(
      as.mutation(api.claims.confirmCredit, { claimId, cents: MAX_USER_AMOUNT_MINOR + 1, evidence: "x", idempotencyKey: "c9" }),
    ).rejects.toThrow(/larger than Recoup accepts/);
    const dismissed = await openReturnClaim(as, sweater);
    await as.mutation(api.claims.dismiss, { claimId: dismissed });
    await expect(recordProvisional(as, dismissed, 100, "p3")).rejects.toThrow(/dismissed/);
    expect((await detail(as, claimId)).events).toHaveLength(0);
  });

  it("another user's claim gets the identical not-found on every new mutation, and nothing is written", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    const { scarf } = await purchaseWithItems(alice);
    const claimId = await openReturnClaim(alice, scarf);
    await recordProvisional(alice, claimId, 2000, "p1");
    for (const call of [
      () => recordProvisional(bob, claimId, 100, "b1"),
      () => finalize(bob, claimId, 100, "b2"),
      () => reverse(bob, claimId, 100, "b3"),
      () => bob.mutation(api.claims.recordNonCashRemedy, { claimId, kind: "voucher", description: "v", state: "promised", idempotencyKey: "b4" }),
      () => bob.query(api.claims.get, { claimId }),
    ]) {
      await expect(call()).rejects.toThrow(/Claim not found/);
    }
    const c = await detail(alice, claimId);
    expect(c.events).toHaveLength(1);
    expect(c.nonCashRemedies).toHaveLength(0);
  });
});

describe("M10 non-cash remedies (contract §3.2)", () => {
  const record = (as: any, claimId: Id<"claims">, over: Record<string, unknown> = {}) =>
    as.mutation(api.claims.recordNonCashRemedy, {
      claimId, kind: "voucher", description: "Store voucher", faceValue: { amountMinor: 1000, currency: "USD" },
      state: "promised", idempotencyKey: "n1", ...over,
    });

  it("appends a row without touching status, version or the ledger; received later is a second row", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    const before = (await as.query(api.claims.get, { claimId }))!;
    const r = await record(as, claimId);
    expect(r.deduped).toBe(false);
    await record(as, claimId, { state: "received", idempotencyKey: "n2" });
    const c = (await as.query(api.claims.get, { claimId }))!;
    expect(c.nonCashRemedies.map((n: any) => [n.kind, n.state, n.faceValue?.amountMinor])).toEqual([
      ["voucher", "promised", 1000],
      ["voucher", "received", 1000],
    ]);
    expect(c.claim.status).toBe(before.claim.status);
    expect(c.claim.version).toBe(before.claim.version);
    expect(c.events).toHaveLength(0);
    expect(c.balance).toEqual(before.balance); // never cash
  });

  it("idempotency: same key + same facts dedupes to one row; same key + different facts conflicts", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    const first = await record(as, claimId);
    const again = await record(as, claimId);
    expect(again).toEqual({ deduped: true, remedyId: first.remedyId });
    await expect(record(as, claimId, { state: "received" })).rejects.toThrow(/idempotency conflict/);
    expect((await as.query(api.claims.get, { claimId }))!.nonCashRemedies).toHaveLength(1);
  });

  it("refuses a face value in another currency, above the cap, an empty description, and a dismissed claim", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const { scarf, sweater } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    await expect(record(as, claimId, { faceValue: { amountMinor: 1000, currency: "EUR" } })).rejects.toThrow(/currency/);
    await expect(record(as, claimId, { faceValue: { amountMinor: 10 ** 12, currency: "USD" } })).rejects.toThrow(/larger than Recoup accepts/);
    await expect(record(as, claimId, { description: "   " })).rejects.toThrow(/description/);
    const noFace = await record(as, claimId, { kind: "repair", faceValue: undefined, idempotencyKey: "n3" });
    expect(noFace.deduped).toBe(false);
    const dismissed = await openReturnClaim(as, sweater);
    await as.mutation(api.claims.dismiss, { claimId: dismissed });
    await expect(record(as, dismissed)).rejects.toThrow(/dismissed/);
  });
});

describe("SEC-MF-5 (amended, D145): one confirmed-credit writer", () => {
  it("applyEventInternal refuses confirmed_credit and both provisional kinds, writing nothing", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { scarf } = await purchaseWithItems(as);
    const claimId = await openReturnClaim(as, scarf);
    for (const kind of ["confirmed_credit", "provisional_credit", "provisional_released"] as const) {
      await expect(
        t.mutation(internal.claims.applyEventInternal, { claimId, userId, kind, cents: 100, evidence: "x", idempotencyKey: `k-${kind}` }),
      ).rejects.toThrow(/cannot be recorded/);
    }
    const c = (await as.query(api.claims.get, { claimId }))!;
    expect(c.events).toHaveLength(0);
    expect(c.claim.version).toBe(1);
  });

  it("grep: only convex/claims.ts writes confirmed_credit, and only inside writeConfirmedCredit", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const root = new globalThis.URL("./", import.meta.url);
    const files: string[] = [];
    const walk = (rel: string) => {
      for (const name of readdirSync(new globalThis.URL(rel, root))) {
        const p = `${rel}${name}`;
        if (statSync(new globalThis.URL(p, root)).isDirectory()) {
          if (name !== "_generated" && name !== "node_modules") walk(`${p}/`);
        } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) files.push(p);
      }
    };
    walk("");
    const writers = files.filter((f) => {
      const src = readFileSync(new globalThis.URL(f, root), "utf8");
      return /"confirmed_credit"/.test(src) && /(insert\(\s*"ledgerEvents"|applyEvent\(|appendLedgerEvent\()/.test(src);
    });
    expect(writers).toEqual(["claims.ts"]);
    const claimsSrc = readFileSync(new globalThis.URL("claims.ts", root), "utf8");
    const writeSites = [...claimsSrc.matchAll(/appendLedgerEvent\([^;]*"confirmed_credit"/g)];
    expect(writeSites).toHaveLength(1);
    const writer = claimsSrc.slice(claimsSrc.indexOf("async function writeConfirmedCredit"));
    expect(writer.indexOf('"confirmed_credit"')).toBeGreaterThan(0);
    expect(writer.indexOf('"confirmed_credit"')).toBeLessThan(writer.indexOf("\n}\n"));
  });
});
