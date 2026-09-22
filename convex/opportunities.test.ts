/// <reference types="vite/client" />
/**
 * Opportunities and cases (contract rev 5.5 §2.8) with R01 v1 FORCED ACTIVE through the test-registry seam (C3):
 * the production registry has no active pack until the lead's activation commit, so these tests prove the v1 path.
 * Expected values are written by hand from the R01 v1 rules (a 12,000 item, a 9,500 observation → 2,500 × qty).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn, twoUsers } from "./test.setup";
import { evaluatePurchase, evaluateTransaction } from "./opportunities";
import { r01LateAskAcknowledgeable } from "./lib/rules/r01_price_adjustment_v1";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { ensurePurchaseTransaction } from "./transactions";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14); // 2026-09-20T14:00Z
const PURCHASED = NOW - 2 * DAY;
const DOMAIN = "acme.example";
type T = ReturnType<typeof setup>;

afterEach(() => resetTestRegistry());

async function world(
  t: T,
  userId: Id<"users">,
  o: { unitCents?: number; qty?: number; observed?: number | null; items?: number; windowDays?: number; currency?: string; isExample?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: DOMAIN, purchasedAt: PURCHASED, currency: o.currency ?? "USD", status: "active",
      ...(o.isExample ? { isExample: true } : {}),
    });
    const itemIds: Id<"items">[] = [];
    for (let i = 0; i < (o.items ?? 1); i++) {
      const itemId = await ctx.db.insert("items", {
        purchaseId, userId, name: `Jacket ${i + 1}`, unitCents: o.unitCents ?? 12_000, qty: o.qty ?? 1,
        productUrl: `https://${DOMAIN}/p/${i}`, returned: false,
      });
      itemIds.push(itemId);
      if (o.observed !== null) {
        await ctx.db.insert("priceChecks", {
          itemId, userId, observedCents: o.observed ?? 9_500, currency: o.currency ?? "USD", confidence: 0.92,
          variantMatch: "exact", observedAt: NOW - 60_000, sourceUrl: `https://${DOMAIN}/p/${i}`,
        });
      }
    }
    const policyId = await ctx.db.insert("policies", {
      userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: o.windowDays ?? 14, channel: "email",
      contactEmail: "help@acme.example", passage: "We adjust the price within 14 days of purchase.",
      sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: PURCHASED + 60_000, confidence: 0.9, confirmedByUser: false,
    });
    const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
    return { purchaseId, itemIds, itemId: itemIds[0], policyId, transactionId };
  });
}

async function legacyClaim(t: T, userId: Id<"users">, w: { purchaseId: Id<"purchases">; itemId: Id<"items"> }, expectedCents = 2_500) {
  return await t.run((ctx) =>
    ctx.db.insert("claims", {
      purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "price_adjustment", expectedCents, status: "detected",
      token: `T${Math.random().toString(36).slice(2, 8).toUpperCase()}`, version: 1,
    }));
}

/** Runs evaluatePurchase in a transaction and returns a serializable projection (Evaluated holds the pack). */
async function evalP(t: T, purchaseId: Id<"purchases">, trigger: Parameters<typeof evaluatePurchase>[2], now: number, opts: { subjects?: string[] } = {}) {
  return await t.run(async (ctx) =>
    (await evaluatePurchase(ctx, purchaseId, trigger, now, opts)).map((e) => ({
      opportunityId: e.opportunityId, linkedClaimId: e.linkedClaimId, material: e.material, appended: e.appended, outcome: e.result.outcome,
    })));
}
async function evalT(t: T, transactionId: Id<"transactions">, trigger: Parameters<typeof evaluateTransaction>[2], now: number) {
  await t.run(async (ctx) => {
    await evaluateTransaction(ctx, transactionId, trigger, now);
  });
}

