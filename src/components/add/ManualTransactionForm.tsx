import { useMutation } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { parseDecimalToMinor } from "../../../convex/lib/money";
import { errorText, fromDateInput, inputClass, labelClass, primaryButtonClass, todayInput, useOnline } from "../../lib/ui";
import { ErrorBox } from "../States";

export type ManualCategory = "air_travel" | "card_charge";

const COPY: Readonly<Record<ManualCategory, { name: string; namePlaceholder: string; total: string; date: string }>> = {
  air_travel: {
    name: "Airline or travel agency you paid",
    namePlaceholder: "e.g. the airline, or the agency that sold the ticket",
    total: "Total you paid for the ticket",
    date: "Date you paid",
  },
  card_charge: {
    name: "Merchant, as it appears on your statement",
    namePlaceholder: "e.g. ACME*STORE 555-0100",
    total: "Amount charged",
    date: "Date of the charge",
  },
};

/**
 * A flight or a card charge entered by hand (`transactions.createManual`): the facts written are the user's own
 * entry (`user_confirmed`, shown as "your entry"). Money is parsed as a decimal string into minor units
 * (`parseDecimalToMinor`, never floats); only USD is accepted for now (O6), and the server says so. The date goes as
 * the calendar day typed (`transactedOn`, the source of card.charge_date) and as an instant for the transaction row
 * (`transactedAt`, never a future instant).
 */
export function ManualTransactionForm({ category }: { category: ManualCategory }) {
  const create = useMutation(api.transactions.createManual);
  const navigate = useNavigate();
  const online = useOnline();
  const ids = { name: useId(), total: useId(), date: useId(), currency: useId() };
  const [name, setName] = useState("");
  const [total, setTotal] = useState("");
  const [date, setDate] = useState(() => todayInput());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = COPY[category];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (name.trim() === "") return setError("Enter who you paid.");
    let totalMinor: number | undefined;
    if (total.trim() !== "") {
      const parsed = parseDecimalToMinor(total, "USD");
      if (!parsed.ok) {
        return setError(parsed.signMarked ? "Enter the amount without a minus sign or brackets." : "Enter the amount as a number like 480.00.");
      }
      totalMinor = parsed.amountMinor;
    } else if (category === "card_charge") {
      return setError("Enter the amount charged.");
    }
    const now = Date.now();
    if (date !== "" && date > todayInput(now)) return setError("The date can't be in the future.");
    // The typed day as an instant for the transaction row (today → now, an earlier day → noon UTC, never future;
    // QA-M16-4). No air fact holds the ticket date, so without it a flight's date would be lost.
    const transactedAt = date === "" ? null : fromDateInput(date, { now });
    setBusy(true);
    try {
      const transactionId = await create({
        category,
        counterpartyName: name.trim(),
        currency: "USD",
        ...(totalMinor !== undefined ? { totalMinor } : {}),
        ...(date !== "" ? { transactedOn: date } : {}),
        ...(transactedAt !== null ? { transactedAt } : {}),
      });
      navigate(`/transactions/${transactionId}`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor={ids.name} className={labelClass}>{copy.name}</label>
          <input id={ids.name} className={inputClass} value={name} placeholder={copy.namePlaceholder} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label htmlFor={ids.total} className={labelClass}>
            {copy.total} {category === "air_travel" && <span className="font-normal text-gray-600">(optional)</span>}
          </label>
          <input id={ids.total} inputMode="decimal" className={`${inputClass} tabular-nums`} placeholder="0.00" value={total} onChange={(e) => setTotal(e.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.currency} className={labelClass}>Currency</label>
          <input id={ids.currency} className={`${inputClass} bg-gray-50`} value="USD" readOnly aria-describedby={`${ids.currency}-hint`} />
          <p id={`${ids.currency}-hint`} className="mt-1 text-xs text-gray-600">Only US dollars for now.</p>
        </div>
        <div>
          <label htmlFor={ids.date} className={labelClass}>{copy.date}</label>
          <input id={ids.date} type="date" max={todayInput()} className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      {error && <ErrorBox error={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !online} className={primaryButtonClass}>
          {busy ? "Saving…" : category === "air_travel" ? "Add flight" : "Add card charge"}
        </button>
        {!online && <p className="text-sm text-gray-700">You're offline. Save when you're back online.</p>}
      </div>
    </form>
  );
}
