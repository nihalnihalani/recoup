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
 * Text as a reader sees it: markdown links and images reduced to their label,
 * emphasis markers and escapes dropped, typographic quotes and dashes folded to
 * ASCII. A model quoting a rendered page will not reproduce `**`, `[x](url)` or
 * curly quotes, so both sides are compared in this form. Wording is untouched:
 * a paraphrase still fails.
 */
export function normalizeForMatch(s: string): string {
  return normalizeWhitespace(
    s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1")
      .replace(/[*_`~]+/g, "")
      .replace(/^\s{0,3}(#{1,6}|>|[-+]|\d+\.)\s+/gm, "")
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201F\u2033]/g, '"')
      .replace(/[\u2010-\u2015]/g, "-")
      .replace(/\u00A0/g, " "),
  );
}

/** Shortest normalized passage that counts as evidence (D45). */
export const MIN_PASSAGE_CHARS = 40;

/**
 * Returns the start index of `passage` inside `markdown` after both are reduced
 * to reader-visible text (see `normalizeForMatch`), or `null` if `passage` is shorter than
 * `MIN_PASSAGE_CHARS` after normalization or does not appear verbatim in `markdown`.
 */
export function verifyPassage(markdown: string, passage: string): number | null {
  const normMarkdown = normalizeForMatch(markdown);
  const normPassage = normalizeForMatch(passage);
  if (normPassage.length < MIN_PASSAGE_CHARS) return null;
  const idx = normMarkdown.indexOf(normPassage);
  return idx === -1 ? null : idx;
}
