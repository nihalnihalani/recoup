/// <reference types="vite/client" />
/**
 * F4 (checkpoint 4, D94): `normalizeLegacyAccounts` regression tests.
 *
 * Legacy rows are simulated the same way a pre-D67 deployment would have
 * produced them: create a real account through the live (normalizing)
 * `signIn` action, then patch the stored `authAccounts.providerAccountId`
 * and `users.email` back to an unnormalized casing directly in the DB —
 * this keeps the password hash and every other invariant genuinely real,
 * only the casing is "legacy".
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { api, internal } from "../_generated/api";
import { setup } from "../test.setup";
import { authMailTransport } from "./authMail";
import { WRONG_CREDENTIALS_MESSAGE } from "../auth";

const PASSWORD = "correct-horse-battery";

async function signIn(t: ReturnType<typeof setup>, params: Record<string, unknown>) {
  return await t.action(api.auth.signIn, { provider: "password", params });
}

/** Creates a real, verified account for `normalizedEmail`, then rewrites the
 * stored `authAccounts.providerAccountId` and `users.email` to `legacyCasing`
 * directly in the DB, simulating a row that predates D67's normalize-on-write. */
async function seedLegacyAccount(t: ReturnType<typeof setup>, normalizedEmail: string, legacyCasing: string) {
  const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
  await signIn(t, { flow: "signUp", email: normalizedEmail, password: PASSWORD });
  const code = (send.mock.calls.at(-1) as unknown as [{ code: string }])[0].code;
  await signIn(t, { flow: "email-verification", email: normalizedEmail, code });
  send.mockRestore();

  return await t.run(async (ctx) => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", normalizedEmail))
      .unique();
    if (!account) throw new Error("expected a seeded authAccounts row");
    await ctx.db.patch(account._id, { providerAccountId: legacyCasing });
    await ctx.db.patch(account.userId, { email: legacyCasing });
    return { accountId: account._id, userId: account.userId };
  });
}

