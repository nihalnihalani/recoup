import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useNavigate } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { DeltaBadge } from "../components/DeltaBadge";
import { fmt } from "../components/Money";
import { Empty, Loading } from "../components/States";
import { StatusPill } from "../components/StatusPill";
import { PriceChart } from "../components/charts/PriceChart";
import { Sparkline } from "../components/charts/Sparkline";
import { WindowMeter } from "../components/charts/WindowMeter";
import {
  bigNumberClass,
  cardClass,
  cardHeaderClass,
  cardTitleClass,
  day,
  errorText,
  mutedLabelClass,
  pageTitleClass,
  pillGoodClass,
  pillMutedClass,
  pillWarnClass,
  primaryButtonClass,
  secondaryButtonClass,
  shortDay,
  tableHeadClass,
  useMeasuredWidth,
  useNow,
} from "../lib/ui";

type Overview = FunctionReturnType<typeof api.tracking.overview>;
type Item = Overview["items"][number];
type BoardData = FunctionReturnType<typeof api.purchases.board>;

/** A drop that can still be claimed: price is below paid, the window has not shut, the money is not back yet. */
function openDropCents(item: Item, now: number): number {
  if (item.dropCents === undefined || item.dropCents <= 0) return 0;
  if (item.windowEndsAt !== undefined && item.windowEndsAt <= now) return 0;
  if (item.claim?.status === "confirmed") return 0;
  return item.dropCents * item.qty;
}

/** Open drops first, largest first; then whichever window shuts soonest; closed and unknown windows last. */
function byUrgency(now: number) {
  const windowRank = (item: Item) =>
    item.windowEndsAt !== undefined && item.windowEndsAt > now ? item.windowEndsAt : Number.POSITIVE_INFINITY;
  return (a: Item, b: Item) => {
    const drop = openDropCents(b, now) - openDropCents(a, now);
    if (drop !== 0) return drop;
    return windowRank(a) - windowRank(b);
  };
}

/**
 * Money on the table across every item over time: at each observation, the sum of
 * (paid minus the price then known) x quantity, counting only prices below paid.
 */
function tableSeries(items: Item[]): { at: number; cents: number }[] {
  const times = [...new Set(items.flatMap((item) => item.points.map((p) => p.at)))].sort((a, b) => a - b);
  return times.map((at) => ({
    at,
    cents: items.reduce((sum, item) => {
      let known: number | undefined;
      for (const p of item.points) {
        if (p.at > at) break;
        known = p.cents;
      }
      return sum + (known !== undefined && known < item.paidCents ? (item.paidCents - known) * item.qty : 0);
    }, 0),
  }));
}

/** A small violet step-area for a stat card. Decorative: the card's number carries the value. */
function MiniArea({ series }: { series: { at: number; cents: number }[] }) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(240);
  const id = `mini-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const height = 48;
  const hi = Math.max(...series.map((p) => p.cents), 1);
  const t0 = series[0]?.at ?? 0;
  const t1 = series[series.length - 1]?.at ?? 1;
  const x = (at: number) => (t1 === t0 ? width : ((at - t0) / (t1 - t0)) * width);
  const y = (cents: number) => 3 + (1 - cents / hi) * (height - 6);
  let line = "";
  series.forEach((p, i) => {
    line += i === 0 ? `M${x(p.at)},${y(p.cents)}` : `H${x(p.at)}V${y(p.cents)}`;
  });
  return (
    <div ref={ref} aria-hidden="true">
      {series.length > 1 && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-violet-500)" stopOpacity={0.2} />
              <stop offset="100%" stopColor="var(--color-violet-500)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${line}V${height}H${x(t0)}Z`} fill={`url(#${id})`} />
          <path d={line} fill="none" className="stroke-violet-500" strokeWidth={2} strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}

