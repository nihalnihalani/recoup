/**
 * Deterministic key derivation for INTERNAL ledger-event callers whose
 * natural idempotency key embeds an external, unbounded string.
 *
 * D112 checkpoint 6a, finding 6a-1: `claims.MAX_IDEMPOTENCY_KEY_CHARS` (128)
 * used to be enforced on every call into `claims.applyEvent`, including the
 * two internal callers that build a key out of an RFC Message-ID
 * (`replies.apply`'s `${claimId}:msg:${messageId}`, `intake.applyRefund`'s
 * `${messageIdOrPasteHash}:${itemId}:${i}`) -- a Message-ID has no length
 * ceiling in the RFC and real forwarders produce ones well past 90 chars, so
 * a long enough one made a credit reply or a forwarded refund permanently
 * unrecordable. DECISION (D112): the 128-char bound applies only to
 * client-supplied keys taken directly by the public mutations
 * (`claims.confirmCredit`/`claims.recordLaterDebit`); an internal caller
 * instead derives a key through `internalKey` below, whose length is fixed
 * regardless of its inputs.
 *
 * sha-256 over the parts joined with a single space, hex-encoded, first 32
 * characters kept (128 bits of a 256-bit digest). D38: idempotency keys are
 * scoped to one claim's own `ledgerEvents` (`by_claim_key` is
 * `[claimId, idempotencyKey]`), so the collision space this needs to cover
 * is "two distinct facts recorded against the same claim", never global --
 * 128 bits is far more than enough there.
 *
 * Uses the platform Web Crypto API (`crypto.subtle`), not a hand-rolled
 * hash: `idempotency.test.ts` asserts `crypto.subtle` is present under
 * convex-test's `edge-runtime` vitest environment, and it is documented
 * (Convex's own docs and changelog) to be available in the real deployed
 * mutation/query/action runtime (V8 isolates with WebCrypto, the same
 * primitive `@convex-dev/rate-limiter` and other components rely on) --
 * there is no runtime here that lacks it, so no synchronous fallback
 * (FNV-1a or otherwise) is carried as dead code.
 *
 * `crypto.subtle.digest` is inherently asynchronous (it returns a
 * `Promise<ArrayBuffer>` in every environment, browser or server); both
 * production callers (`replies.apply`, an `internalMutation` handler, and
 * `intake.applyRefund`, called from the `internalMutation` handler
 * `applyExtraction`) are already `async` functions that can `await` this.
 */
export async function internalKey(...parts: string[]): Promise<string> {
  const data = new TextEncoder().encode(parts.join(" "));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}
