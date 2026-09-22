/// <reference types="vite/client" />
/**
 * M16 — mission §17 "Concurrency and failure", contract §11.1 row M16: CT-1 … CT-6.
 *
 * convex-test runs one mutation at a time, so two "concurrent" calls here are really two orders of execution. What
 * makes the result hold in production is Convex's optimistic concurrency control: a transaction commits only if
 * nothing it READ was written by a transaction that committed after it started; otherwise it re-runs against the
 * new state. So each test below (a) names the documents and index ranges both sides read and write — the READ-SET
 * ARGUMENT that forces the second transaction to re-run and see the first — and (b) proves that the second, re-run
 * transaction does the right thing in every serial order (A then B, and B then A), plus a `Promise.all` of both.
 *
 * CT-1 concurrent `opportunities.openCase` (×2, and vs the cron's auto-open) → one claim.
 *   Both read the opportunity document (`activeClaimId`, status) and the item's `claims.by_item_type_status`
 *   range (the open-claim / overlap check); the winner inserts a claim into that range and patches the
 *   opportunity. The loser's read set is invalidated → it re-runs, sees `activeClaimId`, returns `created: false`.
 * CT-2 manual `opportunities.reevaluate` vs cron `priceWatch.recordCheck` on one item → one claim, one evaluation
 *   row per resultHash.
 *   Both read the opportunity by `(userId, dedupeKey)`, its current evaluation (the resultHash dedupe) and the item's
 *   claims range; both write the opportunity (lastEvaluatedAt / currentEvaluationId). A write to the opportunity
 *   document by the first invalidates the second's read of it → re-run → same resultHash → no second row.
 * CT-3 concurrent `ensurePurchaseTransaction` (through `opportunities.reevaluate` and `purchases.confirm`) → one row.
 *   Both read the `transactions.by_purchase` range for the purchase (`.first()`); the winner inserts into exactly
 *   that range → the loser re-runs, finds the row, returns it.
 * CT-4 credit confirmation vs `followUps.fire` → the reminder is a no-op.
 *   `fire` reads the claim's `followUps.by_claim` range and the claim; `confirmCredit` reads the claim and the
 *   same range (`cancelPending`) and writes both (status confirmed, follow-ups cancelled). Whichever commits
 *   second re-runs: a fire after the confirmation finds nothing pending; a confirmation after a fire clears
 *   `attentionAt`. Either way the confirmed claim ends with no reminder shown and none pending.
 * CT-5 activation change during approval (test registry) → `prepareSend` refuses and the refusal persists (N3).
 *   Activation is code, not a document: a deploy that withdraws a pack lands between the user's review and the send.
 *   The first `prepareSend` under the new code must re-read the registry (not a cached result), return
 *   `rule_withdrawn` (a RETURN, so its writes commit: opportunity superseded, claim version +1, a note), and the
 *   next prepare runs on the legacy path. `prepareSend` reads the claim and opportunity it patches, so two prepares
 *   racing would serialize on those documents: only one of them bumps the version.
 * CT-6 approval invalidation vs `approveAndSend` → the send refuses.
 *   `approveAndSend` reads the claim (`version`), the draft (`version`, `claimVersion`) and the claim's drafts range;
 *   an invalidation (`claims.adjustExpected`, or a corrected unit price re-evaluated as a material change) writes
 *   the claim's `version`. If the invalidation commits first the send re-runs against the new version and refuses;
 *   if the send commits first it sent exactly what was approved and the invalidation lands after. Never a send of a
 *   stale approval.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { scheduleClaimReminder } from "./followUps";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 22, 15);
const R01_ACTIVE = [{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active" as const, decision: "TEST" }];
const R01_WITHDRAWN = [...R01_ACTIVE, { ruleId: "R01.retail_price_adjustment", version: 1, status: "withdrawn" as const, decision: "TEST-W" }];

type T = ReturnType<typeof setup>;
type User = Awaited<ReturnType<typeof signedIn>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setTestActivations(R01_ACTIVE);
});
afterEach(() => {
  vi.useRealTimers();
  resetTestRegistry();
});

async function r01World(t: T, u: User, o: { withPolicy?: boolean } = {}) {
  const purchaseId = await u.as.mutation(api.purchases.create, {
    merchant: "Summit Gear", merchantDomain: "summit.example", orderRef: "ORD-CT", purchasedAt: NOW - 3 * DAY, currency: "USD", status: "active",
    items: [{ name: "Down jacket", unitCents: 12_000, qty: 1, productUrl: "https://summit.example/p/down-jacket" }],
  });
  const itemId = (await u.as.query(api.purchases.get, { purchaseId })).items[0]._id as Id<"items">;
  if (o.withPolicy !== false) {
    await t.run(async (ctx) =>
      await ctx.db.insert("policies", {
        userId: u.userId, merchantDomain: "summit.example", kind: "price_adjustment", windowDays: 14, channel: "email",
        contactEmail: "care@summit.example", passage: "If our price drops within 14 days of purchase, we refund the difference.",
        sourceUrl: "https://summit.example/price-promise", retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
      }));
  }
  return { purchaseId, itemId };
}

const observation = (itemId: Id<"items">, cents = 9_000) => ({
  itemId, sourceUrl: "https://summit.example/p/down-jacket", observedCents: cents, currency: "USD", confidence: 0.93, variantMatch: "exact" as const,
});

/** A stored accepted observation and the public "check again": an open opportunity with no case. */
async function openOpportunity(t: T, u: User) {
  const w = await r01World(t, u);
  await t.run(async (ctx) =>
    await ctx.db.insert("priceChecks", {
      itemId: w.itemId, userId: u.userId, observedCents: 9_000, currency: "USD", confidence: 0.93, variantMatch: "exact",
      observedAt: NOW - DAY, sourceUrl: "https://summit.example/p/down-jacket",
    }));
  await u.as.mutation(api.opportunities.reevaluate, { purchaseId: w.purchaseId });
  const opp = (await u.as.query(api.opportunities.forPurchase, { purchaseId: w.purchaseId })).opportunities[0].opportunity as Doc<"opportunities">;
  expect(opp.activeClaimId).toBeUndefined();
  return { ...w, opportunityId: opp._id };
}

