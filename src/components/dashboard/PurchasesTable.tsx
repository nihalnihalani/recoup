import { Link } from "react-router-dom";
import { WindowMeter } from "../charts/WindowMeter";
import { fmt } from "../../lib/money";
import { ProductThumb } from "../ProductThumb";
import { cardClass, cardTitleClass } from "../../lib/ui";
import { storeInfo } from "../../lib/stores";
import type { Item } from "./model";
import { Bone, ExampleChip, PctChange, RecentNote, VerdictChip, focusRing } from "./parts";

/**
 * `tracking.overview` has no `windowNote` of its own (unlike `insights.activity`/`sources`), since
 * `truncated` there can come from either the 60-purchase cap or a single purchase's own
 * `MAX_ITEMS_PER_PURCHASE` cap (D93/P07) -- this note covers both without claiming which one fired.
 */
const PURCHASES_WINDOW_NOTE = "recent purchases (up to 60) and each purchase's most recent items";

function changePct(item: Item): number | null {
  if (item.latestCents === undefined || item.paidCents <= 0) return null;
  return ((item.latestCents - item.paidCents) / item.paidCents) * 100;
}

function Name({ item }: { item: Item }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <ProductThumb imageUrl={item.imageUrl} name={item.name} size={36} domain={item.merchantDomain} />
      <span className="min-w-0">
        <Link
          to={`/purchases/${item.purchaseId}`}
          title={item.name}
          className={`line-clamp-2 rounded font-medium leading-snug text-gray-900 hover:underline ${focusRing}`}
        >
          {item.name}
        </Link>
        <span className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
          <span className="truncate">
            {item.merchant || storeInfo(item.merchantDomain).name}
            {item.qty > 1 && `, ${item.qty} bought`}
          </span>
          {item.isExample && <ExampleChip />}
        </span>
      </span>
    </span>
  );
}

function NowPrice({ item }: { item: Item }) {
  return item.latestCents === undefined ? (
    <span className="text-gray-400" aria-label="No price read yet">
      —
    </span>
  ) : (
    <span className="font-medium tabular-nums text-gray-900">{fmt(item.latestCents, item.currency)}</span>
  );
}

export function PurchasesTable({ items, now, truncated }: { items: Item[]; now: number; truncated: boolean }) {
  return (
    <section className={`${cardClass} p-5 lg:col-span-2`} aria-labelledby="purchases-title">
      <div className="flex min-w-0 items-center gap-2">
        <h2 id="purchases-title" className={cardTitleClass}>
          Purchases in their price window
        </h2>
        {truncated && <RecentNote windowNote={PURCHASES_WINDOW_NOTE} />}
      </div>

      {items.length === 0 ? (
        <p className="py-10 text-center text-sm text-gray-500">
          Nothing bought is being tracked.{" "}
          <Link to="/add" className={`rounded font-semibold text-gray-900 underline underline-offset-2 ${focusRing}`}>
            Add a purchase
          </Link>{" "}
          and Recoup checks the store's price-adjustment policy when its price falls.
        </p>
      ) : (
        <>
          <table className="mt-4 hidden w-full table-fixed border-separate border-spacing-0 text-sm md:table">
            <thead className="text-xs text-gray-500">
              <tr className="[&>th]:bg-gray-50 [&>th]:px-4 [&>th]:py-2.5 [&>th]:text-left [&>th]:font-medium [&>th:first-child]:rounded-l-lg [&>th:last-child]:rounded-r-lg">
                <th scope="col">Item</th>
                <th scope="col" className="w-36">
                  Now, against paid
                </th>
                <th scope="col" className="w-40">
                  Window
                </th>
                <th scope="col" className="w-36">
                  Verdict
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => {
                const rule = i === items.length - 1 ? "" : "border-b border-gray-100";
                return (
                  <tr key={item.itemId} className="transition-colors hover:bg-gray-50 motion-reduce:transition-none">
                    <th scope="row" className={`px-4 py-3 text-left font-normal ${rule}`}>
                      <Name item={item} />
                    </th>
                    <td className={`px-4 py-3 ${rule}`}>
                      <span className="flex items-center gap-2">
                        <NowPrice item={item} />
                        <PctChange pct={changePct(item)} versus="what you paid" />
                      </span>
                      <span className="block text-xs tabular-nums text-gray-400">paid {fmt(item.paidCents, item.currency)}</span>
                    </td>
                    <td className={`px-4 py-3 ${rule}`}>
                      <WindowMeter purchasedAt={item.purchasedAt} endsAt={item.windowEndsAt} />
                    </td>
                    <td className={`px-4 py-3 ${rule}`}>
                      <VerdictChip item={item} now={now} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <ul className="mt-4 space-y-3 md:hidden">
            {items.map((item) => (
              <li key={item.itemId} className="rounded-xl border border-gray-200 p-3">
                <Name item={item} />
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  <div>
                    <dt className="text-xs text-gray-400">Paid</dt>
                    <dd className="tabular-nums text-gray-600">{fmt(item.paidCents, item.currency)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-400">Now</dt>
                    <dd><NowPrice item={item} /></dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-400">Change</dt>
                    <dd>
                      <PctChange pct={changePct(item)} versus="what you paid" />
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex items-end justify-between gap-4">
                  <div className="min-w-0 grow">
                    <WindowMeter purchasedAt={item.purchasedAt} endsAt={item.windowEndsAt} />
                  </div>
                  <VerdictChip item={item} now={now} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export function PurchasesTableSkeleton() {
  return (
    <div className={`${cardClass} p-5 lg:col-span-2`} aria-hidden="true">
      <Bone className="h-5 w-64" />
      <Bone className="mt-4 h-10 w-full rounded-lg" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3">
          <Bone className="size-9 rounded-lg" />
          <Bone className="h-4 w-1/3" />
          <Bone className="ml-auto h-4 w-14" />
          <Bone className="hidden h-2 w-28 md:block" />
          <Bone className="h-6 w-20 rounded-full" />
        </div>
      ))}
    </div>
  );
}
