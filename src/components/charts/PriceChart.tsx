import { useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { fmt } from "../../lib/money";
import { shortDay, useMeasuredWidth, useNow, when } from "../../lib/ui";

type Point = { at: number; cents: number };
/** A plotted mark: an observation, or the purchase itself (the price you paid, on the day you paid it). */
type Mark = Point & { bought: boolean };

const DAY = 86_400_000;
const M = { top: 22, right: 72, bottom: 26, left: 56 };

/**
 * The chart's palette, once, from the theme tokens: the series is the blue `teal`
 * token, the saving is `moss`, the window marker is `gold`, everything else is gray.
 */
const C = {
  series: "var(--color-teal)",
  seriesStroke: "stroke-teal",
  seriesFill: "fill-teal",
  seriesBg: "bg-teal",
  grid: "stroke-gray-200",
  axisText: "fill-gray-400 text-xs tabular-nums",
  paidLine: "stroke-gray-400",
  saving: "fill-moss/10",
  windowLine: "stroke-gold",
  windowText: "fill-gray-500 text-[11px] font-medium",
} as const;

/** Round tick values covering [lo, hi] in cents. */
function niceTicks(lo: number, hi: number, target = 4): number[] {
  const raw = (hi - lo) / target;
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-6; v += step) ticks.push(Math.round(v));
  return ticks;
}

function axisMoney(cents: number, currency: string, whole: boolean): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    return fmt(cents, currency);
  }
}

function versusPaid(cents: number, paidCents: number, currency: string): string {
  if (cents === paidCents) return "same as you paid";
  const diff = fmt(Math.abs(paidCents - cents), currency);
  return cents < paidCents ? `${diff} below what you paid` : `${diff} above what you paid`;
}

/**
 * The hero price chart. Time runs left to right, price bottom to top. The line is
 * stepped because a price holds until the next observation; the dashed line is what
 * you paid; the green wash between the two is money on the table; the amber dashed
 * marker is where the store's price-adjustment window ends. Hover, or focus a point and use
 * the arrow keys, for date, price and the difference against the paid price.
 */
