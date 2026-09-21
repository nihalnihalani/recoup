import type { ReactNode } from "react";
import { errorText } from "../lib/ui";

/** A skeleton of card-shaped blocks standing in for rows not loaded yet. */
export function Loading({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-14 animate-pulse rounded-2xl border border-gray-200 bg-gray-50 motion-reduce:animate-none"
          style={{ animationDelay: `${i * 100}ms` }}
        />
      ))}
    </div>
  );
}

/** An invitation to act, not a dead end. Dashed border echoes "nothing here yet". */
export function Empty({
  title,
  hint,
  action,
  className = "",
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center ${className}`}
    >
      <p className="text-base font-semibold text-gray-900">{title}</p>
      {hint && <p className="mx-auto mt-2 max-w-sm text-sm text-gray-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Says what went wrong, in the interface's voice. No apology, no vagueness. */
export function ErrorBox({
  error,
  retry,
  className = "",
}: {
  error: unknown;
  retry?: () => void;
  className?: string;
}) {
  const message = errorText(error);
  return (
    <div
      role="alert"
      className={`rounded-2xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-700 ${className}`}
    >
      <p className="font-semibold">Something didn't work.</p>
      <p className="mt-1 text-red-700/90">{message}</p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded-xl border border-red-500/40 bg-white px-3 py-1.5 text-sm font-semibold text-red-700 transition hover:border-red-500/70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-500"
        >
          Try again
        </button>
      )}
    </div>
  );
}
