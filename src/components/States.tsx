import type { ReactNode } from "react";

/** A ledger-page skeleton: blank ruled lines standing in for rows not loaded yet. */
export function Loading({ rows = 3, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`space-y-3 ${className}`} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 animate-pulse rounded-md border border-line bg-ink/5"
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
      className={`rounded-lg border border-dashed border-line bg-ink/[0.02] px-6 py-10 text-center ${className}`}
    >
      <p className="font-serif text-lg text-ink">{title}</p>
      {hint && <p className="mx-auto mt-2 max-w-sm text-sm text-ink/60">{hint}</p>}
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
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={`rounded-lg border border-rust/30 bg-rust/5 px-4 py-3 text-sm text-rust ${className}`}
    >
      <p className="font-medium">Something didn't work.</p>
      <p className="mt-1 text-rust/90">{message}</p>
      {retry && (
        <button
          type="button"
          onClick={retry}
          className="mt-3 rounded-md border border-rust/40 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-rust transition hover:bg-rust/10"
        >
          Try again
        </button>
      )}
    </div>
  );
}
