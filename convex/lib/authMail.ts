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
 */
import { ConvexError } from "convex/values";
import { generateRandomString } from "@oslojs/crypto/random";
import type { RandomReader } from "@oslojs/crypto/random";
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
 * everything else about the two configs is identical.
 */
export function authMail(kind: AuthMailKind): EmailConfig {
  return {
    id: `recoup-${kind}`,
    type: "email",
    name: kind === "verify" ? "Recoup email verification" : "Recoup password reset",
    maxAge: VERIFICATION_CODE_TTL_S,
    generateVerificationToken: async () => generateRandomString(random, CODE_ALPHABET, CODE_LENGTH),
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
  };
}
