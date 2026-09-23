// @vitest-environment node
/**
 * M23 integration (contract §11.2 row M23): reading an uploaded document and the second stage for forwarded or
 * pasted mail, behind `live_document_extraction` (D145). Synthetic PDFs only (`lib/pdfFixtures`); the model is a mock
 * (`lib/ai.extract`), so nothing leaves the test. Timers are fully faked (D231): a scheduled run only runs when a test
 * drives it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ai", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/ai")>();
  return { ...orig, extract: vi.fn() };
});

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { extract } from "./lib/ai";
import { flateBomb, stream, SYNTHETIC_PAN_RECEIPT_LINES, textPdf } from "./lib/pdfFixtures";
import { putFact } from "./lib/facts/write";
import { DOCUMENT_EXTRACTOR_VERSION, EXTRACTION_LEASE_MS, EXTRACTION_SUMMARY, MAX_EXTRACTION_ATTEMPTS, STATUS_SUMMARY } from "./evidence";
import { REPO_ROOT } from "./testing/ruleFixtures.loader";

type T = ReturnType<typeof setup>;
type User = Awaited<ReturnType<typeof signedIn>>;
const T0 = Date.UTC(2026, 8, 23, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(extract).mockReset();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RECEIPT_LINES = ["Northwind Outfitters", "Order 112-3456789-1234562", "Order date: March 3, 2026", "Total paid: 96.34 USD"];

/** What a well-behaved model returns for RECEIPT_LINES (every quote verbatim). `total` lets a test swap digits. */
function orderDoc(total = "96.34") {
  const q = (value: string | null, quote: string | null) => ({ value, quote });
  return {
    merchant: q("Northwind Outfitters", "Northwind Outfitters"),
    merchantDomain: q(null, null),
    orderRef: q("112-3456789-1234562", "Order 112-3456789-1234562"),
    orderDate: q("March 3, 2026", "Order date: March 3, 2026"),
    currency: q("USD", "96.34 USD"),
    items: [],
    subtotal: q(null, null),
    tax: q(null, null),
    shipping: q(null, null),
    total: q(total, "Total paid: 96.34 USD"),
    paymentMethod: q(null, null),
  };
}

async function enableExtraction(t: T) {
  await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: true, approvalRef: "D999: test only" });
}

async function retailTransaction(t: T, userId: Id<"users">): Promise<Id<"transactions">> {
  return await t.run((ctx) =>
    ctx.db.insert("transactions", {
      userId, category: "retail_order", status: "active", counterpartyName: "Northwind Outfitters", currency: "USD", liveFactCount: 0,
    }),
  );
}

async function upload(who: User, bytes: Uint8Array<ArrayBuffer>, docType = "receipt", contentType?: string): Promise<Id<"evidence">> {
  const res = await who.as.fetch("/evidence/upload", {
    method: "POST",
    body: bytes,
    headers: { "Content-Length": String(bytes.byteLength), "X-Doc-Type": docType, ...(contentType ? { "Content-Type": contentType } : {}) },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { evidenceId: Id<"evidence"> }).evidenceId;
}

async function row(t: T, id: Id<"evidence">): Promise<Doc<"evidence">> {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

async function factsOf(t: T, transactionId: Id<"transactions">) {
  return await t.run((ctx) =>
    ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId)).collect(),
  );
}

/** A user with a retail transaction and a declared, attached receipt PDF (queued when the flag is on). */
async function attachedReceipt(t: T, lines: readonly string[] = RECEIPT_LINES, opts: { compress?: boolean } = {}) {
  const a = await signedIn(t, "A");
  const transactionId = await retailTransaction(t, a.userId);
  const evidenceId = await upload(a, textPdf([lines], { compress: opts.compress ?? true }));
  await a.as.mutation(api.evidence.attachToTransaction, { evidenceId, transactionId });
  return { a, transactionId, evidenceId };
}

const run = (t: T, evidenceId: Id<"evidence">) => t.action(internal.evidenceExtract.extractUpload, { evidenceId });

// ---------------------------------------------------------------------------

