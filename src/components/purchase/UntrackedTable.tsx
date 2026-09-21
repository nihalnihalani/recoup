import type { TrackedItem } from "./ItemTracker";
import { fmt } from "../Money";
import { cardClass, tableHeadClass } from "../../lib/ui";
import { BoxIcon, CardHeading } from "./parts";

/** Items with no product page: listed for the record, with nothing to chart. */
export function UntrackedTable({ items, currency }: { items: TrackedItem[]; currency: string }) {
  return (
    <section aria-label="Items not tracked" className={`${cardClass} col-span-full overflow-hidden`}>
      <div className="px-5 pt-5">
        <CardHeading
          icon={<BoxIcon />}
          title="Not tracked"
          hint="No product page on these, so there is no price to watch."
        />
      </div>
      <div className="mt-4 overflow-x-auto border-t border-dashed border-gray-200">
        <table className="w-full table-auto text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th scope="col" className="px-5 py-2.5 text-left font-medium">
                Item
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                Paid each
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {items.map((item) => (
              <tr key={item._id}>
                <td className="px-5 py-3 font-medium text-gray-900">{item.name}</td>
                <td className="px-5 py-3 text-right tabular-nums text-gray-500">{item.qty}</td>
                <td className="px-5 py-3 text-right font-semibold tabular-nums text-gray-900">
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
