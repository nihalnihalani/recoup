/// <reference types="vite/client" />
import { describe, it, expect } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { putFact, readCellRows, type PutFactInput } from "./lib/facts/write";
import { MAX_LIVE_FACTS_PER_TRANSACTION } from "./limits";
import { FACT_SPECS, type FactSpec, type FactValue } from "./lib/facts/catalog";
import { legacyRetailRows } from "./lib/facts/legacyRetail";

type T = ReturnType<typeof setup>;

const basePurchase = {
  merchant: "Northwind Outfitters",
  merchantDomain: "northwind.example",
  orderRef: "NW-1001",
  purchasedAt: Date.UTC(2026, 7, 25),
  currency: "USD",
  items: [
    { name: "Merino sweater", unitCents: 8000, qty: 1 },
    { name: "Wool scarf", unitCents: 4000, qty: 2 },
  ],
};

async function retail(t: T, name = "Owner") {
  const { as, userId } = await signedIn(t, name);
  const purchaseId = await as.mutation(api.purchases.create, basePurchase);
  const { transactionId, itemIds } = await t.run(async (ctx) => {
    const txn = await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).unique();
    const items = await ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseId)).collect();
    return { transactionId: txn!._id, itemIds: items.map((i) => i._id) };
  });
  return { as, userId, purchaseId, transactionId, itemIds, item: `item:${itemIds[0]}`, item2: `item:${itemIds[1]}` };
}

const usd = (n: number) => ({ kind: "money" as const, amountMinor: n, currency: "USD" });
const user = { kind: "user" as const };

function put(t: T, userId: Id<"users">, input: PutFactInput) {
  return t.run((ctx) => putFact(ctx, userId, input));
}

async function evidence(t: T, userId: Id<"users">, extra: Partial<Doc<"evidence">> = {}) {
  return t.run((ctx) =>
    ctx.db.insert("evidence", {
      userId, kind: "email", docType: "order_confirmation", sourceChannel: "agentmail_forward",
      provenance: "user_forwarded", contentHash: "a".repeat(64), receivedAt: Date.now(),
      extractionStatus: "succeeded", extractionAttempts: 1, retention: "active", ...extra,
    }),
  );
}
const cite = (evidenceId: Id<"evidence">, quote = "Qty 2") => ({
  kind: "evidence" as const, evidenceId, quoteStatus: "unverified" as const, extractorVersion: "x1",
  locator: { kind: "text_span" as const, start: 0, end: quote.length, quote },
});

async function rows(t: T, transactionId: Id<"transactions">) {
  return t.run((ctx) =>
    ctx.db.query("facts").withIndex("by_transaction_and_subject_key_and_key", (q) => q.eq("transactionId", transactionId)).collect(),
  );
}
async function liveCount(t: T, transactionId: Id<"transactions">) {
  return (await t.run((ctx) => ctx.db.get(transactionId)))!.liveFactCount;
}

