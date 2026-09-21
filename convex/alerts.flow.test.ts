/// <reference types="vite/client" />
/**
 * T09 — independent acceptance suite for P01's alert-eligibility gate
 * (`lib/accountState.ts`'s `alertGate`, driven through `notify.claimDrop`
 * and `notify.sendDrop`), written from the acceptance bullets in
 * `docs/prompts/recoup-opus-sonnet-agent-team.md` (P01) and the ordering
 * fixed by the contract (`docs/team/contracts/2026-09-21-T01-T05-T06.md`,
 * T01(b): deleted -> no_email -> unverified -> opted_out ->
 * address_suppressed). Scope per task assignment: unverified / opted-out /
 * tombstoned accounts receive no alert, and the gate is re-checked at send
 * time, not just at claim/enqueue time (P01: "Recheck verification and
 * alert preference at send time, not just enqueue").
 *
 * Fixtures are built directly against the schema (`convex/schema.ts`)
 * rather than through the watch-check pipeline, so each test isolates the
 * gate itself. A positive control (a fully eligible account) is included so
 * the negative tests are not vacuously true.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setup, signedIn } from "./test.setup";
import { claimDrop } from "./notify";
import { agentmail } from "./mail";

type T = ReturnType<typeof setup>;

afterEach(() => {
  vi.restoreAllMocks();
});

/** A signed-in user with a verified email and no opt-out/suppression/tombstone. */
async function verifiedUser(t: T, name: string) {
  const { userId, as } = await signedIn(t, name);
  const email = `${name.toLowerCase()}@example.com`;
  await t.run((ctx) => ctx.db.patch(userId, { email, emailVerificationTime: Date.now() }));
  return { userId, as, email };
}

/** An active watch with a target price, ready to accept a qualifying drop. */
async function activeWatch(
  t: T,
  userId: Id<"users">,
  opts: { targetCents?: number; lastCents?: number } = {},
): Promise<Doc<"watches">> {
  return await t.run(async (ctx) => {
    const watchId = await ctx.db.insert("watches", {
      userId,
      name: "Widget",
      productUrl: "https://store.example/widget",
      merchantDomain: "store.example",
      currency: "USD",
      targetCents: opts.targetCents ?? 5_000,
      status: "active",
      nextCheckAt: Date.now() + 3_600_000,
      lastCents: opts.lastCents,
    });
    return (await ctx.db.get(watchId))!;
  });
}

async function inboxFor(t: T, userId: Id<"users">, name: string) {
  await t.run((ctx) =>
    ctx.db.insert("profiles", { userId, inboxId: `inbox-${name.toLowerCase()}`, inboxEmail: `${name.toLowerCase()}@inbox.example` }),
  );
}

describe("T09 acceptance — alert-eligibility gate (P01)", () => {
  it("positive control: a verified, opted-in, non-tombstoned account's qualifying drop is claimed and mailed", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Paula");
    await inboxFor(t, userId, "Paula");
    const watch = await activeWatch(t, userId);
    const sendSpy = vi.spyOn(agentmail, "sendMessage").mockResolvedValue("outbound-paula" as never);

    const mailLogId = await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));
    expect(mailLogId).not.toBeNull();
    expect((await t.run((ctx) => ctx.db.get(mailLogId!)))?.status).toBe("claimed");

    await t.mutation(internal.notify.sendDrop, { mailLogId: mailLogId! });
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const row = await t.run((ctx) => ctx.db.get(mailLogId!));
    expect(row?.status).toBe("queued");
  });

  it("an unverified account's qualifying drop is recorded as suppressed and no mail is sent", async () => {
    const t = setup();
    const { userId } = await signedIn(t, "Uma");
    // email present, but no emailVerificationTime: the exact "unverified" shape.
    await t.run((ctx) => ctx.db.patch(userId, { email: "uma@example.com" }));
    const watch = await activeWatch(t, userId);
    const sendSpy = vi.spyOn(agentmail, "sendMessage");

    const mailLogId = await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));
    expect(mailLogId).not.toBeNull();

    const row = await t.run((ctx) => ctx.db.get(mailLogId!));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("unverified");
    expect(sendSpy).not.toHaveBeenCalled();

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((j) => j.name.includes("sendDrop"))).toHaveLength(0);
  });

  it("an opted-out account's qualifying drop is recorded as suppressed and no mail is sent", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Oscar");
    await as.mutation(api.alerts.setAlerts, { enabled: false });
    const watch = await activeWatch(t, userId);
    const sendSpy = vi.spyOn(agentmail, "sendMessage");

    const mailLogId = await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));
    const row = await t.run((ctx) => ctx.db.get(mailLogId!));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("opted_out");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("a tombstoned account's qualifying drop is recorded as suppressed and no mail is sent", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Tara");
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));
    const watch = await activeWatch(t, userId);
    const sendSpy = vi.spyOn(agentmail, "sendMessage");

    const mailLogId = await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));
    const row = await t.run((ctx) => ctx.db.get(mailLogId!));
    expect(row?.status).toBe("suppressed");
    // `alertGate`'s fixed ordering (deleted -> no_email -> unverified ->
    // opted_out -> address_suppressed): "deleted" wins over every other
    // reason, so this is the tombstone signal, not a coincidental unverified one.
    expect(row?.reason).toBe("deleted");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("tombstoning between claim and send refuses at send time — recheck, not just enqueue-time (P01)", async () => {
    const t = setup();
    const { userId } = await verifiedUser(t, "Tina");
    await inboxFor(t, userId, "Tina");
    const watch = await activeWatch(t, userId);

    // Claimed while the account is still fully eligible.
    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("claimed");

    // The account is tombstoned before the scheduled `sendDrop` actually runs.
    await t.run((ctx) => ctx.db.insert("accountState", { userId, status: "deleting", requestedAt: Date.now(), attempts: 0 }));

    const sendSpy = vi.spyOn(agentmail, "sendMessage");
    await t.mutation(internal.notify.sendDrop, { mailLogId });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("deleted");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("opting out between claim and send refuses at send time — recheck, not just enqueue-time (P01)", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Vera");
    await inboxFor(t, userId, "Vera");
    const watch = await activeWatch(t, userId);

    const mailLogId = (await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD")))!;
    expect((await t.run((ctx) => ctx.db.get(mailLogId)))?.status).toBe("claimed");

    await as.mutation(api.alerts.setAlerts, { enabled: false });

    const sendSpy = vi.spyOn(agentmail, "sendMessage");
    await t.mutation(internal.notify.sendDrop, { mailLogId });

    const row = await t.run((ctx) => ctx.db.get(mailLogId));
    expect(row?.status).toBe("suppressed");
    expect(row?.reason).toBe("opted_out");
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("the caller's own drops view shows the suppressed reason truthfully, not as a generic failure", async () => {
    const t = setup();
    const { userId, as } = await verifiedUser(t, "Wade");
    await as.mutation(api.alerts.setAlerts, { enabled: false });
    const watch = await activeWatch(t, userId);
    await t.run((ctx) => claimDrop(ctx, watch, 4_000, "USD"));

    const rows = await as.query(api.notify.drops, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("suppressed");
    expect(rows[0]!.reason).toBe("opted_out");
    expect(rows[0]!.canRecheck).toBe(false);
  });
});
