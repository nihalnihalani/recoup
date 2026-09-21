/**
 * Password auth, wrapped for email verification/reset (D65-D67, T05).
 *
 * `Password` returns a `ConvexCredentials` provider whose *real* `authorize`
 * lives on `.options.authorize` (the top-level `authorize` is a stub the
 * library merges over at materialization — `provider_utils.ts`'s
 * `providerDefaults`/`merge`). `guardedPassword` below is that same
 * provider with `.options.authorize` swapped for `guardedAuthorize`, which:
 *
 * 1. Normalizes `params.email` and passes the *rewritten* params through to
 *    the real `authorize` — the library patches `users.email` with the raw
 *    `params.email` at every code creation and rejects a code whose raw
 *    email doesn't match the account id it was issued to
 *    (`createVerificationCode.ts`, `Email().authorize`), so normalizing
 *    only inside `profile()` would let a raw-case sign-up never verify.
 * 2. Enforces `authAttempt` (per-email) before any provider work runs.
 * 3. For `flow === "reset"`, pre-checks (never consumes) `authMailPerEmail`
 *    so a throttled reset throws the *same* shape of error for a known and
 *    an unknown address — otherwise the throttle itself would be a timing
 *    side-channel (only known addresses ever reach the real per-address
 *    consume, inside `authMail`'s `sendVerificationRequest`).
 * 4. Maps the library's internal `Error` messages to non-enumerating
 *    `ConvexError`s (identical wording for known and unknown addresses),
 *    except `flow === "reset"` against an unknown address, which returns
 *    `null` — the same thing the library itself returns for a *known*
 *    address's reset request (`Password.ts`'s `reset` branch resolves via
 *    `signInViaProvider`, which maps a "started" email send to `null`).
 *
 * Checkpoint 4 (D94) additions, all in `guardedAuthorize`:
 *
 * 5. F2: `flow === "signUp"` against an email that already has a `password`
 *    account throws `ACCOUNT_EXISTS_MESSAGE` unconditionally, checked via
 *    the library's own `retrieveAccount(ctx, {provider, account:{id}})`
 *    (no `secret` — an existence lookup only, never hashes anything) before
 *    `passwordOptions.authorize` runs. Without this, the library's own
 *    `createAccountFromCredentials.ts` (:46-62) verifies the *supplied*
 *    secret against the *existing* account's hash and, on a match, signs the
 *    caller in as that account — turning `signUp` into an unthrottled
 *    (no `authRateLimits`/`TooManyFailedAttempts` lockout — that only
 *    applies to the `signIn` mutation) password-guessing oracle against
 *    someone else's account.
 * 6. F3: `InvalidAccountId` from a code flow (`email-verification`,
 *    `reset-verification` — reachable when the email in `params` has no
 *    account) maps to `INVALID_CODE_MESSAGE`, not `WRONG_CREDENTIALS_MESSAGE`
 *    — matches the oracle a wrong/expired code already gets, instead of
 *    leaking a distinct "wrong password" wording for a code-entry screen.
 *    `TOO_MANY_ATTEMPTS_MESSAGE` reads identically to
 *    `WRONG_CREDENTIALS_MESSAGE` (both exported, kept as separate constants
 *    only so call sites stay self-documenting) with a `data.retryAfter` the
 *    UI alone can key off. A `flow === "reset"` request against an *unknown*
 *    address now also consumes (not just peeks) `authMailPerEmail` for that
 *    address — previously only a *known* address's real send (deep inside
 *    `authMail`) ever decremented that bucket, so an unknown address could
 *    be probed with unlimited reset requests while a known one got throttled
 *    on the 4th — an account-enumeration side channel.
 * 7. F5: `flow === "signUp"` first consumes `authSignUp` (global, then
 *    per-address) and peeks (never consumes — the real send still does)
 *    `authMailGlobal`, all before any provider work — so a saturated mail
 *    quota or a burst of signUps rejects with `RateLimited` before
 *    `createAccount` ever runs, instead of leaving a fresh, unverified,
 *    permanently-unreachable `users`/`authAccounts` row behind.
 */
