import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { OpportunityRow } from "../components/opportunity/OpportunityRow";
import { Loading } from "../components/States";
import { CATEGORY_LABELS } from "../components/transaction/labels";
import { coverageSummary } from "../lib/coverageCopy";
import { cardClass, day, pageTitleClass } from "../lib/ui";

/** Transactions whose paths are listed at once (each is one live `forTransaction` read until `listMine` lands). */
const GROUP_LIMIT = 25;

/**
 * /opportunities (M24; contract §9): every recovery path, grouped by the transaction it belongs to. There is
 * deliberately no total: alternative paths for one loss are not additive (D145), and the dashboard's per-currency
 * summary is the one place money is added up (SEC-MF-1).
 */
export default function Opportunities() {
  const list = useQuery(api.transactions.list, {});
  if (list === undefined) return <Loading rows={4} />;
  const shown = list.transactions.slice(0, GROUP_LIMIT);
  return (
    <div className="space-y-6">
      <div>
        <h1 className={pageTitleClass}>Recovery paths</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Grouped by purchase or transaction. {coverageSummary()} Paths for the same loss are alternatives, so they are
          never added together; see the dashboard for totals by currency.
        </p>
      </div>
      {list.transactions.length === 0 ? (
        <section className={`${cardClass} border-dashed px-6 py-12 text-center`}>
          <h2 className="text-base font-semibold text-gray-900">Nothing to check yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            Add a purchase, a flight or a card charge. {coverageSummary()}
          </p>
          <Link to="/add" className="mt-4 inline-block font-semibold text-gray-900 underline underline-offset-4">
            Add something
          </Link>
        </section>
      ) : (
        <div className="space-y-4">
          {shown.map((txn) => (
            <TransactionGroup key={txn._id} txn={txn} />
          ))}
          {(list.transactions.length > GROUP_LIMIT || list.truncated) && (
            <p className="text-sm text-gray-600">
              Showing your {GROUP_LIMIT} most recent transactions. Open a purchase or transaction to see the rest.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TransactionGroup({ txn }: { txn: Doc<"transactions"> }) {
  const recovery = useQuery(api.opportunities.forTransaction, { transactionId: txn._id });
  const href = txn.purchaseId ? `/purchases/${txn.purchaseId}` : `/transactions/${txn._id}`;
  if (recovery !== undefined && recovery.opportunities.length === 0) return null;
  const headingId = `group-${txn._id}`;
  return (
    <section aria-labelledby={headingId} className={`${cardClass} p-5`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-gray-900">
          <Link to={href} className="underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900">
            {txn.counterpartyName || CATEGORY_LABELS[txn.category]}
          </Link>
        </h2>
        <p className="text-sm text-gray-600">
          {CATEGORY_LABELS[txn.category]}
          {txn.transactedAt !== undefined ? ` · ${day(txn.transactedAt)}` : ""}
        </p>
      </header>
      {recovery === undefined ? (
        <Loading rows={1} />
      ) : (
        <ul className="mt-2 divide-y divide-gray-100">
          {recovery.opportunities.map((view) => (
            <OpportunityRow key={view.opportunity._id} view={view} href={href} />
          ))}
        </ul>
      )}
    </section>
  );
}
