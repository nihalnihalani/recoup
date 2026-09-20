import { useMeasuredWidth } from "../../lib/ui";

type Point = { at: number; cents: number };

/**
 * A price history at a glance: a step line (a price holds until the next
 * observation), a dashed reference at the paid price, the gap below it washed in,
 * and the latest point emphasised. Tone follows direction against the paid price:
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
  const washes: { x: number; w: number; y: number; h: number }[] = [];
  if (points.length === 1 && last) {
    line = `M${pad},${y(last.cents)}H${w - pad}`;
    if (last.cents < paidCents) washes.push({ x: pad, w: w - 2 * pad, y: paidY, h: y(last.cents) - paidY });
  } else {
    points.forEach((p, i) => {
      line += i === 0 ? `M${x(p.at)},${y(p.cents)}` : `H${x(p.at)}V${y(p.cents)}`;
      const next = points[i + 1];
      if (next && p.cents < paidCents) {
        washes.push({ x: x(p.at), w: x(next.at) - x(p.at), y: paidY, h: y(p.cents) - paidY });
      }
    });
  }

  const direction = last === undefined || last.cents === paidCents ? "flat" : last.cents < paidCents ? "down" : "up";
  const stroke = direction === "down" ? "stroke-green-500" : direction === "up" ? "stroke-red-500" : "stroke-gray-400";
  const fill = direction === "down" ? "fill-green-500" : direction === "up" ? "fill-red-500" : "fill-gray-400";
  const summary =
    last === undefined
      ? "No price observed yet"
      : `Price trend over ${points.length} observation${points.length === 1 ? "" : "s"}: latest is ${
          direction === "down" ? "below" : direction === "up" ? "above" : "the same as"
        } what you paid`;

  return (
    <div ref={ref} style={width === undefined ? undefined : { width }}>
      <svg width={w} height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={summary} className="block">
        {washes.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={Math.max(r.w, 0)} height={Math.max(r.h, 0)} className="fill-green-500/15" />
        ))}
        <line x1={0} x2={w} y1={paidY} y2={paidY} className="stroke-gray-300" strokeWidth={1} strokeDasharray="3 3" />
        {line && (
          <path d={line} fill="none" className={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        )}
        {last && (
          <circle cx={x(last.at)} cy={y(last.cents)} r={4} className={`${fill} stroke-white`} strokeWidth={2} />
        )}
      </svg>
    </div>
  );
}
