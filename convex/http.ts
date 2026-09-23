import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { components, internal } from "./_generated/api";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { auth } from "./auth";
import { agentmail } from "./mail";
import { logEvent } from "./lib/log";
import { sanitizeError } from "./lib/errors";
import { containsPan } from "./lib/pan";
import { ACCEPTED_MIMES, EXTENSION, pdfLooksEncrypted, pdfRawText, sniffMime, type SniffedMime } from "./lib/sniff";
import { parseDocTypeHeader } from "./evidence";
import { MAX_UPLOAD_BYTES } from "./limits";
import { DEV_DEPLOYMENT_MARKER, isDevDeployment } from "./lib/deploymentIdentity";

const http = httpRouter();

auth.addHttpRoutes(http);

/** Always the same shape for a rejected webhook delivery (F-T22-1): 401, empty body, nothing about why leaked to the caller. */
function webhookRejected(reason: string): Response {
  logEvent("webhook_rejected", { reason });
  return new Response(null, { status: 401 });
}

http.route({
  path: "/agentmail/webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    // F-T22-1: fail closed with 401 whenever the deployment has no webhook
    // secret configured, BEFORE ever calling into the component. The
    // component's own `AgentMail` instance (convex/mail.ts) captures
    // `AGENTMAIL_WEBHOOK_SECRET` once at module construction and its
    // `assertConfigured("webhook")` throws a plain `Error` when that
    // captured value is empty -- left uncaught, that becomes an unhandled
    // exception and Convex turns it into a 500 with the deployment's own
    // stack trace, not a clean 401. Checked by name only; the value itself
    // is never read into a log line, only whether it is present.
    if (!process.env.AGENTMAIL_WEBHOOK_SECRET) {
      return webhookRejected("webhook_secret_not_configured");
    }
    let res: Response;
    try {
      // Cast: @agentmail/convex@0.1.0's RunMutationCtx type predates the
      // `runMutation(fn, args, options)` transactionLimits overload convex
      // 1.46 added to GenericActionCtx, so the structural check between the
      // two `runMutation` signatures fails even though the runtime call here
      // (`ctx.runMutation(fn, args)`, no options) is fully compatible.
      res = await agentmail.handleWebhook(
        ctx as unknown as Parameters<typeof agentmail.handleWebhook>[0],
        req,
      );
    } catch (err) {
      // Any other failure inside the component (a bad signature the
      // component itself throws instead of returning, a parse error, an
      // unexpected shape) -- never a 500, never the raw error back to the
      // caller. `sanitizeError` reduces it to one of a small set of
      // user-safe categories before it ever reaches the log line.
      return webhookRejected(sanitizeError(err instanceof Error ? err.message : String(err)));
    }
    // The component's own signature-verification failure returns a 401
    // itself (with a body of "invalid signature") rather than throwing;
    // normalize it to the same empty-body shape as every other rejection.
    if (res.status === 401) {
      return webhookRejected("invalid_signature");
    }
    return res;
  }),
});

/**
 * One-click unsubscribe (T06, contract T06(g).5). Mail scanners prefetch GET
 * links, so GET must never itself unsubscribe -- it only returns a page
 * whose POST form does. The token travels as a query param on both verbs
 * (not a form field), truncated defensively before it ever reaches a
 * database lookup. Both verbs always answer 200 and never reveal whether the
 * token was valid, so this endpoint cannot be used to probe token guesses.
 */
const UNSUBSCRIBE_TOKEN_MAX_CHARS = 128;

function unsubscribeTokenFrom(url: URL): string | null {
  const raw = url.searchParams.get("token");
  if (!raw) return null;
  const token = raw.slice(0, UNSUBSCRIBE_TOKEN_MAX_CHARS);
  return token.length > 0 ? token : null;
}

http.route({
  path: "/alerts/unsubscribe",
  method: "GET",
  handler: httpAction(async (_ctx, req) => {
    const url = new URL(req.url);
    const token = unsubscribeTokenFrom(url) ?? "";
    const action = `/alerts/unsubscribe?token=${encodeURIComponent(token)}`;
    const html = [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Unsubscribe from Recoup price alerts</title></head><body>",
      "<p>Stop receiving Recoup price alert emails?</p>",
      `<form method="POST" action="${action}"><button type="submit">Unsubscribe</button></form>`,
      "</body></html>",
    ].join("");
    // GET writes nothing: no ctx.runMutation call on this branch.
    return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  }),
});

