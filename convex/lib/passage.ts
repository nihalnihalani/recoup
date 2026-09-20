/**
 * Passage verification (D17): a policy snapshot's `passage` is trusted only
 * when it appears verbatim in the scraped markdown, modulo whitespace
 * differences introduced by markdown rendering (line wraps, collapsed
 * spaces, etc).
 */

/** Collapse all whitespace runs to a single space and trim the ends. */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Returns the start index of `passage` inside `markdown` after whitespace
 * normalization of both strings, or `null` if `passage` is empty (after
 * normalization) or does not appear verbatim in `markdown`.
 */
export function verifyPassage(markdown: string, passage: string): number | null {
  const normMarkdown = normalizeWhitespace(markdown);
  const normPassage = normalizeWhitespace(passage);
  if (normPassage.length === 0) return null;
  const idx = normMarkdown.indexOf(normPassage);
  return idx === -1 ? null : idx;
}
