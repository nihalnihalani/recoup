import { useState } from "react";
import type { ReactNode } from "react";
import { AreaChart } from "../charts/AreaChart";
import { fmt } from "../Money";
import { bigNumberClass, cardClass, mutedLabelClass, percent, pillGoodClass, pillMutedClass } from "../../lib/ui";
import { aggregateSeries, baselineCents, mainCurrency } from "./model";
import type { Product } from "./model";
import { ChangePill } from "./parts";
import { useCountUp } from "./useCountUp";

type Tab = "watch" | "bought";

export type OverviewStats = {
  onTableCents: number;
  recoveredCents: number;
  drops: number;
  checks: number;
  currency: string;
};

const icons: Record<"table" | "card" | "drop" | "check", ReactNode> = {
  table: (
    <path d="M4 7h16v10H4zM4 11h16M8 15h3" />
  ),
  card: (
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5zM3 10h18M15 14.5l1.5 1.5 3-3" />
  ),
  drop: <path d="M4 7l6 6 4-4 6 7M20 11v5h-5" />,
  check: <path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4M12 8v4l2.5 2" />,
};

function StatTile({
  icon,
  tint,
  label,
  value,
  format,
}: {
  icon: keyof typeof icons;
  tint: string;
  label: string;
  value: number;
  format: (value: number) => string;
}) {
  const shown = useCountUp(value);
  return (
    <div className="flex items-center gap-3">
      <span className={`inline-flex size-10 shrink-0 items-center justify-center rounded-lg ${tint}`} aria-hidden="true">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
          {icons[icon]}
        </svg>
      </span>
      <div className="min-w-0">
        <dt className="truncate text-sm text-gray-500">{label}</dt>
        {/* The eased figure is decoration; assistive tech reads the settled one. */}
        <dd className="text-lg font-semibold tabular-nums text-gray-800">
          <span aria-hidden="true">{format(shown)}</span>
          <span className="sr-only">{format(value)}</span>
        </dd>
      </div>
    </div>
  );
}

/**
 * The account at a glance. Left: the summed price of everything watched (or bought)
 * over time, against the gray level it started from. Right: four settled figures.
 */
