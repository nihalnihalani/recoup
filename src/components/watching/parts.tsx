import type { ReactNode } from "react";
import { percent } from "../../lib/ui";

/** Shared pieces of the Watching page: chips, the card-header icon tile and a few line icons. */

export type Tone = "good" | "bad" | "wait" | "busy" | "muted";

const DOT: Record<Tone, string> = {
  good: "bg-moss",
  bad: "bg-rust",
  wait: "bg-gold",
  busy: "bg-harbor",
  muted: "bg-gray-300",
};

export const smallLabelClass = "text-xs font-medium text-gray-500";

export const chipClass =
  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-semibold text-gray-900";

export const smallButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-900 transition hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

export const quietButtonClass =
  "inline-flex items-center justify-center rounded-xl px-3 py-2 text-sm font-medium text-gray-500 transition hover:bg-gray-50 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60";

/** Status: a small coloured dot in a bordered chip. The words carry the meaning, the dot repeats it. */
export function Chip({ tone, pulse = false, children }: { tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={chipClass}>
      {tone && (
        <span className="relative flex size-1.5" aria-hidden="true">
          {pulse && (
            <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none ${DOT[tone]}`} />
          )}
          <span className={`relative inline-flex size-1.5 rounded-full ${DOT[tone]}`} />
        </span>
      )}
      {children}
    </span>
  );
}

/** "▼ 8%" in green when the price fell, "▲ 4%" in red when it rose. `ratio` is signed, 0.08 = 8%. */
export function DeltaChip({ ratio }: { ratio: number }) {
  if (ratio === 0) return <span className="text-xs font-medium text-gray-400">No change</span>;
  const down = ratio < 0;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums ${
        down ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-700"
      }`}
    >
      <span aria-hidden="true" className="text-[9px] leading-none">
        {down ? "▼" : "▲"}
      </span>
      <span className="sr-only">{down ? "Down" : "Up"}</span>
      {percent(Math.abs(ratio))}
    </span>
  );
}

/** The small bordered tile that opens a card header. */
export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-900">
      {children}
    </span>
  );
}

function Glyph({ children, className = "size-5" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={`shrink-0 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

type IconProps = { className?: string };

export function LinkIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.700-5.700l-1.200 1.200" />
      <path d="M14 10a4 4 0 0 0-5.700 0l-3 3a4 4 0 0 0 5.700 5.700l1.200-1.200" />
    </Glyph>
  );
}

export function TagDownIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m3.500 7 6 6 4-4 7 7" />
      <path d="M20.500 11v5h-5" />
    </Glyph>
  );
}

export function StoresIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 10v9.500h16V10" />
      <path d="M3 5.500h18l-1 4.500a2.700 2.700 0 0 1-5.300 0 2.700 2.700 0 0 1-5.400 0A2.700 2.700 0 0 1 4 10L3 5.500z" />
      <path d="M10 19.500v-5h4v5" />
    </Glyph>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6 16.500V11a6 6 0 0 1 12 0v5.500l1.500 2h-15l1.500-2z" />
      <path d="M10 20.500a2 2 0 0 0 4 0" />
    </Glyph>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="m15.500 5 3.500 3.500M4 20l.900-4.400L16.200 4.300a2 2 0 0 1 2.800 0l.700.700a2 2 0 0 1 0 2.800L8.400 19.100 4 20z" />
    </Glyph>
  );
}

export function ExternalIcon(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M10 5.500H7A2.500 2.500 0 0 0 4.500 8v9A2.500 2.500 0 0 0 7 19.500h9a2.500 2.500 0 0 0 2.500-2.500v-3" />
      <path d="M14 4.500h5.500V10M19.500 4.500 11 13" />
    </Glyph>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <Glyph className={`size-4 text-gray-400 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}
