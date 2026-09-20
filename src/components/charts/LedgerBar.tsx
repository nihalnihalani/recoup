import { useId } from "react";
import { fmt } from "../Money";

/**
 * One claim's money as a single stacked bar: confirmed (green, solid), promised but
 * not yet confirmed (yellow, hatched — not real money yet), and what is still open
 * (red wash). `promised` is the total promised, so the gold part is promised minus
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
        className="flex h-3 gap-0.5"
      >
        {back > 0 && (
          <div className="rounded-sm bg-green-500" style={{ width: `${(back / scale) * 100}%` }} title={`Back on card ${fmt(back, currency)}`} />
        )}
        {pending > 0 && (
          <svg
            className="h-full rounded-sm"
            style={{ width: `${(pending / scale) * 100}%` }}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <title>{`Promised ${fmt(pending, currency)}`}</title>
            <defs>
              <pattern id={hatchId} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="5" height="5" className="fill-yellow-500/25" />
                <rect width="2" height="5" className="fill-yellow-500" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill={`url(#${hatchId})`} />
          </svg>
        )}
        {open > 0 && (
          <div className="rounded-sm bg-red-500/20" style={{ width: `${(open / scale) * 100}%` }} title={`Still open ${fmt(open, currency)}`} />
        )}
        {back + pending + open === 0 && <div className="flex-1 rounded-sm bg-gray-100" />}
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
        {parts.map((part) => (
          <div key={part.key} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`size-2.5 rounded-sm ${
                part.key === "confirmed"
                  ? "bg-green-500"
                  : part.key === "promised"
                    ? "border border-yellow-500 bg-yellow-500/25"
                    : "bg-red-500/20"
              }`}
            />
            <dt className="text-gray-500">{part.label}</dt>
            <dd className="font-semibold tabular-nums text-gray-800">{fmt(part.cents, currency)}</dd>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <dt className="text-gray-500">Expected</dt>
          <dd className="font-semibold tabular-nums text-gray-800">{fmt(expected, currency)}</dd>
        </div>
      </dl>
    </div>
  );
}
