/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { setup, signedIn } from "../test.setup";
import { alertGate, isTombstoned } from "./accountState";

const NOW = Date.UTC(2026, 8, 21, 12);

describe("isTombstoned", () => {
  it("is false for a fresh account (no accountState row)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    expect(await t.run(async (ctx) => await isTombstoned(ctx, userId))).toBe(false);
  });

  it("is true once an accountState row exists, whatever its status", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run(async (ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: NOW, attempts: 0 }),
    );
    expect(await t.run(async (ctx) => await isTombstoned(ctx, userId))).toBe(true);
  });

  it("does not confuse one user's row for another's", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await t.run(async (ctx) =>
      ctx.db.insert("accountState", { userId: a.userId, status: "deleted", requestedAt: NOW, attempts: 1 }),
    );
    expect(await t.run(async (ctx) => await isTombstoned(ctx, a.userId))).toBe(true);
    expect(await t.run(async (ctx) => await isTombstoned(ctx, b.userId))).toBe(false);
  });
});

/** Sets up a user row with the given email/verification state, an optional alertSettings row, and an optional tombstone. */
async function makeUser(
  t: ReturnType<typeof setup>,
  opts: {
    email?: string;
    verified?: boolean;
    settings?: { alertsEnabled?: boolean; suppressedAt?: number };
    tombstoned?: boolean;
  },
) {
  const { userId } = await signedIn(t);
  await t.run(async (ctx) => {
    await ctx.db.patch(userId, {
      email: opts.email,
      emailVerificationTime: opts.verified ? NOW : undefined,
    });
    if (opts.settings) {
      await ctx.db.insert("alertSettings", {
        userId,
        alertsEnabled: opts.settings.alertsEnabled ?? true,
        unsubscribeToken: "tok",
        suppressedAt: opts.settings.suppressedAt,
        updatedAt: NOW,
      });
    }
    if (opts.tombstoned) {
      await ctx.db.insert("accountState", { userId, status: "deleted", requestedAt: NOW, attempts: 0 });
    }
  });
  return userId;
}

describe("alertGate precedence (deleted -> no_email -> unverified -> opted_out -> address_suppressed)", () => {
  it("deleted wins over every other reason", async () => {
    const t = setup();
    // No email, unverified, opted out, suppressed — AND tombstoned. Deleted must win.
    const userId = await makeUser(t, {
      email: undefined,
      verified: false,
      settings: { alertsEnabled: false, suppressedAt: NOW },
      tombstoned: true,
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toMatchObject({ ok: false, reason: "deleted" });
  });

  it("no_email wins over unverified/opted_out/address_suppressed", async () => {
    const t = setup();
    const userId = await makeUser(t, {
      email: undefined,
      verified: false,
      settings: { alertsEnabled: false, suppressedAt: NOW },
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toMatchObject({ ok: false, reason: "no_email" });
  });

  it("unverified wins over opted_out/address_suppressed", async () => {
    const t = setup();
    const userId = await makeUser(t, {
      email: "person@example.com",
      verified: false,
      settings: { alertsEnabled: false, suppressedAt: NOW },
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toMatchObject({ ok: false, reason: "unverified" });
  });

  it("opted_out wins over address_suppressed", async () => {
    const t = setup();
    const userId = await makeUser(t, {
      email: "person@example.com",
      verified: true,
      settings: { alertsEnabled: false, suppressedAt: NOW },
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toMatchObject({ ok: false, reason: "opted_out" });
  });

  it("address_suppressed is refused when nothing earlier applies", async () => {
    const t = setup();
    const userId = await makeUser(t, {
      email: "person@example.com",
      verified: true,
      settings: { alertsEnabled: true, suppressedAt: NOW },
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toMatchObject({ ok: false, reason: "address_suppressed" });
  });

  it("ok:true returns the trimmed email when every gate passes", async () => {
    const t = setup();
    const userId = await makeUser(t, {
      email: "person@example.com",
      verified: true,
      settings: { alertsEnabled: true },
    });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toEqual({ ok: true, to: "person@example.com" });
  });

  it("ok:true even with no alertSettings row at all (defaults to enabled, not suppressed)", async () => {
    const t = setup();
    const userId = await makeUser(t, { email: "person@example.com", verified: true });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result).toEqual({ ok: true, to: "person@example.com" });
  });

  it("every refusal carries a fixed, non-empty user-facing message", async () => {
    const t = setup();
    const userId = await makeUser(t, { email: undefined, verified: false });
    const result = await t.run(async (ctx) => await alertGate(ctx, userId));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeGreaterThan(0);
  });
});
