import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { fmt } from "../Money";
import { StatusPill } from "../StatusPill";
import { cardHeaderClass, cardTitleClass, percent, pillBadClass, pillGoodClass, pillMutedClass } from "../../lib/ui";
import type { Product, Watch } from "./model";

export function ExampleChip() {
  return <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">Example</span>;
}

export function CardHeader({ id, title, count, aside }: { id: string; title: string; count?: number; aside?: ReactNode }) {
  return (
    <header className={`flex flex-wrap items-center justify-between gap-2 ${cardHeaderClass}`}>
      <h2 id={id} className={cardTitleClass}>
        {title}
        {count !== undefined && <span className="ml-2 font-medium text-gray-400">{count}</span>}
      </h2>
      {aside}
    </header>
  );
}

/**
 * Now against a basis: "▼ $5.00 · 9.1%" green when cheaper, "▲" red when dearer,
 * a gray dash when unknown or level. The arrow carries direction, not the colour.
 */
export function ChangePill({
  nowCents,
  basisCents,
  currency,
  versus,
}: {
  nowCents?: number;
  basisCents?: number;
  currency: string;
  versus: string;
}) {
  if (nowCents === undefined || basisCents === undefined || nowCents === basisCents) {
    return (
      <span
        className={`${pillMutedClass} tabular-nums`}
        aria-label={nowCents === undefined || basisCents === undefined ? "No change known yet" : `Same as ${versus}`}
      >
        —
      </span>
    );
  }
  const lower = nowCents < basisCents;
  const diff = Math.abs(basisCents - nowCents);
  return (
    <span
      className={`${lower ? pillGoodClass : pillBadClass} whitespace-nowrap tabular-nums`}
      aria-label={`${fmt(diff, currency)} ${lower ? "lower" : "higher"} than ${versus}`}
      title={`vs ${versus}`}
    >
      <span aria-hidden="true" className="text-[0.7em]">
        {lower ? "▼" : "▲"}
      </span>
      <span aria-hidden="true">
        {fmt(diff, currency)}
        {basisCents > 0 && ` · ${percent(diff / basisCents)}`}
      </span>
    </span>
  );
}

const chipBase = "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium";

const VERDICTS: Record<Watch["verdict"]["label"], { label: string; className: string }> = {
  good_price: { label: "Good price", className: "bg-green-500/20 text-green-700" },
  fair: { label: "Fair", className: "bg-gray-100 text-gray-600" },
  wait: { label: "Wait", className: "bg-yellow-500/20 text-yellow-700" },
  inflated_discount: { label: "Inflated discount", className: "bg-red-500/20 text-red-700" },
  not_enough_history: { label: "Little history", className: "bg-gray-100 text-gray-500" },
  unknown: { label: "No price", className: "bg-gray-100 text-gray-500" },
};

/** A watch's verdict (or its paused / checking state); a bought item's claim status, or "Tracking". */
export function ProductStatus({ product, linked = false }: { product: Product; linked?: boolean }) {
  const { watch, item } = product;
  if (watch) {
    if (watch.checking) {
      return (
        <span className={`${chipBase} bg-violet-500/15 text-violet-700`}>
          <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden="true" />
          Checking
        </span>
      );
    }
    if (watch.status === "paused") return <span className={`${chipBase} bg-gray-100 text-gray-500`}>Paused</span>;
    const verdict = VERDICTS[watch.verdict.label];
    return (
      <span className={`${chipBase} ${verdict.className}`} title={watch.verdict.reason}>
        {verdict.label}
      </span>
    );
  }
  if (item?.claim) {
    const pill = <StatusPill status={item.claim.status} />;
    return linked ? (
      <Link
        to={`/claims/${item.claim.claimId}`}
        onClick={(event) => event.stopPropagation()}
        aria-label={`Claim for ${product.name}`}
        className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
      >
        {pill}
      </Link>
    ) : (
      pill
    );
  }
  return (
    <span className={`${chipBase} bg-gray-100 text-gray-600`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${item?.productUrl ? "bg-violet-500" : "bg-gray-300"}`} />
      {item?.productUrl ? "Tracking" : "No product link"}
    </span>
  );
}
