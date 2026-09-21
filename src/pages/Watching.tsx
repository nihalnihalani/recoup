import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BudgetBanner } from "../components/BudgetBanner";
import { Money } from "../components/Money";
import { ErrorBox } from "../components/States";
import { WatchCard } from "../components/watching/WatchCard";
import { BellIcon, Chip, IconTile, LinkIcon, TagDownIcon } from "../components/watching/parts";
import { dropChip } from "../lib/drops";
import { useCoarseNow } from "../lib/time";
import {
  cardClass,
  cardTitleClass,
  dollarsToCents,
  errorText,
  inputClass,
  pageTitleClass,
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
    <form onSubmit={onSubmit} className={`${sectionClass} space-y-4`} aria-label="Watch a product">
      <div className="flex items-center gap-3">
        <IconTile>
          <BellIcon />
        </IconTile>
        <h2 className={cardTitleClass}>Watch a product</h2>
      </div>
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor="watch-url">
            Product link
          </label>
          <LinkIcon className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-gray-400" />
          <input
            id="watch-url"
            className={`${inputClass} pl-10`}
            type="url"
            required
            placeholder="Paste a product link from any store"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div className="flex gap-3">
          <div className="min-w-0 flex-1 md:w-48 md:flex-none">
            <label className="sr-only" htmlFor="watch-target">
              Target price, optional
            </label>
            <input
              id="watch-target"
              className={`${inputClass} tabular-nums`}
              inputMode="decimal"
              placeholder="Tell me at $ (optional)"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </div>
          <button type="submit" disabled={busy} className={`${primaryButtonClass} shrink-0 px-5`}>
            {busy ? "Adding…" : "Watch"}
          </button>
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      {/* F-T24-1/D114: text-gray-400 on white measured 2.6:1 (WCAG AA needs 4.5:1); text-gray-600 measures 7.56:1. */}
      <p className="text-xs text-gray-600">
        Works with retailers and marketplaces alike. No affiliate links; every price shows where and when it was read.
      </p>
    </form>
  );
}

