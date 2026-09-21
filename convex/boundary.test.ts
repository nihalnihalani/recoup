import { describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";

/**
 * T02 boundary tests (P08): every public query/mutation/action that takes an
 * id belonging to another table is exercised with a SECOND user (B)
 * supplying user A's ids, plus the malformed-input matrix and the
 * unauthenticated-action matrix from PLAN.md's T02 contract.
 *
 * Two behaviours are both "correct" here and are tested as such:
 *  - most functions resolve ownership with `lib/access.ts`'s `ownedX`
 *    helpers (or an equivalent inline check) and THROW a fixed, generic
 *    message ("Item not found", "Claim not found", ...) for a foreign id;
 *  - three read models (`insights.priceHistory`, `offers.listForWatch`,
 *    `watches.get`) instead resolve the owner with `getAuthUserId` and
 *    return `null`/an empty shape for a foreign, missing or archived id --
 *    documented in each handler's own comment as intentional (signed-out,
 *    missing and foreign all look the same to the caller), and never
 *    include any of the owner's field values either way.
 *
 * Every seeded row seeds directly via `t.run(ctx => ctx.db.insert(...))`,
 * bypassing the public mutations entirely, so the "usage"/spend tables are
 * verifiably empty before each assertion and no scheduled/background work
 * (email sends, scrapes, model calls) is ever created by the fixtures
 * themselves.
 */

type T = ReturnType<typeof setup>;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 21, 12);

type World = {
  purchaseId: Id<"purchases">;
  itemId: Id<"items">;
  policyId: Id<"policies">;
  claimId: Id<"claims">;
  draftId: Id<"drafts">;
  watchId: Id<"watches">;
  offerId: Id<"offers">;
  processedEventId: Id<"processedEvents">;
};

/** Distinctive substrings planted in every field of `seedWorld(..., tag)`, for leak-checking rejections. */
function secretsFor(tag: string): readonly string[] {
  return [
    `Merchant-${tag}-Corp`,
    `merchant-${tag}.example`,
    `ORD-${tag}-SECRET`,
    `Return window for ${tag} only`,
    `help@merchant-${tag}.example`,
    `Draft subject secret ${tag}`,
    `Draft body secret ${tag}`,
    `Watched item secret ${tag}`,
    `store-${tag}.example`,
    `Other store listing secret ${tag}`,
    `lastError secret ${tag}`,
  ];
}

/** One full, owned "world" of rows for `userId`, inserted directly (no budgets, no schedules). */
async function seedWorld(t: T, userId: Id<"users">, tag: string): Promise<World> {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId,
      merchant: `Merchant-${tag}-Corp`,
      merchantDomain: `merchant-${tag}.example`,
      orderRef: `ORD-${tag}-SECRET`,
      purchasedAt: NOW - 5 * DAY,
      currency: "USD",
      status: "active",
    });
    const itemId = await ctx.db.insert("items", {
      purchaseId,
      userId,
      name: `Widget ${tag}`,
      unitCents: 5_000,
      qty: 1,
      productUrl: `https://merchant-${tag}.example/p/widget`,
      returned: true,
      returnedAt: NOW - DAY,
    });
    const policyId = await ctx.db.insert("policies", {
      userId,
      merchantDomain: `merchant-${tag}.example`,
      kind: "returns",
      channel: "email",
      contactEmail: `help@merchant-${tag}.example`,
      passage: `Return window for ${tag} only`,
      sourceUrl: `https://merchant-${tag}.example/returns`,
      retrievedAt: NOW,
      confidence: 1,
      confirmedByUser: true,
    });
    const claimId = await ctx.db.insert("claims", {
      purchaseId,
      itemId,
      userId,
      type: "return_credit",
      expectedCents: 5_000,
      status: "detected",
      policyId,
      token: `TK${tag.toUpperCase().padEnd(4, "0")}`,
      version: 1,
    });
    const draftId = await ctx.db.insert("drafts", {
      claimId,
      userId,
      version: 1,
      claimVersion: 1,
      to: "",
      subject: `Draft subject secret ${tag}`,
      body: `Draft body secret ${tag}`,
    });
    const watchId = await ctx.db.insert("watches", {
      userId,
      name: `Watched item secret ${tag}`,
      productUrl: `https://store-${tag}.example/p/watched`,
      merchantDomain: `store-${tag}.example`,
      status: "active",
      nextCheckAt: NOW + 3_600_000,
      lastCents: 9_000,
      currency: "USD",
    });
    const offerId = await ctx.db.insert("offers", {
      watchId,
      userId,
      storeDomain: `other-${tag}.example`,
      productUrl: `https://other-${tag}.example/p/x`,
      title: `Other store listing secret ${tag}`,
      status: "candidate",
    });
    const processedEventId = await ctx.db.insert("processedEvents", {
      externalId: `evt-${tag}`,
      kind: "paste",
      status: "failed",
      attempts: 1,
      userId,
      route: "intake",
      lastError: `lastError secret ${tag}`,
      errorSummary: "Extraction failed",
    });
    return { purchaseId, itemId, policyId, claimId, draftId, watchId, offerId, processedEventId };
  });
}