const oppsOf = (t: T, transactionId: Id<"transactions">) =>
  t.run((ctx) => ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", transactionId)).collect());
const evalsOf = (t: T, opportunityId: Id<"opportunities">) =>
  t.run((ctx) => ctx.db.query("evaluations").withIndex("by_opportunity", (q) => q.eq("opportunityId", opportunityId)).collect());
const claimsOf = (t: T, itemId: Id<"items">) =>
  t.run((ctx) => ctx.db.query("claims").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect());

describe("evaluateTransaction (R01 v1 via the test registry)", () => {
  pinClockEach(NOW);

  it("creates one opportunity per item with the R01 outcome and estimate; evaluating twice gives one evaluation row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    expect(opp).toMatchObject({
      scenarioId: "R01", remedyKey: "price_difference", subjectKey: `item:${w.itemId}`, status: "open",
      outcome: "likely_eligible", estimate: { amountMinor: 2_500, currency: "USD" }, cashClass: "cash",
      authorityClass: "merchant_promise", lossKeys: [`item:${w.itemId}:price_diff:1`],
      dedupeKey: `${w.transactionId}|R01|price_difference|item:${w.itemId}|-`,
    });
    expect(await evalsOf(t, opp._id)).toHaveLength(1);
    expect(opp.nextDeadlineAt).toBe(PURCHASED + 14 * DAY);
  });

  it("DA-A-3: a legacy open claim is LINKED, never duplicated — Potential 0, one claim", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    const claimId = await legacyClaim(t, userId, w);
    const [e] = await evalP(t, w.purchaseId, "observation", NOW, { subjects: [`item:${w.itemId}`] });
    expect(e.linkedClaimId).toBe(claimId);
    const [opp] = await oppsOf(t, w.transactionId);
    expect(opp).toMatchObject({ status: "case_open", activeClaimId: claimId });
    const claim = await t.run((ctx) => ctx.db.get(claimId));
    expect(claim).toMatchObject({
      opportunityId: opp._id, transactionId: w.transactionId, scenarioId: "R01", remedyKey: "price_difference",
      currency: "USD", lossKeys: [`item:${w.itemId}:price_diff:1`], version: 1,
    });
    expect(await claimsOf(t, w.itemId)).toHaveLength(1);
    const evals = await evalsOf(t, opp._id);
    expect(evals.map((x) => x.trigger)).toEqual(["link"]);
    const summary = await as.query(api.recovery.summary, { now: NOW });
    const usd = summary.currencies.find((c) => c.currency === "USD")!;
    expect(usd.tiles.potential.amountMinor).toBe(0);
    expect(usd.tiles.ready.amountMinor).toBe(2_500); // counted once, as the case
  });

  it("DA-A-32: an observation re-evaluates only its own item (subject-scoped)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId, { items: 3 });
    await evalP(t, w.purchaseId, "observation", NOW, { subjects: [`item:${w.itemIds[1]}`] });
    const opps = await oppsOf(t, w.transactionId);
    expect(opps.map((o) => o.subjectKey)).toEqual([`item:${w.itemIds[1]}`]);
  });

  it("DA-A-32: 30 alternating prices on an open case → no new evaluation rows (the opening observation is read, C2)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(opened.ok).toBe(true);
    const before = (await evalsOf(t, opp._id)).length;
    for (let i = 0; i < 30; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("priceChecks", {
          itemId: w.itemId, userId, observedCents: i % 2 === 0 ? 9_000 : 10_000, currency: "USD", confidence: 0.9,
          variantMatch: "exact", observedAt: NOW + i * 1000, sourceUrl: "https://acme.example/p/0",
        });
        await evaluatePurchase(ctx, w.purchaseId, "observation", NOW, { subjects: [`item:${w.itemId}`] });
      });
    }
    expect((await evalsOf(t, opp._id)).length).toBe(before);
  });

  it("DA-A-32: 30 alternating sub-threshold prices with no case → one row (outcome-bearing hash only)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId, { observed: 11_900 });
    for (let i = 0; i < 30; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("priceChecks", {
          itemId: w.itemId, userId, observedCents: i % 2 === 0 ? 11_900 : 11_850, currency: "USD", confidence: 0.9,
          variantMatch: "exact", observedAt: NOW + i * 1000, sourceUrl: "https://acme.example/p/0",
        });
        await evaluatePurchase(ctx, w.purchaseId, "observation", NOW, { subjects: [`item:${w.itemId}`] });
      });
    }
    const [opp] = await oppsOf(t, w.transactionId);
    expect(opp.outcome).toBe("not_eligible");
    expect(await evalsOf(t, opp._id)).toHaveLength(1);
  });
});

