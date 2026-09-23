export type ClaimStatus =
  | "detected"
  | "drafted"
  | "queued"
  | "sent"
  | "packet"
  | "promised"
  | "confirmed"
  | "reopened"
  | "dismissed"
  /** Wave 2 (M20, §5): the counterparty refused and the user recorded it. */
  | "denied";

/**
 * A claim status as a coloured dot in a bordered chip; the label stays in ink.
 * The finish carries meaning too: a dashed edge = not yet real money (promised),
 * a pulsing dot = a send in flight (queued), a hollow dot = nothing asked yet, and
 * dismissed reads muted with a strike, since it is no longer live. A queued send whose
 * outcome could not be confirmed (`sendUnknown`, P02-OW-4) is "Delivery unknown" with a
 * still dot: it never pulses forever as if it were still on its way.
 */
const CONFIG: Record<ClaimStatus, { label: string; dot: string; chip?: string; pulse?: boolean }> = {
  detected: { label: "Found", dot: "border border-gray-400 bg-white" },
  drafted: { label: "Draft ready", dot: "bg-gray-400" },
  queued: { label: "Sending…", dot: "bg-gold", pulse: true },
  sent: { label: "Asked", dot: "bg-teal" },
  // M20: `packet` means the user recorded filing it themselves; Recoup sent nothing.
  packet: { label: "Filed by you", dot: "bg-teal" },
  promised: { label: "Promised", dot: "bg-gold", chip: "border-dashed border-gold/70" },
  confirmed: { label: "Back on card", dot: "bg-moss" },
  reopened: { label: "Charged again", dot: "bg-rust" },
  dismissed: { label: "Dismissed", dot: "bg-gray-300", chip: "border-gray-200 text-gray-400 line-through" },
  denied: { label: "Denied", dot: "bg-rust" },
};

const DELIVERY_UNKNOWN = { label: "Delivery unknown", dot: "bg-gray-400", chip: "border-dashed border-gray-300" };

export function StatusPill({
  status,
  sendUnknown = false,
  className = "",
}: {
  status: ClaimStatus;
  /** The send's outcome could not be confirmed; only meaningful while the claim is still `queued`. */
  sendUnknown?: boolean;
  className?: string;
}) {
  const config: { label: string; dot: string; chip?: string; pulse?: boolean } =
    status === "queued" && sendUnknown ? DELIVERY_UNKNOWN : CONFIG[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border bg-white px-2 py-0.5 text-xs font-medium ${
        config.chip ?? "border-gray-200"
      } ${status === "dismissed" ? "" : "text-gray-900"} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${config.dot} ${config.pulse ? "animate-pulse motion-reduce:animate-none" : ""}`}
      />
      {config.label}
    </span>
  );
}
