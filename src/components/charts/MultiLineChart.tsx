import { useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { shortDay, useMeasuredWidth, when } from "../../lib/ui";

export type LinePoint = { at: number; value: number };

export type LineSeries = {
  id: string;
  label: string;
  /** Any CSS colour; pass a variable (`var(--color-blue-600)`) so themes keep working. */
  color: string;
  points: LinePoint[];
};

export type MultiLineChartProps = {
  series: LineSeries[];
  format: (value: number) => string;
  height?: number;
  /** One observation to pin a dark callout to, e.g. the overall lowest price. */
  highlight?: { at: number; value: number; seriesId: string; label: string };
  /** A dashed level across the plot, e.g. the target price. */
  reference?: { value: number; label: string };
  ariaLabel: string;
};

type XY = { x: number; y: number };

/** Sorted by time, one point per instant (the later one wins), non-finite values dropped. */
function clean(points: LinePoint[]): LinePoint[] {
  const sorted = points.filter((p) => Number.isFinite(p.at) && Number.isFinite(p.value)).sort((a, b) => a.at - b.at);
  const out: LinePoint[] = [];
  for (const p of sorted) {
    if (out.length > 0 && out[out.length - 1].at === p.at) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

const n = (value: number) => Math.round(value * 100) / 100;

/** Monotone-x cubic (Fritsch–Butland tangents): the curve never overshoots the data between two observations. */
function smoothPath(pts: XY[]): string {
  if (pts.length === 0) return "";
  let d = `M${n(pts[0].x)},${n(pts[0].y)}`;
  if (pts.length === 1) return d;
  if (pts.length === 2) return `${d}L${n(pts[1].x)},${n(pts[1].y)}`;

  const h: number[] = [];
  const s: number[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    h.push(dx);
    s.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx);
  }
  const t: number[] = [s[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (s[i - 1] * s[i] <= 0) {
      t.push(0);
    } else {
      const w = h[i - 1] + h[i];
      t.push((3 * w) / ((w + h[i]) / s[i - 1] + (w + h[i - 1]) / s[i]));
    }
  }
  t.push(s[s.length - 1]);

  for (let i = 0; i < pts.length - 1; i++) {
    const third = h[i] / 3;
    d += `C${n(pts[i].x + third)},${n(pts[i].y + t[i] * third)},${n(pts[i + 1].x - third)},${n(
      pts[i + 1].y - t[i + 1] * third,
    )},${n(pts[i + 1].x)},${n(pts[i + 1].y)}`;
  }
  return d;
}

/** Up to `count` round-numbered ticks inside [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) ticks.push(v);
  return ticks;
}

/** The series' latest observation at or before `at`: a price holds until the next reading. */
function knownAt(points: LinePoint[], at: number): LinePoint | undefined {
  let known: LinePoint | undefined;
  for (const p of points) {
    if (p.at > at) break;
    known = p;
  }
  return known;
}

const WHISKER = 12;

/**
 * Several series over one time axis and one y-scale: a 2px line per series with a
 * faint wash under it, dashed gridlines, an optional dashed reference level and an
 * optional dark callout pinned to one observation. A series with a single reading
 * is a dot with a short whisker, never an invented line. Hover, touch or focus the
 * plot for a crosshair with every series' price at that time; arrow keys step
 * through the readings.
 */
export function MultiLineChart({ series, format, height = 280, highlight, reference, ariaLabel }: MultiLineChartProps) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(640);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [active, setActive] = useState<number | null>(null);
  const stops = useRef<(SVGRectElement | null)[]>([]);

  const lines = series.map((s) => ({ ...s, points: clean(s.points) })).filter((s) => s.points.length > 0);
  const times = [...new Set(lines.flatMap((s) => s.points.map((p) => p.at)))].sort((a, b) => a - b);

  if (lines.length === 0) {
    return (
      <div
        ref={ref}
        role="img"
        aria-label={`${ariaLabel}. No price in this range.`}
        className="relative flex w-full items-center justify-center"
        style={{ height }}
      >
        <div className="absolute inset-x-0 bottom-6 border-t border-dashed border-gray-200" aria-hidden="true" />
        <span className="text-sm text-gray-400">No price read in this range</span>
      </div>
    );
  }

  // One y-scale for everything the chart draws.
  const values = [...lines.flatMap((s) => s.points.map((p) => p.value)), ...(reference ? [reference.value] : [])];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = hi === lo ? Math.abs(hi) * 0.05 || 1 : (hi - lo) * 0.14;
  lo -= pad;
  hi += pad;

  const ticks = niceTicks(lo, hi, height < 220 ? 3 : 4);
  const longest = ticks.reduce((len, t) => Math.max(len, format(t).length), 0);
  const M = { top: 12, right: 16, bottom: 28, left: Math.min(Math.max(longest * 7 + 14, 40), Math.round(width * 0.28)) };
  const plotW = Math.max(width - M.left - M.right, 10);
  const plotH = Math.max(height - M.top - M.bottom, 10);
  const right = M.left + plotW;
  const bottom = M.top + plotH;

  const t0 = times[0];
  const t1 = times[times.length - 1];
  const x = (at: number) => (t1 === t0 ? M.left + plotW / 2 : M.left + ((at - t0) / (t1 - t0)) * plotW);
  const y = (value: number) => M.top + (1 - (value - lo) / (hi - lo)) * plotH;

  const tickCount = t1 === t0 ? 1 : width < 420 ? 3 : 5;
  const xTicks = Array.from({ length: tickCount }, (_, i) => (tickCount === 1 ? t0 : t0 + ((t1 - t0) * i) / (tickCount - 1)));
  // Under a day and a half the date alone would repeat itself, so the axis tells the time.
  const xLabel = (t: number) =>
    t1 !== t0 && t1 - t0 < 36 * 3_600_000 ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : shortDay(t);

  const last = times.length - 1;
  const activeAt = active !== null && active <= last ? times[active] : undefined;
  const readings =
    activeAt === undefined
      ? []
      : lines.flatMap((s) => {
          const known = knownAt(s.points, activeAt);
          return known ? [{ id: s.id, label: s.label, color: s.color, point: known }] : [];
        });

  function nearest(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = M.left + ((event.clientX - box.left) / Math.max(box.width, 1)) * plotW;
    let best = 0;
    for (let i = 1; i < times.length; i++) {
      if (Math.abs(x(times[i]) - px) < Math.abs(x(times[best]) - px)) best = i;
    }
    setActive(best);
  }

  function onKeyDown(event: KeyboardEvent<SVGRectElement>, i: number) {
    const next =
      event.key === "ArrowLeft" ? Math.max(0, i - 1)
      : event.key === "ArrowRight" ? Math.min(last, i + 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    stops.current[next]?.focus();
  }

  const pin = highlight && lines.some((s) => s.id === highlight.seriesId) ? { ...highlight, x: x(highlight.at), y: y(highlight.value) } : undefined;
  const pinColor = pin ? lines.find((s) => s.id === pin.seriesId)?.color : undefined;
  const clampLeft = (px: number, half: number) => Math.min(Math.max(px, Math.min(half, width / 2)), Math.max(width - half, width / 2));
  const pinBelow = pin ? pin.y < 84 : false;
  const crossX = activeAt === undefined ? 0 : x(activeAt);
  const refY = reference ? y(reference.value) : 0;
  const summary = lines.map((s) => `${s.label} ${format(s.points[s.points.length - 1].value)}`).join(", ");

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        <defs>
          {lines.map((s, i) => (
            <linearGradient key={s.id} id={`ml-${uid}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.12} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>

        <g role="img" aria-label={`${ariaLabel}. Latest: ${summary}.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={right} y1={y(t)} y2={y(t)} className="stroke-gray-200" strokeWidth={1} strokeDasharray="3 5" />
              <text x={M.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className="fill-gray-400 text-xs tabular-nums">
                {format(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text
              key={t}
              x={x(t)}
              y={bottom + 20}
              textAnchor={xTicks.length === 1 ? "middle" : i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
              className="fill-gray-400 text-xs tabular-nums"
            >
              {xLabel(t)}
            </text>
          ))}

          {reference && (
            <g>
              <line x1={M.left} x2={right} y1={refY} y2={refY} className="stroke-gray-400" strokeWidth={1} strokeDasharray="6 4" />
              <text
                x={right}
                y={refY}
                dy={refY - M.top < 14 ? "1.15em" : "-0.45em"}
                textAnchor="end"
                className="fill-gray-500 text-[11px] font-medium"
                style={{ paintOrder: "stroke", stroke: "var(--color-white)", strokeWidth: 3, strokeLinejoin: "round" }}
              >
                {reference.label}
              </text>
            </g>
          )}

          {lines.map((s, i) => {
            const marks = s.points.map((p) => ({ x: x(p.at), y: y(p.value) }));
            if (marks.length === 1) {
              const m = marks[0];
              return (
                <line
                  key={s.id}
                  x1={Math.max(M.left, m.x - WHISKER)}
                  x2={Math.min(right, m.x + WHISKER)}
                  y1={m.y}
                  y2={m.y}
                  strokeWidth={2}
                  strokeLinecap="round"
                  className="chart-fade"
                  style={{ stroke: s.color }}
                />
              );
            }
            const line = smoothPath(marks);
            const area = `${line}L${n(marks[marks.length - 1].x)},${bottom}L${n(marks[0].x)},${bottom}Z`;
            return (
              <g key={s.id}>
                <path key={`a${marks.length}`} d={area} fill={`url(#ml-${uid}-${i})`} className="chart-morph chart-fade" />
                <path
                  key={`l${marks.length}`}
                  d={line}
                  pathLength={1}
                  fill="none"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className="chart-morph chart-draw"
                  style={{ stroke: s.color }}
                />
              </g>
            );
          })}

          {/* Where each series stands now; a lone reading gets its dot here too. */}
          {lines.map((s) => {
            const end = s.points[s.points.length - 1];
            return (
              <circle
                key={s.id}
                cx={x(end.at)}
                cy={y(end.value)}
                r={4}
                strokeWidth={2}
                className="chart-fade stroke-white"
                style={{ fill: s.color }}
              />
            );
          })}
        </g>

        {pin && (
          <g aria-hidden="true">
            <circle cx={pin.x} cy={pin.y} r={10} opacity={0.18} className="chart-fade" style={{ fill: pinColor }} />
            <circle cx={pin.x} cy={pin.y} r={5} strokeWidth={2.5} className="chart-fade stroke-white" style={{ fill: pinColor }} />
          </g>
        )}

        {activeAt !== undefined && (
          <g aria-hidden="true">
            <line x1={crossX} x2={crossX} y1={M.top} y2={bottom} className="stroke-gray-300" strokeWidth={1} />
            {readings.map((r) => (
              <circle
                key={r.id}
                cx={x(r.point.at)}
                cy={y(r.point.value)}
                r={5}
                strokeWidth={2}
                className="stroke-white"
                style={{ fill: r.color }}
              />
            ))}
          </g>
        )}

        <rect
          x={M.left}
          y={0}
          width={plotW}
          height={height}
          fill="transparent"
          aria-hidden="true"
          onPointerMove={nearest}
          onPointerDown={nearest}
          onPointerLeave={() => setActive(null)}
        />

        {/* One tab stop; the arrow keys walk the readings. The crosshair is the focus mark. */}
        <g role="group" aria-label="Price readings. Use the arrow keys to move through time.">
          {times.map((at, i) => {
            const told = lines
              .flatMap((s) => {
                const known = knownAt(s.points, at);
                return known ? [`${s.label} ${format(known.value)}`] : [];
              })
              .join(", ");
            return (
              <rect
                key={at}
                ref={(el) => {
                  stops.current[i] = el;
                }}
                x={x(at) - 3}
                y={M.top}
                width={6}
                height={plotH}
                rx={3}
                fill="transparent"
                className="pointer-events-none outline-none focus-visible:fill-gray-900/10"
                tabIndex={(active ?? last) === i ? 0 : -1}
                role="img"
                aria-label={`${when(at)}: ${told}`}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                onKeyDown={(event) => onKeyDown(event, i)}
              />
            );
          })}
        </g>
      </svg>

      {pin && activeAt === undefined && (
        <div
          className="chart-fade pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-xl bg-gray-900 px-3 py-2 text-center shadow-lg"
          style={{
            left: clampLeft(pin.x, 64),
            top: pinBelow ? pin.y + 14 : undefined,
            bottom: pinBelow ? undefined : height - pin.y + 14,
          }}
        >
          <p className="text-[11px] font-medium text-gray-300">{pin.label}</p>
          <p className="text-sm font-semibold tabular-nums text-gray-100">{format(pin.value)}</p>
          <p className="text-[11px] tabular-nums text-gray-300">{new Date(pin.at).toLocaleDateString(undefined, { dateStyle: "medium" })}</p>
        </div>
      )}

      {activeAt !== undefined && (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-20 w-48 -translate-x-1/2 rounded-xl bg-gray-900 px-3 py-2.5 shadow-lg"
          style={{ left: clampLeft(crossX, 100) }}
        >
          <p className="text-[11px] font-medium tabular-nums text-gray-300">{when(activeAt)}</p>
          <ul className="mt-1.5 space-y-1">
            {readings.map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-xs text-gray-300">
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                <span className="min-w-0 grow truncate">{r.label}</span>
                <span className="font-semibold tabular-nums text-gray-100">{format(r.point.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
