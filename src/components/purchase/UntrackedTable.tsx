import type { TrackedItem } from "./ItemTracker";
import { fmt } from "../Money";

/** Items with no product page: listed for the record, with nothing to chart. */
export function UntrackedTable({ items, currency }: { items: TrackedItem[]; currency: string }) {
  return (
    <section aria-label="Items not tracked" className="col-span-full rounded-xl bg-white shadow-xs">
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-100 px-5 py-4">
        <h2 className="font-semibold text-gray-800">Not tracked</h2>
        <p className="text-sm text-gray-500">No product page on these, so there is no price to watch.</p>
      </header>
      <div className="overflow-x-auto p-3">
        <table className="w-full table-auto text-sm">
          <thead className="rounded-xs bg-gray-50 text-xs font-semibold uppercase text-gray-400">
            <tr>
              <th scope="col" className="p-2 text-left">
                Item
              </th>
              <th scope="col" className="p-2 text-right">
                Qty
              </th>
              <th scope="col" className="p-2 text-right">
                Paid each
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {items.map((item) => (
              <tr key={item._id}>
                <td className="p-2 font-medium text-gray-800">{item.name}</td>
                <td className="p-2 text-right tabular-nums text-gray-600">{item.qty}</td>
                <td className="p-2 text-right font-medium tabular-nums text-gray-800">
                  {fmt(item.unitCents, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
