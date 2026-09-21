import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { agentmail } from "./mail";
import { DAILY_LIMIT_ERROR, DROP_SUBJECT, GLOBAL_LIMIT_ERROR, isAlertableDrop } from "./notify";
import { GLOBAL_DAILY_BUDGETS, MAX_DROP_EMAILS_PER_DAY } from "./limits";

/**
 * Drop emails (W2). No network: the AgentMail component cannot dispatch under
 * convex-test (see the note in drafts.test.ts), so the one seam, the shared
 * `agentmail.sendMessage` handle, is replaced with a spy. Fake timers keep the
 * scheduled `sendDrop` from firing until a test flushes it.
 */
const T0 = Date.UTC(2026, 8, 20, 12);
const URL = "https://www.acme.example/p/down-jacket";

let send: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  send = vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-1" as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.SITE_URL;
});

type T = ReturnType<typeof setup>;

async function account(t: T, o: { email?: string | null; inbox?: boolean; name?: string } = {}) {
  const user = await signedIn(t, o.name ?? "Tester");
  await t.run(async (ctx) => {
    if (o.email !== null) await ctx.db.patch(user.userId, { email: o.email ?? "sam@home.example" });
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
    expect(send).not.toHaveBeenCalled();

    await flush(t);

    expect(send).toHaveBeenCalledTimes(1);
    const [, inboxId, message] = send.mock.calls[0] as [unknown, string, { to: string; subject: string; text: string; html?: string }];
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
    const [sent] = await mailRows(t);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBe(Date.now());
    expect(sent.error).toBeUndefined();
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

  it("running sendDrop again for a finished row sends nothing", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);
    const [row] = await mailRows(t);

    await t.action(internal.notify.sendDrop, { mailLogId: row._id });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("a drop that cannot be mailed is still recorded", () => {
  it("no account email: failed row with the reason, no throw, nothing sent", async () => {
    const t = setup();
    const { userId } = await account(t, { email: null });
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/no email address/);
    expect(row.sentAt).toBeUndefined();
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

  it("no inbox of any kind: failed row with the reason", async () => {
    const t = setup();
    const { userId } = await account(t, { inbox: false });
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/alerts are not configured/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send error ends the row as failed with a truncated message", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    send.mockRejectedValueOnce(new Error("x".repeat(5_000)));
    await observe(t, watchId, 4_000);
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/^Send failed: x+/);
    expect(row.error?.length).toBe(1000);
  });

  it("a watch bought before the send went out is not mailed", async () => {
    const t = setup();
    const { userId } = await account(t);
    const watchId = await seedWatch(t, userId, { targetCents: 5_000 });
    await observe(t, watchId, 4_000);
    await t.run((ctx) => ctx.db.patch(watchId, { status: "bought" }));
    await flush(t);

    const [row] = await mailRows(t);
    expect(row.status).toBe("failed");
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
    const created = await as.mutation(api.watches.create, { productUrl: URL, name: "Down\r\nBcc: x@evil.example\u0000 Jacket" });
    const name = async (id: Id<"watches">) => (await t.run((ctx) => ctx.db.get(id)))?.name;
    expect(await name(created)).toBe("DownBcc: x@evil.example Jacket");

    await as.mutation(api.watches.rename, { watchId: created, name: " Parka\n\u001b[31m " });
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

  it("a spent global switch records the drop in the app and mails nobody, until the next UTC day", async () => {
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
    expect(rows.map((r) => r.status)).toEqual(["sent", "failed"]);
    expect(rows[1].error).toBe(GLOBAL_LIMIT_ERROR);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await globalCount()).toBe(max);

    // Next UTC day: the switch is whole again.
    vi.setSystemTime(T0 + 24 * 3_600_000);
    await observe(t, watchId, 48_000);
    expect((await mailRows(t))[2].status).toBe("claimed");
  });

  it(`mails at most ${MAX_DROP_EMAILS_PER_DAY} drops per 24h; the next is recorded as failed, and the window rolls`, async () => {
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
    expect(over).toMatchObject({ status: "failed", error: DAILY_LIMIT_ERROR });

    // The capped alert still shows in the app.
    const listed = await as.query(api.notify.drops, {});
    expect(listed[0]).toMatchObject({ _id: over._id, status: "failed", error: DAILY_LIMIT_ERROR });

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
