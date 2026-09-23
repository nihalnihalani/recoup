import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { EVIDENCE_RETENTION_DAYS } from "../../../convex/lib/privacyFacts";
import { MAX_UPLOAD_BYTES, uploadEvidence, type UploadResult } from "../../lib/evidenceFetch";
import { errorText, inputClass, labelClass, primaryButtonClass, secondaryButtonClass, useOnline } from "../../lib/ui";
import { ErrorBox } from "../States";
import { DOC_TYPE_LABELS, PICKABLE_DOC_TYPES, type EvidenceDocType } from "./docTypes";

/**
 * Upload a document (M24, §2.6/§9). The doc-type picker is REQUIRED before anything is sent (DA-A-8), and the
 * page says plainly that live reading is off (D145): the file is stored, not read, and the user confirms facts
 * themselves. Upload goes through POST /evidence/upload only (`lib/evidenceFetch`).
 */
export function UploadPanel({ onUploaded }: { onUploaded?: (evidenceId: Id<"evidence">) => void }) {
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const online = useOnline();
  const fileId = useId();
  const typeId = useId();
  const hintId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [docType, setDocType] = useState<EvidenceDocType | "">("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [uploadedId, setUploadedId] = useState<Id<"evidence"> | null>(null);

  const tooBig = file !== null && file.size > MAX_UPLOAD_BYTES;
  const ready = file !== null && docType !== "" && !tooBig && online && !busy;

  async function submit() {
    if (!file || docType === "") return;
    setBusy(true);
    setResult(null);
    const outcome = await uploadEvidence({ file, docType, getToken: () => tokenRef.current });
    setResult(outcome);
    setBusy(false);
    if (outcome.ok) {
      const id = outcome.evidenceId as Id<"evidence">;
      setUploadedId(id);
      setFile(null);
      setDocType("");
      onUploaded?.(id);
    }
  }

  return (
    <div className="space-y-4">
      <p id={hintId} className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-3 text-sm text-gray-700">
        Reading uploaded documents is switched off for now, so Recoup <strong className="font-semibold">stores</strong> the
        file but does not read it. You confirm the facts yourself. PDF, JPEG, PNG, WebP or HEIC, up to 10 MB.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <label htmlFor={fileId} className={labelClass}>
            File
          </label>
          <input
            id={fileId}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif"
            aria-describedby={hintId}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-900 file:mr-3 file:rounded-lg file:border file:border-gray-200 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-900 hover:file:bg-gray-50"
          />
          {tooBig && <p className="mt-1.5 text-sm text-red-700">That file is larger than 10 MB.</p>}
        </div>
        <div className="min-w-0">
          <label htmlFor={typeId} className={labelClass}>
            What is this document? <span className="font-normal text-gray-600">(required)</span>
          </label>
          <select
            id={typeId}
            required
            value={docType}
            onChange={(event) => setDocType(event.target.value as EvidenceDocType | "")}
            className={inputClass}
          >
            <option value="">Choose…</option>
            {PICKABLE_DOC_TYPES.map((type) => (
              <option key={type} value={type}>
                {DOC_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={!ready} onClick={() => void submit()} className={primaryButtonClass}>
          {busy ? "Uploading…" : "Upload and store"}
        </button>
        {!online && <p className="text-sm text-gray-700">You're offline. Upload when you're back online.</p>}
        {online && file !== null && docType === "" && (
          <p className="text-sm text-gray-700">Choose what the document is before uploading.</p>
        )}
      </div>
      {result && !result.ok && <ErrorBox error={result.message} />}
      {result?.ok && result.duplicate && (
        <p role="status" className="text-sm text-gray-700">
          You had already uploaded this exact file, so nothing new was stored.
        </p>
      )}
      {uploadedId && <UploadedDocument evidenceId={uploadedId} />}
    </div>
  );
}

/** What was stored, what happens to it, and the choice to keep it (DA-A-7). */
function UploadedDocument({ evidenceId }: { evidenceId: Id<"evidence"> }) {
  const row = useQuery(api.evidence.get, { evidenceId });
  const setPinned = useMutation(api.evidence.setPinned);
  const [error, setError] = useState<string | null>(null);
  if (row === undefined) return <p className="text-sm text-gray-600">Checking the stored file…</p>;
  const pinned = row.pinnedAt !== null;
  return (
    <div role="status" className="space-y-2 rounded-xl border border-gray-200 px-3.5 py-3 text-sm text-gray-900">
      <p className="font-semibold">Stored: {row.fileName ?? "your document"}</p>
      <p className="text-gray-700">
        {DOC_TYPE_LABELS[row.docType]}. {row.extractionSummary ?? "Not read automatically."}
      </p>
      <p className="text-gray-700">
        {pinned
          ? "You chose to keep it, so it is not cleared after 30 days."
          : `It is cleared ${EVIDENCE_RETENTION_DAYS} days after upload unless it is attached to one of your transactions or you keep it.`}
      </p>
      <button
        type="button"
        className={secondaryButtonClass}
        onClick={() =>
          void setPinned({ evidenceId, pinned: !pinned }).catch((caught: unknown) => setError(errorText(caught)))
        }
      >
        {pinned ? "Stop keeping it" : "Keep this document"}
      </button>
      {error && <ErrorBox error={error} />}
    </div>
  );
}