const claimsOn = (t: T, itemId: Id<"items">) =>
  t.run(async (ctx) => await ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());

// ---------------------------------------------------------------------------

describe("CT-1 concurrent openCase → one claim", () => {
  it("two openCase calls for one opportunity (Promise.all) → one claim; the second returns it with created: false", async () => {
    const t = setup();
    const u = await signedIn(t);
    const w = await openOpportunity(t, u);
    const [r1, r2] = await Promise.all([
      u.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId }),
      u.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId }),
    ]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.claimId).toBe(r2.claimId);
    expect([r1.created, r2.created].sort()).toEqual([false, true]);
    const claims = await claimsOn(t, w.itemId);
    expect(claims).toHaveLength(1);
    expect(claims[0].expectedCents).toBe(3_000);
    const opp = await t.run(async (ctx) => await ctx.db.get(w.opportunityId));
    expect(opp?.activeClaimId).toBe(r1.claimId);
  });

  it("openCase vs the cron's auto-open (either order) → one claim", async () => {
    for (const order of ["user-first", "cron-first"] as const) {
      const t = setup();
      const u = await signedIn(t);
      const w = await openOpportunity(t, u);
      const user = () => u.as.mutation(api.opportunities.openCase, { opportunityId: w.opportunityId });
      const cron = () => t.mutation(internal.priceWatch.recordCheck, observation(w.itemId));
      if (order === "user-first") {
        await user();
        await cron();
      } else {
        await cron();
        const r = await user();
        expect(r.ok && !r.created).toBe(true);
      }
      expect(await claimsOn(t, w.itemId), order).toHaveLength(1);
    }
  });
});