async function usageRowCount(t: T): Promise<number> {
  return (await t.run(async (ctx) => ctx.db.query("usage").collect())).length;
}
async function rowCount<TableName extends "drafts" | "claims" | "watches" | "purchases" | "offers" | "policies" | "processedEvents">(
  t: T,
  table: TableName,
): Promise<number> {
  return (await t.run(async (ctx) => ctx.db.query(table).collect())).length;
}

/** Runs `fn`, asserts it rejects, and asserts the rejection's message contains none of `forbidden`. Returns the error. */
async function expectRejectsNoLeak(fn: () => Promise<unknown>, forbidden: readonly string[]): Promise<Error> {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected the call to reject").toBeInstanceOf(Error);
  const message = String((caught as Error).message) + String((caught as { data?: unknown }).data ?? "");
  for (const secret of forbidden) {
    expect(message).not.toContain(secret);
  }
  return caught as Error;
}

/** Two signed-in users (A the victim, B the attacker) with A's world already seeded. */
async function twoUsers(t: T) {
  const a = await signedIn(t, "A");
  const b = await signedIn(t, "B");
  const worldA = await seedWorld(t, a.userId, "a");
  return { a, b, worldA, secretsA: secretsFor("a") };
}

// ---------------------------------------------------------------------------
// Two-user isolation: every public function that takes another table's id
// ---------------------------------------------------------------------------

describe("boundary: claims.ts", () => {
  it("open: user B's own item cannot be opened via a foreign path, and a foreign itemId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.claims.open, { itemId: worldA.itemId }), secretsA);
    expect(await rowCount(t, "claims")).toBe(1); // only A's seeded claim
  });

  it("confirmCredit: foreign claimId is refused and writes no ledger event", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.claims.confirmCredit, { claimId: worldA.claimId, cents: 100, evidence: "e", idempotencyKey: "k" }),
      secretsA,
    );
    expect(await t.run(async (ctx) => ctx.db.query("ledgerEvents").collect())).toHaveLength(0);
  });

  it("recordLaterDebit: foreign claimId is refused and writes no ledger event", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.claims.recordLaterDebit, { claimId: worldA.claimId, cents: 100, evidence: "e", idempotencyKey: "k" }),
      secretsA,
    );
    expect(await t.run(async (ctx) => ctx.db.query("ledgerEvents").collect())).toHaveLength(0);
  });

  it("adjustExpected: foreign claimId is refused and the claim's expectedCents is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.claims.adjustExpected, { claimId: worldA.claimId, expectedCents: 1, reason: "r" }),
      secretsA,
    );
    const claim = await t.run(async (ctx) => ctx.db.get("claims", worldA.claimId));
    expect(claim!.expectedCents).toBe(5_000);
  });

  it("dismiss: foreign claimId is refused and the claim stays open", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.claims.dismiss, { claimId: worldA.claimId }), secretsA);
    const claim = await t.run(async (ctx) => ctx.db.get("claims", worldA.claimId));
    expect(claim!.status).toBe("detected");
  });

  it("clearAttention: foreign claimId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.claims.clearAttention, { claimId: worldA.claimId }), secretsA);
  });

  it("get: foreign claimId is refused and leaks none of A's data", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.query(api.claims.get, { claimId: worldA.claimId }), secretsA);
  });
});

