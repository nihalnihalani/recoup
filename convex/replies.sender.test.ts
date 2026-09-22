/// <reference types="vite/client" />
/**
 * M13 — S-M03-6 (security baseline, repro A.6 inverted): a reply whose `From` has no parseable address is not the
 * merchant. Before: `sameParty(null, x)` was true, so it was recorded with `senderMismatch: false`.
 */
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { sameParty } from "./replies";

describe("S-M03-6: an unparseable sender is unverified", () => {
  it("A.6 inverted: an address-less From is recorded as senderMismatch (sender unverified)", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "A");
    const claimId = await t.run(async (ctx) => {
      const purchaseId = await ctx.db.insert("purchases", {
        userId, merchant: "Acme", merchantDomain: "acme.example", orderRef: "AC-1", purchasedAt: Date.UTC(2026, 0, 2), currency: "USD", status: "active",
      });
      const itemId = await ctx.db.insert("items", { purchaseId, userId, name: "Scarf", unitCents: 4000, qty: 1, returned: true, returnedAt: Date.UTC(2026, 0, 9) });
      const id = await ctx.db.insert("claims", { purchaseId, itemId, userId, type: "return_credit", expectedCents: 4000, status: "sent", token: "AB12CD", version: 1 });
      await ctx.db.insert("drafts", { claimId: id, userId, version: 1, claimVersion: 1, to: "support@acme.example", subject: "s", body: "b", approvedAt: Date.now() });
      return id;
    });
    const res = await t.mutation(internal.replies.apply, {
      claimId, messageId: "<m1@x>", from: "Refund Team", classification: "other", summary: "Hello",
    });
    const reply = await t.run((ctx) => ctx.db.get(res.replyId!));
    expect(reply?.senderMismatch).toBe(true); // before: false
  });

  it("sameParty: either side unknown → not the same party; matching or sub-domains → same", () => {
    expect(sameParty(null, "acme.example")).toBe(false);
    expect(sameParty("acme.example", null)).toBe(false);
    expect(sameParty(null, null)).toBe(false);
    expect(sameParty("mail.acme.example", "acme.example")).toBe(true);
    expect(sameParty("acme.example", "acme.example")).toBe(true);
    expect(sameParty("evil.example", "acme.example")).toBe(false);
  });
});
