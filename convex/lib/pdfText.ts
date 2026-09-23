"use node";
/**
 * The deterministic PDF text layer (M23; D145, D200, D203; security baseline §7 P1–P4).
 *
 * One exact-pinned library, `pdfjs-dist@6.3.289` (Mozilla pdf.js), used for TEXT ONLY: `getTextContent` per page.
 * Nothing here renders, reads annotations, loads the scripting build, or passes any URL or location option (in Node,
 * pdf.js reads its CMap, standard-font and wasm locations with `fs.readFile`), and a static test keeps it that way (P1). pdf.js's
 * Node polyfill tries `require("@napi-rs/canvas")` as soon as it is imported (for DOMMatrix/Path2D, used only when
 * rendering); the text path never hands canvas any document data, and extraction works when the addon cannot be
 * loaded (tested).
 *
 * Before pdf.js ever sees a file, a pre-pass over the RAW BYTES (P3) refuses what pdf.js could otherwise be made to
 * do at our expense. It never trusts the xref, `/Length` or the object structure, all of which pdf.js repairs:
 *   - any `/Encrypt` (also written with `#xx` name escapes, also inside a decoded stream) → `needs_unlocked_copy`.
 *     An owner-password-only PDF opens in pdf.js without a `PasswordException`; no password is ever asked for;
 *   - every `/Filter` (and `/F`, which pdf.js also reads as a stream's filter) anywhere in the file must be a direct
 *     name or array of names that the pre-pass can cap or that pdf.js decodes only for rendering. LZW, RunLength,
 *     Brotli, Crypt, anything unknown, or an indirect filter → `unreadable`;
 *   - every `stream` keyword pdf.js could see (a superset: any `stream` token not inside a longer word) starts a
 *     region that runs to the END OF THE FILE, and its filter chain is decoded from there under a per-stream and a
 *     per-document cap (Flate via `zlib.inflateSync({ maxOutputLength })`, which stops at the end of the deflate
 *     data exactly as pdf.js does; ASCII85 and ASCIIHex mirror pdf.js's own decoders). pdf.js cannot read more of a
 *     stream than that, whatever its `/Length` says, so a wrong or indirect length hides nothing. This covers content,
 *     `/ObjStm`, XRef, `ToUnicode`, font and Form XObject streams alike, and a stream with no visible filter whose
 *     data starts like deflate data is inflated under the same caps anyway;
 *   - image codecs (DCT, JPX, JBIG2, CCITT) are allowed only as the last filter of a stream whose dictionary says
 *     `/Subtype /Image` (pdf.js decodes those only to render), every such filter in the file must be accounted for
 *     that way, and a JPEG's declared frame size is bounded as well.
 * Then (P4) the page count is checked before any page is read (`over_page_cap`), the wall-clock budget is checked
 * before each page, and text stops at the character cap as it is read. Every failure is a status, never a throw.
 */
import { inflateSync } from "node:zlib";
import { MAX_EVIDENCE_TEXT_CHARS, MAX_PDF_PAGES } from "../limits";

export type PdfTextStatus = "ok" | "needs_unlocked_copy" | "over_page_cap" | "unreadable";

export type PdfTextResult =
  | {
      status: "ok";
      /** Each page's text, page n at index n − 1 (pages after the character cap are empty and never read). */
      pages: string[];
      /** The pages joined with "\n", at most `maxChars`. Empty for an image-only PDF (no text layer). */
      text: string;
      pageCount: number;
      /** The text stopped at `maxChars`. */
      truncated: boolean;
    }
  | { status: Exclude<PdfTextStatus, "ok">; reason: string; pageCount?: number };

export type PdfTextOptions = Partial<PdfLimits>;

export type PdfLimits = {
  maxPages: number;
  maxChars: number;
  /** Wall-clock budget for the whole document, checked before each page (P4). */
  budgetMs: number;
  /** Decoded bytes one non-image stream may produce (P3). */
  maxStreamBytes: number;
  /** Decoded bytes one image stream's non-image filters (e.g. Flate) may produce. */
  maxImageStreamBytes: number;
  /** Decoded bytes all streams together may produce, plus the ASCII input the ASCII decoders read (P3). */
  maxTotalBytes: number;
  /** Width × height × components a JPEG in the file may declare. */
  maxImageSamples: number;
};