describe("materiality (§2.8 step 8; C1, C2, N3)", () => {
  pinClockEach(NOW);

  async function openCaseWorld() {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    if (!opened.ok) throw new Error(opened.message);
    const claimId = opened.claimId;
    // A draft bound to the claim's version (M13 writes these; here only claimVersion matters).
    await t.run((ctx) => ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "help@acme.example", subject: "s", body: "b" }));
    return { t, userId, as, w, opp, claimId };
  }
  const notes = (t: T, claimId: Id<"claims">) => t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());

  it("C2: 12 checks at 12 different prices on an open R01 case → 0 version bumps, 0 invalidated drafts", async () => {
    const { t, userId, w, claimId } = await openCaseWorld();
    for (let i = 0; i < 12; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("priceChecks", {
          itemId: w.itemId, userId, observedCents: 8_000 + i * 400, currency: "USD", confidence: 0.9, variantMatch: "exact",
          observedAt: NOW + i * 1000, sourceUrl: "https://acme.example/p/0",
        });
        await evaluatePurchase(ctx, w.purchaseId, "observation", NOW, { subjects: [`item:${w.itemId}`] });
      });
    }
    const claim = (await t.run((ctx) => ctx.db.get(claimId)))!;
    expect(claim.version).toBe(1);
    const draft = await t.run((ctx) => ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", claimId)).first());
    expect(draft!.claimVersion).toBe(claim.version); // the approval binding is still current
    expect(await notes(t, claimId)).toEqual([]);
  });

  it("C2: a corrected unit price on an open case → one bump and a note", async () => {
    const { t, w, claimId } = await openCaseWorld();
    await t.run(async (ctx) => {
      await ctx.db.patch(w.itemId, { unitCents: 11_800 });
      await evaluatePurchase(ctx, w.purchaseId, "fact_change", NOW, { subjects: [`item:${w.itemId}`] });
    });
    expect((await t.run((ctx) => ctx.db.get(claimId)))!.version).toBe(2);
    expect((await notes(t, claimId)).map((n) => n.text).join(" ")).toContain("facts the claim relies on changed");
  });

  it("C1: the legacy window closing on an open case is NOT material, and the late ask is acknowledgeable", async () => {
    const { t, w, claimId, opp } = await openCaseWorld();
    const late = PURCHASED + 14 * DAY + 60_000;
    await evalP(t, w.purchaseId, "user_request", late);
    const after = (await t.run((ctx) => ctx.db.get(opp._id)))!;
    expect(after.outcome).toBe("deadline_passed");
    expect((await t.run((ctx) => ctx.db.get(claimId)))!.version).toBe(1);
    const current = (await t.run((ctx) => ctx.db.get(after.currentEvaluationId!)))!;
    expect(r01LateAskAcknowledgeable(current)).toBe(true);
    expect(current.nextAction).toEqual({ kind: "continue_case", claimId });
  });

  it("N3: activate → link → deactivate → the first evaluation supersedes the opportunity and bumps the version ONCE", async () => {
    const { t, w, claimId, opp } = await openCaseWorld();
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "withdrawn", decision: "TEST" }]);
    await evalT(t, w.transactionId, "rule_version", NOW);
    await evalT(t, w.transactionId, "rule_version", NOW);
    expect((await t.run((ctx) => ctx.db.get(opp._id)))!.status).toBe("superseded");
    expect((await t.run((ctx) => ctx.db.get(claimId)))!.version).toBe(2);
    expect((await notes(t, claimId)).map((n) => n.text)).toEqual(["R01 checks were withdrawn; review and approve again."]);
  });

  it("a rule-version change on an open case is material", async () => {
    const { t, claimId, opp } = await openCaseWorld();
    await t.run(async (ctx) => {
      const current = (await ctx.db.get(opp._id))!;
      await ctx.db.patch(current.currentEvaluationId!, { ruleVersion: 0, resultHash: "stale" });
    });
    const w = (await t.run((ctx) => ctx.db.get(opp._id)))!;
    await evalT(t, w.transactionId, "rule_version", NOW);
    expect((await t.run((ctx) => ctx.db.get(claimId)))!.version).toBe(2);
  });
});

