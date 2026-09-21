/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { setup } from "../test.setup";
import { rateLimiter } from "./rateLimits";

describe("rateLimiter component dispatch (D51 harness)", () => {
  it("refuses the 11th authAttempt for one key within the 10-minute window", async () => {
    const t = setup();
    const key = "person@example.com";
    for (let i = 0; i < 10; i++) {
      const status = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authAttempt", { key }));
      expect(status.ok).toBe(true);
    }
    const eleventh = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authAttempt", { key }));
    expect(eleventh.ok).toBe(false);
  });

  it("keys are independent: a fresh key still has its own full bucket", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      await t.run(async (ctx) => await rateLimiter.limit(ctx, "authAttempt", { key: "a@example.com" }));
    }
    const otherKey = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authAttempt", { key: "b@example.com" }));
    expect(otherKey.ok).toBe(true);
  });
});
