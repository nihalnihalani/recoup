/// <reference types="vite/client" />
/**
 * M16: tests for the Mission 2 e2e seeders in `convex/testing.ts` (`seedR01Purchase`, `recordObservation`,
 * `seedTextEvidence`), the DA-A-35 transaction on every seeded purchase, and `resetUser`'s cleanup of the wave-1
 * tables and stored files. The gate (`E2E_SEED_ENABLED`, never the production host) applies to each new export.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { internal } from "./_generated/api";
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
  ] as const)("%s throws when E2E_SEED_ENABLED is unset, and on the production host", async (_name, call) => {
    const t = setup();
    const userId = await user(t);
    delete process.env.E2E_SEED_ENABLED;
    await expect(call(t, userId)).rejects.toThrow(/E2E_SEED_ENABLED/);
    process.env.E2E_SEED_ENABLED = "true";
    process.env.CONVEX_SITE_URL = "https://cool-oyster-399.convex.site";
    await expect(call(t, userId)).rejects.toThrow(/production deployment/);
  });

  it("recordObservation is gated too", async () => {
    const t = setup();
    const userId = await user(t);
    const { itemId } = await t.mutation(internal.testing.seedR01Purchase, { userId });
    delete process.env.E2E_SEED_ENABLED;
    await expect(t.action(internal.testing.recordObservation, { itemId, observedCents: 9_500 })).rejects.toThrow(/E2E_SEED_ENABLED/);
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
  it("transactions, facts, evidence (+ file), opportunities, evaluations, non-cash remedies and intake events all go", async () => {
    setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
    const t = setup();
    const email = "e2e.reset@example.com";
    const userId = await user(t, email);
    const seeded = await t.mutation(internal.testing.seedR01Purchase, { userId });
    const r = await t.action(internal.testing.recordObservation, { itemId: seeded.itemId, observedCents: 9_500 });
    await t.mutation(internal.testing.seedTextEvidence, { userId, transactionId: seeded.transactionId });
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
    const tables = ["transactions", "facts", "evidence", "opportunities", "evaluations", "nonCashRemedies", "processedEvents", "claims", "purchases"] as const;
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

    expect(await t.mutation(internal.testing.resetUser, { email })).toEqual({ deleted: true });
    const after = await count();
    for (const table of tables) expect(after[table], table).toBe(0);
    expect(after._storage).toBe(0);
  });
});
