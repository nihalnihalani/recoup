import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { Link } from "react-router-dom";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Money } from "../components/Money";
import { Countdown } from "../components/Countdown";
import { StatusPill } from "../components/StatusPill";
import { Empty, Loading, QueryBoundary } from "../components/States";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ConvexError && typeof err.data === "string" ? err.data : fallback;
}

// Board totals are plain cent sums over the signed-in user's own purchases, which in
// practice share one currency (assertCurrency enforces ISO 4217 per purchase, but
// purchases.board does not track a single account currency). USD is the working
// assumption for the header strip; the per-purchase and per-claim rows below still
// format in each purchase's own currency.
const BOARD_CURRENCY = "USD";

function Pill({ tone, children }: { tone: "ink" | "rust"; children: string }) {
  const className =
    tone === "rust"
      ? "border border-rust/40 bg-rust/5 text-rust"
      : "border border-line bg-ink/5 text-ink/60";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${className}`}
    >
      {children}
    </span>
  );
}

function Header() {
  return (
    <div>
      <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Board</h1>
      <p className="mt-1 text-sm text-ink/60">Every purchase with money still on the table.</p>
    </div>
  );
}

function MoneyStrip({ totals }: { totals: { owed: number; asked: number; confirmed: number } }) {
  return (
    <dl
      className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line"
      style={{
        backgroundImage:
          "repeating-linear-gradient(180deg, rgba(30,111,82,0.035) 0px, rgba(30,111,82,0.035) 18px, transparent 18px, transparent 36px)",
      }}
    >
      <div className="px-4 py-4 sm:px-6">
        <dt className="text-xs font-semibold uppercase tracking-wide text-rust/80">Owed</dt>
        <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">
          <Money cents={totals.owed} currency={BOARD_CURRENCY} />
        </dd>
      </div>
      <div className="px-4 py-4 sm:px-6">
        <dt className="text-xs font-semibold uppercase tracking-wide text-harbor/80">Asked</dt>
        <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">
          <Money cents={totals.asked} currency={BOARD_CURRENCY} />
        </dd>
      </div>
      <div className="px-4 py-4 sm:px-6">
        <dt className="text-xs font-semibold uppercase tracking-wide text-moss/80">Confirmed</dt>
        <dd className="mt-1 font-mono text-xl tabular-nums text-ink sm:text-2xl">
          <Money cents={totals.confirmed} currency={BOARD_CURRENCY} />
        </dd>
      </div>
    </dl>
  );
}

type Attention = {
  _id: string;
  status: string;
  kind: string;
  summary?: string;
  attempts: number;
  lastError?: string;
};

function AttentionRow({ a }: { a: Attention }) {
  const retry = useMutation(api.inbound.retryEvent);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry() {
    setError(null);
    setRetrying(true);
    try {
      await retry({ eventId: a._id as Id<"processedEvents"> });
    } catch (err) {
      setError(errorMessage(err, "Couldn't retry this event."));
    } finally {
      setRetrying(false);
    }
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rust/30 bg-rust/5 px-4 py-3 text-sm">
      <div>
        <p className="font-medium text-ink">
          {a.status === "failed" ? "Failed" : "Needs review"} · {a.kind}
          {a.attempts > 0 && <span className="text-ink/40"> · {a.attempts} attempt{a.attempts === 1 ? "" : "s"}</span>}
        </p>
        {a.summary && <p className="mt-0.5 text-ink/60">{a.summary}</p>}
        {a.lastError && <p className="mt-0.5 text-rust/80">{a.lastError}</p>}
        {error && (
          <p role="alert" className="mt-0.5 text-rust">
            {error}
          </p>
        )}
      </div>
      {a.status === "failed" && (
        <button
          type="button"
          onClick={() => void handleRetry()}
          disabled={retrying}
          className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-ink/70 transition hover:border-harbor/40 hover:text-harbor disabled:opacity-60"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </li>
  );
}

function AttentionSection({ attention }: { attention: Attention[] }) {
  if (attention.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Needs attention</h2>
      <ul className="space-y-2">
        {attention.map((a) => (
          <AttentionRow key={a._id} a={a} />
        ))}
      </ul>
    </section>
  );
}

type BoardRow = FunctionReturnType<typeof api.purchases.board>["purchases"][number];

function PurchaseRow({ row }: { row: BoardRow }) {
  const { purchase, items, claims } = row;
  const liveClaims = claims.filter((c) => c.status !== "dismissed");

  return (
    <li className="rounded-lg border border-line bg-white/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/purchases/${purchase._id}`}
            className="font-serif text-lg font-semibold text-ink hover:underline"
          >
            {purchase.merchant}
          </Link>
          {purchase.isExample && <Pill tone="ink">example</Pill>}
          {purchase.status === "needs_review" && (
            <Link to={`/purchases/${purchase._id}`}>
              <Pill tone="rust">needs review</Pill>
            </Link>
          )}
        </div>
        <div className="text-sm text-ink/60">
          {items.length} item{items.length === 1 ? "" : "s"} ·{" "}
          {purchase.purchasedAt ? new Date(purchase.purchasedAt).toLocaleDateString() : "date needed"}
        </div>
      </div>

      {liveClaims.length > 0 && (
        <ul className="mt-3 space-y-2 border-t border-line pt-3">
          {liveClaims.map((c) => (
            <li key={c._id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <Link to={`/claims/${c._id}`} className="text-ink hover:underline">
                {c.type === "return_credit" ? "Return credit" : "Price adjustment"} · {c.item?.name ?? "item"}
              </Link>
              <div className="flex flex-wrap items-center gap-3">
                {c.windowEndsAt !== undefined && <Countdown endsAt={c.windowEndsAt} />}
                {c.balance.unresolved < 0 ? (
                  <span className="font-mono text-sm tabular-nums text-rust">
                    over-credited by <Money cents={-c.balance.unresolved} currency={purchase.currency} />
                  </span>
                ) : (
                  <Money cents={c.balance.unresolved} currency={purchase.currency} className="text-ink" />
                )}
                <StatusPill status={c.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AddPurchaseSection({ hasExample }: { hasExample: boolean }) {
  const paste = useAction(api.intake.paste);
  const loadExample = useMutation(api.examples.load);

  const [pasted, setPasted] = useState("");
  const [pasting, setPasting] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  const [loadingExample, setLoadingExample] = useState(false);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const [exampleNotice, setExampleNotice] = useState<string | null>(null);

  async function handleAdd() {
    setPasteError(null);
    setPasteNotice(null);
    setPasting(true);
    try {
      await paste({ text: pasted });
      setPasted("");
      setPasteNotice("Reading… check Needs attention or the board in a moment");
    } catch (err) {
      setPasteError(errorMessage(err, "Couldn't read that email."));
    } finally {
      setPasting(false);
    }
  }

  async function handleLoadExample() {
    setExampleError(null);
    setExampleNotice(null);
    setLoadingExample(true);
    try {
      const result = await loadExample({});
      if (!result.loaded) {
        setExampleNotice("You already have example purchases loaded.");
      }
    } catch (err) {
      setExampleError(errorMessage(err, "Couldn't load example purchases."));
    } finally {
      setLoadingExample(false);
    }
  }

  return (
    <section className="space-y-2 rounded-lg border border-line bg-white/50 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Add a purchase</h2>
      <label htmlFor="board-paste" className="sr-only">
        Order confirmation text
      </label>
      <textarea
        id="board-paste"
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        rows={5}
        disabled={pasting}
        placeholder="Paste the order confirmation email text here…"
        className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20 disabled:opacity-60"
      />
      {pasteError && (
        <p role="alert" className="text-sm text-rust">
          {pasteError}
        </p>
      )}
      {pasteNotice && <p className="text-sm text-moss">{pasteNotice}</p>}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={pasting || pasted.trim().length === 0}
          className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper disabled:opacity-60"
        >
          {pasting ? "Reading…" : "Add"}
        </button>
        {!hasExample && (
          <button
            type="button"
            onClick={() => void handleLoadExample()}
            disabled={loadingExample}
            className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink/60 transition hover:border-harbor/40 hover:text-harbor disabled:opacity-60"
          >
            {loadingExample ? "Loading…" : "Load an example purchase"}
          </button>
        )}
      </div>
      {exampleNotice && <p className="text-sm text-ink/60">{exampleNotice}</p>}
      {exampleError && (
        <p role="alert" className="text-sm text-rust">
          {exampleError}
        </p>
      )}
    </section>
  );
}

function BoardContent() {
  const board = useQuery(api.purchases.board);

  if (board === undefined) {
    return (
      <div className="space-y-8">
        <Header />
        <Loading rows={4} />
      </div>
    );
  }

  const { purchases, totals, attention } = board;
  const hasExample = purchases.some((row) => row.purchase.isExample);

  return (
    <div className="space-y-8">
      <Header />
      <MoneyStrip totals={totals} />
      <AttentionSection attention={attention} />

      {purchases.length === 0 ? (
        <Empty
          title="No purchases yet"
          hint="Forward an order confirmation to your Recoup inbox, or paste the text in below, and it will show up here as a case."
        />
      ) : (
        <ul className="space-y-4">
          {purchases.map((row) => (
            <PurchaseRow key={row.purchase._id} row={row} />
          ))}
        </ul>
      )}

      <AddPurchaseSection hasExample={hasExample} />
    </div>
  );
}

export default function Board() {
  return (
    <QueryBoundary>
      <BoardContent />
    </QueryBoundary>
  );
}