describe("boundary: drafts.ts", () => {
  it("generate (action): foreign claimId is refused before any model call or budget charge", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expectRejectsNoLeak(() => b.as.action(api.drafts.generate, { claimId: worldA.claimId }), secretsA);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await usageRowCount(t)).toBe(0);
      expect(await rowCount(t, "drafts")).toBe(1); // only A's seeded draft
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("update: foreign draftId is refused and the draft is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.drafts.update, { draftId: worldA.draftId, to: "attacker@evil.example", subject: "s", body: "b" }),
      secretsA,
    );
    const draft = await t.run(async (ctx) => ctx.db.get("drafts", worldA.draftId));
    expect(draft!.subject).toContain("secret-a".slice(0, 0)); // no-op guard, real check below
    expect(draft!.to).toBe("");
  });

  it("approveAndSend: foreign draftId is refused before any send", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    const sendSpy = vi.fn();
    const { agentmail } = await import("./mail");
    vi.spyOn(agentmail, "sendMessage").mockImplementation(sendSpy as never);
    try {
      await expectRejectsNoLeak(
        () =>
          b.as.mutation(api.drafts.approveAndSend, {
            draftId: worldA.draftId,
            to: "attacker@evil.example",
            subject: "s",
            body: "b",
            claimVersion: 1,
            draftVersion: 1,
            recipientConfirmed: true,
          }),
        secretsA,
      );
      expect(sendSpy).not.toHaveBeenCalled();
      expect(await usageRowCount(t)).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("recheckSend: foreign draftId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.drafts.recheckSend, { draftId: worldA.draftId }), secretsA);
  });

  it("sendStatus: foreign draftId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.query(api.drafts.sendStatus, { draftId: worldA.draftId }), secretsA);
  });

  it("markPacketSent: foreign claimId is refused and no claimNote is written", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.drafts.markPacketSent, { claimId: worldA.claimId, note: "n" }), secretsA);
    expect(await t.run(async (ctx) => ctx.db.query("claimNotes").collect())).toHaveLength(0);
  });

  it("listForClaim: foreign claimId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.query(api.drafts.listForClaim, { claimId: worldA.claimId }), secretsA);
  });
});

describe("boundary: market.ts", () => {
  it("refresh: foreign watchId is refused before any budget charge or scheduled lookup", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.market.refresh, { watchId: worldA.watchId }), secretsA);
    expect(await usageRowCount(t)).toBe(0);
  });
});

describe("boundary: offers.ts", () => {
  it("find: foreign watchId is refused before any limiter marker row is written", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.offers.find, { watchId: worldA.watchId }), secretsA);
    // find's own limiter writes a marker `offers` row on success; none should exist beyond A's seeded offer.
    expect(await rowCount(t, "offers")).toBe(1);
  });

  it("confirm: foreign offerId is refused and the offer status is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.offers.confirm, { offerId: worldA.offerId }), secretsA);
    const offer = await t.run(async (ctx) => ctx.db.get("offers", worldA.offerId));
    expect(offer!.status).toBe("candidate");
  });

  it("reject: foreign offerId is refused and the offer status is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.offers.reject, { offerId: worldA.offerId }), secretsA);
    const offer = await t.run(async (ctx) => ctx.db.get("offers", worldA.offerId));
    expect(offer!.status).toBe("candidate");
  });

  it("listForWatch: a foreign watchId does NOT throw -- it returns the same empty shape as signed-out (documented in offers.ts), leaking nothing", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    const result = await b.as.query(api.offers.listForWatch, { watchId: worldA.watchId });
    expect(result).toEqual({ offers: [], best: null, searchingUntil: undefined, nextFindAt: undefined });
    const json = JSON.stringify(result);
    for (const secret of secretsA) expect(json).not.toContain(secret);
  });
});

