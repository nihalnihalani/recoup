import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

describe("insights.activity", () => {
  it("is empty for a signed-out caller", async () => {
    const t = setup();
    expect(await t.query(api.insights.activity, {})).toEqual([]);
    expect(await t.query(api.insights.sources, {})).toEqual([]);
  });

  it("lists the example's price moves newest first, with signed deltas and no unchanged prices", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const feed = await as.query(api.insights.activity, {});
    expect(feed.length).toBeGreaterThan(3);
    const times = feed.map((e) => e.at);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const drops = feed.filter((e) => e.kind === "price_drop");
    expect(drops.length).toBeGreaterThan(0);
    for (const e of drops) expect(e.deltaCents!).toBeLessThan(0);
    for (const e of feed.filter((x) => x.kind === "price_rise")) expect(e.deltaCents!).toBeGreaterThan(0);
    expect(feed.some((e) => e.deltaCents === 0)).toBe(false);
    expect(feed.some((e) => e.kind === "claim_opened")).toBe(true);
  });

  it("never leaks one user's activity or sources to another", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    await alice.mutation(api.examples.load, {});
    expect(await bob.query(api.insights.activity, {})).toEqual([]);
    expect(await bob.query(api.insights.sources, {})).toEqual([]);
  });
});

describe("insights.sources", () => {
  it("counts a watched store and keeps example purchases out", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    await t.run(async (ctx) => {
      const watchId = await ctx.db.insert("watches", {
        userId,
        name: "Desk lamp",
        productUrl: "https://shop.example/p/lamp",
        merchantDomain: "shop.example",
        status: "active",
        nextCheckAt: Date.now() + 3_600_000,
      });
      const at = Date.now();
      for (const [ago, cents] of [[3, 5000], [2, 4500], [1, undefined]] as const) {
        await ctx.db.insert("watchChecks", {
          watchId,
          userId,
          observedCents: cents,
          observedAt: at - ago * 3_600_000,
          sourceUrl: "https://shop.example/p/lamp",
        });
      }
    });
    const rows = await as.query(api.insights.sources, {});
    expect(rows.map((r) => r.domain)).toEqual(["shop.example"]);
    expect(rows[0]).toMatchObject({ watching: 1, checks: 3, priced: 2, drops: 1, bestCents: 4500, bestSubject: "Desk lamp" });
  });
});