http.route({
  path: "/alerts/unsubscribe",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const token = unsubscribeTokenFrom(new URL(req.url));
    if (token) {
      try {
        await ctx.runMutation(internal.alerts.unsubscribeByToken, { token });
      } catch (err) {
        // Never surface an error to the caller (would leak state); log and still answer 200.
        // T24c (D109): structured, redacted line instead of a bare console.error.
        logEvent("notification_failed", { route: "/alerts/unsubscribe", error: sanitizeError(err instanceof Error ? err.message : String(err)) });
      }
    }
    return new Response("You will no longer receive price alert emails from Recoup.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }),
});

// ---------------------------------------------------------------------------
// Evidence upload / download (M13; contract rev 5 §2.6; SEC-UP-1/2/3/5/6/8; DA-A-8/28)
// ---------------------------------------------------------------------------

export const EVIDENCE_UPLOAD_PATH = "/evidence/upload";
export const EVIDENCE_FILE_PATH = "/evidence/file";

/**
 * DA-A-28c: the Vite dev server's origin is allowed ONLY when this deployment is the dev deployment (D62:
 * `adorable-lion-138`). `DEV_DEPLOYMENT_MARKER`/`isDevDeployment` now live in `./lib/deploymentIdentity` (QA2-3:
 * `convex/lib/providerMode.ts` needs the same positive-match helper and cannot import it from here -- see that
 * module's doc comment) and are re-exported below (not `export … from`, so the import above and this stay one
 * binding) so every existing import of them from `./http` keeps working.
 */
export { DEV_DEPLOYMENT_MARKER, isDevDeployment };
export const DEV_FRONTEND_ORIGIN = "http://localhost:5173";

function httpsOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Origins a browser may call the evidence routes from: the app's own https origins, plus localhost on dev only. */
export function allowedOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  const origins = new Set<string>();
  for (const raw of [env.SITE_URL, env.APP_URL, env.CONVEX_SITE_URL]) {
    const origin = httpsOrigin(raw);
    if (origin) origins.add(origin);
  }
  if (isDevDeployment(env.CONVEX_SITE_URL)) origins.add(DEV_FRONTEND_ORIGIN);
  return origins;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  if (origin && allowedOrigins().has(origin)) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": "Content-Disposition, Content-Type" };
  }
  return { Vary: "Origin" };
}

function jsonResponse(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(req) },
  });
}

/** Identical for a missing, malformed, foreign, content-deleted or file-less id (SEC-UP-5): nothing to probe. */
const NOT_FOUND = { error: "not_found" };
/** Identical for signed-out and tombstoned callers. */
const UNAUTHORIZED = { error: "unauthorized" };

/**
 * DA-A-28a: `Content-Disposition` with an ASCII fallback AND the RFC 5987/6266 UTF-8 form, so "reçu.pdf" downloads
 * as "reçu.pdf" while an old client still gets a safe name. Quotes, backslashes and non-printable ASCII never reach
 * the quoted fallback; the stored name was already sanitized at finalize.
 */
