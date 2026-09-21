import { useId, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";
import { shortDay, useMeasuredWidth, when } from "../../lib/ui";

export type AreaPoint = { at: number; value: number };
export type AreaTone = "violet" | "green" | "red" | "sky";

export type AreaChartProps = {
  series: AreaPoint[];
  compare?: AreaPoint[];
  reference?: { value: number; label: string };
  height?: number;
  tone?: AreaTone;
  format?: (value: number) => string;
  showAxes?: boolean;
  curve?: "smooth" | "step";
  ariaLabel: string;
};

const TONES: Record<AreaTone, { color: string; stroke: string; fill: string; bg: string }> = {
  violet: { color: "var(--color-violet-500)", stroke: "stroke-violet-500", fill: "fill-violet-500", bg: "bg-violet-500" },
  green: { color: "var(--color-green-500)", stroke: "stroke-green-500", fill: "fill-green-500", bg: "bg-green-500" },
  red: { color: "var(--color-red-500)", stroke: "stroke-red-500", fill: "fill-red-500", bg: "bg-red-500" },
  sky: { color: "var(--color-sky-500)", stroke: "stroke-sky-500", fill: "fill-sky-500", bg: "bg-sky-500" },
};

type XY = { x: number; y: number };

/** Sorted by time, one point per instant (the later one wins), non-finite values dropped. */
function clean(points: AreaPoint[]): AreaPoint[] {
  const sorted = points
    .filter((p) => Number.isFinite(p.at) && Number.isFinite(p.value))
    .sort((a, b) => a.at - b.at);
  const out: AreaPoint[] = [];
  for (const p of sorted) {
    if (out.length > 0 && out[out.length - 1].at === p.at) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

const n = (value: number) => Math.round(value * 100) / 100;

/**
 * Monotone-x cubic through the points (Fritsch–Butland tangents, as d3's curveMonotoneX):
 * the curve never rises above or dips below the data between two observations.
 */
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

function stepPath(pts: XY[]): string {
  let d = "";
  pts.forEach((p, i) => {
    d += i === 0 ? `M${n(p.x)},${n(p.y)}` : `H${n(p.x)}V${n(p.y)}`;
  });
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

/**
 * A responsive area chart of one series over time: 2px line in the tone colour, a
 * gradient wash under it, an optional gray comparison line behind and an optional
 * dashed reference level. Hover or focus a point for the crosshair and tooltip;
 * arrow keys move between points. One y-axis, always.
 */
export function AreaChart({
  series,
  compare,
  reference,
  height = 160,
  tone = "violet",
  format = (value) => String(value),
  showAxes = false,
  curve = "smooth",
  ariaLabel,
}: AreaChartProps) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>(320);
  const gradientId = `area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [active, setActive] = useState<number | null>(null);
  const dots = useRef<(SVGCircleElement | null)[]>([]);
  const palette = TONES[tone];

  const data = clean(series);
  const behind = clean(compare ?? []);

  if (data.length === 0) {
    return (
      <div
        ref={ref}
        role="img"
        aria-label={`${ariaLabel}. No price yet.`}
        className="relative flex w-full items-center justify-center"
        style={{ height }}
      >
        <div className="absolute inset-x-0 bottom-2 border-t border-dashed border-gray-200" aria-hidden="true" />
        <span className="text-xs text-gray-400">No price yet</span>
      </div>
    );
  }

  // Domain: every value the chart draws shares the one y-scale.
  const values = [...data.map((p) => p.value), ...behind.map((p) => p.value), ...(reference ? [reference.value] : [])];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    const pad = Math.abs(hi) * 0.05 || 1;
    lo -= pad;
    hi += pad;
  } else {
    const pad = (hi - lo) * 0.12;
    lo -= pad;
    hi += pad;
  }
  const ticks = showAxes ? niceTicks(lo, hi, 4) : [];
  const longest = ticks.reduce((len, t) => Math.max(len, format(t).length), 0);

  const M = showAxes
    ? { top: 14, right: 14, bottom: 26, left: Math.min(Math.max(longest * 7 + 14, 36), Math.round(width * 0.3)) }
    : { top: 8, right: 8, bottom: 6, left: 4 };
  const plotW = Math.max(width - M.left - M.right, 10);
  const plotH = Math.max(height - M.top - M.bottom, 10);
  const right = M.left + plotW;
  const bottom = M.top + plotH;

  const times = [...data, ...behind].map((p) => p.at);
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const x = (at: number) => (t1 === t0 ? M.left + plotW / 2 : M.left + ((at - t0) / (t1 - t0)) * plotW);
  const y = (value: number) => M.top + (1 - (value - lo) / (hi - lo)) * plotH;

  const toXY = (points: AreaPoint[]): XY[] => points.map((p) => ({ x: x(p.at), y: y(p.value) }));
  const pathOf = (points: XY[]) => (curve === "step" ? stepPath(points) : smoothPath(points));

  const marks = toXY(data);
  const line = data.length > 1 ? pathOf(marks) : "";
  const area = line ? `${line}L${n(marks[marks.length - 1].x)},${bottom}L${n(marks[0].x)},${bottom}Z` : "";
  // A one-point comparison is a level, not a line: stretch it across the plot.
  const compareXY = behind.length === 1 ? [{ x: M.left, y: y(behind[0].value) }, { x: right, y: y(behind[0].value) }] : toXY(behind);
  const compareLine = compareXY.length > 1 ? pathOf(compareXY) : "";

  const last = data.length - 1;
  const xTicks = t1 === t0 ? [t0] : [t0, t0 + (t1 - t0) / 2, t1];
  // Under a day and a half the date alone would repeat itself, so the axis tells the time.
  const xLabel = (t: number) =>
    t1 - t0 < 36 * 3_600_000 && t1 !== t0 ? new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : shortDay(t);

  function nearest(event: PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const px = M.left + ((event.clientX - box.left) / Math.max(box.width, 1)) * plotW;
    let best = 0;
    for (let i = 1; i < marks.length; i++) {
      if (Math.abs(marks[i].x - px) < Math.abs(marks[best].x - px)) best = i;
    }
    setActive(best);
  }

  function onKeyDown(event: KeyboardEvent<SVGCircleElement>, i: number) {
    const next =
      event.key === "ArrowLeft" ? Math.max(0, i - 1)
      : event.key === "ArrowRight" ? Math.min(last, i + 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    dots.current[next]?.focus();
  }

  const hovered = active !== null && active <= last ? { ...data[active], ...marks[active] } : undefined;
  const tipHalf = 88;
  const tipLeft = hovered ? Math.min(Math.max(hovered.x, Math.min(tipHalf, width / 2)), Math.max(width - tipHalf, width / 2)) : 0;
  const tipBelow = hovered ? hovered.y < 64 && height - hovered.y > 72 : false;
  const refY = reference ? y(reference.value) : 0;

  return (
    <div ref={ref} className="relative w-full select-none">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.color} stopOpacity={0.2} />
            <stop offset="100%" stopColor={palette.color} stopOpacity={0} />
          </linearGradient>
        </defs>

        <g role="img" aria-label={`${ariaLabel}. Latest ${format(data[last].value)}, ${shortDay(data[last].at)}.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={right} y1={y(t)} y2={y(t)} className="stroke-gray-100" strokeWidth={1} />
              <text x={M.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-gray-400 text-xs tabular-nums">
                {format(t)}
              </text>
            </g>
          ))}
          {showAxes &&
            xTicks.map((t, i) => (
              <text
                key={t}
                x={x(t)}
                y={bottom + 18}
                textAnchor={xTicks.length === 1 ? "middle" : i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                className="fill-gray-400 text-xs tabular-nums"
              >
                {xLabel(t)}
              </text>
            ))}

          {/* One observation: a faint level through it, so the dot does not float. */}
          {data.length === 1 && (
            <line x1={M.left} x2={right} y1={marks[0].y} y2={marks[0].y} className="stroke-gray-200" strokeWidth={1} />
          )}

          {compareLine && (
            <path
              d={compareLine}
              fill="none"
              className="chart-morph stroke-gray-300"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {reference && (
            <g>
              <line x1={M.left} x2={right} y1={refY} y2={refY} className="stroke-gray-400" strokeWidth={1} strokeDasharray="4 4" />
              <text
                x={right}
                y={refY}
                dy={refY - M.top < 14 ? "1.15em" : "-0.45em"}
                textAnchor="end"
                className="fill-gray-400 text-[11px] font-medium"
                style={{ paintOrder: "stroke", stroke: "white", strokeWidth: 3, strokeLinejoin: "round" }}
              >
                {reference.label}
              </text>
            </g>
          )}

          {area && <path key={`a${data.length}`} d={area} fill={`url(#${gradientId})`} className="chart-morph chart-fade" />}
          {line && (
            <path
              key={`l${data.length}`}
              d={line}
              pathLength={1}
              fill="none"
              className={`chart-morph chart-draw ${palette.stroke}`}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
        </g>

        {hovered && (
          <line x1={hovered.x} x2={hovered.x} y1={M.top} y2={bottom} className="stroke-gray-300" strokeWidth={1} aria-hidden="true" />
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

        <g role="group" aria-label="Observations. Use the arrow keys to move between them.">
          {marks.map((m, i) => {
            const shown = i === last || i === active;
            return (
              <circle
                key={data[i].at}
                ref={(el) => {
                  dots.current[i] = el;
                }}
                cx={m.x}
                cy={m.y}
                r={i === active ? 5 : 4}
                strokeWidth={2}
                opacity={shown ? 1 : 0}
                className={`${palette.fill} pointer-events-none stroke-white outline-none focus-visible:stroke-gray-900 ${
                  i === last ? "chart-fade" : ""
                }`}
                tabIndex={(active ?? last) === i ? 0 : -1}
                role="img"
                aria-label={`${when(data[i].at)}: ${format(data[i].value)}`}
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
          className="pointer-events-none absolute z-20 w-44 -translate-x-1/2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-lg"
          style={{
            left: tipLeft,
            top: tipBelow ? hovered.y + 12 : undefined,
            bottom: tipBelow ? undefined : height - hovered.y + 12,
          }}
        >
          <p className="truncate text-xs font-medium text-gray-400">{when(hovered.at)}</p>
          <p className="mt-0.5 flex items-center gap-2 text-sm font-semibold tabular-nums text-gray-800">
            <span aria-hidden="true" className={`h-0.5 w-3 rounded-full ${palette.bg}`} />
            {format(hovered.value)}
          </p>
        </div>
      )}
    </div>
  );
}
