/**
 * E-M24 (D220): the evidence reads and the one link M24's screens need — `listForTransaction`, `attachToTransaction`,
 * `listRecent`. Every function is owner-only with the identical not-found for a foreign id, and attaching never moves
 * evidence between transactions (DA-A-29: facts citing it stay on the transaction they cite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { EVIDENCE_LIST_LIMIT, RECENT_UPLOADS_MAX } from "./evidence";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 23, 12);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const basePurchase = {
  merchant: "Northwind Outfitters",
  merchantDomain: "northwind.example",
  orderRef: "NW-1001",
  purchasedAt: Date.UTC(2026, 8, 20),
  currency: "USD",
  items: [{ name: "Merino sweater", unitCents: 8000, qty: 1 }],
};

/** A signed-in user with one purchase and its transaction. */
async function owner(t: T, name: string, orderRef = "NW-1001") {
  const { as, userId } = await signedIn(t, name);
  const purchaseId = await as.mutation(api.purchases.create, { ...basePurchase, orderRef });
  const transactionId = await transactionOf(t, purchaseId);
  return { as, userId, transactionId };
}

async function transactionOf(t: T, purchaseId: Id<"purchases">): Promise<Id<"transactions">> {
  return await t.run(async (ctx) => (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).unique())!._id);
}

let seq = 0;
async function evidence(t: T, userId: Id<"users">, extra: Partial<Doc<"evidence">> = {}) {
  seq++;
  return await t.run((ctx) =>
    ctx.db.insert("evidence", {
      userId, kind: "upload", docType: "receipt", docTypeDeclaredBy: "user", sourceChannel: "upload", provenance: "user_uploaded",
      contentHash: seq.toString(16).padStart(64, "0"), mimeType: "application/pdf", sizeBytes: 100, fileName: `r${seq}.pdf`,
      receivedAt: Date.now(), extractionStatus: "store_only", extractionAttempts: 0, retention: "active", ...extra,
    }),
  );
}

describe("evidence.listForTransaction", () => {
  it("lists one owned transaction's evidence, newest first, and only that transaction's", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const first = await evidence(t, a.userId, { transactionId: a.transactionId });
    vi.setSystemTime(T0 + 60_000);
    const second = await evidence(t, a.userId, { transactionId: a.transactionId, kind: "email", sourceChannel: "agentmail_forward", provenance: "user_forwarded" });
    await evidence(t, a.userId); // unattached: not listed
    const other = await a.as.mutation(api.purchases.create, { ...basePurchase, orderRef: "NW-2" });
    await evidence(t, a.userId, { transactionId: await transactionOf(t, other) }); // another transaction: not listed

    const res = await a.as.query(api.evidence.listForTransaction, { transactionId: a.transactionId });
    expect(res.truncated).toBe(false);
    expect(res.evidence.map((e) => e._id)).toEqual([second, first]);
    expect(res.evidence[0]).not.toHaveProperty("storageId");
  });

  it("is bounded at the limit with a truncated flag", async () => {
    const t = setup();
    const a = await owner(t, "A");
    await t.run(async (ctx) => {
      for (let i = 0; i <= EVIDENCE_LIST_LIMIT; i++) {
        await ctx.db.insert("evidence", {
          userId: a.userId, transactionId: a.transactionId, kind: "upload", docType: "receipt", sourceChannel: "upload",
          provenance: "user_uploaded", contentHash: `b${i}`.padStart(64, "0"), receivedAt: T0 + i, extractionStatus: "store_only",
          extractionAttempts: 0, retention: "active",
        });
      }
    });
    const res = await a.as.query(api.evidence.listForTransaction, { transactionId: a.transactionId });
    expect(res.evidence).toHaveLength(EVIDENCE_LIST_LIMIT);
    expect(res.truncated).toBe(true);
    expect(res.evidence[0].contentHash).toBe(`b${EVIDENCE_LIST_LIMIT}`.padStart(64, "0")); // newest first
  });

  it("two users: a foreign transaction is the identical not-found, and nothing of it is disclosed", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const b = await owner(t, "B");
    await evidence(t, a.userId, { transactionId: a.transactionId });
    const missing = await t.run(async (ctx) => {
      const { _id: _ignored, _creationTime: _alsoIgnored, ...fields } = (await ctx.db.get(b.transactionId))!;
      const id = await ctx.db.insert("transactions", fields);
      await ctx.db.delete(id);
      return id;
    });
    await expect(b.as.query(api.evidence.listForTransaction, { transactionId: a.transactionId })).rejects.toThrow(/^.*Transaction not found$/);
    await expect(b.as.query(api.evidence.listForTransaction, { transactionId: missing })).rejects.toThrow(/Transaction not found/);
    await expect(t.query(api.evidence.listForTransaction, { transactionId: a.transactionId })).rejects.toThrow(/Not signed in/);
  });
});

