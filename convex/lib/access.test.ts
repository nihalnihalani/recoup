/// <reference types="vite/client" />
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { setup, signedIn } from "../test.setup";
import { requireUserId } from "./access";

describe("requireUserId", () => {
  it("resolves the signed-in user's id", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    expect(await as.run(async (ctx) => await requireUserId(ctx))).toBe(userId);
  });

  it("throws when nobody is signed in", async () => {
    const t = setup();
    await expect(t.run(async (ctx) => await requireUserId(ctx))).rejects.toThrow(ConvexError);
  });

  it("refuses a tombstoned (deleting/deleted) account (D77 single choke point)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run(async (ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
    await expect(as.run(async (ctx) => await requireUserId(ctx))).rejects.toThrow(ConvexError);
  });
});
