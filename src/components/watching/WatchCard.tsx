import { useState } from "react";
import { useMutation } from "convex/react";
import { Link, useNavigate } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { AreaChart } from "../charts/AreaChart";
import { MarketHistory } from "./MarketHistory";
import { fmt } from "../../lib/money";
import { ProductThumb } from "../ProductThumb";
import { ErrorBox } from "../States";
import { StoreAvatar } from "../StoreAvatar";
import { storeInfo } from "../../lib/stores";
import { StoreCompare } from "./StoreCompare";
import { Chip, DeltaChip, PencilIcon, quietButtonClass, smallButtonClass, smallLabelClass, type Tone } from "./parts";
import { ago } from "./time";
import { isChecking } from "../../lib/time";
import {
  bigNumberClass,
  cardClass,
  centsToDollars,
  day,
  dollarsToCents,
  errorText,
  fromDateInput,
  todayInput,
  inputClass,
  labelClass,
  percent,
  primaryButtonClass,
  remainingLabel,
  secondaryButtonClass,
} from "../../lib/ui";

type Watch = FunctionReturnType<typeof api.watches.list>[number];

/** `watches.list` returns at most this many accepted observations per watch. */
const SPARK_CAP = 30;

const VERDICT: Record<Watch["verdict"]["label"], { text: string; tone: Tone }> = {
  good_price: { text: "Good price", tone: "good" },
  fair: { text: "Fair price", tone: "muted" },
  wait: { text: "Wait", tone: "wait" },
  inflated_discount: { text: "Discount looks inflated", tone: "bad" },
  not_enough_history: { text: "Not enough history yet", tone: "muted" },
  unknown: { text: "No price yet", tone: "muted" },
};

function StatusChip({ watch, checking }: { watch: Watch; checking: boolean }) {
  if (checking) {
    return (
      <Chip tone="busy" pulse>
        Checking…
      </Chip>
    );
  }
  if (watch.status === "paused") return <Chip tone="wait">Paused</Chip>;
  if (watch.status === "bought") return <Chip tone="muted">Bought</Chip>;
  return <Chip tone="good">Watching</Chip>;
}

/** The product photo, with the store's mark pinned to its corner. Without a photo, the store tile stands in. */
function ProductTile({ watch }: { watch: Watch }) {
  if (watch.imageUrl === null) {
    return (
      <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-gray-100">
        <StoreAvatar domain={watch.merchantDomain} size={32} />
      </span>
    );
  }
  return (
    <span className="relative shrink-0">
      <ProductThumb imageUrl={watch.imageUrl} name={watch.name} size={56} />
      <span className="absolute -bottom-1 -right-1 rounded-lg bg-white p-0.5">
        <StoreAvatar domain={watch.merchantDomain} size={18} />
      </span>
    </span>
  );
}

/** The product name, renamed in place. */
function Name({ watch }: { watch: Watch }) {
  const rename = useMutation(api.watches.rename);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(watch.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (value.trim() === "") return setError("Give the item a name");
    setBusy(true);
    try {
      await rename({ watchId: watch._id, name: value.trim() });
      setEditing(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1">
        <h2 className="truncate text-base font-semibold text-gray-900" title={watch.name}>
          {watch.name}
        </h2>
        <button
          type="button"
          className="shrink-0 rounded-lg p-1 text-gray-400 transition hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          onClick={() => {
            setValue(watch.name);
            setError(null);
            setEditing(true);
          }}
        >
          <PencilIcon className="size-4" />
          <span className="sr-only">Rename {watch.name}</span>
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`name-${watch._id}`}>
          Item name
        </label>
        <input
          id={`name-${watch._id}`}
          className={`${inputClass} min-w-0 flex-1 basis-40 py-2`}
          value={value}
          maxLength={200}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button type="submit" disabled={busy} className={smallButtonClass}>
          {busy ? "Saving…" : "Save name"}
        </button>
        <button type="button" className={quietButtonClass} onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
      {error && <ErrorBox error={error} />}
    </form>
  );
}