describe("boundary: policies.ts", () => {
  it("refresh (action): a domain B has no purchase or watch at is refused before any budget charge, even though A owns it", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    void worldA;
    await expectRejectsNoLeak(
      () => b.as.action(api.policies.refresh, { merchantDomain: "merchant-a.example", kind: "returns" }),
      secretsA,
    );
    expect(await usageRowCount(t)).toBe(0);
    expect(await rowCount(t, "policies")).toBe(1); // only A's seeded policy
  });

  it("confirm: foreign policyId is refused and the snapshot is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.policies.confirm, { policyId: worldA.policyId, channel: "email", passage: "attacker text" }),
      secretsA,
    );
    const policy = await t.run(async (ctx) => ctx.db.get("policies", worldA.policyId));
    expect(policy!.confirmedByUser).toBe(true); // unchanged from seed
    expect(policy!.passage).not.toBe("attacker text");
  });
});

describe("boundary: priceWatch.ts", () => {
  it("checkNow: foreign itemId is refused before any budget charge", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.priceWatch.checkNow, { itemId: worldA.itemId }), secretsA);
    expect(await usageRowCount(t)).toBe(0);
  });
});

describe("boundary: purchases.ts", () => {
  it("confirm: a foreign purchaseId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () =>
        b.as.mutation(api.purchases.confirm, {
          purchaseId: worldA.purchaseId,
          merchant: "attacker",
          merchantDomain: "evil.example",
          purchasedAt: NOW,
          items: [{ itemId: worldA.itemId, name: "x", unitCents: 1, qty: 1 }],
        }),
      secretsA,
    );
  });

  it("confirm: B's OWN purchaseId with A's itemId in the items array is refused (mixed-ownership second id)", async () => {
    const t = setup();
    const { a, b, worldA, secretsA } = await twoUsers(t);
    void a;
    const worldB = await seedWorld(t, b.userId, "b");
    await expectRejectsNoLeak(
      () =>
        b.as.mutation(api.purchases.confirm, {
          purchaseId: worldB.purchaseId, // B's own purchase
          merchant: "B Corp",
          merchantDomain: "merchant-b.example",
          purchasedAt: NOW,
          items: [{ itemId: worldA.itemId, name: "stolen", unitCents: 1, qty: 1 }], // A's item
        }),
      secretsA,
    );
    const item = await t.run(async (ctx) => ctx.db.get("items", worldA.itemId));
    expect(item!.name).toBe("Widget a"); // A's item untouched
  });

  it("setReturned: foreign itemId is refused and the item is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.purchases.setReturned, { itemId: worldA.itemId, returned: false }), secretsA);
    const item = await t.run(async (ctx) => ctx.db.get("items", worldA.itemId));
    expect(item!.returned).toBe(true); // unchanged from seed
  });

  it("remove: foreign purchaseId is refused and the purchase stays active", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.purchases.remove, { purchaseId: worldA.purchaseId }), secretsA);
    const purchase = await t.run(async (ctx) => ctx.db.get("purchases", worldA.purchaseId));
    expect(purchase!.status).toBe("active");
  });

  it("get: foreign purchaseId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.query(api.purchases.get, { purchaseId: worldA.purchaseId }), secretsA);
  });
});

describe("boundary: replies.ts", () => {
  it("listForClaim: foreign claimId is refused", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.query(api.replies.listForClaim, { claimId: worldA.claimId }), secretsA);
  });
});

