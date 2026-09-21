/**
 * The verdict line (W1b): "should I buy now?" answered from OUR OWN price
 * history plus the page's claimed "was" price. Pure and deterministic; the
 * model never produces a verdict, it only reads numbers off a page.
 *
 * All comparisons are integer arithmetic on cents so a boundary is a boundary
 * and not a floating-point accident.
 *
 * Invariant (P04): nothing in this file ever creates a claim or sends an
 * alert, and neither exported verdict shape (`Verdict`, `QualifiedVerdict`)
 * carries any field that could be mistaken for one — both are asserted by
 * `verdict.test.ts`. A verdict is a read-only opinion about a price; only a
 * user's own action ever opens a claim or triggers a send.
 */
import { MIN_OUTLIER_POINTS } from "./shopsavvy";

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
  /**
   * Dated prices from ShopSavvy for the same product (W1b). Our own history
   * starts the day a watch starts, so this is what lets a new watch say
   * something true instead of "not enough history yet". It is weaker evidence:
   * it is only read when our own history is too thin, and the reason always
   * names the source.
   */
  market?: Array<{ observedAt: number; cents: number }>;
  /**
   * When the latest accepted price was actually observed (`watches.lastObservedAt`
   * in the schema T12 adds; not the same as `now`, which is "when this verdict
   * is being computed"). When this is older than `STALE_PRICE_MS`, the verdict
   * is "unknown" regardless of what the stale price would otherwise say —
   * comparing today's decision against a price that might no longer hold is
   * not a comparison this function will make.
   */
  priceObservedAt?: number;
};

export type Verdict = { label: VerdictLabel; reason: string };

/**
 * `verdict()`'s output plus a structured signal for the UI: `qualified` is
 * true whenever the label rests on weaker evidence than a normal own-history
 * comparison — no price yet, a stale price, not enough history (ours or
 * ShopSavvy's), or a label computed from ShopSavvy's third-party history
 * instead of our own reading of the store. `qualifiedReason` is a short
 * human-readable note the UI can show next to the label; it is null exactly
 * when `qualified` is false.
 *
 * This is a strictly additive companion to `verdict()`, not a replacement:
 * `verdict()` keeps returning exactly `{ label, reason }` so every existing
 * caller (`convex/watches.ts`'s `summarise()`, validated by `schema.ts`'s
 * `verdictValidator`) is unaffected. See this task's final report for the
 * one-line schema addendum (`qualified`, `qualifiedReason` on
 * `verdictValidator`) a future task needs before wiring this in.
 */
export type QualifiedVerdict = Verdict & { qualified: boolean; qualifiedReason: string | null };

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
/**
 * Duplicated from `convex/limits.ts`'s `STALE_PRICE_MS` rather than imported: this module stays a
 * dependency-free pure function (its only import is the sibling `shopsavvy.ts` outlier constant),
 * and `limits.ts` did not exist with this constant at the time this task ran. Whoever wires
 * `priceObservedAt` through from `convex/watches.ts` (T12) should import the shared `limits.ts`
 * value there and keep this local copy equal to it.
 */
const STALE_PRICE_MS = 3 * DAY_MS;

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

/**
 * A verdict from third-party history, used only when our own is too thin. Needs
 * at least `MIN_OUTLIER_POINTS` points — the same floor `shopsavvy.ts`'s
 * `withoutOutliers` needs before it actually filters a distribution — so a
 * market series too thin for outlier filtering to have run cannot produce a
 * confident answer either. Future-dated points are dropped first, mirroring
 * the filter applied to our own history, and always says where the prices
 * came from.
 */
function fromMarket(
  currentCents: number,
  market: Array<{ observedAt: number; cents: number }>,
  now: number,
  money: (cents: number) => string,
  formatDay: (ms: number) => string,
): Verdict | null {
  const valid = market.filter(
    (p) => Number.isFinite(p.cents) && Number.isFinite(p.observedAt) && p.observedAt <= now,
  );
  if (valid.length < MIN_OUTLIER_POINTS) return null;
  const sorted = [...valid].sort((a, b) => a.observedAt - b.observedAt);
  const prices = sorted.map((p) => p.cents).sort((a, b) => a - b);
  const lowest = prices[0];
  const highest = prices[prices.length - 1];
  const since = formatDay(sorted[0].observedAt);
  // A flat range says nothing about whether today is a good day to buy.
  if (highest === lowest) return null;

  if (currentCents * 100 <= lowest * 101) {
    return {
      label: "good_price",
      reason: `${money(currentCents)} is at or below the lowest price ShopSavvy has recorded since ${since} (${money(lowest)} to ${money(highest)}).`,
    };
  }
  const median2 = doubledMedian(prices);
  if (currentCents * 2 * 100 > median2 * 105) {
    return {
      label: "wait",
      reason: `ShopSavvy has recorded ${money(lowest)} to ${money(highest)} since ${since}, so ${money(currentCents)} is above the usual price.`,
    };
  }
  return {
    label: "fair",
    reason: `${money(currentCents)} is in the usual range ShopSavvy has recorded since ${since} (${money(lowest)} to ${money(highest)}).`,
  };
}

