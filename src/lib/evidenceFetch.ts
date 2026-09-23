/**
 * The browser side of the two evidence HTTP routes (M24; contract §2.6, §9; DA-A-28b; SEC-UP-5):
 *   POST /evidence/upload   the only way a file enters Recoup;
 *   GET  /evidence/file     the only way a file leaves it (bearer auth, never a storage URL).
 *
 * Pure except for `fetch`, which is injectable for tests. Every outcome is a typed result, never a thrown string,
 * so a page can show an honest state for each: signed out or expired (401, retried ONCE with a fresh token, §9
 * resilience), offline, too large, not an accepted type, over a limit, or failed.
 *
 * DA-A-28b: a preview is only ever built for an image the BYTES say is JPEG, PNG or WebP (the server's sniffed
 * `Content-Type` must agree with `sniffMime` on the downloaded bytes). Anything else — a PDF, HEIC, or a response whose
 * type and bytes disagree — is never put in an <img> or an iframe; it can only be saved as a file.
 */
import { PREVIEWABLE_MIMES, sniffMime, type SniffedMime } from "../../convex/lib/sniff";

/** The largest file the upload route accepts (convex/limits.ts `MAX_UPLOAD_BYTES`), checked before sending. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Fetch = typeof fetch;

/** The deployment's HTTP-actions origin: `VITE_CONVEX_SITE_URL`, else derived from `VITE_CONVEX_URL`. */
type SiteEnv = { VITE_CONVEX_SITE_URL?: string; VITE_CONVEX_URL?: string };

export function evidenceSiteUrl(env: SiteEnv = import.meta.env as SiteEnv): string | null {
  const explicit = env.VITE_CONVEX_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const cloud = env.VITE_CONVEX_URL?.trim();
  if (!cloud) return null;
  try {
    const url = new URL(cloud);
    if (!url.hostname.endsWith(".convex.cloud")) return null;
    url.hostname = url.hostname.replace(/\.convex\.cloud$/, ".convex.site");
    return url.origin;
  } catch {
    return null;
  }
}

export type UploadFailure =
  | "unauthorized"
  | "offline"
  | "network"
  | "too_large"
  | "empty"
  | "unsupported_type"
  | "rate_limited"
  | "quota"
  | "unknown_doc_type"
  | "not_configured"
  | "failed";

export type UploadResult =
  | { ok: true; evidenceId: string; duplicate: boolean; extractionStatus: string }
  | { ok: false; reason: UploadFailure; message: string };

/** Plain-language copy for each failure; none of them claims a file was stored. */
export const UPLOAD_MESSAGES: Readonly<Record<UploadFailure, string>> = {
  unauthorized: "Your session expired. Sign in again, then upload the file again. Nothing was stored.",
  offline: "You're offline, so the file wasn't sent. Try again when you're back online.",
  network: "The upload didn't reach Recoup. Nothing was stored; try again.",
  too_large: "That file is larger than 10 MB. Nothing was stored.",
  empty: "That file is empty. Nothing was stored.",
  unsupported_type: "Recoup accepts PDF, JPEG, PNG, WebP and HEIC files only. Nothing was stored.",
  rate_limited: "Too many uploads in a short time. Wait a minute and try again.",
  quota: "You've reached today's upload limit. Nothing was stored; try again tomorrow.",
  unknown_doc_type: "Choose what kind of document this is first.",
  not_configured: "Uploads aren't available on this deployment.",
  failed: "The upload failed on Recoup's side. Nothing was stored; try again.",
};

function failure(reason: UploadFailure): UploadResult {
  return { ok: false, reason, message: UPLOAD_MESSAGES[reason] };
}

/** Maps the route's JSON error to a failure reason. */
function reasonFor(status: number, error: unknown): UploadFailure {
  if (status === 401) return "unauthorized";
  if (status === 413) return "too_large";
  if (status === 415) return "unsupported_type";
  if (status === 429) return error === "rate_limited" ? "rate_limited" : "quota";
  if (status === 400) return error === "unknown_doc_type" ? "unknown_doc_type" : error === "empty" ? "empty" : "failed";
  return "failed";
}

/**
 * Uploads one file with its REQUIRED declared doc type (DA-A-8: nothing is extracted without one). `getToken` is read
 * again for the single retry after a 401, so a token the auth client refreshed in the meantime is used (§9: session
 * expiry mid-upload → re-auth → retry once). Never retries anything else.
 */