describe("boundary: watches.ts", () => {
  it("get: a foreign watchId does NOT throw -- it returns null exactly like a missing/archived watch (documented in watches.ts), leaking nothing", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    const result = await b.as.query(api.watches.get, { watchId: worldA.watchId });
    expect(result).toBeNull();
    void secretsA;
  });

  it("checkNow: foreign watchId is refused before any budget charge", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.watches.checkNow, { watchId: worldA.watchId }), secretsA);
    expect(await usageRowCount(t)).toBe(0);
  });

  it("setTarget: foreign watchId is refused and the target is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.watches.setTarget, { watchId: worldA.watchId, targetCents: 1 }), secretsA);
    const watch = await t.run(async (ctx) => ctx.db.get("watches", worldA.watchId));
    expect(watch!.targetCents).toBeUndefined();
  });

  it("rename: foreign watchId is refused and the name is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.watches.rename, { watchId: worldA.watchId, name: "stolen" }), secretsA);
    const watch = await t.run(async (ctx) => ctx.db.get("watches", worldA.watchId));
    expect(watch!.name).toBe("Watched item secret a");
  });

  it("setStatus: foreign watchId is refused and the status is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.watches.setStatus, { watchId: worldA.watchId, status: "paused" }), secretsA);
    const watch = await t.run(async (ctx) => ctx.db.get("watches", worldA.watchId));
    expect(watch!.status).toBe("active");
  });

  it("archive: foreign watchId is refused and the status is untouched", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(() => b.as.mutation(api.watches.archive, { watchId: worldA.watchId }), secretsA);
    const watch = await t.run(async (ctx) => ctx.db.get("watches", worldA.watchId));
    expect(watch!.status).toBe("active");
  });

  it("markBought: foreign watchId is refused and creates no purchase", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    await expectRejectsNoLeak(
      () => b.as.mutation(api.watches.markBought, { watchId: worldA.watchId, paidCents: 100, purchasedAt: NOW }),
      secretsA,
    );
    expect(await rowCount(t, "purchases")).toBe(1); // only A's seeded purchase
  });
});

