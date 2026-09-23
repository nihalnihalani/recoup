/**
 * Evidence: the documents and messages a user gives Recoup (M13; contract rev 5 §2.6, §7; security baseline
 * SEC-UP-1…8, SEC-SD-2, SEC-AI-6; DA-A-8/20/27/28).
 *
 * **One upload path.** Files arrive only through the authenticated `POST /evidence/upload` httpAction
 * (`convex/http.ts`), which stores the blob itself and hands its id to `finalizeUpload` below. No public function
 * accepts a `_storage` id, so no caller can attach, read or delete a blob it did not just upload (SEC-UP-1). A
 * refusal after storing deletes only the blob THAT request stored.
 *
 * **One download path.** `GET /evidence/file?id=` (owner-checked, rate-limited, `attachment` + `nosniff`). Nothing
 * here ever calls `ctx.storage.getUrl`: a Convex file URL is a bearer credential (SEC-UP-5).
 *
 * **Extraction is gated (DA-A-8, D145).** The status a new upload gets says why it will or will not be read
 * automatically, in this order: HEIC/HEIF → `unreadable` (the model provider cannot read them, DA-A-28e); an encrypted
 * PDF → `needs_unlocked_copy` (no password is ever asked for); a card number found in the file's bytes → `store_only`,
 * whatever is declared now or later (P08-W1); no user-declared document type → `awaiting_doc_type`; a card statement
 * → `store_only`; live extraction switched off (`live_document_extraction`, D145) → `store_only` and an
 * `extraction_refused` log line; otherwise `not_requested`, and M23's extraction (below) queues it once it is linked
 * to a transaction.
 */
