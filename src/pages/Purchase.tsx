import { useAction, useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Money } from "../components/Money";
import { StatusPill } from "../components/StatusPill";
import { Empty, ErrorBox, Loading } from "../components/States";
import {
  centsToDollars,
  day,
  dollarsToCents,
  errorText,
  fromDateInput,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  sectionClass,
  toDateInput,
  when,
} from "../lib/ui";

type PurchaseData = FunctionReturnType<typeof api.purchases.get>;
type ItemWithDetail = PurchaseData["items"][number];

const POLICY_KIND_LABEL = {
  price_adjustment: "Price adjustment policy",
  returns: "Returns policy",
} as const;

const CLAIM_TYPE_LABEL = {
  price_adjustment: "Price drop",
  return_credit: "Return credit",
} as const;

type PolicyChannel = Doc<"policies">["channel"];

const CHANNELS: readonly PolicyChannel[] = ["email", "form", "chat", "phone", "unknown"];

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

  return (
    <section className={`${sectionClass} space-y-4`}>
      <div>
        <h2 className="font-serif text-lg text-ink">Check this before Recoup starts work</h2>
        <p className="mt-1 text-sm text-ink/60">
          Recoup read these details out of the email. Fix anything wrong, then confirm.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
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

      <div className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Items</h3>
        {items.length === 0 && <p className="text-sm text-ink/60">No items were extracted.</p>}
        {items.map((item, index) => (
          <div key={item.itemId} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <label className={labelClass} htmlFor={`name-${item.itemId}`}>
                Item
              </label>
              <input
                id={`name-${item.itemId}`}
                className={inputClass}
                value={item.name}
                onChange={(event) => patchItem(index, { name: event.target.value })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`unit-${item.itemId}`}>
                Unit price
              </label>
              <input
                id={`unit-${item.itemId}`}
                inputMode="decimal"
                className={inputClass}
                value={item.unitDollars}
                onChange={(event) => patchItem(index, { unitDollars: event.target.value })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`qty-${item.itemId}`}>
                Qty
              </label>
              <input
                id={`qty-${item.itemId}`}
                inputMode="numeric"
                className={inputClass}
                value={item.qty}
                onChange={(event) => patchItem(index, { qty: event.target.value })}
              />
            </div>
            <div className="sm:col-span-4">
              <label className={labelClass} htmlFor={`url-${item.itemId}`}>
                Product page URL
              </label>
              <input
                id={`url-${item.itemId}`}
                className={inputClass}
                placeholder="https://…"
                value={item.productUrl}
                onChange={(event) => patchItem(index, { productUrl: event.target.value })}
              />
            </div>
          </div>
        ))}
      </div>

      {error && <ErrorBox error={error} />}

      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={busy}
        className={primaryButtonClass}
      >
        {busy ? "Confirming…" : "Confirm purchase"}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Active item card
// ---------------------------------------------------------------------------

function ItemCard({ item, currency }: { item: ItemWithDetail; currency: string }) {
  const setReturned = useMutation(api.purchases.setReturned);
  const checkNow = useMutation(api.priceWatch.checkNow);
  const openClaim = useMutation(api.claims.open);

  const [returnedAt, setReturnedAt] = useState(() => toDateInput(item.returnedAt ?? Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const latest = item.priceChecks.find((check) => check.observedCents !== undefined);
  const openReturnClaim = item.claims.find(
    (claim) => claim.type === "return_credit" && claim.status !== "dismissed",
  );

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`${sectionClass} space-y-3`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-serif text-lg text-ink">{item.name}</p>
          <p className="mt-0.5 text-xs text-ink/50">
            Paid <Money cents={item.unitCents} currency={currency} /> × {item.qty}
          </p>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wide text-ink/50">Latest seen</p>
          <p className="text-sm text-ink">
            {latest?.observedCents !== undefined ? (
              <Money cents={latest.observedCents} currency={latest.currency ?? currency} />
            ) : (
              "not checked yet"
            )}
          </p>
        </div>
      </div>

      {item.productUrl && (
        <a
          href={item.productUrl}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-xs text-harbor underline-offset-2 hover:underline"
        >
          {item.productUrl}
        </a>
      )}

      {item.priceChecks.length > 0 && (
        <ul className="space-y-1 border-t border-line pt-2 text-xs text-ink/60">
          {item.priceChecks.slice(0, 5).map((check) => (
            <li key={check._id} className="flex justify-between gap-3">
              <span>{when(check.observedAt)}</span>
              <span>
                {check.observedCents !== undefined ? (
                  <Money cents={check.observedCents} currency={check.currency ?? currency} />
                ) : (
                  (check.note ?? "no usable price")
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={item.returned}
            disabled={busy}
            onChange={(event) => {
              const returned = event.target.checked;
              void run(() =>
                setReturned({
                  itemId: item._id,
                  returned,
                  returnedAt: returned ? (fromDateInput(returnedAt) ?? Date.now()) : undefined,
                }),
              );
            }}
          />
          Returned
        </label>
        <div>
          <label className={labelClass} htmlFor={`returnedAt-${item._id}`}>
            Return date
          </label>
          <input
            id={`returnedAt-${item._id}`}
            type="date"
            className={inputClass}
            value={returnedAt}
            onChange={(event) => {
              setReturnedAt(event.target.value);
              if (item.returned) {
                const at = fromDateInput(event.target.value);
                if (at !== null) {
                  void run(() => setReturned({ itemId: item._id, returned: true, returnedAt: at }));
                }
              }
            }}
          />
        </div>
        <button
          type="button"
          disabled={busy || !item.productUrl}
          title={item.productUrl ? undefined : "This item has no product page to check"}
          onClick={() => void run(() => checkNow({ itemId: item._id }))}
          className={secondaryButtonClass}
        >
          Check price now
        </button>
        {item.returned && !openReturnClaim && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => openClaim({ itemId: item._id }))}
            className={primaryButtonClass}
          >
            Open claim
          </button>
        )}
      </div>

      {item.claims.length > 0 && (
        <ul className="space-y-1 border-t border-line pt-2">
          {item.claims.map((claim) => (
            <li key={claim._id} className="flex flex-wrap items-center justify-between gap-2">
              <Link
                to={`/claims/${claim._id}`}
                className="text-sm text-ink underline-offset-4 hover:underline"
              >
                {CLAIM_TYPE_LABEL[claim.type]} ·{" "}
                <Money cents={Math.max(0, claim.balance.unresolved)} currency={currency} />
              </Link>
              <StatusPill status={claim.status} />
            </li>
          ))}
        </ul>
      )}

      {error && <ErrorBox error={error} />}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Policy cards (D17: immutable snapshots, refresh inserts a new row)
// ---------------------------------------------------------------------------

function PolicyCard({
  kind,
  policy,
  merchantDomain,
}: {
  kind: "price_adjustment" | "returns";
  policy: Doc<"policies"> | undefined;
  merchantDomain: string;
}) {
  const confirmPolicy = useMutation(api.policies.confirm);
  const refresh = useAction(api.policies.refresh);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // `confirm` doubles as an edit: the user can correct what the scrape got
  // wrong before vouching for it, and `channel` is required.
  const [channel, setChannel] = useState<PolicyChannel>(policy?.channel ?? "unknown");
  const [contactEmail, setContactEmail] = useState(policy?.contactEmail ?? "");
  const [windowDays, setWindowDays] = useState(
    policy?.windowDays === undefined ? "" : String(policy.windowDays),
  );

  async function run(work: () => Promise<unknown>) {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${sectionClass} space-y-2`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-serif text-base text-ink">{POLICY_KIND_LABEL[kind]}</h3>
        {policy && (
          <span className="text-xs text-ink/50">Current policy · retrieved {when(policy.retrievedAt)}</span>
        )}
      </div>

      {!policy ? (
        <p className="text-sm text-ink/60">
          Not looked up yet. Refresh to have Recoup find this merchant&rsquo;s rule.
        </p>
      ) : (
        <>
          {policy.passage ? (
            <blockquote className="border-l-2 border-line pl-3 text-sm italic text-ink/80">
              {policy.passage}
            </blockquote>
          ) : (
            <p className="text-sm text-ink/60">
              {policy.note ?? "No passage found. Treat this as unknown."}
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-3">
            <div>
              <label className={labelClass} htmlFor={`channel-${policy._id}`}>
                Channel
              </label>
              <select
                id={`channel-${policy._id}`}
                className={inputClass}
                value={channel}
                onChange={(event) => setChannel(event.target.value as PolicyChannel)}
              >
                {CHANNELS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor={`contact-${policy._id}`}>
                Contact email
              </label>
              <input
                id={`contact-${policy._id}`}
                className={inputClass}
                placeholder="unknown"
                value={contactEmail}
                onChange={(event) => setContactEmail(event.target.value)}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`window-${policy._id}`}>
                Window (days)
              </label>
              <input
                id={`window-${policy._id}`}
                inputMode="numeric"
                className={inputClass}
                placeholder="unknown"
                value={windowDays}
                onChange={(event) => setWindowDays(event.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-ink/50">Confidence {policy.confidence.toFixed(2)}</p>
          {policy.sourceUrl && (
            <a
              href={policy.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-xs text-harbor underline-offset-2 hover:underline"
            >
              {policy.sourceUrl}
            </a>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => refresh({ merchantDomain, kind }))}
          className={secondaryButtonClass}
        >
          {busy ? "Reading the site…" : policy ? "Refresh" : "Look this up"}
        </button>
        {policy && (
          <>
            {policy.confirmedByUser && (
              <span className="text-xs font-semibold uppercase tracking-wide text-moss">
                Confirmed by you
              </span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() => {
                  const days = windowDays.trim() === "" ? undefined : Number(windowDays.trim());
                  if (days !== undefined && (!Number.isSafeInteger(days) || days < 0)) {
                    throw new Error("Enter the window as a whole number of days.");
                  }
                  return confirmPolicy({
                    policyId: policy._id,
                    channel,
                    contactEmail: contactEmail.trim() === "" ? undefined : contactEmail.trim(),
                    windowDays: days,
                  });
                })
              }
              className={primaryButtonClass}
            >
              {policy.confirmedByUser ? "Save corrections" : "This looks right"}
            </button>
          </>
        )}
      </div>

      {error && <ErrorBox error={error} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function Purchase() {
  const { id } = useParams();
  const purchaseId = id as Id<"purchases"> | undefined;
  const data = useQuery(api.purchases.get, purchaseId ? { purchaseId } : "skip");

  if (!purchaseId) return <Empty title="No purchase selected" />;
  if (data === undefined) return <Loading rows={4} />;

  const { purchase, items, policies } = data;
  const currency = purchase.currency;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Purchase</p>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">
          {purchase.merchant || purchase.merchantDomain || "Purchase"}
        </h1>
        <p className="mt-1 text-sm text-ink/60">
          {purchase.orderRef ? `Order ${purchase.orderRef} · ` : ""}
          {day(purchase.purchasedAt)} · {purchase.status.replace("_", " ")}
        </p>
        <Link to="/" className="mt-2 inline-block text-sm text-ink/60 underline-offset-2 hover:text-ink hover:underline">
          Back to the board
        </Link>
      </div>

      {purchase.status === "needs_review" ? (
        <ReviewForm data={data} />
      ) : (
        <>
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Items</h2>
            {items.length === 0 ? (
              <Empty title="No items on this purchase" />
            ) : (
              <ul className="space-y-3">
                {items.map((item) => (
                  <ItemCard key={item._id} item={item} currency={currency} />
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
              {purchase.merchant || purchase.merchantDomain} policy
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              {(["price_adjustment", "returns"] as const).map((kind) => {
                const policy = policies.find((candidate) => candidate.kind === kind);
                return (
                  <PolicyCard
                    // A refresh inserts a NEW snapshot (D17), so remount to pick
                    // up its values rather than keeping the old row's edits.
                    key={policy?._id ?? kind}
                    kind={kind}
                    policy={policy}
                    merchantDomain={purchase.merchantDomain}
                  />
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