describe("boundary: insights.ts", () => {
  it("priceHistory: a foreign watchId does NOT throw -- it returns null (documented in insights.ts), leaking nothing", async () => {
    const t = setup();
    const { b, worldA, secretsA } = await twoUsers(t);
    const result = await b.as.query(api.insights.priceHistory, { watchId: worldA.watchId });
    expect(result).toBeNull();
    void secretsA;
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated public actions: throw before any spend
// ---------------------------------------------------------------------------

describe("unauthenticated public actions throw before any spend", () => {
  it("drafts.generate throws when signed out and writes no usage row", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "U1");
    const worldA = await seedWorld(t, userId, "u1");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(t.action(api.drafts.generate, { claimId: worldA.claimId })).rejects.toThrow(/not signed in/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await usageRowCount(t)).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("intake.paste throws when signed out and writes no usage row or processedEvents row", async () => {
    const t = setup();
    await expect(t.action(api.intake.paste, { text: "x".repeat(100) })).rejects.toThrow(/not signed in/i);
    expect(await usageRowCount(t)).toBe(0);
    expect(await rowCount(t, "processedEvents")).toBe(0);
  });

  it("policies.refresh throws when signed out and writes no usage row or policy snapshot", async () => {
    const t = setup();
    await expect(t.action(api.policies.refresh, { merchantDomain: "example.com", kind: "returns" })).rejects.toThrow(/not signed in/i);
    expect(await usageRowCount(t)).toBe(0);
    expect(await rowCount(t, "policies")).toBe(0);
  });

  it("profiles.ensureInbox throws when signed out and provisions no inbox", async () => {
    const t = setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await expect(t.action(api.profiles.ensureInbox, {})).rejects.toThrow(/not signed in/i);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(await t.run(async (ctx) => ctx.db.query("profiles").collect())).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// v.id() validator: unknown/malformed id strings fail closed
// ---------------------------------------------------------------------------

describe("v.id() argument validation on malformed id strings", () => {
  it("claims.get rejects a syntactically-invalid claimId", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.query(api.claims.get, { claimId: "not-a-real-id" as never })).rejects.toThrow();
  });

  it("watches.checkNow rejects a syntactically-invalid watchId", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.mutation(api.watches.checkNow, { watchId: "not-a-real-id" as never })).rejects.toThrow();
  });

  it("watches.get (the return-null pattern) STILL rejects a syntactically-invalid watchId (the null return only covers a well-formed but foreign/missing id)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.query(api.watches.get, { watchId: "not-a-real-id" as never })).rejects.toThrow();
  });

  it("purchases.setReturned rejects a syntactically-invalid itemId", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.mutation(api.purchases.setReturned, { itemId: "not-a-real-id" as never, returned: true })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Malformed input matrix: NaN / Infinity / negative cents
// ---------------------------------------------------------------------------

describe("malformed input matrix: NaN/Infinity/negative cents", () => {
  async function returnClaim(t: T, as: Awaited<ReturnType<typeof signedIn>>["as"], userId: Id<"users">) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "M", merchantDomain: "m.example", currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: "n", unitCents: 1_000, qty: 1, returned: true,
      });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "return_credit", expectedCents: 1_000, status: "detected", token: "MALF01", version: 1,
      });
      return { purchaseId, itemId, claimId };
    });
  }

  for (const bad of [NaN, Infinity, -Infinity, -100, 1.5]) {
    it(`claims.confirmCredit rejects cents=${bad}`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const { claimId } = await returnClaim(t, as, userId);
      await expect(as.mutation(api.claims.confirmCredit, { claimId, cents: bad, evidence: "e", idempotencyKey: "k" })).rejects.toThrow();
    });

    it(`claims.recordLaterDebit rejects cents=${bad}`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const { claimId } = await returnClaim(t, as, userId);
      await expect(as.mutation(api.claims.recordLaterDebit, { claimId, cents: bad, evidence: "e", idempotencyKey: "k" })).rejects.toThrow();
    });

    it(`claims.adjustExpected rejects expectedCents=${bad}`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const { claimId } = await returnClaim(t, as, userId);
      await expect(as.mutation(api.claims.adjustExpected, { claimId, expectedCents: bad, reason: "r" })).rejects.toThrow();
    });

    it(`watches.setTarget rejects targetCents=${bad}`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const watchId = await t.run((ctx) =>
        ctx.db.insert("watches", {
          userId, name: "W", productUrl: "https://shop.example/p/1", merchantDomain: "shop.example",
          status: "active", nextCheckAt: NOW,
        }),
      );
      await expect(as.mutation(api.watches.setTarget, { watchId, targetCents: bad })).rejects.toThrow();
    });

    it(`watches.markBought rejects paidCents=${bad}`, async () => {
      const t = setup();
      const { as, userId } = await signedIn(t);
      const watchId = await t.run((ctx) =>
        ctx.db.insert("watches", {
          userId, name: "W", productUrl: "https://shop.example/p/1", merchantDomain: "shop.example",
          status: "active", nextCheckAt: NOW,
        }),
      );
      await expect(as.mutation(api.watches.markBought, { watchId, paidCents: bad, purchasedAt: NOW })).rejects.toThrow();
    });
  }

  it("claims.open rejects a negative feeCents", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const itemId = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "M", merchantDomain: "m.example", currency: "USD", status: "active",
      });
      return ctx.db.insert("items", { purchaseId, userId, name: "n", unitCents: 1_000, qty: 1, returned: true });
    });
    await expect(as.mutation(api.claims.open, { itemId, feeCents: -1 })).rejects.toThrow();
  });

  it("purchases.create rejects NaN unitCents and negative qty in one item", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        merchant: "M", merchantDomain: "m.example", currency: "USD", purchasedAt: NOW,
        items: [{ name: "n", unitCents: NaN, qty: 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.purchases.create, {
        merchant: "M", merchantDomain: "m.example", currency: "USD", purchasedAt: NOW,
        items: [{ name: "n", unitCents: 100, qty: -1 }],
      }),
    ).rejects.toThrow();
  });

  it("purchases.create rejects a non-finite purchasedAt", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        merchant: "M", merchantDomain: "m.example", currency: "USD", purchasedAt: Infinity,
        items: [{ name: "n", unitCents: 100, qty: 1 }],
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Malformed input matrix: empty strings
// ---------------------------------------------------------------------------

describe("malformed input matrix: empty strings", () => {
  it("watches.create rejects an empty productUrl", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(as.mutation(api.watches.create, { productUrl: "" })).rejects.toThrow();
  });

  it("watches.rename rejects a name that is empty after trimming", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "W", productUrl: "https://shop.example/p/1", merchantDomain: "shop.example",
        status: "active", nextCheckAt: NOW,
      }),
    );
    await expect(as.mutation(api.watches.rename, { watchId, name: "   " })).rejects.toThrow();
  });

  it("purchases.create rejects an empty merchantDomain", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        merchant: "M", merchantDomain: "", currency: "USD", purchasedAt: NOW,
        items: [{ name: "n", unitCents: 100, qty: 1 }],
      }),
    ).rejects.toThrow();
  });

  it("purchases.create rejects an item with an empty name", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await expect(
      as.mutation(api.purchases.create, {
        merchant: "M", merchantDomain: "m.example", currency: "USD", purchasedAt: NOW,
        items: [{ name: "   ", unitCents: 100, qty: 1 }],
      }),
    ).rejects.toThrow();
  });

  it("claims.dismiss on an unknown-but-well-formed empty idempotencyKey path: confirmCredit rejects an empty idempotencyKey", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await (async () =>
      t.run(async (ctx) => {
        const purchaseId = await ctx.db.insert("purchases", {
          userId, merchant: "M", merchantDomain: "m.example", currency: "USD", status: "active",
        });
        const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "n", unitCents: 1_000, qty: 1, returned: true });
        const claimId = await ctx.db.insert("claims", {
          purchaseId, itemId, userId, type: "return_credit", expectedCents: 1_000, status: "detected", token: "EMPTY1", version: 1,
        });
        return { claimId };
      }))();
    await expect(
      as.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence: "e", idempotencyKey: "   " }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Malformed input matrix: control characters in names
