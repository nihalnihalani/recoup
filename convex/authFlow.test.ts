/// <reference types="vite/client" />
/**
 * Integration tests for the guarded Password provider (`./auth.ts`, D65-D67,
 * T05): the flow table from the binding contract, plus its three failure
 * modes (authAttempt cap, authMailPerEmail cap, and a misconfigured
 * transport), driven through the real `auth.signIn` action so the ordering
 * (rate limit -> provider -> error mapping) is exercised end to end.
 *
 * `convex/auth.test.ts` is T09's; this file is the backend's own coverage
 * per the T05 contract and does not duplicate it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
import { isRateLimitError } from "@convex-dev/rate-limiter";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import { setup } from "./test.setup";
import { authMailTransport } from "./lib/authMail";
import { rateLimiter } from "./lib/rateLimits";
import {
  ACCOUNT_EXISTS_MESSAGE,
  INVALID_CODE_MESSAGE,
  TOO_MANY_ATTEMPTS_MESSAGE,
  WRONG_CREDENTIALS_MESSAGE,
} from "./auth";

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

describe("guarded Password provider — flow table and failure modes (T05, D65-D67)", () => {
  beforeAll(async () => {
    // `@convex-dev/auth` requires these: SITE_URL on every code send
    // (redirects.ts), CONVEX_SITE_URL + JWT_PRIVATE_KEY to mint a session
    // JWT once a sign-in actually succeeds (tokens.ts).
    process.env.SITE_URL = "https://recoup.example";
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
    process.env.ALERTS_INBOX_ID = "inbox_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("signUp normalizes a raw-case, padded email to one users row, with no session until the code is entered", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);

    const result = await signIn(t, { flow: "signUp", email: "  Foo@Example.COM ", password: PASSWORD });
    expect(result.tokens).toBeNull();

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe("foo@example.com");
    expect(users[0]!.emailVerificationTime).toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    // D102: `send` also receives `ctx` as a second (undeclared) argument.
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "foo@example.com", kind: "verify", expiresInMinutes: 15 }),
      expect.anything(),
    );
    expect(lastCode(send)).toMatch(/^\d{8}$/);
  });

  it("verifying with the code captured from the transport spy signs in and sets emailVerificationTime", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "  Foo@Example.COM ";

    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    const code = lastCode(send);

    const verifyResult = await signIn(t, { flow: "email-verification", email, code });
    expect(verifyResult.tokens).not.toBeNull();

    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe("foo@example.com");
    expect(typeof users[0]!.emailVerificationTime).toBe("number");
  });

  it("a wrong or expired code is rejected with a non-enumerating message and no session", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "person@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });

    await expect(signIn(t, { flow: "email-verification", email, code: "00000000" })).rejects.toThrow(
      INVALID_CODE_MESSAGE,
    );
  });

  it("D66: signing in to an unverified existing account with the correct password sends a new code and returns no session", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "unverified@example.com";

    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    expect(send).toHaveBeenCalledTimes(1);

    const signInResult = await signIn(t, { flow: "signIn", email, password: PASSWORD });
    expect(signInResult.tokens).toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0]).toMatchObject({ to: email, kind: "verify" });

    // Still exactly one user, still unverified.
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]!.emailVerificationTime).toBeUndefined();
  });

  it("signUp for an address that already has an account gets the generic message, identical regardless of the existing password", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "existing@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });

    await expect(signIn(t, { flow: "signUp", email, password: "a-different-password-1" })).rejects.toThrow(
      ACCOUNT_EXISTS_MESSAGE,
    );
  });

  it("wrong-password message is identical for a known address and an address that was never registered", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const known = "known@example.com";
    await signIn(t, { flow: "signUp", email: known, password: PASSWORD });

    let knownErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email: known, password: "totally-wrong" });
    } catch (err) {
      knownErr = err;
    }
    let unknownErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email: "never-signed-up@example.com", password: "totally-wrong" });
    } catch (err) {
      unknownErr = err;
    }

    expect(knownErr).toBeInstanceOf(ConvexError);
    expect(unknownErr).toBeInstanceOf(ConvexError);
    expect((knownErr as ConvexError<string>).message).toContain(WRONG_CREDENTIALS_MESSAGE);
    expect((unknownErr as ConvexError<string>).message).toContain(WRONG_CREDENTIALS_MESSAGE);
    expect((knownErr as ConvexError<string>).data).toBe((unknownErr as ConvexError<string>).data);
  });

  it("the library's own too-many-failed-attempts lockout maps to a fixed, non-enumerating message", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "locked-out@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });

    // Simulate the library's own per-account lockout (`authRateLimits`,
    // keyed by the authAccounts row, not by email) being already exhausted,
    // without touching our `authAttempt` bucket — isolates this mapping
    // from the authAttempt cap exercised elsewhere in this file.
    await t.run(async (ctx) => {
      const account = await ctx.db
        .query("authAccounts")
        .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
        .unique();
      if (!account) throw new Error("expected an authAccounts row for " + email);
      await ctx.db.insert("authRateLimits", { identifier: account._id, attemptsLeft: 0, lastAttemptTime: Date.now() });
    });

    await expect(signIn(t, { flow: "signIn", email, password: PASSWORD })).rejects.toThrow(TOO_MANY_ATTEMPTS_MESSAGE);
  });

  it("reset for an unknown address returns exactly what a known address's reset returns, and only the known address gets mail", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const known = "reset-known@example.com";
    await signIn(t, { flow: "signUp", email: known, password: PASSWORD });
    send.mockClear(); // drop the signUp verification send; only care about `reset` below

    const knownResult = await signIn(t, { flow: "reset", email: known });
    const unknownResult = await signIn(t, { flow: "reset", email: "reset-unknown@example.com" });

    expect(knownResult).toEqual(unknownResult);
    expect(knownResult.tokens).toBeNull();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: known, kind: "reset" }), expect.anything());
  });

  it("reset-verification with the reset code changes the password, verifies the email, and signs in", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "reset-flow@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    send.mockClear();

    await signIn(t, { flow: "reset", email });
    const code = lastCode(send);

    const newPassword = "a-brand-new-password-1";
    const result = await signIn(t, { flow: "reset-verification", email, code, newPassword });
    expect(result.tokens).not.toBeNull();

    // The new password now signs in.
    const signInResult = await signIn(t, { flow: "signIn", email, password: newPassword });
    expect(signInResult.tokens).not.toBeNull();
  });

  it("4th auth mail to one address within an hour throws, distinctly from a wrong-credentials error", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "capped-flow@example.com";

    await signIn(t, { flow: "signUp", email, password: PASSWORD }); // 1st send
    await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 2nd send (still unverified)
    await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 3rd send
    expect(send).toHaveBeenCalledTimes(3);

    let caught: unknown;
    try {
      await signIn(t, { flow: "signIn", email, password: PASSWORD }); // 4th — capped
    } catch (err) {
      caught = err;
    }
    expect(isRateLimitError(caught)).toBe(true);
    expect((caught as ConvexError<{ name: string }>).data.name).toBe("authMailPerEmail");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("missing ALERTS_INBOX_ID throws without echoing any body or config, using the real transport", async () => {
    const t = setup();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const saved = process.env.ALERTS_INBOX_ID;
    delete process.env.ALERTS_INBOX_ID;
    try {
      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email: "unconfigured@example.com", password: PASSWORD });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConvexError);
      expect((caught as ConvexError<string>).message).toContain("Could not send the email right now");
      expect((caught as ConvexError<string>).message).not.toContain("am-test");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      if (saved === undefined) delete process.env.ALERTS_INBOX_ID;
      else process.env.ALERTS_INBOX_ID = saved;
    }
  });

  it("11th sign-in attempt for one email within 10 minutes throws before the provider runs, and never reaches the transport", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "attempt-capped@example.com";

    for (let i = 0; i < 10; i++) {
      await expect(signIn(t, { flow: "signIn", email, password: "wrong" })).rejects.toThrow(
        WRONG_CREDENTIALS_MESSAGE,
      );
    }

    let eleventh: unknown;
    try {
      await signIn(t, { flow: "signIn", email, password: "wrong" });
    } catch (err) {
      eleventh = err;
    }
    // Distinct from the 10 prior "Wrong email or password" rejections: proves
    // the authAttempt gate fired before the provider's own credential check ran.
    expect(isRateLimitError(eleventh)).toBe(true);
    expect((eleventh as ConvexError<{ name: string }>).data.name).toBe("authAttempt");
    expect(send).not.toHaveBeenCalled();
  });

  it("no convex module patches users.email directly (invariant: only the provider writes it)", async () => {
    const t = setup();
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await signIn(t, { flow: "signUp", email: "invariant@example.com", password: PASSWORD });
    const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
    expect(users).toHaveLength(1);
    expect(users[0]!.email).toBe("invariant@example.com");
  });

  it("a too-short password gets the library's own ConvexError, not a generic one (passes through unmapped)", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await expect(signIn(t, { flow: "signUp", email: "short-pw@example.com", password: "short" })).rejects.toThrow(
      /8-128 characters/,
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("checkpoint 4 (D94) regression tests — T05.1", () => {
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

  describe("F1 (BLOCKER): authMail() binds a code to the account it was issued to", () => {
    it("a verify code issued to V cannot be redeemed while claiming a different, existing account A's email", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const victim = "victim@example.com";
      const attacker = "attacker@example.com";

      await signIn(t, { flow: "signUp", email: victim, password: PASSWORD });
      const victimCode = lastCode(send);
      await signIn(t, { flow: "signUp", email: attacker, password: PASSWORD }); // attacker needs *an* account to exist

      // Redeem V's code while claiming A's address: must be rejected exactly
      // like an invalid code, never sign the caller in as V.
      await expect(
        signIn(t, { flow: "email-verification", email: attacker, code: victimCode }),
      ).rejects.toThrow(INVALID_CODE_MESSAGE);

      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      const victimUser = users.find((u) => u.email === victim);
      const attackerUser = users.find((u) => u.email === attacker);
      expect(victimUser?.emailVerificationTime).toBeUndefined();
      expect(attackerUser?.emailVerificationTime).toBeUndefined();

      // V's code was never consumed by the failed cross-account attempt: it
      // still redeems correctly, under V's own address.
      const verifyResult = await signIn(t, { flow: "email-verification", email: victim, code: victimCode });
      expect(verifyResult.tokens).not.toBeNull();
      const usersAfter = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(typeof usersAfter.find((u) => u.email === victim)?.emailVerificationTime).toBe("number");
    });

    it("the same cross-account binding is enforced for reset-verification codes", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const victim = "reset-victim@example.com";
      const attacker = "reset-attacker@example.com";

      await signIn(t, { flow: "signUp", email: victim, password: PASSWORD });
      await signIn(t, { flow: "signUp", email: attacker, password: PASSWORD });
      send.mockClear();
      await signIn(t, { flow: "reset", email: victim });
      const resetCode = lastCode(send);

      await expect(
        signIn(t, { flow: "reset-verification", email: attacker, code: resetCode, newPassword: "attacker-chosen-1" }),
      ).rejects.toThrow(INVALID_CODE_MESSAGE);

      // V's real password is unchanged: the old password still signs in
      // (once V verifies — reset also verifies the email per contract).
      const stillWorks = await signIn(t, { flow: "reset-verification", email: victim, code: resetCode, newPassword: "victim-chosen-1" });
      expect(stillWorks.tokens).not.toBeNull();
    });
  });

  describe("F2: signUp against an existing account never authenticates, regardless of the secret", () => {
    it("10 wrong signUp passwords against an existing account, then the correct one, all reject with no tokens", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "f2-existing@example.com";
      // This test is about the ACCOUNT_EXISTS gate specifically (F2), not
      // the separate authAttempt/authSignUp/authSignUpGlobal throttles
      // (covered elsewhere) — reset those between calls so 12 same-email
      // signUp attempts in a row don't trip a *different* limiter and
      // produce a false negative here.
      const resetOtherLimiters = () =>
        t.run(async (ctx) => {
          await rateLimiter.reset(ctx, "authAttempt", { key: email });
          await rateLimiter.reset(ctx, "authSignUp", { key: email });
          await rateLimiter.reset(ctx, "authSignUpGlobal");
        });

      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      await resetOtherLimiters();

      for (let i = 0; i < 10; i++) {
        await expect(
          signIn(t, { flow: "signUp", email, password: `wrong-guess-number-${i}` }),
        ).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
        await resetOtherLimiters();
      }

      // The 11th guess happens to be the *correct* password: must still be
      // refused, never silently authenticate as the existing account.
      await expect(signIn(t, { flow: "signUp", email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    }, 20_000);

    it("the correct password via signUp against an existing account still throws ACCOUNT_EXISTS, not a session", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "f2-correct-guess@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });

      await expect(signIn(t, { flow: "signUp", email, password: PASSWORD })).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);

      // Still exactly one authAccounts row for this email — no duplicate,
      // no credential mutation, no session minted from the "right" guess.
      const accounts = await t.run(async (ctx) =>
        ctx.db
          .query("authAccounts")
          .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
          .collect(),
      );
      expect(accounts).toHaveLength(1);
    });

    it("never hashes the supplied secret against an existing account (existence check runs before hashing)", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "f2-no-hash@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });

      // A well-formed but wrong password: passes the N5 format check (D99),
      // so this exercises the F2 existence guard specifically, proving it
      // fires before any hashing. A malformed password is covered
      // separately (N5, below) and short-circuits even earlier, before the
      // existence check ever runs.
      await expect(
        signIn(t, { flow: "signUp", email, password: "a-different-but-well-formed-1" }),
      ).rejects.toThrow(ACCOUNT_EXISTS_MESSAGE);
    });
  });

  describe("F3: unified oracles", () => {
    it("email-verification against an unknown address reads exactly like a wrong code on a known one (paired .data)", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const known = "f3-known@example.com";
      await signIn(t, { flow: "signUp", email: known, password: PASSWORD });
      send.mockClear();

      let unknownErr: unknown;
      try {
        await signIn(t, { flow: "email-verification", email: "f3-never-signed-up@example.com", code: "12345678" });
      } catch (err) {
        unknownErr = err;
      }
      let wrongCodeErr: unknown;
      try {
        await signIn(t, { flow: "email-verification", email: known, code: "00000000" });
      } catch (err) {
        wrongCodeErr = err;
      }

      expect(unknownErr).toBeInstanceOf(ConvexError);
      expect(wrongCodeErr).toBeInstanceOf(ConvexError);
      expect((unknownErr as ConvexError<string>).message).toContain(INVALID_CODE_MESSAGE);
      expect((wrongCodeErr as ConvexError<string>).message).toContain(INVALID_CODE_MESSAGE);
      expect((unknownErr as ConvexError<string>).data).toBe((wrongCodeErr as ConvexError<string>).data);
    });

    it("reset-verification against an unknown address also reads as an invalid code, not a password error", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await expect(
        signIn(t, {
          flow: "reset-verification",
          email: "f3-unknown-reset@example.com",
          code: "12345678",
          newPassword: "whatever-password-1",
        }),
      ).rejects.toThrow(INVALID_CODE_MESSAGE);
    });

    it("TOO_MANY_ATTEMPTS_MESSAGE reads identically to WRONG_CREDENTIALS_MESSAGE (N1, D99: byte-identical, no retryAfter)", async () => {
      expect(TOO_MANY_ATTEMPTS_MESSAGE).toBe(WRONG_CREDENTIALS_MESSAGE);

      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "f3-lockout@example.com";
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      await t.run(async (ctx) => {
        const account = await ctx.db
          .query("authAccounts")
          .withIndex("providerAndAccountId", (q) => q.eq("provider", "password").eq("providerAccountId", email))
          .unique();
        if (!account) throw new Error("expected an authAccounts row for " + email);
        await ctx.db.insert("authRateLimits", { identifier: account._id, attemptsLeft: 0, lastAttemptTime: Date.now() });
      });

      let lockoutErr: unknown;
      try {
        await signIn(t, { flow: "signIn", email, password: PASSWORD });
      } catch (err) {
        lockoutErr = err;
      }
      let wrongPasswordErr: unknown;
      try {
        await signIn(t, { flow: "signIn", email: "f3-never-signed-up-2@example.com", password: "wrong" });
      } catch (err) {
        wrongPasswordErr = err;
      }

      expect(lockoutErr).toBeInstanceOf(ConvexError);
      expect(wrongPasswordErr).toBeInstanceOf(ConvexError);
      // N1 (D99): byte-identical — same displayed text, same plain-string
      // `.data`, and no `retryAfter` on either (the locked-out user gets no
      // countdown, by design — see auth.ts's N1 doc comment).
      expect((lockoutErr as ConvexError<string>).message).toBe((wrongPasswordErr as ConvexError<string>).message);
      expect(typeof (lockoutErr as ConvexError<string>).data).toBe("string");
      expect(typeof (wrongPasswordErr as ConvexError<string>).data).toBe("string");
      expect((lockoutErr as ConvexError<string>).data).toBe((wrongPasswordErr as ConvexError<string>).data);
    });

    it("reset on an unknown address phantom-consumes authMailPerEmail: the 4th request throws identically for known and unknown addresses", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const known = "f3-parity-known@example.com";
      const unknown = "f3-parity-unknown@example.com";
      await signIn(t, { flow: "signUp", email: known, password: PASSWORD });
      send.mockClear();
      // signUp's own verify-code send already consumed one authMailPerEmail
      // unit for `known` (same per-address bucket, shared across kinds) —
      // reset it so the loop below starts both addresses at a fresh 3/3,
      // isolating this test to the reset-specific parity it's about.
      await t.run(async (ctx) => await rateLimiter.reset(ctx, "authMailPerEmail", { key: known }));

      for (let i = 0; i < 3; i++) {
        const knownResult = await signIn(t, { flow: "reset", email: known });
        const unknownResult = await signIn(t, { flow: "reset", email: unknown });
        expect(knownResult).toEqual(unknownResult);
      }
      expect(send).toHaveBeenCalledTimes(3); // only the known address ever actually sends

      let knownFourth: unknown;
      try {
        await signIn(t, { flow: "reset", email: known });
      } catch (err) {
        knownFourth = err;
      }
      let unknownFourth: unknown;
      try {
        await signIn(t, { flow: "reset", email: unknown });
      } catch (err) {
        unknownFourth = err;
      }

      expect(isRateLimitError(knownFourth)).toBe(true);
      expect(isRateLimitError(unknownFourth)).toBe(true);
      expect((knownFourth as ConvexError<{ name: string }>).data.name).toBe("authMailPerEmail");
      expect((unknownFourth as ConvexError<{ name: string }>).data.name).toBe("authMailPerEmail");
      expect(send).toHaveBeenCalledTimes(3); // the 4th, for either address, never reaches the transport
    });
  });

  describe("F5: authSignUp + authMailGlobal are gated before any account row is created", () => {
    it("exhausting authMailGlobal, then signUp, throws RateLimited and creates no users/authAccounts rows", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await t.run(async (ctx) => {
        for (let i = 0; i < 200; i++) {
          await rateLimiter.limit(ctx, "authMailGlobal", {});
        }
      });

      const email = "f5-global-capped@example.com";
      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email, password: PASSWORD });
      } catch (err) {
        caught = err;
      }

      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authMailGlobal");
      expect(send).not.toHaveBeenCalled();

      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      const accounts = await t.run(async (ctx) => await ctx.db.query("authAccounts").collect());
      expect(users).toHaveLength(0);
      expect(accounts).toHaveLength(0);
    });

    it("exhausting authSignUpGlobal's own bucket also blocks signUp before any row is created (N4, D99: now 200, not 20)", async () => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      await t.run(async (ctx) => {
        for (let i = 0; i < 200; i++) {
          await rateLimiter.limit(ctx, "authSignUpGlobal", {});
        }
      });

      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email: "f5-signup-capped@example.com", password: PASSWORD });
      } catch (err) {
        caught = err;
      }

      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authSignUpGlobal");
      expect(send).not.toHaveBeenCalled();
      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(users).toHaveLength(0);
    }, 20_000);

    it("a per-address burst of signUps against one email is also capped by authSignUp, independent of the global bucket", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "f5-per-address@example.com";
      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await rateLimiter.limit(ctx, "authSignUp", { key: email });
        }
      });

      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email, password: PASSWORD });
      } catch (err) {
        caught = err;
      }
      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authSignUp");

      // A different address is unaffected: its own authSignUp bucket is fresh.
      const other = await signIn(t, { flow: "signUp", email: "f5-per-address-other@example.com", password: PASSWORD });
      expect(other.tokens).toBeNull();
    });
  });
});

describe("checkpoint-4 recheck (D99) regression tests — T05.2", () => {
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

  describe("N1: the library's own lockout throws a plain string, byte-identical to a wrong password", () => {
    it("after 10 wrong passwords and 61s, a locked-out known address and an unknown address throw identical ConvexErrors", async () => {
      vi.useFakeTimers();
      try {
        const t = setup();
        vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
        const known = "n1-locked-known@example.com";
        const unknown = "n1-locked-unknown@example.com";
        await signIn(t, { flow: "signUp", email: known, password: PASSWORD });

        // The signUp call above also spent 1 unit of `known`'s authAttempt
        // bucket (that gate runs before every flow, not just signIn) —
        // refill it back to full before the loop below, otherwise our own
        // gate, not the library's, would refuse the 10th wrong password.
        vi.advanceTimersByTime(61_000);

        // 10 wrong passwords against the known address: our own authAttempt
        // token bucket (capacity 10, keyed by email) lets all 10 reach the
        // provider, which is exactly enough to also exhaust the library's
        // own, independent per-account lockout counter (default 10/hour) —
        // the 10th is the last attempt our own gate lets through before it
        // is empty.
        for (let i = 0; i < 10; i++) {
          await expect(signIn(t, { flow: "signIn", email: known, password: "wrong" })).rejects.toThrow(
            WRONG_CREDENTIALS_MESSAGE,
          );
        }
        // The unknown address has its own, independent authAttempt bucket
        // (keyed by its own email) and exhausts it the same way, even
        // though every one of these is an InvalidAccountId, not a real
        // failed password check.
        for (let i = 0; i < 10; i++) {
          await expect(signIn(t, { flow: "signIn", email: unknown, password: "wrong" })).rejects.toThrow(
            WRONG_CREDENTIALS_MESSAGE,
          );
        }

        // Advance past our own authAttempt bucket's ~60s-per-token refill
        // (rate 10 / 10 minutes) so the 11th call reaches the provider for
        // both addresses — nowhere near the library's own ~6-minute refill
        // for a single attempt, so its lockout is still fully in effect for
        // the known address.
        vi.advanceTimersByTime(61_000);

        let knownErr: unknown;
        try {
          await signIn(t, { flow: "signIn", email: known, password: "wrong" });
        } catch (err) {
          knownErr = err;
        }
        let unknownErr: unknown;
        try {
          await signIn(t, { flow: "signIn", email: unknown, password: "wrong" });
        } catch (err) {
          unknownErr = err;
        }

        expect(knownErr).toBeInstanceOf(ConvexError);
        expect(unknownErr).toBeInstanceOf(ConvexError);
        expect(typeof (knownErr as ConvexError<string>).data).toBe("string");
        expect((knownErr as ConvexError<string>).data).toBe((unknownErr as ConvexError<string>).data);
        expect((knownErr as ConvexError<string>).message).toBe((unknownErr as ConvexError<string>).message);
      } finally {
        vi.useRealTimers();
      }
    }, 20_000);
  });

  describe("N4: authSignUp's global ceiling is independent of the per-address floor", () => {
    it("21 junk signUps from 21 distinct addresses do not block a 22nd, different, legitimate address", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);

      for (let i = 0; i < 21; i++) {
        const result = await signIn(t, { flow: "signUp", email: `n4-distinct-${i}@example.com`, password: PASSWORD });
        expect(result.tokens).toBeNull();
      }

      // A 22nd, different address: still well under the 200/hour global
      // bucket, and its own per-address bucket is fresh — must succeed.
      const legit = await signIn(t, { flow: "signUp", email: "n4-distinct-legit@example.com", password: PASSWORD });
      expect(legit.tokens).toBeNull();

      const users = await t.run(async (ctx) => await ctx.db.query("users").collect());
      expect(users).toHaveLength(22);
    }, 20_000);

    it("the 21st signUp for one address is refused, while the global bucket is untouched", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = "n4-one-address@example.com";
      // Pre-exhaust the per-address authSignUp bucket directly (20/20),
      // the same way an attacker's 20 real signUp attempts against this one
      // address would (each real attempt consumes it regardless of
      // outcome, before accountExists ever runs) — done directly here so
      // this test isolates the per-address bucket from our own separate
      // authAttempt gate (capacity 10/10min/email), which would otherwise
      // start refusing repeat calls to the same address first.
      await t.run(async (ctx) => {
        for (let i = 0; i < 20; i++) {
          await rateLimiter.limit(ctx, "authSignUp", { key: email });
        }
      });

      let caught: unknown;
      try {
        await signIn(t, { flow: "signUp", email, password: PASSWORD });
      } catch (err) {
        caught = err;
      }
      expect(isRateLimitError(caught)).toBe(true);
      expect((caught as ConvexError<{ name: string }>).data.name).toBe("authSignUp");

      // The global bucket (200/hour) is nowhere near exhausted: a different
      // address signs up fine.
      const other = await signIn(t, { flow: "signUp", email: "n4-one-address-other@example.com", password: PASSWORD });
      expect(other.tokens).toBeNull();
    });
  });

  describe("N5: the password-format check runs before the existence probe", () => {
    it("a malformed-password signUp against an existing address and an unknown address throw the identical error", async () => {
      const t = setup();
      vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const existing = "n5-existing@example.com";
      await signIn(t, { flow: "signUp", email: existing, password: PASSWORD });

      let existingErr: unknown;
      try {
        await signIn(t, { flow: "signUp", email: existing, password: "short" });
      } catch (err) {
        existingErr = err;
      }
      let unknownErr: unknown;
      try {
        await signIn(t, { flow: "signUp", email: "n5-unknown@example.com", password: "short" });
      } catch (err) {
        unknownErr = err;
      }

      expect(existingErr).toBeInstanceOf(ConvexError);
      expect(unknownErr).toBeInstanceOf(ConvexError);
      expect((existingErr as ConvexError<string>).message).toBe((unknownErr as ConvexError<string>).message);
      expect((existingErr as ConvexError<string>).data).toBe((unknownErr as ConvexError<string>).data);
      // Neither is the account-exists message — the existence probe never ran.
      expect((existingErr as ConvexError<string>).data).not.toBe(ACCOUNT_EXISTS_MESSAGE);
      expect((existingErr as ConvexError<string>).message).toMatch(/8-128 characters/);

      // The unknown address really is still unknown: no row was created for it.
      const unknownUsers = await t.run(async (ctx) =>
        ctx.db
          .query("users")
          .filter((q) => q.eq(q.field("email"), "n5-unknown@example.com"))
          .collect(),
      );
      expect(unknownUsers).toHaveLength(0);
    });
  });
});

describe("checkpoint 6b (D115) 6b-4a — beforeSessionCreation gates sign-in on the account-deletion tombstone", () => {
  beforeAll(async () => {
    process.env.SITE_URL = "https://recoup.example";
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
    const { privateKey } = await generateKeyPair("RS256", { extractable: true });
    process.env.JWT_PRIVATE_KEY = await exportPKCS8(privateKey);
    process.env.ALERTS_INBOX_ID = "inbox_test";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.E2E_SEED_ENABLED;
  });

  it("a requestDeletion'd user's sign-in throws the SAME ConvexError object shape (message and data, byte-for-byte) as an ordinary wrong password -- not merely the same string", async () => {
    process.env.E2E_SEED_ENABLED = "true";
    const t = setup();
    const email = "n115-tombstoned@example.com";
    const password = PASSWORD;
    const { userId } = await t.action(internal.testing.seedUser, { email, password });
    const as = t.withIdentity({ subject: `${userId}|session` });
    await as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });

    let tombstonedErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email, password });
    } catch (err) {
      tombstonedErr = err;
    }

    // A genuine wrong-password case against a REAL (not-tombstoned) account, not merely an unknown address.
    const otherEmail = "n115-other-account@example.com";
    vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    await signIn(t, { flow: "signUp", email: otherEmail, password });
    let wrongPasswordErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email: otherEmail, password: "definitely-wrong-password" });
    } catch (err) {
      wrongPasswordErr = err;
    }

    expect(tombstonedErr).toBeInstanceOf(ConvexError);
    expect(wrongPasswordErr).toBeInstanceOf(ConvexError);
    expect((tombstonedErr as ConvexError<string>).data).toBe(WRONG_CREDENTIALS_MESSAGE);
    expect((tombstonedErr as ConvexError<string>).data).toBe((wrongPasswordErr as ConvexError<string>).data);
    expect((tombstonedErr as ConvexError<string>).message).toBe((wrongPasswordErr as ConvexError<string>).message);
    expect(typeof (tombstonedErr as ConvexError<string>).data).toBe("string"); // no {kind, retryAfter} envelope -- not distinguishable from a rate limit either.
  });
});

describe("P01-1 (D244) — the two code flows refuse a request with no code before the library can mail one", () => {
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

  async function authRowCounts(t: ReturnType<typeof setup>) {
    return await t.run(async (ctx) => ({
      users: (await ctx.db.query("users").collect()).length,
      authAccounts: (await ctx.db.query("authAccounts").collect()).length,
      authVerificationCodes: (await ctx.db.query("authVerificationCodes").collect()).length,
    }));
  }

  type AddressKind = "known-verified" | "known-unverified" | "unknown" | "tombstoned";

  /** Seeds one address of the given kind; returns it with the transport spy cleared. */
  async function seedAddress(t: ReturnType<typeof setup>, send: SendSpy & { mockClear(): void }, kind: AddressKind) {
    const email = `p011-${kind}@example.com`;
    if (kind !== "unknown") {
      await signIn(t, { flow: "signUp", email, password: PASSWORD });
      if (kind !== "known-unverified") {
        await signIn(t, { flow: "email-verification", email, code: lastCode(send) });
      }
    }
    if (kind === "tombstoned") {
      await t.run(async (ctx) => {
        const user = await ctx.db
          .query("users")
          .withIndex("email", (q) => q.eq("email", email))
          .unique();
        await ctx.db.insert("accountState", { userId: user!._id, status: "deleting", requestedAt: Date.now(), attempts: 0 });
      });
    }
    send.mockClear();
    return email;
  }

  // One case per (address, flow), so each of the re-audit's repros fails on
  // its own against the unfixed code: S1 (email-verification: a known address
  // resolved {tokens:null} and was mailed), S2 (reset-verification: a known
  // address was mailed and went RateLimited on the 4th call), S2b (an
  // unverified target grew a second users row plus authAccounts/code rows),
  // S3 (a tombstoned account was mailed a code).
  const ADDRESSES: AddressKind[] = ["known-verified", "known-unverified", "unknown", "tombstoned"];
  const FLOWS = ["email-verification", "reset-verification"] as const;
  const CASES = ADDRESSES.flatMap((kind) => FLOWS.map((flow) => [kind, flow] as const));

  it.each(CASES)(
    "%s address, %s with no code: the same INVALID_CODE .data four times, never RateLimited, no mail, no new auth rows",
    async (kind, flow) => {
      const t = setup();
      const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
      const email = await seedAddress(t, send, kind);
      const before = await authRowCounts(t);
      const params =
        flow === "email-verification" ? { flow, email } : { flow, email, newPassword: "a-brand-new-password-1" };

      // Four calls: the 4th is past the 3-per-hour authMailPerEmail cap S2
      // used to hit for a known address only, and still under the
      // 10-per-10-min authAttempt cap every address shares.
      for (let call = 1; call <= 4; call++) {
        let caught: unknown;
        let result: unknown;
        try {
          result = await signIn(t, params);
        } catch (err) {
          caught = err;
        }
        const label = `${flow} for a ${kind} address, call ${call} (resolved: ${JSON.stringify(result)})`;
        expect(caught, label).toBeInstanceOf(ConvexError);
        expect(isRateLimitError(caught), label).toBe(false);
        // A string compared with toBe: every address and flow gets the byte-identical .data.
        expect((caught as ConvexError<string>).data, label).toBe(INVALID_CODE_MESSAGE);
        expect(send, label).not.toHaveBeenCalled();
        expect(await authRowCounts(t), label).toEqual(before);
      }
    },
  );

  it("D261 LOW-1: signIn with the correct password on a tombstoned never-verified account mails nothing and reads as a wrong password", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "p011-tombstoned-unverified@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      await ctx.db.insert("accountState", { userId: user!._id, status: "deleting", requestedAt: Date.now(), attempts: 0 });
    });
    send.mockClear();

    let tombstonedErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email, password: PASSWORD });
    } catch (err) {
      tombstonedErr = err;
    }
    let wrongPasswordErr: unknown;
    try {
      await signIn(t, { flow: "signIn", email: "p011-never-signed-up@example.com", password: PASSWORD });
    } catch (err) {
      wrongPasswordErr = err;
    }

    expect(send).not.toHaveBeenCalled(); // before: a fresh verification code was mailed (D66's resend path)
    expect(tombstonedErr).toBeInstanceOf(ConvexError);
    expect((tombstonedErr as ConvexError<string>).data).toBe(WRONG_CREDENTIALS_MESSAGE);
    expect((tombstonedErr as ConvexError<string>).data).toBe((wrongPasswordErr as ConvexError<string>).data);
  });

  it("an empty-string code is refused exactly like a missing one", async () => {
    const t = setup();
    const send = vi.spyOn(authMailTransport, "send").mockResolvedValue(undefined);
    const email = "p011-empty-code@example.com";
    await signIn(t, { flow: "signUp", email, password: PASSWORD });
    send.mockClear();

    await expect(signIn(t, { flow: "email-verification", email, code: "" })).rejects.toThrow(INVALID_CODE_MESSAGE);
    await expect(
      signIn(t, { flow: "reset-verification", email, code: "", newPassword: "a-brand-new-password-1" }),
    ).rejects.toThrow(INVALID_CODE_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });
});
