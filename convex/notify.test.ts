import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { agentmail } from "./mail";
import { applyDropOutcome, claimDrop, DROP_SUBJECT, isAlertableDrop, queuedPatch } from "./notify";
import { BACKOFF_MS } from "./drafts";
import { GLOBAL_DAILY_BUDGETS, MAX_DROP_EMAILS_PER_DAY } from "./limits";

/**
 * Drop emails (W2), rewritten for T06/D68/D85: `sendDrop` is one
 * `internalMutation` (no action, no `dropContext`/`markQueued`/`finishDrop`),
 * gated by `lib/accountState.alertGate` at both claim time and send time, and
 * every refusal is stored as `suppressed` with a `reason` rather than
 * `failed` with a free-text error. No network: the AgentMail component
 * cannot dispatch under convex-test (see the note in drafts.test.ts), so the
 * two seams, the shared `agentmail.sendMessage` and `agentmail.status`
 * handles, are replaced with spies. `status` defaults to a definitive "sent"
 * outcome on the first `reconcileDrop` attempt, so a plain `flush(t)` still
 * carries a row all the way from `claimed` through `queued` to `sent` (F3);
 * tests of the queued/unknown state or of a slower/failed reconcile override
 * it per-call.
 */
const T0 = Date.UTC(2026, 8, 20, 12);
const URL = "https://www.acme.example/p/down-jacket";

let send: ReturnType<typeof vi.spyOn>;
let status: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  send = vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-1" as never);
  status = vi.spyOn(agentmail, "status").mockResolvedValue({
    status: "sent",
    agentmailMessageId: "msg-1",
    threadId: null,
    errorMessage: null,
  } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.SITE_URL;
  delete process.env.CONVEX_SITE_URL;
});

type T = ReturnType<typeof setup>;

/** A signed-in account with a verified email (the default `alertGate` needs to pass) and, by default, an AgentMail profile inbox. */
async function account(
  t: T,
  o: { email?: string | null; verified?: boolean; inbox?: boolean; name?: string } = {},
) {
  const user = await signedIn(t, o.name ?? "Tester");
  await t.run(async (ctx) => {
    if (o.email !== null) {
      await ctx.db.patch(user.userId, {
        email: o.email ?? "sam@home.example",
        emailVerificationTime: o.verified === false ? undefined : T0,
      });
    }
    if (o.inbox !== false) {
      await ctx.db.insert("profiles", {
        userId: user.userId,
        inboxId: `inbox-${user.userId}`,
        inboxEmail: "recoup-abc@agentmail.to",
      });
    }
  });
  return user;
}

async function seedWatch(
  t: T,
  userId: Id<"users">,
  o: { targetCents?: number; status?: "active" | "paused" | "bought"; productUrl?: string } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("watches", {
      userId,
      name: "Down Jacket",
      productUrl: o.productUrl ?? URL,
      merchantDomain: "acme.example",
      targetCents: o.targetCents,
      status: o.status ?? "active",
      nextCheckAt: T0,
    }),
  );
}

async function observe(t: T, watchId: Id<"watches">, cents: number) {
  return await t.mutation(internal.watches.recordWatchCheck, {
    watchId,
    sourceUrl: URL,
    observedCents: cents,
    currency: "USD",
    confidence: 0.92,
    isRange: false,
    variantMatch: "exact",
  });
}

async function mailRows(t: T) {
  return await t.run((ctx) => ctx.db.query("mailLog").collect());
}