import { ConvexError, v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { evidenceDocType, evidenceLocator, extractionStatus as extractionStatusValidator, factValue, quoteStatus as quoteStatusValidator } from "./schema";
import { putFact, readCellRows } from "./lib/facts/write";
import { isTombstoned } from "./lib/accountState";
import { assertSameTransaction, ownedEvidence, ownedTransaction, requireUserId } from "./lib/access";
import { rateLimiter } from "./lib/rateLimits";
import { tryConsumeBudget, tryConsumeGlobalBudget, utcDay } from "./lib/budget";
import { isFlagOn } from "./lib/flags";
import { logEvent } from "./lib/log";
import { isHeicFamily, type SniffedMime } from "./lib/sniff";
import { maskPans } from "./lib/pan";
import { chargeStoredBytes, storedBytes } from "./lib/blobRefs";
import { sha256Hex } from "./lib/canonical";
import {
  DAILY_BUDGETS,
  EVIDENCE_BYTES_PER_USER_PER_DAY,
  EVIDENCE_UPLOADS_PER_DAY,
  GLOBAL_DAILY_BUDGETS,
  MAX_EVIDENCE_BYTES_PER_USER,
  MAX_EVIDENCE_FILE_NAME_CHARS,
  MAX_EVIDENCE_ROWS_PER_USER,
  MAX_EVIDENCE_TEXT_CHARS,
} from "./limits";

export type EvidenceDocType = Infer<typeof evidenceDocType>;
export type ExtractionStatus = Infer<typeof extractionStatusValidator>;

/** `usage` kinds (per user, per UTC day) for the SEC-UP-8 quotas; the global byte switch is `evidence_bytes`. */
export const UPLOAD_COUNT_KIND = "evidence_uploads";
export const UPLOAD_BYTES_KIND = "evidence_bytes";
/**
 * The per-user evidence row cap is counted on one `usage` row that is never reset (evidence rows are never deleted
 * except by the account purge, which also deletes `usage`), so the cap costs one indexed read instead of reading up
 * to 1,000 evidence documents of up to 60 KB each.
 */
export const EVIDENCE_ROWS_KIND = "evidence_rows";
export const LIFETIME_DAY = "lifetime";

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The declared types that do not count as a declaration (DA-A-8): extraction waits for the user's choice. */
const UNDECLARED: ReadonlySet<EvidenceDocType> = new Set<EvidenceDocType>(["unknown", "other"]);

/** Every `evidenceDocType` literal, read from the schema validator so the two never drift. */
export const EVIDENCE_DOC_TYPES: readonly EvidenceDocType[] = (evidenceDocType.members as ReadonlyArray<{ value: EvidenceDocType }>).map(
  (m) => m.value,
);

/** Parses an `X-Doc-Type` header value against the closed list; `undefined` for absent, `null` for invalid. */
export function parseDocTypeHeader(raw: string | null): EvidenceDocType | undefined | null {
  if (raw === null) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  return (EVIDENCE_DOC_TYPES as readonly string[]).includes(value) ? (value as EvidenceDocType) : null;
}

/**
 * DA-A-28a + rev 3: `X-File-Name` arrives percent-encoded UTF-8 (browsers refuse non-Latin-1 header values). Decode
 * it, then strip control characters, quotes, backslashes, slashes and semicolons (none may reach a
 * `Content-Disposition` header or a path), collapse whitespace and bound it. Malformed encoding or nothing left →
 * `undefined` (the download then gets a generic name).
 */
export function sanitizeFileName(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.slice(0, MAX_EVIDENCE_FILE_NAME_CHARS * 12));
  } catch {
    return undefined;
  }
  const cleaned = decoded
    .replace(/[\p{Cc}\p{Cf}"'`\\/;]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const bounded = Array.from(cleaned).slice(0, MAX_EVIDENCE_FILE_NAME_CHARS).join("").trim();
  return bounded.length > 0 && bounded !== "." && bounded !== ".." ? bounded : undefined;
}

/**
 * DA-A-27: `contentHash` is lowercase hex SHA-256. `_storage.sha256` is base64 in convex-test (and the hex comment in
 * the Convex types sits on the deprecated `FileMetadata`), so it is normalized here whatever the encoding: 64 hex
 * characters pass through lowercased; anything else must be base64 of 32 bytes.
 */
export function normalizeSha256(raw: string): string {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed.toLowerCase();
  let binary: string;
  try {
    binary = atob(trimmed.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("Unrecognized sha256 encoding");
  }
  if (binary.length !== 32) throw new Error("Unrecognized sha256 encoding");
  let hex = "";
  for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** Fixed summaries. `STATUS_SUMMARY.pan` doubles as the sticky marker `declareDocType` reads (see there). */
export const STATUS_SUMMARY = {
  heic: "HEIC photos are stored and can be downloaded, but they are never read automatically. Convert it to JPEG or PNG to have it read.",
  encrypted: "This PDF is password-protected. Upload an unlocked copy to have it read; Recoup never asks for the password.",
  awaitingDocType: "Choose what kind of document this is before anything is read from it.",
  statement: "Card statements are stored only and never read automatically.",
  pan: "This file shows what looks like a full card number, so it is stored only and never read automatically.",
  extractionOff: "Automatic reading of uploaded documents is switched off, so this file is stored only.",
} as const;

export type StatusDecision = { status: ExtractionStatus; summary?: string; refusedByFlag: boolean };

/**
 * The extraction gate for an uploaded file, in the order the module doc lists. Pure: every input is decided by the
 * caller (sniffed type, the scans the upload route ran, the user's declaration, the flag).
 */
export function uploadExtractionStatus(input: {
  mime: SniffedMime;
  declaredDocType: EvidenceDocType | undefined;
  encrypted: boolean;
  panDetected: boolean;
  liveExtractionOn: boolean;
}): StatusDecision {
  if (isHeicFamily(input.mime)) return { status: "unreadable", summary: STATUS_SUMMARY.heic, refusedByFlag: false };
  if (input.encrypted) return { status: "needs_unlocked_copy", summary: STATUS_SUMMARY.encrypted, refusedByFlag: false };
  // P08-W1: a card number outranks the declaration (and its absence), so the sticky marker is recorded at once and a
  // type declared later never unlocks the file (`isStickyBlock`).
  if (input.panDetected) return { status: "store_only", summary: STATUS_SUMMARY.pan, refusedByFlag: false };
  if (input.declaredDocType === undefined || UNDECLARED.has(input.declaredDocType)) {
    return { status: "awaiting_doc_type", summary: STATUS_SUMMARY.awaitingDocType, refusedByFlag: false };
  }
  if (input.declaredDocType === "card_statement") return { status: "store_only", summary: STATUS_SUMMARY.statement, refusedByFlag: false };
  if (!input.liveExtractionOn) return { status: "store_only", summary: STATUS_SUMMARY.extractionOff, refusedByFlag: true };
  return { status: "not_requested", refusedByFlag: false };
}

/** Statuses that only a new file can change: re-declaring the type never unlocks them. */
function isStickyBlock(row: Doc<"evidence">): boolean {
  return (
    row.extractionStatus === "unreadable" ||
    row.extractionStatus === "needs_unlocked_copy" ||
    (row.extractionStatus === "store_only" && row.extractionSummary === STATUS_SUMMARY.pan)
  );
}

/** Statuses before any extraction was attempted; only these are recomputed by `declareDocType`. */
const PRE_EXTRACTION: ReadonlySet<ExtractionStatus> = new Set<ExtractionStatus>(["awaiting_doc_type", "store_only", "not_requested"]);

// ---------------------------------------------------------------------------
// Row writes shared with intake
// ---------------------------------------------------------------------------

/**
 * Reserves one row of the user's evidence cap (`MAX_EVIDENCE_ROWS_PER_USER`) on the never-reset counter. Returns
 * false at the cap, writing nothing. Every evidence insert goes through this.
 */
export async function reserveEvidenceRow(ctx: MutationCtx, userId: Id<"users">): Promise<boolean> {
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", LIFETIME_DAY).eq("kind", EVIDENCE_ROWS_KIND))
    .first();
  const used = row?.count ?? 0;
  if (used >= MAX_EVIDENCE_ROWS_PER_USER) return false;
  if (row) await ctx.db.patch(row._id, { count: used + 1 });
  else await ctx.db.insert("usage", { userId, day: LIFETIME_DAY, kind: EVIDENCE_ROWS_KIND, count: 1 });
  return true;
}

/** Rows counted against `MAX_EVIDENCE_ROWS_PER_USER` so far (reads only). */
async function evidenceRowsUsed(ctx: MutationCtx, userId: Id<"users">): Promise<number> {
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", LIFETIME_DAY).eq("kind", EVIDENCE_ROWS_KIND))
    .first();
  return row?.count ?? 0;
}

/** The user's live (not content-deleted) evidence rows with this hash, and the newest cleared one (DA-A-20). */
export async function findByHash(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  contentHash: string,
): Promise<{ active: Doc<"evidence"> | null; cleared: Doc<"evidence"> | null }> {
  // Owner-scoped only (SEC-UP-6): another user's identical bytes are never seen, so no response can differ by them.
  const rows = await ctx.db
    .query("evidence")
    .withIndex("by_user_and_content_hash", (q) => q.eq("userId", userId).eq("contentHash", contentHash))
    .order("desc")
    .take(20);
  return {
    active: rows.find((r) => r.retention === "active") ?? null,
    cleared: rows.find((r) => r.retention === "content_deleted") ?? null,
  };
}

// ---------------------------------------------------------------------------
// Text evidence: forwarded and pasted email (contract §7; D142; SEC-AI-6)
// ---------------------------------------------------------------------------

/** Tags every fact and evidence row the wave-1 inbound-email extraction (`intake.processEvent`) produced. */
export const TEXT_EXTRACTOR_VERSION = "intake_email_v1";

export type EvidenceProvenance = Doc<"evidence">["provenance"];

/**
 * §2.6: the content hash of text evidence is the hex SHA-256 of the MASKED, whitespace-normalized text, so the same
 * email forwarded twice, or forwarded and pasted, is one row, and a card number never reaches the hash (D142).
 */
export async function textContentHash(text: string): Promise<string> {
  return await sha256Hex(maskPans(text).replace(/\s+/g, " ").trim());
}

/** Provenance a later, identical submission may upgrade to: the user now stands behind content a stranger sent. */
const USER_PROVENANCE: ReadonlySet<EvidenceProvenance> = new Set<EvidenceProvenance>(["user_forwarded", "user_pasted"]);

/**
 * Records one forwarded or pasted email as evidence and returns its id, or null when the account is at its evidence
 * row cap (intake then continues without it; nothing is lost that the processed event does not still hold).
 *
 * Everything stored is masked first (D142). Dedupe is owner-scoped on the content hash against ACTIVE rows; a row
 * whose content retention cleared is revived with the new text and a fresh `receivedAt` (DA-A-20, D163). If the same
 * content first arrived from an unverified sender and the user now forwards or pastes it themselves, the row's
 * provenance is upgraded — the user, not the sender, now stands behind it (SEC-AI-6).
 */
export async function recordTextEvidence(
  ctx: MutationCtx,
  input: {
    userId: Id<"users">;
    kind: "email" | "paste";
    provenance: EvidenceProvenance;
    /** DA-B-3 / D194: the inbound email's sender-authentication verdict (always "unavailable" today). */
    senderAuth?: Doc<"evidence">["senderAuth"];
    text: string;
    headers?: { from?: string; subject?: string; date?: string; messageId?: string };
    processedEventId: Id<"processedEvents">;
    docType: EvidenceDocType;
  },
): Promise<Id<"evidence"> | null> {
  const text = maskPans(input.text).slice(0, MAX_EVIDENCE_TEXT_CHARS);
  const contentHash = await textContentHash(text);
  const headers =
    input.headers === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(input.headers)
            .filter(([, v]) => typeof v === "string" && v.length > 0)
            .map(([k, v]) => [k, maskPans(v as string).slice(0, 500)]),
        );
  const now = Date.now();
  const classified = input.docType !== "unknown" && input.docType !== "other";
  const { active, cleared } = await findByHash(ctx, input.userId, contentHash);
  if (active !== null) {
    if (active.provenance === "unverified_sender" && USER_PROVENANCE.has(input.provenance)) {
      await ctx.db.patch(active._id, { provenance: input.provenance });
    }
    return active._id;
  }
  if (cleared !== null && (cleared.kind === "email" || cleared.kind === "paste")) {
    await ctx.db.patch(cleared._id, {
      text,
      retention: "active",
      receivedAt: now,
      processedEventId: input.processedEventId,
      ...(input.senderAuth !== undefined ? { senderAuth: input.senderAuth } : {}),
      ...(USER_PROVENANCE.has(input.provenance) ? { provenance: input.provenance } : {}),
    });
    return cleared._id;
  }
  if (!(await reserveEvidenceRow(ctx, input.userId))) return null;
  return await ctx.db.insert("evidence", {
    userId: input.userId,
    kind: input.kind,
    docType: input.docType,
    ...(classified ? { docTypeDeclaredBy: "classifier" as const } : {}),
    sourceChannel: input.kind === "email" ? "agentmail_forward" : "paste",
    provenance: input.provenance,
    ...(input.senderAuth !== undefined ? { senderAuth: input.senderAuth } : {}),
    processedEventId: input.processedEventId,
    contentHash,
    text,
    ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    receivedAt: now,
    extractionStatus: "succeeded",
    extractionAttempts: 1,
    extractorVersion: TEXT_EXTRACTOR_VERSION,
    hasTextLayer: true,
    retention: "active",
  });
}

// ---------------------------------------------------------------------------
// Upload plumbing (internal; the httpAction in http.ts is the only caller)
// ---------------------------------------------------------------------------

/** The signed-in, non-tombstoned caller of an httpAction, or null (→ 401, identical body either way). */
export const httpCaller = internalQuery({
  args: {},
  returns: v.union(v.id("users"), v.null()),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || (await isTombstoned(ctx, userId))) return null;
    return userId;
  },
});

