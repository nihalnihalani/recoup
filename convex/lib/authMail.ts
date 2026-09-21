/**
 * The Password provider's `verify`/`reset` `Email` hooks (D65, T05).
 *
 * The library — not us — generates the code and stores its hash in
 * `authVerificationCodes` (`@convex-dev/auth`'s `signIn.ts`/
 * `createVerificationCode.ts`); this module only supplies the code alphabet
 * (`generateVerificationToken`) and the delivery (`sendVerificationRequest`),
 * rate-limited per address and globally before every send.
 *
 * Distinct provider ids (`recoup-verify` / `recoup-reset`) are required: a
 * verification code and a reset code are bound to the issuing provider
 * (`verifyCodeAndSignIn.ts`), so a shared id would let one kind of code
 * authorize the other.
 *
 * **F1 (checkpoint 4, D94, BLOCKER):** this used to be a hand-built object
 * literal with no `authorize`. `verifyCodeAndSignIn.ts`'s `verifyCodeOnly`
 * only runs the issuing provider's `authorize(params, account)` binding
 * check `if (methodProvider.type === "email" && methodProvider.authorize !==
 * undefined)` (:180-194) — with no `authorize` at all, that check was
 * skipped unconditionally, so *any* valid, unexpired code, redeemed with
 * *any* `params.email`, authenticated as the code's own account (looked up
 * solely via `verificationCode.accountId`, never compared against
 * `params.email`). A code issued to victim V, redeemed while claiming
 * attacker A's address, signed the caller in as V. Fixed by building this
 * config with the library's own `Email({...})` (`providers/Email.ts:44-56`),
 * which supplies exactly that binding check —
 * `account.providerAccountId !== params.email` throws — as its default
 * `authorize`. We must not pass our own `authorize` in the config below:
 * `Email()`'s `providerDefaults` merge (`provider_utils.ts`'s `merge`)
 * overwrites the default with whatever key is present in our config object,
 * even `authorize: undefined` (that's the library's own documented escape
 * hatch for "magic link" mode) — so simply omitting the key is what keeps
 * the real check. `Email()` itself hardcodes `id`/`maxAge`/`name` and defers
 * our overrides to a `.options` merge that only happens lazily at
 * materialization (`materializeProvider`, called deep inside
 * `signInViaProvider`) — invisible to code (and tests) that reads the
 * returned object's fields directly — so those three are re-applied
 * immediately below; that later lazy merge then re-applies the identical
 * values (a no-op) and never touches `authorize` (not one of our keys).
 */
