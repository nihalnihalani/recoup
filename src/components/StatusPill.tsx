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
 * One tone per claim status. The finish carries meaning, not just the color:
 * dashed = not yet real money (promised), solid fill = money actually moved
 * (confirmed / reopened), a pulsing dot = a send in flight (queued), and
 * dismissed reads muted with a strike, since it is no longer live.
 */
const CONFIG: Record<ClaimStatus, { label: string; className: string; dot?: boolean }> = {
  detected: { label: "Found", className: "bg-ink/5 text-ink/70 border border-transparent" },
  drafted: { label: "Draft ready", className: "bg-harbor/10 text-harbor border border-transparent" },
  queued: { label: "Sending…", className: "bg-gold/10 text-gold border border-transparent", dot: true },
  sent: { label: "Asked", className: "bg-harbor text-paper border border-transparent" },
  packet: { label: "Sent via merchant", className: "bg-teal/10 text-teal border border-transparent" },
  promised: { label: "Promised", className: "bg-gold/10 text-gold border border-dashed border-gold/50" },
  confirmed: { label: "Back on card", className: "bg-moss text-paper border border-transparent" },
  reopened: { label: "Charged again", className: "bg-rust text-paper border border-transparent" },
  dismissed: { label: "Dismissed", className: "bg-ink/5 text-ink/35 border border-transparent line-through" },
};

export function StatusPill({ status, className = "" }: { status: ClaimStatus; className?: string }) {
  const config = CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${config.className} ${className}`}
    >
      {config.dot && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden="true" />}
      {config.label}
    </span>
  );
}
