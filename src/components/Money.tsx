import { fmt } from "../lib/money";

/** A money amount set in tabular numerals so columns of figures line up like a ledger. */
export function Money({
  cents,
  currency,
  className = "",
}: {
  cents: number;
  currency: string;
  className?: string;
}) {
  return <span className={`font-mono tabular-nums ${className}`}>{fmt(cents, currency)}</span>;
}
