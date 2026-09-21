import type { ReactNode } from "react";
import { cardTitleClass } from "../../lib/ui";

/** 20px line icon on a 24 grid, the same stroke as the shell's glyphs. */
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      className="size-5 shrink-0"
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

export function RuleIcon() {
  return (
    <Glyph>
      <path d="M7 3.5h7.5L19 8v12.500H7z" />
      <path d="M14.500 3.500V8H19M10 12.500h6M10 16h4" />
    </Glyph>
  );
}

export function ClaimIcon() {
  return (
    <Glyph>
      <path d="M6 3.500h12v17l-3-1.750-3 1.750-3-1.750-3 1.750z" />
      <path d="M9.500 9h5M9.500 12.500h5" />
    </Glyph>
  );
}

export function ReviewIcon() {
  return (
    <Glyph>
      <path d="M4.500 19.500l1-4L15.750 5.250a1.770 1.770 0 0 1 2.500 0l.5.5a1.770 1.770 0 0 1 0 2.500L8.500 18.500z" />
      <path d="M13.500 7.500l3 3" />
    </Glyph>
  );
}

export function BoxIcon() {
  return (
    <Glyph>
      <path d="M21 8.200 12 3 3 8.200v7.600L12 21l9-5.200z" />
      <path d="M3.300 8.400 12 13.400l8.700-5M12 13.400V21" />
    </Glyph>
  );
}

export function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path
        d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The small bordered tile that carries a card's icon. */
export function IconTile({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500">
      {children}
    </span>
  );
}

/** A card header: icon tile, title, optional line under it, and whatever sits on the right. */
export function CardHeading({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="flex min-w-0 items-center gap-3">
        <IconTile>{icon}</IconTile>
        <div className="min-w-0">
          <h2 className={cardTitleClass}>{title}</h2>
          {hint && <p className="text-sm text-gray-500">{hint}</p>}
        </div>
      </div>
      {action}
    </header>
  );
}

/** Coloured dot + label in a bordered chip: the page's one way of saying a state. */
export function DotChip({ dot, children, className = "" }: { dot: string; children: ReactNode; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-2 py-0.5 text-xs font-medium text-gray-900 ${className}`}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      {children}
    </span>
  );
}
