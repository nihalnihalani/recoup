import { Link } from "react-router-dom";
import { fmt } from "../Money";
import { cardClass, remainingLabel, shortDay } from "../../lib/ui";
import { openDropCents } from "./model";
import type { Item } from "./model";
import { CardHeader } from "./parts";

const DAY = 86_400_000;

/** One horizontal bar per item with a drop that can still be claimed: drop x quantity, largest first. */
export function MoneyOnTable({ items, now }: { items: Item[]; now: number }) {
  const rows = items
    .map((item) => ({ item, cents: openDropCents(item, now) }))
    .filter((row) => row.cents > 0)
    .sort((a, b) => b.cents - a.cents)
    .slice(0, 6);
  const max = Math.max(...rows.map((row) => row.cents), 1);

  return (
    <section className={cardClass} aria-labelledby="table-title">
      <CardHeader id="table-title" title="Money on the table" />
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">No price is below what you paid.</p>
      ) : (
        <ul className="space-y-4 px-5 py-5">
          {rows.map(({ item, cents }) => (
            <li key={item.itemId}>
              <Link
                to={`/purchases/${item.purchaseId}`}
                className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              >
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate font-medium text-gray-800 group-hover:text-violet-600">{item.name}</span>
                  <span className="font-semibold tabular-nums text-gray-800">{fmt(cents, item.currency)}</span>
                </div>
                <div className="mt-1.5 h-2.5 rounded-full bg-gray-100">
                  <div
                    className="h-full min-w-2 rounded-full bg-green-500 transition-[width] duration-700 motion-reduce:transition-none"
                    style={{ width: `${(cents / max) * 100}%` }}
                  />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type OpenWindow = { purchaseId: Item["purchaseId"]; label: string; endsAt: number };

/**
 * Every open adjustment window on one time axis that starts now: a bar runs from
 * today to the day the window shuts, soonest first. Under three days reads yellow,
 * under one day red, and the text always says how long is left.
 */
export function WindowsStrip({ items, now }: { items: Item[]; now: number }) {
  const byPurchase = new Map<string, OpenWindow & { count: number }>();
  for (const item of items) {
    if (item.windowEndsAt === undefined || item.windowEndsAt <= now) continue;
    const existing = byPurchase.get(item.purchaseId);
    if (existing) existing.count += 1;
    else byPurchase.set(item.purchaseId, { purchaseId: item.purchaseId, label: item.name, endsAt: item.windowEndsAt, count: 1 });
  }
  const rows = [...byPurchase.values()].sort((a, b) => a.endsAt - b.endsAt).slice(0, 8);
  const horizon = Math.max(...rows.map((row) => row.endsAt - now), DAY);

  return (
    <section className={cardClass} aria-labelledby="windows-title">
      <CardHeader id="windows-title" title="Adjustment windows" count={rows.length > 0 ? rows.length : undefined} />
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-gray-400">No adjustment window is open.</p>
      ) : (
        <div className="px-5 py-5">
          <ul className="space-y-3">
            {rows.map((row) => {
              const left = row.endsAt - now;
              const tone = left < DAY ? "bg-red-500" : left < 3 * DAY ? "bg-yellow-500" : "bg-violet-500";
              const text = left < DAY ? "text-red-700" : left < 3 * DAY ? "text-yellow-700" : "text-gray-600";
              return (
                <li key={row.purchaseId}>
                  <Link
                    to={`/purchases/${row.purchaseId}`}
                    className="group block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
                  >
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate font-medium text-gray-800 group-hover:text-violet-600">
                        {row.label}
                        {row.count > 1 && <span className="font-normal text-gray-400"> +{row.count - 1}</span>}
                      </span>
                      <span className={`whitespace-nowrap text-xs font-medium tabular-nums ${text}`}>
                        {remainingLabel(left)} left, {shortDay(row.endsAt)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 rounded-full bg-gray-100">
                      <div
                        className={`h-full min-w-1.5 rounded-full transition-[width] duration-700 motion-reduce:transition-none ${tone}`}
                        style={{ width: `${(left / horizon) * 100}%` }}
                      />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex justify-between text-xs text-gray-400" aria-hidden="true">
            <span>Today</span>
            <span>{shortDay(now + horizon)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

export function MoneyCardsSkeleton() {
  return (
    <div className="col-span-full space-y-6 xl:col-span-7" aria-hidden="true">
      {[0, 1].map((card) => (
        <div key={card} className={cardClass}>
          <div className="border-b border-gray-100 px-5 py-4">
            <div className="h-6 w-44 animate-pulse rounded bg-gray-100" />
          </div>
          <div className="space-y-5 p-5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="animate-pulse space-y-2" style={{ animationDelay: `${i * 100}ms` }}>
                <div className="flex justify-between">
                  <div className="h-3.5 w-1/3 rounded bg-gray-100" />
                  <div className="h-3.5 w-14 rounded bg-gray-100" />
                </div>
                <div className={`rounded-full bg-gray-100 ${card === 0 ? "h-2.5" : "h-1.5"}`} style={{ width: `${90 - i * 25}%` }} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