/** "Tell me at": set, change or clear the target price. */
function TargetControl({ watch, currency }: { watch: Watch; currency: string }) {
  const setTarget = useMutation(api.watches.setTarget);
  const saved = watch.targetCents === null ? "" : centsToDollars(watch.targetCents);
  const [value, setValue] = useState(saved);
  const [syncedTo, setSyncedTo] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The saved target changed elsewhere (or just saved): show it, unless the field is mid-edit.
  if (saved !== syncedTo) {
    setSyncedTo(saved);
    setValue(saved);
  }
  const dirty = value.trim() !== saved;

  async function save(targetCents: number | null) {
    setError(null);
    setBusy(true);
    try {
      await setTarget({ watchId: watch._id, targetCents });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (value.trim() === "") return void save(null);
    const cents = dollarsToCents(value);
    if (cents === null || cents <= 0) return setError("Enter the target price as a number, like 89.99");
    void save(cents);
  }

  return (
    <div
      className={`rounded-xl border px-3.5 py-3 ${watch.targetHit ? "border-green-500/40 bg-green-500/5" : "border-gray-200 bg-white"}`}
    >
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className="shrink-0 text-sm font-semibold text-gray-900" htmlFor={`target-${watch._id}`}>
          Tell me at
        </label>
        <input
          id={`target-${watch._id}`}
          className={`${inputClass} w-28 py-2 tabular-nums`}
          inputMode="decimal"
          placeholder="89.99"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {dirty && (
          <button type="submit" disabled={busy} className={smallButtonClass}>
            {busy ? "Saving…" : value.trim() === "" ? "Clear target" : "Save target"}
          </button>
        )}
        {!dirty && watch.targetCents !== null && (
          <button type="button" disabled={busy} className={quietButtonClass} onClick={() => void save(null)}>
            Clear
          </button>
        )}
        <span className="min-w-0 text-sm text-gray-500">
          {watch.targetHit ? (
            <span className="font-semibold text-green-700">At or below your target</span>
          ) : watch.targetCents !== null && watch.lastCents !== null ? (
            <><span className="font-semibold tabular-nums text-gray-900">{fmt(watch.lastCents - watch.targetCents, currency)}</span> to go</>
          ) : watch.targetCents === null ? (
            "Set a price and Recoup emails you when it gets there."
          ) : null}
        </span>
      </form>
      {error && <ErrorBox error={error} className="mt-2" />}
    </div>
  );
}

/** W4: the watched item was bought. It becomes a purchase with its price-adjustment window counting down. */
function BoughtForm({ watch, onDone }: { watch: Watch; onDone: () => void }) {
  const markBought = useMutation(api.watches.markBought);
  const navigate = useNavigate();
  const [paid, setPaid] = useState(watch.lastCents === null ? "" : centsToDollars(watch.lastCents));
  // Today in the shopper's own timezone; an ISO (UTC) date is tomorrow for evening shoppers in the Americas.
  const [date, setDate] = useState(() => todayInput());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const paidCents = dollarsToCents(paid);
    // QA-M16-4: today is "now", an earlier day is never later than now, a later day is refused.
    const now = Date.now();
    const purchasedAt = fromDateInput(date, { now });
    if (paidCents === null || paidCents <= 0) return setError("Enter what you paid, like 89.99");
    if (date > todayInput(now)) return setError("The day you bought it can't be in the future");
    if (purchasedAt === null) return setError("Pick the day you bought it");
    setBusy(true);
    try {
      const purchaseId = await markBought({ watchId: watch._id, paidCents, purchasedAt });
      onDone();
      navigate(`/purchases/${purchaseId}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-xl border border-gray-200 p-4">
      <p className="text-sm text-gray-500">
        Recoup will keep watching after you buy and tell you if the store owes you the difference.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`paid-${watch._id}`}>
            Price you paid
          </label>
          <input
            id={`paid-${watch._id}`}
            className={inputClass}
            inputMode="decimal"
            value={paid}
            onChange={(e) => setPaid(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor={`date-${watch._id}`}>
            Bought on
          </label>
          <input
            id={`date-${watch._id}`}
            className={inputClass}
            type="date"
            max={todayInput()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Saving…" : "Start the window"}
        </button>
        <button type="button" className={secondaryButtonClass} onClick={onDone}>
          Cancel
        </button>
      </div>
      {error && <ErrorBox error={error} />}
    </form>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className={smallLabelClass}>{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold tabular-nums text-gray-900">{value}</dd>
      {hint && <dd className="truncate text-xs text-gray-400">{hint}</dd>}
    </div>
  );
}

/**
 * One watched product as an analytics card: price now, its history, the
 * verdict, the target, other stores. `now` is the 1-second display tick;
 * `coarseNow` is the separate 5-minute clock (P06/D73) forwarded to
 * `StoreCompare`'s own reactive query so a per-second tick never resubscribes it.
 */
export function WatchCard({
  watch,
  now,
  coarseNow,
  storesOpen,
}: {
  watch: Watch;
  now: number;
  coarseNow: number;
  storesOpen: boolean;
}) {
  const checkNow = useMutation(api.watches.checkNow);
  const setStatus = useMutation(api.watches.setStatus);
  const archive = useMutation(api.watches.archive);
  const [buying, setBuying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currency = watch.currency ?? "USD";
  const money = (cents: number) => fmt(cents, currency);
  const store = storeInfo(watch.merchantDomain);
  const verdict = VERDICT[watch.verdict.label];
  const live = watch.status === "active" || watch.status === "paused";
  // P06/D73: `checking` is no longer a server field -- derived from the raw
  // request/completion timestamps plus this card's own clock (never trusted
  // for eligibility; "Check now" still calls the mutation and shows its error).
  const checking = isChecking(watch.checkRequestedAt, watch.lastCheckedAt, now);
  // A verdict computed from thin/stale/third-party evidence (lib/verdict.ts's
  // `verdictWithQualifier`) must never read as a plain, confident claim -- so
  // a caveat is shown whenever `qualified` is true, and "Good price" is never
  // presented unqualified.
  const qualifiedReason = watch.verdict.qualified === true ? watch.verdict.qualifiedReason : null;

  // Everything below is computed from the accepted observations `watches.list` returns.
  const series = watch.spark.map((p) => ({ at: p.observedAt, value: p.observedCents }));
  const values = series.map((p) => p.value);
  const first = values[0];
  const low = values.length > 0 ? Math.min(...values) : null;
  const high = values.length > 0 ? Math.max(...values) : null;
  const average = values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
  const swing = low !== null && high !== null && average !== null && average > 0 ? (high - low) / average : null;
  const capped = values.length >= SPARK_CAP;
  const change = watch.lastCents !== null && first !== undefined && first > 0 ? (watch.lastCents - first) / first : null;

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

  return (
    <li className={`col-span-full flex flex-col xl:col-span-6 ${cardClass}`}>
      <header className="flex items-start gap-4 px-5 pt-5">
        <ProductTile watch={watch} />
        <div className="min-w-0 flex-1">
          <Name watch={watch} />
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500">
            <a
              href={watch.productUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            >
              {store.name}
              <span className="sr-only"> (opens the product page in a new tab)</span>
            </a>
            {store.kind === "marketplace" && <Chip>Marketplace</Chip>}
          </p>
          {store.kind === "marketplace" && store.note && <p className="mt-1 text-xs text-gray-400">{store.note}</p>}
        </div>
        <div className="shrink-0">
          <StatusChip watch={watch} checking={checking} />
        </div>
      </header>

      <div className="space-y-5 px-5 pb-5 pt-4">
        <div className="border-t border-dashed border-gray-200 pt-4">
          <p className={smallLabelClass}>Price now</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`${bigNumberClass} tabular-nums`}>{watch.lastCents === null ? "—" : money(watch.lastCents)}</span>
            {change !== null && <DeltaChip ratio={change} />}
            {watch.listCents !== null && watch.lastCents !== null && watch.listCents > watch.lastCents && (
              <span className="text-sm text-gray-400">
                <span className="sr-only">The store says it was </span>
                <s className="tabular-nums">{money(watch.listCents)}</s>
              </span>
            )}
          </div>
          {/* The last ACCEPTED observation (P06/D73), distinct from "last checked" below,
              which also counts failed attempts that produced no price. */}
          <p className="mt-1 text-xs text-gray-400">
            {watch.lastObservedAt === null ? "No price read yet" : `Price as of ${ago(now, watch.lastObservedAt)}`}
            {watch.priceStale && <span className="text-yellow-700"> · may be out of date</span>}
          </p>
          {change !== null && first !== undefined && (
            <p className="mt-1 text-xs text-gray-400">
              {change === 0 ? "Same as" : "Compared with"} the first price read, {money(first)}
              {capped && " (oldest of the latest 30 reads)"}
            </p>
          )}
        </div>

        {series.length >= 2 ? (
          <AreaChart
            series={series}
            reference={watch.targetCents === null ? undefined : { value: watch.targetCents, label: "Target" }}
            height={160}
            showAxes
            curve="step"
            tone="sky"
            format={money}
            ariaLabel={`Price of ${watch.name} at ${store.name} since ${day(series[0].at)}`}
          />
        ) : (
          <div className="flex h-[160px] items-center justify-center rounded-xl border border-dashed border-gray-200 px-4 text-center text-sm text-gray-400">
            {checking
              ? "Reading the page for the first price…"
              : series.length === 1
                ? "One price read so far. The chart draws itself after the next check."
                : "No price read yet. The chart starts with the first one."}
          </div>
        )}

        <MarketHistory watch={watch} />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl bg-gray-50 p-4 sm:grid-cols-3">
          <Stat label="Lowest" value={low === null ? "—" : money(low)} />
          <Stat label="Highest" value={high === null ? "—" : money(high)} />
          <Stat label="Average" value={average === null ? "—" : money(Math.round(average))} />
          <Stat label="Swing" value={swing === null ? "—" : percent(swing)} hint="high to low, of average" />
          <Stat label="Price reads" value={capped ? `${SPARK_CAP}+` : String(values.length)} hint={capped ? "stats use the latest 30" : undefined} />
          <Stat label="Tracking since" value={day(watch._creationTime)} hint="no history before this" />
        </dl>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Chip tone={verdict.tone}>{verdict.text}</Chip>
          <span className="min-w-0 text-sm text-gray-500">{watch.verdict.reason}</span>
        </div>
        {qualifiedReason !== null && qualifiedReason !== watch.verdict.reason && (
          <p className="text-xs text-yellow-700">{qualifiedReason}</p>
        )}

        {live && <TargetControl watch={watch} currency={currency} />}

        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-400" aria-live="polite">
          {checking ? (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-harbor motion-reduce:animate-none" aria-hidden="true" />
              <span className="font-medium text-gray-900">Checking the page now…</span>
            </>
          ) : (
            <span>
              {watch.lastCheckedAt === null ? "Not checked yet" : `Last checked ${ago(now, watch.lastCheckedAt)}`}
              {watch.status === "active" &&
                (watch.nextCheckAt > now ? ` · next in ${remainingLabel(watch.nextCheckAt - now)}` : " · next check is due")}
              {watch.status === "paused" && " · paused, no checks scheduled"}
              {watch.status === "bought" && " · watching ended when you bought it"}
            </span>
          )}
          {watch.lastNote && !checking && <span className="text-yellow-700">· No price last time: {watch.lastNote}</span>}
        </p>

        {live ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-200 pt-4">
            <button
              type="button"
              disabled={busy || checking}
              className={smallButtonClass}
              onClick={() => void run(() => checkNow({ watchId: watch._id }))}
            >
              {checking ? "Checking…" : "Check now"}
            </button>
            <button
              type="button"
              disabled={busy}
              className={quietButtonClass}
              onClick={() =>
                void run(() => setStatus({ watchId: watch._id, status: watch.status === "paused" ? "active" : "paused" }))
              }
            >
              {watch.status === "paused" ? "Resume" : "Pause"}
            </button>
            <button type="button" aria-expanded={buying} className={smallButtonClass} onClick={() => setBuying((v) => !v)}>
              I bought it
            </button>
            <button
              type="button"
              disabled={busy}
              className={`${quietButtonClass} sm:ml-auto`}
              onClick={() => void run(() => archive({ watchId: watch._id }))}
            >
              Archive
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-gray-200 pt-4">
            {watch.purchaseId !== null && (
              <Link to={`/purchases/${watch.purchaseId}`} className={smallButtonClass}>
                Open the purchase
              </Link>
            )}
            <button
              type="button"
              disabled={busy}
              className={`${quietButtonClass} sm:ml-auto`}
              onClick={() => void run(() => archive({ watchId: watch._id }))}
            >
              Archive
            </button>
          </div>
        )}

        {buying && live && <BoughtForm watch={watch} onDone={() => setBuying(false)} />}
        {error && <ErrorBox error={error} />}
      </div>

      <div className="mt-auto">
        <StoreCompare watch={watch} now={now} coarseNow={coarseNow} defaultOpen={storesOpen} />
      </div>
    </li>
  );
}
