/**
 * Magic-byte type sniffing for evidence uploads (M13; contract rev 5 §2.6 step 3; SEC-UP-3).
 *
 * The type of an uploaded file is decided HERE, from its first bytes, never from the client's `Content-Type`, the
 * file name, or anything stored later. Only five document types are accepted: PDF, JPEG, PNG, WebP and HEIC/HEIF.
 * Everything else — SVG, HTML, XML, Office files, archives, AVIF, plain text, executables — is refused, because
 * nothing here can render or parse it safely and several of them are active content in a browser.
 *
 * Pure and dependency-free: no parsing beyond fixed-offset byte comparisons, so a hostile file cannot make this code
 * do anything but return `null`. PDF structure is examined only by bounded byte searches (`pdfLooksEncrypted`); the
 * real text layer arrives with M23's pinned PDF library.
 */

export type SniffedMime = "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "image/heic" | "image/heif";

/** The accepted types, for tests and for building the allowlist copy. */
export const ACCEPTED_MIMES: readonly SniffedMime[] = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif",
];

/** Image types a browser may preview from a blob (DA-A-28b). HEIC/HEIF are download-only; PDFs are download-only. */
export const PREVIEWABLE_MIMES: ReadonlySet<SniffedMime> = new Set<SniffedMime>(["image/jpeg", "image/png", "image/webp"]);

/** DA-A-28e: stored and downloadable, but never sent to the model provider (it cannot read them). */
export function isHeicFamily(mime: SniffedMime): boolean {
  return mime === "image/heic" || mime === "image/heif";
}

/** File-name extension for a download that has no stored name. */
export const EXTENSION: Record<SniffedMime, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end && i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" at offset 8

/** HEIF major brands that are HEVC-coded images (HEIC). */
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"]);
/** Generic HEIF brands: accepted only when a compatible brand says the payload is HEIC (an AVIF also uses `mif1`). */
const HEIF_GENERIC_BRANDS = new Set(["mif1", "msf1"]);
/** The ISO-BMFF `ftyp` box is small; a larger claimed size is not a real HEIF header. */
const MAX_FTYP_BOX = 256;

function sniffHeif(bytes: Uint8Array): SniffedMime | null {
  if (bytes.length < 16 || ascii(bytes, 4, 8) !== "ftyp") return null;
  const boxSize = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  if (boxSize < 16 || boxSize > MAX_FTYP_BOX || boxSize > bytes.length || boxSize % 4 !== 0) return null;
  const major = ascii(bytes, 8, 12);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= boxSize; at += 4) compatible.push(ascii(bytes, at, at + 4));
  // An AVIF is AV1-coded, not HEVC: refused (no path in Recoup produces or needs it).
  if (major === "avif" || major === "avis" || compatible.includes("avif")) return null;
  if (HEIC_BRANDS.has(major)) return "image/heic";
  if (HEIF_GENERIC_BRANDS.has(major) && compatible.some((b) => HEIC_BRANDS.has(b))) return "image/heif";
  return null;
}

/**
 * The file's type from its magic bytes, or `null` when it is not one of the five accepted types. `null` is also the
 * answer for an empty or truncated header. Only the first bytes are examined; pass the whole upload or a prefix.
 */
export function sniffMime(bytes: Uint8Array): SniffedMime | null {
  if (startsWith(bytes, PDF)) return "application/pdf";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) return "image/webp";
  return sniffHeif(bytes);
}

/** Finds `needle` (ASCII) in `bytes`; a bounded linear scan with no allocation per position. */
function indexOfAscii(bytes: Uint8Array, needle: string): number {
  const n = needle.length;
  const first = needle.charCodeAt(0);
  outer: for (let i = 0; i + n <= bytes.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < n; j++) if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/**
 * SEC-UP-3: an encrypted PDF carries an `/Encrypt` entry in its trailer dictionary. It goes to `needs_unlocked_copy`
 * and Recoup never asks for, or stores, the password. A false positive only means the file is stored without being
 * read automatically.
 */
export function pdfLooksEncrypted(bytes: Uint8Array): boolean {
  return indexOfAscii(bytes, "/Encrypt") >= 0;
}

/**
 * The uncompressed text in a PDF, as Latin-1, for the DA-A-8 card-number pre-scan only. Text in compressed content
 * streams is not visible here; M23's pinned PDF library supplies the real text layer before any extraction exists.
 * Never used for display, hashing or a model call.
 */
export function pdfRawText(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  }
  return out;
}