/**
 * Step 2 of the upload (SEC-UP-8), before the body is read: the per-user upload limiter, the per-user daily upload
 * count, and a pre-check that neither the user's daily byte quota nor the global byte switch (`evidence_bytes`,
 * `ops.pauseKind`) is already spent. The byte quotas themselves are charged at finalize from `_storage.size`
 * (DA-A-28f). A refusal writes nothing the caller could use and stores nothing.
 */
export const admitUpload = internalMutation({
  args: { userId: v.id("users") },
  returns: v.union(v.literal("ok"), v.literal("rate_limited"), v.literal("quota")),
  handler: async (ctx, { userId }) => {
    const limit = await rateLimiter.limit(ctx, "evidenceUpload", { key: userId });
    if (!limit.ok) return "rate_limited";
    const now = Date.now();
    if (await bytesExhausted(ctx, userId, 1, now)) return "quota";
    if (!(await tryConsumeBudget(ctx, userId, UPLOAD_COUNT_KIND, EVIDENCE_UPLOADS_PER_DAY, now))) return "quota";
    return "ok";
  },
});

async function usageCount(ctx: MutationCtx, userId: Id<"users"> | undefined, kind: string, day: string): Promise<number> {
  const row = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", kind))
    .first();
  return row?.count ?? 0;
}

/** Would `bytes` more exceed the user's daily byte quota or the global byte switch today? Reads only. */
async function bytesExhausted(ctx: MutationCtx, userId: Id<"users">, bytes: number, now: number): Promise<boolean> {
  const day = utcDay(now);
  if ((await usageCount(ctx, userId, UPLOAD_BYTES_KIND, day)) + bytes > EVIDENCE_BYTES_PER_USER_PER_DAY) return true;
  return (await usageCount(ctx, undefined, "evidence_bytes", day)) + bytes > GLOBAL_DAILY_BUDGETS.evidence_bytes.max;
}

/**
 * Charges `bytes` against the global switch (the normal budget path, so `ops.pauseKind("evidence_bytes")` refuses
 * it) and then the user's daily byte quota. All or nothing: a refusal leaves both counters untouched.
 */
async function chargeBytes(ctx: MutationCtx, userId: Id<"users">, bytes: number, now: number): Promise<boolean> {
  const day = utcDay(now);
  const userRow = await ctx.db
    .query("usage")
    .withIndex("by_user_day_kind", (q) => q.eq("userId", userId).eq("day", day).eq("kind", UPLOAD_BYTES_KIND))
    .first();
  const userUsed = userRow?.count ?? 0;
  if (userUsed + bytes > EVIDENCE_BYTES_PER_USER_PER_DAY) return false;
  if (!(await tryConsumeGlobalBudget(ctx, "evidence_bytes", GLOBAL_DAILY_BUDGETS.evidence_bytes.max, bytes, now))) return false;
  if (userRow) await ctx.db.patch(userRow._id, { count: userUsed + bytes });
  else await ctx.db.insert("usage", { userId, day, kind: UPLOAD_BYTES_KIND, count: bytes });
  return true;
}

const finalizeResult = v.union(
  v.object({
    outcome: v.literal("stored"),
    evidenceId: v.id("evidence"),
    duplicate: v.boolean(),
    extractionStatus: extractionStatusValidator,
  }),
  v.object({ outcome: v.literal("refused"), reason: v.union(v.literal("unauthorized"), v.literal("quota"), v.literal("row_cap")) }),
);

/**
 * Step 5 of the upload: binds the blob THIS request stored to a row the caller owns. Re-checks the tombstone, reads
 * `_storage` server-side (size and hash never come from the client), normalizes the hash to hex (DA-A-27), dedupes
 * against the caller's own ACTIVE rows (DA-A-20), charges the byte quotas from `_storage.size` (DA-A-28f), and
 * decides the extraction status (DA-A-8). Every refusal and every duplicate deletes the blob this request stored —
 * never any other (SEC-UP-1/2).
 */
