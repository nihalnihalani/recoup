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

/** `cleanLine`, refusing (not truncating) a value longer than `max`: the user typed it, so tell them. */
export function boundedLine(s: string, label: string, max: number): string {
  const line = cleanLine(s);
  if (line.length > max) throw new ConvexError(`${label} must be at most ${max} characters`);
  return line;
}