type VerdictSource = "own_history" | "market" | "none";

/**
 * The single source of truth for every threshold in this file. `verdict()` and
 * `verdictWithQualifier()` both call this and never duplicate its logic, so
 * the two can never drift against each other or against this file's tests.
 */
function verdictCore(input: VerdictInput): Verdict & { source: VerdictSource } {
  const { currentCents, now, priceObservedAt } = input;
  const money = (cents: number) => formatCents(cents, input.currency);
  if (currentCents === null) {
    return { label: "unknown", reason: "We have not been able to read a price for this yet.", source: "none" };
  }

  // Checked before any comparison: a stale price is not one we will judge against today's history,
  // no matter how much history there is.
  if (priceObservedAt !== undefined && Number.isFinite(priceObservedAt) && now - priceObservedAt > STALE_PRICE_MS) {
    const days = Math.floor((now - priceObservedAt) / DAY_MS);
    return {
      label: "unknown",
      reason: `The last price we could read was ${days} days ago; we will judge it again after the next successful check.`,
      source: "none",
    };
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
        source: "own_history",
      };
    }
  }

  if (history.length < MIN_OBSERVATIONS || spanMs < MIN_SPAN_DAYS * DAY_MS) {
    const marketVerdict = fromMarket(currentCents, input.market ?? [], now, money, formatDay);
    if (marketVerdict) return { ...marketVerdict, source: "market" };
    if (listCents !== null) {
      const percentOff = Math.round(((listCents - currentCents) * 100) / listCents);
      return {
        label: "not_enough_history",
        reason: `The store claims ${percentOff}% off ${money(listCents)}, and we have not watched long enough to check that yet.`,
        source: "none",
      };
    }
    return {
      label: "not_enough_history",
      reason: `It is ${money(currentCents)} today; we need about a week of prices before we can say if that is good.`,
      source: "none",
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
      source: "own_history",
    };
  }
  if (currentCents * 200 > median2 * 105) {
    return {
      label: "wait",
      reason: `${money(currentCents)} is above the usual price of ${money(Math.round(median2 / 2))}; it has been as low as ${money(lowest)}.`,
      source: "own_history",
    };
  }
  return {
    label: "fair",
    reason: `${money(currentCents)} is close to the usual price of ${money(Math.round(median2 / 2))}; the lowest we have seen is ${money(lowest)}.`,
    source: "own_history",
  };
}

/**
 * Unchanged from before this task: exactly `{ label, reason }`, so every
 * existing caller keeps working with zero changes. See `verdictWithQualifier`
 * for the same decision plus a structured uncertainty signal.
 */
export function verdict(input: VerdictInput): Verdict {
  const { label, reason } = verdictCore(input);
  return { label, reason };
}

/**
 * Same decision as `verdict()` (never duplicated, never able to drift from
 * it), plus `qualified`/`qualifiedReason` so a UI can render uncertainty
 * instead of presenting every label with equal confidence:
 *
 *  - `unknown` and `not_enough_history` are always qualified: there is either
 *    no price, a stale price, or not enough evidence (ours or ShopSavvy's) to
 *    trust yet.
 *  - `good_price` / `fair` / `wait` computed from ShopSavvy's third-party
 *    history (our own history was too thin) are qualified: the label sounds
 *    as confident as an own-history one, but it is evidence about the
 *    product from other stores, not our own reading of this listing.
 *  - `good_price` / `fair` / `wait` computed from sufficient own history, and
 *    `inflated_discount` (which only ever uses our own history), are not
 *    qualified.
 */
export function verdictWithQualifier(input: VerdictInput): QualifiedVerdict {
  const { label, reason, source } = verdictCore(input);
  if (label === "unknown" || label === "not_enough_history") {
    return { label, reason, qualified: true, qualifiedReason: reason };
  }
  if (source === "market") {
    return {
      label,
      reason,
      qualified: true,
      qualifiedReason: "Based on ShopSavvy's third-party price history for this product, not Recoup's own reading of this store.",
    };
  }
  return { label, reason, qualified: false, qualifiedReason: null };
}
