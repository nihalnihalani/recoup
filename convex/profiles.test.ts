import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

describe("profiles.save", () => {
  it("is idempotent: calling save twice for the same user yields one profile", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const first = await t.mutation(internal.profiles.save, {
      userId,
      inboxId: "i1@agentmail.to",
      inboxEmail: "i1@agentmail.to",
    });
    const second = await t.mutation(internal.profiles.save, {
      userId,
      inboxId: "i2@agentmail.to",
      inboxEmail: "i2@agentmail.to",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.profileId).toBe(first.profileId);

    const rows = await t.run((ctx) =>
      ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].inboxId).toBe("i1@agentmail.to");
  });
});

describe("profiles.me", () => {
  it("returns null user/profile when signed out instead of throwing", async () => {
    const t = setup();
    const result = await t.query(api.profiles.me, {});
    expect(result.user).toBeNull();
    expect(result.profile).toBeNull();
  });

  it("returns the caller's own profile when signed in", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "i@agentmail.to", inboxEmail: "i@agentmail.to" });
    const result = await as.query(api.profiles.me, {});
    expect(result.user?._id).toBe(userId);
    expect(result.profile?.inboxId).toBe("i@agentmail.to");
  });
});
