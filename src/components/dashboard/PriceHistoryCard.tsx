import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { MultiLineChart } from "../charts/MultiLineChart";
import { fmt } from "../../lib/money";
import { ProductThumb } from "../ProductThumb";
import { StoreAvatar } from "../StoreAvatar";
import { cardClass, cardTitleClass, primaryButtonClass } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import { Icon } from "./icons";
import { SERIES_COLORS, agoLong } from "./model";
import type { PriceHistory } from "./model";
import { Bone, PctChange, focusRing } from "./parts";

type Range = "all" | "7d" | "24h";
const RANGES: { id: Range; label: string; ms: number | null }[] = [
  { id: "all", label: "All", ms: null },
  { id: "7d", label: "7d", ms: 7 * 86_400_000 },
  { id: "24h", label: "24h", ms: 86_400_000 },
];

const STATUS: Record<PriceHistory["status"], string> = {
  active: "Watching",
  paused: "Paused",
  bought: "Bought",
  archived: "Archived",
};

function Frame({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={`${cardClass} p-5 lg:col-span-2`} aria-labelledby="history-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="history-title" className={cardTitleClass}>
          Price History
        </h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export function PriceHistoryCard({ now }: { now: number }) {
  const [picked, setPicked] = useState<Id<"watches"> | undefined>(undefined);
  const [range, setRange] = useState<Range>("all");
  const result = useQuery(api.insights.priceHistory, picked === undefined ? {} : { watchId: picked });
  // The last answer stays on screen while the next product loads, so the card never blinks empty.
  const [shown, setShown] = useState(result);
  // A picked watch that has since been archived or removed answers null: return to the default pick.
  const pickGone = result === null && picked !== undefined;
  if (pickGone) setPicked(undefined);
  else if (result !== undefined && result !== shown) setShown(result);
  const selectId = useId();

  if (shown === undefined) return <PriceHistorySkeleton />;

  if (shown === null) {
    return (
      <Frame>
        <div className="mt-5 flex flex-col items-center rounded-xl border border-dashed border-gray-300 px-6 py-14 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl border border-gray-200 text-gray-500">
            <Icon name="down" className="size-5" />
          </span>
          <p className="mt-4 font-semibold text-gray-900">Watch a product to see its price across stores</p>
          <p className="mt-1.5 max-w-sm text-sm text-gray-500">
            Paste a product link. Recoup reads its price every two hours and looks for the same product at other stores.
          </p>
          <Link to="/watching" className={`${primaryButtonClass} mt-5`}>
            <Icon name="plus" />
            Watch a product
          </Link>
        </div>
      </Frame>
    );
  }

  const history = shown;
  const loadingNext = result === undefined;
  const from = RANGES.find((r) => r.id === range)?.ms ?? null;
  const visible = (at: number) => from === null || at >= now - from;

  // A store keeps its colour slot whatever the range hides. Past six stores there are no more honest hues.
  const charted = history.stores.slice(0, SERIES_COLORS.length);
  const uncharted = history.stores.length - charted.length;
  const series = charted.map((store, i) => ({
    id: `${i}:${store.domain}`,
    label: storeInfo(store.domain).name,
    color: SERIES_COLORS[i].color,
    points: store.points.filter((p) => visible(p.at)).map((p) => ({ at: p.at, value: p.cents })),
  }));

  let lowest: { at: number; value: number; seriesId: string; label: string } | undefined;
  for (const s of series) {
    for (const p of s.points) {
      if (lowest === undefined || p.value < lowest.value || (p.value === lowest.value && p.at < lowest.at)) {
        lowest = { at: p.at, value: p.value, seriesId: s.id, label: "Lowest price" };
      }
    }
  }

  const primary = history.stores.find((store) => store.isPrimary) ?? history.stores[0];
  // P06-OW-2: the age of the newest PRICED read, never the last check attempt (which counts failed reads).
  const pricedAt = primary && primary.points.length > 0 ? Math.max(...primary.points.map((p) => p.at)) : undefined;
  const subline = [
    primary ? storeInfo(primary.domain).name : undefined,
    STATUS[history.status],
    pricedAt !== undefined ? `price read ${agoLong(pricedAt, now)}` : primary ? "no price read yet" : undefined,
    history.lowest ? `lowest ${fmt(history.lowest.cents, history.currency)} at ${storeInfo(history.lowest.domain).name}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return (
    <Frame
      aside={
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <label htmlFor={selectId} className="sr-only">
              Product
            </label>
            <select
              id={selectId}
              value={history.watchId}
              onChange={(event) => setPicked(history.options.find((option) => option.watchId === event.target.value)?.watchId)}
              className={`max-w-[14rem] cursor-pointer appearance-none truncate rounded-xl border border-gray-200 bg-white py-2 pl-3 pr-9 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 motion-reduce:transition-none ${focusRing}`}
            >
              {history.options.map((option) => (
                <option key={option.watchId} value={option.watchId}>
                  {option.name}
                  {option.stores > 1 ? ` (${option.stores} stores)` : ""}
                </option>
              ))}
            </select>
            <Icon name="chevron" className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-gray-400" />
          </div>
          <div role="radiogroup" aria-label="Time range" className="flex rounded-xl border border-gray-200 p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={range === r.id}
                onClick={() => setRange(r.id)}
                className={`rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors motion-reduce:transition-none ${focusRing} ${
                  range === r.id ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:text-gray-900"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      }
    >
      <div className={`transition-opacity duration-200 motion-reduce:transition-none ${loadingNext ? "opacity-50" : ""}`} aria-busy={loadingNext}>
        <div className="mt-5 flex items-center gap-4">
          <ProductThumb imageUrl={history.imageUrl} name={history.name} size={72} domain={primary?.domain} />
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-gray-900" title={history.name}>
              {history.name}
            </p>
            <p className="mt-0.5 text-sm text-gray-500">{subline.join(", ")}</p>
          </div>
        </div>

        <ul className="mt-4 flex flex-wrap gap-2" aria-label="Current price by store">
          {history.stores.map((store, i) => (
            <li key={`${i}:${store.domain}`}>
              <a
                href={store.productUrl}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${storeInfo(store.domain).name}: ${store.lastCents === null ? "no price yet" : fmt(store.lastCents, history.currency)}. Opens the store page.`}
                className={`flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 transition-colors hover:bg-gray-50 motion-reduce:transition-none ${focusRing}`}
              >
                <StoreAvatar domain={store.domain} size={20} />
                <span className="text-sm font-semibold tabular-nums text-gray-900">
                  {store.lastCents === null ? "No price" : fmt(store.lastCents, history.currency)}
                </span>
                <PctChange pct={store.changePct} />
              </a>
            </li>
          ))}
        </ul>

        <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Chart legend">
          {charted.map((store, i) => (
            <li key={`${i}:${store.domain}`} className="flex items-center gap-1.5 text-xs font-medium text-gray-600">
              <span aria-hidden="true" className={`size-2 rounded-full ${SERIES_COLORS[i].dot}`} />
              {storeInfo(store.domain).name}
            </li>
          ))}
          {uncharted > 0 && (
            <li className="text-xs text-gray-400">
              {uncharted} more {uncharted === 1 ? "store" : "stores"} not charted
            </li>
          )}
        </ul>

        <div className="mt-3">
          <MultiLineChart
            key={`${history.watchId}:${range}`}
            series={series}
            format={(value) => fmt(value, history.currency)}
            height={280}
            highlight={lowest}
            reference={history.targetCents === null ? undefined : { value: history.targetCents, label: `Your target ${fmt(history.targetCents, history.currency)}` }}
            ariaLabel={`Price of ${history.name} at ${charted.length} ${charted.length === 1 ? "store" : "stores"}`}
          />
        </div>
      </div>
    </Frame>
  );
}

export function PriceHistorySkeleton() {
  return (
    <div className={`${cardClass} p-5 lg:col-span-2`} aria-hidden="true">
      <div className="flex items-center justify-between gap-3">
        <Bone className="h-5 w-28" />
        <div className="flex gap-2">
          <Bone className="h-9 w-40 rounded-xl" />
          <Bone className="h-9 w-32 rounded-xl" />
        </div>
      </div>
      <div className="mt-5 flex items-center gap-4">
        <Bone className="size-[72px] rounded-xl" />
        <div className="space-y-2.5">
          <Bone className="h-5 w-56" />
          <Bone className="h-3.5 w-40" />
        </div>
      </div>
      <div className="mt-4 flex gap-2">
        {[0, 1, 2].map((i) => (
          <Bone key={i} className="h-10 w-32 rounded-xl" />
        ))}
      </div>
      <Bone className="mt-6 h-[280px] w-full rounded-xl" />
    </div>
  );
}