export async function uploadEvidence(input: {
  file: Blob & { name?: string };
  docType: string;
  getToken: () => Promise<string | null> | string | null;
  siteUrl?: string | null;
  fetchImpl?: Fetch;
  online?: boolean;
}): Promise<UploadResult> {
  const site = input.siteUrl === undefined ? evidenceSiteUrl() : input.siteUrl;
  if (!site) return failure("not_configured");
  if (!input.docType) return failure("unknown_doc_type");
  if (input.file.size === 0) return failure("empty");
  if (input.file.size > MAX_UPLOAD_BYTES) return failure("too_large");
  if ((input.online ?? (typeof navigator === "undefined" ? true : navigator.onLine)) === false) return failure("offline");
  const doFetch = input.fetchImpl ?? fetch;

  async function attempt(): Promise<Response | "network" | "no_token"> {
    const token = await input.getToken();
    if (!token) return "no_token";
    try {
      return await doFetch(`${site}/evidence/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Doc-Type": input.docType,
          ...(input.file.name ? { "X-File-Name": encodeURIComponent(input.file.name) } : {}),
        },
        body: input.file,
      });
    } catch {
      return "network";
    }
  }

  let response = await attempt();
  // §9: a 401 (or no token yet) gets exactly one retry with whatever token the auth client holds now.
  if (response === "no_token" || (response !== "network" && response.status === 401)) response = await attempt();
  if (response === "network") return failure("network");
  if (response === "no_token") return failure("unauthorized");
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (response.ok && typeof body.evidenceId === "string") {
    return {
      ok: true,
      evidenceId: body.evidenceId,
      duplicate: body.duplicate === true,
      extractionStatus: typeof body.extractionStatus === "string" ? body.extractionStatus : "unknown",
    };
  }
  return failure(reasonFor(response.status, body.error));
}

export type EvidenceFile =
  | { kind: "image"; blob: Blob; mime: SniffedMime }
  | { kind: "download_only"; blob: Blob; mime: SniffedMime | null; fileName: string | null }
  | { kind: "error"; reason: "unauthorized" | "not_found" | "rate_limited" | "offline" | "network" | "not_configured"; message: string };

const FILE_MESSAGES = {
  unauthorized: "Your session expired. Sign in again to see this file.",
  not_found: "This file isn't available. It may have been cleared or deleted.",
  rate_limited: "Too many file downloads in a short time. Wait a minute and try again.",
  offline: "You're offline. The file can be shown when you're back online.",
  network: "The file couldn't be fetched. Try again.",
  not_configured: "Files aren't available on this deployment.",
} as const;

/** The file name from `Content-Disposition` (RFC 5987 form first). */
function fileNameFrom(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      /* fall through to the ASCII form */
    }
  }
  const plain = /filename="([^"]*)"/i.exec(header);
  return plain ? plain[1] : null;
}

/**
 * Fetches one evidence file (owner-only on the server). DA-A-28b: `kind: "image"` ONLY when the server's type is a
 * previewable image AND the downloaded bytes sniff as that same type; everything else is download-only.
 */
export async function fetchEvidenceFile(input: {
  evidenceId: string;
  getToken: () => Promise<string | null> | string | null;
  siteUrl?: string | null;
  fetchImpl?: Fetch;
  online?: boolean;
}): Promise<EvidenceFile> {
  const site = input.siteUrl === undefined ? evidenceSiteUrl() : input.siteUrl;
  if (!site) return { kind: "error", reason: "not_configured", message: FILE_MESSAGES.not_configured };
  if ((input.online ?? (typeof navigator === "undefined" ? true : navigator.onLine)) === false) {
    return { kind: "error", reason: "offline", message: FILE_MESSAGES.offline };
  }
  const doFetch = input.fetchImpl ?? fetch;
  const url = `${site}/evidence/file?id=${encodeURIComponent(input.evidenceId)}`;
  async function attempt(): Promise<Response | "network" | "unauthorized"> {
    const token = await input.getToken();
    if (!token) return "unauthorized";
    try {
      return await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      return "network";
    }
  }
  let response = await attempt();
  if (response !== "network" && response !== "unauthorized" && response.status === 401) response = await attempt();
  if (response === "network") return { kind: "error", reason: "network", message: FILE_MESSAGES.network };
  if (response === "unauthorized" || response.status === 401) return { kind: "error", reason: "unauthorized", message: FILE_MESSAGES.unauthorized };
  if (response.status === 429) return { kind: "error", reason: "rate_limited", message: FILE_MESSAGES.rate_limited };
  if (!response.ok) return { kind: "error", reason: "not_found", message: FILE_MESSAGES.not_found };

  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const sniffed = sniffMime(bytes);
  const declared = (response.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (sniffed !== null && PREVIEWABLE_MIMES.has(sniffed) && declared === sniffed) {
    return { kind: "image", blob: new Blob([blob], { type: sniffed }), mime: sniffed };
  }
  return { kind: "download_only", blob: new Blob([blob], { type: "application/octet-stream" }), mime: sniffed, fileName: fileNameFrom(response.headers.get("Content-Disposition")) };
}