export function contentDisposition(fileName: string | null, mime: SniffedMime): string {
  const name = fileName ?? `evidence.${EXTENSION[mime]}`;
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Reads at most `max` bytes of the body, never buffering past it. `"too_large"` as soon as it is exceeded. */
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | "too_large"> {
  if (req.body === null) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Longest `X-File-Name` header passed on (percent-encoded UTF-8 of a 200-character name fits many times over). */
const MAX_FILE_NAME_HEADER_CHARS = 4096;

/**
 * `POST /evidence/upload` — the ONLY way a file enters Recoup (§2.6):
 *   1. bearer auth → the caller, or 401 (identical for signed-out and tombstoned);
 *   2. `X-Doc-Type` (optional, closed list; DA-A-8) → 400 if not on it; `Content-Length` required and ≤ 10 MB,
 *      chunked uploads without a length refused → 413, all before the body is read;
 *   3. the per-user limiter and quotas (SEC-UP-8) → 429, nothing stored;
 *   4. the body is streamed with a hard cap → 413; its type is decided by magic bytes → 415 for anything but PDF,
 *      JPEG, PNG, WebP, HEIC/HEIF;
 *   5. `ctx.storage.store`, then `evidence.finalizeUpload` binds it (dedupe, byte quota from `_storage.size`,
 *      extraction gate). A refusal or failure after storing deletes only the blob this request stored.
 * Response: `{ evidenceId, duplicate, extractionStatus }`. Never a URL.
 */
const uploadEvidence = httpAction(async (ctx, req) => {
  const userId = await ctx.runQuery(internal.evidence.httpCaller, {});
  if (userId === null) return jsonResponse(req, 401, UNAUTHORIZED);

  const declaredDocType = parseDocTypeHeader(req.headers.get("X-Doc-Type"));
  if (declaredDocType === null) return jsonResponse(req, 400, { error: "unknown_doc_type" });
  const lengthHeader = req.headers.get("Content-Length");
  const chunked = /chunked/i.test(req.headers.get("Transfer-Encoding") ?? "");
  if (lengthHeader === null || chunked || !/^\d{1,9}$/.test(lengthHeader.trim())) {
    return jsonResponse(req, 413, { error: "length_required", maxBytes: MAX_UPLOAD_BYTES });
  }
  const declaredLength = Number(lengthHeader.trim());
  if (declaredLength > MAX_UPLOAD_BYTES) return jsonResponse(req, 413, { error: "too_large", maxBytes: MAX_UPLOAD_BYTES });
  if (declaredLength === 0) return jsonResponse(req, 400, { error: "empty" });

  const admitted = await ctx.runMutation(internal.evidence.admitUpload, { userId });
  if (admitted !== "ok") return jsonResponse(req, 429, { error: admitted });

  const bytes = await readCapped(req, Math.min(declaredLength, MAX_UPLOAD_BYTES));
  if (bytes === "too_large") return jsonResponse(req, 413, { error: "too_large", maxBytes: MAX_UPLOAD_BYTES });
  if (bytes.byteLength !== declaredLength) return jsonResponse(req, 400, { error: "length_mismatch" });
  const mime = sniffMime(bytes);
  if (mime === null) return jsonResponse(req, 415, { error: "unsupported_type", accepted: ACCEPTED_MIMES });

  // DA-A-8 / SEC-UP-3: decided from the bytes before anything is stored; never from a client claim.
  const isPdf = mime === "application/pdf";
  const encrypted = isPdf && pdfLooksEncrypted(bytes);
  const panDetected = isPdf && containsPan(pdfRawText(bytes));
  const rawName = req.headers.get("X-File-Name");

  const storageId = await ctx.storage.store(new Blob([bytes], { type: mime }));
  let result;
  try {
    result = await ctx.runMutation(internal.evidence.finalizeUpload, {
      userId,
      storageId,
      fileName: rawName === null ? undefined : rawName.slice(0, MAX_FILE_NAME_HEADER_CHARS),
      sniffedMime: mime,
      declaredDocType,
      encrypted,
      panDetected,
    });
  } catch (err) {
    await ctx.runMutation(internal.evidence.discardUnboundUpload, { storageId });
    logEvent("extraction_failed", { route: EVIDENCE_UPLOAD_PATH, error: sanitizeError(err instanceof Error ? err.message : String(err)) });
    return jsonResponse(req, 500, { error: "upload_failed" });
  }
  if (result.outcome === "refused") {
    return result.reason === "unauthorized" ? jsonResponse(req, 401, UNAUTHORIZED) : jsonResponse(req, 429, { error: result.reason });
  }
  return jsonResponse(req, 200, {
    evidenceId: result.evidenceId,
    duplicate: result.duplicate,
    extractionStatus: result.extractionStatus,
  });
});

/**
 * `GET /evidence/file?id=<evidenceId>` — the ONLY way a file leaves Recoup (SEC-UP-5; no `getUrl` anywhere):
 * bearer auth → 401; the per-user download limiter → 429; owner, retention and file checks → one identical 404;
 * then the bytes, as an attachment of the type sniffed at upload, with `nosniff`, no caching and a sandboxing CSP.
 */
const downloadEvidence = httpAction(async (ctx, req) => {
  const userId = await ctx.runQuery(internal.evidence.httpCaller, {});
  if (userId === null) return jsonResponse(req, 401, UNAUTHORIZED);
  if (!(await ctx.runMutation(internal.evidence.admitDownload, { userId }))) return jsonResponse(req, 429, { error: "rate_limited" });
  const id = (new URL(req.url).searchParams.get("id") ?? "").slice(0, 64);
  const target = await ctx.runQuery(internal.evidence.downloadTarget, { userId, evidenceId: id });
  if (target === null) return jsonResponse(req, 404, NOT_FOUND);
  const blob = await ctx.storage.get(target.storageId);
  if (blob === null) return jsonResponse(req, 404, NOT_FOUND);
  const mime = (ACCEPTED_MIMES as readonly string[]).includes(target.mimeType) ? (target.mimeType as SniffedMime) : null;
  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": mime ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(target.fileName, mime ?? "application/pdf"),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      ...corsHeaders(req),
    },
  });
});

/** CORS preflight for both evidence routes: answered only for an allowed origin (DA-A-28c). */
const evidencePreflight = httpAction(async (_ctx, req) => {
  const origin = req.headers.get("Origin");
  if (!origin || !allowedOrigins().has(origin)) return new Response(null, { status: 204, headers: { Vary: "Origin" } });
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Doc-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
});

http.route({ path: EVIDENCE_UPLOAD_PATH, method: "POST", handler: uploadEvidence });
http.route({ path: EVIDENCE_UPLOAD_PATH, method: "OPTIONS", handler: evidencePreflight });
http.route({ path: EVIDENCE_FILE_PATH, method: "GET", handler: downloadEvidence });
http.route({ path: EVIDENCE_FILE_PATH, method: "OPTIONS", handler: evidencePreflight });

// Must be last: exact routes above win over the static catch-all.
registerStaticRoutes(http, components.staticHosting);

export default http;
