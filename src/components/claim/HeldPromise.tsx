import { useId, useRef, useState } from "react";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { fmt } from "../../lib/money";
import { errorText, secondaryButtonClass, when } from "../../lib/ui";

/**
 * A promise Recoup is holding (D21/D178, M28): a reply said the company will pay, but it came from an address other
 * than the one Recoup wrote to, and the mail provider gives no sender-authentication verdict, so it could be spoofed.
 * It writes nothing — no ledger event, no status, no tile — until the owner confirms it once
 * (`replies.confirmHeldPromise`). The stated amount is words, never a money figure; confirming records a PROMISE,
 * which is still not money back.
 */
export function HeldPromise({
  reply,
  currency,
  claimStatus,
  onConfirm,
}: {
  reply: Doc<"replies">;
  currency: string;
  /**
   * F3 fix: `replies.recordPromise` (convex/replies.ts) skips the ledger write and the status change entirely for a
   * dismissed claim (D53: a dismissed claim is terminal) -- nothing else about `ledgerWritten:false` changes on any
   * other status. So confirming on a dismissed claim must not offer, or claim, a result.
   */
  claimStatus: Doc<"claims">["status"];
  onConfirm: (replyId: Id<"replies">) => Promise<{ ledgerWritten: boolean }>;
}) {
  const headingId = useId();
  // One confirmation, even for a double tap that lands before React re-renders the disabled button.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stated = reply.promisedCents !== undefined ? fmt(reply.promisedCents, currency) : null;

  async function confirm() {
    if (inFlight.current || done !== null) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      const result = await onConfirm(reply._id);
      setDone(
        result.ledgerWritten && stated
          ? `Recorded as a promise of ${stated}. It counts as money back only when you confirm it landed.`
          : "Recorded as a promise. It counts as money back only when you confirm it landed.",
      );
    } catch (caught) {
      setError(errorText(caught));
      inFlight.current = false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-2 rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-sm">
      <h2 id={headingId} className="font-semibold text-gray-900">
        Held: we can't verify the sender
      </h2>
      <p className="text-gray-900">
        A reply received {when(reply.receivedAt)}{" "}
        {reply.classification === "credit_issued"
          ? `says a credit${stated ? ` of ${stated}` : ""} was issued`
          : `says you were promised ${stated ?? "a credit"}`}
        , but it came from <span className="break-all font-medium">{reply.from}</span>, not the address Recoup wrote to.
        It could be spoofed, so it is not counted anywhere until you confirm it is genuine.
      </p>
      {reply.summary && <p className="text-gray-700">What it says: {reply.summary}</p>}
      {done ? (
        <p role="status" className="text-gray-900">
          {done}
        </p>
      ) : claimStatus === "dismissed" ? (
        <p className="text-gray-700">This claim is dismissed, so confirming it would record nothing.</p>
      ) : (
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void confirm()}>
          {busy ? "Recording…" : "It's genuine: record the promise"}
        </button>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
