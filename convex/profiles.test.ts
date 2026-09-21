import { afterEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import { setup, signedIn } from "./test.setup";
import { inboxTransport } from "./account";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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
    // T18.5 (D124 B3): `save` now returns `null` only for a tombstoned
    // userId; this one is active, so a null here would itself be a bug.
    expect(first).not.toBeNull();
    expect(first!.created).toBe(true);

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

// ---------------------------------------------------------------------------
// T18.5 (D124 B3): the race `requireActiveUserId` alone cannot close --
// requestDeletion lands WHILE the remote createInboxRemote POST is still in
// flight (after the tombstone check passed, before `save` writes). `save`
// itself now refuses, and `ensureInbox` cleans up the now-orphaned remote
// inbox it just created.
// ---------------------------------------------------------------------------
describe("T18.5 (D124 B3): profiles.save / ensureInbox race with requestDeletion", () => {
  it("before/after: save refuses to insert a profile row for a tombstoned userId [FAILS pre-T18.5]", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    const saved = await t.mutation(internal.profiles.save, { userId, inboxId: "inbox-late", inboxEmail: "late@agentmail.to" });
    expect(saved).toBeNull();

    const rows = await t.run((ctx) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    expect(rows).toHaveLength(0);
  });

  it("save still behaves exactly as before for an active (non-tombstoned) user", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const saved = await t.mutation(internal.profiles.save, { userId, inboxId: "inbox-ok", inboxEmail: "ok@agentmail.to" });
    expect(saved).toEqual({ inboxId: "inbox-ok", inboxEmail: "ok@agentmail.to", created: true });
  });

  it("before/after: ensureInbox whose remote POST straddles requestDeletion deletes the orphaned inbox and returns null, never leaving a live profile row [FAILS pre-T18.5]", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const deleteSpy = vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);

    // The remote POST itself triggers requestDeletion mid-flight, simulating
    // the exact race: requireActiveUserId already passed, the POST is in
    // flight, and the account is torn down before `save` lands.
    const fetchSpy = vi.fn(async () => {
      await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
      return new Response(JSON.stringify({ inbox_id: "inbox-race", email: "race@agentmail.to" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = await as.action(api.profiles.ensureInbox, {});
    expect(result).toBeNull();
    expect(deleteSpy).toHaveBeenCalledWith("inbox-race");
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    // No row ever points at the orphaned "inbox-race" id -- the single-flight
    // placeholder row `claimProvisioning` left behind (T18.5 addendum,
    // F-AUD-2) is untouched by `save`'s refusal, so it may still exist, but
    // it never got `inboxId`/`inboxEmail` filled in and is left for the
    // ordinary account-deletion purge to sweep (see `save`'s own docstring).
    const rows = await t.run((ctx) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    for (const row of rows) {
      expect(row.inboxId).toBeUndefined();
      expect(row.inboxEmail).toBeUndefined();
    }
    expect(await t.run((ctx) => ctx.db.query("profiles").withIndex("by_inbox", (q) => q.eq("inboxId", "inbox-race")).unique())).toBeNull();
  });

  it("ensureInbox for a normal (non-racing) sign-up still returns the new address and never calls deleteInbox", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const deleteSpy = vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ inbox_id: "inbox-normal", email: "normal@agentmail.to" }), { status: 200 })),
    );

    const result = await as.action(api.profiles.ensureInbox, {});
    expect(result).toBe("normal@agentmail.to");
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});

describe("T18.5 (D124 LOW): profiles.me returns null for a tombstoned caller", () => {
  it("before/after: a DELETING account's still-live profile row is no longer exposed through me [FAILS pre-T18.5]", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    // Profile written directly (bypassing ensureInbox) so it still exists
    // when the tombstone lands, exactly like a purge that has not yet
    // reached the `profiles` step (its own last table).
    await t.mutation(internal.profiles.save, { userId, inboxId: "inbox-live", inboxEmail: "live@agentmail.to" });
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    expect(await as.query(api.profiles.me, {})).toBeNull();
  });

  it("an active (non-tombstoned) caller is unaffected", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.mutation(internal.profiles.save, { userId, inboxId: "inbox-live2", inboxEmail: "live2@agentmail.to" });
    expect(await as.query(api.profiles.me, {})).toEqual({ userId, inboxId: "inbox-live2", inboxEmail: "live2@agentmail.to" });
  });
});