describe("normalizeLegacyAccounts (T05.1 F4, D94)", () => {
  beforeAll(async () => {
    process.env.SITE_URL = "https://recoup.example";
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
    process.env.ALERTS_INBOX_ID = "inbox_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a seeded legacy `Legacy@Example.com` account cannot sign in before the migration, and can after", async () => {
    const t = setup();
    await seedLegacyAccount(t, "legacy@example.com", "Legacy@Example.com");

    // Before: the normalized lookup never finds the unnormalized row.
    await expect(signIn(t, { flow: "signIn", email: "Legacy@Example.com", password: PASSWORD })).rejects.toThrow(
      WRONG_CREDENTIALS_MESSAGE,
    );
    await expect(signIn(t, { flow: "signIn", email: "legacy@example.com", password: PASSWORD })).rejects.toThrow(
      WRONG_CREDENTIALS_MESSAGE,
    );

    const result = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(result.accountsNormalized).toBe(1);
    expect(result.usersNormalized).toBe(1);
    expect(result.collisions).toBe(0);
    expect(result.done).toBe(true);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", "legacy@example.com"))
        .unique(),
    );
    expect(row).not.toBeNull();

    // After: signs in for real (the seeded account was fully verified), from either casing.
    const signedIn = await signIn(t, { flow: "signIn", email: "Legacy@Example.com", password: PASSWORD });
    expect(signedIn.tokens).not.toBeNull();
  });

  it("is idempotent: a second run after completion touches nothing", async () => {
    const t = setup();
    await seedLegacyAccount(t, "idempotent@example.com", "Idempotent@Example.COM");

    const first = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(first.accountsNormalized).toBe(1);

    const second = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(second).toEqual({
      done: true,
      scanned: 0,
      accountsNormalized: 0,
      usersNormalized: 0,
      collisions: 0,
      unnormalizable: 0,
    });
  });

  it("normalizing an already-normalized row is a no-op (not miscounted as work)", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await signIn(t, { flow: "signUp", email: "already-fine@example.com", password: PASSWORD });
    send.mockRestore();

    const result = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(result.accountsNormalized).toBe(0);
    expect(result.usersNormalized).toBe(0);
    expect(result.scanned).toBeGreaterThanOrEqual(1);
  });

  it("refuses to merge a legacy row that would collide with an already-normalized account, and records it", async () => {
    const t = setup();
    // The already-normalized account for this mailbox.
    const sendA = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await signIn(t, { flow: "signUp", email: "dup@example.com", password: PASSWORD });
    // A distinct account (different address at signup time) whose row is
    // then rewritten, legacy-style, to collide with the one above.
    await signIn(t, { flow: "signUp", email: "dup-temp@example.com", password: PASSWORD });
    sendA.mockRestore();

    const accountId = await t.run(async (ctx) => {
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", "dup-temp@example.com"))
        .unique();
      if (!account) throw new Error("missing seeded account");
      await ctx.db.patch(account._id, { providerAccountId: "Dup@Example.com" });
      await ctx.db.patch(account.userId, { email: "Dup@Example.com" });
      return account._id;
    });

    const result = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(result.collisions).toBeGreaterThanOrEqual(1);

    // The colliding row is left exactly as it was — still unnormalized, still unreachable.
    const untouched = await t.run(async (ctx) => ctx.db.get(accountId));
    expect(untouched?.providerAccountId).toBe("Dup@Example.com");
  });

  it("N8 (D99): restart: true rescans from the start after an operator resolves a recorded collision by hand", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    // The already-normalized account that will block the other one below.
    await signIn(t, { flow: "signUp", email: "n8-dup@example.com", password: PASSWORD });
    // A distinct account, later rewritten legacy-style to collide with it.
    await signIn(t, { flow: "signUp", email: "n8-dup-temp@example.com", password: PASSWORD });
    send.mockRestore();

    const { blockerAccountId, blockerUserId, collidingAccountId } = await t.run(async (ctx) => {
      const blocker = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", "n8-dup@example.com"))
        .unique();
      const colliding = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) =>
          q.eq("provider", "password").eq("providerAccountId", "n8-dup-temp@example.com"),
        )
        .unique();
      if (!blocker || !colliding) throw new Error("missing seeded accounts");
      await ctx.db.patch(colliding._id, { providerAccountId: "N8-Dup@Example.com" });
      await ctx.db.patch(colliding.userId, { email: "N8-Dup@Example.com" });
      return { blockerAccountId: blocker._id, blockerUserId: blocker.userId, collidingAccountId: colliding._id };
    });

    // First pass: the collision is detected (both at the authAccounts level
    // and, separately, at the users level) and the row is left untouched.
    const first = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(first.done).toBe(true);
    expect(first.collisions).toBeGreaterThanOrEqual(1);
    const stillColliding = await t.run(async (ctx) => ctx.db.get(collidingAccountId));
    expect(stillColliding?.providerAccountId).toBe("N8-Dup@Example.com");

    // A bare re-run resumes from the persisted end-of-table cursor and finds
    // nothing: a normal resume can never revisit a row from an earlier page,
    // even once the collision below gets fixed.
    const bareResumeBeforeFix = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(bareResumeBeforeFix.scanned).toBe(0);
    expect(bareResumeBeforeFix.accountsNormalized).toBe(0);

    // Operator resolves the collision out of band (e.g. renames the stale
    // blocking account away) — the blocking row no longer normalizes to the
    // same address as the row that was refused.
    await t.run(async (ctx) => {
      await ctx.db.patch(blockerAccountId, { providerAccountId: "n8-dup-old@example.com" });
      await ctx.db.patch(blockerUserId, { email: "n8-dup-old@example.com" });
    });

    // Still nothing without restart: the cursor is still parked at the end.
    const bareResumeAfterFix = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(bareResumeAfterFix.scanned).toBe(0);
    expect(bareResumeAfterFix.accountsNormalized).toBe(0);

    // restart: true resets the cursor to the beginning and picks the
    // now-fixable row up.
    const restarted = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, { restart: true });
    expect(restarted.scanned).toBeGreaterThan(0);
    expect(restarted.accountsNormalized).toBeGreaterThanOrEqual(1);
    expect(restarted.usersNormalized).toBeGreaterThanOrEqual(1);
    expect(restarted.collisions).toBe(0);

    const fixed = await t.run(async (ctx) => ctx.db.get(collidingAccountId));
    expect(fixed?.providerAccountId).toBe("n8-dup@example.com");
  });

  it("is resumable via opsState: the run persists a cursor, and re-passing it explicitly is consistent with the default resume", async () => {
    const t = setup();
    await seedLegacyAccount(t, "resumable@example.com", "Resumable@Example.com");

    await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});

    const opsRow = await t.run(async (ctx) =>
      ctx.db
        .query("opsState")
        .withIndex("by_key", (q) => q.eq("key", "authMigrate"))
        .unique(),
    );
    expect(opsRow).not.toBeNull();
    expect(typeof opsRow!.cursor).toBe("string");

    // Explicitly resuming from the persisted cursor (what a manual re-run or
    // an out-of-band scheduler would pass) agrees with the default (omit
    // `cursor`, which reads the same opsState row): both see the table as
    // fully caught up.
    const explicit = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, { cursor: opsRow!.cursor });
    const implicit = await t.mutation(internal.lib.authMigrate.normalizeLegacyAccounts, {});
    expect(explicit.done).toBe(true);
    expect(explicit.scanned).toBe(0);
    expect(implicit).toEqual(explicit);
  });
});
