import { useId, useState } from "react";
import { ErrorBox } from "../States";
import { dollarsToCents, errorText, inputClass, labelClass, primaryButtonClass } from "../../lib/ui";
import { ClaimIcon } from "./icons";

/**
 * One collapsed money action: a disclosure that opens into a single-row form.
 * A fresh idempotency key is minted per submission (D24), never per render.
 */
export function MoneyForm({
  title,
  submitLabel,
  tone,
  currency,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  tone: "credit" | "debit";
  currency: string;
  onSubmit: (cents: number, evidence: string, idempotencyKey: string) => Promise<unknown>;
}) {
  const amountId = useId();
  const noteId = useId();
  const [amount, setAmount] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit() {
    setError(null);
    const cents = dollarsToCents(amount);
    if (cents === null || cents === 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(cents, evidence.trim(), crypto.randomUUID());
      setAmount("");
      setEvidence("");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const credit = tone === "credit";
  const sign = credit ? "+" : "−";

  return (
    <details className="group rounded-xl border border-gray-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl px-3.5 py-3 text-sm font-semibold text-gray-900 marker:hidden hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 [&::-webkit-details-marker]:hidden">
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
            credit ? "bg-green-500/10 text-green-700" : "bg-red-500/10 text-red-700"
          }`}
        >
          <ClaimIcon glyph={credit ? "card" : "repeat"} className="size-4" />
        </span>
        <span className="flex-1">{title}</span>
        <ClaimIcon
          glyph="plus"
          className="size-4 text-gray-400 transition-transform group-open:rotate-45 motion-reduce:transition-none"
        />
      </summary>
      <form
        className="space-y-3 border-t border-dashed border-gray-200 p-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <div>
            <label htmlFor={amountId} className={labelClass}>
              Amount ({currency})
            </label>
            <div className="relative">
              <span
                className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-sm font-semibold text-gray-400"
                aria-hidden="true"
              >
                {sign}
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
        <div className="flex justify-end">
          <button type="submit" disabled={busy} className={`${primaryButtonClass} w-full sm:w-auto`}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
      </form>
    </details>
  );
}