// ---------------------------------------------------------------------------
// T18.5 addendum (F-AUD-2/D126, fresh 36-connection audit "C04 ensureInbox"):
// concurrent ensureInbox calls must be single-flight -- ported from the
// auditor's own repro (scratchpad/audit/repros/zz_audit.test.ts), adapted
// below.
//
// convex-test note (verified against its own source,
// `node_modules/convex-test/dist/index.js`'s `DatabaseFake.begin`): only a
// TOP-LEVEL `t.mutation()`/`t.query()` call takes its serializing lock --
// "Nested transactions are not isolated so if you `Promise.all` on multiple
// `ctx.runMutation` or `ctx.runQuery` calls, they won't be serialized" (the
// library's own comment; deliberate, "so actions can run mutations in
// parallel"). `ensureInbox` calls `claimProvisioning` via `ctx.runMutation`
// from inside an ACTION, so N concurrent `t.action(ensureInbox)` calls are
// exactly this unserialized-nested-call shape: this harness cannot
// guarantee the single winner a real Convex deployment's actual mutation
// atomicity would (empirically: reliable when this describe block runs
// alone, but the race window widens -- more than one call's claim can "win"
// -- once other test FILES run concurrently in the same worker and add
// their own event-loop pressure). So the properties below are checked at
// the layer that convex-test CAN deterministically prove: `claimProvisioning`
// itself is atomic under genuine concurrency (top-level calls, which DO get
// convex-test's lock -- the same guarantee real Convex gives every mutation
// regardless of caller), and the "pending" / "stale" branches behave
// correctly once a claim already exists. A true N-concurrent-ACTIONS
// integration check belongs against a live/dev deployment, not this mock.
// ---------------------------------------------------------------------------
describe("T18.5 addendum (F-AUD-2): ensureInbox provisioning is single-flight", () => {
  it("before/after: claimProvisioning itself is atomic under genuine concurrency -- of 5 simultaneous top-level calls for the same user, exactly one claims and the rest see pending [FAILS pre-addendum: function does not exist]", async () => {
    const t = setup();
    const { userId } = await signedIn(t);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => t.mutation(internal.profiles.claimProvisioning, { userId })),
    );

    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "pending")).toHaveLength(4);
    const rows = await t.run((ctx) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
    expect(rows).toHaveLength(1);
  });

  it("end to end: a single ensureInbox call provisions and returns the real address, spending exactly one inboxProvision rate-limit unit and one provider POST", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ inbox_id: "inbox_1", email: "recoup-1@agentmail.to" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await as.action(api.profiles.ensureInbox, {});
    expect(result).toBe("recoup-1@agentmail.to");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // A second call is now idempotent ("ready"): no further POST.
    const second = await as.action(api.profiles.ensureInbox, {});
    expect(second).toBe("recoup-1@agentmail.to");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a stale (>10min) placeholder is reclaimed by a later caller instead of waiting forever", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    vi.useFakeTimers();
    try {
      // A placeholder from a claimant that vanished (crashed mid-POST): old
      // provisioningAt, never filled in.
      await t.run((ctx) => ctx.db.insert("profiles", { userId, provisioningAt: Date.now() - 11 * 60_000 }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ inbox_id: "inbox-fresh", email: "fresh@agentmail.to" }), { status: 200, headers: { "content-type": "application/json" } })),
      );

      const result = await as.action(api.profiles.ensureInbox, {});
      expect(result).toBe("fresh@agentmail.to");
      const rows = await t.run((ctx) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
      expect(rows).toHaveLength(1);
      expect(rows[0]!.inboxId).toBe("inbox-fresh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh (<10min) placeholder is NOT reclaimed: a second caller waits for it and gets the same address, still exactly 1 POST", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await t.run((ctx) => ctx.db.insert("profiles", { userId, provisioningAt: Date.now() - 60_000 }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // The waiter starts polling; fill in the "winning" row directly (as the
    // real claimant's own `save` would) shortly after, well within the poll budget.
    const waiter = as.action(api.profiles.ensureInbox, {});
    await new Promise((r) => setTimeout(r, 250));
    await t.run(async (ctx) => {
      const row = await ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).unique();
      await ctx.db.patch(row!._id, { inboxId: "inbox-winner", inboxEmail: "winner@agentmail.to", provisioningAt: undefined });
    });

    const result = await waiter;
    expect(result).toBe("winner@agentmail.to");
    // The waiter never provisioned itself (no POST /inboxes) -- checked by
    // endpoint/method rather than "never called at all": an EARLIER test's
    // own `requestDeletion` schedules a real background purge this suite
    // does not drain (real timers, by design elsewhere in this file), so an
    // unrelated stray DELETE call from a previous test's cleanup can still
    // land during this one; that is a pre-existing test-isolation quirk of
    // this file, not something this assertion needs to be fooled by.
    const posts = fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === "POST");
    expect(posts).toHaveLength(0);
  }, 15_000);
});

