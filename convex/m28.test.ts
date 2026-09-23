/// <reference types="vite/client" />
/**
 * M28 (contract §11.2 row M28): replies, drafts and follow-ups on item-less (scenario) claims — DA-A-12's HC-1 sites
 * compile AND are tested — plus DA-A-19 (a reply's currency), the scenario-aware reply prompt and `expectedDomain`,
 * D21/D178 (a promise from a mismatched sender is held for the user), `purpose` (DA-A-9) and `responseExpectation`.
 * The model is a mock; nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./lib/ai", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./lib/ai")>();
  return { ...orig, extract: vi.fn() };
});

import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { extract } from "./lib/ai";
import { REPLY_REVIEW, statedCurrencyMatches } from "./replies";
import { MIN_REMINDER_DAYS, reminderFireAt } from "./followUps";
import { ITEMLESS_CLAIM_MESSAGE } from "./lib/legacyClaim";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 23, 12);
const DAY = 86_400_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(extract).mockReset();
});

/** An air_travel transaction with an R02 opportunity and its scenario claim (no purchase, no item). */
async function scenarioClaim(
  t: T,
  userId: Id<"users">,
  opts: { requiredChannel?: Doc<"claims">["requiredChannel"]; status?: Doc<"claims">["status"]; deadlines?: Doc<"evaluations">["deadlines"] } = {},
) {
  return await t.run(async (ctx) => {
    const transactionId = await ctx.db.insert("transactions", {
      userId, category: "air_travel", status: "active", counterpartyName: "Example Air", counterpartyDomain: "example-air.example", currency: "USD", liveFactCount: 0,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      userId, transactionId, scenarioId: "R02", remedyKey: "fare_refund", subjectKey: "txn", dedupeKey: `${transactionId}|R02|fare_refund|txn|-`,
      status: "case_open", ruleId: "R02.air_refund", ruleVersion: 1, outcome: "eligible", authorityClass: "legal_entitlement",
      remedyType: "cash_refund", cashClass: "cash", estimate: { amountMinor: 41_220, currency: "USD" }, lossKeys: [`txn:${transactionId}:paid`],
      lastEvaluatedAt: T0 - DAY,
    });
    if (opts.deadlines) {
      const evaluationId = await ctx.db.insert("evaluations", {
        userId, opportunityId, scenarioId: "R02", ruleId: "R02.air_refund", ruleVersion: 1, trigger: "case_open", evaluatedAt: T0 - DAY,
        factSnapshotHash: "f", resultHash: "h",
        outcome: "eligible", dimensions: { applies: "pass", factsKnown: "pass", evidenceSupports: "pass", windowOpen: "pass", amountCalculable: "pass", readyForApproval: "pass" },
        conditions: [], assumptions: [], missingFacts: [], disqualifierIds: [], amount: null, deadlines: opts.deadlines, sourceRefs: [],
        overlap: [], nextAction: { kind: "open_case" }, explanation: [], boundFacts: [
          { subjectKey: "txn", key: "air.ticket_number", status: "confirmed", value: { kind: "identifier", scheme: "eticket", value: "0161234567890" } },
          { subjectKey: "txn", key: "air.total_paid", status: "confirmed", value: { kind: "money", amountMinor: 41_220, currency: "USD" } },
          { subjectKey: "txn", key: "air.operating_carrier", status: "candidate", value: { kind: "text", text: "Not confirmed Air" } },
        ],
      });
      await ctx.db.patch(opportunityId, { currentEvaluationId: evaluationId });
    }
    const claimId = await ctx.db.insert("claims", {
      userId, type: "scenario", expectedCents: 41_220, status: opts.status ?? "sent", token: "AIR123", version: 1, transactionId, opportunityId,
      scenarioId: "R02", remedyKey: "fare_refund", currency: "USD", lossKeys: [`txn:${transactionId}:paid`],
      requiredChannel: opts.requiredChannel ?? "email", caseMode: "request",
    });
    await ctx.db.patch(opportunityId, { activeClaimId: claimId });
    return { transactionId, opportunityId, claimId };
  });
}

async function ledger(t: T, claimId: Id<"claims">) {
  return await t.run((ctx) => ctx.db.query("ledgerEvents").withIndex("by_claim", (q) => q.eq("claimId", claimId)).collect());
}
const claimRow = (t: T, id: Id<"claims">) => t.run((ctx) => ctx.db.get(id));

// ---------------------------------------------------------------------------

