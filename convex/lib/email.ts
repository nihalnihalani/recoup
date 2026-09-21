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