describe("T18.6 (D129 B-3): a failed provider POST releases the provisioning claim instead of leaving it looking in-flight for the full 10-minute window", () => {
  it("POST 502 -> a direct claimProvisioning call right after sees 'claimed', not 'pending' (the placeholder was released, not left looking in-flight)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const failing = vi.fn(async () => new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", failing);

    await expect(as.action(api.profiles.ensureInbox, {})).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);

    // The inboxProvision rate-limit unit spent by THIS failed attempt is a
    // separate, deliberate guard (unaffected by releasing the claim -- see
    // ensureInbox's own docstring); what B-3 fixes is that the PLACEHOLDER
    // itself no longer looks claimed, so a fresh caller (once the rate
    // limit's own window allows it) is not ALSO forced through the ~8s
    // waitForProvisioning poll behind a claim nothing will ever finish.
    const claim = await t.mutation(internal.profiles.claimProvisioning, { userId });
    console.log("[T18.6 B-3] claim state right after a failed POST:", JSON.stringify(claim));
    expect(claim.kind).toBe("claimed");
  });

  it("end to end, once the rate-limit window allows a retry: the next ensureInbox call POSTs again and succeeds without waiting", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    const failing = vi.fn(async () => new Response("{}", { status: 502 }));
    vi.stubGlobal("fetch", failing);
    await expect(as.action(api.profiles.ensureInbox, {})).rejects.toThrow();

    // Simulate the inboxProvision window having passed (a real retry minutes
    // later), isolating THIS test to exactly what B-3 changed: the
    // placeholder's own claim state, not the separate rate limiter.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(6 * 60_000);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify({ inbox_id: "inbox-ok", email: "ok@agentmail.to" }), { status: 200, headers: { "content-type": "application/json" } })),
      );
      const started = Date.now();
      const result = await as.action(api.profiles.ensureInbox, {});
      const waited = Date.now() - started;
      console.log("[T18.6 B-3] second call after the rate-limit window passed returned:", result, "after", waited, "ms");
      expect(result).toBe("ok@agentmail.to");
      expect(waited).toBeLessThan(2000); // no ~8s waitForProvisioning poll -- it re-provisioned directly
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});

describe("T18.6 (D129 B-2): claimProvisioning refuses for a tombstoned user", () => {
  it("throws instead of inserting a placeholder profiles row for a fully-purged user", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    let done = false;
    for (let i = 0; i < 100 && !done; i++) done = (await t.mutation(internal.account.purgeStep, { userId })).done;
    expect(done).toBe(true);

    await expect(t.mutation(internal.profiles.claimProvisioning, { userId })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", userId)).collect())).toHaveLength(0);
  });
});

describe("T18.6 (D129 B-4): a compensating deleteInbox failure is logged with the orphaned inboxId before rethrowing", () => {
  it("deleteInbox 502 -> ensureInbox rejects, and a notification_failed log line names the orphaned inboxId", async () => {
    const t = setup();
    const { as } = await signedIn(t);
    vi.spyOn(inboxTransport, "deleteInbox").mockRejectedValue(new Error("AgentMail could not delete the inbox (502)"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
        return new Response(JSON.stringify({ inbox_id: "inbox-orphan", email: "orphan@agentmail.to" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    await expect(as.action(api.profiles.ensureInbox, {})).rejects.toThrow();
    const lines = errSpy.mock.calls.map((c) => c.map(String).join(" ")).filter((l) => l.includes("inbox-orphan"));
    console.log("[T18.6 B-4] log lines naming the orphan:", lines.length);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("notification_failed"))).toBe(true);
  });
});

describe("T18.6 (D129 B-5): a stale-reclaim loser deletes its OWN just-created inbox instead of the winner's (or nothing at all)", () => {
  it("ensureInbox whose own save() lands after a concurrent winner already saved returns the WINNER's address and deletes only its OWN orphaned inbox", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const del = vi.spyOn(inboxTransport, "deleteInbox").mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        // Simulates a concurrent winner (e.g. a stale-reclaim race) finishing
        // -- claiming and saving ITS OWN inbox -- while THIS call's own POST
        // to AgentMail is still in flight.
        await t.mutation(internal.profiles.save, { userId, inboxId: "inbox-winner", inboxEmail: "winner@agentmail.to" });
        return new Response(JSON.stringify({ inbox_id: "inbox-loser", email: "loser@agentmail.to" }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const result = await as.action(api.profiles.ensureInbox, {});
    console.log("[T18.6 B-5] loser ensureInbox result:", result, "deleteInbox calls:", del.mock.calls.map((c) => c[0]));
    expect(result).toBe("winner@agentmail.to");
    expect(del).toHaveBeenCalledWith("inbox-loser");
    expect(del).not.toHaveBeenCalledWith("inbox-winner");
  });
});
