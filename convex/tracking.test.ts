import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

describe("tracking.overview", () => {
  it("returns an empty dashboard to a signed-out caller", async () => {
    const t = setup();
    const out = await t.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(0);
    expect(out.totals.tracked).toBe(0);
  });

  it("plots the example history oldest first with the drop against the paid price", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.examples.load, {});
    const out = await as.query(api.tracking.overview, {});
    const jacket = out.items.find((i) => i.name === "Waxed field jacket");
    expect(jacket).toBeDefined();
    expect(jacket!.points.length).toBeGreaterThan(5);
    const times = jacket!.points.map((p) => p.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(jacket!.latestCents).toBe(9500);
    expect(jacket!.dropCents).toBe(2500);
    expect(jacket!.claim?.expectedCents).toBe(2500);
    // Example money never reaches the account totals (D27).
    expect(out.totals.foundCents).toBe(0);
  });

  it("never shows one user's items to another", async () => {
    const t = setup();
    const { as: alice } = await signedIn(t, "Alice");
    const { as: bob } = await signedIn(t, "Bob");
    await alice.mutation(api.examples.load, {});
    const out = await bob.query(api.tracking.overview, {});
    expect(out.items).toHaveLength(0);
  });
});