export const finalizeUpload = internalMutation({
  args: {
    userId: v.id("users"),
    storageId: v.id("_storage"),
    /** The raw `X-File-Name` header (percent-encoded UTF-8, DA-A-28a); decoded and sanitized here. */
    fileName: v.optional(v.string()),
    sniffedMime: v.union(
      v.literal("application/pdf"), v.literal("image/jpeg"), v.literal("image/png"), v.literal("image/webp"),
      v.literal("image/heic"), v.literal("image/heif"),
    ),
    declaredDocType: v.optional(evidenceDocType),
    encrypted: v.boolean(),
    panDetected: v.boolean(),
  },
  returns: finalizeResult,
  handler: async (ctx, args) => {
    const discard = async () => {
      // The blob was stored by the request that called this mutation, under this user's authentication. It is not
      // bound to any row (checked below before any bind), so deleting it can never remove another user's file.
      const bound = await ctx.db.query("evidence").withIndex("by_storage", (q) => q.eq("storageId", args.storageId)).first();
      if (bound === null && (await ctx.db.system.get("_storage", args.storageId)) !== null) {
        await ctx.storage.delete(args.storageId);
      }
    };
    if (await isTombstoned(ctx, args.userId)) {
      await discard();
      return { outcome: "refused" as const, reason: "unauthorized" as const };
    }
    const meta = await ctx.db.system.get("_storage", args.storageId);
    if (meta === null) throw new ConvexError("Upload not found");
    // SEC-UP-1: a storage id already bound to a row is never bound again (and never deleted from here).
    const alreadyBound = await ctx.db.query("evidence").withIndex("by_storage", (q) => q.eq("storageId", args.storageId)).first();
    if (alreadyBound !== null) throw new ConvexError("Upload already recorded");

    const contentHash = normalizeSha256(meta.sha256);
    const now = Date.now();
    const declaredDocType = args.declaredDocType;
    const liveExtractionOn = await isFlagOn(ctx, "live_document_extraction");
    const decision = uploadExtractionStatus({
      mime: args.sniffedMime,
      declaredDocType,
      encrypted: args.encrypted,
      panDetected: args.panDetected,
      liveExtractionOn,
    });
    const declared = declaredDocType !== undefined && !UNDECLARED.has(declaredDocType);

    const { active, cleared } = await findByHash(ctx, args.userId, contentHash);
    if (active !== null) {
      // The same bytes are already live on this account: link to that row, keep nothing new, charge no bytes.
      await discard();
      return { outcome: "stored" as const, evidenceId: active._id, duplicate: true, extractionStatus: active.extractionStatus };
    }

    // Every cap is checked (reads only) BEFORE anything is charged, so a refusal leaves every counter untouched:
    // the daily byte quotas (DA-A-28f), the per-user stored-bytes cap (D173, `MAX_EVIDENCE_BYTES_PER_USER`,
    // released by retention/purge through `lib/blobRefs.releaseEvidenceBlob`), and — for a new row — the row cap.
    const revive = cleared !== null && cleared.kind === "upload" ? cleared : null;
    if (
      (await bytesExhausted(ctx, args.userId, meta.size, now)) ||
      (await storedBytes(ctx, args.userId)) + meta.size > MAX_EVIDENCE_BYTES_PER_USER
    ) {
      await discard();
      return { outcome: "refused" as const, reason: "quota" as const };
    }
    if (revive === null && (await evidenceRowsUsed(ctx, args.userId)) >= MAX_EVIDENCE_ROWS_PER_USER) {
      await discard();
      return { outcome: "refused" as const, reason: "row_cap" as const };
    }
    // The charges, only now that the blob WILL be bound (a new row or a revive; never a duplicate or a refusal). They
    // cannot fail after the checks above in the same transaction; if one did, the throw rolls everything back and the
    // route deletes the blob.
    if (!(await chargeBytes(ctx, args.userId, meta.size, now))) throw new Error("evidence byte quota changed during finalize");
    if (!(await chargeStoredBytes(ctx, args.userId, meta.size))) throw new Error("stored-bytes cap changed during finalize");
    if (revive === null && !(await reserveEvidenceRow(ctx, args.userId))) throw new Error("evidence row cap changed during finalize");

    const fields = {
      mimeType: args.sniffedMime,
      sizeBytes: meta.size,
      fileName: sanitizeFileName(args.fileName),
      extractionStatus: decision.status,
      extractionSummary: decision.summary,
      ...(declared ? { docType: declaredDocType, docTypeDeclaredBy: "user" as const } : {}),
    };

    let evidenceId: Id<"evidence">;
    if (revive !== null) {
      // DA-A-20 + D163: the row whose content retention cleared comes back to life with the new blob, and its
      // retention clock restarts now.
      await ctx.db.patch(revive._id, {
        ...fields,
        storageId: args.storageId,
        retention: "active",
        receivedAt: now,
        extractionAttempts: 0,
        extractionStartedAt: undefined,
        extractorVersion: undefined,
      });
      evidenceId = revive._id;
    } else {
      evidenceId = await ctx.db.insert("evidence", {
        userId: args.userId,
        kind: "upload",
        docType: declared ? declaredDocType! : "unknown",
        ...(declared ? { docTypeDeclaredBy: "user" as const } : {}),
        sourceChannel: "upload",
        provenance: "user_uploaded",
        storageId: args.storageId,
        contentHash,
        mimeType: fields.mimeType,
        sizeBytes: fields.sizeBytes,
        fileName: fields.fileName,
        receivedAt: now,
        extractionStatus: decision.status,
        extractionSummary: decision.summary,
        extractionAttempts: 0,
        retention: "active",
      });
    }
    if (decision.refusedByFlag) {
      logEvent("extraction_refused", { evidenceId, flag: "live_document_extraction" });
    }
    // M23: a revived row may already be linked to a transaction; a new upload is linked later (attachToTransaction).
    const queued = await queueUploadIfEligible(ctx, evidenceId);
    return { outcome: "stored" as const, evidenceId, duplicate: false, extractionStatus: queued ? ("queued" as const) : decision.status };
  },
});

/**
 * Deletes a blob the upload route stored when `finalizeUpload` itself threw (the route's catch path). Only an
 * UNBOUND blob is deleted, so a caller can never use it to remove a file that belongs to a row.
 */
export const discardUnboundUpload = internalMutation({
  args: { storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, { storageId }) => {
    const bound = await ctx.db.query("evidence").withIndex("by_storage", (q) => q.eq("storageId", storageId)).first();
    if (bound === null && (await ctx.db.system.get("_storage", storageId)) !== null) await ctx.storage.delete(storageId);
    return null;
  },
});

// ---------------------------------------------------------------------------
// Download plumbing
// ---------------------------------------------------------------------------

/** The per-user download limiter (SEC-UP-5), consumed before the id is looked up. */
export const admitDownload = internalMutation({
  args: { userId: v.id("users") },
  returns: v.boolean(),
  handler: async (ctx, { userId }) => (await rateLimiter.limit(ctx, "evidenceDownload", { key: userId })).ok,
});

/**
 * The file behind one of the caller's evidence rows, or null. A malformed id, a missing row, another user's row, a
 * content-deleted row and a row with no file all return the same null (→ an identical 404).
 */
