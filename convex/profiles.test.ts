import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";

describe("profiles", () => {
  it("returns null for a signed-out caller instead of throwing", async () => {
    const t = setup();
    expect(await t.query(api.profiles.me, {})).toBeNull();
  });

  it("reports no inbox until one has been provisioned", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    expect(await as.query(api.profiles.me, {})).toEqual({
      userId,
      inboxId: null,
      inboxEmail: null,
    });
  });

  it("saves an inbox once and is idempotent on a second call", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);

    const first = await t.mutation(internal.profiles.save, {
      userId,
      inboxId: "inbox_1",
      inboxEmail: "recoup-abc@agentmail.to",
    });
    expect(first.created).toBe(true);

    // A concurrent ensureInbox that lost the race must not add a second row.
    const second = await t.mutation(internal.profiles.save, {
      userId,
      inboxId: "inbox_2",
      inboxEmail: "recoup-xyz@agentmail.to",
    });
    expect(second).toEqual({
      inboxId: "inbox_1",
      inboxEmail: "recoup-abc@agentmail.to",
      created: false,
    });

    const rows = await t.run(async (ctx) => await ctx.db.query("profiles").collect());
    expect(rows).toHaveLength(1);

    expect(await as.query(api.profiles.me, {})).toEqual({
      userId,
      inboxId: "inbox_1",
      inboxEmail: "recoup-abc@agentmail.to",
    });
  });

  it("resolves an inbox id back to its owner, and nothing for a stranger's inbox", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.mutation(internal.profiles.save, {
      userId,
      inboxId: "inbox_1",
      inboxEmail: "a@agentmail.to",
    });

    const found = await t.query(internal.profiles.byInbox, { inboxId: "inbox_1" });
    expect(found?.userId).toBe(userId);
    expect(await t.query(internal.profiles.byInbox, { inboxId: "inbox_nope" })).toBeNull();
  });

  it("does not leak another user's inbox through me", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await t.mutation(internal.profiles.save, {
      userId: a.userId,
      inboxId: "inbox_a",
      inboxEmail: "a@agentmail.to",
    });
    const mine = await b.as.query(api.profiles.me, {});
    expect(mine?.inboxEmail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// D115 6b-3 (checkpoint 6b F3b, ported from the reviewer's scratchpad
// da6b.test.ts): `ensureInbox` for a tombstoned account must not call out to
// AgentMail at all, let alone create a fresh, unreachable-by-purge profile
// row. Fails against the pre-T18.2 code (which resolved the caller with a
// bare `getAuthUserId`, so a deleted account got a brand new inbox
// provisioned for it) and passes once `ensureInbox` resolves through the
// tombstone-aware `requireActiveUserId` first.
// ---------------------------------------------------------------------------
describe("profiles.ensureInbox tombstone gate (D115 6b-3, checkpoint 6b F3b)", () => {
  it("provisions nothing for a tombstoned account: no fetch, no profile row", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );

    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ inbox_id: "inbox-new", email: "new@agentmail.to" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(as.action(api.profiles.ensureInbox, {})).rejects.toThrow(ConvexError);
    // The real POST /inboxes call `createInboxRemote` would have made is
    // never reached: the tombstone check throws before it.
    expect(fetchSpy).not.toHaveBeenCalled();

    const profile = await t.run(async (ctx) =>
      ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique(),
    );
    expect(profile).toBeNull();

    vi.unstubAllGlobals();
  });
});