describe("DA-A-19: a reply's amount is recorded only in the claim's own currency", () => {
  it("a '€40' reply on a USD claim → no ledger event, needs review", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    const res = await t.mutation(internal.replies.apply, {
      claimId, messageId: "m-eur", from: "refunds@example-air.example", classification: "promise", summary: "We will refund 40.",
      promised: { value: "40", currency: "€" },
    });
    expect(res).toMatchObject({ ledgerWritten: false, review: REPLY_REVIEW.currency("€", "USD") });
    expect(await ledger(t, claimId)).toEqual([]);
    const claim = await claimRow(t, claimId);
    expect(claim?.status).toBe("sent");
    expect(claim?.attentionAt).toBe(T0);
  });

  it("the claim's own currency, as a code or a symbol that can mean it, is recorded in minor units by string arithmetic", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    const res = await t.mutation(internal.replies.apply, {
      claimId, messageId: "m-usd", from: "refunds@example-air.example", classification: "promise", summary: "Refund of USD 1,234.50 coming.",
      promised: { value: "1,234.50", currency: "USD" },
    });
    expect(res).toMatchObject({ ledgerWritten: true, review: null });
    expect((await ledger(t, claimId)).map((e) => [e.kind, e.cents])).toEqual([["promised_credit", 123_450]]);
    expect(statedCurrencyMatches("$", "USD")).toBe(true);
    expect(statedCurrencyMatches("US$", "USD")).toBe(true);
    expect(statedCurrencyMatches("€", "USD")).toBe(false);
    expect(statedCurrencyMatches("usd", "USD")).toBe(true);
    expect(statedCurrencyMatches("CAD", "USD")).toBe(false);
  });

  it("an amount with a sign marker, or one that does not parse, records nothing and asks for review", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    for (const value of ["(40.00)", "forty", "40.001"]) {
      const res = await t.mutation(internal.replies.apply, {
        claimId, messageId: `m-${value}`, from: "refunds@example-air.example", classification: "credit_issued", summary: "Refunded.",
        promised: { value, currency: "USD" },
      });
      expect(res.review).toBe(REPLY_REVIEW.amount);
    }
    expect(await ledger(t, claimId)).toEqual([]);
  });
});

describe("expectedDomain and D21/D178 on a scenario claim", () => {
  it("with no sent draft, the transaction's counterparty domain is the expected sender (HC-1: never a throw)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    const ok = await t.mutation(internal.replies.apply, {
      claimId, messageId: "m1", from: "Example Air <help@mail.example-air.example>", classification: "other", summary: "Received.",
    });
    expect((await t.run((ctx) => ctx.db.get(ok.replyId!)))?.senderMismatch).toBe(false);
  });

  it("a promise from a mismatched sender is held for the user: no ledger event and no status change until they confirm it once", async () => {
    const t = setup();
    const owner = await signedIn(t, "Owner");
    const other = await signedIn(t, "Other");
    const { claimId } = await scenarioClaim(t, owner.userId);
    const res = await t.mutation(internal.replies.apply, {
      claimId, messageId: "m-spoof", from: "refunds@lookalike.example", classification: "promise", summary: "Refund of 412.20 on its way.",
      promised: { value: "412.20", currency: "USD" },
    });
    expect(res).toMatchObject({ ledgerWritten: false, review: REPLY_REVIEW.held });
    const reply = (await t.run((ctx) => ctx.db.get(res.replyId!)))!;
    expect(reply).toMatchObject({ senderMismatch: true, heldForConfirmation: true, promisedCents: 41_220 });
    expect(await ledger(t, claimId)).toEqual([]);
    expect((await claimRow(t, claimId))?.status).toBe("sent");

    await expect(other.as.mutation(api.replies.confirmHeldPromise, { replyId: reply._id })).rejects.toThrow(/Reply not found/);
    expect(await owner.as.mutation(api.replies.confirmHeldPromise, { replyId: reply._id })).toEqual({ ledgerWritten: true });
    expect((await ledger(t, claimId)).map((e) => [e.kind, e.cents])).toEqual([["promised_credit", 41_220]]);
    expect((await claimRow(t, claimId))?.status).toBe("promised");
    await expect(owner.as.mutation(api.replies.confirmHeldPromise, { replyId: reply._id })).rejects.toThrow(/not waiting for your confirmation/);
    expect(await ledger(t, claimId)).toHaveLength(1);
  });

  it("the same promise from the party we wrote to is recorded at once (unchanged D21)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    const res = await t.mutation(internal.replies.apply, {
      claimId, messageId: "m-real", from: "refunds@example-air.example", classification: "promise", summary: "Refund of 412.20.",
      promised: { value: "412.20", currency: "USD" },
    });
    expect(res).toMatchObject({ ledgerWritten: true, review: null });
  });
});