/** A share of a whole as a slim two-part bar; the rest is a lighter step of the same tone. */
function ShareBar({ part, whole, fill, track }: { part: number; whole: number; fill: string; track: string }) {
  const ratio = whole > 0 ? Math.min(1, Math.max(0, part / whole)) : 0;
  return (
    <div className="flex h-1.5 gap-0.5" aria-hidden="true">
      {ratio > 0 && <div className={`rounded-full ${fill}`} style={{ width: `${ratio * 100}%` }} />}
      {ratio < 1 && <div className={`flex-1 rounded-full ${track}`} />}
    </div>
  );
}

function StatCard({ label, value, pill, children }: { label: string; value: string; pill?: ReactNode; children?: ReactNode }) {
  return (
    <div className={`col-span-full flex flex-col sm:col-span-6 xl:col-span-3 ${cardClass}`}>
      <div className="px-5 pt-5">
        <dt className={mutedLabelClass}>{label}</dt>
        <dd className="mt-1 flex flex-wrap items-center gap-2">
          <span className={bigNumberClass}>{value}</span>
          {pill}
        </dd>
      </div>
      <dd className="mt-auto px-5 pb-5 pt-4">{children}</dd>
    </div>
  );
}

function Stats({ data, now }: { data: Overview; now: number }) {
  const { items, totals } = data;
  const currency = items.find((item) => !item.isExample)?.currency ?? items[0]?.currency ?? "USD";
  const below = items.filter((item) => item.dropCents !== undefined && item.dropCents > 0).length;
  const closingSoon = items.filter(
    (item) => item.windowEndsAt !== undefined && item.windowEndsAt > now && item.windowEndsAt - now < 3 * 86_400_000,
  ).length;
  const money = totals.foundCents + totals.recoveredCents;
  const real = items.filter((item) => !item.isExample);

  return (
    <dl className="grid grid-cols-12 gap-6">
      <StatCard
        label="Items tracked"
        value={String(totals.tracked)}
        pill={below > 0 ? <span className={pillGoodClass}>{below} below paid</span> : undefined}
      >
        <ShareBar part={below} whole={totals.tracked} fill="bg-green-500" track="bg-gray-100" />
      </StatCard>
      <StatCard
        label="Watching now"
        value={String(totals.watching)}
        pill={closingSoon > 0 ? <span className={pillWarnClass}>{closingSoon} closing soon</span> : undefined}
      >
        <ShareBar part={totals.watching} whole={totals.tracked} fill="bg-violet-500" track="bg-violet-500/15" />
      </StatCard>
      <StatCard
        label="On the table"
        value={fmt(totals.foundCents, currency)}
        pill={<span className={pillMutedClass}>{totals.checks} checks</span>}
      >
        <MiniArea series={tableSeries(real.length > 0 ? real : items)} />
      </StatCard>
      <StatCard
        label="Back on card"
        value={fmt(totals.recoveredCents, currency)}
        pill={
          money > 0 && totals.recoveredCents > 0 ? (
            <span className={pillGoodClass}>{Math.round((totals.recoveredCents / money) * 100)}%</span>
          ) : undefined
        }
      >
        <ShareBar part={totals.recoveredCents} whole={money} fill="bg-green-500" track="bg-green-500/15" />
      </StatCard>
    </dl>
  );
}

function ExampleChip() {
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Example</span>;
}

/** The hero: the full price chart of the item with the most money on the table. */
function HeroCard({ item }: { item: Item }) {
  return (
    <section className={`col-span-full flex flex-col xl:col-span-8 ${cardClass}`} aria-labelledby="hero-title">
      <header className={`flex flex-wrap items-center justify-between gap-2 ${cardHeaderClass}`}>
        <div className="min-w-0">
          <h2 id="hero-title" className={`truncate ${cardTitleClass}`}>
            {item.name}
          </h2>
          <p className="truncate text-sm text-gray-500">
            Price history at {item.merchant || item.merchantDomain}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {item.isExample && <ExampleChip />}
          <Link to={`/purchases/${item.purchaseId}`} className="text-sm font-medium text-violet-500 hover:text-violet-600">
            Open purchase
          </Link>
        </div>
      </header>
      <div className="px-5 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={bigNumberClass}>{fmt(item.latestCents ?? item.paidCents, item.currency)}</span>
          <DeltaBadge paidCents={item.paidCents} latestCents={item.latestCents} currency={item.currency} />
        </div>
      </div>
      <div className="grow px-5 pb-5 pt-2">
        <PriceChart
          points={item.points}
          paidCents={item.paidCents}
          currency={item.currency}
          purchasedAt={item.purchasedAt}
          windowEndsAt={item.windowEndsAt}
          height={280}
        />
      </div>
    </section>
  );
}