/** W2 backstop: every price-drop alert, whether or not the email went out. */
function Drops() {
  const drops = useQuery(api.notify.drops);
  const recheckDrop = useMutation(api.notify.recheckDrop);
  const [recheckingId, setRecheckingId] = useState<Id<"mailLog"> | null>(null);
  const [recheckError, setRecheckError] = useState<string | null>(null);

  if (drops === undefined || drops.length === 0) return null;

  async function handleRecheck(mailLogId: Id<"mailLog">) {
    setRecheckError(null);
    setRecheckingId(mailLogId);
    try {
      await recheckDrop({ mailLogId });
    } catch (error) {
      setRecheckError(errorText(error));
    } finally {
      setRecheckingId(null);
    }
  }

  return (
    <section className={sectionClass} aria-labelledby="drops-title">
      <div className="flex items-center gap-3">
        <IconTile>
          <TagDownIcon />
        </IconTile>
        <h2 id="drops-title" className={cardTitleClass}>
          Price drops
        </h2>
      </div>
      <ul className="mt-4 divide-y divide-gray-100 border-t border-dashed border-gray-200">
        {drops.map((drop) => {
          const chip = dropChip(drop);
          return (
            <li key={drop._id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3 text-sm">
              <span className="min-w-0 text-gray-500">
                <span className="font-semibold text-gray-900">{drop.watchName ?? "Item"}</span>
                {drop.cents !== null && (
                  <>
                    {" is now "}
                    <span className="font-semibold tabular-nums text-green-700">
                      <Money cents={drop.cents} currency="USD" />
                    </span>
                  </>
                )}
                {drop.previousCents !== null && (
                  <span className="tabular-nums text-gray-400">
                    {" (was "}
                    <Money cents={drop.previousCents} currency="USD" />)
                  </span>
                )}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs text-gray-400">
                {when(drop._creationTime)}
                <Chip tone={chip.tone}>{chip.label}</Chip>
                {drop.status === "unknown" && drop.canRecheck && (
                  <button
                    type="button"
                    disabled={recheckingId === drop._id}
                    onClick={() => void handleRecheck(drop._id)}
                    className={`${secondaryButtonClass} px-2.5 py-1 text-xs`}
                  >
                    {recheckingId === drop._id ? "Checking…" : "Check again"}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {recheckError && (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-sm text-red-700">
          {recheckError}
        </p>
      )}
    </section>
  );
}

function CardSkeleton() {
  return (
    <div className={`col-span-full xl:col-span-6 ${cardClass} animate-pulse motion-reduce:animate-none`}>
      <div className="flex items-center gap-4 px-5 pt-5">
        <div className="size-14 rounded-xl bg-gray-100" />
        <div className="flex-1 space-y-2">
          <div className="h-4 w-2/3 rounded bg-gray-100" />
          <div className="h-3 w-1/3 rounded bg-gray-100" />
        </div>
      </div>
      <div className="space-y-5 px-5 pb-5 pt-4">
        <div className="h-9 w-36 rounded bg-gray-100" />
        <div className="h-40 rounded-xl bg-gray-100" />
        <div className="grid grid-cols-3 gap-4">
          <div className="h-8 rounded bg-gray-100" />
          <div className="h-8 rounded bg-gray-100" />
          <div className="h-8 rounded bg-gray-100" />
        </div>
        <div className="h-12 rounded-xl bg-gray-100" />
      </div>
    </div>
  );
}

/** First-run invitation. The curve is a decorative shape, not data: no axis, no numbers. */
function EmptyWatching() {
  return (
    <div className={`${cardClass} overflow-hidden text-center`}>
      <div className="px-6 pt-10">
        <p className="text-lg font-semibold text-gray-900">Nothing watched yet</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-gray-500">
          Paste a product link and Recoup starts reading its price. Each check adds a point, and the chart of its ups and
          downs builds from there.
        </p>
        <button
          type="button"
          className={`${secondaryButtonClass} mt-5`}
          onClick={() => document.getElementById("watch-url")?.focus()}
        >
          Paste your first link
        </button>
      </div>
      <svg viewBox="0 0 600 120" preserveAspectRatio="none" className="mt-6 block h-28 w-full" aria-hidden="true">
        <defs>
          <linearGradient id="empty-watch-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-teal)" stopOpacity={0.08} />
            <stop offset="100%" stopColor="var(--color-teal)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d="M0,40 H90 V52 H170 V34 H260 V70 H340 V62 H420 V88 H510 V76 H600 V120 H0 Z" fill="url(#empty-watch-fill)" />
        <path
          d="M0,40 H90 V52 H170 V34 H260 V70 H340 V62 H420 V88 H510 V76 H600"
          fill="none"
          stroke="var(--color-teal)"
          strokeOpacity={0.35}
          strokeWidth={2}
          strokeDasharray="4 6"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

export default function Watching() {
  // `coarseNow` (P06/D73, 5-minute steps) feeds the reactive query so it does
  // not resubscribe on every tick; `now` is a 1-second display clock every
  // countdown/cooldown/"checking…"/"searching…" state derives from, off the
  // query's own RAW timestamps -- never the other way around, and never
  // trusted for eligibility (the buttons still call the mutation and show
  // its error).
  const coarseNow = useCoarseNow();
  const watches = useQuery(api.watches.list, { now: coarseNow });
  const now = useNow(1000);
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
            <Chip tone={active > 0 ? "good" : "muted"}>
              {active} of {watches.length} watching
            </Chip>
            {atTarget > 0 && <Chip tone="good">{atTarget} at target</Chip>}
          </p>
        )}
      </div>

      <BudgetBanner />

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
              coarseNow={coarseNow}
              storesOpen={index < STORES_OPEN_BY_DEFAULT && watch.status !== "bought"}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
