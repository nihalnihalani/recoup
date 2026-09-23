// @vitest-environment node
/**
 * P1: pdf.js's Node build tries `require("@napi-rs/canvas")` the moment it is imported (to polyfill DOMMatrix and
 * Path2D for rendering). In the Convex bundle that require cannot resolve, so the text path must not need it. This
 * file makes the addon unloadable BEFORE pdf.js is first imported in this test process, then extracts text.
 */
import Module from "node:module";
import { afterAll, describe, expect, it } from "vitest";

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleWithLoad = Module as unknown as { _load: Loader };
const originalLoad = moduleWithLoad._load;
const canvasRequests: string[] = [];
moduleWithLoad._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@napi-rs/canvas" || request.startsWith("@napi-rs/canvas-")) {
    canvasRequests.push(request);
    throw Object.assign(new Error(`Cannot find module '${request}' (made unloadable by this test)`), { code: "MODULE_NOT_FOUND" });
  }
  return originalLoad.call(this, request, parent, isMain);
};

afterAll(() => {
  moduleWithLoad._load = originalLoad;
});

describe("pdfText without @napi-rs/canvas", () => {
  it("pdfText: extracts text with canvas unavailable", async () => {
    const { extractPdfText } = await import("./pdfText");
    const { textPdf, SYNTHETIC_RECEIPT_LINES } = await import("./pdfFixtures");
    const result = await extractPdfText(textPdf([SYNTHETIC_RECEIPT_LINES], { compress: true }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.text).toContain("Order 112-3456789-1234562");
    // pdf.js asked for the addon and was refused (it logs `Cannot load "@napi-rs/canvas"`); nothing installed its
    // rendering polyfills, and the text came out anyway.
    expect(canvasRequests).toContain("@napi-rs/canvas");
    expect((globalThis as { DOMMatrix?: unknown }).DOMMatrix).toBeUndefined();
    expect((globalThis as { Path2D?: unknown }).Path2D).toBeUndefined();
  });
});
