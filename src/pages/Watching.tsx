import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Money } from "../components/Money";
import { ErrorBox } from "../components/States";
import { WatchCard } from "../components/watching/WatchCard";
import {
  cardClass,
  cardTitleClass,
  dollarsToCents,
  errorText,
  inputClass,
  pageTitleClass,
  pillGoodClass,
  pillMutedClass,
  pillWarnClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  useNow,
  when,
} from "../lib/ui";

/** Cards whose "other stores" section starts open, so a long list does not open a query per card. */
const STORES_OPEN_BY_DEFAULT = 4;

function AddWatch() {
  const create = useMutation(api.watches.create);
  const [url, setUrl] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const targetCents = target.trim() === "" ? undefined : dollarsToCents(target);
    if (targetCents === null) {
      setError("Enter the target price as a number, like 89.99");
      return;
    }
    setBusy(true);
    try {
      await create({ productUrl: url.trim(), targetCents });
      setUrl("");
      setTarget("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={`${sectionClass} space-y-3`} aria-label="Watch a product">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor="watch-url">
            Product link
          </label>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          >
            <path
              d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2.4-2.4a2.8 2.8 0 0 0-4-4l-.9.9M9.2 6.8a2.8 2.8 0 0 0-4 0L2.8 9.2a2.8 2.8 0 0 0 4 4l.9-.9"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
          <input
            id="watch-url"
            className={`${inputClass} py-2.5 pl-9`}
            type="url"
            required
            placeholder="Paste a product link from any store"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 md:w-40 md:flex-none">
            <label className="sr-only" htmlFor="watch-target">
              Target price, optional
            </label>
            <input
              id="watch-target"
              className={`${inputClass} py-2.5 tabular-nums`}
              inputMode="decimal"
              placeholder="Tell me at $ (optional)"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
          <button type="submit" disabled={busy} className={`${primaryButtonClass} shrink-0 px-5 py-2.5`}>
            {busy ? "Adding…" : "Watch"}
          </button>
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      <p className="text-xs text-gray-400">
        Works with retailers and marketplaces alike. No affiliate links; every price shows where and when it was read.
      </p>
    </form>
  );
}

/** W2 backstop: every price-drop alert, whether or not the email went out. */
function Drops() {
  const drops = useQuery(api.notify.drops);
  if (drops === undefined || drops.length === 0) return null;
  return (
    <section className={`${sectionClass} space-y-2`}>
      <h2 className={cardTitleClass}>Price drops</h2>
      <ul className="divide-y divide-gray-100">
        {drops.map((drop) => (
          <li key={drop._id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="text-gray-800">
              {drop.watchName ?? "Item"}
              {drop.cents !== null && (
                <>
                  {" is now "}
                  <Money cents={drop.cents} currency="USD" />
                </>
              )}
              {drop.previousCents !== null && (
                <span className="text-gray-400">
                  {" (was "}
                  <Money cents={drop.previousCents} currency="USD" />)
                </span>
              )}
            </span>
            <span className="flex items-center gap-2 text-xs text-gray-400">
              {when(drop._creationTime)}
              <span className={drop.status === "sent" ? pillGoodClass : drop.status === "failed" ? pillWarnClass : pillMutedClass}>
                {drop.status === "sent" ? "Emailed" : drop.status === "failed" ? (drop.error ?? "Not emailed") : "Sending"}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CardSkeleton() {
  return (
    <div className={`col-span-full xl:col-span-6 ${cardClass} animate-pulse`}>
      <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
        <div className="h-10 w-10 rounded-full bg-gray-100" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 rounded bg-gray-100" />
          <div className="h-3 w-1/3 rounded bg-gray-100" />
        </div>
      </div>
      <div className="space-y-4 px-5 py-4">
        <div className="h-9 w-36 rounded bg-gray-100" />
        <div className="h-40 rounded-lg bg-gray-100" />
        <div className="grid grid-cols-3 gap-4">
          <div className="h-8 rounded bg-gray-100" />
          <div className="h-8 rounded bg-gray-100" />
          <div className="h-8 rounded bg-gray-100" />
        </div>
        <div className="h-10 rounded-lg bg-gray-100" />
      </div>
    </div>
  );
}

/** First-run invitation. The curve is a decorative shape, not data: no axis, no numbers. */
function EmptyWatching() {
  return (
    <div className={`${cardClass} overflow-hidden text-center`}>
      <div className="px-6 pt-10">
        <p className="text-lg font-semibold text-gray-800">Nothing watched yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
          Paste a product link and Recoup starts reading its price. Each check adds a point, and the chart of its ups and
          downs builds from there.
        </p>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-4`}
          onClick={() => document.getElementById("watch-url")?.focus()}
        >
          Paste your first link
        </button>
      </div>
      <svg viewBox="0 0 600 120" preserveAspectRatio="none" className="mt-6 block h-28 w-full" aria-hidden="true">
        <defs>
          <linearGradient id="empty-watch-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-violet-500)" stopOpacity={0.12} />
            <stop offset="100%" stopColor="var(--color-violet-500)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d="M0,40 H90 V52 H170 V34 H260 V70 H340 V62 H420 V88 H510 V76 H600 V120 H0 Z" fill="url(#empty-watch-fill)" />
        <path
          d="M0,40 H90 V52 H170 V34 H260 V70 H340 V62 H420 V88 H510 V76 H600"
          fill="none"
          stroke="var(--color-violet-500)"
          strokeOpacity={0.25}
          strokeWidth={2}
          strokeDasharray="4 6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

export default function Watching() {
  const watches = useQuery(api.watches.list);
  const now = useNow();
  // Live watches first, in the order the server gives them; bought ones settle at the end.
  const ordered =
    watches === undefined
      ? undefined
      : [...watches.filter((w) => w.status !== "bought"), ...watches.filter((w) => w.status === "bought")];
  const active = watches?.filter((w) => w.status === "active").length ?? 0;
  const atTarget = watches?.filter((w) => w.targetHit && w.status !== "bought").length ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={pageTitleClass}>Watching</h1>
          <p className="mt-1 text-sm text-gray-500">
            Haven’t bought yet? Paste the link. Recoup reads the price and tells you when to buy.
          </p>
        </div>
        {watches !== undefined && watches.length > 0 && (
          <p className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
            <span className={pillMutedClass}>
              {active} of {watches.length} active
            </span>
            {atTarget > 0 && <span className={pillGoodClass}>↓ {atTarget} at target</span>}
          </p>
        )}
      </div>

      <AddWatch />

      <Drops />

      {ordered === undefined ? (
        <div className="grid grid-cols-12 gap-6" role="status" aria-label="Loading watched items">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : ordered.length === 0 ? (
        <EmptyWatching />
      ) : (
        <ul className="grid grid-cols-12 gap-6">
          {ordered.map((watch, index) => (
            <WatchCard
              key={watch._id}
              watch={watch}
              now={now}
              storesOpen={index < STORES_OPEN_BY_DEFAULT && watch.status !== "bought"}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
