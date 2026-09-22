/// <reference types="vite/client" />
/**
 * M13 (security baseline S-M03-1, P02 "provider idempotency / no blind resend"): price-drop alerts go through the
 * same AgentMail component as claim mail, so they share the at-most-once rule. Driven through the real component
 * with `fetch` stubbed at the provider boundary.
 *
 * - one claimed alert → exactly one provider POST, even when the response is lost;
 * - an ambiguous outcome is `unknown`, never `failed`/`send_failed`, so the 24-hour re-claim (D70) — which only
 *   re-sends `failed`/`suppressed` rows — can never blindly send the same alert again;
 * - a provider 4xx response is a definite failure and stays re-claimable, as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { applyDropOutcome, claimDrop } from "./notify";

type T = ReturnType<typeof setup>;
const T0 = Date.UTC(2026, 8, 23, 12);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function alertable(t: T): Promise<{ userId: Id<"users">; watch: Doc<"watches"> }> {
  const { userId } = await signedIn(t, "Ann");
  return await t.run(async (ctx) => {
    await ctx.db.patch(userId, { email: "ann@home.example", emailVerificationTime: T0 });
    await ctx.db.insert("profiles", { userId, inboxId: "inbox-ann", inboxEmail: "ann@inbox.example" });
    const watchId = await ctx.db.insert("watches", {
      userId, name: "Widget", productUrl: "https://store.example/w", merchantDomain: "store.example", currency: "USD",
      targetCents: 5_000, status: "active", nextCheckAt: T0 + 3_600_000,
    });
    return { userId, watch: (await ctx.db.get(watchId))! };
  });
}

function stubProvider(onSend: (n: number) => Response) {
  let posts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (String(url).includes("/messages/send")) {
        posts++;
        return onSend(posts);
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return () => posts;
}

async function drive(t: T, steps: number, stepMs: number) {
  for (let i = 0; i < steps; i++) {
    vi.advanceTimersByTime(stepMs);
    await t.finishInProgressScheduledFunctions();
  }
}

describe("S-M03-1 for price-drop alerts", () => {
  it("a lost provider response: exactly one POST, the row ends unknown (not failed), and the 24h re-claim never resends it", async () => {
    const t = setup();
    const { watch } = await alertable(t);
    const posts = stubProvider(() => {
      throw new TypeError("fetch failed: socket hang up");
    });

    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    await drive(t, 60, 5_000);

    expect(posts()).toBe(1); // before: 5 POSTs (default retryAttempts)
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("unknown"); // before: "failed" with reason send_failed
    expect(row?.reason).not.toBe("send_failed");

    vi.setSystemTime(T0 + 25 * 3_600_000);
    expect(await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"))).toBeNull(); // before: re-claimed and re-sent
    await drive(t, 20, 5_000);
    expect(posts()).toBe(1);
  });

  it("a provider 4xx is a definite failure: failed/send_failed, sanitized, still re-claimable after 24h", async () => {
    const t = setup();
    const { watch } = await alertable(t);
    const posts = stubProvider((n) =>
      n === 1
        ? new Response('{"error":"bad","echo":"Bearer am-test"}', { status: 422 })
        : new Response(JSON.stringify({ message_id: "m2", thread_id: "th2" }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    await drive(t, 20, 5_000);
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("send_failed");
    expect(row?.error ?? "").not.toContain("Bearer");

    vi.setSystemTime(T0 + 25 * 3_600_000);
    expect(await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"))).toBe(mailLogId);
    await drive(t, 20, 5_000);
    expect(posts()).toBe(2);
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("sent");
  });

  it("applyDropOutcome: component `failed` is terminal only for a provider 4xx", async () => {
    const t = setup();
    const { userId } = await alertable(t);
    const row = async (key: string) =>
      await t.run((ctx) =>
        ctx.db.insert("mailLog", {
          userId, dedupeKey: key, kind: "price_drop", to: "ann@home.example", subject: "s", status: "queued",
          outboundId: `ob-${key}` as never, attempt: 1, nextCheckAt: T0, lastCheckedAt: T0,
        }),
      );
    const ambiguous = await row("a");
    expect(
      await t.run((ctx) => applyDropOutcome(ctx, ambiguous, 1, { status: "failed", agentmailMessageId: null, errorMessage: "fetch failed: timeout" })),
    ).toBe("unknown");
    const ambiguousRow = await t.run((ctx) => ctx.db.get(ambiguous));
    expect(ambiguousRow?.status).toBe("unknown");
    expect(ambiguousRow?.providerStatus).toBe("failed");

    const permanent = await row("p");
    expect(
      await t.run((ctx) =>
        applyDropOutcome(ctx, permanent, 1, { status: "failed", agentmailMessageId: null, errorMessage: "AgentMail API error 422: nope" }),
      ),
    ).toBe("failed");
    expect((await t.run((ctx) => ctx.db.get(permanent)))?.error).not.toContain("nope");
  });
});