describe("openCase / dismiss / queries", () => {
  pinClockEach(NOW);

  it("opens once (idempotent), links the claim, and a foreign caller gets the identical not-found", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    const w = await world(t, owner.userId, { qty: 2 });
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const first = await owner.as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(first).toMatchObject({ ok: true, created: true });
    const again = await owner.as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(again).toMatchObject({ ok: true, created: false, claimId: first.ok ? first.claimId : null });
    const claims = await claimsOf(t, w.itemId);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ expectedCents: 5_000, status: "detected", opportunityId: opp._id, windowEndsAt: PURCHASED + 14 * DAY });
    await expect(other.as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).rejects.toThrow("Opportunity not found");
    await expect(other.as.query(api.opportunities.get, { opportunityId: opp._id })).rejects.toThrow("Opportunity not found");
    await expect(other.as.query(api.opportunities.forTransaction, { transactionId: w.transactionId })).rejects.toThrow("Transaction not found");
    await expect(other.as.mutation(api.opportunities.dismiss, { opportunityId: opp._id })).rejects.toThrow("Opportunity not found");
    await t.run(async (ctx) => {
      const ghost = await ctx.db.insert("opportunities", { ...opp, _id: undefined, _creationTime: undefined, dedupeKey: "ghost" } as never);
      await ctx.db.delete(ghost);
      await expect(owner.as.mutation(api.opportunities.openCase, { opportunityId: ghost })).rejects.toThrow("Opportunity not found");
    });
  });

  it("M03 §3.7: openCase is limited per user by the `evaluate` bucket (the 61st call in a minute is refused)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const other = await signedIn(t, "Other");
    const w = await world(t, userId, { observed: 11_900 });
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    for (let i = 0; i < 60; i++) expect((await as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).ok).toBe(false);
    await expect(as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).rejects.toThrow("Too many checks");
    // A foreign caller is refused as not-found before touching the owner's bucket.
    await expect(other.as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).rejects.toThrow("Opportunity not found");
  });

  it("refuses a non-approvable result without throwing (the evaluation is committed)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId, { observed: 11_900 });
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const r = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(r).toMatchObject({ ok: false, code: "not_approvable" });
    expect(await claimsOf(t, w.itemId)).toHaveLength(0);
  });

  it("DA-A-4: an undeclared loss-key intersection on the transaction → the second openCase is refused", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    // Another active case on the same transaction claims the same loss (e.g. a return credit carried the key).
    await t.run((ctx) => ctx.db.insert("claims", {
      purchaseId: w.purchaseId, itemId: w.itemId, userId, type: "return_credit", expectedCents: 12_000, status: "sent",
      token: "RETURN", version: 1, transactionId: w.transactionId, lossKeys: [`item:${w.itemId}:price_diff:1`],
    }));
    const r = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(r).toMatchObject({ ok: false, code: "overlap" });
    expect(r.ok ? "" : r.message).toContain("You already have an active claim for this loss via");
  });

  it("DA-A-29: the overlap guard reads only the caller's claims (a foreign related transaction is ignored, never disclosed)", async () => {
    const t = setup();
    const { owner, other } = await twoUsers(t);
    const w = await world(t, owner.userId);
    const theirs = await world(t, other.userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.transactionId, { relatedTransactionId: theirs.transactionId });
      await ctx.db.insert("claims", {
        purchaseId: theirs.purchaseId, itemId: theirs.itemId, userId: other.userId, type: "return_credit", expectedCents: 1,
        status: "sent", token: "FOREIGN", version: 1, transactionId: theirs.transactionId, lossKeys: [`item:${w.itemId}:price_diff:1`],
      });
    });
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const r = await owner.as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(r.ok).toBe(true);
    // openCase takes no relatedTransactionId: a client cannot supply one.
    await expect(owner.as.mutation(api.opportunities.openCase, { opportunityId: opp._id, relatedTransactionId: theirs.transactionId } as never)).rejects.toThrow();
  });

  it("closing: a dismissed claim reopens the opportunity; a confirmed one closes it", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    const opened = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    const claimId = opened.ok ? opened.claimId : (null as never);
    await as.mutation(api.claims.dismiss, { claimId });
    await evalP(t, w.purchaseId, "user_request", NOW);
    const reopened = (await t.run((ctx) => ctx.db.get(opp._id)))!;
    expect(reopened.status).toBe("open");
    expect(reopened.activeClaimId).toBeUndefined();
    const again = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    const claim2 = again.ok ? again.claimId : (null as never);
    await t.run((ctx) => ctx.db.patch(claim2, { status: "confirmed" }));
    await evalP(t, w.purchaseId, "user_request", NOW);
    expect((await t.run((ctx) => ctx.db.get(opp._id)))!.status).toBe("closed");
  });

  it("dismiss keeps an opportunity dismissed; examples never open claims", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const [opp] = await oppsOf(t, w.transactionId);
    await as.mutation(api.opportunities.dismiss, { opportunityId: opp._id });
    await evalP(t, w.purchaseId, "user_request", NOW);
    expect((await t.run((ctx) => ctx.db.get(opp._id)))!.status).toBe("dismissed");
    expect((await as.mutation(api.opportunities.openCase, { opportunityId: opp._id })).ok).toBe(false);

    const ex = await world(t, userId, { isExample: true });
    await evalP(t, ex.purchaseId, "user_request", NOW);
    const [exOpp] = await oppsOf(t, ex.transactionId);
    expect(exOpp.isExample).toBe(true);
    expect(await as.mutation(api.opportunities.openCase, { opportunityId: exOpp._id })).toMatchObject({ ok: false, code: "example" });
  });

  it("forPurchase/forTransaction: cards only for active packs, plus the paths not checked (no amounts)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId);
    await evalP(t, w.purchaseId, "user_request", NOW);
    const view = await as.query(api.opportunities.forPurchase, { purchaseId: w.purchaseId });
    expect(view.opportunities).toHaveLength(1);
    expect(view.opportunities[0].evaluation?.outcome).toBe("likely_eligible");
    expect(view.pathsNotChecked.map((p) => p.scenarioId)).toEqual(expect.arrayContaining(["R05", "R06", "R11"]));
    setTestActivations([]);
    const hidden = await as.query(api.opportunities.forTransaction, { transactionId: w.transactionId });
    expect(hidden.opportunities).toEqual([]); // no card without an active pack
  });
});

