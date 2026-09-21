import type { ReactNode } from "react";
import { cardClass, cardTitleClass } from "../../lib/ui";
import { ClaimIcon, type ClaimGlyph } from "./icons";

/** The small bordered tile that carries a card's line icon. */
export function IconTile({ glyph }: { glyph: ClaimGlyph }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-500">
      <ClaimIcon glyph={glyph} />
    </span>
  );
}

/**
 * The page card: white on white, held by a hairline border and a 2xl radius, no shadow.
 * The header is an icon tile and a title; `ruled` draws a dashed hairline under it,
 * used where the body is a list or a timeline.
 */
export function Card({
  title,
  icon,
  actions,
  ruled = false,
  className = "",
  bodyClassName = "p-5",
  children,
}: {
  title?: string;
  icon?: ClaimGlyph;
  actions?: ReactNode;
  ruled?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={`flex min-w-0 flex-col ${cardClass} ${className}`}>
      {title !== undefined && (
        <header className="px-5 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 items-center gap-3">
              {icon !== undefined && <IconTile glyph={icon} />}
              <h2 className={cardTitleClass}>{title}</h2>
            </div>
            {actions}
          </div>
          {ruled && <div className="mt-4 border-t border-dashed border-gray-200" aria-hidden="true" />}
        </header>
      )}
      <div className={`min-w-0 grow ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Quiet sentence-case label above a figure. */
export function StatLabel({ children }: { children: ReactNode }) {
  return <div className="text-sm font-medium text-gray-500">{children}</div>;
}
