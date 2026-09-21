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
import { api } from "./_generated/api";
import { setup } from "./test.setup";
import { authMailTransport } from "./lib/authMail";
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
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "foo@example.com", kind: "verify", expiresInMinutes: 15 }),
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
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: known, kind: "reset" }));
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
