import { useState } from "react";
import { useMutation } from "convex/react";
import { Link, useNavigate } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { AreaChart } from "../charts/AreaChart";
import { fmt } from "../Money";
import { ErrorBox } from "../States";
import { StoreAvatar } from "../StoreAvatar";
import { storeInfo } from "../../lib/stores";
import { StoreCompare } from "./StoreCompare";
import { ago } from "./time";
import {
  bigNumberClass,
  cardClass,
  centsToDollars,
  day,
  dollarsToCents,
  errorText,
  fromDateInput,
  inputClass,
  labelClass,
  mutedLabelClass,
  percent,
  pillBadClass,
  pillGoodClass,
  pillMutedClass,
  pillWarnClass,
  primaryButtonClass,
  remainingLabel,
  secondaryButtonClass,
} from "../../lib/ui";

type Watch = FunctionReturnType<typeof api.watches.list>[number];

/** `watches.list` returns at most this many accepted observations per watch. */
const SPARK_CAP = 30;

const VERDICT: Record<Watch["verdict"]["label"], { text: string; className: string }> = {
  good_price: { text: "Good price", className: pillGoodClass },
  fair: { text: "Fair price", className: pillMutedClass },
  wait: { text: "Wait", className: pillWarnClass },
  inflated_discount: { text: "Discount looks inflated", className: pillBadClass },
  not_enough_history: { text: "Not enough history yet", className: pillMutedClass },
  unknown: { text: "No price yet", className: pillMutedClass },
};

const pillVioletClass = "inline-flex items-center gap-1.5 rounded-full bg-violet-500/20 px-1.5 text-sm font-medium text-violet-700";
const quietButtonClass =
  "rounded-lg px-2 py-1.5 text-sm font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";
const compactSecondaryClass = secondaryButtonClass.replace("px-3 py-2", "px-2.5 py-1.5");

function PulseDot() {
  return (
    <span className="relative flex h-2 w-2" aria-hidden="true">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-60 motion-reduce:animate-none" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
    </span>
  );
}

