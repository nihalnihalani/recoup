import { useMutation } from "convex/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PriceChart } from "../charts/PriceChart";
import { StatusSteps } from "../charts/StatusSteps";
import { DeltaBadge } from "../DeltaBadge";
import { fmt } from "../Money";
import { boughtVerdict, priceStats, type VerdictTone } from "../../lib/priceStats";
import {
  day,
  errorText,
  mutedLabelClass,
  percent,
  pillBadClass,
  pillGoodClass,
  pillMutedClass,
  pillWarnClass,
  primaryButtonClass,
  secondaryButtonClass,
  useNow,
} from "../../lib/ui";

type PurchaseData = FunctionReturnType<typeof api.purchases.get>;
export type TrackedItem = PurchaseData["items"][number];

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const cardClass = "rounded-xl bg-white shadow-xs";
const eyebrowClass = "text-xs font-semibold uppercase text-gray-400";

/** `purchases.get` returns at most this many price checks per item. */
const CHECK_CAP = 30;

const TONE_PILL: Record<VerdictTone, string> = {
  green: pillGoodClass,
  red: pillBadClass,
  yellow: pillWarnClass,
  gray: pillMutedClass,
  violet: "inline-flex items-center gap-1 rounded-full bg-violet-500/20 px-1.5 text-sm font-medium text-violet-700",
};

/** One figure of the compact strip under the chart; the same strip a watched product shows. */
function StripStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className={mutedLabelClass}>{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-800">{value}</dd>
      {hint && <dd className="truncate text-xs text-gray-400">{hint}</dd>}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-4 first:pl-5 last:pr-5">
      <dt className={eyebrowClass}>{label}</dt>
      <dd className="mt-1 text-xl font-bold tabular-nums text-gray-800">{children}</dd>
    </div>
  );
}

/**
 * One tracked item as a row of the page's 12-column grid: the price-history
 * card (8 columns) and a stacked side column (4) with the numbers, any
 * price-drop claim, and whatever the page passes as `aside` (the rule card).
 * Renders two grid children, so it must sit directly inside the grid.
 */
