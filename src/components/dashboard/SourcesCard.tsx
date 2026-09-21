import { Link } from "react-router-dom";
import { StoreAvatar } from "../StoreAvatar";
import { cardClass, cardTitleClass } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import { agoLong } from "./model";
import type { SourceRow } from "./model";
import { Bone, controlClass } from "./parts";

/** Share of checks at this store that produced a price. No checks yet reads gray, not red. */
function Readability({ row }: { row: SourceRow }) {
  if (row.checks === 0) {
    return (
      <span className="text-xs text-gray-400" title="No checks at this store yet">
        —
      </span>
    );
  }
  const share = Math.round((row.priced / row.checks) * 100);
  const tone = share >= 80 ? "text-green-700" : share >= 40 ? "text-yellow-700" : "text-red-700";
  return (
    <span
      className={`whitespace-nowrap text-xs font-semibold tabular-nums ${tone}`}
      title={`Pages we could read: ${row.priced} of ${row.checks} checks gave a price`}
      aria-label={`${share}% of pages readable, ${row.priced} of ${row.checks} checks`}
    >
      {share}% read
    </span>
  );
}

export function SourcesCard({ sources, now }: { sources: SourceRow[]; now: number }) {
  return (
    <section className={`${cardClass} flex flex-col p-5`} aria-labelledby="sources-title">
      <header className="flex items-center justify-between gap-3">
        <h2 id="sources-title" className={cardTitleClass}>
          Stores
          {sources.length > 0 && <span className="ml-2 font-medium tabular-nums text-gray-400">{sources.length}</span>}
        </h2>
        <Link to="/watching" className={controlClass}>
          Add a store
        </Link>
      </header>
      {sources.length === 0 ? (
        <p className="my-auto py-10 text-center text-sm text-gray-500">Stores appear here once you watch a product or add a purchase.</p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-100">
          {sources.map((row) => {
            const info = storeInfo(row.domain);
            const counts = [
              row.watching > 0 ? `${row.watching} watching` : "",
              row.bought > 0 ? `${row.bought} bought` : "",
              row.offers > 0 ? `${row.offers} ${row.offers === 1 ? "offer" : "offers"}` : "",
              `${row.drops} ${row.drops === 1 ? "drop" : "drops"}`,
            ].filter((part) => part !== "");
            return (
              <li key={row.domain} className="flex items-center gap-3 py-2.5">
                <StoreAvatar domain={row.domain} size={32} />
                <div className="min-w-0 grow">
                  <p className="truncate text-sm font-semibold text-gray-900" title={info.note}>
                    {info.name}
                    {info.kind === "marketplace" && <span className="ml-1.5 font-normal text-gray-400">marketplace</span>}
                  </p>
                  <p className="truncate text-xs text-gray-500">
                    {counts.join(", ")}
                    {row.lastCheckedAt !== undefined && `, checked ${agoLong(row.lastCheckedAt, now)}`}
                  </p>
                </div>
                <Readability row={row} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function SourcesSkeleton() {
  return (
    <div className={`${cardClass} p-5`} aria-hidden="true">
      <div className="flex items-center justify-between">
        <Bone className="h-5 w-20" />
        <Bone className="h-9 w-24 rounded-xl" />
      </div>
      <div className="mt-4 space-y-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3">
            <Bone className="size-8 rounded-lg" />
            <div className="grow space-y-2">
              <Bone className="h-3.5 w-1/2" />
              <Bone className="h-3 w-3/4" />
            </div>
            <Bone className="h-3.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
