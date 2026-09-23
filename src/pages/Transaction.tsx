import { useMutation, useQuery } from "convex/react";
import { Link, Navigate, useParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { CoverageList } from "../components/opportunity/CoverageList";
import { OpportunityCard } from "../components/opportunity/OpportunityCard";
import { DotChip } from "../components/purchase/parts";
import { Empty, Loading } from "../components/States";
import { EvidenceSection } from "../components/transaction/EvidenceSection";
import { FactsTable } from "../components/transaction/FactsTable";
import { CATEGORY_LABELS, TRANSACTION_STATUS_LABELS } from "../components/transaction/labels";
import { formatMinor } from "../lib/money";
import { cardClass, day, pageTitleClass } from "../lib/ui";

/**
 * /transactions/:id (M24; contract §9 "Transaction page sections"): what the transaction is, the facts known about
 * it (each labelled by how sure it is), its recovery paths (active packs only) with their questions, and the paths
 * not checked. A retail order has a purchase page with the same sections, so it redirects there (§9). A foreign or
 * unknown id throws the server's "Transaction not found", which the route's error boundary shows as the same
 * not-found message as every other page.
 */
export default function Transaction() {
  const { id } = useParams();
  const transactionId = id as Id<"transactions"> | undefined;
  const txn = useQuery(api.transactions.get, transactionId ? { transactionId } : "skip");
  const standalone = txn !== undefined && txn.purchaseId === undefined;
  const cells = useQuery(api.facts.list, transactionId && standalone ? { transactionId } : "skip");
  const recovery = useQuery(api.opportunities.forTransaction, transactionId && standalone ? { transactionId } : "skip");
  const answerFact = useMutation(api.facts.answer);
  const openCase = useMutation(api.opportunities.openCase);
  const reevaluate = useMutation(api.opportunities.reevaluate);

  if (!transactionId) return <Empty title="No transaction selected" />;
  if (txn === undefined) return <Loading rows={4} />;
  if (txn.purchaseId !== undefined) return <Navigate to={`/purchases/${txn.purchaseId}`} replace />;

  const views = recovery?.opportunities ?? [];
  return (
    <div className="space-y-6">
      <div>
        <Link to="/opportunities" className="rounded text-sm font-medium text-gray-600 transition hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500">
          All recovery paths
        </Link>
        <h1 className={`mt-1 break-words ${pageTitleClass}`}>{txn.counterpartyName || CATEGORY_LABELS[txn.category]}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
          <span>{CATEGORY_LABELS[txn.category]}</span>
          {txn.transactedAt !== undefined && <span>{day(txn.transactedAt)}</span>}
          {txn.totalMinor !== undefined && <span className="tabular-nums">{formatMinor(txn.totalMinor, txn.currency)} paid</span>}
          {txn.status !== "active" && <DotChip dot={txn.status === "needs_review" ? "bg-gold" : "bg-gray-300"}>{TRANSACTION_STATUS_LABELS[txn.status]}</DotChip>}
          {txn.isExample && <DotChip dot="bg-gray-300">Example</DotChip>}
        </p>
      </div>

      <section aria-labelledby="txn-facts" className={`${cardClass} p-5`}>
        <h2 id="txn-facts" className="text-base font-semibold text-gray-900">What Recoup knows</h2>
        <div className="mt-3">{cells === undefined ? <Loading rows={2} /> : <FactsTable cells={cells} />}</div>
      </section>

      <section aria-labelledby="txn-paths" className="space-y-4">
        <h2 id="txn-paths" className="text-base font-semibold text-gray-900">Recovery paths</h2>
        {recovery === undefined ? (
          <Loading rows={2} />
        ) : views.length === 0 ? (
          <p className={`${cardClass} p-5 text-sm text-gray-600`}>
            No recovery path applies to this transaction on what Recoup knows now. Recoup checks supported recovery paths
            only; the ones it did not check are listed below.
          </p>
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {views.map((view) => (
              <OpportunityCard
                key={view.opportunity._id}
                view={view}
                related={views}
                cells={cells}
                counterparty={txn.counterpartyName || undefined}
                onOpenCase={() => openCase({ opportunityId: view.opportunity._id })}
                onCheckAgain={async () => {
                  await reevaluate({ transactionId });
                }}
                onAnswer={async ({ subjectKey, key, value }) => {
                  await answerFact({ transactionId, subjectKey, key, value });
                }}
              />
            ))}
          </div>
        )}
        {recovery?.truncated && <p className="text-sm text-gray-600">Showing the first 100 recovery paths.</p>}
        {recovery !== undefined && <CoverageList rows={recovery.pathsNotChecked} />}
      </section>

      <section aria-labelledby="txn-evidence" className={`${cardClass} p-5`}>
        <h2 id="txn-evidence" className="text-base font-semibold text-gray-900">Documents</h2>
        <div className="mt-3">
          <EvidenceSection transactionId={transactionId} />
        </div>
      </section>
    </div>
  );
}
