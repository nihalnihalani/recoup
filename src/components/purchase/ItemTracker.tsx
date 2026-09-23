import { useMutation } from "convex/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PriceChart } from "../charts/PriceChart";
import { StatusSteps } from "../charts/StatusSteps";
import { DeltaBadge } from "../DeltaBadge";
import { fmt } from "../../lib/money";
import { ProductThumb } from "../ProductThumb";
import { boughtVerdict, priceStats, type VerdictTone } from "../../lib/priceStats";
import { priceAge } from "../../lib/time";
import {
  bigNumberClass,
  cardClass,
  day,
  errorText,
  mutedLabelClass,
  percent,
  primaryButtonClass,
  secondaryButtonClass,
  useNow,
} from "../../lib/ui";
import { CardHeading, ClaimIcon, DotChip, ExternalIcon } from "./parts";
import { OpportunityCard } from "../opportunity/OpportunityCard";
import type { FactAnswer } from "../opportunity/Questions";
import type { FactCell, OpenCaseResult, OpportunityView } from "../opportunity/model";

type PurchaseData = FunctionReturnType<typeof api.purchases.get>;
export type TrackedItem = PurchaseData["items"][number];

/** What the page wires into this item's recovery-path cards (`opportunities.forPurchase`, M12). */
export type OpportunityWiring = {
  /** Every card on the purchase's transaction, so a card can name its alternatives. */
  all: readonly OpportunityView[];
  cells?: readonly FactCell[];
  purchaseEditHref?: string;
  counterparty?: string;
  openCase?: (opportunityId: OpportunityView["opportunity"]["_id"]) => Promise<OpenCaseResult>;
  checkAgain?: () => Promise<void>;
  answer?: (answer: FactAnswer) => Promise<void>;
};

/** `purchases.get` returns at most this many price checks per item. */
const CHECK_CAP = 30;

/** The verdict's tone as the dot of its chip. Violet verdicts (a claim in motion) read as near-black. */
const TONE_DOT: Record<VerdictTone, string> = {
  green: "bg-moss",
  red: "bg-rust",
  yellow: "bg-gold",
  gray: "bg-gray-300",
  violet: "bg-gray-900",
};

