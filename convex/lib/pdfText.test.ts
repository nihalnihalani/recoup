// @vitest-environment node
/**
 * M23 `lib/pdfText`: the pre-pass (P3), the text-only pdf.js path (P1, P4) and the text-layer card-number
 * pre-scan (DA-A-8, KS2). Every PDF is synthetic (`lib/pdfFixtures`); nothing is fetched or read from disk.
 */
import { promises as fsPromises } from "node:fs";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPdfText, jpegFrameSamples, loadPdfjs, prePass, PDF_LIMITS, type PdfjsLoader } from "./pdfText";
import {
  ascii85,
  buildPdf,
  flateBomb,
  stream,
  SYNTHETIC_PAN_RECEIPT_LINES,
  SYNTHETIC_RECEIPT_LINES,
  textPdf,
} from "./pdfFixtures";
import { textLayerHasPan, pdfRawText } from "./sniff";
import { containsPan } from "./pan";
import { uploadExtractionStatus } from "../evidence";

const MiB = 1024 * 1024;
/** Small caps so bomb fixtures stay small; the defaults are exercised separately. */
const SMALL = { maxStreamBytes: 1 * MiB, maxImageStreamBytes: 2 * MiB, maxTotalBytes: 3 * MiB };

/** The real pdf.js loader, wrapped so a test can assert it was (or was never) called. */
function spyLoader() {
  return vi.fn<PdfjsLoader>(() => loadPdfjs());
}

/** A pdf.js stand-in: `pages` pages, each `getPage` recorded; `onPage` runs before each page's text is returned. */
function fakeLoader(pages: number, text = (n: number) => `page ${n}`, onPage?: (n: number) => void) {
  const getPage = vi.fn(async (n: number) => {
    onPage?.(n);
    return { getTextContent: async () => ({ items: [{ str: text(n), hasEOL: false }] }), cleanup: () => undefined };
  });
  const load: PdfjsLoader = async () => ({
    getDocument: () => ({ promise: Promise.resolve({ numPages: pages, getPage }), destroy: async () => undefined }),
  });
  return { load: vi.fn(load), getPage };
}

/** A minimal JPEG header: SOI, one baseline frame of `w` × `h` × `c`, EOI. Never decoded on the text path. */
function jpegHeader(w: number, h: number, c = 3): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 8 + 3 * c, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, c, ...Array.from({ length: c }, (_, i) => [i + 1, 0x11, 0x00]).flat(), 0xff, 0xd9]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("pdfText: the text layer", () => {
  it("extracts the text of an uncompressed and a Flate-compressed synthetic receipt", async () => {
    for (const compress of [false, true]) {
      const result = await extractPdfText(textPdf([SYNTHETIC_RECEIPT_LINES], { compress }));
      expect(result.status).toBe("ok");
      if (result.status !== "ok") return;
      expect(result.pageCount).toBe(1);
      expect(result.truncated).toBe(false);
      for (const line of SYNTHETIC_RECEIPT_LINES) expect(result.text.replace(/\s+/g, " ")).toContain(line.replace(/\s+/g, " "));
    }
  });

  it("keeps each page's text separately, in order", async () => {
    const result = await extractPdfText(textPdf([["First page"], ["Second page"], ["Third page"]], { compress: true }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.pages.map((p) => p.trim())).toEqual(["First page", "Second page", "Third page"]);
    expect(result.text.split("\n").filter(Boolean).map((l) => l.trim())).toEqual(["First page", "Second page", "Third page"]);
  });

  it("never fetches or reads a file: a /URI link, a remote /F file spec and a missing standard font", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const readSpy = vi.spyOn(fsPromises, "readFile");
    const builtinFs = process.getBuiltinModule("fs/promises");
    const builtinReadSpy = vi.spyOn(builtinFs, "readFile");
    const pdf = textPdf([["Order 42"]], {
      compress: true,
      pageExtra: "/Annots [6 0 R 7 0 R]",
      extraObjects: [
        "<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /A << /S /URI /URI (https://example.invalid/track) >> >>",
        "<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /A << /S /GoToR /F << /Type /Filespec /FS /URL /F (https://example.invalid/x.pdf) >> /D [0 /Fit] >> >>",
      ],
    });
    const result = await extractPdfText(pdf);
    expect(result.status).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(builtinReadSpy).not.toHaveBeenCalled();
  });

  it("is ok with empty text for a PDF with no text layer", async () => {
    const result = await extractPdfText(textPdf([[]]));
    expect(result).toMatchObject({ status: "ok", pageCount: 1, text: "" });
  });

  it("refuses bytes that are not a PDF, and a PDF pdf.js cannot open, as unreadable", async () => {
    expect(await extractPdfText(new TextEncoder().encode("hello"))).toMatchObject({ status: "unreadable" });
    expect(await extractPdfText(new TextEncoder().encode("%PDF-1.7\nnothing else at all\n"))).toMatchObject({ status: "unreadable" });
  });

  it("maps pdf.js's PasswordException to needs_unlocked_copy", async () => {
    const load: PdfjsLoader = async () => ({
      getDocument: () => ({
        promise: Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })),
        destroy: async () => undefined,
      }),
    });
    expect(await extractPdfText(textPdf([["x"]]), {}, load)).toMatchObject({ status: "needs_unlocked_copy" });
  });
});