describe("evidence.attachToTransaction", () => {
  it("links an unattached upload to an owned transaction, and is idempotent for the same pair", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const ev = await evidence(t, a.userId);
    expect(await a.as.mutation(api.evidence.attachToTransaction, { evidenceId: ev, transactionId: a.transactionId })).toEqual({ changed: true });
    expect((await t.run((ctx) => ctx.db.get(ev)))!.transactionId).toBe(a.transactionId);
    expect(await a.as.mutation(api.evidence.attachToTransaction, { evidenceId: ev, transactionId: a.transactionId })).toEqual({ changed: false });
    const listed = await a.as.query(api.evidence.listForTransaction, { transactionId: a.transactionId });
    expect(listed.evidence.map((e) => e._id)).toEqual([ev]);
  });

  it("refuses evidence already linked to another transaction, so facts citing it keep their transaction (DA-A-29)", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const otherPurchase = await a.as.mutation(api.purchases.create, { ...basePurchase, orderRef: "NW-2" });
    const otherTxn = await transactionOf(t, otherPurchase);
    const ev = await evidence(t, a.userId, { transactionId: otherTxn });
    await expect(a.as.mutation(api.evidence.attachToTransaction, { evidenceId: ev, transactionId: a.transactionId })).rejects.toThrow(
      /already attached to another transaction/,
    );
    expect((await t.run((ctx) => ctx.db.get(ev)))!.transactionId).toBe(otherTxn);
  });

  it("refuses a document whose content was cleared, unless it is already on that transaction", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const cleared = await evidence(t, a.userId, { retention: "content_deleted" });
    await expect(a.as.mutation(api.evidence.attachToTransaction, { evidenceId: cleared, transactionId: a.transactionId })).rejects.toThrow(
      /content was cleared/,
    );
    const clearedHere = await evidence(t, a.userId, { retention: "content_deleted", transactionId: a.transactionId });
    expect(await a.as.mutation(api.evidence.attachToTransaction, { evidenceId: clearedHere, transactionId: a.transactionId })).toEqual({ changed: false });
  });

  it("two users: foreign evidence or a foreign transaction is the identical not-found, and nothing is written", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const b = await owner(t, "B");
    const aEv = await evidence(t, a.userId);
    const bEv = await evidence(t, b.userId);
    await expect(b.as.mutation(api.evidence.attachToTransaction, { evidenceId: aEv, transactionId: b.transactionId })).rejects.toThrow(/Evidence not found/);
    await expect(b.as.mutation(api.evidence.attachToTransaction, { evidenceId: bEv, transactionId: a.transactionId })).rejects.toThrow(/Transaction not found/);
    await expect(b.as.mutation(api.evidence.attachToTransaction, { evidenceId: aEv, transactionId: a.transactionId })).rejects.toThrow(/Evidence not found/);
    expect((await t.run((ctx) => ctx.db.get(aEv)))!.transactionId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(bEv)))!.transactionId).toBeUndefined();
    await expect(t.mutation(api.evidence.attachToTransaction, { evidenceId: aEv, transactionId: a.transactionId })).rejects.toThrow(/Not signed in/);
  });
});

describe("evidence.listRecent", () => {
  it("lists the caller's own most recent uploads, newest first, never other kinds or other users'", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const b = await owner(t, "B");
    const ids: Id<"evidence">[] = [];
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(T0 + i * 1000);
      ids.push(await evidence(t, a.userId, i === 1 ? { transactionId: a.transactionId } : {}));
    }
    await evidence(t, a.userId, { kind: "email", sourceChannel: "agentmail_forward", provenance: "user_forwarded", receivedAt: T0 + 10_000 });
    await evidence(t, b.userId, { receivedAt: T0 + 20_000 });

    const res = await a.as.query(api.evidence.listRecent, { limit: 10 });
    expect(res.map((e) => e._id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(res[1].transactionId).toBe(a.transactionId);
    expect((await a.as.query(api.evidence.listRecent, { limit: 2 })).map((e) => e._id)).toEqual([ids[2], ids[1]]);
    const bRes = await b.as.query(api.evidence.listRecent, { limit: 10 });
    expect(bRes).toHaveLength(1);
    expect(bRes.every((e) => !ids.includes(e._id))).toBe(true);
  });

  it(`refuses a limit outside 1…${RECENT_UPLOADS_MAX}, and a caller who is not signed in`, async () => {
    const t = setup();
    const a = await owner(t, "A");
    for (const limit of [0, -1, 1.5, RECENT_UPLOADS_MAX + 1, Number.NaN]) {
      await expect(a.as.query(api.evidence.listRecent, { limit })).rejects.toThrow(/limit/);
    }
    expect(await a.as.query(api.evidence.listRecent, { limit: RECENT_UPLOADS_MAX })).toEqual([]);
    await expect(t.query(api.evidence.listRecent, { limit: 5 })).rejects.toThrow(/Not signed in/);
  });

  it("end to end: an upload through the route shows up in listRecent and can be attached", async () => {
    const t = setup();
    const a = await owner(t, "A");
    const body = new TextEncoder().encode("%PDF-1.4\nBT (Thank you for your order) Tj ET\n%%EOF\n");
    const res = await a.as.fetch("/evidence/upload", { method: "POST", body, headers: { "Content-Length": String(body.byteLength), "X-Doc-Type": "receipt" } });
    expect(res.status).toBe(200);
    const { evidenceId } = (await res.json()) as { evidenceId: Id<"evidence"> };
    const recent = await a.as.query(api.evidence.listRecent, { limit: 5 });
    expect(recent.map((e) => e._id)).toEqual([evidenceId]);
    expect(recent[0].transactionId).toBeNull();
    await a.as.mutation(api.evidence.attachToTransaction, { evidenceId, transactionId: a.transactionId });
    expect((await a.as.query(api.evidence.listForTransaction, { transactionId: a.transactionId })).evidence.map((e) => e._id)).toEqual([evidenceId]);
  });
});
