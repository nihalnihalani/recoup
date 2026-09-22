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
 * **Extraction is gated before it exists (DA-A-8, D145).** Wave 1 stores documents; it never extracts them. The
 * status a new upload gets says why it will or will not be read automatically, in this order: HEIC/HEIF →
 * `unreadable` (the model provider cannot read them, DA-A-28e); an encrypted PDF → `needs_unlocked_copy` (no
 * password is ever asked for); no user-declared document type → `awaiting_doc_type`; a card statement →
 * `store_only`; a card number found in the file's text → `store_only`; live extraction switched off
 * (`live_document_extraction`, D145) → `store_only` and an `extraction_refused` log line; otherwise
 * `not_requested` (M23 picks those up once extraction exists).
 */
import { ConvexError, v, type Infer } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { evidenceDocType, extractionStatus as extractionStatusValidator } from "./schema";
import { isTombstoned } from "./lib/accountState";
import { ownedEvidence, requireUserId } from "./lib/access";
import { rateLimiter } from "./lib/rateLimits";
import { tryConsumeBudget, tryConsumeGlobalBudget, utcDay } from "./lib/budget";
import { isFlagOn } from "./lib/flags";
import { logEvent } from "./lib/log";
import { isHeicFamily, type SniffedMime } from "./lib/sniff";
import {
  EVIDENCE_BYTES_PER_USER_PER_DAY,
  EVIDENCE_UPLOADS_PER_DAY,
  GLOBAL_DAILY_BUDGETS,
  MAX_EVIDENCE_FILE_NAME_CHARS,
  MAX_EVIDENCE_ROWS_PER_USER,
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
  if (input.declaredDocType === undefined || UNDECLARED.has(input.declaredDocType)) {
    return { status: "awaiting_doc_type", summary: STATUS_SUMMARY.awaitingDocType, refusedByFlag: false };
  }
  if (input.declaredDocType === "card_statement") return { status: "store_only", summary: STATUS_SUMMARY.statement, refusedByFlag: false };
  if (input.panDetected) return { status: "store_only", summary: STATUS_SUMMARY.pan, refusedByFlag: false };
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

    if (!(await chargeBytes(ctx, args.userId, meta.size, now))) {
      await discard();
      return { outcome: "refused" as const, reason: "quota" as const };
    }

    const fields = {
      mimeType: args.sniffedMime,
      sizeBytes: meta.size,
      fileName: sanitizeFileName(args.fileName),
      extractionStatus: decision.status,
      extractionSummary: decision.summary,
      ...(declared ? { docType: declaredDocType, docTypeDeclaredBy: "user" as const } : {}),
    };

    let evidenceId: Id<"evidence">;
    if (cleared !== null && cleared.kind === "upload") {
      // DA-A-20 + D163: the row whose content retention cleared comes back to life with the new blob, and its
      // retention clock restarts now.
      await ctx.db.patch(cleared._id, {
        ...fields,
        storageId: args.storageId,
        retention: "active",
        receivedAt: now,
        extractionAttempts: 0,
        extractionStartedAt: undefined,
        extractorVersion: undefined,
      });
      evidenceId = cleared._id;
    } else {
      if (!(await reserveEvidenceRow(ctx, args.userId))) {
        // Undo the byte charge by refusing through a throw would lose the discard; instead the bytes stay charged for
        // a refused row, which only makes the daily quota stricter.
        await discard();
        return { outcome: "refused" as const, reason: "row_cap" as const };
      }
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
    return { outcome: "stored" as const, evidenceId, duplicate: false, extractionStatus: decision.status };
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
    if (row.retention !== "active") throw new ConvexError("This document's content was cleared. Upload it again.");
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
