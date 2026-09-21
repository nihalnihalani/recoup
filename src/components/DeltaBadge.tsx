import { fmt } from "../lib/money";
import { percent, pillBadClass, pillGoodClass, pillMutedClass } from "../lib/ui";

/**
 * Latest price against the paid price: "▼ $50.00 · 9.1%" (green pill) when it is lower,
 * "▲" (red pill) when higher, a muted dash when unknown or equal. The arrow carries
 * direction, so the badge never relies on colour alone.
 */
export function DeltaBadge({
  paidCents,
  latestCents,
  currency,
}: {
  paidCents: number;
  latestCents?: number;
  currency: string;
}) {

  if (latestCents === undefined || latestCents === paidCents) {
    return (
      <span
        className={`${pillMutedClass} tabular-nums`}
        aria-label={latestCents === undefined ? "No price observed yet" : "Same as you paid"}
      >
        —
      </span>
    );
  }

  const lower = latestCents < paidCents;
  const diff = Math.abs(paidCents - latestCents);
  const share = paidCents > 0 ? ` · ${percent(diff / paidCents)}` : "";

  return (
    <span
      className={`${lower ? pillGoodClass : pillBadClass} whitespace-nowrap tabular-nums`}
      aria-label={`${fmt(diff, currency)} ${lower ? "lower" : "higher"} than you paid`}
    >
      <span aria-hidden="true" className="text-[0.7em]">{lower ? "▼" : "▲"}</span>
      <span aria-hidden="true">
        {fmt(diff, currency)}
        {share}
      </span>
    </span>
  );
}
