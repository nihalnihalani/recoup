import { useAction } from "convex/react";
import { useId, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { ErrorBox } from "../States";
import { errorText, inputClass, primaryButtonClass, useOnline } from "../../lib/ui";

/**
 * Paste an email (moved here from Settings, M24): the same pipeline a forwarded email goes through
 * (`intake.paste`; the text's hash dedupes a second paste). The result lands on the board for review; nothing is
 * confirmed until the user confirms it.
 */
export function PastePanel() {
  const paste = useAction(api.intake.paste);
  const online = useOnline();
  const fieldId = useId();
  const hintId = useId();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      await paste({ text });
      setText("");
      setResult("Added. Recoup is reading it now; it will appear on the board for you to review and confirm.");
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <label htmlFor={fieldId} className="block text-sm font-medium text-gray-900">
        Email text
      </label>
      <textarea
        id={fieldId}
        aria-describedby={hintId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={8}
        placeholder="Paste an order confirmation, refund or delay email here…"
        className={`${inputClass} block resize-y`}
      />
      <p id={hintId} className="text-xs text-gray-600">
        Card numbers in the text are masked before anything is stored.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !online || text.trim().length === 0}
          className={primaryButtonClass}
        >
          {busy ? "Reading…" : "Add from this email"}
        </button>
        {!online && <p className="text-sm text-gray-700">You're offline. Paste again when you're back online.</p>}
        {result && (
          <p role="status" className="flex min-w-0 flex-1 items-start gap-2 text-sm font-medium text-green-700">
            <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-green-500" />
            {result}
          </p>
        )}
      </div>
      {error && <ErrorBox error={error} />}
    </div>
  );
}