describe("CT-2 manual re-evaluate vs cron recordCheck on one item → one claim, one evaluation row per resultHash", () => {
  async function evaluationsByHash(t: T, itemId: Id<"items">) {
    return await t.run(async (ctx) => {
      const opps = (await ctx.db.query("opportunities").collect()).filter((o) => o.subjectKey === `item:${itemId}`);
      const out: Record<string, number> = {};
      for (const o of opps) {
        for (const e of await ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", o._id)).collect()) {
          const k = `${o._id}:${e.resultHash}`;
          out[k] = (out[k] ?? 0) + 1;
        }
      }
      return out;
    });
  }

  it.each(["reevaluate-first", "cron-first", "promise-all"] as const)("%s", async (order) => {
    const t = setup();
    const u = await signedIn(t);
    const w = await r01World(t, u);
    const manual = () => u.as.mutation(api.opportunities.reevaluate, { purchaseId: w.purchaseId });
    const cron = () => t.mutation(internal.priceWatch.recordCheck, observation(w.itemId));
    if (order === "reevaluate-first") {
      await manual();
      await cron();
    } else if (order === "cron-first") {
      await cron();
      await manual();
    } else {
      await Promise.all([manual(), cron()]);
    }
    const claims = (await claimsOn(t, w.itemId)).filter((c) => c.type === "price_adjustment");
    expect(claims).toHaveLength(1);
    expect(claims[0].expectedCents).toBe(3_000);
    // Re-running both once more changes no result: still one row per (opportunity, resultHash).
    await manual();
    vi.setSystemTime(NOW + 60_000);
    await cron();
    const counts = await evaluationsByHash(t, w.itemId);
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
    expect((await claimsOn(t, w.itemId)).filter((c) => c.type === "price_adjustment")).toHaveLength(1);
  });

  it("two cron scrapes of the same item at once → one claim", async () => {
    const t = setup();
    const u = await signedIn(t);
    const w = await r01World(t, u);
    const results = await Promise.all([
      t.mutation(internal.priceWatch.recordCheck, observation(w.itemId)),
      t.mutation(internal.priceWatch.recordCheck, observation(w.itemId)),
    ]);
    expect(results.filter((r) => r.claimId !== null)).toHaveLength(1);
    expect((await claimsOn(t, w.itemId)).filter((c) => c.type === "price_adjustment")).toHaveLength(1);
  });
});

describe("CT-3 concurrent ensurePurchaseTransaction → one transaction row", () => {
  async function legacyPurchase(t: T, userId: Id<"users">) {
    // A pre-mission purchase (inserted as the old code did: no transaction yet).
    return await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Old Shop", merchantDomain: "old.example", purchasedAt: NOW - 10 * DAY, currency: "USD", status: "active",
      });
      await ctx.db.insert("items", { purchaseId, userId, name: "Lamp", unitCents: 5_000, qty: 1, returned: false });
      return purchaseId;
    });
  }
  const txnsFor = (t: T, purchaseId: Id<"purchases">) =>
    t.run(async (ctx) => await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).collect());

  it("two reevaluate calls at once on a legacy purchase → exactly one transaction", async () => {
    const t = setup();
    const u = await signedIn(t);
    const purchaseId = await legacyPurchase(t, u.userId);
    expect(await txnsFor(t, purchaseId)).toHaveLength(0);
    await Promise.all([
      u.as.mutation(api.opportunities.reevaluate, { purchaseId }),
      u.as.mutation(api.opportunities.reevaluate, { purchaseId }),
    ]);
    expect(await txnsFor(t, purchaseId)).toHaveLength(1);
  });

  it("purchases.confirm and reevaluate at once → exactly one transaction, and transactions.forPurchase returns it", async () => {
    const t = setup();
    const u = await signedIn(t);
    const purchaseId = await legacyPurchase(t, u.userId);
    const items = (await u.as.query(api.purchases.get, { purchaseId })).items as Doc<"items">[];
    await Promise.all([
      u.as.mutation(api.purchases.confirm, {
        purchaseId, merchant: "Old Shop", merchantDomain: "old.example", purchasedAt: NOW - 10 * DAY, currency: "USD",
        items: items.map((i) => ({ itemId: i._id, name: i.name, unitCents: i.unitCents, qty: i.qty })),
      }),
      u.as.mutation(api.opportunities.reevaluate, { purchaseId }),
    ]);
    const rows = await txnsFor(t, purchaseId);
    expect(rows).toHaveLength(1);
    expect((await u.as.query(api.transactions.forPurchase, { purchaseId }))?._id).toBe(rows[0]._id);
  });
});

