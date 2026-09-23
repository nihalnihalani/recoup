import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { AreaChart } from "../charts/AreaChart";
import { fmt } from "../../lib/money";
import { day, errorText, secondaryButtonClass, useNow } from "../../lib/ui";
import { Chip, IconTile, smallLabelClass } from "./parts";
import { storeInfo } from "../../lib/stores";

type Watch = FunctionReturnType<typeof api.watches.list>[number];
type Market = NonNullable<Watch["market"]>;
type LookupState = NonNullable<Watch["marketState"]>;

/** Where the lookup stands, in words (P03-A). A `Record`, so a new state is a compile error until it has words. */
const STATE_COPY: Readonly<Record<LookupState, string | null>> = {
  not_configured: "Earlier prices from ShopSavvy aren't available on this deployment.",
  queued: "Looking up earlier prices from ShopSavvy…",
  running: "Looking up earlier prices from ShopSavvy…",
  success: null,
  empty_result: "ShopSavvy has no earlier prices for this product.",
  retryable_failure: "The lookup of earlier prices hit a problem. Recoup tries again on its own.",
  terminal_failure: "The lookup of earlier prices failed.",
};

/** `market.refresh` refusals, in words. Unknown reasons fall back to a neutral line. */
const REFUSAL_COPY: Readonly<Record<string, string>> = {
  budget: "Today's lookup budget is used up. Try again tomorrow.",
  too_recent: "These prices were looked up recently. You can look again later.",
  in_flight: "A lookup is already running.",
  retryable_backoff: "Recoup will retry this lookup on its own shortly.",
  not_configured: "Earlier prices from ShopSavvy aren't available on this deployment.",
  archived: "This watch is archived, so it is not looked up.",
  bought: "This item is bought, so it is not looked up.",
  deleted: "This account is being deleted.",
};

/**
 * The lookup's state line and, when `market.refresh` would accept it, a "Try again" (P03-A): empty_result,
 * terminal_failure, a retryable_failure past its backoff, and a success old enough to refresh. Queued and running
 * show "Looking up…" with no button.
 */
function LookupStatus({ watch }: { watch: Watch }) {
  const refresh = useMutation(api.market.refresh);
  const now = useNow();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const state = watch.marketState;
  if (state === null) return null;
  const line = STATE_COPY[state];
  const canRetry = watch.marketRefreshableAt !== null && watch.marketRefreshableAt <= now;

  async function retry() {
    if (inFlight.current) return;
    inFlight.current = true;
    setMessage(null);
    setBusy(true);
    try {
      const result = await refresh({ watchId: watch._id });
      if (!result.scheduled) setMessage(REFUSAL_COPY[result.reason ?? ""] ?? "The lookup was not started.");
    } catch (caught) {
      setMessage(errorText(caught));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  if (line === null && !canRetry && message === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      {line !== null && (
        <p role={state === "queued" || state === "running" ? "status" : undefined} className="text-gray-600">
          {line}
        </p>
      )}
      {canRetry && (
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void retry()}>
          {busy ? "Starting…" : state === "success" ? "Look up again" : "Try again"}
        </button>
      )}
      {message !== null && (
        <p role="status" className="text-gray-700">
          {message}
        </p>
      )}
    </div>
  );
}

function HistoryIcon({ className = "size-[18px]" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <path d="M3 12a9 9 0 1 0 3-6.7" strokeLinecap="round" />
      <path d="M3 4v4h4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7v5l3.5 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The cheapest point, with the store and day it was seen, so the claim can be checked. */
function lowestPoint(market: Market) {
  let best: Market["points"][number] | null = null;
  for (const point of market.points) {
    if (best === null || point.cents < best.cents) best = point;
  }
  return best;
}

function storeName(retailer: string | null): string | null {
  if (retailer === null) return null;
  // ShopSavvy sends either a label ("Best Buy") or a bare host when it has none.
  return retailer.includes(".") ? storeInfo(retailer).name : retailer;
}

/**
 * Prices recorded before this watch existed, from ShopSavvy. Deliberately a separate block from the
 * card's own chart: `spark` is what Recoup read itself and is the only evidence that opens a claim
 * or sends an alert, while this is a third party's record, shown so a shopper can see whether the
 * thing has ever been cheaper than it is today. Every number here names its source and its date.
 */
export function MarketHistory({ watch }: { watch: Watch }) {
  const market = watch.market;
  // No history and no lookup state: nothing has happened yet, so say nothing.
  if (market === null && watch.marketState === null) return null;

  const currency = watch.currency ?? "USD";
  const money = (cents: number) => fmt(cents, currency);

  if (market === null || market.points.length === 0) {
    // P03-A: a state is shown even with no note, so queued, running and not_configured are visible too.
    const note = market?.note ?? null;
    return (
      <section className="space-y-2 rounded-xl border border-dashed border-gray-200 p-4" aria-label="Price history from ShopSavvy">
        {note !== null && <p className="text-sm text-gray-600">{note}</p>}
        <LookupStatus watch={watch} />
      </section>
    );
  }

  const low = lowestPoint(market);
  const lowStore = low === null ? null : storeName(low.retailer);
  const current = watch.lastCents;
  // The question a shopper actually has: is today's price the good one, or has it been cheaper?
  const beatenBy = current !== null && low !== null && low.cents < current ? current - low.cents : null;
  const series = market.points.map((p) => ({ at: p.observedAt, value: p.cents }));

  return (
    <section className="space-y-3 rounded-xl bg-gray-50 p-4" aria-label="Price history from ShopSavvy">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <IconTile>
            <HistoryIcon />
          </IconTile>
          <div>
            <p className="text-sm font-semibold text-gray-900">Before you started watching</p>
            <p className="text-xs text-gray-600">
              {market.points.length} price{market.points.length === 1 ? "" : "s"} recorded since {day(market.since)}
            </p>
          </div>
        </div>
        <Chip>via ShopSavvy</Chip>
      </div>

      <AreaChart
        series={series}
        height={120}
        showAxes
        curve="step"
        tone="violet"
        format={money}
        ariaLabel={`Prices other shoppers saw for ${watch.name} between ${day(market.since)} and ${day(
          market.points[market.points.length - 1].observedAt,
        )}, from ShopSavvy`}
      />

      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <p className={smallLabelClass}>Cheapest ever seen</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{money(market.lowestCents)}</p>
          {low !== null && (
            <p className="text-xs text-gray-600">
              {lowStore === null ? "Store not recorded" : lowStore} · {day(low.observedAt)}
            </p>
          )}
        </div>
        <div>
          <p className={smallLabelClass}>Dearest ever seen</p>
          <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900">{money(market.highestCents)}</p>
        </div>
      </div>

      {beatenBy !== null && (
        <p className="text-sm text-gray-600">
          It has been <span className="font-semibold tabular-nums text-gray-900">{money(beatenBy)}</span> cheaper than
          today
          {lowStore !== null && <> at {lowStore}</>}
          {low !== null && <> on {day(low.observedAt)}</>}.
        </p>
      )}

      <p className="text-xs text-gray-600">
        Recorded by ShopSavvy across other shops, not read by Recoup. A price here never opens a claim or sends you an
        alert.
      </p>
      <LookupStatus watch={watch} />
    </section>
  );
}