async function alertSettingsRow(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("alertSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function flush(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

describe("isAlertableDrop", () => {
  it("needs the larger of $1.00 and 2% when there is no target", () => {
    const at = (previousCents: number | undefined, cents: number) =>
      isAlertableDrop({ previousCents, cents, targetCents: undefined });
    expect(at(undefined, 5_000)).toBe(false);
    expect(at(5_000, 4_900)).toBe(true); // exactly $1.00 and exactly 2%
    expect(at(5_000, 4_901)).toBe(false);
    expect(at(2_000, 1_900)).toBe(true); // $1.00 floor on a cheap item
    expect(at(2_000, 1_950)).toBe(false);
    expect(at(100_000, 98_500)).toBe(false); // $15 is under 2% of $1000
    expect(at(100_000, 98_000)).toBe(true);
    expect(at(5_000, 5_000)).toBe(false);
    expect(at(5_000, 6_000)).toBe(false);
  });

  it("with a target, fires at or under it and stays quiet on a rise that is still under it", () => {
    const at = (previousCents: number | undefined, cents: number) =>
      isAlertableDrop({ previousCents, cents, targetCents: 4_000 });
    expect(at(undefined, 4_000)).toBe(true);
    expect(at(undefined, 4_001)).toBe(false);
    expect(at(5_000, 3_990)).toBe(true);
    expect(at(3_990, 3_950)).toBe(true);
    expect(at(3_900, 3_950)).toBe(false);
    // A big fall that does not reach the target is not what the user asked for.
    expect(at(9_000, 4_500)).toBe(false);
  });
});

describe("claiming a drop inside recordWatchCheck", () => {
  it("fires on a target hit, even on the first observation, and mails it", async () => {
    process.env.SITE_URL = "https://recoup.example";
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site"; // F7: List-Unsubscribe now comes from this, not SITE_URL
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 8_000 });

    await observe(t, watchId, 7_999);

    const [row] = await mailRows(t);
    expect(row).toMatchObject({
      userId,
      watchId,
      kind: "price_drop",
      dedupeKey: `watch:${watchId}:7999`,
      status: "claimed",
      cents: 7_999,
      to: "sam@home.example",
      subject: "Recoup price alert: an item you are watching dropped",
    });
    expect(row.previousCents).toBeUndefined();
    expect(row.claimedAt).toBe(T0);
    expect(send).not.toHaveBeenCalled();

    await flush(t);

    expect(send).toHaveBeenCalledTimes(1);
    const [, inboxId, message] = send.mock.calls[0] as [
      unknown,
      string,
      { to: string; subject: string; text: string; html?: string; headers?: Record<string, string> },
    ];
    expect(inboxId).toBe(`inbox-${userId}`);
    expect(message.to).toBe("sam@home.example");
    expect(message.subject).toBe("Recoup price alert: an item you are watching dropped");
    expect(message.subject).toBe(DROP_SUBJECT);
    expect(message.html).toBeUndefined();
    for (const part of [
      "Now: $79.99",
      "Your target: $80.00",
      "Store: acme.example",
      `Checked: ${new Date(row._creationTime).toUTCString()}`,
      "https://recoup.example/watching",
      "Recoup uses no affiliate links.",
    ]) {
      expect(message.text).toContain(part);
    }
    // F1: the productUrl is never embedded -- Recoup's own mail must not
    // carry an arbitrary, user-supplied link.
    expect(message.text).not.toContain(URL);
    expect(message.text).not.toContain("Link:");
    // T06: one-click unsubscribe headers (RFC 8058), not a body footer line
    // (the body-content assertions above stay exactly as before).
    expect(message.headers?.["List-Unsubscribe"]).toMatch(/^<.*\/alerts\/unsubscribe\?token=.+>$/);
    expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    const [sent] = await mailRows(t);
    expect(sent.status).toBe("sent");
    expect(sent.outboundId).toBe("outbound-1");
    expect(sent.sentAt).toBe(Date.now());
    expect(sent.error).toBeUndefined();
    expect(sent.reason).toBeUndefined();
  });

  it("fires on a qualifying drop without a target and states both prices", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId);

    await observe(t, watchId, 10_000);
    expect(await mailRows(t)).toHaveLength(0); // first observation, no target
    await observe(t, watchId, 9_000);

    const rows = await mailRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cents: 9_000, previousCents: 10_000, status: "claimed" });
    await flush(t);
    const message = send.mock.calls[0][2] as { text: string };
    expect(message.text).toContain("Now: $90.00");
    expect(message.text).toContain("Before: $100.00");
    expect(message.text).not.toContain("Your target");
  });

  it("does not fire on a rise, under the threshold, above the target, or for a rejected observation", async () => {
    const t = setup();
    const { userId } = await account(t);
    const plain = await seedWatch(t, userId);
    await observe(t, plain, 10_000);
    await observe(t, plain, 12_000); // rise
    await observe(t, plain, 11_900); // $1 off $120 is under 2%
    await observe(t, plain, 11_850); // under $1.00
    await t.mutation(internal.watches.recordWatchCheck, {
      watchId: plain,
      sourceUrl: URL,
      observedCents: 1_000,
      currency: "USD",
      confidence: 0.2, // rejected: never becomes a price, so never an alert
      variantMatch: "exact",
    });

    const targeted = await seedWatch(t, userId, { targetCents: 5_000, productUrl: `${URL}-2` });
    await observe(t, targeted, 9_000);
    await observe(t, targeted, 6_000);

    expect(await mailRows(t)).toHaveLength(0);
    await flush(t);
    expect(send).not.toHaveBeenCalled();
  });

  it("never alerts for a watch that is not active", async () => {
    const t = setup();
    const { userId } = await account(t);
    for (const status of ["paused", "bought"] as const) {
      const watchId = await seedWatch(t, userId, { status, targetCents: 5_000, productUrl: `${URL}-${status}` });
      await observe(t, watchId, 4_000);
    }
    expect(await mailRows(t)).toHaveLength(0);
  });

  it("the same price twice yields exactly one mailLog row and one email", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId);
    await observe(t, watchId, 10_000);
    await observe(t, watchId, 8_000);
    await flush(t);
    await observe(t, watchId, 10_000);
    await observe(t, watchId, 8_000); // the same drop, a week later
    await flush(t);

    expect(await mailRows(t)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("running sendDrop again on an already-resolved row (concurrent duplicate) is a no-op", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);
    const [row] = await mailRows(t);
    expect(row.status).toBe("sent");

    await t.mutation(internal.notify.sendDrop, { mailLogId: row._id });

    expect(send).toHaveBeenCalledTimes(1);
    expect((await mailRows(t))[0].status).toBe("sent");
  });

  it("concurrent duplicate sendDrop while still claimed: the second call sees status != claimed and no-ops", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    const [claimedRow] = await mailRows(t);
    expect(claimedRow.status).toBe("claimed");

    // Both "copies" race for the same row; Convex serialises mutations, so
    // the second one always observes the first's committed transition.
    await Promise.all([
      t.mutation(internal.notify.sendDrop, { mailLogId: claimedRow._id }),
      t.mutation(internal.notify.sendDrop, { mailLogId: claimedRow._id }),
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect((await mailRows(t))[0].status).toBe("queued");
  });
});

