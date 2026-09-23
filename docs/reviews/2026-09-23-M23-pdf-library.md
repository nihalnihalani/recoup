# M23 — PDF text-layer library choice (D145, D200)

Author: `opus-ingestion-integrations-engineer`, self-reported model Opus 5.5 / `claude-opus-5-5`. Reviewed by `opus-security-privacy-reviewer`: **OK with conditions P1–P6** (security baseline §7, 0c1c03a; lead D203). Registry and advisory facts below were read on 2026-09-23 from `npm view` and the GitHub advisory API. This note records what was built against P1–P4; P5 (CI advisory gate + 7-day pdf.js patch rule) and P6 (security re-review) gate the D145 flag, not this lane.

**Need:** a deterministic PDF text layer inside one `"use node"` action (`convex/lib/pdfText.ts`), for three uses: the DA-A-8 card-number pre-scan, DA-A-6 quote verification (`lib/quote.ts`), and page counting (`over_page_cap`). Rendering, OCR, forms and scripting are out of scope.

| Candidate (latest) | License | Unpacked | Runtime deps | Advisories (GHSA) | Verdict |
|---|---|---|---|---|---|
| **pdfjs-dist 6.3.289** (Mozilla pdf.js) | Apache-2.0 | 34.8 MB (legacy + modern builds, maps, cmaps, fonts) | optional `@napi-rs/canvas` (native, rendering only) | CVE-2024-4367 (<4.2.67), CVE-2026-16633 (≥5.6.83 <6.2.108, `enableScripting` in the viewer); **6.3.289 is past both** | **Chosen** |
| unpdf 1.8.1 (UnJS) | MIT | 2.1 MB | optional peer canvas | none on `unpdf` itself, but it **bundles pdf.js ~6.1.200**, which is inside CVE-2026-16633's range, invisible to audit | Rejected: a vendored pdf.js lags upstream fixes |
| pdf-parse 2.4.5 | Apache-2.0 | 21.3 MB | pdfjs-dist 5.4.296 **plus a hard native `@napi-rs/canvas`** | inherits pdf.js | Rejected: native dependency; a wrapper around an older pdf.js |
| pdf2json 4.1.0 / pdfreader | Apache-2.0 / MIT | 11.9 MB | none / pdf2json | none listed | Rejected: a fork of an old pdf.js, with a thin security track record |
| mupdf 1.28.1 | AGPL-3.0 | 14.3 MB | WASM | — | Rejected: license |

**Choice: `pdfjs-dist@6.3.289`, pinned exactly** in `dependencies` (no caret). Lockfile integrity `sha512-ZHjSVpDa3D6izMq8/04lvkhkATUmL9px6ChPaXc1k6nU2Mrhlg1/7F0bdUqCwUjw3NsPTfPZsMDUU6ZIcRaeQw==`. It is first-party pdf.js, receives the fastest security fixes, and `npm audit` sees it directly. `convex/lib/pdfText.static.test.ts` fails if the pin, the integrity or the single lockfile copy changes.

## How it runs (`convex/lib/pdfText.ts`, `"use node"`)

**P1: text only, one library, nothing fetched.**
- Imports only `pdfjs-dist/legacy/build/pdf.mjs` and its worker `pdf.worker.mjs`, lazily, on first use. The worker module is handed to pdf.js through `globalThis.pdfjsWorker` (the in-thread worker pdf.js always uses in Node), so pdf.js never imports a worker file by path.
- `getDocument({ data })` with exactly: `isEvalSupported: false`, `enableXfa: false`, `disableFontFace: true`, `useSystemFonts: false`, `useWorkerFetch: false`, `disableAutoFetch: true`, `disableStream: true`, `stopAtErrors: false`, `useWasm: false`, `isOffscreenCanvasSupported: false`, `isImageDecoderSupported: false`, `maxImageSize: 0`, `verbosity: 0`. No URL and no CMap, standard-font, ICC or wasm location: in Node pdf.js reads those with `fs.readFile`, so with none given it has nothing to fetch or read. No password is ever passed.
- Only `getTextContent()` per page. A static test fails if any `convex/` source (comments aside) contains `render(`, `getOperatorList`, `getAnnotations`, `pdf.scripting`, `cMapUrl`, `standardFontDataUrl`, `wasmUrl` or `iccUrl`, if `lib/pdfText` has a `url:` or `password:` key, or if anything but `lib/pdfText` imports pdf.js or imports another entry of it.
- A test extracts a PDF carrying a `/URI` link and a remote `/F` file spec with `fetch`, `fs.promises.readFile` and the builtin `fs/promises` `readFile` all spied, and asserts none was called.
- **Security's correction applies:** pdf.js's Node build `require`s `@napi-rs/canvas` **eagerly, the moment it is imported** (`node_utils.js`, via `process.getBuiltinModule("module").createRequire(import.meta.url)`), to polyfill `DOMMatrix`/`Path2D` for rendering; it is not only loaded when rendering. The text path never needs it. `pdfText: extracts text with canvas unavailable` (`pdfText.nocanvas.test.ts`) makes the addon unloadable before pdf.js is first imported, extracts text, and asserts the require was attempted and refused and that `DOMMatrix`/`Path2D` stayed undefined.