describe("the live-extraction flag (D145) blocks real-user documents", () => {
  it("with the flag off, a declared and attached PDF is never queued and never read", async () => {
    const t = setup();
    const { evidenceId } = await attachedReceipt(t);
    expect((await row(t, evidenceId)).extractionStatus).toBe("store_only");
    expect((await row(t, evidenceId)).extractionSummary).toBe(STATUS_SUMMARY.extractionOff);
    await run(t, evidenceId);
    expect(extract).not.toHaveBeenCalled();
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.startsWith("evidenceExtract"))).toEqual([]);
  });

  it("a queued run that finds the flag off (it was switched off) ends store_only without a model call", async () => {
    const t = setup();
    await enableExtraction(t);
    const { evidenceId } = await attachedReceipt(t);
    expect((await row(t, evidenceId)).extractionStatus).toBe("queued");
    await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: false });
    await run(t, evidenceId);
    expect(extract).not.toHaveBeenCalled();
    expect((await row(t, evidenceId)).extractionStatus).toBe("store_only");
  });

  it("the flag switched off WHILE the document is being read: nothing is written (the kill switch holds)", async () => {
    const t = setup();
    await enableExtraction(t);
    const { transactionId, evidenceId } = await attachedReceipt(t);
    vi.mocked(extract).mockImplementation(async () => {
      await t.mutation(internal.ops.setFlag, { name: "live_document_extraction", on: false });
      return orderDoc() as never;
    });
    await run(t, evidenceId);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await factsOf(t, transactionId)).toEqual([]);
    expect((await row(t, evidenceId)).extractionStatus).toBe("store_only");
  });

  it("an undeclared or unattached upload is not queued even with the flag on", async () => {
    const t = setup();
    await enableExtraction(t);
    const a = await signedIn(t, "A");
    const transactionId = await retailTransaction(t, a.userId);
    const undeclared = await upload(a, textPdf([RECEIPT_LINES]), "unknown");
    await a.as.mutation(api.evidence.attachToTransaction, { evidenceId: undeclared, transactionId });
    expect((await row(t, undeclared)).extractionStatus).toBe("awaiting_doc_type");
    const unattached = await upload(a, textPdf([["Another receipt 42"]]));
    expect((await row(t, unattached)).extractionStatus).toBe("not_requested");
    // Declaring the type of the attached one queues it now.
    expect(await a.as.mutation(api.evidence.declareDocType, { evidenceId: undeclared, docType: "receipt" })).toEqual({ extractionStatus: "queued" });
  });
});

describe("reading a synthetic receipt (DA-A-6)", () => {
  it("a correct short quote → verified; every value becomes an extracted_candidate citing its span", async () => {
    const t = setup();
    await enableExtraction(t);
    const { transactionId, evidenceId } = await attachedReceipt(t);
    vi.mocked(extract).mockResolvedValue(orderDoc() as never);
    await run(t, evidenceId);

    const [call] = vi.mocked(extract).mock.calls;
    expect(call[3]).toContain("Total paid: 96.34 USD"); // the text layer, in the user role
    const ev = await row(t, evidenceId);
    expect(ev).toMatchObject({ extractionStatus: "succeeded", hasTextLayer: true, pageCount: 1, extractorVersion: DOCUMENT_EXTRACTOR_VERSION });
    const facts = await factsOf(t, transactionId);
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(Object.keys(byKey).sort()).toEqual(["retail.currency", "retail.merchant", "retail.order_ref", "retail.order_total", "retail.purchase_date"]);
    for (const f of facts) {
      expect(f.state).toBe("extracted_candidate");
      expect(f.source).toMatchObject({ kind: "evidence", evidenceId, quoteStatus: "verified", extractorVersion: DOCUMENT_EXTRACTOR_VERSION });
    }
    expect(byKey["retail.order_total"].value).toEqual({ kind: "money", amountMinor: 9_634, currency: "USD" });
    expect(byKey["retail.order_total"].source).toMatchObject({ locator: { kind: "text_span", quote: "Total paid: 96.34 USD" } });
    expect(ev.extractionSummary).toBe("Read. 5 details from it wait for you to confirm.");
  });

  it("a digit-swapped value → unverified (the quote is there, the value does not parse from it)", async () => {
    const t = setup();
    await enableExtraction(t);
    const { transactionId, evidenceId } = await attachedReceipt(t);
    vi.mocked(extract).mockResolvedValue(orderDoc("96.43") as never);
    await run(t, evidenceId);
    const total = (await factsOf(t, transactionId)).find((f) => f.key === "retail.order_total")!;
    expect(total.value).toEqual({ kind: "money", amountMinor: 9_643, currency: "USD" });
    expect(total.source).toMatchObject({ quoteStatus: "unverified" });
  });

  it("an unverified or unverifiable quote can never back an observed fact (it never counts toward evidenceSupports)", async () => {
    const t = setup();
    const { a, transactionId, evidenceId } = await attachedReceipt(t);
    const base = {
      transactionId, subjectKey: "txn", key: "retail.order_total", state: "observed" as const,
      value: { kind: "money" as const, amountMinor: 9_634, currency: "USD" },
    };
    const cite = (quoteStatus: "verified" | "unverified" | "unverifiable") => ({
      kind: "evidence" as const, evidenceId, quoteStatus, extractorVersion: "x1",
      locator: { kind: "text_span" as const, start: 0, end: 5, quote: "Total" },
    });
    for (const s of ["unverified", "unverifiable"] as const) {
      await expect(t.run((ctx) => putFact(ctx, a.userId, { ...base, source: cite(s) }))).rejects.toThrow(/only through a verified quote/);
    }
    expect((await t.run((ctx) => putFact(ctx, a.userId, { ...base, source: cite("verified") }))).outcome).toBe("inserted");
  });
});