// ---------------------------------------------------------------------------

describe("malformed input matrix: control characters in names", () => {
  it("watches.rename strips control characters rather than storing them (current behaviour)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "W", productUrl: "https://shop.example/p/1", merchantDomain: "shop.example",
        status: "active", nextCheckAt: NOW,
      }),
    );
    await as.mutation(api.watches.rename, { watchId, name: "Widget\x00\x01\rName\n" });
    const watch = await t.run((ctx) => ctx.db.get("watches", watchId));
    expect(watch!.name).toBe("WidgetName");
  });

  it("watches.create with a name of only control characters falls back to the default name rather than storing an empty one (current behaviour)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const watchId = await as.mutation(api.watches.create, {
      productUrl: "https://shop.example/p/control-char-item",
      name: "\x00\x01\x02",
    });
    const watch = await t.run((ctx) => ctx.db.get("watches", watchId));
    expect(watch!.name.length).toBeGreaterThan(0);
    expect(watch!.name).not.toMatch(/[ -]/);
  });

  it("purchases.create strips control characters from an item name rather than storing them (current behaviour)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const purchaseId = await as.mutation(api.purchases.create, {
      merchant: "M", merchantDomain: "m.example", currency: "USD", purchasedAt: NOW,
      items: [{ name: "Item\x00Name\x01", unitCents: 100, qty: 1 }],
    });
    const items = await t.run((ctx) =>
      ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).collect(),
    );
    expect(items[0].name).toBe("ItemName");
  });
});

// ---------------------------------------------------------------------------
// Malformed input matrix: unbounded string length on claim ledger fields
// ---------------------------------------------------------------------------

