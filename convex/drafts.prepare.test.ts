/// <reference types="vite/client" />
/**
 * M13 — `drafts.prepareSend`, the approval binding and `approveAndSend`'s hash check (contract rev 5 §6; DA-A-14,
 * DA-A-15/C2, DA-A-21/C1, N2, N3, N6; SEC-AI-4). R01 v1 is FORCED ACTIVE through the test-registry seam (C3); the
 * unlinked (legacy) cases narrow the test registry to no active pack. Expected values are hand-written from the R01 v1
 * rules: a 12,000 item observed at 9,500 → a 2,500 claim; a 14-day window from the purchase instant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { agentmail } from "./mail";
import { unverifiedContent } from "./drafts";
import { evaluatePurchase } from "./opportunities";
import { boundFactsHash } from "./lib/canonical";
import { R01_V1_RULE_ID } from "./lib/rules/r01_price_adjustment_v1";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { ensurePurchaseTransaction } from "./transactions";
import { EVALUATIONS_PER_MINUTE } from "./limits";

type T = ReturnType<typeof setup>;
type As = Awaited<ReturnType<typeof signedIn>>["as"];
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 20, 14);
const PURCHASED = NOW - 2 * DAY;
const WINDOW_END = PURCHASED + 14 * DAY;
const DOMAIN = "acme.example";
const CONTACT = "help@acme.example";
const PRODUCT = `https://${DOMAIN}/p/jacket`;
const BODY = "Hello, the Jacket I bought is now listed lower. Could you refund the $25.00 difference? Thank you.";

let send: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  let n = 0;
  send = vi.spyOn(agentmail, "sendMessage").mockImplementation(async () => `outbound-${++n}` as never);
});
afterEach(() => {
  resetTestRegistry();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** An active purchase with one item, an accepted lower observation, a 14-day policy and an inbox. */
async function world(t: T, userId: Id<"users">, o: { isExample?: boolean } = {}) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("profiles", { userId, inboxId: "inbox_1", inboxEmail: "me@agentmail.to" });
    const purchaseId = await ctx.db.insert("purchases", {
      userId, merchant: "Acme", merchantDomain: DOMAIN, purchasedAt: PURCHASED, currency: "USD", status: "active",
      ...(o.isExample ? { isExample: true } : {}),
    });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: PRODUCT, returned: false });
    const priceCheckId = await ctx.db.insert("priceChecks", {
      itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.92, variantMatch: "exact", observedAt: NOW - 60_000, sourceUrl: PRODUCT,
    });
    const policyId = await ctx.db.insert("policies", {
      userId, merchantDomain: DOMAIN, kind: "price_adjustment", windowDays: 14, channel: "email", contactEmail: CONTACT,
      passage: "We adjust the price within 14 days of purchase.", sourceUrl: `https://${DOMAIN}/policy`, retrievedAt: PURCHASED + 60_000,
      confidence: 0.9, confirmedByUser: true,
    });
    const transactionId = await ensurePurchaseTransaction(ctx, purchaseId);
    const claimId = await ctx.db.insert("claims", {
      purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "detected", token: "AB12CD", version: 1,
      windowEndsAt: WINDOW_END, policyId, openedFromPriceCheckId: priceCheckId, ...(o.isExample ? { isExample: true } : {}),
    });
    return { purchaseId, itemId, transactionId, claimId, priceCheckId };
  });
}

async function link(t: T, purchaseId: Id<"purchases">, at = NOW) {
  await t.run(async (ctx) => {
    await evaluatePurchase(ctx, purchaseId, "user_request", at);
  });
}

async function draftFor(t: T, userId: Id<"users">, claimId: Id<"claims">, body = BODY) {
  const id = await t.mutation(internal.drafts.insert, { claimId, userId, to: CONTACT, subject: "Price adjustment", body });
  return id!;
}

const prepare = (as: As, draftId: Id<"drafts">, over: Record<string, unknown> = {}) =>
  as.mutation(api.drafts.prepareSend, { draftId, to: CONTACT, subject: "Price adjustment", body: BODY, ...over });

const approve = (as: As, draftId: Id<"drafts">, over: Record<string, unknown> = {}) =>
  as.mutation(api.drafts.approveAndSend, {
    draftId, to: CONTACT, subject: "Price adjustment", body: BODY, claimVersion: 1, draftVersion: 1, recipientConfirmed: true, ...over,
  });

