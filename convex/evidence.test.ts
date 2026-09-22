/// <reference types="vite/client" />
/**
 * M13 evidence upload/download (contract rev 5 §2.6; security baseline SEC-UP-1/2/3/5/6/8; DA-A-8, DA-A-20,
 * DA-A-27, DA-A-28a/c/e/f). Everything goes through the real routes with `t.fetch`, so the route contract — status
 * codes, headers, what is and is not stored — is what is asserted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn, type SignedInUser } from "./test.setup";
import { normalizeSha256, sanitizeFileName, STATUS_SUMMARY, uploadExtractionStatus } from "./evidence";
import { allowedOrigins, contentDisposition, isDevDeployment } from "./http";
import {
  EVIDENCE_BYTES_PER_USER_PER_DAY,
  EVIDENCE_DOWNLOADS_PER_MINUTE,
  EVIDENCE_GLOBAL_DAILY_BYTES,
  EVIDENCE_UPLOADS_PER_DAY,
  EVIDENCE_UPLOADS_PER_HOUR,
  GLOBAL_DAILY_BUDGETS,
  MAX_EVIDENCE_BYTES_PER_USER,
  MAX_EVIDENCE_ROWS_PER_USER,
  MAX_UPLOAD_BYTES,
} from "./limits";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 23, 12);
const DAY = "2026-09-23";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const enc = (s: string) => new TextEncoder().encode(s);
function cat(...parts: Array<Uint8Array | number[] | string>): Uint8Array<ArrayBuffer> {
  const arrays = parts.map((p) => (typeof p === "string" ? enc(p) : p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}
let pngSeq = 0;
/** A distinct PNG-signed payload each call (so dedupe never interferes unless a test reuses one). */
const png = (tag = `png-${++pngSeq}`) => cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", tag);
const jpeg = () => cat([0xff, 0xd8, 0xff, 0xe0], "JFIF-jpeg-body");
const pdf = (body = "BT (Thank you for your order) Tj ET") => cat(`%PDF-1.4\n${body}\n%%EOF\n`);
const heic = () => cat([0, 0, 0, 24], "ftyp", "heic", [0, 0, 0, 0], "mif1", "heic", [0, 0, 0, 0], "rest-of-file");
const svg = () => enc('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Fetcher = Pick<SignedInUser["as"], "fetch"> | T;

async function upload(who: Fetcher, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}, lengthOverride?: string | null) {
  const h: Record<string, string> = { ...headers };
  if (lengthOverride !== null) h["Content-Length"] = lengthOverride ?? String(bytes.byteLength);
  return await who.fetch("/evidence/upload", { method: "POST", body: bytes, headers: h });
}

async function uploadJson(who: Fetcher, bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  const res = await upload(who, bytes, headers);
  expect(res.status).toBe(200);
  return (await res.json()) as { evidenceId: Id<"evidence">; duplicate: boolean; extractionStatus: string };
}

const storedBlobs = (t: T) => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
const evidenceRows = (t: T) => t.run((ctx) => ctx.db.query("evidence").collect());

async function flagOn(t: T) {
  await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D999: synthetic test fixture" });
}

async function download(who: Fetcher, id: string) {
  return await who.fetch(`/evidence/file?id=${encodeURIComponent(id)}`, { method: "GET" });
}

// ---------------------------------------------------------------------------

