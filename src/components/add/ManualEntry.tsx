import { useId, useState } from "react";
import { ManualPurchaseForm } from "./ManualPurchaseForm";
import { ManualTransactionForm } from "./ManualTransactionForm";

type Kind = "retail" | "air_travel" | "card_charge";

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: "retail", label: "Store purchase" },
  { value: "air_travel", label: "Flight" },
  { value: "card_charge", label: "Card charge" },
];

/** Manual entry by category (contract §9 "/add … manual entry by category"). What you type is your own entry. */
export function ManualEntry() {
  const name = useId();
  const [kind, setKind] = useState<Kind>("retail");
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-gray-900">What are you adding?</legend>
        <div className="flex flex-wrap gap-2">
          {KINDS.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 has-[:checked]:border-gray-900 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-violet-500"
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
                className="size-4 accent-gray-900"
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>
      {kind === "retail" ? <ManualPurchaseForm /> : <ManualTransactionForm key={kind} category={kind} />}
    </div>
  );
}
