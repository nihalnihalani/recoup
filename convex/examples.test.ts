import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

function hostOfEmail(email: string) {
  return email.split("@")[1];
}

function hostOfUrl(url: string) {
  return new URL(url).host;
}

describe("examples.load", () => {
  it("seeds rows owned only by the caller", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);

    const res = await as.mutation(api.examples.load, {});
    expect(res.loaded).toBe(true);
    if (!res.loaded) throw new Error("unreachable");
    expect(res.purchaseIds).toHaveLength(2);

    const purchases = await t.run(async (ctx) =>
      ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(purchases).toHaveLength(2);
    for (const p of purchases) {
      expect(p.userId).toBe(userId);
      expect(p.isExample).toBe(true);
    }

    const claims = await t.run(async (ctx) => ctx.db.query("claims").collect());
    expect(claims.length).toBeGreaterThan(0);
    for (const c of claims) {
      expect(c.userId).toBe(userId);
      expect(c.isExample).toBe(true);
    }

    const policies = await t.run(async (ctx) => ctx.db.query("policies").collect());
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p.userId).toBe(userId);
      expect(p.isExample).toBe(true);
    }
  });

  it("every recipient, contact email, and product URL points at a *.example host", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});

    const policies = await t.run(async (ctx) => ctx.db.query("policies").collect());
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      expect(p.contactEmail).toBeDefined();
      expect(hostOfEmail(p.contactEmail!)).toMatch(/\.example$/);
      expect(hostOfUrl(p.sourceUrl)).toMatch(/\.example$/);
    }

    const items = await t.run(async (ctx) => ctx.db.query("items").collect());
    const withUrl = items.filter((i) => i.productUrl);
    expect(withUrl.length).toBeGreaterThan(0);
    for (const i of withUrl) {
      expect(hostOfUrl(i.productUrl!)).toMatch(/\.example$/);
    }
  });

  it("is idempotent: a second load returns loaded:false and inserts nothing new", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );

    const second = await as.mutation(api.examples.load, {});
    expect(second).toEqual({ loaded: false });

    const after = await t.run(async (ctx) =>
      ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    expect(after).toHaveLength(before.length);
  });

  it("a second user sees none of the first user's examples", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    await alice.mutation(api.examples.load, {});

    const bobBoard = await bob.query(api.purchases.board, {});
    expect(bobBoard.purchases).toHaveLength(0);
  });

  it("remove archives every example purchase for the caller (D47: history preserved, board cleared)", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.examples.load, {});

    await as.mutation(api.examples.remove, {});

    const purchases = await t.run(async (ctx) =>
      ctx.db
        .query("purchases")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    );
    // Archived, not deleted: the rows (and their claims/ledger history) stay.
    expect(purchases).toHaveLength(2);
    expect(purchases.every((p) => p.status === "archived")).toBe(true);
    const claims = await t.run(async (ctx) => ctx.db.query("claims").collect());
    expect(claims.length).toBeGreaterThan(0);

    const board = await as.query(api.purchases.board, {});
    expect(board.purchases).toHaveLength(0);

    // The idempotency guard skips archived example purchases, so loading
    // again after a removal seeds a fresh set rather than staying blocked.
    const reloaded = await as.mutation(api.examples.load, {});
    expect(reloaded.loaded).toBe(true);
  });

  it("board totals for the caller are all zero after load: examples are excluded (D27)", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});

    const board = await as.query(api.purchases.board, {});
    expect(board.totals.owed).toBe(0);
    expect(board.totals.asked).toBe(0);
    expect(board.totals.confirmed).toBe(0);
  });
});
