import type { Tone } from "../components/watching/parts";

/** Mirrors `convex/schema.ts`'s `mailStatus`. */
export type DropStatus = "claimed" | "queued" | "sent" | "failed" | "unknown" | "suppressed";

/**
 * Pure mapping from one `mailLog` drop row's server fields to its user-facing label and tone
 * (T08). Never labels anything "Emailed" except a truly `sent` row (Invariant 8: unknown never
 * renders as sent). `error` already carries the plain-language reason for `suppressed` (set
 * server-side from `REASON_MESSAGES`/`GATE_MESSAGES`) and `failed` rows, so it is rendered
 * as-is rather than re-derived from the `reason` enum client-side.
 */
export function dropChip(drop: {
  status: DropStatus;
  error: string | null;
  providerStatus: string | null;
}): { label: string; tone: Tone } {
  switch (drop.status) {
    case "claimed":
    case "queued":
      return { label: "Sending…", tone: "busy" };
    case "sent":
      return drop.providerStatus === "complained"
        ? { label: "Marked as spam", tone: "wait" }
        : { label: "Emailed", tone: "good" };
    case "unknown":
      return { label: "Delivery unknown", tone: "wait" };
    case "suppressed":
      return { label: drop.error ?? "Not emailed", tone: "muted" };
    case "failed":
      return { label: drop.error ?? "Delivery failed", tone: "bad" };
  }
}