describe("CT-4 credit confirmation vs followUps.fire → the reminder is a no-op", () => {
  async function claimWithReminder(t: T, u: User) {
    const purchaseId = await u.as.mutation(api.purchases.create, {
      merchant: "Harbor Books", merchantDomain: "harbor.example", orderRef: "ORD-FU", purchasedAt: NOW - 3 * DAY, currency: "USD", status: "active",
      items: [{ name: "Atlas", unitCents: 4_000, qty: 1 }],
    });
    const itemId = (await u.as.query(api.purchases.get, { purchaseId })).items[0]._id as Id<"items">;
    await u.as.mutation(api.purchases.setReturned, { itemId, returned: true });
    const claimId = await u.as.mutation(api.claims.open, { itemId });
    // The reminder the send path schedules (followUps.scheduleClaimReminder), due in 7 days.
    await t.run(async (ctx) => await scheduleClaimReminder(ctx, (await ctx.db.get(claimId))!));
    return claimId;
  }
  const state = (t: T, claimId: Id<"claims">) =>
    t.run(async (ctx) => ({
      claim: (await ctx.db.get(claimId))!,
      followUps: await ctx.db.query("followUps").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect(),
    }));

  it("confirmation first: the due reminder finds nothing pending — no attention flag, nothing fired", async () => {
    const t = setup();
    const u = await signedIn(t);
    const claimId = await claimWithReminder(t, u);
    await u.as.mutation(api.claims.confirmCredit, { claimId, cents: 4_000, evidence: "Refund posted", idempotencyKey: "full" });
    vi.setSystemTime(NOW + 8 * DAY);
    await t.mutation(internal.followUps.fire, { claimId });
    const s = await state(t, claimId);
    expect(s.claim.status).toBe("confirmed");
    expect(s.claim.attentionAt).toBeUndefined();
    expect(s.followUps.map((f) => f.status)).toEqual(["cancelled"]);
  });

  it("the reminder first (already dequeued), then the confirmation: the confirmed claim ends with no attention flag and nothing pending", async () => {
    const t = setup();
    const u = await signedIn(t);
    const claimId = await claimWithReminder(t, u);
    vi.setSystemTime(NOW + 8 * DAY);
    await t.mutation(internal.followUps.fire, { claimId });
    expect((await state(t, claimId)).claim.attentionAt).toBe(NOW + 8 * DAY);
    await u.as.mutation(api.claims.confirmCredit, { claimId, cents: 4_000, evidence: "Refund posted", idempotencyKey: "full" });
    const s = await state(t, claimId);
    expect(s.claim.status).toBe("confirmed");
    expect(s.claim.attentionAt).toBeUndefined();
    expect(s.followUps.filter((f) => f.status === "pending")).toEqual([]);
  });

  it("Promise.all of both at the due time → the same end state", async () => {
    const t = setup();
    const u = await signedIn(t);
    const claimId = await claimWithReminder(t, u);
    vi.setSystemTime(NOW + 8 * DAY);
    await Promise.all([
      u.as.mutation(api.claims.confirmCredit, { claimId, cents: 4_000, evidence: "Refund posted", idempotencyKey: "full" }),
      t.mutation(internal.followUps.fire, { claimId }),
    ]);
    const s = await state(t, claimId);
    expect(s.claim.status).toBe("confirmed");
    expect(s.claim.attentionAt).toBeUndefined();
    expect(s.followUps.filter((f) => f.status === "pending")).toEqual([]);
  });

  it("control: a partial confirmation leaves the claim open, and the reminder still fires", async () => {
    const t = setup();
    const u = await signedIn(t);
    const claimId = await claimWithReminder(t, u);
    await u.as.mutation(api.claims.confirmCredit, { claimId, cents: 1_000, evidence: "Part refund", idempotencyKey: "part" });
    vi.setSystemTime(NOW + 8 * DAY);
    await t.mutation(internal.followUps.fire, { claimId });
    const s = await state(t, claimId);
    expect(s.claim.attentionAt).toBe(NOW + 8 * DAY);
    expect(s.followUps.map((f) => f.status)).toEqual(["fired"]);
  });
});

