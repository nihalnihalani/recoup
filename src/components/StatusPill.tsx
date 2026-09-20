export type ClaimStatus =
  | "detected"
  | "drafted"
  | "queued"
  | "sent"
  | "packet"
  | "promised"
  | "confirmed"
  | "reopened"
  | "dismissed";

/**
 * One tone per claim status, as a soft tinted pill. The finish carries meaning too:
 * a dashed edge = not yet real money (promised), a solid fill = money actually moved
 * (confirmed / reopened), a pulsing dot = a send in flight (queued), and dismissed
 * reads muted with a strike, since it is no longer live.
 */
const CONFIG: Record<ClaimStatus, { label: string; className: string; dot?: boolean }> = {
  detected: { label: "Found", className: "bg-gray-100 text-gray-600 border border-transparent" },
  drafted: { label: "Draft ready", className: "bg-violet-500/15 text-violet-700 border border-transparent" },
  queued: { label: "Sending…", className: "bg-yellow-500/20 text-yellow-700 border border-transparent", dot: true },
  sent: { label: "Asked", className: "bg-violet-500 text-white border border-transparent" },
  packet: { label: "Sent via merchant", className: "bg-sky-500/20 text-sky-700 border border-transparent" },
  promised: { label: "Promised", className: "bg-yellow-500/20 text-yellow-700 border border-dashed border-yellow-500" },
  confirmed: { label: "Back on card", className: "bg-green-700 text-white border border-transparent" },
  reopened: { label: "Charged again", className: "bg-red-500 text-white border border-transparent" },
  dismissed: { label: "Dismissed", className: "bg-gray-100 text-gray-400 border border-transparent line-through" },
};

export function StatusPill({ status, className = "" }: { status: ClaimStatus; className?: string }) {
  const config = CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${config.className} ${className}`}
    >
      {config.dot && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {config.label}
    </span>
  );
}