export function ItemTracker({
  item,
  currency,
  purchasedAt,
  windowEndsAt,
  aside,
}: {
  item: TrackedItem;
  currency: string;
  purchasedAt: number | undefined;
  windowEndsAt: number | undefined;
  aside?: ReactNode;
}) {
  const checkNow = useMutation(api.priceWatch.checkNow);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // checkNow only schedules the check. Remember the newest check we had when
  // asking, and read as "checking" until a newer one arrives.
  const [askedAfter, setAskedAfter] = useState<Id<"priceChecks"> | "none" | null>(null);
  const now = useNow();

  const newestId = item.priceChecks[0]?._id ?? "none";
  const checking = busy || (askedAfter !== null && askedAfter === newestId);

  // Checks arrive newest first. Only same-currency priced checks can share the
  // paid-price axis; everything else is counted, not plotted.
  const priced = item.priceChecks.filter(
    (check) => check.observedCents !== undefined && (check.currency ?? currency) === currency,
  );
  const unplotted = item.priceChecks.filter((check) => !priced.includes(check));
  const points = priced
    .map((check) => ({ at: check.observedAt, cents: check.observedCents ?? 0 }))
    .reverse();
  const latest = points.at(-1);
  const lowest = points.length > 0 ? Math.min(...points.map((point) => point.cents)) : undefined;
  const lastUnplotted = unplotted[0];

  const claims = item.claims.filter((claim) => claim.type === "price_adjustment");

  // Every figure below describes only the plotted reads, which the server caps.
  const stats = priceStats(points, now);
  const capped = item.priceChecks.length >= CHECK_CAP;
  const money = (cents: number | null) => (cents === null ? "—" : fmt(cents, currency));
  // The newest claim still in play decides the verdict, as it does on the dashboard.
  const liveClaim = [...claims]
    .filter((claim) => claim.status !== "dismissed")
    .sort((a, b) => b._creationTime - a._creationTime)[0];
  const verdict = boughtVerdict({
    paidCents: item.unitCents,
    latestCents: latest?.cents,
    windowEndsAt,
    claimStatus: liveClaim?.status,
    now,
    currency,
  });
  const held = stats.daysAtCurrentPrice;

  async function handleCheck() {
    setError(null);
    setBusy(true);
    try {
      await checkNow({ itemId: item._id });
      setAskedAfter(newestId);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const dash = <span className="text-gray-300">—</span>;

  return (
    <>
      <section aria-label={item.name} className={`${cardClass} col-span-full flex flex-col xl:col-span-8`}>
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-gray-800">{item.name}</h2>
            {item.qty > 1 && (
              <span className="shrink-0 rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-600">
                × {item.qty}
              </span>
            )}
            {item.productUrl && (
              <a
                href={item.productUrl}
                target="_blank"
                rel="noreferrer"
                aria-label={`Open the product page for ${item.name}`}
                title="Open the product page"
                className="shrink-0 rounded-lg p-1 text-gray-400 transition hover:text-harbor focus-visible:outline-2 focus-visible:outline-harbor"
              >
                <ExternalIcon />
              </a>
            )}
          </div>
          <button
            type="button"
            disabled={checking}
            onClick={() => void handleCheck()}
            className={`${secondaryButtonClass} inline-flex items-center gap-2`}
          >
            {checking && <span className="size-1.5 animate-pulse rounded-full bg-harbor" aria-hidden="true" />}
            {checking ? "Checking…" : "Check price now"}
          </button>
        </header>

        <div className="px-5 pt-3">
          <p className={eyebrowClass}>Current price</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <p className="text-3xl font-bold tabular-nums text-gray-800">
              {latest ? fmt(latest.cents, currency) : dash}
            </p>
            <DeltaBadge paidCents={item.unitCents} latestCents={latest?.cents} currency={currency} />
          </div>
          {held !== null && stats.count >= 2 && (
            <p className="mt-0.5 text-xs text-gray-400">
              {held === 0 ? "At this price for less than a day" : `At this price for ${held} ${held === 1 ? "day" : "days"}`}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className={`${TONE_PILL[verdict.tone]} whitespace-nowrap`}>{verdict.label}</span>
            <span className="min-w-0 text-sm text-gray-600">{verdict.reason}</span>
            {verdict.kind === "claim_now" &&
              (liveClaim ? (
                <Link to={`/claims/${liveClaim._id}`} className={primaryButtonClass}>
                  Open the claim
                </Link>
              ) : (
                claims.length === 0 && (
                  // Claims are opened by a price check that confirms the drop, never from the browser.
                  <button type="button" disabled={checking} onClick={() => void handleCheck()} className={primaryButtonClass}>
                    {checking ? "Checking…" : "Confirm the drop to open a claim"}
                  </button>
                )
              ))}
          </div>
        </div>

        <div className="min-w-0 grow px-5 pb-5 pt-4">
          {points.length > 0 ? (
            <PriceChart
              points={points}
              paidCents={item.unitCents}
              currency={currency}
              purchasedAt={purchasedAt}
              windowEndsAt={windowEndsAt}
              height={280}
            />
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-gray-200 text-sm text-gray-500">
              {checking ? "Reading the product page…" : "No price seen yet"}
            </div>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-gray-100 pt-3 sm:grid-cols-3">
            <StripStat label="Lowest" value={money(stats.lowest)} />
            <StripStat label="Highest" value={money(stats.highest)} />
            <StripStat label="Average" value={money(stats.average)} />
            <StripStat
              label="Swing"
              value={stats.count >= 2 ? percent(stats.swingPct / 100) : "—"}
              hint="high to low, of average"
            />
            <StripStat
              label="Price reads"
              value={capped ? `${stats.count}+` : String(stats.count)}
              hint={capped ? `stats use the latest ${CHECK_CAP} checks` : undefined}
            />
            <StripStat label="Tracking since" value={day(stats.trackingSince ?? undefined)} hint="no history before this" />
          </dl>
          {unplotted.length > 0 && lastUnplotted && (
            <p className="mt-3 text-xs text-gray-400">
              {unplotted.length} {unplotted.length === 1 ? "check" : "checks"} not plotted. Last on{" "}
              {day(lastUnplotted.observedAt)}:{" "}
              {lastUnplotted.observedCents !== undefined
                ? `priced in ${lastUnplotted.currency ?? "another currency"}`
                : (lastUnplotted.note ?? "no usable price")}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="rounded-b-xl border-t border-rust/20 bg-rust/10 px-5 py-2.5 text-sm text-rust">
            {error}
          </p>
        )}
      </section>

      <div className="col-span-full flex flex-col gap-6 xl:col-span-4">
        <dl className={`${cardClass} grid grid-cols-3 divide-x divide-gray-100`}>
          <Stat label="Paid">{fmt(item.unitCents, currency)}</Stat>
          <Stat label="Now">{latest ? fmt(latest.cents, currency) : dash}</Stat>
          <Stat label="Lowest">{lowest !== undefined ? fmt(lowest, currency) : dash}</Stat>
        </dl>

        {claims.map((claim) => (
          <section key={claim._id} aria-label="Price-drop claim" className={`${cardClass} p-5`}>
            <header className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-gray-800">Price-drop claim</h2>
              <Link
                to={`/claims/${claim._id}`}
                className="text-sm font-medium text-harbor hover:underline focus-visible:outline-2 focus-visible:outline-harbor"
              >
                View claim
              </Link>
            </header>
            <p className={`mt-3 ${eyebrowClass}`}>Asking for</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-gray-800">{fmt(claim.expectedCents, currency)}</p>
            <div className="mt-4">
              <StatusSteps status={claim.status} />
            </div>
          </section>
        ))}

        {aside}
      </div>
    </>
  );
}