export function OverviewCard({ watched, bought, stats }: { watched: Product[]; bought: Product[]; stats: OverviewStats }) {
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab: Tab = picked ?? (watched.length > 0 || bought.length === 0 ? "watch" : "bought");
  const products = tab === "watch" ? watched : bought;

  const currency = mainCurrency(products.length > 0 ? products : [...watched, ...bought]);
  const series = aggregateSeries(products);
  const baseline = baselineCents(products);
  const nowTotal = series.length > 0 ? series[series.length - 1].value : undefined;
  const compare = series.length > 0 ? [{ at: series[0].at, value: baseline }, { at: series[series.length - 1].at, value: baseline }] : [];
  const money = (value: number) => fmt(Math.round(value), currency);

  const headline = tab === "watch" ? (nowTotal ?? 0) : stats.onTableCents;
  const shown = useCountUp(headline);
  const paidTotal = bought.reduce((sum, p) => sum + (p.basisCents ?? 0) * p.qty, 0);

  return (
    <section className={`col-span-full ${cardClass}`} aria-labelledby="overview-title">
      <div className="grid grid-cols-12">
        <div className="col-span-full p-5 lg:col-span-8 xl:col-span-9">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="overview-title" className="text-lg font-semibold text-gray-800">
              Overview
            </h2>
            <div role="group" aria-label="Show" className="inline-flex rounded-lg bg-gray-100 p-0.5">
              {(["watch", "bought"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setPicked(key)}
                  className={`rounded-md px-3 py-1 text-sm font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-violet-500 ${
                    tab === key ? "bg-white text-gray-800 shadow-xs" : "text-gray-500 hover:text-gray-700"
                  }`}
                >
                  {key === "watch" ? "Watching" : "Bought"}
                  <span className="ml-1.5 tabular-nums text-gray-400">{key === "watch" ? watched.length : bought.length}</span>
                </button>
              ))}
            </div>
          </div>

          <p className={`mt-4 ${mutedLabelClass}`}>{tab === "watch" ? "Watched total now" : "Money on the table"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={`${bigNumberClass} tabular-nums`}>
              <span aria-hidden="true">{tab === "watch" && nowTotal === undefined ? "—" : money(shown)}</span>
              <span className="sr-only">{tab === "watch" && nowTotal === undefined ? "No price yet" : money(headline)}</span>
            </span>
            {tab === "watch" ? (
              <ChangePill nowCents={nowTotal} basisCents={nowTotal === undefined ? undefined : baseline} currency={currency} versus="first seen" />
            ) : stats.onTableCents > 0 && paidTotal > 0 ? (
              <span className={`${pillGoodClass} tabular-nums`}>{percent(stats.onTableCents / paidTotal)} of paid</span>
            ) : (
              <span className={pillMutedClass} aria-label="Nothing below paid">
                —
              </span>
            )}
            <span className="text-sm text-gray-400">{tab === "watch" ? "vs first seen" : "still claimable"}</span>
          </div>

          <div className="mt-3">
            <AreaChart
              key={tab}
              series={series}
              compare={compare}
              height={240}
              tone={tab === "watch" ? "violet" : "sky"}
              format={money}
              showAxes
              ariaLabel={tab === "watch" ? "Summed price of watched products over time" : "Summed price of bought items over time, against what was paid"}
            />
          </div>
          {series.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className={`h-0.5 w-3 rounded-full ${tab === "watch" ? "bg-violet-500" : "bg-sky-500"}`} />
                {tab === "watch" ? "Price now" : "Price now, all items"}
              </li>
              <li className="flex items-center gap-1.5">
                <span aria-hidden="true" className="h-0.5 w-3 rounded-full bg-gray-300" />
                {tab === "watch" ? "First seen" : "Paid"} {money(baseline)}
              </li>
            </ul>
          )}
        </div>

        <dl className="col-span-full grid grid-cols-2 content-center gap-5 border-t border-gray-100 p-5 lg:col-span-4 lg:grid-cols-1 lg:border-l lg:border-t-0 xl:col-span-3">
          <StatTile icon="table" tint="bg-violet-500/15 text-violet-700" label="On the table" value={stats.onTableCents} format={(v) => fmt(Math.round(v), stats.currency)} />
          <StatTile icon="card" tint="bg-green-500/15 text-green-700" label="Back on card" value={stats.recoveredCents} format={(v) => fmt(Math.round(v), stats.currency)} />
          <StatTile icon="drop" tint="bg-sky-500/15 text-sky-700" label="Drops caught" value={stats.drops} format={(v) => String(Math.round(v))} />
          <StatTile icon="check" tint="bg-yellow-500/15 text-yellow-700" label="Price checks" value={stats.checks} format={(v) => String(Math.round(v))} />
        </dl>
      </div>
    </section>
  );
}

export function OverviewSkeleton() {
  return (
    <div className={`grid grid-cols-12 ${cardClass}`} aria-hidden="true">
      <div className="col-span-full animate-pulse space-y-3 p-5 lg:col-span-8 xl:col-span-9">
        <div className="flex justify-between">
          <div className="h-6 w-28 rounded bg-gray-100" />
          <div className="h-8 w-44 rounded-lg bg-gray-100" />
        </div>
        <div className="h-3 w-24 rounded bg-gray-100" />
        <div className="h-9 w-40 rounded bg-gray-100" />
        <div className="h-56 rounded-lg bg-gray-100" />
      </div>
      <div className="col-span-full grid animate-pulse grid-cols-2 content-center gap-5 border-t border-gray-100 p-5 lg:col-span-4 lg:grid-cols-1 lg:border-l lg:border-t-0 xl:col-span-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-gray-100" />
            <div className="grow space-y-2">
              <div className="h-3 w-20 rounded bg-gray-100" />
              <div className="h-5 w-16 rounded bg-gray-100" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