/** Defaults, sized for receipts, tickets and statements (the upload cap is 10 MB). */
export const PDF_LIMITS: Readonly<PdfLimits> = {
  maxPages: MAX_PDF_PAGES,
  maxChars: MAX_EVIDENCE_TEXT_CHARS,
  budgetMs: 20_000,
  maxStreamBytes: 16 * 1024 * 1024,
  maxImageStreamBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxImageSamples: 64 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// The raw-bytes pre-pass (P3)
// ---------------------------------------------------------------------------

const LATIN1 = new TextDecoder("latin1");

/** Filters the pre-pass decodes under a cap, by their full and abbreviated names (pdf.js `Parser.makeFilter`). */
const CAPPABLE: Readonly<Record<string, "flate" | "a85" | "ahx">> = {
  FlateDecode: "flate", Fl: "flate", ASCII85Decode: "a85", A85: "a85", ASCIIHexDecode: "ahx", AHx: "ahx",
};
/** Decoded by pdf.js only to render an image, which the text path never does. */
const IMAGE_CODECS: ReadonlySet<string> = new Set(["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"]);
const JPEG_CODECS: ReadonlySet<string> = new Set(["DCTDecode", "DCT"]);

const REFUSED = {
  encrypted: "This PDF is encrypted. Upload an unlocked copy to have it read.",
  filter: (name: string) => `This PDF uses a compression (${name}) Recoup does not read.`,
  indirectFilter: "This PDF names its compression indirectly, which Recoup does not read.",
  bomb: "This PDF expands to more data than Recoup will read.",
  damaged: "This PDF has a damaged compressed stream.",
  image: "This PDF uses image compression outside an image, which Recoup does not read.",
  jpeg: "This PDF holds an image larger than Recoup will read.",
} as const;

export type PrePass =
  | { ok: true; streams: number; decodedBytes: number }
  | { ok: false; status: "needs_unlocked_copy" | "unreadable"; reason: string };

class Refusal extends Error {
  readonly status: "needs_unlocked_copy" | "unreadable";
  constructor(status: "needs_unlocked_copy" | "unreadable", reason: string) {
    super(reason);
    this.status = status;
  }
}

const NAME_ESCAPE = /\/[^\s()<>[\]{}/%]*#[0-9A-Fa-f]{2}[^\s()<>[\]{}/%]*/g;

/** `/Fil#74er` is `/Filter` to pdf.js; every name is compared after its `#xx` escapes are decoded. */
function decodeNameEscapes(text: string): string {
  if (!text.includes("#")) return text;
  return text.replace(NAME_ESCAPE, (name) => name.replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))));
}

/** A dictionary's text with its string literals, hex strings and comments removed (so a string cannot fake a key). */
function stripStringsAndComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (ch === "(") {
      let depth = 1;
      i++;
      while (i < text.length && depth > 0) {
        if (text[i] === "\\") i++;
        else if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      out += " ";
    } else if (ch === "<" && text[i + 1] !== "<") {
      while (i < text.length && text[i] !== ">") i++;
      i++;
      out += " ";
    } else if (ch === "<" || ch === ">") {
      out += text.slice(i, i + 2);
      i += 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** The top level of the dictionaries in `text`: whatever is nested inside an inner `<< >>` is blanked out. */
function topLevel(text: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === "<<") {
      depth++;
      out += depth <= 1 ? two : "  ";
      i++;
    } else if (two === ">>") {
      out += depth <= 1 ? two : "  ";
      depth = Math.max(0, depth - 1);
      i++;
    } else {
      out += depth <= 1 ? text[i] : " ";
    }
  }
  return out;
}

type FilterKey = { key: "Filter" | "F"; kind: "names"; names: string[] } | { key: "Filter" | "F"; kind: "indirect" | "other" };

/** Every `/Filter` and `/F` key in `text` (name-escapes already decoded) with the shape of its value. */
function filterKeys(text: string): FilterKey[] {
  const out: FilterKey[] = [];
  for (const m of text.matchAll(/\/(Filter|F)(?![^\s()<>[\]{}/%])/g)) {
    const key = m[1] as "Filter" | "F";
    const rest = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 512).replace(/^\s+/, "");
    if (rest.startsWith("/")) {
      const name = /^\/([^\s()<>[\]{}/%]*)/.exec(rest);
      out.push({ key, kind: "names", names: [name ? name[1] : ""] });
    } else if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      const body = close >= 0 ? rest.slice(1, close) : rest.slice(1);
      const tokens = body.trim().split(/\s+|(?=\/)/).filter((t) => t.length > 0);
      if (close < 0 || tokens.some((t) => !t.startsWith("/"))) out.push({ key, kind: "indirect" });
      else out.push({ key, kind: "names", names: tokens.map((t) => t.slice(1)) });
    } else if (/^\d+\s+\d+\s+R(?![^\s()<>[\]{}/%])/.test(rest)) {
      out.push({ key, kind: "indirect" });
    } else {
      out.push({ key, kind: "other" });
    }
  }
  return out;
}

