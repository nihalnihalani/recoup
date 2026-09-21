import { remainingLabel } from "../../lib/ui";

/** "12m ago" from two epoch times. */
export function ago(now: number, at: number): string {
  const diff = now - at;
  return diff < 60_000 ? "just now" : `${remainingLabel(diff)} ago`;
}