describe("a drop that cannot be mailed is still recorded as suppressed with a reason", () => {
  it("unverified user: suppressed/unverified, no enqueue, no send", async () => {
    const t = setup();
    const { userId } = await account(t, { verified: false });
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe("unverified");
    expect(row.sentAt).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it("no account email: suppressed/no_email, no send", async () => {
    const t = setup();
    const { userId } = await account(t, { email: null });
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe("no_email");
    expect(row.error).toMatch(/email address/);
    expect(send).not.toHaveBeenCalled();
  });

  it("no Recoup inbox but a shared alerts inbox: the alert goes out from the shared inbox", async () => {
    process.env.ALERTS_INBOX_ID = "alerts@agentmail.test";
    try {
      const t = setup();
      const { userId } = await account(t, { inbox: false });
      const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
      await observe(t, watchId, 4_000);
      await flush(t);

      const [row] = await mailRows(t);
      expect(row.status).toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toBe("alerts@agentmail.test");
    } finally {
      delete process.env.ALERTS_INBOX_ID;
    }
  });

  it("no inbox of any kind: claimed then suppressed/not_configured at send time", async () => {
    const t = setup();
    const { userId } = await account(t, { inbox: false });
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe("not_configured");
    expect(send).not.toHaveBeenCalled();
  });

  it("F12b: a send error ends the row as failed/send_failed, with the component's raw message sanitized before it reaches mailLog.error", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    const raw = "AgentMail request to https://api.agentmail.to/v1/send failed: 500 (key sk_live_abc123)";
    send.mockRejectedValueOnce(new Error(raw));
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
    expect(row.reason).toBe("send_failed");
    // Sanitized to a generic category (lib/errors.sanitizeError): the raw
    // component/provider text -- including anything that looks like a
    // credential or an internal host -- never reaches `mailLog.error`.
    expect(row.error).toBe("Provider error");
    expect(row.error).not.toContain("sk_live_abc123");
    expect(row.error).not.toContain("api.agentmail.to");
  });

  it("a watch bought before the send went out is suppressed/watch_inactive at send time", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await t.run((ctx) => ctx.db.patch(watchId, { status: "bought" }));
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe("watch_inactive");
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the alert carries nothing its sender chose (pre-launch review B2)", () => {
  it("contains neither the watch name nor the product URL, and its only link is back to Recoup", async () => {
    process.env.SITE_URL = "https://recoup.example";
    const t = setup();
    const { userId } = await account(t, { email: "victim@corp.example" });
    const bait = "https://evil-shop.example/p/login-here?x=1";
    const watchId = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId,
        name: "URGENT: your account is locked, sign in at evil-shop.example/login",
        productUrl: bait,
        merchantDomain: "evil-shop.example",
        targetCents: 99_999_999,
        status: "active",
        nextCheckAt: T0,
      }),
    );
    await observe(t, watchId, 1_000);
    await flush(t);

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][2] as { subject: string; text: string; html?: string };
    expect(message.subject).toBe("Recoup price alert: an item you are watching dropped");
    expect(message.html).toBeUndefined();
    expect(message.text).not.toContain("URGENT");
    expect(message.text).not.toContain("account is locked");
    expect(message.text).not.toContain(bait);
    expect(message.text).not.toContain("/p/login-here");
    expect(message.text).not.toContain("/login");
    const links = message.text.match(/https?:\/\/\S+/g) ?? [];
    expect(links).toEqual(["https://recoup.example/watching"]);
    // The stored row, which the in-app list reads, has the same fixed subject.
    expect((await mailRows(t))[0].subject).toBe(DROP_SUBJECT);
  });

  it("a row claimed before the fix, with the old name-bearing subject, is still sent with the fixed one", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 8_000 });
    await observe(t, watchId, 7_000);
    const [row] = await mailRows(t);
    await t.run((ctx) => ctx.db.patch(row._id, { subject: "Price drop: <phish> is now $70.00" }));
    await flush(t);
    expect((send.mock.calls[0][2] as { subject: string }).subject).toBe(DROP_SUBJECT);
  });

  it("control characters never reach a stored watch name", async () => {
    const t = setup();
    const { userId, as } = await account(t);
    const created = await as.mutation(api.watches.create, { productUrl: URL, name: "Down\r\nBcc: x@evil.example\0 Jacket" });
    const name = async (id: Id<"watches">) => (await t.run((ctx) => ctx.db.get(id)))?.name;
    expect(await name(created)).toBe("DownBcc: x@evil.example Jacket");

    await as.mutation(api.watches.rename, { watchId: created, name: " Parka\n[31m " });
    expect(await name(created)).toBe("Parka[31m");
    await expect(as.mutation(api.watches.rename, { watchId: created, name: "\r\n" })).rejects.toThrow();

    // The extractor's product name is page-controlled and fills a default name.
    const unnamed = await t.run((ctx) =>
      ctx.db.insert("watches", {
        userId, name: "acme.example: down jacket", productUrl: URL, merchantDomain: "acme.example", status: "active", nextCheckAt: T0,
      }),
    );
    await t.mutation(internal.watches.recordWatchCheck, {
      watchId: unnamed, sourceUrl: URL, observedCents: 5_000, currency: "USD", confidence: 0.9, isRange: false,
      variantMatch: "exact", productName: "Alpine\r\nSubject: hi\tJacket",
    });
    expect(await name(unnamed)).toBe("AlpineSubject: hiJacket");
  });
});