import { ConvexError } from "convex/values";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { ConvexCredentialsUserConfig } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth, retrieveAccount } from "@convex-dev/auth/server";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { Value } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/email";
import { authMail } from "./lib/authMail";
import { rateLimiter } from "./lib/rateLimits";

/** Client-facing messages. Identical for known/unknown addresses by construction (D67/T05). */
export const WRONG_CREDENTIALS_MESSAGE = "Wrong email or password";
/**
 * F3 (D94): deliberately the *same string* as `WRONG_CREDENTIALS_MESSAGE` —
 * the library's own per-account lockout (`authRateLimits`, distinct from our
 * `authAttempt` rate limit) must not read differently from an ordinary wrong
 * password, or the message itself becomes an account-lockout oracle. Kept as
 * a separate exported constant only so call sites document intent; the UI
 * distinguishes this case via `data.retryAfter` on the thrown `ConvexError`,
 * which a plain wrong-credentials error never carries.
 */
export const TOO_MANY_ATTEMPTS_MESSAGE = WRONG_CREDENTIALS_MESSAGE;
/** Approximate: the library's per-account lockout refills continuously (10/hour by default, not in fixed windows), so this is a conservative single-slot estimate, not an exact countdown. */
const TOO_MANY_ATTEMPTS_RETRY_AFTER_MS = 6 * 60_000;
export const INVALID_CODE_MESSAGE = "That code is not valid or has expired";
export const ACCOUNT_EXISTS_MESSAGE =
  "Could not create an account with those details. If you already have one, sign in or reset your password.";
/** Never leaked to the client with any raw detail attached (lib/errors.ts precedent). */
export const UNEXPECTED_AUTH_ERROR_MESSAGE = "Something went wrong. Please try again.";

const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_CHARS = 128;
/** Matches `Password<DataModel>({...})` below, which does not override `id`. */
const PASSWORD_PROVIDER_ID = "password";

const password = Password<DataModel>({
  profile: (params) => ({ email: normalizeEmail(params.email) }),
  validatePasswordRequirements: (pw: string) => {
    if (typeof pw !== "string" || pw.length < MIN_PASSWORD_CHARS || pw.length > MAX_PASSWORD_CHARS) {
      throw new ConvexError(`Password must be ${MIN_PASSWORD_CHARS}-${MAX_PASSWORD_CHARS} characters`);
    }
  },
  verify: authMail("verify"),
  reset: authMail("reset"),
});

type AuthorizeResult = { userId: Id<"users">; sessionId?: Id<"authSessions"> } | null;
type AuthorizeParams = Partial<Record<string, Value | undefined>>;
type Ctx = GenericActionCtxWithAuthConfig<DataModel>;

/** The library's real `authorize`, hidden behind an internal, undocumented `.options` field. */
const passwordOptions = (password as unknown as { options: ConvexCredentialsUserConfig<DataModel> }).options;

/**
 * F2: existence-only lookup (no `secret`, so `retrieveAccount` never hashes
 * or touches the library's per-account lockout) used to refuse `signUp`
 * against an email that already has a `password` account before any
 * provider work — in particular before `createAccountFromCredentials.ts`
 * would otherwise verify the *supplied* secret against the *existing*
 * hash. Returns `false` for `Error("InvalidAccountId")` (no such account,
 * the expected/normal case for a real new sign-up); anything else
 * propagates to `guardedAuthorize`'s catch, which maps it safely.
 */
async function accountExists(ctx: Ctx, email: string): Promise<boolean> {
  try {
    await retrieveAccount(ctx, { provider: PASSWORD_PROVIDER_ID, account: { id: email } });
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === "InvalidAccountId") return false;
    throw err;
  }
}