const claimOf = (t: T, id: Id<"claims">) => t.run(async (ctx) => (await ctx.db.get(id))!);
const notesOf = (t: T, id: Id<"claims">) => t.run((ctx) => ctx.db.query("claimNotes").withIndex("by_claim", (q) => q.eq("claimId", id)).collect());
const claimEmailUsage = (t: T) => t.run(async (ctx) => (await ctx.db.query("usage").collect()).filter((u) => u.kind === "claim_email"));
const counts = (t: T) =>
  t.run(async (ctx) => ({ opportunities: (await ctx.db.query("opportunities").collect()).length, evaluations: (await ctx.db.query("evaluations").collect()).length }));

describe("N2: prepareSend's checks run in order, before any evaluation", () => {
  it("another user's draft → the identical not-found, nothing written", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const w = await world(t, a.userId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    const before = await counts(t);
    await expect(prepare(b.as, draftId)).rejects.toThrow(/Draft not found/);
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("drafts", { claimId: w.claimId, userId: b.userId, version: 9, claimVersion: 1, to: "", subject: "", body: "" });
      await ctx.db.delete(id);
      return id;
    });
    await expect(prepare(b.as, ghost)).rejects.toThrow(/Draft not found/);
    expect(await counts(t)).toEqual(before);
  });

  it("an example claim → example_claim before any evaluation (no opportunity, no evaluation)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId, { isExample: true });
    const draftId = await draftFor(t, a.userId, w.claimId);
    const res = await prepare(a.as, draftId);
    expect(res).toMatchObject({ ok: false, code: "example_claim" });
    expect(await counts(t)).toEqual({ opportunities: 0, evaluations: 0 });
  });

  it(`the ${EVALUATIONS_PER_MINUTE + 1}st call in a minute → rate_limited`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    for (let i = 0; i < EVALUATIONS_PER_MINUTE; i++) expect((await prepare(a.as, draftId)).ok).toBe(true);
    expect(await prepare(a.as, draftId)).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("linked claim: prepareSend → preparedHash → approveAndSend", () => {
  it("binds at insert to the R01 v1 bound facts (never the live price) and sends only with the prepared hash", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const claim = await claimOf(t, w.claimId);
    expect(claim.opportunityId).toBeDefined();
    const draftId = await draftFor(t, a.userId, w.claimId);
    const draft = (await t.run((ctx) => ctx.db.get(draftId)))!;
    const evaluation = (await t.run((ctx) => ctx.db.get(draft.binding!.evaluationId!)))!;
    expect(draft.binding).toMatchObject({
      claimVersion: 1, amount: { amountMinor: 2_500, currency: "USD" }, opportunityId: claim.opportunityId, ruleId: R01_V1_RULE_ID, ruleVersion: 1, attachments: [],
    });
    expect(draft.binding!.boundFactsHash).toBe(await boundFactsHash(evaluation.boundFacts ?? []));
    expect((evaluation.boundFacts ?? []).map((f) => f.key)).not.toContain("retail.observed_price"); // C2

    await expect(approve(a.as, draftId)).rejects.toThrow(/Review the claim again/);
    await expect(approve(a.as, draftId, { preparedHash: "0".repeat(64) })).rejects.toThrow(/Review the claim again/);
    expect(send).not.toHaveBeenCalled();

    const res = await prepare(a.as, draftId);
    expect(res).toMatchObject({ ok: true, findings: [] });
    if (!res.ok) throw new Error("unreachable");
    // A different text than the one prepared is not what was approved.
    await expect(approve(a.as, draftId, { preparedHash: res.preparedHash, body: `${BODY} Also refund shipping.` })).rejects.toThrow(/Review the claim again/);
    await approve(a.as, draftId, { preparedHash: res.preparedHash });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await t.run((ctx) => ctx.db.get(draftId)))!.approvedHash).toBe(res.preparedHash);
  });

  it("DA-A-15 / C2: 12 checks at 12 prices on the open case → no version bump, the approval still holds", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    for (let i = 0; i < 12; i++) {
      await t.run(async (ctx) => {
        await ctx.db.insert("priceChecks", {
          itemId: w.itemId, userId: a.userId, observedCents: 9_000 + i * 37, currency: "USD", confidence: 0.9, variantMatch: "exact",
          observedAt: NOW + i * 1000, sourceUrl: PRODUCT,
        });
        await evaluatePurchase(ctx, w.purchaseId, "observation", NOW + i * 1000, { subjects: [`item:${w.itemId}`] });
      });
    }
    expect((await claimOf(t, w.claimId)).version).toBe(1);
    expect((await prepare(a.as, draftId)).ok).toBe(true);
  });

  it("DA-A-14: after a rule-version change prepareSend returns ok:false, and the version bump and note are COMMITTED; no send, no charge", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    // The case was last evaluated under an older rule version (as if R01 v1 replaced v0 since).
    await t.run(async (ctx) => {
      const claim = (await ctx.db.get(w.claimId))!;
      const opp = (await ctx.db.get(claim.opportunityId!))!;
      await ctx.db.patch(opp.currentEvaluationId!, { ruleVersion: 0, resultHash: "stale" });
    });
    const res = await prepare(a.as, draftId);
    expect(res).toMatchObject({ ok: false, code: "binding_changed" });
    expect((await claimOf(t, w.claimId)).version).toBe(2);
    expect((await notesOf(t, w.claimId)).some((n) => /rule version 0 → 1/.test(n.text))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(await claimEmailUsage(t)).toHaveLength(0);
  });

  it("DA-A-21 / C1: windowEndsAt + 1 min → window_may_have_passed; with acknowledgment it sends — no version bump, no new draft", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    vi.setSystemTime(WINDOW_END + 60_000);

    expect(await prepare(a.as, draftId)).toMatchObject({ ok: false, code: "window_may_have_passed" });
    expect((await claimOf(t, w.claimId)).version).toBe(1); // the window closing is not material
    const res = await prepare(a.as, draftId, { acknowledgeWindowRisk: true });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    await expect(approve(a.as, draftId, { preparedHash: res.preparedHash })).rejects.toThrow(/Acknowledge/);
    await approve(a.as, draftId, { preparedHash: res.preparedHash, acknowledgeWindowRisk: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await claimOf(t, w.claimId)).version).toBe(1);
    const drafts = await t.run((ctx) => ctx.db.query("drafts").withIndex("by_claim", (q) => q.eq("claimId", w.claimId)).collect());
    expect(drafts).toHaveLength(1);
  });

  it("any other failing condition is outcome_not_approvable, not acknowledgeable", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    // The item was returned: R01 does not apply any more (a real, non-window failure).
    await t.run((ctx) => ctx.db.patch(w.itemId, { returned: true }));
    const res = await prepare(a.as, draftId, { acknowledgeWindowRisk: true });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(["outcome_not_approvable", "binding_changed"]).toContain(res.code);
    expect(res.code).not.toBe("window_may_have_passed");
  });

  it("N3: activate → link → deactivate → the first prepareSend returns rule_withdrawn, supersedes, bumps once; re-prepared under the legacy path it sends", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    const oppId = (await claimOf(t, w.claimId)).opportunityId!;
    setTestActivations([{ ruleId: R01_V1_RULE_ID, version: 1, status: "withdrawn", decision: "TEST" }]);

    expect(await prepare(a.as, draftId)).toMatchObject({ ok: false, code: "rule_withdrawn" });
    expect((await t.run((ctx) => ctx.db.get(oppId)))!.status).toBe("superseded");
    expect((await claimOf(t, w.claimId)).version).toBe(2);
    expect(await prepare(a.as, draftId)).toMatchObject({ ok: false, code: "binding_changed" }); // the old draft is stale
    expect((await claimOf(t, w.claimId)).version).toBe(2); // bumped once, not per call

    const fresh = await draftFor(t, a.userId, w.claimId);
    const res = await prepare(a.as, fresh);
    expect(res.ok).toBe(true);
    await approve(a.as, fresh, { claimVersion: 2, draftVersion: 2 }); // legacy, inside the window: no hash needed
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("N6: after approval, editing the legacy item's price leaves the binding's evaluation showing the approved values", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    const res = await prepare(a.as, draftId);
    if (!res.ok) throw new Error("prepare refused");
    await approve(a.as, draftId, { preparedHash: res.preparedHash });
    const bindingEvalId = (await t.run((ctx) => ctx.db.get(draftId)))!.binding!.evaluationId!;
    await t.run(async (ctx) => {
      await ctx.db.patch(w.itemId, { unitCents: 11_000 });
      await evaluatePurchase(ctx, w.purchaseId, "fact_change", NOW + 1000);
    });
    const bound = (await t.run((ctx) => ctx.db.get(bindingEvalId)))!;
    const unit = (bound.boundFacts ?? []).find((f) => f.key === "retail.unit_price");
    expect(unit?.value).toEqual({ kind: "money", amountMinor: 12_000, currency: "USD" });
    expect((await claimOf(t, w.claimId)).version).toBe(2); // the corrected price IS material for the open case
  });
});