describe("POST /evidence/upload — refusals before anything is stored (SEC-UP-2/3/8)", () => {
  it("signed-out and tombstoned callers get the same 401 and nothing is stored", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const anon = await upload(t, png());
    await t.run((ctx) => ctx.db.insert("accountState", { userId: a.userId, status: "deleting", requestedAt: T0, attempts: 0 }));
    const tomb = await upload(a.as, png());
    expect(anon.status).toBe(401);
    expect(tomb.status).toBe(401);
    expect(await tomb.text()).toBe(await anon.text());
    expect(await storedBlobs(t)).toBe(0);
  });

  it("413 before the body is read: no Content-Length, chunked without a length, or a declared length over 10 MB", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    expect((await upload(a.as, png(), {}, null)).status).toBe(413);
    expect((await upload(a.as, png(), { "Transfer-Encoding": "chunked" })).status).toBe(413);
    expect((await upload(a.as, png(), {}, String(MAX_UPLOAD_BYTES + 1))).status).toBe(413);
    expect((await upload(a.as, png(), {}, "12abc")).status).toBe(413);
    expect(await storedBlobs(t)).toBe(0);
    // None of these consumed the daily count (they never reached admission).
    const usage = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(usage.filter((u) => u.kind === "evidence_uploads")).toHaveLength(0);
  });

  it("the body is streamed with a cap: more bytes than declared are refused and nothing is stored", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const body = png("x".repeat(100));
    expect((await upload(a.as, body, {}, "20")).status).toBe(413);
    expect(await storedBlobs(t)).toBe(0);
  });

  it("an SVG (or HTML) sent as image/png named .png is refused by content sniffing with 415, nothing stored", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const res = await upload(a.as, svg(), { "Content-Type": "image/png", "X-File-Name": "photo.png", "X-Doc-Type": "receipt" });
    expect(res.status).toBe(415);
    expect((await upload(a.as, enc("<!doctype html><script>x</script>"), { "Content-Type": "application/pdf" })).status).toBe(415);
    expect(await storedBlobs(t)).toBe(0);
    expect(await evidenceRows(t)).toHaveLength(0);
  });

  it("an X-Doc-Type outside the closed list → 400", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    expect((await upload(a.as, png(), { "X-Doc-Type": "medical_bill" })).status).toBe(400);
    expect(await storedBlobs(t)).toBe(0);
  });

  it(`the ${EVIDENCE_UPLOADS_PER_HOUR + 1}st upload in an hour is refused with 429 and stores nothing; another user is unaffected`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    for (let i = 0; i < EVIDENCE_UPLOADS_PER_HOUR; i++) expect((await upload(a.as, png())).status).toBe(200);
    const before = await storedBlobs(t);
    const over = await upload(a.as, png());
    expect(over.status).toBe(429);
    expect(await storedBlobs(t)).toBe(before);
    expect((await upload(b.as, png())).status).toBe(200);
  });

  it(`the per-user daily count (${EVIDENCE_UPLOADS_PER_DAY}) refuses with 429 before the body is read`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.insert("usage", { userId: a.userId, day: DAY, kind: "evidence_uploads", count: EVIDENCE_UPLOADS_PER_DAY }));
    expect((await upload(a.as, png())).status).toBe(429);
    expect(await storedBlobs(t)).toBe(0);
  });

  it("SEC-UP-8 kill switch: ops.pauseKind('evidence_bytes') refuses every user's upload", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    await t.mutation(internal.ops.pauseKind, { kind: "evidence_bytes" });
    expect((await upload(a.as, png())).status).toBe(429);
    expect((await upload(b.as, png())).status).toBe(429);
    expect(await storedBlobs(t)).toBe(0);
    expect(GLOBAL_DAILY_BUDGETS.evidence_bytes.max).toBe(EVIDENCE_GLOBAL_DAILY_BYTES);
  });
});

