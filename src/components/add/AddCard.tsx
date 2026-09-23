import type { ReactNode } from "react";

/** The intake page's card: the Settings card look (hairline border, dashed header rule), with a real heading id. */
export function AddCard({
  id,
  title,
  hint,
  children,
  className = "",
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={`min-w-0 rounded-2xl border border-gray-200 bg-white ${className}`}>
      <header className="mx-5 border-b border-dashed border-gray-200 py-4">
        <h2 id={id} className="text-base font-semibold text-gray-900">
          {title}
        </h2>
        {hint && <p className="mt-1 text-sm text-gray-600">{hint}</p>}
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}