export const downloadTarget = internalQuery({
  args: { userId: v.id("users"), evidenceId: v.string() },
  returns: v.union(
    v.object({ storageId: v.id("_storage"), mimeType: v.string(), fileName: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  handler: async (ctx, { userId, evidenceId }) => {
    const id = ctx.db.normalizeId("evidence", evidenceId);
    if (id === null) return null;
    const row = await ctx.db.get(id);
    if (!row || row.userId !== userId || row.retention !== "active" || !row.storageId || !row.mimeType) return null;
    return { storageId: row.storageId, mimeType: row.mimeType, fileName: row.fileName ?? null };
  },
});

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** What an owner sees of one evidence row. No storage id and no URL-shaped field, ever (SEC-UP-5). */
const evidenceView = v.object({
  _id: v.id("evidence"),
  _creationTime: v.number(),
  transactionId: v.union(v.id("transactions"), v.null()),
  kind: v.string(),
  docType: evidenceDocType,
  docTypeDeclaredBy: v.union(v.literal("user"), v.literal("classifier"), v.null()),
  sourceChannel: v.string(),
  provenance: v.string(),
  contentHash: v.string(),
  mimeType: v.union(v.string(), v.null()),
  sizeBytes: v.union(v.number(), v.null()),
  fileName: v.union(v.string(), v.null()),
  hasFile: v.boolean(),
  text: v.union(v.string(), v.null()),
  headers: v.union(
    v.object({ from: v.optional(v.string()), subject: v.optional(v.string()), date: v.optional(v.string()), messageId: v.optional(v.string()) }),
    v.null(),
  ),
  receivedAt: v.number(),
  pinnedAt: v.union(v.number(), v.null()),
  extractionStatus: extractionStatusValidator,
  extractionSummary: v.union(v.string(), v.null()),
  retention: v.string(),
  isExample: v.boolean(),
});

function view(row: Doc<"evidence">) {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    transactionId: row.transactionId ?? null,
    kind: row.kind,
    docType: row.docType,
    docTypeDeclaredBy: row.docTypeDeclaredBy ?? null,
    sourceChannel: row.sourceChannel,
    provenance: row.provenance,
    contentHash: row.contentHash,
    mimeType: row.mimeType ?? null,
    sizeBytes: row.sizeBytes ?? null,
    fileName: row.fileName ?? null,
    hasFile: row.storageId !== undefined && row.retention === "active",
    text: row.text ?? null,
    headers: row.headers ?? null,
    receivedAt: row.receivedAt,
    pinnedAt: row.pinnedAt ?? null,
    extractionStatus: row.extractionStatus,
    extractionSummary: row.extractionSummary ?? null,
    retention: row.retention,
    isExample: row.isExample === true,
  };
}

/** One of the caller's evidence rows. A foreign or missing id → the identical "Evidence not found". */
export const get = query({
  args: { evidenceId: v.id("evidence") },
  returns: evidenceView,
  handler: async (ctx, { evidenceId }) => {
    const userId = await requireUserId(ctx);
    return view(await ownedEvidence(ctx, evidenceId, userId));
  },
});

/** `listForTransaction` returns at most this many rows (newest first) and says when there were more. */
export const EVIDENCE_LIST_LIMIT = 100;
/** `listRecent` accepts a `limit` from 1 to this. */
export const RECENT_UPLOADS_MAX = 20;

const CONTENT_CLEARED = "This document's content was cleared. Upload it again.";

/**
 * E-M24 (D220): the evidence on one of the caller's transactions, newest recorded first, at most
 * `EVIDENCE_LIST_LIMIT` rows plus `truncated`. A foreign or missing transaction → the identical "Transaction not
 * found" (the owner check runs before any evidence is read).
 */
export const listForTransaction = query({
  args: { transactionId: v.id("transactions") },
  returns: v.object({ evidence: v.array(evidenceView), truncated: v.boolean() }),
  handler: async (ctx, { transactionId }) => {
    const userId = await requireUserId(ctx);
    await ownedTransaction(ctx, transactionId, userId);
    const page = await ctx.db
      .query("evidence")
      .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
      .order("desc")
      .take(EVIDENCE_LIST_LIMIT + 1);
    // Rows are linked only to their owner's transactions; the filter keeps that true even if a row were ever wrong.
    const own = page.filter((row) => row.userId === userId);
    return { evidence: own.slice(0, EVIDENCE_LIST_LIMIT).map(view), truncated: page.length > EVIDENCE_LIST_LIMIT };
  },
});

/**
 * E-M24 (D220): link one of the caller's unattached documents to one of the caller's transactions. The same pair
 * again is a no-op (`changed: false`). Evidence already on ANOTHER transaction is refused, never moved: facts cite
 * evidence of their own transaction only (DA-A-29), and moving it would leave those citations pointing across
 * transactions. A document whose content was cleared cannot be newly attached. Foreign or missing ids → the identical
 * "Evidence not found" / "Transaction not found", before anything is written. This is the only way to attach an
 * existing document; the upload route takes no transaction.
 */
export const attachToTransaction = mutation({
  args: { evidenceId: v.id("evidence"), transactionId: v.id("transactions") },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, { evidenceId, transactionId }) => {
    const userId = await requireUserId(ctx);
    const row = await ownedEvidence(ctx, evidenceId, userId);
    await ownedTransaction(ctx, transactionId, userId);
    let link: "same" | "unlinked";
    try {
      link = assertSameTransaction(transactionId, row, { allowUnlinked: true, label: "Evidence" });
    } catch {
      throw new ConvexError("This document is already attached to another transaction.");
    }
    if (link === "same") return { changed: false };
    if (row.retention !== "active") throw new ConvexError(CONTENT_CLEARED);
    await ctx.db.patch(row._id, { transactionId });
    await queueUploadIfEligible(ctx, row._id);
    return { changed: true };
  },
});

/**
 * E-M24 (D220): the caller's own most recent uploads (kind `upload`), newest first. `limit` must be a whole number
 * from 1 to `RECENT_UPLOADS_MAX`.
 */
export const listRecent = query({
  args: { limit: v.number() },
  returns: v.array(evidenceView),
  handler: async (ctx, { limit }) => {
    const userId = await requireUserId(ctx);
    if (!Number.isInteger(limit) || limit < 1 || limit > RECENT_UPLOADS_MAX) {
      throw new ConvexError(`limit must be a whole number from 1 to ${RECENT_UPLOADS_MAX}`);
    }
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_user_and_kind_and_received_at", (q) => q.eq("userId", userId).eq("kind", "upload"))
      .order("desc")
      .take(limit);
    return rows.map(view);
  },
});

/**
 * DA-A-8: the user says what a document is. Any type other than `unknown`/`other` is a declaration
 * (`docTypeDeclaredBy: "user"`); `unknown`/`other` puts the row back to `awaiting_doc_type`. The extraction status is
 * recomputed only while nothing has been extracted yet, and never lifts a block only a new file can lift (HEIC, an
 * encrypted PDF, a card number in the file). The live-extraction flag is read here too, so declaring a type never
 * bypasses it.
 */
export const declareDocType = mutation({
  args: { evidenceId: v.id("evidence"), docType: evidenceDocType },
  returns: v.object({ extractionStatus: extractionStatusValidator }),
  handler: async (ctx, { evidenceId, docType }) => {
    const userId = await requireUserId(ctx);
    const row = await ownedEvidence(ctx, evidenceId, userId);
    if (row.retention !== "active") throw new ConvexError(CONTENT_CLEARED);
    const declared = !UNDECLARED.has(docType);
    const patch: Partial<Doc<"evidence">> = declared
      ? { docType, docTypeDeclaredBy: "user" }
      : { docType, docTypeDeclaredBy: undefined };
    let status = row.extractionStatus;
    if (row.kind === "upload" && row.mimeType && PRE_EXTRACTION.has(row.extractionStatus) && !isStickyBlock(row)) {
      const decision = uploadExtractionStatus({
        mime: row.mimeType as SniffedMime,
        declaredDocType: declared ? docType : undefined,
        encrypted: false,
        panDetected: false,
        liveExtractionOn: await isFlagOn(ctx, "live_document_extraction"),
      });
      status = decision.status;
      patch.extractionStatus = decision.status;
      patch.extractionSummary = decision.summary;
      if (decision.refusedByFlag && row.extractionStatus !== "store_only") {
        logEvent("extraction_refused", { evidenceId, flag: "live_document_extraction" });
      }
    }
    await ctx.db.patch(row._id, patch);
    if (await queueUploadIfEligible(ctx, row._id)) status = "queued";
    return { extractionStatus: status };
  },
});

/**
 * DA-A-7: keep (pin) or release a document past the retention window. Pinning is the user's choice and is disclosed
 * on the Privacy page (`lib/privacyFacts.ts`); releasing lets the normal 30-day rule apply again.
 */
export const setPinned = mutation({
  args: { evidenceId: v.id("evidence"), pinned: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { evidenceId, pinned }) => {
    const userId = await requireUserId(ctx);
    const row = await ownedEvidence(ctx, evidenceId, userId);
    await ctx.db.patch(row._id, { pinnedAt: pinned ? (row.pinnedAt ?? Date.now()) : undefined });
    return null;
  },
});

// ---------------------------------------------------------------------------
// Extraction (M23; D145, DA-A-6, DA-A-8, SEC-AI-1/2, SEC-UP-4, SEC-DEL-4; security baseline §7 P4)
// ---------------------------------------------------------------------------
//
// An upload is read only when ALL of these hold, re-checked at every step (queue, claim, completion):
//   - the server flag `live_document_extraction` is on (D145: off on every deployment until the user approves);
//   - the user declared what the document is (DA-A-8) and it is a type with a schema, but never a card statement;
//   - it is linked to one of the user's transactions (facts are always about a transaction);
//   - its content is still stored, and the account is not being deleted (SEC-DEL-4).
// The node action `evidenceExtract.extractUpload` does the reading: `lib/pdfText` for the text layer (the text-layer
// card-number pre-scan forces `store_only` before any model call), one `lib/ai.extract` call with the type's constant
// system prompt, then `lib/docFacts` locates and verifies every quote (DA-A-6). Photos and image-only PDFs have no
// deterministic text layer and are never sent to the model (SEC-SD-4: no document images to a provider before the
// Privacy disclosure says so). Email and paste text is read the same way by `intake.extractTextEvidence` (the
// second-stage classifier). Every extracted value becomes an `extracted_candidate` fact (SEC-AI-2).
//
// Each run holds a lease (`running` + `extractionStartedAt`). A run that does not finish within
// `EXTRACTION_LEASE_MS` is abandoned; `retryStalledExtractions` (the sweep M29 schedules) re-queues it, and after
// `MAX_EXTRACTION_ATTEMPTS` attempts the document ends `unreadable` (P4).

/** Tags every fact the M23 document extraction writes. */
export const DOCUMENT_EXTRACTOR_VERSION = "doc_extract_v1";
/** Attempts before a document that keeps failing (or timing out) is given up on (security baseline §7 P4). */
export const MAX_EXTRACTION_ATTEMPTS = 3;
/** A run older than this has lost its lease (the node action times out at 10 minutes). */
export const EXTRACTION_LEASE_MS = 15 * 60_000;
/** Rows the stall sweep looks at per status per run. */
const RETRY_SWEEP_LIMIT = 50;

/** Document types extraction reads (a schema exists in `lib/schemas_docs`); card statements never, here. */
const EXTRACTABLE: ReadonlySet<EvidenceDocType> = new Set<EvidenceDocType>([
  "order_confirmation", "receipt", "expense_receipt", "refund_notice", "shipping_notice", "delivery_notice",
  "delay_notice", "e_ticket", "itinerary_change_notice", "cancellation_notice", "baggage_report", "submission_proof",
]);

export const EXTRACTION_SUMMARY = {
  queued: "Queued to be read.",
  paused: "Paused: today's document-reading limit is reached. Recoup will try again.",
  retry: "Reading this document failed. Recoup will try again.",
  gaveUp: "Recoup could not read this document. You can still enter the details yourself.",
  photo: "Photos are stored and can be downloaded, but Recoup reads text only from PDFs. Enter the details yourself.",
  noTextLayer: "This PDF has no text Recoup can read (it looks like a scan). Enter the details yourself.",
  gone: "The file is no longer stored.",
} as const;

/** The completion summary: how many candidates now wait for the user's confirmation. */
export function readSummary(written: number): string {
  return written === 0
    ? "Read. Nothing in it answers one of this transaction's questions yet."
    : `Read. ${written} detail${written === 1 ? "" : "s"} from it ${written === 1 ? "waits" : "wait"} for you to confirm.`;
}

/** Why an upload row cannot be queued, or null when it can. Reads only. */
function uploadIneligible(row: Doc<"evidence">): string | null {
  if (row.kind !== "upload") return "not an upload";
  if (row.retention !== "active" || row.storageId === undefined) return "content cleared";
  if (row.transactionId === undefined) return "not linked to a transaction";
  if (row.docTypeDeclaredBy !== "user" || !EXTRACTABLE.has(row.docType)) return "no declared, readable type";
  return null;
}

async function scheduleRun(ctx: MutationCtx, row: Doc<"evidence">, delayMs = 0): Promise<void> {
  if (row.kind === "upload") await ctx.scheduler.runAfter(delayMs, internal.evidenceExtract.extractUpload, { evidenceId: row._id });
  else await ctx.scheduler.runAfter(delayMs, internal.intake.extractTextEvidence, { evidenceId: row._id });
}

/**
 * Queues an upload that is now eligible (called after finalize, `declareDocType` and `attachToTransaction`). Only a
 * row still `not_requested` is queued, and only while the flag is on; returns whether it was.
 */
export async function queueUploadIfEligible(ctx: MutationCtx, evidenceId: Id<"evidence">): Promise<boolean> {
  const row = await ctx.db.get(evidenceId);
  if (row === null || row.extractionStatus !== "not_requested" || uploadIneligible(row) !== null) return false;
  if (await isTombstoned(ctx, row.userId)) return false;
  if (!(await isFlagOn(ctx, "live_document_extraction"))) return false;
  await ctx.db.patch(row._id, { extractionStatus: "queued", extractionSummary: EXTRACTION_SUMMARY.queued });
  await scheduleRun(ctx, row);
  return true;
}

/**
 * Queues the second stage for a forwarded or pasted message (`intake.applyExtraction` calls it once the first stage
 * has linked the evidence to a transaction). Only while the flag is on; returns whether it was queued.
 */
export async function queueTextSecondStage(ctx: MutationCtx, evidenceId: Id<"evidence">): Promise<boolean> {
  const row = await ctx.db.get(evidenceId);
  if (row === null || (row.kind !== "email" && row.kind !== "paste")) return false;
  if (row.retention !== "active" || row.text === undefined || row.transactionId === undefined) return false;
  if (row.extractionStatus === "queued" || row.extractionStatus === "running") return false;
  if (row.extractorVersion === DOCUMENT_EXTRACTOR_VERSION) return false; // read by the second stage already
  if (await isTombstoned(ctx, row.userId)) return false;
  if (!(await isFlagOn(ctx, "live_document_extraction"))) return false;
  await ctx.db.patch(row._id, { extractionStatus: "queued", extractionSummary: EXTRACTION_SUMMARY.queued, extractionAttempts: 0 });
  await scheduleRun(ctx, row);
  return true;
}


/** How a run that can no longer finish ends: uploads `unreadable` (P4), messages `failed` (their first stage stands). */
function gaveUpStatus(row: Doc<"evidence">): ExtractionStatus {
  return row.kind === "upload" ? "unreadable" : "failed";
}

/**
 * Takes the lease on one queued row (or on a run whose lease expired), after re-checking everything: the flag, the
 * tombstone, the content, the link, the attempt count and the daily reading budget (`inbound_extract`, per user then
 * deployment-wide). Returns null — having written why — when the row must not be read now.
 */
export const claimExtraction = internalMutation({
  args: { evidenceId: v.id("evidence") },
  // The lease (never returned to a client: this is internal, SEC-UP-1).
  returns: v.union(
    v.object({
      userId: v.id("users"),
      transactionId: v.id("transactions"),
      category: v.union(v.literal("retail_order"), v.literal("air_travel"), v.literal("card_charge")),
      kind: v.union(v.literal("upload"), v.literal("email"), v.literal("paste")),
      docType: evidenceDocType,
      docTypeDeclaredBy: v.union(v.literal("user"), v.literal("classifier"), v.null()),
      storageId: v.union(v.id("_storage"), v.null()),
      mimeType: v.union(v.string(), v.null()),
      text: v.union(v.string(), v.null()),
      startedAt: v.number(),
      attempt: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, { evidenceId }) => {
    const row = await ctx.db.get(evidenceId);
    if (row === null) return null;
    const now = Date.now();
    const stale = row.extractionStatus === "running" && (row.extractionStartedAt ?? 0) < now - EXTRACTION_LEASE_MS;
    if (row.extractionStatus !== "queued" && !stale) return null;
    if (row.kind !== "upload" && row.kind !== "email" && row.kind !== "paste") return null;
    if (await isTombstoned(ctx, row.userId)) return null; // SEC-DEL-4: the purge removes the row and its blob
    if (!(await isFlagOn(ctx, "live_document_extraction"))) {
      await ctx.db.patch(row._id, { extractionStatus: row.kind === "upload" ? "store_only" : "succeeded", extractionSummary: row.kind === "upload" ? STATUS_SUMMARY.extractionOff : undefined });
      logEvent("extraction_refused", { evidenceId, flag: "live_document_extraction" });
      return null;
    }
    const unusable =
      row.kind === "upload" ? uploadIneligible(row) : row.retention !== "active" || row.text === undefined || row.transactionId === undefined ? "not readable" : null;
    const txn = row.transactionId === undefined ? null : await ctx.db.get(row.transactionId);
    if (unusable !== null || txn === null || txn.userId !== row.userId) {
      await ctx.db.patch(row._id, { extractionStatus: row.kind === "upload" ? "not_requested" : "succeeded", extractionSummary: undefined });
      return null;
    }
    if (row.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
      await ctx.db.patch(row._id, { extractionStatus: gaveUpStatus(row), extractionSummary: EXTRACTION_SUMMARY.gaveUp });
      return null;
    }
    const perUser = await tryConsumeBudget(ctx, row.userId, "inbound_extract", DAILY_BUDGETS.inbound_extract.max, now);
    const global = perUser && (await tryConsumeGlobalBudget(ctx, "inbound_extract", GLOBAL_DAILY_BUDGETS.inbound_extract.max, 1, now));
    if (!global) {
      await ctx.db.patch(row._id, { extractionStatus: "queued", extractionSummary: EXTRACTION_SUMMARY.paused });
      return null;
    }
    const attempt = row.extractionAttempts + 1;
    await ctx.db.patch(row._id, {
      extractionStatus: "running",
      extractionAttempts: attempt,
      extractionStartedAt: now,
      extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
    });
    return {
      userId: row.userId,
      transactionId: txn._id,
      category: txn.category,
      kind: row.kind as "upload" | "email" | "paste",
      docType: row.docType,
      docTypeDeclaredBy: row.docTypeDeclaredBy ?? null,
      storageId: row.storageId ?? null,
      mimeType: row.mimeType ?? null,
      text: row.text ?? null,
      startedAt: now,
      attempt,
    };
  },
});

const HOUR_MS = 3_600_000;

/**
 * D247 (DA E3): does `epochMs` name the calendar day `isoDate`? A document's date-only value is stored at noon UTC
 * (`lib/docFacts`, and intake's `safeDate` — the documented convention), which is that same calendar day from UTC-11
 * to UTC+12. So an instant names day D when D is its local date in some zone of that range:
 * [D 00:00 at UTC+12, D 24:00 at UTC-11).
 */
export function instantOnDay(epochMs: number, isoDate: string): boolean {
  const midnight = Date.parse(`${isoDate}T00:00:00Z`);
  return epochMs >= midnight - 12 * HOUR_MS && epochMs < midnight + 24 * HOUR_MS + 11 * HOUR_MS;
}

/**
 * D247: a date candidate that names the same calendar day as a live row already in its cell (an email's exact instant,
 * a confirmed date) adds nothing but a false "which date?" conflict, so it is not written.
 */
async function sameDayAlreadyInCell(
  ctx: MutationCtx,
  transactionId: Id<"transactions">,
  key: string,
  value: Infer<typeof factValue>,
): Promise<boolean> {
  if (value.kind !== "instant") return false;
  const day = new Date(value.epochMs).toISOString().slice(0, 10);
  const rows = await readCellRows(ctx, transactionId, "txn", key);
  return rows.some((r) => r.value.kind === "instant" && instantOnDay(r.value.epochMs, day));
}

const candidateValidator = v.object({ key: v.string(), value: factValue, locator: evidenceLocator, quoteStatus: quoteStatusValidator });

/**
 * Ends a run that still holds its lease: writes the candidates as `extracted_candidate` facts through the single fact
 * writer, and the final status. Writes NOTHING when the lease was lost, the account is being deleted (SEC-DEL-4: the
 * purge then removes the row and its blob), the content was cleared, or the flag was switched off while the document
 * was being read (the operator's kill switch, RUNBOOK §14). A candidate the catalogue refuses is skipped.
 */
export const completeExtraction = internalMutation({
  args: {
    evidenceId: v.id("evidence"),
    startedAt: v.number(),
    status: v.union(
      v.literal("succeeded"), v.literal("store_only"), v.literal("needs_unlocked_copy"), v.literal("over_page_cap"),
      v.literal("unreadable"),
    ),
    summary: v.optional(v.string()),
    hasTextLayer: v.optional(v.boolean()),
    pageCount: v.optional(v.number()),
    /** The second-stage classifier's type for an undeclared message (never overrides the user's declaration). */
    classifiedDocType: v.optional(evidenceDocType),
    candidates: v.array(candidateValidator),
  },
  returns: v.object({ applied: v.boolean(), written: v.number() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.evidenceId);
    if (row === null || row.extractionStatus !== "running" || row.extractionStartedAt !== args.startedAt) return { applied: false, written: 0 };
    if (await isTombstoned(ctx, row.userId)) return { applied: false, written: 0 };
    if (!(await isFlagOn(ctx, "live_document_extraction"))) {
      await ctx.db.patch(row._id, { extractionStatus: row.kind === "upload" ? "store_only" : "succeeded", extractionSummary: row.kind === "upload" ? STATUS_SUMMARY.extractionOff : undefined });
      logEvent("extraction_refused", { evidenceId: row._id, flag: "live_document_extraction" });
      return { applied: false, written: 0 };
    }
    if (row.retention !== "active") {
      await ctx.db.patch(row._id, { extractionStatus: row.kind === "upload" ? "not_requested" : "succeeded", extractionSummary: undefined });
      return { applied: false, written: 0 };
    }
    const patch: Partial<Doc<"evidence">> = {};
    if (args.classifiedDocType !== undefined && row.docTypeDeclaredBy !== "user") {
      patch.docType = args.classifiedDocType;
      patch.docTypeDeclaredBy = UNDECLARED.has(args.classifiedDocType) ? undefined : "classifier";
    }
    let written = 0;
    if (args.status === "succeeded" && row.transactionId !== undefined) {
      for (const c of args.candidates) {
        if (await sameDayAlreadyInCell(ctx, row.transactionId, c.key, c.value)) continue;
        try {
          const res = await putFact(ctx, row.userId, {
            transactionId: row.transactionId,
            subjectKey: "txn",
            key: c.key,
            state: "extracted_candidate",
            value: c.value,
            source: { kind: "evidence", evidenceId: row._id, locator: c.locator, quoteStatus: c.quoteStatus, extractorVersion: DOCUMENT_EXTRACTOR_VERSION },
          });
          if (res.outcome === "inserted") written++;
        } catch (err) {
          if (!(err instanceof ConvexError)) throw err;
        }
      }
    }
    await ctx.db.patch(row._id, {
      ...patch,
      extractionStatus: args.status,
      extractionSummary: args.status === "succeeded" ? readSummary(written) : args.summary,
      ...(args.hasTextLayer !== undefined ? { hasTextLayer: args.hasTextLayer } : {}),
      ...(args.pageCount !== undefined ? { pageCount: args.pageCount } : {}),
    });
    return { applied: true, written };
  },
});

/**
 * A run that threw: re-queued with a growing delay while attempts remain, else given up (`unreadable` for an upload,
 * P4). Nothing is retried for an account being deleted.
 */
export const failExtraction = internalMutation({
  args: { evidenceId: v.id("evidence"), startedAt: v.number(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, { evidenceId, startedAt, error }) => {
    const row = await ctx.db.get(evidenceId);
    if (row === null || row.extractionStatus !== "running" || row.extractionStartedAt !== startedAt) return null;
    logEvent("extraction_failed", { evidenceId, attempt: row.extractionAttempts, error: error.slice(0, 300) });
    if (await isTombstoned(ctx, row.userId)) return null;
    if (row.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
      await ctx.db.patch(row._id, { extractionStatus: gaveUpStatus(row), extractionSummary: EXTRACTION_SUMMARY.gaveUp });
      return null;
    }
    await ctx.db.patch(row._id, { extractionStatus: "queued", extractionSummary: EXTRACTION_SUMMARY.retry });
    await scheduleRun(ctx, row, row.extractionAttempts * 60_000);
    return null;
  },
});

/**
 * The stall sweep (M29 wires it into `crons.ts`): re-queues runs whose lease expired (or gives them up after
 * `MAX_EXTRACTION_ATTEMPTS`, P4) and re-schedules queued rows (a budget pause, or a lost schedule; the claim makes a
 * duplicate run a no-op). Bounded per status; skips accounts being deleted.
 */
export const retryStalledExtractions = internalMutation({
  args: {},
  returns: v.object({ requeued: v.number(), gaveUp: v.number(), rescheduled: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    let requeued = 0;
    let gaveUp = 0;
    let rescheduled = 0;
    const stalled = await ctx.db
      .query("evidence")
      .withIndex("by_extraction_status_and_extraction_started_at", (q) =>
        q.eq("extractionStatus", "running").lt("extractionStartedAt", now - EXTRACTION_LEASE_MS),
      )
      .take(RETRY_SWEEP_LIMIT);
    for (const row of stalled) {
      if (await isTombstoned(ctx, row.userId)) continue;
      if (row.extractionAttempts >= MAX_EXTRACTION_ATTEMPTS) {
        await ctx.db.patch(row._id, { extractionStatus: gaveUpStatus(row), extractionSummary: EXTRACTION_SUMMARY.gaveUp });
        gaveUp++;
      } else {
        await ctx.db.patch(row._id, { extractionStatus: "queued", extractionSummary: EXTRACTION_SUMMARY.retry });
        await scheduleRun(ctx, row);
        requeued++;
      }
    }
    const queued = await ctx.db
      .query("evidence")
      .withIndex("by_extraction_status_and_extraction_started_at", (q) => q.eq("extractionStatus", "queued"))
      .take(RETRY_SWEEP_LIMIT);
    for (const row of queued) {
      if (await isTombstoned(ctx, row.userId)) continue;
      await scheduleRun(ctx, row);
      rescheduled++;
    }
    return { requeued, gaveUp, rescheduled };
  },
});
