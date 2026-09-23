import { useId } from "react";
import { DotChip } from "../purchase/parts";
import { describeFactValue, humanizeKeys, type FactCell } from "../opportunity/model";
import { FACT_STATE_COPY } from "./labels";

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  user: "your entry",
  evidence: "a document",
  price_check: "a price check",
  legacy_price_check: "a price check",
  derived: "a calculation",
  legacy_purchase: "the purchase record",
};

/** The fact's name in words ("retail.purchase_date" → "purchase date"). */
function factName(key: string): string {
  const words = humanizeKeys(key);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Which part of the transaction a fact is about; nothing for the transaction itself. */
function subjectName(subjectKey: string): string | null {
  if (subjectKey === "txn") return null;
  const kind = subjectKey.split(":")[0];
  return kind === "item" ? "One item" : kind === "leg" ? "One flight leg" : kind === "bag" ? "One bag" : kind;
}

function valueOf(cell: FactCell): string {
  if (cell.conflict) return cell.conflict.values.map((v) => `${describeFactValue(v.value)} (${SOURCE_WORDS[v.source.kind] ?? v.source.kind})`).join(" vs ");
  if (cell.value) return describeFactValue(cell.value);
  if (cell.hint) return `Later suggested: ${describeFactValue(cell.hint.value)}`;
  return "—";
}

function sourceOf(cell: FactCell): string | null {
  const source = cell.source ?? cell.sources?.[0];
  return source ? (SOURCE_WORDS[source.kind] ?? source.kind) : null;
}

/**
 * Everything known about a transaction, split into what is settled and what needs the user (contract §9). Each
 * row says how sure it is; a candidate is never shown as confirmed and a conflict shows every value with its source.
 */
export function FactsTable({ cells }: { cells: readonly FactCell[] }) {
  const needs = cells.filter((c) => !FACT_STATE_COPY[c.status].settled);
  const settled = cells.filter((c) => FACT_STATE_COPY[c.status].settled);
  if (cells.length === 0) return <p className="text-sm text-gray-600">Nothing is recorded about this transaction yet.</p>;
  return (
    <div className="space-y-5">
      {needs.length > 0 && <FactGroup title="Needs your confirmation" cells={needs} />}
      {settled.length > 0 && <FactGroup title="Confirmed and observed" cells={settled} />}
    </div>
  );
}

function FactGroup({ title, cells }: { title: string; cells: readonly FactCell[] }) {
  const headingId = useId();
  return (
    <div>
      <h3 id={headingId} className="text-sm font-semibold text-gray-900">{title}</h3>
      {/* A keyboard user can scroll the table on a narrow screen: the scroller is focusable and named. */}
      <div role="region" aria-labelledby={headingId} tabIndex={0} className="mt-2 overflow-x-auto rounded-xl border border-gray-200 outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
        <table className="w-full min-w-[36rem] table-auto text-sm">
          <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-600">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Fact</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Value</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">How sure</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">From</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {cells.map((cell) => (
              <tr key={`${cell.subjectKey}\u0000${cell.key}`}>
                <th scope="row" className="px-3 py-2.5 text-left font-medium text-gray-900">
                  {factName(cell.key)}
                  {subjectName(cell.subjectKey) && (
                    <span className="block text-xs font-normal text-gray-600">{subjectName(cell.subjectKey)}</span>
                  )}
                </th>
                <td className="px-3 py-2.5 tabular-nums text-gray-900">{valueOf(cell)}</td>
                <td className="px-3 py-2.5">
                  <DotChip dot={FACT_STATE_COPY[cell.status].dot}>{FACT_STATE_COPY[cell.status].label}</DotChip>
                </td>
                <td className="px-3 py-2.5 text-gray-700">{sourceOf(cell) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