async function guardedAuthorize(params: AuthorizeParams, ctx: Ctx): Promise<AuthorizeResult> {
  const email = normalizeEmail(params.email);
  const flow = params.flow;
  const rewrittenParams: AuthorizeParams = { ...params, email };

  // Before any provider work: 11th attempt for this email in 10 minutes fails closed.
  await rateLimiter.limit(ctx, "authAttempt", { key: email, throws: true });

  try {
    if (flow === "reset") {
      // Non-consuming: keeps a throttled reset indistinguishable for a known
      // vs. an unknown address (only a known address's real send consumes
      // this limit, inside authMail's sendVerificationRequest — the
      // InvalidAccountId branch below phantom-consumes it for an unknown one).
      const status = await rateLimiter.check(ctx, "authMailPerEmail", { key: email });
      if (!status.ok) {
        throw new ConvexError({ kind: "RateLimited", name: "authMailPerEmail", retryAfter: status.retryAfter });
      }
    }

    if (flow === "signUp") {
      // F5: consumed before any users/authAccounts row is created.
      await rateLimiter.limit(ctx, "authSignUp", { throws: true });
      await rateLimiter.limit(ctx, "authSignUp", { key: email, throws: true });
      const mailStatus = await rateLimiter.check(ctx, "authMailGlobal");
      if (!mailStatus.ok) {
        throw new ConvexError({ kind: "RateLimited", name: "authMailGlobal", retryAfter: mailStatus.retryAfter });
      }

      // F2: signUp against an existing account never authenticates, no
      // matter the supplied secret, and never reaches the hash comparison.
      if (await accountExists(ctx, email)) {
        throw new ConvexError(ACCOUNT_EXISTS_MESSAGE);
      }
    }

    return await passwordOptions.authorize(rewrittenParams, ctx);
  } catch (err) {
    // Our own ConvexErrors (rate limits, password-requirement checks, the
    // authMail transport's own non-enumerating errors) are already safe.
    if (err instanceof ConvexError) throw err;

    const message = err instanceof Error ? err.message : String(err);

    if (message === "InvalidAccountId") {
      // Unknown address: for `reset`, this is the library's *known*-address
      // shape (null); for signIn it collapses into the same wrong-credentials
      // message a known address with a bad secret gets; for the two code
      // flows it reads as an invalid code (F3), not a password error.
      if (flow === "reset") {
        // F3: phantom-consume so an unknown address's reset depletes the
        // same per-address bucket a known address's real send would —
        // otherwise an unknown address could be probed indefinitely while a
        // known one gets throttled on its 4th request within the hour.
        await rateLimiter.limit(ctx, "authMailPerEmail", { key: email, throws: true });
        return null;
      }
      if (flow === "email-verification" || flow === "reset-verification") {
        throw new ConvexError(INVALID_CODE_MESSAGE);
      }
      throw new ConvexError(WRONG_CREDENTIALS_MESSAGE);
    }
    if (message === "InvalidSecret") {
      throw new ConvexError(WRONG_CREDENTIALS_MESSAGE);
    }
    if (message === "TooManyFailedAttempts") {
      throw new ConvexError({ message: TOO_MANY_ATTEMPTS_MESSAGE, retryAfter: TOO_MANY_ATTEMPTS_RETRY_AFTER_MS });
    }
    if (message === "Could not verify code" || message === "Invalid code") {
      throw new ConvexError(INVALID_CODE_MESSAGE);
    }
    if (message.includes("already exists")) {
      throw new ConvexError(ACCOUNT_EXISTS_MESSAGE);
    }
    // Unexpected: never let a raw Error ("Server Error" on the client, or
    // worse, a leaked detail) reach the caller.
    throw new ConvexError(UNEXPECTED_AUTH_ERROR_MESSAGE);
  }
}

const guardedPassword = ConvexCredentials<DataModel>({
  ...passwordOptions,
  authorize: guardedAuthorize,
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [guardedPassword],
});
