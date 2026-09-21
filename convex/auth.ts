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
 *    only so call sites stay self-documenting); see N1 below for why it no
 *    longer carries a `retryAfter`. A `flow === "reset"` request against an *unknown*
 *    address now also consumes (not just peeks) `authMailPerEmail` for that
 *    address — previously only a *known* address's real send (deep inside
 *    `authMail`) ever decremented that bucket, so an unknown address could
 *    be probed with unlimited reset requests while a known one got throttled
 *    on the 4th — an account-enumeration side channel.
 * 7. F5: `flow === "signUp"` first consumes `authSignUpGlobal` (deployment-
 *    wide), then `authSignUp` (per-address), and peeks (never consumes —
 *    the real send still does) `authMailGlobal`, all before any provider
 *    work — so a saturated mail quota or a burst of signUps rejects with
 *    `RateLimited` before `createAccount` ever runs, instead of leaving a
 *    fresh, unverified, permanently-unreachable `users`/`authAccounts` row
 *    behind.
 *
 * Checkpoint-4 recheck (D99) additions:
 *
 * 8. N1: the library's own per-account lockout (`TooManyFailedAttempts`,
 *    tracked in its `authRateLimits` table, distinct from our `authAttempt`
 *    bucket above) maps to a *plain-string* `ConvexError(WRONG_CREDENTIALS_MESSAGE)`
 *    — no `retryAfter`, no `{kind: "RateLimited"}` envelope, byte-identical
 *    to an ordinary wrong password. This is a deliberate tradeoff: the
 *    locked-out user gets no countdown (the client's `isRateLimitError()`
 *    returns false for this error, same as for a wrong password, so the UI
 *    falls back to its generic "wrong email or password" copy) because
 *    giving one back would let an attacker distinguish "this account is
 *    locked" from "this password is wrong" by response shape alone, for
 *    every account they probe — an enumeration oracle in exchange for a
 *    countdown nobody but the legitimate owner benefits from.
 * 9. N4: `authSignUp` (per-address, 20/hour) and `authSignUpGlobal`
 *    (deployment-wide, 200/hour token bucket) are now two distinct named
 *    limiters — previously both the unkeyed (global) and keyed (per-
 *    address) calls shared one config, so the *global* bucket was also
 *    capped at 20/hour: 20 signUps anywhere (e.g. 20 distinct, unrelated
 *    addresses) refused every further signUp on the entire site until the
 *    window rolled over, a self-inflicted registration lockout rather than
 *    an abuse control.
 * 10. N5: the password-format check (`checkPasswordFormat`, the same rule
 *     passed to `Password(...)` as `validatePasswordRequirements` below)
 *     now runs *before* the F2 existence probe. Previously a malformed
 *     (too-short/too-long) password against an *existing* address
 *     short-circuited on `ACCOUNT_EXISTS_MESSAGE`, while the identical
 *     malformed password against an *unknown* address fell through into
 *     the library's own `authorize` (which validates the password first)
 *     and threw a differently-worded error — an account-enumeration oracle
 *     triggerable with zero valid credentials.
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
 * F3 (D94) / N1 (D99): deliberately the *same string* as
 * `WRONG_CREDENTIALS_MESSAGE` — the library's own per-account lockout
 * (`authRateLimits`, distinct from our `authAttempt` rate limit) must not
 * read differently from an ordinary wrong password, or the message itself
 * becomes an account-lockout oracle. Kept as a separate exported constant
 * only so call sites document intent. N1 (D99): the thrown `ConvexError` is
 * now a plain string with no `retryAfter` and no `{kind: "RateLimited"}`
 * envelope — byte-identical to a wrong-password error, including to
 * `isRateLimitError()` on the client, which returns `false` for both. The
 * locked-out user gets no countdown, by design: see the module docstring's
 * "N1" note for the enumeration-oracle tradeoff this avoids.
 */
export const TOO_MANY_ATTEMPTS_MESSAGE = WRONG_CREDENTIALS_MESSAGE;
export const INVALID_CODE_MESSAGE = "That code is not valid or has expired";
export const ACCOUNT_EXISTS_MESSAGE =
  "Could not create an account with those details. If you already have one, sign in or reset your password.";
/** Never leaked to the client with any raw detail attached (lib/errors.ts precedent). */
export const UNEXPECTED_AUTH_ERROR_MESSAGE = "Something went wrong. Please try again.";

const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_CHARS = 128;
/** Matches `Password<DataModel>({...})` below, which does not override `id`. */
const PASSWORD_PROVIDER_ID = "password";

/**
 * N5 (D99): the same 8-128 char rule passed to `Password(...)` below as
 * `validatePasswordRequirements`, exposed as a standalone function so
 * `guardedAuthorize` can also run it directly, *before* the F2 existence
 * probe (see the `flow === "signUp"` branch below) — the library's own
 * `validatePasswordRequirements` hook is not otherwise reachable ahead of
 * that probe, and its internal default (`validateDefaultPasswordRequirements`
 * in `Password.ts`) is not exported, so this mirrors our own already-active
 * rule rather than importing the library's.
 */
function checkPasswordFormat(pw: unknown): void {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_CHARS || pw.length > MAX_PASSWORD_CHARS) {
    throw new ConvexError(`Password must be ${MIN_PASSWORD_CHARS}-${MAX_PASSWORD_CHARS} characters`);
  }
}

const password = Password<DataModel>({
  profile: (params) => ({ email: normalizeEmail(params.email) }),
  validatePasswordRequirements: checkPasswordFormat,
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
      // F5/N4: consumed before any users/authAccounts row is created.
      // Global and per-address are two distinct named limiters (N4, D99) so
      // a deployment-wide burst from many distinct addresses cannot exhaust
      // the same bucket a single targeted address is throttled by.
      await rateLimiter.limit(ctx, "authSignUpGlobal", { throws: true });
      await rateLimiter.limit(ctx, "authSignUp", { key: email, throws: true });
      const mailStatus = await rateLimiter.check(ctx, "authMailGlobal");
      if (!mailStatus.ok) {
        throw new ConvexError({ kind: "RateLimited", name: "authMailGlobal", retryAfter: mailStatus.retryAfter });
      }

      // N5 (D99): format-check the password *before* the existence probe
      // below — otherwise a malformed password against an existing address
      // short-circuited on ACCOUNT_EXISTS_MESSAGE while the identical
      // malformed password against an unknown address fell through into the
      // library's own (differently-worded) validation error, letting a
      // junk-password signUp distinguish a registered address from an
      // unregistered one with zero valid credentials.
      checkPasswordFormat(params.password);

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
      // N1 (D99): a plain-string ConvexError, byte-identical to a wrong
      // password — no `retryAfter`, no `{kind: "RateLimited"}` envelope.
      // The locked-out user gets no countdown, by design: see the module
      // docstring's "N1" note and TOO_MANY_ATTEMPTS_MESSAGE's own doc
      // comment for why a distinguishable shape here is an enumeration
      // oracle (an attacker could tell "locked out" from "wrong password"
      // for any account they probe, with zero valid credentials).
      throw new ConvexError(TOO_MANY_ATTEMPTS_MESSAGE);
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
