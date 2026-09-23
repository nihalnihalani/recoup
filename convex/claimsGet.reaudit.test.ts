/**
 * P07-W3 (re-audit): `claims.get` no longer ships the claim thread's raw inbound messages (text, html and the raw
 * webhook JSON of every message, read by an unbounded component `.collect()`, sized by the counterparty). Nothing read
 * the field; `replies` holds the classified summaries. Fails on 20a7c03 (before this change).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { api } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { REPO_ROOT } from "./testing/ruleFixtures.loader";

describe("P07-W3: claims.get is bounded and carries no raw thread messages", () => {
  it("a claim with a mail thread → no `messages` field; the response stays small", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const claimId = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", { userId, merchant: "Acme", merchantDomain: "acme.example", purchasedAt: Date.UTC(2026, 8, 1), currency: "USD", status: "active" });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Jacket", unitCents: 12_000, qty: 1, returned: false });
      return await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "price_adjustment", expectedCents: 2_500, status: "sent", token: "THRD01", version: 1, threadId: "thread-1" });
    });
    const result = await as.query(api.claims.get, { claimId });
    expect(Object.keys(result)).not.toContain("messages");
    expect(JSON.stringify(result).length).toBeLessThan(50_000);
  });

  it("claims.ts never reads the component's inbound messages (the unbounded .collect() is gone)", () => {
    const source = readFileSync(path.join(REPO_ROOT, "convex/claims.ts"), "utf8");
    expect(source).not.toContain("listInboundMessages");
  });
});