describe("the scenario-aware reply prompt (classify)", () => {
  it("names the request, the company and the amount in the claim's currency; a review leaves the event in needs_review", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const { claimId } = await scenarioClaim(t, userId);
    const eventId = await t.run((ctx) =>
      ctx.db.insert("processedEvents", { externalId: "evt-r", kind: "agentmail.message.received", status: "processing", attempts: 1, userId, route: "reply", claimId }),
    );
    vi.mocked(extract).mockResolvedValue({ classification: "promise", summary: "We will refund 40 euros.", promised: { value: "40", currency: "EUR" } } as never);
    await t.action(internal.replies.classify, {
      processedEventId: eventId, claimId, messageId: "m-c", from: "refunds@example-air.example", subject: "Re: refund [RC-AIR123]", text: "We will refund 40 euros.",
    });
    const [call] = vi.mocked(extract).mock.calls;
    expect(call[3]).toContain("Request: a R02 request (fare refund)");
    expect(call[3]).toContain("Company written to: Example Air");
    expect(call[3]).toContain("Amount the customer asked for: USD 412.20");
    expect(call[3]).not.toMatch(/\d USD\b/); // never the wave-1 "412.20 USD" with an assumed currency
    const ev = await t.run((ctx) => ctx.db.get(eventId));
    expect(ev).toMatchObject({ status: "needs_review", summary: REPLY_REVIEW.currency("EUR", "USD") });
    expect(await ledger(t, claimId)).toEqual([]);
  });
});

describe("drafts on an item-less (scenario) claim (HC-1)", () => {
  async function withInbox(t: T, userId: Id<"users">) {
    await t.run((ctx) => ctx.db.insert("profiles", { userId, inboxId: "inbox_1", inboxEmail: "me@agentmail.to" }));
  }

  it("generate writes from the transaction, the claim's own amount and currency, and only CONFIRMED bound facts (SEC-AI-4)", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t, "Ann");
    await withInbox(t, userId);
    const { claimId } = await scenarioClaim(t, userId, { status: "detected", deadlines: [] });
    vi.mocked(extract).mockResolvedValue({ subject: "Refund request", body: "Hello, please refund USD 412.20. Ann" } as never);
    const draftId = await as.action(api.drafts.generate, { claimId });
    const [call] = vi.mocked(extract).mock.calls;
    const facts = call[3] as string;
    expect(call[2]).toMatch(/one request for money back/);
    expect(facts).toContain("Company: Example Air");
    expect(facts).toContain("Request: fare refund");
    expect(facts).toContain("Amount being asked for: USD 412.20");
    expect(facts).toContain("- ticket number: 0161234567890");
    expect(facts).toContain("- total paid: USD 412.20");
    expect(facts).not.toContain("Not confirmed Air"); // a candidate is never stated
    const draft = (await t.run((ctx) => ctx.db.get(draftId)))!;
    expect(draft).toMatchObject({ purpose: "formal", subject: "Refund request [RC-AIR123]" });
    expect((await claimRow(t, claimId))?.status).toBe("drafted");
  });

  it("DA-A-9: an email on a claim whose required channel is postal mail is informal and never moves the claim's status", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await scenarioClaim(t, userId, { status: "detected", requiredChannel: "postal_mail", deadlines: [] });
    vi.mocked(extract).mockResolvedValue({ subject: "Question", body: "Hello" } as never);
    const draftId = await as.action(api.drafts.generate, { claimId });
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.purpose).toBe("informal");
    expect((await claimRow(t, claimId))?.status).toBe("detected");
  });

  it("prepareSend on a scenario claim answers with a policy result, never the item-less refusal", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    await withInbox(t, userId);
    const { claimId } = await scenarioClaim(t, userId, { status: "drafted" });
    const draftId = await t.run((ctx) =>
      ctx.db.insert("drafts", { claimId, userId, version: 1, claimVersion: 1, to: "help@example-air.example", subject: "Refund [RC-AIR123]", body: "Hello" }),
    );
    const res = await as.mutation(api.drafts.prepareSend, { draftId, to: "help@example-air.example", subject: "Refund", body: "Hello" }).catch((e: Error) => e.message);
    expect(res).not.toBe(ITEMLESS_CLAIM_MESSAGE);
    expect(typeof res === "object" && res !== null && "ok" in res).toBe(true);
  });
});

describe("follow-ups on a scenario claim: responseExpectation", () => {
  it("the reminder lands when the counterparty was due to answer, never sooner than the 7-day floor, and falls back to the floor", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const later = await scenarioClaim(t, userId, {
      deadlines: [{ id: "refund_due", label: "Refund due", obligor: "counterparty", status: "open", dueAt: T0 + 20 * DAY, mustBe: "paid", basis: "b" }],
    });
    const sooner = await scenarioClaim(t, userId, {
      deadlines: [{ id: "refund_due", label: "Refund due", obligor: "counterparty", status: "open", dueAt: T0 + 2 * DAY, mustBe: "paid", basis: "b" }],
    });
    const none = await scenarioClaim(t, userId);
    const at = async (id: Id<"claims">) => await t.run(async (ctx) => reminderFireAt(ctx, (await ctx.db.get(id))!, T0));
    expect(await at(later.claimId)).toBe(T0 + 20 * DAY);
    expect(await at(sooner.claimId)).toBe(T0 + MIN_REMINDER_DAYS * DAY);
    expect(await at(none.claimId)).toBe(T0 + MIN_REMINDER_DAYS * DAY);
  });
});
