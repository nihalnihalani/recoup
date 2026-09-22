import { useRef, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { fmt } from "../../lib/money";
import { errorText, secondaryButtonClass } from "../../lib/ui";

export type ConfirmRefundResult = FunctionReturnType<typeof api.intake.confirmRefundEmail>;
type AttentionRow = FunctionReturnType<typeof api.intake.needsAttention>[number];
/**
 * The held refund's projection on a needs-attention row (M13b): what the email says, validated like `applyRefund`
 * (amounts as the ledger's `cents` unit, a clear currency), display-only and never applied.
 */
export type HeldRefundSummary = NonNullable<AttentionRow["pendingRefund"]>;

/**
 * A refund email Recoup is holding (DA-B-3, SEC-AI-6): the mail provider gives no sender-authentication verdict,
 * so a From header proves nothing and the email could be spoofed. Nothing reaches the ledger or the claims until the
 * user confirms it with one tap (`intake.confirmRefundEmail`). The amount is shown only as what the email PROMISES:
 * confirming records a promise, never money back; money counts as back only when the user confirms it arrived.
 * There is deliberately no "Try again" here: a retry would pay for a new extraction and change nothing.
 */
export function HeldRefund({
  eventId,
  refund,
  onConfirm,
}: {
  eventId: Id<"processedEvents">;
  refund?: HeldRefundSummary;
  onConfirm: (processedEventId: Id<"processedEvents">) => Promise<ConfirmRefundResult>;
}) {
  // One confirmation per row, even for a double tap that lands before React re-renders the disabled button.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (inFlight.current || done !== null) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const result = await onConfirm(eventId);
      setDone(result.summary ?? "Recorded as a promised refund.");
    } catch (caught) {
      setError(errorText(caught));
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  const credits = refund?.credits ?? [];
  const merchant = refund?.merchant ?? null;

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-3 py-2.5 text-sm text-gray-900">
      <p className="font-semibold">We can't verify who sent this email.</p>
      <p className="text-gray-700">
        Nothing has been recorded. If this refund is genuine, confirm it and Recoup records it as a promise
        {merchant ? ` from ${merchant}` : ""}. It counts as money back only once you confirm it reached your card.
      </p>
      {credits.length > 0 ? (
        <ul className="space-y-0.5">
          {credits.map((credit, index) => (
            <li key={index} className="tabular-nums">
              Promised, not received: <span className="font-semibold">{fmt(credit.amountMinor, credit.currency)}</span>
              {credit.itemName ? ` for ${credit.itemName}` : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-gray-700">Recoup could not read a usable refund amount from this email.</p>
      )}
      {done === null ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className={`${secondaryButtonClass} whitespace-nowrap px-3 py-1.5 text-xs`}
        >
          {busy ? "Confirming…" : "Confirm this refund"}
        </button>
      ) : (
        <p role="status" className="text-green-700">
          {done}
        </p>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
