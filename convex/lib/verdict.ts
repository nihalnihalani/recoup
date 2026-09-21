/**
 * The verdict line (W1b): "should I buy now?" answered from OUR OWN price
 * history plus the page's claimed "was" price. Pure and deterministic; the
 * model never produces a verdict, it only reads numbers off a page.
 *
 * All comparisons are integer arithmetic on cents so a boundary is a boundary
 * and not a floating-point accident.
 */

export type VerdictLabel =
  | "good_price"
  | "fair"
  | "wait"
  | "inflated_discount"
  | "not_enough_history"
  | "unknown";

export type VerdictInput = {
  /** Latest accepted price, or null when we have never read one. */
  currentCents: number | null;
  /** The page's claimed "was"/list price from the latest accepted check. */
  listCents: number | null;
  /** Every accepted observation we hold, any order; normally includes the current one. */
  history: Array<{ observedAt: number; cents: number }>;
  now: number;
  /** ISO 4217 code for the amounts in `reason`; USD when not known yet. */
  currency?: string;
};

export type Verdict = { label: VerdictLabel; reason: string };

export const VERDICT_LABELS: ReadonlyArray<VerdictLabel> = [
  "good_price",
  "fair",
  "wait",
  "inflated_discount",
  "not_enough_history",
  "unknown",
];

const DAY_MS = 86_400_000;
/** Below either bar the verdict is "not enough history", never a guess. */
export const MIN_OBSERVATIONS = 3;
export const MIN_SPAN_DAYS = 7;
/** The inflated-discount call needs less: two sightings at least two days apart. */
export const MIN_LIST_OBSERVATIONS = 2;
export const MIN_LIST_SPAN_DAYS = 2;

export function formatCents(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function formatDay(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Twice the median, so an even-length history stays in integers. */
function doubledMedian(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] * 2 : sorted[mid - 1] + sorted[mid];
}

export function verdict(input: VerdictInput): Verdict {
  const { currentCents, now } = input;
  const money = (cents: number) => formatCents(cents, input.currency);
  if (currentCents === null) {
    return { label: "unknown", reason: "We have not been able to read a price for this yet." };
  }

  const history = input.history
    .filter((h) => Number.isFinite(h.cents) && Number.isFinite(h.observedAt) && h.observedAt <= now)
    .sort((a, b) => a.observedAt - b.observedAt);
  const spanMs = history.length === 0 ? 0 : history[history.length - 1].observedAt - history[0].observedAt;
  // A "was" price at or below today's price is not a discount claim at all.
  const listCents = input.listCents !== null && input.listCents > currentCents ? input.listCents : null;

  if (
    listCents !== null &&
    history.length >= MIN_LIST_OBSERVATIONS &&
    spanMs >= MIN_LIST_SPAN_DAYS * DAY_MS
  ) {
    // "Seen" means within 2% of the claimed price, or above it.
    const sawListPrice = history.some((h) => h.cents * 100 >= listCents * 98);
    const sawCurrentOrLower = history.some((h) => h.cents <= currentCents);
    if (!sawListPrice && sawCurrentOrLower) {
      return {
        label: "inflated_discount",
        reason: `The 'was' price of ${money(listCents)} has not been seen since we started watching on ${formatDay(history[0].observedAt)}.`,
      };
    }
  }

  if (history.length < MIN_OBSERVATIONS || spanMs < MIN_SPAN_DAYS * DAY_MS) {
    if (listCents !== null) {
      const percentOff = Math.round(((listCents - currentCents) * 100) / listCents);
      return {
        label: "not_enough_history",
        reason: `The store claims ${percentOff}% off ${money(listCents)}, and we have not watched long enough to check that yet.`,
      };
    }
    return {
      label: "not_enough_history",
      reason: `It is ${money(currentCents)} today; we need about a week of prices before we can say if that is good.`,
    };
  }

  const sorted = history.map((h) => h.cents).sort((a, b) => a - b);
  const lowest = sorted[0];
  const median2 = doubledMedian(sorted);
  const since = formatDay(history[0].observedAt);

  if (currentCents * 100 <= lowest * 101) {
    return {
      label: "good_price",
      reason:
        currentCents <= lowest
          ? `${money(currentCents)} is the lowest price we have seen since ${since}.`
          : `${money(currentCents)} is right next to the lowest price we have seen since ${since}, ${money(lowest)}.`,
    };
  }
  if (currentCents * 200 > median2 * 105) {
    return {
      label: "wait",
      reason: `${money(currentCents)} is above the usual price of ${money(Math.round(median2 / 2))}; it has been as low as ${money(lowest)}.`,
    };
  }
  return {
    label: "fair",
    reason: `${money(currentCents)} is close to the usual price of ${money(Math.round(median2 / 2))}; the lowest we have seen is ${money(lowest)}.`,
  };
}
