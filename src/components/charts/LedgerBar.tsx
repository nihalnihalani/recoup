import { useId } from "react";
import { fmt } from "../Money";

/**
 * One claim's money as a single stacked bar: confirmed (green, solid), promised but
 * not yet confirmed (amber, hatched: not real money yet), and the remainder still
 * open (gray). `promised` is the total promised, so the amber part is promised minus
 * confirmed. Segments are separated by a 2px surface gap, not by strokes.
 */
export function LedgerBar({
  expected,
  promised,
  confirmed,
  currency,
}: {
  expected: number;
  promised: number;
  confirmed: number;
  currency: string;
}) {
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const back = Math.max(0, confirmed);
  const pending = Math.max(0, promised - back);
  const open = Math.max(0, expected - back - pending);
  const scale = Math.max(back + pending + open, 1);

  const parts = [
    { key: "confirmed", label: "Back on card", cents: back },
    { key: "promised", label: "Promised", cents: pending },
    { key: "open", label: "Still open", cents: open },
  ] as const;

  return (
    <div>
      <div
        role="img"
        aria-label={`Of ${fmt(expected, currency)} expected: ${fmt(back, currency)} back on card, ${fmt(pending, currency)} promised, ${fmt(open, currency)} still open`}
        className="flex h-2.5 gap-0.5"
      >
        {back > 0 && (
          <div className="rounded-full bg-moss" style={{ width: `${(back / scale) * 100}%` }} title={`Back on card ${fmt(back, currency)}`} />
        )}
        {pending > 0 && (
          <svg
            className="h-full rounded-full"
            style={{ width: `${(pending / scale) * 100}%` }}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <title>{`Promised ${fmt(pending, currency)}`}</title>
            <defs>
              <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" className="fill-gold/20" />
                <rect width="2" height="5" className="fill-gold" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${hatchId})`} />
          </svg>
        )}
        {open > 0 && (
          <div className="rounded-full bg-gray-200" style={{ width: `${(open / scale) * 100}%` }} title={`Still open ${fmt(open, currency)}`} />
        )}
        {back + pending + open === 0 && <div className="flex-1 rounded-full bg-gray-100" />}
      </div>

      <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {parts.map((part) => (
          <div key={part.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2 rounded-full ${
                part.key === "confirmed"
                  ? "bg-moss"
                  : part.key === "promised"
                    ? "border border-gold bg-gold/20"
                    : "bg-gray-300"
              }`}
            />
            <dt className="text-gray-500">{part.label}</dt>
            <dd className="font-semibold tabular-nums text-gray-900">{fmt(part.cents, currency)}</dd>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <dt className="text-gray-500">Expected</dt>
          <dd className="font-semibold tabular-nums text-gray-900">{fmt(expected, currency)}</dd>
        </div>
      </dl>
    </div>
  );
}
