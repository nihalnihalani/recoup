import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { EVIDENCE_RETENTION_DAYS } from "../../../convex/lib/privacyFacts";
import { when } from "../../lib/ui";
import { DOC_TYPE_LABELS } from "./docTypes";

/**
 * The caller's recent uploads (`evidence.listRecent`), each with where it stands: attached to a transaction (kept
 * while that is open), kept by choice, or waiting (cleared after the retention window unless attached or kept).
 */
export function RecentUploads() {
  const recent = useQuery(api.evidence.listRecent, { limit: 5 });
  if (recent === undefined || recent.length === 0) return null;
  return (
    <div className="mt-5 border-t border-dashed border-gray-200 pt-4">
      <h3 className="text-sm font-semibold text-gray-900">Recent uploads</h3>
      <ul className="mt-2 space-y-2 text-sm">
        {recent.map((row) => (
          <li key={row._id} className="flex flex-wrap justify-between gap-x-3">
            <span className="min-w-0 break-words text-gray-900">
              {row.fileName ?? DOC_TYPE_LABELS[row.docType]} <span className="text-gray-600">· {when(row.receivedAt)}</span>
            </span>
            <span className="text-gray-700">
              {row.retention !== "active"
                ? "Content cleared"
                : row.transactionId !== null
                  ? "Attached to a transaction"
                  : row.pinnedAt !== null
                    ? "Kept"
                    : `Not attached; cleared after ${EVIDENCE_RETENTION_DAYS} days`}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-600">Attach an upload from its transaction's page, under Documents.</p>
    </div>
  );
}