describe("the single fact writer (O2)", () => {
  const SOURCES = import.meta.glob<string>(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**"], {
    query: "?raw", import: "default", eager: true,
  });

  it("only lib/facts/write.ts inserts into facts", () => {
    const writers = Object.entries(SOURCES)
      .filter(([, src]) => /\.insert\(\s*["']facts["']/.test(src))
      .map(([f]) => f);
    expect(writers).toEqual(["./lib/facts/write.ts"]);
  });

  it("nothing else patches a fact row's state (supersession is the writer's)", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([f, src]) => f !== "./lib/facts/write.ts" && /state:\s*["']superseded["']/.test(src))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });
});

describe("putFact — refusals (closed catalogue, ownership, DA-A-29)", () => {
  it("refuses an off-catalogue key, a key of another category, and a subject the key does not take", async () => {
    const t = setup();
    const r = await retail(t);
    await expect(put(t, r.userId, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.nope", state: "user_confirmed", value: usd(1), source: user })).rejects.toThrow(/Unknown fact key/);
    await expect(put(t, r.userId, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.unit_price", state: "user_confirmed", value: usd(1), source: user })).rejects.toThrow(/not recorded against a transaction/);
    await expect(put(t, r.userId, { transactionId: r.transactionId, subjectKey: "order:1", key: "retail.unit_price", state: "user_confirmed", value: usd(1), source: user })).rejects.toThrow(/Unknown fact subject/);
    const air = await t.run((ctx) =>
      ctx.db.insert("transactions", { userId: r.userId, category: "air_travel", status: "active", counterpartyName: "Air", currency: "USD", liveFactCount: 0 }),
    );
    await expect(put(t, r.userId, { transactionId: air, subjectKey: "txn", key: "retail.currency", state: "user_confirmed", value: { kind: "code", code: "USD" }, source: user })).rejects.toThrow(/does not apply to a air_travel/);
  });

  it("another user's transaction → the same not-found as a missing one", async () => {
    const t = setup();
    const a = await retail(t, "A");
    const b = await retail(t, "B");
    const input = { transactionId: a.transactionId, subjectKey: "txn", key: "retail.currency", state: "user_confirmed" as const, value: { kind: "code" as const, code: "USD" }, source: user };
    await expect(put(t, b.userId, input)).rejects.toThrow(/^.*Transaction not found/);
  });

  it("an item from another purchase (same user) or another user → Item not found", async () => {
    const t = setup();
    const a = await retail(t, "A");
    const { purchaseId: other } = await (async () => {
      const purchaseId = await a.as.mutation(api.purchases.create, { ...basePurchase, orderRef: "NW-2" });
      return { purchaseId };
    })();
    const otherItem = await t.run(async (ctx) => (await ctx.db.query("items").withIndex("by_purchase", (q) => q.eq("purchaseId", other)).first())!._id);
    const b = await retail(t, "B");
    for (const subjectKey of [`item:${otherItem}`, b.item, "item:zzzzzz"]) {
      await expect(put(t, a.userId, { transactionId: a.transactionId, subjectKey, key: "retail.quantity", state: "user_confirmed", value: { kind: "count", n: 1 }, source: user })).rejects.toThrow(/Item not found/);
    }
  });

  it("refuses wrong kinds, codes off the list, and user_confirmed for a key only the system states", async () => {
    const t = setup();
    const r = await retail(t);
    const base = { transactionId: r.transactionId, subjectKey: r.item, source: user, state: "user_confirmed" as const };
    await expect(put(t, r.userId, { ...base, key: "retail.quantity", value: usd(1) })).rejects.toThrow(/count/);
    await expect(put(t, r.userId, { ...base, key: "retail.observed_price", value: usd(1) })).rejects.toThrow(/not something you can confirm/);
    await expect(put(t, r.userId, { ...base, subjectKey: "txn", key: "retail.currency", value: { kind: "code", code: "XYZ" } })).rejects.toThrow(/currency/);
    await expect(put(t, r.userId, { ...base, key: "retail.unit_price", value: usd(100_000_001) })).rejects.toThrow(/larger/);
  });

  it("state ↔ source: a candidate needs evidence, derived needs a rule, only a user answer says I don't know or overrides", async () => {
    const t = setup();
    const r = await retail(t);
    const base = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity" };
    await expect(put(t, r.userId, { ...base, state: "extracted_candidate", value: { kind: "count", n: 1 }, source: user })).rejects.toThrow(/cannot come from a user source/);
    await expect(put(t, r.userId, { ...base, state: "derived", value: { kind: "count", n: 1 }, source: user })).rejects.toThrow(/cannot come from a user source/);
    const ev = await evidence(t, r.userId);
    await expect(put(t, r.userId, { ...base, state: "extracted_candidate", value: { kind: "user_unknown" }, source: cite(ev) })).rejects.toThrow(/I don't know/);
    await expect(put(t, r.userId, { ...base, state: "extracted_candidate", value: { kind: "count", n: 1 }, source: cite(ev), overridesObserved: true })).rejects.toThrow(/override/);
  });

  it("DA-A-29: evidence from another of the user's transactions is refused; unlinked evidence is linked on cite", async () => {
    const t = setup();
    const r = await retail(t);
    const second = await r.as.mutation(api.purchases.create, { ...basePurchase, orderRef: "NW-2" });
    const secondTxn = await t.run(async (ctx) => (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", second)).unique())!._id);
    const foreign = await evidence(t, r.userId, { transactionId: secondTxn });
    const input = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity", state: "extracted_candidate" as const, value: { kind: "count" as const, n: 2 } };
    await expect(put(t, r.userId, { ...input, source: cite(foreign) })).rejects.toThrow(/Evidence belongs to a different transaction/);
    expect(await rows(t, r.transactionId)).toHaveLength(0);

    const unlinked = await evidence(t, r.userId);
    await put(t, r.userId, { ...input, source: cite(unlinked) });
    expect((await t.run((ctx) => ctx.db.get(unlinked)))!.transactionId).toBe(r.transactionId);

    const b = await retail(t, "B");
    const othersEvidence = await evidence(t, b.userId);
    await expect(put(t, r.userId, { ...input, source: cite(othersEvidence) })).rejects.toThrow(/Evidence not found/);
  });

  it("SEC-AI-6: evidence from an unverified sender yields candidates only", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId, { provenance: "unverified_sender" });
    const input = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity", value: { kind: "count" as const, n: 2 }, source: cite(ev) };
    await expect(put(t, r.userId, { ...input, state: "user_confirmed" })).rejects.toThrow(/unverified sender/);
    expect((await put(t, r.userId, { ...input, state: "extracted_candidate" })).outcome).toBe("inserted");
  });

  it("a price check must be the user's, on this transaction, about its own item", async () => {
    const t = setup();
    const r = await retail(t);
    const pc = await t.run((ctx) =>
      ctx.db.insert("priceChecks", { itemId: r.itemIds[0], userId: r.userId, observedCents: 7000, currency: "USD", observedAt: Date.now(), sourceUrl: "https://northwind.example/p" }),
    );
    const input = { transactionId: r.transactionId, key: "retail.observed_price", state: "observed" as const, value: usd(7000), source: { kind: "price_check" as const, priceCheckId: pc } };
    await expect(put(t, r.userId, { ...input, subjectKey: r.item2 })).rejects.toThrow(/its own item/);
    const b = await retail(t, "B");
    await expect(put(t, b.userId, { ...input, transactionId: b.transactionId, subjectKey: b.item })).rejects.toThrow(/Price check not found/);
    expect((await put(t, r.userId, { ...input, subjectKey: r.item })).outcome).toBe("inserted");
  });

  it("derived facts cite 1–8 facts of the same transaction", async () => {
    const t = setup();
    const r = await retail(t);
    const second = await retail(t, "Other");
    const { factId: mine } = await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity", state: "user_confirmed", value: { kind: "count", n: 1 }, source: user });
    const { factId: theirs } = await put(t, second.userId, { transactionId: second.transactionId, subjectKey: second.item, key: "retail.quantity", state: "user_confirmed", value: { kind: "count", n: 1 }, source: user });
    const input = { transactionId: r.transactionId, subjectKey: "txn", key: "retail.window_days", state: "derived" as const, value: { kind: "count" as const, n: 30 } };
    await expect(put(t, r.userId, { ...input, source: { kind: "derived", ruleId: "R01", fromFactIds: [theirs] } })).rejects.toThrow(/Fact not found/);
    await expect(put(t, r.userId, { ...input, source: { kind: "derived", ruleId: "R01", fromFactIds: Array(9).fill(mine) } })).rejects.toThrow(/1 to 8/);
    await expect(put(t, r.userId, { ...input, source: { kind: "derived", ruleId: "R01", fromFactIds: [] } })).rejects.toThrow(/1 to 8/);
    expect((await put(t, r.userId, { ...input, source: { kind: "derived", ruleId: "R01", fromFactIds: [mine] } })).outcome).toBe("inserted");
  });

  it("refuses writes to an archived transaction and for a deleted account", async () => {
    const t = setup();
    const r = await retail(t);
    const input = { transactionId: r.transactionId, subjectKey: "txn", key: "retail.currency", state: "user_confirmed" as const, value: { kind: "code" as const, code: "USD" }, source: user };
    await t.run((ctx) => ctx.db.insert("accountState", { userId: r.userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));
    await expect(put(t, r.userId, input)).rejects.toThrow(/deleted/);
    const s = await retail(t, "S");
    await s.as.mutation(api.purchases.remove, { purchaseId: s.purchaseId });
    await expect(put(t, s.userId, { ...input, transactionId: s.transactionId })).rejects.toThrow(/archived/);
  });
});

describe("putFact — D142 masking", () => {
  it("putFact masks text, never refuses", async () => {
    const t = setup();
    const r = await retail(t);
    const res = await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.item_name", state: "user_confirmed", value: { kind: "text", text: "Card 4111-1111-1111-1111 sleeve" }, source: user });
    expect(res.outcome).toBe("inserted");
    const [row] = await rows(t, r.transactionId);
    expect(row.value).toEqual({ kind: "text", text: "Card •••• 1111 sleeve" });
  });

  it("masks a card number inside an evidence locator quote", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId);
    await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity", state: "extracted_candidate", value: { kind: "count", n: 2 }, source: cite(ev, "paid with 4111 1111 1111 1111, qty 2") });
    const [row] = await rows(t, r.transactionId);
    expect(row.source.kind === "evidence" && row.source.locator.kind === "text_span" && row.source.locator.quote).toBe("paid with •••• 1111, qty 2");
  });

  it("a Luhn-valid order ref is an identifier and is stored unchanged (never masked)", async () => {
    const t = setup();
    const r = await retail(t);
    await put(t, r.userId, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.order_ref", state: "user_confirmed", value: { kind: "identifier", scheme: "order_ref", value: "112-3456789-1234562" }, source: user });
    const [row] = await rows(t, r.transactionId);
    expect(row.value).toEqual({ kind: "identifier", scheme: "order_ref", value: "112-3456789-1234562" });
  });
});

describe("putFact — supersede rules and the live count", () => {
  it("a new confirmation supersedes the confirmed row and candidates, not the observation", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId);
    const pc = await t.run((ctx) => ctx.db.insert("priceChecks", { itemId: r.itemIds[0], userId: r.userId, observedCents: 7000, currency: "USD", observedAt: Date.now(), sourceUrl: "https://x.example" }));
    const base = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.unit_price" };
    // retail.unit_price is user-assertable; the observation targets retail.observed_price in real use, but the
    // supersede rules are per cell, so one cell exercises all of them.
    await put(t, r.userId, { ...base, state: "extracted_candidate", value: usd(8100), source: cite(ev) });
    const first = await put(t, r.userId, { ...base, state: "user_confirmed", value: usd(8000), source: user });
    expect(await liveCount(t, r.transactionId)).toBe(1);
    await put(t, r.userId, { ...base, key: "retail.observed_price", state: "observed", value: usd(7000), source: { kind: "price_check", priceCheckId: pc } });
    const second = await put(t, r.userId, { ...base, state: "user_confirmed", value: usd(7900), source: user });
    const all = await rows(t, r.transactionId);
    const byId = new Map(all.map((x) => [x._id, x]));
    expect(byId.get(first.factId)).toMatchObject({ state: "superseded", supersededBy: second.factId });
    expect(all.filter((x) => x.state !== "superseded").map((x) => [x.key, x.state])).toEqual([
      ["retail.observed_price", "observed"],
      ["retail.unit_price", "user_confirmed"],
    ]);
    expect(await liveCount(t, r.transactionId)).toBe(2);
  });

  it("overridesObserved supersedes the cell's observation", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId);
    const base = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity" };
    await put(t, r.userId, { ...base, state: "observed", value: { kind: "count", n: 3 }, source: cite(ev) });
    await put(t, r.userId, { ...base, state: "user_confirmed", value: { kind: "count", n: 2 }, source: user, overridesObserved: true });
    const live = await t.run((ctx) => readCellRows(ctx, r.transactionId, r.item, "retail.quantity"));
    expect(live.map((x) => [x.state, x.value])).toEqual([["user_confirmed", { kind: "count", n: 2 }]]);
    expect(live[0].overridesObserved).toBe(true);
    expect(await liveCount(t, r.transactionId)).toBe(1);
  });

  it("DA-A-36: an unchanged observation patches lastObservedAt and inserts nothing; a changed one supersedes", async () => {
    const t = setup();
    const r = await retail(t);
    const pc = await t.run((ctx) => ctx.db.insert("priceChecks", { itemId: r.itemIds[0], userId: r.userId, observedCents: 7000, currency: "USD", observedAt: Date.now(), sourceUrl: "https://x.example" }));
    const obs = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.observed_price", state: "observed" as const, source: { kind: "price_check" as const, priceCheckId: pc } };
    const a = await put(t, r.userId, { ...obs, value: usd(7000) });
    const before = (await t.run((ctx) => ctx.db.get(a.factId)))!.lastObservedAt!;
    await new Promise((res) => setTimeout(res, 5));
    const b = await put(t, r.userId, { ...obs, value: usd(7000) });
    expect(b).toEqual({ factId: a.factId, outcome: "patched" });
    expect((await t.run((ctx) => ctx.db.get(a.factId)))!.lastObservedAt!).toBeGreaterThan(before);
    expect(await rows(t, r.transactionId)).toHaveLength(1);
    const c = await put(t, r.userId, { ...obs, value: usd(6500) });
    expect(c.outcome).toBe("inserted");
    expect((await rows(t, r.transactionId)).map((x) => x.state)).toEqual(["superseded", "observed"]);
    expect(await liveCount(t, r.transactionId)).toBe(1);
  });

  it("re-stating an identical answer writes nothing; a candidate supersedes nothing; a derived supersedes the older derived", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId);
    const q = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity" };
    const a = await put(t, r.userId, { ...q, state: "user_confirmed", value: { kind: "count", n: 2 }, source: user });
    expect(await put(t, r.userId, { ...q, state: "user_confirmed", value: { kind: "count", n: 2 }, source: user })).toEqual({ factId: a.factId, outcome: "unchanged" });
    await put(t, r.userId, { ...q, state: "extracted_candidate", value: { kind: "count", n: 5 }, source: cite(ev) });
    expect((await t.run((ctx) => readCellRows(ctx, r.transactionId, r.item, "retail.quantity"))).map((x) => x.state)).toEqual(["user_confirmed", "extracted_candidate"]);
    // A later identical answer is no longer a no-op: it retires the newer candidate.
    expect((await put(t, r.userId, { ...q, state: "user_confirmed", value: { kind: "count", n: 2 }, source: user })).outcome).toBe("inserted");
    expect(await liveCount(t, r.transactionId)).toBe(1);

    const { factId: input } = await put(t, r.userId, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.currency", state: "user_confirmed", value: { kind: "code", code: "USD" }, source: user });
    const d = { transactionId: r.transactionId, subjectKey: "txn", key: "retail.window_days", state: "derived" as const, source: { kind: "derived" as const, ruleId: "R01", fromFactIds: [input] } };
    await put(t, r.userId, { ...d, value: { kind: "count", n: 30 } });
    await put(t, r.userId, { ...d, value: { kind: "count", n: 14 } });
    const live = await t.run((ctx) => readCellRows(ctx, r.transactionId, "txn", "retail.window_days"));
    expect(live.map((x) => x.value)).toEqual([{ kind: "count", n: 14 }]);
    expect(await liveCount(t, r.transactionId)).toBe(3);
  });

  it("I don't know supersedes the earlier answer and candidates like any confirmation", async () => {
    const t = setup();
    const r = await retail(t);
    const q = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.quantity", state: "user_confirmed" as const, source: user };
    await put(t, r.userId, { ...q, value: { kind: "count", n: 2 } });
    await put(t, r.userId, { ...q, value: { kind: "user_unknown" } });
    const live = await t.run((ctx) => readCellRows(ctx, r.transactionId, r.item, "retail.quantity"));
    expect(live.map((x) => x.value)).toEqual([{ kind: "user_unknown" }]);
  });

  it("copies isExample from the transaction", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const { purchaseIds } = await as.mutation(api.examples.load, {});
    const txn = await t.run(async (ctx) => (await ctx.db.query("transactions").withIndex("by_purchase", (q) => q.eq("purchaseId", purchaseIds[0])).unique())!);
    await put(t, userId, { transactionId: txn._id, subjectKey: "txn", key: "retail.currency", state: "user_confirmed", value: { kind: "code", code: "USD" }, source: user });
    expect((await rows(t, txn._id))[0].isExample).toBe(true);
  });
});

describe("putFact — the live cap (DA-A-36)", () => {
  it("the 1,001st correction is accepted: superseded rows never count toward the cap", async () => {
    const t = setup();
    const r = await retail(t);
    const q = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.unit_price", state: "user_confirmed" as const, source: user };
    for (let batch = 0; batch < 11; batch++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 91; i++) await putFact(ctx, r.userId, { ...q, value: usd(10_000 + batch * 91 + i) });
      });
    }
    // 11 × 91 = 1,001 corrections of one cell.
    const all = await rows(t, r.transactionId);
    expect(all).toHaveLength(1_001);
    expect(all.filter((x) => x.state !== "superseded")).toHaveLength(1);
    expect(await liveCount(t, r.transactionId)).toBe(1);
  });

  it("at the cap a NEW fact is refused but a correction, an unchanged observation and a changed observation are accepted", async () => {
    const t = setup();
    const r = await retail(t);
    const ev = await evidence(t, r.userId);
    const pc = await t.run((ctx) => ctx.db.insert("priceChecks", { itemId: r.itemIds[0], userId: r.userId, observedCents: 7000, currency: "USD", observedAt: Date.now(), sourceUrl: "https://x.example" }));
    await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.unit_price", state: "user_confirmed", value: usd(8000), source: user });
    const obs = { transactionId: r.transactionId, subjectKey: r.item, key: "retail.observed_price", state: "observed" as const, source: { kind: "price_check" as const, priceCheckId: pc } };
    await put(t, r.userId, { ...obs, value: usd(7000) });
    // Fill the rest of the cap with distinct live candidates on one cell (seeded directly: the cap is what is tested).
    await t.run(async (ctx) => {
      for (let n = 1; n <= MAX_LIVE_FACTS_PER_TRANSACTION - 2; n++) {
        await ctx.db.insert("facts", {
          userId: r.userId, transactionId: r.transactionId, subjectKey: r.item2, key: "retail.quantity",
          state: "extracted_candidate", value: { kind: "count", n }, source: cite(ev), recordedAt: Date.now(),
        });
      }
      await ctx.db.patch(r.transactionId, { liveFactCount: MAX_LIVE_FACTS_PER_TRANSACTION });
    });
    await expect(put(t, r.userId, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.currency", state: "user_confirmed", value: { kind: "code", code: "USD" }, source: user })).rejects.toThrow(/at most 1000 current facts/);
    expect((await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.unit_price", state: "user_confirmed", value: usd(7900), source: user })).outcome).toBe("inserted");
    expect((await put(t, r.userId, { ...obs, value: usd(7000) })).outcome).toBe("patched");
    expect((await put(t, r.userId, { ...obs, value: usd(6000) })).outcome).toBe("inserted");
    expect(await liveCount(t, r.transactionId)).toBe(MAX_LIVE_FACTS_PER_TRANSACTION);
  });
});

describe("facts public functions (ownership, D142, DA-A-1)", () => {
  it("list: the resolved cells of a retail transaction — legacy values, the currency assumption, stored answers", async () => {
    const t = setup();
    const r = await retail(t);
    // An internal user_confirmed writer (not facts.answer: retail.quantity is legacy-backed, M11b).
    await put(t, r.userId, { transactionId: r.transactionId, subjectKey: r.item2, key: "retail.quantity", state: "user_confirmed", value: { kind: "user_unknown" }, source: user });
    const cells = await r.as.query(api.facts.list, { transactionId: r.transactionId });
    const get = (s: string, k: string) => cells.find((c) => c.subjectKey === s && c.key === k);
    expect(get("txn", "retail.merchant")).toMatchObject({ status: "confirmed", value: { kind: "text", text: "Northwind Outfitters" }, source: { kind: "legacy_purchase" }, userAssertable: true, answerVia: "purchases.confirm" });
    expect(get("txn", "retail.currency")).toMatchObject({ status: "candidate", capsOutcomeAt: "likely_eligible", question: { prompt: "Which currency did you pay in?" } });
    expect(get(r.item, "retail.unit_price")).toMatchObject({ status: "confirmed", value: usd(8000) });
    // DA-A-1 end to end: "I don't know" is never read as the legacy value it replaced.
    expect(get(r.item2, "retail.quantity")).toEqual({
      subjectKey: r.item2, key: "retail.quantity", status: "user_unknown", capsOutcomeAt: null, userAssertable: true,
      answerVia: "purchases.confirm", question: { prompt: "How many did you buy?", why: "The difference is owed per unit." },
    });
  });

  it("answer: records a confirmation through putFact (masked), and an identical re-answer writes nothing", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const standalone = await t.run((ctx) =>
      ctx.db.insert("transactions", { userId, category: "retail_order", status: "active", counterpartyName: "Shop", currency: "USD", liveFactCount: 0 }),
    );
    const args = { transactionId: standalone, subjectKey: "txn", key: "retail.merchant", value: { kind: "text" as const, text: "Shop 5555 5555 5555 4444" } };
    const first = await as.mutation(api.facts.answer, args);
    expect(first.outcome).toBe("inserted");
    expect(await as.mutation(api.facts.answer, args)).toEqual({ factId: first.factId, outcome: "unchanged" });
    const cells = await as.query(api.facts.list, { transactionId: standalone });
    expect(cells).toEqual([
      expect.objectContaining({ key: "retail.merchant", status: "confirmed", value: { kind: "text", text: "Shop •••• 4444" }, answerVia: "facts.answer" }),
    ]);
  });

  it("answer: refuses keys only the system states and off-catalogue keys; writes nothing", async () => {
    const t = setup();
    const r = await retail(t);
    await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.observed_price", value: usd(1) })).rejects.toThrow(/not something you can confirm/);
    await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.window_days", value: { kind: "count", n: 99 } })).rejects.toThrow(/not something you can confirm/);
    await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: "txn", key: "x".repeat(5000), value: usd(1) })).rejects.toThrow(/Unknown fact key/);
    expect(await rows(t, r.transactionId)).toHaveLength(0);
  });

  it("two users: a foreign transaction or item gets the identical not-found on list and answer, and nothing is written", async () => {
    const t = setup();
    const a = await retail(t, "A");
    const b = await retail(t, "B");
    const gone = await t.run(async (ctx) => {
      const id = await ctx.db.insert("transactions", { userId: a.userId, category: "retail_order", status: "active", counterpartyName: "X", currency: "USD", liveFactCount: 0 });
      await ctx.db.delete(id);
      return id;
    });
    const foreignList = await b.as.query(api.facts.list, { transactionId: a.transactionId }).catch((e: Error) => e.message);
    const missingList = await a.as.query(api.facts.list, { transactionId: gone }).catch((e: Error) => e.message);
    expect(foreignList).toMatch(/Transaction not found/);
    expect(missingList).toBe(foreignList);
    const answer = { subjectKey: "txn", key: "retail.currency", value: { kind: "code" as const, code: "USD" } };
    const foreignAnswer = await b.as.mutation(api.facts.answer, { ...answer, transactionId: a.transactionId }).catch((e: Error) => e.message);
    expect(foreignAnswer).toBe(foreignList);
    // B's own transaction, A's item as the subject.
    await expect(b.as.mutation(api.facts.answer, { transactionId: b.transactionId, subjectKey: a.item, key: "retail.quantity", value: { kind: "count", n: 1 } })).rejects.toThrow();
    expect(await rows(t, a.transactionId)).toHaveLength(0);
    expect(await rows(t, b.transactionId)).toHaveLength(0);
  });

  it("signed-out and deleted callers are refused", async () => {
    const t = setup();
    const r = await retail(t);
    await expect(t.query(api.facts.list, { transactionId: r.transactionId })).rejects.toThrow(/Not signed in/);
    await expect(t.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.currency", value: { kind: "code", code: "USD" } })).rejects.toThrow(/Not signed in/);
    await t.run((ctx) => ctx.db.insert("accountState", { userId: r.userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));
    await expect(r.as.query(api.facts.list, { transactionId: r.transactionId })).rejects.toThrow(/deleted/);
    await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: "txn", key: "retail.currency", value: { kind: "code", code: "USD" } })).rejects.toThrow(/deleted/);
  });

  it("a non-retail transaction lists its stored cells only", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t);
    const air = await t.run((ctx) =>
      ctx.db.insert("transactions", { userId, category: "air_travel", status: "active", counterpartyName: "Air", currency: "USD", liveFactCount: 0 }),
    );
    expect(await as.query(api.facts.list, { transactionId: air })).toEqual([]);
  });
});

