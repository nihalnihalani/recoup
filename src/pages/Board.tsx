import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import { Countdown } from "../components/Countdown";
import { Money } from "../components/Money";
import { StatusPill } from "../components/StatusPill";
import { Empty, Loading } from "../components/States";
import { day, errorText, sectionClass } from "../lib/ui";

type BoardData = FunctionReturnType<typeof api.purchases.board>;
type BoardRow = BoardData["purchases"][number];

const CLAIM_TYPE_LABEL = {
  price_adjustment: "Price drop",
  return_credit: "Return credit",
} as const;

/** Soonest closing window first; purchases with no live window sink to the bottom. */
function soonestWindow(row: BoardRow): number {
  const ends = row.claims
    .filter((claim) => claim.status !== "dismissed" && claim.windowEndsAt !== undefined)
    .map((claim) => claim.windowEndsAt as number);
  return ends.length > 0 ? Math.min(...ends) : Number.POSITIVE_INFINITY;
}

function Total({ label, cents, tone }: { label: string; cents: number; tone: string }) {
  return (
    <div className="px-4 py-4 sm:px-6">
      <dt className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{label}</dt>
      <dd className="mt-1 text-xl text-ink sm:text-2xl">
        <Money cents={cents} currency="USD" />
      </dd>
    </div>
  );
}

function Row({ row }: { row: BoardRow }) {
  const { purchase, items, claims } = row;
  const openClaims = claims.filter((claim) => claim.status !== "dismissed");

  return (
    <li className={sectionClass}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link
            to={`/purchases/${purchase._id}`}
            className="font-serif text-lg text-ink underline-offset-4 hover:underline"
          >
            {purchase.merchant || purchase.merchantDomain || "Unknown merchant"}
          </Link>
          <p className="mt-0.5 text-xs text-ink/50">
            {purchase.orderRef ? `Order ${purchase.orderRef} · ` : ""}
            {day(purchase.purchasedAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {purchase.isExample && (
            <span className="rounded-full bg-ink/5 px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-ink/50">
              Example
            </span>
          )}
          {purchase.status === "needs_review" && (
            <Link
              to={`/purchases/${purchase._id}`}
              className="rounded-full bg-gold/10 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-gold"
            >
              Needs review
            </Link>
          )}
        </div>
      </div>

      <p className="mt-2 text-sm text-ink/70">
        {items.length === 0
          ? "No line items yet."
          : items.map((item) => `${item.name} ×${item.qty}`).join(", ")}
      </p>

      {openClaims.length > 0 && (
        <ul className="mt-3 divide-y divide-line border-t border-line">
          {openClaims.map((claim) => (
            <li key={claim._id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <Link
                to={`/claims/${claim._id}`}
                className="text-sm text-ink underline-offset-4 hover:underline"
              >
                {CLAIM_TYPE_LABEL[claim.type]} · {claim.item?.name ?? "item"}
              </Link>
              <div className="flex items-center gap-3">
                <Money
                  cents={Math.max(0, claim.balance.unresolved)}
                  currency={purchase.currency}
                  className="text-sm text-ink"
                />
                <StatusPill status={claim.status} />
                {claim.windowEndsAt !== undefined && <Countdown endsAt={claim.windowEndsAt} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function Board() {
  const board = useQuery(api.purchases.board);
  const loadExamples = useMutation(api.examples.load);
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

  if (board === undefined) {
    return <Loading rows={4} />;
  }

  const rows = [...board.purchases].sort((a, b) => soonestWindow(a) - soonestWindow(b));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Board</h1>
        <p className="mt-1 text-sm text-ink/60">Every purchase with money still on the table.</p>
      </div>

      <dl
        className="grid grid-cols-3 divide-x divide-line overflow-hidden rounded-lg border border-line"
        style={{
          backgroundImage:
            "repeating-linear-gradient(180deg, rgba(30,111,82,0.035) 0px, rgba(30,111,82,0.035) 18px, transparent 18px, transparent 36px)",
        }}
      >
        <Total label="Owed" cents={board.totals.owed} tone="text-rust/80" />
        <Total label="Asked" cents={board.totals.asked} tone="text-harbor/80" />
        <Total label="Confirmed" cents={board.totals.confirmed} tone="text-moss/80" />
      </dl>

      {rows.length === 0 ? (
        <Empty
          title="No purchases yet"
          hint="Forward an order confirmation to your Recoup inbox, or paste the text in from Settings, and it will show up here as a case."
          action={
            <div className="flex flex-col items-center gap-3">
              <div className="flex flex-wrap justify-center gap-2">
                <Link
                  to="/settings"
                  className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper transition hover:bg-harbor/90"
                >
                  Add a purchase
                </Link>
                <button
                  type="button"
                  onClick={onLoadExamples}
                  disabled={loading}
                  className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink transition hover:bg-ink/5 disabled:opacity-50"
                >
                  {loading ? "Loading…" : "Load an example purchase"}
                </button>
              </div>
              {loadError && <p className="text-sm text-rust">{loadError}</p>}
            </div>
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => (
            <Row key={row.purchase._id} row={row} />
          ))}
        </ul>
      )}
    </div>
  );
}