describe("daily cap", () => {
  it("is 5 a day per user", () => {
    expect(MAX_DROP_EMAILS_PER_DAY).toBe(5);
  });

  it("a spent global switch records the drop as suppressed/global_cap and mails nobody, until the next UTC day", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 100_000 });
    const max = GLOBAL_DAILY_BUDGETS.drop_email.max;
    expect(max).toBe(300);
    await t.run((ctx) => ctx.db.insert("usage", { day: "2026-09-20", kind: "drop_email", count: max - 1 }));
    const globalCount = async () =>
      (await t.run((ctx) => ctx.db.query("usage").collect())).find((r) => r.kind === "drop_email")?.count;

    await observe(t, watchId, 50_000); // takes the last global unit
    await observe(t, watchId, 49_000); // global switch is spent
    await flush(t);

    const rows = await mailRows(t);
    expect(rows.map((r) => r.status)).toEqual(["sent", "suppressed"]);
    expect(rows[1].reason).toBe("global_cap");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await globalCount()).toBe(max);

    // Next UTC day: the switch is whole again.
    vi.setSystemTime(T0 + 24 * 3_600_000);
    await observe(t, watchId, 48_000);
    expect((await mailRows(t))[2].status).toBe("claimed");
  });

  it(`mails at most ${MAX_DROP_EMAILS_PER_DAY} drops per 24h; the next is suppressed/daily_cap, and the window rolls`, async () => {
    const t = setup();
    const { userId, as } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 100_000 });

    // Each observation is a new, lower price under the target: a new alert.
    for (let i = 0; i <= MAX_DROP_EMAILS_PER_DAY; i++) {
      await observe(t, watchId, 50_000 - i * 100);
    }
    await flush(t);

    const rows = await mailRows(t);
    expect(rows).toHaveLength(MAX_DROP_EMAILS_PER_DAY + 1);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(MAX_DROP_EMAILS_PER_DAY);
    expect(send).toHaveBeenCalledTimes(MAX_DROP_EMAILS_PER_DAY);
    const over = rows[rows.length - 1];
    expect(over).toMatchObject({ status: "suppressed", reason: "daily_cap" });

    // The capped alert still shows in the app.
    const listed = await as.query(api.notify.drops, {});
    expect(listed[0]).toMatchObject({ _id: over._id, status: "suppressed", reason: "daily_cap" });

    vi.setSystemTime(T0 + 25 * 3_600_000);
    await observe(t, watchId, 40_000);
    await flush(t);
    expect(send).toHaveBeenCalledTimes(MAX_DROP_EMAILS_PER_DAY + 1);
  });

  it("is per user", async () => {
    const t = setup();
    const a = await account(t, { name: "A" });
    const b = await account(t, { name: "B", email: "b@home.example" });
    const watchA = await seedWatch(t, a.userId, { targetCents: 100_000 });
    for (let i = 0; i < MAX_DROP_EMAILS_PER_DAY; i++) await observe(t, watchA, 50_000 - i * 100);

    const watchB = await seedWatch(t, b.userId, { targetCents: 100_000 });
    await observe(t, watchB, 50_000);

    const rows = await mailRows(t);
    expect(rows.find((r) => r.userId === b.userId)?.status).toBe("claimed");
  });
});

describe("D70: re-claiming a transient dedupe row after DROP_RECLAIM_MIN_MS", () => {
  /**
   * Drives `claimDrop` directly (not through `watches.recordWatchCheck`),
   * with the SAME watch snapshot and cents on every call. This isolates the
   * dedupe/reclaim logic in `notify.ts` from `recordWatchCheck`'s own
   * side effect of updating `watch.lastCents` on every accepted observation
   * (which would otherwise make the second `isAlertableDrop` check see
   * "no change" and return false before the reclaim branch is ever reached).
   */
  async function claimTwice(t: T, watchId: Id<"watches">, cents: number) {
    const watch = (await t.run((ctx) => ctx.db.get(watchId)))!;
    return await t.run((ctx) => claimDrop(ctx, watch, cents, "USD"));
  }

  it("re-claims a send_failed row after 24h and never re-claims it sooner", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    send.mockRejectedValueOnce(new Error("boom"));
    await claimTwice(t, watchId, 4_000);
    await flush(t);
    const [failedRow] = await mailRows(t);
    expect(failedRow.status).toBe("failed");
    expect(failedRow.reason).toBe("send_failed");

    // Too soon: same dedupe key, not yet 24h since claimedAt -> no reclaim.
    vi.setSystemTime(T0 + 3_600_000);
    expect(await claimTwice(t, watchId, 4_000)).toBeNull();
    expect(await mailRows(t)).toHaveLength(1);
    expect((await mailRows(t))[0].status).toBe("failed");

    // After 24h: re-claimed in place, sent this time.
    vi.setSystemTime(T0 + 25 * 3_600_000);
    const reclaimedId = await claimTwice(t, watchId, 4_000);
    expect(reclaimedId).toBe(failedRow._id);
    await flush(t);
    const rows = await mailRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2); // one failed attempt, then the reclaimed retry
  });

  it("never re-claims a row suppressed for opted_out, deleted, or address_suppressed, however old", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await t.run((ctx) =>
      ctx.db.insert("alertSettings", {
        userId,
        alertsEnabled: false,
        unsubscribeToken: "tok-opted-out",
        updatedAt: T0,
      }),
    );
    await claimTwice(t, watchId, 4_000);
    const [row] = await mailRows(t);
    expect(row.status).toBe("suppressed");
    expect(row.reason).toBe("opted_out");

    vi.setSystemTime(T0 + 30 * 24 * 3_600_000); // 30 days later
    expect(await claimTwice(t, watchId, 4_000)).toBeNull();
    expect(await mailRows(t)).toHaveLength(1); // still the same row, never reclaimed
    expect(send).not.toHaveBeenCalled();
  });

  it("F6/D79: a spent global switch (the operator kill switch) also pauses the 24h re-claim, not just fresh claims", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    send.mockRejectedValueOnce(new Error("boom"));
    await claimTwice(t, watchId, 4_000);
    await flush(t);
    const [failedRow] = await mailRows(t);
    expect(failedRow.status).toBe("failed");
    expect(failedRow.reason).toBe("send_failed");

    // Past the 24h window, so the row is normally reclaimable...
    vi.setSystemTime(T0 + 25 * 3_600_000);
    // ...but an operator has pinned the deployment-wide switch to max for
    // the day (D79's kill switch: a global `usage` row at max).
    await t.run((ctx) =>
      ctx.db.insert("usage", { day: "2026-09-21", kind: "drop_email", count: GLOBAL_DAILY_BUDGETS.drop_email.max }),
    );

    const reclaimed = await claimTwice(t, watchId, 4_000);
    expect(reclaimed).toBe(failedRow._id);
    const row = await t.run((ctx) => ctx.db.get(failedRow._id));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("global_cap");
    expect(send).toHaveBeenCalledTimes(1); // only the original failed attempt; the reclaim never enqueued
  });
});

