"use node";
/**
 * M23: reads one uploaded document (the node half of `evidence.ts`'s extraction; D145, DA-A-6, DA-A-8, SEC-UP-4).
 *
 * The run holds a lease from `evidence.claimExtraction`, which re-checks the live-extraction flag (OFF on every
 * deployment until the user approves the data flow), the tombstone, the declared type, the link and the budget. Then:
 *   1. the bytes come from `ctx.storage.get` (never an action argument, P2);
 *   2. a photo is never sent anywhere: it has no deterministic text layer, and document images go to no provider
 *      before the Privacy disclosure says so (SEC-SD-4) → `store_only`;
 *   3. a PDF goes through `lib/pdfText` (bomb pre-pass, page cap, budget, text only; SEC-UP-4). A refusal there is the
 *      document's status (`needs_unlocked_copy`, `over_page_cap`, `unreadable`); an empty text layer (a scan) →
 *      `store_only`;
 *   4. the text-layer card-number pre-scan (DA-A-8, KS2): a card number anywhere in the text layer → `store_only`,
 *      before and instead of any model call, whatever type the user declared;
 *   5. one `lib/ai.extract` call: the declared type's schema, its CONSTANT system prompt (SEC-AI-1), the masked text in
 *      the user role;
 *   6. `lib/docFacts` locates and verifies every quote against the same text layer (DA-A-6), and
 *      `evidence.completeExtraction` writes the candidates — or nothing, if the account was deleted or the flag switched
 *      off meanwhile (SEC-DEL-4).
 * Any throw releases the lease through `evidence.failExtraction` (retry, then `unreadable` after three attempts, P4).
 */
import { v } from "convex/values";
import type { FunctionReturnType } from "convex/server";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";
import { extract } from "./lib/ai";
import { candidatesFromDoc, type DocCandidate } from "./lib/docFacts";
import { maskPans } from "./lib/pan";
import { extractPdfText } from "./lib/pdfText";
import { boundExtracted, DOC_SCHEMAS, DOC_SYSTEMS, type ExtractableDocType } from "./lib/schemas_docs";
import { textLayerHasPan } from "./lib/sniff";
import { EXTRACTION_SUMMARY, STATUS_SUMMARY } from "./evidence";

/** The declared type's constant system prompt (SEC-AI-1: a closed enum selects among module constants). */
const DOC_SYSTEM = (docType: ExtractableDocType): string => DOC_SYSTEMS[docType];

type Outcome = {
  status: "succeeded" | "store_only" | "needs_unlocked_copy" | "over_page_cap" | "unreadable";
  summary?: string;
  hasTextLayer?: boolean;
  pageCount?: number;
  candidates: DocCandidate[];
};

type Lease = NonNullable<FunctionReturnType<typeof internal.evidence.claimExtraction>>;

async function readUpload(ctx: ActionCtx, lease: Lease): Promise<Outcome> {
  if (lease.storageId === null) return { status: "unreadable", summary: EXTRACTION_SUMMARY.gone, candidates: [] };
  const blob = await ctx.storage.get(lease.storageId);
  if (blob === null) return { status: "unreadable", summary: EXTRACTION_SUMMARY.gone, candidates: [] };
  if (lease.mimeType !== "application/pdf") return { status: "store_only", summary: EXTRACTION_SUMMARY.photo, hasTextLayer: false, candidates: [] };

  const pdf = await extractPdfText(new Uint8Array(await blob.arrayBuffer()));
  if (pdf.status !== "ok") {
    return { status: pdf.status, summary: pdf.reason, ...(pdf.pageCount !== undefined ? { pageCount: pdf.pageCount } : {}), candidates: [] };
  }
  if (pdf.text.trim().length === 0) {
    return { status: "store_only", summary: EXTRACTION_SUMMARY.noTextLayer, hasTextLayer: false, pageCount: pdf.pageCount, candidates: [] };
  }
  if (textLayerHasPan(pdf.text)) {
    return { status: "store_only", summary: STATUS_SUMMARY.pan, hasTextLayer: true, pageCount: pdf.pageCount, candidates: [] };
  }
  const docType = lease.docType as ExtractableDocType;
  // Masked again as defence in depth (D142); after the pre-scan found no card number this changes nothing.
  const layer = { text: maskPans(pdf.text), pages: pdf.pages.map(maskPans) };
  // D30: the schema carries no bounds, so they are enforced on the parsed output before any field is read.
  const doc: unknown = boundExtracted(await extract(`document_${docType}`, DOC_SCHEMAS[docType], DOC_SYSTEM(docType), layer.text));
  return { status: "succeeded", hasTextLayer: true, pageCount: pdf.pageCount, candidates: candidatesFromDoc(docType, doc, lease.category, layer) };
}

export const extractUpload = internalAction({
  args: { evidenceId: v.id("evidence") },
  returns: v.null(),
  handler: async (ctx, { evidenceId }) => {
    const lease = await ctx.runMutation(internal.evidence.claimExtraction, { evidenceId });
    if (lease === null) return null;
    try {
      const outcome = await readUpload(ctx, lease);
      await ctx.runMutation(internal.evidence.completeExtraction, { evidenceId, startedAt: lease.startedAt, ...outcome });
    } catch (err) {
      await ctx.runMutation(internal.evidence.failExtraction, {
        evidenceId,
        startedAt: lease.startedAt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return null;
  },
});