**P2: runtime and bytes.**
- `convex.json` is exactly `{"node": {"nodeVersion": "22"}}`, with no `externalPackages`: pdf.js is **bundled**. `engines.node` is `>=22.13 <23` (pdf.js 6.3.289 declares `>=22.13.0 || >=24`), in `package.json` and the lockfile root.
- The action reads the bytes itself with `ctx.storage.get`; bytes are never an action argument (the 5 MiB argument limit). The gated `testingPdf:extractSyntheticPdf` does exactly that with a synthetic PDF it stores, reads back and deletes.
- **Bundling proven locally:** `npx convex dev --once --typecheck disable --codegen disable --debug-bundle-path <empty dir>` bundles and stops ("Skipping rest of push"; nothing is pushed). The node bundle has `externalPackages: []`, `nodeDependencies: []`, `nodeVersion: "22"`. pdf.js is split into two lazily imported chunks (≈0.7 MB main build, ≈1.7 MB worker). The canvas `require` survives as a runtime `createRequire(import.meta.url)("@napi-rs/canvas")` that nothing can resolve from the bundle's location. Running the bundled `lib/pdfText.js` from a directory with no `node_modules` above it printed pdf.js's `Cannot load "@napi-rs/canvas"` warning plus the two polyfill warnings, left `DOMMatrix` undefined, and extracted both synthetic receipts. Expect the same three warning lines in the deployment's logs the first time the action runs (pdf.js is imported lazily, so not at deploy time).
- **Still to prove on `adorable-lion-138`** (lead deploys): the push, one synthetic extraction (`npx convex run testingPdf:extractSyntheticPdf '{}'` → `status: "ok"`, `panDetected: false`, `canvasLoaded: false`, `nodeVersion` v22.x; with `'{"variant":"card_number"}'` → `panDetected: true`), and whether the canvas warning line appears in the logs.

**P3: the raw-bytes pre-pass, before pdf.js sees the file.** It never trusts the xref, `/Length` or the object structure, all of which pdf.js repairs.
- Any `/Encrypt` → `needs_unlocked_copy`, also when written with `#xx` name escapes and also inside any decoded stream (e.g. an `/ObjStm`). An owner-password-only PDF opens in pdf.js without a `PasswordException`, so this check is what catches it. A `PasswordException` from pdf.js also maps to `needs_unlocked_copy`.
- Every `/Filter` **and `/F`** key in the file (pdf.js reads `dict.get("F", "Filter")` on every stream) is read after decoding `#xx` name escapes. It must be a direct name or an array of names from the capped set (Flate, ASCII85, ASCIIHex, full or abbreviated) or an image codec. **LZW, RunLength, Brotli, Crypt, any unknown name, or an indirect `/Filter` → `unreadable`.**
- Every `stream` token pdf.js could see (a superset: any `stream` not inside a longer word) is found by scanning the raw bytes, not the xref. Its data starts after that line, as in pdf.js `skipToNextLine`, and **runs to the end of the file**. The whole filter chain is decoded from there:
  - Flate via `zlib.inflateSync({ maxOutputLength, finishFlush: Z_SYNC_FLUSH })`, which stops at the end of the deflate data exactly as pdf.js does and ignores what follows;
  - ASCII85 and ASCIIHex re-implemented byte for byte from pdf.js's own decoders.
  - So a wrong, missing or indirect `/Length` hides nothing: pdf.js cannot get more out of a stream than this decode does.