describe("F3: claimed -> queued -> sent (never straight to sent)", () => {
  it("sits at queued, with the component's outboundId, until reconcileDrop confirms delivery", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });

    await observe(t, watchId, 4_000);
    // Run only the immediate `sendDrop` the claim scheduled, not the
    // `reconcileDrop` it goes on to schedule itself.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    const [queued] = await mailRows(t);
    expect(queued.status).toBe("queued");
    expect(queued.outboundId).toBe("outbound-1");
    expect(send).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();

    await flush(t);
    const [resolved] = await mailRows(t);
    expect(resolved.status).toBe("sent");
    expect(status).toHaveBeenCalledWith(expect.anything(), "outbound-1");
  });
});

describe("crash-window: a row left claimed with no outbound is picked up by the sweep", () => {
  it("sweepStalled reschedules sendDrop for a stuck claimed row, exactly one enqueue after", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    // Simulate a crash: the scheduled sendDrop never ran. Cancel it and put
    // the row's nextCheckAt in the past, as if the crash happened a while ago.
    const [row] = await mailRows(t);
    expect(row.status).toBe("claimed");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const fn of scheduled) await t.run((ctx) => ctx.scheduler.cancel(fn._id));
    await t.run((ctx) => ctx.db.patch(row._id, { nextCheckAt: T0 - 1 }));

    const swept = await t.mutation(internal.notify.sweepStalled, {});
    expect(swept).toBe(1);
    await flush(t);

    expect(send).toHaveBeenCalledTimes(1);
    expect((await mailRows(t))[0].status).toBe("sent");
  });

  it("a queued/unknown row past nextCheckAt is also swept via reconcileDrop", async () => {
    status.mockResolvedValue({ status: "pending", agentmailMessageId: null, threadId: null, errorMessage: null } as never);
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions(); // now queued, its own reconcile pending
    const [queued] = await mailRows(t);
    expect(queued.status).toBe("queued");
    // Cancel the row's own reconcile and simulate it going stale.
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const fn of scheduled) await t.run((ctx) => ctx.scheduler.cancel(fn._id));
    await t.run((ctx) => ctx.db.patch(queued._id, { nextCheckAt: T0 - 1 }));

    const swept = await t.mutation(internal.notify.sweepStalled, {});
    expect(swept).toBe(1);
    await flush(t);
    expect(status).toHaveBeenCalled();
  });
});