// CT-5 and CT-6 need a sendable R01 case: an auto-opened claim, a draft, a confirmed contact and an inbox.
async function sendableCase(t: T, u: User) {
  const w = await r01World(t, u);
  const opened = await t.mutation(internal.priceWatch.recordCheck, observation(w.itemId));
  const claimId = opened.claimId!;
  expect(claimId).not.toBeNull();
  await t.run(async (ctx) => await ctx.db.insert("profiles", { userId: u.userId, inboxId: "inbox-ct", inboxEmail: "ct@inbox.example" }));
  const draftId = (await t.mutation(internal.drafts.insert, {
    claimId, userId: u.userId, to: "care@summit.example", subject: "Price adjustment", body: "Hello, please adjust the price of my jacket.",
  }))!;
  return { ...w, claimId, draftId };
}
const reviewed = { to: "care@summit.example", subject: "Price adjustment", body: "Hello, please adjust the price of my jacket." };

describe("CT-5 activation change during approval → prepareSend refuses and the refusal persists (N3)", () => {
  it("withdrawn between review and send: rule_withdrawn once (superseded, version +1, note), then the legacy path", async () => {
    const t = setup();
    const u = await signedIn(t);
    const c = await sendableCase(t, u);
    const first = await u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true });
    expect(first).toMatchObject({ ok: true });
    const before = (await t.run(async (ctx) => await ctx.db.get(c.claimId)))!;

    setTestActivations(R01_WITHDRAWN); // the deploy that withdraws R01 v1 lands here
    const refused = await u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true });
    expect(refused).toMatchObject({ ok: false, code: "rule_withdrawn" });
    const after = await t.run(async (ctx) => ({
      claim: (await ctx.db.get(c.claimId))!,
      opp: before.opportunityId ? await ctx.db.get(before.opportunityId) : null,
      notes: await ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", c.claimId)).collect(),
    }));
    // Persisted, although the mutation refused: a RETURN, not a throw.
    expect(after.opp?.status).toBe("superseded");
    expect(after.claim.version).toBe(before.version + 1);
    expect(after.notes.length).toBeGreaterThan(0);

    // The refusal sticks: the reviewed draft was bound to the withdrawn evaluation, so it stays refused (stale) and
    // nothing bumps again. A fresh draft of the same claim is reviewed on the legacy path and is sendable.
    const again = await u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true });
    expect(again).toMatchObject({ ok: false, code: "binding_changed" });
    expect((await t.run(async (ctx) => await ctx.db.get(c.claimId)))!.version).toBe(before.version + 1);
    const fresh = (await t.mutation(internal.drafts.insert, { claimId: c.claimId, userId: u.userId, ...reviewed }))!;
    const legacy = await u.as.mutation(api.drafts.prepareSend, { draftId: fresh, ...reviewed, acknowledgeUnverifiedContent: true });
    expect(legacy).toMatchObject({ ok: true });
    const claimNow = (await t.run(async (ctx) => await ctx.db.get(c.claimId)))!;
    const draftNow = (await t.run(async (ctx) => await ctx.db.get(fresh)))!;
    await u.as.mutation(api.drafts.approveAndSend, {
      draftId: fresh, ...reviewed, claimVersion: claimNow.version, draftVersion: draftNow.version, recipientConfirmed: true,
      preparedHash: legacy.ok ? legacy.preparedHash : undefined, acknowledgeUnverifiedContent: true,
    });
    expect((await t.run(async (ctx) => await ctx.db.get(fresh)))!.outboundId).toBeDefined();
  });

  it("two prepares racing after the withdrawal bump the version once", async () => {
    const t = setup();
    const u = await signedIn(t);
    const c = await sendableCase(t, u);
    const before = (await t.run(async (ctx) => await ctx.db.get(c.claimId)))!;
    setTestActivations(R01_WITHDRAWN);
    const results = await Promise.all([
      u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true }),
      u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true }),
    ]);
    expect(results.filter((r) => !r.ok && r.code === "rule_withdrawn")).toHaveLength(1);
    expect((await t.run(async (ctx) => await ctx.db.get(c.claimId)))!.version).toBe(before.version + 1);
  });
});

