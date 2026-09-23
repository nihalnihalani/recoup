import { useAuthToken } from "@convex-dev/auth/react";
import { useEffect, useRef, useState } from "react";
import { fetchEvidenceFile } from "../../lib/evidenceFetch";
import { secondaryButtonClass } from "../../lib/ui";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "image"; url: string }
  | { kind: "file"; url: string; fileName: string }
  | { kind: "error"; message: string };

/**
 * One stored file, fetched only when the user asks (downloads are rate limited) through GET /evidence/file with a
 * bearer token, never a storage URL. DA-A-28b: an <img> is built only for an image whose server type and bytes agree
 * (`fetchEvidenceFile`); anything else — a PDF, HEIC, or a mismatch — is offered as a file to save, never rendered.
 */
export function EvidencePreview({ evidenceId, fileName }: { evidenceId: string; fileName: string | null }) {
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const [state, setState] = useState<State>({ kind: "idle" });

  useEffect(() => {
    return () => {
      if (state.kind === "image" || state.kind === "file") URL.revokeObjectURL(state.url);
    };
  }, [state]);

  async function load() {
    setState({ kind: "loading" });
    const result = await fetchEvidenceFile({ evidenceId, getToken: () => tokenRef.current });
    if (result.kind === "error") return setState({ kind: "error", message: result.message });
    const url = URL.createObjectURL(result.blob);
    if (result.kind === "image") setState({ kind: "image", url });
    else setState({ kind: "file", url, fileName: result.fileName ?? fileName ?? "document" });
  }

  if (state.kind === "image") {
    return <img src={state.url} alt={`Preview of ${fileName ?? "the uploaded image"}`} className="max-h-72 rounded-lg border border-gray-200 object-contain" />;
  }
  if (state.kind === "file") {
    return (
      <p className="text-sm text-gray-700">
        This file type is not previewed here.{" "}
        <a href={state.url} download={state.fileName} className="font-semibold text-gray-900 underline underline-offset-4">
          Save {state.fileName}
        </a>
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <button type="button" className={secondaryButtonClass} disabled={state.kind === "loading"} onClick={() => void load()}>
        {state.kind === "loading" ? "Fetching…" : "Show file"}
      </button>
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}
    </div>
  );
}