describe("what is never sent to the model", () => {
  it("DA-A-8: a PDF declared a receipt with a test card number in its (compressed) text layer → store_only", async () => {
    const t = setup();
    await enableExtraction(t);
    const { transactionId, evidenceId } = await attachedReceipt(t, SYNTHETIC_PAN_RECEIPT_LINES, { compress: true });
    // The upload route's raw-bytes scan could not see it (compressed), so the row was queued.
    await run(t, evidenceId);
    expect(extract).not.toHaveBeenCalled();
    expect(await row(t, evidenceId)).toMatchObject({ extractionStatus: "store_only", extractionSummary: STATUS_SUMMARY.pan, hasTextLayer: true });
    expect(await factsOf(t, transactionId)).toEqual([]);
  });

  it("a photo, and a PDF with no text layer, are stored only (no deterministic text layer, SEC-SD-4)", async () => {
    const t = setup();
    await enableExtraction(t);
    const a = await signedIn(t, "A");
    const transactionId = await retailTransaction(t, a.userId);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4]);
    const photo = await upload(a, png);
    const scan = await upload(a, textPdf([[]]));
    for (const id of [photo, scan]) await a.as.mutation(api.evidence.attachToTransaction, { evidenceId: id, transactionId });
    await run(t, photo);
    await run(t, scan);
    expect(extract).not.toHaveBeenCalled();
    expect(await row(t, photo)).toMatchObject({ extractionStatus: "store_only", extractionSummary: EXTRACTION_SUMMARY.photo });
    expect(await row(t, scan)).toMatchObject({ extractionStatus: "store_only", extractionSummary: EXTRACTION_SUMMARY.noTextLayer, hasTextLayer: false });
  });

  it("SEC-UP-4: a decompression bomb ends unreadable before pdf.js or the model sees it", async () => {
    const t = setup();
    await enableExtraction(t);
    const a = await signedIn(t, "A");
    const transactionId = await retailTransaction(t, a.userId);
    const bomb = textPdf([["Receipt"]], { extraObjects: [stream("/Filter /FlateDecode", flateBomb(20 * 1024 * 1024))] });
    const evidenceId = await upload(a, bomb);
    await a.as.mutation(api.evidence.attachToTransaction, { evidenceId, transactionId });
    await run(t, evidenceId);
    expect(extract).not.toHaveBeenCalled();
    expect((await row(t, evidenceId)).extractionStatus).toBe("unreadable");
  });
});