describe("CT-6 approval invalidation vs approveAndSend → the send refuses", () => {
  const outboundCount = (t: T, claimId: Id<"claims">) =>
    t.run(async (ctx) => (await ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect()).filter((d) => d.outboundId !== undefined).length);

  async function approved(t: T, u: User) {
    const c = await sendableCase(t, u);
    const prepared = await u.as.mutation(api.drafts.prepareSend, { draftId: c.draftId, ...reviewed, acknowledgeUnverifiedContent: true });
    expect(prepared.ok).toBe(true);
    const claim = (await t.run(async (ctx) => await ctx.db.get(c.claimId)))!;
    const draft = (await t.run(async (ctx) => await ctx.db.get(c.draftId)))!;
    const send = () =>
      u.as.mutation(api.drafts.approveAndSend, {
        draftId: c.draftId, ...reviewed, claimVersion: claim.version, draftVersion: draft.version, recipientConfirmed: true,
        preparedHash: prepared.ok ? prepared.preparedHash : undefined, acknowledgeUnverifiedContent: true,
      });
    return { ...c, send };
  }

  it("the expected amount corrected after the review → the send refuses, nothing is enqueued", async () => {
    const t = setup();
    const u = await signedIn(t);
    const c = await approved(t, u);
    await u.as.mutation(api.claims.adjustExpected, { claimId: c.claimId, expectedCents: 2_500, reason: "Store said the sale price was 9,500" });
    await expect(c.send()).rejects.toThrow();
    expect(await outboundCount(t, c.claimId)).toBe(0);
  });

  it("a corrected unit price after the review (a material change to a bound fact) → the send refuses", async () => {
    const t = setup();
    const u = await signedIn(t);
    const c = await approved(t, u);
    const items = (await u.as.query(api.purchases.get, { purchaseId: c.purchaseId })).items as Doc<"items">[];
    await u.as.mutation(api.purchases.confirm, {
      purchaseId: c.purchaseId, merchant: "Summit Gear", merchantDomain: "summit.example", purchasedAt: NOW - 3 * DAY, currency: "USD",
      items: items.map((i) => ({ itemId: i._id, name: i.name, unitCents: 11_000, qty: i.qty, productUrl: i.productUrl })),
    });
    await expect(c.send()).rejects.toThrow();
    expect(await outboundCount(t, c.claimId)).toBe(0);
  });

  it("Promise.all of the invalidation and the send: either the send refused, or it went out on the approved version", async () => {
    const t = setup();
    const u = await signedIn(t);
    const c = await approved(t, u);
    const approvedVersion = (await t.run(async (ctx) => await ctx.db.get(c.claimId)))!.version;
    const [, sent] = await Promise.allSettled([
      u.as.mutation(api.claims.adjustExpected, { claimId: c.claimId, expectedCents: 2_500, reason: "Corrected" }),
      c.send(),
    ]);
    if (sent.status === "fulfilled") {
      const draft = (await t.run(async (ctx) => await ctx.db.get(c.draftId)))!;
      expect(draft.claimVersion).toBe(approvedVersion);
      expect(await outboundCount(t, c.claimId)).toBe(1);
    } else {
      expect(await outboundCount(t, c.claimId)).toBe(0);
    }
  });
});