import { ConvexError } from "convex/values";
import { generateRandomString } from "@oslojs/crypto/random";
import type { RandomReader } from "@oslojs/crypto/random";
import { Email } from "@convex-dev/auth/providers/Email";
import type { EmailConfig, GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { DataModel } from "../_generated/dataModel";
import { rateLimiter } from "./rateLimits";
import { VERIFICATION_CODE_TTL_S } from "../limits";

export type AuthMailKind = "verify" | "reset";

const CODE_ALPHABET = "0123456789";
const CODE_LENGTH = 8;
const DEFAULT_AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";

/** `@oslojs/crypto/random` needs a `RandomReader`; the Web Crypto CSPRNG backs it. */
const random: RandomReader = {
  read: (bytes) => crypto.getRandomValues(bytes as unknown as Uint8Array<ArrayBuffer>),
};

const SUBJECTS: Record<AuthMailKind, string> = {
  verify: "Your Recoup verification code",
  reset: "Your Recoup password reset code",
};

/** Fixed copy, no user-controlled text and no link (invariant: PLAN.md T05). */
function bodyFor(kind: AuthMailKind, code: string, expiresInMinutes: number): string {
  const purpose = kind === "verify" ? "verify your email address" : "reset your Recoup password";
  return (
    `Use this code to ${purpose}: ${code}\n\n` +
    `This code expires in ${expiresInMinutes} minutes. If you didn't request this, you can ignore this email.`
  );
}

/**
 * Sends one auth mail. Kept as an object (not a bare exported function) so
 * tests can `vi.spyOn(authMailTransport, "send")` — the same seam `mail.ts`
 * exposes for `agentmail.sendMessage` — instead of mocking global `fetch`.
 *
 * Same fetch shape as `profiles.ts`'s `createInboxRemote`: bearer auth
 * against `ALERTS_INBOX_ID`, and the response body is never echoed back to
 * the caller on failure (it can quote the request's auth header).
 */
export const authMailTransport = {
  async send(args: { to: string; kind: AuthMailKind; code: string; expiresInMinutes: number }): Promise<void> {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    const inboxId = process.env.ALERTS_INBOX_ID;
    if (!apiKey || !inboxId) {
      throw new ConvexError("Could not send the email right now");
    }
    const baseUrl = (process.env.AGENTMAIL_BASE_URL ?? DEFAULT_AGENTMAIL_BASE_URL).replace(/\/$/, "");

    const response = await fetch(`${baseUrl}/inboxes/${inboxId}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to: [args.to],
        subject: SUBJECTS[args.kind],
        text: bodyFor(args.kind, args.code, args.expiresInMinutes),
      }),
    });
    if (!response.ok) {
      throw new ConvexError("Could not send the email right now");
    }
  },
};

/**
 * `Email({...})` config for the verify/reset flows. `kind` picks the
 * provider id (`recoup-verify` | `recoup-reset`) and the outgoing copy;
 * everything else about the two configs is identical. Deliberately does
 * *not* pass `authorize` — see the module doc comment (F1) for why that
 * omission is what keeps the library's default account-binding check.
 */
export function authMail(kind: AuthMailKind): EmailConfig {
  const id = `recoup-${kind}`;
  const name = kind === "verify" ? "Recoup email verification" : "Recoup password reset";
  const generateVerificationToken = async () => generateRandomString(random, CODE_ALPHABET, CODE_LENGTH);

  // No explicit `<DataModel>` generic: `Email()`'s `authorize` field is a
  // contravariant function-typed property, so instantiating it with our
  // concrete `DataModel` would make `built` (and this function's declared
  // `EmailConfig` return type, which itself defaults to `GenericDataModel`)
  // mutually unassignable under `strictFunctionTypes`. Nothing here reads
  // `built.authorize`'s `account` parameter, so the default generic loses
  // nothing.
  const built = Email({
    id,
    name,
    maxAge: VERIFICATION_CODE_TTL_S,
    generateVerificationToken,
    sendVerificationRequest: (async (
      { identifier, token, expires }: { identifier: string; token: string; expires: Date },
      ctx?: GenericActionCtxWithAuthConfig<DataModel>,
    ) => {
      if (!ctx) {
        // The library always passes ctx as an undeclared second argument
        // (contract T05 g4); this only trips if something calls the hook directly.
        throw new Error("authMail.sendVerificationRequest requires ctx");
      }
      const expiresInMinutes = Math.max(1, Math.round((expires.getTime() - Date.now()) / 60_000));

      // Per-address, then deployment-wide: both are enforced before the network call.
      await rateLimiter.limit(ctx, "authMailPerEmail", { key: identifier, throws: true });
      await rateLimiter.limit(ctx, "authMailGlobal", { throws: true });

      await authMailTransport.send({ to: identifier, kind, code: token, expiresInMinutes });
    }) as EmailConfig["sendVerificationRequest"],
  });

  // `Email()` hardcodes id/maxAge/name in its own returned literal and only
  // applies our overrides via a `.options` merge the library performs lazily
  // at materialization time (see doc comment). Re-apply them here so this
  // object is already correct for anything that reads it directly (our own
  // tests included) — `built.authorize` (the real binding check) and
  // `built.sendVerificationRequest`/`built.type` are left untouched.
  return { ...built, id, name, maxAge: VERIFICATION_CODE_TTL_S, generateVerificationToken };
}