describe("notify.applyDropOutcome (F3)", () => {
  async function queuedMailLog(t: ReturnType<typeof setup>, userId: Id<"users">) {
    return await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId,
        dedupeKey: `watch:seed:${Math.random()}`,
        kind: "price_drop",
        to: "sam@home.example",
        subject: "Price drop: Thing is now $10.00",
        status: "queued",
        outboundId: "outbound-1" as never,
        cents: 1_000,
      }),
    );
  }

  it("moves a queued row to sent on a real message id", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, { status: "sent", agentmailMessageId: "msg-1", errorMessage: null }),
    );
    expect(outcome).toBe("sent");
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    expect(row?.sentAt).toBe(Date.now());
    expect(row?.agentmailMessageId).toBe("msg-1");
    expect(row?.providerStatus).toBe("sent");
  });

  it("treats a bounce that still carries a message id as a failure, never as sent, and suppresses the address (review H3's rule, ported); the raw provider message is sanitized before it reaches mailLog.error (F12b)", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) => ctx.db.patch(userId, { email: "sam@home.example", emailVerificationTime: T0 }));
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, {
        status: "bounced",
        agentmailMessageId: "msg-1",
        errorMessage: "AgentMail 500: mailbox unavailable at inbox_abc123@agentmail.to",
      }),
    );
    expect(outcome).toBe("failed");
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed");
    expect(row?.reason).toBe("send_failed");
    expect(row?.providerStatus).toBe("bounced");
    expect(row?.error).toBe("Provider error"); // sanitized: the raw component/provider text never reaches `drops`
    expect(row?.error).not.toContain("inbox_abc123");
    expect(row?.agentmailMessageId).toBe("msg-1");

    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("bounced");
  });

  it("a complaint keeps the row sent but records providerStatus and suppresses the address", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) => ctx.db.patch(userId, { email: "sam@home.example", emailVerificationTime: T0 }));
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, { status: "complained", agentmailMessageId: "msg-2", errorMessage: null }),
    );
    expect(outcome).toBe("sent");
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    expect(row?.providerStatus).toBe("complained");

    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("complained");
  });

  it("reschedules while pending and attempts remain, leaving the row queued", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, { status: "pending", agentmailMessageId: null, errorMessage: null }),
    );
    expect(outcome).toBe("retrying");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(1);
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("queued");
    expect(row?.attempt).toBe(2);
  });

  it("moves to unknown with a nextCheckAt once every backoff attempt is spent, and a later sweep reconciles again", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 5, { status: "pending", agentmailMessageId: null, errorMessage: null }),
    );
    expect(outcome).toBe("unknown");
    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("unknown");
    expect(row?.nextCheckAt).toBeGreaterThan(Date.now());

    // Later: the sweep picks the unknown row back up and this time delivery resolves.
    status.mockResolvedValueOnce({ status: "sent", agentmailMessageId: "msg-late", threadId: null, errorMessage: null } as never);
    vi.setSystemTime((row!.nextCheckAt ?? 0) + 1);
    const swept = await t.mutation(internal.notify.sweepStalled, {});
    expect(swept).toBe(1);
    await flush(t);
    const resolved = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(resolved?.status).toBe("sent");
  });

  it("is a no-op on a row that already resolved", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    const mailLogId = await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId,
        dedupeKey: "watch:seed:x",
        kind: "price_drop",
        to: "sam@home.example",
        subject: "s",
        status: "sent",
        cents: 1,
      }),
    );
    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, { status: "sent", agentmailMessageId: "msg-2", errorMessage: null }),
    );
    expect(outcome).toBe("gone");
  });

  it("F10: a tombstoned user's bounce still updates the mailLog row, but creates no alertSettings row", async () => {
    const t = setup();
    const { userId } = await signedIn(t);
    await t.run((ctx) =>
      ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }),
    );
    const mailLogId = await queuedMailLog(t, userId);

    const outcome = await t.run((ctx) =>
      applyDropOutcome(ctx, mailLogId, 1, {
        status: "bounced",
        agentmailMessageId: "msg-tomb",
        errorMessage: "bounced",
      }),
    );
    expect(outcome).toBe("failed");

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("failed"); // the row's own status is still recorded
    expect(row?.reason).toBe("send_failed");

    const settings = await t.run((ctx) =>
      ctx.db.query("alertSettings").withIndex("by_user", (q) => q.eq("userId", userId)).first(),
    );
    expect(settings).toBeNull(); // ...but no alertSettings row was created for the tombstoned user
  });
});

describe("notify.recheckDrop (D56 pattern, contract T06(g).6: reads inline, does not schedule)", () => {
  async function unknownRow(t: T, userId: Id<"users">) {
    return await t.run((ctx) =>
      ctx.db.insert("mailLog", {
        userId,
        dedupeKey: `watch:seed:${Math.random()}`,
        kind: "price_drop",
        to: "sam@home.example",
        subject: DROP_SUBJECT,
        status: "unknown",
        outboundId: "outbound-1" as never,
        cents: 1_000,
        attempt: 5,
      }),
    );
  }

  it("delayed provider success after unknown resolves the row to sent, immediately (no extra scheduling)", async () => {
    const t = setup();
    const { userId, as } = await account(t);
    const mailLogId = await unknownRow(t, userId);
    status.mockResolvedValueOnce({ status: "sent", agentmailMessageId: "msg-late", threadId: null, errorMessage: null } as never);

    await as.mutation(api.notify.recheckDrop, { mailLogId });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("sent");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  it("throws for another user's row and for a row that is not queued/unknown (e.g. already sent)", async () => {
    const t = setup();
    const owner = await account(t, { name: "Owner" });
    const other = await account(t, { name: "Other", email: "other@home.example" });
    const mailLogId = await unknownRow(t, owner.userId);

    await expect(other.as.mutation(api.notify.recheckDrop, { mailLogId })).rejects.toThrow(/not found/i);

    await t.run((ctx) => ctx.db.patch(mailLogId, { status: "sent" }));
    await expect(owner.as.mutation(api.notify.recheckDrop, { mailLogId })).rejects.toThrow(/cannot be rechecked/i);
  });
});

describe("notify.drops", () => {
  it("returns [] when signed out", async () => {
    const t = setup();
    expect(await t.query(api.notify.drops, {})).toEqual([]);
  });

  it("lists only the caller's drops, newest first, with nulls for absent fields", async () => {
    const t = setup();
    const owner = await account(t, { name: "Owner" });
    const other = await account(t, { name: "Other", email: "other@home.example" });
    const mine = await seedWatch(t, owner.userId, { targetCents: 9_000 });
    const theirs = await seedWatch(t, other.userId, { targetCents: 9_000 });

    await observe(t, mine, 8_000);
    vi.setSystemTime(T0 + 1_000);
    await observe(t, theirs, 7_000);
    vi.setSystemTime(T0 + 2_000);
    await observe(t, mine, 7_500);

    const listed = await owner.as.query(api.notify.drops, {});
    expect(listed.map((d) => d.cents)).toEqual([7_500, 8_000]);
    expect(listed[0]).toEqual({
      _id: listed[0]._id,
      _creationTime: listed[0]._creationTime,
      watchId: mine,
      watchName: "Down Jacket",
      cents: 7_500,
      previousCents: 8_000,
      status: "claimed",
      error: null,
      reason: null,
      providerStatus: null,
      canRecheck: false,
    });
    expect(listed[1].previousCents).toBeNull();

    const othersList = await other.as.query(api.notify.drops, {});
    expect(othersList).toHaveLength(1);
    expect(othersList[0].watchId).toBe(theirs);
  });

  it("caps the list at 30", async () => {
    const t = setup();
    const { userId, as } = await account(t);
    const watchId = await seedWatch(t, userId);
    await t.run(async (ctx) => {
      for (let i = 0; i < 35; i++) {
        await ctx.db.insert("mailLog", {
          userId,
          dedupeKey: `watch:${watchId}:${i}`,
          kind: "price_drop",
          watchId,
          to: "sam@home.example",
          subject: "s",
          status: "sent",
          cents: i,
        });
      }
    });
    const listed = await as.query(api.notify.drops, {});
    expect(listed).toHaveLength(30);
    expect(listed[0].cents).toBe(34);
  });

  it("canRecheck is true only for queued/unknown rows", async () => {
    const t = setup();
    const { userId, as } = await account(t);
    await t.run(async (ctx) => {
      for (const s of ["claimed", "queued", "sent", "failed", "unknown", "suppressed"] as const) {
        await ctx.db.insert("mailLog", {
          userId, dedupeKey: `watch:x:${s}`, kind: "price_drop", to: "sam@home.example", subject: "s", status: s, cents: 1,
        });
      }
    });
    const listed = await as.query(api.notify.drops, {});
    const byStatus = Object.fromEntries(listed.map((d) => [d.status, d.canRecheck]));
    expect(byStatus).toMatchObject({ claimed: false, queued: true, sent: false, failed: false, unknown: true, suppressed: false });
  });

  it("D115 6b-3 / T18.3: returns [] for a tombstoned caller with real drops, not the caller's real data", async () => {
    const t = setup();
    const { userId, as } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 9_000 });
    await observe(t, watchId, 8_000);
    // Prove there is real data first, so the post-tombstone assertion below is not vacuous.
    expect((await as.query(api.notify.drops, {})).length).toBeGreaterThan(0);

    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: T0, attempts: 0 }));

    expect(await as.query(api.notify.drops, {})).toEqual([]);
  });
});

