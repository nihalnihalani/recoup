import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { BudgetBanner } from "../components/BudgetBanner";
import { ActivitySkeleton, ActivityTimeline } from "../components/dashboard/ActivityTimeline";
import { PriceHistoryCard } from "../components/dashboard/PriceHistoryCard";
import { PurchasesTable, PurchasesTableSkeleton } from "../components/dashboard/PurchasesTable";
import { SourcesCard, SourcesSkeleton } from "../components/dashboard/SourcesCard";
import { StatCards, StatCardsSkeleton } from "../components/dashboard/StatCards";
import { TrackedTable, TrackedTableSkeleton } from "../components/dashboard/TrackedTable";
import { Icon } from "../components/dashboard/icons";
import { byUrgency } from "../components/dashboard/model";
import type { BoardData } from "../components/dashboard/model";
import { ExampleChip, focusRing } from "../components/dashboard/parts";
import { cardClass, day, errorText, primaryButtonClass, secondaryButtonClass, useNow } from "../lib/ui";
import { useCoarseNow } from "../lib/time";

function NeedsReview({ purchases }: { purchases: BoardData["purchases"] }) {
  const pending = purchases.filter((row) => row.purchase.status === "needs_review");
  if (pending.length === 0) return null;
  return (
    <section aria-labelledby="needs-review" className={`${cardClass} flex flex-wrap items-center gap-x-4 gap-y-3 border-yellow-500/60 px-5 py-4`}>
      <h2 id="needs-review" className="flex items-center gap-2 text-sm font-semibold text-gray-900">
        <span className="flex size-7 items-center justify-center rounded-lg bg-yellow-500/20 text-yellow-700">
          <Icon name="alert" />
        </span>
        {pending.length === 1 ? "1 purchase needs a look" : `${pending.length} purchases need a look`}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {pending.map(({ purchase }) => (
          <li key={purchase._id}>
            <Link
              to={`/purchases/${purchase._id}`}
              className={`inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-sm transition-colors hover:bg-gray-50 motion-reduce:transition-none ${focusRing}`}
            >
              <span className="font-medium text-gray-900">{purchase.merchant || purchase.merchantDomain || "Unknown merchant"}</span>
              <span className="text-xs tabular-nums text-gray-400">{day(purchase.purchasedAt)}</span>
              {purchase.isExample && <ExampleChip />}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Board() {
  // `coarseNow` (P06/D73, 5-minute steps) feeds every reactive query that
  // takes one, so this page's own re-render cadence never resubscribes them;
  // `now` stays the page's existing 1-minute display clock for relative
  // day/window text elsewhere on the dashboard.
  const coarseNow = useCoarseNow();
  const overview = useQuery(api.tracking.overview, { now: coarseNow });
  const watches = useQuery(api.watches.list, { now: coarseNow });
  const activity = useQuery(api.insights.activity);
  const sources = useQuery(api.insights.sources);
  const board = useQuery(api.purchases.board);
  const tracked = useQuery(api.insights.trackedTable, { now: coarseNow });
  // Every recovery money figure comes from here, never from `tracking.overview` (DA-A-34).
  const summary = useQuery(api.recovery.summary, { now: coarseNow });
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

  const items = overview === undefined ? undefined : [...overview.items].sort(byUrgency(now));
  // Examples never count toward recovery totals (DA-A-35); the cards say so while the example is all there is.
  const realItems = items?.filter((item) => !item.isExample) ?? [];
  const onlyExamples = realItems.length === 0 && (items?.length ?? 0) > 0;

  const liveWatches = watches?.filter((watch) => watch.status === "active" || watch.status === "paused") ?? [];
  const known = overview !== undefined && watches !== undefined && board !== undefined;
  const noProducts = known && liveWatches.length === 0 && overview.items.length === 0;
  const nothingYet = noProducts && board.purchases.length === 0;

  const loadExampleButton = (
    <button type="button" onClick={() => void onLoadExamples()} disabled={loading} className={secondaryButtonClass}>
      {loading ? "Loading…" : "Load example"}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {noProducts && !nothingYet && loadExampleButton}
        <Link to="/settings" className={secondaryButtonClass}>
          Add purchase
        </Link>
        <Link to="/watching" className={primaryButtonClass}>
          <Icon name="plus" />
          Watch a product
        </Link>
      </div>
      {loadError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {loadError}
        </p>
      )}

      <BudgetBanner />

      {board !== undefined && <NeedsReview purchases={board.purchases} />}

      {nothingYet ? (
        <section className={`${cardClass} border-dashed border-gray-300 px-6 py-16 text-center`} aria-labelledby="empty-title">
          <h2 id="empty-title" className="text-lg font-semibold text-gray-900">
            Nothing tracked yet
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
            Watch a product before you buy, or add something you bought. Recoup checks the price every two hours and tells you when it falls.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link to="/watching" className={primaryButtonClass}>
              <Icon name="plus" />
              Watch a product
            </Link>
            {loadExampleButton}
          </div>
        </section>
      ) : (
        <>
          {watches === undefined || activity === undefined || overview === undefined || summary === undefined ? (
            <StatCardsSkeleton />
          ) : (
            <StatCards
              watches={watches}
              activity={activity.events}
              activityTruncated={activity.truncated}
              activityWindowNote={activity.windowNote}
              summary={summary}
              onlyExamples={onlyExamples}
              now={now}
            />
          )}

          <div className="grid gap-5 *:min-w-0 lg:grid-cols-3">
            <PriceHistoryCard now={now} />
            {activity === undefined ? (
              <ActivitySkeleton />
            ) : (
              <ActivityTimeline events={activity.events} truncated={activity.truncated} windowNote={activity.windowNote} />
            )}
          </div>

          {tracked === undefined ? <TrackedTableSkeleton /> : <TrackedTable rows={tracked} />}

          <div className="grid gap-5 *:min-w-0 lg:grid-cols-3">
            {items === undefined || overview === undefined ? (
              <PurchasesTableSkeleton />
            ) : (
              <PurchasesTable items={items} now={now} truncated={overview.truncated} />
            )}
            {sources === undefined ? (
              <SourcesSkeleton />
            ) : (
              <SourcesCard sources={sources.rows} truncated={sources.truncated} windowNote={sources.windowNote} now={now} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
