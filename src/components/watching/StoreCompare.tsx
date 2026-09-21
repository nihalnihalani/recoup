import { useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { fmt } from "../Money";
import { ErrorBox } from "../States";
import { StoreAvatar } from "../StoreAvatar";
import { storeInfo } from "../../lib/stores";
import { Chip, ChevronIcon, ExternalIcon, IconTile, StoresIcon, smallButtonClass, smallLabelClass } from "./parts";
import { ago } from "./time";
import { errorText, percent, remainingLabel } from "../../lib/ui";

type Watch = FunctionReturnType<typeof api.watches.list>[number];
type Offer = FunctionReturnType<typeof api.offers.listForWatch>["offers"][number];

const textButtonClass =
  "rounded-lg px-1.5 py-0.5 text-sm font-medium text-gray-500 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

type Row = {
  key: string;
  domain: string;
  url: string;
  cents: number | null;
  currency: string;
  checkedAt: number | null;
  own: boolean;
  offer: Offer | null;
};

/** One store as a horizontal bar. The bar is scaled to the most expensive comparable store. */
function StoreBar({
  row,
  maxCents,
  cheapest,
  comparable,
  vsWatch,
  now,
  onRemove,
}: {
  row: Row;
  maxCents: number;
  cheapest: boolean;
  comparable: boolean;
  vsWatch: number | null;
  now: number;
  onRemove?: () => void;
}) {
  const info = storeInfo(row.domain);
  const ratio = comparable && row.cents !== null && maxCents > 0 ? Math.max(0.02, row.cents / maxCents) : 0;
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <StoreAvatar domain={row.domain} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <a
              href={row.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-w-0 items-center gap-1 text-sm font-semibold text-gray-900 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            >
              <span className="truncate">{info.name}</span>
              <ExternalIcon className="size-3.5 text-gray-400" />
              <span className="sr-only">(opens the store page in a new tab)</span>
            </a>
            {row.own && <Chip>Watched here</Chip>}
            {info.kind === "marketplace" && <Chip>Marketplace</Chip>}
            {cheapest && <Chip tone="good">Cheapest</Chip>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-sm font-semibold tabular-nums ${cheapest ? "text-green-700" : "text-gray-900"}`}>
            {row.cents === null ? "No price read" : fmt(row.cents, row.currency)}
          </p>
        </div>
      </div>
      <div className="mt-1.5 pl-10">
        {ratio > 0 ? (
          <div
            className="h-1.5 rounded-full bg-gray-100"
            title={`${info.name}: ${row.cents === null ? "" : fmt(row.cents, row.currency)}`}
            aria-hidden="true"
          >
            <div
              className={`h-1.5 rounded-full ${cheapest ? "bg-moss" : row.own ? "bg-gray-900" : "bg-gray-300"}`}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        ) : (
          row.cents !== null && <p className="text-xs text-gray-400">Priced in {row.currency}, so it is not ranked against the others.</p>
        )}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-xs text-gray-400">
          <span>
            {row.checkedAt === null ? "Not read yet" : `Read ${ago(now, row.checkedAt)}`}
            {vsWatch !== null && vsWatch !== 0 && (
              <span className={vsWatch < 0 ? "text-green-700" : ""}>
                {" · "}
                {percent(Math.abs(vsWatch))} {vsWatch < 0 ? "less than" : "more than"} the watched store
              </span>
            )}
            {info.kind === "marketplace" && info.note && ` · ${info.note}`}
            {row.offer?.note && ` · ${row.offer.note}`}
          </span>
          {onRemove && (
            <button type="button" className={`${textButtonClass} text-xs`} onClick={onRemove}>
              Not the same item
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

/** The same item at other stores: confirmed matches ranked as bars, candidates waiting for a yes or no. */
export function StoreCompare({ watch, now, defaultOpen }: { watch: Watch; now: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = `stores-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const data = useQuery(api.offers.listForWatch, open ? { watchId: watch._id } : "skip");
  const find = useMutation(api.offers.find);
  const confirm = useMutation(api.offers.confirm);
  const reject = useMutation(api.offers.reject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const watching = watch.status === "active" || watch.status === "paused";
  const currency = watch.currency ?? "USD";
  const confirmed = data?.offers.filter((o) => o.status === "confirmed") ?? [];
  const candidates = data?.offers.filter((o) => o.status === "candidate") ?? [];

  const rows: Row[] = [
    {
      key: "own",
      domain: watch.merchantDomain,
      url: watch.productUrl,
      cents: watch.lastCents,
      currency,
      checkedAt: watch.lastCheckedAt,
      own: true,
      offer: null,
    },
    ...confirmed.map((offer) => ({
      key: offer._id,
      domain: offer.storeDomain,
      url: offer.productUrl,
      cents: offer.lastCents,
      currency: offer.currency ?? currency,
      checkedAt: offer.lastCheckedAt,
      own: false,
      offer,
    })),
  ];
  const comparable = (row: Row) => row.cents !== null && row.currency === currency;
  rows.sort((a, b) => {
    const ra = comparable(a) ? 0 : a.cents !== null ? 1 : 2;
    const rb = comparable(b) ? 0 : b.cents !== null ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return (a.cents ?? 0) - (b.cents ?? 0);
  });
  const ranked = rows.filter(comparable);
  const maxCents = Math.max(0, ...ranked.map((r) => r.cents ?? 0));
  const cheapestKey = ranked.length >= 2 ? ranked[0].key : null;

  const canFind = watching && data !== undefined && !data.searching && data.nextFindAt === null;
  const findLabel =
    data === undefined
      ? "Find other stores"
      : data.searching
        ? "Searching…"
        : data.nextFindAt !== null
          ? `Search again in ${remainingLabel(data.nextFindAt - now)}`
          : confirmed.length + candidates.length === 0
            ? "Find other stores"
            : "Search again";

  return (
    <section className="border-t border-gray-200">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className={`flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition hover:bg-gray-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 ${open ? "" : "rounded-b-2xl"}`}
        >
          <span className="flex min-w-0 items-center gap-3">
            <IconTile>
              <StoresIcon />
            </IconTile>
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-semibold text-gray-900">Same item at other stores</span>
              {data?.best && (
                <span className="text-sm font-medium text-green-700">
                  {storeInfo(data.best.storeDomain).name} has it for {fmt(data.best.cents, data.best.currency)}
                </span>
              )}
            </span>
          </span>
          <ChevronIcon open={open} />
        </button>
      </h3>

      {open && (
        <div id={panelId} className="space-y-4 border-t border-dashed border-gray-200 px-5 pb-5 pt-2">
          {data === undefined ? (
            <div className="space-y-2 pt-2" role="status" aria-label="Loading stores">
              <div className="h-9 animate-pulse rounded-xl bg-gray-100 motion-reduce:animate-none" />
              <div className="h-9 animate-pulse rounded-xl bg-gray-100 motion-reduce:animate-none" />
            </div>
          ) : (
            <>
              <ul className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <StoreBar
                    key={row.key}
                    row={row}
                    maxCents={maxCents}
                    comparable={comparable(row)}
                    cheapest={row.key === cheapestKey}
                    vsWatch={
                      !row.own && comparable(row) && row.cents !== null && watch.lastCents !== null && watch.lastCents > 0
                        ? (row.cents - watch.lastCents) / watch.lastCents
                        : null
                    }
                    now={now}
                    onRemove={
                      row.offer === null
                        ? undefined
                        : () => {
                            const offerId = row.offer?._id;
                            if (offerId) void run(() => reject({ offerId }));
                          }
                    }
                  />
                ))}
              </ul>

              {confirmed.length === 0 && candidates.length === 0 && (
                <p className="text-sm text-gray-500">
                  {data.searching
                    ? "Reading store pages. This takes about a minute."
                    : watching
                      ? "No other stores listed yet. Search to see who else sells it."
                      : "No other stores were compared for this item."}
                </p>
              )}

              {candidates.length > 0 && (
                <div>
                  <p className={`${smallLabelClass} rounded-lg bg-gray-50 px-3 py-2`}>Possible matches</p>
                  <ul className="divide-y divide-gray-100">
                    {candidates.map((offer) => {
                      const info = storeInfo(offer.storeDomain);
                      return (
                        <li key={offer._id} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                          <span className="flex min-w-0 flex-1 basis-48 items-center gap-3">
                            <StoreAvatar domain={offer.storeDomain} size={24} />
                            <span className="min-w-0">
                              <a
                                href={offer.productUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex max-w-full items-center gap-1 text-sm font-medium text-gray-500 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                              >
                                <span className="truncate">{info.name}</span>
                                <ExternalIcon className="size-3.5 text-gray-400" />
                              </a>
                              <span className="block truncate text-xs text-gray-400">
                                {offer.variantMatch === "exact" ? "Looks like the same item" : "May be a different version"}
                                {info.kind === "marketplace" && " · marketplace"}
                                {offer.lastCheckedAt !== null && ` · read ${ago(now, offer.lastCheckedAt)}`}
                              </span>
                            </span>
                          </span>
                          <span className="flex items-center gap-2">
                            <span className="text-sm font-semibold tabular-nums text-gray-900">
                              {offer.lastCents === null ? "—" : fmt(offer.lastCents, offer.currency ?? currency)}
                            </span>
                            <button
                              type="button"
                              disabled={busy}
                              className={smallButtonClass}
                              onClick={() => void run(() => confirm({ offerId: offer._id }))}
                            >
                              Confirm<span className="sr-only"> {info.name} is the same item</span>
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              className={textButtonClass}
                              onClick={() => void run(() => reject({ offerId: offer._id }))}
                            >
                              Reject<span className="sr-only"> {info.name}</span>
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-gray-400">Ranked by price only. No affiliate links, no sponsored placement.</p>
                {watching && (
                  <button
                    type="button"
                    disabled={!canFind || busy}
                    className={smallButtonClass}
                    onClick={() => void run(() => find({ watchId: watch._id }))}
                  >
                    {findLabel}
                  </button>
                )}
              </div>
            </>
          )}
          {error && <ErrorBox error={error} />}
        </div>
      )}
    </section>
  );
}
