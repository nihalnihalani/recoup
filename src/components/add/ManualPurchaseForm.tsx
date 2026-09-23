import { useMutation } from "convex/react";
import { useId, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import { currencyExponent, parseHundredths } from "../../lib/money";
import { errorText, fromDateInput, inputClass, labelClass, primaryButtonClass, secondaryButtonClass, todayInput, useOnline } from "../../lib/ui";
import { ErrorBox } from "../States";

type ItemRow = { key: number; name: string; price: string; qty: string; productUrl: string };

let nextKey = 1;
const blankItem = (): ItemRow => ({ key: nextKey++, name: "", price: "", qty: "1", productUrl: "" });

/**
 * A purchase entered by hand (M24 manual entry, retail): `purchases.create`, active, with the date, currency and
 * item prices the user typed (their own entry, so nothing is a candidate). Prices are parsed without floats; the
 * date is never a future instant (QA-M16-4). Recoup then reads the store's policy and watches the product pages.
 */
export function ManualPurchaseForm() {
  const create = useMutation(api.purchases.create);
  const navigate = useNavigate();
  const online = useOnline();
  const ids = { merchant: useId(), domain: useId(), date: useId(), currency: useId(), order: useId() };
  const [merchant, setMerchant] = useState("");
  const [domain, setDomain] = useState("");
  const [date, setDate] = useState(() => todayInput());
  const [currency, setCurrency] = useState("USD");
  const [orderRef, setOrderRef] = useState("");
  const [items, setItems] = useState<ItemRow[]>(() => [blankItem()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (key: number, change: Partial<ItemRow>) =>
    setItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (merchant.trim() === "" || domain.trim() === "") return setError("Enter the store's name and website.");
    const now = Date.now();
    if (date > todayInput(now)) return setError("The purchase date can't be in the future.");
    const purchasedAt = fromDateInput(date, { now });
    if (purchasedAt === null) return setError("Enter the purchase date.");
    const code = currency.trim().toUpperCase();
    if (currencyExponent(code) === null) return setError("Enter the 3-letter code of the currency you paid in, like USD.");
    const parsed = [];
    for (const [index, row] of items.entries()) {
      const label = row.name.trim() || `item ${index + 1}`;
      if (row.name.trim() === "") return setError(`Name item ${index + 1}.`);
      const unitCents = parseHundredths(row.price);
      if (unitCents === null || unitCents === 0) return setError(`Enter the unit price of ${label} as a number like 19.99.`);
      const qty = Number(row.qty);
      if (!Number.isSafeInteger(qty) || qty < 1) return setError(`Enter a whole quantity of 1 or more for ${label}.`);
      parsed.push({ name: row.name.trim(), unitCents, qty, ...(row.productUrl.trim() ? { productUrl: row.productUrl.trim() } : {}) });
    }
    setBusy(true);
    try {
      const purchaseId = await create({
        merchant: merchant.trim(),
        merchantDomain: domain.trim(),
        purchasedAt,
        currency: code,
        items: parsed,
        status: "active",
        ...(orderRef.trim() ? { orderRef: orderRef.trim() } : {}),
      });
      navigate(`/purchases/${purchaseId}`);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={ids.merchant} className={labelClass}>Store</label>
          <input id={ids.merchant} className={inputClass} value={merchant} onChange={(e) => setMerchant(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label htmlFor={ids.domain} className={labelClass}>Store website</label>
          <input id={ids.domain} className={inputClass} value={domain} placeholder="example.com" onChange={(e) => setDomain(e.target.value)} autoComplete="off" />
        </div>
        <div>
          <label htmlFor={ids.date} className={labelClass}>Purchase date</label>
          <input id={ids.date} type="date" max={todayInput()} className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor={ids.currency} className={labelClass}>Currency</label>
          <input id={ids.currency} className={`${inputClass} uppercase`} maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} autoComplete="off" />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={ids.order} className={labelClass}>Order number <span className="font-normal text-gray-600">(optional)</span></label>
          <input id={ids.order} className={inputClass} value={orderRef} onChange={(e) => setOrderRef(e.target.value)} autoComplete="off" />
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-gray-900">Items</legend>
        {items.map((row, index) => (
          <div key={row.key} className="grid gap-2 rounded-xl border border-gray-200 p-3 sm:grid-cols-[minmax(0,2fr)_7rem_5rem]">
            <div className="min-w-0">
              <label htmlFor={`item-${row.key}-name`} className="mb-1 block text-xs font-medium text-gray-700">Item {index + 1} name</label>
              <input id={`item-${row.key}-name`} className={inputClass} value={row.name} onChange={(e) => patch(row.key, { name: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`item-${row.key}-price`} className="mb-1 block text-xs font-medium text-gray-700">Unit price</label>
              <input id={`item-${row.key}-price`} inputMode="decimal" className={`${inputClass} tabular-nums`} value={row.price} placeholder="0.00" onChange={(e) => patch(row.key, { price: e.target.value })} />
            </div>
            <div>
              <label htmlFor={`item-${row.key}-qty`} className="mb-1 block text-xs font-medium text-gray-700">Qty</label>
              <input id={`item-${row.key}-qty`} inputMode="numeric" className={`${inputClass} tabular-nums`} value={row.qty} onChange={(e) => patch(row.key, { qty: e.target.value })} />
            </div>
            <div className="min-w-0 sm:col-span-3">
              <label htmlFor={`item-${row.key}-url`} className="mb-1 block text-xs font-medium text-gray-700">Product page <span className="font-normal text-gray-600">(optional, lets Recoup watch the price)</span></label>
              <input id={`item-${row.key}-url`} className={inputClass} value={row.productUrl} placeholder="https://…" onChange={(e) => patch(row.key, { productUrl: e.target.value })} />
            </div>
            {items.length > 1 && (
              <div className="sm:col-span-3">
                <button type="button" className="text-sm font-medium text-gray-700 underline underline-offset-4 hover:text-gray-900" onClick={() => setItems((rows) => rows.filter((r) => r.key !== row.key))}>
                  Remove item {index + 1}
                </button>
              </div>
            )}
          </div>
        ))}
        <button type="button" className={secondaryButtonClass} onClick={() => setItems((rows) => [...rows, blankItem()])}>
          Add another item
        </button>
      </fieldset>

      {error && <ErrorBox error={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !online} className={primaryButtonClass}>
          {busy ? "Saving…" : "Add purchase"}
        </button>
        {!online && <p className="text-sm text-gray-700">You're offline. Save when you're back online.</p>}
      </div>
    </form>
  );
}