describe("pdfText: page cap, budget and text cap (P4)", () => {
  it("refuses more than 20 pages as over_page_cap before reading any page", async () => {
    const real = await extractPdfText(textPdf(Array.from({ length: 21 }, (_, i) => [`p${i + 1}`])));
    expect(real).toMatchObject({ status: "over_page_cap", pageCount: 21 });
    const fake = fakeLoader(PDF_LIMITS.maxPages + 1);
    expect(await extractPdfText(textPdf([["x"]]), {}, fake.load)).toMatchObject({ status: "over_page_cap" });
    expect(fake.getPage).not.toHaveBeenCalled();
    const exactly = fakeLoader(PDF_LIMITS.maxPages);
    expect(await extractPdfText(textPdf([["x"]]), {}, exactly.load)).toMatchObject({ status: "ok", pageCount: 20 });
  });

  it("pdfText: stops at the page budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
    // Each page takes 8 s against a 20 s budget: pages 1–3 start in time, page 4 would start at 24 s.
    const fake = fakeLoader(5, (n) => `page ${n}`, () => vi.setSystemTime(Date.now() + 8_000));
    const result = await extractPdfText(textPdf([["x"]]), { budgetMs: 20_000 }, fake.load);
    expect(result).toMatchObject({ status: "unreadable", pageCount: 5 });
    expect(fake.getPage).toHaveBeenCalledTimes(3);
    // The real pdf.js path honours the budget too.
    vi.useRealTimers();
    expect(await extractPdfText(textPdf([["x"], ["y"]]), { budgetMs: -1 })).toMatchObject({ status: "unreadable" });
  });

  it("stops at the character cap as it reads, and never reads the pages after it", async () => {
    const fake = fakeLoader(4, () => "x".repeat(30));
    const result = await extractPdfText(textPdf([["x"]]), { maxChars: 50 }, fake.load);
    expect(result).toMatchObject({ status: "ok", truncated: true, pageCount: 4 });
    if (result.status !== "ok") return;
    expect(result.text.length).toBeLessThanOrEqual(50);
    expect(result.text).toBe(`${"x".repeat(30)}\n${"x".repeat(19)}`);
    expect(fake.getPage).toHaveBeenCalledTimes(2);
    expect(result.pages).toHaveLength(4);
    const real = await extractPdfText(textPdf([["A".repeat(80)], ["B".repeat(80)]]), { maxChars: 60 });
    expect(real).toMatchObject({ status: "ok", truncated: true });
    if (real.status === "ok") expect(real.text.length).toBeLessThanOrEqual(60);
  });
});

