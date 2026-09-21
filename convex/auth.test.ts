/// <reference types="vite/client" />
/**
 * T09 — independent acceptance suite for P01 (T05's guarded Password
 * provider, `./auth.ts`), written from the acceptance bullets in
 * `docs/prompts/recoup-opus-sonnet-agent-team.md` (P01) and the contract at
 * `docs/team/contracts/2026-09-21-T01-T05-T06.md`, not from T05's own
 * `convex/authFlow.test.ts`. That file's env/JWT bootstrap (`beforeAll`
 * below) is copied verbatim per the task brief; none of its assertions are
 * imported or reused — every scenario here is derived from the acceptance
 * checklist and independently re-derived against the installed
 * `@convex-dev/auth`/`lucia` sources (see per-test comments).
 *
 * Scope (per task assignment): duplicate/expired/wrong-provider codes,
 * re-verification, the D66 pre-change-account migration, reset
 * enumeration-safety, the three rate limits (per-address auth mail,
 * per-email auth attempts, the deployment-wide auth-mail cap), and email
 * normalization on every write path that touches `users.email`.
 *
 * A requirement that does not hold against the current code stays as
 * `it.fails` with a `// FINDING:` comment naming the file:line — none were
 * found for this file's scope.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { Scrypt } from "lucia";
import { isRateLimitError } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup } from "./test.setup";
import { authMailTransport } from "./lib/authMail";
import { rateLimiter } from "./lib/rateLimits";
import { VERIFICATION_CODE_TTL_S } from "./limits";
import { ACCOUNT_EXISTS_MESSAGE, INVALID_CODE_MESSAGE, WRONG_CREDENTIALS_MESSAGE } from "./auth";

const PASSWORD = "correct-horse-battery";

type SendCall = { to: string; kind: "verify" | "reset"; code: string; expiresInMinutes: number };
type SendSpy = { mock: { calls: unknown[][] } };

function lastCode(spy: SendSpy): string {
  const calls = spy.mock.calls as unknown as [SendCall][];
  const call = calls.at(-1);
  if (!call) throw new Error("authMailTransport.send was never called");
  return call[0].code;
}

async function signIn(t: ReturnType<typeof setup>, params: Record<string, unknown>) {
  return await t.action(api.auth.signIn, { provider: "password", params });
}

/**
 * Directly constructs an account in the shape it would have had before T05
 * shipped: a `users` row with `email` set and no `emailVerificationTime`,
 * and an `authAccounts` row with a real password hash but no `emailVerified`
 * stamp. `createAccount`/`Password.ts`'s own `crypto.hashSecret` is `new
 * Scrypt().hash(password)` (verified by reading
 * `node_modules/@convex-dev/auth/src/providers/Password.ts`), so hashing the
 * same way here makes the row indistinguishable, at the credential-check
 * layer, from a row `createAccount` produced before email verification
 * existed. `retrieveAccountWithCredentialsImpl` looks the row up purely by
 * the `providerAndAccountId` index and verifies `secret` with the same
 * `Scrypt` class, so no other field is required to make signIn succeed.
 */
async function legacyAccount(
  t: ReturnType<typeof setup>,
  email: string,
  password: string,
): Promise<{ userId: Id<"users"> }> {
  const secret = await new Scrypt().hash(password);
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret,
    });
    return { userId };
  });
}