describe("POST /evidence/upload — stored, hashed, deduped, charged (SEC-UP-1/6, DA-A-20/27/28f)", () => {
  it("stores the file under the caller with a 64-hex SHA-256 of the bytes (DA-A-27) and returns no URL", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const bytes = png("receipt");
    const res = await upload(a.as, bytes, { "X-Doc-Type": "receipt", "X-File-Name": "receipt.png" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("/api/storage");
    expect(text).not.toMatch(/https?:\/\//);
    const body = JSON.parse(text) as { evidenceId: Id<"evidence"> };
    const row = (await t.run((ctx) => ctx.db.get(body.evidenceId)))!;
    expect(row.userId).toBe(a.userId);
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.contentHash).toBe(await sha256Hex(bytes));
    expect(row).toMatchObject({
      kind: "upload", sourceChannel: "upload", provenance: "user_uploaded", mimeType: "image/png", sizeBytes: bytes.byteLength,
      fileName: "receipt.png", docType: "receipt", docTypeDeclaredBy: "user", retention: "active", extractionAttempts: 0,
    });
    expect(row.storageId).toBeDefined();
    const view = await a.as.query(api.evidence.get, { evidenceId: body.evidenceId });
    expect(JSON.stringify(view)).not.toContain("/api/storage");
    expect(JSON.stringify(view)).not.toContain(row.storageId!);
    expect(view.hasFile).toBe(true);
  });

  it("normalizeSha256: hex passes through lowercased; base64 of 32 bytes becomes hex; anything else throws", () => {
    const hex = "ab".repeat(32);
    expect(normalizeSha256(hex.toUpperCase())).toBe(hex);
    const b64 = btoa(String.fromCharCode(...new Array(32).fill(0xab)));
    expect(normalizeSha256(b64)).toBe(hex);
    expect(() => normalizeSha256("not-a-hash")).toThrow();
    expect(() => normalizeSha256(btoa("short"))).toThrow();
  });

  it("DA-A-28f: the byte quotas are charged from _storage.size, per user and globally", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const bytes = png("y".repeat(500));
    await uploadJson(a.as, bytes);
    const usage = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(usage.find((u) => u.userId === a.userId && u.kind === "evidence_bytes" && u.day === DAY)?.count).toBe(bytes.byteLength);
    expect(usage.find((u) => u.userId === undefined && u.kind === "evidence_bytes" && u.day === DAY)?.count).toBe(bytes.byteLength);
  });

  it("DA-A-28f: over the per-user daily byte quota after storing → 429, the stored blob is deleted, no row", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) =>
      ctx.db.insert("usage", { userId: a.userId, day: DAY, kind: "evidence_bytes", count: EVIDENCE_BYTES_PER_USER_PER_DAY - 10 }),
    );
    const res = await upload(a.as, png("z".repeat(100)));
    expect(res.status).toBe(429);
    expect(await storedBlobs(t)).toBe(0);
    expect(await evidenceRows(t)).toHaveLength(0);
  });

  it("D173: the stored-bytes cap refuses an upload over it (blob deleted, nothing charged); after retention clears one, a new upload within the cap succeeds", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const first = png("f".repeat(200));
    const second = png("s".repeat(200));
    // Just enough room for one of the two files.
    await t.run((ctx) =>
      ctx.db.insert("usage", { userId: a.userId, day: "lifetime", kind: "evidence_stored_bytes", count: MAX_EVIDENCE_BYTES_PER_USER - first.byteLength - 10 }),
    );
    const stored = await uploadJson(a.as, first);
    const over = await upload(a.as, second);
    expect(over.status).toBe(429);
    expect(await storedBlobs(t)).toBe(1);
    const dailyBefore = (await t.run((ctx) => ctx.db.query("usage").collect())).find((u) => u.userId === a.userId && u.kind === "evidence_bytes")?.count;
    expect(dailyBefore).toBe(first.byteLength); // the refused upload charged nothing

    vi.advanceTimersByTime(31 * 86_400_000);
    for (let i = 0; i < 60; i++) if ((await t.mutation(internal.retention.sweepRecovery, {})).done) break;
    expect((await t.run((ctx) => ctx.db.get(stored.evidenceId)))!.retention).toBe("content_deleted");
    expect((await upload(a.as, second)).status).toBe(200);
  });

  it(`the per-user row cap (${MAX_EVIDENCE_ROWS_PER_USER}) refuses a new row and deletes the stored blob`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await t.run((ctx) => ctx.db.insert("usage", { userId: a.userId, day: "lifetime", kind: "evidence_rows", count: MAX_EVIDENCE_ROWS_PER_USER }));
    expect((await upload(a.as, png())).status).toBe(429);
    expect(await storedBlobs(t)).toBe(0);
  });

  it("SEC-UP-6: A and B upload identical bytes → two rows, two blobs, identical responses", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const bytes = png("same-bytes");
    const ra = await uploadJson(a.as, bytes);
    const rb = await uploadJson(b.as, bytes);
    expect(ra.evidenceId).not.toBe(rb.evidenceId);
    expect({ ...ra, evidenceId: "x" }).toEqual({ ...rb, evidenceId: "x" });
    expect(await storedBlobs(t)).toBe(2);
    expect(await evidenceRows(t)).toHaveLength(2);
  });

  it("SEC-UP-6: A uploading the same file twice → one row, the second blob deleted, bytes charged once", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const bytes = png("twice");
    const first = await uploadJson(a.as, bytes);
    const second = await uploadJson(a.as, bytes);
    expect(second).toMatchObject({ evidenceId: first.evidenceId, duplicate: true });
    expect(await storedBlobs(t)).toBe(1);
    expect(await evidenceRows(t)).toHaveLength(1);
    const usage = await t.run((ctx) => ctx.db.query("usage").collect());
    expect(usage.find((u) => u.userId === a.userId && u.kind === "evidence_bytes")?.count).toBe(bytes.byteLength);
  });

  it("DA-A-20: upload → retention clears it → re-upload of the same bytes → the SAME row is active again with content, receivedAt now (D163)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const bytes = png("revive-me");
    const first = await uploadJson(a.as, bytes, { "X-Doc-Type": "receipt" });
    vi.advanceTimersByTime(31 * 86_400_000);
    for (let i = 0; i < 60; i++) {
      if ((await t.mutation(internal.retention.sweepRecovery, {})).done) break;
    }
    const cleared = (await t.run((ctx) => ctx.db.get(first.evidenceId)))!;
    expect(cleared.retention).toBe("content_deleted");
    expect(cleared.storageId).toBeUndefined();
    expect((await download(a.as, first.evidenceId)).status).toBe(404);

    const revivedAt = Date.now();
    const again = await uploadJson(a.as, bytes);
    expect(again.evidenceId).toBe(first.evidenceId);
    expect(again.duplicate).toBe(false);
    const row = (await t.run((ctx) => ctx.db.get(first.evidenceId)))!;
    expect(row.retention).toBe("active");
    expect(row.storageId).toBeDefined();
    expect(row.receivedAt).toBe(revivedAt);
    const res = await download(a.as, first.evidenceId);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(await evidenceRows(t)).toHaveLength(1);
  });

  it("SEC-UP-1: finalizing a storage id already bound to A's row is refused and A's blob survives", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const { evidenceId } = await uploadJson(a.as, png("a-owns"));
    const storageId = (await t.run((ctx) => ctx.db.get(evidenceId)))!.storageId!;
    await expect(
      t.mutation(internal.evidence.finalizeUpload, {
        userId: b.userId, storageId, sniffedMime: "image/png", encrypted: false, panDetected: false,
      }),
    ).rejects.toThrow(/already recorded/);
    expect(await t.run((ctx) => ctx.db.system.get("_storage", storageId))).not.toBeNull();
    expect((await evidenceRows(t)).map((r) => r.userId)).toEqual([a.userId]);
  });

  it("no public function accepts a _storage id, and nothing in convex/ calls ctx.storage.getUrl (SEC-UP-1/5)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "_generated" || name === "node_modules") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) files.push(path);
      }
    };
    walk("convex");
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (/\.getUrl\s*\(/.test(src)) offenders.push(`${file}: getUrl`);
      if (file.endsWith("schema.ts")) continue;
      let at = src.indexOf('v.id("_storage")');
      while (at >= 0) {
        const before = src.slice(0, at);
        const decl = [...before.matchAll(/export const (\w+) = (internalMutation|internalQuery|internalAction|mutation|query|action|httpAction)\(/g)].at(-1);
        if (decl && !decl[2].startsWith("internal")) offenders.push(`${file}: ${decl[1]} (${decl[2]})`);
        at = src.indexOf('v.id("_storage")', at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("DA-A-8: a document type is declared before anything is extracted", () => {
  it("no doc type → awaiting_doc_type, never extracted — even with live extraction on", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    for (const headers of [{}, { "X-Doc-Type": "unknown" }, { "X-Doc-Type": "other" }] as Array<Record<string, string>>) {
      const r = await uploadJson(a.as, png(), headers);
      expect(r.extractionStatus).toBe("awaiting_doc_type");
      const row = (await t.run((ctx) => ctx.db.get(r.evidenceId)))!;
      expect(row.docTypeDeclaredBy).toBeUndefined();
    }
  });

  it("declared card_statement → store_only, even with live extraction on", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    const r = await uploadJson(a.as, pdf(), { "X-Doc-Type": "card_statement" });
    expect(r.extractionStatus).toBe("store_only");
    expect((await t.run((ctx) => ctx.db.get(r.evidenceId)))!.extractionSummary).toBe(STATUS_SUMMARY.statement);
  });

  it("a PDF declared 'receipt' with a card number in its text layer → store_only, and re-declaring never unlocks it", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    const r = await uploadJson(a.as, pdf("BT (Paid with 4111 1111 1111 1111) Tj ET"), { "X-Doc-Type": "receipt" });
    expect(r.extractionStatus).toBe("store_only");
    const again = await a.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "order_confirmation" });
    expect(again.extractionStatus).toBe("store_only");
  });

  it("live extraction off (D145, the default): a declared receipt is store_only and extraction_refused is logged", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const logs = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const r = await uploadJson(a.as, png(), { "X-Doc-Type": "receipt" });
    expect(r.extractionStatus).toBe("store_only");
    const lines = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"extraction_refused"'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(r.evidenceId);
    expect(lines[0]).toContain("live_document_extraction");
  });

  it("live extraction on and a declared, clean receipt → not_requested (left for M23's extractor)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    expect((await uploadJson(a.as, jpeg(), { "X-Doc-Type": "receipt" })).extractionStatus).toBe("not_requested");
  });

  it("DA-A-28e: HEIC is stored and downloadable but unreadable — never sent to the model, whatever the declaration", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    const r = await uploadJson(a.as, heic(), { "X-Doc-Type": "receipt" });
    expect(r.extractionStatus).toBe("unreadable");
    const row = (await t.run((ctx) => ctx.db.get(r.evidenceId)))!;
    expect(row.mimeType).toBe("image/heic");
    expect(row.extractionSummary).toMatch(/JPEG or PNG/);
    expect((await a.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "damage_photo" })).extractionStatus).toBe("unreadable");
    expect((await download(a.as, r.evidenceId)).status).toBe(200);
  });

  it("SEC-UP-3: an encrypted PDF → needs_unlocked_copy (no password asked)", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    await flagOn(t);
    const r = await uploadJson(a.as, pdf("trailer << /Encrypt 7 0 R >>"), { "X-Doc-Type": "receipt" });
    expect(r.extractionStatus).toBe("needs_unlocked_copy");
    expect((await t.run((ctx) => ctx.db.get(r.evidenceId)))!.extractionSummary).not.toMatch(/enter .*password/i);
  });

  it("declareDocType: awaiting → declared (flag off → store_only; flag on → not_requested); back to unknown → awaiting; owner only", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const r = await uploadJson(a.as, png());
    expect((await a.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "receipt" })).extractionStatus).toBe("store_only");
    await flagOn(t);
    expect((await a.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "receipt" })).extractionStatus).toBe("not_requested");
    expect((await a.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "unknown" })).extractionStatus).toBe("awaiting_doc_type");
    await expect(b.as.mutation(api.evidence.declareDocType, { evidenceId: r.evidenceId, docType: "receipt" })).rejects.toThrow(/^.*Evidence not found/);
    await expect(b.as.query(api.evidence.get, { evidenceId: r.evidenceId })).rejects.toThrow(/Evidence not found/);
  });

  it("the gate order is fixed (pure)", () => {
    const base = { mime: "image/png" as const, declaredDocType: "receipt" as const, encrypted: false, panDetected: false, liveExtractionOn: true };
    expect(uploadExtractionStatus(base).status).toBe("not_requested");
    expect(uploadExtractionStatus({ ...base, liveExtractionOn: false })).toMatchObject({ status: "store_only", refusedByFlag: true });
    expect(uploadExtractionStatus({ ...base, panDetected: true, liveExtractionOn: false })).toMatchObject({ status: "store_only", refusedByFlag: false });
    expect(uploadExtractionStatus({ ...base, declaredDocType: "card_statement", panDetected: true }).summary).toBe(STATUS_SUMMARY.statement);
    expect(uploadExtractionStatus({ ...base, declaredDocType: undefined, panDetected: true }).status).toBe("awaiting_doc_type");
    expect(uploadExtractionStatus({ ...base, mime: "application/pdf", encrypted: true, declaredDocType: undefined }).status).toBe("needs_unlocked_copy");
    expect(uploadExtractionStatus({ ...base, mime: "image/heif", encrypted: true }).status).toBe("unreadable");
  });
});