function hasImageCodec(k: FilterKey): boolean {
  return k.kind === "names" && k.names.some((n) => IMAGE_CODECS.has(n));
}

/** The global rule: every filter name anywhere in the file is one the pre-pass caps or an image codec. */
function checkEveryFilterName(keys: readonly FilterKey[]): void {
  for (const k of keys) {
    if (k.kind === "indirect" && k.key === "Filter") throw new Refusal("unreadable", REFUSED.indirectFilter);
    if (k.kind === "other" && k.key === "Filter") throw new Refusal("unreadable", REFUSED.indirectFilter);
    if (k.kind !== "names") continue; // `/F 4` (annotation flags), `/F (file.pdf)`, `/F 12 0 R` (a file spec)
    for (const n of k.names) {
      if (CAPPABLE[n] === undefined && !IMAGE_CODECS.has(n)) throw new Refusal("unreadable", REFUSED.filter(n || "unnamed"));
    }
  }
}

/** pdf.js `Ascii85Stream`, byte for byte (it accepts any non-whitespace byte as a digit and stops at `~`). */
function decodeA85(data: Uint8Array, cap: number): { out: Uint8Array; read: number } {
  const out = new Uint8Array(Math.min(cap + 4, data.length * 4 + 4));
  let n = 0;
  let p = 0;
  const isWs = (c: number) => c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
  const next = () => (p < data.length ? data[p++] : -1);
  const input = new Array<number>(5);
  for (;;) {
    let c = next();
    while (isWs(c)) c = next();
    if (c === -1 || c === 0x7e) break;
    if (n + 4 > cap) throw new Refusal("unreadable", REFUSED.bomb);
    if (c === 0x7a) {
      out.fill(0, n, n + 4);
      n += 4;
      continue;
    }
    input[0] = c;
    let i: number;
    for (i = 1; i < 5; ++i) {
      c = next();
      while (isWs(c)) c = next();
      input[i] = c;
      if (c === -1 || c === 0x7e) break;
    }
    const produced = i - 1;
    let eof = false;
    if (i < 5) {
      for (let j = i; j < 5; j++) input[j] = 0x21 + 84;
      eof = true;
    }
    let t = 0;
    for (let j = 0; j < 5; ++j) t = t * 85 + (input[j] - 0x21);
    const group = [0, 0, 0, 0];
    for (let j = 3; j >= 0; --j) {
      group[j] = t & 0xff;
      t >>= 8;
    }
    for (let j = 0; j < produced; j++) out[n + j] = group[j];
    n += produced;
    if (eof) break;
  }
  return { out: out.subarray(0, n), read: p };
}

