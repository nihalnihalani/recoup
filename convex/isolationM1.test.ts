/// <reference types="vite/client" />
/**
 * M16 — two-user isolation for every NEW public function of Mission 2 wave 1 (mission §17 "Security"; contract §10
 * "Foreign ids on every public function get an identical not-found"; M03 SEC controls; D153 owned* helpers).
 *
 * Written by QA from the mission and contract, not from the implementers' tests. For every public function that
 * takes an id, user B calls it with user A's id and with a MISSING id of the same table (a row of A's that was
 * deleted). The two outcomes must be identical after the id itself is masked: the same thrown ConvexError data (or
 * the same returned value), so the response cannot tell "exists but not yours" from "does not exist", and nothing of
 * A's leaks. After every probe, none of A's rows in any table has changed. List-shaped queries (no id) must show B
 * none of A's rows or money. The HTTP evidence routes are covered the same way (identical 404; upload dedupe is
 * owner-scoped, so identical bytes never reveal that another user holds them).
 *
 * A reflective guard enumerates the public functions of every convex module and compares them with the public
 * surface at `5cc326d` (the Mission 2 start, D134): every function added since must have an isolation case here.
 * A function added by a later lane after this file shows up as an `it.todo` naming it (visible in the test output)
 * instead of turning main red; M25 (wave 2 QA) folds those in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/rules/registry", async () => await import("./lib/rules/testRegistry"));

import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { resetTestRegistry, setTestActivations } from "./lib/rules/testRegistry";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 22, 15);
const SECRET = "Owner-A-Secret-Merchant";

type T = ReturnType<typeof setup>;
type User = Awaited<ReturnType<typeof signedIn>>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  setTestActivations([{ ruleId: "R01.retail_price_adjustment", version: 1, status: "active", decision: "TEST" }]);
});
afterEach(() => {
  vi.useRealTimers();
  resetTestRegistry();
});

// ---------------------------------------------------------------------------
// The public surface at 5cc326d (D134), listed from that commit's sources. Everything public now and not here is
// "new in Mission 2" and needs a case below. `auth.*` (Convex Auth's own exports) predates the mission.
// ---------------------------------------------------------------------------
const PUBLIC_AT_5CC326D = new Set(
  (
    "account.deletionStatus account.exportPage account.requestDeletion alerts.setAlerts alerts.settings budget.status " +
    "claims.adjustExpected claims.clearAttention claims.confirmCredit claims.dismiss claims.get claims.open " +
    "claims.recordLaterDebit drafts.approveAndSend drafts.generate drafts.listForClaim drafts.markPacketSent " +
    "drafts.recheckSend drafts.sendStatus drafts.update examples.load insights.activity insights.priceHistory " +
    "insights.sources insights.trackedTable intake.needsAttention intake.paste intake.retryEvent market.refresh " +
    "notify.drops notify.recheckDrop offers.confirm offers.find offers.listForWatch offers.reject policies.confirm " +
    "policies.refresh priceWatch.checkNow profiles.ensureInbox profiles.me purchases.board purchases.confirm " +
    "purchases.create purchases.get purchases.remove purchases.setReturned replies.listForClaim tracking.overview " +
    "watches.archive watches.checkNow watches.create watches.get watches.list watches.markBought watches.rename " +
    "watches.setStatus watches.setTarget"
  ).split(" "),
);

/** Every public (client-callable) function exported by a top-level convex module, as `module.name`. */
function currentPublicFunctions(): string[] {
  // Multi-dot files (tests, test.setup, convex.config, auth.config) are never Convex function modules (bundler rule).
  const modules = import.meta.glob(["./*.ts", "!./*.*.ts"], { eager: true }) as Record<string, Record<string, unknown>>;
  const out: string[] = [];
  for (const [file, mod] of Object.entries(modules)) {
    const name = file.replace(/^\.\//, "").replace(/\.ts$/, "");
    if (name.includes(".") || name === "schema") continue; // tests, test.setup, multi-dot helpers
    for (const [exportName, value] of Object.entries(mod)) {
      if ((typeof value === "function" || typeof value === "object") && value !== null && (value as { isPublic?: boolean }).isPublic === true) {
        out.push(`${name}.${exportName}`);
      }
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// A's world (built through public mutations, plus the data boundaries named in ledgerFixtures.test.ts)
// ---------------------------------------------------------------------------

type World = {
  a: User;
  b: User;
  purchaseId: Id<"purchases">;
  itemIds: Id<"items">[];
  transactionId: Id<"transactions">;
  opportunityId: Id<"opportunities">;
  claimId: Id<"claims">;
  draftId: Id<"drafts">;
  sentDraftId: Id<"drafts">;
  evidenceId: Id<"evidence">;
  pendingRefundEventId: Id<"processedEvents">;
  missing: Record<"purchases" | "transactions" | "opportunities" | "claims" | "drafts" | "evidence" | "processedEvents", string>;
  pdf: Uint8Array<ArrayBuffer>;
};

const pdfBytes = (tag: string) => new TextEncoder().encode(`%PDF-1.4\nBT (Receipt ${tag}) Tj ET\n%%EOF\n`) as Uint8Array<ArrayBuffer>;

async function upload(who: Pick<User["as"], "fetch">, bytes: Uint8Array<ArrayBuffer>) {
  return await who.fetch("/evidence/upload", { method: "POST", body: bytes, headers: { "Content-Length": String(bytes.byteLength), "X-Doc-Type": "receipt" } });
}

async function buildWorld(t: T): Promise<World> {
  const a = await signedIn(t, "Owner A");
  const b = await signedIn(t, "Other B");
  await t.run(async (ctx) => {
    await ctx.db.patch(a.userId, { email: "owner.a@example.com" });
    await ctx.db.patch(b.userId, { email: "other.b@example.com" });
  });

  const purchaseId = await a.as.mutation(api.purchases.create, {
    merchant: SECRET, merchantDomain: "owner-a-shop.example", orderRef: "ORD-A-SECRET", purchasedAt: NOW - 3 * DAY, currency: "USD",
    status: "active",
    items: [
      { name: "Watched coat", unitCents: 12_000, qty: 1, productUrl: "https://owner-a-shop.example/p/coat" },
      { name: "Returned boots", unitCents: 8_000, qty: 1 },
      { name: "Sent scarf", unitCents: 3_000, qty: 1 },
    ],
  });
  const itemIds = (await a.as.query(api.purchases.get, { purchaseId })).items.map((i: Doc<"items">) => i._id);
  const txn = await a.as.query(api.transactions.forPurchase, { purchaseId });
  const transactionId = txn!._id;

  // An open R01 opportunity with no case: a policy + a stored observation, then the public "check again".
  await t.run(async (ctx) => {
    await ctx.db.insert("policies", {
      userId: a.userId, merchantDomain: "owner-a-shop.example", kind: "price_adjustment", windowDays: 14, channel: "email",
      contactEmail: "help@owner-a-shop.example", passage: "We refund the difference within 14 days.", sourceUrl: "https://owner-a-shop.example/policy",
      retrievedAt: NOW - 3 * DAY + 60_000, confidence: 0.9, confirmedByUser: true,
    });
    await ctx.db.insert("priceChecks", {
      itemId: itemIds[0], userId: a.userId, observedCents: 9_000, currency: "USD", confidence: 0.95, variantMatch: "exact",
      observedAt: NOW - DAY, sourceUrl: "https://owner-a-shop.example/p/coat",
    });
  });
  await a.as.mutation(api.opportunities.reevaluate, { purchaseId });
  const opportunityId = (await a.as.query(api.opportunities.forPurchase, { purchaseId })).opportunities[0].opportunity._id as Id<"opportunities">;

  // A return claim with a draft; a second claim whose draft already went out (for resendAfterUnknown).
  await a.as.mutation(api.purchases.setReturned, { itemId: itemIds[1], returned: true });
  const claimId = await a.as.mutation(api.claims.open, { itemId: itemIds[1] });
  const draftId = (await t.mutation(internal.drafts.insert, { claimId, userId: a.userId, to: "help@owner-a-shop.example", subject: "Return ORD-A-SECRET", body: `Hello ${SECRET}` }))!;
  await a.as.mutation(api.purchases.setReturned, { itemId: itemIds[2], returned: true });
  const sentClaimId = await a.as.mutation(api.claims.open, { itemId: itemIds[2] });
  const sentDraftId = (await t.mutation(internal.drafts.insert, { claimId: sentClaimId, userId: a.userId, to: "help@owner-a-shop.example", subject: "Return", body: "Hello" }))!;
  await t.run(async (ctx) => {
    await ctx.db.patch(sentDraftId, { outboundId: "outbound-owner-a" as NonNullable<Doc<"drafts">["outboundId"]>, approvedAt: NOW - DAY });
    await ctx.db.patch(sentClaimId, { status: "queued", sendUnknown: true });
  });

  // A refund email from an address that is not A's: held for A's confirmation (SEC-AI-6).
  const pendingRefundEventId = await t.run(async (ctx) =>
    await ctx.db.insert("processedEvents", {
      externalId: "agentmail:<refund-spoof@owner-a-shop.example>", kind: "agentmail.message.received", status: "received", attempts: 0,
      userId: a.userId, route: "intake",
      payload: { messageId: "<refund-spoof@owner-a-shop.example>", subject: "Refund", text: "Refund issued.", from: "someone@elsewhere.example" },
    }));
  await t.mutation(internal.intake.applyExtraction, {
    processedEventId: pendingRefundEventId,
    parsed: { kind: "refund", order: null, refund: { merchant: SECRET, orderRef: "ORD-A-SECRET", credits: [{ itemName: "Returned boots", amount: 80, currency: "USD", state: "posted" }] }, confidence: 0.9 },
  });
  const held = await t.run(async (ctx) => await ctx.db.get(pendingRefundEventId));
  expect((held!.payload as Record<string, unknown>).pendingRefund).toBeDefined();

  // A's uploaded receipt.
  const pdf = pdfBytes("owner-a");
  const up = await upload(a.as, pdf);
  expect(up.status).toBe(200);
  const evidenceId = ((await up.json()) as { evidenceId: Id<"evidence"> }).evidenceId;

  // Missing ids: real rows of A's, deleted, so the id is well-formed and names nothing.
  const missing = await t.run(async (ctx) => {
    const del = async <N extends TableNames>(table: N, doc: Record<string, unknown>) => {
      const id = await ctx.db.insert(table, doc as never);
      await ctx.db.delete(id);
      return id as string;
    };
    const purchase = (await ctx.db.get(purchaseId))!;
    const { _id: _p, _creationTime: _pc, ...pFields } = purchase;
    const transaction = (await ctx.db.get(transactionId))!;
    const { _id: _t, _creationTime: _tc, ...tFields } = transaction;
    const opp = (await ctx.db.get(opportunityId))!;
    const { _id: _o, _creationTime: _oc, ...oFields } = opp;
    const claim = (await ctx.db.get(claimId))!;
    const { _id: _c, _creationTime: _cc, ...cFields } = claim;
    const draft = (await ctx.db.get(draftId))!;
    const { _id: _d, _creationTime: _dc, ...dFields } = draft;
    const ev = (await ctx.db.get(evidenceId))!;
    const { _id: _e, _creationTime: _ec, storageId: _s, ...eFields } = ev;
    const pe = (await ctx.db.get(pendingRefundEventId))!;
    const { _id: _x, _creationTime: _xc, ...xFields } = pe;
    return {
      purchases: await del("purchases", pFields),
      transactions: await del("transactions", { ...tFields, purchaseId: undefined, naturalKey: "deleted" }),
      opportunities: await del("opportunities", { ...oFields, dedupeKey: "deleted" }),
      claims: await del("claims", { ...cFields, token: "DELETEDTOKEN" }),
      drafts: await del("drafts", dFields),
      evidence: await del("evidence", { ...eFields, contentHash: "deleted" }),
      processedEvents: await del("processedEvents", { ...xFields, externalId: "deleted" }),
    };
  });

  return { a, b, purchaseId, itemIds, transactionId, opportunityId, claimId, draftId, sentDraftId, evidenceId, pendingRefundEventId, missing, pdf };
}

// ---------------------------------------------------------------------------
// Probe machinery
// ---------------------------------------------------------------------------

/** What a call returned or threw, with the probed id masked, so two calls that differ only in the id compare equal. */
async function outcome(p: Promise<unknown>, id: string): Promise<string> {
  const mask = (s: string) => s.split(id).join("<ID>");
  try {
    return mask(`resolved:${JSON.stringify(await p)}`);
  } catch (err) {
    if (err instanceof ConvexError) return mask(`ConvexError:${JSON.stringify(err.data)}`);
    return mask(`Error:${err instanceof Error ? err.message : String(err)}`);
  }
}

const OWNED_TABLES = [
  "purchases", "items", "transactions", "facts", "evidence", "opportunities", "evaluations", "claims", "ledgerEvents",
  "drafts", "claimNotes", "processedEvents", "nonCashRemedies", "policies", "priceChecks", "followUps",
] as const;

/** Every row A owns, in every table a probe could touch. */
async function snapshotOf(t: T, userId: Id<"users">) {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of OWNED_TABLES) {
      const rows = (await ctx.db.query(table).collect()) as Array<{ userId?: Id<"users"> }>;
      out[table] = rows.filter((r) => r.userId === userId);
    }
    return out;
  });
}

type Probe = {
  fn: string;
  /** Calls the function as `who` with the given id of the probed table. */
  call: (who: User["as"], id: string, w: World) => Promise<unknown>;
  table: keyof World["missing"];
  ownerId: (w: World) => string;
};

const draftSend = (id: string) => ({ draftId: id as Id<"drafts">, to: "help@owner-a-shop.example", subject: "Return", body: "Hello" });

const PROBES: Probe[] = [
  { fn: "transactions.get", table: "transactions", ownerId: (w) => w.transactionId, call: (as, id) => as.query(api.transactions.get, { transactionId: id as Id<"transactions"> }) },
  { fn: "transactions.forPurchase", table: "purchases", ownerId: (w) => w.purchaseId, call: (as, id) => as.query(api.transactions.forPurchase, { purchaseId: id as Id<"purchases"> }) },
  { fn: "facts.list", table: "transactions", ownerId: (w) => w.transactionId, call: (as, id) => as.query(api.facts.list, { transactionId: id as Id<"transactions"> }) },
  {
    fn: "facts.answer", table: "transactions", ownerId: (w) => w.transactionId,
    call: (as, id) => as.mutation(api.facts.answer, { transactionId: id as Id<"transactions">, subjectKey: "txn", key: "retail.order_ref", value: { kind: "identifier", scheme: "order_ref", value: "ORD-B" } }),
  },
  { fn: "evidence.get", table: "evidence", ownerId: (w) => w.evidenceId, call: (as, id) => as.query(api.evidence.get, { evidenceId: id as Id<"evidence"> }) },
  { fn: "evidence.declareDocType", table: "evidence", ownerId: (w) => w.evidenceId, call: (as, id) => as.mutation(api.evidence.declareDocType, { evidenceId: id as Id<"evidence">, docType: "card_statement" }) },
  { fn: "evidence.setPinned", table: "evidence", ownerId: (w) => w.evidenceId, call: (as, id) => as.mutation(api.evidence.setPinned, { evidenceId: id as Id<"evidence">, pinned: true }) },
  { fn: "opportunities.openCase", table: "opportunities", ownerId: (w) => w.opportunityId, call: (as, id) => as.mutation(api.opportunities.openCase, { opportunityId: id as Id<"opportunities"> }) },
  { fn: "opportunities.dismiss", table: "opportunities", ownerId: (w) => w.opportunityId, call: (as, id) => as.mutation(api.opportunities.dismiss, { opportunityId: id as Id<"opportunities"> }) },
  { fn: "opportunities.get", table: "opportunities", ownerId: (w) => w.opportunityId, call: (as, id) => as.query(api.opportunities.get, { opportunityId: id as Id<"opportunities"> }) },
  { fn: "opportunities.forTransaction", table: "transactions", ownerId: (w) => w.transactionId, call: (as, id) => as.query(api.opportunities.forTransaction, { transactionId: id as Id<"transactions"> }) },
  { fn: "opportunities.forPurchase", table: "purchases", ownerId: (w) => w.purchaseId, call: (as, id) => as.query(api.opportunities.forPurchase, { purchaseId: id as Id<"purchases"> }) },
  { fn: "opportunities.reevaluate(purchaseId)", table: "purchases", ownerId: (w) => w.purchaseId, call: (as, id) => as.mutation(api.opportunities.reevaluate, { purchaseId: id as Id<"purchases"> }) },
  { fn: "opportunities.reevaluate(transactionId)", table: "transactions", ownerId: (w) => w.transactionId, call: (as, id) => as.mutation(api.opportunities.reevaluate, { transactionId: id as Id<"transactions"> }) },
  { fn: "drafts.prepareSend", table: "drafts", ownerId: (w) => w.draftId, call: (as, id) => as.mutation(api.drafts.prepareSend, draftSend(id)) },
  {
    fn: "drafts.resendAfterUnknown", table: "drafts", ownerId: (w) => w.sentDraftId,
    call: (as, id) => as.mutation(api.drafts.resendAfterUnknown, { ...draftSend(id), claimVersion: 1, draftVersion: 1, recipientConfirmed: true, acknowledgedOutboundId: "outbound-owner-a" }),
  },
  { fn: "intake.confirmRefundEmail", table: "processedEvents", ownerId: (w) => w.pendingRefundEventId, call: (as, id) => as.mutation(api.intake.confirmRefundEmail, { processedEventId: id as Id<"processedEvents"> }) },
  {
    fn: "claims.recordProvisionalCredit", table: "claims", ownerId: (w) => w.claimId,
    call: (as, id) => as.mutation(api.claims.recordProvisionalCredit, { claimId: id as Id<"claims">, amount: { amountMinor: 100, currency: "USD" }, evidence: "x", idempotencyKey: "iso-prov" }),
  },
  { fn: "claims.finalizeProvisionalCredit", table: "claims", ownerId: (w) => w.claimId, call: (as, id) => as.mutation(api.claims.finalizeProvisionalCredit, { claimId: id as Id<"claims">, cents: 100, evidence: "x", idempotencyKey: "iso-fin" }) },
  { fn: "claims.reverseProvisionalCredit", table: "claims", ownerId: (w) => w.claimId, call: (as, id) => as.mutation(api.claims.reverseProvisionalCredit, { claimId: id as Id<"claims">, cents: 100, evidence: "x", idempotencyKey: "iso-rev" }) },
  {
    fn: "claims.recordNonCashRemedy", table: "claims", ownerId: (w) => w.claimId,
    call: (as, id) => as.mutation(api.claims.recordNonCashRemedy, { claimId: id as Id<"claims">, kind: "voucher", description: "v", state: "received", idempotencyKey: "iso-nc" }),
  },
];

/** Public functions that take no id: covered by the list/summary cases and the HTTP cases below. */
const NO_ID_CASES = ["transactions.list", "recovery.summary", "http:POST /evidence/upload", "http:GET /evidence/file"];

// ---------------------------------------------------------------------------

describe("isolation: foreign id ≡ missing id for every new id-taking public function", () => {
  it.each(PROBES.map((p) => [p.fn, p] as const))("%s: B with A's id gets exactly what B gets with a missing id, and A's rows are unchanged", async (_fn, probe) => {
    const t = setup();
    const w = await buildWorld(t);
    const before = await snapshotOf(t, w.a.userId);
    const foreign = await outcome(probe.call(w.b.as, probe.ownerId(w), w), probe.ownerId(w));
    const missing = await outcome(probe.call(w.b.as, w.missing[probe.table], w), w.missing[probe.table]);
    expect(foreign).toBe(missing);
    expect(foreign).not.toContain(SECRET);
    expect(foreign).not.toContain("ORD-A-SECRET");
    expect(await snapshotOf(t, w.a.userId)).toEqual(before);
  });

  it("the owner's own call succeeds on the same ids (the probes are not vacuous)", async () => {
    const t = setup();
    const w = await buildWorld(t);
    expect((await w.a.as.query(api.transactions.get, { transactionId: w.transactionId }))._id).toBe(w.transactionId);
    expect((await w.a.as.query(api.opportunities.get, { opportunityId: w.opportunityId })).opportunity._id).toBe(w.opportunityId);
    expect((await w.a.as.query(api.evidence.get, { evidenceId: w.evidenceId }))).toBeDefined();
    expect(await w.a.as.query(api.facts.list, { transactionId: w.transactionId })).toBeInstanceOf(Array);
    const prepared = await w.a.as.mutation(api.drafts.prepareSend, draftSend(w.draftId));
    expect(prepared).toBeDefined();
  });
});

describe("isolation: list-shaped queries never show another user's rows or money", () => {
  it("transactions.list and recovery.summary for B contain nothing of A's", async () => {
    const t = setup();
    const w = await buildWorld(t);
    const bList = await w.b.as.query(api.transactions.list, {});
    expect(bList.transactions).toEqual([]);
    const aList = await w.a.as.query(api.transactions.list, {});
    expect(aList.transactions.map((x: Doc<"transactions">) => x._id)).toContain(w.transactionId);

    const bSummary = await w.b.as.query(api.recovery.summary, { now: NOW });
    expect(bSummary.currencies).toEqual([]);
    expect(bSummary.nonCash).toEqual([]);
    expect(bSummary.counts).toEqual({ notYetDue: 0, needsAnswers: 0, deadlinesThisWeek: 0 });
    const aSummary = await w.a.as.query(api.recovery.summary, { now: NOW });
    expect(aSummary.currencies.length).toBeGreaterThan(0);
    expect(JSON.stringify(bSummary)).not.toContain(w.a.userId);
  });

  it("intake.needsAttention for B does not list A's held refund email", async () => {
    const t = setup();
    const w = await buildWorld(t);
    const bNeeds = JSON.stringify(await w.b.as.query(api.intake.needsAttention, {}));
    expect(bNeeds).not.toContain(w.pendingRefundEventId);
    expect(bNeeds).not.toContain(SECRET);
    expect(JSON.stringify(await w.a.as.query(api.intake.needsAttention, {}))).toContain(w.pendingRefundEventId);
  });
});

describe("isolation: cross-user references inside the caller's own rows", () => {
  it("B confirming B's own held refund email that names A's order and merchant never touches A's claims", async () => {
    const t = setup();
    const w = await buildWorld(t);
    const before = await snapshotOf(t, w.a.userId);
    const eventId = await t.run(async (ctx) =>
      await ctx.db.insert("processedEvents", {
        externalId: "agentmail:<b-forged@elsewhere.example>", kind: "agentmail.message.received", status: "received", attempts: 0,
        userId: w.b.userId, route: "intake",
        payload: { messageId: "<b-forged@elsewhere.example>", subject: "Refund", text: "Refund issued.", from: "someone@elsewhere.example" },
      }));
    await t.mutation(internal.intake.applyExtraction, {
      processedEventId: eventId,
      parsed: { kind: "refund", order: null, refund: { merchant: SECRET, orderRef: "ORD-A-SECRET", credits: [{ itemName: "Returned boots", amount: 80, currency: "USD", state: "posted" }] }, confidence: 0.9 },
    });
    // B holds no purchase: the email matches nothing of B's, and A's purchases are never searched.
    const row = await t.run(async (ctx) => await ctx.db.get(eventId));
    expect(row!.status).toBe("needs_review");
    expect(row!.summary).toMatch(/could not be matched/);
    await expect(w.b.as.mutation(api.intake.confirmRefundEmail, { processedEventId: eventId })).rejects.toThrow(/no refund waiting/);
    expect(await snapshotOf(t, w.a.userId)).toEqual(before);
  });
});

describe("isolation: the HTTP evidence routes", () => {
  it("GET /evidence/file: A's id, a deleted id and a malformed id give B one identical 404; A gets the file", async () => {
    const t = setup();
    const w = await buildWorld(t);
    const read = async (as: User["as"], id: string) => {
      const res = await as.fetch(`/evidence/file?id=${encodeURIComponent(id)}`, { method: "GET" });
      return { status: res.status, body: await res.text() };
    };
    const foreign = await read(w.b.as, w.evidenceId);
    expect(foreign.status).toBe(404);
    expect(await read(w.b.as, w.missing.evidence)).toEqual(foreign);
    expect(await read(w.b.as, "not-an-id")).toEqual(foreign);
    expect(foreign.body).not.toContain(w.evidenceId);
    const own = await w.a.as.fetch(`/evidence/file?id=${encodeURIComponent(w.evidenceId)}`, { method: "GET" });
    expect(own.status).toBe(200);
  });

  it("POST /evidence/upload: B uploading the same bytes as A gets a new row of B's own (dedupe never crosses users)", async () => {
    const t = setup();
    const w = await buildWorld(t);
    const res = await upload(w.b.as, w.pdf);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evidenceId: Id<"evidence">; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.evidenceId).not.toBe(w.evidenceId);
    const row = await t.run(async (ctx) => await ctx.db.get(body.evidenceId));
    expect(row?.userId).toBe(w.b.userId);
    // And A's own re-upload is the duplicate (the control).
    const again = (await (await upload(w.a.as, w.pdf)).json()) as { evidenceId: Id<"evidence">; duplicate: boolean };
    expect(again).toMatchObject({ evidenceId: w.evidenceId, duplicate: true });
  });
});

describe("isolation: every public function added since 5cc326d has a case here (reflective)", () => {
  const covered = new Set([...PROBES.map((p) => p.fn.replace(/\(.*\)$/, "")), ...NO_ID_CASES]);
  const added = currentPublicFunctions().filter((f) => !PUBLIC_AT_5CC326D.has(f) && !f.startsWith("auth."));
  const uncovered = added.filter((f) => !covered.has(f));

  it("the enumeration sees the wave-1 surface (not vacuous)", () => {
    expect(added).toEqual(expect.arrayContaining(["transactions.get", "opportunities.openCase", "recovery.summary", "intake.confirmRefundEmail", "drafts.prepareSend"]));
    expect(currentPublicFunctions()).toEqual(expect.arrayContaining(["claims.confirmCredit", "purchases.create"]));
  });

  it("no function public at 5cc326d has disappeared without the list being updated", () => {
    const now = new Set(currentPublicFunctions());
    expect([...PUBLIC_AT_5CC326D].filter((f) => !now.has(f))).toEqual([]);
  });

  for (const f of uncovered) it.todo(`isolation case for ${f} (public since 5cc326d, not yet probed here)`);
});
