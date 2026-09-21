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

/** Minimum normalized passage length (D45): shorter quotes are too weak to trust as evidence. */
export const MIN_PASSAGE_LENGTH = 40;

/**
 * Returns the start index of `passage` inside `markdown` after whitespace
 * normalization of both strings, or `null` if `passage` is shorter than
 * `MIN_PASSAGE_LENGTH` normalized characters or does not appear verbatim in
 * `markdown`.
 */
export function verifyPassage(markdown: string, passage: string): number | null {
  const normMarkdown = normalizeWhitespace(markdown);
  const normPassage = normalizeWhitespace(passage);
  if (normPassage.length < MIN_PASSAGE_LENGTH) return null;
  const idx = normMarkdown.indexOf(normPassage);
  return idx === -1 ? null : idx;
}