/** One figure of the compact strip under the chart; the same strip a watched product shows. */
function StripStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className={mutedLabelClass}>{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-900">{value}</dd>
      {hint && <dd className="truncate text-xs text-gray-400">{hint}</dd>}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-4 first:pl-5 last:pr-5 sm:px-4 xl:flex xl:items-baseline xl:justify-between xl:gap-3 xl:px-5 xl:py-3 2xl:block 2xl:px-4 2xl:py-4 2xl:first:pl-5 2xl:last:pr-5">
      <dt className={mutedLabelClass}>{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-gray-900 sm:text-xl xl:mt-0 xl:text-lg 2xl:mt-1 2xl:text-xl">{children}</dd>
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
  opportunities = [],
  wiring,
}: {
  item: TrackedItem;
  currency: string;
  purchasedAt: number | undefined;
  windowEndsAt: number | undefined;
  aside?: ReactNode;
  /** This item's recovery paths (active packs only; the server filters). */
  opportunities?: readonly OpportunityView[];
  wiring?: OpportunityWiring;
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
    sendUnknown: liveClaim?.sendUnknown === true,
    priceStale: item.priceStale,
    priceObservedAt: item.lastObservedAt,
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
      <section aria-label={item.name} className={`${cardClass} col-span-full flex flex-col overflow-hidden xl:col-span-8`}>
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
            <ProductThumb imageUrl={item.imageUrl} name={item.name} size={56} />
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-gray-900">{item.name}</h2>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500">
                <span className="tabular-nums">Paid {fmt(item.unitCents, currency)}</span>
                {item.qty > 1 && (
                  <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs font-medium tabular-nums text-gray-500">
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
                    className="-m-1 rounded-lg p-1 text-gray-400 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-violet-500"
                  >
                    <ExternalIcon />
                  </a>
                )}
              </p>
            </div>
          </div>
          <button type="button" disabled={checking} onClick={() => void handleCheck()} className={secondaryButtonClass}>
            {checking && <span className="size-1.5 animate-pulse rounded-full bg-gold motion-reduce:animate-none" aria-hidden="true" />}
            {checking ? "Checking…" : "Check price now"}
          </button>
        </header>

        <div className="px-5 pt-5">
          {/* P06-OW-2: an out-of-date price is labelled by its age, never as the current price. */}
          <p className={mutedLabelClass}>{latest && item.priceStale ? "Last price read" : "Current price"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2.5">
            <p className={bigNumberClass}>{latest ? fmt(latest.cents, currency) : dash}</p>
            {!item.priceStale && <DeltaBadge paidCents={item.unitCents} latestCents={latest?.cents} currency={currency} />}
          </div>
          {latest && (
            <p className="mt-1 text-xs text-gray-600">
              {item.priceStale ? `Out of date: ${priceAge(item.lastObservedAt ?? latest.at, now)}` : `Price ${priceAge(item.lastObservedAt ?? latest.at, now)}`}
            </p>
          )}
          {held !== null && stats.count >= 2 && (
            <p className="mt-1 text-xs text-gray-400">
              {held === 0 ? "At this price for less than a day" : `At this price for ${held} ${held === 1 ? "day" : "days"}`}
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
            <DotChip dot={TONE_DOT[verdict.tone]}>{verdict.label}</DotChip>
            <span className="min-w-0 text-sm text-gray-500">{verdict.reason}</span>
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

        <div className="mx-5 mt-5 border-t border-dashed border-gray-200" aria-hidden="true" />

        <div className="min-w-0 grow px-5 pb-5 pt-5">
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
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-gray-200 text-sm text-gray-500">
              {checking ? "Reading the product page…" : "No price seen yet"}
            </div>
          )}
          <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-dashed border-gray-200 pt-4 sm:grid-cols-3">
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
            <p className="mt-4 text-xs text-gray-400">
              {unplotted.length} {unplotted.length === 1 ? "check" : "checks"} not plotted. Last on{" "}
              {day(lastUnplotted.observedAt)}:{" "}
              {lastUnplotted.observedCents !== undefined
                ? `priced in ${lastUnplotted.currency ?? "another currency"}`
                : (lastUnplotted.note ?? "no usable price")}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="border-t border-rust/20 bg-rust/5 px-5 py-2.5 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>

      <div className="col-span-full flex flex-col gap-6 xl:col-span-4">
        <dl className={`${cardClass} grid grid-cols-3 divide-x divide-dashed divide-gray-200 xl:grid-cols-1 xl:divide-x-0 xl:divide-y 2xl:grid-cols-3 2xl:divide-x 2xl:divide-y-0`}>
          <Stat label="Paid">{fmt(item.unitCents, currency)}</Stat>
          <Stat label="Now">{latest ? fmt(latest.cents, currency) : dash}</Stat>
          <Stat label="Lowest">{lowest !== undefined ? fmt(lowest, currency) : dash}</Stat>
        </dl>

        {opportunities.map((view) => (
          <OpportunityCard
            key={view.opportunity._id}
            view={view}
            related={wiring?.all}
            cells={wiring?.cells}
            purchaseEditHref={wiring?.purchaseEditHref}
            counterparty={wiring?.counterparty}
            onOpenCase={wiring?.openCase ? () => wiring.openCase!(view.opportunity._id) : undefined}
            onCheckAgain={wiring?.checkAgain}
            onAnswer={wiring?.answer}
          />
        ))}

        {claims.map((claim) => (
          <section key={claim._id} aria-label="Price-drop claim" className={`${cardClass} p-5`}>
            <CardHeading
              icon={<ClaimIcon />}
              title="Price-drop claim"
              action={
                <Link
                  to={`/claims/${claim._id}`}
                  className="rounded-lg text-sm font-semibold text-gray-900 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                >
                  View claim
                </Link>
              }
            />
            <div className="mt-4 border-t border-dashed border-gray-200 pt-4">
              <p className={mutedLabelClass}>Asking for</p>
              <p className={`mt-1 ${bigNumberClass}`}>{fmt(claim.expectedCents, currency)}</p>
            </div>
            <div className="mt-5">
              <StatusSteps status={claim.status} sendUnknown={claim.sendUnknown === true} />
            </div>
          </section>
        ))}

        {aside}
      </div>
    </>
  );
}
