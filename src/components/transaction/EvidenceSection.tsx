import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useId, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { EVIDENCE_RETENTION_DAYS } from "../../../convex/lib/privacyFacts";
import { errorText, inputClass, labelClass, secondaryButtonClass, when } from "../../lib/ui";
import { UploadPanel } from "../add/UploadPanel";
import { DOC_TYPE_LABELS } from "../add/docTypes";
import { ErrorBox, Loading } from "../States";
import { EvidencePreview } from "./EvidencePreview";

type EvidenceView = FunctionReturnType<typeof api.evidence.get>;

const PARTIAL_STATUSES = new Set(["needs_review", "failed", "unreadable", "needs_unlocked_copy", "over_page_cap"]);

/** Where a document stands, in plain words; the server's own summary when it has one. */
function statusLine(row: EvidenceView): string {
  if (row.retention === "content_deleted") return "Its content was cleared after the retention period; the facts recorded from it stay.";
  if (row.extractionSummary) return row.extractionSummary;
  if (row.extractionStatus === "succeeded") return "Read. Anything it proposed waits for you to confirm it.";
  if (PARTIAL_STATUSES.has(row.extractionStatus)) return "Only partly read. Check its facts above and fill in what is missing.";
  return "Stored, not read.";
}

/**
 * The transaction's documents (contract §9 "evidence"): each with its declared type, where it stands (stored, not
 * read, partly read, cleared), when it is cleared, a keep toggle (DA-A-7), and a file preview fetched on request
 * (DA-A-28b: images only, and only when their bytes agree). Add a document by uploading it here (it is attached to
 * this transaction) or by attaching one of your recent uploads.
 */
export function EvidenceSection({ transactionId }: { transactionId: Id<"transactions"> }) {
  const list = useQuery(api.evidence.listForTransaction, { transactionId });
  const attach = useMutation(api.evidence.attachToTransaction);
  const [error, setError] = useState<string | null>(null);

  async function attachUpload(evidenceId: Id<"evidence">) {
    setError(null);
    try {
      await attach({ evidenceId, transactionId });
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <div className="space-y-5">
      {list === undefined ? (
        <Loading rows={2} />
      ) : list.evidence.length === 0 ? (
        <p className="text-sm text-gray-600">No documents are attached to this transaction yet.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {list.evidence.map((row) => (
            <EvidenceRow key={row._id} row={row} />
          ))}
        </ul>
      )}
      {list?.truncated && <p className="text-sm text-gray-600">Showing the 100 most recent documents.</p>}

      <details className="rounded-xl border border-gray-200">
        <summary className="cursor-pointer rounded-xl px-3.5 py-3 text-sm font-semibold text-gray-900 focus-visible:outline-2 focus-visible:outline-violet-500">
          Add a document to this transaction
        </summary>
        <div className="space-y-5 border-t border-dashed border-gray-200 p-3.5">
          <UploadPanel onUploaded={(evidenceId) => void attachUpload(evidenceId)} />
          <AttachRecent onAttach={attachUpload} />
        </div>
      </details>
      {error && <ErrorBox error={error} />}
    </div>
  );
}

function EvidenceRow({ row }: { row: EvidenceView }) {
  const setPinned = useMutation(api.evidence.setPinned);
  const [error, setError] = useState<string | null>(null);
  const pinned = row.pinnedAt !== null;
  const name = row.fileName ?? row.headers?.subject ?? DOC_TYPE_LABELS[row.docType];
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 break-words font-medium text-gray-900">{name}</p>
        <p className="text-xs text-gray-600">{when(row.receivedAt)}</p>
      </div>
      <p className="text-sm text-gray-700">
        {DOC_TYPE_LABELS[row.docType]} · {statusLine(row)}
      </p>
      {row.retention === "active" && (
        <p className="text-xs text-gray-600">
          {pinned ? "Kept: you chose to keep it." : `Kept while this transaction is open, or ${EVIDENCE_RETENTION_DAYS} days if it is not.`}
        </p>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {row.hasFile && <EvidencePreview evidenceId={row._id} fileName={row.fileName} />}
        {row.retention === "active" && (
          <button
            type="button"
            className={secondaryButtonClass}
            onClick={() => void setPinned({ evidenceId: row._id, pinned: !pinned }).catch((caught: unknown) => setError(errorText(caught)))}
          >
            {pinned ? "Stop keeping it" : "Keep this document"}
          </button>
        )}
      </div>
      {error && <ErrorBox error={error} />}
    </li>
  );
}

/** One of the caller's recent uploads that is not attached anywhere yet, attached here. */
function AttachRecent({ onAttach }: { onAttach: (id: Id<"evidence">) => Promise<void> }) {
  const recent = useQuery(api.evidence.listRecent, { limit: 20 });
  const selectId = useId();
  const [choice, setChoice] = useState("");
  const unattached = (recent ?? []).filter((row) => row.transactionId === null && row.retention === "active");
  if (recent === undefined || unattached.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-56">
        <label htmlFor={selectId} className={labelClass}>
          Or attach one of your recent uploads
        </label>
        <select id={selectId} className={inputClass} value={choice} onChange={(event) => setChoice(event.target.value)}>
          <option value="">Choose…</option>
          {unattached.map((row) => (
            <option key={row._id} value={row._id}>
              {(row.fileName ?? DOC_TYPE_LABELS[row.docType]) + ` · ${when(row.receivedAt)}`}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        disabled={choice === ""}
        className={secondaryButtonClass}
        onClick={() => void onAttach(choice as Id<"evidence">).then(() => setChoice(""))}
      >
        Attach
      </button>
      <p className="basis-full text-xs text-gray-600">Attaching keeps it for as long as this transaction is open.</p>
    </div>
  );
}
