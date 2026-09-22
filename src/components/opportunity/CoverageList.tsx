import type { CoverageRow } from "./model";

/**
 * "Paths not checked / source not verified" (contract §9; mission §20): honest coverage for this transaction —
 * which recovery paths Recoup did NOT check and why. No amounts, ever: a path that was not checked has no estimate.
 */
export function CoverageList({ rows }: { rows: readonly CoverageRow[] }) {
  const notChecked = rows.filter((row) => row.status === "not_checked");
  if (notChecked.length === 0) return null;
  return (
    <details className="group rounded-2xl border border-gray-200 bg-white">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-5 py-4 text-sm font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-violet-500">
        <span>
          Paths not checked
          <span className="ml-2 font-normal text-gray-600">
            {notChecked.length} {notChecked.length === 1 ? "path" : "paths"} · Recoup checks supported recovery paths only
          </span>
        </span>
        <span aria-hidden="true" className="text-gray-500 transition group-open:rotate-180 motion-reduce:transition-none">
          ▾
        </span>
      </summary>
      <ul className="divide-y divide-gray-100 border-t border-gray-200 px-5">
        {notChecked.map((row) => (
          <li key={row.scenarioId} className="py-3">
            <p className="text-sm font-medium text-gray-900">{row.title}</p>
            <p className="mt-0.5 text-sm text-gray-600">{row.reason}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
