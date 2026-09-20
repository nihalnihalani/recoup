import { useId, useState } from "react";
import { ErrorBox } from "../States";
import { dollarsToCents, errorText, primaryButtonClass } from "../../lib/ui";

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

  const mark = tone === "credit" ? "bg-moss" : "bg-rust";
  const sign = tone === "credit" ? "+" : "−";
  const field =
    "rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20";

  return (
    <details className="group rounded-lg border border-line bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-ink marker:hidden focus-visible:outline-2 focus-visible:outline-harbor [&::-webkit-details-marker]:hidden">
        <span className={`size-2 rounded-full ${mark}`} aria-hidden="true" />
        <span className="flex-1">{title}</span>
        <span className="text-lg leading-none text-ink/40 transition group-open:rotate-45" aria-hidden="true">
          +
        </span>
      </summary>
      <form
        className="space-y-3 border-t border-line/60 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={amountId} className="sr-only">
            Amount ({currency})
          </label>
          <div className="flex items-center gap-1">
            <span className="text-sm font-semibold text-ink/50" aria-hidden="true">
              {sign}
            </span>
            <input
              id={amountId}
              inputMode="decimal"
              placeholder="0.00"
              className={`${field} w-24 tabular-nums`}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <span className="text-xs text-ink/40">{currency}</span>
          </div>
          <label htmlFor={noteId} className="sr-only">
            Where you saw it
          </label>
          <input
            id={noteId}
            className={`${field} min-w-0 flex-1`}
            placeholder="Where you saw it"
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
          />
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            {busy ? "Saving…" : submitLabel}
          </button>
        </div>
        {error && <ErrorBox error={error} />}
      </form>
    </details>
  );
}
