/// <reference types="vite/client" />
/**
 * M16: tests for the Mission 2 e2e seeders in `convex/testing.ts` (`seedR01Purchase`, `recordObservation`,
 * `seedDraft`, `seedRetrievedPolicy`, `seedInbox`, `itemsOfPurchase`, `sendTrace`, `seedTextEvidence`), the DA-A-35
 * transaction on every seeded purchase, and `resetUser`'s cleanup of the wave-1 tables, stored files and the inbox
 * profile. The gate (`E2E_SEED_ENABLED`, never the production host) applies to each new export (D202).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";
import { SYNTHETIC_PAN } from "./testing";

const ENV_KEYS = ["E2E_SEED_ENABLED", "CONVEX_SITE_URL"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.E2E_SEED_ENABLED = "true";
  process.env.CONVEX_SITE_URL = "https://adorable-lion-138.convex.site";
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 22, 15));
  setTestActivations([]);
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.useRealTimers();
  resetTestRegistry();
});

async function user(t: ReturnType<typeof setup>, email = "e2e.m16@example.com") {
  return await t.run(async (ctx) => await ctx.db.insert("users", { name: "E2E M16", email }));
}

describe("the gate applies to every new seeder", () => {
  it.each([
    ["seedR01Purchase", (t: ReturnType<typeof setup>, userId: Id<"users">) => t.mutation(internal.testing.seedR01Purchase, { userId })],
    ["seedTextEvidence", (t: ReturnType<typeof setup>, userId: Id<"users">) => t.mutation(internal.testing.seedTextEvidence, { userId })],
    ["seedRetrievedPolicy", (t: ReturnType<typeof setup>, userId: Id<"users">) => t.mutation(internal.testing.seedRetrievedPolicy, { userId, merchantDomain: "r01-x.example" })],
    ["seedInbox", (t: ReturnType<typeof setup>, userId: Id<"users">) => t.mutation(internal.testing.seedInbox, { userId })],
    ["sendTrace", (t: ReturnType<typeof setup>, userId: Id<"users">) => t.query(internal.testing.sendTrace, { userId })],
  ] as const)("%s throws when E2E_SEED_ENABLED is unset, and on the production host", async (_name, call) => {
    const t = setup();
    const userId = await user(t);
    delete process.env.E2E_SEED_ENABLED;
    await expect(call(t, userId)).rejects.toThrow(/E2E_SEED_ENABLED/);
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://cool-oyster-399.convex.site";
    await expect(call(t, userId)).rejects.toThrow(/production deployment/);
  });

  it("recordObservation, seedDraft and itemsOfPurchase refuse too, with the gate off and on the production host (D202)", async () => {
    const t = setup();
    const userId = await user(t);
    const { itemId, purchaseId } = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const { claimId } = await t.action(internal.testing.recordObservation, { itemId, observedCents: 9_500 });
    const calls = [
      () => t.action(internal.testing.recordObservation, { itemId, observedCents: 9_000 }),
      () => t.action(internal.testing.seedDraft, { claimId: claimId!, userId }),
      () => t.query(internal.testing.itemsOfPurchase, { purchaseId }),
    ];
    delete process.env.E2E_SEED_ENABLED;
    for (const call of calls) await expect(call()).rejects.toThrow(/E2E_SEED_ENABLED/);
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://cool-oyster-399.convex.site";
    for (const call of calls) await expect(call()).rejects.toThrow(/production deployment/);
    // Nothing the refused calls could have written: still no draft, one observation.
    const rows = await t.run(async (ctx) => ({
      drafts: (await ctx.db.query("drafts").collect()).length,
      checks: (await ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", itemId)).collect()).length,
    }));
    expect(rows).toEqual({ drafts: 0, checks: 1 });
  });
});

describe("seeders", () => {
  it("seedFixtures gives every purchase its transaction (DA-A-35)", async () => {
    const t = setup();
    const userId = await user(t);
    const seeded = await t.mutation(internal.testing.seedFixtures, { userId });
    const txns = await t.run(async (ctx) =>
      Promise.all([seeded.boughtPurchaseId, seeded.claimPurchaseId].map((p) => ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", p)).collect())));
    expect(txns.map((rows) => rows.length)).toEqual([1, 1]);
  });

  it("seedR01Purchase + recordObservation: the real write path opens one 5,000 claim (legacy), or a card with its case (R01 v1)", async () => {
    for (const mode of ["legacy", "v1"] as const) {
      setTestActivations(mode === "v1" ? [{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }] : []);
      const t = setup();
      const userId = await user(t);
      const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
      const txn = await t.run(async (ctx) => await ctx.db.get(seeded.transactionId));
      expect(txn?.purchaseId).toBe(seeded.purchaseId);
      const r = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
      expect(r.accepted).toBe(true);
      const claim = await t.run(async (ctx) => (r.claimId ? await ctx.db.get(r.claimId) : null));
      expect(claim?.expectedCents, mode).toBe(5_000); // (12,000 − 9,500) × 2
      const opps = await t.run(async (ctx) => await ctx.db.query("opportunities").withIndex("by_transaction", (q) => q.eq("transactionId", seeded.transactionId)).collect());
      expect(opps.length, mode).toBe(mode === "v1" ? 1 : 0);
    }
  });

  it("seedDraft writes a draft through the real drafts.insert (claim moves to drafted; legacy: nothing to bind)", async () => {
    const t = setup();
    const userId = await user(t);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const r = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
    const draftId = await t.action(internal.testing.seedDraft, { claimId: r.claimId!, userId });
    const rows = await t.run(async (ctx) => ({ draft: draftId ? await ctx.db.get(draftId) : null, claim: await ctx.db.get(r.claimId!) }));
    expect(rows.draft?.to).toBe("care@e2e-r01.example");
    expect(rows.claim?.status).toBe("drafted");
    expect(rows.draft?.binding).toBeUndefined(); // legacy mode here: an unlinked claim has no evaluation to bind to
  });

  it("seedDraft under R01 v1 binds the draft to the claim's evaluation (the drafts.insert path)", async () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const t = setup();
    const userId = await user(t);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const r = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
    const draftId = await t.action(internal.testing.seedDraft, { claimId: r.claimId!, userId });
    const draft = await t.run(async (ctx) => (draftId ? await ctx.db.get(draftId) : null));
    expect(draft?.binding?.ruleId).toBe("R01.retail_price_adjustment");
    expect(draft?.binding?.amount.amountMinor).toBe(5_000);
  });

  it("seedRetrievedPolicy writes an UNCONFIRMED snapshot through the research writer; seedInbox makes ensureInbox ready without the provider", async () => {
    const t = setup();
    const userId = await user(t);
    const policyId = await t.mutation(internal.testing.seedRetrievedPolicy, { userId, merchantDomain: "r01-x.example" });
    const policy = await t.run(async (ctx) => await ctx.db.get(policyId));
    expect(policy).toMatchObject({ merchantDomain: "r01-x.example", kind: "price_adjustment", windowDays: 14, confirmedByUser: false, contactEmail: "care@r01-x.example" });

    const inboxEmail = await t.mutation(internal.testing.seedInbox, { userId });
    expect(inboxEmail).toMatch(/@inbox\.e2e\.example$/);
    // No fetch stub: were the provider called, the key-less test env would throw "Email is not configured".
    expect(await t.withIdentity({ subject: `${userId}|session` }).action(api.profiles.ensureInbox, {})).toBe(inboxEmail);
    expect(await t.mutation(internal.testing.seedInbox, { userId })).toBe(inboxEmail); // idempotent: one profile row
    expect(await t.run(async (ctx) => (await ctx.db.query("profiles").collect()).length)).toBe(1);
  });

  it("itemsOfPurchase names the purchase's items; recordObservation records the page it is given", async () => {
    const t = setup();
    const userId = await user(t);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const items = await t.query(internal.testing.itemsOfPurchase, { purchaseId: seeded.purchaseId });
    expect(items).toEqual([{ itemId: seeded.itemId, productUrl: "https://e2e-r01.example/p/e2e-trail-runner" }]);
    await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500, sourceUrl: "https://e2e-r01.example/p/other" });
    const check = await t.run(async (ctx) => await ctx.db.query("priceChecks").withIndex("by_item", (q) => q.eq("itemId", seeded.itemId)).first());
    expect(check?.sourceUrl).toBe("https://e2e-r01.example/p/other");
  });

  it("sendTrace: a D18 refusal after prepare + acknowledgment leaves no outbound trace; a real enqueue does leave one", async () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const t = setup();
    const userId = await user(t);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const { claimId } = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
    // Not the policy's confirmed contact (care@…): D18 then needs the tick, which the browser spec never gives.
    const draftId = (await t.action(internal.testing.seedDraft, { claimId: claimId!, userId, to: "help@e2e-r01.example" }))!;
    await t.mutation(internal.testing.seedInbox, { userId });
    const as = t.withIdentity({ subject: `${userId}|session` });
    const draft = (await t.run(async (ctx) => await ctx.db.get(draftId)))!;
    const claim = (await t.run(async (ctx) => await ctx.db.get(claimId!)))!;
    const text = { draftId, to: draft.to, subject: draft.subject, body: `${draft.body} Call me on 555-010-4477.` };
    const before = await t.query(internal.testing.sendTrace, { userId });
    expect(before).toEqual({ mailLogRows: 0, drafts: 1, draftsWithOutbound: 0, draftsApproved: 0, claimsQueuedOrLater: 0 });

    // The browser's order: prepare (refused: the phone is unverified) → acknowledged prepare → approve, recipient unticked.
    const prepare = async (input: typeof text) => {
      const refused = await as.mutation(api.drafts.prepareSend, input);
      expect(refused).toMatchObject({ ok: false, code: "unverified_content", findings: ["phone 555-010-4477"] });
      // DA-B-11: the acknowledgment echoes the hash of exactly the findings shown, for exactly this text.
      const ack = { acknowledgeUnverifiedContent: true, acknowledgedFindingsHash: refused.ok ? undefined : refused.findingsHash };
      const r = await as.mutation(api.drafts.prepareSend, { ...input, ...ack });
      if (!r.ok) throw new Error(`prepare refused: ${r.code}`);
      return { ...input, ...ack, claimVersion: claim.version, draftVersion: draft.version, preparedHash: r.preparedHash };
    };
    await expect(as.mutation(api.drafts.approveAndSend, { ...(await prepare(text)), recipientConfirmed: false })).rejects.toThrow(
      /Confirm this recipient before sending/,
    );
    expect(await t.query(internal.testing.sendTrace, { userId })).toEqual(before);

    // Control: sendTrace does see a real enqueue. D18 lets an UNTICKED recipient through when it is exactly the contact
    // of a policy the user confirmed (seedR01Purchase's care@ address), which is why the browser spec never uses it.
    const toContact = { ...text, to: "care@e2e-r01.example" };
    await as.mutation(api.drafts.approveAndSend, { ...(await prepare(toContact)), recipientConfirmed: false });
    expect(await t.query(internal.testing.sendTrace, { userId })).toMatchObject({ draftsWithOutbound: 1, draftsApproved: 1, claimsQueuedOrLater: 1 });
  });

  it("seedTextEvidence stores only the masked card number, and hashes the masked text", async () => {
    const t = setup();
    const userId = await user(t);
    const { transactionId } = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const { evidenceId, storedText } = await t.mutation(internal.testing.seedTextEvidence, { userId, transactionId });
    const row = await t.run(async (ctx) => await ctx.db.get(evidenceId));
    expect(row?.text).toBe(storedText);
    expect(storedText).not.toContain(SYNTHETIC_PAN);
    expect(storedText).not.toMatch(/4111\s?1111\s?1111\s?1111/);
    expect(storedText).toContain("1111");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(storedText)));
    expect(row?.contentHash).toBe(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
    await expect(t.mutation(internal.testing.seedTextEvidence, { userId: await user(t, "other@example.com"), transactionId })).rejects.toThrow(/transaction not found/);
  });
});

describe("resetUser removes the Mission 2 rows and stored files", () => {
  it("transactions, facts, evidence (+ file), opportunities, evaluations, non-cash remedies, intake events and the inbox profile all go", async () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const t = setup();
    const email = "e2e.reset@example.com";
    const userId = await user(t, email);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const r = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
    await t.mutation(internal.testing.seedTextEvidence, { userId, transactionId: seeded.transactionId });
    await t.mutation(internal.testing.seedInbox, { userId });
    const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["%PDF-1.4 synthetic"])));
    await t.run(async (ctx) => {
      await ctx.db.insert("evidence", {
        userId, kind: "upload", docType: "receipt", sourceChannel: "upload", provenance: "user_uploaded", storageId,
        contentHash: "f".repeat(64), receivedAt: Date.now(), extractionStatus: "store_only", extractionAttempts: 0, retention: "active",
      });
      await ctx.db.insert("nonCashRemedies", {
        userId, claimId: r.claimId!, kind: "voucher", description: "E2E voucher", state: "received", idempotencyKey: "e2e", recordedAt: Date.now(),
      });
      await ctx.db.insert("processedEvents", { externalId: "e2e-evt", kind: "paste", status: "succeeded", attempts: 1, userId, route: "intake" });
    });
    const tables = ["transactions", "facts", "evidence", "opportunities", "evaluations", "nonCashRemedies", "processedEvents", "claims", "purchases", "profiles"] as const;
    const count = () =>
      t.run(async (ctx) => {
        const out: Record<string, number> = {};
        for (const table of tables) out[table] = (await ctx.db.query(table).collect()).filter((x) => (x as { userId?: Id<"users"> }).userId === userId).length;
        out._storage = (await ctx.db.system.query("_storage").collect()).length;
        return out;
      });
    const before = await count();
    expect(before.transactions).toBe(1);
    expect(before.opportunities).toBe(1);
    expect(before.evidence).toBe(2);
    expect(before._storage).toBe(1);
    expect(before.profiles).toBe(1);

    expect(await t.mutation(internal.testing.resetUser, { email })).toEqual({ deleted: true });
    const after = await count();
    for (const table of tables) expect(after[table], table).toBe(0);
    expect(after._storage).toBe(0);
  });
});