describe("pdfText: the raw-bytes pre-pass (P3) — pdf.js is never called", () => {
  const refused = async (pdf: Uint8Array, status: "unreadable" | "needs_unlocked_copy", limits: Parameters<typeof extractPdfText>[1] = SMALL) => {
    const load = spyLoader();
    const result = await extractPdfText(pdf, limits, load);
    expect(result.status).toBe(status);
    expect(load).not.toHaveBeenCalled();
    return result;
  };

  it("Flate bomb in a content stream (small caps, and the defaults)", async () => {
    const pdf = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      stream("/Filter /FlateDecode", flateBomb(4 * MiB)),
    ]);
    await refused(pdf, "unreadable");
    const big = buildPdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      stream("/Filter /FlateDecode", flateBomb(PDF_LIMITS.maxStreamBytes + MiB)),
    ]);
    await refused(big, "unreadable", {});
  });

  it("LZW bomb, RunLength bomb, Brotli, Crypt and an unknown filter (full and abbreviated names)", async () => {
    for (const filter of ["/LZWDecode", "/LZW", "/RunLengthDecode", "/RL", "/BrotliDecode", "/Crypt", "/MadeUpDecode", "[/FlateDecode /LZWDecode]"]) {
      const pdf = textPdf([["x"]], { extraObjects: [stream(`/Filter ${filter}`, new Uint8Array(64).fill(0x80))] });
      await refused(pdf, "unreadable");
    }
  });

  it("A85 → Flate chained bomb, and AHx → Flate", async () => {
    const a85 = textPdf([["x"]], { extraObjects: [stream("/Filter [/ASCII85Decode /FlateDecode]", ascii85(flateBomb(4 * MiB)))] });
    await refused(a85, "unreadable");
    const hex = Buffer.from(flateBomb(4 * MiB)).toString("hex");
    const ahx = textPdf([["x"]], { extraObjects: [stream("/Filter [/AHx /Fl]", `${hex}>`)] });
    await refused(ahx, "unreadable");
  });

  it("bomb inside an /ObjStm", async () => {
    const pdf = textPdf([["x"]], { extraObjects: [stream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", flateBomb(4 * MiB))] });
    await refused(pdf, "unreadable");
  });

  it.each([
    ["an XRef stream", "/Type /XRef /Size 3 /W [1 2 1] /Filter /FlateDecode"],
    ["a ToUnicode CMap", "/Filter /FlateDecode"],
    ["an embedded font program", "/Length1 100 /Filter /FlateDecode"],
    ["a Form XObject", "/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F 3 0 R >> >> /Filter /FlateDecode"],
  ])("bomb in %s", async (_, dict) => {
    await refused(textPdf([["x"]], { extraObjects: [stream(dict, flateBomb(4 * MiB))] }), "unreadable");
  });

  it("bomb behind a wrong /Length (too short) and behind an indirect /Length", async () => {
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /FlateDecode", flateBomb(4 * MiB), 10)] }), "unreadable");
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /FlateDecode", flateBomb(4 * MiB), "99 0 R")] }), "unreadable");
  });

  it("bomb whose filter is hidden: #xx-escaped names, the /F key, an indirect filter, or no visible filter at all", async () => {
    const hidden = [
      stream("/Fil#74er /LZW#44ecode", new Uint8Array(8)),
      stream("/F /LZWDecode", new Uint8Array(8)),
      stream("/Filter 9 0 R", new Uint8Array(8)),
      stream("/Filter [9 0 R]", new Uint8Array(8)),
      stream("/F 9 0 R", new Uint8Array(8)),
      stream("/Filter /Fl#61teDecode", flateBomb(4 * MiB)),
      stream("/Foo (/Subtype /Image)", flateBomb(4 * MiB)),
      stream("", ascii85(flateBomb(4 * MiB))),
    ];
    for (const obj of hidden) await refused(textPdf([["x"]], { extraObjects: [obj] }), "unreadable");
  });

  it("many small streams that add up past the document cap", async () => {
    const extra = Array.from({ length: 4 }, () => stream("/Filter /FlateDecode", flateBomb(900 * 1024)));
    await refused(textPdf([["x"]], { extraObjects: extra }), "unreadable");
  });

  it("owner-password-only PDF (an /Encrypt entry, no user password), also #xx-escaped or inside an /ObjStm", async () => {
    const encryptDict = `<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`;
    const pdf = textPdf([["x"]], { extraObjects: [encryptDict], trailer: "/Encrypt 6 0 R /ID [<00112233445566778899aabbccddeeff> <00112233445566778899aabbccddeeff>] " });
    await refused(pdf, "needs_unlocked_copy");
    await refused(textPdf([["x"]], { extraObjects: [encryptDict], trailer: "/Encr#79pt 6 0 R " }), "needs_unlocked_copy");
    const objStm = stream("/Type /ObjStm /N 1 /First 5 /Filter /FlateDecode", new Uint8Array(deflateSync(Buffer.from("7 0 << /Encrypt 6 0 R >>"))));
    await refused(textPdf([["x"]], { extraObjects: [objStm] }), "needs_unlocked_copy");
  });

  it("image codecs: allowed as an image XObject's last filter, refused anywhere else, and a JPEG's frame is bounded", async () => {
    const image = (dict: string, data: Uint8Array) =>
      textPdf([["Receipt with a logo"]], { extraObjects: [stream(`/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 ${dict}`, data)] });
    const ok = await extractPdfText(image("/Filter /DCTDecode", jpegHeader(16, 16)));
    expect(ok.status).toBe("ok");
    expect((await extractPdfText(image("/Filter [/FlateDecode /DCTDecode]", new Uint8Array(deflateSync(jpegHeader(16, 16)))))).status).toBe("ok");
    expect((await extractPdfText(image("/Filter /JPXDecode", new Uint8Array(32)))).status).toBe("ok");
    await refused(image("/Filter /DCTDecode", jpegHeader(0xffff, 0xffff)), "unreadable", {});
    await refused(image("/Filter [/DCTDecode /FlateDecode]", jpegHeader(16, 16)), "unreadable");
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /DCTDecode", jpegHeader(16, 16))] }), "unreadable");
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /JBIG2Decode", new Uint8Array(32))] }), "unreadable");
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /CCITTFaxDecode /Foo (/Subtype /Image)", new Uint8Array(32))] }), "unreadable");
    expect(jpegFrameSamples(jpegHeader(640, 480, 3))).toBe(640 * 480 * 3);
    expect(jpegFrameSamples(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("a declared filter chain that does not decode is refused (fail closed)", async () => {
    await refused(textPdf([["x"]], { extraObjects: [stream("/Filter /FlateDecode", "this is not deflate data")] }), "unreadable");
  });

  it("an ordinary PDF passes the pre-pass with its streams counted", () => {
    const result = prePass(textPdf([["a"], ["b"]], { compress: true }), PDF_LIMITS);
    expect(result).toMatchObject({ ok: true, streams: 2 });
  });

  it("the structures real producers write pass: XRef and object streams, fonts, forms, images, metadata, annotation flags", async () => {
    const extra = [
      stream("/Type /XRef /Size 12 /W [1 2 1] /Filter /FlateDecode /DecodeParms << /Columns 4 /Predictor 12 >>", new Uint8Array(deflateSync(new Uint8Array(48)))),
      stream("/Type /ObjStm /N 1 /First 4 /Filter /FlateDecode", new Uint8Array(deflateSync(Buffer.from("20 0 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")))),
      stream("/Length1 1024 /Filter /FlateDecode", new Uint8Array(deflateSync(new Uint8Array(1024)))),
      stream("/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /F 3 0 R >> >> /Filter /FlateDecode", new Uint8Array(deflateSync(Buffer.from("BT /F 9 Tf (logo) Tj ET")))),
      stream("/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode", jpegHeader(16, 16)),
      stream("/Type /Metadata /Subtype /XML", "<x:xmpmeta><rdf:Description>a live stream<br/>stream of receipts</rdf:Description></x:xmpmeta>"),
    ];
    const pdf = textPdf([["Order 42"]], { compress: true, pageExtra: "/Annots [12 0 R]", extraObjects: [...extra, "<< /Type /Annot /Subtype /Link /F 4 /Rect [0 0 1 1] >>"] });
    expect(prePass(pdf, PDF_LIMITS)).toMatchObject({ ok: true });
    expect((await extractPdfText(pdf)).status).toBe("ok");
  });
});

describe("pdfText: the text-layer card-number pre-scan (DA-A-8, KS2)", () => {
  it("a receipt with a test card number in its compressed text layer → store_only", async () => {
    const pdf = textPdf([SYNTHETIC_PAN_RECEIPT_LINES], { compress: true });
    // The raw bytes hide it (the content stream is compressed): only the text layer shows it.
    expect(containsPan(pdfRawText(pdf))).toBe(false);
    const result = await extractPdfText(pdf);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(containsPan(result.text)).toBe(false); // lib/pan alone misses the double spaces (rule c) ...
    const panDetected = textLayerHasPan(result.text); // ... KS2's normalization catches them
    expect(panDetected).toBe(true);
    const decision = uploadExtractionStatus({ mime: "application/pdf", declaredDocType: "receipt", encrypted: false, panDetected, liveExtractionOn: true });
    expect(decision.status).toBe("store_only");
  });

  it("the same receipt without the card number is not flagged", async () => {
    const result = await extractPdfText(textPdf([SYNTHETIC_RECEIPT_LINES], { compress: true }));
    expect(result.status === "ok" && textLayerHasPan(result.text)).toBe(false);
  });
});