describe("attempts, leases and the stall sweep (P4)", () => {
  it(`a run that keeps failing is retried, then unreadable after ${MAX_EXTRACTION_ATTEMPTS} attempts`, async () => {
    const t = setup();
    await enableExtraction(t);
    const { transactionId, evidenceId } = await attachedReceipt(t);
    vi.mocked(extract).mockRejectedValue(new Error("model unavailable"));
    for (let i = 1; i < MAX_EXTRACTION_ATTEMPTS; i++) {
      await run(t, evidenceId);
      expect(await row(t, evidenceId)).toMatchObject({ extractionStatus: "queued", extractionAttempts: i, extractionSummary: EXTRACTION_SUMMARY.retry });
    }
    await run(t, evidenceId);
    expect(await row(t, evidenceId)).toMatchObject({ extractionStatus: "unreadable", extractionAttempts: MAX_EXTRACTION_ATTEMPTS, extractionSummary: EXTRACTION_SUMMARY.gaveUp });
    expect(await factsOf(t, transactionId)).toEqual([]);
    await run(t, evidenceId);
    expect(extract).toHaveBeenCalledTimes(MAX_EXTRACTION_ATTEMPTS);
  });

  it("a run whose lease expired is re-queued by the sweep, and given up once its attempts are spent", async () => {
    const t = setup();
    await enableExtraction(t);
    const { evidenceId } = await attachedReceipt(t);
    await t.run((ctx) => ctx.db.patch(evidenceId, { extractionStatus: "running", extractionStartedAt: T0 - EXTRACTION_LEASE_MS - 1, extractionAttempts: 1 }));
    expect(await t.mutation(internal.evidence.retryStalledExtractions, {})).toMatchObject({ requeued: 1, gaveUp: 0 });
    expect((await row(t, evidenceId)).extractionStatus).toBe("queued");
    await t.run((ctx) =>
      ctx.db.patch(evidenceId, { extractionStatus: "running", extractionStartedAt: T0 - EXTRACTION_LEASE_MS - 1, extractionAttempts: MAX_EXTRACTION_ATTEMPTS }),
    );
    expect(await t.mutation(internal.evidence.retryStalledExtractions, {})).toMatchObject({ requeued: 0, gaveUp: 1 });
    expect((await row(t, evidenceId)).extractionStatus).toBe("unreadable");
  });

  it("a run still inside its lease is never taken twice", async () => {
    const t = setup();
    await enableExtraction(t);
    const { evidenceId } = await attachedReceipt(t);
    expect(await t.mutation(internal.evidence.claimExtraction, { evidenceId })).not.toBeNull();
    expect(await t.mutation(internal.evidence.claimExtraction, { evidenceId })).toBeNull();
  });
});

