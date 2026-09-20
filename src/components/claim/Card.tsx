import type { ReactNode } from "react";

/**
 * The dashboard card: white, rounded-xl, faint shadow. `ruled` gives the header a
 * bottom rule, used for list, table and timeline cards; plain headers sit flush
 * above their content.
 */
export function Card({
  title,
  actions,
  ruled = false,
  className = "",
  bodyClassName = "p-5",
  children,
}: {
  title?: string;
  actions?: ReactNode;
  ruled?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={`flex flex-col rounded-xl bg-white shadow-xs ${className}`}>
      {title !== undefined && (
        <header
          className={`flex flex-wrap items-center justify-between gap-2 px-5 ${
            ruled ? "border-b border-line/60 py-4" : "pt-5"
          }`}
        >
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          {actions}
        </header>
      )}
      <div className={`grow ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/** Muted uppercase label above a figure. */
export function StatLabel({ children }: { children: ReactNode }) {
  return <div className="text-xs font-semibold uppercase text-ink/40">{children}</div>;
}
