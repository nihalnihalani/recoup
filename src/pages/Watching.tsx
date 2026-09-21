import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Sparkline } from "../components/charts/Sparkline";
import { Money } from "../components/Money";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  dollarsToCents,
  errorText,
  fromDateInput,
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

/** W4: the watched item was bought. It becomes a purchase with its price-adjustment window counting down. */
function BoughtForm({ watch, onDone }: { watch: Watch; onDone: () => void }) {
  const markBought = useMutation(api.watches.markBought);
  const navigate = useNavigate();
  const [paid, setPaid] = useState(watch.lastCents === null ? "" : (watch.lastCents / 100).toFixed(2));
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
      <div className="grid gap-3 sm:grid-cols-[10rem_12rem_auto_auto] sm:items-end">
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

/** W3: the same item at other stores. Candidates are greyed until the user confirms the match. */
function OtherStores({ watch }: { watch: Watch }) {
  const data = useQuery(api.offers.listForWatch, { watchId: watch._id });
  const find = useMutation(api.offers.find);
  const confirm = useMutation(api.offers.confirm);
  const reject = useMutation(api.offers.reject);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<unknown>) {
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (data === undefined) return null;
  const canFind = !data.searching && data.nextFindAt === null;

  return (
    <div className="space-y-2 rounded-lg bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-gray-800">
          Other stores
          {data.best && (
            <span className="ml-2 font-normal text-green-700">
              Cheapest confirmed: {data.best.storeDomain} at{" "}
              <Money cents={data.best.cents} currency={data.best.currency} />
            </span>
          )}
        </p>
        <button
          type="button"
          disabled={!canFind}
          className={secondaryButtonClass}
          onClick={() => void run(() => find({ watchId: watch._id }))}
        >
          {data.searching ? "Searching…" : data.nextFindAt !== null ? "Searched recently" : "Find other stores"}
        </button>
      </div>
      {data.offers.length === 0 ? (
        <p className="text-xs text-gray-400">
          {data.searching ? "Reading store pages. This takes about a minute." : "No other stores listed yet."}
        </p>
      ) : (
        <ul className="divide-y divide-gray-200">
          {data.offers.map((offer) => {
            const confirmed = offer.status === "confirmed";
            return (
              <li
                key={offer._id}
                className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${confirmed ? "" : "opacity-60"}`}
              >
                <span className="min-w-0">
                  <a
                    href={offer.productUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-medium text-gray-800 underline-offset-2 hover:underline"
                  >
                    {offer.storeDomain}
                  </a>
                  <span className="ml-2 text-xs text-gray-400">
                    {confirmed ? "you confirmed this match" : offer.variantMatch === "exact" ? "looks like the same item" : "may be a different version"}
                    {offer.lastCheckedAt !== null && ` · read ${when(offer.lastCheckedAt)}`}
                    {offer.note && ` · ${offer.note}`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-gray-800">
                    {offer.lastCents === null ? "—" : <Money cents={offer.lastCents} currency={offer.currency ?? "USD"} />}
                  </span>
                  {!confirmed && (
                    <button type="button" className={secondaryButtonClass} onClick={() => void run(() => confirm({ offerId: offer._id }))}>
                      Same item
                    </button>
                  )}
                  <button type="button" className={secondaryButtonClass} onClick={() => void run(() => reject({ offerId: offer._id }))}>
                    Not it
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-gray-400">Ranked by price only. No affiliate links, no sponsored placement.</p>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function WatchRow({ watch }: { watch: Watch }) {
  const [buying, setBuying] = useState(false);
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

      {watch.spark.length >= 2 && (
        <Sparkline
          points={watch.spark.map((p) => ({ at: p.observedAt, cents: p.observedCents }))}
          paidCents={watch.targetCents ?? watch.spark[0].observedCents}
        />
      )}

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
          <button type="button" className={secondaryButtonClass} onClick={() => setBuying((v) => !v)}>
            I bought it
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
      {buying && <BoughtForm watch={watch} onDone={() => setBuying(false)} />}
      <OtherStores watch={watch} />
      {error && <ErrorBox error={error} />}
    </li>
  );
}

/** W2 backstop: every price-drop alert, whether or not the email went out. */
function Drops() {
  const drops = useQuery(api.notify.drops);
  if (drops === undefined || drops.length === 0) return null;
  return (
    <section className={`${sectionClass} space-y-2`}>
      <h2 className="text-lg font-semibold text-gray-800">Price drops</h2>
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

      <Drops />

      {watches === undefined ? (
        <Loading rows={3} />
      ) : watches.length === 0 ? (
        <Empty title="Nothing watched yet" hint="Paste a product link above to start a price history." />
      ) : (
        <ul className="space-y-3">
          {watches.filter((w) => w.status !== "bought").map((watch) => (
            <WatchRow key={watch._id} watch={watch} />
          ))}
        </ul>
      )}
    </div>
  );
}