export function PriceChart({
  points,
  paidCents,
  currency,
  purchasedAt,
  windowEndsAt,
  height = 260,
}: {
  points: Point[];
  paidCents: number;
  currency: string;
  purchasedAt?: number;
  windowEndsAt?: number;
  height?: number;
}) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(640);
  const now = useNow(60_000);
  const [active, setActive] = useState<number | null>(null);
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  const gradientId = `price-area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const sorted = [...points].sort((a, b) => a.at - b.at);
  const first = sorted[0];
  // The purchase is a known price on a known day, so the line starts there.
  const marks: Mark[] = [
    ...(purchasedAt !== undefined && (first === undefined || purchasedAt < first.at)
      ? [{ at: purchasedAt, cents: paidCents, bought: true }]
      : []),
    ...sorted.map((p) => ({ ...p, bought: false })),
  ];
  const observed = sorted.length;
  const latest = sorted[observed - 1];

  // Time domain: purchase (or first sighting) to the later of the last sighting,
  // today and the window's end, with a little air after the window marker.
  const tStart = marks[0]?.at ?? (windowEndsAt !== undefined ? Math.min(now, windowEndsAt) - 7 * DAY : now - 7 * DAY);
  const lastAt = marks[marks.length - 1]?.at ?? tStart;
  const reach = windowEndsAt !== undefined ? Math.max(lastAt, windowEndsAt) : Math.max(lastAt, now);
  const tSpan = Math.max(reach - tStart, DAY);
  const tEnd = tStart + tSpan * (windowEndsAt !== undefined ? 1.06 : 1);
  const lineEnd = Math.min(Math.max(now, lastAt), tStart + tSpan);

  const values = [paidCents, ...sorted.map((p) => p.cents)];
  const vLo = Math.min(...values);
  const vHi = Math.max(...values);
  const vPad = vHi === vLo ? Math.max(paidCents * 0.08, 100) : (vHi - vLo) * 0.18;
  const yLo = Math.max(0, vLo - vPad);
  const yHi = vHi + vPad;

  const plotW = Math.max(width - M.left - M.right, 40);
  const plotH = Math.max(height - M.top - M.bottom, 40);
  const x = (at: number) => M.left + ((at - tStart) / (tEnd - tStart)) * plotW;
  const y = (cents: number) => M.top + (1 - (cents - yLo) / (yHi - yLo)) * plotH;
  const right = M.left + plotW;
  const bottom = M.top + plotH;
  const paidY = y(paidCents);

  const ticks = niceTicks(yLo, yHi);
  const whole = ticks.every((t) => t % 100 === 0);

  const xTickCount = Math.max(2, Math.min(5, Math.floor(plotW / 110)));
  // Short spans would repeat the same day label, so identical neighbours are dropped.
  const xTicks = Array.from({ length: xTickCount }, (_, i) => tStart + (tSpan * i) / (xTickCount - 1)).filter(
    (t, i, all) => i === 0 || shortDay(t) !== shortDay(all[i - 1]),
  );

  let line = "";
  const washes: { x: number; w: number; y: number; h: number }[] = [];
  marks.forEach((m, i) => {
    line += i === 0 ? `M${x(m.at)},${y(m.cents)}` : `H${x(m.at)}V${y(m.cents)}`;
    const until = marks[i + 1]?.at ?? lineEnd;
    if (m.cents < paidCents && until > m.at) {
      washes.push({ x: x(m.at), w: x(until) - x(m.at), y: paidY, h: y(m.cents) - paidY });
    }
  });
  if (marks.length > 0 && lineEnd > lastAt) line += `H${x(lineEnd)}`;
  const lineStopX = marks.length > 0 ? x(Math.max(lineEnd, lastAt)) : 0;
  const area = marks.length > 0 && lineStopX > x(marks[0].at) ? `${line}V${bottom}H${x(marks[0].at)}Z` : "";

  const windowX = windowEndsAt !== undefined ? x(windowEndsAt) : undefined;
  const windowClosed = windowEndsAt !== undefined && windowEndsAt <= now;
  const endLabelY = latest ? y(latest.cents) : paidY;
  // The paid label takes two lines at the right edge; the latest price is labelled only when clear of it.
  const showEndLabel = latest !== undefined && (endLabelY < paidY - 16 || endLabelY > paidY + 30);
  const dotR = 3.5;

  const summary =
    latest === undefined
      ? `No price observed yet. You paid ${fmt(paidCents, currency)}.`
      : `Price history, ${observed} observation${observed === 1 ? "" : "s"} from ${shortDay(sorted[0].at)} to ${shortDay(
          latest.at,
        )}. You paid ${fmt(paidCents, currency)}. Latest ${fmt(latest.cents, currency)}, ${versusPaid(
          latest.cents,
          paidCents,
          currency,
        )}. Lowest ${fmt(vLo, currency)}.${
          windowEndsAt !== undefined
            ? ` Price-adjustment window ${windowClosed ? "ended" : "ends"} ${shortDay(windowEndsAt)}.`
            : ""
        }`;

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    if (marks.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const px = M.left + ((event.clientX - box.left) / box.width) * plotW;
    let nearest = 0;
    marks.forEach((m, i) => {
      if (Math.abs(x(m.at) - px) < Math.abs(x(marks[nearest].at) - px)) nearest = i;
    });
    setActive(nearest);
  }

  function onKeyDown(event: KeyboardEvent<SVGCircleElement>, i: number) {
    const target =
      event.key === "ArrowRight"
        ? Math.min(i + 1, marks.length - 1)
        : event.key === "ArrowLeft"
          ? Math.max(i - 1, 0)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? marks.length - 1
              : null;
    if (target === null) return;
    event.preventDefault();
    dots.current[target]?.focus();
  }

  const hovered = active !== null ? marks[active] : undefined;
  const tipLabel =
    hovered === undefined
      ? ""
      : hovered.bought
        ? "You paid"
        : hovered.cents === vLo && hovered.cents < paidCents
          ? "Lowest price"
          : hovered === marks[marks.length - 1]
            ? "Latest price"
            : hovered.cents === paidCents
              ? "Same as you paid"
              : "Price";
  const tipLeft = hovered ? Math.min(Math.max(x(hovered.at), 84), width - 84) : 0;
  const tipBelow = hovered ? y(hovered.cents) < 96 : false;

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.series} stopOpacity={0.12} />
            <stop offset="100%" stopColor={C.series} stopOpacity={0} />
          </linearGradient>
        </defs>
        <g role="img" aria-label={summary}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={right} y1={y(t)} y2={y(t)} className={C.grid} strokeWidth={1} strokeDasharray="3 4" />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={C.axisText}>
                {axisMoney(t, currency, whole)}
              </text>
            </g>
          ))}
          <line x1={M.left} x2={right} y1={bottom} y2={bottom} className="stroke-gray-200" strokeWidth={1} />
          {xTicks.map((t, i) => (
            <text
              key={t}
              x={x(t)}
              y={bottom + 17}
              textAnchor={i === 0 ? "start" : "middle"}
              className={C.axisText}
            >
              {shortDay(t)}
            </text>
          ))}

          {windowX !== undefined && (
            <g>
              {right - windowX > 0 && (
                <rect x={windowX} y={M.top} width={right - windowX} height={plotH} className="fill-gray-50/70" />
              )}
              <line
                x1={windowX}
                x2={windowX}
                y1={M.top - 6}
                y2={bottom}
                className={C.windowLine}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text x={windowX - 6} y={M.top - 9} textAnchor="end" className={C.windowText}>
                {windowClosed ? "Window ended" : "Window ends"} {shortDay(windowEndsAt as number)}
              </text>
            </g>
          )}

          {washes.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={Math.max(r.w, 0)} height={Math.max(r.h, 0)} className={C.saving} />
          ))}

          <line
            x1={M.left}
            x2={right}
            y1={paidY}
            y2={paidY}
            className={C.paidLine}
            strokeWidth={1}
            strokeDasharray="5 4"
          />
          <text
            x={right + 8}
            y={paidY}
            dy="0.32em"
            className="fill-gray-500 text-[11px] font-medium"
          >
            You paid
          </text>
          <text x={right + 8} y={paidY} dy="1.5em" className="fill-gray-400 text-xs tabular-nums">
            {fmt(paidCents, currency)}
          </text>

          {area && <path d={area} fill={`url(#${gradientId})`} />}
          {line && (
            <path d={line} fill="none" className={C.seriesStroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          )}

          {showEndLabel && latest && (
            <text
              x={Math.min(x(lineEnd) + 8, right + 8)}
              y={endLabelY}
              dy="0.32em"
              className="fill-gray-900 text-xs font-semibold tabular-nums"
            >
              {fmt(latest.cents, currency)}
            </text>
          )}

          {observed === 0 && (
            <text
              x={M.left + plotW / 2}
              y={paidY + (paidY > M.top + plotH / 2 ? -22 : 30)}
              textAnchor="middle"
              className="fill-gray-400 text-sm"
            >
              No price observed yet
            </text>
          )}
        </g>

        {hovered && (
          <line
            x1={x(hovered.at)}
            x2={x(hovered.at)}
            y1={M.top}
            y2={bottom}
            className="stroke-gray-300"
            strokeWidth={1}
            strokeDasharray="3 3"
            aria-hidden="true"
          />
        )}
        {hovered && (
          <circle cx={x(hovered.at)} cy={y(hovered.cents)} r={10} className={C.seriesFill} opacity={0.16} aria-hidden="true" />
        )}

        <rect
          x={M.left}
          y={M.top}
          width={plotW}
          height={plotH}
          fill="transparent"
          aria-hidden="true"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setActive(null)}
        />

        <g role="group" aria-label="Price observations. Use the arrow keys to move between them.">
          {marks.map((m, i) => {
            const isLast = i === marks.length - 1;
            const tone = m.bought ? `fill-surface ${C.seriesStroke}` : `${C.seriesFill} stroke-surface`;
            // Only the purchase, the latest read and the point in hand are marked; the step line carries the rest.
            const shown = m.bought || isLast || active === i;
            return (
              <circle
                key={`${m.at}-${i}`}
                ref={(el) => {
                  dots.current[i] = el;
                }}
                cx={x(m.at)}
                cy={y(m.cents)}
                r={active === i ? 5 : isLast ? 4 : dotR}
                strokeWidth={2}
                opacity={shown ? 1 : 0}
                className={`${tone} pointer-events-none outline-none focus-visible:stroke-gray-900`}
                tabIndex={(active ?? marks.length - 1) === i ? 0 : -1}
                role="img"
                aria-label={`${m.bought ? "Bought" : "Observed"} ${when(m.at)}: ${fmt(m.cents, currency)}${
                  m.bought ? "" : `, ${versusPaid(m.cents, paidCents, currency)}`
                }`}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => onKeyDown(event, i)}
              />
            );
          })}
        </g>
      </svg>

      {hovered && (
        <div
          role="status"
          className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-white"
          style={{
            left: tipLeft,
            top: tipBelow ? y(hovered.cents) + 16 : undefined,
            bottom: tipBelow ? undefined : height - y(hovered.cents) + 16,
          }}
        >
          <p className="text-xs text-gray-400">{tipLabel}</p>
          <p className="mt-0.5 text-base font-bold leading-tight tabular-nums">{fmt(hovered.cents, currency)}</p>
          {!hovered.bought && hovered.cents !== paidCents && (
            <p className="mt-0.5 text-xs tabular-nums text-gray-300">
              <span aria-hidden="true" className={`mr-1 text-[0.7em] ${hovered.cents < paidCents ? "text-green-400" : "text-red-400"}`}>
                {hovered.cents < paidCents ? "▼" : "▲"}
              </span>
              {fmt(Math.abs(paidCents - hovered.cents), currency)} {hovered.cents < paidCents ? "below" : "above"} paid
            </p>
          )}
          <p className="mt-1 text-xs text-gray-400">{when(hovered.at)}</p>
        </div>
      )}
    </div>
  );
}
