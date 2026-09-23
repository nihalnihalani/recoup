import { useId, useState, type FormEvent } from "react";
import { ErrorBox } from "../States";
import { parseHundredths } from "../../lib/money";
import { inputClass, labelClass, primaryButtonClass, errorText } from "../../lib/ui";
import { ClaimIcon } from "./icons";

/** How the money came back (DA-B-10). Only `cash` is money back; the rest are non-cash remedies (mission §6). */
export type CreditRoute = "cash" | "store_credit" | "points";

export type NonCashCredit = {
  kind: "voucher" | "points";
  description: string;
  /** Face value in the claim's minor units, when the user gave one. Shown per item only, never summed with cash. */
  faceValueMinor?: number;
  idempotencyKey: string;
};

const ROUTES: readonly { value: CreditRoute; label: string; hint: string }[] = [
  { value: "cash", label: "To my card or original payment", hint: "Counts as money back." },
  {
    value: "store_credit",
    label: "Store credit or a gift card",
    hint: "Non-cash. Closes this claim, and is never counted as money back on your card.",
  },
  { value: "points", label: "Points", hint: "Non-cash. Closes this claim, and is never counted as money back on your card." },
];

/**
 * "Credit landed" (DA-B-10): the user first says HOW it came back. To the card or original payment is a confirmed
 * cash credit (`claims.confirmCredit`, the only confirmed-money writer); store credit, a gift card or points resolve
 * the claim with a non-cash remedy (DA-B-16: `claims.recordNonCashResolution`, which closes it for ask) and never
 * reach the ledger, "Back to your card" or the Recovered total. There is no default: the choice is required. A fresh
 * idempotency key per submission (D24).
 */
export function CreditLandedForm({
  currency,
  onCash,
  onNonCash,
}: {
  currency: string;
  onCash: (cents: number, evidence: string, idempotencyKey: string) => Promise<unknown>;
  onNonCash: (credit: NonCashCredit) => Promise<unknown>;
}) {
  const legendId = useId();
  const amountId = useId();
  const noteId = useId();
  const [route, setRoute] = useState<CreditRoute | null>(null);
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cash = route === "cash";
  const amountOptional = route === "points";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(null);
    if (route === null) {
      setError("Choose how it came back.");
      return;
    }
    const trimmed = amount.trim();
    const cents = trimmed.length === 0 ? null : parseHundredths(trimmed);
    if (trimmed.length > 0 && cents === null) {
      setError("Enter the amount as a number like 12.50.");
      return;
    }
    if ((cents === null || cents === 0) && !amountOptional) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      if (cash) {
        await onCash(cents!, evidence.trim(), crypto.randomUUID());
      } else {
        const kind = route === "points" ? "points" : "voucher";
        const words = route === "points" ? "Points" : "Store credit or gift card";
        await onNonCash({
          kind,
          description: evidence.trim() || words,
          ...(cents !== null && cents > 0 ? { faceValueMinor: cents } : {}),
          idempotencyKey: crypto.randomUUID(),
        });
        setDone(
          `Recorded as ${route === "points" ? "points" : "store credit"}. This claim is now closed with a non-cash remedy: it is never counted as money back on your card.`,
        );
      }
      setAmount("");
      setEvidence("");
      setRoute(null);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="group rounded-xl border border-gray-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold text-gray-900 marker:hidden hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 [&::-webkit-details-marker]:hidden">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-green-500/10 text-green-700">
          <ClaimIcon glyph="card" className="size-4" />
        </span>
        <span className="flex-1">Credit landed</span>
        <ClaimIcon
          glyph="plus"
          className="size-4 text-gray-400 transition-transform group-open:rotate-45 motion-reduce:transition-none"
        />
      </summary>
      <form className="space-y-3 border-t border-dashed border-gray-200 p-3.5" onSubmit={(event) => void handleSubmit(event)}>
        <fieldset>
          <legend id={legendId} className={labelClass}>
            How did it come back?
          </legend>
          <div className="space-y-1.5">
            {ROUTES.map((option) => (
              <label key={option.value} className="flex items-start gap-2.5 rounded-lg px-1 py-0.5 text-sm text-gray-900">
                <input
                  type="radio"
                  name={`${legendId}-route`}
                  value={option.value}
                  checked={route === option.value}
                  onChange={() => setRoute(option.value)}
                  className="mt-0.5 size-4 accent-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-xs text-gray-600">{option.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <div>
            <label htmlFor={amountId} className={labelClass}>
              {cash || route === null ? "Amount" : amountOptional ? "Stated value, optional" : "Value"} ({currency})
            </label>
            <div className="relative">
              <span
                className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm font-semibold text-gray-400"
                aria-hidden="true"
              >
                +
              </span>
              <input
                id={amountId}
                inputMode="decimal"
                placeholder="0.00"
                className={`${inputClass} pl-8 tabular-nums`}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor={noteId} className={labelClass}>
              Where you saw it
            </label>
            <input
              id={noteId}
              className={inputClass}
              placeholder="Card statement, store email"
              value={evidence}
              onChange={(event) => setEvidence(event.target.value)}
            />
          </div>
        </div>
        {error && <ErrorBox error={error} />}
        {done && (
          <p role="status" className="text-sm text-gray-700">
            {done}
          </p>
        )}
        <div className="flex justify-end">
          <button type="submit" disabled={busy} className={`${primaryButtonClass} w-full sm:w-auto`}>
            {busy ? "Saving…" : cash || route === null ? "Confirm credit" : route === "points" ? "Record points" : "Record store credit"}
          </button>
        </div>
      </form>
    </details>
  );
}
