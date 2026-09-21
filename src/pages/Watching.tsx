import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Money } from "../components/Money";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  dollarsToCents,
  errorText,
  inputClass,
  labelClass,
  pageTitleClass,
  pillBadClass,
  pillGoodClass,
  pillMutedClass,
  pillWarnClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  when,
} from "../lib/ui";

type Watch = FunctionReturnType<typeof api.watches.list>[number];

const VERDICT: Record<Watch["verdict"]["label"], { text: string; className: string }> = {
  good_price: { text: "Good price", className: pillGoodClass },
  fair: { text: "Fair price", className: pillMutedClass },
  wait: { text: "Wait", className: pillWarnClass },
  inflated_discount: { text: "Discount looks inflated", className: pillBadClass },
  not_enough_history: { text: "Not enough history yet", className: pillMutedClass },
  unknown: { text: "No price yet", className: pillMutedClass },
};

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
    <form onSubmit={onSubmit} className={`${sectionClass} space-y-3`}>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <div>
          <label className={labelClass} htmlFor="watch-url">
            Paste a product link
          </label>
          <input
            id="watch-url"
            className={inputClass}
            type="url"
            required
            placeholder="https://store.com/product…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="watch-target">
            Tell me at (optional)
          </label>
          <input
            id="watch-target"
            className={inputClass}
            inputMode="decimal"
            placeholder="$ target"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
        </div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          {busy ? "Adding…" : "Watch this"}
        </button>
      </div>
      {error && <ErrorBox error={error} />}
      <p className="text-xs text-gray-400">
        No affiliate links. Every price shows where and when it was read.
      </p>
    </form>
  );
}

function WatchRow({ watch }: { watch: Watch }) {
  const checkNow = useMutation(api.watches.checkNow);
  const archive = useMutation(api.watches.archive);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const verdict = VERDICT[watch.verdict.label];
  const currency = watch.currency ?? "USD";

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
    <li className={`${sectionClass} space-y-3`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-800">{watch.name}</p>
          <a
            href={watch.productUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-xs text-gray-400 underline-offset-2 hover:underline"
          >
            {watch.merchantDomain}
          </a>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-gray-800">
            {watch.lastCents === null ? "—" : <Money cents={watch.lastCents} currency={currency} />}
          </p>
          {watch.listCents !== null && watch.lastCents !== null && watch.listCents > watch.lastCents && (
            <p className="text-xs text-gray-400">
              store says was <Money cents={watch.listCents} currency={currency} />
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className={verdict.className}>{verdict.text}</span>
        {watch.targetHit && <span className={pillGoodClass}>At or below your target</span>}
        {watch.status === "paused" && <span className={pillMutedClass}>Paused</span>}
        <span className="text-sm text-gray-600">{watch.verdict.reason}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
        <span>
          {watch.checking
            ? "Checking the page now…"
            : watch.lastCheckedAt === null
              ? "Not checked yet"
              : `Checked ${when(watch.lastCheckedAt)}`}
          {watch.targetCents !== null && (
            <>
              {" · target "}
              <Money cents={watch.targetCents} currency={currency} />
            </>
          )}
          {watch.lastNote && !watch.checking && ` · ${watch.lastNote}`}
        </span>
        <span className="flex gap-2">
          <button
            type="button"
            disabled={busy || watch.checking}
            className={secondaryButtonClass}
            onClick={() => void run(() => checkNow({ watchId: watch._id }))}
          >
            Check now
          </button>
          <button
            type="button"
            disabled={busy}
            className={secondaryButtonClass}
            onClick={() => void run(() => archive({ watchId: watch._id }))}
          >
            Stop watching
          </button>
        </span>
      </div>
      {error && <ErrorBox error={error} />}
    </li>
  );
}

export default function Watching() {
  const watches = useQuery(api.watches.list);

  return (
    <div className="space-y-6">
      <div>
        <h1 className={pageTitleClass}>Watching</h1>
        <p className="mt-1 text-sm text-gray-500">
          Haven’t bought yet? Paste the link. Recoup reads the price and tells you when to buy.
        </p>
      </div>

      <AddWatch />

      {watches === undefined ? (
        <Loading rows={3} />
      ) : watches.length === 0 ? (
        <Empty title="Nothing watched yet" hint="Paste a product link above to start a price history." />
      ) : (
        <ul className="space-y-3">
          {watches.map((watch) => (
            <WatchRow key={watch._id} watch={watch} />
          ))}
        </ul>
      )}
    </div>
  );
}
