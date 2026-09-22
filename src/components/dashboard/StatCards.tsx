import type { ReactNode } from "react";
import { AreaChart, type AreaTone } from "../charts/AreaChart";
import { fmt, formatMinor } from "../../lib/money";
import { cardClass, shortDay } from "../../lib/ui";
import { Icon, type IconName } from "./icons";
import { perDay, startOfDay, watchedTotalsByCurrency } from "./model";
import type { ActivityEvent, RecoverySummary, SeriesPoint, Watch } from "./model";
import { Bone, RecentNote } from "./parts";

const WEEK = 7 * 86_400_000;
/** insights.activity returns at most this many events; at the cap, older days are unknown. */
const FEED_CAP = 40;

function StatCard({
  icon,
  title,
  badge,
  value,
  delta,
  deltaTone = "muted",
  context,
  trend,
}: {
  icon: IconName;
  title: string;
  /** e.g. a `RecentNote` when the figure comes from a truncated, sampled window rather than the full account. */
  badge?: ReactNode;
  /** A plain string for a single figure, or a stacked list of per-currency lines (never a cross-currency sum). */
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: "good" | "bad" | "muted";
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
        {badge}
      </header>
      <div className="my-4 border-t border-dashed border-gray-200" aria-hidden="true" />
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-3xl font-semibold tabular-nums tracking-tight text-gray-900">{value}</p>
          <p className="mt-1.5 text-sm">
            {delta !== undefined && delta !== null && (
              <>
                <span className={`font-semibold tabular-nums ${tone}`}>{delta}</span>{" "}
              </>
            )}
            <span className="text-gray-500">{context}</span>
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

/** One line per currency, stacked; a single currency reads as a plain figure. Never a cross-currency sum. */
function CurrencyLines({ lines }: { lines: { currency: string; label: string }[] }) {
  if (lines.length === 1) return <>{lines[0].label}</>;
  return (
    <span className="inline-flex flex-col gap-0.5">
      {lines.map((line) => (
        <span key={line.currency}>{line.label}</span>
      ))}
    </span>
  );
}

/** A muted pill naming the one currency a small chart covers, when the list spans several. */
function OnlyCurrencyNote({ currency }: { currency: string }) {
  return (
    <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600" title={`The chart shows ${currency} prices only; other currencies are never added in.`}>
      {currency} only
    </span>
  );
}

export function StatCards({
  watches,
  activity,
  activityTruncated,
  activityWindowNote,
  summary,
  onlyExamples,
  now,
}: {
  watches: Watch[];
  activity: ActivityEvent[];
  /** Whether `activity` is a sampled window rather than the account's full history (D72): the alert count below is labelled, not presented as a total. */
  activityTruncated: boolean;
  activityWindowNote: string;
  /**
   * `recovery.summary`: the ONE source of every money figure here (SEC-MF-1, DA-A-34). `tracking.overview` is not a
   * prop on purpose, so none of its money totals can reach this component.
   */
  summary: RecoverySummary;
  /** Only the example is loaded: examples never count toward these totals (DA-A-35), so say so instead of showing zero. */
  onlyExamples: boolean;
  now: number;
}): ReactNode {
  const active = watches.filter((watch) => watch.status === "active");
  const addedThisWeek = active.filter((watch) => watch._creationTime >= now - WEEK).length;
  // QA-2: one series per currency; the small chart shows the currency most of the list is priced in.
  const watchedTotals = watchedTotalsByCurrency(active);
  const watchTrend = watchedTotals[0];
  const cheaper =
    watchTrend !== undefined &&
    watchTrend.series.length > 1 &&
    watchTrend.series[watchTrend.series.length - 1].value <= watchTrend.series[0].value;

  const alerts = activity.filter((event) => event.kind === "price_drop" || event.kind === "alert_sent");
  const alertsToday = alerts.filter((event) => event.at >= startOfDay(now)).length;
  const drops = activity.filter((event) => event.kind === "price_drop").map((event) => event.at);
  const oldestKnown = activity.length >= FEED_CAP ? activity[activity.length - 1].at : undefined;
  const dropsPerDay = perDay(drops, now, 7, oldestKnown);

  const recoveredLines = summary.currencies
    .filter((row) => row.recoveredMinor > 0)
    .map((row) => ({ currency: row.currency, label: formatMinor(row.recoveredMinor, row.currency) }));

  return (
    <div className="space-y-5">
      <div className="grid gap-5 *:min-w-0 lg:grid-cols-3">
        <StatCard
          icon="eye"
          title="Watching"
          badge={watchedTotals.length > 1 && watchTrend && <OnlyCurrencyNote currency={watchTrend.currency} />}
          value={String(active.length)}
          delta={`+${addedThisWeek}`}
          deltaTone={addedThisWeek > 0 ? "good" : "muted"}
          context="this week"
          trend={
            watchTrend && {
              series: watchTrend.series,
              tone: cheaper ? "green" : "red",
              format: (value) => fmt(value, watchTrend.currency),
              label: `Combined price of everything you watch that is priced in ${watchTrend.currency}, over time`,
            }
          }
        />
        <StatCard
          icon="bell"
          title="Price Drop Alerts"
          badge={activityTruncated && <RecentNote windowNote={activityWindowNote} />}
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
          title="Recovered"
          badge={!summary.complete && <PartialNote />}
          value={recoveredLines.length > 0 ? <CurrencyLines lines={recoveredLines} /> : <span className="text-gray-500">—</span>}
          context={
            recoveredLines.length > 0
              ? "back to your card or account, as you confirmed it"
              : onlyExamples
                ? "nothing yet — the example is never counted"
                : "nothing confirmed back yet"
          }
        />
      </div>
      <RecoveryPanel summary={summary} />
    </div>
  );
}

/** The summary read a bounded window (≤ 200 claims, ≤ 200 open opportunities): labelled, never presented as complete. */
function PartialNote() {
  return (
    <span
      className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
      title="Totals cover your 200 most recent claims and open opportunities; older ones are not included."
    >
      Partial
    </span>
  );
}

// ---------------------------------------------------------------------------
// Recovery tiles (contract §3.4, §9): per currency, disjoint, furthest state
// ---------------------------------------------------------------------------

type TileKey = keyof RecoverySummary["currencies"][number]["tiles"];

/** Furthest state last, the order a case moves through (DA-A-17). Each loss sits in exactly one tile. */
const TILES: readonly { key: TileKey; label: string; hint: string }[] = [
  { key: "potential", label: "Potential", hint: "estimated, not guaranteed" },
  { key: "ready", label: "Ready to ask", hint: "an open claim not sent yet" },
  { key: "sendingOrUnknown", label: "Sending or unknown", hint: "not confirmed as sent" },
  { key: "asked", label: "Asked", hint: "sent or submitted; no money yet" },
  { key: "promised", label: "Promised", hint: "promised to you; not received yet" },
];

const NON_CASH_LABELS: Record<string, [string, string]> = {
  voucher: ["voucher", "vouchers"],
  points: ["points award", "points awards"],
  repair: ["repair", "repairs"],
  replacement: ["replacement", "replacements"],
  service_credit: ["service credit", "service credits"],
  fee_waiver: ["fee waiver", "fee waivers"],
  other: ["other non-cash remedy", "other non-cash remedies"],
};

function nonCashLabel(kind: string, count: number): string {
  const [one, many] = NON_CASH_LABELS[kind] ?? ["non-cash remedy", "non-cash remedies"];
  return `${count} ${count === 1 ? one : many}`;
}

function RecoveryPanel({ summary }: { summary: RecoverySummary }) {
  const { counts } = summary;
  const strips = [
    counts.needsAnswers > 0 && `${counts.needsAnswers} ${counts.needsAnswers === 1 ? "path needs" : "paths need"} your answers`,
    counts.deadlinesThisWeek > 0 &&
      `${counts.deadlinesThisWeek} ${counts.deadlinesThisWeek === 1 ? "deadline" : "deadlines"} of yours this week`,
    counts.notYetDue > 0 && `${counts.notYetDue} not yet due`,
  ].filter((strip): strip is string => typeof strip === "string");

  return (
    <section aria-labelledby="recovery-title" className={`${cardClass} p-5`}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="recovery-title" className="font-semibold text-gray-900">
          Recovery by currency
        </h2>
        <p className="text-sm text-gray-500">Each amount counts once, in the furthest step it has reached. Currencies are never added together.</p>
      </header>

      {summary.currencies.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">
          No recovery paths with an amount yet. Recoup checks supported recovery paths as prices and details come in.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {summary.currencies.map((row) => (
            <div key={row.currency} aria-label={`${row.currency} recovery`} role="group">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-600">{row.currency}</p>
              <dl className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                {TILES.map((tile) => {
                  const t = row.tiles[tile.key];
                  return (
                    <div key={tile.key} className="min-w-0 rounded-xl border border-gray-200 px-3.5 py-3">
                      <dt className="text-xs font-medium text-gray-600">{tile.label}</dt>
                      <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-gray-900">
                        {t.components > 0 ? formatMinor(t.amountMinor, row.currency) : <span className="text-gray-500">—</span>}
                      </dd>
                      {t.provisionalMinor > 0 && (
                        <dd className="text-xs text-gray-600">of which provisional {formatMinor(t.provisionalMinor, row.currency)}</dd>
                      )}
                      {tile.key === "asked" && row.askedUserReportedMinor > 0 && (
                        <dd className="text-xs text-gray-600">
                          incl. {formatMinor(row.askedUserReportedMinor, row.currency)} you recorded sending yourself
                        </dd>
                      )}
                      <dd className="mt-0.5 text-xs text-gray-500">{tile.hint}</dd>
                    </div>
                  );
                })}
              </dl>
              {row.overCreditMinor > 0 && (
                <p className="mt-2 text-sm text-red-700">
                  Over-credit / possible double credit: {formatMinor(row.overCreditMinor, row.currency)}. More came back than
                  this loss; check whether a credit was posted twice.
                </p>
              )}
              {row.cappedAtPaidTotal && (
                <p className="mt-2 text-xs text-gray-600">
                  Capped at what you paid{row.paidTotalPartial ? " (cap based on item prices only)" : ""}.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {summary.unsupportedCurrencies.length > 0 && (
        <p className="mt-4 text-sm text-gray-600">
          {summary.unsupportedCurrencies
            .map((row) => `${row.claims} ${row.claims === 1 ? "claim" : "claims"} in ${row.currency}`)
            .join(", ")}{" "}
          {summary.unsupportedCurrencies.length === 1 && summary.unsupportedCurrencies[0].claims === 1 ? "is" : "are"} not in
          these totals: Recoup cannot total that currency yet. Each claim still shows its own amount.
        </p>
      )}

      {(summary.nonCash.length > 0 || strips.length > 0) && (
        <ul className="mt-4 flex flex-wrap gap-2 border-t border-dashed border-gray-200 pt-4 text-sm">
          {summary.nonCash.map((row) => (
            <li key={row.kind} className="rounded-full border border-gray-200 px-2.5 py-0.5 text-gray-700">
              {nonCashLabel(row.kind, row.count)} (non-cash)
            </li>
          ))}
          {strips.map((strip) => (
            <li key={strip} className="rounded-full border border-gray-200 px-2.5 py-0.5 text-gray-700">
              {strip}
            </li>
          ))}
        </ul>
      )}
    </section>
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
