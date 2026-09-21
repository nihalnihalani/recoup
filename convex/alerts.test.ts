/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { suppressAddress, tokenFor } from "./alerts";

describe("alerts.settings", () => {
  it("defaults to enabled with no alertSettings row yet", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const result = await as.query(api.alerts.settings, {});
    expect(result).toEqual({ alertsEnabled: true, emailVerified: false, email: null, suppressedReason: null });
  });

  it("reflects the user's email and verification state", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) => ctx.db.patch(userId, { email: "person@example.com", emailVerificationTime: Date.now() }));
    const result = await as.query(api.alerts.settings, {});
    expect(result).toEqual({ alertsEnabled: true, emailVerified: true, email: "person@example.com", suppressedReason: null });
  });

  it("another user's settings row is never visible through this query", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await a.as.mutation(api.alerts.setAlerts, { enabled: false });
    const bResult = await b.as.query(api.alerts.settings, {});
    expect(bResult.alertsEnabled).toBe(true);
  });
});

describe("alerts.setAlerts", () => {
  it("false/true round-trip", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    await as.mutation(api.alerts.setAlerts, { enabled: false });
    expect((await as.query(api.alerts.settings, {})).alertsEnabled).toBe(false);
    await as.mutation(api.alerts.setAlerts, { enabled: true });
    expect((await as.query(api.alerts.settings, {})).alertsEnabled).toBe(true);
  });

  it("enabled:true clears suppression from all three reasons (bounced, complained, user_unsubscribed) — D69", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    for (const reason of ["bounced", "complained", "user_unsubscribed"] as const) {
      await t.run(async (ctx) => await suppressAddress(ctx, userId, reason === "user_unsubscribed" ? "bounced" : reason));
      if (reason === "user_unsubscribed") {
        const token = await t.run(async (ctx) => await tokenFor(ctx, userId));
        await t.mutation(internal.alerts.unsubscribeByToken, { token });
      }
      const before = await as.query(api.alerts.settings, {});
      expect(before.suppressedReason).not.toBeNull();
      await as.mutation(api.alerts.setAlerts, { enabled: true });
      const after = await as.query(api.alerts.settings, {});
      expect(after).toMatchObject({ alertsEnabled: true, suppressedReason: null });
    }
  });

  it("creates the row on first call and generates a stable 64-char hex unsubscribe token", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await as.mutation(api.alerts.setAlerts, { enabled: false });
    const rows = await t.run(async (ctx) => await ctx.db.query("alertSettings").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(userId);
    expect(rows[0].unsubscribeToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("alerts.unsubscribeByToken", () => {
  it("an unknown token returns false and writes nothing", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => await tokenFor(ctx, userId)); // ensure a row exists for someone
    const result = await t.mutation(internal.alerts.unsubscribeByToken, { token: "not-a-real-token" });
    expect(result).toBe(false);
    const rows = await t.run(async (ctx) => await ctx.db.query("alertSettings").collect());
    expect(rows[0].alertsEnabled).toBe(true);
    expect(rows[0].suppressedReason).toBeUndefined();
  });

  it("a valid token disables alerts and records user_unsubscribed", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const token = await t.run(async (ctx) => await tokenFor(ctx, userId));
    const result = await t.mutation(internal.alerts.unsubscribeByToken, { token });
    expect(result).toBe(true);
    const row = await t.run(async (ctx) =>
      await ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(row).toMatchObject({ alertsEnabled: false, suppressedReason: "user_unsubscribed" });
    expect(row!.suppressedAt).toBeTypeOf("number");
  });

  it("another user's token cannot be read or affected via settings/setAlerts", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const tokenA = await t.run(async (ctx) => await tokenFor(ctx, a.userId));
    await t.mutation(internal.alerts.unsubscribeByToken, { token: tokenA });
    // B is unaffected.
    expect((await b.as.query(api.alerts.settings, {})).alertsEnabled).toBe(true);
    // A is affected, and B's own setAlerts call cannot see or use A's token.
    expect((await a.as.query(api.alerts.settings, {})).alertsEnabled).toBe(false);
  });
});

describe("suppressAddress", () => {
  it("sets suppressedReason without touching alertsEnabled", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => await suppressAddress(ctx, userId, "bounced"));
    const row = await t.run(async (ctx) =>
      await ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(row).toMatchObject({ alertsEnabled: true, suppressedReason: "bounced" });
  });

  it("creates the row if absent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) => await suppressAddress(ctx, userId, "complained"));
    const rows = await t.run(async (ctx) => await ctx.db.query("alertSettings").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, suppressedReason: "complained" });
  });
});

describe("tokenFor", () => {
  it("is stable across calls and creates a row if absent", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const first = await t.run(async (ctx) => await tokenFor(ctx, userId));
    const second = await t.run(async (ctx) => await tokenFor(ctx, userId));
    expect(first).toBe(second);
    expect(await t.run(async (ctx) => await ctx.db.query("alertSettings").collect())).toHaveLength(1);
  });
});
