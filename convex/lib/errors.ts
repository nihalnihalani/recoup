/**
 * Sanitizes a raw internal error string (typically `String(err)` caught at a
 * processing boundary) into one of a small set of user-safe categories
 * (D58). `processedEvents.lastError` keeps the raw message server-side for
 * operators; `processedEvents.errorSummary`, produced by this function, is
 * the only thing `purchases.board`'s "needs attention" list ever shows -- it
 * must never leak a stack trace, an API payload, or any other internal
 * detail back to the user.
 *
 * Pure and dependency-free so it can be unit-tested directly and reused by
 * every writer of `processedEvents.lastError`. Order matters: patterns are
 * checked most specific to least, since some raw messages (e.g. the OpenAI
 * "no parsed output" error, which names the provider but is really an
 * extraction failure) would otherwise match more than one bucket.
 */
export function sanitizeError(msg: string | undefined): string {
  const s = (msg ?? "").toLowerCase();
  if (!s) return "Something went wrong";

  // The LLM call ran but its output didn't parse/validate against our schema.
  if (/no parsed output|zoderror|zod error/.test(s)) {
    return "Extraction failed";
  }

  // The call to an upstream provider (OpenAI, AgentMail, Firecrawl, ...)
  // itself failed: network, auth, rate limit, or a 5xx.
  if (
    /openai|agentmail|firecrawl|rate.?limit|connection|econnrefused|econnreset|etimedout|fetch failed|\bnetwork\b|\btimeout\b|\b5\d\d\b|api key is not set/.test(
      s,
    )
  ) {
    return "Provider error";
  }

  // One of our own boundary assertions (convex/lib/money.ts and friends)
  // rejected the data.
  if (/must be|out of range|not a valid|idempotency conflict|invalid/.test(s)) {
    return "Invalid data";
  }

  return "Something went wrong";
}