describe("publicAppUrl (link in alert emails)", () => {
  const saved = { app: process.env.APP_URL, site: process.env.SITE_URL };
  afterEach(() => {
    process.env.APP_URL = saved.app;
    process.env.SITE_URL = saved.site;
    if (saved.app === undefined) delete process.env.APP_URL;
    if (saved.site === undefined) delete process.env.SITE_URL;
  });

  it("prefers APP_URL and trims a trailing slash", async () => {
    const { publicAppUrl } = await import("./notify");
    process.env.APP_URL = "https://recoup.example/";
    process.env.SITE_URL = "http://localhost:5173";
    expect(publicAppUrl()).toBe("https://recoup.example");
  });

  it("never returns a localhost or non-https address", async () => {
    const { publicAppUrl } = await import("./notify");
    delete process.env.APP_URL;
    process.env.SITE_URL = "http://localhost:5173";
    expect(publicAppUrl()).toBeNull();
    process.env.SITE_URL = "https://localhost:5173";
    expect(publicAppUrl()).toBeNull();
  });
});

describe("mailEvents.onEvent: late bounce/complaint on an already-sent drop alert", () => {
  function event(overrides: Record<string, unknown> = {}) {
    return {
      type: "event" as const,
      event_type: "message.bounced" as const,
      event_id: "evt-1",
      bounce: { message_id: "msg-late-1" },
      ...overrides,
    };
  }

  it("terminal bounce on a sent row -> failed + alertSettings.suppressedReason bounced", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);
    const [sent] = await mailRows(t);
    expect(sent.status).toBe("sent");
    await t.run((ctx) => ctx.db.patch(sent._id, { agentmailMessageId: "msg-late-1" }));

    await t.mutation(internal.mailEvents.onEvent, { event: event() });

    const row = await t.run((ctx) => ctx.db.get(sent._id));
    expect(row?.status).toBe("failed");
    expect(row?.providerStatus).toBe("bounced");
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("bounced");
  });

  it("complaint via onEvent -> stays sent, providerStatus complained, address suppressed", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);
    const [sent] = await mailRows(t);
    await t.run((ctx) => ctx.db.patch(sent._id, { agentmailMessageId: "msg-complained-1" }));

    await t.mutation(internal.mailEvents.onEvent, {
      event: event({ event_type: "message.complained", bounce: undefined, complaint: { message_id: "msg-complained-1" } }),
    });

    const row = await t.run((ctx) => ctx.db.get(sent._id));
    expect(row?.status).toBe("sent");
    expect(row?.providerStatus).toBe("complained");
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("complained");
  });

  it("an event whose message id matches nothing is a no-op", async () => {
    const t = setup();
    await expect(t.mutation(internal.mailEvents.onEvent, { event: event({ bounce: { message_id: "unknown-id" } }) })).resolves.toBeNull();
  });

  it("duplicate delivery of the same event is idempotent", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);
    const [sent] = await mailRows(t);
    await t.run((ctx) => ctx.db.patch(sent._id, { agentmailMessageId: "msg-dup-1" }));

    const e = event({ bounce: { message_id: "msg-dup-1" } });
    await t.mutation(internal.mailEvents.onEvent, { event: e });
    await t.mutation(internal.mailEvents.onEvent, { event: e }); // redelivered

    const settingsRows = await t.run((ctx) => ctx.db.query("alertSettings").collect());
    expect(settingsRows).toHaveLength(1); // suppressAddress patched once, not inserted twice
    const row = await t.run((ctx) => ctx.db.get(sent._id));
    expect(row?.status).toBe("failed");
  });

  it("message.received and domain.verified are ignored", async () => {
    const t = setup();
    await expect(
      t.mutation(internal.mailEvents.onEvent, {
        event: { type: "event", event_type: "message.received", event_id: "e1", message: { message_id: "m1" } },
      }),
    ).resolves.toBeNull();
    await expect(
      t.mutation(internal.mailEvents.onEvent, {
        event: { type: "event", event_type: "domain.verified", event_id: "e2", domain: { message_id: "m1" } },
      }),
    ).resolves.toBeNull();
  });
});

