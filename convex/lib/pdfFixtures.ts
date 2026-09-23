"use node";
/**
 * Synthetic PDFs, built byte by byte, for `lib/pdfText`'s tests and the gated `testingPdf:extractSyntheticPdf`
 * deployment check (M23). No user data and no file on disk: every document here is assembled from the literals below,
 * with a correct cross-reference table unless a fixture is deliberately broken.
 */
import { deflateSync } from "node:zlib";

function bytesOf(s: string): Uint8Array {
  // Latin-1: one byte per char, so a PDF string can carry WinAnsi bytes such as 0x96 (en dash).
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One indirect object's body: a dictionary or other direct object, or a stream (dictionary + data). */
export type PdfObject = string | { dict: string; data: Uint8Array; length?: number | string };

/** A stream object whose `/Length` is the real data length unless `length` overrides it (e.g. a wrong or indirect one). */
export function stream(dict: string, data: Uint8Array | string, length?: number | string): PdfObject {
  return { dict, data: typeof data === "string" ? bytesOf(data) : data, length };
}

/**
 * Objects 1..n in order, a classic xref table and a trailer whose `/Root` is object 1. `trailer` adds entries
 * (e.g. `/Encrypt 9 0 R`).
 */
export function buildPdf(objects: readonly PdfObject[], trailer = ""): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [bytesOf("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  let offset = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(offset);
    let chunk: Uint8Array;
    if (typeof obj === "string") {
      chunk = bytesOf(`${i + 1} 0 obj\n${obj}\nendobj\n`);
    } else {
      const length = obj.length ?? obj.data.length;
      chunk = concat([
        bytesOf(`${i + 1} 0 obj\n<< ${obj.dict} /Length ${length} >>\nstream\n`),
        obj.data,
        bytesOf("\nendstream\nendobj\n"),
      ]);
    }
    parts.push(chunk);
    offset += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(bytesOf(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailer}>>\nstartxref\n${offset}\n%%EOF\n`));
  return concat(parts);
}

/** A PDF string literal for ASCII text. */
function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

/** A content stream that shows each line on its own line, Helvetica 11 pt. */
export function contentFor(lines: readonly string[]): string {
  const ops = ["BT", "/F1 11 Tf", "14 TL", "72 740 Td"];
  for (const line of lines) ops.push(`${pdfString(line)} Tj T*`);
  ops.push("ET");
  return ops.join("\n");
}

export type TextPdfOptions = {
  /** Flate-compress each page's content stream (the usual case in real PDFs). */
  compress?: boolean;
  /** Extra entries for every page dictionary. */
  pageExtra?: string;
  /** Extra objects appended after the pages (numbered from `3 + 2 × pages + 1`). */
  extraObjects?: readonly PdfObject[];
  trailer?: string;
};

/**
 * A text PDF: object 1 catalog, 2 page tree, 3 the font, then each page followed by its content stream. Uses the
 * standard 14 Helvetica with WinAnsiEncoding, so pdf.js needs no font file to map its text.
 */
export function textPdf(pages: ReadonlyArray<readonly string[]>, opts: TextPdfOptions = {}): Uint8Array<ArrayBuffer> {
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objects: PdfObject[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  pages.forEach((lines, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R ${opts.pageExtra ?? ""}>>`);
    const content = contentFor(lines);
    objects.push(opts.compress ? stream("/Filter /FlateDecode", deflateSync(bytesOf(content))) : stream("", content));
  });
  objects.push(...(opts.extraObjects ?? []));
  return buildPdf(objects, opts.trailer);
}

/** ASCII85 as PDF writes it, ending in `~>`. */
export function ascii85(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let v = 0;
    for (let j = 0; j < 4; j++) v = v * 256 + (j < chunk.length ? chunk[j] : 0);
    if (chunk.length === 4 && v === 0) {
      out += "z";
      continue;
    }
    const digits: number[] = [];
    for (let j = 0; j < 5; j++) {
      digits.unshift(v % 85);
      v = Math.floor(v / 85);
    }
    out += digits.slice(0, chunk.length + 1).map((d) => String.fromCharCode(d + 33)).join("");
  }
  return `${out}~>`;
}

/** Deflated zeros: `size` bytes once inflated, about a thousandth of that compressed. */
export function flateBomb(size: number): Uint8Array {
  return new Uint8Array(deflateSync(new Uint8Array(size), { level: 9 }));
}

/** The one-page synthetic receipt the deployment check reads (no card number). */
export const SYNTHETIC_RECEIPT_LINES: readonly string[] = [
  "Example Outfitters - Order receipt",
  "Order 112-3456789-1234562",
  "Ordered on March 3, 2026",
  "Trail runner shoes      1 x $89.00",
  "Subtotal $89.00  Tax $7.34  Total $96.34",
  "Paid with Visa ending in 1111",
];

/**
 * The same receipt with a test card number in its (compressed) text layer, its groups joined by en dashes (WinAnsi
 * 0x96), which pdf.js keeps as U+2013 and `lib/pan` alone does not read as a separator (KS2).
 */
export const SYNTHETIC_PAN_RECEIPT_LINES: readonly string[] = [
  ...SYNTHETIC_RECEIPT_LINES.slice(0, 5),
  "Card 4111\x961111\x961111\x961111",
];
