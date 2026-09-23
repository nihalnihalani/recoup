import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { OpportunityRow } from "../components/opportunity/OpportunityRow";
import { Loading } from "../components/States";
import { CATEGORY_LABELS } from "../components/transaction/labels";
import { coverageSummary } from "../lib/coverageCopy";
import { cardClass, pageTitleClass } from "../lib/ui";

type Item = FunctionReturnType<typeof api.opportunities.listMine>["items"][number];
type Group = { transactionId: Id<"transactions">; category: Item["category"]; counterpartyName: string; items: Item[] };

/** The server's rows (newest evaluation first) grouped by transaction, in the order each transaction first appears. */
function groupByTransaction(items: readonly Item[]): Group[] {
  const groups = new Map<Id<"transactions">, Group>();
  for (const item of items) {
    let group = groups.get(item.transactionId);
    if (!group) {
      group = { transactionId: item.transactionId, category: item.category, counterpartyName: item.counterpartyName, items: [] };
      groups.set(item.transactionId, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/**
 * /opportunities (M24; contract §9; D220): every open recovery path and every path with a claim open, from ONE owner-
 * scoped read (`opportunities.listMine`), grouped by the transaction it belongs to. There is deliberately no total:
 * alternative paths for one loss are not additive (D145), and the dashboard's per-currency summary is the one place
 * money is added up (SEC-MF-1).
 */
export default function Opportunities() {
  const list = useQuery(api.opportunities.listMine, {});
  if (list === undefined) return <Loading rows={4} />;
  const groups = groupByTransaction(list.items);
  return (
    <div className="space-y-6">
      <div>
        <h1 className={pageTitleClass}>Recovery paths</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Grouped by purchase or transaction. {coverageSummary()} Paths for the same loss are alternatives, so they are
          never added together; see the dashboard for totals by currency.
        </p>
      </div>
      {groups.length === 0 ? (
        <section className={`${cardClass} border-dashed px-6 py-12 text-center`}>
          <h2 className="text-base font-semibold text-gray-900">No recovery paths yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
            A path is listed here when something you added may be owed money back. Add a purchase, a flight or a card
            charge. {coverageSummary()}
          </p>
          <Link to="/add" className="mt-4 inline-block font-semibold text-gray-900 underline underline-offset-4">
            Add something
          </Link>
        </section>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <TransactionGroup key={group.transactionId} group={group} />
          ))}
          {list.truncated && (
            <p className="text-sm text-gray-600">
              Showing your most recently checked paths only. Open a purchase or transaction to see all of its paths.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TransactionGroup({ group }: { group: Group }) {
  // A retail transaction's page forwards to its purchase page, so every group links to its transaction.
  const href = `/transactions/${group.transactionId}`;
  const headingId = `group-${group.transactionId}`;
  return (
    <section aria-labelledby={headingId} className={`${cardClass} p-5`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-base font-semibold text-gray-900">
          <Link to={href} className="underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900">
            {group.counterpartyName || CATEGORY_LABELS[group.category]}
          </Link>
        </h2>
        <p className="text-sm text-gray-600">{CATEGORY_LABELS[group.category]}</p>
      </header>
      <ul className="mt-2 divide-y divide-gray-100">
        {group.items.map((item) => (
          <OpportunityRow key={item.opportunity._id} view={item} href={href} />
        ))}
      </ul>
    </section>
  );
}