describe("F7: List-Unsubscribe headers built from CONVEX_SITE_URL", () => {
  const saved = process.env.CONVEX_SITE_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.CONVEX_SITE_URL;
    else process.env.CONVEX_SITE_URL = saved;
  });

  it("sends List-Unsubscribe/-Post headers built from CONVEX_SITE_URL, carrying the real unsubscribe token", async () => {
    process.env.CONVEX_SITE_URL = "https://recoup-test.convex.site";
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]![2] as { headers?: Record<string, string> };
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.unsubscribeToken).toBeTruthy();
    expect(args.headers).toEqual({
      "List-Unsubscribe": `<https://recoup-test.convex.site/alerts/unsubscribe?token=${settings!.unsubscribeToken}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("omits both headers when CONVEX_SITE_URL is unset", async () => {
    delete process.env.CONVEX_SITE_URL;
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    const args = send.mock.calls[0]![2] as { headers?: Record<string, string> };
    expect(args.headers).toBeUndefined();
  });

  it("omits both headers when CONVEX_SITE_URL is not https", async () => {
    process.env.CONVEX_SITE_URL = "http://recoup-test.convex.site";
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    const args = send.mock.calls[0]![2] as { headers?: Record<string, string> };
    expect(args.headers).toBeUndefined();
  });
});

describe("F8: an early complaint/bounce (arrives before the message id is known) is applied once reconcile learns it", () => {
  it("a complaint via onEvent while the row is still queued is applied when reconcileDrop later confirms delivery", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    // Only run the immediate `sendDrop`, not the `reconcileDrop` it schedules:
    // the row is `queued` with an outboundId but no `agentmailMessageId` yet.
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
    const [queued] = await mailRows(t);
    expect(queued.status).toBe("queued");
    expect(queued.agentmailMessageId).toBeUndefined();

    // The complaint webhook arrives before we have ever reconciled: `onEvent`
    // cannot find this row by `agentmailMessageId` (it is not set yet), so
    // without F8 the complaint would be lost for good.
    await t.mutation(internal.mailEvents.onEvent, {
      event: {
        type: "event",
        event_type: "message.complained",
        event_id: "evt-early-complaint",
        complaint: { message_id: "msg-1" }, // matches the default `status` mock's agentmailMessageId
      },
    });
    expect((await mailRows(t))[0].status).toBe("queued"); // onEvent could not map it yet; row untouched directly

    // The reconcile now learns the real message id.
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("sent"); // it WAS delivered; a complaint is a flag, not an undelivery
    expect(row.providerStatus).toBe("complained");
    expect(row.agentmailMessageId).toBe("msg-1");
    const settings = await alertSettingsRow(t, userId);
    expect(settings?.suppressedReason).toBe("complained");
  });
});

describe("F11b: sendDrop's try only wraps the sendMessage call", () => {
  it("queuedPatch (the exact post-enqueue patch) is a pure function of (to, outboundId, now)", () => {
    const now = 1_800_000_000_000;
    expect(queuedPatch("user@example.com", "outbound-99" as never, now)).toEqual({
      status: "queued",
      to: "user@example.com",
      outboundId: "outbound-99",
      attempt: 0,
      reason: undefined,
      error: undefined,
      nextCheckAt: now + BACKOFF_MS[0],
      lastCheckedAt: now,
    });
  });

  // Documents a limitation: convex-test gives no way to force
  // `ctx.scheduler.runAfter` to throw (`vi.spyOn` cannot intercept it), so
  // the exact regression -- "a failure applying the post-enqueue patch or
  // scheduling the reconcile must not record `failed` after a successful
  // enqueue" -- cannot be driven end-to-end here. What IS verified: a
  // genuinely successful send never ends up `failed` (the row above), and
  // `queuedPatch`'s shape (used unconditionally, outside sendDrop's
  // try/catch -- see its own source and comment) matches what a successful
  // enqueue actually writes.
  it("a successful send is never re-labeled failed: the row ends queued, not failed", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();

    const [row] = await mailRows(t);
    expect(row.status).toBe("queued");
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("P10-OW-12: RECOUP_PROVIDER_MODE=stub", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sendDrop's AgentMail-send call site throws a stub error, caught by its own existing catch as a genuine send_failed -- same as a real component/provider failure, never a fabricated send", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    const [claimedRow] = await mailRows(t);
    expect(claimedRow.status).toBe("claimed");

    vi.stubEnv("RECOUP_PROVIDER_MODE", "stub");
    // QA2-3: stub mode now refuses without a positive dev/E2E signal; supply the dev host.
    vi.stubEnv("CONVEX_SITE_URL", "https://adorable-lion-138.convex.site");
    await t.mutation(internal.notify.sendDrop, { mailLogId: claimedRow._id });

    expect(send).not.toHaveBeenCalled();
    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
    expect(row.reason).toBe("send_failed");
    // F12b: sanitizeError collapses the raw stub message to a fixed, user-safe category before it reaches
    // mailLog.error -- the same behavior a real component/provider failure already gets (never verbatim).
    expect(typeof row.error).toBe("string");
  });
});
