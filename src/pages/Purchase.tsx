import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { WindowMeter } from "../components/charts/WindowMeter";
import { ItemTracker } from "../components/purchase/ItemTracker";
import { RuleCard } from "../components/purchase/RuleCard";
import { UntrackedTable } from "../components/purchase/UntrackedTable";
import { Empty, Loading } from "../components/States";
import {
  centsToDollars,
  day,
  dollarsToCents,
  errorText,
  fromDateInput,
  inputClass,
  labelClass,
  primaryButtonClass,
  toDateInput,
} from "../lib/ui";

type PurchaseData = FunctionReturnType<typeof api.purchases.get>;
// ---------------------------------------------------------------------------
// Review form (D25: every extracted purchase starts needs_review)
// ---------------------------------------------------------------------------

type ItemDraft = {
  itemId: Id<"items">;
  name: string;
  unitDollars: string;
  qty: string;
  productUrl: string;
};

function ReviewForm({ data }: { data: PurchaseData }) {
  const confirm = useMutation(api.purchases.confirm);
  const [merchant, setMerchant] = useState(data.purchase.merchant);
  const [merchantDomain, setMerchantDomain] = useState(data.purchase.merchantDomain);
  const [orderRef, setOrderRef] = useState(data.purchase.orderRef ?? "");
  const [purchasedAt, setPurchasedAt] = useState(() =>
    toDateInput(data.purchase.purchasedAt ?? Date.now()),
  );
  const [items, setItems] = useState<ItemDraft[]>(() =>
    data.items.map((item) => ({
      itemId: item._id,
      name: item.name,
      unitDollars: centsToDollars(item.unitCents),
      qty: String(item.qty),
      productUrl: item.productUrl ?? "",
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function patchItem(index: number, patch: Partial<ItemDraft>) {
    setItems((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  }

  async function handleSubmit() {
    setError(null);
    const at = fromDateInput(purchasedAt);
    if (at === null) {
      setError("Enter the purchase date.");
      return;
    }
    const parsed: {
      itemId: Id<"items">;
      name: string;
      unitCents: number;
      qty: number;
      productUrl?: string;
    }[] = [];
    for (const item of items) {
      const unitCents = dollarsToCents(item.unitDollars);
      const qty = Number(item.qty);
      if (unitCents === null) {
        setError(`Enter a valid unit price for "${item.name || "item"}".`);
        return;
      }
      if (!Number.isSafeInteger(qty) || qty < 1) {
        setError(`Enter a whole quantity of 1 or more for "${item.name || "item"}".`);
        return;
      }
      parsed.push({
        itemId: item.itemId,
        name: item.name.trim(),
        unitCents,
        qty,
        productUrl: item.productUrl.trim() === "" ? undefined : item.productUrl.trim(),
      });
    }

    setBusy(true);
    try {
      await confirm({
        purchaseId: data.purchase._id,
        merchant: merchant.trim(),
        merchantDomain: merchantDomain.trim(),
        orderRef: orderRef.trim() === "" ? undefined : orderRef.trim(),
        purchasedAt: at,
        items: parsed,
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const cellInput = `${inputClass} min-w-0`;

  return (
    <section aria-label="Review this purchase" className="col-span-full rounded-xl bg-white shadow-xs">
      <header className="border-b border-gray-100 px-5 py-4">
        <h2 className="font-semibold text-gray-800">Check the details</h2>
        <p className="mt-0.5 text-sm text-gray-500">Read from the order email. Fix anything wrong, then confirm.</p>
      </header>

      <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="merchant">
            Merchant
          </label>
          <input
            id="merchant"
            className={inputClass}
            value={merchant}
            onChange={(event) => setMerchant(event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="merchantDomain">
            Merchant domain
          </label>
          <input
            id="merchantDomain"
            className={inputClass}
            value={merchantDomain}
            onChange={(event) => setMerchantDomain(event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="orderRef">
            Order reference
          </label>
          <input
            id="orderRef"
            className={inputClass}
            value={orderRef}
            onChange={(event) => setOrderRef(event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="purchasedAt">
            Purchase date
          </label>
          <input
            id="purchasedAt"
            type="date"
            className={inputClass}
            value={purchasedAt}
            onChange={(event) => setPurchasedAt(event.target.value)}
          />
        </div>
      </div>

      <div className="border-t border-gray-100 px-5 py-4">
        <h3 className="font-semibold text-gray-800">Items</h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No items were extracted.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[40rem] table-auto text-sm">
              <thead className="bg-gray-50 text-xs font-semibold uppercase text-gray-400">
                <tr>
                  <th scope="col" className="p-2 text-left">
                    Item
                  </th>
                  <th scope="col" className="w-28 p-2 text-left">
                    Unit price
                  </th>
                  <th scope="col" className="w-20 p-2 text-left">
                    Qty
                  </th>
                  <th scope="col" className="p-2 text-left">
                    Product page
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item, index) => (
                  <tr key={item.itemId}>
                    <td className="p-2">
                      <input
                        aria-label={`Item ${index + 1} name`}
                        className={cellInput}
                        value={item.name}
                        onChange={(event) => patchItem(index, { name: event.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        aria-label={`Item ${index + 1} unit price`}
                        inputMode="decimal"
                        className={cellInput}
                        value={item.unitDollars}
                        onChange={(event) => patchItem(index, { unitDollars: event.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        aria-label={`Item ${index + 1} quantity`}
                        inputMode="numeric"
                        className={cellInput}
                        value={item.qty}
                        onChange={(event) => patchItem(index, { qty: event.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        aria-label={`Item ${index + 1} product page URL`}
                        className={cellInput}
                        placeholder="https://…"
                        value={item.productUrl}
                        onChange={(event) => patchItem(index, { productUrl: event.target.value })}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-gray-100 px-5 py-4">
        {error && (
          <p role="alert" className="mr-auto text-sm text-rust">
            {error}
          </p>
        )}
        <button type="button" onClick={() => void handleSubmit()} disabled={busy} className={primaryButtonClass}>
          {busy ? "Confirming…" : "Confirm purchase"}
        </button>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Asks for a fresh check on every tracked item; failures (cooldowns) are summed up inline. */
function CheckAllButton({ itemIds }: { itemIds: Id<"items">[] }) {
  const checkNow = useMutation(api.priceWatch.checkNow);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setError(null);
    setBusy(true);
    const results = await Promise.allSettled(itemIds.map((itemId) => checkNow({ itemId })));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      setError(`${failures.length} of ${itemIds.length} not checked: ${errorText(failures[0].reason)}`);
    }
    setBusy(false);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" disabled={busy} onClick={() => void handleClick()} className={primaryButtonClass}>
        {busy ? "Checking…" : "Check all prices"}
      </button>
      {error && (
        <p role="alert" className="max-w-xs text-right text-xs text-rust">
          {error}
        </p>
      )}
    </div>
  );
}

export default function Purchase() {
  const { id } = useParams();
  const purchaseId = id as Id<"purchases"> | undefined;
  const data = useQuery(api.purchases.get, purchaseId ? { purchaseId } : "skip");

  if (!purchaseId) return <Empty title="No purchase selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { purchase, items, policies } = data;
  const currency = purchase.currency;
  const needsReview = purchase.status === "needs_review";

  // `get` returns the latest snapshot per kind; this page is price-only.
  const rule = policies.find((candidate) => candidate.kind === "price_adjustment");
  const windowEndsAt =
    purchase.purchasedAt !== undefined && rule?.windowDays !== undefined
      ? purchase.purchasedAt + rule.windowDays * DAY_MS
      : undefined;

  const tracked = items.filter((item) => item.productUrl);
  const untracked = items.filter((item) => !item.productUrl);

  const ruleCard = (
    <RuleCard
      // A refresh inserts a NEW snapshot (D17), so remount to pick up its
      // values rather than keeping the old row's edits.
      key={rule?._id ?? "none"}
      policy={rule}
      merchantDomain={purchase.merchantDomain}
    />
  );

  return (
    <div>
      <div className="mb-8 sm:flex sm:items-center sm:justify-between sm:gap-6">
        <div className="mb-4 min-w-0 sm:mb-0">
          <Link to="/" className="text-sm font-medium text-gray-500 hover:text-gray-800">
            Back to the board
          </Link>
          <h1 className="mt-1 truncate text-2xl font-bold text-gray-800 md:text-3xl">
            {purchase.merchant || purchase.merchantDomain || "Purchase"}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
            {purchase.orderRef && <span>Order {purchase.orderRef}</span>}
            <span>Bought {day(purchase.purchasedAt)}</span>
            {needsReview && (
              <span className="rounded-full bg-gold/15 px-2.5 py-1 text-xs font-medium text-gold">Needs your review</span>
            )}
          </p>
        </div>
        {!needsReview && (
          <div className="flex flex-wrap items-center gap-4 sm:justify-end">
            <div className="w-56">
              <WindowMeter purchasedAt={purchase.purchasedAt} endsAt={windowEndsAt} />
            </div>
            {tracked.length > 1 && <CheckAllButton itemIds={tracked.map((item) => item._id)} />}
          </div>
        )}
      </div>

      <div className="grid grid-cols-12 gap-6">
        {needsReview ? (
          <ReviewForm data={data} />
        ) : (
          <>
            {items.length === 0 && <Empty title="No items on this purchase" className="col-span-full" />}
            {tracked.map((item, index) => (
              <ItemTracker
                key={item._id}
                item={item}
                currency={currency}
                purchasedAt={purchase.purchasedAt}
                windowEndsAt={windowEndsAt}
                // The rule belongs to the store, not the item: show it once,
                // beside the first chart.
                aside={index === 0 ? ruleCard : undefined}
              />
            ))}
            {untracked.length > 0 && <UntrackedTable items={untracked} currency={currency} />}
            {tracked.length === 0 && <div className="col-span-full xl:col-span-6">{ruleCard}</div>}
          </>
        )}
      </div>
    </div>
  );
}
