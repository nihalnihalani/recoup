import { remainingLabel, useNow } from "../../lib/ui";

const DAY = 86_400_000;

/**
 * The price-adjustment window as a slim bar that drains: a gray track, and a fill
 * for the share of the window still open (near-black, amber under 3 days, red
 * under 24 hours). Re-renders every minute.
 */
export function WindowMeter({ purchasedAt, endsAt }: { purchasedAt?: number; endsAt?: number }) {
  const now = useNow(60_000);

  if (endsAt === undefined) {
    return (
      <div role="img" aria-label="No price-adjustment window known">
        <div className="h-1.5 rounded-full border border-dashed border-gray-300" aria-hidden="true" />
        <p className="mt-1 text-xs text-gray-400">no window known</p>
      </div>
    );
  }

  const remaining = endsAt - now;
  const closed = remaining <= 0;
  // Without a purchase date the bar is scaled against a 30-day window.
  const start = purchasedAt !== undefined && purchasedAt < endsAt ? purchasedAt : endsAt - 30 * DAY;
  const total = endsAt - start;
  const elapsed = closed ? 1 : Math.min(1, Math.max(0, (now - start) / total));

  const tone = remaining < DAY ? "bg-rust" : remaining < 3 * DAY ? "bg-gold" : "bg-gray-900";
  const text = closed
    ? "text-gray-400"
    : remaining < DAY
      ? "text-red-700"
      : remaining < 3 * DAY
        ? "text-yellow-700"
        : "text-gray-900";
  const label = closed ? "window closed" : `${remainingLabel(remaining)} left`;
  const totalDays = Math.round(total / DAY);

  return (
    <div
      role="img"
      aria-label={
        closed
          ? "Price-adjustment window closed"
          : `Price-adjustment window: ${remainingLabel(remaining)} left of ${totalDays} days`
      }
    >
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
        {!closed && (
          <div
            className={`h-full min-w-1.5 rounded-full transition-[width] duration-500 motion-reduce:transition-none ${tone}`}
            style={{ width: `${(1 - elapsed) * 100}%` }}
          />
        )}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 whitespace-nowrap text-xs">
        <span className={`font-medium tabular-nums ${text}`}>
          {label}
        </span>
        {!closed && purchasedAt !== undefined && (
          <span className="tabular-nums text-gray-400">{totalDays}d window</span>
        )}
      </div>
    </div>
  );
}
