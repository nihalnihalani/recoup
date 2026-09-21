import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { Empty } from "../components/States";
import { ActivityFeed, ActivitySkeleton } from "../components/dashboard/ActivityFeed";
import { MoneyCardsSkeleton, MoneyOnTable, WindowsStrip } from "../components/dashboard/MoneyCards";
import { OverviewCard, OverviewSkeleton } from "../components/dashboard/OverviewCard";
import { ProductCards, ProductCardsSkeleton } from "../components/dashboard/ProductCards";
import { ProductsTable, ProductsTableSkeleton } from "../components/dashboard/ProductsTable";
import { SourcesCard, SourcesSkeleton } from "../components/dashboard/SourcesCard";
import { boughtProduct, byUrgency, mainCurrency, openDropCents, watchProduct } from "../components/dashboard/model";
import type { BoardData } from "../components/dashboard/model";
import { ExampleChip } from "../components/dashboard/parts";
import { cardClass, day, errorText, pageTitleClass, pillWarnClass, primaryButtonClass, secondaryButtonClass, useNow } from "../lib/ui";

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

function PlusIcon() {
  return (
    <svg className="size-4" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M15 7H9V1a1 1 0 0 0-2 0v6H1a1 1 0 0 0 0 2h6v6a1 1 0 0 0 2 0V9h6a1 1 0 0 0 0-2z" />
    </svg>
  );
}

export default function Board() {
  const overview = useQuery(api.tracking.overview);
  const watches = useQuery(api.watches.list);
  const activity = useQuery(api.insights.activity);
  const sources = useQuery(api.insights.sources);
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

  const ready =
    overview !== undefined && watches !== undefined && activity !== undefined && sources !== undefined && board !== undefined;

  const watchButton = (
    <Link to="/watching" className={primaryButtonClass}>
      <PlusIcon />
      Watch a product
    </Link>
  );
  const addButton = (
    <Link to="/settings" className={primaryButtonClass}>
      <PlusIcon />
      Add purchase
    </Link>
  );
  const loadExampleButton = (
    <button type="button" onClick={() => void onLoadExamples()} disabled={loading} className={secondaryButtonClass}>
      {loading ? "Loading…" : "Load example"}
    </button>
  );

  if (!ready) {
    return (
      <div className="space-y-6" role="status" aria-label="Loading dashboard">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className={pageTitleClass}>Dashboard</h1>
        </div>
        <ProductCardsSkeleton />
        <OverviewSkeleton />
        <div className="grid grid-cols-12 gap-6">
          <ProductsTableSkeleton />
          <SourcesSkeleton />
          <ActivitySkeleton />
          <MoneyCardsSkeleton />
        </div>
      </div>
    );
  }

  const items = [...overview.items].sort(byUrgency(now));
  // A watch marked bought lives on as its purchase; listing both would count it twice.
  const watched = watches.filter((watch) => watch.status === "active" || watch.status === "paused").map(watchProduct);
  // Items with a price history lead, so the cards up top have something to draw.
  const bought = [...items.filter((item) => item.points.length > 0), ...items.filter((item) => item.points.length === 0)].map(boughtProduct);
  const products = [...watched, ...bought];
  const nothingYet = products.length === 0 && board.purchases.length === 0;

  // Figures describe real purchases; the example only fills in while there is nothing else.
  const realItems = items.filter((item) => !item.isExample);
  const scoped = realItems.length > 0 ? realItems : items;
  const onlyExamples = realItems.length === 0 && items.length > 0;
  const sourceDrops = sources.reduce((sum, row) => sum + row.drops, 0);
  const stats = {
    onTableCents: scoped.reduce((sum, item) => sum + openDropCents(item, now), 0),
    recoveredCents: onlyExamples
      ? items.reduce((sum, item) => sum + Math.max(item.claim?.confirmedCents ?? 0, 0), 0)
      : overview.totals.recoveredCents,
    drops: sourceDrops > 0 ? sourceDrops : activity.filter((event) => event.kind === "price_drop").length,
    checks: Math.max(overview.totals.checks, sources.reduce((sum, row) => sum + row.checks, 0)),
    currency: mainCurrency(scoped.length > 0 ? scoped.map(boughtProduct) : products),
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className={pageTitleClass}>Dashboard</h1>
        <div className="flex flex-wrap items-center gap-2">
          {products.length === 0 && loadExampleButton}
          {watchButton}
          {addButton}
        </div>
      </div>
      {loadError && (
        <p role="alert" className="text-sm font-medium text-red-700">
          {loadError}
        </p>
      )}

      <NeedsReview purchases={board.purchases} />

      {products.length === 0 ? (
        <Empty
          title={nothingYet ? "Nothing tracked yet" : "No prices to show yet"}
          hint={
            nothingYet
              ? "Watch a product before you buy, or add something you bought. Recoup checks the price and tells you when it falls."
              : "Review the purchases above to start tracking their prices."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {watchButton}
              {addButton}
              {loadExampleButton}
            </div>
          }
        />
      ) : (
        <>
          <ProductCards products={products} />
          <div className="grid grid-cols-12 gap-6">
            <OverviewCard watched={watched} bought={scoped.map(boughtProduct)} stats={stats} />
            <ProductsTable products={products} />
            <SourcesCard sources={sources} now={now} />
            <ActivityFeed events={activity} now={now} />
            <div className="col-span-full space-y-6 xl:col-span-7">
              <MoneyOnTable items={scoped} now={now} />
              <WindowsStrip items={items} now={now} />
            </div>
          </div>
        </>
      )}

      {overview.capped && <p className="text-xs text-gray-400">Showing your 60 most recent purchases.</p>}
    </div>
  );
}
