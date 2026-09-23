"use node";
/**
 * Deployment check for the PDF text layer (M23; D203, security baseline §7 P2): proves on a real deployment that
 * `lib/pdfText` bundles, loads pdf.js on the Node 22 action runtime and reads one synthetic PDF end to end.
 *
 * Internal only, and gated exactly like `convex/testing.ts` (`assertE2EEnabled`): it throws unless
 * `E2E_SEED_ENABLED === "true"` and `CONVEX_SITE_URL` is not the production host. It touches no user data and makes
 * no model call: the PDF is built from `lib/pdfFixtures`' literals, stored, read back with `ctx.storage.get` (the
 * way the real extraction will read an upload — bytes are never an action argument, P2), and deleted again.
 *
 *   npx convex run testingPdf:extractSyntheticPdf '{}'
 *   npx convex run testingPdf:extractSyntheticPdf '{"variant":"card_number"}'
 */
import { ConvexError, v } from "convex/values";
import { internalAction } from "./_generated/server";
import { extractPdfText } from "./lib/pdfText";
import { SYNTHETIC_PAN_RECEIPT_LINES, SYNTHETIC_RECEIPT_LINES, textPdf } from "./lib/pdfFixtures";
import { textLayerHasPan } from "./lib/sniff";

/** Same marker as `convex/testing.ts` (D83 item 6 / D95 / D102): the documented production host. */
const PRODUCTION_HOST_MARKER = "cool-oyster-399";

function assertCheckEnabled(): void {
  if (process.env.E2E_SEED_ENABLED !== "true") {
    throw new ConvexError("convex/testingPdf.ts is disabled on this deployment: E2E_SEED_ENABLED is not \"true\"");
  }
  const siteUrl = process.env.CONVEX_SITE_URL ?? "";
  if (siteUrl.includes(PRODUCTION_HOST_MARKER)) {
    throw new ConvexError(`convex/testingPdf.ts refuses to run: CONVEX_SITE_URL ("${siteUrl}") looks like the production deployment`);
  }
}

export const extractSyntheticPdf = internalAction({
  args: { variant: v.optional(v.union(v.literal("receipt"), v.literal("card_number"))) },
  returns: v.object({
    status: v.union(v.literal("ok"), v.literal("needs_unlocked_copy"), v.literal("over_page_cap"), v.literal("unreadable")),
    pageCount: v.union(v.number(), v.null()),
    textLength: v.number(),
    /** DA-A-8: the text-layer card-number pre-scan's verdict (`null` when there is no text layer). */
    panDetected: v.union(v.boolean(), v.null()),
    byteLength: v.number(),
    elapsedMs: v.number(),
    nodeVersion: v.string(),
    /** Whether pdf.js managed to load `@napi-rs/canvas` (it installs DOMMatrix when it does). Expected false. */
    canvasLoaded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    assertCheckEnabled();
    const lines = args.variant === "card_number" ? SYNTHETIC_PAN_RECEIPT_LINES : SYNTHETIC_RECEIPT_LINES;
    const storageId = await ctx.storage.store(new Blob([textPdf([lines], { compress: true })], { type: "application/pdf" }));
    try {
      const blob = await ctx.storage.get(storageId);
      if (blob === null) throw new ConvexError("the synthetic PDF was not found in storage right after it was stored");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const startedAt = Date.now();
      const result = await extractPdfText(bytes);
      const elapsedMs = Date.now() - startedAt;
      return {
        status: result.status,
        pageCount: result.pageCount ?? null,
        textLength: result.status === "ok" ? result.text.length : 0,
        panDetected: result.status === "ok" ? textLayerHasPan(result.text) : null,
        byteLength: bytes.length,
        elapsedMs,
        nodeVersion: process.version,
        canvasLoaded: typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix !== "undefined",
      };
    } finally {
      await ctx.storage.delete(storageId);
    }
  },
});