describe("GET /evidence/file — owner-checked, attachment, nosniff (SEC-UP-5, DA-A-28a)", () => {
  it("the owner gets the bytes with the sniffed type, attachment disposition, nosniff and no caching", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const bytes = pdf();
    const r = await uploadJson(a.as, bytes, { "Content-Type": "text/html", "X-File-Name": "order.pdf", "X-Doc-Type": "receipt" });
    const res = await download(a.as, r.evidenceId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="order.pdf"; filename*=UTF-8''order.pdf`);
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("DA-A-28a: a UTF-8 file name round-trips through the percent-encoded header and RFC 5987", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const r = await uploadJson(a.as, pdf(), { "X-File-Name": encodeURIComponent("reçu d'été.pdf") });
    const row = (await t.run((ctx) => ctx.db.get(r.evidenceId)))!;
    expect(row.fileName).toBe("reçu dété.pdf"); // the quote is stripped at finalize (rev 3)
    const res = await download(a.as, r.evidenceId);
    const cd = res.headers.get("Content-Disposition")!;
    expect(cd).toContain(`filename="re_u d_t_.pdf"`);
    expect(cd).toContain(`filename*=UTF-8''re%C3%A7u%20d%C3%A9t%C3%A9.pdf`);
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe("reçu dété.pdf");
  });

  it("file names are sanitized: no quotes, slashes, semicolons or control characters; malformed encoding is dropped", () => {
    expect(sanitizeFileName(encodeURIComponent('a"b;c/d\\e\r\nf.pdf'))).toBe("abcdef.pdf");
    expect(sanitizeFileName("%E0%A4%A")).toBeUndefined();
    expect(sanitizeFileName(encodeURIComponent("../"))).toBeUndefined();
    expect(sanitizeFileName(encodeURIComponent("x".repeat(500)))!.length).toBe(200);
    expect(contentDisposition(null, "image/png")).toBe(`attachment; filename="evidence.png"; filename*=UTF-8''evidence.png`);
  });

  it("B requesting A's id, a nonexistent id and a malformed id all get the same 404; signed-out gets 401", async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const b = await signedIn(t, "B");
    const r = await uploadJson(a.as, png());
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("evidence", {
        userId: b.userId, kind: "upload", docType: "unknown", sourceChannel: "upload", provenance: "user_uploaded",
        contentHash: "0".repeat(64), receivedAt: T0, extractionStatus: "awaiting_doc_type", extractionAttempts: 0, retention: "active",
      });
      await ctx.db.delete(id);
      return id;
    });
    const foreign = await download(b.as, r.evidenceId);
    const missing = await download(b.as, ghost);
    const malformed = await download(b.as, "not-an-id");
    expect([foreign.status, missing.status, malformed.status]).toEqual([404, 404, 404]);
    const bodies = [await foreign.text(), await missing.text(), await malformed.text()];
    expect(new Set(bodies).size).toBe(1);
    expect((await download(t, r.evidenceId)).status).toBe(401);
  });

  it(`the ${EVIDENCE_DOWNLOADS_PER_MINUTE + 1}st download in a minute → 429`, async () => {
    const t = setup();
    const a = await signedIn(t, "A");
    const r = await uploadJson(a.as, png());
    for (let i = 0; i < EVIDENCE_DOWNLOADS_PER_MINUTE; i++) expect((await download(a.as, r.evidenceId)).status).toBe(200);
    expect((await download(a.as, r.evidenceId)).status).toBe(429);
  });
});

describe("CORS (DA-A-28c): localhost only on the dev deployment", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["CONVEX_SITE_URL", "SITE_URL", "APP_URL"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("localhost:5173 is refused on a non-dev CONVEX_SITE_URL and allowed on the dev deployment", async () => {
    expect(isDevDeployment("https://cool-oyster-399.convex.site")).toBe(false);
    expect(isDevDeployment("https://adorable-lion-138.convex.site")).toBe(true);
    expect(isDevDeployment("https://adorable-lion-138.evil.example")).toBe(false);
    expect(isDevDeployment("https://evil.example/adorable-lion-138.")).toBe(false);
    expect(isDevDeployment(undefined)).toBe(false);
    expect(allowedOrigins({ CONVEX_SITE_URL: "https://cool-oyster-399.convex.site", SITE_URL: "http://localhost:5173" }).has("http://localhost:5173")).toBe(false);
    expect(allowedOrigins({ CONVEX_SITE_URL: "https://adorable-lion-138.convex.site" }).has("http://localhost:5173")).toBe(true);
    expect(allowedOrigins({ SITE_URL: "https://recoup.example" }).has("https://recoup.example")).toBe(true);

    const t = setup();
    process.env.CONVEX_SITE_URL = "https://cool-oyster-399.convex.site";
    process.env.SITE_URL = "https://recoup.example";
    const pre = await t.fetch("/evidence/upload", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const prod = await t.fetch("/evidence/upload", { method: "OPTIONS", headers: { Origin: "https://recoup.example" } });
    expect(prod.headers.get("Access-Control-Allow-Origin")).toBe("https://recoup.example");
    expect(prod.headers.get("Access-Control-Allow-Headers")).toContain("X-Doc-Type");

    process.env.CONVEX_SITE_URL = "https://adorable-lion-138.convex.site";
    const dev = await t.fetch("/evidence/file", { method: "OPTIONS", headers: { Origin: "http://localhost:5173" } });
    expect(dev.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  });
});
