import { Link, useNavigate } from "react-router-dom";
import { AreaChart } from "../charts/AreaChart";
import { fmt } from "../Money";
import { StoreAvatar } from "../StoreAvatar";
import { bigNumberClass, cardClass, mutedLabelClass, pillGoodClass, useNow } from "../../lib/ui";
import { claimNowFirst, productVerdict, type Product } from "./model";
import { ChangePill, ExampleChip, ProductStatus } from "./parts";

const MAX_CARDS = 6;

function ProductCard({ product, now }: { product: Product; now: number }) {
  const navigate = useNavigate();
  const verdict = productVerdict(product, now);
  const claimNow = verdict?.kind === "claim_now";
  const { currency } = product;
  const known = product.nowCents !== undefined;
  // A bought item nobody has priced yet still has one honest number: what was paid.
  const headline = product.nowCents ?? (product.kind === "bought" ? product.basisCents : undefined);

  return (
    <article
      className={`group col-span-full flex cursor-pointer flex-col sm:col-span-6 xl:col-span-4 ${cardClass} ${claimNow ? "ring-1 ring-violet-500/40" : ""}`}
      onClick={() => void navigate(product.to)}
    >
      <header className="flex items-start gap-3 px-5 pt-5">
        <StoreAvatar domain={product.domain} size={36} />
        <div className="min-w-0 grow">
          <h3 className="truncate text-base font-semibold text-gray-800">
            <Link
              to={product.to}
              onClick={(event) => event.stopPropagation()}
              className="outline-none group-hover:text-violet-600 focus-visible:underline"
            >
              {product.name}
            </Link>
          </h3>
          <p className="truncate text-xs text-gray-400">
            {product.storeName}
            {product.qty > 1 && ` ×${product.qty}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <ProductStatus product={product} now={now} />
          {product.isExample && <ExampleChip />}
        </div>
      </header>

      <div className="px-5 pt-3">
        <p className={mutedLabelClass}>{known || product.kind === "watch" ? "Now" : "Paid"}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className={`${bigNumberClass} tabular-nums`}>{headline === undefined ? "—" : fmt(headline, currency)}</span>
          {product.watch?.targetHit ? (
            <span className={pillGoodClass}>At target</span>
          ) : (
            <ChangePill nowCents={product.nowCents} basisCents={product.basisCents} currency={currency} versus={product.basisLabel} />
          )}
        </div>
        {verdict && product.nowCents !== undefined && (
          <p className="mt-1 truncate text-xs text-gray-400" title={verdict.reason}>
            {verdict.reason}
          </p>
        )}
      </div>

      {/* The chart answers hover and arrow keys itself, so a click on it does not leave the page. */}
      <div className="mt-auto px-3 pb-3 pt-2" onClick={(event) => event.stopPropagation()}>
        <AreaChart
          series={product.series}
          reference={product.reference}
          height={96}
          tone={product.kind === "watch" ? "violet" : "sky"}
          format={(value) => fmt(Math.round(value), currency)}
          ariaLabel={`Price of ${product.name} at ${product.storeName}`}
        />
      </div>
    </article>
  );
}

/** The first six products, each with its own price line: money to claim now leads, then watched, then bought. */
export function ProductCards({ products }: { products: Product[] }) {
  const now = useNow();
  const shown = claimNowFirst(products, now).slice(0, MAX_CARDS);
  return (
    <section aria-label="Products">
      <div className="grid grid-cols-12 gap-6">
        {shown.map((product) => (
          <ProductCard key={product.key} product={product} now={now} />
        ))}
      </div>
      {products.length > MAX_CARDS && (
        <p className="mt-3 text-right text-sm">
          <a href="#products-title" className="font-medium text-violet-500 hover:text-violet-600">
            View all {products.length}
          </a>
        </p>
      )}
    </section>
  );
}

export function ProductCardsSkeleton() {
  return (
    <div className="grid grid-cols-12 gap-6" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className={`col-span-full p-5 sm:col-span-6 xl:col-span-4 ${cardClass}`}>
          <div className="flex animate-pulse items-start gap-3" style={{ animationDelay: `${i * 120}ms` }}>
            <div className="size-9 rounded-lg bg-gray-100" />
            <div className="grow space-y-2">
              <div className="h-4 w-2/3 rounded bg-gray-100" />
              <div className="h-3 w-1/3 rounded bg-gray-100" />
            </div>
            <div className="h-5 w-16 rounded-full bg-gray-100" />
          </div>
          <div className="mt-5 animate-pulse space-y-2">
            <div className="h-3 w-10 rounded bg-gray-100" />
            <div className="h-8 w-32 rounded bg-gray-100" />
            <div className="h-20 rounded-lg bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}
