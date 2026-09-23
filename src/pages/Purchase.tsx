import { useMutation, useQuery } from "convex/react";
import { useId, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { WindowMeter } from "../components/charts/WindowMeter";
import { ItemTracker, type OpportunityWiring } from "../components/purchase/ItemTracker";
import { CoverageList } from "../components/opportunity/CoverageList";
import { OpportunityCard } from "../components/opportunity/OpportunityCard";
import { RuleCard } from "../components/purchase/RuleCard";
import { UntrackedTable } from "../components/purchase/UntrackedTable";
import { CardHeading, DotChip, ReviewIcon } from "../components/purchase/parts";
import { Empty, Loading } from "../components/States";
import { useCoarseNow } from "../lib/time";
import { currencyExponent, hundredthsToInput, parseHundredths } from "../lib/money";
import {
  cardClass,
  cardTitleClass,
  day,
  errorText,
  fromDateInput,
  inputClass,
  labelClass,
  pageTitleClass,
  primaryButtonClass,
  secondaryButtonClass,
  tableHeadClass,
  toDateInput,
  todayInput,
} from "../lib/ui";

type PurchaseData = FunctionReturnType<typeof api.purchases.get>;
// ---------------------------------------------------------------------------
// Review form (D25: every extracted purchase starts needs_review). The same
// form edits an active purchase (M15, D164/D167): the purchase record is the
// source of truth for merchant, order, date, currency and item facts, so a
// question about one of them is answered here, through `purchases.confirm`.
// ---------------------------------------------------------------------------

/** Codes offered in the currency field's suggestion list; any ISO 4217 code the runtime knows is accepted. */
const COMMON_CURRENCIES = ["USD", "CAD", "EUR", "GBP", "AUD", "JPY", "MXN"] as const;

type ItemDraft = {
  itemId: Id<"items">;
  name: string;
  unitDollars: string;
  qty: string;
  productUrl: string;
};

function ReviewForm({ data, onDone }: { data: PurchaseData; onDone?: () => void }) {
  const confirm = useMutation(api.purchases.confirm);
  const editing = data.purchase.status !== "needs_review";
  const currencyHintId = useId();
  // Any claim on the purchase was opened (and possibly paid) in its currency; the server refuses a change then.
  const currencyLocked = data.items.some((item) => item.claims.length > 0);
  const [currency, setCurrency] = useState(data.purchase.currency);
  const [merchant, setMerchant] = useState(data.purchase.merchant);
  const [merchantDomain, setMerchantDomain] = useState(data.purchase.merchantDomain);
  const [orderRef, setOrderRef] = useState(data.purchase.orderRef ?? "");
  const storedPurchasedAt = data.purchase.purchasedAt;
  // The day as first shown. If the user leaves it alone, the stored instant is sent back unchanged (never later
  // than now), so re-saving a purchase never moves its window start (QA-M16-4).
  const [initialDate] = useState(() => toDateInput(storedPurchasedAt ?? Date.now()));
  const [purchasedAt, setPurchasedAt] = useState(initialDate);
  const [items, setItems] = useState<ItemDraft[]>(() =>
    data.items.map((item) => ({
      itemId: item._id,
      name: item.name,
      unitDollars: hundredthsToInput(item.unitCents),
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
    const now = Date.now();
    if (purchasedAt > todayInput(now)) {
      setError("The purchase date can't be in the future.");
      return;
    }
    const at =
      purchasedAt === initialDate && storedPurchasedAt !== undefined
        ? Math.min(storedPurchasedAt, now)
        : fromDateInput(purchasedAt, { now });
    if (at === null) {
      setError("Enter the purchase date.");
      return;
    }
    const code = currency.trim().toUpperCase();
    if (currencyExponent(code) === null) {
      setError("Enter the 3-letter code of the currency you paid in, like USD.");
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
      const unitCents = parseHundredths(item.unitDollars);
      const qty = Number(item.qty);
      if (unitCents === null) {
        setError(`Enter the unit price for "${item.name || "item"}" as a number like 19.99.`);
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
        // D164: always explicit. Confirming the form is the user's confirmation of the currency (DA-A-33).
        currency: code,
        items: parsed,
      });
      onDone?.();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  const cellInput = `${inputClass} min-w-0`;

  return (
    <section aria-label={editing ? "Edit this purchase" : "Review this purchase"} className={`${cardClass} col-span-full overflow-hidden`}>
      <div className="px-5 pt-5">
        <CardHeading
          icon={<ReviewIcon />}
          title={editing ? "Edit the details" : "Check the details"}
          hint={
            editing
              ? "Recoup's checks use these details. Correct anything that is wrong, then save."
              : "Read from the order email. Fix anything wrong, then confirm."
          }
        />
      </div>

      <div className="mx-5 mt-4 grid gap-4 border-t border-dashed border-gray-200 py-5 sm:grid-cols-2">
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
            max={todayInput()}
            className={inputClass}
            value={purchasedAt}
            onChange={(event) => setPurchasedAt(event.target.value)}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="currency">
            Currency
          </label>
          <input
            id="currency"
            className={`${inputClass} uppercase disabled:bg-gray-50 disabled:text-gray-500`}
            value={currency}
            maxLength={3}
            autoComplete="off"
            spellCheck={false}
            list="currency-codes"
            disabled={currencyLocked}
            aria-describedby={currencyHintId}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
          <datalist id="currency-codes">
            {COMMON_CURRENCIES.map((code) => (
              <option key={code} value={code} />
            ))}
          </datalist>
          <p id={currencyHintId} className="mt-1.5 text-xs text-gray-600">
            {currencyLocked
              ? "A claim already uses this currency, so it cannot change."
              : editing
                ? "The currency you paid in. Recoup never converts currencies."
                : `Read from the order email as ${data.purchase.currency}. Confirming the purchase confirms this currency, so change it if you paid in another.`}
          </p>
        </div>
      </div>

      <div className="border-t border-gray-200 px-5 py-5">
        <h3 className={cardTitleClass}>Items</h3>
        {items.length === 0 ? (
          <p className="mt-2 text-sm text-gray-500">No items were extracted.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full min-w-[40rem] table-auto text-sm">
              <thead className={tableHeadClass}>
                <tr>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Item
                  </th>
                  <th scope="col" className="w-28 px-3 py-2.5 text-left font-medium">
                    Unit price
                  </th>
                  <th scope="col" className="w-20 px-3 py-2.5 text-left font-medium">
                    Qty
                  </th>
                  <th scope="col" className="px-3 py-2.5 text-left font-medium">
                    Product page
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
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

      <footer className="flex flex-wrap items-center justify-end gap-3 border-t border-gray-200 px-5 py-4">
        {error && (
          <p role="alert" className="mr-auto text-sm text-red-700">
            {error}
          </p>
        )}
        {editing && onDone && (
          <button type="button" onClick={onDone} disabled={busy} className={secondaryButtonClass}>
            Cancel
          </button>
        )}
        <button type="button" onClick={() => void handleSubmit()} disabled={busy} className={primaryButtonClass}>
          {editing ? (busy ? "Saving…" : "Save changes") : busy ? "Confirming…" : "Confirm purchase"}
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
        <p role="alert" className="max-w-xs text-right text-xs text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export default function Purchase() {
  const { id } = useParams();
  const purchaseId = id as Id<"purchases"> | undefined;
  // Called unconditionally, above the early returns below, so hook order
  // stays valid across renders (D103/D107 C4): a coarse, display-only clock
  // (src/lib/time.ts) so the verdict's staleness math is real rather than
  // frozen at the query's first subscribe.
  const now = useCoarseNow();
  const data = useQuery(api.purchases.get, purchaseId ? { purchaseId, now } : "skip");
  // `?edit=details` opens the details form on an active purchase: the edit path a question about a
  // purchase-record fact links to (`answerVia: "purchases.confirm"`, D167). A plain URL, so it survives a refresh.
  const [searchParams, setSearchParams] = useSearchParams();
  const editRequested = searchParams.get("edit") === "details";
  // M12: recovery paths for this purchase's transaction (active packs only) and the paths not checked.
  const recovery = useQuery(api.opportunities.forPurchase, purchaseId ? { purchaseId } : "skip");
  const transactionId = recovery?.opportunities[0]?.opportunity.transactionId;
  const hasQuestions = recovery?.opportunities.some((view) => (view.evaluation?.missingFacts.length ?? 0) > 0) ?? false;
  const cells = useQuery(api.facts.list, transactionId !== undefined && hasQuestions ? { transactionId } : "skip");
  const openCase = useMutation(api.opportunities.openCase);
  const reevaluate = useMutation(api.opportunities.reevaluate);
  const answerFact = useMutation(api.facts.answer);

  if (!purchaseId) return <Empty title="No purchase selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { purchase, items, policies } = data;
  const currency = purchase.currency;
  const needsReview = purchase.status === "needs_review";
  const editing = !needsReview && editRequested;
  const stopEditing = () =>
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("edit");
        return next;
      },
      { replace: true },
    );

  // `get` returns the latest snapshot per kind; this page is price-only.
  const rule = policies.find((candidate) => candidate.kind === "price_adjustment");
  const windowEndsAt =
    purchase.purchasedAt !== undefined && rule?.windowDays !== undefined
      ? purchase.purchasedAt + rule.windowDays * DAY_MS
      : undefined;

  const tracked = items.filter((item) => item.productUrl);
  const untracked = items.filter((item) => !item.productUrl);

  const views = recovery?.opportunities ?? [];
  const wiring: OpportunityWiring = {
    all: views,
    cells,
    // D167: purchase-record facts are corrected on this page's details form.
    purchaseEditHref: "?edit=details",
    counterparty: purchase.merchant || purchase.merchantDomain || undefined,
    openCase: (opportunityId) => openCase({ opportunityId }),
    checkAgain: async () => {
      await reevaluate({ purchaseId: purchase._id });
    },
    answer: async ({ subjectKey, key, value }) => {
      if (transactionId === undefined) return;
      await answerFact({ transactionId, subjectKey, key, value });
    },
  };
  const itemViews = (itemId: string) => views.filter((view) => view.opportunity.subjectKey === `item:${itemId}`);
  const otherViews = views.filter(
    (view) => !items.some((item) => view.opportunity.subjectKey === `item:${item._id}` && item.productUrl),
  );

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
          <Link
            to="/"
            className="rounded text-sm font-medium text-gray-500 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
          >
            Back to the board
          </Link>
          <h1 className={`mt-1 truncate ${pageTitleClass}`}>
            {purchase.merchant || purchase.merchantDomain || "Purchase"}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-500">
            {purchase.orderRef && <span>Order {purchase.orderRef}</span>}
            <span>Bought {day(purchase.purchasedAt)}</span>
            {needsReview && (
              <DotChip dot="bg-gold">Needs your review</DotChip>
            )}
          </p>
        </div>
        {!needsReview && (
          <div className="flex flex-wrap items-center gap-4 sm:justify-end">
            <div className="w-full min-w-0 sm:w-56">
              <WindowMeter purchasedAt={purchase.purchasedAt} endsAt={windowEndsAt} />
            </div>
            {!editing && (
              <Link to="?edit=details" className={secondaryButtonClass}>
                Edit details
              </Link>
            )}
            {tracked.length > 1 && <CheckAllButton itemIds={tracked.map((item) => item._id)} />}
          </div>
        )}
      </div>

      <div className="grid grid-cols-12 gap-6">
        {needsReview ? (
          <ReviewForm data={data} />
        ) : editing ? (
          <ReviewForm data={data} onDone={stopEditing} />
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
                opportunities={itemViews(item._id)}
                wiring={wiring}
              />
            ))}
            {untracked.length > 0 && <UntrackedTable items={untracked} currency={currency} />}
            {tracked.length === 0 && <div className="col-span-full xl:col-span-6">{ruleCard}</div>}
            {otherViews.length > 0 && (
              <div className="col-span-full grid gap-6 lg:grid-cols-2">
                {otherViews.map((view) => (
                  <OpportunityCard
                    key={view.opportunity._id}
                    view={view}
                    related={views}
                    cells={cells}
                    purchaseEditHref={wiring.purchaseEditHref}
                    counterparty={wiring.counterparty}
                    onOpenCase={() => openCase({ opportunityId: view.opportunity._id })}
                    onCheckAgain={wiring.checkAgain}
                    onAnswer={wiring.answer}
                  />
                ))}
              </div>
            )}
            {recovery !== undefined && recovery.pathsNotChecked.length > 0 && (
              <div className="col-span-full">
                <CoverageList rows={recovery.pathsNotChecked} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