/** pdf.js `AsciiHexStream`: skips anything that is not a hex digit, stops at `>`. */
function decodeAHx(data: Uint8Array, cap: number): { out: Uint8Array; read: number } {
  const out = new Uint8Array(Math.min(cap + 1, (data.length + 1) >> 1));
  let n = 0;
  let first = -1;
  let p = 0;
  let eof = false;
  for (; p < data.length; p++) {
    const ch = data[p];
    let digit: number;
    if (ch >= 0x30 && ch <= 0x39) digit = ch & 0x0f;
    else if ((ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) digit = (ch & 0x0f) + 9;
    else if (ch === 0x3e) {
      eof = true;
      p++;
      break;
    } else continue;
    if (first < 0) first = digit;
    else {
      if (n >= cap) throw new Refusal("unreadable", REFUSED.bomb);
      out[n++] = (first << 4) | digit;
      first = -1;
    }
  }
  if (first >= 0 && eof && n < out.length) out[n++] = first << 4;
  return { out: out.subarray(0, n), read: p };
}

function inflateCapped(data: Uint8Array, cap: number): Uint8Array {
  try {
    // Z_SYNC_FLUSH: a truncated stream yields what it holds (pdf.js is as lenient); trailing bytes are ignored.
    return new Uint8Array(inflateSync(data, { maxOutputLength: cap, finishFlush: 2 }));
  } catch (err) {
    if (err instanceof RangeError) throw new Refusal("unreadable", REFUSED.bomb);
    throw err;
  }
}

/** Decodes one filter chain (image codecs already removed) under `cap`; returns the output and the ASCII input read. */
function decodeChain(data: Uint8Array, chain: readonly string[], cap: number): { out: Uint8Array; asciiRead: number } {
  let buf = data;
  let asciiRead = 0;
  for (const f of chain) {
    const kind = CAPPABLE[f];
    if (kind === "flate") buf = inflateCapped(buf, cap);
    else {
      const r = kind === "a85" ? decodeA85(buf, cap) : decodeAHx(buf, cap);
      buf = r.out;
      asciiRead += r.read;
    }
  }
  return { out: buf, asciiRead };
}

/** A zlib header (pdf.js checks the same two bytes): deflate method, a valid check value, no preset dictionary. */
function looksLikeZlib(data: Uint8Array): boolean {
  return data.length >= 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0 && (data[1] & 0x20) === 0;
}

/** A filter chain the data looks encoded with although no filter is visible for it (a mis-read dictionary). */
function sniffChain(data: Uint8Array): string[] | null {
  if (looksLikeZlib(data)) return ["FlateDecode"];
  // Only the first two decoded bytes matter; a short head decodes to at most 4 bytes per input byte.
  const head = data.subarray(0, 64);
  try {
    if (looksLikeZlib(decodeA85(head, 4 * head.length + 4).out)) return ["ASCII85Decode", "FlateDecode"];
    if (looksLikeZlib(decodeAHx(head, head.length).out)) return ["ASCIIHexDecode", "FlateDecode"];
  } catch {
    return null;
  }
  return null;
}

/**
 * The largest width × height × components a JPEG declares in a start-of-frame segment before its first scan
 * (pdf.js first skips any junk before the SOI marker). `null` when no frame header is found within bounded work.
 */
export function jpegFrameSamples(data: Uint8Array): number | null {
  let p = 0;
  const soiWindow = Math.min(data.length, 64 * 1024);
  while (p + 1 < soiWindow && !(data[p] === 0xff && data[p + 1] === 0xd8)) p++;
  if (p + 1 >= soiWindow) return null;
  p += 2;
  let samples: number | null = null;
  let steps = 0;
  while (p + 3 < data.length) {
    if (++steps > 100_000) return null;
    if (data[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = data[p + 1];
    if (marker === 0xff || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      p++;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image, or the first scan: the frame is declared by now
    const len = (data[p + 2] << 8) | data[p + 3];
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame && p + 9 < data.length) {
      const height = (data[p + 5] << 8) | data[p + 6];
      const width = (data[p + 7] << 8) | data[p + 8];
      const components = data[p + 9];
      // A zero height is filled in later by a DNL marker; count it as the largest height a JPEG can declare.
      const s = width * (height === 0 ? 0xffff : height) * Math.max(1, components);
      samples = Math.max(samples ?? 0, s);
    }
    if (len < 2) break;
    p += 2 + len;
  }
  return samples;
}

/**
 * P3: refuses, from the raw bytes alone, what pdf.js must not be given. `ok` carries only counts; nothing decoded
 * here is kept or handed on (pdf.js decodes the file again itself).
 */
export function prePass(bytes: Uint8Array, limits: Pick<PdfLimits, "maxStreamBytes" | "maxImageStreamBytes" | "maxTotalBytes" | "maxImageSamples">): PrePass {
  try {
    return runPrePass(bytes, limits);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, status: err.status, reason: err.message };
    return { ok: false, status: "unreadable", reason: REFUSED.damaged };
  }
}

function runPrePass(bytes: Uint8Array, limits: Pick<PdfLimits, "maxStreamBytes" | "maxImageStreamBytes" | "maxTotalBytes" | "maxImageSamples">): PrePass {
  const raw = LATIN1.decode(bytes);
  const text = decodeNameEscapes(raw);
  if (/\/Encrypt(?![^\s()<>[\]{}/%])/.test(text)) throw new Refusal("needs_unlocked_copy", REFUSED.encrypted);

  const everyKey = filterKeys(text);
  checkEveryFilterName(everyKey);
  const imageFiltersInFile = everyKey.filter(hasImageCodec).length;
  let imageFiltersOnImages = 0;

  const headers = [...raw.matchAll(/(?<![0-9])\d+\s+\d+\s+obj(?![^\s()<>[\]{}/%])/g)].map((m) => m.index ?? 0);
  let h = 0;
  let previousKeywordEnd = 0;
  let total = 0;
  let streams = 0;

  for (const m of raw.matchAll(/(?<![A-Za-z0-9])stream(?![A-Za-z0-9])/g)) {
    const at = m.index ?? 0;
    // The stream's data starts after the end of the keyword's line (pdf.js `Lexer.skipToNextLine`).
    let start = at + "stream".length;
    while (start < raw.length && raw[start] !== "\n" && raw[start] !== "\r") start++;
    if (raw[start] === "\r" && raw[start + 1] === "\n") start += 2;
    else start += 1;
    start = Math.min(start, bytes.length);

    // Its dictionary: after the last object header before the keyword, and after the previous keyword.
    while (h + 1 < headers.length && headers[h + 1] < at) h++;
    const header = headers.length > 0 && headers[h] < at ? headers[h] : 0;
    const from = Math.max(header, previousKeywordEnd);
    previousKeywordEnd = at + "stream".length;
    const dict = decodeNameEscapes(topLevel(stripStringsAndComments(raw.slice(from, at))));
    streams++;

    const keys = filterKeys(dict);
    const named = keys.filter((k) => k.kind === "names");
    if (keys.some((k) => k.kind === "indirect")) throw new Refusal("unreadable", REFUSED.indirectFilter);
    if (named.length > 1) throw new Refusal("unreadable", REFUSED.indirectFilter);
    const filters = named.length === 1 && named[0].kind === "names" ? named[0].names : [];
    const subtypes = [...dict.matchAll(/\/Subtype(?![^\s()<>[\]{}/%])\s*\/([^\s()<>[\]{}/%]*)/g)].map((s) => s[1]);
    const isImage = subtypes.length === 1 && subtypes[0] === "Image" && !/\/Subtype(?![^\s()<>[\]{}/%])\s*[^\s/]/.test(dict);

    const codecAt = filters.findIndex((f) => IMAGE_CODECS.has(f));
    if (codecAt >= 0) {
      if (!isImage || codecAt !== filters.length - 1) throw new Refusal("unreadable", REFUSED.image);
      imageFiltersOnImages++;
    }
    const chain = codecAt >= 0 ? filters.slice(0, codecAt) : filters;
    const cap = isImage ? limits.maxImageStreamBytes : limits.maxStreamBytes;
    const data = bytes.subarray(start);

    let decoded: Uint8Array | null = null;
    if (chain.length > 0) {
      const r = decodeChain(data, chain, cap);
      decoded = r.out;
      total += r.asciiRead;
    } else if (codecAt < 0) {
      // No filter visible: if the data still decodes to deflate data, decode it under the same caps anyway.
      const sniffed = sniffChain(data);
      if (sniffed) {
        try {
          const r = decodeChain(data, sniffed, cap);
          decoded = r.out;
          total += r.asciiRead;
        } catch (err) {
          if (err instanceof Refusal) throw err;
          decoded = null;
        }
      }
    }
    if (decoded) {
      total += decoded.byteLength;
      if (decodedHasEncrypt(decoded)) throw new Refusal("needs_unlocked_copy", REFUSED.encrypted);
    }
    if (codecAt >= 0 && JPEG_CODECS.has(filters[codecAt])) {
      const samples = jpegFrameSamples(decoded ?? data);
      if (samples === null || samples > limits.maxImageSamples) throw new Refusal("unreadable", REFUSED.jpeg);
    }
    if (total > limits.maxTotalBytes) throw new Refusal("unreadable", REFUSED.bomb);
  }
  if (imageFiltersOnImages !== imageFiltersInFile) throw new Refusal("unreadable", REFUSED.image);
  return { ok: true, streams, decodedBytes: total };
}

function decodedHasEncrypt(decoded: Uint8Array): boolean {
  const s = LATIN1.decode(decoded);
  return /\/Encrypt(?![^\s()<>[\]{}/%])/.test(decodeNameEscapes(s));
}

// ---------------------------------------------------------------------------
// pdf.js, text only (P1, P4)
// ---------------------------------------------------------------------------

/** What the extractor needs from pdf.js; injectable so a test can prove it is never called on a refused file. */
export type PdfjsLoader = () => Promise<{ getDocument: GetDocument }>;
type GetDocument = (src: Record<string, unknown>) => LoadingTask;
type LoadingTask = { promise: Promise<PdfDoc>; destroy: () => Promise<void> };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<PdfPage> };
type PdfPage = {
  getTextContent: () => Promise<{ items: ReadonlyArray<{ str?: string; hasEOL?: boolean }> }>;
  cleanup: () => unknown;
};

/**
 * The legacy (Node) build and its worker, imported lazily. In Node pdf.js always uses an in-thread worker; handing
 * it the worker module through `globalThis.pdfjsWorker` means it never has to `import()` a worker file by path,
 * which a bundle could not resolve. The worker entry ships without type declarations: `as string` only stops
 * TypeScript from looking for them (the bundler still sees, and bundles, the literal path).
 */
export const loadPdfjs: PdfjsLoader = async () => {
  const worker: unknown = await import("pdfjs-dist/legacy/build/pdf.worker.mjs" as string);
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  return { getDocument: pdfjs.getDocument as unknown as GetDocument };
};

/**
 * The only `getDocument` options this module ever passes (P1): bytes in, nothing fetched, nothing evaluated.
 * No URL and no CMap, standard-font, ICC or wasm location: pdf.js has nothing to fetch or read from disk.
 */
function documentOptions(data: Uint8Array): Record<string, unknown> {
  return {
    data,
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableStream: true,
    stopAtErrors: false,
    // Nothing that could decode an image or load wasm, even if a future text path asked for it.
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    maxImageSize: 0,
    verbosity: 0,
  };
}

/**
 * The text layer of one PDF, or the reason there is none. Never throws: every failure is a status the caller maps to
 * `extractionStatus` (`needs_unlocked_copy`, `over_page_cap`, `unreadable`). An image-only PDF is `ok` with empty text
 * (its quotes are `unverifiable`, `lib/quote`).
 */
export async function extractPdfText(bytes: Uint8Array, options: PdfTextOptions = {}, load: PdfjsLoader = loadPdfjs): Promise<PdfTextResult> {
  const o = { ...PDF_LIMITS, ...options };
  const startedAt = Date.now();
  if (!/^%PDF-/.test(LATIN1.decode(bytes.subarray(0, 5)))) return { status: "unreadable", reason: "This is not a PDF." };
  const pre = prePass(bytes, o);
  if (!pre.ok) return { status: pre.status, reason: pre.reason };

  let task: LoadingTask;
  let doc: PdfDoc;
  try {
    const { getDocument } = await load();
    // pdf.js takes ownership of (and may detach) the buffer it is given; give it a copy.
    task = getDocument(documentOptions(new Uint8Array(bytes)));
    doc = await task.promise;
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "PasswordException") {
      return { status: "needs_unlocked_copy", reason: "This PDF is password-protected. Upload an unlocked copy to have it read." };
    }
    return { status: "unreadable", reason: "This PDF could not be read." };
  }
  try {
    const pageCount = doc.numPages;
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) return { status: "unreadable", reason: "This PDF has no pages." };
    if (pageCount > o.maxPages) {
      return { status: "over_page_cap", pageCount, reason: `This PDF has ${pageCount} pages; Recoup reads at most ${o.maxPages}.` };
    }
    const pages: string[] = [];
    let text = "";
    let truncated = false;
    for (let n = 1; n <= pageCount && !truncated; n++) {
      if (Date.now() - startedAt > o.budgetMs) {
        return { status: "unreadable", pageCount, reason: "This PDF took too long to read." };
      }
      if (n > 1) {
        if (text.length >= o.maxChars) {
          truncated = true;
          break;
        }
        text += "\n";
      }
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        pageText += item.str + (item.hasEOL ? "\n" : "");
        if (text.length + pageText.length > o.maxChars) break;
      }
      page.cleanup();
      const room = o.maxChars - text.length;
      if (pageText.length > room) {
        pageText = pageText.slice(0, room);
        truncated = true;
      }
      text += pageText;
      pages.push(pageText);
    }
    while (pages.length < pageCount) pages.push("");
    return { status: "ok", pages, text, pageCount, truncated };
  } catch {
    return { status: "unreadable", reason: "This PDF could not be read." };
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