- **Caps:** 16 MiB decoded per stream, 64 MiB per stream whose dictionary says `/Subtype /Image`, and 128 MiB per document (decoded output plus the ASCII input read). Over any cap → `unreadable`. A declared chain that fails to decode → `unreadable` (fail closed).
- A stream's dictionary is the text between its object header and the keyword, with string literals, hex strings, comments and nested dictionaries removed, so a string cannot fake a key. When no filter is visible but the data still starts as deflate data (directly, or under ASCII85/ASCIIHex), it is inflated under the same caps anyway.
- **Image codecs** (DCT, JPX, JBIG2, CCITT) are allowed only as the last filter of a `/Subtype /Image` stream, because pdf.js decodes those only to render. Every image-codec filter in the file must be accounted for that way, or the file is `unreadable`. A JPEG's declared frame is bounded too (width × height × components ≤ 64 Mi), so even a mislabelled one cannot make pdf.js allocate without bound.
- **Fixtures, each asserting the pdf.js loader spy was never called:**
  - Flate bomb (with small caps and with the defaults);
  - LZW, RunLength, Brotli, Crypt and unknown filters;
  - A85→Flate and AHx→Flate chained bombs;
  - a bomb inside an `/ObjStm`, and in XRef, ToUnicode, font and Form XObject streams;
  - a bomb behind a too-short `/Length` and behind an indirect `/Length`;
  - filters hidden with `#xx` escapes, the `/F` key, indirect filters, a string-faked `/Subtype /Image`, and no visible filter;
  - many streams over the document cap;
  - an owner-password-only PDF (also `#xx`-escaped, also in an `/ObjStm`);
  - image codecs outside images, and an oversized JPEG frame.

**P4: page cap, budget and text cap.**
- `numPages > 20` → `over_page_cap`, before any page is read.
- The wall-clock budget (20 s, and the pre-pass counts against it) is checked before each page → `unreadable`. Tested as "pdfText: stops at the page budget".
- Text stops at `MAX_EVIDENCE_TEXT_CHARS` as items are read, and the pages after the cap are never fetched.
- The "at most 3 lease attempts, then `unreadable`" half of P4 belongs to the evidence integration, which is held until M20.

**Text-layer card-number pre-scan (DA-A-8, KS2).** `lib/sniff`'s `textLayerHasPan` runs `lib/pan` (unchanged, inside R01's pinned engine closure, D197) after `normalizeDigitSeparators`. That folds any run of spaces, tabs or Unicode spaces between two digits into one space, and any dash-like character between two digits into `-`. Line breaks are never joined.
- pdf.js already folds tabs, no-break spaces and repeated spaces into single spaces. An en dash (WinAnsi 0x96) survives as U+2013, so the synthetic card-number receipt uses it.
- The test shows that the raw bytes hide the number (the content is compressed), that `lib/pan` alone misses it in the text layer, and that KS2 finds it. `uploadExtractionStatus` then gives `store_only` for a declared receipt.
- IMEI, e-ticket, order-reference and EAN-13 samples are left unchanged and unflagged.

## Residual risks, for the record

1. **Dictionary association is textual.** A content stream relabelled `/Subtype /Image` that carries JPX, JBIG2 or CCITT data could reach a pdf.js image decoder on the text path. DCT is bounded by its frame check; the other three are not. Bounds: the action's memory and time limits, at most 3 lease attempts (evidence integration), and upload rate limits.
2. **Fail-closed false positives** (the file is stored, just not read). They are rare in receipts and statements:
   - uncompressed content with LZW or RunLength inline images;
   - the literal text `/Encrypt` inside a stream;
   - a damaged declared Flate stream;
   - a JPEG larger than about 22 MP colour;
   - more than 128 MiB decoded in total.
3. **Time within one page.** pdf.js's per-page evaluation is not interruptible, so the budget is checked between pages; the Convex action timeout is the backstop.
4. **The native optional dependency.** `@napi-rs/canvas` still installs locally, because it is an optional dependency. The deployment never loads it, since the bundle cannot resolve it.
5. **A large parser on untrusted bytes.** The mitigations are the pre-pass, one isolated `"use node"` action and the caps. Extraction stays flag-gated off for real users (D145) until P5 and P6.
