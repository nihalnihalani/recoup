/**
 * P07-W2 (re-audit, D244d): the raw content of a `needs_review` inbound email — the normal end state of every
 * extracted order email — follows the published window, and the Privacy statement says exactly that. Security
 * reviews the disclosure (D244d). Every named test fails on 20a7c03 (before this change).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { PRIVACY_STATEMENTS } from "./lib/privacyFacts";
import { BUDGET_PAUSED_SUMMARY, PAYLOAD_CLEARED_MESSAGE } from "./intake";
import { RETENTION_PAYLOAD_DAYS } from "./limits";

const DAY = 86_400_000;
type T = ReturnType<typeof setup>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 1, 12));
});
afterEach(() => vi.useRealTimers());

async function fullRetentionCycle(t: T) {
  for (let i = 0; i < 40; i++) if ((await t.mutation(internal.retention.sweep, {})).done) return;
  throw new Error("retention did not finish a cycle");
}

async function orderEmail(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db.insert("processedEvents", {
      externalId: `m-${Math.random()}`, kind: "agentmail.message.received", status: "needs_review", attempts: 1, userId, route: "intake",
      summary: "Order from Acme", payload: { subject: "Your Acme order", text: "Order #123 — Jacket $120.00", from: "orders@acme.example", messageId: "m-1" },
    }),
  );
}

describe("P07-W2: needs_review email content is cleared on the published window", () => {
  it("the repro inverted: an extracted order email left in needs_review, +31 days, one retention cycle → no text, subject or sender", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await orderEmail(t, userId);
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS - 1) * DAY);
    await fullRetentionCycle(t);
    expect((await t.run((ctx) => ctx.db.get(id)))!.payload).toMatchObject({ text: expect.any(String) }); // inside the window: kept
    vi.advanceTimersByTime(2 * DAY);
    await fullRetentionCycle(t);
    const row = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(row.payload).toEqual({ messageId: "m-1" });
    expect(row.summary).toBe("Order from Acme"); // the row and its summary stay
  });

  it("retryEvent refuses a row whose content was cleared, before any charge", async () => {
    const t = setup();
    const { userId, as } = await signedIn(t);
    const id = await orderEmail(t, userId);
    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS + 1) * DAY);
    await fullRetentionCycle(t);
    await expect(as.mutation(api.intake.retryEvent, { processedEventId: id })).rejects.toThrow(PAYLOAD_CLEARED_MESSAGE);
    expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))!.status).toBe("needs_review");
  });

  it("the Privacy statement names the window and says it covers emails still waiting for review", () => {
    expect(PRIVACY_STATEMENTS.inboundPayload).toContain(`${RETENTION_PAYLOAD_DAYS} days`);
    expect(PRIVACY_STATEMENTS.inboundPayload).toMatch(/including an email still waiting for your review/);
    expect(PRIVACY_STATEMENTS.inboundPayload).toMatch(/refund/);
  });
});

// F1 (D266 audit): a `needs_review` row paused by a daily/global `inbound_extract` budget refusal
// (`BUDGET_PAUSED_SUMMARY`) can sit long enough to cross the retention window above. Before this fix, its summary
// stayed `BUDGET_PAUSED_SUMMARY` forever, so `intake.retryFailed`'s budget-paused pass kept matching the row and
// rescheduled `processEvent` on the now-empty `payload.text` -- a real, charged OpenAI call over nothing, and a
// summary that no longer reflects the row's actual (content-cleared) state.
describe("F1: an inbound_extract pause outlasting the retention window is never re-run on empty text", () => {
  it("retention retitles the summary in the same patch as the clear; retryFailed makes 0 extract/classify calls, writes no usage rows, and leaves the cleared summary", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const id = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: `m-${Math.random()}`, kind: "agentmail.message.received", status: "needs_review", attempts: 1, userId, route: "intake",
        summary: BUDGET_PAUSED_SUMMARY,
        payload: { subject: "Your Acme order", text: "Order #123 — Jacket $120.00", from: "orders@acme.example", messageId: "m-budget" },
      }),
    );

    vi.advanceTimersByTime((RETENTION_PAYLOAD_DAYS + 1) * DAY);
    await fullRetentionCycle(t);
    const cleared = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(cleared.payload).toEqual({ messageId: "m-budget" });
    // The primary fix: retitled away from BUDGET_PAUSED_SUMMARY in the same patch as the clear.
    expect(cleared.summary).toBe(PAYLOAD_CLEARED_MESSAGE);

    expect(await t.action(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    const after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(after.status).toBe("needs_review"); // never "received" -- processEvent was never scheduled
    expect(after.summary).toBe(PAYLOAD_CLEARED_MESSAGE);
    expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
  });

  it("defence in depth: even a row that still reads BUDGET_PAUSED_SUMMARY is skipped once its payload has no text", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    // Simulates state cleared under the pre-fix retention (payload cleared, summary never retitled).
    const id = await t.run((ctx) =>
      ctx.db.insert("processedEvents", {
        externalId: `m-${Math.random()}`, kind: "agentmail.message.received", status: "needs_review", attempts: 1, userId, route: "intake",
        summary: BUDGET_PAUSED_SUMMARY, payload: { messageId: "m-stale" },
      }),
    );
    expect(await t.action(internal.intake.retryFailed, {})).toEqual({ unstuck: 0, retried: 0 });
    const after = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(after.status).toBe("needs_review");
    expect(after.summary).toBe(PAYLOAD_CLEARED_MESSAGE);
    expect(await t.run((ctx) => ctx.db.query("usage").collect())).toEqual([]);
  });
});