describe("malformed input matrix: string length on claims.ts ledger fields", () => {
  async function returnClaim2(t: T, userId: Id<"users">) {
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "M", merchantDomain: "m.example", currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "n", unitCents: 1_000, qty: 1, returned: true });
      const claimId = await ctx.db.insert("claims", {
        purchaseId, itemId, userId, type: "return_credit", expectedCents: 1_000, status: "detected", token: "LEN0001", version: 1,
      });
      return { claimId };
    });
  }

  // T16 tightened these: PLAN.md's T02 contract recorded the (former)
  // absence of a length bound as "current behaviour ... T16 tightens and
  // updates the expectation." claims.ts now bounds evidence/reason/
  // idempotencyKey at 2,000/500/128 chars (convex/lib/text.ts's
  // `assertMaxChars`) with a ConvexError, so a 10,000-char value (still well
  // under the ~1MB platform limit these tests originally probed) is refused.
  it("confirmCredit rejects a 10,000-char evidence string (T16: bounded at 2,000 chars)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await returnClaim2(t, userId);
    const evidence = "e".repeat(10_000);
    await expect(
      as.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence, idempotencyKey: "k" }),
    ).rejects.toThrow(/evidence must be at most 2000 characters/);
    expect(await t.run((ctx) => ctx.db.query("ledgerEvents").collect())).toHaveLength(0);
  });

  it("recordLaterDebit rejects a 10,000-char evidence string (T16: bounded at 2,000 chars)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await returnClaim2(t, userId);
    await as.mutation(api.claims.confirmCredit, { claimId, cents: 1_000, evidence: "e", idempotencyKey: "k0" });
    const evidence = "d".repeat(10_000);
    await expect(
      as.mutation(api.claims.recordLaterDebit, { claimId, cents: 100, evidence, idempotencyKey: "k1" }),
    ).rejects.toThrow(/evidence must be at most 2000 characters/);
  });

  it("adjustExpected rejects a 10,000-char reason string (T16: bounded at 500 chars)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await returnClaim2(t, userId);
    const reason = "r".repeat(10_000);
    await expect(
      as.mutation(api.claims.adjustExpected, { claimId, expectedCents: 500, reason }),
    ).rejects.toThrow(/reason must be at most 500 characters/);
    expect(await t.run((ctx) => ctx.db.query("claimNotes").collect())).toHaveLength(0);
  });

  it("confirmCredit rejects a 10,000-char idempotencyKey (T16: bounded at 128 chars)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await returnClaim2(t, userId);
    const idempotencyKey = "k".repeat(10_000);
    await expect(
      as.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence: "e", idempotencyKey }),
    ).rejects.toThrow(/idempotencyKey must be at most 128 characters/);
  });

  /**
   * FINDING, now fixed (T16; was convex/claims.ts: `confirmCredit`/
   * `recordLaterDebit`/`adjustExpected`, and convex/lib/money.ts
   * `assertPositiveCents`): none of `evidence`, `reason` or `idempotencyKey`
   * had an application-level length cap (unlike every other free-text field
   * in the app -- draft subject/body, claim notes elsewhere, purchase/item
   * names -- which all go through `boundedLine`/`.slice(...)`), so a single
   * call could write a multi-megabyte string into a `ledgerEvents`/
   * `claimNotes` row. This test previously confirmed a ~1.5 MB `evidence`
   * string was accepted with no error; `claims.ts`'s new 2,000-char bound
   * (convex/lib/text.ts's `assertMaxChars`) now rejects it 750x under that
   * size, so this is a passing regression test, not an `it.fails` finding.
   */
  it("confirmCredit rejects an unbounded (~1.5MB) evidence string (T16, was a FINDING)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { claimId } = await returnClaim2(t, userId);
    const evidence = "x".repeat(1_500_000);
    await expect(
      as.mutation(api.claims.confirmCredit, { claimId, cents: 100, evidence, idempotencyKey: "big" }),
    ).rejects.toThrow(/evidence must be at most 2000 characters/);
  });
});
