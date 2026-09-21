import { Link, useNavigate } from "react-router-dom";
import { WindowMeter } from "../charts/WindowMeter";
import { fmt } from "../Money";
import { StoreAvatar } from "../StoreAvatar";
import { cardClass, tableHeadClass, useNow } from "../../lib/ui";
import { claimNowFirst, type Product } from "./model";
import { CardHeader, ExampleChip, ProductStatus } from "./parts";

function subLabel(product: Product): string {
  const { nowCents, basisCents, lowCents, highCents } = product;
  if (nowCents === undefined) return "No price yet";
  if (product.watch?.targetHit) return "At target";
  const ranged = lowCents !== undefined && highCents !== undefined && lowCents < highCents;
  if (ranged && nowCents === lowCents) return "Lowest seen";
  if (product.kind === "bought" && basisCents !== undefined) {
    if (nowCents < basisCents) return "Below paid";
    if (nowCents > basisCents) return "Above paid";
    return "Same as paid";
  }
  if (ranged && nowCents === highCents) return "Highest seen";
  return lowCents === undefined ? "First price" : `Low ${fmt(lowCents, product.currency)}`;
}

/** Where the current price sits between the lowest and the highest seen: green end is cheap. */
function RangeBar({ product }: { product: Product }) {
  const { nowCents, lowCents, highCents, currency } = product;
  const ranged = nowCents !== undefined && lowCents !== undefined && highCents !== undefined && highCents > lowCents;
  const ratio = ranged ? Math.min(1, Math.max(0, (nowCents - lowCents) / (highCents - lowCents))) : 0.5;
  return (
    <div
      role="img"
      aria-label={
        ranged
          ? `Now ${fmt(nowCents, currency)}, between a low of ${fmt(lowCents, currency)} and a high of ${fmt(highCents, currency)}`
          : "No price range yet"
      }
      title={ranged ? `${fmt(lowCents, currency)} – ${fmt(highCents, currency)}` : undefined}
      className="relative h-1.5 w-full"
    >
      <div className={`h-full rounded-full ${ranged ? "bg-linear-to-r from-green-500 to-gray-200" : "bg-gray-100"}`} />
      {nowCents !== undefined && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-gray-800 transition-[left] duration-500 motion-reduce:transition-none"
          style={{ left: `${ratio * 100}%` }}
        />
      )}
    </div>
  );
}

export function ProductsTable({ products }: { products: Product[] }) {
  const navigate = useNavigate();
  const now = useNow();
  const ordered = claimNowFirst(products, now);
  return (
    <section className={`col-span-full xl:col-span-8 ${cardClass}`} aria-labelledby="products-title">
      <CardHeader id="products-title" title="Products" count={products.length} />
      <div className="overflow-x-auto p-3">
        <table className="w-full min-w-[640px] table-auto text-sm">
          <thead className={tableHeadClass}>
            <tr>
              <th scope="col" className="rounded-l-md p-2 text-left font-semibold">Product</th>
              <th scope="col" className="whitespace-nowrap p-2 text-left font-semibold">Now / paid or target</th>
              <th scope="col" className="p-2 text-left font-semibold">Status</th>
              <th scope="col" className="rounded-r-md p-2 text-left font-semibold">Window</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {ordered.map((product) => {
              const basis = product.kind === "bought" ? product.basisCents : (product.watch?.targetCents ?? undefined);
              return (
                <tr key={product.key} className="cursor-pointer transition hover:bg-gray-50" onClick={() => void navigate(product.to)}>
                  <td className="max-w-64 p-2">
                    <div className="flex items-center gap-3">
                      <StoreAvatar domain={product.domain} size={40} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <Link
                            to={product.to}
                            onClick={(event) => event.stopPropagation()}
                            className="truncate font-medium text-gray-800 outline-none hover:text-violet-600 focus-visible:underline"
                          >
                            {product.name}
                          </Link>
                          {product.qty > 1 && <span className="text-xs text-gray-400">×{product.qty}</span>}
                          {product.isExample && <ExampleChip />}
                        </div>
                        <div className="truncate text-xs text-gray-400">
                          {product.storeName}, {product.kind === "watch" ? "watching" : "bought"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="w-48 p-2">
                    <div className="whitespace-nowrap tabular-nums">
                      <span className="font-semibold text-gray-800">
                        {product.nowCents === undefined ? "—" : fmt(product.nowCents, product.currency)}
                      </span>
                      <span className="text-gray-400"> / {basis === undefined ? "no target" : fmt(basis, product.currency)}</span>
                    </div>
                    <div className="mt-1.5">
                      <RangeBar product={product} />
                    </div>
                    <div className="mt-1 text-xs text-gray-400">{subLabel(product)}</div>
                  </td>
                  <td className="p-2">
                    <ProductStatus product={product} now={now} linked />
                  </td>
                  <td className="w-44 p-2">
                    {product.item ? (
                      <WindowMeter purchasedAt={product.item.purchasedAt} endsAt={product.item.windowEndsAt} />
                    ) : (
                      <span className="text-xs text-gray-400">Not bought yet</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function ProductsTableSkeleton() {
  return (
    <div className={`col-span-full xl:col-span-8 ${cardClass}`} aria-hidden="true">
      <div className="border-b border-gray-100 px-5 py-4">
        <div className="h-6 w-32 animate-pulse rounded bg-gray-100" />
      </div>
      <div className="space-y-4 p-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex animate-pulse items-center gap-3" style={{ animationDelay: `${i * 100}ms` }}>
            <div className="size-10 rounded-lg bg-gray-100" />
            <div className="w-1/3 space-y-2">
              <div className="h-4 rounded bg-gray-100" />
              <div className="h-3 w-1/2 rounded bg-gray-100" />
            </div>
            <div className="grow space-y-2">
              <div className="h-4 w-24 rounded bg-gray-100" />
              <div className="h-1.5 rounded-full bg-gray-100" />
            </div>
            <div className="h-5 w-20 rounded-full bg-gray-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
