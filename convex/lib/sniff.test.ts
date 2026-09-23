import { describe, expect, it } from "vitest";
import { isHeicFamily, normalizeDigitSeparators, pdfLooksEncrypted, pdfRawText, sniffMime, textLayerHasPan } from "./sniff";
import { containsPan } from "./pan";

const bytes = (...parts: Array<string | number[]>) => {
  const out: number[] = [];
  for (const p of parts) {
    if (typeof p === "string") for (const ch of p) out.push(ch.charCodeAt(0));
    else out.push(...p);
  }
  return new Uint8Array(out);
};
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const FIXTURES = {
  pdf: bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n"),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0, 1, 2, 3]),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0, 0, 0, 13], "IHDR", [0, 0, 0, 1]),
  webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 ", [0, 0, 0, 0]),
  heic: bytes(be32(24), "ftyp", "heic", [0, 0, 0, 0], "mif1", "heic", [0, 0, 0, 0]),
  heifGeneric: bytes(be32(24), "ftyp", "mif1", [0, 0, 0, 0], "mif1", "heic", [0, 0, 0, 0]),
};

describe("lib/sniff — magic bytes decide the type (SEC-UP-3)", () => {
  it("accepts exactly PDF, JPEG, PNG, WebP and HEIC/HEIF", () => {
    expect(sniffMime(FIXTURES.pdf)).toBe("application/pdf");
    expect(sniffMime(FIXTURES.jpeg)).toBe("image/jpeg");
    expect(sniffMime(FIXTURES.png)).toBe("image/png");
    expect(sniffMime(FIXTURES.webp)).toBe("image/webp");
    expect(sniffMime(FIXTURES.heic)).toBe("image/heic");
    expect(sniffMime(FIXTURES.heifGeneric)).toBe("image/heif");
    expect(isHeicFamily("image/heic")).toBe(true);
    expect(isHeicFamily("image/png")).toBe(false);
  });

  it("refuses SVG, HTML, XML, Office/zip, AVIF, plain text, executables and empty input — whatever they are called", () => {
    const refused = [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
      bytes('<?xml version="1.0"?><svg/>'),
      bytes("<!doctype html><html><body>hi</body></html>"),
      bytes("  <html>"),
      bytes("PK", [3, 4], "word/document.xml"),
      bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), // legacy Office
      bytes(be32(24), "ftyp", "avif", [0, 0, 0, 0], "mif1", "avif", [0, 0, 0, 0]),
      bytes(be32(24), "ftyp", "mif1", [0, 0, 0, 0], "mif1", "avif", [0, 0, 0, 0]),
      bytes("MZ", [0x90, 0]),
      bytes([0x7f], "ELF"),
      bytes("GIF89a"),
      bytes("hello, this is a receipt"),
      bytes("RIFF", [0, 0, 0, 0], "WAVEfmt "),
      new Uint8Array(0),
      bytes([0x89, 0x50, 0x4e]), // truncated PNG header
    ];
    for (const b of refused) expect(sniffMime(b)).toBeNull();
  });

  it("an HEIF box header with an absurd size is not a HEIF", () => {
    expect(sniffMime(bytes(be32(0x7fffffff), "ftyp", "heic", [0, 0, 0, 0]))).toBeNull();
    expect(sniffMime(bytes(be32(8), "ftyp", "heic", [0, 0, 0, 0]))).toBeNull();
  });

  it("finds an /Encrypt trailer entry and the uncompressed text of a PDF (the DA-A-8 card-number pre-scan input)", () => {
    expect(pdfLooksEncrypted(FIXTURES.pdf)).toBe(false);
    expect(pdfLooksEncrypted(bytes("%PDF-1.7\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>"))).toBe(true);
    const withCard = bytes("%PDF-1.4\nBT /F1 12 Tf (Card 4111 1111 1111 1111 exp 12/27) Tj ET");
    expect(containsPan(pdfRawText(withCard))).toBe(true);
    expect(containsPan(pdfRawText(FIXTURES.pdf))).toBe(false);
  });
});

describe("lib/sniff — text-layer card-number pre-scan, KS2 separator normalization (DA-A-8, D165)", () => {
  const ch = (code: number) => String.fromCharCode(code);
  const TEST_PAN = ["4111", "1111", "1111", "1111"];
  const GAPS: ReadonlyArray<[string, string]> = [
    ["two spaces", "  "],
    ["a tab", ch(0x09)],
    ["a no-break space", ch(0x00a0)],
    ["a figure space", ch(0x2007)],
    ["a thin space", ch(0x2009)],
    ["a narrow no-break space", ch(0x202f)],
    ["an ideographic space", ch(0x3000)],
    ["a space and a tab", ` ${ch(0x09)}`],
  ];
  const DASHES: ReadonlyArray<[string, string]> = [
    ["a non-breaking hyphen", ch(0x2011)],
    ["a figure dash", ch(0x2012)],
    ["an en dash", ch(0x2013)],
    ["an em dash", ch(0x2014)],
    ["a minus sign", ch(0x2212)],
    ["a full-width hyphen-minus", ch(0xff0d)],
  ];

  it.each(GAPS)("folds %s between digit groups into one space, so the card number is found", (_, gap) => {
    const text = `Card ${TEST_PAN.join(gap)} on file`;
    expect(containsPan(text)).toBe(false); // lib/pan alone (single separators, rule c) misses it
    expect(normalizeDigitSeparators(text)).toBe(`Card ${TEST_PAN.join(" ")} on file`);
    expect(textLayerHasPan(text)).toBe(true);
  });

  it.each(DASHES)("reads %s between digit groups as a hyphen, so the card number is found", (_, dash) => {
    const text = `Card ${TEST_PAN.join(dash)}`;
    expect(containsPan(text)).toBe(false);
    expect(normalizeDigitSeparators(text)).toBe(`Card ${TEST_PAN.join("-")}`);
    expect(textLayerHasPan(text)).toBe(true);
  });

  it("never joins digits across a line break, and leaves gaps that are not between two digits alone", () => {
    expect(normalizeDigitSeparators("4111 1111\n1111 1111")).toBe("4111 1111\n1111 1111");
    expect(textLayerHasPan("4111 1111\n1111 1111")).toBe(false);
    expect(normalizeDigitSeparators("Total  $96.34 " + ch(0x2013) + " paid")).toBe("Total  $96.34 " + ch(0x2013) + " paid");
  });

  it.each([
    ["an IMEI", "IMEI 352099001761481"],
    ["an e-ticket number", "E-ticket 4221234567897"],
    ["an order reference", "Order 112-3456789-1234562"],
    ["an EAN-13 barcode", "EAN 4006381333932"],
  ])("keeps %s unchanged and unflagged", (_, sample) => {
    expect(normalizeDigitSeparators(sample)).toBe(sample);
    expect(textLayerHasPan(sample)).toBe(false);
  });
});
