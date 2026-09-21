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

describe("authSignUp / authSignUpGlobal are independent named limits (N4, D99)", () => {
  it("the per-address bucket (authSignUp) refuses its 21st call for one key; a different key is unaffected", async () => {
    const t = setup();
    const key = "solo@example.com";
    for (let i = 0; i < 20; i++) {
      const status = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUp", { key }));
      expect(status.ok).toBe(true);
    }
    const refused = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUp", { key }));
    expect(refused.ok).toBe(false);

    const otherKey = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUp", { key: "other@example.com" }));
    expect(otherKey.ok).toBe(true);
  });

  it("the deployment-wide bucket (authSignUpGlobal) is untouched by per-address consumption, and vice versa", async () => {
    const t = setup();
    const key = "solo2@example.com";
    for (let i = 0; i < 20; i++) {
      await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUp", { key }));
    }
    // The per-address bucket for `key` is now exhausted (asserted above),
    // but the separate, unkeyed global bucket (200/hour token bucket) was
    // never touched by any of those calls.
    const global = await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUpGlobal", {}));
    expect(global.ok).toBe(true);

    // And the reverse: consuming the global bucket doesn't touch a fresh
    // per-address bucket.
    for (let i = 0; i < 50; i++) {
      await t.run(async (ctx) => await rateLimiter.limit(ctx, "authSignUpGlobal", {}));
    }
    const perAddress = await t.run(async (ctx) =>
      await rateLimiter.limit(ctx, "authSignUp", { key: "fresh-after-global@example.com" }),
    );
    expect(perAddress.ok).toBe(true);
  });
});