describe("T09 acceptance — guarded Password provider (P01)", () => {
  // Copied from convex/authFlow.test.ts's own beforeAll (task brief: "copy
  // the env setup"). `@convex-dev/auth` requires SITE_URL on every code send
  // (redirects.ts) and CONVEX_SITE_URL + JWT_PRIVATE_KEY to mint a session
  // JWT once a sign-in actually succeeds (tokens.ts).
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

  describe("codes", () => {
    it("a code cannot be used twice — the second use is rejected the same way a wrong code is (duplicate code use fails)", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "dup-code@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      const code = lastCode(send);

      const first = await signIn(t, { flow: "email-verification", email, code });
      expect(first.tokens).not.toBeNull();

      // Re-submitting the same code: the library deletes a verification code
      // on successful use (createVerificationCode.ts / verifyCodeAndSignIn.ts),
      // so the second attempt cannot find it and must fail the same way an
      // invalid code does — not silently re-authorize, and not crash.
      await expect(signIn(t, { flow: "email-verification", email, code })).rejects.toThrow(INVALID_CODE_MESSAGE);
    });

    it("a code presented after VERIFICATION_CODE_TTL_S has elapsed is rejected (expired code fails)", async () => {
      vi.useFakeTimers();
      try {
        const t = setup();
        const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
        const email = "expired-code@example.com";
        await signIn(t, { flow: "signUp", email, password: PASSWORD });
        const code = lastCode(send);

        vi.advanceTimersByTime((VERIFICATION_CODE_TTL_S + 1) * 1000);

        await expect(signIn(t, { flow: "email-verification", email, code })).rejects.toThrow(INVALID_CODE_MESSAGE);

        // And the account is still unverified — the expired attempt granted nothing.
        const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
        expect(users).toHaveLength(1);
        expect(users[0]!.emailVerificationTime).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a reset code cannot be redeemed as an email-verification code (wrong-provider code fails)", async () => {
      // D65 settled question 1 / contract note: `recoup-verify` and
      // `recoup-reset` are distinct provider ids specifically so a code
      // minted by one can never authorize the other
      // (verifyCodeAndSignIn.ts checks `verificationCode.provider ===
      // methodProviderId`).
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "cross-provider@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      send.mockClear();

      await signIn(t, { flow: "reset", email });
      const resetCode = lastCode(send);
      expect(send.mock.calls.at(-1)![0]).toMatchObject({ kind: "reset" });

      await expect(
        signIn(t, { flow: "email-verification", email, code: resetCode }),
      ).rejects.toThrow(INVALID_CODE_MESSAGE);
    });

    it("a verify code cannot be redeemed as a reset code (wrong-provider code fails, the other direction)", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "cross-provider-2@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      const verifyCode = lastCode(send);

      await expect(
        signIn(t, { flow: "reset-verification", email, code: verifyCode, newPassword: "brand-new-password-1" }),
      ).rejects.toThrow(INVALID_CODE_MESSAGE);
    });

    it("after a wrong attempt, requesting a new code invalidates the old one and the new code signs in (re-verification after a new code works)", async () => {
      // The library keeps at most one pending code per account
      // (`generateUniqueVerificationCode` deletes any existing code before
      // inserting the new one), so this also proves the old code is not
      // merely "one of several valid codes" but is actually gone.
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "reverify@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      const staleCode = lastCode(send);

      await expect(signIn(t, { flow: "email-verification", email, code: "00000000" })).rejects.toThrow(
        INVALID_CODE_MESSAGE,
      );

      // D66: signing in again while unverified (correct password) mints a fresh code.
      const resendResult = await signIn(t, { flow: "signIn", email, password: PASSWORD });
      expect(resendResult.tokens).toBeNull();
      const freshCode = lastCode(send);
      expect(freshCode).not.toBe(staleCode);

      // The stale code from the first send no longer works.
      await expect(signIn(t, { flow: "email-verification", email, code: staleCode })).rejects.toThrow(
        INVALID_CODE_MESSAGE,
      );

      // The fresh code does, and sets emailVerificationTime.
      const verified = await signIn(t, { flow: "email-verification", email, code: freshCode });
      expect(verified.tokens).not.toBeNull();
      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(typeof users[0]!.emailVerificationTime).toBe("number");
    });
  });

  describe("D66 migration: pre-existing accounts", () => {
    it("an account created before email verification existed must verify at next sign-in and gets no session until then", async () => {
      const email = "legacy-user@example.com";
      const t = setup();
      await legacyAccount(t, email, PASSWORD);
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);

      // Correct credentials against a real (pre-existing) account, but the
      // library's own `config.verify && !account.emailVerified` tail sends a
      // code instead of a session (Password.ts).
      const first = await signIn(t, { flow: "signIn", email, password: PASSWORD });
      expect(first.tokens).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ to: email, kind: "verify" });

      const usersMidway = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(usersMidway).toHaveLength(1);
      expect(usersMidway[0]!.emailVerificationTime).toBeUndefined();

      // Wrong password on the same legacy account still fails normally —
      // the migration path does not bypass credential checking.
      await expect(signIn(t, { flow: "signIn", email, password: "not-the-password" })).rejects.toThrow(
        WRONG_CREDENTIALS_MESSAGE,
      );

      const code = lastCode(send);
      const verified = await signIn(t, { flow: "email-verification", email, code });
      expect(verified.tokens).not.toBeNull();
      const usersFinal = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(usersFinal).toHaveLength(1);
      expect(typeof usersFinal[0]!.emailVerificationTime).toBe("number");
    });
  });

  describe("reset enumeration-safety", () => {
    it("reset for an unknown address returns exactly what a known address's reset returns, and only the known address is mailed", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const known = "reset-known-2@example.com";
      await signIn(t, { flow: "signUp", email: known, password: PASSWORD });
      send.mockClear();

      const knownResult = await signIn(t, { flow: "reset", email: known });
      const unknownResult = await signIn(t, { flow: "reset", email: "never-registered-2@example.com" });

      expect(knownResult).toEqual(unknownResult);
      expect(knownResult.tokens).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ to: known, kind: "reset" });
    });

    it("a known address's reset is refused the same RateLimited way once its own per-address cap is spent", async () => {
      // Complements the identical-response test above: once the SAME
      // address's `authMailPerEmail` bucket is spent (3/hour, shared
      // between verify and reset sends to that address), a further reset
      // fails closed like any other capped send rather than silently
      // starting a flow it cannot deliver on.
      const t = setup();
      const known = "reset-throttled-known@example.com";
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      // signUp already sends one verify code, which counts against the same
      // per-address bucket a reset send draws from — so only 2 more sends
      // are needed to reach the 3/hour cap, not 3.
      await signIn(t, { flow: "signUp", email: known, password: PASSWORD });
      expect(send).toHaveBeenCalledTimes(1);
      await signIn(t, { flow: "reset", email: known });
      await signIn(t, { flow: "reset", email: known });
      expect(send.mock.calls.filter((c) => (c[0] as SendCall).to === known)).toHaveLength(3);

      let caught: unknown;
      try {
        await signIn(t, { flow: "reset", email: known });
      } catch (err) {
        caught = err;
      }
      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authMailPerEmail");
    });
  });

  describe("rate limits", () => {
    it("the 4th auth mail to one address within an hour is refused, distinctly from a credentials error", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "capped-address@example.com";

      await signIn(t, { flow: "signUp", email, password: PASSWORD }); // 1
      await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 2 (still unverified -> resend)
      await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 3
      expect(send).toHaveBeenCalledTimes(3);

      let caught: unknown;
      try {
        await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 4th
      } catch (err) {
        caught = err;
      }
      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authMailPerEmail");
      expect(send).toHaveBeenCalledTimes(3);

      // A 5th attempt is refused the same way; the cap does not silently reopen.
      await expect(signIn(t, { flow: "signIn", email, password: PASSWORD })).rejects.toThrow();
      expect(send).toHaveBeenCalledTimes(3);
    });

    it("the 11th sign-in attempt for one email within 10 minutes is refused before the provider runs at all", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "attempt-capped-2@example.com";

      for (let i = 0; i < 10; i++) {
        await expect(signIn(t, { flow: "signIn", email, password: "wrong" })).rejects.toThrow(
          WRONG_CREDENTIALS_MESSAGE,
        );
      }
      // Proof the account genuinely does not exist yet and every one of the
      // 10 rejections above was the credentials check, not something else.
      const usersBefore = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(usersBefore).toHaveLength(0);

      let eleventh: unknown;
      try {
        await signIn(t, { flow: "signIn", email, password: "wrong" });
      } catch (err) {
        eleventh = err;
      }
      expect(isRateLimitError(eleventh)).toBe(true);
      expect((eleventh as ConvexError<{ name: string }>).data.name).toBe("authAttempt");
      // "before the provider runs": no account was created and no mail sent,
      // proving retrieveAccount/createAccount never ran on the 11th call.
      expect(send).not.toHaveBeenCalled();
      const usersAfter = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(usersAfter).toHaveLength(0);
    });

    it("the deployment-wide auth-mail cap fails closed for every address once exhausted, not just the one that used it up", async () => {
      // Sending 200 real emails to exhaust `authMailGlobal` would make this
      // test absurdly slow; instead we drain the same rate-limiter bucket
      // `sendVerificationRequest` itself consumes from
      // (`rateLimiter.limit(ctx, "authMailGlobal", ...)`), through the real
      // component, the same technique convex/lib/rateLimits.test.ts already
      // uses for `authAttempt`. This still exercises the real fail-closed
      // check inside `lib/authMail.ts`, just with the bucket pre-loaded.
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);

      const drained = await t.run(async (ctx) => rateLimiter.limit(ctx, "authMailGlobal", { count: 200 }));
      expect(drained.ok).toBe(true);

      // A brand-new address, never seen before: proves this is the GLOBAL
      // switch, not the per-address one (which would only affect reused addresses).
      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email: "global-cap-victim@example.com", password: PASSWORD });
      } catch (err) {
        caught = err;
      }
      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authMailGlobal");
      expect(send).not.toHaveBeenCalled();

      // And a second, different address is refused the same way — the cap
      // is not silently per-caller or one-shot.
      let secondCaught: unknown;
      try {
        await signIn(t, { flow: "signUp", email: "global-cap-victim-2@example.com", password: PASSWORD });
      } catch (err) {
        secondCaught = err;
      }
      expect(isRateLimitError(secondCaught)).toBe(true);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe("email normalization on every write path", () => {
    it("signUp normalizes a raw-case, padded email before the first users.email write", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await signIn(t, { flow: "signUp", email: "  MixedCase.User@Example.COM ", password: PASSWORD });
      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe("mixedcase.user@example.com");
      expect(send.mock.calls[0]![0]).toMatchObject({ to: "mixedcase.user@example.com" });
    });

    it("email-verification looks the account up by the normalized form even when the client re-submits a differently-cased/padded email", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const raw = "  Second.User@Example.COM  ";
      await signIn(t, { flow: "signUp", email: raw, password: PASSWORD });
      const code = lastCode(send);

      // A client that echoes the raw string back (rather than the normalized
      // one) must still resolve to the same account: guardedAuthorize
      // normalizes on every flow, not just signUp/profile().
      const verified = await signIn(t, { flow: "email-verification", email: raw, code });
      expect(verified.tokens).not.toBeNull();
      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe("second.user@example.com");
    });

    it("reset resolves a raw-case address to the same normalized account that signed up", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await signIn(t, { flow: "signUp", email: "third.user@example.com", password: PASSWORD });
      send.mockClear();

      const result = await signIn(t, { flow: "reset", email: "  Third.User@EXAMPLE.com" });
      expect(result.tokens).toBeNull();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ to: "third.user@example.com", kind: "reset" });
    });

    it("reset-verification writes the normalized address, never the raw one the client submitted", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await signIn(t, { flow: "signUp", email: "fourth.user@example.com", password: PASSWORD });
      send.mockClear();
      await signIn(t, { flow: "reset", email: " Fourth.User@Example.com " });
      const code = lastCode(send);

      await signIn(t, {
        flow: "reset-verification",
        email: " Fourth.User@Example.com ",
        code,
        newPassword: "another-new-password-1",
      });
      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(users).toHaveLength(1);
      expect(users[0]!.email).toBe("fourth.user@example.com");
    });

  });

  describe("account-exists safety", () => {
    it("signUp for an address that already has an account gets the same generic message regardless of the existing password", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "already-exists@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });

      await expect(signIn(t, { flow: "signUp", email, password: "a-totally-different-pw-1" })).rejects.toThrow(
        ACCOUNT_EXISTS_MESSAGE,
      );
    });
  });
});

describe("T18.5 (D124 LOW): reset-code mail is refused for a tombstoned account", () => {
  it("before/after: reset flow for a tombstoned account throws the wrong-credentials message and sends no mail [FAILS pre-T18.5]", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "tombstoned-reset@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    send.mockClear();

    const userId = await t.run(async (ctx) => {
      const user = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", email)).unique();
      return user!._id;
    });
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));

    await expect(signIn(t, { flow: "reset", email })).rejects.toThrow(WRONG_CREDENTIALS_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it("an active (non-tombstoned) account's reset flow is unaffected: still sends the code and returns no tokens", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "active-reset@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    send.mockClear();

    const result = await signIn(t, { flow: "reset", email });
    expect(result.tokens).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("an unknown address's reset flow is unaffected (no account to resolve, so no tombstone check can even run)", async () => {
    const t = setup();
    const result = await signIn(t, { flow: "reset", email: "never-registered-reset@example.com" });
    expect(result.tokens).toBeNull();
  });
});
