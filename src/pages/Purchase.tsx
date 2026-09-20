import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ConvexError } from "convex/values";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { Money } from "../components/Money";
import { Countdown } from "../components/Countdown";
import { StatusPill } from "../components/StatusPill";
import { Empty, Loading, QueryBoundary } from "../components/States";

// T11b-2 will replace this once priceWatch lands.
const PRICE_WATCH_NOTE = "manual re-check arrives with priceWatch";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ConvexError && typeof err.data === "string" ? err.data : fallback;
}

function toDateInputValue(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

type PurchaseData = NonNullable<FunctionReturnType<typeof api.purchases.get>>;
type PurchaseItem = PurchaseData["items"][number];

// ---------------------------------------------------------------------------
// Review form (purchase.status === "needs_review", D25)
// ---------------------------------------------------------------------------

type ReviewRow = {
  itemId: Id<"items">;
  name: string;
  unitCents: string;
  qty: string;
  productUrl: string;
};

function ReviewForm({ purchase, items }: { purchase: Doc<"purchases">; items: PurchaseItem[] }) {
  const confirm = useMutation(api.purchases.confirm);
  const [merchant, setMerchant] = useState(purchase.merchant);
  const [merchantDomain, setMerchantDomain] = useState(purchase.merchantDomain);
  const [orderRef, setOrderRef] = useState(purchase.orderRef ?? "");
  const [purchasedAt, setPurchasedAt] = useState(toDateInputValue(purchase.purchasedAt));
  const [rows, setRows] = useState<ReviewRow[]>(
    items.map((it) => ({
      itemId: it._id,
      name: it.name,
      unitCents: (it.unitCents / 100).toFixed(2),
      qty: String(it.qty),
      productUrl: it.productUrl ?? "",
    })),
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateRow(index: number, patch: Partial<ReviewRow>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!purchasedAt) {
      setError("Date needed is required.");
      return;
    }
    const parsedItems: Array<{
      itemId: Id<"items">;
      name: string;
      unitCents: number;
      qty: number;
      productUrl?: string;
    }> = [];
    for (const row of rows) {
      const unitCents = Math.round(parseFloat(row.unitCents) * 100);
      if (!Number.isInteger(unitCents) || unitCents < 0) {
        setError(`"${row.name || "Item"}" needs a valid unit price.`);
        return;
      }
      const qty = parseInt(row.qty, 10);
      if (!Number.isInteger(qty) || qty < 1 || String(qty) !== row.qty.trim()) {
        setError(`"${row.name || "Item"}" needs a whole-number quantity of at least 1.`);
        return;
      }
      parsedItems.push({
        itemId: row.itemId,
        name: row.name,
        unitCents,
        qty,
        productUrl: row.productUrl.trim() || undefined,
      });
    }

    setSubmitting(true);
    try {
      await confirm({
        purchaseId: purchase._id,
        merchant,
        merchantDomain,
        orderRef: orderRef.trim() || undefined,
        purchasedAt: new Date(purchasedAt).getTime(),
        items: parsedItems,
      });
    } catch (err) {
      setError(errorMessage(err, "Couldn't save this purchase."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-6">
      <div className="rounded-lg border border-line bg-white/70 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Review this purchase</h2>
        <p className="mt-1 text-sm text-ink/60">
          Confirm the details Recoup pulled out before this case goes active.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="review-merchant" className="mb-1 block text-sm font-medium text-ink">
              Merchant
            </label>
            <input
              id="review-merchant"
              type="text"
              required
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>
          <div>
            <label htmlFor="review-domain" className="mb-1 block text-sm font-medium text-ink">
              Merchant domain
            </label>
            <input
              id="review-domain"
              type="text"
              required
              value={merchantDomain}
              onChange={(e) => setMerchantDomain(e.target.value)}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>
          <div>
            <label htmlFor="review-order-ref" className="mb-1 block text-sm font-medium text-ink">
              Order reference
            </label>
            <input
              id="review-order-ref"
              type="text"
              value={orderRef}
              onChange={(e) => setOrderRef(e.target.value)}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>
          <div>
            <label htmlFor="review-date" className="mb-1 block text-sm font-medium text-ink">
              Date needed
            </label>
            <input
              id="review-date"
              type="date"
              required
              value={purchasedAt}
              onChange={(e) => setPurchasedAt(e.target.value)}
              className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
            />
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-white/70 p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink/50">Items</h2>
        <div className="mt-3 space-y-4">
          {rows.map((row, index) => (
            <div key={row.itemId} className="grid gap-3 border-t border-line pt-3 first:border-t-0 first:pt-0 sm:grid-cols-4">
              <div>
                <label htmlFor={`item-name-${row.itemId}`} className="mb-1 block text-xs font-medium text-ink/60">
                  Name
                </label>
                <input
                  id={`item-name-${row.itemId}`}
                  type="text"
                  required
                  value={row.name}
                  onChange={(e) => updateRow(index, { name: e.target.value })}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
                />
              </div>
              <div>
                <label htmlFor={`item-price-${row.itemId}`} className="mb-1 block text-xs font-medium text-ink/60">
                  Unit price
                </label>
                <input
                  id={`item-price-${row.itemId}`}
                  type="number"
                  min="0"
                  step="0.01"
                  required
                  value={row.unitCents}
                  onChange={(e) => updateRow(index, { unitCents: e.target.value })}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
                />
              </div>
              <div>
                <label htmlFor={`item-qty-${row.itemId}`} className="mb-1 block text-xs font-medium text-ink/60">
                  Qty
                </label>
                <input
                  id={`item-qty-${row.itemId}`}
                  type="number"
                  min="1"
                  step="1"
                  required
                  value={row.qty}
                  onChange={(e) => updateRow(index, { qty: e.target.value })}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
                />
              </div>
              <div>
                <label htmlFor={`item-url-${row.itemId}`} className="mb-1 block text-xs font-medium text-ink/60">
                  Product URL
                </label>
                <input
                  id={`item-url-${row.itemId}`}
                  type="url"
                  value={row.productUrl}
                  onChange={(e) => updateRow(index, { productUrl: e.target.value })}
                  className="w-full rounded-md border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-harbor px-4 py-2 text-sm font-semibold text-paper transition hover:bg-harbor/90 disabled:opacity-60"
      >
        {submitting ? "Saving…" : "Confirm purchase"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Active purchase view
// ---------------------------------------------------------------------------

function OpenReturnCreditForm({ item }: { item: PurchaseItem }) {
  const openClaim = useMutation(api.claims.open);
  const [feeAmount, setFeeAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    let feeCents: number | undefined;
    if (feeAmount.trim() !== "") {
      feeCents = Math.round(parseFloat(feeAmount) * 100);
      if (!Number.isInteger(feeCents) || feeCents < 0) {
        setError("Fee must be a non-negative amount.");
        return;
      }
    }
    setSubmitting(true);
    try {
      await openClaim({ itemId: item._id, feeCents });
      setFeeAmount("");
    } catch (err) {
      setError(errorMessage(err, "Couldn't open the claim."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="mt-2 space-y-1">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={`fee-${item._id}`} className="mb-1 block text-xs font-medium text-ink/60">
            Return fee (optional)
          </label>
          <input
            id={`fee-${item._id}`}
            type="number"
            min="0"
            step="0.01"
            value={feeAmount}
            onChange={(e) => setFeeAmount(e.target.value)}
            className="w-24 rounded-md border border-line bg-white px-2 py-1 text-sm text-ink outline-none focus:border-harbor focus:ring-2 focus:ring-harbor/20"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="rounded-md bg-harbor px-3 py-1.5 text-xs font-semibold text-paper disabled:opacity-60"
        >
          {submitting ? "Opening…" : "Open return-credit claim"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-rust">
          {error}
        </p>
      )}
    </form>
  );
}

function ItemRow({ purchase, item }: { purchase: Doc<"purchases">; item: PurchaseItem }) {
  const setReturned = useMutation(api.purchases.setReturned);
  const [toggling, setToggling] = useState(false);

  const latestPriceCheck = item.priceChecks[0];
  const hasOpenReturnCredit = item.claims.some(
    (c) => c.type === "return_credit" && c.status !== "confirmed" && c.status !== "dismissed",
  );

  async function handleToggleReturned(checked: boolean) {
    setToggling(true);
    try {
      await setReturned({ itemId: item._id, returned: checked });
    } finally {
      setToggling(false);
    }
  }

  return (
    <tr className="border-b border-line align-top last:border-b-0">
      <td className="py-3 pl-4 pr-4">
        <p className="font-medium text-ink">{item.name}</p>
        <p className="text-xs text-ink/50">
          {item.qty} × <Money cents={item.unitCents} currency={purchase.currency} />
        </p>
      </td>
      <td className="py-3 pr-4">
        <Money cents={item.unitCents * item.qty} currency={purchase.currency} />
      </td>
      <td className="py-3 pr-4" title={latestPriceCheck?.note}>
        {latestPriceCheck?.observedCents !== undefined ? (
          <Money cents={latestPriceCheck.observedCents} currency={purchase.currency} />
        ) : (
          <span className="text-ink/40">—</span>
        )}
        <div>
          <button
            type="button"
            disabled
            title={PRICE_WATCH_NOTE}
            className="mt-1 rounded-md border border-line px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink/40 opacity-60"
          >
            Check price now
          </button>
        </div>
      </td>
      <td className="py-3 pr-4">
        <label className="inline-flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={item.returned}
            disabled={toggling}
            onChange={(e) => void handleToggleReturned(e.target.checked)}
            aria-label={`Mark ${item.name} returned`}
          />
          Returned
        </label>
      </td>
      <td className="py-3 pr-4">
        {item.claims.length > 0 && (
          <ul className="space-y-1">
            {item.claims.map((c) => (
              <li key={c._id}>
                <Link
                  to={`/claims/${c._id}`}
                  className="inline-flex flex-wrap items-center gap-2 text-sm text-ink hover:underline"
                >
                  <StatusPill status={c.status} />
                  {c.balance.unresolved < 0 ? (
                    <span className="font-mono text-xs tabular-nums text-rust">
                      over-credited by <Money cents={-c.balance.unresolved} currency={purchase.currency} />
                    </span>
                  ) : (
                    <Money cents={c.balance.unresolved} currency={purchase.currency} />
                  )}
                  {c.windowEndsAt !== undefined && <Countdown endsAt={c.windowEndsAt} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {item.returned && !hasOpenReturnCredit && <OpenReturnCreditForm item={item} />}
      </td>
    </tr>
  );
}

function ItemsTable({ purchase, items }: { purchase: Doc<"purchases">; items: PurchaseItem[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white/70">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold uppercase tracking-wide text-ink/50">
            <th className="px-4 py-3 font-semibold">Item</th>
            <th className="px-4 py-3 font-semibold">Paid</th>
            <th className="px-4 py-3 font-semibold">Latest price</th>
            <th className="px-4 py-3 font-semibold">Returned</th>
            <th className="px-4 py-3 font-semibold">Claims</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <ItemRow key={item._id} purchase={purchase} item={item} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PolicyCard({
  purchase,
  kind,
  policy,
}: {
  purchase: Doc<"purchases">;
  kind: "returns" | "price_adjustment";
  policy: Doc<"policies"> | undefined;
}) {
  const refresh = useAction(api.policies.refresh);
  const confirmPolicy = useMutation(api.policies.confirm);
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setError(null);
    setRefreshing(true);
    try {
      await refresh({ merchantDomain: purchase.merchantDomain, kind });
    } catch (err) {
      setError(errorMessage(err, "Couldn't refresh this policy."));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleConfirm() {
    if (!policy) return;
    setError(null);
    setConfirming(true);
    try {
      await confirmPolicy({
        policyId: policy._id,
        channel: policy.channel,
        windowDays: policy.windowDays,
        contactEmail: policy.contactEmail,
        passage: policy.passage,
        sourceUrl: policy.sourceUrl,
      });
    } catch (err) {
      setError(errorMessage(err, "Couldn't confirm this policy."));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-line bg-white/70 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink/50">
        {kind === "returns" ? "Returns policy" : "Price-adjustment policy"}
      </h3>

      {policy ? (
        <>
          <blockquote className="font-serif text-sm italic text-ink">
            {policy.passage ? `“${policy.passage}”` : "No passage found"}
          </blockquote>
          <p className="text-xs text-ink/50">
            Current policy · retrieved {new Date(policy.retrievedAt).toLocaleString()}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <div>
              <dt className="text-xs text-ink/40">Channel</dt>
              <dd className="text-ink">{policy.channel}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Window</dt>
              <dd className="text-ink">{policy.windowDays !== undefined ? `${policy.windowDays} days` : "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Contact</dt>
              <dd className="text-ink">{policy.contactEmail ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink/40">Confidence</dt>
              <dd className="text-ink">{Math.round(policy.confidence * 100)}%</dd>
            </div>
          </dl>
          <a
            href={policy.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-block text-xs font-medium text-harbor underline underline-offset-2"
          >
            Source
          </a>
          <div className="flex flex-wrap gap-2 pt-1">
            {!policy.confirmedByUser && (
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={confirming}
                className="rounded-md border border-moss/40 px-3 py-1.5 text-xs font-semibold text-moss disabled:opacity-60"
              >
                {confirming ? "Saving…" : "Looks right"}
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink/70 disabled:opacity-60"
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-ink/50">No policy found yet.</p>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-semibold text-ink/70 disabled:opacity-60"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </>
      )}

      {error && (
        <p role="alert" className="text-xs text-rust">
          {error}
        </p>
      )}
    </div>
  );
}

function DeletePurchaseButton({ purchaseId }: { purchaseId: Id<"purchases"> }) {
  const remove = useMutation(api.purchases.remove);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    if (!window.confirm("Delete this purchase and every claim on it? This can't be undone.")) return;
    setError(null);
    setDeleting(true);
    try {
      await remove({ purchaseId });
      navigate("/");
    } catch (err) {
      setError(errorMessage(err, "Couldn't delete this purchase."));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => void handleDelete()}
        disabled={deleting}
        className="rounded-md border border-line px-4 py-2 text-sm font-semibold text-ink/60 transition hover:border-rust/40 hover:text-rust disabled:opacity-60"
      >
        {deleting ? "Deleting…" : "Delete purchase"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-rust">
          {error}
        </p>
      )}
    </div>
  );
}

function ActivePurchase({ purchase, items, policies }: PurchaseData) {
  const returnsPolicy = policies.find((p) => p.kind === "returns");
  const priceAdjustmentPolicy = policies.find((p) => p.kind === "price_adjustment");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Purchase</p>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">{purchase.merchant}</h1>
          <p className="mt-1 text-sm text-ink/60">
            {purchase.purchasedAt ? new Date(purchase.purchasedAt).toLocaleDateString() : "date needed"}
            {purchase.orderRef ? ` · Order ${purchase.orderRef}` : ""}
          </p>
        </div>
        <DeletePurchaseButton purchaseId={purchase._id} />
      </div>

      <ItemsTable purchase={purchase} items={items} />

      <div className="grid gap-4 sm:grid-cols-2">
        <PolicyCard purchase={purchase} kind="returns" policy={returnsPolicy} />
        <PolicyCard purchase={purchase} kind="price_adjustment" policy={priceAdjustmentPolicy} />
      </div>
    </div>
  );
}

function PurchaseContent({ purchaseId }: { purchaseId: Id<"purchases"> }) {
  const data = useQuery(api.purchases.get, { purchaseId });

  if (data === undefined) {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Purchase</p>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">Loading…</h1>
        </div>
        <Loading rows={5} />
      </div>
    );
  }

  if (data.purchase.status === "needs_review") {
    return (
      <div className="space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Purchase</p>
          <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">{data.purchase.merchant}</h1>
        </div>
        <ReviewForm purchase={data.purchase} items={data.items} />
      </div>
    );
  }

  return <ActivePurchase {...data} />;
}

export default function Purchase() {
  const { id } = useParams();

  if (!id) {
    return (
      <Empty
        title="This purchase isn't loaded yet"
        hint="This page will show line items, prices, returns, and the merchant's policy for this purchase."
      />
    );
  }

  return (
    <QueryBoundary>
      <PurchaseContent purchaseId={id as Id<"purchases">} />
    </QueryBoundary>
  );
}
