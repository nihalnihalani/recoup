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
import { ConvexError, v } from "convex/values";
import { generateRandomString } from "@oslojs/crypto/random";
import type { RandomReader } from "@oslojs/crypto/random";
import { Email } from "@convex-dev/auth/providers/Email";
import type { EmailConfig, GenericActionCtxWithAuthConfig } from "@convex-dev/auth/server";
import type { DataModel } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { rateLimiter } from "./rateLimits";
import { providerStubMode, stubbedProviderError } from "./providerMode";
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
 * D102: the E2E harness has no real mail provider on a disposable
 * deployment, so it needs a test-only way to read back the code a signUp/
 * reset just issued. `convex/testing.ts` (tester-owned) exposes the read
 * side (`lastCodeFor(email)`); this mutation is the write side, called from
 * `authMailTransport.send` below (that transport runs inside the auth
 * *action*, with no `ctx.db` of its own, hence a mutation rather than a
 * plain write). Gated independently of the call site — even if a caller
 * forgot to check `E2E_SEED_ENABLED` first, this mutation refuses on its
 * own, and refuses unconditionally on the documented production host
 * regardless of the env var, so the check can never be satisfied there by
 * an accidental/malicious env value.
 */
export const recordE2ECode = internalMutation({
  args: { email: v.string(), code: v.string(), kind: v.union(v.literal("verify"), v.literal("reset")) },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (process.env.E2E_SEED_ENABLED !== "true") {
      throw new ConvexError("E2E seeding is disabled");
    }
    if ((process.env.CONVEX_SITE_URL ?? "").includes("cool-oyster-399")) {
      throw new ConvexError("E2E seeding is disabled");
    }
    // `kind` is accepted (and validated) to match the call site's natural
    // shape, but the capture is address-only — one row per email, latest
    // code wins, the same way a real inbox only ever has one live code.
    void args.kind;
    const key = `e2e:code:${args.email}`;
    const now = Date.now();
    const existing = await ctx.db
      .query("opsState")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { cursor: args.code, updatedAt: now });
    } else {
      await ctx.db.insert("opsState", { key, cursor: args.code, updatedAt: now });
    }
    return null;
  },
});

/**
 * Sends one auth mail. Kept as an object (not a bare exported function) so
 * tests can `vi.spyOn(authMailTransport, "send")` — the same seam `mail.ts`
 * exposes for `agentmail.sendMessage` — instead of mocking global `fetch`.
 *
 * Same fetch shape as `profiles.ts`'s `createInboxRemote`: bearer auth
 * against `ALERTS_INBOX_ID`, and the response body is never echoed back to
 * the caller on failure (it can quote the request's auth header).
 *
 * `ctx` is an undeclared second argument, the same convention
 * `sendVerificationRequest` below uses for the library's own ctx — present
 * whenever `sendVerificationRequest` calls this (it always does), absent
 * only for a direct unit-test call that never exercises the D102 path.
 */
export const authMailTransport = {
  async send(
    args: { to: string; kind: AuthMailKind; code: string; expiresInMinutes: number },
    ctx?: GenericActionCtxWithAuthConfig<DataModel>,
  ): Promise<void> {
    const e2eSeedEnabled = process.env.E2E_SEED_ENABLED === "true";
    if (e2eSeedEnabled) {
      if (!ctx) {
        throw new Error("authMailTransport.send requires ctx when E2E_SEED_ENABLED is set");
      }
      // D102: record before attempting the real send, and never swallowed —
      // if this refuses (wrong deployment), the signUp/reset should fail
      // loudly, not silently fall through to a "succeeded" state nobody
      // can read the code back from.
      await ctx.runMutation(internal.lib.authMail.recordE2ECode, {
        email: args.to,
        code: args.code,
        kind: args.kind,
      });
    }

    try {
      await sendViaProvider(args);
    } catch (err) {
      if (e2eSeedEnabled) {
        // A disposable E2E deployment has no real provider credentials
        // (no AGENTMAIL_API_KEY) — the code is already captured above, so
        // sign-up must still complete rather than fail on the mail step.
        return;
      }
      throw err;
    }
  },
};

export async function sendViaProvider(args: { to: string; kind: AuthMailKind; code: string; expiresInMinutes: number }): Promise<void> {
  // P10-OW-12: the auth-code send is an "AgentMail send" call site like any other. `authMailTransport.send`'s
  // own caller (below) already tolerates a thrown failure here when `E2E_SEED_ENABLED=true` -- the exact
  // deployment this stub is for -- by swallowing it and letting sign-up complete on the captured code alone.
  if (providerStubMode()) throw stubbedProviderError("AgentMail send", args.kind);
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
}

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

      await authMailTransport.send({ to: identifier, kind, code: token, expiresInMinutes }, ctx);
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