/** One horizontal bar per item with a drop that can still be claimed: drop x quantity, largest first. */
function TableCard({ items }: { items: Item[] }) {
  // Same rule as the stat tile: a drop whose money is already back, or whose window shut, is not on the table.
  const now = Date.now();
  const rows = items
    .map((item) => ({ item, cents: openDropCents(item, now) }))
    .filter((row) => row.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 7);
  const max = Math.max(...rows.map((row) => row.cents), 1);

  return (
    <section className={`col-span-full flex flex-col xl:col-span-4 ${cardClass}`} aria-labelledby="table-title">
      <header className={cardHeaderClass}>
        <h2 id="table-title" className={cardTitleClass}>
          Money on the table
        </h2>
      </header>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">No price is below what you paid.</p>
      ) : (
        <ul className="grow space-y-4 px-5 py-5">
          {rows.map(({ item, cents }) => (
            <li key={item.itemId}>
              <Link to={`/purchases/${item.purchaseId}`} className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-gray-800 group-hover:text-violet-600">{item.name}</span>
                  <span className="font-semibold tabular-nums text-gray-800">{fmt(cents, item.currency)}</span>
                </div>
                <div className="mt-1.5 h-2.5 rounded-full bg-gray-100">
                  <div className="h-full min-w-2 rounded-full bg-green-500" style={{ width: `${(cents / max) * 100}%` }} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ItemsTable({ items }: { items: Item[] }) {
  const navigate = useNavigate();
  return (
    <section className={`col-span-full ${cardClass}`} aria-labelledby="items-title">
      <header className={cardHeaderClass}>
        <h2 id="items-title" className={cardTitleClass}>
          Tracked items <span className="ml-1 font-medium text-gray-400">{items.length}</span>
        </h2>
      </header>
      <div className="overflow-x-auto p-3">
        <table className="w-full table-auto text-sm">
          <thead className={tableHeadClass}>
            <tr>
              {["Item", "Paid", "Now", "Change", "Trend", "Window", "Status"].map((heading, i) => (
                <th
                  key={heading}
                  scope="col"
                  className={`whitespace-nowrap p-2 font-semibold ${i === 0 ? "rounded-l-md text-left" : i === 1 || i === 2 ? "text-right" : "text-left"} ${i === 6 ? "rounded-r-md" : ""}`}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((item) => (
              <tr
                key={item.itemId}
                className="cursor-pointer transition hover:bg-gray-50"
                onClick={() => void navigate(`/purchases/${item.purchaseId}`)}
              >
                <td className="max-w-72 p-2">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/purchases/${item.purchaseId}`}
                      onClick={(event) => event.stopPropagation()}
                      className="truncate font-medium text-gray-800 outline-none hover:text-violet-600 focus-visible:underline"
                    >
                      {item.name}
                    </Link>
                    {item.qty > 1 && <span className="text-xs text-gray-400">×{item.qty}</span>}
                    {item.isExample && <ExampleChip />}
                  </div>
                  <div className="truncate text-xs text-gray-400">
                    {item.merchant || item.merchantDomain}
                    {item.purchasedAt !== undefined && `, ${shortDay(item.purchasedAt)}`}
                  </div>
                </td>
                <td className="whitespace-nowrap p-2 text-right tabular-nums">{fmt(item.paidCents, item.currency)}</td>
                <td className="whitespace-nowrap p-2 text-right font-semibold tabular-nums text-gray-800">
                  {item.latestCents === undefined ? <span className="font-normal text-gray-400">—</span> : fmt(item.latestCents, item.currency)}
                </td>
                <td className="p-2">
                  <DeltaBadge paidCents={item.paidCents} latestCents={item.latestCents} currency={item.currency} />
                </td>
                <td className="p-2">
                  <Sparkline points={item.points} paidCents={item.paidCents} width={120} height={32} />
                </td>
                <td className="min-w-40 p-2">
                  <WindowMeter purchasedAt={item.purchasedAt} endsAt={item.windowEndsAt} />
                </td>
                <td className="p-2">
                  {item.claim ? (
                    <Link
                      to={`/claims/${item.claim.claimId}`}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`Claim for ${item.name}`}
                      className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                    >
                      <StatusPill status={item.claim.status} />
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-500">
                      <span aria-hidden="true" className={`size-1.5 rounded-full ${item.productUrl ? "bg-violet-500" : "bg-gray-300"}`} />
                      {item.productUrl ? "Watching" : "No product link"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NeedsReview({ purchases }: { purchases: BoardData["purchases"] }) {
  const pending = purchases.filter((row) => row.purchase.status === "needs_review");
  if (pending.length === 0) return null;
  return (
    <section aria-labelledby="needs-review" className={`${cardClass} border-l-4 border-yellow-500 px-5 py-4`}>
      <h2 id="needs-review" className="flex items-center gap-2 text-sm font-semibold text-gray-800">
        Needs review <span className={pillWarnClass}>{pending.length}</span>
      </h2>
      <ul className="mt-3 flex flex-wrap gap-2">
        {pending.map(({ purchase }) => (
          <li key={purchase._id}>
            <Link
              to={`/purchases/${purchase._id}`}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm transition hover:border-gray-300"
            >
              <span className="font-medium text-gray-800">{purchase.merchant || purchase.merchantDomain || "Unknown merchant"}</span>
              <span className="text-xs text-gray-400">{day(purchase.purchasedAt)}</span>
              {purchase.isExample && <ExampleChip />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Board() {
  const overview = useQuery(api.tracking.overview);
  const board = useQuery(api.purchases.board);
  const loadExamples = useMutation(api.examples.load);
  const now = useNow(60_000);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onLoadExamples() {
    setLoadError(null);
    setLoading(true);
    try {
      await loadExamples({});
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }

  if (overview === undefined || board === undefined) {
    return <Loading rows={4} />;
  }

  const items = [...overview.items].sort(byUrgency(now));
  const nothingYet = items.length === 0 && board.purchases.length === 0;
  // The hero is the biggest open drop; failing that, the item with the longest history.
  const hero =
    items.length === 0
      ? undefined
      : openDropCents(items[0], now) > 0
        ? items[0]
        : [...items].sort((a, b) => b.points.length - a.points.length)[0];

  const loadExampleButton = (
    <button type="button" onClick={onLoadExamples} disabled={loading} className={secondaryButtonClass}>
      {loading ? "Loading…" : "Load example"}
    </button>
  );
  const addButton = (
    <Link to="/settings" className={primaryButtonClass}>
      <svg className="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M15 7H9V1a1 1 0 0 0-2 0v6H1a1 1 0 0 0 0 2h6v6a1 1 0 0 0 2 0V9h6a1 1 0 0 0 0-2z" />
      </svg>
      Add purchase
    </Link>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className={pageTitleClass}>Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          {items.length === 0 && loadExampleButton}
          {addButton}
        </div>
      </div>
      {loadError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {loadError}
        </p>
      )}

      <Stats data={overview} now={now} />

      <NeedsReview purchases={board.purchases} />

      {hero === undefined ? (
        <Empty
          title={nothingYet ? "Nothing tracked yet" : "No prices to show yet"}
          hint={
            nothingYet
              ? "Add something you bought and Recoup watches its price until the store's adjustment window shuts."
              : "Review the purchases above to start tracking their prices."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {addButton}
              {loadExampleButton}
            </div>
          }
        />
      ) : (
        <div className="grid grid-cols-12 gap-6">
          <HeroCard item={hero} />
          <TableCard items={items} />
          <ItemsTable items={items} />
        </div>
      )}

      {overview.capped && <p className="text-xs text-gray-400">Showing your 60 most recent purchases.</p>}
    </div>
  );
}