describe("SEC-DEL-4 / CT-7: extraction and account deletion", () => {
  it("extraction finishing after requestDeletion writes no facts, and the purge leaves no blob", async () => {
    const t = setup();
    await enableExtraction(t);
    const { a, transactionId, evidenceId } = await attachedReceipt(t);
    vi.mocked(extract).mockImplementation(async () => {
      await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
      return orderDoc() as never;
    });
    await run(t, evidenceId);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await factsOf(t, transactionId)).toEqual([]);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(evidenceId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("facts").collect())).toEqual([]);
  });

  it("deletion requested before the run: the lease is refused and the model is never called", async () => {
    const t = setup();
    await enableExtraction(t);
    const { a, evidenceId } = await attachedReceipt(t);
    await a.as.mutation(api.account.requestDeletion, { confirmation: "delete my account" });
    await run(t, evidenceId);
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("second stage for forwarded and pasted mail (intake)", () => {
  const TEXT = RECEIPT_LINES.join("\n");

  async function textEvidence(t: T, userId: Id<"users">, transactionId: Id<"transactions">, extra: Partial<Doc<"evidence">> = {}) {
    return await t.run((ctx) =>
      ctx.db.insert("evidence", {
        userId, transactionId, kind: "email", docType: "unknown", sourceChannel: "agentmail_forward", provenance: "unverified_sender",
        contentHash: "c".repeat(64), text: TEXT, receivedAt: T0, extractionStatus: "succeeded", extractionAttempts: 1,
        extractorVersion: "intake_email_v1", hasTextLayer: true, retention: "active", ...extra,
      }),
    );
  }

  it("classifies an undeclared message, then reads it with verifiable quotes (candidates only, SEC-AI-6)", async () => {
    const t = setup();
    await enableExtraction(t);
    const a = await signedIn(t, "A");
    const transactionId = await retailTransaction(t, a.userId);
    const evidenceId = await textEvidence(t, a.userId, transactionId);
    expect(await t.run((ctx) => import("./evidence").then((m) => m.queueTextSecondStage(ctx, evidenceId)))).toBe(true);
    vi.mocked(extract)
      .mockResolvedValueOnce({ docType: "order_confirmation", confidence: 0.9, reason: "an order number and a total" } as never)
      .mockResolvedValueOnce(orderDoc() as never);
    await t.action(internal.intake.extractTextEvidence, { evidenceId });
    expect(await row(t, evidenceId)).toMatchObject({ extractionStatus: "succeeded", docType: "order_confirmation", docTypeDeclaredBy: "classifier" });
    const facts = await factsOf(t, transactionId);
    expect(facts.length).toBe(5);
    expect(facts.every((f) => f.state === "extracted_candidate" && f.source.kind === "evidence" && f.source.quoteStatus === "verified")).toBe(true);
  });

  it("never overrides the user's declaration, and a low-confidence guess reads nothing", async () => {
    const t = setup();
    await enableExtraction(t);
    const a = await signedIn(t, "A");
    const transactionId = await retailTransaction(t, a.userId);
    const guessed = await textEvidence(t, a.userId, transactionId);
    await t.run((ctx) => import("./evidence").then((m) => m.queueTextSecondStage(ctx, guessed)));
    vi.mocked(extract).mockResolvedValueOnce({ docType: "receipt", confidence: 0.3, reason: "unsure" } as never);
    await t.action(internal.intake.extractTextEvidence, { evidenceId: guessed });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(await row(t, guessed)).toMatchObject({ extractionStatus: "succeeded", docType: "unknown" });

    vi.mocked(extract).mockReset();
    const declared = await textEvidence(t, a.userId, transactionId, { docType: "receipt", docTypeDeclaredBy: "user", contentHash: "d".repeat(64) });
    await t.run((ctx) => import("./evidence").then((m) => m.queueTextSecondStage(ctx, declared)));
    vi.mocked(extract).mockResolvedValueOnce(orderDoc() as never);
    await t.action(internal.intake.extractTextEvidence, { evidenceId: declared });
    expect(vi.mocked(extract).mock.calls.map((c) => c[0])).toEqual(["document_receipt"]); // no classifier call
    expect(await row(t, declared)).toMatchObject({ docType: "receipt", docTypeDeclaredBy: "user" });
  });

  it("applyExtraction queues the second stage only while the flag is on", async () => {
    for (const on of [false, true]) {
      const t = setup();
      if (on) await enableExtraction(t);
      const a = await signedIn(t, "A");
      const eventId = await t.run((ctx) =>
        ctx.db.insert("processedEvents", {
          externalId: `paste:${a.userId}:x`, kind: "paste", status: "processing", attempts: 1, userId: a.userId, route: "intake",
          payload: { subject: "", text: TEXT, from: "", messageId: null },
        }),
      );
      await t.mutation(internal.intake.applyExtraction, {
        processedEventId: eventId,
        parsed: {
          kind: "order",
          order: { merchant: "Northwind Outfitters", merchantDomain: "northwind.example", orderRef: "112-3456789-1234562", purchasedAt: "2026-03-03", currency: "USD", items: [{ name: "Trail runners", unitPrice: 96.34, qty: 1, productUrl: null }] },
          refund: null,
          confidence: 0.9,
        },
      });
      const ev = (await t.run((ctx) => ctx.db.query("evidence").collect()))[0];
      expect(ev.transactionId).toBeDefined();
      expect(ev.extractionStatus).toBe(on ? "queued" : "succeeded");
    }
  });
});

describe("SEC-AI-1 (static): the new extract() call sites pass constant system prompts", () => {
  it("evidenceExtract.ts and intake.ts's second stage", () => {
    const node = readFileSync(path.join(REPO_ROOT, "convex/evidenceExtract.ts"), "utf8");
    expect(node).toMatch(/extract\(`document_\$\{docType\}`, DOC_SCHEMAS\[docType\], DOC_SYSTEM\(docType\), layer\.text\)/);
    expect(node).toMatch(/const DOC_SYSTEM = \(docType: ExtractableDocType\): string => DOC_SYSTEMS\[docType\];/);
    const intake = readFileSync(path.join(REPO_ROOT, "convex/intake.ts"), "utf8");
    expect(intake).toMatch(/extract\("document_classification", DocClassification, DOC_CLASSIFIER_SYSTEM, layer\.text\)/);
    expect(intake).toMatch(/const DOC_CLASSIFIER_SYSTEM = CLASSIFIER_SYSTEM;/);
  });
});