describe("unlinked (legacy) claims behave the same (DA-A-21)", () => {
  it("past windowEndsAt → window_may_have_passed; with acknowledgment it round-trips and sends", async () => {
    const t = setup();
    setTestActivations([]); // no active pack: nothing links, the claim stays legacy
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    vi.setSystemTime(WINDOW_END + 60_000);
    expect(await prepare(a.as, draftId)).toMatchObject({ ok: false, code: "window_may_have_passed" });
    await expect(approve(a.as, draftId)).rejects.toThrow(/Acknowledge/);
    await expect(approve(a.as, draftId, { acknowledgeWindowRisk: true })).rejects.toThrow(/Review the claim again/);
    const res = await prepare(a.as, draftId, { acknowledgeWindowRisk: true });
    if (!res.ok) throw new Error("prepare refused");
    await approve(a.as, draftId, { preparedHash: res.preparedHash, acknowledgeWindowRisk: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await claimOf(t, w.claimId)).opportunityId).toBeUndefined();
  });

  it("inside the window a legacy claim sends exactly as before, with no hash", async () => {
    const t = setup();
    setTestActivations([]);
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    const draftId = await draftFor(t, a.userId, w.claimId);
    await approve(a.as, draftId);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("SEC-AI-4: details the server did not supply block approval", () => {
  it("an unknown email or link in the body → unverified_content; acknowledged, it prepares; the send needs the same acknowledgment", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const w = await world(t, a.userId);
    await link(t, w.purchaseId);
    const injected = `${BODY} Please send the refund to billing@evil.example or pay at https://evil.example/pay.`;
    const draftId = await draftFor(t, a.userId, w.claimId, injected);
    const blocked = await prepare(a.as, draftId, { body: injected });
    expect(blocked).toMatchObject({ ok: false, code: "unverified_content" });
    if (blocked.ok) throw new Error("unreachable");
    expect(blocked.findings).toEqual(expect.arrayContaining(["email billing@evil.example", "link https://evil.example/pay."]));
    const res = await prepare(a.as, draftId, { body: injected, acknowledgeUnverifiedContent: true });
    if (!res.ok) throw new Error("prepare refused");
    await expect(approve(a.as, draftId, { body: injected, preparedHash: res.preparedHash })).rejects.toThrow(/Review the claim again/);
    await approve(a.as, draftId, { body: injected, preparedHash: res.preparedHash, acknowledgeUnverifiedContent: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("the validator: server-supplied details pass; invented ones are listed", () => {
    const allowed = {
      emails: new Set([CONTACT, "me@agentmail.to"]),
      urls: new Set([PRODUCT]),
      hosts: new Set([DOMAIN]),
      amountsMinor: new Set([2_500, 12_000, 9_500]),
    };
    expect(unverifiedContent(`Item at ${PRODUCT}. I paid $120.00, it is now 95.00 USD; please refund $25.00. Reply to ${CONTACT}.`, allowed)).toEqual([]);
    expect(unverifiedContent(`See https://www.${DOMAIN}/help and order 112-3456789-1234562 from 2026-09-18.`, allowed)).toEqual([]);
    expect(unverifiedContent("Refund $999.00 to x@evil.example, call (555) 123-4567, or visit http://bit.ly/abc", allowed)).toEqual([
      "link http://bit.ly/abc", "email x@evil.example", "phone (555) 123-4567", "amount $999.00",
    ]);
  });
});