function StatusChip({ watch }: { watch: Watch }) {
  if (watch.checking) {
    return (
      <span className={pillVioletClass}>
        <PulseDot />
        Checking…
      </span>
    );
  }
  if (watch.status === "paused") return <span className={pillMutedClass}>Paused</span>;
  if (watch.status === "bought") return <span className={pillVioletClass}>Bought</span>;
  return <span className={pillGoodClass}>Active</span>;
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
        <h2 className="truncate text-lg font-semibold text-gray-800" title={watch.name}>
          {watch.name}
        </h2>
        <button
          type="button"
          className="shrink-0 rounded-md p-1 text-gray-400 transition hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          onClick={() => {
            setValue(watch.name);
            setError(null);
            setEditing(true);
          }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="m10.5 3 2.5 2.5M2.5 13.5l.6-3.1 7.9-7.9a1.4 1.4 0 0 1 2 0l.5.5a1.4 1.4 0 0 1 0 2l-7.9 7.9-3.1.6Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
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
          className={`${inputClass} min-w-0 flex-1 basis-40 py-1.5`}
          value={value}
          maxLength={200}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button type="submit" disabled={busy} className={compactSecondaryClass}>
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
      className={`rounded-lg px-3 py-2.5 ${watch.targetHit ? "bg-green-500/10 ring-1 ring-green-500/30" : "bg-gray-50"}`}
    >
      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label className={`${mutedLabelClass} shrink-0`} htmlFor={`target-${watch._id}`}>
          Tell me at
        </label>
        <input
          id={`target-${watch._id}`}
          className={`${inputClass} w-28 py-1.5 tabular-nums`}
          inputMode="decimal"
          placeholder="89.99"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        {dirty && (
          <button type="submit" disabled={busy} className={compactSecondaryClass}>
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
            <span className="font-medium text-green-700">↓ At or below your target</span>
          ) : watch.targetCents !== null && watch.lastCents !== null ? (
            <>{fmt(watch.lastCents - watch.targetCents, currency)} to go</>
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
  const [date, setDate] = useState(() => {
    // Today in the shopper's own timezone; an ISO (UTC) date is tomorrow for evening shoppers in the Americas.
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const paidCents = dollarsToCents(paid);
    const purchasedAt = fromDateInput(date);
    if (paidCents === null || paidCents <= 0) return setError("Enter what you paid, like 89.99");
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
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg bg-gray-50 p-3">
      <p className="text-sm text-gray-600">
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
      <dt className={mutedLabelClass}>{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-semibold tabular-nums text-gray-800">{value}</dd>
      {hint && <dd className="truncate text-xs text-gray-400">{hint}</dd>}
    </div>
  );
}

/** One watched product as an analytics card: price now, its history, the verdict, the target, other stores. */
export function WatchCard({ watch, now, storesOpen }: { watch: Watch; now: number; storesOpen: boolean }) {
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
      <header className="flex items-start gap-3 border-b border-gray-100 px-5 py-4">
        <StoreAvatar domain={watch.merchantDomain} size={40} />
        <div className="min-w-0 flex-1">
          <Name watch={watch} />
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-gray-500">
            <a
              href={watch.productUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
            >
              {store.name}
              <span className="sr-only"> (opens the product page in a new tab)</span>
            </a>
            {store.kind === "marketplace" && <span className={pillMutedClass}>Marketplace</span>}
          </p>
          {store.kind === "marketplace" && store.note && <p className="mt-1 text-xs text-gray-400">{store.note}</p>}
        </div>
        <div className="shrink-0">
          <StatusChip watch={watch} />
        </div>
      </header>

      <div className="space-y-4 px-5 py-4">
        <div>
          <p className={mutedLabelClass}>Now</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`${bigNumberClass} tabular-nums`}>{watch.lastCents === null ? "—" : money(watch.lastCents)}</span>
            {change !== null &&
              (change === 0 ? (
                <span className={pillMutedClass}>No change</span>
              ) : (
                <span className={change < 0 ? pillGoodClass : pillBadClass}>
                  <span aria-hidden="true">{change < 0 ? "↓" : "↑"}</span>
                  <span className="sr-only">{change < 0 ? "Down" : "Up"}</span>
                  {percent(Math.abs(change))}
                </span>
              ))}
            {watch.listCents !== null && watch.lastCents !== null && watch.listCents > watch.lastCents && (
              <span className="text-sm text-gray-400">
                <span className="sr-only">The store says it was </span>
                <s className="tabular-nums">{money(watch.listCents)}</s>
              </span>
            )}
          </div>
          {change !== null && first !== undefined && (
            <p className="mt-0.5 text-xs text-gray-400">
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
            tone="violet"
            format={money}
            ariaLabel={`Price of ${watch.name} at ${store.name} since ${day(series[0].at)}`}
          />
        ) : (
          <div className="flex h-[160px] items-center justify-center rounded-lg border border-dashed border-gray-200 px-4 text-center text-sm text-gray-400">
            {watch.checking
              ? "Reading the page for the first price…"
              : series.length === 1
                ? "One price read so far. The chart draws itself after the next check."
                : "No price read yet. The chart starts with the first one."}
          </div>
        )}

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-gray-100 pt-3 sm:grid-cols-3">
          <Stat label="Lowest" value={low === null ? "—" : money(low)} />
          <Stat label="Highest" value={high === null ? "—" : money(high)} />
          <Stat label="Average" value={average === null ? "—" : money(Math.round(average))} />
          <Stat label="Swing" value={swing === null ? "—" : percent(swing)} hint="high to low, of average" />
          <Stat label="Price reads" value={capped ? `${SPARK_CAP}+` : String(values.length)} hint={capped ? "stats use the latest 30" : undefined} />
          <Stat label="Tracking since" value={day(watch._creationTime)} hint="no history before this" />
        </dl>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={verdict.className}>{verdict.text}</span>
          <span className="min-w-0 text-sm text-gray-600">{watch.verdict.reason}</span>
        </div>

        {live && <TargetControl watch={watch} currency={currency} />}

        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-400" aria-live="polite">
          {watch.checking ? (
            <>
              <PulseDot />
              <span className="text-violet-700">Checking the page now…</span>
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
          {watch.lastNote && !watch.checking && <span className="text-yellow-700">· No price last time: {watch.lastNote}</span>}
        </p>

        {live ? (
          <div className="flex flex-wrap items-center gap-1">
            <button
              type="button"
              disabled={busy || watch.checking}
              className={compactSecondaryClass}
              onClick={() => void run(() => checkNow({ watchId: watch._id }))}
            >
              {watch.checking ? "Checking…" : "Check now"}
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
            <button type="button" aria-expanded={buying} className={quietButtonClass} onClick={() => setBuying((v) => !v)}>
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
          <div className="flex flex-wrap items-center gap-1">
            {watch.purchaseId !== null && (
              <Link to={`/purchases/${watch.purchaseId}`} className={compactSecondaryClass}>
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
        <StoreCompare watch={watch} now={now} defaultOpen={storesOpen} />
      </div>
    </li>
  );
}