describe("M11b: legacy-backed retail keys have one source of truth (the purchase record)", () => {
  const LEGACY_BACKED = ["retail.merchant", "retail.order_ref", "retail.purchase_date", "retail.currency", "retail.item_name", "retail.quantity", "retail.unit_price"];

  it("facts.answer refuses every legacy-backed key on a purchase-backed transaction, pointing at the purchase edit; nothing is written", async () => {
    const t = setup();
    const r = await retail(t);
    const answers: Array<{ subjectKey: string; key: string; value: FactValue }> = [
      { subjectKey: "txn", key: "retail.merchant", value: { kind: "text", text: "Northwind Co" } },
      { subjectKey: "txn", key: "retail.order_ref", value: { kind: "identifier", scheme: "order_ref", value: "NW-9" } },
      { subjectKey: "txn", key: "retail.purchase_date", value: { kind: "instant", epochMs: Date.UTC(2026, 7, 20) } },
      { subjectKey: "txn", key: "retail.currency", value: { kind: "code", code: "EUR" } },
      { subjectKey: r.item, key: "retail.item_name", value: { kind: "text", text: "Sweater" } },
      { subjectKey: r.item, key: "retail.quantity", value: { kind: "user_unknown" } },
      { subjectKey: r.item, key: "retail.unit_price", value: usd(7000) },
    ];
    expect(answers.map((a) => a.key)).toEqual(LEGACY_BACKED);
    for (const a of answers) {
      await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, ...a }), a.key).rejects.toThrow(/edit the purchase/);
    }
    expect(await rows(t, r.transactionId)).toHaveLength(0);
    expect(await liveCount(t, r.transactionId)).toBe(0);
  });

  it("the same correction through purchases.confirm updates the snapshot, with no conflict", async () => {
    const t = setup();
    const r = await retail(t);
    await expect(r.as.mutation(api.facts.answer, { transactionId: r.transactionId, subjectKey: r.item, key: "retail.unit_price", value: usd(7000) })).rejects.toThrow(/edit the purchase/);
    await r.as.mutation(api.purchases.confirm, {
      purchaseId: r.purchaseId, merchant: "Northwind Outfitters", merchantDomain: "northwind.example", purchasedAt: basePurchase.purchasedAt,
      items: [
        { itemId: r.itemIds[0], name: "Merino sweater", unitCents: 7000, qty: 1 },
        { itemId: r.itemIds[1], name: "Wool scarf", unitCents: 4000, qty: 2 },
      ],
    });
    const cells = await r.as.query(api.facts.list, { transactionId: r.transactionId });
    expect(cells.find((c) => c.subjectKey === r.item && c.key === "retail.unit_price")).toMatchObject({ status: "confirmed", value: usd(7000), source: { kind: "legacy_purchase" } });
    expect(cells.filter((c) => c.status === "conflicting")).toEqual([]);
  });

  it("the catalogue flag and the legacy adapter agree on which keys the purchase record backs", () => {
    const flagged = (FACT_SPECS as readonly FactSpec[]).filter((s) => s.sourceOfTruth === "purchase_record").map((s) => s.key).sort();
    expect(flagged).toEqual([...LEGACY_BACKED].sort());
    const emitted = new Set(legacyRetailRows({
      purchase: { _id: "p" as Id<"purchases">, _creationTime: 0, userId: "u" as Id<"users">, merchant: "M", merchantDomain: "m.example", orderRef: "R-1", purchasedAt: 1, currency: "USD", status: "active" },
      items: [{ _id: "i" as Id<"items">, _creationTime: 0, purchaseId: "p" as Id<"purchases">, userId: "u" as Id<"users">, name: "N", unitCents: 1, qty: 1, returned: false }],
      latestAccepted: {},
    }).map((r) => r.key));
    expect([...emitted].sort()).toEqual([...LEGACY_BACKED].sort());
  });
});

describe("M11b: facts.answer is rate-limited per user (factsAnswer bucket)", () => {
  it("a burst of 30 answers passes; the 31st is refused before any write; another user is unaffected", async () => {
    const t = setup();
    const { as, userId } = await signedIn(t, "Burst");
    const other = await signedIn(t, "Other");
    const standalone = async (uid: Id<"users">) =>
      t.run((ctx) => ctx.db.insert("transactions", { userId: uid, category: "retail_order", status: "active", counterpartyName: "Shop", currency: "USD", liveFactCount: 0 }));
    const mine = await standalone(userId);
    const theirs = await standalone(other.userId);
    const answer = (transactionId: Id<"transactions">, text: string) => ({ transactionId, subjectKey: "txn", key: "retail.merchant", value: { kind: "text" as const, text } });
    for (let i = 0; i < 30; i++) await as.mutation(api.facts.answer, answer(mine, `Shop ${i}`));
    const before = await rows(t, mine);
    await expect(as.mutation(api.facts.answer, answer(mine, "Shop 30"))).rejects.toThrow(/too many answers/);
    expect(await rows(t, mine)).toEqual(before);
    expect((await other.as.mutation(api.facts.answer, answer(theirs, "Theirs"))).outcome).toBe("inserted");
  });
});
