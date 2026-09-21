import { ConvexError } from "convex/values";

/**
 * Removes every control character (C0, DEL and C1: CR, LF, NUL, escape and the
 * rest). Anything that can end up in a mail header, a subject or a one-line
 * label goes through this at write time (pre-launch review B1, LOW "subject
 * injection").
 */
export function stripControl(s: string): string {
  return s.replace(/\p{Cc}/gu, "");
}

/** One clean line: control characters out, then trimmed. */
export function cleanLine(s: string): string {
  return stripControl(s).trim();
}

/**
 * A label a person would recognise, or null. A page we cannot read often yields a name that survives
 * `cleanLine` but says nothing: ".", "-", "|", "()". Storing one of those over a readable default
 * leaves a watch card titled "." (seen live on 2026-09-20), so a name needs a letter or a digit.
 */
export function meaningfulName(s: string | undefined): string | null {
  if (s === undefined) return null;
  const line = cleanLine(s);
  return /[\p{L}\p{N}]/u.test(line) ? line : null;
}

/** `cleanLine`, refusing (not truncating) a value longer than `max`: the user typed it, so tell them. */
export function boundedLine(s: string, label: string, max: number): string {
  const line = cleanLine(s);
  if (line.length > max) throw new ConvexError(`${label} must be at most ${max} characters`);
  return line;
}

/**
 * A length-only ceiling, refusing (not truncating or cleaning) a value
 * longer than `max`. Unlike `boundedLine`, this does not strip control
 * characters or trim -- for callers that already control the string's shape
 * (ledger evidence, claim notes, idempotency keys) and just need a cap
 * (P08, T16).
 */
export function assertMaxChars(s: string, label: string, max: number): string {
  if (s.length > max) throw new ConvexError(`${label} must be at most ${max} characters`);
  return s;
}
