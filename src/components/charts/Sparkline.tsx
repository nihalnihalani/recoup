import { useId } from "react";
import { useMeasuredWidth } from "../../lib/ui";

type Point = { at: number; cents: number };

/** Direction against the paid price picks the tone. Tokens only, defined once. */
const TONES = {
  down: { color: "var(--color-moss)", stroke: "stroke-moss", fill: "fill-moss" },
  up: { color: "var(--color-rust)", stroke: "stroke-rust", fill: "fill-rust" },
  flat: { color: "var(--color-gray-400)", stroke: "stroke-gray-400", fill: "fill-gray-400" },
} as const;

/**
 * A price history at a glance: a thin step line (a price holds until the next
 * observation) over a soft gradient, a dashed reference at the paid price, and
 * only the latest point marked. Tone follows direction against the paid price:
 * green below, red above, gray when equal. Fills its container unless `width`
 * is given.
 */
export function Sparkline({
  points,
  paidCents,
  width,
  height = 36,
}: {
  points: Point[];
  paidCents: number;
  width?: number;
  height?: number;
}) {
  const { ref, width: measuredWidth } = useMeasuredWidth<HTMLDivElement>(width ?? 160);
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const w = width ?? measuredWidth;
  const pad = 5;

  const last = points[points.length - 1];
  const values = [paidCents, ...points.map((p) => p.cents)];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.max(paidCents * 0.1, 1);
  const yLo = hi === lo ? lo - span / 2 : lo;
  const y = (cents: number) => pad + (1 - (cents - yLo) / span) * (height - 2 * pad);

  const t0 = points[0]?.at ?? 0;
  const t1 = last?.at ?? 1;
  const x = (at: number) => (t1 === t0 ? w - pad : pad + ((at - t0) / (t1 - t0)) * (w - 2 * pad));

  const paidY = y(paidCents);
  let line = "";
  let startX = pad;
  let endX = w - pad;
  if (points.length === 1 && last) {
    line = `M${pad},${y(last.cents)}H${w - pad}`;
  } else if (last) {
    points.forEach((p, i) => {
      line += i === 0 ? `M${x(p.at)},${y(p.cents)}` : `H${x(p.at)}V${y(p.cents)}`;
    });
    startX = x(points[0].at);
    endX = x(last.at);
  }
  const area = line ? `${line}V${height}H${startX}Z` : "";

  const direction = last === undefined || last.cents === paidCents ? "flat" : last.cents < paidCents ? "down" : "up";
  const tone = TONES[direction];
  const summary =
    last === undefined
      ? "No price observed yet"
      : `Price trend over ${points.length} observation${points.length === 1 ? "" : "s"}: latest is ${
          direction === "down" ? "below" : direction === "up" ? "above" : "the same as"
        } what you paid`;

  return (
    <div ref={ref} style={width === undefined ? undefined : { width }}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={summary} className="block">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone.color} stopOpacity={0.16} />
            <stop offset="100%" stopColor={tone.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {area && endX > startX && <path d={area} fill={`url(#${gradientId})`} />}
        <line x1={0} x2={w} y1={paidY} y2={paidY} className="stroke-gray-300" strokeWidth={1} strokeDasharray="3 3" />
        {line && (
          <path d={line} fill="none" className={tone.stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {last && (
          <circle cx={x(last.at)} cy={y(last.cents)} r={3} className={`${tone.fill} stroke-surface`} strokeWidth={1.5} />
        )}
      </svg>
    </div>
  );
}
