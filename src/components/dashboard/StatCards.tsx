import type { ReactNode } from "react";
import { AreaChart, type AreaTone } from "../charts/AreaChart";
import { fmt } from "../../lib/money";
import { cardClass, shortDay } from "../../lib/ui";
import { Icon, type IconName } from "./icons";
import { claimableGapSeries, mainCurrency, openDropCents, perDay, startOfDay, watchedTotalSeries } from "./model";
import type { ActivityEvent, Item, Overview, SeriesPoint, Watch } from "./model";
import { Bone } from "./parts";

const WEEK = 7 * 86_400_000;
/** insights.activity returns at most this many events; at the cap, older days are unknown. */
const FEED_CAP = 40;

function StatCard({
  icon,
  title,
  value,
  delta,
  deltaTone,
  context,
  trend,
}: {
  icon: IconName;
  title: string;
  value: string;
  delta: string;
  deltaTone: "good" | "bad" | "muted";
  context: string;
  trend?: { series: SeriesPoint[]; tone: AreaTone; format: (value: number) => string; label: string };
}) {
  const tone = deltaTone === "good" ? "text-green-700" : deltaTone === "bad" ? "text-red-700" : "text-gray-500";
  return (
    <section className={`${cardClass} p-5`} aria-label={title}>
      <header className="flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-lg border border-gray-200 text-gray-700">
          <Icon name={icon} className="size-[18px]" />
        </span>
        <h2 className="font-semibold text-gray-900">{title}</h2>
      </header>
      <div className="my-4 border-t border-dashed border-gray-200" aria-hidden="true" />
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-3xl font-semibold tabular-nums tracking-tight text-gray-900">{value}</p>
          <p className="mt-1.5 whitespace-nowrap text-sm">
            <span className={`font-semibold tabular-nums ${tone}`}>{delta}</span> <span className="text-gray-500">{context}</span>
          </p>
        </div>
        {trend && trend.series.length > 1 && (
          <div className="min-w-0 max-w-32 grow basis-20">
            <AreaChart series={trend.series} tone={trend.tone} height={56} format={trend.format} ariaLabel={trend.label} />
          </div>
        )}
      </div>
    </section>
  );
}

export function StatCards({
  watches,
  activity,
  overview,
  scoped,
  onlyExamples,
  now,
}: {
  watches: Watch[];
  activity: ActivityEvent[];
  overview: Overview;
  /** The bought items the money figures describe: real ones, or the example while there is nothing else. */
  scoped: Item[];
  onlyExamples: boolean;
  now: number;
}): ReactNode {
  const active = watches.filter((watch) => watch.status === "active");
  const addedThisWeek = active.filter((watch) => watch._creationTime >= now - WEEK).length;
  const watchedTotal = watchedTotalSeries(active);
  const watchCurrency = mainCurrency(active.flatMap((watch) => (watch.currency ? [watch.currency] : [])));
  const cheaper = watchedTotal.length > 1 && watchedTotal[watchedTotal.length - 1].value <= watchedTotal[0].value;

  const alerts = activity.filter((event) => event.kind === "price_drop" || event.kind === "alert_sent");
  const alertsToday = alerts.filter((event) => event.at >= startOfDay(now)).length;
  const drops = activity.filter((event) => event.kind === "price_drop").map((event) => event.at);
  const oldestKnown = activity.length >= FEED_CAP ? activity[activity.length - 1].at : undefined;
  const dropsPerDay = perDay(drops, now, 7, oldestKnown);

  const currency = mainCurrency(scoped.map((item) => item.currency));
  const onTable = scoped.reduce((sum, item) => sum + openDropCents(item, now), 0);
  const recovered = onlyExamples
    ? scoped.reduce((sum, item) => sum + Math.max(item.claim?.confirmedCents ?? 0, 0), 0)
    : overview.totals.recoveredCents;
  const gap = claimableGapSeries(scoped, now);

  return (
    <div className="grid gap-5 *:min-w-0 lg:grid-cols-3">
      <StatCard
        icon="eye"
        title="Watching"
        value={String(active.length)}
        delta={`+${addedThisWeek}`}
        deltaTone={addedThisWeek > 0 ? "good" : "muted"}
        context="this week"
        trend={{
          series: watchedTotal,
          tone: cheaper ? "green" : "red",
          format: (value) => fmt(value, watchCurrency),
          label: "Combined price of everything you watch, over time",
        }}
      />
      <StatCard
        icon="bell"
        title="Price Drop Alerts"
        value={String(alerts.length)}
        delta={String(alertsToday)}
        deltaTone={alertsToday > 0 ? "good" : "muted"}
        context="today"
        trend={{
          series: dropsPerDay,
          tone: "green",
          format: (value) => `${value} ${value === 1 ? "drop" : "drops"}`,
          label: `Price drops per day since ${dropsPerDay.length > 0 ? shortDay(dropsPerDay[0].at) : "this week"}`,
        }}
      />
      <StatCard
        icon="wallet"
        title="Money on the table"
        value={fmt(onTable, currency)}
        delta={fmt(recovered, currency)}
        deltaTone={recovered > 0 ? "good" : "muted"}
        context="back on card"
        trend={
          gap.some((point) => point.value > 0)
            ? {
                series: gap,
                tone: "green",
                format: (value) => fmt(value, currency),
                label: "How far below what you paid your open purchases have been, over time",
              }
            : undefined
        }
      />
    </div>
  );
}

export function StatCardsSkeleton() {
  return (
    <div className="grid gap-5 *:min-w-0 lg:grid-cols-3" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={`${cardClass} p-5`}>
          <div className="flex items-center gap-3">
            <Bone className="size-9 rounded-lg" />
            <Bone className="h-4 w-32" />
          </div>
          <div className="my-4 border-t border-dashed border-gray-200" />
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-2.5">
              <Bone className="h-8 w-24" />
              <Bone className="h-3.5 w-32" />
            </div>
            <Bone className="h-12 w-28 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}
