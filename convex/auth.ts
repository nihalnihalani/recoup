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
 */
import { ConvexError } from "convex/values";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import type { ConvexCredentialsUserConfig } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import type { GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { Value } from "convex/values";
import type { DataModel, Id } from "./_generated/dataModel";
import { normalizeEmail } from "./lib/email";
import { authMail } from "./lib/authMail";
import { rateLimiter } from "./lib/rateLimits";

/** Client-facing messages. Identical for known/unknown addresses by construction (D67/T05). */
export const WRONG_CREDENTIALS_MESSAGE = "Wrong email or password";
export const TOO_MANY_ATTEMPTS_MESSAGE = "Too many attempts. Try again later.";
export const INVALID_CODE_MESSAGE = "That code is not valid or has expired";
export const ACCOUNT_EXISTS_MESSAGE =
  "Could not create an account with those details. If you already have one, sign in or reset your password.";
/** Never leaked to the client with any raw detail attached (lib/errors.ts precedent). */
export const UNEXPECTED_AUTH_ERROR_MESSAGE = "Something went wrong. Please try again.";

const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_CHARS = 128;

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

async function guardedAuthorize(params: AuthorizeParams, ctx: Ctx): Promise<AuthorizeResult> {
  const email = normalizeEmail(params.email);
  const flow = params.flow;

  // Before any provider work: 11th attempt for this email in 10 minutes fails closed.
  await rateLimiter.limit(ctx, "authAttempt", { key: email, throws: true });

  if (flow === "reset") {
    // Non-consuming: keeps a throttled reset indistinguishable for a known
    // vs. an unknown address (only a known address's real send consumes
    // this limit, inside authMail's sendVerificationRequest).
    const status = await rateLimiter.check(ctx, "authMailPerEmail", { key: email });
    if (!status.ok) {
      throw new ConvexError({ kind: "RateLimited", name: "authMailPerEmail", retryAfter: status.retryAfter });
    }
  }

  const rewrittenParams: AuthorizeParams = { ...params, email };

  try {
    return await passwordOptions.authorize(rewrittenParams, ctx);
  } catch (err) {
    // Our own ConvexErrors (rate limits, password-requirement checks, the
    // authMail transport's own non-enumerating errors) are already safe.
    if (err instanceof ConvexError) throw err;

    const message = err instanceof Error ? err.message : String(err);

    if (message === "InvalidAccountId") {
      // Unknown address: for `reset`, this is the library's *known*-address
      // shape (null); for signIn/signUp it collapses into the same
      // wrong-credentials message a known address with a bad secret gets.
      if (flow === "reset") return null;
      throw new ConvexError(WRONG_CREDENTIALS_MESSAGE);
    }
    if (message === "InvalidSecret") {
      throw new ConvexError(WRONG_CREDENTIALS_MESSAGE);
    }
    if (message === "TooManyFailedAttempts") {
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
