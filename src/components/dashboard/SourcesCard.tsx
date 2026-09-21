import { Link } from "react-router-dom";
import { StoreAvatar } from "../StoreAvatar";
import { cardClass, pillBadClass, pillGoodClass, pillMutedClass, pillWarnClass } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import { agoLong } from "./model";
import type { SourceRow } from "./model";
import { CardHeader } from "./parts";

/** Share of checks at this store that produced a price. No checks yet reads gray, not red. */
function Readability({ row }: { row: SourceRow }) {
  if (row.checks === 0) {
    return (
      <span className={pillMutedClass} title="No checks at this store yet">
        —
      </span>
    );
  }
  const share = Math.round((row.priced / row.checks) * 100);
  const tone = share >= 80 ? pillGoodClass : share >= 40 ? pillWarnClass : pillBadClass;
  return (
    <span
      className={`${tone} tabular-nums`}
      title={`Pages we could read: ${row.priced} of ${row.checks} checks gave a price`}
      aria-label={`${share}% of pages readable, ${row.priced} of ${row.checks} checks`}
    >
      {share}% read
    </span>
  );
}

export function SourcesCard({ sources, now }: { sources: SourceRow[]; now: number }) {
  return (
    <section className={`col-span-full flex flex-col xl:col-span-4 ${cardClass}`} aria-labelledby="sources-title">
      <CardHeader id="sources-title" title="Stores" count={sources.length > 0 ? sources.length : undefined} />
      {sources.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">Stores appear here once you watch a product or add a purchase.</p>
      ) : (
        <ul className="grow divide-y divide-gray-100 px-5">
          {sources.map((row) => {
            const info = storeInfo(row.domain);
            const counts = [
              row.watching > 0 ? `${row.watching} watching` : "",
              row.bought > 0 ? `${row.bought} bought` : "",
              row.offers > 0 ? `${row.offers} ${row.offers === 1 ? "offer" : "offers"}` : "",
            ].filter((part) => part !== "");
            return (
              <li key={row.domain} className="flex items-start gap-3 py-3">
                <StoreAvatar domain={row.domain} size={36} />
                <div className="min-w-0 grow">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="truncate font-semibold text-gray-800">{info.name}</span>
                    {info.kind === "marketplace" && (
                      <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs font-medium text-sky-700">Marketplace</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-gray-500">{counts.length > 0 ? counts.join(", ") : "Nothing live"}</p>
                  <p className="text-xs text-gray-400">
                    {row.drops} {row.drops === 1 ? "drop" : "drops"}
                    {row.lastCheckedAt !== undefined && `, last checked ${agoLong(row.lastCheckedAt, now)}`}
                  </p>
                  {info.note && <p className="mt-0.5 text-xs text-gray-400">{info.note}</p>}
                </div>
                <Readability row={row} />
              </li>
            );
          })}
        </ul>
      )}
      <footer className="border-t border-gray-100 px-5 py-3 text-right">
        <Link to="/watching" className="text-sm font-medium text-violet-500 hover:text-violet-600">
          Watch another store
        </Link>
      </footer>
    </section>
  );
}

export function SourcesSkeleton() {
  return (
    <div className={`col-span-full xl:col-span-4 ${cardClass}`} aria-hidden="true">
      <div className="border-b border-gray-100 px-5 py-4">
        <div className="h-6 w-24 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="space-y-5 p-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex animate-pulse items-center gap-3" style={{ animationDelay: `${i * 100}ms` }}>
            <div className="size-9 rounded-lg bg-gray-100" />
            <div className="grow space-y-2">
              <div className="h-4 w-1/2 rounded bg-gray-100" />
              <div className="h-3 w-3/4 rounded bg-gray-100" />
            </div>
            <div className="h-5 w-14 rounded-full bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
