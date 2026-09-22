/// <reference types="vite/client" />
/**
 * The optional legacy link backfill (contract §8): paged, resumable through `opsState`, idempotent, tombstone-safe.
 * Linking itself is mandatory and lazy in `evaluateTransaction` (DA-A-3); this only brings it forward.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { pinClockEach, setup, signedIn } from "./test.setup";
import { LINK_LEGACY_CURSOR_KEY, LINK_LEGACY_PAGE } from "./migrations";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";

const NOW = Date.UTC(2026, 8, 20, 14);
type T = ReturnType<typeof setup>;
afterEach(() => resetTestRegistry());

async function legacyPurchaseWithClaim(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: NOW - 86_400_000, currency: "USD", status: "active" });
    const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, productUrl: "https://acme.example/p", returned: false });
    await ctx.db.insert("priceChecks", { itemId, userId, observedCents: 9_500, currency: "USD", confidence: 0.9, variantMatch: "exact", observedAt: NOW - 1000, sourceUrl: "https://acme.example/p" });
    await ctx.db.insert("policies", { userId, merchantDomain: "acme.example", kind: "price_adjustment", windowDays: 14, channel: "email", passage: "p", sourceUrl: "https://acme.example/policy", retrievedAt: NOW - 86_400_000, confidence: 0.9, confirmedByUser: false });
    const claimId = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "sent", token: `L${Math.random().toString(36).slice(2, 7)}`, version: 1 });
    return { purchaseId, itemId, claimId };
  });
}

describe("migrations.linkLegacyPurchases", () => {
  pinClockEach(NOW);

  it("links legacy open claims (DA-A-3), creates the transaction, and is idempotent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const a = await legacyPurchaseWithClaim(t, userId);
    const r1 = await t.mutation(internal.migrations.linkLegacyPurchases, { restart: true, chain: false });
    expect(r1).toEqual({ processed: 1, done: true });
    const claim = (await t.run((ctx) => ctx.db.get(a.claimId)))!;
    expect(claim.opportunityId).toBeDefined();
    expect(claim.transactionId).toBeDefined();
    const evals1 = await t.run((ctx) => ctx.db.query("evaluations").collect());
    await t.mutation(internal.migrations.linkLegacyPurchases, { restart: true, chain: false });
    expect(await t.run((ctx) => ctx.db.query("evaluations").collect())).toHaveLength(evals1.length);
    expect(await t.run((ctx) => ctx.db.query("claims").collect())).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(a.claimId)))!.version).toBe(1); // linking is not material
  });

  it("pages through purchases with an opsState cursor and resumes where it stopped", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    for (let i = 0; i < LINK_LEGACY_PAGE + 3; i++) await legacyPurchaseWithClaim(t, userId);
    const first = await t.mutation(internal.migrations.linkLegacyPurchases, { restart: true, chain: false });
    expect(first).toEqual({ processed: LINK_LEGACY_PAGE, done: false });
    const cursor = await t.run((ctx) => ctx.db.query("opsState").withIndex("by_key", (q) => q.eq("key", LINK_LEGACY_CURSOR_KEY)).first());
    expect(cursor?.cursor).toBeDefined();
    const second = await t.mutation(internal.migrations.linkLegacyPurchases, { chain: false });
    expect(second).toEqual({ processed: 3, done: true });
    const linked = (await t.run((ctx) => ctx.db.query("claims").collect())).filter((c) => c.opportunityId !== undefined);
    expect(linked).toHaveLength(LINK_LEGACY_PAGE + 3);
  });

  it("skips tombstoned owners and does nothing while no pack is active", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const gone = await signedIn(t, "Gone");
    const a = await legacyPurchaseWithClaim(t, userId);
    const b = await legacyPurchaseWithClaim(t, gone.userId);
    await t.run((ctx) => ctx.db.insert("accountState", { userId: gone.userId, status: "deleting", requestedAt: NOW, attempts: 0 }));
    setTestActivations([]);
    await t.mutation(internal.migrations.linkLegacyPurchases, { restart: true, chain: false });
    expect((await t.run((ctx) => ctx.db.get(a.claimId)))!.opportunityId).toBeUndefined(); // no active pack → no link
    resetTestRegistry();
    await t.mutation(internal.migrations.linkLegacyPurchases, { restart: true, chain: false });
    expect((await t.run((ctx) => ctx.db.get(a.claimId)))!.opportunityId).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(b.claimId)))!.opportunityId).toBeUndefined(); // tombstoned owner untouched
  });
});