describe("legacy loss keys and helper edges", () => {
  pinClockEach(NOW);

  it("an archived transaction is not evaluated", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.patch(w.purchaseId, { status: "archived" });
      await ensurePurchaseTransaction(ctx, w.purchaseId);
      expect((await evaluatePurchase(ctx, w.purchaseId, "user_request", NOW)).length).toBe(0);
    });
    expect(await oppsOf(t, w.transactionId)).toEqual([]);
  });

  it("with no active pack, evaluation writes nothing (the production registry before activation)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const w = await world(t, userId);
    setTestActivations([]);
    await evalP(t, w.purchaseId, "user_request", NOW);
    expect(await oppsOf(t, w.transactionId)).toEqual([]);
  });

  it("a paid claim then a deeper drop → a new loss key n+1 and only the remainder", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const w = await world(t, userId, { qty: 2 });
    const paid = await legacyClaim(t, userId, w, 5_000);
    await t.run((ctx) => ctx.db.patch(paid, { status: "confirmed" }));
    await t.run(async (ctx) => {
      await ctx.db.insert("priceChecks", { itemId: w.itemId, userId, observedCents: 9_000, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW, sourceUrl: "https://acme.example/p/0" });
      await evaluatePurchase(ctx, w.purchaseId, "observation", NOW);
    });
    const [opp] = await oppsOf(t, w.transactionId);
    expect(opp).toMatchObject({ estimate: { amountMinor: 1_000, currency: "USD" }, lossKeys: [`item:${w.itemId}:price_diff:2`] });
    const r = await as.mutation(api.opportunities.openCase, { opportunityId: opp._id });
    expect(r.ok).toBe(true);
    const open = (await claimsOf(t, w.itemId)).filter((c: Doc<"claims">) => c.status === "detected");
    expect(open.map((c) => c.expectedCents)).toEqual([1_000]);
  });
});
