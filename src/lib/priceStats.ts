/**
 * Price analytics for one product, computed from the priced observations the
 * backend returns. Pure: no React, no Convex, no clock of its own. Every figure
 * describes only the points it was given, so callers must say so when the list
 * is capped.
 */

export type PricePoint = { at: number; cents: number };

export type PriceStats = {
  count: number;
  lowest: number | null;
  highest: number | null;
  /** Mean of the points, rounded to whole cents. */
  average: number | null;
  /** (highest - lowest) / average * 100. 0 with fewer than two points. */
  swingPct: number;
  first: PricePoint | null;
  latest: PricePoint | null;
  /** When the first point was read. There is no history before it. */
  trackingSince: number | null;
  /**
   * Whole days the latest price has held: from the start of the unbroken run of
   * identical prices that ends at the latest point, until `now` (or until the
   * latest point when `now` is not given).
   */
  daysAtCurrentPrice: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function priceStats(points: PricePoint[], now?: number): PriceStats {
  if (points.length === 0) {
    return {
      count: 0,
      lowest: null,
      highest: null,
      average: null,
      swingPct: 0,
      first: null,
      latest: null,
      trackingSince: null,
      daysAtCurrentPrice: null,
    };
  }

  // Callers pass oldest first; sorting a copy keeps the result right if they do not.
  const sorted = [...points].sort((a, b) => a.at - b.at);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];

  let lowest = first.cents;
  let highest = first.cents;
  let sum = 0;
  for (const point of sorted) {
    if (point.cents < lowest) lowest = point.cents;
    if (point.cents > highest) highest = point.cents;
    sum += point.cents;
  }
  const mean = sum / sorted.length;

  let runStart = latest;
  for (let i = sorted.length - 1; i >= 0 && sorted[i].cents === latest.cents; i--) runStart = sorted[i];
  const until = Math.max(now ?? latest.at, latest.at);

  return {
    count: sorted.length,
    lowest,
    highest,
    average: Math.round(mean),
    swingPct: sorted.length >= 2 && mean > 0 ? ((highest - lowest) / mean) * 100 : 0,
    first,
    latest,
    trackingSince: first.at,
    daysAtCurrentPrice: Math.floor((until - runStart.at) / DAY_MS),
  };
}

export type BoughtVerdictKind =
  | "claim_now"
  | "asked"
  | "promised"
  | "recovered"
  | "hold"
  | "above_paid"
  | "window_closed"
  | "no_price";

export type VerdictTone = "green" | "violet" | "yellow" | "gray" | "red";

export type BoughtVerdict = {
  kind: BoughtVerdictKind;
  label: string;
  /** The same verdict in two or three words, for tight chips. */
  shortLabel: string;
  reason: string;
  tone: VerdictTone;
};

/** A drop is worth claiming from $1 or 2% of the paid price, whichever is larger. */
export function claimThresholdCents(paidCents: number): number {
  return Math.max(100, paidCents * 0.02);
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** "9 days", "5 hours", "42 minutes": the largest unit of a positive duration. */
function timeLeft(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (minutes >= 1440) return unit(Math.floor(minutes / 1440), "day");
  if (minutes >= 60) return unit(Math.floor(minutes / 60), "hour");
  return unit(minutes, "minute");
}

/**
 * What a bought item's price means for its owner right now. Deterministic: the
 * same inputs always give the same verdict. A live claim outranks the price,
 * because once the store has been asked the next move is the store's.
 */
export function boughtVerdict(args: {
  paidCents: number;
  latestCents?: number;
  windowEndsAt?: number;
  claimStatus?: string;
  now: number;
  /** ISO currency for the amounts in `reason`. Defaults to USD. */
  currency?: string;
}): BoughtVerdict {
  const { paidCents, latestCents, windowEndsAt, claimStatus, now } = args;
  const currency = args.currency ?? "USD";

  if (latestCents === undefined) {
    return { kind: "no_price", label: "No price yet", shortLabel: "No price yet", reason: "No price has been read for this item yet.", tone: "gray" };
  }
  if (claimStatus === "confirmed") {
    return { kind: "recovered", label: "Back on card", shortLabel: "Back on card", reason: "The store paid the difference back.", tone: "green" };
  }
  if (claimStatus === "promised") {
    return {
      kind: "promised",
      label: "Promised", shortLabel: "Promised",
      reason: "The store agreed to pay the difference. It is not back on your card yet.",
      tone: "yellow",
    };
  }
  if (claimStatus === "queued" || claimStatus === "sent" || claimStatus === "packet") {
    return { kind: "asked", label: "Asked", shortLabel: "Asked", reason: "The store has been asked for the difference. Waiting on its reply.", tone: "violet" };
  }

  const dropCents = paidCents - latestCents;
  const windowKnown = windowEndsAt !== undefined;
  const windowOpen = !windowKnown || windowEndsAt > now;

  if (dropCents > 0 && dropCents >= claimThresholdCents(paidCents) && windowOpen) {
    return {
      kind: "claim_now",
      label: "Claim now", shortLabel: "Claim now",
      reason: windowKnown
        ? `${money(dropCents, currency)} below what you paid, with ${timeLeft(windowEndsAt - now)} left to claim.`
        : `${money(dropCents, currency)} below what you paid. The store's claim window is unknown, so ask soon.`,
      tone: "green",
    };
  }
  if (dropCents > 0 && !windowOpen) {
    return {
      kind: "window_closed",
      label: "Window closed", shortLabel: "Window closed",
      reason: `${money(dropCents, currency)} below what you paid, but the store's claim window has ended.`,
      tone: "gray",
    };
  }
  if (dropCents < 0) {
    return {
      kind: "above_paid",
      label: "Price went up since you bought", shortLabel: "Price went up",
      reason: `Now ${money(-dropCents, currency)} more than you paid. Nothing to claim.`,
      tone: "red",
    };
  }
  return {
    kind: "hold",
    label: "Holding at what you paid", shortLabel: "Holding",
    reason:
      dropCents > 0
        ? `Only ${money(dropCents, currency)} below what you paid, too small to claim.`
        : "Same price as when you bought. Nothing to claim.",
    tone: "gray",
  };
}
