/**
 * Email address normalisation shared by the guarded auth `authorize`
 * (`../auth.ts`) and the Password provider's own `profile` callback (D67,
 * T05).
 *
 * Trim + lowercase + a format check + a length cap, nothing more: no
 * plus/dot folding, so `a+alerts@x.com` and `a@x.com` are distinct accounts
 * (documented limitation, D67 — per-mailbox abuse is bounded elsewhere by
 * the global `drop_email`/`claim_email` switches and the per-address auth
 * mail limit, not by address canonicalisation).
 */
import { ConvexError } from "convex/values";

/** Matches the library's own permissive shape; rejects only the obviously malformed. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** RFC 5321 4.5.3.1.3 (mailbox length): generous, but bounds every index/read keyed on email. */
const MAX_EMAIL_CHARS = 254;

/**
 * Trims, lowercases and validates `raw` as an email address.
 *
 * Accepts `unknown` because it is called directly on `params.email` from a
 * `signIn()` call, which is `Partial<Record<string, Value | undefined>>` —
 * never assume the client sent a string.
 */
export function normalizeEmail(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ConvexError("Enter a valid email address");
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_CHARS || !EMAIL_RE.test(trimmed)) {
    throw new ConvexError("Enter a valid email address");
  }
  return trimmed;
}

/**
 * Validates `raw` as exactly one email address within `maxChars` (D116):
 * shared by `drafts.update`'s `to` field and `policies.confirm`'s
 * `contactEmail`. Unlike `normalizeEmail` (the auth path, a fixed 254-char
 * RFC cap and silent lowercasing of an account identifier) this keeps the
 * caller's original casing and takes its own caller-supplied cap -- an
 * address a user types into a draft or a policy's contact field is not an
 * account identifier, so forcing it to lowercase would only make a typo
 * harder to see if they need to fix it. A comma or semicolon is rejected
 * outright (on top of `EMAIL_RE`'s own single-address shape) so
 * "one@x.com, two@x.com" can never pass as a single recipient.
 */
export function parseSingleEmail(raw: unknown, maxChars: number): string {
  if (typeof raw !== "string") {
    throw new ConvexError("Enter a single valid email address");
  }
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > maxChars ||
    /[,;]/.test(trimmed) ||
    !EMAIL_RE.test(trimmed)
  ) {
    throw new ConvexError("Enter a single valid email address");
  }
  return trimmed;
}
